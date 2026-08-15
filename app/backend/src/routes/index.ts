// 路由聚合 —— TECH.md §3.6 端点 + S2 政策管理/浏览
import { Router } from 'express';
import { healthRouter } from './health.js';
import { statusRouter } from './status.js';
import { chatRouter } from './chat.js';
import { sessionsRouter } from './sessions.js';
import { feedbackRouter } from './feedback.js';
import { policyRouter } from './policy.js';
import { usersRouter } from './users.js';
import { groupsRouter } from './groups.js';
import { browseRouter } from './browse.js';
import { configRouter } from './configs.js';
import { modelConfigRouter } from './model-config.js';
import { authRouter } from './auth.js';
import { statsRouter } from './stats.js';
import { localModelRouter } from './local-model.js';
import { securityRouter } from './security.js';

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use(statusRouter);
apiRouter.use(authRouter);
apiRouter.use(chatRouter);
apiRouter.use(sessionsRouter);
apiRouter.use(feedbackRouter);
apiRouter.use(policyRouter);
apiRouter.use(usersRouter);
apiRouter.use(groupsRouter);
apiRouter.use(browseRouter);
apiRouter.use(configRouter);
apiRouter.use(securityRouter);   // 2026-08-12：安全设置（密级体系/审计目录）——需在 localModelRouter 之前（其全局 config_mgmt 中间件会拦截 /api/security/levels 等登录可读端点）
apiRouter.use(modelConfigRouter); // 2026-08-09：模型接入（S7 ⑤）
apiRouter.use('/stats', statsRouter);
apiRouter.use(localModelRouter); // 2026-08-09：父级带 /stats 前缀，端点注册在 statsRouter 根路径