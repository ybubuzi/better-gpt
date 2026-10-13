import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ExecCommandInput, ManagedProcessView, ProcessResult, ProxyConfig, Workspace, WriteStdinInput } from '@better-gpt/contracts';
import type { RuntimeStore } from './runtime-store.js';
import { windowsCommand } from './windows-command.js';

interface Session {
  id: number; workspaceId: string; command: string; cwd: string;
  child: ChildProcessWithoutNullStreams; startedAt: number; endedAt?: number;
  running: boolean; exitCode: number | null; output: string; pending: string;
  truncated: boolean; pendingTruncated: boolean; waiters: Set<() => void>; cleanup?: NodeJS.Timeout;
  leaderExited: boolean; streamsClosed: boolean; leaderCode: number | null; terminated: boolean; monitor?: NodeJS.Timeout;
  stopping?: Promise<void>;
}

export async function shellExecutable(): Promise<string> {
  if (process.env.BETTER_GPT_SHELL) return process.env.BETTER_GPT_SHELL;
  if (process.platform !== 'win32') return '/bin/bash';
  const paths = (process.env.PATH ?? '').split(delimiter);
  for (const directory of paths) {
    const candidate = join(directory, 'pwsh.exe');
    try { await access(candidate); return candidate; } catch {}
  }
  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    const candidate = join(programFiles, 'PowerShell', '7', 'pwsh.exe');
    try { await access(candidate); return candidate; } catch {}
  }
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function childEnvironment(proxy: ProxyConfig, resolvedAddress?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  const keys = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
  if (proxy.mode === 'direct') for (const key of keys) delete env[key];
  if (proxy.mode === 'custom') {
    if (proxy.credentialRef && resolvedAddress === undefined) throw new Error('代理凭据尚未解析，未静默改为直连');
    for (const key of keys) env[key] = resolvedAddress ?? proxy.url;
  }
  const bypass = ['localhost', '127.0.0.1', '::1', ...proxy.bypass, env.NO_PROXY ?? env.no_proxy ?? ''].filter(Boolean).join(',');
  env.NO_PROXY = bypass; env.no_proxy = bypass;
  return env;
}

export class ProcessManager {
  private sessions = new Map<number, Session>();
  private nextId = 1;
  private closing = true;
  private starts = 0;
  constructor(private readonly runtime: RuntimeStore, private readonly workspaceAvailable: (uuid: string) => boolean = () => true) {}
  activate(): void { this.closing = false; }
  runningCount(workspaceId: string): number {
    return [...this.sessions.values()].filter((session) => session.workspaceId === workspaceId && session.running).length;
  }

  list(workspaceId?: string): ManagedProcessView[] {
    return [...this.sessions.values()].filter((session) => workspaceId === undefined || session.workspaceId === workspaceId)
      .sort((left, right) => right.id - left.id).map((session) => ({
        id: session.id, workspaceId: session.workspaceId, ...(session.child.pid ? { pid: session.child.pid } : {}),
        command: this.runtime.redact(session.command), cwd: session.cwd, startedAt: session.startedAt,
        ...(session.endedAt !== undefined ? { endedAt: session.endedAt } : {}), running: session.running,
        exitCode: session.exitCode, output: this.runtime.redact(session.output), outputTruncated: session.truncated, terminationRequested: session.terminated,
      }));
  }
  private require(workspaceId: string, id: number): Session {
    const session = this.sessions.get(id);
    if (!session || session.workspaceId !== workspaceId) throw new Error('当前工作区不存在该进程会话');
    return session;
  }
  async start(workspace: Workspace, input: ExecCommandInput, proxy: ProxyConfig, resolvedAddress?: string): Promise<ProcessResult> {
    if (this.closing || !this.workspaceAvailable(workspace.uuid)) throw new Error('本地服务未启动或工作区正在删除');
    if ([...this.sessions.values()].filter((item) => item.running).length + this.starts >= 32) throw new Error('受管进程已达到上限');
    this.starts++;
    if (this.sessions.size >= 200) {
      const expired = [...this.sessions.values()].find((session) => !session.running);
      if (expired) {
        if (expired.cleanup) clearTimeout(expired.cleanup);
        expired.child.stdout.destroy(); expired.child.stderr.destroy(); expired.child.stdin.destroy();
        this.sessions.delete(expired.id);
      }
    }
    let session: Session;
    try {
      const root = await realpath(workspace.projectRoot);
      const cwd = await realpath(resolve(root, input.workdir ?? '.'));
      const rel = relative(root, cwd);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('命令初始目录必须位于工作区内');
      if (!(await stat(cwd)).isDirectory()) throw new Error('命令目录不存在');
      const shell = await shellExecutable();
      if (this.closing || !this.workspaceAvailable(workspace.uuid)) throw new Error('服务正在停止或工作区正在删除');
      const command = process.platform === 'win32' ? windowsCommand(input.cmd, process.pid) : input.cmd;
      const args = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
      const child = spawn(shell, args, { cwd, env: childEnvironment(proxy, resolvedAddress), windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      session = { id: this.nextId++, workspaceId: workspace.uuid, command: input.cmd, cwd, child, startedAt: Date.now(),
        running: true, exitCode: null, output: '', pending: '', truncated: false, pendingTruncated: false,
        waiters: new Set(), leaderExited: false, streamsClosed: false, leaderCode: null, terminated: false };
      this.sessions.set(session.id, session);
      const append = (chunk: string) => {
        session.output += chunk; session.pending += chunk;
        if (session.output.length > 200_000) { session.output = session.output.slice(-200_000); session.truncated = true; }
        if (session.pending.length > 1_000_000) { session.pending = session.pending.slice(-1_000_000); session.pendingTruncated = true; }
        this.runtime.changed();
      };
      child.stdout.setEncoding('utf8').on('data', append);
      child.stderr.setEncoding('utf8').on('data', append);
      child.stdin.on('error', () => {});
      child.once('exit', (code) => {
        session.leaderExited = true; session.leaderCode = code ?? -1;
        if (process.platform !== 'win32' && !session.monitor) {
          session.monitor = setInterval(() => this.checkFinished(session), 100);
          session.monitor.unref();
        }
        this.checkFinished(session);
      });
      child.once('error', (error) => { append(`\n${error.message}\n`); session.leaderExited = true; session.leaderCode = -1; session.streamsClosed = true; this.checkFinished(session); });
      child.once('close', (code) => { session.leaderExited = true; session.leaderCode = code ?? session.leaderCode ?? -1; session.streamsClosed = true; this.checkFinished(session); });
      this.runtime.changed();
      await new Promise<void>((ready, reject) => { child.once('spawn', ready); child.once('error', reject); });
    } finally { this.starts--; }
    await this.wait(session, input.yield_time_ms);
    return this.consume(session, input.max_output_tokens * 4);
  }
  private async wait(session: Session, milliseconds: number): Promise<void> {
    if (!session.running || milliseconds === 0) return;
    await new Promise<void>((resolveWait) => {
      const done = () => { clearTimeout(timer); session.waiters.delete(done); resolveWait(); };
      const timer = setTimeout(done, milliseconds);
      session.waiters.add(done);
      if (!session.running) done();
    });
  }
  private groupAlive(session: Session): boolean {
    if (!session.child.pid) return false;
    try { process.kill(-session.child.pid, 0); return true; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
      return true;
    }
  }
  private checkFinished(session: Session): void {
    if (!session.running || !session.leaderExited) return;
    if (process.platform !== 'win32' && this.groupAlive(session)) return;
    if (!session.streamsClosed) return;
    session.running = false; session.exitCode = session.leaderCode; session.endedAt = Date.now();
    this.runtime.processFinished(session.workspaceId, { session_id: session.id, running: false,
      exit_code: session.exitCode, output: session.output, output_truncated: session.truncated, termination_requested: session.terminated });
    if (session.monitor) clearInterval(session.monitor);
    for (const done of [...session.waiters]) done();
    session.cleanup = setTimeout(() => { this.sessions.delete(session.id); this.runtime.changed(); }, 5 * 60_000);
    session.cleanup.unref(); this.runtime.changed();
  }
  private consume(session: Session, maxChars: number): ProcessResult {
    const raw = session.pending;
    const output = raw.length > maxChars ? `${raw.slice(0, Math.floor(maxChars / 2))}\n…输出已截断…\n${raw.slice(-Math.floor(maxChars / 2))}` : raw;
    const result = { session_id: session.id, running: session.running, exit_code: session.exitCode,
      output, output_truncated: session.pendingTruncated || raw.length > maxChars, termination_requested: session.terminated };
    session.pending = ''; session.pendingTruncated = false;
    return result;
  }
  async poll(workspaceId: string, input: WriteStdinInput): Promise<ProcessResult> {
    const session = this.require(workspaceId, input.session_id);
    if (input.chars.includes('\u0003')) await this.stop(workspaceId, session.id);
    const chars = input.chars.replaceAll('\u0003', '');
    if (chars && session.running) session.child.stdin.write(chars);
    await this.wait(session, input.yield_time_ms);
    return this.consume(session, input.max_output_tokens * 4);
  }
  private async signal(session: Session, force: boolean): Promise<void> {
    const child = session.child;
    if (!session.running || !child.pid) return;
    if (process.platform === 'win32') {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore' });
      await new Promise<void>((resolveKill) => { killer.once('error', () => resolveKill()); killer.once('close', () => resolveKill()); });
    } else {
      try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
    }
  }
  async stop(workspaceId: string, id: number): Promise<void> {
    const session = this.require(workspaceId, id);
    session.stopping ??= (async () => {
      if (session.running) session.terminated = true;
      await this.signal(session, false); await this.wait(session, 2000);
      if (session.running) { await this.signal(session, true); await this.wait(session, 2000); }
      if (session.running) throw new Error('进程尚未退出，请检查系统权限后重试');
    })().finally(() => { delete session.stopping; });
    return session.stopping;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    while (this.starts > 0) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    await Promise.all([...this.sessions.values()].filter((session) => session.running).map((session) => this.stop(session.workspaceId, session.id)));
    for (const session of this.sessions.values()) {
      session.child.stdin.destroy(); session.child.stdout.destroy(); session.child.stderr.destroy();
    }
  }
  async stopWorkspace(workspaceId: string): Promise<void> {
    await Promise.all([...this.sessions.values()].filter((session) => session.workspaceId === workspaceId && session.running).map((session) => this.stop(workspaceId, session.id)));
  }
}
