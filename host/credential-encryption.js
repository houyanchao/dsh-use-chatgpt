import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createWindowsCredentialEncryption } from './windows-credential-encryption.js';

const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../native/credential-key', import.meta.url));
const universalHelper = fileURLToPath(new URL('../native/credential-key-universal', import.meta.url));
const providerId = 'dsh-macos-keychain-aes256gcm-v1';
const nonceLength = 12;
const tagLength = 16;

export function createCredentialEncryption(options) {
  if (process.platform === 'win32') return createWindowsCredentialEncryption();
  return createMacCredentialEncryption(options);
}

/** The Keychain holds a separate random key for each SDK storage directory. */
function createMacCredentialEncryption({ storageDir }) {
  const account = createHash('sha256').update(resolve(storageDir)).digest('hex');
  const aad = Buffer.from(`${providerId}:${account}`);

  let activeHelper = helper;

  function invoke(executable, operation) {
    return exec(executable, [operation, account], {
      encoding: 'buffer',
      maxBuffer: 4096,
      timeout: 15_000,
      env: {},
    });
  }

  async function readKey(operation) {
    if (process.platform !== 'darwin') throw new Error('macOS Keychain is unavailable');
    let result;
    try {
      result = await invoke(activeHelper, operation);
    } catch (error) {
      // An older macOS or a different CPU can prevent the legacy binary from
      // launching. Preserve actual Keychain errors and permission decisions.
      if (activeHelper === universalHelper || error.killed
        || (typeof error.code !== 'string' && error.signal !== 'SIGABRT')) throw error;
      activeHelper = universalHelper;
      result = await invoke(activeHelper, operation);
    }
    const { stdout } = result;
    if (stdout.length !== 32) {
      stdout.fill(0);
      throw new Error('macOS Keychain returned an invalid encryption key');
    }
    return stdout;
  }

  return {
    id: providerId,

    async isAvailable() {
      try {
        const key = await readKey('read');
        key.fill(0);
        return true;
      } catch (error) {
        // A new installation has no key. The first encryption creates it.
        return error?.code === 2;
      }
    },

    async encrypt(plaintext) {
      const key = await readKey('get-or-create');
      try {
        const nonce = randomBytes(nonceLength);
        const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: tagLength });
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
      } finally {
        key.fill(0);
      }
    },

    async decrypt(bytes) {
      const ciphertextOffset = nonceLength + tagLength;
      if (bytes.length < ciphertextOffset) throw new Error('Truncated encrypted credentials');
      const key = await readKey('read');
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, nonceLength), {
          authTagLength: tagLength,
        });
        decipher.setAAD(aad);
        decipher.setAuthTag(bytes.subarray(nonceLength, ciphertextOffset));
        return Buffer.concat([decipher.update(bytes.subarray(ciphertextOffset)), decipher.final()]).toString('utf8');
      } finally {
        key.fill(0);
      }
    },
  };
}
