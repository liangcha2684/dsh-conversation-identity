/**
 * 提炼层：把归一化转录变成身份卡。
 *
 * 三段式：
 *   1) 短记录（一次装得下）→ 直接出卡；
 *   2) 长记录 → 分块出「观察」，再合并成卡（合并那次才做取舍与冲突消解）；
 *   3) 记忆（可选）→ 单独一次，产出事实条目。
 *
 * 硬规则（写在 system 里，逐条对应设计里说过的坑）：
 *   - 只写记录里看出来的，看不出来留空，**不编**；
 *   - 锚点必须逐字摘录，之后再拿原文校验（见 validateAnchors）；
 *   - 频次权重 > 强度权重，单次事件不算性格（防「吵一次架写成易怒」）；
 *   - 用「他/你」，不要用「用户/助手」。
 *
 * 纯函数模块。
 */
import { normalizeCard } from './card.js';

const FIELD_SPEC = `- displayName: 他在记录里怎么自称或被称呼（一个名字，不要长句）
- addressToUser: 他怎么称呼你（原样，例如「波波」「你」「老铁」）
- register: 正式度——正式 / 随意 / 混用（混用时写清什么时候切）
- sentence: 句子长度倾向——短句为主 / 长句铺陈 / 长短交替
- structure: 段落与列表习惯——一句话解决 / 固定分三条 / 先结论再展开 / 几乎不分段
- punctuation: 标点习惯——省略号多、感叹号多、几乎不用问号 之类
- catchphrases: 口头禅数组，每条 {"text":"原话","count":出现次数}，最多 5 条，只收真的重复出现过的
- emoji: 用不用表情符号、在哪用（句尾/强调/不用）
- refusal: 拒绝或不同意时的句式（原样例式，不要评价）
- turnLength: 单次回复长度——平均几十字 / 一段 / 好几段
- questionRate: 反问与追问频率——几乎不反问 / 常反问 / 每轮都追问
- closing: 收尾方式——给结论 / 抛问题 / 留白
- pace: 连发还是停等——会不会连着发几条短消息
- judgment: 怎么下判断——先给结论还是先铺陈过程；下判断时用不用绝对语气
- evidence: 要不要证据/数据——张口就是数字 / 只讲感受 / 两者都要
- concede: 什么条件下退让（被指出哪类错误时改口）
- avoid: 绕开的话题（记录里明显不接的话题）
- uncertainty: 不确定时的表现——装懂 / 直说不知道 / 反问细节
- relationship: 跟你的关系质感（一句话，例如「同事式互怼，关键时站你这边」）
- boundaries: 他明确不做的事（拒绝过什么、画过什么线）`;

const SYSTEM_RULES = `你是一个「对话身份重建器」。输入是一段两个人之间的聊天记录（A=导入者自己，B=要被重建的那个人）。
你的任务：从 B 的发言里，还原 B 的说话方式、节奏和判断方式，写成一张可以注入给另一个模型的身份卡。

规则（逐条遵守）：
1. 只写记录里真的能看出来的。看不出来就留空字符串 ""，**绝对不要编**——编出来的特征会让重建出来的人变成另一个人。
2. 锚点（anchors）必须从原文**逐字摘录**（不超过 60 字），并给出行号；概括改写过的锚点无效。
3. 权重按**出现频次**，不按情绪强度。只出现一次的极端表现不要写进性格字段。
4. 描述用「他」「你」，不要用「用户」「助手」「AI」这类第三人称标签。
5. 所有字段都是**短句**（每个不超过 60 字），不要写成段落。
6. 只输出一个 JSON 对象，不要 Markdown 代码块、不要解释。

输出格式：
{"card":{${FIELD_SPEC.split('\n').map((line) => line.replace(/^- ([A-Za-z]+):.*$/, '"$1": ""')).join(',')}},"anchors":[{"quote":"原文逐字","line":123,"why":"这句说明什么"}]}`;

const MERGE_RULES = `你是一个「身份卡合并器」。输入是同一段聊天记录被分块观察后得到的多份观察（JSON 数组），以及已有的锚点。
你的任务：合并成一张身份卡。

规则：
1. **冲突消解**：同一字段多份观察说法不一致时，以出现次数多的为准；若明显是「前后期风格变化」，写近期的那一种，并在字段里用「（后期）」标注。
2. 只出现一次的观察，不要当成性格特征。
3. **anchors 至少 4 条**（最多 12 条）：必须是原文逐字摘录，优先留能说明「称呼」「句子长度」「拒绝句式」「收尾追问」的原话。**这一项不许省略。**
4. **catchphrases 至少 3 条**（确实重复出现过的才写，每条 {"text":"原话","count":出现次数}）。**这一项不许省略。**
5. 字段仍然要短（每不超过 60 字）；合并后不要变长，宁可比单块更概括。
6. 只输出一个 JSON 对象：{"card":{…},"anchors":[…]}
7. 就算时间紧，也先保证 anchors 与 catchphrases 有内容——它们是「不许编」的唯一依据。`;

/** 把转录渲染成给模型看的文本；total 用来让模型能被要求「只写第 N 段」。 */
export function renderTurns(turns, { maxChars = 24000, label = {} } = {}) {
  const lines = [];
  let used = 0;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const who = turn.speaker === 'them' ? (label.them ?? 'B') : (label.me ?? 'A');
    const body = String(turn.text ?? '').replace(/\s+\n/g, '\n').trim();
    if (body.length === 0) continue;
    const line = `${index + 1}. [${who}] ${body}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * 分块：超长记录不能全读，先切段；块数超上限就均匀抽样（并在 meta 上标 sampled）。
 * @param {object[]} turns
 * @param {{ chunkChars: number, maxChunks: number }} options
 */
export function planChunks(turns, { chunkChars = 11000, maxChunks = 12 } = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const chunks = [];
  let current = [];
  let size = 0;
  for (const turn of list) {
    const cost = String(turn.text ?? '').length + 24;
    if (current.length > 0 && size + cost > chunkChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(turn);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length <= maxChunks) return { chunks, sampled: false };
  // 均匀抽样：保住头（人设初印象）与尾（近期状态），中间等距取。
  const picked = [];
  const step = chunks.length / maxChunks;
  for (let index = 0; index < maxChunks; index += 1) picked.push(chunks[Math.floor(index * step)]);
  return { chunks: picked, sampled: true, totalChunks: chunks.length };
}

/** 单块/单次出卡的 prompt。 */
export function buildCardPrompt({ turns, language = 'auto', label }) {
  const dialog = renderTurns(turns, { label });
  return {
    system: `${SYSTEM_RULES}\n\n字段说明：\n${FIELD_SPEC}`,
    user: [
      `## 聊天记录（${turns.length} 轮，行号从 1 开始）`,
      '',
      dialog,
      '',
      `请按规则输出 JSON。语言：${language === 'en' ? 'English（但字段名保持英文）' : '中文'}。`,
    ].join('\n'),
  };
}

/** 分块观察的 prompt（输出 observations 形状，字段同卡）。 */
export function buildChunkPrompt({ turns, index, total, language = 'auto', label }) {
  const dialog = renderTurns(turns, { label });
  return {
    system: `你是「观察员」。只看这一块聊天记录，记下能观察到的特征——**看不出来就留空**，不要为凑满字段而编。
只输出 JSON：{"observations":{…同字段…},"anchors":[{"quote":"原文逐字","line":行号,"why":"说明什么"}]}。
字段：\n${FIELD_SPEC}`,
    user: [
      `## 第 ${index + 1}/${total} 块（${turns.length} 轮）`,
      '',
      dialog,
      '',
      `语言：${language === 'en' ? 'English（字段名保持英文）' : '中文'}。`,
    ].join('\n'),
  };
}

/** 合并 prompt。 */
export function buildMergePrompt({ observations, anchors = [], language = 'auto' }) {
  return {
    system: MERGE_RULES,
    user: [
      `## 分块观察（共 ${observations.length} 份）`,
      '',
      JSON.stringify({ observations, anchors }, null, 1),
      '',
      `语言：${language === 'en' ? 'English（字段名保持英文）' : '中文'}。`,
    ].join('\n'),
  };
}

/** 记忆提炼 prompt（只有勾了「延续记忆」才跑）。 */
export function buildMemoryPrompt({ turns, language = 'auto', label }) {
  const dialog = renderTurns(turns, { label });
  return {
    system: `你是「关系记忆提炼器」。从这段两个人的聊天里，提炼出被重建的那个人**当时知道的事**——他说过的事实、约定、结论、还没聊完的事。
规则：
1. 只提炼 B 说过的、或被两人确认过的内容；A 单方面说过但 B 没接住的，不算。
2. 每条自包含、不超过 60 字，不要出现「上面」「那次」这类指代。
3. 宁缺毋滥：3~15 条。寒暄、过程性描述不要。
4. 只输出 JSON：{"memories":[{"text":"…","kind":"fact|decision|task|question|context"}]}`,
    user: [`## 聊天记录`, '', dialog, '', `语言：${language === 'en' ? 'English' : '中文'}。`].join('\n'),
  };
}

/**
 * 从模型输出里抽第一个配平的 JSON 对象（容忍代码块与前后废话）。
 * @param {string} raw
 */
export function extractJson(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

export function parseJsonObject(raw) {
  const json = extractJson(raw);
  if (json === undefined) return undefined;
  try {
    const parsed = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 解析出卡结果 → { card, anchors }。 */
export function parseCardResponse(raw, { identityId, name, generation = 1, sourceIds = [] } = {}) {
  const parsed = parseJsonObject(raw);
  if (parsed === undefined) return undefined;
  const payload = parsed.card !== null && typeof parsed.card === 'object' ? parsed.card : parsed;
  const card = normalizeCard({ ...payload, anchors: parsed.anchors ?? payload.anchors }, { identityId, name, generation, sourceIds });
  return { card, anchors: card.anchors };
}

/** 解析观察块 → { observations, anchors }。 */
export function parseChunkResponse(raw) {
  const parsed = parseJsonObject(raw);
  if (parsed === undefined) return undefined;
  const observations = parsed.observations !== null && typeof parsed.observations === 'object' ? parsed.observations : undefined;
  if (observations === undefined) return undefined;
  return { observations, anchors: Array.isArray(parsed.anchors) ? parsed.anchors : [] };
}

/** 解析记忆 → 条目数组。 */
export function parseMemoryResponse(raw) {
  const parsed = parseJsonObject(raw);
  if (parsed === undefined) return [];
  const list = Array.isArray(parsed.memories) ? parsed.memories : Array.isArray(parsed) ? parsed : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const text = String(item?.text ?? item ?? '').replace(/\s+/g, ' ').trim();
    if (text.length === 0 || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push({ text: text.slice(0, 200), kind: typeof item?.kind === 'string' ? item.kind : 'fact' });
  }
  return out.slice(0, 20);
}

/**
 * 锚点校验：quote 必须能在转录里逐字找到（允许跨行差异由空白归一吸收）。
 * 找不到就丢掉——宁可少锚点，也不要假锚点。
 * @param {Array<{quote:string}>} anchors
 * @param {object[]} turns
 */
/** 逐字匹配前的归一：只吸收空白、引号、中英文标点与省略号写法的差异，不改动字符顺序。 */
function normalizeForMatch(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[’‘“”"']/g, '')
    .replace(/…/g, '.')
    .replace(/[！!]/g, '!')
    .replace(/[？?]/g, '?')
    .replace(/[～~]/g, '~')
    .replace(/[，,]/g, ',')
    .replace(/[。.]/g, '.')
    .replace(/[：:]/g, ':');
}

/**
 * 锚点校验：归一之后必须能在转录里逐字找到；找不到就丢掉——宁可少锚点，也不要假锚点。
 * 归一只是吸收空白/引号/标点写法的差异，不改动任何字符顺序，所以「归一通过」仍然等于「原文里有这句」。
 * @param {Array<{quote:string}>} anchors
 * @param {object[]} turns
 */
export function validateAnchors(anchors, turns) {
  const haystack = normalizeForMatch(turns.map((turn) => String(turn.text ?? '')).join('\n'));
  const kept = [];
  for (const anchor of Array.isArray(anchors) ? anchors : []) {
    const quote = normalizeForMatch(anchor?.quote);
    if (quote.length < 4) continue;
    if (!haystack.includes(quote)) continue;
    kept.push(anchor);
  }
  return kept;
}
