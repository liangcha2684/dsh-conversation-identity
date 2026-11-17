/**
 * 离线体检：只做归一化 + 预算，不调用模型、不落盘。
 * 用法：node scripts/dry-run.mjs <记录文件> [counterpart]
 */
import { readFile } from 'node:fs/promises';

import { detectFormat, normalizeTranscript, applyCounterpart, summarize } from '../lib/import-adapters.js';
import { planChunks } from '../lib/distill.js';
import { splitHeldOut } from '../lib/replay.js';
import { normalizeConfig } from '../lib/config.js';

const file = process.argv[2];
const counterpart = process.argv[3] ?? '';
if (file === undefined) {
  console.error('用法：node scripts/dry-run.mjs <记录文件> [counterpart]');
  process.exit(1);
}

const text = await readFile(file, 'utf8');
const format = detectFormat(text);
console.log(`file      : ${file}`);
console.log(`chars     : ${text.length}`);
console.log(`format    : ${format}`);

let norm = normalizeTranscript(text, { format, maxMessageChars: 4000 });
let turns = norm.transcript ?? [];
if (counterpart.length > 0 && turns.some((turn) => turn.speaker === 'unknown')) {
  turns = applyCounterpart(turns, counterpart);
  norm = summarize(turns, { format: norm.format, notes: norm.notes ?? [] });
}
console.log(`ok        : ${norm.ok}  confidence: ${norm.confidence}`);
console.log(`turns     : ${JSON.stringify(norm.turns)}`);
if (Array.isArray(norm.samples) && norm.samples.length > 0) {
  console.log('samples   :');
  for (const sample of norm.samples.slice(0, 4)) console.log(`  [${sample.speaker}] ${sample.text.slice(0, 100)}`);
}
if (norm.ok !== true) {
  console.log(`error     : ${norm.error}`);
  process.exit(0);
}

const config = normalizeConfig({});
const { train, heldOut, fromIndex } = splitHeldOut(norm.transcript, { heldOutTurns: config.heldOutTurns });
const chars = train.reduce((sum, turn) => sum + String(turn.text ?? '').length + 24, 0);
const plan = planChunks(train, { chunkChars: config.chunkChars, maxChunks: config.maxChunks });
const single = chars <= config.distillMaxInputChars;
console.log(`train     : ${train.length} 轮 / ${chars} 字`);
console.log(`heldOut   : ${heldOut.length} 轮（从第 ${fromIndex} 条开始，提炼模型看不到）`);
console.log(`chunks    : ${single ? 1 : plan.chunks.length}${plan.sampled ? `（抽样，共 ${plan.totalChunks} 块）` : ''}`);
console.log(`est calls : ${(single ? 1 : plan.chunks.length + 1) + 1}（含 1 次记忆）`);

// 抽查几条「对面」的话，确认没把用户发言认成对面。
const them = norm.transcript.filter((turn) => turn.speaker === 'them').slice(0, 3);
console.log('them 抽样 :');
for (const turn of them) console.log(`  - ${turn.text.slice(0, 120)}`);
const me = norm.transcript.filter((turn) => turn.speaker === 'me').slice(0, 2);
console.log('me 抽样   :');
for (const turn of me) console.log(`  - ${turn.text.slice(0, 120)}`);
