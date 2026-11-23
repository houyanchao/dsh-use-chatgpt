import { build } from 'esbuild';
import { cp } from 'node:fs/promises';

await build({
  entryPoints: ['host/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  outfile: 'dist/index.js',
});
await cp(new URL('../notices/', import.meta.url), new URL('../dist/', import.meta.url), { recursive: true });
