import { createHash } from 'node:crypto';
import { appendFile, mkdir, realpath, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AppConfig, Workspace } from '@better-gpt/contracts';
import type { ConfigStore } from './config-store.js';
import { assertNoDestinationLinks } from './destination-guard.js';
import { storageIdentityPath } from './storage-identity.js';

export type DiagnosticRole = 'application' | 'client' | 'daemon';
export type WorkspaceSelection = Pick<Workspace, 'uuid' | 'name' | 'projectRoot'>;
export interface BindDiagnosticContext { requestId?: string; selection?: WorkspaceSelection }
export interface ConfigurationReport {
  time: string; role: DiagnosticRole; pid: number; startedAt: string; cwd: string; executable: string; entryPoint: string;
  dataDirectory: string; configPath: string; configRealPath: string; modifiedAt: string | null;
  configFingerprint: string; workspaceFingerprint: string; logPath: string; storageIdentityFile: string; logError?: string;
  workspaces: { uuid: string; name: string; projectRoot: string; absoluteProjectRoot: string; enabled: boolean; tunnelEnabled: boolean;
    binding: { profileId: string; name: string | null; provider: string | null } | null }[];
}
export interface ConfigurationComparison {
  client: ConfigurationReport; backend: ConfigurationReport | null; backendError?: string;
  sameFile: boolean | null; sameStorage: boolean | null; sameConfig: boolean | null; sameWorkspaces: boolean | null;
  missingInBackend: string[]; missingInClient: string[];
}

const identity = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

/** Only explicit metadata is logged; config credentials, proxy auth and agent instructions are excluded. */
export class ConfigurationDiagnostics {
  readonly logPath: string;
  private writing: Promise<void> = Promise.resolve();
  private previousFingerprint = '';
  private lastError: string | undefined;
  constructor(private readonly store: ConfigStore, readonly role: DiagnosticRole) {
    this.logPath = join(resolve(store.directory), 'runtime', 'diagnostics', `${role}-${process.pid}.jsonl`);
  }
  async record(event: string, metadata: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, role: this.role, event, ...metadata }) + '\n';
    this.writing = this.writing.then(async () => {
      await assertNoDestinationLinks(this.store.directory, this.logPath);
      await mkdir(join(resolve(this.store.directory), 'runtime', 'diagnostics'), { recursive: true, mode: 0o700 });
      const size = await stat(this.logPath).then((value) => value.size, () => 0);
      if (size > 4 * 1024 * 1024) { await assertNoDestinationLinks(this.store.directory, this.logPath + '.previous'); await rename(this.logPath, this.logPath + '.previous'); }
      await appendFile(this.logPath, line, { mode: 0o600 }); this.lastError = undefined;
    }).catch((error: unknown) => { this.lastError = error instanceof Error ? error.message : '诊断日志无法写入'; });
    await this.writing;
  }
  async capture(config: AppConfig, event = 'configuration.loaded', force = false): Promise<ConfigurationReport> {
    const configPath = resolve(this.store.path);
    const [physical, info, storage] = await Promise.all([realpath(configPath).catch(() => configPath), stat(configPath).catch(() => null),
      storageIdentityPath(this.store.directory).then((path) => ({ path, error: '' }), (error: unknown) => ({ path: '', error: error instanceof Error ? error.message : '无法写入存储标识' }))]);
    const workspaces = config.workspaces.map((workspace) => {
      const profile = config.tunnelProfiles.find((entry) => entry.id === workspace.tunnelBinding?.profileId);
      return { uuid: workspace.uuid, name: workspace.name, projectRoot: workspace.projectRoot, absoluteProjectRoot: resolve(workspace.projectRoot),
        enabled: workspace.enabled, tunnelEnabled: workspace.tunnelEnabled,
        binding: workspace.tunnelBinding ? { profileId: workspace.tunnelBinding.profileId, name: profile?.name ?? null, provider: profile?.provider ?? null } : null };
    });
    const report: ConfigurationReport = { time: new Date().toISOString(), role: this.role, pid: process.pid, startedAt, cwd: process.cwd(), executable: process.execPath,
      entryPoint: process.argv[1] ? resolve(process.argv[1]) : '(embedded)', dataDirectory: resolve(this.store.directory), configPath, configRealPath: physical,
      modifiedAt: info?.mtime.toISOString() ?? null, configFingerprint: digest(config), workspaceFingerprint: digest(workspaces), logPath: this.logPath, storageIdentityFile: storage.path, workspaces };
    const observedIdentity = `${report.configRealPath}:${report.storageIdentityFile}:${report.configFingerprint}`;
    if (force || observedIdentity !== this.previousFingerprint) {
      await this.record(event, { report }); this.previousFingerprint = observedIdentity;
    }
    if (this.lastError || storage.error) report.logError = [storage.error, this.lastError].filter(Boolean).join('；');
    return report;
  }
}

export function compareConfiguration(client: ConfigurationReport, backend: ConfigurationReport | null, backendError?: string): ConfigurationComparison {
  return { client, backend, ...(backendError ? { backendError } : {}), sameFile: backend ? identity(client.configRealPath) === identity(backend.configRealPath) : null,
    sameStorage: backend && client.storageIdentityFile && backend.storageIdentityFile ? identity(client.storageIdentityFile) === identity(backend.storageIdentityFile) : null,
    sameConfig: backend ? client.configFingerprint === backend.configFingerprint : null,
    sameWorkspaces: backend ? client.workspaceFingerprint === backend.workspaceFingerprint : null,
    missingInBackend: backend ? client.workspaces.filter((workspace) => !backend.workspaces.some((entry) => entry.uuid === workspace.uuid)).map((workspace) => workspace.uuid) : [],
    missingInClient: backend ? backend.workspaces.filter((workspace) => !client.workspaces.some((entry) => entry.uuid === workspace.uuid)).map((workspace) => workspace.uuid) : [] };
}

export function formatConfigurationDiagnostics(value: ConfigurationComparison): string {
  const sections = [value.client, ...(value.backend ? [value.backend] : [])].map((report) => [
    `${report.role === 'client' ? 'TUI / CLI 客户端' : report.role === 'daemon' ? '后台服务' : '独立服务'} · PID ${report.pid}`,
    `配置文件：${report.configPath}`, `实际文件：${report.configRealPath}`, `存储标识：${report.storageIdentityFile}`, `启动入口：${report.entryPoint}`, `工作目录：${report.cwd}`,
    `配置指纹：${report.configFingerprint}`, `修改时间：${report.modifiedAt ?? '文件尚未建立'}`, `诊断日志：${report.logPath}`,
    ...(report.logError ? [`日志写入错误：${report.logError}`] : []), `加载工作区：${report.workspaces.length}`,
    ...report.workspaces.flatMap((workspace, index) => [`${index + 1}. ${workspace.name}`, `   UUID：${workspace.uuid}`, `   绝对路径：${workspace.absoluteProjectRoot}`,
      `   隧道：${workspace.binding ? `${workspace.binding.name ?? '(未知配置)'} · ${workspace.binding.provider ?? '(未知类型)'} · ${workspace.binding.profileId}` : '未绑定'}${workspace.tunnelEnabled ? '' : ' · 公网已暂停'}`]),
  ].join('\n'));
  return [value.backend ? `前后台对照：同一文件=${value.sameFile ? '是' : '否'}，存储一致=${value.sameStorage ? '是' : '否'}，配置一致=${value.sameConfig ? '是' : '否'}，工作区一致=${value.sameWorkspaces ? '是' : '否'}` : `后台对照不可用：${value.backendError ?? '后台未运行'}`,
    ...(value.missingInBackend.length ? [`后台缺少UUID：${value.missingInBackend.join(', ')}`] : []), ...(value.missingInClient.length ? [`客户端缺少UUID：${value.missingInClient.join(', ')}`] : []), ...sections].join('\n\n');
}
