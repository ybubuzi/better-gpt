import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, relative } from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig, TunnelProfile } from '@better-gpt/contracts';
import { shellExecutable } from './process-manager.js';
import { windowsTunnelCommand } from './windows-command.js';

const runFile = promisify(execFile);
interface ProcessIdentity { pid: number; parent: number; createdAt: string; command: string; executable: string }
const nativeChildren = new WeakMap<ChildProcessWithoutNullStreams, { pid: number; createdAt: string; executable: string }>();
const normalize = (value: string) => value.replaceAll('\\', '/').toLowerCase();
const within = (root: string, path: string) => { const rel = relative(resolve(root), resolve(path)); return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel); };
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export async function processIdentities(): Promise<ProcessIdentity[]> {
  if (process.platform !== 'win32') {
    const { stdout } = await runFile('ps', ['-axo', 'pid=,ppid=,lstart=,command='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
    return stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), createdAt: match[3]!, command: match[4]!, executable: '' }] : [];
    });
  }
  const result = await runFile(await shellExecutable(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine,ExecutablePath) | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  const parsed: unknown = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item: { ProcessId: number; ParentProcessId: number; CreationDate: string; CommandLine?: string; ExecutablePath?: string }) => ({
    pid: item.ProcessId, parent: item.ParentProcessId, createdAt: item.CreationDate, command: item.CommandLine ?? '', executable: item.ExecutablePath ?? '',
  }));
}

/** Open a handle before checking creation time, so PID reuse cannot target another process. */
async function stopVerifiedNative(identity: { pid: number; createdAt: string; executable: string }): Promise<void> {
  if (process.platform !== 'win32') throw new Error('当前平台无法自动核验遗留进程身份');
  const script = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${identity.pid} -ErrorAction SilentlyContinue; if ($p) { $h=$p.Handle; if ($p.Path -ine ${quote(identity.executable)} -or [Math]::Abs(($p.StartTime.ToUniversalTime()-[DateTime]::Parse(${quote(identity.createdAt)}).ToUniversalTime()).TotalMilliseconds) -ge 2) { throw '进程身份已变化，拒绝结束' }; $p.Kill(); if (-not $p.WaitForExit(5000)) { throw '进程未能退出' } }; exit 0`;
  await runFile(await shellExecutable(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, maxBuffer: 64_000 });
}
export async function findCloudflared(profile: TunnelProfile, directory: string): Promise<string> {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const candidates = 'executable' in profile && profile.executable ? [profile.executable]
    : [join(directory, 'bin', name), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((path) => join(path, name))];
  for (const candidate of candidates) {
    try { await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return resolve(candidate); }
    catch {}
  }
  throw new Error('找不到可执行的 cloudflared；请检查迁移的程序路径，或安装 cloudflared 并将其加入 PATH。');
}

/** Read process metadata only; never terminate a connector belonging to another application. */
export async function assertNoExistingConnector(profile: Extract<TunnelProfile, { provider: 'cloudflare' }>, config: AppConfig,
  directory?: string, recovered?: (message: string) => void): Promise<void> {
  let processes: ProcessIdentity[];
  try {
    processes = await processIdentities();
  } catch { throw new Error('无法检查已有 cloudflared 进程，未启动重复连接器；请检查系统进程查询权限。'); }
  const sourceRoots = config.migrations.map((record) => normalize(record.sourceDirectory));
  const collisions = processes.filter((item) => {
    const command = normalize(item.command), executable = normalize(item.executable);
    return (executable.endsWith('/cloudflared.exe') || /(?:^|[ /])cloudflared(?: |$)/.test(command))
      && (command.includes(profile.tunnelId.toLowerCase()) || sourceRoots.some((root) =>
        command.includes(`${root}/cloudflared.yml`) || executable.startsWith(`${root}/`)));
  });
  for (const collision of collisions) {
    const configPath = /--config\s+["']?([^"']+?\.yml)/i.exec(collision.command)?.[1];
    const own = directory && configPath && within(join(directory, 'runtime'), configPath) && within(directory, collision.executable);
    if (own && process.platform === 'win32') {
      let owner: { pid: number; createdAt: string } | undefined;
      try {
        owner = (JSON.parse(await readFile(join(resolve(configPath, '..'), 'owner.json'), 'utf8')) as { owner: typeof owner }).owner;
        if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.createdAt !== 'string' || !Number.isFinite(Date.parse(owner.createdAt))) throw new Error('归属记录损坏');
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取已有连接器的归属记录，未自动清理'); }
      const parent = processes.find((item) => item.pid === collision.parent && new Date(item.createdAt).getTime() <= new Date(collision.createdAt).getTime());
      const ownerAlive = owner ? processes.some((item) => item.pid === owner!.pid && item.createdAt === owner!.createdAt) : !!parent;
      if (!ownerAlive) {
        await stopVerifiedNative(collision);
        recovered?.(`已清理本应用失去父进程的残留连接器（PID ${collision.pid}）。`); continue;
      }
      throw new Error(`同一隧道由另一个 better-gpt 实例管理（PID ${collision.pid}）。请连接已有后台服务，或先停止该实例；未结束活跃进程。`);
    }
    throw new Error(`同一隧道已有连接器（PID ${collision.pid}，${own ? 'better-gpt' : '外部程序或 Codexter'}）。请先停止对应服务再重试；未结束该进程。`);
  }
}

export async function spawnTunnel(executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<ChildProcessWithoutNullStreams> {
  if (!isAbsolute(executable)) throw new Error('隧道程序必须解析为绝对路径');
  let child: ChildProcessWithoutNullStreams;
  if (process.platform === 'win32') {
    // The job is created before cloudflared starts and dies with the Node owner. Credentials stay in env.
    child = spawn(await shellExecutable(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsTunnelCommand(executable, args, process.pid)],
      { env, cwd, windowsHide: true, stdio: 'pipe' });
  } else child = spawn(executable, args, { env, cwd, detached: true, stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  if (process.platform === 'win32') {
    let pending = '';
    child.stdout.on('data', (data: Buffer | string) => {
      pending = (pending + data.toString()).slice(-8000);
      const match = /__BETTER_GPT_NATIVE__(\d+)\|([^\r\n]+)/.exec(pending);
      if (match) { nativeChildren.set(child, { pid: Number(match[1]), createdAt: match[2]!, executable }); pending = ''; }
    });
  }
  return child;
}

export async function stopTunnelProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const wait = async (milliseconds: number) => { const deadline = Date.now() + milliseconds; while (!exited() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50)); };
  if (process.platform === 'win32') {
    if (!exited()) {
      await runFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 5000, maxBuffer: 64_000 }).catch(() => {});
    }
    const native = nativeChildren.get(child);
    if (native) await stopVerifiedNative(native);
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await wait(2000);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  await wait(2000);
  if (!exited()) throw new Error('连接器进程在停止期限内未退出，请检查系统权限后重试');
  // OS termination is authoritative. A descendant-held pipe must never block shutdown forever.
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
}
