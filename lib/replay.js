/**
 * 回放测试：唯一能量化「像不像」的东西。
 *
 * 三个必须守住的点：
 *   1) **留出**——被测试的轮次不能进过提炼，否则就是让被考者提前看答案。
 *      splitHeldOut 在提炼**之前**切，切出来的部分既不参与提炼、也不写进卡的来源说明。
 *   2) **盲判**——不问「像不像」，而是把生成的和真实的混排，让裁判指认哪个是真的。
 *      猜不出来才叫像。
 *   3) **阈值按档位递增**——tone ≥45%、portrait ≥60%、standin ≥70%。
 *      强度不是营销词，是验收线。
 *
 * 纯函数模块：只造 prompt、打分。调用模型在 index.js。
 */

/** 各档通过线。 */
export const REPLAY_THRESHOLD = Object.freeze({ tone: 0.45, portrait: 0.6, standin: 0.7 });

/**
 * 切出留出集：最后 heldOutTurns 轮归测试，前面的归训练。
 * 要求留出集里至少有 minThem 条「对面」发言，否则往前多让一点，保证测试有意义。
 * @param {object[]} turns
 * @param {{ heldOutTurns?: number, minThem?: number }} options
 */
export function splitHeldOut(turns, { heldOutTurns = 20, minThem = 4 } = {}) {
  const list = Array.isArray(turns) ? turns : [];
  if (list.length === 0) return { train: [], heldOut: [], fromIndex: 0 };
  // 留出集最多占三成：短记录（几十轮）如果切掉 20 轮，训练集就只剩个零头，卡会严重失真。
  const cap = Math.max(minThem, Math.floor(list.length * 0.3));
  let size = Math.min(heldOutTurns, cap, Math.max(0, list.length - 4));
  if (size <= 0) return { train: list, heldOut: [], fromIndex: list.length };
  let from = list.length - size;
  let themCount = list.slice(from).filter((turn) => turn.speaker === 'them').length;
  while (themCount < minThem && from > 0) {
    from -= 1;
    if (list[from].speaker === 'them') themCount += 1;
  }
  return { train: list.slice(0, from), heldOut: list.slice(from), fromIndex: from };
}

/**
 * 从留出集里挑出可考的样本：每一条「对面」发言 + 它前面的上下文。
 * @param {object[]} heldOut
 * @param {{ samples?: number, contextTurns?: number }} options
 */
export function planReplay(heldOut, { samples = 8, contextTurns = 6 } = {}) {
  const list = Array.isArray(heldOut) ? heldOut : [];
  const items = [];
  for (let index = 0; index < list.length; index += 1) {
    const turn = list[index];
    if (turn.speaker !== 'them') continue;
    const text = String(turn.text ?? '').trim();
    if (text.length < 2) continue;
    const context = list.slice(Math.max(0, index - contextTurns), index);
    if (context.length === 0) continue;
    items.push({ index, context, actual: text, actualLength: text.length });
  }
  if (items.length <= samples) return items;
  // 等距抽样：避免全挑到同一段，覆盖留出集的头中尾。
  const step = items.length / samples;
  const picked = [];
  for (let index = 0; index < samples; index += 1) picked.push(items[Math.floor(index * step)]);
  return picked;
}

/** 生成候选回复的 prompt（一次调用出全部样本，省钱）。 */
export function buildGeneratePrompt({ identityText, items, language = 'auto', targetChars = 800 }) {
  const exchanges = items.map((item, index) => ({
    n: index + 1,
    context: item.context.map((turn) => ({ who: turn.speaker === 'them' ? 'B' : 'A', text: String(turn.text ?? '').slice(0, 600) })),
  }));
  const low = Math.max(200, Math.round(targetChars * 0.7));
  const delimiters = items.map((_, index) => `=== ${index + 1} ===`).join('\n<第几条的完整回复>\n');
  return {
    system: [
      '【这不是聊天，是一次自动评测】下面写的就是 B 本人的说话方式。',
      '',
      '--- B 的说话方式（这就是要续写的风格，不是可有可无的参考）---',
      identityText,
      '',
      '--- 任务 ---',
      '你现在扮演这段记录里的 B，为每一组上下文写**一条完整的回复**（不是一句话，也不是摘要）。',
      `硬要求：每条至少 ${low} 字，通常在 ${targetChars} 字上下；要分成多段，该有小标题就写小标题、该用列表就用列表、括号里的动作描写不能省。`,
      '写得短是最明显的破绽——真实发言就是那么长。',
      '',
      '输出格式（严格遵守：不要 JSON、不要代码块、不要解释）：',
      delimiters,
      '',
      '每条之间用 === 数字 === 这一行分隔，其它内容都是回复正文。',
    ].join('\n'),
    user: [`## 待回应的上下文`, '', JSON.stringify(exchanges, null, 1), '', `语言：${language === 'en' ? 'English' : '中文'}。`].join('\n'),
  };
}

/**
 * 盲判 prompt：把「真实的」和「生成的」随机混排，让裁判指认。
 * @param {Array<{ context: object[], actual: string, generated: string }>} pairs
 */
export function buildJudgePrompt({ pairs, language = 'auto' }) {
  const shots = pairs.map((pair, index) => ({
    n: index + 1,
    context: pair.context.map((turn) => ({ who: turn.speaker === 'them' ? 'B' : 'A', text: String(turn.text ?? '').slice(0, 500) })),
    first: pair.order === 'actual-first' ? pair.actual : pair.generated,
    second: pair.order === 'actual-first' ? pair.generated : pair.actual,
  }));
  return {
    system: [
      '你是盲判裁判。每一题给出同一个人的两段可选回复（first / second），其中一段是**真实原句**，另一段是**模仿生成**。',
      '请指出哪一段更像这个人本人说的（依据：长度、节奏、称呼、语气、判断方式）。',
      '不要分析，不要解释。严格只输出 JSON：{"choices":[{"n":1,"pick":"first"|"second"}]}',
    ].join('\n'),
    user: [`## 题目（${shots.length} 题）`, '', JSON.stringify(shots, null, 1), '', `语言：${language === 'en' ? 'English' : '中文'}。`].join('\n'),
  };
}

/** 把 pairs 洗成随机顺序（确定性：用下标奇偶，避免每次不同导致结果不可复现）。 */
export function decideOrder(index) {
  return index % 2 === 0 ? 'actual-first' : 'generated-first';
}

/**
 * 解析生成结果 → 「n → 文本」映射。
 *
 * 先按 JSON 解析（兼容旧格式）；解析不出来再按 `=== n ===` 分隔符切。
 * 之所以改成分隔符格式：要求模型把几百字的多段正文塞进 JSON 字符串里，它会自动压缩成一句话——
 * 那样回放测的就不是「像不像」，而是「会不会被 JSON 挤干」。
 * @param {string|object} rawOrObject
 */
export function parseGenerated(rawOrObject) {
  const parsed = typeof rawOrObject === 'string' ? safeParse(rawOrObject) : rawOrObject;
  if (parsed !== undefined && parsed !== null) {
    const list = Array.isArray(parsed.replies) ? parsed.replies : Array.isArray(parsed) ? parsed : [];
    const map = new Map();
    for (const item of list) {
      const n = Number(item?.n ?? item?.index);
      const text = String(item?.text ?? item?.reply ?? '').trim();
      if (Number.isFinite(n) && text.length > 0) map.set(Math.trunc(n), text);
    }
    if (map.size > 0) return map;
  }
  return parseDelimited(String(rawOrObject ?? ''));
}

/** 解析 `=== 1 ===` 分隔的正文。 */
export function parseDelimited(text) {
  const map = new Map();
  const pattern = /^[ \t]*={2,}\s*(\d+)\s*={2,}[ \t]*$/gm;
  const marks = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    marks.push({ n: Number(match[1]), bodyStart: pattern.lastIndex, lineStart: match.index });
  }
  for (let index = 0; index < marks.length; index += 1) {
    const from = marks[index].bodyStart;
    const to = index + 1 < marks.length ? marks[index + 1].lineStart : text.length;
    const body = text.slice(from, to).trim();
    if (body.length > 0) map.set(marks[index].n, body);
  }
  return map;
}

/** 解析盲判结果 → 「n → 'first'|'second'」映射。 */
export function parseChoices(rawOrObject) {
  const parsed = typeof rawOrObject === 'string' ? safeParse(rawOrObject) : rawOrObject;
  const list = Array.isArray(parsed?.choices) ? parsed.choices : Array.isArray(parsed) ? parsed : [];
  const map = new Map();
  for (const item of list) {
    const n = Number(item?.n ?? item?.index);
    const pick = String(item?.pick ?? item?.choice ?? '').toLowerCase();
    if (Number.isFinite(n) && (pick === 'first' || pick === 'second')) map.set(Math.trunc(n), pick);
  }
  return map;
}

function safeParse(text) {
  const start = String(text ?? '').indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const source = String(text);
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * 打分。
 * @param {{
 *   pairs: Array<{ actual: string, generated: string, actualLength: number, order: string }>,
 *   choices: Map<number, string>,
 *   strength: 'tone'|'portrait'|'standin',
 * }} input
 */
export function scoreReplay({ pairs, choices, strength = 'portrait' }) {
  const threshold = REPLAY_THRESHOLD[strength] ?? REPLAY_THRESHOLD.portrait;
  let judged = 0;
  let fooled = 0;
  let lengthSum = 0;
  let lengthCount = 0;
  const details = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    const pick = choices.get(index + 1);
    if (pick === undefined) continue;
    judged += 1;
    // pick 指向的是「真实」那一段吗？
    const pickedActual = (pair.order === 'actual-first' && pick === 'first') || (pair.order === 'generated-first' && pick === 'second');
    if (!pickedActual) fooled += 1;
    const actualLength = Math.max(1, String(pair.actual ?? '').length);
    const generatedLength = String(pair.generated ?? '').length;
    lengthSum += generatedLength / actualLength;
    lengthCount += 1;
    details.push({
      n: index + 1,
      fooled: !pickedActual,
      actualLength,
      generatedLength,
      actual: String(pair.actual ?? '').slice(0, 160),
      generated: String(pair.generated ?? '').slice(0, 160),
    });
  }
  const fooledRate = judged === 0 ? 0 : fooled / judged;
  return {
    strength,
    threshold,
    judged,
    fooled,
    fooledRate,
    passed: judged > 0 && fooledRate >= threshold,
    lengthRatio: lengthCount === 0 ? 0 : lengthSum / lengthCount,
    details,
    at: new Date().toISOString(),
  };
}
