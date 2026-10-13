import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Inspect every existing component, including junctions, before writing or removing migration data. */
export async function assertNoDestinationLinks(root: string, destination: string): Promise<void> {
  const base = resolve(root);
  const rel = relative(base, resolve(destination));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('目标路径超出 Better GPT 数据目录');
  let current = base;
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error('目标数据目录含符号链接或目录联接，迁移已停止以保护原数据');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }
}
