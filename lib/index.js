/**
 * dsh-conversation-identity —— 对话身份延续插件（host 侧，零依赖）。
 *
 * 做什么：
 *   1. 导入一段聊天记录（平台导出 / 纯文本 / JSONL），归一化成转录；
 *   2. 切出留出集（回放测试用，提炼模型看不到），把剩下的交给当前会话同款模型，
 *      重建出「聊天的对面」的身份卡（语气 / 节奏 / 思维 / 相处方式 + 原文锚点）；
 *   3. 落盘到 <DSH_HOME>/conversation-identity/identities/<id>/；
 *   4. 新建会话时（client 半边的选择器）绑定一个身份 + 强度档，之后每次模型请求把
 *      身份段注入系统提示词——于是新会话直接接着上次的关系说话；
 *   5. 提供 identity_* 工具、/identity 命令、以及回放盲判验收。
 *
 * 为什么零依赖：第三方插件与宿主 @deepseek-ai/* 的版本可能错位。这里只用 node 内置模块
 * 与 ctx 上的 service 接口，工具定义与消息对象按 DSH 运行时形状手写。
 */
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { normalizeConfig, STRENGTHS, STRENGTH_LABEL } from './config.js';
import { IdentityStore } from './store.js';
import { normalizeTranscript, applyCounterpart, summarize, detectFormat } from './import-adapters.js';
import {
  planChunks,
  buildCardPrompt,
  buildChunkPrompt,
  buildMergePrompt,
  buildMemoryPrompt,
  parseCardResponse,
  parseChunkResponse,
  parseMemoryResponse,
  validateAnchors,
} from './distill.js';
import { renderIdentity, renderCardMarkdown } from './card.js';
import { refreshCardEvidence } from './anchors.js';
import { measureStyle, applyMetricsToCard } from './metrics.js';
import { searchTranscript, renderRecall } from './recall.js';
import { parseImportArgs, IDENTITY_USAGE } from './command-args.js';
import {
  splitHeldOut,
  planReplay,
  buildGeneratePrompt,
  buildJudgePrompt,
  parseGenerated,
  parseChoices,
  decideOrder,
  scoreReplay,
  REPLAY_THRESHOLD,
} from './replay.js';
import { collectText } from './stream.js';

/** 插件名（cordis loader 日志用）。 */
export const name = 'conversation-identity';

/** 不硬依赖任何服务：缺哪个就少哪个调用面。 */
export const inject = [];

const LOG_PREFIX = '[conversation-identity]';
const ROUTE_PREFIX = '/conversation-identity';

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  try {
    if (typeof res?.writeHead === 'function') {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
    }
    if (typeof res?.end === 'function') res.end(body);
  } catch {
    // 连接已断：没有可恢复的动作
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 262144) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text.length === 0 ? {} : JSON.parse(text);
}

/** 从会话对象上解析提炼要用的 provider/model。 */
function resolveRoute(config, session) {
  if (config.provider !== null && config.model !== null) return { provider: config.provider, model: config.model };
  try {
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined;
    const configRoute = header?.config;
    if (typeof configRoute?.provider === 'string' && typeof configRoute?.model === 'string') {
      return { provider: configRoute.provider, model: configRoute.model };
    }
    const context = typeof session?.requestContext === 'function' ? session.requestContext() : undefined;
    if (typeof context?.provider === 'string' && typeof context?.model === 'string') {
      return { provider: context.provider, model: context.model };
    }
  } catch {
    // 会话刚建 / headless 首次请求前拿不到路由，由调用方降级。
  }
  return undefined;
}

function newSourceId() {
  return `src-${randomBytes(4).toString('hex')}`;
}

/** 从命令参数里挑出导入用的那几个（空字符串当没给）。 */
function pickImportFlags(options) {
  return {
    counterpart: typeof options?.counterpart === 'string' && options.counterpart.length > 0 ? options.counterpart : undefined,
    name: typeof options?.name === 'string' && options.name.length > 0 ? options.name : undefined,
    strength: options?.strength,
    format: options?.format,
    memory: options?.memory,
    bind: options?.bind,
  };
}

/** 向导每一步要问的那句话。 */
function importStepPrompt(wizard) {
  if (wizard.step === 'counterpart') {
    const names = Array.isArray(wizard.names) && wizard.names.length > 0 ? wizard.names.join(' / ') : '（没认出名字）';
    return [
      `记录里认出这些名字：**${names}**`,
      '哪个是你要延续的那个人？',
      '- 指定：`/identity + 某个名字`',
      `- 用默认（**${wizard.defaultCounterpart || '第一个名字'}**）：直接回 \`/identity +\``,
      '',
      '（退出向导：`/identity cancel`）',
    ].join('\n');
  }
  return [
    '这张角色卡叫什么名字？',
    '- 起名：`/identity + 小克`',
    `- 用默认（**${wizard.defaultName || '文件名'}**）：直接回 \`/identity +\``,
    '',
    '（退出向导：`/identity cancel`）',
  ].join('\n');
}

/** 记录的时间范围（有 ts 才有）。 */
function coverageOf(turns) {
  let from = null;
  let to = null;
  for (const turn of turns) {
    const ts = Number(turn?.ts);
    if (!Number.isFinite(ts)) continue;
    const iso = new Date(ts).toISOString();
    if (from === null || iso < from) from = iso;
    if (to === null || iso > to) to = iso;
  }
  return { from, to };
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) {
    log('已在配置里禁用（enabled: false），不加载任何能力。');
    return { drain: async () => {}, config };
  }

  const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  const rootDir = config.storeDir ?? join(dshHome, 'conversation-identity');
  const store = new IdentityStore({ rootDir });

  /** @type {Map<string, object|null>} sessionId → 绑定 */
  const bindings = new Map();
  /** @type {Map<string, object>} identityId → { meta, card, memory } */
  const identities = new Map();
  /** @type {Map<string, object[]>} identityId → 转录（检索用，按身份缓一次） */
  const transcripts = new Map();
  /** @type {Map<string, { at: number, args: object }>} sessionId → 待确认的导入（/identity + 之后等 /identity yes） */
  const pendingImports = new Map();
  /** @type {Map<string, object>} sessionId → 导入向导状态（一步步补参数，不填就用默认） */
  const wizards = new Map();
  /** 向导的有效期：10 分钟。 */
  const WIZARD_TTL_MS = 10 * 60 * 1000;
  /** 待确认导入的有效期：10 分钟。过期就要求重跑一次预估，免得拿着旧预算去花钱。 */
  const PENDING_TTL_MS = 10 * 60 * 1000;
  /** @type {Set<string>} 正在预热的会话 */
  const priming = new Set();
  const lifetime = new AbortController();
  const inflight = new Set();

  ctx.effect(() => () => {
    lifetime.abort(new Error('conversation-identity 插件已卸载'));
    for (const task of inflight) task.catch(() => undefined);
  }, 'conversation-identity: lifecycle');

  // ── 预热：把绑定与身份卡读进内存，注入段只读内存（同步）────────────────
  async function primeIdentity(identityId) {
    if (typeof identityId !== 'string' || identityId.length === 0) return undefined;
    if (identities.has(identityId)) return identities.get(identityId);
    try {
      const record = await store.load(identityId);
      identities.set(identityId, record);
      return record;
    } catch (error) {
      log(`读取身份 ${identityId} 失败：${errorMessage(error)}`);
      return undefined;
    }
  }

  function primeSession(session) {
    const id = session?.id;
    if (typeof id !== 'string' || id.length === 0) return;
    if (bindings.has(id) || priming.has(id)) return;
    priming.add(id);
    const task = store.readBinding(id)
      .then(async (binding) => {
        if (binding?.identityId !== undefined) await primeIdentity(binding.identityId);
        bindings.set(id, binding ?? null);
      })
      .catch((error) => {
        log(`预热会话 ${id} 的身份绑定失败：${errorMessage(error)}`);
        bindings.set(id, null);
      })
      .finally(() => priming.delete(id));
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  }

  // ── 模型调用 ─────────────────────────────────────────────────────────
  /**
   * 调一次模型，返回纯文本。
   *
   * 为什么带 compact 重试：提炼要输出一整张卡，推理模型的思维链也吃 maxOutputTokens 预算，
   * 长记录的合并阶段很容易触顶。第一次触顶时自动换一版更紧凑的输出要求再试一次——
   * 比直接失败好，也比一直调大上限省事。
   *
   * @param {object} session
   * @param {string} system
   * @param {string} user
   * @param {{ stage?: string }} options
   */
  async function callModel(session, system, user, { stage = '调用' } = {}) {
    const llm = ctx.get('llm');
    if (llm === undefined) throw new Error('llm 服务不可用（宿主没有挂载 LLM 运行时）');
    const route = resolveRoute(config, session);
    if (route === undefined) throw new Error('无法确定提炼用的 provider/model：请在插件配置里显式填 provider + model');

    const COMPACT = [
      '',
      '【重要】上一次的输出因为太长被截断了。这一次必须极度紧凑：',
      '- 每个字段值不超过 30 字；',
      '- 锚点最多 4 条，每条 quote 不超过 40 字；',
      '- 不要输出任何解释、Markdown 围栏或多余空白；',
      '- 仍然只输出一个 JSON 对象。',
    ].join('\n');

    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`${stage}超时（${config.timeoutMs}ms）`)), config.timeoutMs);
      const signal = AbortSignal.any([lifetime.signal, controller.signal]);
      const started = Date.now();
      try {
        const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: config.maxOutputTokens }, signal);
        const message = {
          id: `identity-${randomBytes(6).toString('hex')}`,
          role: 'user',
          content: [{ type: 'text', text: user }],
          source: { kind: 'conversation-identity' },
        };
        const stream = call.stream({
          ...call.config,
          messages: [message],
          system: attempt === 1 ? system : `${system}\n${COMPACT}`,
          sessionId: session?.id,
          purpose: 'conversation-identity',
          signal,
        });
        const { text, finish } = await collectText(stream);
        const ms = Date.now() - started;
        log(`${stage}：输入 ${user.length} 字 → 输出 ${text.length} 字，用时 ${ms}ms，finish=${finish?.kind ?? 'ok'}${attempt > 1 ? '（紧凑重试）' : ''}`);
        if (finish?.kind === 'error' || finish?.kind === 'aborted') {
          throw new Error(`[${stage}] 模型调用失败：${finish?.failure?.message ?? finish.kind}`);
        }
        if (finish?.kind === 'max-tokens') {
          lastError = new Error(`[${stage}] 模型输出触顶 maxOutputTokens（${config.maxOutputTokens}）被截断`);
          if (attempt === 1) {
            log(`${stage}：输出触顶，改为紧凑模式重试一次`);
            continue;
          }
          throw lastError;
        }
        return text;
      } catch (error) {
        // 中止/失败不再重试，直接把阶段信息带出去，便于定位是哪一步挂的。
        if (error instanceof Error && error.message.startsWith(`[${stage}]`)) throw error;
        throw new Error(`[${stage}] ${errorMessage(error)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error(`[${stage}] 未知失败`);
  }

  /** 出卡/合并：模型偶尔会把 JSON 写成散文，多给一次机会——别让一次格式问题白烧一整轮导入。 */
  async function distillCard(session, prompts, { stage, identityId, name, sourceId }) {
    let calls = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const system = attempt === 1
        ? prompts.system
        : `【只输出 JSON】你上一次的输出不是可解析的 JSON 对象。这次严格只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。\n\n${prompts.system}`;
      const raw = await callModel(session, system, prompts.user, { stage: attempt === 1 ? stage : `${stage}(重试)` });
      calls += 1;
      const parsed = parseCardResponse(raw, { identityId, name, generation: 1, sourceIds: [sourceId] });
      if (parsed !== undefined) return { result: parsed, calls };
      log(`${stage}：输出不是可解析的身份卡 JSON，重试一次`);
    }
    return { result: undefined, calls };
  }

  /** 从文件路径猜一个身份名（没有 --name 时用）。 */
  function guessNameFromPath(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) return undefined;
    const base = basename(filePath).replace(/\.[^.]+$/u, '').trim();
    return base.length > 0 ? base.slice(0, 40) : undefined;
  }

  // ── 导入 ─────────────────────────────────────────────────────────────
  /** 只算预算，不花钱。 */
  function estimateImport(turns, memory) {
    const { train } = splitHeldOut(turns, { heldOutTurns: config.heldOutTurns });
    const chars = train.reduce((sum, turn) => sum + String(turn.text ?? '').length + 24, 0);
    const withMemory = memory !== false;
    if (chars <= config.distillMaxInputChars) {
      return { calls: 1 + (withMemory ? 1 : 0), chunks: 1, chars, sampled: false, trainTurns: train.length };
    }
    const plan = planChunks(train, { chunkChars: config.chunkChars, maxChunks: config.maxChunks });
    return {
      calls: plan.chunks.length + 1 + (withMemory ? 1 : 0),
      chunks: plan.chunks.length,
      chars,
      sampled: plan.sampled,
      totalChunks: plan.totalChunks ?? plan.chunks.length,
      trainTurns: train.length,
    };
  }

  async function readSource(args) {
    if (typeof args?.text === 'string' && args.text.trim().length > 0) {
      return {
        text: args.text,
        kind: typeof args?.sourceKind === 'string' ? args.sourceKind : 'pasted',
        label: typeof args?.sourceLabel === 'string' ? args.sourceLabel : undefined,
      };
    }
    if (typeof args?.path === 'string' && args.path.trim().length > 0) {
      const file = args.path.trim();
      const text = await readFile(file, 'utf8');
      return { text, kind: 'file', path: file };
    }
    throw new Error('需要 path（文件路径）或 text（直接粘贴的内容）其中之一');
  }

  /** 从命令携带的附件里取一个文本文件；不是文本就明确报错，不猜。 */
  async function readAttachmentSource(invocation) {
    const list = Array.isArray(invocation?.attachments) ? invocation.attachments : [];
    const block = list.find((item) => item?.type === 'file' && item?.attachment?.attachmentId !== undefined);
    if (block === undefined) return undefined;
    const service = ctx.get('attachments');
    if (service === undefined) throw new Error('宿主没有附件服务，读不了附件；请直接给文件路径');
    const ref = block.attachment;
    const name = typeof ref.name === 'string' && ref.name.length > 0 ? ref.name : '附件';
    const hostPath = typeof service.fileHostPath === 'function' ? service.fileHostPath(ref) : undefined;
    if (typeof hostPath === 'string' && hostPath.length > 0) {
      return { text: await readFile(hostPath, 'utf8'), kind: 'attachment', sourceLabel: name };
    }
    if (typeof service.readFileStream === 'function') {
      const chunks = [];
      for await (const chunk of service.readFileStream(ref)) chunks.push(Buffer.from(chunk));
      return { text: Buffer.concat(chunks).toString('utf8'), kind: 'attachment', sourceLabel: name };
    }
    throw new Error('这个附件不是可读的文本文件；请改成给文件路径');
  }

  /**
   * 完整导入流程：归一化 → 留出切分 → 提炼 → 落盘 → 绑定。
   * @returns {Promise<object>} 给工具/命令渲染用的结果对象
   */
  async function importIdentity(session, args) {
    const source = await readSource(args);
    const format = typeof args?.format === 'string' && args.format !== 'auto' ? args.format : detectFormat(source.text);
    let norm = normalizeTranscript(source.text, {
      format,
      meLabels: config.meLabels,
      themLabels: config.themLabels,
      maxMessageChars: config.maxMessageChars,
    });
    const counterpart = typeof args?.counterpart === 'string' ? args.counterpart.trim() : '';
    let turns = Array.isArray(norm.transcript) ? norm.transcript : [];
    if (counterpart.length > 0 && turns.some((turn) => turn.speaker === 'unknown')) {
      turns = applyCounterpart(turns, counterpart);
      norm = summarize(turns, { format: norm.format ?? format, notes: Array.isArray(norm.notes) ? norm.notes : [] });
    }
    if (norm.ok !== true) {
      // 工具输出必须是无损 JSON：可缺的字段一律显式置 null，不要留 undefined。
      return {
        ok: false,
        needs: 'speaker',
        error: norm.error ?? '无法识别对话',
        format: norm.format ?? format,
        names: Array.isArray(norm.names) ? norm.names : [],
        turns: norm.turns ?? null,
        samples: Array.isArray(norm.samples) ? norm.samples : [],
        notes: Array.isArray(norm.notes) ? norm.notes : [],
        // 一次把要问的全给出来，别让用户一个个字段试。
        questions: Array.isArray(norm.names) && norm.names.length > 0
          ? [{
            id: 'counterpart',
            question: '记录里出现了多个名字，哪个是你要延续的那个人？',
            options: norm.names.slice(0, 6),
          }]
          : [],
        hint: '这份记录的说话人没法自动判定。请把对方的名字（或称呼）作为 counterpart 传进来，其余发言会被当作你自己。',
      };
    }
    turns = norm.transcript;

    const memory = args?.memory === undefined ? config.memoryOnImport : args.memory !== false;
    const estimate = estimateImport(turns, memory);
    const guessedName = guessNameFromPath(source.path)
      ?? (typeof norm.speakers?.them === 'string' && norm.speakers.them.length > 0 ? norm.speakers.them : '')
      ?? '';
    if (args?.dryRun === true) {
      return {
        ok: true,
        dryRun: true,
        suggestedName: guessedName.length > 0 ? guessedName : `身份 ${new Date().toISOString().slice(0, 10)}`,
        suggestedCounterpart: Array.isArray(norm.names) && norm.names.length > 0 ? norm.names[0] : '',
        format: norm.format,
        confidence: norm.confidence,
        turns: norm.turns,
        samples: norm.samples,
        notes: norm.notes,
        coverage: coverageOf(turns),
        estimate,
        hint: `预估 ${estimate.calls} 次模型调用（${estimate.chunks} 块${estimate.sampled ? '，超长已抽样' : ''}）。确认无误后去掉 dryRun 再调一次。`,
      };
    }

    const identityName = typeof args?.name === 'string' && args.name.trim().length > 0
      ? args.name.trim().slice(0, 40)
      : (guessedName.length > 0 ? guessedName : `身份 ${new Date().toISOString().slice(0, 10)}`);
    const strength = STRENGTHS.includes(args?.strength) ? args.strength : config.defaultStrength;

    const meta0 = await store.create({ name: identityName, sessionId: session?.id, strength });
    const identityId = meta0.identityId;
    const sourceId = newSourceId();
    await store.writeTranscript(identityId, turns);

    const { train, fromIndex } = splitHeldOut(turns, { heldOutTurns: config.heldOutTurns });
    if (train.length < 2) {
      await store.remove(identityId).catch(() => undefined);
      throw new Error('记录太短（切掉留出集后不足 2 轮），无法提炼');
    }
    // 只有**真的知道对方名字**时才把名字给模型看。像我/你这种标签，给名字等于教模型编一个人名出来
    // （上一版就把身份名当成了对方的名字，卡里 displayName 和记忆都歪了）。
    const knownThem = (typeof counterpart === 'string' && counterpart.length > 0)
      ? counterpart
      : (typeof norm.speakers?.them === 'string' ? norm.speakers.them : '');
    const label = knownThem.length > 0 ? { them: knownThem, me: 'A' } : undefined;

    let calls = 0;
    let sampled = false;
    let card;
    let anchors = [];
    try {
      const chars = train.reduce((sum, turn) => sum + String(turn.text ?? '').length + 24, 0);
      if (chars <= config.distillMaxInputChars) {
        const prompts = buildCardPrompt({ turns: train, language: config.language, label });
        const distilled = await distillCard(session, prompts, { stage: '出卡', identityId, name: identityName, sourceId });
        calls += distilled.calls;
        if (distilled.result === undefined) throw new Error('模型两次都没有产出可解析的身份卡 JSON');
        card = distilled.result.card;
        anchors = distilled.result.anchors;
      } else {
        const plan = planChunks(train, { chunkChars: config.chunkChars, maxChunks: config.maxChunks });
        sampled = plan.sampled === true;
        const observations = [];
        const rawAnchors = [];
        for (let index = 0; index < plan.chunks.length; index += 1) {
          const prompts = buildChunkPrompt({ turns: plan.chunks[index], index, total: plan.chunks.length, language: config.language, label });
          const raw = await callModel(session, prompts.system, prompts.user, { stage: `分块 ${index + 1}/${plan.chunks.length}` });
          calls += 1;
          const parsed = parseChunkResponse(raw);
          if (parsed !== undefined) {
            observations.push(parsed.observations);
            rawAnchors.push(...parsed.anchors);
          }
        }
        if (observations.length === 0) throw new Error('分块观察全部失败（模型没有产出可解析的 JSON）');
        const merge = buildMergePrompt({ observations, anchors: rawAnchors.slice(0, 24), language: config.language });
        const merged = await distillCard(session, merge, { stage: '合并', identityId, name: identityName, sourceId });
        calls += merged.calls;
        if (merged.result === undefined) throw new Error('合并阶段模型两次都没有产出可解析的身份卡 JSON');
        card = merged.result.card;
        anchors = merged.result.anchors;
      }
    } catch (error) {
      await store.remove(identityId).catch(() => undefined);
      throw error;
    }

    // 模型常把非必填的 anchors / catchphrases 整段省掉。这两样本来就能从转录里量出来，
    // 先本地补齐（免费、确定），再走逐字校验——保证卡里永远有「不许编」的依据。
    const local = refreshCardEvidence(card, train, { sourceId, limit: 8 });
    card = local.card;
    if (local.addedAnchors > 0 || local.catchphrases > 0) {
      log(`本地补齐：锚点 +${local.addedAnchors}、口头禅 ${local.catchphrases} 条`);
    }
    // 「他回多长」这种事不用问模型，量出来更准；长度是回放里最容易被识破的破绽。
    card = applyMetricsToCard(card, measureStyle(train));
    anchors = [...anchors, ...card.anchors];

    // 锚点：逐字校验 + 按转录行号回填。假锚点一律丢掉。
    const normalizedHaystack = turns.map((turn) => String(turn.text ?? '')).join('\n').replace(/\s+/g, ' ');
    const keptAnchors = [];
    for (const anchor of validateAnchors(anchors, train)) {
      const needle = String(anchor.quote).replace(/\s+/g, ' ').trim();
      const index = turns.findIndex((turn) => String(turn.text ?? '').replace(/\s+/g, ' ').includes(needle));
      if (index < 0) continue;
      keptAnchors.push({ ...anchor, sourceId, line: index + 1 });
    }
    // 去重：同一句原话被模型重复给出多次时只留一条（上一版 #53 出现过两条一样的）。
    const seenQuotes = new Set();
    card.anchors = keptAnchors
      .filter((anchor) => {
        const key = String(anchor.quote ?? '').replace(/\s+/g, '');
        if (key.length === 0 || seenQuotes.has(key)) return false;
        seenQuotes.add(key);
        return true;
      })
      .slice(-12);

    let memoryResult = { added: 0, total: 0 };
    if (memory) {
      try {
        const prompts = buildMemoryPrompt({ turns: train, language: config.language, label });
        const raw = await callModel(session, prompts.system, prompts.user, { stage: '记忆' });
        calls += 1;
        memoryResult = await store.appendMemory(identityId, parseMemoryResponse(raw), { maxEntries: 60 });
      } catch (error) {
        log(`记忆提炼失败（身份卡已生成，不影响使用）：${errorMessage(error)}`);
      }
    }

    const coverage = coverageOf(turns);
    const markdown = renderCardMarkdown(card, {
      meta: {
        identityId,
        generation: 1,
        createdAt: meta0.createdAt,
        updatedAt: new Date().toISOString(),
        sources: [{ id: sourceId, kind: source.kind, format: norm.format, turns: turns.length, addedAt: new Date().toISOString(), sampled }],
        coverage,
      },
    });
    await store.writeCard(identityId, card, { markdown });
    const meta = await store.writeMeta(identityId, {
      ...meta0,
      name: identityName,
      strength,
      sources: [{
        id: sourceId,
        kind: source.kind,
        format: norm.format,
        path: source.path ?? null,
        label: source.label ?? null,
        turns: turns.length,
        heldOut: turns.length - fromIndex,
        sampled,
        addedAt: new Date().toISOString(),
      }],
      coverage,
      sampled,
      heldOutFrom: fromIndex,
      levels: calls,
      confidence: norm.confidence,
      notes: norm.notes,
    });

    if (args?.bind !== false && typeof session?.id === 'string') {
      const binding = await store.writeBinding(session.id, { identityId, strength, memory, anchors: true });
      bindings.set(session.id, binding ?? null);
    }
    await primeIdentity(identityId);

    return {
      ok: true,
      identityId,
      name: identityName,
      strength,
      format: norm.format,
      turns: norm.turns,
      heldOut: turns.length - fromIndex,
      anchors: card.anchors.length,
      memory: memoryResult,
      calls,
      sampled,
      confidence: norm.confidence,
      notes: norm.notes,
      meta,
      hint: `已建好身份「${identityName}」。新建会话时在「身份」里选它即可；也可以现在直接聊——本会话已经绑定上了。`,
    };
  }

  // ── 回放测试 ─────────────────────────────────────────────────────────
  async function runReplay(session, { identityId, strength: requested, samples } = {}) {
    const record = await store.load(identityId);
    const turns = await store.readTranscript(identityId);
    const from = Number.isFinite(Number(record.meta.heldOutFrom))
      ? Number(record.meta.heldOutFrom)
      : splitHeldOut(turns, { heldOutTurns: config.heldOutTurns }).fromIndex;
    const held = turns.slice(from);
    const themCount = held.filter((turn) => turn.speaker === 'them').length;
    if (themCount < 2) throw new Error(`留出集里「对面」只有 ${themCount} 条发言，没法回放（可把 heldOutTurns 调大后重新导入）`);

    const strength = STRENGTHS.includes(requested) ? requested : (record.meta.strength ?? config.defaultStrength);
    const items = planReplay(held, { samples: Math.min(12, Math.max(2, Math.trunc(Number(samples ?? 8)) || 8)) });
    if (items.length === 0) throw new Error('留出集里没有可考的样本');

    const identityText = renderIdentity(record.card, {
      strength,
      maxChars: config.maxCharsByStrength[strength],
      memory: record.memory,
      anchorsMax: config.anchorsMax,
      memoryMax: config.memoryMaxEntries,
      allowEmotion: config.allowEmotion,
    });
    const targetChars = Number(record.card?.metrics?.median) > 0 ? Number(record.card.metrics.median) : 600;
    const generate = buildGeneratePrompt({ identityText, items, language: config.language, targetChars });
    let generated = parseGenerated(await callModel(session, generate.system, generate.user, { stage: '回放生成' }));
    if (generated.size === 0) {
      // 少量模型会无视分隔符继续写散文；再来一次，把格式要求顶到最前面。
      const retrySystem = [
        '【只输出带分隔符的正文】上一次输出里没有 `=== 1 ===` 这样的分隔行，无法解析。',
        `这次严格按格式输出 ${items.length} 段，每段前面写一行 === n ===，后面是完整回复（每段 ${targetChars} 字上下，不要压缩）。`,
        '',
        generate.system,
      ].join('\n');
      generated = parseGenerated(await callModel(session, retrySystem, generate.user, { stage: '回放生成(重试)' }));
    }
    if (generated.size === 0) throw new Error('回放生成阶段模型两次都没有产出可解析的分段回复');

    const pairs = [];
    for (let index = 0; index < items.length; index += 1) {
      const text = generated.get(index + 1);
      if (text === undefined || text.length === 0) continue;
      pairs.push({
        context: items[index].context,
        actual: items[index].actual,
        generated: text,
        order: decideOrder(index),
      });
    }
    if (pairs.length === 0) throw new Error('模型没有产出任何候选回复');
    const judge = buildJudgePrompt({ pairs, language: config.language });
    let choices = parseChoices(await callModel(session, judge.system, judge.user, { stage: '回放盲判' }));
    if (choices.size === 0) {
      const retrySystem = [
        '【只输出 JSON】上一次输出不是可解析的 JSON。这次只输出 {"choices":[{"n":1,"pick":"first"}]} 这样的对象。',
        '',
        judge.system,
      ].join('\n');
      choices = parseChoices(await callModel(session, retrySystem, judge.user, { stage: '回放盲判(重试)' }));
    }
    const score = scoreReplay({ pairs, choices, strength });
    score.identityId = identityId;
    score.calls = 2;
    await store.writeReplay(identityId, score);
    return score;
  }

  // ── 事件 ─────────────────────────────────────────────────────────────
  ctx.on('session/created', (session) => primeSession(session));
  ctx.on('session/event', (session) => primeSession(session));

  // ── 系统提示词注入 ────────────────────────────────────────────────────
  if (config.injectOrder > 0) {
    ctx.inject(['systemPrompt'], (scope) => {
      const systemPrompt = scope.get('systemPrompt');
      scope.effect(() => systemPrompt.section({
        name: 'conversation-identity',
        order: config.injectOrder,
        text: (assemblyContext) => {
          try {
            const session = assemblyContext?.agent?.session;
            if (session === undefined || typeof session.id !== 'string') return '';
            const binding = bindings.get(session.id);
            if (binding === undefined || binding === null) return '';
            const record = identities.get(binding.identityId);
            if (record === undefined) return '';
            const strength = STRENGTHS.includes(binding.strength) ? binding.strength : config.defaultStrength;
            const card = binding.anchors === false ? { ...record.card, anchors: [] } : record.card;
            return renderIdentity(card, {
              strength,
              maxChars: config.maxCharsByStrength[strength],
              memory: binding.memory === true ? record.memory : [],
              anchorsMax: config.anchorsMax,
              memoryMax: config.memoryMaxEntries,
              allowEmotion: config.allowEmotion,
              transcriptTurns: Number(record.meta?.sources?.[0]?.turns) || 0,
            });
          } catch (error) {
            log(`渲染身份提示词失败：${errorMessage(error)}`);
            return '';
          }
        },
      }), 'conversation-identity: system prompt section');
    });
  }

  // ── 工具 ─────────────────────────────────────────────────────────────
  const OBJECT_OUTPUT = { type: 'object', additionalProperties: true };
  const textOut = (text) => [{ type: 'text', text }];

  function strengthLine(strength) {
    return `${strength}（${STRENGTH_LABEL[strength] ?? strength}）`;
  }

  function renderImport(value) {
    if (value?.ok !== true) {
      const lines = [`导入没有完成：${value?.error ?? '未知原因'}`];
      if (Array.isArray(value?.names) && value.names.length > 0) lines.push(`识别到的名字：${value.names.join(' / ')}`);
      if (Array.isArray(value?.samples) && value.samples.length > 0) {
        lines.push('', '样本：');
        for (const sample of value.samples) lines.push(`- [${sample.speaker}] ${sample.text}`);
      }
      if (typeof value?.hint === 'string') lines.push('', value.hint);
      return textOut(lines.join('\n'));
    }
    if (value.dryRun === true) {
      const lines = [
        '## 预估（还没花钱）',
        `- 格式：${value.format}；置信度：${value.confidence}`,
        `- 轮次：${value.turns?.total} 轮（我 ${value.turns?.me} / 他 ${value.turns?.them}）`,
        `- 调用次数：${value.estimate?.calls} 次（${value.estimate?.chunks} 块${value.estimate?.sampled ? '，超长已抽样' : ''}）`,
        `- 提炼用训练轮次：${value.estimate?.trainTurns}（留出 ${value.turns?.total - value.estimate?.trainTurns} 轮做回放测试，模型看不到）`,
      ];
      for (const note of value.notes ?? []) lines.push(`- 注意：${note}`);
      if (typeof value.hint === 'string') lines.push('', value.hint);
      return textOut(lines.join('\n'));
    }
    const lines = [
      `## 身份已建立：${value.name}（${value.identityId}）`,
      `- 强度：${strengthLine(value.strength)}；格式：${value.format}；置信度：${value.confidence}`,
      `- 轮次：${value.turns?.total} 轮（我 ${value.turns?.me} / 他 ${value.turns?.them}）；留出 ${value.heldOut} 轮做回放`,
      `- 原文锚点：${value.anchors} 条；记忆：新增 ${value.memory?.added} 条（共 ${value.memory?.total} 条）`,
      `- 本次调用：${value.calls} 次${value.sampled ? '（记录超长，已抽样）' : ''}`,
    ];
    for (const note of value.notes ?? []) lines.push(`- 注意：${note}`);
    if (typeof value.hint === 'string') lines.push('', value.hint);
    return textOut(lines.join('\n'));
  }

  function renderList(items, binding) {
    const lines = ['## 已导入的身份'];
    if (items.length === 0) lines.push('（还没有。用 identity_import 导入一段聊天记录。）');
    for (const meta of items) {
      const marks = [];
      if (binding?.identityId === meta.identityId) marks.push('当前会话已绑定');
      if (meta.sampled) marks.push('抽样卡');
      lines.push(`- ${meta.name || '(未命名)'} · ${meta.identityId} · 第 ${meta.generation ?? 1} 代 · ${meta.sources?.[0]?.turns ?? '?'} 轮${marks.length > 0 ? ` · ${marks.join('，')}` : ''}`);
    }
    if (binding !== undefined && binding !== null) {
      lines.push('', `当前会话：${binding.identityId} · ${strengthLine(binding.strength)} · 记忆${binding.memory ? '带' : '不带'} · 锚点${binding.anchors ? '带' : '不带'}`);
    }
    lines.push('', '用法：identity_use({"identityId":"…","strength":"tone|portrait|standin"}) · identity_use({"identityId":"off"}) 解绑');
    return textOut(lines.join('\n'));
  }

  ctx.inject(['tools'], (scope) => {
    const tools = scope.get('tools');

    scope.effect(() => tools.register({
      name: 'identity_import',
      description: [
        '导入一段聊天记录，把「聊天的对面」重建成一个可注入的身份（语气/节奏/思维/相处方式 + 原文锚点）。',
        '支持：ChatGPT/Claude 导出 JSON、DeepSeek 网页版导出、通用 {role,content} JSON、JSONL、微信导出的 CSV/TSV、带「名字:」标记的纯文本。',
        '长记录会分块提炼（预估调用次数见 dryRun）。说话人认不出时会返回样本让你确认，不会瞎猜。',
        '★ 返回值里若带 questions 数组，请用 ask_user_question 把**所有问题一次性**抛给用户，不要一个一个问。',
        '★ name 可以不传（默认用文件名）；只有「记录里出现两个自定义名字」时才必须问 counterpart。',
        '先用 dryRun:true 看预估，再正式导入（正式导入会真的调用模型）。',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: '聊天记录文件的路径（与 text 二选一）。' },
          text: { type: 'string', description: '直接粘贴的聊天记录内容（与 path 二选一）。' },
          format: { type: 'string', enum: ['auto', 'deepseek-json', 'chatgpt-json', 'claude-json', 'generic-json', 'jsonl', 'csv', 'labeled-text'], description: '默认 auto 自动判定。csv = 微信导出工具常见格式（表头含 sender/内容 列）。' },
          counterpart: { type: 'string', description: '要重建的那个人的名字/称呼——纯文本记录认不出谁是谁时必填。' },
          name: { type: 'string', description: '给这个身份起的名字（默认用对面在记录里的名字）。' },
          strength: { type: 'string', enum: ['tone', 'portrait', 'standin'], description: '默认强度档；tone=底色，portrait=画像，standin=替身。' },
          memory: { type: 'boolean', description: '是否顺带提炼「这段关系的记忆」，默认按插件配置。' },
          dryRun: { type: 'boolean', description: '只做归一化与预算，不调用模型、不落盘。' },
          bind: { type: 'boolean', description: '是否立刻绑定到当前会话，默认 true。' },
        },
      },
      output: {
        schema: OBJECT_OUTPUT,
        render: (_args, value) => renderImport(value ?? {}),
      },
      async execute(args, exec) {
        const session = exec?.agent?.session;
        if (session === undefined) throw new Error('当前调用没有关联会话（提炼需要会话的模型路由）');
        return importIdentity(session, args ?? {});
      },
    }), 'conversation-identity: identity_import');

    scope.effect(() => tools.register({
      name: 'identity_list',
      description: '列出已导入的身份，以及当前会话绑定了哪个、什么强度档。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: OBJECT_OUTPUT, render: (_args, value) => renderList(value?.identities ?? [], value?.binding) },
      async execute(_args, exec) {
        const session = exec?.agent?.session;
        if (session !== undefined) primeSession(session);
        const items = await store.list();
        const binding = session === undefined ? undefined : (bindings.get(session.id) ?? await store.readBinding(session.id));
        return { identities: items, binding: binding ?? null };
      },
    }), 'conversation-identity: identity_list');

    scope.effect(() => tools.register({
      name: 'identity_use',
      description: '把某个身份绑定到当前会话（或换强度档/开关记忆与锚点）；identityId 传 "off" 解绑。改档立即生效，不重新提炼、不花钱。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          identityId: { type: 'string', description: '身份 id；传 "off" 解绑当前会话。' },
          strength: { type: 'string', enum: ['tone', 'portrait', 'standin'], description: '强度档。' },
          memory: { type: 'boolean', description: '是否注入这段关系的记忆。' },
          anchors: { type: 'boolean', description: '是否注入原文锚点（替身档才有）。' },
        },
      },
      output: {
        schema: OBJECT_OUTPUT,
        render: (_args, value) => textOut(value?.ok === true
          ? `当前会话：${value.binding === null ? '已解绑身份' : `${value.binding.identityId} · ${strengthLine(value.binding.strength)} · 记忆${value.binding.memory ? '带' : '不带'} · 锚点${value.binding.anchors ? '带' : '不带'}`}`
          : `操作失败：${value?.error ?? '未知原因'}`),
      },
      async execute(args, exec) {
        const session = exec?.agent?.session;
        if (session === undefined) throw new Error('当前调用没有关联会话');
        try {
          if (String(args?.identityId ?? '').toLowerCase() === 'off') {
            await store.writeBinding(session.id, { identityId: null });
            bindings.set(session.id, null);
            return { ok: true, binding: null };
          }
          if (typeof args?.identityId !== 'string' || args.identityId.length === 0) {
            return { ok: false, error: 'identityId 必填（或传 "off" 解绑）' };
          }
          const record = await store.load(args.identityId);
          const binding = await store.writeBinding(session.id, {
            identityId: args.identityId,
            strength: STRENGTHS.includes(args?.strength) ? args.strength : (record.meta.strength ?? config.defaultStrength),
            memory: typeof args?.memory === 'boolean' ? args.memory : undefined,
            anchors: typeof args?.anchors === 'boolean' ? args.anchors : undefined,
          });
          await primeIdentity(args.identityId);
          bindings.set(session.id, binding ?? null);
          return { ok: true, binding: binding ?? null };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
    }), 'conversation-identity: identity_use');

    scope.effect(() => tools.register({
      name: 'identity_show',
      description: '看一张身份卡的完整内容（字段 + 原文锚点 + 记忆 + 上次回放结果），核对「像不像」用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['identityId'],
        properties: { identityId: { type: 'string', description: '身份 id。' } },
      },
      output: { schema: OBJECT_OUTPUT, render: (_args, value) => textOut(String(value?.markdown ?? '（没有内容）')) },
      async execute(args) {
        const record = await store.load(args.identityId);
        const replay = await store.readReplay(args.identityId);
        return {
          markdown: renderCardMarkdown(record.card, { meta: record.meta, memory: record.memory, replay }),
          card: record.card,
          meta: record.meta,
        };
      },
    }), 'conversation-identity: identity_show');

    scope.effect(() => tools.register({
      name: 'identity_replay',
      description: [
        '回放测试：拿留出集（提炼时模型没看过的最后若干轮）做盲判——把「真实原句」和「模仿生成」混排，',
        '让裁判指认哪个是真的。猜不出来才叫像。通过线：tone ≥45%、portrait ≥60%、standin ≥70%。',
        '固定 2 次模型调用（一次生成全部样本、一次盲判），不受样本数影响。',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['identityId'],
        properties: {
          identityId: { type: 'string', description: '身份 id。' },
          strength: { type: 'string', enum: ['tone', 'portrait', 'standin'], description: '测哪一档，默认按身份当前的档。' },
          samples: { type: 'number', description: '样本数，默认 8，最多 12。' },
        },
      },
      output: {
        schema: OBJECT_OUTPUT,
        render: (_args, value) => {
          if (value?.ok !== true) return textOut(`回放失败：${value?.error ?? '未知原因'}`);
          const score = value.score ?? {};
          const lines = [
            `## 回放结果（${strengthLine(score.strength ?? 'portrait')}）`,
            `- 盲判骗过率：${((score.fooledRate ?? 0) * 100).toFixed(0)}%（${score.fooled} / ${score.judged} 组）`,
            `- 通过线：${((score.threshold ?? 0) * 100).toFixed(0)}% → ${score.passed ? '**通过**' : '**未通过**'}`,
            `- 平均长度比：${(score.lengthRatio ?? 0).toFixed(2)}（1.0 = 和真实一样长）`,
          ];
          if (score.passed !== true) lines.push('', '没过线说明卡的信息不够，回去补锚点/换更强的档，而不是调措辞糊弄。');
          const details = Array.isArray(score.details) ? score.details.slice(0, 6) : [];
          if (details.length > 0) {
            lines.push('', '### 明细');
            for (const item of details) {
              lines.push(`${item.fooled ? '×' : '✓'} 真实 ${item.actualLength} 字 / 生成 ${item.generatedLength} 字`);
              lines.push(`  真实：${item.actual}`);
              lines.push(`  生成：${item.generated}`);
            }
          }
          return textOut(lines.join('\n'));
        },
      },
      async execute(args, exec) {
        const session = exec?.agent?.session;
        if (session === undefined) throw new Error('当前调用没有关联会话');
        try {
          const score = await runReplay(session, args ?? {});
          return { ok: true, score };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
    }), 'conversation-identity: identity_replay');

    scope.effect(() => tools.register({
      name: 'identity_reanchor',
      description: [
        '从已保存的转录里，本地补齐/刷新一张身份卡的「原文锚点」与「口头禅」（零模型调用、免费）。',
        '适用：卡建好了但 anchors / catchphrases 是空的（提炼模型把非必填项省掉了）。',
        '锚点是从转录原样摘的，必然通过逐字校验；口头禅按「出现在多少条发言里」排，不按总次数。',
        '改完立即生效（重建内存缓存），不用重新导入、不用重启。',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['identityId'],
        properties: {
          identityId: { type: 'string', description: '身份 id。' },
          limit: { type: 'number', description: '最多补几条锚点，默认 8，上限 12。' },
        },
      },
      output: {
        schema: OBJECT_OUTPUT,
        render: (_args, value) => textOut(value?.ok === true
          ? `已补齐：锚点 +${value.addedAnchors}（共 ${value.anchors}），口头禅 ${value.catchphrases} 条。\n\n${value.markdown ?? ''}`
          : `补齐失败：${value?.error ?? '未知原因'}`),
      },
      async execute(args) {
        const id = typeof args?.identityId === 'string' ? args.identityId.trim() : '';
        if (id.length === 0) return { ok: false, error: 'identityId 必填' };
        try {
          const record = await store.load(id);
          const turns = await store.readTranscript(id);
          const limit = Math.min(12, Math.max(1, Math.trunc(Number(args?.limit ?? 8)) || 8));
          const result = refreshCardEvidence(record.card, turns, { limit, sourceId: record.meta.sources?.[0]?.id ?? '' });
          result.card = applyMetricsToCard(result.card, measureStyle(turns));
          // 回填行号，方便回溯原文位置。
          const haystack = turns.map((turn) => String(turn.text ?? '').replace(/\s+/g, ''));
          result.card.anchors = result.card.anchors.map((anchor) => {
            if (Number(anchor?.line) > 0) return anchor;
            const needle = String(anchor.quote ?? '').replace(/\s+/g, '');
            const index = haystack.findIndex((text) => text.includes(needle));
            return { ...anchor, line: index >= 0 ? index + 1 : 0 };
          });
          const markdown = renderCardMarkdown(result.card, { meta: record.meta, memory: record.memory });
          await store.writeCard(id, result.card, { markdown });
          identities.delete(id);
          await primeIdentity(id);
          return { ok: true, identityId: id, addedAnchors: result.addedAnchors, anchors: result.card.anchors.length, catchphrases: result.catchphrases, markdown };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
    }), 'conversation-identity: identity_reanchor');

    scope.effect(() => tools.register({
      name: 'identity_recall',
      description: [
        '在「绑定身份」的原文记录里按关键词检索他/你说过的话（零成本，读本地转录）。',
        '当用户提到某个具体项目、型号、路径、结论，而注入的身份段里没写清楚时，先查原文再回答——',
        '宁可查，不要凭印象编。返回命中的原句与上下文，可以直接引用。',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: '关键词，空格分隔多个（中文/英文均可），例如「折叠琴 价位」「破甲 理论」。' },
          identityId: { type: 'string', description: '不填则用当前会话绑定的身份。' },
          limit: { type: 'number', description: '返回几段，默认 6，上限 20。' },
        },
      },
      output: { schema: OBJECT_OUTPUT, render: (_args, value) => textOut(String(value?.text ?? '（没有结果）')) },
      async execute(args, exec) {
        const session = exec?.agent?.session;
        const explicit = typeof args?.identityId === 'string' ? args.identityId.trim() : '';
        let identityId = explicit;
        if (identityId.length === 0) {
          const binding = session === undefined
            ? undefined
            : (bindings.get(session.id) ?? await store.readBinding(session.id));
          identityId = typeof binding?.identityId === 'string' ? binding.identityId : '';
        }
        if (identityId.length === 0) {
          return { ok: false, text: '当前会话没有绑定身份，也没有指定 identityId——先在「身份」里选一个，或用 identity_use 绑定。' };
        }
        const record = await store.load(identityId).catch(() => undefined);
        if (record === undefined) return { ok: false, text: `身份 ${identityId} 不存在。` };
        let turns = transcripts.get(identityId);
        if (turns === undefined) {
          turns = await store.readTranscript(identityId);
          transcripts.set(identityId, turns);
        }
        const limit = Math.min(20, Math.max(1, Math.trunc(Number(args?.limit ?? 6)) || 6));
        const results = searchTranscript(turns, args?.query, { limit, context: 1 });
        return {
          ok: true,
          identityId,
          results: results.map((item) => ({ line: item.match.line, speaker: item.match.speaker, hits: item.hits, text: item.match.text.slice(0, 600) })),
          text: renderRecall({
            identityName: record.card?.name || identityId,
            query: String(args?.query ?? ''),
            results,
            totalTurns: turns.length,
          }),
        };
      },
    }), 'conversation-identity: identity_recall');

    scope.effect(() => tools.register({
      name: 'identity_forget',
      description: '删除一个身份（卡、记忆、转录、回放结果一起删）。绑定它的会话会自动失效。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['identityId'],
        properties: { identityId: { type: 'string', description: '身份 id。' } },
      },
      output: { schema: OBJECT_OUTPUT, render: (_args, value) => textOut(value?.ok === true ? `已删除身份 ${value.identityId}` : `删除失败：${value?.error ?? '未知原因'}`) },
      async execute(args) {
        try {
          await store.remove(args.identityId);
          identities.delete(args.identityId);
          transcripts.delete(args.identityId);
          return { ok: true, identityId: args.identityId };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
    }), 'conversation-identity: identity_forget');
  });

  // ── /identity 命令 ────────────────────────────────────────────────────
  ctx.inject(['commands'], (scope) => {
    const commands = scope.get('commands');
    scope.effect(() => commands.register({
      definitionId: 'conversation-identity',
      name: 'identity',
      description: '身份延续：/identity（状态）· + <文件> 导入聊天记录生成角色卡 · list · use <id> [tier] · off · show · reanchor · replay · forget',
      input: { hint: '+ <文件|附件> [--yes] | list | use <id> [tier] | off | yes | show | reanchor | replay | forget', attachments: true },
      handler: async (invocation) => {
        const session = invocation?.agent?.session;
        if (session === undefined) return { kind: 'error', text: '命令没有关联会话。' };
        const raw = String(invocation?.rawInput ?? '').trim();
        const [verbRaw, ...rest] = raw.split(/\s+/);
        const verb = (verbRaw ?? '').toLowerCase();
        const arg = rest[0] ?? '';
        try {
          if (verb === 'yes' || verb === 'y' || verb === 'ok' || verb === '确认' || verb === '跑') {
            const pending = pendingImports.get(session.id);
            if (pending === undefined || Date.now() - pending.at > PENDING_TTL_MS) {
              pendingImports.delete(session.id);
              return { kind: 'error', text: '没有待确认的导入（或已超过 10 分钟）。先重跑一次预估：/identity + <文件>' };
            }
            pendingImports.delete(session.id);
            try {
              const result = await importIdentity(session, { ...pending.args, dryRun: false });
              return { kind: result?.ok === true ? 'success' : 'error', text: renderImport(result).map((block) => block.text).join('\n') };
            } catch (error) {
              return { kind: 'error', text: `导入失败：${errorMessage(error)}` };
            }
          }
          if (verb === '+' || verb === 'import' || verb === '导入') {
            const parsed = parseImportArgs(raw);
            if (parsed.error !== undefined) return { kind: 'error', text: `${parsed.error}\n\n${IDENTITY_USAGE}` };
            const now = Date.now();
            let wizard = wizards.get(session.id);
            if (wizard !== undefined && now - wizard.at > WIZARD_TTL_MS) {
              wizards.delete(session.id);
              wizard = undefined;
            }
            const answer = parsed.path;
            const flags = pickImportFlags(parsed.options);

            // 第一次 `+`：确定记录来源，免费探一次预算，决定要不要先问「对面是谁」。
            if (wizard === undefined) {
              let source;
              try {
                source = answer.length > 0 ? { path: answer } : await readAttachmentSource(invocation);
              } catch (error) {
                return { kind: 'error', text: `读取记录失败：${errorMessage(error)}` };
              }
              if (source === undefined || source === null) {
                return {
                  kind: 'success',
                  text: '把聊天记录**拖进输入框**，再回一句 `/identity +`；或者直接跟路径：\n`/identity + "D:/记录/微信.csv"`',
                };
              }
              let probe;
              try {
                probe = await importIdentity(session, { ...source, ...flags, dryRun: true });
              } catch (error) {
                return { kind: 'error', text: `读不出这份记录：${errorMessage(error)}` };
              }
              if (probe?.ok !== true && probe?.needs !== 'speaker') {
                return { kind: 'error', text: renderImport(probe).map((block) => block.text).join('\n') };
              }
              // 一行写全就直接跑：`/identity + <记录> <对面名字> <卡名字>`
              const positional = Array.isArray(parsed.positionals) ? parsed.positionals : [];
              const needsCounterpart = probe?.ok !== true;
              const givenCounterpart = (flags.counterpart ?? '').length > 0
                ? flags.counterpart
                : (needsCounterpart ? (positional[1] ?? '') : '');
              const givenName = (flags.name ?? '').length > 0
                ? flags.name
                : (needsCounterpart ? (positional[2] ?? '') : (positional[1] ?? ''));
              wizard = {
                step: needsCounterpart && givenCounterpart.length === 0
                  ? 'counterpart'
                  : (givenName.length > 0 ? 'ready' : 'name'),
                source,
                options: {
                  ...flags,
                  counterpart: givenCounterpart.length > 0 ? givenCounterpart : undefined,
                  name: givenName.length > 0 ? givenName : undefined,
                },
                at: now,
                names: Array.isArray(probe?.names) ? probe.names : [],
                defaultCounterpart: Array.isArray(probe?.names) && probe.names.length > 0 ? probe.names[0] : '',
                defaultName: probe?.suggestedName ?? '',
              };
              if (wizard.step !== 'ready') {
                wizards.set(session.id, wizard);
                return { kind: 'success', text: importStepPrompt(wizard) };
              }
            }

            // 之后每个 `+`：填这一步（不填就取默认）并进入下一步；最后一步跑导入。
            if (wizard.step === 'counterpart') {
              wizard.options.counterpart = answer.length > 0 ? answer : wizard.defaultCounterpart;
              wizard.step = 'name';
              wizard.at = now;
              try {
                const probe = await importIdentity(session, { ...wizard.source, ...wizard.options, dryRun: true });
                if (probe?.ok === true) wizard.defaultName = probe.suggestedName ?? '';
              } catch {
                // 探价失败不影响继续，正式跑时还会再算一次。
              }
              wizards.set(session.id, wizard);
              return { kind: 'success', text: importStepPrompt(wizard) };
            }
            if (wizard.step === 'name') {
              if (answer.length > 0) wizard.options.name = answer;
              else if (wizard.options.name === undefined && typeof wizard.defaultName === 'string' && wizard.defaultName.length > 0) wizard.options.name = wizard.defaultName;
              wizard.step = 'ready';
            }
            const importArgs = { ...wizard.source, ...wizard.options };
            wizards.delete(session.id);
            try {
              // 先算预算（免费）。短记录直接一路跑完——两段确认对普通用户太啰嗦；
              // 只有超过 autoRunMaxCalls（默认 6 次）的长记录才停下来问一句。
              const estimate = await importIdentity(session, { ...importArgs, dryRun: true });
              if (estimate?.ok !== true) {
                return { kind: 'error', text: renderImport(estimate).map((block) => block.text).join('\n') };
              }
              const calls = Number(estimate.estimate?.calls ?? 0);
              const autoRun = parsed.options.yes === true
                || (config.autoRunMaxCalls > 0 && calls > 0 && calls <= config.autoRunMaxCalls);
              if (!autoRun) {
                pendingImports.set(session.id, { at: Date.now(), args: importArgs });
                return {
                  kind: 'success',
                  text: [
                    renderImport(estimate).map((block) => block.text).join('\n'),
                    '',
                    `这次要 **${calls} 次**模型调用，超过自动开跑上限（${config.autoRunMaxCalls} 次）。`,
                    '确认执行回一句：`/identity yes`（10 分钟内有效）；想一步到底下次加 `--yes`。',
                  ].join('\n'),
                };
              }
              const result = await importIdentity(session, { ...importArgs, dryRun: false });
              const text = renderImport(result).map((block) => block.text).join('\n');
              return {
                kind: result?.ok === true ? 'success' : 'error',
                text: result?.ok === true ? `${text}\n\n**已绑定到本会话，直接接着聊就行。**` : text,
              };
            } catch (error) {
              return { kind: 'error', text: `导入失败：${errorMessage(error)}` };
            }
          }
          if (verb === 'cancel' || verb === '取消') {
            wizards.delete(session.id);
            pendingImports.delete(session.id);
            return { kind: 'success', text: '已退出导入向导（未开始任何调用）。' };
          }
          if (verb === 'help' || verb === '帮助' || verb === '?') {
            return { kind: 'success', text: IDENTITY_USAGE };
          }
          if (verb === 'list' || verb === '列表') {
            const items = await store.list();
            const binding = await store.readBinding(session.id);
            const lines = ['## 已导入的身份'];
            if (items.length === 0) lines.push('（还没有。用 identity_import 导入一段聊天记录。）');
            for (const meta of items) {
              lines.push(`- ${meta.name || '(未命名)'} · ${meta.identityId} · 第 ${meta.generation ?? 1} 代 · ${meta.sources?.[0]?.turns ?? '?'} 轮`);
            }
            if (binding !== undefined) lines.push('', `当前会话：${binding.identityId} · ${binding.strength}`);
            return { kind: 'success', text: lines.join('\n') };
          }
          if (verb === 'off') {
            await store.writeBinding(session.id, { identityId: null });
            bindings.set(session.id, null);
            return { kind: 'success', text: '已解绑当前会话的身份（卡本身保留）。' };
          }
          if (verb === 'use') {
            if (arg.length === 0) return { kind: 'error', text: '用法：/identity use <id> [tone|portrait|standin]' };
            const tier = STRENGTHS.includes(rest[1]) ? rest[1] : undefined;
            const record = await store.load(arg);
            const binding = await store.writeBinding(session.id, {
              identityId: arg,
              strength: tier ?? record.meta.strength ?? config.defaultStrength,
            });
            await primeIdentity(arg);
            bindings.set(session.id, binding ?? null);
            return { kind: 'success', text: `已绑定 ${arg}（${strengthLine(binding.strength)}）。` };
          }
          if (verb === 'show') {
            if (arg.length === 0) return { kind: 'error', text: '用法：/identity show <id>' };
            const record = await store.load(arg);
            const replay = await store.readReplay(arg);
            return { kind: 'success', text: renderCardMarkdown(record.card, { meta: record.meta, memory: record.memory, replay }) };
          }
          if (verb === 'replay') {
            if (arg.length === 0) return { kind: 'error', text: '用法：/identity replay <id> [samples]' };
            const score = await runReplay(session, { identityId: arg, samples: rest[1] });
            return {
              kind: 'success',
              text: `盲判骗过率 ${(score.fooledRate * 100).toFixed(0)}%（${score.fooled}/${score.judged}），通过线 ${(score.threshold * 100).toFixed(0)}% → ${score.passed ? '通过' : '未通过'}；长度比 ${score.lengthRatio.toFixed(2)}`,
            };
          }
          if (verb === 'reanchor') {
            if (arg.length === 0) return { kind: 'error', text: '用法：/identity reanchor <id>' };
            const record = await store.load(arg);
            const turns = await store.readTranscript(arg);
            const result = refreshCardEvidence(record.card, turns, { sourceId: record.meta.sources?.[0]?.id ?? '' });
            result.card = applyMetricsToCard(result.card, measureStyle(turns));
            await store.writeCard(arg, result.card, { markdown: renderCardMarkdown(result.card, { meta: record.meta, memory: record.memory }) });
            identities.delete(arg);
            await primeIdentity(arg);
            return { kind: 'success', text: `已补齐：锚点 +${result.addedAnchors}（共 ${result.card.anchors.length}），口头禅 ${result.catchphrases} 条。` };
          }
          if (verb === 'forget') {
            if (arg.length === 0) return { kind: 'error', text: '用法：/identity forget <id>' };
            await store.remove(arg);
            identities.delete(arg);
            return { kind: 'success', text: `已删除身份 ${arg}。` };
          }
          if (raw.length > 0) {
            return { kind: 'error', text: IDENTITY_USAGE };
          }
          const binding = await store.readBinding(session.id);
          const lines = [
            '## 对话身份延续',
            `- 已导入身份：${(await store.list()).length} 个`,
            `- 本会话绑定：${binding === undefined ? '无（新建会话时在「身份」里选，或 /identity use <id>）' : `${binding.identityId} · ${strengthLine(binding.strength)}`}`,
            `- 存储目录：${rootDir}`,
            `- 强度档：${STRENGTHS.map((tier) => `${tier}（${STRENGTH_LABEL[tier]}，通过线 ${(REPLAY_THRESHOLD[tier] * 100).toFixed(0)}%）`).join(' · ')}`,
            '',
            '可用：/identity + <文件>（导入生成角色卡）· list · use · off · show · reanchor · replay · forget',
          ];
          return { kind: 'success', text: lines.join('\n') };
        } catch (error) {
          return { kind: 'error', text: `身份命令失败：${errorMessage(error)}` };
        }
      },
    }), 'conversation-identity: /identity command');
  });

  // ── HTTP 路由（新建会话那一行的身份选择器）────────────────────────────
  async function statePayload(sessionId) {
    const items = await store.list();
    const binding = sessionId.length > 0 ? await store.readBinding(sessionId) : undefined;
    return {
      ok: true,
      strengths: STRENGTHS.map((tier) => ({ id: tier, label: STRENGTH_LABEL[tier], threshold: REPLAY_THRESHOLD[tier] })),
      identities: items.map((meta) => ({
        identityId: meta.identityId,
        name: meta.name ?? '',
        generation: meta.generation ?? 1,
        turns: meta.sources?.[0]?.turns ?? 0,
        sampled: meta.sampled === true,
        strength: meta.strength ?? config.defaultStrength,
        updatedAt: meta.updatedAt ?? '',
      })),
      binding: binding ?? null,
    };
  }

  async function handleStateRoute(req, res) {
    const url = new URL(req?.url ?? `${ROUTE_PREFIX}/state`, 'http://127.0.0.1');
    const method = req?.method ?? 'GET';
    if (method === 'GET') {
      const sessionId = (url.searchParams.get('sessionId') ?? '').trim();
      const payload = await statePayload(sessionId);
      // 顺手把绑定塞进缓存，省下一次请求的预热。
      if (sessionId.length > 0) {
        if (payload.binding !== null) await primeIdentity(payload.binding.identityId);
        bindings.set(sessionId, payload.binding);
      }
      sendJson(res, 200, payload);
      return;
    }
    if (method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: `invalid JSON body: ${errorMessage(error)}` });
        return;
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
      if (sessionId.length === 0) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' });
        return;
      }
      try {
        const unbind = body?.identityId === null || body?.identityId === 'off';
        if (unbind) {
          await store.writeBinding(sessionId, { identityId: null });
          bindings.set(sessionId, null);
        } else {
          if (typeof body?.identityId !== 'string' || body.identityId.length === 0) {
            sendJson(res, 400, { ok: false, error: 'identityId is required (or null to unbind)' });
            return;
          }
          const binding = await store.writeBinding(sessionId, {
            identityId: body.identityId,
            strength: STRENGTHS.includes(body?.strength) ? body.strength : undefined,
            memory: typeof body?.memory === 'boolean' ? body.memory : undefined,
            anchors: typeof body?.anchors === 'boolean' ? body.anchors : undefined,
          });
          await primeIdentity(body.identityId);
          bindings.set(sessionId, binding ?? null);
        }
        sendJson(res, 200, await statePayload(sessionId));
      } catch (error) {
        sendJson(res, 500, { ok: false, error: errorMessage(error) });
      }
      return;
    }
    sendJson(res, 405, { ok: false, error: 'use GET or POST' });
  }

  /** 删掉一张角色卡：先解绑所有会话，再删目录（卡/记忆/转录/回放一起走）。 */
  async function handleDeleteRoute(req, res) {
    if ((req?.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'use POST' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `invalid JSON body: ${errorMessage(error)}` });
      return;
    }
    const identityId = typeof body?.identityId === 'string' ? body.identityId.trim() : '';
    if (identityId.length === 0) {
      sendJson(res, 400, { ok: false, error: 'identityId is required' });
      return;
    }
    try {
      const cleared = await store.clearBindingsFor(identityId);
      await store.remove(identityId);
      identities.delete(identityId);
      transcripts.delete(identityId);
      for (const [sessionId, binding] of bindings) {
        if (binding?.identityId === identityId) bindings.set(sessionId, null);
      }
      log(`已删除身份 ${identityId}（解绑 ${cleared} 个会话）`);
      sendJson(res, 200, await statePayload(typeof body?.sessionId === 'string' ? body.sessionId : ''));
    } catch (error) {
      sendJson(res, 500, { ok: false, error: errorMessage(error) });
    }
  }

  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.get('webServer');
    scope.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/state`,
      handler: async (req, res) => {
        try {
          await handleStateRoute(req, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorMessage(error) });
        }
      },
    }), 'conversation-identity: state route');

    scope.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/delete`,
      handler: async (req, res) => {
        try {
          await handleDeleteRoute(req, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorMessage(error) });
        }
      },
    }), 'conversation-identity: delete route');
  });

  log(`已加载：存储目录 ${rootDir}；注入 ${config.injectOrder > 0 ? `系统提示词（order ${config.injectOrder}）` : '关'}；默认档 ${strengthLine(config.defaultStrength)}。`);

  return {
    drain: async () => {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
    store,
    config,
    importIdentity,
    runReplay,
  };
}
