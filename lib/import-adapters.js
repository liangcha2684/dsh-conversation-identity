/**
 * 导入层：把各种「聊天记录」归一化成同一种转录结构。
 *
 * 唯一的中间产物：
 *   { speaker: 'me' | 'them', text: string, ts?: number|null }
 * speaker=me 是导入者自己，speaker=them 是「聊天的对面」——也就是要被重建的那个人。
 *
 * 为什么这一层要这么厚：
 * 1) 平台导出里混着 system / tool / thinking 块，不剥掉就会把「系统提示」当成「他的说话方式」，
 *    整张卡直接报废；
 * 2) 说话人认错是这类功能最致命的失败——整张卡会反向，而且用户看不出来。所以拿不准就
 *    返回 low 置信度 + 样本，由上层停下来问，绝不猜。
 *
 * 纯函数模块，不碰文件系统，便于单测。
 */

const TEXT_BUDGET = 4000;

/** 内置的说话人标签集合（纯文本用）。 */
const BUILTIN_THEM = ['assistant', 'ai', 'bot', 'chatgpt', 'claude', 'gemini', 'deepseek', 'model', '助手', '人工智能', '你', '对方'];
const BUILTIN_ME = ['user', 'human', 'me', '我', '本人', '自己'];

/** CSV 表头里代表「说话人」的列名。 */
const SENDER_COLUMNS = ['sender', 'from', 'talker', 'nickname', 'name', 'speaker', 'user', '发送者', '发送人', '昵称', '说话人', '用户', '联系人'];
/** CSV 表头里代表「内容」的列名。 */
const CONTENT_COLUMNS = ['content', 'text', 'message', 'msg', 'body', '内容', '消息', '正文', '文本'];
/** CSV 表头里代表「时间」的列名。 */
const TIME_COLUMNS = ['time', 'timestamp', 'date', 'datetime', 'create_time', '时间', '日期', '发送时间'];
/** 微信导出里的占位符（本身没有语气信息，留着只会稀释特征）。 */
const PLACEHOLDER = /^\[[^\]]{1,16}\](?:\[[^\]]{1,16}\])*$/u;
/** 系统/自己发的通知类消息。 */
const SYSTEM_SENDERS = ['系统', 'system', '微信团队', '文件传输助手'];

/**
 * 猜格式。
 * @param {string} text
 * @returns {'deepseek-json'|'chatgpt-json'|'claude-json'|'generic-json'|'jsonl'|'csv'|'labeled-text'|'unknown'}
 */
export function detectFormat(text) {
  const value = String(text ?? '').trim();
  if (value.length === 0) return 'unknown';
  if (value.startsWith('{') || value.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      // 不是单个 JSON —— 可能是 JSONL，逐行看。
      const lines = value.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
      if (lines.length >= 2) return 'jsonl';
      return 'labeled-text';
    }
    const shapes = JSON.stringify(parsed).slice(0, 200000);
    if (/"fragments"\s*:/.test(shapes) && /"role"\s*:\s*"(?:USER|ASSISTANT)"/.test(shapes)) return 'deepseek-json';
    if (/"mapping"\s*:/.test(shapes)) return 'chatgpt-json';
    if (/"chat_messages"\s*:/.test(shapes)) return 'claude-json';
    if (/"messages"\s*:/.test(shapes) || (Array.isArray(parsed) && parsed.length > 0 && looksLikeMessages(parsed))) return 'generic-json';
    return 'labeled-text';
  }
  if (looksLikeCsv(value)) return 'csv';
  return 'labeled-text';
}

/** 第一行像不像 CSV/TSV 表头（带 sender 与内容列名）。 */
function looksLikeCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  if (!firstLine.includes(delimiter)) return false;
  const cells = parseCsvRows(firstLine, delimiter)[0] ?? [];
  if (cells.length < 2) return false;
  const lower = cells.map((cell) => cell.trim().toLowerCase());
  return lower.some((cell) => SENDER_COLUMNS.includes(cell)) && lower.some((cell) => CONTENT_COLUMNS.includes(cell));
}

function looksLikeMessages(list) {
  const first = list.find((item) => item !== null && typeof item === 'object');
  if (first === undefined) return false;
  return ['role', 'sender', 'author', 'from', 'is_user'].some((key) => key in first);
}

/** 把原始文本切成转录。 */
export function normalizeTranscript(text, { format = 'auto', meLabels = '', themLabels = '', maxMessageChars = TEXT_BUDGET } = {}) {
  const value = String(text ?? '');
  if (value.trim().length === 0) return { ok: false, format: 'unknown', error: '内容为空' };
  const picked = format === 'auto' ? detectFormat(value) : format;
  const labels = {
    me: splitLabels(meLabels),
    them: splitLabels(themLabels),
  };
  try {
    switch (picked) {
      case 'deepseek-json':
        return finish(picked, fromDeepSeek(value, maxMessageChars), labels);
      case 'csv':
        return finish(picked, fromCsv(value, labels, maxMessageChars), labels);
      case 'chatgpt-json':
        return finish(picked, fromChatGpt(value, maxMessageChars), labels);
      case 'claude-json':
        return finish(picked, fromClaude(value, maxMessageChars), labels);
      case 'generic-json':
        return finish(picked, fromGenericJson(value, maxMessageChars), labels);
      case 'jsonl':
        return finish(picked, fromJsonl(value, maxMessageChars), labels);
      case 'labeled-text':
        return finish(picked, fromLabeledText(value, labels, maxMessageChars), labels);
      default:
        return { ok: false, format: picked, error: `无法识别的格式（${picked}）` };
    }
  } catch (error) {
    return { ok: false, format: picked, error: error instanceof Error ? error.message : String(error) };
  }
}

function splitLabels(raw) {
  return String(raw ?? '')
    .split(/[,，;；\n]/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

/** 统一收尾：补充 speakers / confidence / notes / 样本。 */
function finish(format, { transcript, speakers, notes, forcedConfidence }) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return {
      ok: false,
      format,
      error: '没有解析出任何对话轮次',
      notes: Array.isArray(notes) ? notes : [],
      transcript: [],
      turns: { total: 0, me: 0, them: 0, unknown: 0 },
    };
  }
  const them = transcript.filter((turn) => turn.speaker === 'them').length;
  const me = transcript.filter((turn) => turn.speaker === 'me').length;
  const unknown = transcript.filter((turn) => turn.speaker === 'unknown').length;
  const names = [...new Set(transcript.map((turn) => turn.name).filter((name) => typeof name === 'string' && name.length > 0))];
  const list = [...(notes ?? [])];
  let confidence = forcedConfidence ?? 'high';
  if (them === 0) {
    // 认不出对面：把转录和候选名字一起带出去，让上层能问「谁是你要延续的那个人」。
    return {
      ok: false,
      format,
      error: '没有识别出「对面」说的话——请用 counterpart 参数指定对面是谁，或检查导入内容',
      transcript,
      names,
      turns: { total: transcript.length, me, them, unknown },
      samples: speakerSamples(transcript),
      notes: list,
    };
  }
  if (me === 0) {
    list.push('只认出「对面」一方，缺少导入者自己的发言（仍可用，但称呼/节奏可能偏）');
    confidence = 'medium';
  }
  if (confidence === 'high' && them < 3) {
    list.push(`对面只有 ${them} 轮发言，样本偏少，卡的质量上限很低`);
    confidence = 'medium';
  }
  return {
    ok: true,
    format,
    transcript,
    confidence,
    speakers: { me: speakers?.me ?? null, them: speakers?.them ?? null, all: [...new Set(transcript.map((turn) => turn.speaker))] },
    notes: list,
    turns: { total: transcript.length, me, them },
    samples: speakerSamples(transcript),
  };
}

/** 给上层做「说话人确认」用的样本（me/them 各 2 条，再加 1 条归属可疑的）。 */
export function speakerSamples(transcript, limit = 5) {
  const out = [];
  const pick = (speaker, count) => {
    const list = transcript.filter((turn) => turn.speaker === speaker).slice(0, count);
    for (const turn of list) out.push({ speaker: turn.speaker, text: turn.text.slice(0, 120) });
  };
  pick('me', 2);
  pick('them', 2);
  const unknown = transcript.find((turn) => turn.speaker === 'unknown');
  if (unknown !== undefined) out.push({ speaker: 'unknown', text: unknown.text.slice(0, 120) });
  return out.slice(0, limit);
}

// ── CSV / TSV（微信导出工具最常见）────────────────────────────────────────
/**
 * 要求：表头里同时有「说话人」列和「内容」列（中英文列名都认）。
 * 说话人归属：给了 counterpart 就以它为准（命中→对面，其余→自己）；
 * 否则只看 meLabels / themLabels；再否则全部记 unknown，让上层停下来问。
 */
function fromCsv(text, labels, maxMessageChars) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const rows = parseCsvRows(text, delimiter);
  if (rows.length < 2) return { transcript: [], notes: ['CSV 只有表头没有数据行'], forcedConfidence: 'low' };
  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const senderIndex = header.findIndex((cell) => SENDER_COLUMNS.includes(cell));
  const contentIndex = header.findIndex((cell) => CONTENT_COLUMNS.includes(cell));
  const timeIndex = header.findIndex((cell) => TIME_COLUMNS.includes(cell));
  if (senderIndex < 0 || contentIndex < 0) {
    return {
      transcript: [],
      notes: [`CSV 表头没认出「说话人」或「内容」列。读到的是：${(rows[0] ?? []).join(' | ')}`],
      forcedConfidence: 'low',
    };
  }
  const transcript = [];
  let dropped = 0;
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row) || row.length === 0) continue;
    const sender = String(row[senderIndex] ?? '').trim();
    const content = String(row[contentIndex] ?? '').trim();
    if (sender.length === 0 || content.length === 0) continue;
    if (SYSTEM_SENDERS.includes(sender)) continue;
    if (PLACEHOLDER.test(content)) {
      dropped += 1;
      continue;
    }
    transcript.push({
      speaker: classifyCsvSender(sender, labels),
      name: sender,
      text: clip(content, maxMessageChars),
      ts: timeIndex >= 0 ? normalizeTs(row[timeIndex]) : null,
    });
  }
  const notes = [
    `CSV（${delimiter === '\t' ? 'TSV' : '逗号'}分隔）：识别到 ${transcript.length} 条发言`,
    ...dropped > 0 ? [`已丢掉 ${dropped} 条纯占位符消息（[图片]/[表情] 这类，没有语气信息）`] : [],
  ];
  return { transcript, notes };
}

function classifyCsvSender(sender, labels) {
  const value = sender.trim().toLowerCase();
  if (labels.them.includes(value)) return 'them';
  if (labels.me.includes(value)) return 'me';
  if (BUILTIN_THEM.includes(value)) return 'them';
  if (BUILTIN_ME.includes(value)) return 'me';
  return 'unknown';
}

/** RFC4180 风格的 CSV 解析（支持引号内的逗号与换行、双引号转义）。 */
export function parseCsvRows(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (char === '\r') continue;
    field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ── DeepSeek 网页版导出 ──────────────────────────────────────────────────
/**
 * 结构：{ id, title, messages: [{ id, role: "USER"|"ASSISTANT", fragments: [{ type, content }] }] }
 * 实测的 fragments.type（一条 1032 消息的导出）：
 *   USER/REQUEST（496）      用户的提问 —— 算「我」
 *   USER/FILE（66）          用户上传的文件 —— 不是发言
 *   ASSISTANT/THINK（688）   **思维链** —— 不是他说的话，必须剔（否则整张卡变成内心戏）
 *   ASSISTANT/RESPONSE（512）他的回答 —— 算「对面」
 *   ASSISTANT/CONTENT_RISK（225）风险提示 —— 系统腔，不是他的语气
 *   ASSISTANT/TOOL_SEARCH（100）/ TOOL_OPEN（425）  检索动作 —— 不是发言
 * 所以这里用白名单，只收 REQUEST 与 RESPONSE。
 */
function fromDeepSeek(text, maxMessageChars) {
  const parsed = JSON.parse(text);
  const sessions = Array.isArray(parsed) ? parsed : [parsed];
  const transcript = [];
  for (const session of sessions) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    // 导出里 parent_id 可能构成分支，但 messages 本身是按 id 递增的线性序列。
    const ordered = [...messages].sort((a, b) => Number(a?.id ?? 0) - Number(b?.id ?? 0));
    for (const message of ordered) {
      const role = String(message?.role ?? '').toUpperCase();
      if (role !== 'USER' && role !== 'ASSISTANT') continue;
      const wanted = role === 'USER' ? 'REQUEST' : 'RESPONSE';
      const fragments = Array.isArray(message?.fragments) ? message.fragments : [];
      const parts = [];
      for (const fragment of fragments) {
        if (String(fragment?.type ?? '').toUpperCase() !== wanted) continue;
        const content = typeof fragment?.content === 'string' ? fragment.content.trim() : '';
        if (content.length > 0) parts.push(content);
      }
      const body = parts.join('\n').trim();
      if (body.length === 0) continue;
      transcript.push({
        speaker: role === 'USER' ? 'me' : 'them',
        text: clip(body, maxMessageChars),
        ts: normalizeTs(message?.inserted_at),
      });
    }
  }
  return { transcript, notes: ['DeepSeek 网页版导出：只收 REQUEST/RESPONSE，已剔除思维链、检索、风险提示与文件片段'] };
}

// ── ChatGPT conversations.json ───────────────────────────────────────────
/**
 * mapping 是树，必须从根沿 children 走成线性对话；旁支（重新生成的分支）是死路，跳过。
 */
function fromChatGpt(text, maxMessageChars) {
  const parsed = JSON.parse(text);
  const conversations = Array.isArray(parsed) ? parsed : [parsed];
  const transcript = [];
  const notes = [];
  for (const conversation of conversations) {
    const mapping = conversation?.mapping;
    if (mapping === null || typeof mapping !== 'object') continue;
    const visited = new Set();
    // 找根：parent 不在 mapping 里的节点。
    const ids = Object.keys(mapping);
    const rootIds = ids.filter((id) => {
      const parent = mapping[id]?.parent;
      return parent === undefined || parent === null || mapping[parent] === undefined;
    });
    let cursor = (rootIds.length > 0 ? rootIds[0] : undefined) ?? ids[0];
    let guard = 0;
    while (cursor !== undefined && guard < 100000) {
      guard += 1;
      if (visited.has(cursor)) break;
      visited.add(cursor);
      const node = mapping[cursor];
      if (node === undefined) break;
      const message = node.message;
      const turn = messageToTurn(message);
      if (turn !== undefined && turn.speaker !== 'skip') {
        transcript.push({ ...turn, text: clip(turn.text, maxMessageChars) });
      }
      const children = Array.isArray(node.children) ? node.children.filter((id) => mapping[id] !== undefined && !visited.has(id)) : [];
      // 分支取第一个没走过的孩子（主链）。
      cursor = children[0];
    }
  }
  notes.push('ChatGPT 导出：已按 parent/children 还原主链，system/tool/隐藏消息已剔除');
  return { transcript: dropSkipped(transcript), notes };
}

function messageToTurn(message) {
  if (message === null || typeof message !== 'object') return { speaker: 'skip', text: '' };
  const role = String(message.author?.role ?? '').toLowerCase();
  if (role === 'system' || role === 'tool' || role === 'developer') return { speaker: 'skip', text: '' };
  const metadata = message.metadata ?? {};
  if (metadata.is_visually_hidden_from_conversation === true) return { speaker: 'skip', text: '' };
  if (message.content === null || typeof message.content !== 'object') return { speaker: 'skip', text: '' };
  // 只收 text 类型：code / execution_output / tether_browsing_display 都不是「他说的话」。
  if (message.content.content_type !== undefined && message.content.content_type !== 'text') return { speaker: 'skip', text: '' };
  const parts = Array.isArray(message.content.parts) ? message.content.parts : [];
  const body = parts.filter((part) => typeof part === 'string').join('\n').trim();
  if (body.length === 0) return { speaker: 'skip', text: '' };
  const speaker = role === 'user' ? 'me' : 'them';
  const ts = Number.isFinite(Number(message.create_time)) ? Number(message.create_time) * 1000 : null;
  return { speaker, text: body, ts };
}

function dropSkipped(list) {
  return list.filter((turn) => turn.speaker !== 'skip');
}

// ── Claude 导出 ─────────────────────────────────────────────────────────
/**
 * 结构：{ conversations: [{ chat_messages: [{ sender, text, content: [...] }] }] }
 * content 里可能有 thinking 块——那不是他说的话，必须剥掉。
 */
function fromClaude(text, maxMessageChars) {
  const parsed = JSON.parse(text);
  const conversations = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.conversations) ? parsed.conversations : [parsed];
  const transcript = [];
  for (const conversation of conversations) {
    const messages = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
    for (const message of messages) {
      const sender = String(message?.sender ?? message?.role ?? '').toLowerCase();
      if (sender === 'system' || sender === 'tool') continue;
      const body = claudeBody(message);
      if (body.length === 0) continue;
      transcript.push({ speaker: sender === 'human' || sender === 'user' ? 'me' : 'them', text: clip(body, maxMessageChars), ts: normalizeTs(message?.created_at) });
    }
  }
  return { transcript, notes: ['Claude 导出：已剥离 thinking / tool 块'] };
}

function claudeBody(message) {
  const direct = typeof message?.text === 'string' ? message.text.trim() : '';
  if (direct.length > 0) return direct;
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block === null || typeof block !== 'object') continue;
    // thinking / tool_use / tool_result 一律跳过。
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

function normalizeTs(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

// ── 通用 JSON（{messages:[...]} 或 [{role,content}]） ─────────────────────
function fromGenericJson(text, maxMessageChars) {
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.messages) ? parsed.messages
      : Array.isArray(parsed?.items) ? parsed.items
        : Array.isArray(parsed?.data) ? parsed.data : [];
  const transcript = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const role = String(item.role ?? item.sender ?? item.author?.role ?? item.from ?? '').toLowerCase();
    if (role === 'system' || role === 'tool' || role === 'developer') continue;
    const body = genericBody(item);
    if (body.length === 0) continue;
    transcript.push({ speaker: role === 'user' || role === 'human' || role === 'me' ? 'me' : 'them', text: clip(body, maxMessageChars), ts: normalizeTs(item.timestamp ?? item.created_at ?? item.time) });
  }
  return { transcript, notes: ['通用 JSON：按 role/sender 映射（user→导入者，其余→对面）'] };
}

function genericBody(item) {
  for (const key of ['text', 'content', 'message', 'body']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (Array.isArray(value)) {
      const parts = value
        .map((block) => (typeof block === 'string' ? block : block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .filter((part) => part.trim().length > 0);
      if (parts.length > 0) return parts.join('\n').trim();
    }
  }
  return '';
}

// ── JSONL（DSH 自己的会话日志也接近这个形状）─────────────────────────────
function fromJsonl(text, maxMessageChars) {
  const transcript = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let item;
    try {
      item = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const role = String(item?.role ?? item?.message?.role ?? '').toLowerCase();
    if (role === 'system' || role === 'tool' || role === 'developer') continue;
    const body = genericBody(item?.message ?? item);
    if (body.length === 0) continue;
    transcript.push({ speaker: role === 'user' || role === 'human' ? 'me' : 'them', text: clip(body, maxMessageChars), ts: normalizeTs(item?.time ?? item?.timestamp) });
  }
  return { transcript, notes: ['JSONL：逐行解析'] };
}

// ── 纯文本（标记行）─────────────────────────────────────────────────────
/**
 * 识别优先级：
 *   1) `我: …` / `你: …`
 *   2) `User: …` / `Assistant: …`
 *   3) 自定义昵称（两个名字）——拿不准，降置信度
 *   4) 微信式 `名字  时间` 单独一行，下一条是内容——同样拿不准
 */
function fromLabeledText(text, labels, maxMessageChars) {
  const lines = String(text).split(/\r?\n/);
  const marker = buildMarkerRegex(lines);
  const transcript = [];
  const names = new Set();
  let current = null;
  const notes = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim().length === 0) {
      if (current !== null) current.text.push('');
      continue;
    }
    const matched = marker.exec(line);
    if (matched !== null) {
      const label = matched[1].trim();
      names.add(label);
      const speaker = classifyLabel(label, labels);
      const body = line.slice(matched[0].length).trim();
      current = { speaker, name: label, text: body.length > 0 ? [body] : [] };
      transcript.push(current);
      continue;
    }
    if (current !== null) current.text.push(line.trim());
  }
  const turns = transcript
    .map((turn) => ({ speaker: turn.speaker, name: turn.name, text: turn.text.join('\n').trim() }))
    .filter((turn) => turn.text.length > 0)
    .map((turn) => ({ ...turn, text: clip(turn.text, maxMessageChars) }));

  // 自定义名字：如果只出现两个名字，且都不是内置标签，说明是「两个真人」的记录。
  const custom = [...names].filter((name) => classifyLabel(name, labels) === 'unknown');
  if (custom.length === 2) {
    for (const turn of turns) {
      if (turn.speaker === 'unknown') {
        turn.speaker = 'unknown';
      }
    }
    notes.push(`认出两个自定义名字：${custom.join(' / ')}；无法自动判断谁是「对面」——请用 counterpart 参数指定`);
    return { transcript: turns, notes, forcedConfidence: 'low', speakers: { all: custom } };
  }
  if (custom.length > 2) {
    notes.push(`认出多个自定义名字（${custom.join('、')}），说话人归属可能不准`);
    return { transcript: turns, notes, forcedConfidence: 'low' };
  }
  notes.push('纯文本：按标记行切分');
  return { transcript: turns, notes };
}

/** 标记行：`名字:` / `名字：`，名字最多 24 字，允许 `[名字]` 与 `**名字**`。 */
function buildMarkerRegex(lines) {
  const counts = new Map();
  const probe = /^\s*(?:\[|\*\*)?([^\s:：*\]\[】]{1,24})(?:\]|\*\*)?\s*[:：]\s*/u;
  for (const line of lines) {
    const matched = probe.exec(line);
    if (matched === null) continue;
    const label = matched[1].trim();
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  // 出现 2 次以上的才算真标签，避免把正文里的「注意:」当成说话人。
  const labels = [...counts.entries()].filter(([, count]) => count >= 2).map(([label]) => label);
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (escaped.length === 0) return /^\s*$^/u;
  return new RegExp(`^\\s*(?:\\[|\\*\\*)?(${escaped})(?:\\]|\\*\\*)?\\s*[:：]\\s*`, 'u');
}

function classifyLabel(label, labels) {
  const value = label.trim().toLowerCase();
  if (labels.them.includes(value)) return 'them';
  if (labels.me.includes(value)) return 'me';
  if (BUILTIN_THEM.includes(value)) return 'them';
  if (BUILTIN_ME.includes(value)) return 'me';
  return 'unknown';
}

function clip(text, max) {
  const value = String(text ?? '').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * 把 low 置信度的转录按「对面是谁」重映射：counterpart 匹配到的名字 → them，
 * 其余名字 → me。这是纯文本导入唯一可靠的消歧方式。
 * @param {object[]} transcript
 * @param {string} counterpart
 */
export function applyCounterpart(transcript, counterpart) {
  const name = String(counterpart ?? '').trim().toLowerCase();
  if (name.length === 0) return transcript;
  return transcript.map((turn) => {
    // 只有带名字的（纯文本标记行）才重映射：counterpart 命中的算「对面」，其余算你自己。
    // 同名标签在不同导出里可能表示相反的一方（有的导出把用户标成「你」），所以给了 counterpart 就以它为准。
    if (typeof turn.name !== 'string' || turn.name.length === 0) return turn;
    return { ...turn, speaker: turn.name.toLowerCase() === name ? 'them' : 'me' };
  });
}

/**
 * 重新统计一份已经（可能被 applyCounterpart 修过）的转录，形状与 normalizeTranscript 的返回值一致。
 * @param {object[]} transcript
 * @param {{ format?: string, notes?: string[] }} options
 */
export function summarize(transcript, { format = 'labeled-text', notes = [] } = {}) {
  return finish(format, { transcript, notes: [...notes, '已按 counterpart 重新归属说话人'] });
}
