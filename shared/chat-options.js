export const defaultChatOptions = Object.freeze({ webSearch: false, jsonSchema: '' });

function invalidFeatures(message) {
  return Object.assign(new Error(message), { code: 'invalid_features' });
}

export function validateFeatures(value) {
  if (typeof value?.webSearch !== 'boolean' || typeof value.jsonSchema !== 'string') {
    throw invalidFeatures('请提供联网搜索设置和有效的 JSON Schema。');
  }
  const jsonSchema = value.jsonSchema.trim();
  if (new TextEncoder().encode(jsonSchema).byteLength > 64 * 1024) throw invalidFeatures('JSON Schema 不能超过 64 KiB。');
  if (jsonSchema) {
    let schema;
    try {
      schema = JSON.parse(jsonSchema);
    } catch {
      throw invalidFeatures('JSON Schema 不是有效的 JSON。');
    }
    if (schema?.type !== 'object' || !schema.properties || typeof schema.properties !== 'object'
      || Array.isArray(schema.properties) || schema.additionalProperties !== false
      || !Array.isArray(schema.required) || schema.required.length !== Object.keys(schema.properties).length
      || new Set(schema.required).size !== schema.required.length
      || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key))) {
      throw invalidFeatures('Schema 根节点须为 object，设置 additionalProperties 为 false，并在 required 中列出全部属性。');
    }
  }
  return { webSearch: value.webSearch, jsonSchema };
}

export function mergeChatOptions(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length
    || Object.keys(patch).some(key => key !== 'webSearch' && key !== 'jsonSchema')) {
    throw invalidFeatures('无效的对话选项。');
  }
  return validateFeatures({ ...current, ...patch });
}
