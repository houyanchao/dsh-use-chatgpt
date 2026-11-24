import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createPluginInstaller } from '../client/plugin-installer.js';

const registry = 'https://registry.npmjs.org/';
const freeModel = 'dsh-open-model';
const timeline = 'dsh-timeline';
const ok = value => ({ ok: true, value });
const accepted = name => ({ status: 'accepted', name, version: '1.2.3', bundle: true, registry });

function setup(t, manager) {
  const events = new Map();
  let attach;
  let dispose;
  const installer = createPluginInstaller({
    inject(_services, callback) { attach = callback; },
  });
  function listen(name, callback) {
    events.set(name, callback);
    return () => events.delete(name);
  }
  function connect() {
    attach({
      remote: { pluginManager: manager, $on: listen },
      on: listen,
      effect(start) { dispose = start(); },
    });
  }
  connect();
  const unsubscribe = installer.subscribe(() => {});
  t.after(() => { unsubscribe(); dispose(); });
  return { installer, events, reconnect() { dispose(); connect(); } };
}

test('installs the inspected official version once and rejoins a lost install reply', async t => {
  const inspection = Promise.withResolvers();
  const calls = [];
  let bundles = [{ name: timeline, installed: false, enabled: false, availability: 'profile' }];
  const { installer } = setup(t, {
    listBundles: () => ok(bundles),
    inspect(name, options) {
      calls.push(['inspect', name, options]);
      return inspection.promise;
    },
    installBundle(spec, options) {
      calls.push(['install', spec, options]);
      throw new Error('reply lost');
    },
    waitForInstall(id) {
      calls.push(['join', id]);
      bundles = [...bundles, { name: freeModel, installed: true }];
      return ok({ application: 'applied' });
    },
  });
  await nextTurn();
  assert(installer.getSnapshot().installed.has(timeline));
  await installer.install(timeline);
  const pending = installer.install(freeModel);
  await installer.install(freeModel);
  assert.equal(installer.getSnapshot().pending, freeModel);
  assert.deepEqual(calls, [['inspect', freeModel, { registry }]]);
  inspection.resolve(ok(accepted(freeModel)));
  await pending;
  const id = calls[1][2].requestId;
  assert.equal(typeof id, 'string');
  assert.deepEqual(calls.slice(1), [
    ['install', freeModel + '@1.2.3', { registry, enabled: true, expected: { name: freeModel, version: '1.2.3' }, requestId: id }],
    ['join', id],
  ]);
  assert(installer.getSnapshot().installed.has(freeModel));
  assert.equal(installer.getSnapshot().pending, null);
  assert.equal(installer.getSnapshot().error, null);
});

test('recognizes the old scoped package without installing a second provider', async t => {
  const { installer } = setup(t, {
    listBundles: () => ok([{ name: '@houyanchao/dsh-free-model', installed: true }]),
    inspect: () => assert.fail('already installed under its old name'),
  });
  await nextTurn();
  assert(installer.getSnapshot().installed.has(freeModel));
  await installer.install(freeModel);
  assert.equal(installer.getSnapshot().error, null);
});

test('rejects mismatched metadata and reports an explicit registry not-found result', async t => {
  let answer;
  let installations = 0;
  const { installer } = setup(t, {
    listBundles: () => ok([]), inspect: () => ok(answer),
    installBundle() { installations++; return ok({ application: 'applied' }); },
  });
  await nextTurn();
  for (const mismatch of [{ name: 'dsh-free-model' }, { registry: 'https://registry.npmmirror.com/' }, { bundle: false }, { version: 'latest' }]) {
    answer = { ...accepted(freeModel), ...mismatch };
    await installer.install(freeModel);
    assert.equal(installer.getSnapshot().error.name, freeModel);
  }
  answer = { status: 'refused', problem: 'not-found', reason: '404' };
  await installer.install(freeModel);
  assert.deepEqual(installer.getSnapshot().error, { name: freeModel, message: '404', problem: 'not-found' });
  assert.equal(installations, 0);
});

test('ignores old connection results and refreshes on external installation changes', async t => {
  const inspection = Promise.withResolvers();
  let bundles = [];
  let installations = 0;
  const { installer, events, reconnect } = setup(t, {
    listBundles: () => ok(bundles),
    inspect: () => inspection.promise,
    installBundle() { installations++; return ok({ application: 'applied' }); },
  });
  await nextTurn();
  const pending = installer.install(timeline);
  reconnect();
  inspection.resolve(ok(accepted(timeline)));
  await pending;
  assert.equal(installations, 0);
  assert.equal(installer.getSnapshot().pending, null);
  bundles = [{ name: timeline, installed: true, enabled: false }];
  events.get('plugin-manager/changed')();
  await nextTurn();
  assert(installer.getSnapshot().installed.has(timeline));
  bundles = [];
  events.get('connection/reset')();
  await nextTurn();
  assert.equal(installer.getSnapshot().installed.size, 0);
});
