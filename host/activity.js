import { mergeChatOptions, validateFeatures } from '../shared/chat-options.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { planEnabled, providerId } from './provider.js';

const counters = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
const chatId = /^chatgpt-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function fail(message, status) {
  return json({ error: { message } }, status);
}

async function modelCatalog({ adapter, getSession, usageStore, onCatalogChange }, request, session) {
  const { profileId, accountSignal } = session;
  const params = new URL(request.url).searchParams;
  const writing = request.method === 'POST';
  const body = writing ? await request.json().catch(() => null) : undefined;
  if (writing && (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['profileId', 'model', 'enabled'].includes(key))
    || typeof body.profileId !== 'string' || typeof body.model !== 'string' || !body.model.length
    || typeof body.enabled !== 'boolean')) return fail('无效的模型显示设置。', 400);
  const expected = writing ? body.profileId : params.get('profileId');
  if (expected !== null && expected !== profileId) return fail('当前 ChatGPT 账号已更改，请刷新重试。', 409);
  const refreshing = !writing && params.get('refresh') === '1';
  const models = await adapter.listPlanModels(refreshing);
  const current = await getSession();
  request.signal?.throwIfAborted();
  accountSignal?.throwIfAborted();
  if (!planEnabled(current) || current.profileId !== profileId || current.accountSignal !== accountSignal) {
    return fail('当前账号或套餐授权已更改，请刷新重试。', 403);
  }
  if (writing) {
    if (!models.some(model => model.id === body.model)) return fail('该账号没有此套餐模型。', 400);
    usageStore.setModelEnabled(profileId, body.model, body.enabled);
    onCatalogChange();
    return json({ model: body.model, enabled: body.enabled });
  }
  const hidden = usageStore.hiddenModels(profileId);
  if (refreshing) onCatalogChange();
  return json({ models: models.map(model => ({ ...model, enabled: !hidden.has(model.id) })) });
}

async function selectChatModel(ctx, { adapter, getSession, usageStore }, request, session) {
  const input = await request.json().catch(() => null);
  const { sessionId, model, reasoningEffort } = input ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['sessionId', 'model', 'reasoningEffort'].includes(key))
    || typeof sessionId !== 'string' || !chatId.test(sessionId)
    || typeof model !== 'string' || !model.length || model.length > 128
    || (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !reasoningEffort.length || reasoningEffort.length > 64))) {
    return fail('无效的 ChatGPT 会话或模型。', 400);
  }
  const { profileId, accountSignal } = session;
  const signal = accountSignal ? AbortSignal.any([request.signal, accountSignal]) : request.signal;
  signal.throwIfAborted();
  if (usageStore.owner(sessionId) !== profileId) return fail('当前账号无法更改此 ChatGPT 会话。', 403);
  const agents = ctx.get?.('agents');
  const agent = agents?.get(sessionId);
  if (!agent) return fail('DSH 会话未打开，请重新选择会话。', 409);

  const available = (await adapter.listSelectableModels()).find(entry => entry.id === model);
  signal.throwIfAborted();
  if (!available || (reasoningEffort !== undefined && !available.reasoning?.efforts.some(effort => effort.id === reasoningEffort))) {
    return fail('当前 ChatGPT 账号不支持此模型或推理强度。', 400);
  }
  const selected = { provider: providerId, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
  await ctx.llm.resolveCallConfig(selected, signal);
  const current = await getSession();
  signal.throwIfAborted();
  if (!planEnabled(current) || current.profileId !== profileId || current.accountSignal !== accountSignal
    || usageStore.owner(sessionId) !== profileId || agents.get(sessionId) !== agent) {
    return fail('账号或会话已更改，请重新选择。', 409);
  }
  agent.model.select(selected);
  return json({ selected });
}

export function createUsageStore(directory) {
  let database;
  function db() {
    if (database) return database;
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const connection = new DatabaseSync(directory ? join(directory, 'activity.sqlite') : ':memory:');
    try {
      connection.exec(`PRAGMA busy_timeout=2000;
        CREATE TABLE IF NOT EXISTS usage (
          profile TEXT PRIMARY KEY, calls INTEGER NOT NULL, ${counters.map(k => k + ' INTEGER NOT NULL').join(', ')},
          lastModel TEXT NOT NULL, lastAt INTEGER NOT NULL, lastTotal INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_usage (
          profile TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL, totalTokens INTEGER NOT NULL,
          PRIMARY KEY (profile, model)
        );
        CREATE TABLE IF NOT EXISTS hidden_models (profile TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY (profile, model));
        CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, profile TEXT NOT NULL, created INTEGER NOT NULL);`);
      connection.exec(`CREATE TABLE IF NOT EXISTS chat_options (
        id TEXT PRIMARY KEY REFERENCES chats(id), webSearch INTEGER NOT NULL, jsonSchema TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS native_chat_options (
          id TEXT NOT NULL, profile TEXT NOT NULL, webSearch INTEGER NOT NULL, jsonSchema TEXT NOT NULL,
          PRIMARY KEY (id, profile))`);
    } catch (error) { connection.close(); throw error; }
    database = connection;
    return database;
  }
  return {
    hiddenModels(profileId) {
      const rows = db().prepare('SELECT model FROM hidden_models WHERE profile=?').all(profileId);
      return new Set(rows.map(row => row.model));
    },
    setModelEnabled(profileId, model, enabled) {
      const sql = enabled ? 'DELETE FROM hidden_models WHERE profile=? AND model=?'
        : 'INSERT OR IGNORE INTO hidden_models (profile, model) VALUES (?, ?)';
      db().prepare(sql).run(profileId, model);
    },
    record(profile, model, usage) {
      if (!profile) return;
      const total = usage.totalTokens ?? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      const values = { ...usage, totalTokens: total };
      const connection = db();
      connection.exec('BEGIN IMMEDIATE');
      try {
        connection.prepare(`INSERT INTO usage VALUES (?,1,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(profile) DO UPDATE SET calls=calls+1,
          ${counters.map(k => k+'='+k+'+excluded.'+k).join(', ')},
          lastModel=excluded.lastModel, lastAt=excluded.lastAt, lastTotal=excluded.lastTotal`)
          .run(profile, ...counters.map(k => values[k] ?? 0), model, Date.now(), total);
        connection.prepare(`INSERT INTO model_usage (profile,model,calls,totalTokens) VALUES (?,?,1,?)
          ON CONFLICT(profile,model) DO UPDATE SET calls=calls+1, totalTokens=totalTokens+excluded.totalTokens`)
          .run(profile, model, total);
        connection.exec('COMMIT');
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    },
    summary(profile) {
      const rows = db().prepare(`SELECT u.*, m.model, m.calls AS modelCalls, m.totalTokens AS modelTokens
        FROM usage u LEFT JOIN model_usage m ON m.profile=u.profile WHERE u.profile=?
        ORDER BY m.totalTokens DESC, m.calls DESC, m.model`).all(profile);
      const row = rows[0];
      return { calls: row?.calls ?? 0, ...Object.fromEntries(counters.map(k => [k, row?.[k] ?? 0])),
        byModel: rows.filter(entry => entry.model != null).map(entry => ({
          model: entry.model, calls: entry.modelCalls, totalTokens: entry.modelTokens,
        })),
        ...(row ? { last: { model: row.lastModel, at: row.lastAt, totalTokens: row.lastTotal } } : {}) };
    },
    owner(id) { return db().prepare('SELECT profile FROM chats WHERE id=?').get(id)?.profile; },
    chatOptions(id, profile) {
      const query = id.startsWith('chatgpt-')
        ? `SELECT o.webSearch, o.jsonSchema FROM chat_options o
          JOIN chats c ON c.id=o.id WHERE c.id=? AND c.profile=?`
        : 'SELECT webSearch, jsonSchema FROM native_chat_options WHERE id=? AND profile=?';
      const row = db().prepare(query).get(id, profile);
      return row && { webSearch: Boolean(row.webSearch), jsonSchema: row.jsonSchema };
    },
    patchChatOptions(id, profile, fallback, patch) {
      const connection = db();
      connection.exec('BEGIN IMMEDIATE');
      try {
        const legacy = id.startsWith('chatgpt-');
        if (legacy && this.owner(id) !== profile) throw new Error('Chat ownership changed');
        const settings = mergeChatOptions(this.chatOptions(id, profile) ?? fallback, patch);
        if (legacy) {
          connection.prepare(`INSERT INTO chat_options (id,webSearch,jsonSchema) VALUES (?,?,?)
            ON CONFLICT(id) DO UPDATE SET webSearch=excluded.webSearch, jsonSchema=excluded.jsonSchema`)
            .run(id, Number(settings.webSearch), settings.jsonSchema);
        } else {
          connection.prepare(`INSERT INTO native_chat_options (id,profile,webSearch,jsonSchema) VALUES (?,?,?,?)
            ON CONFLICT(id,profile) DO UPDATE SET webSearch=excluded.webSearch, jsonSchema=excluded.jsonSchema`)
            .run(id, profile, Number(settings.webSearch), settings.jsonSchema);
        }
        connection.exec('COMMIT');
        return settings;
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    },
    associate(id, profile, options) {
      const connection = db();
      connection.exec('BEGIN IMMEDIATE');
      try {
        const { changes } = connection.prepare('INSERT OR IGNORE INTO chats(id,profile,created) VALUES (?,?,?)')
          .run(id, profile, Date.now());
        if (changes && options) connection.prepare('INSERT INTO chat_options (id, webSearch, jsonSchema) VALUES (?,?,?)')
          .run(id, Number(options.webSearch), options.jsonSchema);
        const owned = this.owner(id) === profile;
        connection.exec('COMMIT');
        return owned;
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    },
    chats(profile) {
      return db().prepare('SELECT id FROM chats WHERE profile=? ORDER BY created DESC, rowid DESC').all(profile).map(r => r.id);
    },
    close() { database?.close(); database = undefined; },
  };
}

export function mountActivity(ctx, { adapter, getSession, usageStore, onCatalogChange }) {
  ctx.effect(() => () => usageStore.close(), 'ChatGPT activity');
  for (const path of ['models', 'usage', 'chats', 'chat-model', 'model-visibility']) {
    ctx.connection.fetch.register({
      path: '/api/dsh-use-chatgpt/' + path,
      methods: path === 'chats' ? ['GET','POST'] : ['chat-model', 'model-visibility'].includes(path) ? ['POST'] : ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const session = await getSession();
          session.accountSignal?.throwIfAborted();
          if (!planEnabled(session) || !session.profileId) return json({error:{message:'请先连接 ChatGPT 并授权使用套餐。'}},403);
          if (path === 'chat-model') return await selectChatModel(ctx, { adapter, getSession, usageStore }, request, session);
          const profile = session.profileId;
          if (path === 'models' || path === 'model-visibility') {
            return await modelCatalog({ adapter, getSession, usageStore, onCatalogChange }, request, session);
          }
          if (path === 'usage') return json(usageStore.summary(profile));
          if (request.method === 'POST') {
            const body = await request.json().catch(() => null);
            session.accountSignal?.throwIfAborted();
            if (body?.profileId !== profile || typeof body?.id !== 'string' || !chatId.test(body.id)) return json({ error:{message:'账号或会话已更改，请刷新重试。'} },409);
            const { id, title } = body;
            const options = body.features === undefined ? undefined : validateFeatures(body.features);
            if (title !== undefined && (typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 256)) {
              return fail('无效的 ChatGPT 会话标题。', 400);
            }
            const owner = usageStore.owner(id);
            if (owner !== undefined && owner !== profile) return fail('该会话属于另一个 ChatGPT 账号。', 409);
            const titles = title !== undefined && owner === undefined ? ctx.get?.('sessionTitle') : undefined;
            const nativeSession = titles ? ctx.get('agents')?.get(id)?.session : undefined;
            if (titles && !nativeSession) return fail('DSH 会话未打开，请重新选择会话。', 409);
            request.signal?.throwIfAborted();
            if (!usageStore.associate(id, profile, options)) return fail('该会话属于另一个 ChatGPT 账号。', 409);
            if (titles && !titles.get(nativeSession)) titles.rename(nativeSession, title);
          }
          return json({ids:usageStore.chats(profile)});
        } catch (error) {
          if (error?.code === 'invalid_features') return fail(error.message, 400);
          return json({error:{message:error?.name === 'ChatGPTError' ? error.message : '读取 ChatGPT 数据失败，请重试。'}},503);
        }
      },
    });
  }
}
