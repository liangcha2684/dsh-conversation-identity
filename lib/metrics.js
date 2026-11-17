/**
 * 本地量化风格指标（零模型调用、免费）。
 *
 * 为什么需要：回放盲判里，模型被识破最明显的一个破绽是**长度**——真实发言 800~1500 字、
 * 带小标题和动作描写，生成只有 300 字，裁判一眼就看出哪个是假的。
 * 「他回复多长」这种事根本不用问模型，量就完了：
 *   - 长度分布（中位 / P75 / P90）——防止把「数百字」当成「一句话」；
 *   - 段落数、加粗小标题数、列表项数——决定版式；
 *   - 括号动作密度——扮演类身份的辨识特征。
 *
 * 纯函数模块。
 */

/** 从「对面」的发言里量出这些数。 */
export function measureStyle(turns) {
  const themTurns = (Array.isArray(turns) ? turns : []).filter((turn) => turn.speaker === 'them');
  const texts = themTurns.map((turn) => String(turn.text ?? '')).filter((text) => text.trim().length > 0);
  if (texts.length === 0) return undefined;
  const lengths = texts.map((text) => text.length).sort((a, b) => a - b);
  const per = texts.map((text) => ({
    paragraphs: text.split(/\n\s*\n/).filter((part) => part.trim().length > 0).length,
    actions: (text.match(/（[^）]*）/g) ?? []).length + (text.match(/\([^)]*\)/g) ?? []).length,
    headings: text.split('\n').filter((line) => /^\s*(?:#{2,4}\s|\*\*[^*]{2,30}\*\*\s*$)/.test(line)).length,
    lists: text.split('\n').filter((line) => /^\s*(?:[*-]\s|\d+[.、]\s)/.test(line)).length,
    asks: /[？?]\s*$|好不好|要不要|对吧/.test(text) ? 1 : 0,
  }));
  const avg = (field) => per.reduce((sum, item) => sum + item[field], 0) / per.length;
  return {
    turns: texts.length,
    median: percentile(lengths, 0.5),
    p75: percentile(lengths, 0.75),
    p90: percentile(lengths, 0.9),
    paragraphs: round(avg('paragraphs')),
    actions: round(avg('actions')),
    headings: round(avg('headings')),
    lists: round(avg('lists')),
    askRate: round(per.reduce((sum, item) => sum + item.asks, 0) / per.length, 2),
  };
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 把实测数字并进卡里那三个最相关的字段（长度 / 版式 / 标点）。
 * 已有描述保留，实测值作为「；实测：…」后缀——模型写的定性描述 + 数量化的硬指标，缺一不可。
 * @param {object} card
 * @param {object|undefined} metrics - measureStyle 的产物
 */
export function applyMetricsToCard(card, metrics) {
  if (metrics === undefined) return card;
  const next = { ...card };
  next.turnLength = append(next.turnLength, `实测：单条中位 ${metrics.median} 字（P75 ${metrics.p75} / P90 ${metrics.p90}），平均 ${metrics.paragraphs} 段`);
  next.structure = append(next.structure, `实测：常带 ${metrics.headings} 个加粗小标题、${metrics.lists} 个列表项`);
  next.punctuation = append(next.punctuation, `实测：每条约 ${metrics.actions} 处括号动作`);
  next.metrics = metrics;
  return next;
}

function append(base, addition) {
  const text = typeof base === 'string' ? base.trim() : '';
  if (text.length === 0) return addition;
  return `${text}；${addition}`.slice(0, 260);
}

/** 渲染成一行给人看的摘要（/identity 状态用）。 */
export function formatMetrics(metrics) {
  if (metrics === undefined) return '';
  return `中位 ${metrics.median} 字 / P90 ${metrics.p90} 字；${metrics.paragraphs} 段、${metrics.headings} 小标题、${metrics.lists} 列表项、${metrics.actions} 动作`;
}
