/**
 * 原文检索（给 `identity_recall` 用）：在身份转录里按关键词找「他/你说过的话」。
 *
 * 为什么要有它：注入到上下文里的记忆永远是「一小组核心事实」，几十条封顶；
 * 而身份下存着的是**全部原文**（小鲸那份 1008 轮 / 1.3MB）。想不起细节时去查原文，
 * 比往上下文里硬塞事实更接近「真的记得」，也能引用原话而不是凭印象编。
 *
 * 纯函数模块。
 */

/**
 * @param {object[]} turns - 归一化转录
 * @param {string} query - 关键词，空格/逗号分隔多个
 * @param {{ limit?: number, context?: number }} options
 * @returns {Array<{ index: number, hits: number, match: object, context: object[] }>}
 */
export function searchTranscript(turns, query, { limit = 6, context = 1 } = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/[\s,，、;；]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  if (terms.length === 0 || list.length === 0) return [];

  const scored = [];
  for (let index = 0; index < list.length; index += 1) {
    const text = String(list[index]?.text ?? '');
    if (text.length === 0) continue;
    const haystack = text.toLowerCase();
    let hits = 0;
    for (const term of terms) if (haystack.includes(term)) hits += 1;
    if (hits === 0) continue;
    // 命中词数优先；同样命中时**优先对面说的话**——问「她当时怎么说」时，
    // 排一堆用户自己的提问上来没有用；最后才看密度（短句里的提及更相关）。
    const isThem = list[index]?.speaker === 'them' ? 1 : 0;
    const density = hits / Math.max(1, text.length / 200);
    scored.push({ index, hits, isThem, density, text });
  }
  if (scored.length === 0) return [];
  scored.sort((a, b) => (b.hits - a.hits) || (b.isThem - a.isThem) || (b.density - a.density) || (b.index - a.index));

  const picked = [];
  const used = new Set();
  for (const item of scored) {
    if (picked.length >= limit) break;
    const from = Math.max(0, item.index - context);
    const to = Math.min(list.length - 1, item.index + context);
    // 跳过与已选结果重叠的窗口，免得六条结果其实是同一段对话。
    let overlap = false;
    for (let cursor = from; cursor <= to; cursor += 1) {
      if (used.has(cursor)) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;
    for (let cursor = from; cursor <= to; cursor += 1) used.add(cursor);
    picked.push({
      index: item.index,
      hits: item.hits,
      match: { speaker: list[item.index]?.speaker ?? 'them', text: item.text, line: item.index + 1 },
      context: sliceRange(list, from, to),
    });
  }
  return picked;
}

function sliceRange(list, from, to) {
  const out = [];
  for (let index = from; index <= to; index += 1) {
    const turn = list[index];
    if (turn === undefined) continue;
    out.push({ speaker: turn.speaker === 'them' ? 'them' : 'me', text: String(turn.text ?? ''), line: index + 1 });
  }
  return out;
}

/** 渲染成工具输出文本。 */
export function renderRecall({ identityName, query, results, totalTurns }) {
  if (!Array.isArray(results) || results.length === 0) {
    return `在「${identityName}」的记录里没找到与「${query}」相关的内容（共 ${totalTurns} 轮）。换个更具体的词试试。`;
  }
  const lines = [`## 「${identityName}」记录里与「${query}」相关的 ${results.length} 段`];
  for (const item of results) {
    lines.push('');
    lines.push(`### 第 ${item.match.line} 行（命中 ${item.hits} 个词）`);
    for (const turn of item.context) {
      const who = turn.speaker === 'them' ? identityName : '你';
      const mark = turn.line === item.match.line ? '**' : '';
      lines.push(`- ${mark}${who}：${String(turn.text).slice(0, 400)}${mark}`);
    }
  }
  return lines.join('\n');
}
