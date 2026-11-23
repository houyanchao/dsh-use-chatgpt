import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { windowsSystemDirectory } from './platform.js';

const providerId = 'dsh-windows-dpapi-current-user-v1';
// DPAPI binds credentials to the Windows user. Keep this context independent
// of the storage path so moving the profile directory preserves access.
const entropy = createHash('sha256').update(providerId).digest();
const maxCredentialBytes = 2 * 1024 * 1024;
const healthCheckTtl = 60_000;
const probe = Buffer.from([1]);

// The command line carries only the helper code. The entropy and credential
// bytes pass through binary stdin/stdout without touching a file.
function command(operation) {
  return Buffer.from(`
$ErrorActionPreference = 'Stop'
$operation = '${operation}'
try {
  $null = [System.Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
  $stream = [System.IO.MemoryStream]::new()
  [Console]::OpenStandardInput().CopyTo($stream)
  $payload = $stream.GetBuffer()
  $entropy = [byte[]]::new(32)
  $bytes = [byte[]]::new([int]$stream.Length - $entropy.Length)
  [Array]::Copy($payload, 0, $entropy, 0, $entropy.Length)
  [Array]::Copy($payload, $entropy.Length, $bytes, 0, $bytes.Length)
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($operation -eq 'decrypt') {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
  } else {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
    if ($operation -eq 'probe') {
      $result = [System.Security.Cryptography.ProtectedData]::Unprotect($result, $entropy, $scope)
    }
  }
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($result, 0, $result.Length)
  $stdout.Flush()
} catch {
  exit 1
} finally {
  if ($payload) { [Array]::Clear($payload, 0, $payload.Length) }
  if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  if ($result) { [Array]::Clear($result, 0, $result.Length) }
  if ($stream) { $stream.Dispose() }
}
`, 'utf16le').toString('base64');
}

const commands = { encrypt: command('encrypt'), decrypt: command('decrypt'), probe: command('probe') };

async function runDpapi(operation, bytes) {
  if (bytes.byteLength > maxCredentialBytes) throw new Error('Windows credential data is too large.');
  const input = Buffer.concat([entropy, bytes]);
  try {
    const systemDirectory = windowsSystemDirectory();
    const powershell = win32.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const stdout = await new Promise((resolve, reject) => {
      const child = childProcess.execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', commands[operation]], {
        cwd: systemDirectory,
        env: { SystemRoot: win32.dirname(systemDirectory), PATH: systemDirectory },
        encoding: 'buffer',
        maxBuffer: 2 * maxCredentialBytes,
        timeout: 15_000,
        windowsHide: true,
      }, (error, output) => {
        if (error) reject(error);
        else resolve(output);
      });
      // Early PowerShell exits are reported via execFile, including with a closed pipe.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
    if (stdout.length === 0) throw new Error('Empty credential protection result.');
    return stdout;
  } catch (error) {
    // Child process errors can contain captured stdout. Keep it out of error reports.
    if (Buffer.isBuffer(error?.stdout)) error.stdout.fill(0);
    throw new Error('Windows credential protection is unavailable.');
  } finally {
    input.fill(0);
  }
}

export function createWindowsCredentialEncryption() {
  let availableUntil = 0;
  let checking;

  return {
    id: providerId,

    async isAvailable() {
      if (Date.now() < availableUntil) return true;
      checking ??= runDpapi('probe', probe).then(bytes => {
        const available = bytes.equals(probe);
        if (available) availableUntil = Date.now() + healthCheckTtl;
        return available;
      }, () => false).finally(() => { checking = undefined; });
      return checking;
    },

    async encrypt(plaintext) {
      const bytes = Buffer.from(plaintext, 'utf8');
      try {
        return await runDpapi('encrypt', bytes);
      } finally {
        bytes.fill(0);
      }
    },

    async decrypt(ciphertext) {
      const bytes = await runDpapi('decrypt', ciphertext);
      try {
        return bytes.toString('utf8');
      } finally {
        bytes.fill(0);
      }
    },
  };
}
