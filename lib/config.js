/**
 * 配置归一化：把所有可调项收成一份冻结对象，缺省值全在这里。
 * 纯函数，便于单测；非法值直接抛错（插件加载时就暴露，而不是运行到一半才炸）。
 */

/** 三档强度：tone 底色 / portrait 画像 / standin 替身。 */
export const STRENGTHS = Object.freeze(['tone', 'portrait', 'standin']);

/** 强度档位的中文名（日志与界面共用）。 */
export const STRENGTH_LABEL = Object.freeze({ tone: '底色', portrait: '画像', standin: '替身' });

export const DEFAULTS = Object.freeze({
  enabled: true,
  /** 数据根目录；null = <DSH_HOME>/conversation-identity。 */
  storeDir: null,

  // ── 注入 ──────────────────────────────────────────────────────────
  /** 系统提示词里的段落顺序：比记忆段（9000）小，先于记忆出现。 */
  injectOrder: 8960,
  /** 新建会话时绑定身份的默认强度。 */
  defaultStrength: 'portrait',
  /** 各档的字数上限（不含记忆与锚点，它们各有自己的预算）。 */
  maxCharsByStrength: Object.freeze({ tone: 320, portrait: 900, standin: 1600 }),
  /** 是否允许替身档表达情绪（用户明确要求允许，但要用四条禁令压住）。 */
  allowEmotion: true,
  /** 记忆段最多注入多少条事实。 */
  memoryMaxEntries: 24,
  /** 锚点最多注入几条（替身档）。 */
  anchorsMax: 6,

  // ── 提炼 ──────────────────────────────────────────────────────────
  /** 提炼用的 provider/model；null = 跟当前会话同款模型。 */
  provider: null,
  model: null,
  language: 'auto',
  /** 单次请求的输入字数上限。 */
  distillMaxInputChars: 24000,
  /** 分块时每块的目标字数。 */
  chunkChars: 11000,
  /** 最多分几块（超过就抽样并标注）。 */
  maxChunks: 12,
  maxOutputTokens: 16000,
  timeoutMs: 180000,

  // ── 导入 ──────────────────────────────────────────────────────────
  /** 切出多少轮做回放测试（这些轮次不会给提炼模型看）。 */
  heldOutTurns: 20,
  /** 纯文本里识别说话人的标签，逗号分隔；空 = 用内置集合。 */
  meLabels: '',
  themLabels: '',
  /** 导入时默认是否顺带提炼记忆。 */
  memoryOnImport: true,
  /**
   * 命令里「直接开跑」的调用次数上限：预估 ≤ 这个数就不再二次确认（短记录一次到位）。
   * 0 = 永远要求确认。长记录（十几次调用）仍然会停下来问。
   */
  autoRunMaxCalls: 6,
  /** 记录文件里单条消息保留的最大字数。 */
  maxMessageChars: 4000,
});

function integer(value, fallback, min, max, field) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) throw new Error(`conversation-identity: ${field} 必须是整数`);
  return Math.min(max, Math.max(min, number));
}

function text(value, fallback, max, field) {
  if (value === undefined || value === null) return fallback;
  const string = String(value).trim();
  if (string.length === 0) return fallback;
  if (string.length > max) throw new Error(`conversation-identity: ${field} 最多 ${max} 个字符`);
  return string;
}

function bool(value, fallback, field) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`conversation-identity: ${field} 必须是布尔值`);
  return value;
}

/**
 * @param {unknown} raw - cordis patch 里的 config（可省略）。
 * @returns {object} 冻结后的配置。
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const strength = input.defaultStrength === undefined ? DEFAULTS.defaultStrength : input.defaultStrength;
  if (!STRENGTHS.includes(strength)) {
    throw new Error(`conversation-identity: defaultStrength 只能是 ${STRENGTHS.join(' | ')}，收到 ${JSON.stringify(strength)}`);
  }
  const language = input.language === undefined ? DEFAULTS.language : input.language;
  if (language !== 'auto' && language !== 'zh' && language !== 'en') {
    throw new Error(`conversation-identity: language 只能是 auto | zh | en，收到 ${JSON.stringify(language)}`);
  }
  const chars = input.maxCharsByStrength !== null && typeof input.maxCharsByStrength === 'object'
    ? input.maxCharsByStrength
    : {};
  const maxCharsByStrength = Object.freeze({
    tone: integer(chars.tone, DEFAULTS.maxCharsByStrength.tone, 120, 4000, 'maxCharsByStrength.tone'),
    portrait: integer(chars.portrait, DEFAULTS.maxCharsByStrength.portrait, 120, 4000, 'maxCharsByStrength.portrait'),
    standin: integer(chars.standin, DEFAULTS.maxCharsByStrength.standin, 120, 6000, 'maxCharsByStrength.standin'),
  });
  return Object.freeze({
    enabled: bool(input.enabled, DEFAULTS.enabled, 'enabled'),
    storeDir: input.storeDir === undefined || input.storeDir === null || input.storeDir === '' ? null : String(input.storeDir),
    injectOrder: integer(input.injectOrder, DEFAULTS.injectOrder, 0, 100000, 'injectOrder'),
    defaultStrength: strength,
    maxCharsByStrength,
    allowEmotion: bool(input.allowEmotion, DEFAULTS.allowEmotion, 'allowEmotion'),
    memoryMaxEntries: integer(input.memoryMaxEntries, DEFAULTS.memoryMaxEntries, 0, 200, 'memoryMaxEntries'),
    anchorsMax: integer(input.anchorsMax, DEFAULTS.anchorsMax, 0, 40, 'anchorsMax'),
    provider: input.provider === undefined || input.provider === null || input.provider === '' ? null : String(input.provider),
    model: input.model === undefined || input.model === null || input.model === '' ? null : String(input.model),
    language,
    distillMaxInputChars: integer(input.distillMaxInputChars, DEFAULTS.distillMaxInputChars, 4000, 200000, 'distillMaxInputChars'),
    chunkChars: integer(input.chunkChars, DEFAULTS.chunkChars, 2000, 100000, 'chunkChars'),
    maxChunks: integer(input.maxChunks, DEFAULTS.maxChunks, 1, 60, 'maxChunks'),
    maxOutputTokens: integer(input.maxOutputTokens, DEFAULTS.maxOutputTokens, 512, 32000, 'maxOutputTokens'),
    timeoutMs: integer(input.timeoutMs, DEFAULTS.timeoutMs, 5000, 900000, 'timeoutMs'),
    heldOutTurns: integer(input.heldOutTurns, DEFAULTS.heldOutTurns, 0, 200, 'heldOutTurns'),
    meLabels: text(input.meLabels, DEFAULTS.meLabels, 300, 'meLabels'),
    themLabels: text(input.themLabels, DEFAULTS.themLabels, 300, 'themLabels'),
    memoryOnImport: bool(input.memoryOnImport, DEFAULTS.memoryOnImport, 'memoryOnImport'),
    autoRunMaxCalls: integer(input.autoRunMaxCalls, DEFAULTS.autoRunMaxCalls, 0, 200, 'autoRunMaxCalls'),
    maxMessageChars: integer(input.maxMessageChars, DEFAULTS.maxMessageChars, 200, 20000, 'maxMessageChars'),
  });
}
