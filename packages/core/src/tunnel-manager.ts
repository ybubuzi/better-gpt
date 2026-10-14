import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { mkdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AppConfig, TunnelRuntime } from '@better-gpt/contracts';
import type { Application } from './application.js';
import { SecretVault } from './secret-vault.js';
import { assertNoDestinationLinks } from './destination-guard.js';
import { startLocalService, type LocalService } from './server.js';
import { childEnvironment } from './process-manager.js';
import { assertNoExistingConnector, findCloudflared, processIdentities, spawnTunnel, stopTunnelProcess } from './tunnel-process.js';
import { planTunnels, type TunnelPlan } from './tunnels.js';
import { ensureFrpc, frpConfiguration } from './frp.js';
import { networkFetch, proxyAddress } from './network.js';

interface Session {
  view: TunnelRuntime; controller: AbortController; startup?: Promise<void>; cleanup?: Promise<void>;
  child?: ChildProcessWithoutNullStreams; origin?: LocalService; directory?: string; monitor?: NodeJS.Timeout;
  metricsPort?: number; closed: boolean; stopping: boolean; probeBusy: boolean;
  probe?: () => Promise<boolean>;
  retry?: NodeJS.Timeout;
}

function ready(port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get({ hostname: '127.0.0.1', port, path: '/ready', signal, timeout: 2000 }, (response) => {
      response.resume(); resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => request.destroy());
  });
}

/** Credentials are only passed through the child environment, never argv or generated YAML. */
export function cloudflareConfiguration(plan: TunnelPlan, origin: string): string {
  if (plan.profile.provider !== 'cloudflare') throw new Error('隧道类型不匹配');
  return [
    `tunnel: ${JSON.stringify(plan.profile.tunnelId)}`, 'no-autoupdate: true',
    'metrics: "127.0.0.1:0"', 'grace-period: 2s',
    'ingress:', `  - hostname: ${JSON.stringify(new URL(plan.profile.publicBaseUrl).hostname)}`,
    `    service: ${JSON.stringify(origin)}`, '    originRequest:',
    `      httpHostHeader: ${JSON.stringify(new URL(origin).host)}`,
    '      connectTimeout: 10s', '  - service: http_status:404', '',
  ].join('\n');
}

export class TunnelManager {
  private readonly sessions = new Map<string, Session>();
  private startOperation: Promise<TunnelRuntime[]> | undefined;
  private stopOperation: Promise<void> | undefined;
  private closing = false;
  constructor(private readonly app: Application) {}

  start(config: AppConfig, profileId?: string | string[]): Promise<TunnelRuntime[]> {
    if (this.stopOperation) return Promise.reject(new Error('隧道正在停止，请等待完成后重试'));
    if (this.startOperation) return this.startOperation.then(() => this.start(config, profileId));
    this.closing = false;
    this.startOperation = (async () => {
      const allPlans = planTunnels(config);
      const ids = typeof profileId === 'string' ? [profileId] : profileId;
      const plans = allPlans.filter((plan) => !ids || ids.includes(plan.profile.id));
      await this.reconcile(config);
      await Promise.all(plans.map(async (plan) => {
        if (this.closing) return;
        const existing = this.sessions.get(plan.profile.id);
        if (existing && ['starting', 'connected', 'reconnecting', 'external'].includes(existing.view.status)) return;
        if (existing) await this.cleanup(existing);
        if (this.closing) return;
        const view: TunnelRuntime = { profileId: plan.profile.id, name: plan.profile.name,
          provider: plan.profile.provider, status: 'starting', origin: '', output: '', error: '' };
        const session: Session = { view, controller: new AbortController(), closed: false, stopping: false, probeBusy: false };
        this.sessions.set(plan.profile.id, session);
        this.app.runtime.tunnels.set(plan.profile.id, view);
        this.app.runtime.changed();
        session.startup = this.launch(session, plan, config).catch(async (error: unknown) => {
          if (!session.stopping) {
            view.status = 'failed'; view.error = this.app.runtime.redact(error instanceof Error ? error.message : '隧道启动失败');
            this.log(session, view.error);
          }
          await this.cleanup(session).catch((error: unknown) => this.log(session, error instanceof Error ? error.message : '清理未完成'));
        });
        await session.startup;
      }));
      return plans.flatMap((plan) => { const value = this.app.runtime.tunnels.get(plan.profile.id); return value ? [value] : []; });
    })().finally(() => { this.startOperation = undefined; });
    return this.startOperation;
  }

  private log(session: Session, text: string): void {
    session.view.output = (session.view.output + this.app.runtime.redact(text) + '\n').slice(-32_000);
    if (session.view.provider === 'ssh') void this.app.diagnostics.record('ssh.connector-output', { profileId: session.view.profileId, profileName: session.view.name,
      status: session.view.status, message: this.app.runtime.redact(text).slice(0, 8000) });
    this.app.runtime.changed();
  }

  private async launch(session: Session, plan: TunnelPlan, config: AppConfig): Promise<void> {
    const { profile } = plan;
    if (profile.provider === 'external') {
      session.origin = await startLocalService(this.app, profile.localPort, profile.id, { managedListener: true, publicHostname: new URL(profile.publicBaseUrl).hostname });
      session.view.origin = session.origin.origin;
      session.view.status = 'external';
      this.log(session, `外部隧道请转发到 ${session.origin.origin}；仅允许此配置绑定的工作区。本应用不启动外部连接器，公网连通性请使用 tunnel doctor 检查。`);
      return;
    }
    if (profile.provider === 'frp' || profile.provider === 'ssh') { await this.launchFrp(session, plan, config); return; }
    if (profile.provider !== 'cloudflare') throw new Error(`${profile.provider} 运行器尚未接入；仅有配置不能建立公网连接。`);
    await assertNoExistingConnector(profile, config, this.app.store.directory, (message) => this.log(session, message));
    session.controller.signal.throwIfAborted();
    const executable = await findCloudflared(profile, this.app.store.directory);
    const bytes = await new SecretVault(this.app.store.directory).read(profile.credentialRef);
    let credentials: { TunnelID?: string; AccountTag?: string; TunnelSecret?: string };
    try { credentials = JSON.parse(bytes.toString('utf8')) as typeof credentials; }
    catch { throw new Error('Cloudflare 运行凭据格式无效'); }
    if (credentials.TunnelID?.toLowerCase() !== profile.tunnelId.toLowerCase() || !credentials.AccountTag || !credentials.TunnelSecret) {
      throw new Error('Cloudflare 凭据与隧道 ID 不匹配或缺少运行字段');
    }
    this.app.runtime.protectSecret(bytes.toString('utf8'));
    this.app.runtime.protectSecret(JSON.stringify(credentials));
    this.app.runtime.protectSecret(credentials.TunnelSecret);
    session.controller.signal.throwIfAborted();
    session.origin = await startLocalService(this.app, 0, profile.id, {
      managedListener: true, publicHostname: new URL(profile.publicBaseUrl).hostname,
    });
    session.view.origin = session.origin.origin;
    const directory = join(this.app.store.directory, 'runtime', `cf-${profile.id}-${randomUUID()}`);
    const file = join(directory, 'cloudflared.yml');
    await assertNoDestinationLinks(this.app.store.directory, file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    session.directory = directory;
    const owner = (await processIdentities()).find((item) => item.pid === process.pid);
    if (!owner) throw new Error('无法记录连接器所有者身份');
    await writeFile(join(directory, 'owner.json'), JSON.stringify({ version: 1, owner: { pid: owner.pid, createdAt: owner.createdAt } }), { flag: 'wx', mode: 0o600 });
    await writeFile(file, cloudflareConfiguration(plan, session.origin.origin), { flag: 'wx', mode: 0o600 });
    session.controller.signal.throwIfAborted();
    const proxy = profile.proxy ?? config.proxy;
    const address = await proxyAddress(proxy, this.app.store.directory); if (address) this.app.runtime.protectSecret(address);
    const env = childEnvironment(proxy, address);
    // Prevent inherited cloudflared settings from selecting another tunnel or untrusted config.
    for (const key of Object.keys(env)) if (/^TUNNEL_|^BETTER_GPT_/i.test(key)) delete env[key];
    env.TUNNEL_CRED_CONTENTS = JSON.stringify(credentials);
    const args = ['tunnel', '--config', file, '--no-autoupdate', '--output', 'json',
      '--protocol', 'auto', '--edge-ip-version', '4', 'run', profile.tunnelId];
    this.log(session, `启动 cloudflared；独立入口 ${session.origin.origin}，仅允许此配置绑定的 ${plan.workspaces.length} 个工作区。`);
    if (proxy.mode !== 'direct') this.log(session, '已传递代理环境变量。cloudflared 的边缘隧道连接使用原生网络；HTTP/SOCKS 环境代理不保证代理该连接。');
    const child = await spawnTunnel(executable, args, env, directory);
    session.child = child;
    if (child.pid) session.view.pid = child.pid;
    let failure: string | undefined;
    child.once('error', (error) => { failure = this.app.runtime.redact(error.message); });
    const read = (stream: typeof child.stdout) => {
      stream.setEncoding('utf8'); let pending = '';
      const line = (text: string) => {
        text = text.replace(/\r$/, '');
        if (text.startsWith('__BETTER_GPT_NATIVE__')) return;
        this.log(session, text);
        const match = /Starting metrics server on (?:127\.0\.0\.1|localhost):(\d+)/.exec(text);
        if (match) session.metricsPort = Number(match[1]);
      };
      stream.on('data', (chunk: string) => {
        pending += chunk;
        let index: number;
        while ((index = pending.indexOf('\n')) >= 0) { line(pending.slice(0, index)); pending = pending.slice(index + 1); }
        if (pending.length > 128_000) { pending = ''; this.log(session, '[过长日志已丢弃]'); }
      });
      stream.on('end', () => { if (pending) line(pending); });
    };
    read(child.stdout); read(child.stderr);
    child.once('close', (code, signal) => {
      session.closed = true;
      if (!session.stopping && session.view.status !== 'starting') {
        session.view.status = 'failed'; session.view.error = failure ?? `cloudflared 意外退出（${code ?? signal ?? '未知'}）；按 t 重试。`;
        this.log(session, session.view.error);
        void this.cleanup(session).catch((error: unknown) => this.log(session, error instanceof Error ? error.message : '清理失败'));
      }
    });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      session.controller.signal.throwIfAborted();
      if (failure || session.closed) throw new Error(failure ?? 'cloudflared 在连接成功前退出，请查看隧道日志。');
      if (session.metricsPort && await ready(session.metricsPort, session.controller.signal)) {
        session.controller.signal.throwIfAborted();
        if (failure || session.closed || child.exitCode !== null || child.signalCode !== null) {
          throw new Error(failure ?? 'cloudflared 在就绪检查期间退出，请查看隧道日志。');
        }
        session.view.status = 'connected'; session.view.connectedAt = Date.now();
        this.log(session, 'Cloudflare 已确认边缘连接就绪；公网域名的 DNS/Access 策略仍以 Cloudflare 配置为准。');
        session.monitor = setInterval(() => { void this.monitor(session); }, 5000);
        session.monitor.unref(); return;
      }
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); session.controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 250);
        session.controller.signal.addEventListener('abort', done, { once: true });
      });
    }
    throw new Error('等待 Cloudflare 就绪超过 45 秒，已停止本次连接器。请检查隧道日志、网络和凭据。');
  }

  private async launchFrp(session: Session, plan: TunnelPlan, config: AppConfig): Promise<void> {
    const profile = plan.profile; if (profile.provider !== 'frp' && profile.provider !== 'ssh') throw new Error('隧道类型不匹配');
    if (profile.provider === 'ssh' && (!isAbsolute(profile.identityFile) || !isAbsolute(profile.knownHostsFile) || /[\r\n"]/.test(profile.knownHostsFile))) throw new Error('SSH私钥及known_hosts必须使用绝对路径，known_hosts不能包含换行或双引号');
    const executable = profile.executable ?? (profile.provider === 'frp' ? await ensureFrpc(this.app.store.directory, { ...config, proxy: profile.proxy ?? config.proxy }) : process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : '/usr/bin/ssh');
    const token = profile.provider === 'frp' ? (await new SecretVault(this.app.store.directory).read(profile.credentialRef)).toString('utf8').trim() : '';
    if (profile.provider === 'frp' && !token) throw new Error('frp运行凭据为空'); if (token) this.app.runtime.protectSecret(token);
    const proxy = profile.proxy ?? config.proxy, address = await proxyAddress(proxy, this.app.store.directory);
    await this.app.diagnostics.record('tunnel.starting', { profileId: profile.id, provider: profile.provider, name: profile.name,
      serverAddress: profile.serverAddress, serverPort: profile.serverPort, remotePort: profile.remotePort, publicBaseUrl: profile.publicBaseUrl,
      ...(profile.provider === 'ssh' ? { sshHostAlias: profile.sshHostAlias ?? null, sshConfigFile: profile.sshConfigFile ?? null, knownHostsFile: profile.knownHostsFile } : {}),
      effectiveProxyMode: proxy.mode, profileProxyOverride: !!profile.proxy,
      workspaces: plan.workspaces.map((workspace) => workspace.uuid) });
    if (profile.provider === 'frp' && address && !['http:', 'socks5:', 'socks5h:'].includes(new URL(address).protocol)) throw new Error('frpc仅支持HTTP/SOCKS5代理，请为此隧道设置对应代理');
    if (address) this.app.runtime.protectSecret(address);
    session.controller.signal.throwIfAborted();
    session.origin = await startLocalService(this.app, 0, profile.id, { managedListener: true, publicHostname: new URL(profile.publicBaseUrl).hostname });
    session.view.origin = session.origin.origin;
    const directory = join(this.app.store.directory, 'runtime', `${profile.provider}-${profile.id}-${randomUUID()}`), file = join(directory, profile.provider === 'frp' ? 'frpc.toml' : 'ssh.json');
    await assertNoDestinationLinks(this.app.store.directory, file); await mkdir(directory, { recursive: true, mode: 0o700 }); session.directory = directory;
    await writeFile(file, profile.provider === 'frp' ? frpConfiguration(profile, session.origin.origin, !!address) : JSON.stringify({ provider: 'ssh', server: profile.serverAddress, remotePort: profile.remotePort }), { flag: 'wx', mode: 0o600 });
    const env = childEnvironment(proxy, address); if (token) env.BETTER_GPT_FRP_TOKEN = token;
    if (address) { env.BETTER_GPT_FRP_PROXY = address.replace(/^socks5h:/, 'socks5:'); env.BETTER_GPT_SSH_PROXY = address; }
    const args = profile.provider === 'frp' ? ['-c', file] : ['-N', '-T', '-F', profile.sshConfigFile ?? 'none', '-p', String(profile.serverPort), '-l', profile.username,
      '-i', profile.identityFile, '-o', `UserKnownHostsFile="${profile.knownHostsFile.replaceAll('\\', '/')}"`, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      ...(profile.hostKeyAlias ? ['-o', `HostKeyAlias=${profile.hostKeyAlias}`] : []),
      ...(address ? ['-o', `ProxyCommand="${process.execPath}" "${fileURLToPath(new URL('./proxy-command.js', import.meta.url))}" %h %p`] : []),
      '-R', `127.0.0.1:${profile.remotePort}:127.0.0.1:${new URL(session.origin.origin).port}`,
      ...(profile.sshHostAlias ? ['-o', `HostName=${profile.serverAddress}`, profile.sshHostAlias] : [profile.serverAddress])];
    session.controller.signal.throwIfAborted();
    const child = await spawnTunnel(executable, args, env, directory); session.child = child; if (child.pid) session.view.pid = child.pid;
    child.once('error', (error) => { session.view.error = this.app.runtime.redact(error.message); });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8'); let pending = '';
      const line = (value: string) => {
        if (value.startsWith('__BETTER_GPT_NATIVE__')) return;
        this.log(session, value);
        if (profile.provider === 'ssh' && /remote port forwarding failed for listen port|cannot listen to port/i.test(value)) session.view.error = `SSH远端转发端口 ${profile.remotePort} 申请失败：可能已被占用或服务器禁止转发。原始信息：${this.app.runtime.redact(value)}`;
        else if (profile.provider === 'ssh' && !session.view.error && /Connection closed by UNKNOWN port|kex_exchange_identification|SSH代理连接失败/i.test(value)) session.view.error = `SSH连接或代理握手失败（服务器端口 ${profile.serverPort}，远端转发端口 ${profile.remotePort}）：${this.app.runtime.redact(value)}`;
      };
      stream.on('data', (chunk: string) => { pending += chunk; let index: number; while ((index = pending.indexOf('\n')) >= 0) { line(pending.slice(0, index).replace(/\r$/, '')); pending = pending.slice(index + 1); } if (pending.length > 128000) pending = ''; });
      stream.on('end', () => { if (pending) line(pending.replace(/\r$/, '')); });
    }
    child.once('close', (code) => {
      session.closed = true;
      if (!session.stopping && session.view.status !== 'starting') {
        session.view.status = 'failed'; session.view.error = `${profile.provider}连接器退出（${code}），将尝试重连`; this.log(session, session.view.error);
        void this.cleanup(session).then(() => { if (session.stopping || this.closing) return; session.retry = setTimeout(() => {
          void this.app.store.read().then(({ config: current }) => { if (!session.stopping && !this.closing && this.sessions.get(profile.id) === session && planTunnels(current).some((entry) => entry.profile.id === profile.id)) return this.start(current); }).catch(() => {});
        }, 5000); session.retry.unref(); }).catch(() => {});
      }
    });
    const request = networkFetch(proxy, this.app.store.directory);
    session.probe = async () => {
      try { const response = await request(new URL('/healthz', profile.publicBaseUrl), { signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(4000)]) });
        if (!response.ok) { void response.body?.cancel(); return false; }
        const info = await response.json() as { profileId?: string }; return info.profileId === profile.id;
      } catch { return false; }
    };
    this.log(session, `${profile.provider}连接器已启动；远端回环端口${profile.remotePort}，仅转发${plan.workspaces.length}个绑定工作区。`);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      session.controller.signal.throwIfAborted(); if (session.closed) throw new Error(session.view.error || `${profile.provider}在公网入口就绪前退出，请查看诊断日志 ${this.app.diagnostics.logPath}`);
      if (await session.probe()) {
        session.controller.signal.throwIfAborted(); if (session.closed || child.exitCode !== null || child.signalCode !== null) throw new Error(`${profile.provider}在检查期间退出`);
        session.view.status = 'connected'; session.view.connectedAt = Date.now(); this.log(session, '自建HTTPS入口已验证，工作区入口身份匹配。');
        session.monitor = setInterval(() => { void this.monitor(session); }, 5000); session.monitor.unref(); return;
      }
      await new Promise((done) => setTimeout(done, 500));
    }
    throw new Error('自建HTTPS入口45秒内未就绪，请检查DNS、TLS、HTTPS反向代理及连接器配置');
  }

  private async monitor(session: Session): Promise<void> {
    if (session.stopping || session.closed || session.probeBusy || (!session.metricsPort && !session.probe)) return;
    session.probeBusy = true;
    try {
      const healthy = session.probe ? await session.probe() : await ready(session.metricsPort!, session.controller.signal);
      if (session.stopping || session.closed) return;
      const status = healthy ? 'connected' : 'reconnecting';
      if (session.view.status !== status) {
        session.view.status = status;
        this.log(session, healthy ? '隧道连接已恢复。' : '隧道连接暂时不可用，连接器正在重连。');
      }
    } finally { session.probeBusy = false; }
  }

  private cleanup(session: Session): Promise<void> {
    return session.cleanup ??= (async () => {
      if (session.monitor) clearInterval(session.monitor);
      if (session.retry) clearTimeout(session.retry);
      const results = await Promise.allSettled([
        session.child ? stopTunnelProcess(session.child) : Promise.resolve(),
        session.origin ? session.origin.close() : Promise.resolve(),
      ]);
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), '隧道资源未能全部停止，请重试');
      if (session.directory) {
        try {
          const file = join(session.directory, session.view.provider === 'frp' ? 'frpc.toml' : session.view.provider === 'ssh' ? 'ssh.json' : 'cloudflared.yml');
          await assertNoDestinationLinks(this.app.store.directory, file);
          await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
          await unlink(join(session.directory, 'owner.json')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
          await rmdir(session.directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
        } catch { this.log(session, '连接器已停止；运行目录无法清空，保留目录供检查（不含运行凭据）。'); }
      }
      session.view.origin = ''; delete session.view.pid;
      this.app.runtime.changed();
    })().catch((error: unknown) => { delete session.cleanup; throw error; });
  }

  private async stopSession(session: Session): Promise<void> {
    session.stopping = true; session.view.status = 'stopping'; session.controller.abort(); this.app.runtime.changed();
    await session.startup;
    await this.cleanup(session);
    session.view.status = 'stopped'; this.app.runtime.changed();
  }

  async reconcile(config: AppConfig): Promise<void> {
    const activeIds = new Set(planTunnels(config).map((plan) => plan.profile.id));
    for (const [id, session] of this.sessions) if (!activeIds.has(id) && session.view.status !== 'stopped') await this.stopSession(session);
  }

  stop(): Promise<void> {
    return this.stopOperation ??= (async () => {
      this.closing = true;
      // Abort before waiting so an unresponsive network cannot delay quitting by 45 seconds.
      for (const session of this.sessions.values()) { session.stopping = true; session.controller.abort(); }
      await this.startOperation?.catch(() => {});
      const results = await Promise.allSettled([...this.sessions.values()].map((session) => this.stopSession(session)));
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), '部分隧道停止失败');
    })().finally(() => { this.stopOperation = undefined; });
  }
}
