import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUsageStore } from '../host/activity.js';
import { ChatGPTError } from '../host/chatgpt/errors.js';
import { mountChatGPT } from '../host/index.js';
import { createProvider } from '../host/provider.js';

test('model catalog coalesces reads, expires after a minute, and rechecks the grant on cache hits', async t => {
  const inFlight = Promise.withResolvers();
  const account = new AbortController();
  let sharing = true;
  let grantReads = 0;
  let fetches = 0;
  let time = 100_000;
  t.mock.method(performance, 'now', () => time);

  const adapter = createProvider({
    async listModels() {
      fetches += 1;
      if (fetches === 1) return inFlight.promise;
      if (fetches === 2) throw new Error('Temporary model catalog failure');
      return [{ slug: 'updated-model', displayName: `Updated ${fetches}` }];
    },
  }, async () => {
    grantReads += 1;
    return { status: 'connected', sharing, profileId: 'alpha', accountSignal: account.signal };
  }, new AbortController().signal);

  const first = adapter.listModels();
  const second = adapter.listModels();
  inFlight.resolve([
    { slug: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol' },
    { slug: 'gpt-6.2-sol', displayName: 'Duplicate' },
  ]);
  const [initial, concurrent] = await Promise.all([first, second]);
  assert.equal(fetches, 1);
  assert.deepEqual(initial, concurrent);
  assert.deepEqual(initial.map(({ id, name }) => ({ id, name })), [{ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }]);
  initial[0].inputModalities.push('audio');
  assert.deepEqual((await adapter.listModels())[0].inputModalities, ['text', 'image']);
  time += 59_999;
  assert.equal((await adapter.listModels())[0].id, 'gpt-6.2-sol');
  assert.equal(fetches, 1);
  time += 1;
  await assert.rejects(adapter.listModels(), { message: 'Temporary model catalog failure' });
  assert.equal((await adapter.listModels())[0].name, 'Updated 3');
  sharing = false;
  assert.deepEqual(await adapter.listModels(), []);
  assert.equal(fetches, 3);
  sharing = true;
  assert.equal((await adapter.listModels())[0].name, 'Updated 4');
  assert.equal(grantReads, 8);
});

test('model catalogs never cross profile IDs or account generations', async () => {
  const firstEntered = Promise.withResolvers();
  const firstResponse = Promise.withResolvers();
  let account = new AbortController();
  let profileId = 'alpha';
  let fetches = 0;
  const adapter = createProvider({
    async listModels({ signal }) {
      fetches += 1;
      if (fetches === 1) {
        firstEntered.resolve(signal);
        return firstResponse.promise;
      }
      return [{ slug: `${profileId}-model`, displayName: `Fetch ${fetches}` }];
    },
  }, async () => ({ status: 'connected', sharing: true, profileId, accountSignal: account.signal }), new AbortController().signal);

  const old = adapter.listModels();
  const oldRejected = assert.rejects(old, { name: 'AbortError' });
  const oldSignal = await firstEntered.promise;
  account.abort();
  account = new AbortController();
  profileId = 'beta';
  assert.equal(oldSignal.aborted, true);
  assert.equal((await adapter.listModels())[0].id, 'beta-model');
  firstResponse.resolve([{ slug: 'alpha-model', displayName: 'Old result' }]);
  await oldRejected;
  assert.equal((await adapter.listModels())[0].name, 'Fetch 2');

  profileId = 'alpha';
  assert.equal((await adapter.listModels())[0].id, 'alpha-model');
  assert.equal(fetches, 3);
  account.abort();
  account = new AbortController();
  assert.equal((await adapter.listModels())[0].name, 'Fetch 4');
});

test('manual refresh bypasses a warm catalog once and still checks account authorization', async () => {
  let reads = 0;
  let sharing = true;
  const account = new AbortController();
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const provider = createProvider({
    async listModels() {
      reads += 1;
      if (reads === 1) return [{ slug: 'previous', displayName: 'Previous' }];
      started.resolve();
      return response.promise;
    },
  }, async () => ({ profileId: 'alpha', status: 'connected', sharing, accountSignal: account.signal }),
  new AbortController().signal);

  assert.equal((await provider.listModels())[0].id, 'previous');
  const manual = provider.listPlanModels(true);
  await started.promise;
  const concurrent = Promise.all([provider.listModels(), provider.listPlanModels(true)]);
  response.resolve([{ slug: 'new', displayName: 'New model' }]);
  assert.equal((await manual)[0].id, 'new');
  assert.deepEqual((await concurrent).map(catalog => catalog[0].id), ['new', 'new']);
  assert.equal((await provider.listModels())[0].id, 'new');
  assert.equal(reads, 2);
  sharing = false;
  assert.deepEqual(await provider.listPlanModels(true), []);
  assert.equal(reads, 2);
});

test('catalog connection errors are quiet in the native picker and actionable in the plugin', async t => {
  const networkError = new ChatGPTError('network_error', '无法连接 OpenAI，请检查网络后重试。', true);
  const routes = new Map();
  const notifications = [];
  const session = { profileId: 'alpha', status: 'connected', sharing: true };
  let adapter;
  let offline = true;
  mountChatGPT({
    llm: { registerAdapter(_ids, implementation) {
      adapter = implementation;
      return { replace(ids) { notifications.push(ids); } };
    } },
    connection: { fetch: { register(route) { routes.set(route.path, route); } } },
    effect(setup) { t.after(setup()); },
  }, {
    available: true,
    client: {
      subscribe: () => () => {},
      getSession: async () => session,
      async listModels() {
        if (offline) throw networkError;
        return [{ slug: 'chat-model', displayName: 'Chat model' }];
      },
    },
  });

  const path = '/api/dsh-use-chatgpt/models';
  const retry = () => routes.get(path).fetch(new Request('http://localhost' + path + '?profileId=alpha&refresh=1'));
  assert.deepEqual(await adapter.listModels(), []);
  await assert.rejects(adapter.listSelectableModels(), { code: 'network_error' });
  await assert.rejects(adapter.prepareCall('chatgpt-plan', 'chat-model'), { code: 'network_error' });
  const failed = await retry();
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: { message: networkError.message } });
  assert.deepEqual(notifications, []);

  offline = false;
  const recovered = await retry();
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).models.map(model => model.id), ['chat-model']);
  assert.deepEqual(notifications, [['chatgpt-plan']]);
  assert.deepEqual((await adapter.listModels()).map(model => model.id), ['chat-model']);
});

test('picker visibility persists per account while the complete catalog and existing routes remain usable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-model-visibility-'));
  const store = createUsageStore(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const routes = new Map();
  const notifications = [];
  let adapter;
  let session = { profileId: 'alpha', status: 'connected', sharing: true };
  let modelIds = ['first', 'second'];
  let stall;
  const entered = Promise.withResolvers();

  mountChatGPT({
    llm: { registerAdapter(_ids, implementation) {
      adapter = implementation;
      return { replace(ids) { notifications.push(ids); } };
    } },
    connection: { fetch: { register(route) { routes.set(route.path, route); } } },
    effect(setup) { t.after(setup()); },
  }, {
    available: true, usageStore: store,
    client: {
      subscribe: () => () => {},
      getSession: async () => session,
      listProfiles: async () => [],
      selectProfile: async profileId => (session = { ...session, profileId }),
      async listModels() {
        if (stall) { entered.resolve(); await stall.promise; }
        return modelIds.map(slug => ({ slug, displayName: slug }));
      },
      streamResponse: async () => ({ text: 'continued', output: [] }),
    },
  });

  async function call(path, body) {
    const request = new Request('http://localhost/api/dsh-use-chatgpt/' + path,
      body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    const response = await routes.get(new URL(request.url).pathname).fetch(request);
    return { status: response.status, data: await response.json() };
  }
  const change = (model, enabled) => call('model-visibility', { profileId: session.profileId, model, enabled });
  const catalog = async (path = 'models') => (await call(path)).data.models.map(({ id, enabled }) => [id, enabled]);
  assert.deepEqual(await catalog(), [['first', true], ['second', true]]);
  assert.equal((await call('models?profileId=beta')).status, 409);
  assert.equal((await call('model-visibility', { profileId: 'beta', model: 'first', enabled: false })).status, 409);
  assert.equal((await change('unknown', false)).status, 400);
  assert.equal((await change('first', 'false')).status, 400);
  assert.deepEqual(notifications, []);
  const [first, second] = await Promise.all([change('first', false), change('second', false)]);
  assert.deepEqual(first, { status: 200, data: { model: 'first', enabled: false } });
  assert.deepEqual(second, { status: 200, data: { model: 'second', enabled: false } });
  assert.deepEqual(notifications, [['chatgpt-plan'], ['chatgpt-plan']]);
  assert.deepEqual(await adapter.listModels(), []);
  const hiddenModel = await adapter.prepareCall('chatgpt-plan', 'first');
  const chunks = await Array.fromAsync(hiddenModel.stream({ model: 'first', messages: [] }));
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });

  store.close();
  assert.deepEqual(await catalog(), [['first', false], ['second', false]]);
  modelIds.push('new');
  assert.deepEqual(await catalog('models?refresh=1'), [['first', false], ['second', false], ['new', true]]);
  assert.deepEqual((await adapter.listModels()).map(m => m.id), ['new']);
  await change('second', true);
  await call('select-profile', { profileId: 'beta' });
  assert.deepEqual(await catalog(), [['first', true], ['second', true], ['new', true]]);
  await call('select-profile', { profileId: 'alpha' });
  assert.deepEqual(await catalog(), [['first', false], ['second', true], ['new', true]]);

  stall = Promise.withResolvers();
  const refreshing = call('models?refresh=1');
  await entered.promise;
  const saving = change('second', false);
  await call('select-profile', { profileId: 'beta' });
  stall.resolve();
  assert.notEqual((await saving).status, 200);
  assert.notEqual((await refreshing).status, 200);
  assert.deepEqual(store.hiddenModels('alpha'), new Set(['first']));
  assert.deepEqual(store.hiddenModels('beta'), new Set());
  session = { ...session, sharing: false };
  assert.equal((await change('first', false)).status, 403);
});
