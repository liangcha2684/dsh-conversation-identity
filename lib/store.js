/**
 * 存储层：身份卡、记忆、转录、会话绑定。纯 IO，不解释语义。
 *
 * 目录形状：
 *   <root>/identities/<identityId>/meta.json        身份元信息（来源、代际、覆盖范围）
 *   <root>/identities/<identityId>/card.json        身份卡
 *   <root>/identities/<identityId>/card.md          人看的卡片视图
 *   <root>/identities/<identityId>/memory.jsonl     这段关系的记忆（勾了「延续记忆」才有）
 *   <root>/identities/<identityId>/transcript.jsonl 归一化转录（锚点校验与回放都靠它）
 *   <root>/identities/<identityId>/replay.json      上次回放结果
 *   <root>/sessions/<sessionId>.json                会话绑定：用哪个身份、哪档强度
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function safeId(value) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9._-]{1,128}$/.test(text) ? text : '';
}

/** 原子写：先写临时文件再 rename，避免半截 JSON。 */
async function atomicWrite(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, text, 'utf8');
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readJsonl(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // 坏行跳过：一条坏记录不该让整个身份不可用。
    }
  }
  return out;
}

async function writeJsonl(file, rows) {
  await atomicWrite(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''));
}

export function newIdentityId() {
  return `id-${randomBytes(6).toString('hex')}`;
}

export class IdentityStore {
  constructor({ rootDir, markdownView = true } = {}) {
    this.rootDir = rootDir !== undefined && rootDir !== null && rootDir !== ''
      ? rootDir
      : join(homedir(), '.dsh', 'conversation-identity');
    this.markdownView = markdownView;
    /** @type {Map<string, object>} identityId → { meta, card, memory } */
    this.cache = new Map();
  }

  paths(identityId) {
    const dir = join(this.rootDir, 'identities', safeId(identityId));
    return {
      dir,
      meta: join(dir, 'meta.json'),
      card: join(dir, 'card.json'),
      markdown: join(dir, 'card.md'),
      memory: join(dir, 'memory.jsonl'),
      transcript: join(dir, 'transcript.jsonl'),
      replay: join(dir, 'replay.json'),
    };
  }

  bindingPath(sessionId) {
    return join(this.rootDir, 'sessions', `${safeId(sessionId)}.json`);
  }

  /** 列出全部身份（按更新时间倒序），只读 meta，不读卡。 */
  async list() {
    const dir = join(this.rootDir, 'identities');
    let entries = [];
    try {
      const { readdir } = await import('node:fs/promises');
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readJson(join(dir, entry.name, 'meta.json'));
      if (meta === undefined) continue;
      out.push(meta);
    }
    return out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  }

  /** 读一份身份的完整内容（meta + card + memory）。 */
  async load(identityId) {
    const id = safeId(identityId);
    if (id.length === 0) throw new Error('身份 id 非法');
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const paths = this.paths(id);
    const [meta, card, memory] = await Promise.all([readJson(paths.meta), readJson(paths.card), readJsonl(paths.memory)]);
    if (meta === undefined || card === undefined) throw new Error(`身份 ${id} 不存在或不完整`);
    const record = Object.freeze({ meta, card, memory });
    this.cache.set(id, record);
    return record;
  }

  /** 只读 meta（比 load 便宜，列表/校验用）。 */
  async meta(identityId) {
    const id = safeId(identityId);
    return id.length === 0 ? undefined : readJson(this.paths(id).meta);
  }

  async readTranscript(identityId) {
    const id = safeId(identityId);
    if (id.length === 0) return [];
    return readJsonl(this.paths(id).transcript);
  }

  async writeTranscript(identityId, turns) {
    await writeJsonl(this.paths(identityId).transcript, turns);
  }

  /**
   * 建一个新身份（只写 meta 骨架，卡等提炼完成后再写）。
   * @param {{ name: string, sessionId?: string, strength?: string }} input
   */
  async create({ name, sessionId, strength }) {
    const id = newIdentityId();
    const now = new Date().toISOString();
    const meta = {
      v: 1,
      identityId: id,
      name: String(name ?? '').slice(0, 40),
      generation: 1,
      createdAt: now,
      updatedAt: now,
      sources: [],
      coverage: { from: null, to: null },
      sampled: false,
      heldOutFrom: null,
      createdIn: sessionId ?? null,
      strength: strength ?? 'portrait',
      cards: 1,
    };
    await atomicWrite(this.paths(id).meta, `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  }

  async writeMeta(identityId, meta) {
    const next = { ...meta, updatedAt: new Date().toISOString() };
    await atomicWrite(this.paths(identityId).meta, `${JSON.stringify(next, null, 2)}\n`);
    this.cache.delete(safeId(identityId));
    return next;
  }

  /** 写卡（同时刷新人读视图）。generation 由调用方决定。 */
  async writeCard(identityId, card, { markdown } = {}) {
    await atomicWrite(this.paths(identityId).card, `${JSON.stringify(card, null, 2)}\n`);
    if (this.markdownView && typeof markdown === 'string') {
      await atomicWrite(this.paths(identityId).markdown, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
    }
    this.cache.delete(safeId(identityId));
  }

  /** 追加记忆（按正文去重，最多保留 memoryMax 条，超出淘汰最旧的）。 */
  async appendMemory(identityId, entries, { maxEntries = 60 } = {}) {
    const paths = this.paths(identityId);
    const existing = await readJsonl(paths.memory);
    const seen = new Set(existing.map((entry) => String(entry.text ?? '').toLowerCase()));
    const added = [];
    for (const entry of entries) {
      const text = String(entry?.text ?? '').replace(/\s+/g, ' ').trim();
      if (text.length === 0) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      added.push({
        id: randomUUID(),
        text: text.slice(0, 400),
        kind: typeof entry?.kind === 'string' ? entry.kind.slice(0, 24) : 'fact',
        createdAt: new Date().toISOString(),
        source: typeof entry?.source === 'string' ? entry.source : 'import',
      });
    }
    const merged = [...existing, ...added].slice(-Math.max(1, maxEntries));
    await atomicWrite(paths.memory, merged.map((row) => JSON.stringify(row)).join('\n') + (merged.length > 0 ? '\n' : ''));
    this.cache.delete(safeId(identityId));
    return { added: added.length, total: merged.length };
  }

  async writeReplay(identityId, replay) {
    await atomicWrite(this.paths(identityId).replay, `${JSON.stringify(replay, null, 2)}\n`);
  }

  async readReplay(identityId) {
    return readJson(this.paths(identityId).replay);
  }

  async remove(identityId) {
    const id = safeId(identityId);
    if (id.length === 0) throw new Error('身份 id 非法');
    await rm(this.paths(id).dir, { recursive: true, force: true });
    this.cache.delete(id);
  }

  /** 解绑所有指向这个身份的会话（删身份时用，避免会话里留一个死引用）。 */
  async clearBindingsFor(identityId) {
    const id = safeId(identityId);
    if (id.length === 0) return 0;
    const dir = join(this.rootDir, 'sessions');
    let entries = [];
    try {
      const { readdir } = await import('node:fs/promises');
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
    let cleared = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = join(dir, entry.name);
      const binding = await readJson(file);
      if (binding?.identityId !== id) continue;
      await rm(file, { force: true });
      cleared += 1;
    }
    return cleared;
  }

  // ── 会话绑定 ──────────────────────────────────────────────────────────
  /** 读一个会话绑定的身份；没有绑定时返回 undefined。 */
  async readBinding(sessionId) {
    const id = safeId(sessionId);
    if (id.length === 0) return undefined;
    return readJson(this.bindingPath(id));
  }

  /**
   * 写会话绑定。identityId 传 null 表示解绑。
   * @param {string} sessionId
   * @param {{ identityId: string|null, strength?: string, memory?: boolean, anchors?: boolean }} patch
   */
  async writeBinding(sessionId, patch) {
    const id = safeId(sessionId);
    if (id.length === 0) throw new Error('会话 id 非法');
    if (patch.identityId === null || patch.identityId === undefined) {
      await rm(this.bindingPath(id), { force: true });
      return undefined;
    }
    const existing = (await this.readBinding(id)) ?? {};
    const next = {
      v: 1,
      sessionId: id,
      identityId: safeId(patch.identityId),
      strength: patch.strength ?? existing.strength ?? 'portrait',
      memory: patch.memory ?? existing.memory ?? true,
      anchors: patch.anchors ?? existing.anchors ?? true,
      updatedAt: new Date().toISOString(),
    };
    if (next.identityId.length === 0) throw new Error('身份 id 非法');
    await atomicWrite(this.bindingPath(id), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
