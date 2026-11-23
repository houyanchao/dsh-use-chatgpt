import { createHash } from 'node:crypto';

const namespace = 'dsh';
const toolNamePattern = /^[a-zA-Z0-9_-]{1,128}$/;
const wireIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const aliasPrefix = 'dsh_tool_';

function toolError(code, message) {
  return Object.assign(new Error(message), { code });
}

function usesOriginalName(name) {
  return toolNamePattern.test(name) && !name.startsWith(aliasPrefix);
}

function responseToolName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw toolError('UNSUPPORTED_TOOL', 'ChatGPT 套餐工具缺少名称。');
  }
  if (usesOriginalName(name)) return name;
  // Preserve the DSH name locally, even for punctuated MCP names.
  return `${aliasPrefix}${createHash('sha256').update(name).digest('base64url')}`;
}

export function toResponsesTools(definitions = []) {
  if (!definitions.length) return [];
  const tools = definitions.map(({ name, description, parameters }) => ({
    type: 'function', name: responseToolName(name), description, parameters, strict: false,
  }));
  return [{ type: 'namespace', name: namespace, description: 'DeepSeek Harness local tools', tools }];
}

export function wireCallId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw toolError('INVALID_TOOL_HISTORY', '会话的工具记录缺少调用标识。');
  }
  if (wireIdPattern.test(id)) return id;
  // Other providers can store composite IDs. Keep each pair bound after translation.
  return `call_dsh_${createHash('sha256').update(id).digest('base64url')}`;
}

export function serializeToolCall({ id, name, arguments: args }) {
  if (typeof name !== 'string' || name.length === 0 || typeof args !== 'string') {
    throw toolError('INVALID_TOOL_HISTORY', '会话的工具调用记录无法发送给 ChatGPT。');
  }
  return { type: 'function_call', call_id: wireCallId(id), name: responseToolName(name), namespace, arguments: args };
}

function toolResultText(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'tool-result') parts.push(toolResultText(block.content));
    else throw toolError('UNSUPPORTED_CONTENT', '请先转换工具结果中的附件，再发送给 ChatGPT。');
  }
  return parts.join('\n');
}

export function serializeToolResult(block, output = toolResultText(block.content)) {
  if (block.isError) {
    const note = 'Tool execution failed.';
    output = typeof output === 'string' ? `${note}\n${output}` : [{ type: 'input_text', text: note }, ...output];
  }
  return { type: 'function_call_output', call_id: wireCallId(block.toolCallId), output };
}

function allowedName(wireName, allowedToolNames) {
  if (usesOriginalName(wireName)) return allowedToolNames.has(wireName) ? wireName : undefined;
  for (const name of allowedToolNames) {
    if (!usesOriginalName(name) && responseToolName(name) === wireName) return name;
  }
}

export function toToolCallBlock(item, allowedToolNames) {
  if (item?.type !== 'function_call' || (item.status != null && item.status !== 'completed') ||
      typeof item.call_id !== 'string' || !wireIdPattern.test(item.call_id) ||
      typeof item.name !== 'string' || !toolNamePattern.test(item.name)) {
    throw toolError('INVALID_TOOL_CALL', 'ChatGPT 返回了不完整的工具调用。');
  }
  const name = allowedName(item.name, allowedToolNames);
  if ((item.namespace != null && item.namespace !== namespace) || name === undefined) {
    throw toolError('UNEXPECTED_TOOL_CALL', 'ChatGPT 请求了当前会话未提供的工具。');
  }
  let parsed;
  try {
    if (typeof item.arguments === 'string') parsed = JSON.parse(item.arguments);
  } catch {
    // Never put the raw argument content in logs or user-visible errors.
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw toolError('INVALID_TOOL_ARGUMENTS', 'ChatGPT 返回的工具参数必须是有效的 JSON 对象。');
  }
  return { type: 'tool-call', id: item.call_id, name, arguments: item.arguments };
}
