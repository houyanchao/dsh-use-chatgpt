import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateChecker, mountUpdates } from '../host/updates.js';
import { openPluginDetails, readPluginUpdate } from '../client/updates.js';

const name = 'dsh-use-chatgpt';
const packageUrl = 'https://registry.npmjs.org/dsh-use-chatgpt';
const latestUrl = `${packageUrl}/latest`;
const publishedAt = '2026-01-02T15:37:09.123Z';
const day = 24 * 60 * 60 * 1000;
const eligibleAt = Date.parse(publishedAt) + day;

const manifest = version => Response.json({ name, version });
const metadata = (version, published = publishedAt) => Response.json({
  name, 'dist-tags': { latest: version }, time: { [version]: published },
});

test('npm upgrade checking uses the exact plugin package and compares the latest dist-tag by SemVer', async () => {
  const lookup = async (currentVersion, response) => {
    const urls = [];
    const { version } = await response.clone().json().catch(() => ({}));
    const result = await createUpdateChecker({
      currentVersion,
      now: () => eligibleAt,
      async fetch(url, options) {
        urls.push(url);
        assert.equal(options.redirect, 'error');
        assert.equal(options.credentials, 'omit');
        assert.ok(options.signal instanceof AbortSignal);
        return url === latestUrl ? response : metadata(version);
      },
    })();
    assert.deepEqual(urls, result.status === 'update_available' ? [latestUrl, packageUrl] : [latestUrl]);
    return result;
  };

  assert.deepEqual(await lookup('0.2.2', manifest('0.2.10')), {
    status: 'update_available', currentVersion: '0.2.2', latestVersion: '0.2.10',
  });
  assert.equal((await lookup('1.0.0', manifest('0.9.0'))).status, 'up_to_date');
  assert.equal((await lookup('0.2.0-rc.1', manifest('0.2.0'))).status, 'update_available');
  assert.equal((await lookup('0.2.0+local', manifest('0.2.0+registry'))).status, 'up_to_date');
  assert.deepEqual(await lookup('0.2.0', manifest('0.3.0-rc.1')), {
    status: 'update_available', currentVersion: '0.2.0', latestVersion: '0.3.0-rc.1',
  });
  assert.equal((await lookup('0.3.0', manifest('0.3.0-rc.1'))).status, 'up_to_date');
  assert.equal((await lookup('0.3.0-rc.9', manifest('0.3.0-rc.10'))).status, 'update_available');
  assert.equal((await lookup('0.3.0-rc.10', manifest('0.3.0-rc.9'))).status, 'up_to_date');
  assert.equal((await lookup('0.3.0-rc.10', manifest('0.3.0-rc.a'))).status, 'update_available');
  assert.equal((await lookup('0.3.0-rc', manifest('0.3.0-rc.1'))).status, 'update_available');
  assert.equal((await lookup('0.3.0-beta.11', manifest('0.3.0-rc.1'))).status, 'update_available');
  assert.equal((await lookup('0.3.0-rc.1+local', manifest('0.3.0-rc.1+registry'))).status, 'up_to_date');
  assert.equal((await lookup('0.2.0', manifest('0.3.0-rc.01'))).status, 'unreachable');
  assert.equal((await lookup('0.2.0', Response.json({ name: 'some-other-package', version: '99.0.0' }))).status, 'unreachable');
  assert.equal((await lookup('0.2.0', new Response(' '.repeat(256 * 1024 + 1)))).status, 'unreachable');
});

test('404 and network failure stay distinct when the update cache expires', async () => {
  let time = eligibleAt;
  let calls = 0;
  const check = createUpdateChecker({
    currentVersion: '0.2.0',
    now: () => time,
    async fetch(url) {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 404 });
      if (calls === 2) throw new Error('Network unavailable');
      return url === latestUrl ? manifest('0.3.0') : metadata('0.3.0');
    },
  });
  const concurrent = await Promise.all([check(), check(), check()]);
  assert.deepEqual(concurrent.map(result => result.status), ['unpublished', 'unpublished', 'unpublished']);
  assert.equal(calls, 1);
  time += 30 * 60 * 1000;
  assert.equal((await check()).status, 'unreachable');
  assert.equal((await check()).status, 'unreachable');
  assert.equal(calls, 2);
  time += 5 * 60 * 1000;
  assert.equal((await check()).status, 'update_available');
  assert.equal(calls, 4);
});

test('a newer release stays pending until its exact npm publication time plus 24 hours', async () => {
  let time = eligibleAt - 60_000;
  const urls = [];
  const check = createUpdateChecker({
    currentVersion: '1.0.0', now: () => time,
    async fetch(url) {
      urls.push(url);
      return url === latestUrl ? manifest('1.1.0') : metadata('1.1.0');
    },
  });
  const waiting = { status: 'release_pending', currentVersion: '1.0.0', latestVersion: '1.1.0' };
  assert.deepEqual(await Promise.all([check(), check()]), [waiting, waiting]);
  time = eligibleAt - 1;
  assert.deepEqual(await check(), waiting);
  assert.deepEqual(urls, [latestUrl, packageUrl]);
  time = eligibleAt;
  assert.deepEqual(await check(), { ...waiting, status: 'update_available' });
  assert.deepEqual(urls, [latestUrl, packageUrl, latestUrl, packageUrl]);
});

test('a replacement latest tag waits for its own release to age', async () => {
  let time = eligibleAt - 1;
  let latest = '1.1.0';
  const times = { '1.1.0': publishedAt, '1.2.0': new Date(eligibleAt + 1).toISOString() };
  const check = createUpdateChecker({
    currentVersion: '1.0.0', now: () => time,
    async fetch(url) {
      return url === latestUrl ? manifest(latest) : Response.json({ name, 'dist-tags': { latest }, time: times });
    },
  });
  assert.equal((await check()).status, 'release_pending');
  latest = '1.2.0';
  time = eligibleAt;
  assert.deepEqual(await check(), { status: 'release_pending', currentVersion: '1.0.0', latestVersion: latest });
  time = Date.parse(times[latest]) + day;
  assert.equal((await check()).status, 'update_available');
});

test('an unverifiable publication is suppressed and rechecked after a short cache', async () => {
  const latest = '1.1.0';
  const time = { [latest]: publishedAt };
  for (const invalid of [
    Response.json({ name }), Response.json({ name, time: { modified: publishedAt, '1.0.0': publishedAt } }),
    Response.json({ name, time: { [latest]: 'invalid' } }),
    Response.json({ name: 'another-plugin', time }),
    Response.json({ name, time, 'dist-tags': { latest: '1.2.0' } }),
    new Response(null, { status: 404 }), new Response(null, { status: 503 }),
  ]) {
    let clock = eligibleAt;
    let reads = 0;
    const check = createUpdateChecker({
      currentVersion: '1.0.0', now: () => clock,
      async fetch(url) {
        if (url === latestUrl) return manifest(latest);
        reads++;
        return reads === 1 ? invalid : metadata(latest);
      },
    });
    assert.equal((await check()).status, 'unreachable');
    clock += 5 * 60_000 - 1;
    assert.equal((await check()).status, 'unreachable');
    assert.equal(reads, 1);
    clock++;
    assert.equal((await check()).status, 'update_available');
    assert.equal(reads, 2);
  }
});

test('the client preserves a pending release without enabling its upgrade entry', async t => {
  const pending = { status: 'release_pending', currentVersion: '1.0.0', latestVersion: '1.1.0' };
  t.mock.method(globalThis, 'fetch', async () => Response.json(pending));
  assert.deepEqual(await readPluginUpdate(), pending);
});

test('the update route is read-only and the client opens the exact native package details', async t => {
  let route;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/dsh-use-chatgpt/update') return route.fetch();
    return url === latestUrl ? manifest('99.0.0') : metadata('99.0.0', '2001-01-01T00:00:00.000Z');
  });
  mountUpdates({ connection: { fetch: { register: spec => { route = spec; } } } });
  assert.equal(route.path, '/api/dsh-use-chatgpt/update');
  assert.deepEqual(route.methods, ['GET']);
  assert.equal((await route.fetch()).headers.get('cache-control'), 'no-store');
  assert.equal((await readPluginUpdate()).latestVersion, '99.0.0');

  let selected;
  assert.equal(openPluginDetails({ get(service) {
    assert.equal(service, 'pluginNavigation');
    return { openBundle: packageName => { selected = packageName; } };
  } }), true);
  assert.equal(selected, name);
  assert.equal(openPluginDetails({ get: () => undefined }), false);
});

test('the client retries one early desktop route failure after the startup delay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const published = { status: 'update_available', currentVersion: '0.3.0', latestVersion: '0.4.0' };
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return calls === 1 ? new Response(null, { status: 401 }) : Response.json(published);
  });
  const status = readPluginUpdate(undefined, { retryClientFailure: true });
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  t.mock.timers.tick(750);
  assert.deepEqual(await status, published);
  assert.equal(calls, 2);
});

test('the startup retry preserves a host result and cancels on disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const unreachable = { status: 'unreachable', currentVersion: '0.3.0' };
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) return Response.json(unreachable);
    throw new TypeError('Desktop route unavailable');
  });
  assert.deepEqual(await readPluginUpdate(undefined, { retryClientFailure: true }), unreachable);
  assert.equal(calls, 1);

  const controller = new AbortController();
  const status = readPluginUpdate(controller.signal, { retryClientFailure: true });
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(status, { name: 'AbortError' });
  t.mock.timers.tick(750);
  assert.equal(calls, 2);
});
