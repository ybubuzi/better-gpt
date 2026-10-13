import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMissing } from './config-store.js';

export interface LegacySecrets { key: string; encryptedSource?: Buffer; sourceFile?: string }

export async function readLegacySecrets(fallback: string): Promise<LegacySecrets> {
  if (process.platform === 'win32') {
    const sourceFile = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Codexter', 'Codexter', 'flutter_secure_storage.dat');
    let encryptedSource: Buffer;
    try { encryptedSource = await readFile(sourceFile); }
    catch (error) { if (isMissing(error)) return { key: fallback }; throw new Error('无法读取旧系统凭据文件'); }
    const command = "$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); $json=[Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json; $value=[string]$json.openai_runtime_api_key; [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))) } catch { exit 3 }";
    const encoded = await new Promise<string>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => { child.kill(); reject(new Error('读取旧系统凭据超时')); }, 15_000);
      child.stdout.on('data', (data: Buffer) => chunks.push(data));
      child.stderr.resume();
      child.once('error', () => { clearTimeout(timer); reject(new Error('无法调用 Windows 用户凭据接口')); });
      child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks).toString('ascii'))
        : reject(new Error('旧凭据无法由当前 Windows 用户解密；原文件已保留')); });
      child.stdin.on('error', () => {});
      child.stdin.end(encryptedSource.toString('base64'));
    });
    return { key: Buffer.from(encoded.trim(), 'base64').toString('utf8').trim() || fallback, encryptedSource, sourceFile };
  }
  if (process.platform === 'darwin') {
    try {
      const { AsyncEntry } = await import('@napi-rs/keyring');
      const key = await new AsyncEntry('flutter_secure_storage_service', 'openai_runtime_api_key').getPassword();
      return { key: key?.trim() || fallback };
    } catch { throw new Error('无法读取旧版 Keychain 凭据，请在原用户会话中授权后重试'); }
  }
  // The old Linux application was not supported. Never silently claim a complete credential migration.
  throw new Error('当前仅支持从 Windows/macOS 迁移系统凭据；Linux 来源需要兼容的凭据导出包');
}
