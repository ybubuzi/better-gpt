import { createHash, randomUUID } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { chmod, lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Application } from './application.js';
import { assertNoDestinationLinks } from './destination-guard.js';
import type { CallLog, ManagedProcessView, TunnelRuntime } from '@better-gpt/contracts';
import type { BindDiagnosticContext } from './configuration-diagnostics.js';
import { storageIdentityPath } from './storage-identity.js';

export interface DaemonState {
  dataDirectory?: string; configPath?: string; diagnosticsLog?: string; storageIdentityFile?: string;
  pid: number; instanceId: string; workspaceId: string; serviceOrigin: string; serviceError: string;
  logs: CallLog[]; tunnels: TunnelRuntime[]; processes: ManagedProcessView[];
  mcps?: Record<string, unknown>[];
  summary?: { workspaceId: string; title: string; text: string; endedAt: string };
}
export function legacyDaemonEndpoint(directory: string): string {
  const identity = process.platform === 'win32' ? resolve(directory).toLowerCase() : resolve(directory);
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\better-gpt-${hash}` : join(directory, 'runtime', 'control.sock');
}
export async function daemonEndpoint(directory: string): Promise<string> {
  const physical = await storageIdentityPath(directory), identity = process.platform === 'win32' ? physical.toLowerCase() : physical;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\better-gpt-v2-${hash}` : join(dirname(physical), 'control.sock');
}
export async function connectDaemon(directory: string, legacy = false): Promise<Socket> {
  const endpoint = legacy ? legacyDaemonEndpoint(directory) : await daemonEndpoint(directory);
  return new Promise((resolveConnection, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => socket.destroy(new Error('后台服务连接超时')), 1500);
    socket.once('connect', () => { clearTimeout(timer); resolveConnection(socket); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Local IPC only: Windows named pipe / permission-restricted Unix socket. No public control URL. */
export async function runDaemon(directory: string): Promise<void> {
  const app = new Application(directory, 'daemon');
  const runtimeDirectory = join(directory, 'runtime');
  const metadataPath = join(runtimeDirectory, 'service.json');
  await assertNoDestinationLinks(directory, metadataPath);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const endpoint = await daemonEndpoint(directory), storageIdentityFile = await storageIdentityPath(directory), instanceId = randomUUID();
  const sockets = new Set<Socket>();
  let stopping = false;
  let closeOperation: Promise<void> | undefined;
  const server = createServer((socket) => {
    sockets.add(socket); let buffer = '', workspaceId = '', detailKind = '', detailId: string | number | undefined; let dirty = true;
    const crop = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit)}\n[列表摘要已截断，Enter 打开完整详情]`;
    const state = (): DaemonState => ({ pid: process.pid, instanceId, workspaceId, dataDirectory: resolve(app.store.directory), configPath: resolve(app.store.path), diagnosticsLog: app.diagnostics.logPath, storageIdentityFile,
      serviceOrigin: app.runtime.serviceOrigin, serviceError: app.runtime.serviceError,
      mcps: app.runtime.mcps, ...(app.runtime.summary ? { summary: app.runtime.summary } : {}),
      logs: app.runtime.logs(workspaceId).map((log) => detailKind === 'log' && log.id === detailId ? log : { ...log,
        command: crop(log.command, 2000), args: crop(log.args, 4000), result: crop(log.result, 8000) }),
      tunnels: [...app.runtime.tunnels.values()].map((tunnel) => detailKind === 'catalog' && tunnel.profileId === detailId ? tunnel : { ...tunnel, output: crop(tunnel.output, 2000) }),
      processes: app.processes.list().map((process) => detailKind === 'process' && process.id === detailId && process.workspaceId === workspaceId
        ? process : { ...process, command: crop(process.command, 1000), output: '' }),
    });
    const send = (message: unknown) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n'); };
    const push = () => {
      if (!dirty || socket.destroyed || socket.writableLength > 1024 * 1024) return;
      dirty = false; const data = state();
      // Bound each frame, preserving the selected log and fetching its full detail on demand.
      let budget = 8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify({ ...data, logs: [] }));
      const retained = new Set<string>();
      const selected = data.logs.find((log) => detailKind === 'log' && log.id === detailId);
      for (const log of [...(selected ? [selected] : []), ...[...data.logs].reverse()]) {
        if (retained.has(log.id)) continue;
        const size = Buffer.byteLength(JSON.stringify(log)) + 1;
        if (size > budget) continue; budget -= size; retained.add(log.id);
      }
      data.logs = data.logs.filter((log) => retained.has(log.id));
      send({ event: 'state', data });
    };
    const unsubscribe = app.runtime.subscribe(() => { dirty = true; push(); });
    socket.on('drain', push);
    socket.on('close', () => { sockets.delete(socket); unsubscribe(); });
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 256_000) { socket.destroy(); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        void (async () => {
          let id: unknown;
          try {
            const request = JSON.parse(line) as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
            id = request.id;
            if (typeof id !== 'number' || typeof request.method !== 'string') throw new Error('无效控制请求');
            if (stopping && request.method !== 'state') throw new Error('后台服务正在关闭');
            const params = request.params ?? {};
            let result: unknown;
            switch (request.method) {
              case 'state': result = state(); break;
              case 'diagnostics': result = await app.configurationDiagnostics(); break;
              case 'watch':
                workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
                detailKind = typeof params.detailKind === 'string' ? params.detailKind : '';
                detailId = typeof params.detailId === 'string' || typeof params.detailId === 'number' ? params.detailId : undefined;
                dirty = true; push(); result = null; break;
              case 'start': {
                const port = typeof params.port === 'number' ? params.port : 18921;
                const profile = typeof params.profileId === 'string' ? params.profileId : undefined;
                if (params.localOnly === true) { const service = await app.startService(port, profile); result = { service: { port: service.port, origin: service.origin }, tunnels: [] }; }
                else { const gateway = await app.startGateway(port, profile); result = { service: { port: gateway.service.port, origin: gateway.service.origin }, tunnels: gateway.tunnels }; }
                break;
              }
              case 'stop': await app.stopService(); result = state(); break;
              case 'tunnels': result = await app.controlTunnels(params); break;
              case 'workspaceBind':
                if (typeof params.workspaceId !== 'string') throw new Error('工作区参数无效');
                result = await app.bindWorkspace(params.workspaceId, params.binding, params.diagnostic as BindDiagnosticContext | undefined); break;
              case 'workspaceRemove':
                if (typeof params.workspaceId !== 'string') throw new Error('工作区参数无效');
                result = await app.removeWorkspace(params.workspaceId); break;
              case 'openAiSharedId':
                if (typeof params.profileId !== 'string' || typeof params.tunnelId !== 'string') throw new Error('隧道参数无效');
                await app.setSharedOpenAiTunnelId(params.profileId, params.tunnelId); result = null; break;
              case 'stopProcess': {
                if (typeof params.workspaceId !== 'string' || typeof params.sessionId !== 'number') throw new Error('进程参数无效');
                await app.stopProcess(params.workspaceId, params.sessionId); result = null; break;
              }
              case 'shutdown': await app.stopService(); send({ id, result: { stopped: true } }); void shutdown(); return;
              default: throw new Error('未知后台操作');
            }
            dirty = true; push(); send({ id, result });
          } catch (error) { send({ id, error: app.runtime.redact(error instanceof Error ? error.message : '后台操作失败') }); }
        })();
      }
    });
    push();
  });

  const shutdown = (): Promise<void> => closeOperation ??= (async () => {
    stopping = true;
    try {
      await app.dispose();
      for (const socket of sockets) socket.end();
      await new Promise<void>((done) => {
        const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 1500);
        server.close(() => { clearTimeout(timer); done(); });
      });
      try {
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { instanceId?: string };
        if (metadata.instanceId === instanceId) await unlink(metadataPath);
      } catch {}
    } catch (error) {
      stopping = false; closeOperation = undefined;
      app.runtime.serviceError = '后台服务未能完全停止，可重试停止操作'; app.runtime.changed(); throw error;
    }
  })();

  const startupPath = join(runtimeDirectory, 'startup.lock');
  const startup = await open(startupPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error(`后台正在启动，或启动锁遗留。确认已有进程状态后检查 ${startupPath}`);
    throw error;
  });
  let initializationError: unknown;
  try {
  await startup.writeFile(JSON.stringify({ pid: process.pid, instanceId, startedAt: new Date().toISOString() }));
  if (process.platform !== 'win32') {
    // A crashed daemon may leave a socket file. Only recover it when its recorded owner is gone.
    try {
      const socket = await connectDaemon(directory); socket.destroy(); throw new Error('后台服务已经运行');
    } catch (error) {
      if (error instanceof Error && error.message === '后台服务已经运行') throw error;
      const info = await lstat(endpoint).catch(() => undefined);
      if (info) {
        if (!info.isSocket()) throw new Error('后台服务入口被普通文件占用');
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { pid: number };
        let alive = true; try { process.kill(metadata.pid, 0); } catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw new Error('后台服务仍存活，但无法连接控制入口');
        await unlink(endpoint);
      }
    }
  }
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.off('error', reject); done(); }); });
  if (process.platform !== 'win32') await chmod(endpoint, 0o600);
  await writeFile(metadataPath, JSON.stringify({ version: 2, pid: process.pid, instanceId, endpoint, storageIdentityFile, startedAt: new Date().toISOString() }), { mode: 0o600 });
  } catch (error) {
    initializationError = error;
  } finally {
    try { await startup.close(); await unlink(startupPath); }
    catch (error) { initializationError ??= error; }
  }
  if (initializationError) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    await app.dispose(); throw initializationError;
  }
  await app.configurationDiagnostics();
  const signal = () => { void shutdown().catch((error: unknown) => { process.stderr.write(app.runtime.redact(String(error)) + '\n'); process.exitCode = 1; }); };
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
}
