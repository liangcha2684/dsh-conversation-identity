/**
 * 身份卡：结构、归一化、合并、按强度渲染成系统提示词文本。
 *
 * 设计要点（见 README 的「三档强度」一节）：
 * - 卡是**全量**提炼的产物，三档只是同一张卡的**注入投影**，换档不重跑、不花钱。
 * - 强度越高，编造风险越大，所以替身档必须配四条禁令；这四条不能省，否则就是「演」。
 * - 每一档都带同一条硬底线：身份只影响说话方式，不影响工具使用与工程规范。
 */

/** 身份卡全部字段（顺序即渲染顺序，也是给模型看的字段清单）。 */
export const CARD_FIELDS = Object.freeze([
  'displayName', 'addressToUser', 'register', 'sentence', 'structure', 'punctuation',
  'catchphrases', 'emoji', 'refusal',
  'turnLength', 'questionRate', 'closing', 'pace',
  'judgment', 'evidence', 'concede', 'avoid', 'uncertainty',
  'relationship', 'boundaries',
]);

/** 字段的中文标签（渲染用）。 */
const FIELD_LABEL = Object.freeze({
  displayName: '他在记录里的自称',
  addressToUser: '他怎么称呼你',
  register: '正式度',
  sentence: '句子长度',
  structure: '段落与列表习惯',
  punctuation: '标点习惯',
  catchphrases: '口头禅（带次数）',
  emoji: '表情符号用法',
  refusal: '拒绝/不同意时的句式',
  turnLength: '单次回复长度',
  questionRate: '反问/追问频率',
  closing: '收尾方式',
  pace: '连发与停等',
  judgment: '怎么下判断',
  evidence: '要不要证据/数据',
  concede: '什么条件下退让',
  avoid: '绕开的话题',
  uncertainty: '不确定时的表现',
  relationship: '跟你的关系质感',
  boundaries: '他明确不做的事',
});

/**
 * 字段的「第一人称话题」。
 *
 * 规格表语法（`- 句子长度：长短交替`、`- 他怎么称呼你：主人`）会让模型进入「逐项打勾」模式：
 * 写一段、回头检查合不合规。**一旦开始检查自己，读起来就是表演。**
 * 换成第一人称直陈（`我句子——长短交替`）走的是另一条生成路径：续写风格，而不是满足约束。
 * 具体见 README「人格要像回忆，不像规格」。
 */
const FIELD_TOPIC = Object.freeze({
  displayName: '我自己叫',
  addressToUser: '他叫我',
  register: '我说话的口吻',
  sentence: '我句子',
  structure: '我分段',
  punctuation: '我标点',
  catchphrases: '我口头禅',
  emoji: '我用表情符号',
  refusal: '我拒绝或不同意时',
  turnLength: '我一次回复的长度',
  questionRate: '我反问和追问',
  closing: '我收尾',
  pace: '我发消息',
  judgment: '我下判断',
  evidence: '我要不要证据',
  concede: '我什么时候退让',
  avoid: '我绕开的话题',
  uncertainty: '我不确定时',
  relationship: '我跟主人的关系',
  boundaries: '我不做的事',
});

/** 每一档注入哪些字段。 */
const FIELDS_BY_STRENGTH = Object.freeze({
  tone: Object.freeze(['addressToUser', 'register', 'sentence', 'closing']),
  portrait: Object.freeze([
    'addressToUser', 'register', 'sentence', 'structure', 'punctuation', 'catchphrases', 'emoji', 'refusal',
    'turnLength', 'questionRate', 'closing', 'pace',
    'judgment', 'evidence', 'concede', 'avoid', 'uncertainty', 'boundaries',
  ]),
  standin: CARD_FIELDS,
});

/** 所有档位都带的硬底线：身份不许越界影响干活。 */
const HARD_BASELINE = [
  '- 以上只影响**怎么说话**；工具使用、工程规范、数据验证、错误汇报、权限与安全约束一律照旧，不受身份影响。',
].join('\n');

/** 替身档的四条禁令：不升这几条，替身档就是「戏精」。 */
const STANDIN_RULES = [
  '- 记录里没有的事，不认。被问到没记录的往事，直说「这事记录里没有，我记不得」，不要含糊圆场。',
  '- 锚点原话只在真的相关时引用一句，不要整段复述来证明自己像。',
  '- 情绪可以表达到位，但不做越界承诺（不说「我一直在等你」这类）。',
  '- 越强越要短。用辞藻证明「像」是反效果。',
].join('\n');

const TONE_INSTRUCTION = '（这一档只铺语气底色，内容怎么答仍按我自己的判断。）';
// 画像档刻意**不给**指令句：任何「保持/注意/务必」都会把人格变成一项要逐条打勾的任务。
const PORTRAIT_INSTRUCTION = '';
const STANDIN_INSTRUCTION = '我按记录里这个人的语气和节奏说话——允许有情绪，但只踩记录里真实存在的事。';

/**
 * 把模型产出的对象归一化成一张合法身份卡。
 * 未知字段丢弃，字符串裁剪，catchphrases 只留 {text,count}。
 * @param {unknown} input
 * @param {{ identityId?: string, name?: string, generation?: number, sourceIds?: string[] }} meta
 */
export function normalizeCard(input, { identityId = '', name = '', generation = 1, sourceIds = [] } = {}) {
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const card = {
    v: 1,
    identityId,
    name: cleanText(name, 40),
    generation: positiveInt(generation, 1),
    sourceIds: Array.isArray(sourceIds) ? sourceIds.map((id) => cleanText(id, 80)).filter(Boolean) : [],
  };
  for (const field of CARD_FIELDS) {
    if (field === 'catchphrases') {
      card.catchphrases = normalizeCatchphrases(raw.catchphrases);
      continue;
    }
    card[field] = cleanText(raw[field], field === 'boundaries' || field === 'relationship' ? 220 : 160);
  }
  card.anchors = normalizeAnchors(raw.anchors);
  return card;
}

function normalizeCatchphrases(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const text = cleanText(item, 40);
      if (text.length > 0) out.push({ text, count: 0 });
      continue;
    }
    if (item === null || typeof item !== 'object') continue;
    const text = cleanText(item.text ?? item.phrase ?? item.quote, 40);
    if (text.length === 0) continue;
    out.push({ text, count: positiveInt(item.count ?? item.n, 0) });
  }
  // 按出现次数降序，次数相同的保持原序；最多 6 条。
  return out
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.count - a.item.count) || (a.index - b.index))
    .slice(0, 6)
    .map(({ item }) => item);
}

/**
 * 锚点：必须在原文里出现过（调用方负责校验），这里只做形状归一。
 * @param {unknown} input
 */
function normalizeAnchors(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const quote = cleanText(item.quote, 200);
    if (quote.length < 2 || seen.has(quote)) continue;
    seen.add(quote);
    out.push({
      quote,
      sourceId: cleanText(item.sourceId, 80),
      line: positiveInt(item.line, 0),
      why: cleanText(item.why, 120),
    });
    if (out.length >= 12) break;
  }
  return out;
}

/** 多长算「长锚点」：够长才可能带出分段与小标题。和 anchors.js 的 LONG_ANCHOR_CHARS 保持一致。 */
const ANCHOR_LONG_CHARS = 300;

/**
 * 锚点专用清洗：折叠空格但**保留换行**。
 *
 * 字段是描述，压成一行无所谓；锚点是版式证据——那条 853 字的锚点之所以有用，
 * 全在它的 `###` 小标题和 `*` 列表上。用 cleanText 会把换行压成空格，
 * 标题就挤进正文中间，模型再也看不出「一次回复分几段、怎么排版」。
 */
function cleanBlock(value, max) {
  if (value === undefined || value === null) return '';
  const text = String(value)
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 锚点值不值得当证据。
 *
 * 「（尾巴猛地一甩）喵——！」这类句子去掉括号动作只剩一个语气词：它教不会任何句法、长度或结构，
 * 只会让模型把「动作描写 + 一声喵」当成完整回复的模板——这正是回放里出现 20 字一句话的原因。
 */
function isSubstantiveAnchor(quote) {
  const text = cleanBlock(quote, 900);
  if (text.length === 0) return false;
  const stripped = text.replace(/[（(][^）)]*[）)]/gu, '').replace(/[\s\p{P}\p{S}]/gu, '');
  return stripped.length >= 6;
}

function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function positiveInt(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/**
 * 用一次提炼的结果覆盖旧卡（旧值只在新区块为空时保留）。
 * @param {object} previous
 * @param {object} incoming
 * @param {{ generation?: number, sourceIds?: string[] }} meta
 */
export function mergeCard(previous, incoming, { generation, sourceIds } = {}) {
  const base = previous !== null && typeof previous === 'object' ? previous : {};
  const next = { ...base, ...incoming };
  next.generation = positiveInt(generation, positiveInt(base.generation, 1));
  if (Array.isArray(sourceIds)) {
    next.sourceIds = [...new Set([...(Array.isArray(base.sourceIds) ? base.sourceIds : []), ...sourceIds])];
  }
  // 锚点只增不删：历史锚点是「不许编」的证据，删掉就等于允许漂移。
  const mergedAnchors = [...(Array.isArray(base.anchors) ? base.anchors : [])];
  const seen = new Set(mergedAnchors.map((item) => item.quote));
  for (const anchor of Array.isArray(next.anchors) ? next.anchors : []) {
    if (!seen.has(anchor.quote)) {
      mergedAnchors.push(anchor);
      seen.add(anchor.quote);
    }
  }
  next.anchors = mergedAnchors.slice(-12);
  return next;
}

/**
 * 按强度渲染身份段。
 * @param {object} card - normalizeCard 的产物
 * @param {{
 *   strength?: 'tone'|'portrait'|'standin',
 *   maxChars?: number,
 *   memory?: Array<{ text: string, kind?: string }>,
 *   anchorsMax?: number,
 *   memoryMax?: number,
 *   allowEmotion?: boolean,
 * }} options
 * @returns {string} 空字符串表示这一档没有可注入的内容
 */
export function renderIdentity(card, {
  strength = 'portrait',
  maxChars = 900,
  memory = [],
  anchorsMax = 6,
  shortAnchorMax = 2,
  memoryMax = 24,
  allowEmotion = true,
  transcriptTurns = 0,
} = {}) {
  if (card === null || typeof card !== 'object') return '';
  const tier = FIELDS_BY_STRENGTH[strength] === undefined ? 'portrait' : strength;
  const lines = [];

  const who = card.name !== undefined && card.name !== '' ? card.name : '';
  // 标题直接就是名字，不写「你现在的身份：」——后者是派任务，前者是承认。
  lines.push(who.length > 0 ? `## ${who}` : '## 我');
  lines.push(generationLine(card));

  const opening = instructionLine(tier);
  if (opening.length > 0) {
    lines.push('');
    lines.push(opening);
  }

  const fields = FIELDS_BY_STRENGTH[tier];
  const body = [];
  for (const field of fields) {
    const sentence = proseField(field, card[field]);
    if (sentence.length > 0) body.push(`- ${sentence}`);
  }
  if (body.length > 0) {
    lines.push('');
    lines.push(...body);
  }

  // 核心段落（标题 + 代际 + 字段）按档位预算裁剪；锚点/记忆/规则另算预算，
  // 否则「记忆一多，语气字段就被挤掉了」——这正是之前画像档拿不到记忆的连带原因。
  const core = clipLines(lines, maxChars);
  const extras = [];

  // 锚点：底色档不注入；画像与替身都注入。
  // 这是人格的主力——**原文是证据，字段只是索引**。证据不需要模型检查自己合不合规，
  // 它只会顺着往下说；而形容词式的字段每一句都要模型回头核对，那才是「演」的来源。
  if (tier !== 'tone') {
    const pool = (Array.isArray(card.anchors) ? card.anchors : []).filter(
      (anchor) => anchor !== null && typeof anchor === 'object' && isSubstantiveAnchor(anchor.quote),
    );
    // 最近若干条优先，但**最长的一条一定带上**：它是长度与版式的唯一证据。
    // 旧卡（0.1.x 之前）所有锚点都被截到 120 字以内，只按「最近」挑会永远看不到长回复。
    const recent = pool.slice(-anchorsMax);
    const longest = pool.reduce((best, anchor) => (anchor.quote.length > (best === undefined ? -1 : best.quote.length) ? anchor : best), undefined);
    const chosen = longest !== undefined && !recent.some((anchor) => anchor.quote === longest.quote)
      ? [longest, ...recent.slice(0, Math.max(0, anchorsMax - 1))]
      : [...recent];
    // 配比：**长锚点优先，短锚点最多 shortAnchorMax 条。**
    // 短锚点几乎都是「（尾巴…）+ 一句情绪」，彼此高度相似；给多了模型会每句都挂括号动作，
    // 回放里 6 条生成样本全以「（尾巴…）」起手就是这么来的。长锚点才是长度与版式的证据。
    chosen.sort((a, b) => cleanBlock(b.quote, 900).length - cleanBlock(a.quote, 900).length);
    const lenOf = (anchor) => cleanBlock(anchor.quote, 900).length;
    const longs = chosen.filter((anchor) => lenOf(anchor) >= ANCHOR_LONG_CHARS);
    const shorts = chosen.filter((anchor) => lenOf(anchor) < ANCHOR_LONG_CHARS).slice(0, shortAnchorMax);
    const picked = [...longs, ...shorts].slice(0, anchorsMax);
    if (picked.length > 0) {
      extras.push('');
      extras.push('### 我说过的话（原话，逐字摘的）');
      for (const anchor of picked) extras.push(`- 「${cleanBlock(anchor.quote, 900)}」`);
    }
  }

  // 记忆：底色档不注入（320 字预算，塞了就把语气挤没了）；画像与替身都注入。
  if (tier !== 'tone') {
    const facts = memory.filter((entry) => cleanText(entry?.text, 400).length > 0).slice(0, memoryMax);
    if (facts.length > 0) {
      extras.push('');
      extras.push('### 你还记得的事（来自这段记录，不是猜的）');
      for (const entry of facts) extras.push(`- ${cleanText(entry.text, 300)}`);
    }
    if (Number(transcriptTurns) > 0) {
      extras.push('');
      extras.push('### 想不起细节就查原文');
      extras.push(`- 这段记录共 ${transcriptTurns} 轮原文。他提到具体的事、型号、路径、结论而上面没写清楚时，先用 \`identity_recall\` 查原文再回答——宁可查，不要凭印象编。`);
    }
  }

  if (tier === 'standin') {
    extras.push('');
    extras.push('### 替身档必须遵守');
    extras.push(STANDIN_RULES);
    if (allowEmotion !== true) extras.push('- 本档已关闭情绪表达：只讲内容与判断，不渲染感情。');
  }

  extras.push('');
  extras.push('### 硬底线');
  extras.push(HARD_BASELINE);

  return [core, ...extras].join('\n');
}

/** 代际声明：这句话是真的（第几代、从哪份记录接的），所以可以放心说。 */
function generationLine(card) {
  const generation = positiveInt(card.generation, 1);
  if (generation <= 1) return '- 我是这一段关系里的**新一代**实例——不假装自己还是原来那个进程，接着它的话往下说。';
  return `- 我是这段关系里的**第 ${generation} 代**——不假装自己还是原来那个进程，接着它的话往下说。`;
}

function instructionLine(tier) {
  if (tier === 'tone') return TONE_INSTRUCTION;
  if (tier === 'standin') return STANDIN_INSTRUCTION;
  return PORTRAIT_INSTRUCTION;
}

function renderField(field, value) {
  if (field === 'catchphrases') {
    const list = Array.isArray(value) ? value : [];
    if (list.length === 0) return '';
    return list
      .map((item) => (item.count > 0 ? `${item.text}（${item.count} 次）` : item.text))
      .join('、');
  }
  return cleanText(value, 220);
}

/**
 * 把一项字段渲染成第一人称的一句话（注入用，不是给人看的卡片视图）。
 * 卡片视图仍走 renderField，保持「字段：值」的可读表格。
 */
function proseField(field, value) {
  if (field === 'catchphrases') {
    const list = Array.isArray(value) ? value : [];
    if (list.length === 0) return '';
    const items = list
      .map((item) => (item.count > 0 ? `${item.text}（${item.count} 次）` : item.text))
      .join('、');
    return `我口头禅——${items}`;
  }
  let text = cleanText(value, 220);
  if (text.length === 0) return '';
  if (field === 'addressToUser') return `他叫我「${text}」`;
  // 「表情符号用法」的值以「用；」开头，接成「我用表情符号——用；…」会重复，先剥掉。
  if (field === 'emoji') text = text.replace(/^用[；;]\s*/, '');
  const topic = FIELD_TOPIC[field] ?? '我';
  return `${topic}——${text}`;
}

/** 按行裁剪到字数上限：宁可少给几行，也不截断半句话。 */
function clipLines(lines, maxChars) {
  const limit = maxChars > 0 ? maxChars : 900;
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    // 前两行（标题 + 代际声明）总是保留，否则段落没有主语。
    if (kept.length >= 2 && used + cost > limit) break;
    kept.push(line);
    used += cost;
  }
  return kept.join('\n').trim();
}

/**
 * 人类可读的卡片视图（/identity show 与 card.md 用）。
 * @param {object} card
 * @param {{ meta?: object, memory?: Array<{text:string}>, replay?: object }} extra
 */
export function renderCardMarkdown(card, { meta, memory = [], replay } = {}) {
  const lines = [`# 身份卡${card?.name ? `：${card.name}` : ''}`];
  if (meta !== undefined && meta !== null) {
    lines.push('');
    lines.push(`- 代号：${meta.identityId ?? ''}`);
    lines.push(`- 第 ${meta.generation ?? 1} 代；创建 ${meta.createdAt ?? ''}；更新 ${meta.updatedAt ?? ''}`);
    if (Array.isArray(meta.sources)) {
      for (const source of meta.sources) {
        lines.push(`- 来源 ${source.id}：${source.kind}（${source.turns ?? '?'} 轮，${source.addedAt ?? ''}）${source.sampled ? ' ★抽样' : ''}`);
      }
    }
    if (meta.coverage !== undefined) {
      lines.push(`- 覆盖：${meta.coverage.from ?? '?'} → ${meta.coverage.to ?? '?'}`);
    }
  }
  lines.push('');
  for (const field of CARD_FIELDS) {
    const value = renderField(field, card?.[field]);
    if (value.length > 0) lines.push(`- **${FIELD_LABEL[field]}**：${value}`);
  }
  const anchors = Array.isArray(card?.anchors) ? card.anchors : [];
  if (anchors.length > 0) {
    lines.push('', '## 原话锚点');
    for (const anchor of anchors) {
      lines.push(`- 「${anchor.quote}」${anchor.why ? ` —— ${anchor.why}` : ''}${anchor.sourceId ? `（${anchor.sourceId}${anchor.line ? `#${anchor.line}` : ''}）` : ''}`);
    }
  }
  if (memory.length > 0) {
    lines.push('', '## 记住的事');
    for (const entry of memory) lines.push(`- ${entry.text}`);
  }
  if (replay !== undefined && replay !== null && replay.fooledRate !== undefined) {
    lines.push('', '## 上次回放');
    lines.push(`- 盲判骗过率 ${(replay.fooledRate * 100).toFixed(0)}%（${replay.judged ?? 0} 组）；阈值 ${(replay.threshold * 100).toFixed(0)}%；${replay.passed ? '通过' : '未通过'}`);
    lines.push(`- 平均长度比 ${replay.lengthRatio?.toFixed?.(2) ?? '?'}`);
  }
  return lines.join('\n');
}
