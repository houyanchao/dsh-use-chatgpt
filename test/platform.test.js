import assert from 'node:assert/strict';
import test from 'node:test';
import { browserLaunch, isDesktopHost, windowsSystemDirectory } from '../host/platform.js';

test('the DSH Desktop IPC entry is recognized on macOS and Windows', () => {
  assert.equal(isDesktopHost('/local/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'), true);
  assert.equal(isDesktopHost('C:\\应用\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'), true);
  assert.equal(isDesktopHost('C:\\app\\node_modules\\other\\lib\\index.js'), false);
  assert.equal(isDesktopHost(undefined), false);
});

test('authorization launches the system browser with the full OAuth URL as one argument', t => {
  const target = 'https://auth.openai.com/oauth/authorize?state=some-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A8123';
  const originalRoot = process.env.SystemRoot;
  process.env.SystemRoot = 'D:\\Windows';
  t.after(() => {
    if (originalRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalRoot;
  });

  assert.deepEqual(browserLaunch(target, 'darwin'), { file: '/usr/bin/open', args: [target] });
  assert.deepEqual(browserLaunch(target, 'win32'), {
    file: 'D:\\Windows\\System32\\rundll32.exe',
    args: ['D:\\Windows\\System32\\url.dll,FileProtocolHandler', target],
    cwd: 'D:\\Windows\\System32',
  });
  for (const url of ['not a URL', 'http://auth.openai.com/', 'https://auth.openai.com.example.org/', 'https://name@auth.openai.com/']) {
    assert.throws(() => browserLaunch(url, 'win32'), { code: 'invalid_sign_in_url' });
  }
  for (const root of ['Windows', '\\Windows', '\\\\server\\share']) {
    assert.throws(() => windowsSystemDirectory(root), /SystemRoot/);
  }
});
