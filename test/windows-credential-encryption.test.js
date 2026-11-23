import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createWindowsCredentialEncryption } from '../host/windows-credential-encryption.js';

const sample = '{"accessToken":"示例凭据"}';
const ciphertext = Buffer.from([0x00, 0xaa, 0x11, 0xff]);

function mockWindowsShell(t, handleInput) {
  const root = process.env.SystemRoot;
  process.env.SystemRoot = 'D:\\Windows';
  t.after(() => {
    if (root === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = root;
  });
  const calls = [];
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    const stdin = new PassThrough();
    const chunks = [];
    stdin.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
    void once(stdin, 'end').then(() => {
      const input = Buffer.concat(chunks);
      const code = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      const operation = code.match(/^\$operation = '([a-z]+)'$/m)?.[1];
      const call = { file, args, options, operation, code, entropy: input.subarray(0, 32), bytes: input.subarray(32) };
      calls.push(call);
      return handleInput(call);
    }).then(stdout => callback(null, stdout), callback);
    return { stdin };
  });
  return calls;
}

test('Windows credentials pass only through pipes to a fixed Windows system executable', async t => {
  const calls = mockWindowsShell(t, ({ operation, bytes }) => {
    if (operation === 'encrypt') return ciphertext;
    if (operation === 'decrypt') return Buffer.from(sample);
    return Buffer.from(bytes);
  });
  const provider = createWindowsCredentialEncryption();
  assert.deepEqual(await Promise.all([provider.isAvailable(), provider.isAvailable(), provider.isAvailable()]), [true, true, true]);
  assert.equal(await provider.isAvailable(), true);
  assert.deepEqual(await provider.encrypt(sample), ciphertext);
  assert.equal(await provider.decrypt(ciphertext), sample);
  assert.deepEqual(calls.map(call => call.operation), ['probe', 'encrypt', 'decrypt']);
  assert.equal(calls[1].bytes.toString(), sample);
  assert.deepEqual(calls[2].bytes, ciphertext);
  for (const call of calls) {
    assert.equal(call.file, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(call.args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(call.options.windowsHide, true);
    assert.match(call.code, /DataProtectionScope\]::CurrentUser/);
    assert.ok(!call.code.includes(sample));
    assert.ok(!JSON.stringify(call.options.env).includes(sample));
    assert.deepEqual(call.entropy, calls[0].entropy);
  }
});

test('Windows credential failures keep child output private and permit a new availability probe', async t => {
  let broken = true;
  const calls = mockWindowsShell(t, ({ bytes }) => {
    if (broken) throw Object.assign(new Error(sample), { stdout: Buffer.from(sample) });
    return Buffer.from(bytes);
  });
  const provider = createWindowsCredentialEncryption();
  assert.equal(await provider.isAvailable(), false);
  await assert.rejects(provider.encrypt(sample), { message: 'Windows credential protection is unavailable.' });
  broken = false;
  assert.equal(await provider.isAvailable(), true);
  assert.deepEqual(calls.map(call => call.operation), ['probe', 'encrypt', 'probe']);
});

test('Windows DPAPI encrypts and decrypts across provider instances and rejects tampering', {
  skip: process.platform !== 'win32',
  timeout: 60_000,
}, async () => {
  const provider = createWindowsCredentialEncryption();
  assert.equal(await provider.isAvailable(), true);
  const sealed = await provider.encrypt(sample);
  assert.ok(!sealed.includes(Buffer.from(sample)));
  const reopened = createWindowsCredentialEncryption();
  assert.equal(await reopened.decrypt(sealed), sample);
  sealed[sealed.length - 1] ^= 1;
  await assert.rejects(reopened.decrypt(sealed));
});
