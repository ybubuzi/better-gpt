import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { AppConfig, TunnelProfile } from '@better-gpt/contracts';
import { networkFetch } from './network.js';
import { shellExecutable } from './process-manager.js';
import { assertNoDestinationLinks } from './destination-guard.js';

const version = '0.70.1';
const hashes: Record<string, string> = {
  windows_amd64: '531f3cd3cc41c0b4f077b54fe6b7dd83c0ff727e7f0bf412a4c78fa279165de5',
  windows_arm64: '74d3acaf0f03ee190dd0462f9b49861dca50b0559c5488af4b36572fc951fcca',
  linux_amd64: '333da23d1b9009d7c01638e9ba38cf4600f7d37d393f854e96ee1396adefa9a6',
  linux_arm64: '3990f396a9a490ee7f0e5f355287750ed41520064ed999eab443b5e9a78d773d',
  darwin_amd64: 'cbf69cf26e5553e914e97d37f5d4367fa30f5f531d073a889465af4719281e25',
  darwin_arm64: 'cfa733b5a261c1647edee3c1fc4133d2542989b28f5602e81d47fc821d25c55f',
};
export async function ensureFrpc(directory: string, config: AppConfig): Promise<string> {
  const platform = process.platform === 'win32' ? 'windows' : process.platform, architecture = process.arch === 'x64' ? 'amd64' : process.arch;
  const target = `${platform}_${architecture}`, expected = hashes[target]; if (!expected) throw new Error('当前平台需要手动指定frpc路径');
  const name = process.platform === 'win32' ? 'frpc.exe' : 'frpc';
  const destination = join(directory, 'bin', `frp-${version}-${target}`, name);
  await assertNoDestinationLinks(directory, destination);
  try { await access(destination); return destination; } catch {}
  const root = join(directory, 'runtime', `frp-download-${randomUUID()}`), base = `frp_${version}_${target}`;
  const archive = join(root, `${base}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const response = await networkFetch(config.proxy, directory)(`https://github.com/fatedier/frp/releases/download/v${version}/${base}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`frpc下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 50 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('frpc发行包SHA256不匹配');
  await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
  try { if (process.platform === 'win32') {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    await promisify(execFile)(await shellExecutable(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(root)} -ErrorAction Stop`], { windowsHide: true, timeout: 30000, maxBuffer: 64_000 });
  } else await promisify(execFile)('tar', ['-xzf', archive, '-C', root, `${base}/${name}`], { timeout: 30000 }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/virus|potentially unwanted|病毒|不需要的软件/i.test(message)) throw new Error('系统安全软件拦截了frpc发行包，已停止安装；未绕过防护。可选择SSH/外部隧道，或指定经管理员审核且系统允许运行的frpc。');
    throw new Error(`frpc解压失败：${message}`);
  }
  const executable = join(root, base, name); await access(executable);
  await mkdir(join(directory, 'bin', `frp-${version}-${target}`), { recursive: true, mode: 0o700 });
  await rename(executable, destination); if (process.platform !== 'win32') await chmod(destination, 0o700);
  await unlink(archive); return destination;
}

export function frpConfiguration(profile: Extract<TunnelProfile, { provider: 'frp' }>, origin: string, hasProxy: boolean): string {
  return [`serverAddr = ${JSON.stringify(profile.serverAddress)}`, `serverPort = ${profile.serverPort}`, 'loginFailExit = false',
    'auth.method = "token"', 'auth.token = "{{ .Envs.BETTER_GPT_FRP_TOKEN }}"', 'transport.protocol = "tcp"', 'transport.tls.enable = true',
    ...(hasProxy ? ['transport.proxyURL = "{{ .Envs.BETTER_GPT_FRP_PROXY }}"'] : []),
    '', '[[proxies]]', `name = "better-gpt-${profile.id}"`, 'type = "tcp"', 'localIP = "127.0.0.1"',
    `localPort = ${new URL(origin).port}`, `remotePort = ${profile.remotePort}`, ''].join('\n');
}
