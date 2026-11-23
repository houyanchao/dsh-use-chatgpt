import OpenAI from 'openai';
import { apiError, ChatGPTError, isObject, reportTransportFailure } from './errors.js';

const apiRoot = 'https://api.openai.com/v1';
const maxChars = 16 * 1024 * 1024;
const count = value => Number.isSafeInteger(value) && value >= 0;

function buildRequest(options) {
  const input = typeof options.input === 'string' ? [{ role: 'user', content: options.input }] : options.input;
  if (!Array.isArray(input) || !input.every(item => isObject(item) && item.role !== 'system' &&
      (typeof item.type === 'string' || (['developer', 'user', 'assistant'].includes(item.role) &&
       (typeof item.content === 'string' || Array.isArray(item.content)))))) {
    throw new ChatGPTError('invalid_request', 'ChatGPT 输入必须由受支持的消息和工具记录组成。');
  }
  const body = { model: options.model, input, store: false, stream: true };
  if (options.instructions !== undefined) body.instructions = options.instructions;
  if (options.tools !== undefined) body.tools = options.tools;
  if (options.reasoningEffort || options.reasoningSummary) {
    body.reasoning = { effort: options.reasoningEffort, summary: options.reasoningSummary };
    // Stateless tool continuations replay opaque reasoning returned by the API.
    if (options.reasoningEffort !== 'none' && options.tools?.some(tool => tool.type === 'namespace')) {
      body.include = ['reasoning.encrypted_content'];
    }
  }
  if (options.textFormat) body.text = { format: options.textFormat };
  return body;
}

function tokenCounts(usage) {
  if (!count(usage?.input_tokens) || !count(usage?.output_tokens)) return;
  const stats = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  if (usage.total_tokens === stats.inputTokens + stats.outputTokens) stats.totalTokens = usage.total_tokens;
  const cached = usage.input_tokens_details?.cached_tokens;
  const written = usage.input_tokens_details?.cache_write_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  if (count(cached) && cached <= stats.inputTokens) stats.cachedInputTokens = cached;
  if (count(written) && written <= stats.inputTokens - (stats.cachedInputTokens ?? 0)) stats.cacheWriteTokens = written;
  if (count(reasoning) && reasoning <= stats.outputTokens) stats.reasoningTokens = reasoning;
  return stats;
}

function retainCitation(links, note) {
  if (note?.type !== 'url_citation' || typeof note.url !== 'string') return;
  const url = URL.parse(note.url);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
  const href = note.url.trim();
  const title = typeof note.title === 'string' ? note.title.trim() : '';
  if (!links.has(href) || title) links.set(href, title ? { url: href, title } : { url: href });
}

function mergeItems(finished, terminal = []) {
  // Some servers send only the completed items; others repeat a subset in the final event.
  const ordered = [...finished].sort(([left], [right]) => left - right);
  const itemIds = new Set(ordered.map(([, item]) => item.call_id || item.id).filter(Boolean));
  if (Array.isArray(terminal)) {
    for (const [index, item] of terminal.entries()) {
      if (typeof item?.type !== 'string') continue;
      const id = item.call_id || item.id;
      if (id ? itemIds.has(id) : finished.has(index)) continue;
      ordered.push([index, item]);
      if (id) itemIds.add(id);
    }
  }
  return ordered.sort(([left], [right]) => left - right).map(([, item]) => item);
}

function collectItemCitations(links, item) {
  if (item?.type !== 'message' || !Array.isArray(item.content)) return;
  for (const part of item.content) {
    if (part?.type === 'output_text' && Array.isArray(part.annotations)) {
      for (const annotation of part.annotations) retainCitation(links, annotation);
    }
  }
}

const tooLarge = () => new ChatGPTError('response_too_large', 'ChatGPT 返回的内容过长，请缩小请求。');

async function readEvents(stream, options, signal, requestId) {
  const finished = new Map();
  const summaries = new Map();
  const links = new Map();
  let summaryChars = 0;
  let text = '';

  function appendText(delta) {
    if (typeof delta !== 'string' || !delta) return;
    if (text.length + delta.length > maxChars) throw tooLarge();
    text += delta;
    options.onDelta?.(delta);
  }

  function collectSummary(event) {
    if (!count(event.output_index) || !count(event.summary_index)) return;
    const key = `${event.output_index}/${event.summary_index}`;
    const old = summaries.get(key)?.text ?? '';
    const isDelta = event.type.endsWith('.delta');
    const value = isDelta ? event.delta : event.text;
    if (typeof value !== 'string') return;
    const next = isDelta ? old + value : value;
    const delta = next.startsWith(old) ? next.slice(old.length) : '';
    const prefix = !old && summaryChars ? '\n\n' : '';
    summaryChars += next.length - old.length;
    if (summaryChars > maxChars) throw tooLarge();
    summaries.set(key, { item: event.output_index, part: event.summary_index, text: next });
    if (delta) options.onReasoningDelta?.(prefix + delta);
  }

  for await (const event of stream) {
    signal.throwIfAborted();
    switch (event?.type) {
      case 'response.refusal.delta':
      case 'response.output_text.delta':
        appendText(event.delta);
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_summary_text.done':
        collectSummary(event);
        break;
      case 'response.output_text.annotation.added':
        retainCitation(links, event.annotation);
        break;
      case 'response.output_item.done':
        if (count(event.output_index) && typeof event.item?.type === 'string') {
          finished.set(event.output_index, event.item);
          collectItemCitations(links, event.item);
        }
        break;
      case 'error':
      case 'response.failed':
        throw apiError(event.response ?? event, undefined, requestId);
      case 'response.incomplete':
        throw new ChatGPTError('response_incomplete', 'ChatGPT 未完成本次回答，请重试。', true);
      case 'response.completed': {
        const output = mergeItems(finished, event.response?.output);
        if (Array.isArray(event.response?.output)) {
          // The terminal snapshot may add citations to an item already marked done.
          for (const item of event.response.output) collectItemCitations(links, item);
        }
        let finalText = '';
        const finalSummary = [];
        for (const item of output) {
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part?.type === 'output_text') {
                if (typeof part.text === 'string') finalText += part.text;
              } else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
                finalText += part.refusal;
              }
            }
          }
          if (item.type === 'reasoning' && Array.isArray(item.summary)) {
            for (const part of item.summary) {
              if (part?.type === 'summary_text' && typeof part.text === 'string') finalSummary.push(part.text);
            }
          }
        }
        if (finalText.startsWith(text)) appendText(finalText.slice(text.length));
        const collected = [...summaries.values()].sort((a, b) => a.item - b.item || a.part - b.part);
        const summary = collected.length ? collected.map(part => part.text).join('\n\n') : finalSummary.join('\n\n');
        if (summary.length > maxChars) throw tooLarge();
        if (summary && !collected.length) options.onReasoningDelta?.(summary);
        const usage = tokenCounts(event.response?.usage);
        return {
          text,
          ...(output.length && { output }),
          ...(links.size && { citations: [...links.values()] }),
          ...(summary && { reasoningSummary: summary }),
          ...(usage && { usage }),
        };
      }
    }
  }
  throw new ChatGPTError('stream_interrupted', 'ChatGPT 连接提前结束，请重试。', true);
}

export async function streamResponse(accessToken, options, signal) {
  const body = buildRequest(options);
  // SIWC requests always use the selected ChatGPT grant. Environment API keys,
  // project headers and SDK debug logging must not affect this request.
  const client = new OpenAI({
    baseURL: apiRoot, apiKey: accessToken, adminAPIKey: null, organization: null, project: null,
    maxRetries: 0, logLevel: 'off', fetchOptions: { redirect: 'error' },
    defaultHeaders: {
      authorization: `Bearer ${accessToken}`, 'openai-organization': null, 'openai-project': null,
    },
  });
  const timeout = AbortSignal.timeout(180_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let receivedHeaders = false;
  try {
    requestSignal.throwIfAborted();
    const { data, response, request_id: requestId } = await client.responses.create(body, {
      headers: { accept: 'text/event-stream' }, signal: requestSignal,
    }).withResponse();
    receivedHeaders = true;
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!response.body || (mime && mime !== 'text/event-stream')) {
      await response.body?.cancel();
      throw new ChatGPTError('invalid_stream', 'OpenAI 返回了无法读取的对话流。', true);
    }
    const result = await readEvents(data, options, requestSignal, requestId);
    requestSignal.throwIfAborted();
    return result;
  } catch (cause) {
    if (signal?.aborted) throw new ChatGPTError('cancelled', '已取消 ChatGPT 请求。');
    if (timeout.aborted) throw new ChatGPTError('network_error', 'ChatGPT 响应超时，请重试。', true);
    if (cause instanceof ChatGPTError) throw cause;
    if (cause instanceof OpenAI.APIError && !(cause instanceof OpenAI.APIConnectionError) &&
        !(cause instanceof OpenAI.APIUserAbortError)) {
      throw apiError(cause.error, cause.status, cause.requestID);
    }
    reportTransportFailure(apiRoot, cause);
    if (!receivedHeaders) throw new ChatGPTError('network_error', '无法连接 OpenAI，请检查网络。', true);
    throw new ChatGPTError('stream_interrupted', 'ChatGPT 响应中断，请重试。', true);
  }
}
