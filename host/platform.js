import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { ChatGPTError } from './chatgpt/errors.js';

const exec = promisify(execFile);

export function isDesktopHost(entry) {
  return entry?.replaceAll('\\', '/').endsWith('/@deepseek-ai/dsh-desktop-host/lib/index.js') ?? false;
}

export function windowsSystemDirectory(root = process.env.SystemRoot) {
  if (!root || !/^[a-z]:[\\/]/i.test(root)) throw new Error('Windows SystemRoot is unavailable');
  return win32.join(root, 'System32');
}

export function browserLaunch(url, platform = process.platform) {
  const target = URL.parse(url);
  if (target?.origin !== 'https://auth.openai.com' || target.username || target.password) {
    throw new ChatGPTError('invalid_sign_in_url', '无法验证 ChatGPT 登录地址。');
  }
  if (platform === 'darwin') return { file: '/usr/bin/open', args: [target.href] };
  if (platform === 'win32') {
    const system = windowsSystemDirectory();
    return {
      file: win32.join(system, 'rundll32.exe'),
      args: [`${win32.join(system, 'url.dll')},FileProtocolHandler`, target.href],
      cwd: system,
    };
  }
  throw new ChatGPTError('browser_unavailable', '无法打开系统浏览器。');
}

export async function openBrowser(url) {
  try {
    const { file, args, cwd } = browserLaunch(url);
    await exec(file, args, { cwd, timeout: 15_000, windowsHide: true });
  } catch (error) {
    if (error instanceof ChatGPTError) throw error;
    throw new ChatGPTError('browser_unavailable', '无法打开系统浏览器。');
  }
}
