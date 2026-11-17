/**
 * 装配冒烟测试：用替身 ctx 跑一遍 apply，确认
 *   - 该注册的段落/工具/命令/路由都注册了，名字与顺序正确；
 *   - 绑定身份后，注入段真的产出身份文本（不需要真的调用模型）；
 * 这样在重启 DSH 之前就能发现接线错误。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply } from '../lib/index.js';
import { normalizeCard, renderIdentity } from '../lib/card.js';

function makeContext(extraServices = {}) {
  const state = { sections: [], tools: [], commands: [], routes: [], events: [] };
  const disposers = [];
  const services = {
    systemPrompt: { section: (config) => { state.sections.push(config); return () => {}; } },
    tools: { register: (definition) => { state.tools.push(definition); return () => {}; } },
    commands: { register: (definition) => { state.commands.push(definition); return () => {}; } },
    webServer: { register: (definition) => { state.routes.push(definition); return () => {}; } },
    ...extraServices,
  };
  const makeScope = () => ({
    get: (name) => services[name],
    effect: (fn) => {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
  });
  const ctx = {
    effect: (fn) => {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
    inject: (deps, callback) => callback(makeScope()),
    on: (event, handler) => {
      state.events.push({ event, handler });
      disposers.push(() => {});
    },
    get: (name) => services[name],
  };
  return { ctx, state };
}

test('apply 注册了注入段 / 5 个工具 / 1 个命令 / 1 条路由', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-idtn-apply-'));
  try {
    const { ctx, state } = makeContext();
    const handle = apply(ctx, { storeDir: dir });
    try {
      assert.equal(state.sections.length, 1);
      assert.equal(state.sections[0].name, 'conversation-identity');
      assert.equal(state.sections[0].order, 8960);
      assert.deepEqual(state.tools.map((tool) => tool.name).sort(), [
        'identity_forget', 'identity_import', 'identity_list', 'identity_reanchor', 'identity_recall', 'identity_replay', 'identity_show', 'identity_use',
      ]);
      assert.equal(state.commands.length, 1);
      assert.equal(state.commands[0].name, 'identity');
      assert.equal(state.routes.length, 2);
      assert.deepEqual(state.routes.map((route) => route.path).sort(), [
        '/conversation-identity/delete',
        '/conversation-identity/state',
      ]);
      assert.deepEqual(handle.config.maxCharsByStrength, { tone: 320, portrait: 900, standin: 1600 });
    } finally {
      await handle.drain();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('绑定身份后，注入段产出身份文本；解绑后为空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-idtn-inject-'));
  try {
    const { ctx, state } = makeContext();
    const handle = apply(ctx, { storeDir: dir });
    try {
      const meta = await handle.store.create({ name: '小克', sessionId: 'session-1' });
      const card = normalizeCard({ addressToUser: '波波', register: '随意', sentence: '短句为主', closing: '给结论', judgment: '先给结论' }, { identityId: meta.identityId, name: '小克', generation: 2 });
      await handle.store.writeCard(meta.identityId, card, { markdown: '# 卡' });
      await handle.store.writeBinding('session-1', { identityId: meta.identityId, strength: 'portrait' });

      // 模拟宿主发 session/created，让插件把绑定读进内存。
      const created = state.events.find((item) => item.event === 'session/created');
      assert.ok(created !== undefined);
      created.handler({ id: 'session-1' });
      await handle.drain();

      const section = state.sections[0];
      const injected = section.text({ agent: { session: { id: 'session-1' } } });
      assert.ok(injected.includes('波波'), '注入段应包含称呼');
      assert.ok(injected.includes('第 2 代'), '注入段应包含代际声明');
      assert.ok(injected.includes('工具使用'), '注入段应包含硬底线');

      // 不相关的会话不该被注入。
      assert.equal(section.text({ agent: { session: { id: 'session-other' } } }), '');

      // 解绑后立刻消失（缓存同步更新）。
      const use = state.tools.find((tool) => tool.name === 'identity_use');
      await use.execute({ identityId: 'off' }, { agent: { session: { id: 'session-1' } } });
      assert.equal(section.text({ agent: { session: { id: 'session-1' } } }), '');
    } finally {
      await handle.drain();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('identity_list 在没有身份时也能正常返回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-idtn-list-'));
  try {
    const { ctx, state } = makeContext();
    const handle = apply(ctx, { storeDir: dir });
    try {
      const list = state.tools.find((tool) => tool.name === 'identity_list');
      const value = await list.execute({}, { agent: { session: { id: 'session-1' } } });
      assert.deepEqual(value.identities, []);
      assert.equal(value.binding, null);
    } finally {
      await handle.drain();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('三档注入文本长度单调递增且都非空', () => {
  const card = normalizeCard({ addressToUser: '波波', register: '随意', sentence: '短句为主', closing: '给结论', judgment: '先给结论', relationship: '同事式互怼' }, { identityId: 'id-1', name: '小克' });
  const tone = renderIdentity(card, { strength: 'tone' });
  const portrait = renderIdentity(card, { strength: 'portrait' });
  const standin = renderIdentity(card, { strength: 'standin' });
  assert.ok(tone.length > 0 && portrait.length > tone.length && standin.length > portrait.length);
});

test('/identity + 向导：先问对面是谁，答完再问名字，可取消', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-idtn-wizard-'));
  try {
    const csv = ['sender,content', '波波,在吗', '小鲸,在的呀', '波波,今天累死了', '小鲸,抱抱你', '波波,好', '小鲸,去洗澡'].join('\n');
    const file = join(dir, 'chat.csv');
    await writeFile(file, csv, 'utf8');
    const { ctx, state } = makeContext();
    const handle = apply(ctx, { storeDir: dir });
    try {
      const command = state.commands.find((item) => item.name === 'identity');
      const session = { id: 'session-wizard' };

      const step1 = await command.handler({ rawInput: `+ ${file}`, agent: { session }, attachments: [] });
      assert.equal(step1.kind, 'success', step1.text);
      assert.ok(step1.text.includes('哪个是你要延续的那个人'), `应问对面是谁：${step1.text}`);
      assert.ok(step1.text.includes('小鲸') && step1.text.includes('波波'), '要列出认出的名字');
      assert.ok(step1.text.includes('/identity + '), '要告诉用户怎么用默认');

      const step2 = await command.handler({ rawInput: '+ 小鲸', agent: { session }, attachments: [] });
      assert.ok(step2.text.includes('叫什么名字'), `应问名字：${step2.text}`);

      const cancelled = await command.handler({ rawInput: 'cancel', agent: { session }, attachments: [] });
      assert.ok(cancelled.text.includes('已退出'), cancelled.text);
      const afterCancel = await command.handler({ rawInput: 'list', agent: { session }, attachments: [] });
      assert.ok(afterCancel.text.includes('还没有'), '取消后不应留下身份');
    } finally {
      await handle.drain();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/identity + 附件：读附件 → 问名字 → 长记录出预算等确认', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-idtn-attach-'));
  try {
    // 一段足够长的纯文本（约 24 万字 → 分块抽样 12 块 → 14 次调用），确保落在「要确认」区间。
    const lines = [];
    for (let index = 0; index < 800; index += 1) {
      lines.push(index % 2 === 0 ? `我: 第${index}个问题，${'描述'.repeat(60)}` : `小鲸: 第${index}个回答，${'解释'.repeat(60)}`);
    }
    const file = join(dir, 'chat.txt');
    await writeFile(file, lines.join('\n'), 'utf8');

    // 附件服务替身：fileHostPath 直接返回磁盘路径。
    const { ctx, state } = makeContext({ attachments: { fileHostPath: () => file } });
    const handle = apply(ctx, { storeDir: dir });
    try {
      const command = state.commands.find((item) => item.name === 'identity');
      const session = { id: 'session-attach' };

      // 第一步：拖附件 + `/identity +` → 记录里是「我/小鲸」，认不出对面，先问对面是谁。
      const step1 = await command.handler({
        rawInput: '+',
        agent: { session },
        attachments: [{ type: 'file', attachment: { attachmentId: 'a1', name: 'chat.txt', bytes: 1 } }],
      });
      assert.equal(step1.kind, 'success', String(step1.text).slice(0, 200));
      assert.ok(step1.text.includes('哪个是你要延续的那个人'), `应先问对面：${String(step1.text).slice(0, 200)}`);

      // 第二步：指定对面 → 问名字。
      const step2 = await command.handler({ rawInput: '+ 小鲸', agent: { session }, attachments: [] });
      assert.ok(step2.text.includes('叫什么名字'), `应问名字：${String(step2.text).slice(0, 200)}`);

      // 第三步：给名字 → 长记录（14 次调用）要停下来等确认。
      const step3 = await command.handler({ rawInput: '+ 测试卡', agent: { session }, attachments: [] });
      assert.ok(step3.text.includes('调用次数'), '应给出预算');
      assert.ok(step3.text.includes('/identity yes'), '长记录要停下来等确认');
      assert.ok(!step3.text.includes('已绑定到本会话'), '确认前不该跑完');
    } finally {
      await handle.drain();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
