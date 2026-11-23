import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { Server } from 'node:http';
import test from 'node:test';
import { SignJWT } from 'jose';
import { authorize, refreshConnection, revokeConnection } from '../host/chatgpt/oauth.js';

const issuer = 'https://auth.openai.com';
const configuration = {
  issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
  jwks_uri: issuer + '/keys', revocation_endpoint: issuer + '/revoke',
};

test('stray browser callbacks do not consume a pending sign-in or send a code to the token endpoint', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), issuer + '/.well-known/openid-configuration');
    return Response.json(configuration);
  });
  let server;
  t.mock.method(Server.prototype, 'listen', function (_, ready) {
    this.address = () => ({ port: 51797 });
    server = this;
    queueMicrotask(ready);
    return this;
  });
  function callback(url, host = url.host) {
    const response = { statusCode: 200, setHeader() {}, end() {} };
    server.emit('request', { method: 'GET', headers: { host }, url: url.pathname + url.search }, response);
    return response.statusCode;
  }
  const config = { appName: 'DSH synthetic', redirectPort: 0, openBrowser(address) {
    const link = new URL(address);
    const redirect = new URL(link.searchParams.get('redirect_uri'));
    redirect.searchParams.set('state', 'unrelated');
    assert.equal(callback(redirect), 400);
    redirect.searchParams.set('state', link.searchParams.get('state'));
    assert.equal(callback(redirect, 'localhost:51797'), 404);
    redirect.searchParams.append('state', 'unrelated');
    assert.equal(callback(redirect), 400);
    redirect.searchParams.set('state', link.searchParams.get('state'));
    redirect.searchParams.set('error', 'access_denied');
    assert.equal(callback(redirect), 200);
  } };
  await assert.rejects(authorize(config, undefined, 'urn:uuid:fixture', new AbortController().signal), { code: 'access_denied' });
});

test('a rotation survives unavailable signing keys, verifies the original account, and revokes the newest refresh token', async t => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'fixture-key';
  const publicKey = { ...keys.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256' };
  const grant = { clientId: 'oaiapp_synthetic', subject: 'synthetic-subject', status: 'connected',
    scopes: ['chatgpt.tokens.use.direct', 'offline_access'],
    credentials: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() } };
  let online = false;
  let exchanges = 0;
  let revocations = 0;
  const refreshedId = await new SignJWT({ email: 'test@example.invalid' })
    .setProtectedHeader({ alg: 'RS256', kid }).setIssuedAt().setExpirationTime('5m')
    .setIssuer(issuer).setAudience(grant.clientId).setSubject(grant.subject).sign(keys.privateKey);
  t.mock.method(globalThis, 'fetch', async (address, init) => {
    const request = new Request(address, init);
    if (request.url === issuer + '/.well-known/openid-configuration') return Response.json(configuration);
    if (request.url === configuration.jwks_uri) {
      return online ? Response.json({ keys: [publicKey] }) : new Response(null, { status: 503 });
    }
    const form = new URLSearchParams(await request.text());
    if (request.url === configuration.revocation_endpoint) {
      assert.equal(form.get('token'), 'new-refresh');
      revocations++;
      return new Response(null);
    }
    assert.equal(request.url, configuration.token_endpoint);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'old-refresh');
    assert.equal(form.has('scope'), false);
    exchanges++;
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'bearer',
      expires_in: 3600, id_token: refreshedId });
  });
  const signal = new AbortController().signal;
  let checkpoint;
  await assert.rejects(refreshConnection(grant, signal, value => { checkpoint = value; }),
    { code: 'identity_verification_unavailable' });
  assert.equal(checkpoint.credentials.refreshToken, 'new-refresh');
  const saved = { ...grant, pendingRefresh: checkpoint };
  online = true;
  const noWrite = () => assert.fail('the existing checkpoint must be reused');
  const recovered = await refreshConnection(saved, signal, noWrite);
  assert.equal(recovered.pendingRefresh, undefined);
  assert.equal(recovered.credentials.refreshToken, 'new-refresh');
  assert.deepEqual(recovered.scopes, grant.scopes);
  assert.equal(recovered.profileIdToken, refreshedId);
  await assert.rejects(refreshConnection({ ...saved, subject: 'different' }, signal, noWrite), { code: 'account_mismatch' });
  assert.equal(exchanges, 1);
  // A logout from the older snapshot must still revoke the rotated token.
  await revokeConnection(saved);
  assert.equal(revocations, 1);
});
