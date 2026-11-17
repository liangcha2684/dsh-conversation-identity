/**
 * 纯函数与存储的回归测试（node --test）。
 * 重点覆盖设计里点过的三个坑：说话人认错、假锚点、留出集污染。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { detectFormat, normalizeTranscript, applyCounterpart, summarize } from '../lib/import-adapters.js';
import { normalizeCard, renderIdentity, mergeCard } from '../lib/card.js';
import { planChunks, validateAnchors, parseCardResponse, parseChunkResponse, parseMemoryResponse } from '../lib/distill.js';
import { extractCatchphrases, pickAnchors, refreshCardEvidence } from '../lib/anchors.js';
import { measureStyle, applyMetricsToCard } from '../lib/metrics.js';
import { searchTranscript, renderRecall } from '../lib/recall.js';
import { parseImportArgs, tokenize } from '../lib/command-args.js';
import { splitHeldOut, planReplay, scoreReplay, decideOrder, parseGenerated, parseChoices, REPLAY_THRESHOLD } from '../lib/replay.js';
import { IdentityStore } from '../lib/store.js';

// ── 导入层 ────────────────────────────────────────────────────────────────
test('纯文本：我/你 标记能正确归属', () => {
  const text = [
    '我: 这个方案行不行',
    '你: 行，但先验数据',
    '我: 数据还没跑',
    '你: 那就先跑，别急着改',
  ].join('\n');
  const result = normalizeTranscript(text, { format: 'auto' });
  assert.equal(result.ok, true);
  assert.equal(result.turns.me, 2);
  assert.equal(result.turns.them, 2);
  assert.equal(detectFormat(text), 'labeled-text');
});

test('纯文本：两个自定义名字认不出对面时必须停下，不能猜', () => {
  const text = [
    '张三: 晚上打一局？',
    '李四: 行，我八点上线',
    '张三: 我开房间',
    '李四: 好',
  ].join('\n');
  const result = normalizeTranscript(text, { format: 'labeled-text' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.names.sort(), ['张三', '李四']);
  assert.ok(result.samples.length > 0);
});

test('纯文本：给定 counterpart 后能重新归属', () => {
  const text = [
    '张三: 晚上打一局？',
    '李四: 行，我八点上线',
    '张三: 我开房间',
    '李四: 好',
  ].join('\n');
  const first = normalizeTranscript(text, { format: 'labeled-text' });
  const fixed = summarize(applyCounterpart(first.transcript, '李四'));
  assert.equal(fixed.ok, true);
  assert.equal(fixed.turns.them, 2);
  assert.equal(fixed.turns.me, 2);
});

test('ChatGPT 导出：按 parent/children 还原主链，并剔掉 system', () => {
  const payload = [{
    title: 't',
    mapping: {
      a: { parent: null, children: ['b'], message: null },
      b: { parent: 'a', children: ['c'], message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['你是助手'] } } },
      c: { parent: 'b', children: ['d'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['帮我看看这个'] } } },
      d: { parent: 'c', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['先验数据'] } } },
    },
  }];
  const json = JSON.stringify(payload);
  assert.equal(detectFormat(json), 'chatgpt-json');
  const result = normalizeTranscript(json, { format: 'auto' });
  assert.equal(result.ok, true);
  assert.equal(result.transcript.length, 2);
  assert.equal(result.transcript[0].speaker, 'me');
  assert.equal(result.transcript[1].speaker, 'them');
});

test('Claude 导出：thinking 块不算他说的话', () => {
  const json = JSON.stringify({
    conversations: [{
      chat_messages: [
        { sender: 'human', text: '这件事怎么弄' },
        { sender: 'assistant', content: [{ type: 'thinking', thinking: '我在想…' }, { type: 'text', text: '先别急，我看看数据' }], text: '' },
      ],
    }],
  });
  assert.equal(detectFormat(json), 'claude-json');
  const result = normalizeTranscript(json, { format: 'auto' });
  assert.equal(result.ok, true);
  assert.equal(result.transcript[1].text, '先别急，我看看数据');
  assert.ok(!result.transcript[1].text.includes('我在想'));
});

test('通用 JSON：role 映射与 system 剔除', () => {
  const json = JSON.stringify({ messages: [
    { role: 'system', content: 'x' },
    { role: 'user', content: '问' },
    { role: 'assistant', content: [{ type: 'text', text: '答' }] },
  ] });
  const result = normalizeTranscript(json, { format: 'auto' });
  assert.equal(result.ok, true);
  assert.equal(result.transcript.length, 2);
});

test('DeepSeek 网页版导出：只收 REQUEST/RESPONSE，思维链不能当他说的话', () => {
  const json = JSON.stringify({
    id: 'fe71114d',
    title: 't',
    messages: [
      { id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: '摸摸尾巴' }] },
      { id: 2, role: 'ASSISTANT', fragments: [
        { type: 'THINK', content: '（内心戏：主人又来了，要不要装害羞）' },
        { type: 'RESPONSE', content: '（尾巴一僵）喵呜～不行啦！' },
      ] },
      { id: 3, role: 'ASSISTANT', fragments: [{ type: 'CONTENT_RISK', content: '风险提示文本' }] },
      { id: 4, role: 'USER', fragments: [{ type: 'FILE', content: 'a.png' }] },
    ],
  });
  assert.equal(detectFormat(json), 'deepseek-json');
  const result = normalizeTranscript(json, { format: 'auto' });
  assert.equal(result.ok, true);
  assert.equal(result.transcript.length, 2);
  assert.equal(result.transcript[1].speaker, 'them');
  assert.ok(!result.transcript[1].text.includes('内心戏'), '思维链必须被剔除');
  assert.ok(!result.transcript[1].text.includes('风险提示'), '风险提示不是他的语气');
});

test('counterpart：标签已分类也按名字重映射（「你」在不同导出里可能是相反一方）', () => {
  const text = ['你: 摸摸头', '小鲸: 喵呜～', '你: 帮我看看这段代码', '小鲸: 好，先跑一下'].join('\n');
  const first = normalizeTranscript(text, { format: 'labeled-text' });
  const fixed = summarize(applyCounterpart(first.transcript, '小鲸'), { format: first.format });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.turns.them, 2);
  assert.equal(fixed.turns.me, 2);
  assert.equal(fixed.transcript.find((turn) => turn.speaker === 'them').text, '喵呜～');
});

// ── CSV / 微信导出 ────────────────────────────────────────────────────────
test('CSV：带表头的微信导出，给 counterpart 才能定谁是对面', () => {
  const csv = [
    'sender,content,time',
    '波波,在吗,2026-11-01 20:00:00',
    '小鲸,"在呀主人，怎么啦？",2026-11-01 20:01:00',
    '波波,"看这个，带逗号的内容",2026-11-01 20:02:00',
    '[图片],,2026-11-01 20:03:00',
    '小鲸,[表情],2026-11-01 20:04:00',
  ].join('\n');
  assert.equal(detectFormat(csv), 'csv');

  const first = normalizeTranscript(csv, { format: 'auto' });
  assert.equal(first.ok, false, '两个自定义名字时应停下来问');
  assert.deepEqual(first.names.sort(), ['小鲸', '波波']);

  const fixed = summarize(applyCounterpart(first.transcript, '小鲸'), { format: 'csv' });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.turns.them, 1);
  assert.equal(fixed.turns.me, 2);
  assert.ok(fixed.transcript.some((turn) => turn.text.includes('带逗号的内容')), '引号里的逗号不能把字段切碎');
  assert.ok(!fixed.transcript.some((turn) => turn.text === '[表情]'), '纯占位符要丢掉');
});

test('CSV：TSV 也能识别，只有一方时降置信度', () => {
  const tsv = ['talker\tcontent', '小鲸\t喵呜～', '小鲸\t人家知道啦'].join('\n');
  assert.equal(detectFormat(tsv), 'csv');
  const result = normalizeTranscript(tsv, { format: 'csv' });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('对面'), `应提示没有对面：${result.error}`);
});

test('CSV：表头认不出时明确报错，不瞎猜', () => {
  const csv = ['a,b', '1,2'].join('\n');
  const result = normalizeTranscript(csv, { format: 'csv' });
  assert.equal(result.ok, false);
  assert.ok(result.notes.some((note) => note.includes('表头')));
});

// ── 卡 ────────────────────────────────────────────────────────────────────
const SAMPLE_CARD = {
  card: {
    displayName: '小克',
    addressToUser: '波波',
    register: '随意',
    sentence: '短句为主',
    structure: '先结论再展开',
    punctuation: '很少用问号',
    catchphrases: [{ text: '行', count: 12 }, { text: '那就这样', count: 3 }],
    emoji: '不用',
    refusal: '「这个不行，换 X」',
    turnLength: '一段话',
    questionRate: '几乎不反问',
    closing: '给结论',
    pace: '一次说完',
    judgment: '先给结论',
    evidence: '张口要数据',
    concede: '被指出数据错时会改口',
    avoid: '不谈价格',
    uncertainty: '直说不知道',
    relationship: '同事式互怼，关键时站你这边',
    boundaries: '不替你做决定',
  },
  anchors: [{ quote: '行，但先验数据', line: 2, why: '节奏与判断' }],
};

test('三档渲染：字段随档位递增，且都带硬底线', () => {
  const card = normalizeCard({ ...SAMPLE_CARD.card, anchors: SAMPLE_CARD.anchors }, { identityId: 'id-1', name: '小克', generation: 2 });
  const tone = renderIdentity(card, { strength: 'tone' });
  const portrait = renderIdentity(card, { strength: 'portrait' });
  const standin = renderIdentity(card, { strength: 'standin', memory: [{ text: '他说过下周三上线' }] });
  assert.ok(tone.includes('波波'));
  assert.ok(!tone.includes('怎么下判断'), '底色档不该注入思维字段');
  assert.ok(portrait.includes('怎么下判断'));
  assert.ok(portrait.length > tone.length);
  assert.ok(standin.includes('原话锚点'));
  assert.ok(standin.includes('下周三上线'));
  assert.ok(standin.length > portrait.length);
  for (const text of [tone, portrait, standin]) {
    assert.ok(text.includes('工具使用'), '硬底线必须在每一档里');
    assert.ok(text.includes('新一代') || text.includes('代'));
  }
});

test('锚点开关关掉时不能漏注入（slice(-0) 的经典坑）', () => {
  const card = normalizeCard({ ...SAMPLE_CARD.card, anchors: SAMPLE_CARD.anchors }, { identityId: 'id-1', name: '小克' });
  const hidden = renderIdentity({ ...card, anchors: [] }, { strength: 'standin' });
  assert.ok(!hidden.includes('行，但先验数据'));
});

test('代际合并：锚点只增不删', () => {
  const card = normalizeCard({ ...SAMPLE_CARD.card, anchors: SAMPLE_CARD.anchors }, { identityId: 'id-1', name: '小克' });
  const merged = mergeCard(card, normalizeCard({ ...SAMPLE_CARD.card, anchors: [{ quote: '那就先跑再改', why: 'x' }] }, { identityId: 'id-1' }), { generation: 2 });
  assert.equal(merged.generation, 2);
  assert.equal(merged.anchors.length, 2);
});

// ── 提炼 ──────────────────────────────────────────────────────────────────
test('分块：超上限时抽样，且保住头尾', () => {
  const turns = Array.from({ length: 400 }, (_, index) => ({ speaker: index % 2 === 0 ? 'me' : 'them', text: 'x'.repeat(60) }));
  const plan = planChunks(turns, { chunkChars: 2000, maxChunks: 5 });
  assert.equal(plan.sampled, true);
  assert.equal(plan.chunks.length, 5);
});

test('锚点校验：原文里没有的锚点必须丢掉', () => {
  const turns = [{ speaker: 'them', text: '行，但先验数据' }, { speaker: 'me', text: '好' }];
  const kept = validateAnchors([
    { quote: '行，但先验数据' },
    { quote: '我编的一句话' },
  ], turns);
  assert.equal(kept.length, 1);
});

test('模型输出容错：代码块包裹 / 前后废话都能解析', () => {
  const raw = '```json\n{"card":{"addressToUser":"波波"},"anchors":[{"quote":"行，但先验数据"}]}\n```\n以上。';
  const parsed = parseCardResponse(raw, { identityId: 'id-1', name: '小克' });
  assert.equal(parsed.card.addressToUser, '波波');
  assert.equal(parsed.anchors.length, 1);
});

test('分块观察与记忆解析', () => {
  const chunk = parseChunkResponse('{"observations":{"register":"随意"},"anchors":[{"quote":"行"}]}');
  assert.equal(chunk.observations.register, '随意');
  const memory = parseMemoryResponse('{"memories":[{"text":"下周三上线","kind":"task"},{"text":"下周三上线"}]}');
  assert.equal(memory.length, 1);
});

// ── 锚点与口头禅的本地补齐 ────────────────────────────────────────────────
const NARRATIVE_TURNS = [
  { speaker: 'them', text: '（推了推黑框小眼镜，尾巴一甩）喵呜～主人召唤我啦？' },
  { speaker: 'them', text: '（推了推黑框小眼镜）这只视频绝对没问题喵呜。' },
  { speaker: 'them', text: '（尾巴轻轻拍打水面）人家才不要呢，喵呜！' },
  { speaker: 'them', text: '（鼓起脸颊）不要啦，喵呜～好不好？' },
  { speaker: 'me', text: '摸摸头' },
];

test('口头禅：剥掉括号动作、只收语气型短语', () => {
  const tics = extractCatchphrases(NARRATIVE_TURNS, { minTurns: 2 });
  const texts = tics.map((item) => item.text);
  assert.ok(texts.includes('喵呜'), `应识别出「喵呜」，实际：${texts.join('/')}`);
  assert.ok(!texts.some((text) => text.includes('黑框')), '括号里的动作不能当口头禅');
  assert.ok(!texts.includes('视频'), '高频内容词不能当口头禅');
});

test('锚点：本地摘出来的必须逐字可查，且只增不删', () => {
  const card = normalizeCard({ addressToUser: '主人' }, { identityId: 'id-x', name: '小鲸' });
  const result = refreshCardEvidence(card, NARRATIVE_TURNS, { limit: 6 });
  assert.ok(result.card.anchors.length > 0, '应该补出锚点');
  for (const anchor of result.card.anchors) {
    assert.ok(NARRATIVE_TURNS.some((turn) => String(turn.text).includes(anchor.quote)), `锚点必须是原文子串：${anchor.quote}`);
  }
  assert.ok(result.card.anchors.some((anchor) => anchor.why === '称呼与开场'));

  // 再跑一次不应重复追加，已有锚点不被删。
  const again = refreshCardEvidence(result.card, NARRATIVE_TURNS, { limit: 6 });
  assert.equal(again.card.anchors.length, result.card.anchors.length);
});

test('口头禅只补空缺：模型给过的不会被本地覆盖', () => {
  const card = normalizeCard({ catchphrases: [{ text: '咕嘿嘿', count: 9 }] }, { identityId: 'id-x', name: '小鲸' });
  const result = refreshCardEvidence(card, NARRATIVE_TURNS, { limit: 6 });
  assert.deepEqual(result.card.catchphrases, [{ text: '咕嘿嘿', count: 9 }]);
});

// ── 风格指标 ──────────────────────────────────────────────────────────────
test('实测风格指标：长度分布、版式与动作密度能进卡', () => {
  const turns = [
    { speaker: 'them', text: '（尾巴一甩）喵呜～\n\n### 小标题\n* 一条\n* 两条\n\n这段正文写了挺多字，用来撑长度分布。' },
    { speaker: 'them', text: '短的一句喵。' },
    { speaker: 'them', text: '（推了推眼镜）中等长度的一条，带问句好不好？' },
    { speaker: 'me', text: '不该被统计' },
  ];
  const metrics = measureStyle(turns);
  assert.equal(metrics.turns, 3, '只统计对面的发言');
  assert.ok(metrics.median > 0 && metrics.p90 >= metrics.median);
  assert.ok(metrics.headings > 0 && metrics.lists > 0, `版式指标应大于 0，实际 headings=${metrics.headings} lists=${metrics.lists}`);
  assert.ok(metrics.actions > 0);

  const card = applyMetricsToCard(normalizeCard({ turnLength: '长' }, { identityId: 'id-x', name: 'x' }), metrics);
  assert.ok(card.turnLength.startsWith('长；实测：单条中位'), '实测值要接在模型描述后面，不能覆盖');
  assert.ok(card.structure.includes('实测：'));
  assert.deepEqual(card.metrics, metrics);
});

// ── 原文检索 ──────────────────────────────────────────────────────────────
test('记忆与档位解耦：画像档也注入记忆，底色档不注', () => {
  const card = normalizeCard({ addressToUser: '主人', judgment: '先给结论' }, { identityId: 'id-x', name: '小鲸' });
  const memory = [{ text: '小鲸小名叫欧鲸鲸，只准主人一个人叫' }, { text: '折叠琴预算 300 元内选 88 键' }];
  const portrait = renderIdentity(card, { strength: 'portrait', memory, transcriptTurns: 1008 });
  assert.ok(portrait.includes('欧鲸鲸'), '画像档必须带记忆');
  assert.ok(portrait.includes('先给结论'), '记忆变多不能把思维字段挤掉');
  assert.ok(portrait.includes('identity_recall'), '要提示可以查原文');

  const tone = renderIdentity(card, { strength: 'tone', memory });
  assert.ok(!tone.includes('欧鲸鲸'), '底色档不注记忆');

  const standin = renderIdentity(card, { strength: 'standin', memory });
  assert.ok(standin.includes('欧鲸鲸') && standin.includes('替身档必须遵守'));
});

test('原文检索：命中关键词、带上下文、结果不重叠', () => {
  const turns = [
    { speaker: 'me', text: '折叠琴买哪个好' },
    { speaker: 'them', text: '300 元内选 88 键折叠琴，标准键宽 22mm' },
    { speaker: 'me', text: '那破甲呢' },
    { speaker: 'them', text: '破甲只能讲理论思路，不能给实操' },
    { speaker: 'them', text: '不相关的一句话' },
  ];
  const hits = searchTranscript(turns, '折叠琴', { limit: 3 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match.line, 2);
  assert.ok(hits[0].context.length >= 1, '要带上下文');

  const two = searchTranscript(turns, '破甲 理论', { limit: 5 });
  assert.ok(two.length >= 1);
  assert.equal(two[0].hits, 2, '两个词都命中的排第一');

  assert.deepEqual(searchTranscript(turns, '不存在的东西'), []);
  const text = renderRecall({ identityName: '小鲸', query: '折叠琴', results: hits, totalTurns: turns.length });
  assert.ok(text.includes('小鲸') && text.includes('88 键'));
});

// ── /identity 命令参数 ────────────────────────────────────────────────────
test('/identity + 文件：默认只出预算，--yes 才真跑', () => {
  const dry = parseImportArgs('+ "C:/记录/微信 导出.csv" --counterpart=阿May --name=阿May');
  assert.equal(dry.verb, '+');
  assert.equal(dry.path, 'C:/记录/微信 导出.csv', '引号里的空格不能把路径切断');
  assert.equal(dry.options.counterpart, '阿May');
  assert.equal(dry.options.name, '阿May');
  assert.equal(dry.options.yes, false, '没给 --yes 就不能花钱');

  const real = parseImportArgs('+ C:/a/chat.json --yes --strength=standin --no-memory');
  assert.equal(real.path, 'C:/a/chat.json');
  assert.equal(real.options.yes, true);
  assert.equal(real.options.strength, 'standin');
  assert.equal(real.options.memory, false);
});

test('/identity yes：确认句单独成一个子命令', () => {
  const yes = parseImportArgs('yes');
  assert.equal(yes.verb, 'yes');
  assert.equal(yes.path, '');
  assert.equal(parseImportArgs('确认').verb, '确认');
  assert.equal(parseImportArgs('y').verb, 'y');
});

test('/identity + 文件：参数写错要明确报错，不要静默跑', () => {
  assert.ok(parseImportArgs('+ a.csv --strength=huge').error.includes('tone'));
  assert.ok(parseImportArgs('+ a.csv --bogus=1').error.includes('不认识'));
  assert.ok(parseImportArgs('+ a b c d').error.includes('参数太多'));
  assert.ok(parseImportArgs('+ a.csv --counterpart').error.includes('缺值'));
});

test('/identity + 一行写全：记录 / 对面名字 / 卡名字', () => {
  const parsed = parseImportArgs('+ "C:/记录/微信 导出.csv" 阿May 小克');
  assert.equal(parsed.path, 'C:/记录/微信 导出.csv');
  assert.deepEqual(parsed.positionals, ['C:/记录/微信 导出.csv', '阿May', '小克']);
  assert.equal(parsed.options.counterpart, '', '位置参数不写进 flag，由调用方按场景解释');
  // 只给记录时，后面两个位置参数自然缺省。
  assert.deepEqual(parseImportArgs('+ a.csv').positionals, ['a.csv']);
});

// ── 回放 ──────────────────────────────────────────────────────────────────
test('留出集：测试轮次绝不进训练集', () => {
  const turns = Array.from({ length: 40 }, (_, index) => ({ speaker: index % 2 === 0 ? 'me' : 'them', text: `t${index}` }));
  const { train, heldOut, fromIndex } = splitHeldOut(turns, { heldOutTurns: 20 });
  assert.equal(train.length, fromIndex);
  assert.equal(train.length + heldOut.length, turns.length);
  assert.ok(heldOut.filter((turn) => turn.speaker === 'them').length >= 4);
});

test('打分：全被识破 = 未通过；全骗过 = 通过', () => {
  const pairs = [
    { actual: 'aaaa', generated: 'bbbb', order: decideOrder(0) }, // actual-first
    { actual: 'cccc', generated: 'dddd', order: decideOrder(1) }, // generated-first
  ];
  const wrong = new Map([[1, 'second'], [2, 'first']]);
  const bad = scoreReplay({ pairs, choices: wrong, strength: 'portrait' });
  assert.equal(bad.fooledRate, 1);
  assert.equal(bad.passed, true);
  const right = new Map([[1, 'first'], [2, 'second']]);
  const good = scoreReplay({ pairs, choices: right, strength: 'portrait' });
  assert.equal(good.fooledRate, 0);
  assert.equal(good.passed, false);
  assert.equal(good.threshold, REPLAY_THRESHOLD.portrait);
});

test('回放样本：偶数条排序确定，重复跑结果一致', () => {
  const heldOut = Array.from({ length: 12 }, (_, index) => ({ speaker: index % 2 === 0 ? 'me' : 'them', text: 'hi' }));
  const first = planReplay(heldOut, { samples: 4 }).map((item) => item.index);
  const second = planReplay(heldOut, { samples: 4 }).map((item) => item.index);
  assert.deepEqual(first, second);
  assert.deepEqual(parseGenerated('{"replies":[{"n":1,"text":"x"}]}').get(1), 'x');
  assert.equal(parseChoices('{"choices":[{"n":1,"pick":"first"}]}').get(1), 'first');
});

test('回放生成：分隔符格式能解析多段长正文（JSON 会把长文挤成一句话）', () => {
  const raw = [
    '=== 1 ===',
    '第一段的正文。',
    '',
    '### 小标题',
    '* 列表一项',
    '* 列表二项',
    '=== 2 ===',
    '第二段正文，带（括号动作）。',
  ].join('\n');
  const parsed = parseGenerated(raw);
  assert.equal(parsed.size, 2);
  assert.ok(parsed.get(1).includes('### 小标题'));
  assert.ok(parsed.get(1).includes('列表二项'));
  assert.equal(parsed.get(2), '第二段正文，带（括号动作）。');
});

// ── 存储 ──────────────────────────────────────────────────────────────────
test('存储往返：建身份 → 写卡 → 读回 → 绑定', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-idtn-'));
  try {
    const store = new IdentityStore({ rootDir: dir });
    const meta = await store.create({ name: '小克', sessionId: 'session-1' });
    assert.equal(meta.generation, 1);
    const card = normalizeCard(SAMPLE_CARD.card, { identityId: meta.identityId, name: '小克' });
    await store.writeCard(meta.identityId, card, { markdown: '# 卡' });
    await store.writeTranscript(meta.identityId, [{ speaker: 'them', text: '行' }]);
    await store.appendMemory(meta.identityId, [{ text: '下周三上线', kind: 'task' }]);

    const loaded = await store.load(meta.identityId);
    assert.equal(loaded.card.addressToUser, '波波');
    assert.equal(loaded.memory.length, 1);

    const binding = await store.writeBinding('session-1', { identityId: meta.identityId, strength: 'standin' });
    assert.equal(binding.strength, 'standin');
    const reread = await store.readBinding('session-1');
    assert.equal(reread.identityId, meta.identityId);

    // 删卡之前先把指向它的绑定清掉，避免会话里留死引用。
    assert.equal(await store.clearBindingsFor(meta.identityId), 1);
    assert.equal(await store.readBinding('session-1'), undefined);

    const list = await store.list();
    assert.equal(list.length, 1);

    await store.writeBinding('session-1', { identityId: null });
    assert.equal(await store.readBinding('session-1'), undefined);

    await store.remove(meta.identityId);
    await assert.rejects(() => store.load(meta.identityId));
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
