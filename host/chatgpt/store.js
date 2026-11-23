import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { ChatGPTError } from './errors.js';

// Retain the disk format and lock name used by earlier releases, including during upgrades.
const limit = 2 * 1024 * 1024;
const authFile = 'chatgpt-auth.json';
const hostFile = 'chatgpt-host.json';
const unix = process.platform !== 'win32';
const hostIdPattern = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validScopes = value => Array.isArray(value) && value.every(scope => typeof scope === 'string');
const newState = () => ({ version: 2, profiles: [], pendingRegistrations: [] });
const invalid = () => new ChatGPTError('storage_invalid', '本机的账号记录无法读取，请恢复原有凭据文件。');

function validTokens(tokens) {
  return typeof tokens?.accessToken === 'string' && tokens.accessToken.length > 0
    && Number.isFinite(tokens.expiresAt)
    && (tokens.earliestRefreshAt === undefined || typeof tokens.earliestRefreshAt === 'string' || Number.isFinite(tokens.earliestRefreshAt))
    && (tokens.refreshToken === undefined || (typeof tokens.refreshToken === 'string' && tokens.refreshToken.length > 0));
}

function checkState(state) {
  if (state?.version !== 2 || !Array.isArray(state.profiles) || !Array.isArray(state.pendingRegistrations)) throw invalid();
  const ids = new Set();
  const labels = new Set();
  for (const entry of [...state.profiles, ...state.pendingRegistrations]) {
    if (typeof entry?.id !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(entry.id) || ids.has(entry.id)
      || typeof entry.label !== 'string' || !entry.label.trim() || /[\u0000-\u001f]/.test(entry.label) || entry.label.length > 120 || labels.has(entry.label)
      || typeof entry.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(entry.clientId)
      || entry.clientId === 'dynamic_agent_client' || typeof entry.savedAt !== 'string') throw invalid();
    ids.add(entry.id);
    labels.add(entry.label);
  }
  for (const profile of state.profiles) {
    if (profile.version !== 1 || !['connected', 'disconnected', 'reauth_required'].includes(profile.status)
      || !validScopes(profile.scopes) || (profile.credentials !== undefined && !validTokens(profile.credentials))
      || (profile.subject !== undefined && typeof profile.subject !== 'string')
      || (profile.profileIdToken !== undefined && (typeof profile.profileIdToken !== 'string' || !profile.profileIdToken))
      || (profile.requiresNewRegistration !== undefined && typeof profile.requiresNewRegistration !== 'boolean')) throw invalid();
    const identity = profile.identity;
    if (identity !== undefined && (!identity || typeof identity !== 'object' || Array.isArray(identity)
      || ['email', 'name'].some(field => identity[field] !== undefined && typeof identity[field] !== 'string'))) throw invalid();
    if (profile.pendingRefresh !== undefined) {
      const pending = profile.pendingRefresh;
      if (profile.status !== 'connected' || !profile.credentials || !validTokens(pending?.credentials)
        || !pending.credentials.refreshToken || !validScopes(pending.scopes) || typeof pending.idToken !== 'string' || !pending.idToken
        || !Number.isSafeInteger(pending.receivedAt) || pending.receivedAt <= 0 || pending.receivedAt > Date.now() + 5000) throw invalid();
    }
  }
  if (state.activeProfileId !== undefined && !state.profiles.some(profile => profile.id === state.activeProfileId)) throw invalid();
  return state;
}

async function readRecord(path) {
  let fd;
  try {
    const link = await lstat(path);
    if (!link.isFile()) throw invalid();
    fd = await open(path, constants.O_RDONLY | (unix ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > limit || (unix && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw new ChatGPTError('storage_unsafe', '请检查本机凭据文件的权限和大小。');
    }
    return JSON.parse(await fd.readFile('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error instanceof ChatGPTError) throw error;
    throw invalid();
  } finally {
    await fd?.close();
  }
}

export class AccountStore {
  constructor(directory, encryption) {
    if (!directory || !isAbsolute(directory) || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(encryption?.id ?? '')
      || !['encrypt', 'decrypt', 'isAvailable'].every(key => typeof encryption[key] === 'function')) {
      throw new ChatGPTError('invalid_config', '账号存储需要绝对路径和系统加密服务。');
    }
    this.directory = directory;
    this.encryption = encryption;
  }

  async transaction(work, signal) {
    const directory = this.directory;
    let compromised = false;
    let release;
    const checkLock = () => {
      if (!release || compromised) throw new ChatGPTError('storage_lock_lost', '凭据文件的写锁已丢失，请重新打开账号。');
    };
    const write = async (filename, object) => {
      checkLock();
      const bytes = JSON.stringify(object);
      if (Buffer.byteLength(bytes) > limit) throw new ChatGPTError('storage_too_large', '凭据文件过大。');
      const temporary = join(directory, '.chatgpt-' + randomUUID() + '.tmp');
      const output = await open(temporary, 'wx', 0o600);
      try {
        try {
          await output.writeFile(bytes);
          await output.sync();
        } finally {
          await output.close();
        }
        checkLock();
        await rename(temporary, join(directory, filename));
        if (unix) {
          const dir = await open(directory, 'r');
          try { await dir.sync(); } finally { await dir.close(); }
        }
      } finally {
        await rm(temporary, { force: true });
      }
    };

    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || (unix && stat.uid !== process.getuid())) throw new ChatGPTError('storage_unsafe', '请使用当前用户的本地凭据目录。');
      if (unix && (stat.mode & 0o077)) await chmod(directory, 0o700);
      const deadline = performance.now() + 45_000;
      while (!release) {
        signal?.throwIfAborted();
        try {
          release = await lockfile.lock(directory, {
            lockfilePath: join(directory, '.chatgpt-auth.lock'),
            stale: 120_000, update: 20_000,
            onCompromised: () => { compromised = true; },
          });
        } catch (error) {
          if (error.code !== 'ELOCKED') throw error;
          if (performance.now() > deadline) throw new ChatGPTError('storage_busy', '另一个进程正在保存账号，请稍后重试。', true);
          await delay(75, undefined, { signal });
        }
      }
      signal?.throwIfAborted();
      const save = async state => {
        await this.#requireEncryption();
        const encoded = JSON.stringify(checkState(state));
        let encrypted;
        try {
          encrypted = await this.encryption.encrypt(encoded);
          if (!(encrypted instanceof Uint8Array) || encrypted.length === 0) throw invalid();
        } catch {
          throw new ChatGPTError('storage_encryption_failed', '本机无法加密账号信息。', true);
        }
        await write(authFile, { version: 3, provider: this.encryption.id, ciphertext: Buffer.from(encrypted).toString('base64') });
      };
      const hostId = async () => {
        const record = await readRecord(join(directory, hostFile));
        if (record === undefined) {
          const id = 'urn:uuid:' + randomUUID();
          await write(hostFile, { version: 1, id });
          return id;
        }
        if (record?.version !== 1 || typeof record.id !== 'string' || !hostIdPattern.test(record.id)) {
          throw new ChatGPTError('host_identity_invalid', '本机标识文件无效，请恢复原文件。');
        }
        return record.id;
      };
      const state = await this.#load(save);
      const result = await work({ state, save: () => save(state), hostId });
      checkLock();
      return result;
    } catch (error) {
      if (error instanceof ChatGPTError) throw error;
      if (signal?.aborted) throw new ChatGPTError('cancelled', '操作已取消。');
      throw new ChatGPTError('storage_error', '本机无法安全读写账号信息。');
    } finally {
      if (release && !compromised) {
        try { await release(); } catch { throw new ChatGPTError('storage_lock_lost', '无法释放凭据存储锁。'); }
        release = undefined;
      }
    }
  }

  async #requireEncryption() {
    const available = await Promise.resolve().then(() => this.encryption.isAvailable()).catch(() => false);
    if (!available) throw new ChatGPTError('storage_encryption_unavailable', '请解锁系统凭据存储后重试。', true);
  }

  async #load(save) {
    const record = await readRecord(join(this.directory, authFile));
    if (record === undefined) return newState();
    if (record?.version === 3) {
      if (record.provider !== this.encryption.id) throw new ChatGPTError('storage_provider_mismatch', '请使用保存这些凭据的系统加密服务。');
      await this.#requireEncryption();
      try {
        const bytes = Buffer.from(record.ciphertext, 'base64');
        if (!bytes.length || bytes.toString('base64') !== record.ciphertext) throw invalid();
        return checkState(JSON.parse(await this.encryption.decrypt(bytes)));
      } catch {
        throw new ChatGPTError('storage_decryption_failed', '无法解密现有凭据。请检查钥匙串或 Windows 用户后重试。', true);
      }
    }
    let state = record;
    if (record?.version === 1) {
      const id = randomUUID();
      state = { ...newState(), activeProfileId: id, profiles: [{ ...record, id, label: 'Connection 1', requiresNewRegistration: true }] };
    }
    checkState(state);
    // Valid pre-encryption files are upgraded in place without making a plaintext backup.
    await save(state);
    return state;
  }
}
