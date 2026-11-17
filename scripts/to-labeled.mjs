/**
 * 把一份记录转换成「我: / 你:」标记的纯文本。
 *
 * 什么时候需要它：宿主里的插件还是旧版（没重启，内存里没有新的格式适配器）时，
 * 先用这个脚本把记录预归一化成纯文本，走 labeled-text 通道导入。
 * 重启 DSH 之后就不需要了，可以直接喂原始 JSON。
 *
 * 用法：node scripts/to-labeled.mjs <输入> <输出.txt>
 */
import { readFile, writeFile } from 'node:fs/promises';

import { detectFormat, normalizeTranscript } from '../lib/import-adapters.js';

const input = process.argv[2];
const output = process.argv[3];
if (input === undefined || output === undefined) {
  console.error('用法：node scripts/to-labeled.mjs <输入> <输出.txt>');
  process.exit(1);
}

const text = await readFile(input, 'utf8');
const format = detectFormat(text);
const result = normalizeTranscript(text, { format, maxMessageChars: 20000 });
if (result.ok !== true) {
  console.error('归一化失败：', result.error);
  process.exit(1);
}

const lines = [];
for (const turn of result.transcript) {
  const label = turn.speaker === 'them' ? '你' : '我';
  lines.push(`${label}: ${turn.text}`);
}
await writeFile(output, `${lines.join('\n')}\n`, 'utf8');
console.log(`format=${format} turns=${result.transcript.length} (me=${result.turns.me} them=${result.turns.them})`);
console.log(`written: ${output}`);
