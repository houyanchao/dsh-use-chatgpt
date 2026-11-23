import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url);
const { name } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['client/index.jsx'],
  outfile: 'dist/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'text', '.svg': 'dataurl' },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {
const module = { exports: {} };`,
  },
  footer: { js: 'return module.exports; } });' },
});
