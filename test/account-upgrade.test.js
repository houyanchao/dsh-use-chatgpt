import assert from 'node:assert/strict';
import { randomBytes, subtle } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createChatGPT } from '../host/chatgpt/client.js';
import { AccountStore } from '../host/chatgpt/store.js';

// A synthetic 0.6.0 connection on disk. The new implementation must open it without registering again.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-account-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const encryption = {
    id: 'synthetic-key',
    isAvailable: () => true,
    async encrypt(text) {
      const iv = randomBytes(12);
      const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(text));
      return Buffer.concat([iv, Buffer.from(ciphertext)]);
    },
    async decrypt(data) {
      const bytes = await subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12) }, key, data.subarray(12));
      return Buffer.from(bytes).toString('utf8');
    },
  };
  const profile = {
    version: 1, id: 'profile-A', label: 'Connection 1', clientId: 'oaiapp_synthetic', savedAt: new Date().toISOString(),
    subject: 'synthetic-subject', identity: { email: 'user@example.invalid' }, profileIdToken: 'synthetic-id',
    status: 'connected', scopes: ['offline_access', 'chatgpt.tokens.use.direct'],
    credentials: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() - 100 },
  };
  const state = { version: 2, activeProfileId: profile.id, profiles: [profile], pendingRegistrations: [] };
  const file = join(directory, 'chatgpt-auth.json');
  async function write(value) { await writeFile(file, JSON.stringify(value), { mode: 0o600 }); }
  async function seal() {
    await write({ version: 3, provider: encryption.id, ciphertext: (await encryption.encrypt(JSON.stringify(state))).toString('base64') });
  }
  const config = { storageDir: directory, credentialEncryption: encryption, appName: 'Fixture', appId: 'fixture', redirectPort: 0 };
  return { config, file, profile, state, write, seal };
}

test('upgrade resumes an encrypted account; concurrent runtimes rotate once and failed remote logout still removes local credentials', async t => {
  const fx = await fixture(t);
  await fx.seal();
  const hostId = 'urn:uuid:c36edcb6-7c38-44c9-81f2-7c903de474f8';
  await writeFile(join(fx.config.storageDir, 'chatgpt-host.json'), JSON.stringify({ version: 1, id: hostId }), { mode: 0o600 });
  assert.equal(await new AccountStore(fx.config.storageDir, fx.config.credentialEncryption).transaction(tx => tx.hostId()), hostId);
  const issuer = 'https://auth.openai.com';
  let rotations = 0;
  let revocations = 0;
  let inferences = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/.well-known/openid-configuration') return Response.json({ issuer,
      authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/renew', jwks_uri: issuer + '/keys',
      revocation_endpoint: issuer + '/revoke' });
    if (path === '/renew') {
      assert.equal(options.body.get('refresh_token'), 'old-refresh');
      rotations++;
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'bearer', expires_in: 3600 });
    }
    if (path === '/v1/models') {
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer new-access');
      inferences++;
      return Response.json({ models: [] });
    }
    if (path === '/revoke') {
      assert.equal(options.body.get('token'), 'new-refresh');
      revocations++;
      return new Response(null, { status: 400 });
    }
    assert.fail('Unexpected test endpoint: ' + path);
  });
  const a = createChatGPT(fx.config);
  const b = createChatGPT(fx.config);
  assert.equal((await a.getSession()).profileId, fx.profile.id);
  await assert.rejects(a.listModels({ expectedProfileId: 'profile-B' }), { code: 'connection_changed' });
  await Promise.all([a.listModels(), b.listModels()]);
  assert.deepEqual([rotations, inferences], [1, 2]);
  assert.doesNotMatch(await readFile(fx.file, 'utf8'), /old-access|new-access|new-refresh/);
  await assert.rejects(a.disconnect(), { code: 'revocation_failed' });
  assert.equal(revocations, 1);
  await assert.rejects(b.listModels(), { code: 'sign_in_required' });
  const stored = JSON.parse(await readFile(fx.file, 'utf8'));
  const { profiles } = JSON.parse(await fx.config.credentialEncryption.decrypt(Buffer.from(stored.ciphertext, 'base64')));
  assert.equal(profiles[0].clientId, fx.profile.clientId);
  for (const field of ['credentials', 'pendingRefresh', 'profileIdToken']) assert.equal(profiles[0][field], undefined);
});

test('readable old plaintext is encrypted before use; unknown or unreadable credentials are preserved exactly', async t => {
  const fx = await fixture(t);
  await fx.write(fx.state);
  const client = createChatGPT(fx.config);
  assert.equal((await client.getSession()).sharing, true);
  const encrypted = await readFile(fx.file, 'utf8');
  assert.equal(JSON.parse(encrypted).version, 3);
  assert.doesNotMatch(encrypted, /old-refresh|old-access/);
  await fx.write(fx.profile);
  const [legacy] = await client.listProfiles();
  assert.equal(legacy.requiresNewRegistration, true);
  assert.equal(legacy.sharing, true);
  assert.equal(JSON.parse(await readFile(fx.file, 'utf8')).version, 3);
  await assert.rejects(client.signIn({ profileId: legacy.id }), { code: 'registration_upgrade_required' });
  for (const record of [{ version: 30 }, { version: 3, provider: 'different-os', ciphertext: 'AQ==' },
    { version: 3, provider: fx.config.credentialEncryption.id, ciphertext: 'AQ==' }]) {
    await fx.write(record);
    assert.equal((await client.getSession()).sharing, false);
    await assert.rejects(client.signIn());
    assert.equal(await readFile(fx.file, 'utf8'), JSON.stringify(record));
  }
});

test('first launch can show the login page without prompting the system key store', async t => {
  const fx = await fixture(t);
  const check = t.mock.method(fx.config.credentialEncryption, 'isAvailable', () => false);
  const client = createChatGPT(fx.config);
  assert.deepEqual(await client.getSession(), { status: 'disconnected', sharing: false });
  assert.deepEqual(await client.listProfiles(), []);
  assert.equal(check.mock.callCount(), 0);
  await fx.seal();
  assert.equal((await client.getSession()).error.code, 'storage_encryption_unavailable');
});

test('a rotated grant survives a signing-key outage and a restart without reusing its refresh token', async t => {
  const fx = await fixture(t);
  await fx.seal();
  const issuer = 'https://auth.openai.com';
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), alg: 'RS256', kid: 'upgrade-fixture', use: 'sig' };
  const idToken = await new SignJWT({ email: fx.profile.identity.email }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(issuer).setAudience(fx.profile.clientId).setSubject(fx.profile.subject).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  let ready = false;
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    switch (new URL(url).pathname) {
      case '/.well-known/openid-configuration':
        return Response.json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/renew',
          jwks_uri: issuer + '/keys', revocation_endpoint: issuer + '/revoke' });
      case '/renew':
        assert.equal(++exchanges, 1);
        return Response.json({ access_token: 'pending-access', refresh_token: 'pending-refresh', id_token: idToken,
          token_type: 'bearer', expires_in: 3600 });
      case '/keys':
        return ready ? Response.json({ keys: [jwk] }) : new Response(null, { status: 503 });
      case '/v1/models':
        assert.equal(ready, true);
        assert.equal(new Headers(options.headers).get('authorization'), 'Bearer pending-access');
        return Response.json({ models: [] });
      default:
        assert.fail('Unexpected test endpoint');
    }
  });
  const client = createChatGPT(fx.config);
  await assert.rejects(client.listModels(), { code: 'identity_verification_unavailable' });
  const readProfile = async () => {
    const envelope = JSON.parse(await readFile(fx.file, 'utf8'));
    return JSON.parse(await fx.config.credentialEncryption.decrypt(Buffer.from(envelope.ciphertext, 'base64'))).profiles[0];
  };
  assert.equal((await readProfile()).pendingRefresh.credentials.refreshToken, 'pending-refresh');
  ready = true;
  await createChatGPT(fx.config).listModels();
  assert.equal(exchanges, 1);
  const profile = await readProfile();
  assert.equal(profile.pendingRefresh, undefined);
  assert.equal(profile.credentials.refreshToken, 'pending-refresh');
});
