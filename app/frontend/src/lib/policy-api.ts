// S2 政策管理 + 浏览/阅读 API 封装
import { api } from './api';

export interface VersionRow {
  id: string; version_no: string | null; status: string; effective_from: string | null;
  effective_to: string | null; change_note: string | null; published_at: string | null;
  index_status?: string; index_error?: string | null;
  // 2026-08-06：后端按服务器时区算好的版本派生状态（active/pending/expired/invalid/draft），前端不再自算“今天”
  computed_status?: string;
}

export interface LineDetail {
  line: any;
  versions: VersionRow[];
  timezone: string | null; // 2026-08-13：政策线时区（IANA），管理端展示用（取代原 server_tz 服务器偏移）
}

// 政策库
export const Libraries = {
  list: () => api.get('/libraries').then((r) => r.data),
  create: (name: string, description?: string, visible_rules?: any[], apply_rules?: any[]) => api.post('/libraries', { name, description, visible_rules, apply_rules }).then((r) => r.data),
  update: (id: string, patch: any) => api.patch(`/libraries/${id}`, patch).then((r) => r.data),
  stop: (id: string) => api.delete(`/libraries/${id}`).then((r) => r.data),
};

export interface PolicyListItem {
  id: string;
  name: string;
  policy_type: string | null;
  security_level?: string | null;
  // 派生状态：active/pending/invalid/unpublished
  derived_status: string;
  current_version_no: string | null;
  published_count: number;
  invalid_count: number;
  version_count: number;
  max_updated_at: string | null;
  created_at?: string | null;
  library_name: string;
  // 线级属性（编辑属性弹窗用）
  doc_no?: string | null;
  topic?: string | null;
  publish_org?: string | null;
  legal_basis?: string | null;
  tags?: string | null;
  library_id?: string | null;
}

export interface SliceSegment {
  index: number;
  text: string;
  lang: string;
  type: 'body' | 'cover' | 'toc' | 'header_footer';
  level: '' | 'H1' | 'H2' | 'H3';
  has_table: boolean;
  tokens: number;
  retained: boolean;
  isPureHeading?: boolean;
}

export const Policies = {
  listByLibrary: (libId: string) => api.get(`/libraries/${libId}/policies`).then((r) => r.data as { policies: PolicyListItem[] }),
  create: (libId: string, body: any) => api.post(`/libraries/${libId}/policies`, body).then((r) => r.data as { line_id: string; version_id: string }),
  get: (lineId: string) => api.get(`/policies/${lineId}`).then((r) => r.data as LineDetail),
  updateLine: (lineId: string, patch: any) => api.patch(`/policies/${lineId}`, patch).then((r) => r.data),
  newVersion: (lineId: string) => api.post(`/policies/${lineId}/versions`, {}).then((r) => r.data as { version_id: string }),
  versionDetail: (lineId: string, versionId: string) => api.get(`/policies/${lineId}/versions/${versionId}`).then((r) => r.data as { line: any; version: any; segments: SliceSegment[]; splits: boolean[] }),
  upload: (lineId: string, versionId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post(`/policies/${lineId}/versions/${versionId}/upload`, fd, { headers: { 'content-type': 'multipart/form-data' } }).then((r) => r.data);
  },
  updatePlan: (lineId: string, versionId: string, segments: SliceSegment[], splits: boolean[]) =>
    api.put(`/policies/${lineId}/versions/${versionId}/chunks`, { segments, splits }).then((r) => r.data),
  publish: (lineId: string, versionId: string, body: any) =>
    api.post(`/policies/${lineId}/versions/${versionId}/publish`, body).then((r) => r.data),
  updateVersion: (lineId: string, versionId: string, patch: any) =>
    api.patch(`/policies/${lineId}/versions/${versionId}`, patch).then((r) => r.data),
  invalidate: (lineId: string, versionId: string) =>
    api.post(`/policies/${lineId}/versions/${versionId}/invalidate`, {}).then((r) => r.data),
  reindex: (lineId: string, versionId: string) =>
    api.post(`/policies/${lineId}/versions/${versionId}/reindex`, {}).then((r) => r.data),
  deleteVersion: (lineId: string, versionId: string) => api.delete(`/policies/${lineId}/versions/${versionId}`).then((r) => r.data),
  deleteLine: (lineId: string) => api.delete(`/policies/${lineId}`).then((r) => r.data),
  setRefs: (lineId: string, toLineIds: string[]) => api.put(`/policies/${lineId}/refs`, { to_line_ids: toLineIds }).then((r) => r.data),
  getRefs: (lineId: string) => api.get(`/policies/${lineId}/refs`).then((r) => r.data),
};

// 员工端浏览/搜索/阅读
export const Browse = {
  list: (params?: Record<string, string>) => api.get('/browse', { params }).then((r) => r.data),
  search: (q: string) => api.get('/search', { params: { q } }).then((r) => r.data),
  read: (lineId: string) => api.get(`/policy/${lineId}`).then((r) => r.data),
  readVersion: (lineId: string, versionId: string) => api.get(`/policy/${lineId}/${versionId}`).then((r) => r.data),
};
// 用户管理（S6 前置最小版，PRD §4.1.5）
export interface UserRow {
  id: string; employee_no: string | null; name: string; department: string | null;
  position: string | null; email: string | null; phone: string | null;
  region: string | null; contract_type: string | null; level_type: string | null;
  role: string | null; status: string;
  [key: string]: any; // 2026-08-11：预留自定义字段（custom_1~10）动态存取
}
export const Users = {
  list: (params?: { search?: string; status?: string; sortBy?: string; sortOrder?: string }) => api.get('/users', { params }).then((r) => r.data as { users: UserRow[] }),
  create: (body: Partial<UserRow>) => api.post('/users', body).then((r) => r.data),
  update: (id: string, body: Partial<UserRow>) => api.put(`/users/${id}`, body).then((r) => r.data),
  deactivate: (id: string) => api.post(`/users/${id}/deactivate`, {}).then((r) => r.data),
  activate: (id: string) => api.post(`/users/${id}/activate`, {}).then((r) => r.data),
  remove: (id: string) => api.delete(`/users/${id}`).then((r) => r.data),
  resetPassword: (id: string) => api.post(`/users/${id}/reset-password`, {}).then((r) => r.data),
  importCsv: (rows: Record<string, string>[]) => api.post('/users/import', { rows }).then((r) => r.data as { imported: number; skipped: { row: number; reason: string }[] }),
  // CSV 闭环（2026-08-07，PRD §4.1.5）：模板下载 / 全量导出 / 文件导入（dryRun 预览不写库）
  template: () => api.get('/users/template', { responseType: 'blob' }).then((r) => r.data as Blob),
  exportCsv: () => api.get('/users/export', { responseType: 'blob' }).then((r) => r.data as Blob),
  importFile: (file: File, dryRun: boolean) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('dryRun', dryRun ? '1' : '0');
    return api.post('/users/import', fd).then((r) => r.data as ImportResult);
  },
};

export interface ImportResult {
  dryRun: boolean; total: number; unknownCols: string[];
  created: number; updated: number; activated: number; deactivated: number;
  skipped: { row: number; reason: string }[];
}

// 我的权限（S6 前端渲染联动，PRD §3.3 ④）：当前用户 + 功能勾选 + 管理范围
// 注：前端隐藏 ≠ 权限生效，后端 API 校验才是安全底线（PRD §3.3 ③）
export interface MyPerm {
  user: { id: string; name: string; employee_no: string | null; region: string | null; level_type: string | null; role: string | null; language?: string; mustChangePassword?: boolean } | null;
  isSystemAdmin: boolean;
  functions: string[];
  managed_library_ids: string[];
  forcePasswordChange?: boolean; // 2026-08-09：首次登录强制改密（must_change_password=1 && 配置开启）；前端只认此字段
}
export const Me = {
  get: () => api.get('/me').then((r) => r.data as MyPerm),
};

// 登录认证（S6 完整用户系统，2026-08-07，PRD §3.2）
export interface LoginResp { token: string; expires_at: string; user: { id: string; employee_no: string; name: string; role: string | null; mustChangePassword?: boolean } }
export const Auth = {
  login: (employee_no: string, password: string) => api.post('/auth/login', { employee_no, password }).then((r) => r.data as LoginResp),
  logout: () => api.post('/auth/logout', {}).then((r) => r.data),
  // 自助改密（2026-08-09）：force=true（强制模式）免当前密码；常规模式需 currentPassword
  changePassword: (currentPassword: string, newPassword: string, force: boolean) =>
    api.post('/auth/change-password', { currentPassword, newPassword, force }).then((r) => r.data),
};

// 选项字段（field_dicts，2026-08-11 重构：值/名分离 + 选项独立表 + CSV 维护）
export interface FieldDictOption { id: string; field_key: string; value: string; label: string; label_en: string | null; enabled: number; sort: number }
export interface FieldDict {
  key: string; name: string; name_i18n?: { zh?: string; en?: string } | null; type: 'option' | 'multi' | 'text';
  is_system: number; required: number; in_context: number; enabled: number; sort: number; options: FieldDictOption[];
}
export const FieldDicts = {
  list: () => api.get('/field_dicts').then((r) => r.data as { fields: FieldDict[] }),
  create: (body: { name: string; type?: string; name_i18n?: Record<string, string>; options?: any[]; sort?: number }) => api.post('/field_dicts', body).then((r) => r.data),
  update: (key: string, body: { name?: string; name_i18n?: Record<string, string> | null; type?: string; enabled?: number; required?: number; in_context?: number; sort?: number }) => api.put(`/field_dicts/${key}`, body).then((r) => r.data),
  remove: (key: string) => api.delete(`/field_dicts/${key}`).then((r) => r.data),
  addOption: (key: string, body: { value: string; label: string; label_en?: string; sort?: number }) => api.post(`/field_dicts/${key}/options`, body).then((r) => r.data),
  updateOption: (key: string, id: string, body: { label?: string; label_en?: string | null; enabled?: number; sort?: number }) => api.put(`/field_dicts/${key}/options/${id}`, body).then((r) => r.data),
  removeOption: (key: string, id: string) => api.delete(`/field_dicts/${key}/options/${id}`).then((r) => r.data),
  sortOptions: (key: string, ids: string[]) => api.post(`/field_dicts/${key}/options/sort`, { ids }).then((r) => r.data),
};

// 用户组管理（S6 权限，PRD §3.3）
export interface GroupRule { rule_no: number; field: string; operator?: 'in' | 'not_in'; values: string[] }
export interface GroupRow {
  id: string; name: string; type: string; description: string | null;
  enabled: number; sort: number;
  function_ids?: string[];
  managed_library_ids?: string[];
  rules: GroupRule[]; manual_members: { id: string; name: string; employee_no: string | null; department?: string | null; position?: string | null }[];
  include_members?: { id: string; name: string; employee_no: string | null; department?: string | null; position?: string | null }[];
  exclude_members?: { id: string; name: string; employee_no: string | null; department?: string | null; position?: string | null }[];
  members?: { id: string; name: string; employee_no: string | null; department?: string | null; position?: string | null }[];
}
export const Groups = {
  list: () => api.get('/groups').then((r) => r.data as { groups: GroupRow[] }),
  create: (body: { name: string; description?: string }) => api.post('/groups', body).then((r) => r.data),
  update: (id: string, body: any) => api.put(`/groups/${id}`, body).then((r) => r.data),
  saveRules: (id: string, rules: GroupRule[]) => api.put(`/groups/${id}/rules`, { rules }).then((r) => r.data),
  addMember: (id: string, userId: string, type: 'include' | 'exclude' = 'include') => api.post(`/groups/${id}/members/${userId}`, { type }).then((r) => r.data),
  removeMember: (id: string, userId: string) => api.delete(`/groups/${id}/members/${userId}`).then((r) => r.data),
  members: (id: string) => api.get(`/groups/${id}/members`).then((r) => r.data as { members: { id: string; name: string }[] }),
  previewMembers: (body: { rules: { rule_no: number; field: string; operator?: string; values: string[] }[]; include: string[]; exclude: string[] }) =>
    api.post('/groups/preview-members', body).then((r) => r.data as { members: { id: string; name: string; employee_no: string | null; department: string | null; position: string | null }[] }),
  remove: (id: string) => api.delete(`/groups/${id}`).then((r) => r.data),
};
