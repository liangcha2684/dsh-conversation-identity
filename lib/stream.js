/**
 * 极简流式装配：只关心文本块（与 dsh-conversation-memory 的做法一致）。
 * 自己实现而不从宿主包导入，避免跨包版本耦合。
 */

/**
 * 消费一个 chunk 流，装配出纯文本。
 * @param {AsyncIterable<object>} stream
 * @returns {Promise<{ text: string, finish: object | undefined, usage: object | undefined }>}
 */
export async function collectText(stream) {
  const texts = new Map();
  let finish;
  let usage;
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue;
    switch (chunk.type) {
      case 'text-delta': {
        const index = chunk.index ?? 0;
        texts.set(index, (texts.get(index) ?? '') + String(chunk.text ?? ''));
        break;
      }
      case 'block-end': {
        if (chunk.block?.type === 'text') texts.set(chunk.index ?? 0, String(chunk.block.text ?? ''));
        break;
      }
      case 'usage':
        usage = chunk.usage;
        break;
      case 'finish':
        finish = chunk.reason;
        break;
      default:
        break;
    }
  }
  const text = [...texts.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join('');
  return { text, finish, usage };
}
