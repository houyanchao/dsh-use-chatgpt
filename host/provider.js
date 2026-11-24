import { createFileInputs, restoreFileInputs } from './files.js';
import { createImageInputs, requestImageTarget, supportsImages } from './images.js';
import { serializeToolCall, serializeToolResult, toResponsesTools, toToolCallBlock } from './tools.js';

export const providerId = 'chatgpt-plan';
const catalogTtlMs = 60_000;

const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const effortNames = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const modelsWithReasoning = new Map([
  ...['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-astra'].map(id => [id, efforts]),
  ...['gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
    .map(id => [id, ['none', ...efforts]]),
]);

export function planEnabled(session) {
  return session.status === 'connected' && session.sharing === true;
}

export function pluginError(code, message) {
  return Object.assign(new Error(message), { code });
}

function reasoningForTool(message, index, model, profileId) {
  const source = message.source;
  if (source?.kind !== 'model' || source.provider !== providerId || source.model !== model) return [];
  if (!profileId || source.replayState?.response?.profileId !== profileId) return [];
  const retained = source.replayState?.blocks?.[index];
  if (retained?.callId !== message.content[index].id || !Array.isArray(retained.reasoning)) return [];
  return retained.reasoning.filter(item => item?.type === 'reasoning'
    && typeof item.id === 'string' && typeof item.encrypted_content === 'string'
    && Array.isArray(item.summary));
}

async function responseInput(options, attachments, signal, profileId) {
  const messages = restoreFileInputs(options);
  const input = options.system ? [{ role: 'developer', content: options.system }] : [];
  const imageInput = createImageInputs(attachments, signal);
  const fileInput = createFileInputs(attachments, signal);
  const toolResults = new Set(messages.flatMap(message => message.content
    .filter(block => block.type === 'tool-result').map(block => block.toolCallId)));
  const pending = new Set();

  async function contentPart(block) {
    if (block.type === 'text') return { type: 'input_text', text: block.text };
    if (block.type === 'image') return imageInput(block);
    if (block.type === 'file') return fileInput(block);
  }

  for (const message of messages) {
    const role = message.role === 'system' ? 'developer' : message.role;
    const parts = [];
    function flush() {
      if (!parts.length) return;
      const content = parts.every(part => part.type === 'input_text')
        ? parts.map(part => part.text).join('\n')
        : [...parts];
      input.push({ role, content });
      parts.length = 0;
    }
    for (const [index, block] of message.content.entries()) {
      signal.throwIfAborted();
      if (block.type === 'tool-call' && toolResults.has(block.id)) {
        flush();
        input.push(...reasoningForTool(message, index, options.model, profileId), serializeToolCall(block));
        pending.add(block.id);
      } else if (block.type === 'tool-result' && pending.delete(block.toolCallId)) {
        flush();
        const output = [];
        for (const resultBlock of block.content) {
          const part = await contentPart(resultBlock);
          if (part) output.push(part);
        }
        const result = output.every(part => part.type === 'input_text') ? output.map(part => part.text).join('\n') : output;
        input.push(serializeToolResult(block, result));
      } else {
        const part = await contentPart(block);
        if (part) parts.push(part);
      }
    }
    flush();
  }
  return input;
}

function responseEvents(client, options) {
  const { signal } = options;
  let cancelled = false;
  return new ReadableStream({
    start(output) {
      const conclude = event => {
        if (cancelled) return;
        output.enqueue(event);
        output.close();
      };
      void Promise.resolve().then(() => client.streamResponse({
        ...options,
        onDelta: text => {
          if (text && !signal.aborted && !cancelled) output.enqueue({ type: 'text', delta: text });
        },
        onReasoningDelta: text => {
          if (text && !signal.aborted && !cancelled) output.enqueue({ type: 'reasoning', delta: text });
        },
      })).then(
        result => conclude({ done: true, result }),
        error => conclude({ error }),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
}

function modelInfo(id, name = id, reasoningEfforts = modelsWithReasoning.get(id)) {
  return {
    provider: providerId,
    id,
    name,
    inputModalities: supportsImages(id) ? ['text', 'image'] : ['text'],
    ...(reasoningEfforts?.length ? { reasoning: { efforts: reasoningEfforts.map(id => ({ id, name: effortNames[id] })) } } : {}),
  };
}

function tokenUsage(usage) {
  const { inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheWriteTokens, reasoningTokens } = usage;
  return {
    inputTokens: inputTokens - (cachedInputTokens ?? 0) - (cacheWriteTokens ?? 0),
    outputTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cacheReadTokens: cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function completedToolCalls(output, toolNames) {
  const calls = [];
  const ids = new Set();
  let reasoning = [];
  for (const item of output ?? []) {
    if (item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && typeof item.id === 'string') {
      reasoning.push({ type: 'reasoning', id: item.id, summary: [], encrypted_content: item.encrypted_content });
    }
    if (item?.type !== 'function_call') continue;
    const block = toToolCallBlock(item, toolNames);
    if (ids.has(block.id)) throw pluginError('INVALID_TOOL_CALL', 'ChatGPT 返回了重复的工具调用。');
    ids.add(block.id);
    calls.push({ block, reasoning });
    reasoning = [];
  }
  return calls;
}

function sourceLinks(citations) {
  const urls = new Set();
  for (const citation of citations ?? []) {
    try {
      const url = new URL(citation.url);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
        urls.add(url.href.replace(/[<>]/g, character => encodeURIComponent(character)));
      }
    } catch {
      // Drop malformed or non-link annotation metadata.
    }
  }
  return urls.size ? `\n\n${[...urls].map((url, index) => `[${index + 1}](<${url}>)`).join(' · ')}` : '';
}

export function createProvider(client, getSession, lifetime, {
  getAttachments = () => undefined,
  getPreferences = () => ({}),
  getChatOwner,
  getHiddenModels = () => new Set(),
  onUsage,
} = {}) {
  let catalog;

  async function fetchModels(signal, profileId) {
    const entries = await client.listModels({ signal, expectedProfileId: profileId });
    signal.throwIfAborted();
    const models = new Map();
    for (const model of entries) {
      if (!models.has(model.slug)) models.set(model.slug, modelInfo(model.slug, model.displayName, model.reasoningEfforts));
    }
    return [...models.values()];
  }

  async function loadModels(session, force) {
    const { accountSignal, profileId } = session;
    if (!planEnabled(session)) {
      if (catalog?.accountSignal === accountSignal) catalog = undefined;
      return [];
    }
    const signal = accountSignal ? AbortSignal.any([lifetime, accountSignal]) : lifetime;
    signal.throwIfAborted();
    if (!profileId || !accountSignal) return fetchModels(signal, profileId);

    const sameAccount = catalog?.profileId === profileId && catalog.accountSignal === accountSignal;
    const refreshCached = force && Number.isFinite(catalog?.expiresAt);
    if (!sameAccount || refreshCached || catalog.expiresAt <= performance.now()) {
      const entry = { profileId, accountSignal, expiresAt: Infinity };
      entry.result = fetchModels(signal, profileId).then(models => {
        entry.expiresAt = performance.now() + catalogTtlMs;
        return models;
      }, error => {
        if (catalog === entry) catalog = undefined;
        throw error;
      });
      catalog = entry;
    }
    const models = await catalog.result;
    signal.throwIfAborted();
    return structuredClone(models);
  }

  async function resolveForSession(session, model) {
    const entries = await loadModels(session, false);
    return entries.find(entry => entry.id === model) ?? modelInfo(model);
  }

  async function listVisibleModels(session) {
    const models = await loadModels(session, false);
    session.accountSignal?.throwIfAborted();
    if (!session.profileId || models.length === 0) return models;
    const hidden = getHiddenModels(session.profileId);
    return models.filter(model => !hidden.has(model.id));
  }

  return {
    providerInfo: id => ({ id, name: 'ChatGPT 套餐' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => ({
      ...requestImageTarget,
      width: Math.min(image.width, requestImageTarget.width),
      height: Math.min(image.height, requestImageTarget.height),
    }),
    async listModels() {
      const session = await getSession();
      try {
        return await listVisibleModels(session);
      } catch (error) {
        if (error?.code !== 'network_error') throw error;
        lifetime.throwIfAborted();
        session.accountSignal?.throwIfAborted();
        return [];
      }
    },
    async listSelectableModels() {
      return listVisibleModels(await getSession());
    },
    async listPlanModels(force = false) {
      return loadModels(await getSession(), force);
    },
    async resolveModel(_provider, model, signal) {
      signal?.throwIfAborted();
      const entry = await resolveForSession(await getSession(), model);
      signal?.throwIfAborted();
      return entry;
    },
    async prepareCall(provider, model, signal) {
      return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) };
    },
    async *stream(options) {
      const request = new AbortController();
      let signal = AbortSignal.any([request.signal, lifetime, ...(options.signal ? [options.signal] : [])]);
      let accountSignal;
      const outputBlocks = new Map();
      try {
        signal.throwIfAborted();
        const session = await getSession();
        if (!planEnabled(session)) {
          throw pluginError('sharing_not_enabled', '请先在侧边栏的 ChatGPT 页面登录并授权使用套餐。');
        }
        accountSignal = session.accountSignal;
        if (accountSignal) signal = AbortSignal.any([signal, accountSignal]);
        if (options.sessionId?.startsWith('chatgpt-') && getChatOwner?.(options.sessionId) !== session.profileId) {
          throw pluginError('profile_changed', '请切换回创建此会话的 ChatGPT 账号。');
        }
        signal.throwIfAborted();
        const { model, reasoningEffort } = options;
        const useCatalog = reasoningEffort !== undefined || (catalog && catalog.profileId === session.profileId);
        const modelDetails = useCatalog
          ? await resolveForSession(session, model) : modelInfo(model);
        if (reasoningEffort !== undefined && !modelDetails.reasoning?.efforts.some(effort => effort.id === reasoningEffort)) {
          throw pluginError('UNSUPPORTED_REASONING_EFFORT', '该 ChatGPT 模型不支持所选推理等级。');
        }
        const tools = toResponsesTools(options.tools);
        const { webSearch } = options.purpose ? {} : await getPreferences(options.sessionId, session.profileId);
        if (webSearch) tools.push({ type: 'web_search' });
        const reasoningSummary = !options.purpose && modelDetails.reasoning && reasoningEffort !== 'none'
          ? 'auto' : undefined;
        const input = await responseInput(options, getAttachments(), signal, session.profileId);
        signal.throwIfAborted();
        const events = responseEvents(client, {
          input, model, reasoningEffort, reasoningSummary, tools: tools.length ? tools : undefined, signal,
          expectedProfileId: session.profileId,
        });
        for await (const event of events) {
          signal.throwIfAborted();
          if (event.error) throw event.error;
          if (event.delta) {
            if (!outputBlocks.has(event.type)) {
              const index = outputBlocks.size;
              outputBlocks.set(event.type, index);
              yield { type: 'block-start', index, blockType: event.type };
            }
            yield { type: `${event.type}-delta`, index: outputBlocks.get(event.type), text: event.delta };
          }
          if (event.done) {
            const { text, reasoningSummary: summary, usage, output, citations } = event.result;
            const calls = completedToolCalls(output, new Set(options.tools?.map(tool => tool.name)));
            const links = sourceLinks(citations);
            const completed = { text: text + links, reasoning: summary ?? '' };
            for (const [type, value] of Object.entries(completed)) {
              const index = outputBlocks.get(type);
              if (index === undefined && value) {
                const newIndex = outputBlocks.size;
                outputBlocks.set(type, newIndex);
                yield { type: 'block-start', index: newIndex, blockType: type };
                yield { type: `${type}-delta`, index: newIndex, text: value };
              } else if (type === 'text' && index !== undefined && links) {
                yield { type: 'text-delta', index, text: links };
              }
            }
            if (!completed.text && calls.length === 0) throw pluginError('EMPTY_RESPONSE', 'ChatGPT 没有返回可显示的内容。');
            const blocks = [];
            for (const [type, index] of outputBlocks) {
              yield { type: 'block-end', index, block: { type, text: completed[type] } };
              blocks.push(null);
            }
            for (const { block, reasoning } of calls) {
              const index = blocks.length;
              yield { type: 'block-start', index, blockType: 'tool-call' };
              yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
              yield { type: 'block-end', index, block };
              blocks.push(reasoning.length ? { callId: block.id, reasoning } : null);
            }
            if (usage) {
              const counts = tokenUsage(usage);
              try { onUsage?.(session.profileId, model, counts); } catch (error) {
                console.warn('dsh-use-chatgpt: could not save usage counters', error?.code ?? 'storage_error');
              }
              yield { type: 'usage', usage: counts };
            }
            yield {
              type: 'finish',
              reason: { kind: calls.length ? 'tool-calls' : 'stop' },
              ...(blocks.some(Boolean) && session.profileId ? { replayState: { response: { profileId: session.profileId }, blocks } } : {}),
            };
            return;
          }
        }
      } catch (error) {
        const aborted = signal.aborted;
        const cancelledMessage = lifetime.aborted ? 'DSH 已重新载入插件，本轮已停止。请重新发送。'
          : accountSignal?.aborted ? '账号连接已改变，本轮已停止。' : '已停止本轮 ChatGPT 请求。';
        const failure = aborted ? { code: 'ABORTED', message: cancelledMessage }
          : error?.code === 'cancelled' ? { code: 'stream_interrupted', message: 'ChatGPT 提前结束了连接，请重新发送。' } : {
          code: typeof error?.code === 'string' ? error.code : 'CHATGPT_REQUEST_FAILED',
          message: error?.code === 'network_error' ? '暂时连接不上 OpenAI，请检查网络后重试本轮。'
            : typeof error?.code === 'string' ? error.message : 'ChatGPT 请求失败，请重试。',
          ...(typeof error?.status === 'number' ? { status: error.status } : {}),
          ...(typeof error?.requestId === 'string' ? { requestId: error.requestId } : {}),
        };
        yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure } };
      } finally {
        request.abort();
      }
    },
  };
}
