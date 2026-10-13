import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { configSchema, createEmptyConfig, type AppConfig } from '@better-gpt/contracts';
import { assertNoDestinationLinks } from './destination-guard.js';

export const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export class ConfigStore {
  readonly path: string;
  constructor(readonly directory: string) { this.path = join(directory, 'config.json'); }

  async read(): Promise<{ config: AppConfig; initialized: boolean }> {
    await assertNoDestinationLinks(this.directory, this.path);
    let source: string;
    try { source = await readFile(this.path, 'utf8'); }
    catch (error) {
      if (isMissing(error)) return { config: createEmptyConfig(), initialized: false };
      throw error;
    }
    // Invalid or future-version configuration must never be silently reset.
    return { config: configSchema.parse(JSON.parse(source)), initialized: true };
  }

  async update(change: (current: AppConfig) => AppConfig | null | Promise<AppConfig | null>): Promise<AppConfig> {
    await assertNoDestinationLinks(this.directory, this.path);
    await mkdir(this.directory, { recursive: true });
    const lockPath = join(this.directory, 'config.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`配置正在被其他进程修改，或上次写入中断。请确认后检查 ${lockPath}`);
      }
      throw error;
    }
    const temporary = join(this.directory, `config.${randomUUID()}.tmp`);
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      const current = await this.read();
      const changed = await change(current.config);
      if (changed === null) {
        await unlink(this.path).catch((error: unknown) => { if (!isMissing(error)) throw error; });
        return createEmptyConfig();
      }
      const config = configSchema.parse(changed);
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify(config, null, 2)}\n`); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
      return config;
    } finally {
      try {
        await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; });
      } finally {
        try { await lock.close(); } finally { await unlink(lockPath); }
      }
    }
  }
}
