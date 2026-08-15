// 前后端共享类型与常量（S1 起维护）
// 关联：PRD §4 / TECH.md §3

/** 问答模式 —— S3 仅高效可选，智能 S4 上线 */
export type ChatMode = 'efficient' | 'smart';

/** 全员统一身份：本期无登录（PRD §3.1）。
 *  S4 补登录后由服务端在 session 上回填 user_id。 */
export interface SessionContext {
  /** 前端 localStorage 生成的 UUID；每次请求带 X-Session-Id */
  sessionId: string;
  /** S4 起填充；本期为空 */
  userId?: string;
}

/** 引用三件套（PRD §4.4.3）—— S3 起填充，S1 仅定义结构 */
export interface Citation {
  chunkId: string;
  source: string;
  section: string;
  anchor: string;
}

/** /api/health 响应 */
export interface HealthResponse {
  status: 'ok';
  backend: 'up';
  /** DeepSeek 连接状态 —— S1 空实现：未配置 / pending */
  deepseek: 'connected' | 'disconnected' | 'unconfigured';
  python: 'up' | 'down';
}

/** /api/status 响应（S3 设置页用，S1 占位） */
export interface StatusResponse {
  deepseek: {
    connected: boolean;
    model: string | null;
  };
}
/** 个性化回答注入的用户属性（S5 方案 A：默认注入低敏感字段）
 *  与 session 中间件 req.user 同构；只存当前登录用户本人数据（个人数据红线） */
export interface UserProfile {
  id: string;
  name: string;
  department: string | null;
  position: string | null;
  region: string | null;
  hire_date: string | null;
  contract_type: string | null;
  level_type: string | null;
  role: string | null;
}
