import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'darwin') {
  const nativeDir = fileURLToPath(new URL('../native/', import.meta.url));
  const source = fileURLToPath(new URL('../native/credential-key.swift', import.meta.url));
  const cache = fileURLToPath(new URL('../node_modules/.cache/swift', import.meta.url));
  mkdirSync(cache, { recursive: true });
  const staging = mkdtempSync(join(nativeDir, '.credential-key-'));
  try {
    const legacy = join(staging, 'credential-key');
    // Preserve the build used for existing Keychain access grants.
    execFileSync('/usr/bin/swiftc', ['-O', '-module-cache-path', cache, source, '-o', legacy], { stdio: 'inherit' });
    const slices = [];
    for (const arch of ['arm64', 'x86_64']) {
      const slice = join(staging, arch);
      execFileSync('/usr/bin/swiftc', [
        '-O', '-target', `${arch}-apple-macos11.0`, '-module-cache-path', cache, source, '-o', slice,
      ], { stdio: 'inherit' });
      slices.push(slice);
    }
    const universal = join(staging, 'credential-key-universal');
    execFileSync('/usr/bin/lipo', ['-create', ...slices, '-output', universal], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', universal], { stdio: 'inherit' });
    renameSync(universal, join(nativeDir, 'credential-key-universal'));
    renameSync(legacy, join(nativeDir, 'credential-key'));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
