-- 数据模型 schema（一次性建表）
-- - users：PRD §6.2.1 用户表 19 字段（S1 建，本期不填数据）
-- - policy_*：PRD §6.2 政策内容管理（S2）
-- 新增表用 CREATE TABLE IF NOT EXISTS，旧库升级不破坏已有数据。

-- ============ 用户表（S1，19 业务字段 + 2 系统字段） ============
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,                 -- UUID
  employee_no     TEXT UNIQUE,                      -- 工号
  name            TEXT NOT NULL,                    -- 姓名
  email           TEXT UNIQUE,                      -- 邮箱
  phone           TEXT,                             -- 手机
  gender          TEXT,                             -- 性别（选项字段，S6 字典）
  department      TEXT,                             -- 部门（核心个性化）
  position        TEXT,                             -- 岗位（核心个性化）
  region          TEXT,                             -- 地区（选项字段，单层，核心个性化）
  birthday        TEXT,                             -- 生日 ISO
  hire_date       TEXT,                             -- 入职日期 ISO（核心个性化，算司龄）
  contract_type   TEXT,                             -- 合同类型（选项字段，核心个性化）
  level_type      TEXT,                             -- 层级类型（选项字段，混合字典，核心个性化）
  other_tags      TEXT,                             -- 其他标签（选项字段，JSON 数组）
  source_type     TEXT,                             -- 来源类型 csv/ad/feishu
  external_id     TEXT,                             -- 外部 ID（幂等键）
  open_id         TEXT,                             -- 飞书 open_id（深链+SSO）
  password_hash   TEXT,                             -- 密码 hash（scrypt$salt$hash，S6 登录 2026-08-07）
  timezone        TEXT DEFAULT '+08:00',            -- 用户时区（默认北京；PRD §5.3 多时区）
  language        TEXT DEFAULT 'zh-CN',             -- 用户界面语言（BCP47 zh-CN/en-US，2026-08-13 i18n 权威字段）
  role            TEXT,                             -- 角色（S6 启用）
  status          TEXT DEFAULT 'active',            -- 状态（S6 启用）
  must_change_password INTEGER DEFAULT 0,           -- 首次登录强制改密标志（新建/导入/重置置1，改密清零；2026-08-09）
  custom_1 TEXT, custom_2 TEXT, custom_3 TEXT, custom_4 TEXT, custom_5 TEXT,  -- 预留自定义字段槽位（2026-08-11）
  custom_6 TEXT, custom_7 TEXT, custom_8 TEXT, custom_9 TEXT, custom_10 TEXT, -- 管理员定义用途：权限可见性/规则/对话上下文/CSV
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external
  ON users (source_type, external_id)
  WHERE source_type IS NOT NULL AND external_id IS NOT NULL;

-- ============ 登录会话（S6 完整用户系统，2026-08-07） ============
-- 服务端 token：登录发随机 token，请求带 Authorization: Bearer <token>；登出吊销；有效期 7 天
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,                     -- 随机 token（crypto.randomBytes(32).hex）
  user_id     TEXT NOT NULL,                        -- 所属用户
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at  TEXT NOT NULL,                        -- 过期时间（ISO，查询时过滤）
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- ============ 政策库（S2）============
CREATE TABLE IF NOT EXISTS policy_libraries (
  id              TEXT PRIMARY KEY,                 -- 系统生成
  name            TEXT NOT NULL,                    -- 多语言字段（JSON，至少中/英），S2 简化先存 TEXT，显示按 UI 语言 fallback
  name_i18n       TEXT,                             -- 预留：多语言 JSON 结构（S6/S7 接）
  description     TEXT,                             -- 说明
  status          TEXT DEFAULT 'active',            -- 启用/停用；停用联动库内文件统一不可检索
  default_visibility TEXT,                          -- 默认可见范围（多选权限组 JSON，S6 生效）
  admin_ids       TEXT,                             -- 管理员 ID 列表（JSON 数组，S6 生效；旧方案，兼容保留）
  admin_group_ids TEXT,                             -- 管理组 id JSON（旧方案：库上配管理组；方案 B 已移上角色，兼容保留）
  visible_rules   TEXT,                             -- 库级默认可见条件 JSON（ABAC，2026-08-07；NULL=全员）
  apply_rules     TEXT,                             -- 库级适用范围规则 JSON（与 visible_rules 同构，2026-08-12；NULL=全员适用）
  created_by      TEXT,                             -- 创建人
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============ 政策线（业务语义，跨版本稳定） ============
CREATE TABLE IF NOT EXISTS policy_lines (
  id              TEXT PRIMARY KEY,                 -- 系统自动编码，URL 稳定锚点
  library_id      TEXT NOT NULL,                    -- 所属政策库
  name            TEXT NOT NULL,                    -- 名称/标题
  policy_type     TEXT,                             -- 政策类型（后台可配选项，如 制度/规定/办法）
  doc_no          TEXT,                             -- 文档编号（合规追溯）
  topic           TEXT,                             -- 主题分类（选项，对接人路由 + 统计，S5 起）
  security_level   TEXT,                            -- 密级（可配选项，联动默认可见范围，S6 生效）
  publish_org     TEXT,                             -- 发布单位
  visibility      TEXT,                             -- 可见范围（权限组多选 JSON，S6 生效）
  tags            TEXT,                             -- 标签（JSON 数组，可扩展）
  legal_basis     TEXT,                             -- 依据法规
  visible_rules   TEXT,                             -- 文件级可见条件 JSON（ABAC，NULL=继承库，2026-08-07）
  apply_rules     TEXT,                             -- 文件级适用范围规则 JSON（NULL=继承库，2026-08-12；废弃 apply_region/apply_audience）
  created_by      TEXT,
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (library_id) REFERENCES policy_libraries(id)
);

-- ============ 版本（生命周期 + 内容） ============
CREATE TABLE IF NOT EXISTS policy_versions (
  id              TEXT PRIMARY KEY,                 -- 系统生成（版本级 URL）
  line_id         TEXT NOT NULL,                    -- 所属政策线
  version_no      TEXT,                             -- 版本号（手填，非必须，不自动递增）
  status          TEXT DEFAULT 'draft',            -- 草稿/已发布/失效
  language        TEXT DEFAULT 'zh',               -- 语言（多选字段 JSON，如 '["zh","en"]'）
  effective_from  TEXT,                             -- 生效开始日期（必填，ISO yyyy-mm-dd）
  effective_to    TEXT,                             -- 生效结束日期（可空=长期）
  change_note     TEXT,                             -- 变更说明
  original_file_path TEXT,                           -- 原始文件路径（永存不修改）
  original_file_name TEXT,                           -- 原始文件名
  markdown_content TEXT,                             -- 系统生成的 Markdown 原文库
  html_content    TEXT,                             -- S2：Word→HTML 渲染用（员工阅读界面）
  convert_status   TEXT DEFAULT 'pending',          -- 转换中/预览/已确认（pending/converting/preview/confirmed）
  convert_quality  TEXT,                            -- 转换质量标记（ok/need_review）
  slice_plan       TEXT,                            -- 段落+切分线 JSON（PRD §4.2.2 编辑模型）
  index_status    TEXT DEFAULT 'not_indexed',       -- 未入库/已向量化（S3）
  published_by    TEXT,                             -- 发布人
  published_at    TEXT,                             -- 发布时间
  created_by      TEXT,
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (line_id) REFERENCES policy_lines(id)
);

-- 版本区间不重叠靠业务层校验 + 发布时自动闭合旧版（PRD §4.2.3）
CREATE INDEX IF NOT EXISTS idx_versions_line ON policy_versions (line_id);
CREATE INDEX IF NOT EXISTS idx_versions_status ON policy_versions (status);

-- ============ 切片方案（S2 持久化，8 字段，PRD §4.4.1） ============
CREATE TABLE IF NOT EXISTS policy_chunks (
  id              TEXT PRIMARY KEY,                 -- 入库后回填关联 Chroma id（S3）
  version_id      TEXT NOT NULL,                    -- 所属版本
  chunk_index     INTEGER NOT NULL,                 -- 切片序号
  start_pos       INTEGER,                          -- 切分位置（Markdown 字符偏移）
  end_pos         INTEGER,
  content         TEXT,                             -- chunk 文本（便于预览展示）
  retained        INTEGER DEFAULT 1,                -- 是否向量化（1→入库；0→仅原文可见 / 丢弃）
  level           TEXT,                             -- 标题层级 H1/H2/H3
  has_table       INTEGER DEFAULT 0,                -- 是否含表格
  section_path    TEXT,                             -- 章节路径（去重键 + 上下文重构，S3）
  anchor          TEXT,                             -- URL 锚点（slug，S3 引用跳转）
  language        TEXT,                             -- 段语言（按段检测，S3 入库用）
  type            TEXT DEFAULT 'body',              -- body/cover/toc/header_footer（S2 切片预览标记）
  adjacent_prev_id TEXT,                             -- 前相邻 chunk id（S3）
  adjacent_next_id TEXT,                             -- 后相邻 chunk id（S3）
  token_count     INTEGER,                          -- S3 技术详情
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (version_id) REFERENCES policy_versions(id)
);
CREATE INDEX IF NOT EXISTS idx_chunks_version ON policy_chunks (version_id, chunk_index);

-- ============ 图片资源（S2） ============
CREATE TABLE IF NOT EXISTS policy_images (
  id              TEXT PRIMARY KEY,
  version_id      TEXT NOT NULL,
  original_name   TEXT,                             -- 原文件名
  stored_path     TEXT NOT NULL,                    -- 本地存储路径（HTML 预览引用）
  alt_text        TEXT,                             -- 图片描述文本（纳入所在 chunk）
  position        INTEGER,                          -- 原文段落位置（渲染时插入）
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (version_id) REFERENCES policy_versions(id)
);

-- ============ 引用关系（双向自动链接，PRD §4.2.4） ============
CREATE TABLE IF NOT EXISTS policy_references (
  id              TEXT PRIMARY KEY,
  from_line_id    TEXT NOT NULL,                    -- 引用方政策线
  to_line_id      TEXT NOT NULL,                    -- 被引用方政策线
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (from_line_id, to_line_id),
  FOREIGN KEY (from_line_id) REFERENCES policy_lines(id),
  FOREIGN KEY (to_line_id) REFERENCES policy_lines(id)
);
CREATE INDEX IF NOT EXISTS idx_refs_from ON policy_references (from_line_id);
CREATE INDEX IF NOT EXISTS idx_refs_to ON policy_references (to_line_id);

-- ============ 业务主题路由表（S5：三场景②行动链接 ③联系人 用） ============
-- 2026-08-06 重构：链接归 processes，本表只留对接人（主题+地区→用户）；旧结构（topic/action_link/contact_*）由迁移脚本处理
CREATE TABLE IF NOT EXISTS topic_routes (
  id              TEXT PRIMARY KEY,
  topic_id        TEXT NOT NULL,                    -- 关联 policy_topics.id
  region          TEXT,                             -- 地区（空=主题级兑底）
  contact_user_id TEXT,                             -- 对接人 → users.id（联系方式/open_id 从用户表读）
  sort            INTEGER DEFAULT 0,
  enabled         INTEGER DEFAULT 1,
  description     TEXT,
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (topic_id) REFERENCES policy_topics(id),
  FOREIGN KEY (contact_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_routes_topic ON topic_routes (topic_id, region);

-- ============ 配置中心（2026-08-06） ============
-- 参数/提示词 KV 表：type 驱动配置页渲染；value NULL = 用默认值（重置=置 NULL）
CREATE TABLE IF NOT EXISTS app_configs (
  key            TEXT PRIMARY KEY,
  module         TEXT NOT NULL,                     -- efficient / smart / common / model
  section        TEXT NOT NULL,                     -- intent / retrieve / generate / reply / home / ui / session ...
  label          TEXT NOT NULL,                     -- 展示名（中文）
  type           TEXT NOT NULL DEFAULT 'text',      -- bool / number / text（单行）/ textarea（多行）/ list / json / select
  value          TEXT,                              -- 当前值；NULL=用默认
  default_value  TEXT NOT NULL,
  value_en       TEXT,                              -- 用户可见文案类 key 的英文值（locale=en → value_en ?? value，2026-08-13；提示词/参数不填）
  label_en       TEXT,                              -- 配置项展示名英文（locale=en → label_en ?? label，2026-08-13；i18n 迁移列同步入 schema，2026-08-13）
  description_en TEXT,                              -- 配置项说明英文（同 label_en，2026-08-13）
  variables      TEXT,                              -- 提示词可用变量说明（JSON）
  options        TEXT,                              -- 枚举选项（JSON，select 用）
  description    TEXT,
  sort           INTEGER DEFAULT 0,
  updated_at     TEXT,
  updated_by     TEXT,
  hidden         INTEGER DEFAULT 0,       -- 2026-08-13：隐藏标记（配置页不显示、读链保留：getConfig 按 key 直读不受影响）
  i18n           INTEGER DEFAULT 0        -- 2026-08-14：用户可见文案类标记（1=配置页显示英文值编辑区，双语维护；提示词/参数不标）
);
CREATE INDEX IF NOT EXISTS idx_configs_module ON app_configs (module, section, sort);

-- 业务主题字典（纯配置，双模式共用；scope 注入意图识别提示词）
CREATE TABLE IF NOT EXISTS policy_topics (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_en     TEXT,
  keywords    TEXT,                                -- 关键词/同义词 JSON
  scope       TEXT,                                -- 范围说明（涵盖…；不含…，注入意图识别）
  sort        INTEGER DEFAULT 0,
  enabled     INTEGER DEFAULT 1,
  description TEXT,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 动作意图字典（类型固定需开发，描述提示词可配；仅高效模式）
CREATE TABLE IF NOT EXISTS intent_types (
  id          TEXT PRIMARY KEY,                    -- query / contact / process / other
  name        TEXT NOT NULL,
  name_en     TEXT,
  prompt_desc TEXT NOT NULL,                       -- 注入意图识别提示词
  sort        INTEGER DEFAULT 0,
  enabled     INTEGER DEFAULT 1,
  description TEXT,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 流程字典（流程→URL，与主题解耦；纯 LLM 识别 flow 后推送）
CREATE TABLE IF NOT EXISTS processes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_en     TEXT,
  url         TEXT NOT NULL,                       -- 飞书/OA 流程链接
  topic_id    TEXT,                                -- 兑底主题（可空：如离职无主题）
  keywords    TEXT,                                -- 展示/辅助关键词 JSON
  sort        INTEGER DEFAULT 0,
  enabled     INTEGER DEFAULT 1,
  description TEXT,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (topic_id) REFERENCES policy_topics(id)
);

-- ============ 对话与消息（S3） ============
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,                 -- session_id（前端传 X-Session-Id）
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,                 -- message_id UUID
  session_id      TEXT NOT NULL,                    -- 所属对话
  user_id         TEXT,                             -- 归属用户（2026-08-07 历史按用户隔离；S4 前留空/admin）
  role            TEXT NOT NULL,                    -- user / assistant
  content         TEXT,
  question        TEXT,                             -- 仅 role=user：原始问题
  citations       TEXT,                             -- JSON：[{chunk_id, source, section, anchor}]
  mode            TEXT DEFAULT 'efficient',
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  latency_ms      INTEGER,                          -- 单轮完整耗时
  first_token_ms  INTEGER,
  retrieve_ms     INTEGER,                           -- 检索耗时
  rerank_ms       INTEGER,
  bm25_count      INTEGER,
  vector_count    INTEGER,
  fused_count     INTEGER,
  reranked_count  INTEGER,
  cited_count     INTEGER,
  rejected        INTEGER DEFAULT 0,               -- 是否拒答
  hallucination   INTEGER DEFAULT 0,               -- 引用空但已答（幻觉信号）
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (session_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, created_at);

-- ============ 满意度反馈（S3） ============
CREATE TABLE IF NOT EXISTS feedbacks (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  value           TEXT NOT NULL,                     -- up / down
  reason          TEXT,                             -- 不准确/没找到/看不懂/引用有误/其他
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_feedbacks_session ON feedbacks (session_id);

-- ============ 引用计数预聚合表（2026-08-09，统计性能优化方案 a） ============
-- 保存消息时按天记账（day×line_id×source → count），统计引用排名直接查本表（几十行），
-- 不再每次全量拉取 citations JSON 到内存 JS 聚合（数据量增长后是最大性能隐患）
CREATE TABLE IF NOT EXISTS policy_citation_stats (
  day         TEXT NOT NULL,                        -- 本地日期 YYYY-MM-DD（服务器时区）
  line_id     TEXT NOT NULL,                        -- 政策线 id（库排名用）
  source      TEXT NOT NULL,                        -- 政策名（政策排名用）
  count       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (day, line_id, source)
);

-- 统计查询日期范围索引（2026-08-09，方案 b）：created_at 独立索引 + ISO 字符串范围比较（不包函数）
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);
-- ============ LLM 模型接入配置（S7 ⑤，2026-08-09，PRD §4.4.9 / TECH §3.8） ============
-- 单行表：id 恒为 1（PRIMARY KEY CHECK）；api_key_enc 为 AES-256-GCM 密文（secrets.ts），
-- 明文永不落库；NULL 字段=用 provider 默认/未配置；环境变量仅在无行时兑底
CREATE TABLE IF NOT EXISTS llm_config (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  provider      TEXT NOT NULL DEFAULT 'deepseek',   -- openai / anthropic / deepseek / custom（云端）
  base_url      TEXT,                               -- 自定义 baseUrl；NULL=用 provider 预设默认
  model         TEXT,                               -- 模型名（如 deepseek-v4-flash）；NULL=未配置
  api_key_enc   TEXT,                               -- 密文（aes-gcm$<iv>$<tag>$<cipher>）；NULL=未配置（B3 后废弃，改用加密文件 llm.key.enc）
  -- 2026-08-09 本地模型（llama.cpp）：接入模式 + 本地参数（默认保守，上限放开由管理员调）
  mode          TEXT NOT NULL DEFAULT 'cloud',      -- cloud=云端 API / local=本地模型（A2 二选一随时切换）
  engine        TEXT DEFAULT 'llama.cpp',           -- 本地引擎（本期固定 llama.cpp，预留扩展）
  model_file    TEXT,                               -- 本地 GGUF 文件路径（models/llm/<名>/<file>.gguf）
  ctx_size      INTEGER DEFAULT 16384,              -- 上下文长度（手填；8GB 显卡建议 ≤16K，高显存可加大，模型运行时校验）
  kv_quantize   INTEGER DEFAULT 1,                  -- KV cache 量化（1=开 q8_0 省显存 / 0=关 大显存可关）
  gpu_layers    INTEGER DEFAULT 40,                 -- GPU 层数（-1=全量/0=CPU/N=前N层；WDDM 下须显式指定，40 实测 8GB 可跑）
  thinking      INTEGER DEFAULT 0,                  -- 思考模式（0=关/1=开；本地默认关——9B 思考成本高收益低；云端/本地独立）
  concurrency   INTEGER DEFAULT 2,                  -- 本地并发数（B4：2 并发 + 排队超时）
  queue_timeout INTEGER DEFAULT 60000,              -- 排队超时 ms（B4：超 60s 取消）
  updated_at    TEXT,
  updated_by    TEXT
);

-- ============ 权限模型（S6 混合模型，2026-08-07，PRD §3.3 / TECH §3.6.x） ============
-- 用户组（RBAC：功能 + 管理范围载体；动态条件 + 手动成员并存）
CREATE TABLE IF NOT EXISTS user_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,                        -- 组名（如 系统管理员组 / 政策库管理员组 / 总部政策管理组）
  type        TEXT NOT NULL DEFAULT 'manual',       -- builtin(内置) / manual(手动) / dynamic(已废弃兼容)；方案 B：仅 builtin 语义
  description TEXT,
  enabled     INTEGER DEFAULT 1,
  sort        INTEGER DEFAULT 0,
  function_ids TEXT,                                -- 方案 B 功能勾选 JSON（policy_mgmt/user_mgmt/role_mgmt/config_mgmt/query）
  managed_library_ids TEXT,                         -- 方案 B 管理范围 JSON（勾选库 id，含 "ALL" 全部标记）
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT
);
-- 动态组条件：同 rule_no 的条件 = AND（同时满足）；不同 rule_no = OR（任一规则满足）；字段 in 多值
CREATE TABLE IF NOT EXISTS user_group_rules (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  rule_no     INTEGER DEFAULT 0,                    -- 规则组号（AND 组）
  field       TEXT NOT NULL,                        -- 选项字段 key（引用 field_dicts.key）
  operator    TEXT DEFAULT 'in',                    -- in(包含) / not_in(不包含)；2026-08-07 扩展
  allowed_values TEXT NOT NULL,                    -- JSON 数组（多选，values 为保留字）
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_group_rules_group ON user_group_rules (group_id);
-- 手动成员（动态组不存，实时算；手动+动态并存）
CREATE TABLE IF NOT EXISTS user_group_members (
  group_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  type        TEXT DEFAULT 'include',               -- include(包含，直接加入) / exclude(排除，满足规则也排除)；2026-08-07
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (group_id, user_id)
);
-- 字段字典（选项字段配置，S6 完整版做界面；本期预留 key 引用）
CREATE TABLE IF NOT EXISTS field_dicts (
  key         TEXT PRIMARY KEY,                     -- 字段 key（region/contract_type/level_type/department/position/custom_1~10）
  name        TEXT NOT NULL,                        -- 显示名（当前语言）
  name_i18n   TEXT,                                 -- 显示名多语言 JSON {"zh":"...","en":"..."}（2026-08-11，与整体 i18n 同构）
  type        TEXT NOT NULL DEFAULT 'option',       -- option(单选) / multi(多选，存 JSON 数组) / text(文本)（2026-08-11）
  options     TEXT,                                 -- 【废弃】JSON 数组（旧模型，存量迁移后置空；选项移入 field_dict_options）
  is_system   INTEGER DEFAULT 0,                    -- 内置字段=1（region/contract_type/level_type/department/position）：不可停用/删除（2026-08-11）
  required    INTEGER DEFAULT 0,                    -- 业务级必填（2026-08-11）：新建/编辑/导入时该字段必须填写；工号/姓名系统必填不进此表
  in_context  INTEGER DEFAULT 0,                    -- 注入对话上下文（2026-08-11）：仅该字段参与个性化资格判断（内置核心字段默认 1，预留字段默认 0）
  enabled     INTEGER DEFAULT 1,
  sort        INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT
);
-- 选项独立表（2026-08-11：值/名分离——value 稳定编码匹配用，label 显示名可改/多语言；选项生命周期：改名/停用/删除-引用检查）
CREATE TABLE IF NOT EXISTS field_dict_options (
  id          TEXT PRIMARY KEY,
  field_key   TEXT NOT NULL,
  value       TEXT NOT NULL,                        -- 匹配/存储用（手填唯一；存量保持中文值，新选项英文编码）
  label       TEXT NOT NULL,                        -- 显示名（当前语言）
  label_en    TEXT,                                 -- 显示名英文（i18n）
  enabled     INTEGER DEFAULT 1,                    -- 停用：新数据不可选，存量显示，历史规则生效
  sort        INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT,
  UNIQUE (field_key, value),
  FOREIGN KEY (field_key) REFERENCES field_dicts(key)
);
CREATE INDEX IF NOT EXISTS idx_field_options_key ON field_dict_options (field_key, enabled, sort);
-- 用户导入字段元数据（2026-08-07，CSV 导入/导出/模板 schema 驱动）：
-- 未来 users 表新增定制字段 → 加一行此表 → 模板/导出/导入零代码适配
CREATE TABLE IF NOT EXISTS user_import_fields (
  field       TEXT PRIMARY KEY,                     -- users 表字段名（id/employee_no/.../custom_x）
  label       TEXT NOT NULL,                        -- CSV 列头中文名
  type        TEXT NOT NULL DEFAULT 'text',         -- text / option
  required    INTEGER DEFAULT 0,                    -- 必填（工号/姓名）
  unique_key  INTEGER DEFAULT 0,                    -- 唯一约束（工号/邮箱；email 暂保持唯一）
  dict_key    TEXT,                                 -- option 类型对应的 field_dicts.key
  importable  INTEGER DEFAULT 1,                    -- 是否可导入（password_hash 等禁导入）
  sort        INTEGER DEFAULT 0
);
-- 可见性/管理范围扩展列（存量库由迁移脚本 ALTER 补列）
-- policy_libraries: admin_group_ids(JSON 管理组) + visible_rules(JSON 库级可见条件)
-- policy_lines: visible_rules(JSON 文件级可见条件, NULL=继承库)
