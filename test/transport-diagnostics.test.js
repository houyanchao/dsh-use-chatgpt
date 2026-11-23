import assert from 'node:assert/strict';
import test from 'node:test';
import { apiError, fetchRemote, reportTransportFailure, requiresReauthentication } from '../host/chatgpt/errors.js';
import { streamResponse } from '../host/chatgpt/responses.js';

test('OAuth error survives a vendor-specific code or detail on the same response', () => {
  const reason = apiError({ error: 'invalid_grant', code: 'extension_code', detail: { code: 'unrelated' } }, 400);
  assert.equal(reason.code, 'invalid_grant');
  assert.equal(requiresReauthentication(reason), true);
  assert.equal(apiError({ error: { code: 'model_not_found' } }, 404).code, 'model_not_found');
});

test('network diagnostics report only allowlisted error facts and OpenAI origin', async t => {
  const output = [];
  t.mock.method(console, 'warn', (message, facts) => output.push({ message, facts }));
  const privateData = 'synthetic-secret-header-body-identity-path';
  const socket = Object.assign(new Error(privateData), { name: 'SocketError', code: 'UND_ERR_SOCKET', path: privateData });
  const aggregate = new AggregateError([socket, Object.assign(new Error(privateData), { code: privateData })], privateData);
  const failure = new TypeError(privateData, { cause: aggregate });
  t.mock.method(globalThis, 'fetch', async () => { throw failure; });

  await assert.rejects(fetchRemote(`https://api.openai.com/v1/models?data=${privateData}`), { code: 'network_error' });
  await assert.rejects(streamResponse('synthetic-token', { model: 'test', input: privateData }, new AbortController().signal), { code: 'network_error' });
  reportTransportFailure(`https://untrusted.example/${privateData}`, failure);

  assert.equal(output.length, 2);
  assert.equal(output[0].facts.origin, 'https://api.openai.com');
  assert.deepEqual(output[0].facts.chain, [
    { name: 'TypeError' }, { name: 'AggregateError' }, { name: 'SocketError', code: 'UND_ERR_SOCKET' }, { name: 'Error' },
  ]);
  assert.equal(output[1].facts.chain[0].name, 'APIConnectionError');
  assert.equal(output[1].facts.chain.some(error => error.code === 'UND_ERR_SOCKET'), true);
  assert.equal(JSON.stringify(output).includes(privateData), false);
  assert.equal(JSON.stringify(output).includes('synthetic-token'), false);
});
