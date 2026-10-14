import { spawn } from 'node:child_process';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Socket } from 'node:net';
import type { ManagedProcessView, TunnelRuntime, TunnelControl } from '@better-gpt/contracts';
import { Application } from './application.js';
import { RuntimeStore } from './runtime-store.js';
import { connectDaemon, legacyDaemonEndpoint, type DaemonState } from './daemon.js';
import { assertNoDestinationLinks } from './destination-guard.js';
import { randomUUID } from 'node:crypto';
import { compareConfiguration, type ConfigurationReport, type ConfigurationComparison, type BindDiagnosticContext } from './configuration-diagnostics.js';
import { storageIdentityPath } from './storage-identity.js';

export class DaemonClient {
  readonly background = true;
  readonly runtime = new RuntimeStore();
  readonly local: Application;
  readonly migration: Application['migration'];
  private views: ManagedProcessView[] = [];
  readonly processes = {
    list: (workspaceId: string) => this.views.filter((process) => process.workspaceId === workspaceId),
    runningCount: (workspaceId: string) => this.views.filter((process) => process.workspaceId === workspaceId && process.running).length,
  };
  private socket: Socket | undefined;
  private connecting: Promise<void> | undefined;
  private requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private id = 0;
  private workspaceId = '';
  private detailKind = '';
  private detailId: string | number | undefined;
  private disposed = false;
  daemonPid: number | undefined;
  private backendIdentity = '';
  private legacyExpectedPid: number | undefined;
  constructor(readonly directory: string, private readonly entry: string) { this.local = new Application(directory, 'client'); this.migration = this.local.migration; }
  async snapshot() { if (!this.socket && !this.disposed) await this.attach(); return this.local.snapshot(); }
  createWorkspace(raw: unknown) { return this.local.createWorkspace(raw); }
  setProxy(raw: unknown) { return this.local.setProxy(raw); }
  async configureSelfHostedTunnel(raw: unknown, workspaceIds: string[], token?: string) {
    const profile = await this.local.configureSelfHostedTunnel(raw, [], token);
    for (const uuid of workspaceIds) await this.bindWorkspace(uuid, { profileId: profile.id });
    return profile;
  }
  configureProviderTunnel(raw: unknown) { return this.local.configureProviderTunnel(raw); }
  discoverSshConnections(options: { authorized: boolean }) { return this.local.discoverSshConnections(options); }
  async setSharedOpenAiTunnelId(profileId: string, value: string): Promise<void> { await this.request('openAiSharedId', { profileId, tunnelId: value }); }
  async diagnoseConfiguration(): Promise<ConfigurationComparison> {
    const client = await this.local.configurationDiagnostics();
    let backend: ConfigurationReport | null = null, backendError: string | undefined;
    try { backend = await this.request('diagnostics') as ConfigurationReport; }
    catch (error) { backendError = error instanceof Error ? error.message : '后台诊断读取失败'; if (backendError === '未知后台操作') backendError = `后台 PID ${this.daemonPid ?? '?'} 尚未加载诊断功能，需要重启后台服务`; }
    const comparison = compareConfiguration(client, backend, backendError);
    await this.local.diagnostics.record('configuration.compared', { comparison }); return comparison;
  }
  async bindWorkspace(uuid: string, binding: unknown, context?: BindDiagnosticContext): ReturnType<Application['bindWorkspace']> {
    await this.connect(true);
    const comparison = await this.diagnoseConfiguration();
    if (comparison.sameFile === false || comparison.sameStorage === false) throw new Error(`前后台实际存储不同，已取消绑定。客户端：${comparison.client.configRealPath}；后台：${comparison.backend?.configRealPath}。按 d 查看诊断。`);
    const selected = context?.selection ?? comparison.client.workspaces.find((workspace) => workspace.uuid === uuid);
    const diagnostic: BindDiagnosticContext = { requestId: context?.requestId ?? randomUUID(), ...(selected ? { selection: { uuid: selected.uuid, name: selected.name, projectRoot: selected.projectRoot } } : {}) };
    await this.local.diagnostics.record('binding.requested', { requestId: diagnostic.requestId, workspaceId: uuid, selection: diagnostic.selection ?? null,
      clientConfigPath: comparison.client.configPath, backendConfigPath: comparison.backend?.configPath ?? null, comparison });
    try { return await this.request('workspaceBind', { workspaceId: uuid, binding, diagnostic }) as Awaited<ReturnType<Application['bindWorkspace']>>; }
    catch (error) { await this.local.diagnostics.record('binding.response-failed', { requestId: diagnostic.requestId, workspaceId: uuid, error: this.runtime.redact(error instanceof Error ? error.message : '绑定失败') }); throw error; }
  }
  async removeWorkspace(uuid: string): ReturnType<Application['removeWorkspace']> {
    return await this.request('workspaceRemove', { workspaceId: uuid }) as Awaited<ReturnType<Application['removeWorkspace']>>;
  }
  async attach(): Promise<boolean> { try { await this.connect(false); await this.request('state'); return true; } catch { return false; } }
  selectWorkspace(workspaceId: string): void {
    this.workspaceId = workspaceId;
    if (this.socket) void this.request('watch', this.watchParams()).catch(() => {});
  }
  selectDetail(kind: string, id?: string | number): void {
    this.detailKind = kind; this.detailId = id;
    if (this.socket) void this.request('watch', this.watchParams()).catch(() => {});
  }
  private watchParams() { return { workspaceId: this.workspaceId, detailKind: this.detailKind, detailId: this.detailId }; }
  private apply(state: DaemonState): void {
    if (this.legacyExpectedPid !== undefined && state.pid !== this.legacyExpectedPid) { this.socket?.destroy(new Error('旧后台进程与本目录元数据不符')); return; }
    const identity = `${state.pid}:${state.instanceId}`;
    if (identity !== this.backendIdentity) {
      this.backendIdentity = identity;
      void this.local.diagnostics.record('backend.connected', { daemonPid: state.pid, clientConfigPath: this.local.store.path,
        backendConfigPath: state.configPath ?? '(旧后台未提供)', backendDataDirectory: state.dataDirectory ?? '(旧后台未提供)', backendLogPath: state.diagnosticsLog ?? null });
    }
    this.daemonPid = state.pid; this.views = state.processes;
    this.runtime.importRemote(state);
  }
  private async connectLegacyOwned(): Promise<Socket | undefined> {
    const file = join(this.directory, 'runtime', 'service.json');
    try {
      const [physical, marker] = await Promise.all([realpath(file), storageIdentityPath(this.directory)]);
      const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
      if (normalize(dirname(physical)) !== normalize(dirname(marker))) return;
      const metadata = JSON.parse(await readFile(file, 'utf8')) as { pid?: number; endpoint?: string };
      if (!metadata.pid || metadata.endpoint !== legacyDaemonEndpoint(this.directory)) return;
      const socket = await connectDaemon(this.directory, true); this.legacyExpectedPid = metadata.pid; return socket;
    } catch { return; }
  }
  private async connect(launch: boolean): Promise<void> {
    if (this.disposed) throw new Error('管理界面已断开');
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let socket: Socket;
      try { socket = await connectDaemon(this.directory); this.legacyExpectedPid = undefined; }
      catch (error) {
        const legacySocket = await this.connectLegacyOwned();
        if (legacySocket) socket = legacySocket;
        else {
        if (!launch) throw error;
        const path = join(this.directory, 'runtime', 'service.log');
        await assertNoDestinationLinks(this.directory, path); await mkdir(join(this.directory, 'runtime'), { recursive: true, mode: 0o700 });
        const log = await open(path, 'a', 0o600);
        try {
          const child = spawn(process.execPath, [this.entry, '--data-dir', this.directory], { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env } });
          await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', reject); }); child.unref();
        } finally { await log.close(); }
        const deadline = Date.now() + 10_000;
        while (true) {
          if (this.disposed) throw new Error('管理界面已退出，后台启动可继续');
          try { socket = await connectDaemon(this.directory); break; }
          catch { if (Date.now() > deadline) throw new Error(`后台服务启动失败，请查看 ${path}`); await new Promise((done) => setTimeout(done, 200)); }
        }
        }
      }
      if (this.disposed) { socket.destroy(); throw new Error('管理界面已断开'); }
      this.socket = socket; let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk; if (buffer.length > 64 * 1024 * 1024) { socket.destroy(new Error('后台状态过大')); return; }
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const message = JSON.parse(line) as { event?: string; data?: DaemonState; id?: number; result?: unknown; error?: string };
            if (message.event === 'state' && message.data) this.apply(message.data);
            if (message.id !== undefined) {
              const pending = this.requests.get(message.id); if (!pending) continue;
              clearTimeout(pending.timer); this.requests.delete(message.id);
              if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
            }
          } catch {}
        }
      });
      const disconnected = () => {
        if (this.socket === socket) this.socket = undefined;
        this.legacyExpectedPid = undefined;
        for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('后台服务连接已断开')); }
        this.requests.clear(); this.views = []; this.runtime.serviceOrigin = ''; this.runtime.serviceError = this.disposed ? '' : '后台服务连接已断开，按 r 重新连接'; this.runtime.changed();
      };
      socket.on('error', () => {}); socket.once('close', disconnected);
      socket.write(JSON.stringify({ id: ++this.id, method: 'watch', params: this.watchParams() }) + '\n');
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.connect(['start', 'tunnels', 'workspaceBind', 'workspaceRemove', 'openAiSharedId'].includes(method));
    if (this.legacyExpectedPid !== undefined && !['state', 'watch', 'shutdown', 'diagnostics'].includes(method)) throw new Error('当前连接的是旧版后台，请先运行 better-gpt service stop，再重新启动服务以启用物理配置路径隔离');
    if (this.disposed) throw new Error('管理界面已断开');
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('后台操作超时；服务可能仍在处理，请刷新状态')); }, 65_000);
      this.requests.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async startGateway(port = Number(process.env.BETTER_GPT_PORT ?? 18921), profileId?: string, localOnly = false): Promise<{ service: { port: number; origin: string }; tunnels: TunnelRuntime[] }> {
    const result = await this.request('start', { port, ...(profileId ? { profileId } : {}), localOnly }) as { service: { port: number; origin: string }; tunnels: TunnelRuntime[] };
    await this.request('watch', this.watchParams()); return result;
  }
  async stopService(): Promise<void> { await this.request('stop'); }
  async controlTunnels(input: TunnelControl): ReturnType<Application['controlTunnels']> {
    return await this.request('tunnels', input) as Awaited<ReturnType<Application['controlTunnels']>>;
  }
  async shutdown(): Promise<void> { await this.request('shutdown'); }
  async status(): Promise<DaemonState | null> { try { return await this.request('state') as DaemonState; } catch { return null; } }
  async stopProcess(workspaceId: string, sessionId: number): Promise<void> { await this.request('stopProcess', { workspaceId, sessionId }); }
  async dispose(): Promise<void> {
    this.disposed = true; this.socket?.destroy(); this.socket = undefined;
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('管理界面已退出，后台操作继续执行')); }
    this.requests.clear(); this.runtime.dispose();
  }
}
