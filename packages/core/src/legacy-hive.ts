import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { dataDirectory } from './paths.js';
import { assertNoDestinationLinks } from './destination-guard.js';

export interface RawRecord { key: string | number; value: { typeId: number; fields: Record<string, unknown> } }
export interface HiveExport { formatVersion: 1; boxes: Record<string, RawRecord[]> }
export const hiveNames = ['global_config', 'workspaces', 'skills', 'downstream_mcps'] as const;
const root = new URL('../../../', import.meta.url);
const preparations = new Map<string, Promise<string>>();

async function ensureBridge(directory: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of ['bin/export.dart', 'pubspec.yaml', 'pubspec.lock']) hash.update(await readFile(new URL(`tools/legacy-hive/${file}`, root)));
  const fingerprint = hash.digest('hex');
  const bridge = join(directory, 'cache', 'legacy-hive', `${process.platform}-${process.arch}-${fingerprint}`);
  const executable = join(bridge, '.build', `legacy-hive${process.platform === 'win32' ? '.exe' : ''}`);
  for (const file of ['bin/export.dart', 'pubspec.yaml', 'pubspec.lock', '.build/source.sha256', `.build/legacy-hive${process.platform === 'win32' ? '.exe' : ''}`, '.pub-cache/marker']) await assertNoDestinationLinks(directory, join(bridge, file));
  try {
    await access(executable);
    if ((await readFile(join(bridge, '.build', 'source.sha256'), 'utf8')).trim() === fingerprint) return executable;
  } catch {}
  const existing = preparations.get(bridge);
  if (existing) return existing;
  const preparation = (async () => {
    try {
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL('scripts/build-legacy.mjs', root))], {
        windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, BETTER_GPT_BRIDGE_DIR: bridge },
      });
    } catch { throw new Error('Hive 兼容工具准备失败；首次迁移需要 Dart 3，请检查 BETTER_GPT_DART、下载代理和用户缓存目录权限。'); }
    return executable;
  })().finally(() => { preparations.delete(bridge); });
  preparations.set(bridge, preparation);
  return preparation;
}

export async function decodeHive(files: Record<string, Buffer>, directory = dataDirectory()): Promise<HiveExport> {
  const executable = await ensureBridge(directory);
  const input = JSON.stringify(Object.fromEntries(hiveNames.map((name) => [name, files[`${name}.hive`]?.toString('base64') ?? ''])));
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Hive 解码超时，未更改旧配置')); }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { child.kill(); reject(new Error('Hive 导出数据超过安全处理上限')); return; }
      chunks.push(chunk);
    });
    child.stderr.resume(); // Never surface data from child stderr to terminal/logs.
    child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动 Hive 兼容工具')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Hive 数据解码失败；未更改旧配置，请检查源版本或文件完整性'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  let value: HiveExport;
  try { value = JSON.parse(output) as HiveExport; }
  catch { throw new Error('Hive 兼容工具返回格式错误，未输出其内容'); }
  if (value.formatVersion !== 1 || !value.boxes) throw new Error('Hive 导出格式不兼容');
  return value;
}
