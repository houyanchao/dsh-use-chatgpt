import { AsyncLocalStorage } from 'node:async_hooks';
import { extname } from 'node:path';
import { supportsImages } from './images.js';

const requestFiles = new AsyncLocalStorage();
const requestFileBytes = 50_000_000;
const mediaTypes = new Map([
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.dot', 'application/msword'],
  ['.odt', 'application/vnd.oasis.opendocument.text'],
  ['.rtf', 'application/rtf'],
  ['.pages', 'application/vnd.apple.pages'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.odp', 'application/vnd.oasis.opendocument.presentation'],
  ['.key', 'application/vnd.apple.keynote'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/jsonl'],
  ['.ndjson', 'application/x-ndjson'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.xml', 'application/xml'],
  ['.eml', 'message/rfc822'],
]);
const textExtensions = new Set([
  '.txt', '.text', '.log', '.asm', '.bat', '.c', '.cc', '.conf', '.cpp', '.css', '.cxx',
  '.def', '.dic', '.diff', '.go', '.h', '.hh', '.in', '.java', '.js', '.jsx', '.list', '.make',
  '.mjs', '.patch', '.php', '.pl', '.po', '.ps1', '.py', '.rb', '.rs', '.rst', '.sh', '.sql',
  '.toml', '.ts', '.tsx', '.vtt',
]);

function attachmentError(code, message) {
  return Object.assign(new Error(message), { code });
}

function fileMediaType(name) {
  if (typeof name !== 'string') return undefined;
  const extension = extname(name).toLowerCase();
  return mediaTypes.get(extension) ?? (textExtensions.has(extension) ? 'text/plain' : undefined);
}

function inlineFile(block, model) {
  const mediaType = fileMediaType(block.attachment?.name);
  return mediaType !== undefined && (mediaType !== 'application/pdf' || supportsImages(model));
}

function hasInlineFiles(blocks, model) {
  return blocks.some(block => (block.type === 'file' && inlineFile(block, model))
    || (block.type === 'tool-result' && hasInlineFiles(block.content, model)));
}

async function* withFileContext(context, next) {
  const iterator = requestFiles.run(context, () => next()[Symbol.asyncIterator]());
  let complete = false;
  try {
    while (true) {
      const item = await requestFiles.run(context, () => iterator.next());
      if (item.done) {
        complete = true;
        return;
      }
      yield item.value;
    }
  } finally {
    if (!complete) await requestFiles.run(context, () => iterator.return?.());
  }
}

export function mountFileInputs(ctx, providerId) {
  ctx.on('llm/stream', (options, next) => {
    if (options.provider !== providerId || typeof ctx.get('attachments')?.readFileStream !== 'function') return next();
    const messages = new Map(options.messages.filter(message => hasInlineFiles(message.content, options.model))
      .map(message => [message.id, message]));
    if (messages.size === 0) return next();
    return withFileContext({
      provider: options.provider,
      model: options.model,
      sessionId: options.sessionId,
      messages,
      handleText: ref => ctx.llm.fileRequestText(ref),
    }, next);
  }, { global: true });
}

function restoreBlocks(projected, original, { model, handleText }) {
  if (projected.length !== original.length) return projected;
  let restored;
  for (const [index, block] of original.entries()) {
    const current = projected[index];
    let replacement = current;
    if (block.type === 'file' && inlineFile(block, model)
      && current?.type === 'text' && current.text === handleText(block.attachment)) {
      replacement = block;
    } else if (block.type === 'tool-result' && current?.type === 'tool-result'
      && current.toolCallId === block.toolCallId) {
      const content = restoreBlocks(current.content, block.content, { model, handleText });
      if (content !== current.content) replacement = { ...current, content };
    }
    if (replacement !== current) {
      restored ??= [...projected];
      restored[index] = replacement;
    }
  }
  return restored ?? projected;
}

export function restoreFileInputs(options) {
  const context = requestFiles.getStore();
  if (!context || context.provider !== options.provider || context.model !== options.model
    || context.sessionId !== options.sessionId) return options.messages;
  return options.messages.map(message => {
    const original = context.messages.get(message.id);
    if (!original || original.role !== message.role) return message;
    // Restore only the matching host-generated handle in the original block
    // position. Keep the host's image projection and replay filtering intact.
    const content = restoreBlocks(message.content, original.content, context);
    return content === message.content ? message : { ...message, content };
  });
}

export function createFileInputs(attachments, signal) {
  let totalBytes = 0;
  return async ({ attachment }) => {
    signal?.throwIfAborted();
    const { name, bytes } = attachment ?? {};
    if (typeof name !== 'string' || /[/\\\u0000-\u001f]/.test(name) || !Number.isSafeInteger(bytes) || bytes <= 0) {
      throw attachmentError('UNSUPPORTED_CONTENT', '文件附件为空或格式无效。');
    }
    const mediaType = fileMediaType(name);
    if (!mediaType) throw attachmentError('UNSUPPORTED_CONTENT', 'ChatGPT 套餐不支持该附件格式。');
    if (bytes >= requestFileBytes || totalBytes + bytes > requestFileBytes) {
      throw attachmentError('ATTACHMENT_TOO_LARGE', '每个文件须小于 50 MB，单次请求的文件总大小不能超过 50 MB。');
    }
    if (typeof attachments?.readFileStream !== 'function') {
      throw attachmentError('UNSUPPORTED_CONTENT', '当前 DSH 环境无法读取文件附件。');
    }
    totalBytes += bytes;
    const file = Buffer.allocUnsafe(bytes);
    let offset = 0;
    try {
      for await (const chunk of attachments.readFileStream(attachment, signal)) {
        signal?.throwIfAborted();
        if (!(chunk instanceof Uint8Array) || offset + chunk.byteLength > bytes) {
          throw new Error('Invalid attachment length');
        }
        file.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } catch {
      signal?.throwIfAborted();
      throw attachmentError('ATTACHMENT_READ_FAILED', '无法读取文件附件，请重新添加后再试。');
    }
    signal?.throwIfAborted();
    if (offset !== bytes) throw attachmentError('ATTACHMENT_READ_FAILED', '文件附件不完整，请重新添加后再试。');
    if (mediaType === 'application/pdf' && !file.subarray(0, 1024).includes('%PDF-')) {
      throw attachmentError('UNSUPPORTED_CONTENT', '附件内容不是有效的 PDF。');
    }
    return {
      type: 'input_file',
      filename: name,
      file_data: `data:${mediaType};base64,${file.toString('base64')}`,
    };
  };
}
