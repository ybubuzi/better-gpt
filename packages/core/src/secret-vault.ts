import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isMissing } from './config-store.js';
import { assertNoDestinationLinks } from './destination-guard.js';

export class SecretVault {
  private keyPromise: Promise<Buffer> | undefined;
  readonly directory: string;
  private readonly dataDirectory: string;
  constructor(dataDirectory: string) { this.dataDirectory = resolve(dataDirectory); this.directory = join(this.dataDirectory, 'secrets'); }

  private async key(create: boolean): Promise<Buffer> {
    if (this.keyPromise) return this.keyPromise;
    this.keyPromise = (async () => {
      await assertNoDestinationLinks(this.dataDirectory, join(this.directory, 'metadata.json'));
      const { AsyncEntry } = await import('@napi-rs/keyring');
      const identity = process.platform === 'win32' ? this.directory.toLowerCase() : this.directory;
      const account = createHash('sha256').update(identity).digest('hex');
      const entry = new AsyncEntry('better-gpt:vault:v1', account, { linux: { store: 'secret-service' } });
      let encoded: string | null;
      try { encoded = await entry.getPassword(); }
      catch { throw new Error('系统凭据库不可用或未解锁，未写入明文凭据'); }
      if (!encoded) {
        try { await readFile(join(this.directory, 'metadata.json')); throw new Error('凭据库主密钥缺失，拒绝覆盖现有数据'); }
        catch (error) { if (!isMissing(error)) throw error; }
        if (!create) throw new Error('尚未初始化凭据库');
        encoded = randomBytes(32).toString('base64');
        try { await entry.setPassword(encoded); }
        catch { throw new Error('无法保存系统凭据库主密钥'); }
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(join(this.directory, 'metadata.json'), JSON.stringify({ version: 1, service: 'better-gpt:vault:v1', account }), { flag: 'wx', mode: 0o600 });
      }
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32) throw new Error('凭据库主密钥格式异常');
      if (create) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await assertNoDestinationLinks(this.dataDirectory, join(this.directory, 'metadata.json'));
        await writeFile(join(this.directory, 'metadata.json'), JSON.stringify({ version: 1, service: 'better-gpt:vault:v1', account }),
          { flag: 'wx', mode: 0o600 }).catch((error: unknown) => {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        });
      }
      return key;
    })();
    try { return await this.keyPromise; } catch (error) { this.keyPromise = undefined; throw error; }
  }
  private file(reference: string): string {
    if (!reference.startsWith('vault:')) throw new Error('不支持的凭据引用');
    return join(this.directory, `${createHash('sha256').update(reference).digest('hex')}.enc`);
  }
  async read(reference: string): Promise<Buffer> {
    await assertNoDestinationLinks(this.dataDirectory, this.file(reference));
    const key = await this.key(false);
    const stored = JSON.parse(await readFile(this.file(reference), 'utf8')) as { version: number; iv: string; tag: string; data: string };
    if (stored.version !== 1) throw new Error('凭据存储版本不兼容');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'));
      decipher.setAAD(Buffer.from(reference));
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]);
    } catch { throw new Error('加密备份或凭据完整性校验失败'); }
  }
  async put(reference: string, value: Buffer): Promise<void> {
    await assertNoDestinationLinks(this.dataDirectory, this.file(reference));
    const key = await this.key(true);
    try {
      const current = await this.read(reference);
      if (!current.equals(value)) throw new Error('凭据引用冲突，拒绝覆盖已有值');
      return;
    } catch (error) { if (!isMissing(error)) throw error; }
    const iv = randomBytes(12);
    const encryptor = createCipheriv('aes-256-gcm', key, iv);
    encryptor.setAAD(Buffer.from(reference));
    const encrypted = Buffer.concat([encryptor.update(value), encryptor.final()]);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    await assertNoDestinationLinks(this.dataDirectory, temporary);
    await writeFile(temporary, JSON.stringify({ version: 1, iv: iv.toString('base64'),
      tag: encryptor.getAuthTag().toString('base64'), data: encrypted.toString('base64') }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, this.file(reference));
    if (!(await this.read(reference)).equals(value)) throw new Error('凭据写入后校验失败');
  }
}
