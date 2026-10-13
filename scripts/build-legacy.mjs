import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bridge = join(root, 'tools', 'legacy-hive');
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
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(dart, args, { cwd: bridge, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, PUB_CACHE: process.env.PUB_CACHE ?? join(root, 'work', 'pub-cache') } });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`迁移工具准备失败 (${code})`)));
  });
}
await run(['pub', 'get', '--enforce-lockfile']);
await mkdir(dirname(output), { recursive: true });
await run(['compile', 'exe', 'bin/export.dart', '-o', output]);
const hash = createHash('sha256').update(await readFile(join(bridge, 'bin', 'export.dart')))
  .update(await readFile(join(bridge, 'pubspec.lock'))).digest('hex');
await writeFile(join(dirname(output), 'source.sha256'), hash);
console.log('Hive compatibility bridge ready.');
