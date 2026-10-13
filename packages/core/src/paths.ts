import { homedir, platform } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function applicationDataRoot(): string {
  if (platform() === 'win32') return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
}
export function dataDirectory(override = process.env.BETTER_GPT_DATA_DIR): string {
  return override ? resolve(override) : join(applicationDataRoot(), 'better-gpt');
}
export function legacyDirectories(): string[] {
  // The Flutter version predates XDG_DATA_HOME support.
  const root = platform() === 'linux' ? join(homedir(), '.local', 'share') : applicationDataRoot();
  return ['codexter', 'codexter-dev'].map((name) => join(root, name));
}
export function requireAbsoluteDirectory(value: string): string {
  if (!isAbsolute(value)) throw new Error('项目目录必须使用当前操作系统的绝对路径');
  return resolve(value);
}
