import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createUsageStore, mountActivity } from '../host/activity.js';
import { createProvider, providerId } from '../host/provider.js';

const alpha = 'profile-alpha';
const beta = 'profile-beta';
const chatA = 'chatgpt-11111111-1111-4111-8111-111111111111';
const chatB = 'chatgpt-22222222-2222-4222-8222-222222222222';
const chatC = 'chatgpt-33333333-3333-4333-8333-333333333333';
const usage = {
  inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 4, totalTokens: 23,
};

test('activity persists profile-specific totals and chat ownership across connections and reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-activity-'));
  const writer = createUsageStore(directory);
  const peer = createUsageStore(directory);
  const reopened = createUsageStore(directory);
  t.after(async () => {
    writer.close();
    peer.close();
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  });

  let time = 1000;
  t.mock.method(Date, 'now', () => time);
  assert.deepEqual(peer.summary(alpha), {
    calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0,
    byModel: [],
  });
  writer.record(alpha, 'gpt-a-first', usage);
  assert.equal(writer.associate(chatA, alpha), true);
  time += 1;
  peer.record(beta, 'gpt-b', { inputTokens: 2, outputTokens: 3 });
  assert.equal(peer.associate(chatA, beta), false);
  assert.equal(peer.associate(chatB, beta), true);
  time += 1;
  peer.record(alpha, 'gpt-a-last', { inputTokens: 5, outputTokens: 6, cacheReadTokens: 1, cacheWriteTokens: 2, reasoningTokens: 3 });
  assert.equal(writer.associate(chatC, alpha), true);
  assert.equal(peer.associate(chatA, alpha), true);
  assert.equal(peer.owner(chatA), alpha);
  writer.close();
  peer.close();

  assert.deepEqual(reopened.summary(alpha), {
    calls: 2, inputTokens: 16, outputTokens: 13, cacheReadTokens: 4, cacheWriteTokens: 4, reasoningTokens: 7, totalTokens: 37,
    byModel: [{ model: 'gpt-a-first', calls: 1, totalTokens: 23 }, { model: 'gpt-a-last', calls: 1, totalTokens: 14 }],
    last: { model: 'gpt-a-last', at: 1002, totalTokens: 14 },
  });
  assert.deepEqual(reopened.summary(beta), {
    calls: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 5,
    byModel: [{ model: 'gpt-b', calls: 1, totalTokens: 5 }],
    last: { model: 'gpt-b', at: 1001, totalTokens: 5 },
  });
  assert.deepEqual(reopened.chats(alpha), [chatC, chatA]);
  assert.deepEqual(reopened.chats(beta), [chatB]);
  assert.equal(reopened.owner(chatB), beta);
  assert.equal(reopened.owner('missing-chat'), undefined);
});

test('model usage starts with newly recorded calls and commits together with profile totals', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-legacy-activity-'));
  const legacy = new DatabaseSync(join(directory, 'activity.sqlite'));
  legacy.exec(`CREATE TABLE usage (profile TEXT PRIMARY KEY, calls INTEGER NOT NULL, inputTokens INTEGER NOT NULL,
    outputTokens INTEGER NOT NULL, cacheReadTokens INTEGER NOT NULL, cacheWriteTokens INTEGER NOT NULL,
    reasoningTokens INTEGER NOT NULL, totalTokens INTEGER NOT NULL, lastModel TEXT NOT NULL,
    lastAt INTEGER NOT NULL, lastTotal INTEGER NOT NULL);`);
  legacy.prepare('INSERT INTO usage VALUES (?,4,75,25,0,0,0,100,?,5000,20)').run(alpha, 'gpt-legacy');
  const store = createUsageStore(directory);
  t.after(async () => {
    store.close();
    legacy.close();
    await rm(directory, { recursive: true, force: true });
  });

  const old = store.summary(alpha);
  assert.deepEqual(old.byModel, []);
  assert.deepEqual(old.last, { model: 'gpt-legacy', totalTokens: 20, at: 5000 });
  assert.equal(old.totalTokens, 100);
  store.record(alpha, 'gpt-new', usage);
  store.record(alpha, 'gpt-new', usage);
  const updated = store.summary(alpha);
  assert.equal(updated.calls, 6);
  assert.equal(updated.totalTokens, 146);
  assert.deepEqual(updated.byModel, [{ model: 'gpt-new', calls: 2, totalTokens: 46 }]);
  legacy.exec(`CREATE TRIGGER fail_model_record BEFORE INSERT ON model_usage BEGIN
    SELECT RAISE(ABORT, 'synthetic write error'); END;`);
  assert.throws(() => store.record(alpha, 'gpt-new', usage), /synthetic write error/);
  assert.deepEqual(store.summary(alpha), updated);
});

test('activity routes require an active grant and cannot expose or assign a different profile', async t => {
  const store = createUsageStore();
  const routes = new Map();
  const registration = { fetch: { register(route) { routes.set(route.path.split('/').at(-1), route); } } };
  const modelEntered = Promise.withResolvers();
  const modelRelease = Promise.withResolvers();
  let modelsPaused = false;
  let modelCalls = 0;
  let account = new AbortController();
  let session = { status: 'connected', sharing: false, profileId: alpha, accountSignal: account.signal };
  let staleSnapshot;
  function select(profileId, sharing = true) {
    account.abort();
    account = new AbortController();
    session = { status: 'connected', profileId, sharing, accountSignal: account.signal };
  }

  mountActivity({ connection: registration, effect(setup) { t.after(setup()); } }, {
    async getSession() { return staleSnapshot ?? session; },
    usageStore: store,
    adapter: { async listPlanModels() {
      modelCalls += 1;
      const name = session.profileId;
      if (modelsPaused) {
        modelEntered.resolve();
        await modelRelease.promise;
      }
      return [{ id: 'synthetic', name }];
    } },
  });

  async function call(path, body) {
    const request = new Request(`http://127.0.0.1/api/dsh-use-chatgpt/${path}`, body === undefined
      ? undefined : { method: 'POST', body: JSON.stringify(body) });
    const response = await routes.get(path).fetch(request);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() };
  }

  assert.deepEqual([...routes].map(([path, route]) => [path, route.methods]), [
    ['models', ['GET']], ['usage', ['GET']], ['chats', ['GET', 'POST']], ['chat-model', ['POST']], ['model-visibility', ['POST']],
  ]);
  for (const path of routes.keys()) {
    assert.equal((await call(path)).status, 403);
  }
  assert.equal((await call('chats', { id: chatA, profileId: alpha })).status, 403);
  assert.equal(modelCalls, 0);
  assert.equal(store.owner(chatA), undefined);

  store.record(alpha, 'gpt-a', usage);
  store.record(beta, 'gpt-b', { inputTokens: 1, outputTokens: 2 });
  select(alpha);
  assert.deepEqual(await call('models'), { status: 200, body: { models: [{ id: 'synthetic', name: alpha, enabled: true }] } });
  assert.equal((await call('usage')).body.totalTokens, 23);
  assert.equal((await call('chats', { id: chatA, profileId: beta })).status, 409);
  assert.equal((await call('chats', { id: 'ordinary-dsh-chat', profileId: alpha })).status, 409);
  assert.deepEqual(await call('chats', { id: chatA, profileId: alpha }), { status: 200, body: { ids: [chatA] } });
  assert.deepEqual(await call('chats', { id: chatA, profileId: alpha }), { status: 200, body: { ids: [chatA] } });

  const bodyEntered = Promise.withResolvers();
  const bodyRelease = Promise.withResolvers();
  const oldRegistration = routes.get('chats').fetch({
    method: 'POST',
    json() { bodyEntered.resolve(); return bodyRelease.promise; },
  });
  modelsPaused = true;
  const previousModels = call('models');
  await Promise.all([bodyEntered.promise, modelEntered.promise]);

  const previous = session;
  select(beta);
  staleSnapshot = previous;
  assert.equal((await call('usage')).status, 503);
  assert.equal((await call('chats')).status, 503);
  staleSnapshot = undefined;

  assert.deepEqual(await call('chats', { id: chatB, profileId: beta }), { status: 200, body: { ids: [chatB] } });
  bodyRelease.resolve({ id: chatB, profileId: alpha });
  modelRelease.resolve();
  const [oldChatResponse, oldModelsResponse] = await Promise.all([oldRegistration, previousModels]);
  assert.equal(oldChatResponse.status, 503);
  assert.equal(oldModelsResponse.status, 503);
  assert.equal(oldModelsResponse.body.models, undefined);
  assert.equal(store.owner(chatB), beta);
  assert.equal((await call('chats', { id: chatA, profileId: beta })).status, 409);
  assert.deepEqual(await call('chats'), { status: 200, body: { ids: [chatB] } });
  assert.equal((await call('usage')).body.totalTokens, 3);
  select(alpha);
  assert.deepEqual(await call('chats'), { status: 200, body: { ids: [chatA] } });
});

test('sidebar model selection updates only the live session of the active grant', async t => {
  const store = createUsageStore();
  store.associate(chatA, alpha);
  store.associate(chatB, beta);
  const account = new AbortController();
  const pendingValidation = Promise.withResolvers();
  const validationEntered = Promise.withResolvers();
  let paused = false;
  let route;
  let catalogCalls = 0;
  const selected = [];
  const agent = { model: { select: choice => selected.push(choice) } };
  mountActivity({
    connection: { fetch: { register(spec) { if (spec.path.endsWith('/chat-model')) route = spec; } } },
    effect(setup) { t.after(setup()); },
    get(service) {
      assert.equal(service, 'agents');
      return { get: sessionId => sessionId === chatA ? agent : undefined };
    },
    llm: { async resolveCallConfig(choice, signal) {
      signal.throwIfAborted();
      assert.equal(choice.provider, providerId);
      if (paused) {
        validationEntered.resolve();
        await pendingValidation.promise;
      }
    } },
  }, {
    usageStore: store,
    async getSession() { return { status: 'connected', sharing: true, profileId: alpha, accountSignal: account.signal }; },
    adapter: { async listSelectableModels() {
      catalogCalls += 1;
      return [{ id: 'gpt-chat', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }];
    } },
  });
  const choice = { sessionId: chatA, model: 'gpt-chat', reasoningEffort: 'high' };
  function select(body) {
    return route.fetch(new Request('http://127.0.0.1' + route.path, { method: 'POST', body: JSON.stringify(body) }));
  }

  assert.equal((await select({ ...choice, sessionId: 'ordinary-dsh-session' })).status, 400);
  assert.equal((await select({ ...choice, sessionId: chatB })).status, 403);
  assert.equal(catalogCalls, 0);
  assert.equal((await select({ ...choice, model: 'not-in-catalog' })).status, 400);
  assert.equal((await select({ ...choice, reasoningEffort: 'maximum' })).status, 400);
  assert.deepEqual(selected, []);
  const result = await select(choice);
  assert.equal(result.status, 200);
  const expected = { provider: providerId, model: choice.model, reasoningEffort: choice.reasoningEffort };
  assert.deepEqual(await result.json(), { selected: expected });

  paused = true;
  const stale = select({ ...choice, reasoningEffort: 'low' });
  await validationEntered.promise;
  account.abort();
  pendingValidation.resolve();
  assert.equal((await stale).status, 503);
  assert.deepEqual(selected, [expected]);
});

test('native provider uses the owning profile for sidebar chats and records completed usage only', async t => {
  const store = createUsageStore();
  t.after(() => store.close());
  assert.equal(store.associate(chatA, alpha), true);
  let profileId = beta;
  const forwarded = [];
  const client = {
    async streamResponse({ model, input }) {
      forwarded.push({ model, input });
      return { text: 'Synthetic answer', usage: { inputTokens: 16, outputTokens: 7, cachedInputTokens: 3, cacheWriteTokens: 2, reasoningTokens: 4, totalTokens: 23 } };
    },
  };
  const adapter = createProvider(client, async () => ({ status: 'connected', sharing: true, profileId }), new AbortController().signal, {
    getChatOwner: id => store.owner(id),
    onUsage: (profile, model, counters) => store.record(profile, model, counters),
  });
  const options = {
    sessionId: chatA, provider: providerId, model: 'synthetic-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic request' }] }],
  };
  const blocked = await Array.fromAsync(adapter.stream(options));
  assert.equal(blocked.at(-1).reason.failure.code, 'profile_changed');
  assert.equal(forwarded.length, 0);
  assert.equal(store.summary(beta).calls, 0);

  profileId = alpha;
  const unknown = await Array.fromAsync(adapter.stream({ ...options, sessionId: chatC }));
  assert.equal(unknown.at(-1).reason.failure.code, 'profile_changed');
  assert.equal(forwarded.length, 0);
  const completed = await Array.fromAsync(adapter.stream(options));
  assert.deepEqual(completed.at(-1).reason, { kind: 'stop' });
  assert.equal(forwarded.length, 1);
  assert.deepEqual(completed.find(chunk => chunk.type === 'usage').usage, usage);
  assert.equal(store.summary(alpha).calls, 1);
  assert.equal(store.summary(alpha).totalTokens, 23);
  assert.equal(store.summary(beta).calls, 0);
});
