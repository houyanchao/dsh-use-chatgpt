import assert from 'node:assert/strict';
import test from 'node:test';
import { createFileInputs, mountFileInputs, restoreFileInputs } from '../host/files.js';
import { createImageInputs, supportsImages } from '../host/images.js';

const provider = 'chatgpt-plan';
const model = 'gpt-6.2-sol';
const text = value => ({ type: 'text', text: value });

test('image inputs use both DSH rendition contracts and reject oversized encoded bytes', async () => {
  const attachment = { attachmentId: 'image', mediaType: 'image/png', bytes: 3, width: 1, height: 1 };
  const signal = new AbortController().signal;
  let data = Uint8Array.of(1, 2, 3);
  const imageInput = createImageInputs({
    async readImageRequest(ref, policy, actualSignal) {
      assert.equal(ref, attachment);
      assert.deepEqual(policy, {
        width: 2048, height: 2048, maxImageBytes: 4 * 1024 * 1024, imageTargetBytes: 4 * 1024 * 1024,
        maxPixels: 2048 * 2048, maxBytes: 4 * 1024 * 1024,
      });
      assert.equal(actualSignal, signal);
      return { variantId: 'rendered', attachment: ref, mediaType: 'image/png', data, width: 1, height: 1,
        bytes: data.byteLength, depth: 'uchar', space: 'srgb', hasAlpha: true };
    },
  }, signal);
  assert.equal(supportsImages(model), true);
  assert.equal(supportsImages('unknown-model'), false);
  assert.deepEqual(await imageInput({ attachment }), {
    type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'auto',
  });
  data = new Uint8Array(4 * 1024 * 1024 + 1);
  await assert.rejects(imageInput({ attachment }), { code: 'ATTACHMENT_TOO_LARGE' });
});

test('native file inputs preserve exact bytes and reject malformed or oversized files', async () => {
  const pdf = Buffer.from('%PDF-1.4\n');
  let bytes = pdf;
  let reads = 0;
  const fileInput = createFileInputs({
    async *readFileStream() {
      reads += 1;
      yield bytes.subarray(0, 3);
      yield bytes.subarray(3);
    },
  });
  const attachment = { name: 'document.pdf', bytes: pdf.length };
  assert.deepEqual(await fileInput({ attachment }), {
    type: 'input_file', filename: attachment.name, file_data: `data:application/pdf;base64,${pdf.toString('base64')}`,
  });
  await assert.rejects(fileInput({ attachment: { ...attachment, bytes: 50_000_000 } }), { code: 'ATTACHMENT_TOO_LARGE' });
  assert.equal(reads, 1);
  bytes = Buffer.alloc(pdf.length);
  await assert.rejects(fileInput({ attachment }), { code: 'UNSUPPORTED_CONTENT' });
  bytes = pdf.subarray(1);
  await assert.rejects(fileInput({ attachment }), { code: 'ATTACHMENT_READ_FAILED' });
});

test('file restoration is scoped to each stream and preserves text, image projection and replay filtering', async () => {
  let middleware;
  let attachments = { readFileStream() {} };
  const handle = ref => `[File ${ref.name}]`;
  mountFileInputs({
    llm: { fileRequestText: handle },
    get: () => attachments,
    on(event, callback) {
      assert.equal(event, 'llm/stream');
      middleware = callback;
    },
  }, provider);

  function stream(name, selectedModel = model) {
    const file = { type: 'file', attachment: { name, bytes: 10 } };
    const toolResult = { type: 'tool-result', toolCallId: 'call', content: [file, text('result')] };
    const message = {
      id: 'same-message-id', role: 'user', source: { kind: 'tool', callId: 'call' },
      content: [text('before'), file, { type: 'image' }, toolResult, text('after')],
    };
    const options = { model: selectedModel, provider, sessionId: name, messages: [message] };
    return middleware(options, async function* () {
      await new Promise(resolve => setImmediate(resolve));
      const fileText = text(handle(file.attachment));
      const imageProjection = text('placeholder');
      const projected = {
        ...message, source: { ...message.source, projected: true },
        content: [message.content[0], fileText, imageProjection, { ...toolResult, content: [fileText, text('result')] }, message.content[4]],
      };
      yield restoreFileInputs({ ...options, messages: [projected] })[0];
    })[Symbol.asyncIterator]();
  }

  const a = stream('a.pdf');
  const b = stream('b.pdf');
  const [first, second] = await Promise.all([a.next(), b.next()]);
  for (const [result, name] of [[first, 'a.pdf'], [second, 'b.pdf']]) {
    assert.equal(result.value.source.projected, true);
    assert.deepEqual(result.value.content.map(block => block.type), ['text', 'file', 'text', 'tool-result', 'text']);
    assert.equal(result.value.content[1].attachment.name, name);
    assert.equal(result.value.content[2].text, 'placeholder');
    assert.equal(result.value.content[3].content[0].attachment.name, name);
  }
  await Promise.all([a.return(), b.return()]);

  for (const input of [stream('document.pdf', 'text-only'), stream('document.exe')]) {
    const item = await input.next();
    assert.equal(item.value.content[1].type, 'text');
    await input.return();
  }
  attachments = undefined;
  const unsupported = stream('document.pdf');
  assert.equal((await unsupported.next()).value.content[1].type, 'text');
  await unsupported.return();
});
