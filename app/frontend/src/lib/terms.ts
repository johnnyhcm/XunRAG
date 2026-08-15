// 术语对照（PRD §8 准则 6：用用户的词；en 唯一出处见 PRD §8 en 列）
// 系统态 → 用户可见词，全站唯一出处；locale 感知：en 取 en.json 的 terms.*，缺省回退中文（i18next fallback）
// 注意：本模块的 label 函数依赖 i18n.t，组件中如需随语言切换重渲染，请配合 useTranslation() 订阅
import i18n from '../i18n';

const ZH: Record<string, Record<string, string> | string> = {
  status: { draft: '草稿', published: '已生效', invalid: '已废止' },
  libStatus: { active: '启用', inactive: '已停用' },
  convert: { pending: '待上传', converting: '转换中', preview: '待确认', confirmed: '已确认' },
  indexStatus: { not_indexed: '未入库（不可问答）', indexed: '已入库（可问答）' },
  mode: { efficient: '高效模式', smart: '智能模式' },
  chunkType: { cover: '封面', toc: '目录', header_footer: '页眉页脚', body: '正文' },
  feedback: { up: '有帮助', down: '需改进' },
  reject: '未在政策库中找到相关内容',
} as const;

const label = (group: string, key: string): string => {
  const map = ZH[group];
  const zhFallback = (map && typeof map === 'object' ? (map as Record<string, string>)[key] : undefined) ?? key;
  return i18n.t(`terms.${group}.${key}`, { defaultValue: zhFallback });
};

/** 原始 zh 映射（非组件/静态场景兜底用）；界面显示请用 label 函数 */
export const TERM = ZH;

export const statusLabel = (s: string): string => label('status', s);
export const libStatusLabel = (s: string): string => label('libStatus', s);
export const convertLabel = (s: string): string => label('convert', s);
export const chunkTypeLabel = (s: string): string => label('chunkType', s);
export const modeLabel = (s: string): string => label('mode', s);
export const feedbackLabel = (s: string): string => label('feedback', s);
export const rejectText = (): string => label('reject', 'reject');
