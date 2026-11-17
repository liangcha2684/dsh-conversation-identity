/**
 * 锚点与口头禅的本地补齐（零模型调用、零成本）。
 *
 * 为什么需要它：提炼模型在「紧凑重试」或长记录合并时，容易把非必填的 anchors /
 * catchphrases 直接省掉，结果卡是对的、却没有一句原文可引用——替身档就没了「不编」的依据。
 * 这两样东西**本来就能从转录里量出来**，没必要每次都求模型：
 *
 *   - 口头禅：对面发言里的高频短语（按「出现在多少条发言里」排，不是按总次数，
 *     免得一句话重复三遍就能当口头禅）；
 *   - 锚点：按用途各挑一句**原话**（称呼 / 拒绝 / 收尾 / 典型长度 / 动作描写 / 口头禅），
 *     因为是从转录里原样摘的，校验必然通过。
 *
 * 纯函数模块。
 */

/** 高频但没信息量的词，不能当口头禅。 */
const STOPWORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '因为', '所以', '但是', '就是',
  '可以', '没有', '不是', '一个', '一下', '已经', '还是', '真的', '其实', '然后', '现在',
  '时候', '知道', '觉得', '应该', '需要', '这样', '那样', '这里', '那里', '自己', '东西',
  '问题', '事情', '出来', '过来', '起来', '上去', '下去', '的话', '之类', '有点', '一些',
  '这些', '那些', '不过', '而且', '或者', '如果', '虽然', '可是', '还有', '一样',
  '不会', '不能', '不要', '可能', '一定', '非常', '特别', '感觉', '喜欢',
  // 泛用高频词：本来就会出现几百次，但不构成「这人的标志」。
  '直接', '你的', '给你', '咱们', '你的', '我会', '我要', '我想', '我是', '我在', '我有',
  '你就', '你是', '你要', '这不', '这么', '那么', '多少', '有点', '一点', '真是', '好像',
  '了吧', '了呢', '了吗', '就好',
]);

/**
 * 从「对面」的发言里量出口头禅。
 *
 * 两条经验（都是在 1000 轮真实记录上试出来的）：
 *   1. **先剥掉括号里的动作描写**。不剥的话高频片段全是「推了推黑框小眼镜」这类动作，
 *      那不是口头禅；剥掉之后剩下的才是「喵呜」「人家」「咕嘿嘿」这类语气标记。
 *   2. **短语太长就不是口头禅**。所以 gram 上限 4 字，并按「出现在多少条发言里」排，
 *      免得一句话重复三遍就成了口头禅。
 *
 * @param {object[]} turns
 * @param {{ limit?: number, minTurns?: number, maxGram?: number }} options
 * @returns {Array<{text: string, count: number}>} count = 出现在多少条发言里
 */
export function extractCatchphrases(turns, { limit = 6, minTurns = 3, maxGram = 4 } = {}) {
  const themTurns = (Array.isArray(turns) ? turns : []).filter((turn) => turn.speaker === 'them');
  if (themTurns.length < minTurns) return [];
  const docFreq = new Map();
  for (const turn of themTurns) {
    const text = stripActions(String(turn.text ?? ''));
    const seen = new Set();
    for (let size = 2; size <= maxGram; size += 1) {
      for (let index = 0; index + size <= text.length; index += 1) {
        const gram = text.slice(index, index + size);
        if (!isCandidate(gram)) continue;
        if (seen.has(gram)) continue;
        seen.add(gram);
        docFreq.set(gram, (docFreq.get(gram) ?? 0) + 1);
      }
    }
  }
  const scored = [...docFreq.entries()]
    .filter(([, count]) => count >= Math.max(minTurns, Math.ceil(themTurns.length * 0.02)))
    // 按「出现在多少条发言里」排，次数相同时更短的优先——口头禅是短颗粒，不是长句。
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => (b.count - a.count) || (a.text.length - b.text.length));

  // 去掉互相重叠的窗口（「推了推黑框小」和「了推黑框小眼」其实是同一句的错位切片）。
  const kept = [];
  for (const item of scored) {
    if (kept.length >= limit) break;
    if (kept.some((other) => other.text.includes(item.text) || item.text.includes(other.text))) continue;
    if (kept.some((other) => sharedLength(other.text, item.text) >= Math.min(other.text.length, item.text.length) * 0.7)) continue;
    kept.push(item);
  }
  return kept.map(({ text, count }) => ({ text, count }));
}

/** 去掉括号内的动作描写（中英文括号都算）。 */
function stripActions(text) {
  return text.replace(/（[^）]*）/g, ' ').replace(/\([^)]*\)/g, ' ');
}

/** 最长公共子串长度（短语都很短，暴力足够）。 */
function sharedLength(a, b) {
  let best = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      let size = 0;
      while (i + size < a.length && j + size < b.length && a[i + size] === b[j + size]) size += 1;
      if (size > best) best = size;
    }
  }
  return best;
}

/** 语气词/拟声字：口头禅几乎一定含这些字，「视频」「绝对」这类高频内容词则不含。 */
const TIC_CHARS = /[呜喵呀啦哦嘛嘿咯诶哇嗯唉哟嗷啵咕嘻哼吧呢呣嘤嚏欸]/u;

function isCandidate(gram) {
  if (gram.trim().length !== gram.length) return false; // 边界处有空白/换行
  if (STOPWORDS.has(gram)) return false;
  // 只收纯汉字短语：标点、拉丁、数字一律不算口头禅（不然会出「主人，」「！主人」这种）。
  if (!/^[\u4e00-\u9fff]+$/u.test(gram)) return false;
  // 必须含语气词/拟声字。只靠频次挑出来的是「视频」「绝对」这种内容词，不是口头禅。
  if (!TIC_CHARS.test(gram)) return false;
  // 语气字挂在虚词后面的是句子碎片（「了喵」「的喵」「好喵」），不是独立口头禅。
  if (/^[的了是好这那就不是有和跟吧呢啊]/u.test(gram)) return false;
  return true;
}

/**
 * 按用途各挑一句原话。
 * @param {object[]} turns
 * @param {object} card - 已归一化的身份卡（用 addressToUser / catchphrases）
 * @param {{ limit?: number }} options
 * @returns {Array<{ quote: string, why: string }>}
 */
export function pickAnchors(turns, card, { limit = 6 } = {}) {
  const themTurns = (Array.isArray(turns) ? turns : []).filter((turn) => turn.speaker === 'them');
  if (themTurns.length === 0) return [];
  const used = new Set();
  const anchors = [];
  const push = (turn, why) => {
    if (turn === undefined || anchors.length >= limit) return;
    const quote = quotable(String(turn.text ?? ''));
    if (quote.length < 4 || used.has(quote)) return;
    used.add(quote);
    anchors.push({ quote, why });
  };
  const find = (predicate) => themTurns.find((turn) => predicate(String(turn.text ?? '')));

  const address = typeof card?.addressToUser === 'string' ? card.addressToUser.trim() : '';
  if (address.length > 0) push(find((text) => text.includes(address)), '称呼与开场');
  push(find((text) => /千万别|不要|不行|不能|不许|不准/.test(text)), '拒绝与转折');
  push(find((text) => /好不好|要不要|对吧|你说呢|[？?]\s*$/.test(text)), '收尾追问');
  push(find((text) => /^[（(]/.test(text)), '动作描写');

  // 典型长度：取长度中位数附近的一条，代表「一次回多少」。
  const lengths = themTurns.map((turn) => String(turn.text ?? '').length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  let closest;
  for (const turn of themTurns) {
    const value = Math.abs(String(turn.text ?? '').length - median);
    if (closest === undefined || value < closest.value) closest = { turn, value };
  }
  push(closest?.turn, '典型长度与节奏');

  const tics = Array.isArray(card?.catchphrases) ? card.catchphrases : [];
  for (const tic of tics) {
    if (anchors.length >= limit) break;
    const word = typeof tic?.text === 'string' ? tic.text : '';
    if (word.length === 0) continue;
    push(find((text) => text.includes(word)), `口头禅「${word}」`);
  }
  return anchors;
}

/** 从一条发言里切出一句可引用的原话（仍然是原文的连续子串）。 */
function quotable(text) {
  const trimmed = text.trim();
  if (trimmed.length <= 120) return trimmed;
  // 按句末标点切成句子，取第一个足够长又不太长的。
  const sentences = trimmed.split(/(?<=[。！？!?~～])/u).map((part) => part.trim()).filter((part) => part.length > 0);
  for (const sentence of sentences) {
    if (sentence.length >= 8 && sentence.length <= 120) return sentence;
  }
  return trimmed.slice(0, 120);
}

/**
 * 把本地量出来的口头禅与锚点合并进卡（口头禅只补空缺，锚点只增不删）。
 * @param {object} card
 * @param {object[]} turns
 * @param {{ limit?: number, sourceId?: string }} options
 */
export function refreshCardEvidence(card, turns, { limit = 6, sourceId = '' } = {}) {
  const next = { ...card };
  const existingTics = Array.isArray(card?.catchphrases) ? card.catchphrases : [];
  if (existingTics.length === 0) next.catchphrases = extractCatchphrases(turns);
  const anchors = pickAnchors(turns, next, { limit });
  const existing = Array.isArray(card?.anchors) ? card.anchors : [];
  const seen = new Set(existing.map((anchor) => anchor.quote));
  const added = [];
  for (const anchor of anchors) {
    if (seen.has(anchor.quote)) continue;
    seen.add(anchor.quote);
    added.push({ ...anchor, sourceId, line: 0 });
  }
  next.anchors = [...existing, ...added].slice(-12);
  return { card: next, addedAnchors: added.length, catchphrases: next.catchphrases.length };
}
