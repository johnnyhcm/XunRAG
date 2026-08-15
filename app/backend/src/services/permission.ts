// 权限判定服务（S6 混合模型，2026-08-07，PRD §3.3 / TECH §3.6.x）
// - 功能/管理范围：用户组（动态条件实时匹配 + 手动成员），系统管理员内置超级
// - 内容可见性：政策库/文件可见条件（ABAC 属性匹配，规则内 AND / 规则间 OR，文件⊆库交集）
// - 判定实时：读用户属性不缓存（C2 决策）
import { getDb } from '../db/index.js';
import { E, sendErr } from './errors.js';

export interface UserProfile {
  id: string; name: string; department: string | null; position: string | null;
  region: string | null; hire_date: string | null; contract_type: string | null;
  level_type: string | null; role: string | null;
}

/** 条件命中：in=值∈values；not_in=值∉values（空值视为不匹配排除=放行） */
function hitCondition(field: string, operator: string, values: string[], user: UserProfile): boolean {
  const v = (user as any)[field] ?? null;
  if (operator === 'not_in') return v == null || !values.includes(v); // 空值放行（not_in 语义）
  return v != null && values.includes(v);
}

/** 动态组条件评估：规则内 AND（同 rule_no 全满足）、规则间 OR（任一规则满足） */
export function evalRules(rules: { rule_no: number; field: string; operator: string; allowed_values: string[] }[], user: UserProfile): boolean {
  if (!rules?.length) return false;
  // 按 rule_no 分组：同组 AND，组间 OR
  const groups = new Map<number, { field: string; operator: string; allowed_values: string[] }[]>();
  for (const r of rules) {
    const arr = groups.get(r.rule_no) ?? [];
    arr.push({ field: r.field, operator: r.operator ?? 'in', allowed_values: r.allowed_values ?? [] });
    groups.set(r.rule_no, arr);
  }
  for (const [_, conds] of groups) {
    if (!conds.length) continue; // 空条件分组无意义，跳过
    if (conds.every((c) => hitCondition(c.field, c.operator, c.allowed_values, user))) return true;
  }
  return false;
}

/** 当前用户所属组 id 集合：动态组（属性实时匹配）+ 手动组（user_group_members） */
export function getUserGroupIds(user: UserProfile | null): string[] {
  if (!user) return [];
  const db = getDb();
  const groups = new Set<string>();
  // 1) 规则自动（所有启用组都查规则，不再按 dynamic/manual 类型区分；2026-08-07 简化）
  const allGroups = db.prepare('SELECT id FROM user_groups WHERE enabled=1').all() as { id: string }[];
  for (const g of allGroups) {
    if (g.id === 'system_admin') continue; // 系统管理员组仅手动（安全红线）
    const rules = db.prepare('SELECT rule_no, field, operator, allowed_values FROM user_group_rules WHERE group_id=?').all(g.id) as { rule_no: number; field: string; operator: string; allowed_values: string | null }[];
    if (rules.length && evalRules(rules.map((r) => ({ rule_no: r.rule_no, field: r.field, operator: r.operator ?? 'in', allowed_values: safeParse(r.allowed_values) })), user)) groups.add(g.id);
  }
  // 2) 包含例外（直接加入；组启用才生效）
  for (const r of db.prepare(`
    SELECT m.group_id FROM user_group_members m JOIN user_groups g ON g.id=m.group_id
    WHERE m.user_id=? AND m.type='include' AND g.enabled=1`).all(user.id) as { group_id: string }[]) groups.add(r.group_id);
  // 3) 排除例外（满足规则也排除；组启用才生效）
  for (const r of db.prepare(`
    SELECT m.group_id FROM user_group_members m JOIN user_groups g ON g.id=m.group_id
    WHERE m.user_id=? AND m.type='exclude' AND g.enabled=1`).all(user.id) as { group_id: string }[]) groups.delete(r.group_id);
  // 4) 系统管理员组手动成员（安全红线，单独处理）
  const sysAdminMember = db.prepare("SELECT 1 x FROM user_group_members WHERE group_id='system_admin' AND user_id=? AND type='include'").get(user.id);
  if (sysAdminMember) groups.add('system_admin');
  // 员工组：全员默认（内置 employee）
  groups.add('employee');
  return [...groups];
}

/** 系统管理员判断（组体系 + 兼容现有 users.role='admin'） */
export function isSystemAdmin(user: UserProfile | null): boolean {
  // 系统管理员唯一来源 = 系统管理员组（role 字段已废弃，2026-08-07）
  if (!user) return false;
  return getUserGroupIds(user).includes('system_admin');
}

function safeParse(s: string | null): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/** 可见条件 JSON：[{conditions:[{field,values[]}]}] —— 规则间 OR，规则内 AND；null=全员可见 */
type VisibleRule = { conditions: { field: string; operator?: string; values: string[] }[] };

/** 适用范围规则（2026-08-12）：与 visible_rules 同构；line 级 NULL=继承库级，库级 NULL=全员适用 */
type ApplyRule = VisibleRule;

/** 解析规则 JSON（防御：非数组/损坏 → null） */
function parseRules(json: string | null): ApplyRule[] | null {
  if (!json) return null;
  try { const v = JSON.parse(json); return Array.isArray(v) ? (v as ApplyRule[]) : null; } catch { return null; }
}

/** 适用范围三分态评估（2026-08-12，C1 落地）——消费方式：高效模式传 Python 加权 / 智能模式工具标注重排
 *  'applicable'   规则命中（用户属性匹配）
 *  'inapplicable' 规则存在且用户相关属性有值但不匹配（明确不适用）
 *  'neutral'      无规则（全员适用）或用户属性缺失（无法判断，保守中性——不照搬可见范围"in 不命中=排除"的安全语义） */
export function getApplicableState(line: { apply_rules: string | null; library_id: string }, user: UserProfile | null): 'applicable' | 'inapplicable' | 'neutral' {
  if (!user) return 'neutral'; // 匿名无属性可判断
  // 规则解析：文件级 → 库级继承 → 无规则=全员适用
  let rules = parseRules(line.apply_rules)?.filter((r) => r?.conditions?.length) ?? null;
  if (!rules || !rules.length) {
    try {
      const lib = getDb().prepare('SELECT apply_rules FROM policy_libraries WHERE id=?').get(line.library_id) as { apply_rules: string | null } | undefined;
      rules = parseRules(lib?.apply_rules ?? null)?.filter((r) => r?.conditions?.length) ?? null;
    } catch { rules = null; }
  }
  if (!rules || !rules.length) return 'neutral';
  // 命中判定：任一规则全条件满足 = 适用
  if (rules.some((r) => hitRule(r, user))) return 'applicable';
  // 未命中：规则涉及字段中用户属性存在缺失 → 无法判断（中性）；否则明确不适用
  const fields = new Set<string>();
  for (const r of rules) for (const c of r.conditions ?? []) if (c?.field) fields.add(c.field);
  const missing = [...fields].some((f) => (user as any)[f] == null);
  return missing ? 'neutral' : 'inapplicable';
}

/** 批量：对可见 line 集合算适用性，返回 applicable/inapplicable 两个 line_id 集合（neutral 不进任一集合）
 *  供 searchPolicies 传 Python 加权 / smartChat 工具标注重排 */
export function getApplicableSets(user: UserProfile | null, lineIds: string[]): { applicable: Set<string>; inapplicable: Set<string> } {
  const applicable = new Set<string>();
  const inapplicable = new Set<string>();
  if (!user || !lineIds.length) return { applicable, inapplicable };
  const db = getDb();
  const rows = db.prepare(`SELECT id, library_id, apply_rules FROM policy_lines WHERE id IN (${lineIds.map(() => '?').join(',')})`).all(...lineIds) as { id: string; library_id: string; apply_rules: string | null }[];
  for (const r of rows) {
    const st = getApplicableState(r, user);
    if (st === 'applicable') applicable.add(r.id);
    else if (st === 'inapplicable') inapplicable.add(r.id);
  }
  return { applicable, inapplicable };
}

/** 单条可见规则是否命中（规则内 AND） */
function hitRule(rule: VisibleRule, user: UserProfile): boolean {
  if (!rule?.conditions?.length) return false;
  return rule.conditions.every((c) => hitCondition(c.field, c.operator ?? 'in', c.values ?? [], user));
}

/** 一组可见规则是否命中（规则间 OR）；null/空 = 全员可见 */
function hitVisible(rulesJson: string | null, user: UserProfile): boolean {
  if (!rulesJson) return true; // null = 全员/继承
  let rules: VisibleRule[] = [];
  try { const v = JSON.parse(rulesJson); rules = Array.isArray(v) ? v : []; } catch { return true; }
  // 过滤空条件规则（conditions 空 = 无约束；如 [{conditions:[]}] 应视为全员可见）
  rules = rules.filter((r) => r?.conditions?.length);
  if (!rules.length) return true;
  return rules.some((r) => hitRule(r, user));
}

/** 当前用户可见 line_ids（含库级默认 + 文件级覆盖，文件⊆库交集）—— 检索/浏览/阅读共用
 *  管理权 ⊇ 可见性（2026-08-07）：能管理某库的用户，可见该库全部文件（无视库/文件可见条件） */
export function getVisibleLineIds(user: UserProfile | null): string[] {
  if (!user) return [];
  const db = getDb();
  const lines = db.prepare('SELECT id, library_id, visible_rules FROM policy_lines').all() as { id: string; library_id: string; visible_rules: string | null }[];
  if (isSystemAdmin(user)) return lines.map((r) => r.id); // 系统管理员全数据
  // 用户管理的库集合（角色管理范围；能管就能看该库全部）
  const myRoles = new Set(getUserGroupIds(user));
  const libs = db.prepare('SELECT id, visible_rules FROM policy_libraries').all() as { id: string; visible_rules: string | null }[];
  const managedLibs = new Set<string>();
  const libVisible = new Map<string, string | null>();
  for (const l of libs) {
    libVisible.set(l.id, l.visible_rules);
    if (canManageLibrary(user, l.id)) managedLibs.add(l.id);
  }
  const visible: string[] = [];
  for (const line of lines) {
    if (managedLibs.has(line.library_id)) { visible.push(line.id); continue; } // 管理权 ⊇ 可见性
    const libRule = libVisible.get(line.library_id) ?? null;
    const fileRule = line.visible_rules ?? null; // NULL=继承库
    // 文件⊆库：有效可见 = 文件条件 ∩ 库条件（交集，以更严格为准）
    if (hitVisible(libRule, user) && hitVisible(fileRule, user)) visible.push(line.id);
  }
  return visible;
}

/** 用户是否有某库管理权（角色管理范围 managed_library_ids，含 ALL；系统管理员恒 true） */
export function canManageLibrary(user: UserProfile | null, libraryId: string): boolean {
  if (!user) return false;
  if (isSystemAdmin(user)) return true;
  const myRoles = getUserGroupIds(user).filter((r) => r !== 'employee'); // employee 无管理功能
  const db = getDb();
  for (const roleId of myRoles) {
    const r = db.prepare('SELECT managed_library_ids FROM user_groups WHERE id=? AND enabled=1').get(roleId) as { managed_library_ids: string | null } | undefined;
    if (!r?.managed_library_ids) continue;
    const ids = safeParse(r.managed_library_ids);
    if (ids.includes('ALL') || ids.includes(libraryId)) return true;
  }
  return false;
}

/** 功能权限：用户是否有某功能（任一角色 function_ids 含 fn；system_admin 全功能；employee=query） */
export function hasPerm(user: UserProfile | null, fn: string): boolean {
  if (!user) return false;
  if (isSystemAdmin(user)) return true;
  const db = getDb();
  for (const roleId of getUserGroupIds(user)) {
    const r = db.prepare('SELECT function_ids FROM user_groups WHERE id=? AND enabled=1').get(roleId) as { function_ids: string | null } | undefined;
    if (!r?.function_ids) continue;
    const fns = safeParse(r.function_ids);
    if (fns.includes(fn)) return true;
  }
  return false;
}

/** 鉴权中间件：系统管理员（管理类 API：用户/组/配置/政策管理） */
export function requireAdmin() {
  return (req: any, res: any, next: any) => {
    if (!isSystemAdmin(req.user ?? null)) return sendErr(req, res, 403, E('PERM_SYSTEM_ADMIN', '无权限（需要系统管理员）', 'No permission (requires system administrator)'));
    next();
  };
}

/** 鉴权中间件：按功能权限（系统管理员天然通过）——管理类 API 功能细分（2026-08-08）
 *  PRD §3.3：用户管理/权限角色管理/系统配置为系统级功能，业务角色可分勾并生效（多角色并集） */
export function requireFn(fn: string) {
  return (req: any, res: any, next: any) => {
    if (!hasPerm(req.user ?? null, fn)) return sendErr(req, res, 403, E('PERM_FN', `无权限（需要 ${fn} 功能）`, `No permission (requires the ${fn} function)`));
    next();
  };
}

/** 任一管理功能（用户/角色/配置/政策）——用户列表等被多模块共用的数据端点用（如角色编辑页的成员选择器） */
export function requireAnyMgmt() {
  return (req: any, res: any, next: any) => {
    const u = req.user ?? null;
    const ok = hasPerm(u, 'policy_library_mgmt') || hasPerm(u, 'policy_mgmt') || hasPerm(u, 'user_mgmt') || hasPerm(u, 'role_mgmt') || hasPerm(u, 'config_mgmt');
    if (!ok) return sendErr(req, res, 403, E('PERM_ANY_MGMT', '无权限（需要任一管理功能）', 'No permission (requires any administrative function)'));
    next();
  };
}

/** 目标用户是否为系统管理员组成员（安全护栏：授予/收回系统管理员的唯一入口，防提权/防锁死） */
export function isSystemAdminMember(userId: string): boolean {
  return !!getDb().prepare("SELECT 1 x FROM user_group_members WHERE group_id='system_admin' AND user_id=? AND type='include'").get(userId);
}

/** 成员预览（2026-08-08）：按传入的规则草稿 + 包含/排除计算成员名单（不保存、不改库）——
 *  编辑权限角色时"查看最新规则下的成员名单"用；判定逻辑与 getUserGroupIds 的规则部分一致（evalRules 复用，无漂移） */
export function previewGroupMembers(
  rules: { rule_no: number; field: string; operator?: string; values: string[] }[],
  includeIds: string[],
  excludeIds: string[],
): { id: string; name: string; employee_no: string | null; department: string | null; position: string | null }[] {
  const db = getDb();
  const users = db.prepare("SELECT id, name, employee_no, department, position, region, contract_type, level_type FROM users WHERE status='active'").all() as any[];
  const inc = new Set(includeIds);
  const exc = new Set(excludeIds);
  const evalRulesInput = rules.map((r) => ({ rule_no: r.rule_no, field: r.field, operator: r.operator ?? 'in', allowed_values: r.values ?? [] }));
  return users.filter((u) => {
    if (exc.has(u.id)) return false;
    if (inc.has(u.id)) return true;
    const profile: UserProfile = { id: u.id, name: u.name, department: u.department, position: u.position, region: u.region, hire_date: null, contract_type: u.contract_type, level_type: u.level_type, role: 'employee' };
    return evalRules(evalRulesInput, profile);
  }).map((u) => ({ id: u.id, name: u.name, employee_no: u.employee_no, department: u.department, position: u.position }));
}
