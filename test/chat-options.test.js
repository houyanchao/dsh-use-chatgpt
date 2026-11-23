import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createUsageStore } from '../host/activity.js';
import { mountChatGPT } from '../host/index.js';
import { createPreferences } from '../host/preferences.js';
import { defaultChatOptions, mergeChatOptions, validateFeatures } from '../shared/chat-options.js';
import { streamResponse } from '../host/chatgpt/responses.js';

const alpha = 'account-a';
const beta = 'account-b';
const oldChat = 'chatgpt-11111111-1111-4111-8111-111111111111';
const newChat = 'chatgpt-22222222-2222-4222-8222-222222222222';
const otherChat = 'chatgpt-33333333-3333-4333-8333-333333333333';
const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
const jsonSchema = JSON.stringify(schema);

function workspace(t, directory, services = {}) {
  const store = createUsageStore(directory);
  const preferences = createPreferences(directory);
  const routes = new Map();
  let adapter;
  let session = { profileId: alpha, status: 'connected', sharing: true };
  mountChatGPT({
    get(name) { return services[name]; },
    llm: { registerAdapter(_ids, implementation) { adapter = implementation; return { replace() {} }; } },
    connection: { fetch: { register(route) { routes.set(route.path, route); } } },
    effect(setup) { t.after(setup()); },
  }, {
    available: true, preferences, usageStore: store,
    client: {
      async getSession() { return session; },
      subscribe() { return () => {}; },
      async listProfiles() { return []; },
      async listModels() { return [{ slug: 'test-model', displayName: 'Test model', reasoningEfforts: ['low', 'high'] }]; },
      async selectProfile(profileId) { session = { ...session, profileId }; return session; },
      streamResponse(options) { return streamResponse('synthetic-test-credential', options, options.signal); },
    },
  });
  async function call(action, params, body) {
    const url = new URL('/api/dsh-use-chatgpt/' + action, 'http://localhost');
    url.search = new URLSearchParams(params);
    const request = new Request(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    const response = await routes.get(url.pathname).fetch(request);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() };
  }
  return {
    store, adapter, preferences,
    allowSharing(value) { session = { ...session, sharing: value }; },
    select(profileId) { return call('select-profile', {}, { profileId }); },
    register(id, profileId, features) { return call('chats', {}, { id, profileId, features }); },
    options(sessionId, profileId, patch) { return call('chat-options', { sessionId, profileId }, patch); },
  };
}

test('session option patches validate supplied fields and preserve the existing choices', () => {
  const starting = validateFeatures({ webSearch: false, jsonSchema: ' ' + jsonSchema + '\n' });
  assert.deepEqual(starting, { webSearch: false, jsonSchema });
  assert.deepEqual(mergeChatOptions(starting, { webSearch: true }), { webSearch: true, jsonSchema });
  assert.deepEqual(mergeChatOptions(starting, { jsonSchema: '' }), defaultChatOptions);
  for (const patch of [null, [], {}, { other: 1 }, { webSearch: 'yes' }, { jsonSchema: '{' },
    { jsonSchema: JSON.stringify({ ...schema, required: [] }) },
    { jsonSchema: JSON.stringify({ ...schema, description: '文'.repeat(24_000) }) }]) {
    assert.throws(() => mergeChatOptions(starting, patch), { code: 'invalid_features' });
  }
});

test('existing chats inherit saved defaults, new chats retain their settings across retries and reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chat-options-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldDatabase = new DatabaseSync(join(directory, 'activity.sqlite'));
  oldDatabase.exec('CREATE TABLE chats (id TEXT PRIMARY KEY, profile TEXT NOT NULL, created INTEGER NOT NULL)');
  oldDatabase.prepare('INSERT INTO chats VALUES (?, ?, ?)').run(oldChat, alpha, 1);
  oldDatabase.close();

  const ws = workspace(t, directory);
  const defaults = { webSearch: true, jsonSchema: '' };
  await ws.preferences.save(defaults);
  assert.deepEqual(await ws.options(oldChat, alpha), { status: 200, body: { features: defaults } });
  assert.equal((await ws.register(newChat, alpha, { ...defaultChatOptions, jsonSchema: '{' })).status, 400);
  assert.equal(ws.store.owner(newChat), undefined);
  assert.equal((await ws.register(newChat, alpha, defaultChatOptions)).status, 200);
  assert.deepEqual((await ws.options(newChat, alpha)).body.features, defaultChatOptions);

  const changes = await Promise.all([
    ws.options(newChat, alpha, { webSearch: true }),
    ws.options(newChat, alpha, { jsonSchema }),
  ]);
  assert.deepEqual(changes.map(change => change.status), [200, 200]);
  assert.equal((await ws.options(newChat, alpha, { jsonSchema: 'bad' })).status, 400);
  assert.equal((await ws.register(newChat, alpha, defaultChatOptions)).status, 200);
  assert.deepEqual((await ws.options(oldChat, alpha)).body.features, defaults);
  assert.deepEqual(await ws.preferences.get(), defaults);

  ws.store.close();
  const reopened = createUsageStore(directory);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.chatOptions(newChat, alpha), { webSearch: true, jsonSchema });
  assert.equal(reopened.chatOptions(newChat, beta), undefined);
});

test('chat option reads and writes require the active grant, requested profile and chat ownership', async t => {
  const ws = workspace(t);
  assert.equal((await ws.register(oldChat, alpha, defaultChatOptions)).status, 200);
  for (const [id, profile] of [[newChat, alpha], [oldChat, beta], [oldChat, '']]) {
    assert.equal((await ws.options(id, profile)).status, 403);
    assert.equal((await ws.options(id, profile, { webSearch: true })).status, 403);
  }
  ws.allowSharing(false);
  assert.equal((await ws.options(oldChat, alpha)).status, 403);
  assert.equal((await ws.options(oldChat, alpha, { webSearch: true })).status, 403);
  ws.allowSharing(true);
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const originalGet = ws.preferences.get;
  const wait = t.mock.method(ws.preferences, 'get', async () => {
    entered.resolve();
    await resume.promise;
    return defaultChatOptions;
  });
  const pending = ws.options(oldChat, alpha, { webSearch: true });
  await entered.promise;
  wait.mock.restore();
  assert.equal(ws.preferences.get, originalGet);
  assert.equal((await ws.select(beta)).status, 200);
  resume.resolve();
  assert.equal((await pending).status, 503);
  assert.equal((await ws.options(oldChat, alpha)).status, 403);
  assert.equal((await ws.options(oldChat, beta)).status, 403);
  assert.equal((await ws.register(otherChat, beta, { webSearch: false, jsonSchema })).status, 200);
  assert.deepEqual((await ws.options(otherChat, beta)).body.features, { webSearch: false, jsonSchema });
  assert.deepEqual(ws.store.chatOptions(oldChat, alpha), defaultChatOptions);
});

test('a revoked grant while preferences are being loaded prevents a queued patch', async t => {
  const ws = workspace(t);
  await ws.register(oldChat, alpha, defaultChatOptions);
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  t.mock.method(ws.preferences, 'get', async () => {
    entered.resolve();
    await resume.promise;
    return defaultChatOptions;
  });
  const pending = ws.options(oldChat, alpha, { webSearch: true });
  await entered.promise;
  ws.allowSharing(false);
  resume.resolve();
  const response = await pending;
  assert.ok(response.status >= 400);
  assert.deepEqual(ws.store.chatOptions(oldChat, alpha), defaultChatOptions);
});

test('the native provider sends each chat’s selected options in the Responses request body', async t => {
  const nativeId = 'session-11111111-1111-4111-8111-111111111111';
  const savedId = 'session-22222222-2222-4222-8222-222222222222';
  const ws = workspace(t, undefined, {
    sessions: new Map([[nativeId, { header: { origin: 'user' } }]]),
    sessionPersistence: { async stat(id) { return id === savedId ? { header: { origin: 'user' } } : undefined; } },
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    requests.push(await request.json());
    return new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  });
  async function send(sessionId, purpose, reasoningEffort) {
    const chunks = await Array.fromAsync(ws.adapter.stream({ provider: 'chatgpt-plan', model: 'test-model', sessionId, purpose, reasoningEffort,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'input' }] }],
    }));
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });
    return requests.at(-1);
  }

  await ws.preferences.save({ webSearch: true, jsonSchema: '' });
  assert.equal((await ws.register(oldChat, alpha, defaultChatOptions)).status, 200);
  assert.equal((await ws.register(newChat, alpha, defaultChatOptions)).status, 200);
  assert.equal((await ws.options(newChat, alpha, { jsonSchema, webSearch: true })).status, 200);
  assert.deepEqual((await ws.adapter.listModels())[0].reasoning.efforts.map(level => level.id), ['low', 'high']);
  const searchable = await send(newChat, undefined, 'high');
  assert.deepEqual(searchable.tools, [{ type: 'web_search' }]);
  assert.equal(searchable.reasoning.effort, 'high');
  assert.equal(searchable.text, undefined);
  const plain = await send(oldChat, undefined, 'low');
  assert.equal(plain.tools, undefined);
  assert.equal(plain.reasoning.effort, 'low');
  const requestCount = requests.length;
  const unsupported = await Array.fromAsync(ws.adapter.stream({
    provider: 'chatgpt-plan', model: 'test-model', sessionId: newChat, reasoningEffort: 'max', messages: [],
  }));
  assert.equal(unsupported.at(-1).reason.failure.code, 'UNSUPPORTED_REASONING_EFFORT');
  assert.equal(requests.length, requestCount);
  assert.equal(plain.text, undefined);
  const ordinary = await send('native-dsh-chat');
  assert.deepEqual(ordinary.tools, [{ type: 'web_search' }]);
  assert.equal(ordinary.text, undefined);

  // DSH's composer creates a native session before sending the initial message.
  assert.equal((await ws.options(nativeId, alpha, { webSearch: false, jsonSchema })).status, 200);
  const native = await send(nativeId);
  assert.equal(native.tools, undefined);
  assert.equal(native.text, undefined);
  assert.deepEqual((await ws.options(savedId, alpha)).body.features, { webSearch: true, jsonSchema: '' });
  assert.equal((await ws.options('missing-native-session', alpha, { jsonSchema })).status, 403);
  assert.equal((await ws.options(nativeId, beta)).status, 403);
  assert.equal((await ws.select(beta)).status, 200);
  assert.deepEqual((await ws.options(nativeId, beta)).body.features, { webSearch: true, jsonSchema: '' });
  assert.equal((await send(nativeId)).text, undefined);
  assert.equal((await ws.select(alpha)).status, 200);
  assert.deepEqual((await ws.options(nativeId, alpha)).body.features, { webSearch: false, jsonSchema });
  assert.equal(ws.store.owner(nativeId), undefined);

  const background = await send(newChat, 'summary');
  assert.equal(background.text, undefined);
  assert.equal(background.tools, undefined);
});
