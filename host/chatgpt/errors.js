export class ChatGPTError extends Error {
  constructor(code, message, retryable = false, status, requestId) {
    super(message);
    this.name = 'ChatGPTError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.requestId = requestId;
  }

  toJSON() {
    return {
      code: this.code, message: this.message, retryable: this.retryable,
      ...(this.status !== undefined && { status: this.status }),
      ...(this.requestId && { requestId: this.requestId }),
    };
  }
}

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const invalidSession = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused',
]);
export function requiresReauthentication(error) {
  return invalidSession.has(error?.code);
}

export function asError(error) {
  if (error instanceof ChatGPTError) return error;
  if (error?.name === 'AbortError') return new ChatGPTError('cancelled', '已取消 ChatGPT 请求。');
  return new ChatGPTError('connection_error', 'ChatGPT 连接失败，请重试。', true);
}

const apiMessages = {
  access_denied: '授权已取消。',
  invalid_client: 'OpenAI 未接受当前应用注册。请检查账号连接。',
  invalid_token: '请检查当前 ChatGPT 账号的授权状态。',
  invalid_api_key: '请检查当前 ChatGPT 账号的授权状态。',
  invalid_request_error: 'OpenAI 未接受当前模型或请求参数。',
  invalid_request: 'OpenAI 未接受当前模型或请求参数。',
  model_not_found: '当前账号无法使用此模型，请选择其他模型。',
  subscription_sharing_usage_limit_exceeded: '套餐或应用用量已达上限，请在 ChatGPT 用量设置中查看。',
  subscription_sharing_usage_unavailable: '暂时无法读取套餐用量，请稍后重试。',
  subscription_sharing_user_not_eligible: '当前账号或工作区未获准使用 ChatGPT 套餐。',
  subscription_sharing_invalid_user: '请检查所选账号的套餐和授权状态。',
  subscription_sharing_user_unavailable: '账号或工作区暂时不可用，请稍后重试。',
  subscription_sharing_unsupported_capability: '当前账号或模型不支持这项功能。',
  subscription_sharing_route_not_supported: '套餐授权不支持这项请求。',
  subscription_sharing_client_not_enabled: '当前应用尚未开通套餐授权。',
  chatpass_v2_scope_not_authorized: '此请求需要额外的 ChatGPT 套餐授权。',
  chatpass_v2_invalid_authorization_context: '当前 ChatGPT 账号的授权不适用于此请求。',
};

const temporaryCodes = new Set(['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable']);

export function apiError(body, status, requestId) {
  // Some API errors echo submitted prompts. Only recognized machine codes reach DSH.
  let detail = body;
  for (let level = 0; level < 4 && isObject(detail); level++) {
    if (typeof detail.error === 'string') break;
    if (isObject(detail.error)) detail = detail.error;
    else if (isObject(detail.detail)) detail = detail.detail;
    else break;
  }
  const raw = typeof detail === 'string' ? detail
    : typeof detail?.error === 'string' ? detail.error : detail?.code;
  const normalized = typeof raw === 'string' ? raw.replace(/^subscription_sharing_v2_/, 'subscription_sharing_') : '';
  let code = 'api_error';
  let message = 'OpenAI 未能完成请求，请检查所选账号和模型。';
  let retryable = false;
  if (invalidSession.has(raw)) {
    code = raw;
    message = '此授权已无法续期，请重新连接 ChatGPT 账号。';
  } else if (Object.hasOwn(apiMessages, normalized)) {
    code = raw;
    message = apiMessages[normalized];
    retryable = temporaryCodes.has(normalized);
  } else if (status === 429 || status >= 500) {
    message = status === 429 ? '请求已受限，请稍后再试，或查看 ChatGPT 用量设置。' : 'OpenAI 服务暂时不可用，请稍后重试。';
    retryable = true;
  } else if (status === 401 || status === 403) {
    message = '当前 ChatGPT 连接没有执行此次请求的权限。';
  }
  const id = typeof requestId === 'string' && /^[\w.-]{1,160}$/.test(requestId) ? requestId : undefined;
  return new ChatGPTError(code, message, retryable, status, id);
}

const origins = new Set(['https://auth.openai.com', 'https://api.openai.com']);
const networkClasses = new Set([
  'TypeError', 'AggregateError', 'AbortError', 'TimeoutError', 'SocketError', 'APIConnectionError',
  'APIConnectionTimeoutError', 'APIUserAbortError', 'ConnectTimeoutError', 'HeadersTimeoutError',
  'BodyTimeoutError', 'RequestAbortedError',
]);
const networkCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EPROTO', 'EACCES', 'EPERM', 'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED',
  'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function reportTransportFailure(url, error) {
  const origin = URL.parse(url)?.origin;
  if (!origins.has(origin)) return;
  const pending = [error];
  const seen = new Set();
  const chain = [];
  while (pending.length && chain.length < 6) {
    const entry = pending.shift();
    if (!(entry instanceof Error) || seen.has(entry)) continue;
    seen.add(entry);
    const name = [entry.name, entry.constructor.name].find(key => networkClasses.has(key)) ?? 'Error';
    chain.push(networkCodes.has(entry.code) ? { name, code: entry.code } : { name });
    if (entry.cause) pending.push(entry.cause);
    if (entry instanceof AggregateError) pending.push(...entry.errors.slice(0, 3));
  }
  console.warn('dsh-use-chatgpt: transport failure', { origin, chain });
}

export async function fetchRemote(url, init = {}, timeoutMs = 30_000) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  try {
    return await fetch(url, { ...init, signal, redirect: 'error' });
  } catch (cause) {
    if (init.signal?.aborted) throw new ChatGPTError('cancelled', '已取消 ChatGPT 请求。');
    reportTransportFailure(url, cause);
    throw new ChatGPTError('network_error', '无法连接 OpenAI，请检查网络后重试。', true);
  }
}

export async function jsonResponse(response) {
  try {
    return await response.json();
  } catch (cause) {
    if (cause?.name === 'AbortError') throw asError(cause);
    if (!response.ok) throw apiError(null, response.status, response.headers.get('x-request-id'));
    throw new ChatGPTError('invalid_response', 'OpenAI 返回的数据格式异常。', true, response.status);
  }
}
