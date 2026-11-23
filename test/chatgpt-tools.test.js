import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeToolCall, serializeToolResult, toResponsesTools, toToolCallBlock } from '../host/tools.js';

test('DSH tool declarations preserve optional parameters in the SIWC namespace', () => {
  assert.deepEqual(toResponsesTools(), []);
  const parameters = { type: 'object', properties: { query: { type: 'string' } } };
  assert.deepEqual(toResponsesTools([{ name: 'lookup', description: 'Find a value', parameters }]), [{
    type: 'namespace', name: 'dsh', description: 'DeepSeek Harness local tools', tools: [
      { type: 'function', name: 'lookup', description: 'Find a value', parameters, strict: false },
    ],
  }]);
  assert.throws(() => toResponsesTools([{ name: '', description: '', parameters }]), { code: 'UNSUPPORTED_TOOL' });
});

test('punctuated and reserved names use stable aliases without confusing the DSH registry', () => {
  const localName = 'my-mcp.tool';
  const aliases = names => toResponsesTools(names.map(name => ({ name, description: '', parameters: {} })))
    .flatMap(namespace => namespace.tools.map(tool => tool.name));
  const [alias] = aliases([localName]);
  assert.match(alias, /^dsh_tool_[a-zA-Z0-9_-]+$/);
  const [reused, escaped] = aliases([localName, alias]);
  assert.equal(reused, alias);
  assert.notEqual(escaped, alias);
  const wireCall = serializeToolCall({ id: 'call_123', name: localName, arguments: '{}' });
  assert.equal(wireCall.name, alias);
  assert.equal(toToolCallBlock(wireCall, new Set([localName, alias])).name, localName);
  assert.equal(toToolCallBlock({ ...wireCall, name: escaped }, new Set([alias])).name, alias);
  assert.throws(() => toToolCallBlock(wireCall, new Set([alias])), { code: 'UNEXPECTED_TOOL_CALL' });
});

test('history keeps a stable call pair across providers and supports projected tool output', () => {
  const id = `call_123|${'old_item_'.repeat(10)}`;
  const call = serializeToolCall({ id, name: 'lookup', arguments: '{ "query": "example" }' });
  const result = { toolCallId: id, isError: true, content: [{ type: 'text', text: 'It was not found' }] };
  assert.equal(call.call_id, serializeToolCall({ id, name: 'lookup', arguments: '{}' }).call_id);
  assert.match(call.call_id, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(call.arguments, '{ "query": "example" }');
  assert.deepEqual(serializeToolResult(result), {
    type: 'function_call_output', call_id: call.call_id, output: 'Tool execution failed.\nIt was not found',
  });
  const image = { type: 'input_image', image_url: 'data:image/png;base64,AQ==' };
  assert.deepEqual(serializeToolResult(result, [image]).output, [{ type: 'input_text', text: 'Tool execution failed.' }, image]);
  assert.equal(serializeToolResult({ ...result, toolCallId: 'call_original', isError: false }).call_id, 'call_original');
});

test('completed calls use the authorized DSH schema name and retain raw JSON after validation', () => {
  const allowedNames = new Set(['lookup']);
  const item = {
    type: 'function_call', id: 'fc_456', call_id: 'call_123', namespace: 'dsh',
    name: 'lookup', arguments: ' { "query": "example" } ', status: 'completed',
  };
  assert.deepEqual(toToolCallBlock(item, allowedNames), {
    type: 'tool-call', id: 'call_123', name: 'lookup', arguments: item.arguments,
  });
  assert.throws(() => toToolCallBlock({ ...item, name: 'unknown' }, allowedNames), { code: 'UNEXPECTED_TOOL_CALL' });
  assert.throws(() => toToolCallBlock({ ...item, namespace: 'other' }, allowedNames), { code: 'UNEXPECTED_TOOL_CALL' });
  assert.throws(() => toToolCallBlock({ ...item, status: 'incomplete' }, allowedNames), { code: 'INVALID_TOOL_CALL' });
  for (const args of ['[1]', '{', 'null', '"not an object"', undefined]) {
    assert.throws(() => toToolCallBlock({ ...item, arguments: args }, allowedNames), { code: 'INVALID_TOOL_ARGUMENTS' });
  }
});
