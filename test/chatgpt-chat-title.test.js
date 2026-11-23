import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageStore, mountActivity } from '../host/activity.js';

const newId = 'chatgpt-11111111-1111-4111-8111-111111111111';
const namedId = 'chatgpt-22222222-2222-4222-8222-222222222222';
const existingId = 'chatgpt-33333333-3333-4333-8333-333333333333';
const otherId = 'chatgpt-44444444-4444-4444-8444-444444444444';

test('chat registration pins the title once through the native API for eligible new sessions', async t => {
  const usageStore = createUsageStore();
  const account = new AbortController();
  usageStore.associate(existingId, 'alpha');
  usageStore.associate(otherId, 'beta');
  const names = new Map([[namedId, { title: 'My title', source: { kind: 'user' } }]]);
  const renames = [];
  let route;
  mountActivity({
    effect(setup) { t.after(setup()); },
    connection: { fetch: { register(value) { if (value.path.endsWith('/chats')) route = value; } } },
    get(name) {
      if (name === 'agents') return { get: id => ({ session: { id } }) };
      assert.equal(name, 'sessionTitle');
      return {
        get: session => names.get(session.id),
        rename(session, title) {
          assert.equal(usageStore.owner(session.id), 'alpha');
          renames.push(session.id);
          names.set(session.id, { title, source: { kind: 'user' } });
        },
      };
    },
  }, {
    adapter: { listModels: () => assert.fail('A local title does not read models') },
    getSession: async () => ({ status: 'connected', sharing: true, profileId: 'alpha', accountSignal: account.signal }),
    usageStore,
  });

  function register(id, title) {
    return route.fetch(new Request(`http://127.0.0.1${route.path}`, {
      method: 'POST', body: JSON.stringify({ id, title, profileId: 'alpha' }),
    }));
  }
  assert.equal((await register(otherId, 'Other account')).status, 409);
  assert.equal((await register('ordinary-session', 'Other session')).status, 409);
  assert.equal((await register(newId, 'a'.repeat(257))).status, 400);
  assert.equal((await register(existingId, 'Previously registered')).status, 200);
  assert.equal((await register(namedId, 'Leave my existing title')).status, 200);
  assert.equal((await register(newId, 'Pinned locally')).status, 200);
  assert.equal((await register(newId, 'Another suggestion')).status, 200);
  assert.deepEqual(renames, [newId]);
  assert.deepEqual(names.get(newId), { title: 'Pinned locally', source: { kind: 'user' } });
  assert.equal(names.get(namedId).title, 'My title');
});
