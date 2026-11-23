import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { apiError, ChatGPTError, fetchRemote, jsonResponse } from './errors.js';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const registrationClient = 'dynamic_agent_client';
const planScope = 'chatgpt.tokens.use.direct';
const requestedScopes = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', planScope];
const callbackPath = '/auth/callback';
const freshSecret = () => randomBytes(32).toString('base64url');
const validString = value => typeof value === 'string' && value.length > 0;
const invalidTokens = () => new ChatGPTError('invalid_token_response', 'OpenAI 返回的登录凭据不完整，请重新登录。');
const invalidIdentity = () => new ChatGPTError('invalid_id_token', '无法验证 ChatGPT 身份，请重新登录。');
const cancelled = () => new ChatGPTError('cancelled', '已取消 ChatGPT 登录。');

export function identityVerificationUnavailable() {
  return new ChatGPTError('identity_verification_unavailable', 'OpenAI 身份验证服务暂时不可用，已保留连接，请稍后重试。', true);
}

let discoveryCache;
let signingKeys;

async function loadProvider() {
  const response = await fetchRemote(issuer + '/.well-known/openid-configuration');
  const metadata = await jsonResponse(response);
  const discoveryError = () => new ChatGPTError('discovery_failed', '无法验证 OpenAI 登录服务的配置。', true);
  if (!response.ok || metadata?.issuer !== issuer) throw discoveryError();
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
    if (key === 'revocation_endpoint' && metadata[key] === undefined) continue;
    const endpoint = typeof metadata[key] === 'string' && URL.parse(metadata[key]);
    if (!endpoint || endpoint.origin !== issuer || endpoint.username || endpoint.password || endpoint.hash) {
      throw discoveryError();
    }
  }
  return metadata;
}

function provider() {
  if (!discoveryCache || discoveryCache.until <= Date.now()) {
    const promise = loadProvider();
    discoveryCache = { until: Date.now() + 60 * 60_000, promise };
    promise.catch(() => {
      if (discoveryCache?.promise === promise) discoveryCache = undefined;
    });
  }
  return discoveryCache.promise;
}

function verifierFor(url) {
  if (signingKeys?.url !== url) {
    const resolve = createRemoteJWKSet(new URL(url), {
      timeoutDuration: 15_000,
      [customFetch]: (address, options) => fetchRemote(address, options, 15_000),
    });
    signingKeys = { url, resolve };
  }
  const current = signingKeys;
  return async (header, token) => {
    try {
      return await current.resolve(header, token);
    } catch {
      // Resume a checkpoint after JWKS outages or key rotation without spending another refresh token.
      if (current === signingKeys) signingKeys = undefined;
      throw identityVerificationUnavailable();
    }
  };
}

async function identity(token, clientId, { nonce, at = Date.now(), subject } = {}) {
  if (!validString(token)) throw invalidIdentity();
  const metadata = await provider().catch(() => { throw identityVerificationUnavailable(); });
  let claims;
  try {
    const result = await jwtVerify(token, verifierFor(metadata.jwks_uri), {
      audience: clientId, issuer, algorithms: ['RS256'],
      requiredClaims: ['sub', 'aud', 'iss', 'exp', 'iat'],
      currentDate: new Date(at), clockTolerance: 5,
    });
    claims = result.payload;
  } catch (error) {
    if (error?.code === 'identity_verification_unavailable') throw error;
    throw invalidIdentity();
  }
  if (!validString(claims.sub) || !Number.isFinite(claims.iat) || claims.iat > at / 1000 + 5
    || (nonce !== undefined && nonce !== claims.nonce)
    || ((claims.azp !== undefined || (Array.isArray(claims.aud) && claims.aud.length > 1)) && claims.azp !== clientId)) {
    throw invalidIdentity();
  }
  if (subject !== undefined && claims.sub !== subject) {
    throw new ChatGPTError('account_mismatch', '返回的 ChatGPT 身份与所选账号不一致。');
  }
  const display = {};
  if (validString(claims.name)) display.name = claims.name;
  if (validString(claims.email)) display.email = claims.email;
  return { subject: claims.sub, identity: display, profileIdToken: token };
}

function postForm(url, fields, signal, timeout) {
  return fetchRemote(url, { method: 'POST', headers: { accept: 'application/json' },
    body: new URLSearchParams(fields), signal }, timeout);
}

async function exchange(metadata, fields, signal) {
  signal.throwIfAborted();
  const response = await postForm(metadata.token_endpoint, { ...fields, resource }, signal);
  const data = await jsonResponse(response);
  if (!response.ok) throw apiError(data, response.status, response.headers.get('x-request-id'));
  if (typeof data !== 'object' || !data || Array.isArray(data)) throw invalidTokens();
  return data;
}

function parseGrant(data, previousScopes) {
  const scope = data.scope === undefined ? previousScopes?.join(' ') : data.scope;
  if (typeof scope !== 'string') throw invalidTokens();
  const scopes = [...new Set(scope.trim().split(/\s+/).filter(Boolean))];
  const rotating = previousScopes !== undefined || scopes.includes('offline_access');
  if (!validString(data.access_token)) {
    if (rotating || scopes.includes(planScope)) throw invalidTokens();
    return { scopes };
  }
  const expiresAt = Date.now() + data.expires_in * 1000;
  if (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'
    || typeof data.expires_in !== 'number' || data.expires_in <= 0 || !Number.isFinite(expiresAt)
    || (rotating && !validString(data.refresh_token))) throw invalidTokens();
  const credentials = { accessToken: data.access_token, expiresAt };
  if (validString(data.refresh_token)) credentials.refreshToken = data.refresh_token;
  if (typeof data.earliest_refresh_at === 'string' || Number.isFinite(data.earliest_refresh_at)) {
    credentials.earliestRefreshAt = data.earliest_refresh_at;
  }
  return { scopes, credentials };
}

function validState(params, expected) {
  const states = params.getAll('state');
  if (states.length !== 1) return false;
  const supplied = Buffer.from(states[0]);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const clearQuery = "history.replaceState(null, '', '/auth/complete')";
const scriptHash = createHash('sha256').update(clearQuery).digest('base64');
const callbackPage = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>返回 DeepSeek Harness</title>'
  + '<h1>请返回 DeepSeek Harness</h1><p>应用将显示本次授权的结果。你可以关闭此标签页。</p>'
  + '<script>' + clearQuery + '</script></html>';

async function waitForSignIn({ port, state, clientId, signal }, launch) {
  const callback = Promise.withResolvers();
  const expected = Buffer.from(state);
  let address;
  let finished = false;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${scriptHash}'; frame-ancestors 'none'; base-uri 'none'`);
    const url = URL.parse(req.url, address);
    if (finished || !url || req.method !== 'GET' || url.origin !== address || url.username || url.password
      || req.headers.host !== url.host || url.pathname !== callbackPath) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    const params = url.searchParams;
    if (!validState(params, expected)) {
      res.statusCode = 400;
      return res.end('Invalid state');
    }
    finished = true;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(callbackPage);
    if (params.has('error')) return callback.reject(apiError({ error: params.get('error') }));
    const code = params.get('code');
    const issued = params.has('client_id') ? params.get('client_id') : clientId;
    if (!code || params.getAll('code').length !== 1 || params.getAll('client_id').length > 1
      || !validString(issued) || !/^[a-zA-Z0-9_-]{1,200}$/.test(issued)
      || issued === registrationClient || (clientId && clientId !== issued)) {
      return callback.reject(new ChatGPTError('registration_incomplete', 'OpenAI 未完成应用注册，请重新登录。'));
    }
    callback.resolve({ code, clientId: issued });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  const stop = () => callback.reject(cancelled());
  // A cancel or callback can arrive before the OS has finished launching the browser.
  callback.promise.catch(() => {});
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const bindFailed = () => reject(new ChatGPTError('callback_port_unavailable', '无法打开本机登录回调端口，请重试。'));
      server.once('error', bindFailed);
      server.listen({ port, host: '127.0.0.1' }, () => {
        server.off('error', bindFailed);
        server.on('error', () => callback.reject(new ChatGPTError('callback_failed', '本机登录回调已中断。')));
        resolve();
      });
    });
    signal.throwIfAborted();
    address = 'http://127.0.0.1:' + server.address().port;
    const redirect = address + callbackPath;
    const [, result] = await Promise.all([launch(redirect), callback.promise]);
    return { ...result, redirect };
  } finally {
    signal.removeEventListener('abort', stop);
    server.close();
    server.closeAllConnections();
  }
}

export async function authorize(config, previous, hostId, signal, { reconsent, onRegistration } = {}) {
  const metadata = await provider();
  const state = freshSecret();
  const nonce = freshSecret();
  const verifier = freshSecret();
  const previousId = previous?.clientId;
  const callback = await waitForSignIn({ port: config.redirectPort, state, clientId: previousId, signal }, redirect => {
    const url = new URL(metadata.authorization_endpoint);
    const fields = { client_id: previousId || registrationClient, state, nonce, redirect_uri: redirect,
      response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      resource, scope: requestedScopes.join(' '), ext_agent_host_id: hostId };
    if (!previousId) fields.agent_name_hint = config.appName;
    // The browser launcher passes its target in argv. Use only a login hint there.
    if (previous?.identity?.email) fields.login_hint = previous.identity.email;
    if (reconsent) fields.prompt = 'consent';
    url.search = new URLSearchParams(fields);
    return config.openBrowser(url.href);
  });
  signal.throwIfAborted();
  await onRegistration?.(callback.clientId);
  const data = await exchange(metadata, { grant_type: 'authorization_code', client_id: callback.clientId,
    redirect_uri: callback.redirect, code: callback.code, code_verifier: verifier }, signal);
  const account = await identity(data.id_token, callback.clientId, { nonce, subject: previous?.subject });
  signal.throwIfAborted();
  return { version: 1, status: 'connected', savedAt: new Date().toISOString(), clientId: callback.clientId,
    ...account, ...parseGrant(data) };
}

export async function refreshConnection(profile, signal, checkpoint) {
  let candidate = profile.pendingRefresh;
  let grant;
  if (candidate) {
    grant = { scopes: candidate.scopes, credentials: candidate.credentials };
  } else {
    const refresh = profile.credentials?.refreshToken;
    if (!refresh) throw new ChatGPTError('invalid_grant', '请重新连接 ChatGPT 账号。');
    const data = await exchange(await provider(), { grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: refresh }, signal);
    grant = parseGrant(data, profile.scopes);
    if (data.id_token !== undefined) {
      if (!validString(data.id_token)) throw invalidIdentity();
      candidate = { ...grant, idToken: data.id_token, receivedAt: Date.now() };
      await checkpoint(candidate);
    }
  }
  const next = { ...profile, ...grant, status: 'connected', savedAt: new Date().toISOString() };
  if (candidate) {
    if (!validString(profile.subject)) throw invalidIdentity();
    Object.assign(next, await identity(candidate.idToken, profile.clientId, { at: candidate.receivedAt, subject: profile.subject }));
  }
  delete next.pendingRefresh;
  return next;
}

export async function revokeConnection(profile) {
  if (!profile.credentials && !profile.pendingRefresh) return;
  const token = profile.pendingRefresh?.credentials.refreshToken || profile.credentials?.refreshToken;
  const failed = () => new ChatGPTError('revocation_failed', '未能确认远端撤销，请在 ChatGPT 设置中断开此应用。', true);
  const metadata = await provider().catch(() => { throw failed(); });
  if (!token || !metadata.revocation_endpoint) throw failed();
  const form = { token, token_type_hint: 'refresh_token', client_id: profile.clientId };
  for (let index = 0; index < 2; index++) {
    const response = await postForm(metadata.revocation_endpoint, form, undefined, 8_000).catch(() => undefined);
    await response?.body?.cancel().catch(() => {});
    if (response?.status === 200) return;
    if (response && response.status < 500) break;
    if (index === 0) await sleep(250);
  }
  throw failed();
}
