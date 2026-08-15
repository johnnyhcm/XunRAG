// 后端错误响应 → 错误码 + 本地化 批量迁移（2026-08-13，PRD §5.3 i18n 决策②）
// 一次性 codemod：把 res.status(N).json({ error: 'ZH' }) 替换为 sendErr(req, res, N, E('CODE','ZH','EN'))
// 用法：node scripts/i18n-error-codemod.mjs [--dry-run]
// 注意：运行后需手动检查（模板字符串/多行/特殊字符边界），并跑 tsc + 测试
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// zh → [code, en]（en 用与 zh 相同的插值语法）
const MAP = {
  'CSV 缺少必填列：value、label（参考模板）': ['FIELD_CSV_MISSING_COLS', 'CSV is missing required columns: value, label (see template)'],
  'admin 不可停用': ['USER_ADMIN_FIXED', 'The admin account cannot be disabled'],
  'effective_from 必填': ['POLICY_EFF_FROM_REQUIRED', 'effective_from is required'],
  'file 参数非法': ['FIELD_FILE_INVALID', 'file parameter is invalid'],
  'ids 含不属于该字段的选项': ['FIELD_IDS_NOT_OWNED', 'ids contains options not belonging to this field'],
  'ids 必填': ['FIELD_IDS_REQUIRED', 'ids is required'],
  'ids 必须包含该字段全部选项': ['FIELD_IDS_INCOMPLETE', 'ids must include all options of this field'],
  'levels 必须为非空数组': ['SEC_LEVELS_REQUIRED', 'levels must be a non-empty array'],
  'message_id 与 value 必填': ['FEEDBACK_REQUIRED', 'message_id and value are required'],
  'name 必填': ['NAME_REQUIRED', 'name is required'],
  'policy 必须为对象 {档位: {watermark, copy_protect, ai_searchable, audit_read, audit_denied}}': ['SEC_POLICY_FORMAT', 'policy must be an object {level: {watermark, copy_protect, ai_searchable, audit_read, audit_denied}}'],
  'question 必填': ['CHAT_QUESTION_REQUIRED', 'question is required'],
  'segments/splits 长度不一致': ['SLICE_LEN_MISMATCH', 'segments/splits length mismatch'],
  'value 仅 up/down': ['FEEDBACK_VALUE_INVALID', 'value must be up or down'],
  'value 和显示名必填': ['FIELD_OPTION_VALUE_LABEL_REQUIRED', 'value and display name are required'],
  '不能移除 admin 的系统管理员身份（防锁死）': ['GROUP_ADMIN_SAFEGUARD', 'The admin role cannot be removed from the admin account (anti-lockout)'],
  '仅已发布版本可重新索引': ['POLICY_ONLY_PUBLISHED_REINDEX', 'Only published versions can be re-indexed'],
  '仅已废止或编辑中的版本可删除': ['POLICY_ONLY_INVALID_DRAFT_DELETE', 'Only revoked or editing versions can be deleted'],
  '仅支持 .docx / .md': ['POLICY_UNSUPPORTED_FORMAT', 'Only .docx / .md are supported'],
  '仅草稿可上传': ['POLICY_ONLY_DRAFT_UPLOAD', 'Only drafts can be uploaded'],
  '仅草稿可发布': ['POLICY_ONLY_DRAFT_PUBLISH', 'Only drafts can be published'],
  '内置组不可删除': ['GROUP_BUILTIN_UNDELETABLE', 'Built-in groups cannot be deleted'],
  '内置角色的功能/范围/启用仅系统管理员可修改': ['GROUP_BUILTIN_LOCKED', 'Built-in role functions/scope/enabled can only be modified by system administrators'],
  '内置角色的规则仅系统管理员可配置': ['GROUP_BUILTIN_RULES_LOCKED', 'Built-in role rules can only be configured by system administrators'],
  '名称必填': ['NAME_REQUIRED', 'Name is required'],
  '字典不存在': ['DICT_NOT_FOUND', 'Dictionary not found'],
  '字段 key 仅支持预置槽位 custom_1~custom_10': ['FIELD_KEY_SLOT_ONLY', 'Field key must be a reserved slot custom_1~custom_10'],
  '字段不存在': ['FIELD_NOT_FOUND', 'Field not found'],
  '密级必填（安全属性不可清空，请选择 公开/内部/机密/绝密 等档位）': ['POLICY_SECURITY_LEVEL_REQUIRED', 'Security level is required (a security attribute cannot be cleared; select Public/Internal/Confidential/Top secret)'],
  '工号和姓名必填': ['USER_NAME_EMPLOYEE_REQUIRED', 'Employee number and name are required'],
  '已废止版本不可编辑': ['POLICY_INVALID_NOT_EDITABLE', 'Revoked versions cannot be edited'],
  '已废止版本不可调整切片': ['POLICY_INVALID_NO_SLICE', 'Slices of revoked versions cannot be adjusted'],
  '库不存在': ['LIB_NOT_FOUND', 'Library not found'],
  '政策线/库不存在': ['POLICY_LINE_LIB_NOT_FOUND', 'Policy line / library not found'],
  '政策线不存在': ['POLICY_LINE_NOT_FOUND', 'Policy line not found'],
  '文件为空或无可解析数据': ['FIELD_CSV_EMPTY', 'File is empty or contains no parseable data'],
  '文件为空或缺少数据行': ['USER_CSV_EMPTY', 'File is empty or missing data rows'],
  '文本与选项类型互切需先清空选项': ['FIELD_TEXT_OPTION_SWITCH', 'Switching between text and option types requires clearing options first'],
  '文本类型字段无选项': ['FIELD_TEXT_NO_OPTIONS', 'Text fields have no options'],
  '无可阅读的有效版本': ['POLICY_NO_READABLE_VERSION', 'No readable effective version'],
  '无导入数据': ['USER_NO_IMPORT', 'No import data'],
  '无权限查看该政策库内容（需知识库内容运营授权）': ['PERM_LIB_CONTENT', 'No permission to view this library content (requires content operations authorization)'],
  '无权限管理该政策库': ['PERM_LIB_MANAGE', 'No permission to manage this library'],
  '无权限访问该政策': ['PERM_POLICY', 'No permission to access this policy'],
  '无权限（需要知识库全局管理功能）': ['PERM_LIB_GLOBAL', 'No permission (requires policy library global management)'],
  '无权限（需要知识库内容运营功能）': ['PERM_POLICY_MGMT', 'No permission (requires policy library content operations)'],
  '无权限（需要知识库管理功能）': ['PERM_LIB_MGMT', 'No permission (requires policy library management)'],
  '无权限（需要系统配置权限）': ['PERM_CONFIG', 'No permission (requires system configuration)'],
  '日志文件不存在': ['SEC_LOG_FILE_MISSING', 'Log file does not exist'],
  '时区不合法（IANA 时区）': ['POLICY_INVALID_TZ', 'Invalid timezone (IANA timezone)'],
  '服务商已变更：旧 API Key 不可复用，请填写新服务商的 Key': ['MODEL_PROVIDER_KEY_MISMATCH', 'Provider changed: the old API key cannot be reused; please enter the new provider key'],
  '未提供 file': ['POLICY_NO_FILE', 'No file provided'],
  '未配置 API Key': ['MODEL_NO_API_KEY', 'API key not configured'],
  '未配置 API Key：请先在表单填写并测试连接': ['MODEL_NO_API_KEY_FORM', 'API key not configured: fill it in the form and test the connection first'],
  '档位 value 必填': ['SEC_LEVEL_VALUE_REQUIRED', 'Level value is required'],
  '版本不存在': ['POLICY_VERSION_NOT_FOUND', 'Version not found'],
  '版本不存在或未发布': ['POLICY_VERSION_NOT_PUBLISHED', 'Version not found or not published'],
  '版本号不能为空': ['POLICY_VERSION_NO_REQUIRED', 'Version number cannot be empty'],
  '版本号必填': ['POLICY_VERSION_NO_REQUIRED', 'Version number is required'],
  '用户不存在': ['USER_NOT_FOUND', 'User not found'],
  '类型不合法': ['FIELD_TYPE_INVALID', 'Invalid type'],
  '系统内置字段不可停用（可停用单个选项）': ['FIELD_SYSTEM_NO_DISABLE', 'System built-in fields cannot be disabled (individual options can be disabled)'],
  '系统内置字段不可删除（可停用单个选项）': ['FIELD_SYSTEM_NO_DELETE', 'System built-in fields cannot be deleted (individual options can be disabled)'],
  '系统管理员不可被停用（仅系统管理员可操作）': ['USER_ADMIN_CANNOT_DISABLE', 'System administrators cannot be disabled (system admins only)'],
  '系统管理员组的成员仅系统管理员可管理（安全红线）': ['GROUP_ADMIN_MEMBERS_LOCKED', 'System administrator group members can only be managed by system administrators (security red line)'],
  '组不存在': ['GROUP_NOT_FOUND', 'Group not found'],
  '组名必填': ['GROUP_NAME_REQUIRED', 'Group name is required'],
  '该政策已发布版本，时区已锁定（与旧版一致），不可修改': ['POLICY_TZ_LOCKED', 'This policy has a published version; timezone is locked (must match previous version), cannot be modified'],
  '该政策已发布版本，时区已锁定（新版本必须与旧版一致）': ['POLICY_TZ_LOCKED', 'This policy has a published version; timezone is locked (new versions must match)'],
  '该用户是转人工联系人，不可停用': ['USER_CONTACT_CANNOT_DISABLE', 'This user is a human-assistance contact and cannot be disabled'],
  '请上传 CSV 文件': ['USER_CSV_REQUIRED', 'Please upload a CSV file'],
  '请先登录': ['AUTH_NOT_LOGGED_IN', 'Not logged in'],
  '请选择密级后再发布（密级是上线安全检查，草稿可暂不设置）': ['POLICY_SECURITY_LEVEL_REQUIRED_PUBLISH', 'Select a security level before publishing (security check; drafts may skip it)'],
  '读取审计目录失败：': ['SEC_AUDIT_DIR_READ_FAILED', 'Failed to read audit directory: '],
  '读取日志失败：': ['SEC_LOG_READ_FAILED', 'Failed to read log: '],
  '转换失败': ['CONVERT_FAILED', 'Conversion failed'],
  '选项不存在': ['FIELD_OPTION_NOT_FOUND', 'Option not found'],
  '配置项不存在': ['CONFIG_NOT_FOUND', 'Configuration item not found'],
  '预留槽位已用满（10 个），如需更多请联系开发扩展': ['FIELD_SLOTS_FULL', 'All 10 reserved slots are in use; contact development to extend'],
  '首个版本发布请选择时区（默认北京时间）': ['POLICY_TZ_FIRST_PUBLISH', 'Select a timezone for the first version publish (defaults to Beijing time)'],
  '首段之前不可有切分线': ['SLICE_NO_SPLIT_BEFORE_FIRST', 'No split line allowed before the first segment'],
  '高效模式已停用，请开启新对话': ['CHAT_EFFICIENT_DISABLED', 'Efficient mode is disabled. Please start a new chat'],
  // ---- 模板字符串（插值保留 ${...}）----
  '仅可删除空库：库内仍有 ${cnt.c} 个政策文件（含废止/编辑中），请知识库内容运营先清理': ['LIB_DELETE_NONEMPTY', 'Only empty libraries can be deleted: the library still has ${cnt.c} policy files (incl. revoked/editing); ask content operations to clean up first'],
  '保存失败：${e?.message ?? e}': ['SAVE_FAILED', 'Save failed: ${e?.message ?? e}'],
  '删除失败：${e?.message ?? e}': ['DELETE_FAILED', 'Delete failed: ${e?.message ?? e}'],
  '单次导入不能超过 5 万行（当前 ${rows.length} 行）': ['USER_IMPORT_LIMIT', 'Single import cannot exceed 50,000 rows (currently ${rows.length} rows)'],
  '字段被 ${refs} 处规则/可见性引用，不可删除（可停用字段）': ['FIELD_REFERENCED', 'Field is referenced by ${refs} rule(s)/visibility; cannot delete (field can be disabled)'],
  '导入失败：${e?.message ?? e}': ['USER_IMPORT_FAILED', 'Import failed: ${e?.message ?? e}'],
  '工号 ${b.employee_no} 已存在': ['USER_EMPLOYEE_EXISTS', 'Employee number ${b.employee_no} already exists'],
  '工号 ${employeeNo} 已存在': ['USER_EMPLOYEE_EXISTS', 'Employee number ${employeeNo} already exists'],
  '新增失败：${e?.message ?? e}': ['DICT_ADD_FAILED', 'Add failed: ${e?.message ?? e}'],
  '档位「${blocked.map((b) => b.label).join(\'、\')}」仍被政策引用，禁止删除——请改为「停用」（存量政策策略继续生效）': ['SEC_LEVEL_IN_USE_DELETE', 'Level(s) ${blocked.map((b) => b.label).join(\'、\')} still referenced by policies; deletion is forbidden — disable instead (existing policy tiers remain effective)'],
  '档位「${l.value}」label 必填': ['SEC_LEVEL_LABEL_REQUIRED', 'Level ${l.value} label is required'],
  '档位「${l.value}」重复': ['SEC_LEVEL_DUPLICATE', 'Level ${l.value} is duplicated'],
  '档位「${level}」${k} 必须为布尔': ['SEC_LEVEL_ENTRY_BOOL', 'Level ${level} ${k} must be boolean'],
  '档位「${level}」策略格式错误': ['SEC_LEVEL_ENTRY_FORMAT', 'Level ${level} policy format error'],
  '档位「${renamed.map((b) => b.label).join(\'、\')}」仍被政策引用，档位键不可修改（已按删除处理）——请先停用或迁移政策密级': ['SEC_LEVEL_KEY_LOCKED', 'Level(s) ${renamed.map((b) => b.label).join(\'、\')} still referenced by policies; level key cannot be changed (handled as delete) — disable or migrate policy levels first'],
  '槽位 ${key} 已被占用': ['FIELD_SLOT_TAKEN', 'Slot ${key} is already in use'],
  '缺少必填列：${missing.map((m) => m.label).join(\'、\')}': ['USER_CSV_MISSING_COLS', 'Missing required columns: ${missing.map((m) => m.label).join(\'、\')}'],
  '该对话已达 ${roundLimit} 轮上限（高效模式限制，智能模式无此限制），请开启新对话': ['CHAT_ROUND_LIMIT', 'This conversation has reached the ${roundLimit}-round limit (efficient mode only; smart mode has no limit). Please start a new chat'],
  '选项 value 已存在：${value}': ['FIELD_OPTION_VALUE_EXISTS', 'Option value already exists: ${value}'],
  '选项「${cur.label}」被 ${refs} 处用户数据/规则引用，不可删除（可停用：存量数据保留，新数据不可选）': ['FIELD_OPTION_REFERENCED', 'Option ${cur.label} is referenced by ${refs} user data/rule(s); cannot delete (can disable: existing data kept, new data not selectable)'],
  'CSV 校验失败（${errors.length} 处，已全部拒绝）：\\n${errors.slice(0, 20).join(\'\\n\')}': ['GROUPS_CSV_INVALID', 'CSV validation failed (${errors.length} issue(s), all rejected):\\n${errors.slice(0, 20).join(\'\\n\')}'],
  '「${f.name}」为必填项': ['USER_FIELD_REQUIRED', '"${f.name}" is required'],
};

const TARGETS = [
  'app/backend/src/routes/users.ts',
  'app/backend/src/routes/policy.ts',
  'app/backend/src/routes/groups.ts',
  'app/backend/src/routes/security.ts',
  'app/backend/src/routes/configs.ts',
  'app/backend/src/routes/model-config.ts',
  'app/backend/src/routes/browse.ts',
  'app/backend/src/routes/chat.ts',
  'app/backend/src/routes/local-model.ts',
  'app/backend/src/routes/feedback.ts',
];

const dry = process.argv.includes('--dry-run');
let total = 0;

// 正则：res.status(N).json({ error: '...' }) 或 `...`（非贪婪，处理括号）
const RE = /res\.status\((\d+)\)\.json\(\{\s*error:\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*\}\)/g;

for (const file of TARGETS) {
  const full = path.resolve(file);
  let src = readFileSync(full, 'utf8');
  const orig = src;
  let hits = 0;
  src = src.replace(RE, (m, status, msgRaw) => {
    const isTpl = msgRaw.startsWith('`');
    const inner = isTpl ? msgRaw.slice(1, -1) : msgRaw.slice(1, -1);
    const entry = MAP[inner];
    if (!entry) { console.warn(`  [未映射] ${file}: ${msgRaw}`); return m; }
    const [code, en] = entry;
    hits++;
    total++;
    const zhExpr = isTpl ? `\`${inner}\`` : `'${inner}'`;
    const enExpr = isTpl ? `\`${en}\`` : `'${en}'`;
    return `sendErr(req, res, ${status}, E('${code}', ${zhExpr}, ${enExpr}))`;
  });
  if (hits) {
    // 加 import（若缺）
    if (!src.includes("from '../services/errors.js'")) {
      src = src.replace(/(import \{ logger \} from '..\/services\/logger\.js';\n)/, "$1import { E, sendErr } from '../services/errors.js';\n");
    }
    if (dry) { console.log(`[dry-run] ${file}: ${hits} 处将替换`); }
    else { writeFileSync(full, src, 'utf8'); console.log(`[done] ${file}: ${hits} 处替换`); }
  } else {
    console.log(`[skip] ${file}`);
  }
}
console.log(`\n共替换 ${total} 处（dry-run=${dry}）`);
