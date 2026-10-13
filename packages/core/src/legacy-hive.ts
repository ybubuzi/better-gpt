import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export interface RawRecord { key: string | number; value: { typeId: number; fields: Record<string, unknown> } }
export interface HiveExport { formatVersion: 1; boxes: Record<string, RawRecord[]> }
export const hiveNames = ['global_config', 'workspaces', 'skills', 'downstream_mcps'] as const;
const root = new URL('../../../', import.meta.url);
const executable = fileURLToPath(new URL(`tools/legacy-hive/.build/legacy-hive${process.platform === 'win32' ? '.exe' : ''}`, root));
let preparation: Promise<void> | undefined;

async function ensureBridge(): Promise<void> {
  try {
    await access(executable);
    const hash = createHash('sha256').update(await readFile(new URL('tools/legacy-hive/bin/export.dart', root)))
      .update(await readFile(new URL('tools/legacy-hive/pubspec.lock', root))).digest('hex');
    if ((await readFile(new URL('tools/legacy-hive/.build/source.sha256', root), 'utf8')).trim() === hash) return;
  } catch {}
  preparation ??= (async () => {
    try {
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL('scripts/build-legacy.mjs', root))], {
        windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
      });
    } catch { throw new Error('Hive 兼容工具准备失败。请运行 npm run migration:build 查看依赖或 Dart 环境错误。'); }
  })().finally(() => { preparation = undefined; });
  await preparation;
}

export async function decodeHive(files: Record<string, Buffer>): Promise<HiveExport> {
  await ensureBridge();
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
