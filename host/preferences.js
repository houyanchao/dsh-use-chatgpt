import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultChatOptions as defaults, validateFeatures } from '../shared/chat-options.js';

export function createPreferences(storageDir) {
  const path = storageDir && join(storageDir, 'features.json');
  let current;
  let pending = Promise.resolve();

  return {
    async get() {
      current ??= path ? readFile(path, 'utf8').then(source => validateFeatures(JSON.parse(source)), error => {
        if (error.code === 'ENOENT') return defaults;
        throw error;
      }) : Promise.resolve(defaults);
      return current;
    },
    async save(value) {
      const settings = Object.freeze(validateFeatures(value));
      const write = pending.then(async () => {
        if (path) {
          await mkdir(storageDir, { recursive: true, mode: 0o700 });
          const temporary = `${path}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, `${JSON.stringify(settings)}\n`, { flag: 'wx', mode: 0o600 });
            await rename(temporary, path);
          } finally {
            await rm(temporary, { force: true });
          }
        }
        current = Promise.resolve(settings);
      });
      pending = write.catch(() => undefined);
      await write;
      return settings;
    },
  };
}
