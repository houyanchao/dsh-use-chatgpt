import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createChatGPT } from '../host/chatgpt/client.js';
import { mountChatGPT } from '../host/index.js';
import { providerId } from '../host/provider.js';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
  token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
  revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
};
const CLIENT_ID = 'oaiapp_test_dsh';
const SECOND_CLIENT_ID = 'oaiapp_test_dsh_second';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

function testEncryption() {
  const key = randomBytes(32);
  return {
    id: 'test-aes-gcm',
    isAvailable: () => true,
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decrypt(bytes) {
      const ciphertext = Buffer.from(bytes);
      const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12));
      decipher.setAuthTag(ciphertext.subarray(12, 28));
      return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function signedIdentity(privateKey, nonce, clientId) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'test-key' };
  const claims = {
    iss: ISSUER,
    aud: clientId,
    sub: clientId === CLIENT_ID ? 'synthetic-dsh-user' : 'synthetic-dsh-second-user',
    iat: now,
    exp: now + 3600,
    nonce,
    email: clientId === CLIENT_ID ? 'test@example.invalid' : 'second@example.invalid',
  };
  const payload = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
}

test('DSH gates models by profile grant and isolates account changes, in-flight requests, and replay', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'dsh-devkit-flow-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', kid: 'test-key', use: 'sig' };
  const calls = [];
  const browserAttempts = [];
  let callbackServer;
  let leaveStreamOpen = false;
  let openStreamSignal;
  let nextEvents;
  let browserPaused;
  let refuseIdentity = false;
  let omitPlanGrant = false;
  let imagePaused;
  let revocationStatus = 200;
  let registrationClientId = CLIENT_ID;

  // Deliver the callback to the DevKit's real handler without binding a socket.
  t.mock.method(Server.prototype, 'listen', function (options, onListening) {
    assert.deepEqual(options, { port: 0, host: '127.0.0.1' });
    callbackServer = this;
    this.address = () => ({ address: '127.0.0.1', port: 54321, family: 'IPv4' });
    queueMicrotask(onListening);
    return this;
  });

  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    const { url, method } = request;
    const body = method === 'POST' ? await request.text() : undefined;
    calls.push({ url, method, body, authorization: request.headers.get('authorization') });

    switch (url) {
      case `${ISSUER}/.well-known/openid-configuration`:
        return Response.json(DISCOVERY);
      case DISCOVERY.jwks_uri:
        return Response.json({ keys: [jwk] });
      case DISCOVERY.token_endpoint: {
        const attempt = browserAttempts.at(-1);
        const clientId = new URLSearchParams(body).get('client_id');
        const scopes = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke'];
        if (!omitPlanGrant && ![1, 3].includes(browserAttempts.length)) scopes.push(PLAN_SCOPE);
        return Response.json({
          id_token: refuseIdentity ? undefined : signedIdentity(privateKey, attempt.searchParams.get('nonce'), clientId),
          access_token: `synthetic-access-${browserAttempts.length}`,
          refresh_token: `synthetic-refresh-${browserAttempts.length}`,
          token_type: 'bearer',
          scope: scopes.join(' '),
          expires_in: 3600,
        });
      }
      case `${RESOURCE}/models`:
        return Response.json({ models: [
          { slug: 'test-model', display_name: 'Test Model', visibility: 'list' },
          { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', visibility: 'list' },
          { slug: 'test-hidden', display_name: 'Hidden', visibility: 'hidden' },
        ] });
      case `${RESOURCE}/responses`: {
        const events = nextEvents ?? [
          { type: 'response.output_text.delta', delta: 'Synthetic ' },
          { type: 'response.output_text.delta', delta: 'reply' },
          { type: 'response.completed', response: { usage: { input_tokens: 14, output_tokens: 8, total_tokens: 22,
            input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } } } },
        ];
        nextEvents = undefined;
        if (leaveStreamOpen) {
          openStreamSignal = request.signal;
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(events[0])}\n\n`));
              request.signal.addEventListener('abort', () => { controller.error(request.signal.reason); }, { once: true });
            },
          }), { headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      case DISCOVERY.revocation_endpoint:
        return new Response(null, { status: revocationStatus });
      default:
        throw new Error(`Unexpected network endpoint: ${url}`);
    }
  });

  const credentialEncryption = testEncryption();
  const config = {
    appName: 'DSH Test Plugin',
    appId: 'dsh-test-plugin',
    redirectPort: 0,
    storageDir,
    sendHostId: true,
    credentialEncryption,
    openBrowser(url) {
      const authorization = new URL(url);
      browserAttempts.push(authorization);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authorization.searchParams.get('state'));
      callback.searchParams.set('code', `synthetic-code-${browserAttempts.length}`);
      const clientId = authorization.searchParams.get('client_id');
      callback.searchParams.set('client_id', clientId === 'dynamic_agent_client' ? registrationClientId : clientId);
      const approve = () => assert.equal(callbackServer.emit('request', {
        method: 'GET', headers: { host: callback.host }, url: `${callback.pathname}${callback.search}`,
      }, { setHeader() {}, end() {} }), true);
      if (browserPaused) browserPaused.resolve(approve);
      else approve();
    },
  };
  const client = createChatGPT(config);
  const routes = new Map();
  let adapter;
  let providers;
  let catalogChanges = 0;
  const cleanups = [];
  mountChatGPT({
    llm: { registerAdapter(ids, impl) {
      providers = ids;
      adapter = impl;
      return { replace(next) { providers = next; catalogChanges++; } };
    } },
    get(key) {
      if (key === 'attachments') return {
        async readImageRequest() {
          if (imagePaused) {
            imagePaused.entered.resolve();
            await imagePaused.release.promise;
          }
          return { data: Buffer.from([1, 2, 3]), mediaType: 'image/png' };
        },
        async *readFileStream() { yield Buffer.from('Example file\n'); },
      };
    },
    connection: { fetch: { register(route) { routes.set(route.path, route); } } },
    effect(callback) { cleanups.push(callback()); },
  }, { client, credentialEncryption, available: true });
  t.after(() => cleanups.forEach(cleanup => cleanup()));

  async function accountResult(action, body, signal) {
    const path = `/api/dsh-use-chatgpt/${action}`;
    const { methods, fetch } = routes.get(path);
    const response = await fetch(new Request(`http://127.0.0.1${path}`, {
      method: methods[0], signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: response.status, state: await response.json() };
  }

  async function account(action, body) {
    const { status, state } = await accountResult(action, body);
    assert.equal(status, 200, JSON.stringify(state));
    return state;
  }

  const defaultFeatures = { webSearch: false, jsonSchema: '' };
  assert.deepEqual(await account('status'), { status: 'disconnected', sharing: false, available: true, addingAccount: false, profiles: [], features: defaultFeatures });
  assert.deepEqual(providers, []);
  const response = { model: 'test-model', input: 'Test input' };
  const options = {
    provider: providerId,
    model: response.model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Be concise' }] },
      { role: 'user', content: [{ type: 'text', text: response.input }] },
    ],
    tools: [{ name: 'example', description: 'A synthetic example tool.', parameters: { type: 'object', properties: {} } }],
  };

  browserPaused = Promise.withResolvers();
  const initialLogin = account('sign-in');
  const approveInitial = await browserPaused.promise;
  const initialState = await account('status');
  assert.equal(initialState.status, 'connecting');
  assert.equal(initialState.addingAccount, false);
  assert.equal(initialState.profileId, undefined);
  browserPaused = undefined;
  approveInitial();
  const identityOnly = await initialLogin;
  assert.equal(identityOnly.status, 'connected');
  assert.equal(identityOnly.identity.email, 'test@example.invalid');
  assert.equal(identityOnly.sharing, false);
  assert.deepEqual(providers, []);
  const afterIdentity = calls.length;
  assert.deepEqual(await adapter.listModels(), []);
  assert.equal((await Array.fromAsync(adapter.stream(options))).at(-1).reason.failure.code, 'sharing_not_enabled');
  await assert.rejects(client.listModels(), { code: 'sharing_not_enabled' });
  await assert.rejects(client.streamResponse(response), { code: 'sharing_not_enabled' });
  assert.equal(calls.length, afterIdentity);

  const authorized = await account('enable');
  assert.equal(authorized.sharing, true);
  assert.deepEqual(providers, [providerId]);
  const models = await adapter.listModels();
  assert.deepEqual(models.map(model => model.id), ['test-model', 'gpt-6.2-sol']);
  assert.deepEqual(models[0], { provider: providerId, id: 'test-model', name: 'Test Model', inputModalities: ['text'] });
  assert.deepEqual(models[1].inputModalities, ['text', 'image']);
  assert.deepEqual(models[1].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  const prepared = await adapter.prepareCall(providerId, response.model);
  const chunks = await Array.fromAsync(prepared.stream(options));
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Synthetic ' },
    { type: 'text-delta', index: 0, text: 'reply' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic reply' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 8, totalTokens: 22, cacheReadTokens: 4, reasoningTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);

  const [registration, reconsent] = browserAttempts.map(attempt => attempt.searchParams);
  assert.equal(registration.get('client_id'), 'dynamic_agent_client');
  assert.equal(registration.get('agent_name_hint'), 'DSH Test Plugin');
  assert.match(registration.get('ext_agent_host_id'), /^urn:uuid:[0-9a-f-]+$/);
  assert.equal(reconsent.get('ext_agent_host_id'), registration.get('ext_agent_host_id'));
  assert.equal(reconsent.get('client_id'), CLIENT_ID);
  assert.equal(reconsent.get('prompt'), 'consent');
  const exchanges = calls.filter(call => call.url === DISCOVERY.token_endpoint);
  assert.equal(exchanges.length, browserAttempts.length);
  for (const [index, call] of exchanges.entries()) {
    const parameters = new URLSearchParams(call.body);
    const authorization = browserAttempts[index].searchParams;
    assert(authorization.get('scope').split(' ').includes(PLAN_SCOPE));
    assert.equal(parameters.get('grant_type'), 'authorization_code');
    assert.equal(parameters.get('code'), `synthetic-code-${index + 1}`);
    assert.equal(parameters.get('client_id'), CLIENT_ID);
    assert.equal(parameters.get('redirect_uri'), 'http://127.0.0.1:54321/auth/callback');
    assert.equal(parameters.get('resource'), RESOURCE);
    assert.equal(authorization.get('code_challenge_method'), 'S256');
    assert.equal(createHash('sha256').update(parameters.get('code_verifier')).digest('base64url'), authorization.get('code_challenge'));
  }
  const modelCall = calls.find(call => call.url === `${RESOURCE}/models`);
  const streamCall = calls.find(call => call.url === `${RESOURCE}/responses`);
  assert.equal(modelCall.authorization, 'Bearer synthetic-access-2');
  assert.equal(streamCall.authorization, 'Bearer synthetic-access-2');
  assert.deepEqual(JSON.parse(streamCall.body), {
    model: 'test-model', input: [
      { role: 'developer', content: 'Be concise' }, { role: 'user', content: 'Test input' },
    ], tools: [{ type: 'namespace', name: 'dsh', description: 'DeepSeek Harness local tools',
      tools: [{ ...options.tools[0], type: 'function', strict: false }] }], store: false, stream: true,
  });

  const visionOptions = {
    ...options,
    model: models[1].id,
    reasoningEffort: 'high',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Check attachments and call example.' },
      { type: 'image', attachment: { id: 'example-image' } },
      { type: 'file', attachment: { id: 'example-file', name: 'example.txt', bytes: 13 } },
    ] }],
  };
  const reasoning = { type: 'reasoning', id: 'rs_example', encrypted_content: 'opaque-example', summary: [] };
  const call = { type: 'function_call', id: 'fc_example', call_id: 'call_example', name: 'example',
    namespace: 'dsh', arguments: '{}', status: 'completed' };
  nextEvents = [
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Synthetic summary' },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.done', output_index: 1, item: call },
    { type: 'response.completed', response: { output: [] } },
  ];
  const toolChunks = await Array.fromAsync(adapter.stream(visionOptions));
  assert.deepEqual(toolChunks.at(-1).reason, { kind: 'tool-calls' });
  const blocks = toolChunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block);
  assert.deepEqual(blocks, [
    { type: 'reasoning', text: 'Synthetic summary' },
    { type: 'tool-call', id: 'call_example', name: 'example', arguments: '{}' },
  ]);
  const multimodalBody = JSON.parse(calls.at(-1).body);
  assert.deepEqual(multimodalBody.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(multimodalBody.input[0], { role: 'user', content: [
    { type: 'input_text', text: 'Check attachments and call example.' },
    { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'auto' },
    { type: 'input_file', filename: 'example.txt', file_data: `data:text/plain;base64,${Buffer.from('Example file\n').toString('base64')}` },
  ] });
  const toolContinuation = { ...visionOptions, messages: [
    ...visionOptions.messages,
    { role: 'assistant', content: blocks, source: { kind: 'model', provider: providerId, model: models[1].id,
      replayState: toolChunks.at(-1).replayState } },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: call.call_id, content: [{ type: 'text', text: 'Tool result' }] }] },
  ] };
  const continuation = await Array.fromAsync(adapter.stream(toolContinuation));
  assert.equal(continuation.at(-1).reason.kind, 'stop');
  assert.deepEqual(JSON.parse(calls.at(-1).body).input.slice(1), [
    reasoning, { type: call.type, call_id: call.call_id, namespace: call.namespace, name: call.name, arguments: call.arguments },
    { type: 'function_call_output', call_id: call.call_id, output: 'Tool result' },
  ]);

  const schema = { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false };
  const legacyFeatures = { webSearch: true, jsonSchema: JSON.stringify(schema) };
  assert.deepEqual((await account('features', legacyFeatures)).features, legacyFeatures);
  nextEvents = [
    { type: 'response.output_text.delta', delta: 'Search result' },
    { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://example.com/source' } },
    { type: 'response.completed', response: { output: [] } },
  ];
  const searched = await Array.fromAsync(adapter.stream(visionOptions));
  assert.match(searched.find(chunk => chunk.type === 'block-end').block.text, /\[1\]\(<https:\/\/example\.com\/source>\)/);
  assert.deepEqual(JSON.parse(calls.at(-1).body).tools.at(-1), { type: 'web_search' });
  assert.equal(JSON.parse(calls.at(-1).body).text, undefined);
  await Array.fromAsync(adapter.stream({ ...visionOptions, purpose: 'session-title' }));
  assert.equal(JSON.parse(calls.at(-1).body).text, undefined);
  assert.equal(JSON.parse(calls.at(-1).body).tools.some(tool => tool.type === 'web_search'), false);
  await account('features', defaultFeatures);

  leaveStreamOpen = true;
  const inFlight = prepared.stream(options);
  assert.equal((await inFlight.next()).value.type, 'block-start');
  assert.equal((await inFlight.next()).value.type, 'text-delta');
  const signedOut = await account('disconnect');
  assert.deepEqual(signedOut, {
    status: 'disconnected', sharing: false, available: true, addingAccount: false, features: defaultFeatures,
    profiles: [],
  });
  assert.deepEqual(providers, []);
  assert.equal((await inFlight.next()).value.reason.kind, 'aborted');
  assert.equal((await inFlight.next()).done, true);
  const revoked = calls.at(-1);
  assert.equal(revoked.url, DISCOVERY.revocation_endpoint);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(revoked.body)), {
    token: 'synthetic-refresh-2', token_type_hint: 'refresh_token', client_id: CLIENT_ID,
  });
  const disconnected = await client.getSession();
  assert.equal(disconnected.status, 'disconnected');
  assert.equal(disconnected.sharing, false);
  const afterDisconnect = calls.length;
  assert.deepEqual(await adapter.listModels(), []);
  assert.equal((await Array.fromAsync(prepared.stream(options))).at(-1).reason.failure.code, 'sharing_not_enabled');
  await assert.rejects(client.listModels(), { code: 'sign_in_required' });
  await assert.rejects(client.streamResponse(response), { code: 'sign_in_required' });
  await assert.rejects(createChatGPT(config).streamResponse(response), { code: 'sign_in_required' });
  assert.equal(calls.length, afterDisconnect);

  assert.equal((await accountResult('sign-in', { profileId: authorized.profileId })).state.error.code, 'profile_not_found');
  registrationClientId = SECOND_CLIENT_ID;
  const second = await account('sign-in', { newProfile: true });
  const secondId = second.profileId;
  assert.notEqual(secondId, authorized.profileId);
  assert.deepEqual(second.identity, { email: 'second@example.invalid' });
  assert.equal(second.sharing, false);
  assert.deepEqual(second.profiles.map(({ id, sharing, status }) => ({ id, sharing, status })), [
    { id: secondId, sharing: false, status: 'connected' },
  ]);
  assert.equal(browserAttempts.at(-1).searchParams.get('client_id'), 'dynamic_agent_client');
  registrationClientId = CLIENT_ID;
  const first = await account('sign-in', { newProfile: true });
  const firstId = first.profileId;
  assert.notEqual(firstId, authorized.profileId);
  assert.deepEqual(first.identity, authorized.identity);
  assert.equal(first.sharing, true);
  assert.equal(browserAttempts.at(-1).searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal((await accountResult('sign-in', { profileId: firstId, newProfile: true })).status, 400);

  const browserCount = browserAttempts.length;
  const readingBody = Promise.withResolvers();
  const finishReading = Promise.withResolvers();
  t.mock.method(Request.prototype, 'json', () => {
    readingBody.resolve();
    return finishReading.promise;
  }, { times: 1 });
  const preparingAdd = accountResult('sign-in', { newProfile: true });
  await readingBody.promise;
  const earlyCancel = account('cancel');
  finishReading.resolve({ newProfile: true });
  assert.equal((await preparingAdd).state.error.code, 'cancelled');
  const afterEarlyCancel = await earlyCancel;
  assert.equal(browserAttempts.length, browserCount);
  assert.equal(afterEarlyCancel.profileId, firstId);
  assert.equal(afterEarlyCancel.sharing, true);
  assert.equal(afterEarlyCancel.addingAccount, false);

  registrationClientId = SECOND_CLIENT_ID;
  const duringCancel = adapter.stream(options);
  assert.equal((await duringCancel.next()).value.type, 'block-start');
  assert.equal((await duringCancel.next()).value.type, 'text-delta');
  leaveStreamOpen = false;
  const beforeAddChanges = catalogChanges;
  browserPaused = Promise.withResolvers();
  const settingsRequest = new AbortController();
  const ongoingLogin = accountResult('sign-in', { newProfile: true }, settingsRequest.signal);
  await browserPaused.promise;
  settingsRequest.abort();
  const adding = await account('status');
  assert.equal(adding.status, 'connected');
  assert.equal(adding.addingAccount, true);
  assert.equal(adding.sharing, true);
  assert.equal(adding.profileId, firstId);
  assert.deepEqual(adding.identity, first.identity);
  assert.equal(adding.profiles.find(profile => profile.id === firstId).sharing, true);
  assert.deepEqual(providers, [providerId]);
  assert.equal(openStreamSignal.aborted, false);
  assert.deepEqual(await adapter.listModels(), models);
  assert.equal((await Array.fromAsync(adapter.stream(options))).at(-1).reason.kind, 'stop');
  assert.equal(calls.at(-1).authorization, 'Bearer synthetic-access-4');
  assert.equal((await accountResult('select-profile', { profileId: secondId })).status, 409);
  assert.equal((await accountResult('sign-out-profile', { profileId: secondId })).status, 409);
  const cancelled = await account('cancel');
  assert.equal(cancelled.profileId, firstId);
  assert.equal(cancelled.addingAccount, false);
  assert.equal(cancelled.sharing, true);
  assert.equal((await ongoingLogin).state.error.code, 'cancelled');
  browserPaused = undefined;
  assert.deepEqual(providers, [providerId]);
  assert.equal(catalogChanges, beforeAddChanges);
  assert.equal(openStreamSignal.aborted, false);

  imagePaused = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  const stale = adapter.stream(visionOptions);
  const pending = stale.next();
  await imagePaused.entered.promise;
  const beforeSwitch = calls.length;
  const identityAgain = await account('select-profile', { profileId: secondId });
  assert.equal(identityAgain.profileId, secondId);
  assert.equal(identityAgain.sharing, false);
  assert.deepEqual(providers, []);
  assert.equal(openStreamSignal.aborted, true);
  assert.equal((await duringCancel.next()).value.reason.kind, 'aborted');
  imagePaused.release.resolve();
  assert.equal((await pending).value.reason.kind, 'aborted');
  assert.equal((await stale.next()).done, true);
  assert.equal(calls.length, beforeSwitch);

  const secondAuthorized = await account('enable', { profileId: secondId });
  assert.equal(secondAuthorized.profileId, secondId);
  assert.equal(secondAuthorized.sharing, true);
  assert.equal(browserAttempts.at(-1).searchParams.get('client_id'), SECOND_CLIENT_ID);
  assert.equal((await Array.fromAsync(adapter.stream(toolContinuation))).at(-1).reason.kind, 'stop');
  assert.deepEqual(JSON.parse(calls.at(-1).body).input.slice(1), [
    { type: call.type, call_id: call.call_id, namespace: call.namespace, name: call.name, arguments: call.arguments },
    { type: 'function_call_output', call_id: call.call_id, output: 'Tool result' },
  ]);
  await adapter.listModels();
  assert.equal(calls.at(-1).authorization, 'Bearer synthetic-access-6');
  const secondSignedOut = await account('disconnect');
  assert.equal(secondSignedOut.profileId, undefined);
  assert.deepEqual(secondSignedOut.profiles.map(profile => profile.id), [firstId]);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls.at(-1).body)), {
    token: 'synthetic-refresh-6', token_type_hint: 'refresh_token', client_id: SECOND_CLIENT_ID,
  });
  const recovered = await account('select-profile', { profileId: firstId });
  assert.equal(recovered.sharing, true);
  await adapter.listModels();
  assert.equal(calls.at(-1).authorization, 'Bearer synthetic-access-4');
  assert.deepEqual(recovered.profiles.map(({ id, status, sharing }) => ({ id, status, sharing })), [
    { id: firstId, status: 'connected', sharing: true },
  ]);

  leaveStreamOpen = true;
  const duringRetry = adapter.stream(options);
  assert.equal((await duringRetry.next()).value.type, 'block-start');
  assert.equal((await duringRetry.next()).value.type, 'text-delta');
  leaveStreamOpen = false;
  refuseIdentity = true;
  assert.equal((await accountResult('sign-in', { newProfile: true })).state.error.code, 'invalid_id_token');
  const afterFailure = await account('status');
  assert.equal(afterFailure.profileId, firstId);
  assert.equal(afterFailure.sharing, true);
  assert.equal(afterFailure.addingAccount, false);
  assert.equal(openStreamSignal.aborted, false);
  const unfinished = afterFailure.profiles.find(profile => profile.pending);
  assert.ok(unfinished);

  refuseIdentity = false;
  omitPlanGrant = true;
  const otherProcess = createChatGPT(config);
  const previouslySelected = (await otherProcess.getSession()).profileId;
  assert.equal(previouslySelected, firstId);
  browserPaused = Promise.withResolvers();
  const resumed = account('sign-in', { profileId: unfinished.id });
  const approveResumed = await browserPaused.promise;
  const resuming = await account('status');
  assert.equal(resuming.status, 'connected');
  assert.equal(resuming.addingAccount, true);
  assert.equal(resuming.profileId, firstId);
  assert.equal(resuming.sharing, true);
  assert.deepEqual(providers, [providerId]);
  assert.deepEqual(await adapter.listPlanModels(true), models);
  assert.equal(calls.at(-1).authorization, 'Bearer synthetic-access-4');
  assert.equal(openStreamSignal.aborted, false);
  approveResumed();
  const added = await resumed;
  browserPaused = undefined;
  assert.equal(added.status, 'connected');
  assert.equal(added.addingAccount, false);
  assert.equal(added.profileId, unfinished.id);
  assert.equal(added.sharing, false);
  assert.deepEqual(providers, []);
  assert.equal(openStreamSignal.aborted, true);
  assert.equal((await duringRetry.next()).value.reason.kind, 'aborted');
  // Another process still displays A after this registration made B active.
  const beforeStaleLogout = calls.length;
  await assert.rejects(otherProcess.disconnect({ expectedProfileId: previouslySelected }), { code: 'connection_changed' });
  assert.equal(calls.length, beforeStaleLogout);
  assert.equal((await client.getSession()).profileId, added.profileId);
  assert.equal((await client.getSession()).status, 'connected');
  assert.equal((await client.listProfiles()).find(profile => profile.id === firstId).sharing, true);
  assert.equal((await account('select-profile', { profileId: firstId })).sharing, true);
  assert.deepEqual(providers, [providerId]);

  assert.equal((await accountResult('sign-out-profile')).state.error.code, 'invalid_profile');
  assert.equal((await accountResult('sign-out-profile', { profileId: 'missing' })).state.error.code, 'profile_not_found');
  imagePaused = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  const streamA = Array.fromAsync(adapter.stream(visionOptions));
  await imagePaused.entered.promise;
  const afterOtherSignOut = await account('sign-out-profile', { profileId: added.profileId });
  assert.equal(afterOtherSignOut.profileId, firstId);
  assert.deepEqual(afterOtherSignOut.profiles.map(profile => profile.id), [firstId]);
  assert.equal(new URLSearchParams(calls.at(-1).body).get('client_id'), SECOND_CLIENT_ID);
  imagePaused.release.resolve();
  assert.equal((await streamA).at(-1).reason.kind, 'stop');
  assert.equal(calls.at(-1).authorization, 'Bearer synthetic-access-4');

  // A failed remote revocation must still save the local sign-out and select A atomically.
  const readded = await account('sign-in', { newProfile: true });
  assert.notEqual(readded.profileId, added.profileId);
  revocationStatus = 400;
  assert.equal((await accountResult('sign-out-profile', { profileId: readded.profileId })).state.error.code, 'revocation_failed');
  assert.equal((await createChatGPT(config).getSession()).profileId, firstId);
  const remaining = await account('status');
  assert.equal(remaining.sharing, true);
  assert.deepEqual(remaining.profiles.map(profile => profile.id), [firstId]);
  assert.deepEqual(providers, [providerId]);

  revocationStatus = 200;
  leaveStreamOpen = true;
  const lastStream = adapter.stream(options);
  assert.equal((await lastStream.next()).value.type, 'block-start');
  assert.equal((await lastStream.next()).value.type, 'text-delta');

  const deadline = new AbortController();
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = t.mock.method(AbortSignal, 'timeout', ms => ms === 180_000 ? deadline.signal : realTimeout(ms));
  browserPaused = Promise.withResolvers();
  const timedOut = accountResult('sign-in', { newProfile: true });
  await browserPaused.promise;
  assert.ok(timeout.mock.calls.some(call => call.arguments[0] === 180_000));
  deadline.abort(new DOMException('Authorization timed out', 'TimeoutError'));
  assert.equal((await timedOut).state.error.code, 'authorization_timeout');
  timeout.mock.restore();
  browserPaused = undefined;
  const afterTimeout = await account('status');
  assert.equal(afterTimeout.profileId, firstId);
  assert.equal(afterTimeout.sharing, true);
  assert.equal(afterTimeout.addingAccount, false);
  assert.equal(openStreamSignal.aborted, false);

  const last = await account('sign-out-profile', { profileId: firstId });
  assert.equal(last.status, 'disconnected');
  assert.equal(last.profileId, undefined);
  assert.deepEqual(last.profiles, []);
  assert.equal((await lastStream.next()).value.reason.kind, 'aborted');
  assert.deepEqual(providers, []);
  await assert.rejects(createChatGPT(config).listModels(), { code: 'sign_in_required' });
});
