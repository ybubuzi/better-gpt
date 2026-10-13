import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { platform } from 'node:os';
import {
  appVersion, createWorkspaceInputSchema, workspaceSchema, tunnelProfileSchema,
  tunnelBindingSchema, proxySchema, type AppSnapshot, type TunnelProfile,
  execCommandInputSchema, writeStdinInputSchema, tunnelControlSchema, providerSetupSchema, tunnelIdSchema,
} from '@better-gpt/contracts';
import { ConfigStore } from './config-store.js';
import { discoverLegacy } from './legacy.js';
import { dataDirectory, requireAbsoluteDirectory } from './paths.js';
import { MigrationService } from './migration.js';
import { RuntimeStore } from './runtime-store.js';
import { ProcessManager } from './process-manager.js';
import { startLocalService, type LocalService } from './server.js';
import { TunnelManager } from './tunnel-manager.js';
import { DownstreamPool } from './downstream.js';
import { WorkspaceFiles } from './workspace-files.js';
import { proxyAddress } from './network.js';
import { SecretVault } from './secret-vault.js';
import { tunnelMatches } from './tunnels.js';
import { discoverSshConnections } from './ssh-discovery.js';
import { assertNoDestinationLinks } from './destination-guard.js';

export class Application {
  readonly store: ConfigStore;
  readonly migration: MigrationService;
  readonly runtime = new RuntimeStore();
  private readonly deletedWorkspaces = new Set<string>();
  readonly processes = new ProcessManager(this.runtime, (uuid) => !this.deletedWorkspaces.has(uuid));
  readonly tunnels = new TunnelManager(this);
  readonly downstream = new DownstreamPool(this);
  private readonly fileServices = new Map<string, WorkspaceFiles>();
  async workspace(uuid: string) {
    const workspace = (await this.store.read()).config.workspaces.find((entry) => entry.uuid === uuid && entry.enabled);
    if (!workspace) throw new Error('工作区不存在或已停用'); return workspace;
  }
  async files(uuid: string): Promise<WorkspaceFiles> {
    const workspace = await this.workspace(uuid);
    let service = this.fileServices.get(uuid);
    if (!service || service.root !== workspace.projectRoot) { service = new WorkspaceFiles(workspace.projectRoot); this.fileServices.set(uuid, service); }
    return service;
  }
  private localService: LocalService | undefined;
  private starting: Promise<LocalService> | undefined;
  private gatewayStarting: Promise<{ service: LocalService; tunnels: import('@better-gpt/contracts').TunnelRuntime[] }> | undefined;
  private stopping: Promise<void> | undefined;
  private tunnelControl: Promise<unknown> = Promise.resolve();
  private controlGeneration = 0;
  constructor(directory = dataDirectory()) {
    this.store = new ConfigStore(directory);
    this.migration = new MigrationService(this.store);
  }

  async snapshot(): Promise<AppSnapshot> {
    const [{ config, initialized }, legacy] = await Promise.all([this.store.read(), discoverLegacy()]);
    return { version: appVersion, platform: platform(), dataDirectory: this.store.directory, initialized, config, legacy };
  }
  async initialize(): Promise<AppSnapshot> {
    await this.store.update((config) => config);
    return this.snapshot();
  }
  discoverSshConnections(options: { authorized: boolean }) {
    return discoverSshConnections({ authorized: options.authorized, managedKnownHostsFile: join(this.store.directory, 'ssh', 'known_hosts') });
  }
  async createWorkspace(raw: unknown): Promise<AppSnapshot> {
    const input = createWorkspaceInputSchema.parse(raw);
    const projectRoot = requireAbsoluteDirectory(input.projectRoot);
    if (!(await stat(projectRoot)).isDirectory()) throw new Error('项目路径不是目录');
    const workspace = workspaceSchema.parse({ uuid: randomUUID(), name: input.name, projectRoot,
      createdAt: new Date().toISOString() });
    await this.store.update((config) => ({ ...config, workspaces: [...config.workspaces, workspace] }));
    return this.snapshot();
  }
  async addTunnelProfile(raw: unknown): Promise<TunnelProfile> {
    const profile = tunnelProfileSchema.parse(raw);
    await this.store.update((config) => ({ ...config, tunnelProfiles: [...config.tunnelProfiles, profile] }));
    return profile;
  }
  async configureProviderTunnel(raw: unknown): Promise<TunnelProfile> {
    const input = providerSetupSchema.parse(raw), id = randomUUID(), vault = new SecretVault(this.store.directory);
    if (input.provider === 'cloudflare') {
      if (!isAbsolute(input.credentialFile)) throw new Error('Cloudflare凭据文件必须使用绝对路径');
      const bytes = await readFile(input.credentialFile);
      if (bytes.length > 1024 * 1024) throw new Error('Cloudflare凭据文件过大');
      let credentials: Record<string, unknown>;
      try { credentials = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Cloudflare凭据文件不是有效JSON'); }
      if (typeof credentials?.TunnelID !== 'string' || typeof credentials.AccountTag !== 'string' || !credentials.AccountTag || typeof credentials.TunnelSecret !== 'string' || !credentials.TunnelSecret) throw new Error('Cloudflare凭据缺少TunnelID/AccountTag/TunnelSecret');
      const profile = tunnelProfileSchema.parse({ id, provider: 'cloudflare', name: input.name, publicBaseUrl: input.publicBaseUrl, tunnelId: credentials.TunnelID, credentialRef: `vault:cloudflare:${id}`, ...(input.executable ? { executable: input.executable } : {}) });
      if ((await this.store.read()).config.tunnelProfiles.some((entry) => entry.provider === 'cloudflare' && entry.tunnelId.toLowerCase() === credentials.TunnelID!.toString().toLowerCase())) throw new Error('这个Cloudflare隧道已经配置，请直接复用已有配置');
      await vault.put(profile.provider === 'cloudflare' ? profile.credentialRef : '', bytes);
      return this.addTunnelProfile(profile);
    }
    const runtimeKeyRef = `vault:openai:${id}`;
    await vault.put(runtimeKeyRef, Buffer.from(input.runtimeKey));
    return this.addTunnelProfile({ id, provider: 'openai', name: input.name, runtimeKeyRef, tunnelId: input.tunnelId, ...(input.executable ? { executable: input.executable } : {}) });
  }
  async setSharedOpenAiTunnelId(profileId: string, value: string): Promise<void> {
    const tunnelId = tunnelIdSchema.parse(value);
    await this.workspaceMutation(async () => {
      await this.store.update((config) => {
        if (!config.tunnelProfiles.some((profile) => profile.id === profileId && profile.provider === 'openai')) throw new Error('ChatGPT隧道配置不存在');
        return { ...config, tunnelProfiles: config.tunnelProfiles.map((profile) => profile.id === profileId && profile.provider === 'openai' ? { ...profile, tunnelId } : profile) };
      });
    });
  }
  async configureSelfHostedTunnel(raw: unknown, workspaceIds: string[], token?: string): Promise<TunnelProfile> {
    const profile = tunnelProfileSchema.parse(raw);
    if (!['frp', 'ssh', 'external'].includes(profile.provider)) throw new Error('此向导仅用于自建或外部隧道');
    if (profile.provider === 'ssh') {
      const managedHosts = join(this.store.directory, 'ssh', 'known_hosts');
      if (resolve(profile.knownHostsFile) === resolve(managedHosts)) {
        await assertNoDestinationLinks(this.store.directory, managedHosts);
        await mkdir(join(this.store.directory, 'ssh'), { recursive: true, mode: 0o700 });
        await writeFile(managedHosts, '', { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      }
      for (const path of [profile.identityFile, profile.knownHostsFile]) if (!isAbsolute(path) || !(await stat(path)).isFile()) throw new Error('SSH密钥和known_hosts必须是存在的绝对文件路径');
      if (profile.sshConfigFile && (!isAbsolute(profile.sshConfigFile) || !(await stat(profile.sshConfigFile)).isFile())) throw new Error('SSH config必须是存在的绝对文件路径');
    }
    const config = (await this.store.read()).config;
    if (workspaceIds.some((id) => !config.workspaces.some((workspace) => workspace.uuid === id))) throw new Error('所选工作区不存在');
    if (profile.provider === 'frp' && token !== undefined) {
      if (!token.trim()) throw new Error('frp认证Token不能为空');
      await new SecretVault(this.store.directory).put(profile.credentialRef, Buffer.from(token));
    }
    await this.store.update((current) => ({ ...current, tunnelProfiles: [...current.tunnelProfiles, profile],
      workspaces: current.workspaces.map((workspace) => workspaceIds.includes(workspace.uuid) ? { ...workspace, tunnelBinding: { profileId: profile.id } } : workspace) }));
    return profile;
  }
  bindWorkspace(uuid: string, raw: unknown) {
    const binding = raw === null ? null : tunnelBindingSchema.parse(raw);
    return this.workspaceMutation(async () => {
      const config = await this.store.update((current) => {
        if (!current.workspaces.some((workspace) => workspace.uuid === uuid)) throw new Error('工作区不存在');
        return { ...current, workspaces: current.workspaces.map((workspace) => workspace.uuid === uuid ? { ...workspace, tunnelBinding: binding,
          ...(workspace.tunnelBinding?.openAiTunnelId ? { legacyOpenAiTunnelId: workspace.tunnelBinding.openAiTunnelId } : {}) } : workspace) };
      });
      await this.tunnels.reconcile(config);
      const workspace = config.workspaces.find((entry) => entry.uuid === uuid)!;
      if (binding && this.localService && workspace.enabled && workspace.tunnelEnabled && !this.stopping) {
        const views = await this.tunnels.start(config, binding.profileId);
        const failed = views.find((entry) => entry.status === 'failed');
        if (failed) return { warning: `绑定已保存；${failed.error}` };
      }
      this.runtime.changed(); return {} as { warning?: string };
    });
  }
  removeWorkspace(uuid: string) {
    return this.workspaceMutation(async () => {
      this.deletedWorkspaces.add(uuid);
      let config;
      try { config = await this.store.update((current) => {
        if (!current.workspaces.some((workspace) => workspace.uuid === uuid)) throw new Error('工作区不存在');
        return { ...current, workspaces: current.workspaces.filter((workspace) => workspace.uuid !== uuid) };
      }); } catch (error) { this.deletedWorkspaces.delete(uuid); throw error; }
      await Promise.all([this.processes.stopWorkspace(uuid), this.tunnels.reconcile(config)]);
      this.fileServices.delete(uuid); this.runtime.changed();
      return { removed: true, projectFilesPreserved: true };
    });
  }
  private workspaceMutation<T>(action: () => Promise<T>): Promise<T> {
    const previousGateway = this.gatewayStarting, generation = this.controlGeneration;
    const operation = this.tunnelControl.then(async () => {
      await previousGateway?.catch(() => {});
      if (this.stopping || generation !== this.controlGeneration) throw new Error('服务正在停止，请稍后修改工作区');
      return action();
    });
    this.tunnelControl = operation.catch(() => {}); return operation;
  }
  async setProxy(raw: unknown): Promise<void> {
    const proxy = proxySchema.parse(raw);
    await this.store.update((config) => ({ ...config, proxy }));
  }
  async executeCommand(workspaceId: string, raw: unknown) {
    return this.runtime.trace(workspaceId, 'exec_command', raw && typeof raw === 'object' ? raw as Record<string, unknown> : { invalidArguments: raw }, async () => {
      const input = execCommandInputSchema.parse(raw);
      const config = (await this.store.read()).config;
      const workspace = config.workspaces.find((entry) => entry.uuid === workspaceId && entry.enabled);
      if (!workspace) throw new Error('工作区不存在或未启用');
      const address = await proxyAddress(config.proxy, this.store.directory);
      if (address) this.runtime.protectSecret(address);
      return this.processes.start(workspace, input, config.proxy, address);
    });
  }
  async writeStdin(workspaceId: string, raw: unknown) {
    return this.runtime.trace(workspaceId, 'write_stdin', raw && typeof raw === 'object' ? raw as Record<string, unknown> : { invalidArguments: raw },
      () => this.processes.poll(workspaceId, writeStdinInputSchema.parse(raw)));
  }
  async stopProcess(workspaceId: string, id: number): Promise<void> {
    await this.runtime.trace(workspaceId, 'stop_process', { session_id: id, purpose: '手动结束进程' },
      async () => { await this.processes.stop(workspaceId, id); return { session_id: id, stopped: true }; });
  }
  async startService(port = Number(process.env.BETTER_GPT_PORT ?? 18921), profileId?: string): Promise<LocalService> {
    if (this.stopping) throw new Error('服务正在停止，请稍后再启动');
    if (this.localService) return this.localService;
    this.starting ??= startLocalService(this, port, profileId).then((service) => { this.localService = service; this.downstream.activate(); return service; })
      .catch((error: unknown) => {
        this.runtime.serviceError = this.runtime.redact(error instanceof Error ? error.message : '启动失败');
        this.runtime.changed(); throw error;
      }).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  stopService(): Promise<void> {
    this.controlGeneration++;
    return this.stopping ??= (async () => {
      try { await Promise.all([this.tunnels.stop(), this.downstream.close()]); }
      finally {
        await this.gatewayStarting?.catch(() => {});
        if (this.starting) await this.starting.catch(() => {});
        if (this.localService) { const service = this.localService; this.localService = undefined; await service.close(); }
        else await this.processes.shutdown();
      }
    })().finally(() => { this.stopping = undefined; });
  }
  startGateway(port = Number(process.env.BETTER_GPT_PORT ?? 18921), profileId?: string) {
    if (this.stopping) return Promise.reject(new Error('服务正在停止，请稍后再启动'));
    const previousControl = this.tunnelControl;
    return this.gatewayStarting ??= (async () => {
      await previousControl;
      const service = await this.startService(port, profileId);
      const { config } = await this.store.read();
      if (this.stopping) throw new Error('服务启动已取消');
      const tunnels = await this.tunnels.start(config, profileId);
      return { service, tunnels };
    })().finally(() => { this.gatewayStarting = undefined; });
  }
  controlTunnels(raw: unknown) {
    const input = tunnelControlSchema.parse(raw), scope = input.scope, generation = this.controlGeneration;
    const previousGateway = this.gatewayStarting;
    const operation = this.tunnelControl.then(async () => {
      const check = () => { if (this.stopping || generation !== this.controlGeneration) throw new Error('服务正在停止，隧道操作已取消'); };
      check();
      await previousGateway?.catch(() => {}); check();
      const existing = (await this.store.read()).config; check();
      if (scope.kind === 'workspace') {
        const target = existing.workspaces.find((workspace) => workspace.uuid === scope.workspaceId);
        if (!target) throw new Error('工作区不存在');
        if (!target.tunnelBinding) throw new Error('工作区尚未绑定公网隧道');
        if (input.action === 'start' && (!target.enabled || !existing.tunnelProfiles.find((profile) => profile.id === target.tunnelBinding?.profileId)?.enabled)) throw new Error('工作区或隧道配置已停用');
      }
      if (scope.kind === 'profile' && !existing.tunnelProfiles.some((profile) => profile.id === scope.profileId)) throw new Error('隧道配置不存在');
      const affected = new Set(existing.workspaces.filter((workspace) => {
        const profile = existing.tunnelProfiles.find((entry) => entry.id === workspace.tunnelBinding?.profileId);
        return profile && tunnelMatches(profile, input.scope) && (input.scope.kind !== 'workspace' || workspace.uuid === input.scope.workspaceId)
          && (input.action === 'stop' || (workspace.enabled && profile.enabled));
      }).map((workspace) => workspace.uuid));
      const config = await this.store.update((current) => { check(); return { ...current,
        workspaces: current.workspaces.map((workspace) => affected.has(workspace.uuid) ? { ...workspace, tunnelEnabled: input.action === 'start' } : workspace) }; });
      check();
      let tunnels: import('@better-gpt/contracts').TunnelRuntime[];
      if (input.action === 'start' && affected.size) {
        await this.startService(); check();
        const profiles = [...new Set(config.workspaces.filter((workspace) => affected.has(workspace.uuid)).map((workspace) => workspace.tunnelBinding!.profileId))];
        tunnels = await this.tunnels.start(config, profiles); check();
      } else { await this.tunnels.reconcile(config); check(); tunnels = [...this.runtime.tunnels.values()]; }
      this.runtime.changed();
      return { affectedWorkspaces: affected.size, tunnels };
    });
    this.tunnelControl = operation.catch(() => {}); return operation;
  }
  async dispose(): Promise<void> { await this.stopService(); this.runtime.dispose(); }
}
