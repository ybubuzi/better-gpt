import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceBridge = join(root, 'tools', 'legacy-hive');
const sourceHash = createHash('sha256');
for (const file of ['bin/export.dart', 'pubspec.yaml', 'pubspec.lock']) sourceHash.update(await readFile(join(sourceBridge, file)));
const hash = sourceHash.digest('hex');
const dataRoot = process.platform === 'win32' ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
const data = process.env.BETTER_GPT_DATA_DIR ? resolve(process.env.BETTER_GPT_DATA_DIR) : join(dataRoot, 'better-gpt');
const bridge = process.env.BETTER_GPT_BRIDGE_DIR ? resolve(process.env.BETTER_GPT_BRIDGE_DIR) : join(data, 'cache', 'legacy-hive', `${process.platform}-${process.arch}-${hash}`);
for (const file of ['bin/export.dart', 'pubspec.yaml', 'pubspec.lock', '.build/source.sha256', `.build/legacy-hive${process.platform === 'win32' ? '.exe' : ''}`, '.pub-cache/marker']) {
  let cursor = join(bridge, file);
  while (dirname(cursor) !== cursor) {
    const info = await lstat(cursor).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info?.isSymbolicLink()) throw new Error('Hive缓存目标包含链接，已停止写入。');
    cursor = dirname(cursor);
  }
}
const output = join(bridge, '.build', process.platform === 'win32' ? 'legacy-hive.exe' : 'legacy-hive');
let dart;
const candidates = [process.env.BETTER_GPT_DART];
for (const path of (process.env.PATH ?? '').split(delimiter)) {
  if (process.platform === 'win32') candidates.push(join(path, 'dart.exe'), join(path, 'cache', 'dart-sdk', 'bin', 'dart.exe'));
  else candidates.push(join(path, 'dart'));
}
for (const candidate of candidates.filter(Boolean)) {
  try { await access(candidate); dart = resolve(candidate); break; } catch {}
}
if (!dart) throw new Error('首次准备 Hive 兼容工具需要 Dart 3；请设置 BETTER_GPT_DART 为 dart 可执行文件的绝对路径。');
if (bridge !== sourceBridge) {
  await mkdir(join(bridge, 'bin'), { recursive: true, mode: 0o700 });
  for (const file of ['bin/export.dart', 'pubspec.yaml', 'pubspec.lock']) await copyFile(join(sourceBridge, file), join(bridge, file));
}
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(dart, args, { cwd: bridge, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, PUB_CACHE: process.env.PUB_CACHE ?? join(bridge, '.pub-cache') } });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`迁移工具准备失败 (${code})`)));
  });
}
await run(['pub', 'get', '--enforce-lockfile']);
await mkdir(dirname(output), { recursive: true });
await run(['compile', 'exe', 'bin/export.dart', '-o', output]);
await writeFile(join(dirname(output), 'source.sha256'), hash);
console.log('Hive compatibility bridge ready.');
