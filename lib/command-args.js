/**
 * `/identity` 命令的参数解析（纯函数，便于单测）。
 *
 * 目标写法：
 *   /identity + "C:/记录/微信.csv" --counterpart=阿May --name=阿May --strength=portrait --yes
 *   /identity + C:/记录/chat.json            ← 不带 --yes 只出预算，不花钱
 *
 * 为什么默认只出预算：一次长记录导入要十几次模型调用，命令里手滑按个回车就烧钱的体验很糟。
 */

/** 把一行输入切成 token，支持单双引号包住含空格的路径。 */
export function tokenize(input) {
  const out = [];
  let current = '';
  let quote = null;
  for (const char of String(input ?? '')) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** 支持 `--k=v` / `--k v` 两种写法。 */
const VALUE_FLAGS = new Set(['counterpart', 'name', 'strength', 'format', 'memory', 'anchors', 'bind']);
/** 只有开关语义的旗标。 */
const BOOLEAN_FLAGS = new Set(['yes', 'dry', 'keep-memory', 'no-memory', 'no-anchors', 'no-bind']);

/**
 * 解析导入子命令。
 * @param {string} input - 去掉 `/identity` 之后的原文
 * @returns {{ verb: string, path: string, positionals: string[], options: object, help: boolean, error?: string }}
 */
export function parseImportArgs(input) {
  const tokens = tokenize(input);
  const verb = (tokens[0] ?? '').toLowerCase();
  const options = { counterpart: '', name: '', strength: undefined, format: undefined, memory: undefined, bind: undefined, yes: false };
  /** 位置参数：① 记录路径 ② 对面名字 ③ 卡名字（后两个可省）。 */
  const positionals = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      if (positionals.length >= 3) {
        return { verb, path: positionals[0] ?? '', positionals, options, help: false, error: `参数太多了：${token}（路径含空格请用引号包住）` };
      }
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const key = (eq >= 0 ? body.slice(0, eq) : body).toLowerCase();
    let value = eq >= 0 ? body.slice(eq + 1) : undefined;
    if (BOOLEAN_FLAGS.has(key)) {
      if (key === 'yes') options.yes = true;
      if (key === 'no-memory') options.memory = false;
      if (key === 'keep-memory') options.memory = true;
      if (key === 'no-bind') options.bind = false;
      // dry / no-anchors 由调用方按默认处理
      continue;
    }
    if (!VALUE_FLAGS.has(key)) return { verb, path: positionals[0] ?? '', positionals, options, help: false, error: `不认识的参数：--${key}` };
    if (value === undefined) {
      value = tokens[index + 1];
      if (value === undefined) return { verb, path: positionals[0] ?? '', positionals, options, help: false, error: `--${key} 后面缺值` };
      index += 1;
    }
    if (key === 'memory') options.memory = value !== 'false' && value !== '0' && value !== 'no';
    else if (key === 'bind') options.bind = value !== 'false';
    else if (key === 'strength') {
      if (!['tone', 'portrait', 'standin'].includes(value)) {
        return { verb, path: positionals[0] ?? '', positionals, options, help: false, error: `--strength 只能是 tone / portrait / standin，收到 ${value}` };
      }
      options.strength = value;
    } else options[key] = value;
  }
  return { verb, path: positionals[0] ?? '', positionals, options, help: false };
}

/** 命令自身的帮助文本。 */
export const IDENTITY_USAGE = [
  '## /identity',
  '',
  '- `/identity` —— 状态',
  '- `/identity list` —— 列出已导入身份',
  '- `/identity +` —— **一步导入：按提示一步步补，不填就取默认**',
  '- `/identity + <记录> [对面名字] [卡名字]` —— 一行写全，直接跑',
  '- `/identity cancel` —— 退出当前导入向导',
  '- `/identity use <id> [tone|portrait|standin]` —— 绑定到本会话',
  '- `/identity off` —— 解绑',
  '- `/identity show <id>` / `reanchor <id>` / `replay <id>` / `forget <id>`',
  '',
  '用法：',
  '- 一行写全：`/identity + "D:/记录/微信.csv" 阿May 小克`（记录 / 对面 / 卡名）',
  '- 只给记录：`/identity + "D:/记录/微信.csv"`，之后每次回 `/identity +` 就是「用默认继续」',
  '- 第 2 个位置参数只在「记录里出现两个自定义名字」时才被当成对面名字；',
  '  如果记录是「我/你」这种标签，第 2 个参数直接当成卡名字。',
].join('\n');
