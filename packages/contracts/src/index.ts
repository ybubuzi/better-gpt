import { z } from 'zod';
export * from './tools.js';

export const appVersion = '0.1.0';
const name = z.string().min(1);
const reference = z.string().trim().min(1);
export const tunnelIdSchema = z.string().regex(/^tunnel_[0-9a-fA-F]{32}$/);
export const publicBaseUrlSchema = z.url().refine((text) => {
  const url = new URL(text);
  return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
}, '公网入口必须是无路径、无凭据的 HTTPS 域名地址');
export const proxySchema = z.strictObject({
  mode: z.enum(['environment', 'direct', 'custom']).default('environment'),
  url: z.string().default(''),
  credentialRef: z.string().optional(),
  bypass: z.array(z.string()).default(['localhost', '127.0.0.1', '::1']),
}).superRefine((proxy, ctx) => {
  if (proxy.mode !== 'custom') return;
  try {
    const url = new URL(proxy.url);
    if (!['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol)
      || !url.hostname || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
      throw new Error('invalid proxy');
    }
  } catch {
    ctx.addIssue({ code: 'custom', path: ['url'], message: '代理地址无效；账号密码应保存为凭据引用' });
  }
});

const profileBase = {
  id: z.uuid(), name, enabled: z.boolean().default(true),
  proxy: proxySchema.optional(),
};
export const tunnelProfileSchema = z.discriminatedUnion('provider', [
  z.strictObject({ ...profileBase, provider: z.literal('cloudflare'), publicBaseUrl: publicBaseUrlSchema,
    tunnelId: z.uuid(), credentialRef: reference, managementCredentialRef: reference.optional(), executable: z.string().optional() }),
  z.strictObject({ ...profileBase, provider: z.literal('openai'), runtimeKeyRef: reference,
    tunnelId: tunnelIdSchema.optional(), executable: z.string().optional() }),
  z.strictObject({ ...profileBase, provider: z.literal('frp'), publicBaseUrl: publicBaseUrlSchema,
    serverAddress: reference, serverPort: z.int().min(1).max(65535), credentialRef: reference,
    remotePort: z.int().min(1).max(65535).default(19080),
    executable: z.string().optional() }),
  z.strictObject({ ...profileBase, provider: z.literal('ssh'), publicBaseUrl: publicBaseUrlSchema,
    serverAddress: z.string().regex(/^[A-Za-z0-9_.:-]+$/), serverPort: z.int().min(1).max(65535).default(22),
    username: z.string().regex(/^[A-Za-z0-9_.-]+$/), identityFile: reference, knownHostsFile: reference,
    sshConfigFile: reference.optional(), sshHostAlias: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/).optional(),
    hostKeyAlias: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional(), remotePort: z.int().min(1).max(65535).default(19080),
    executable: z.string().optional() }),
  z.strictObject({ ...profileBase, provider: z.literal('external'), publicBaseUrl: publicBaseUrlSchema,
    localPort: z.int().min(1).max(65535).default(19090) }),
]);
export const tunnelBindingSchema = z.strictObject({
  profileId: z.uuid(), openAiTunnelId: tunnelIdSchema.optional(),
});
export const workspaceSchema = z.strictObject({
  uuid: z.uuid(), name, projectRoot: z.string().min(1), enabled: z.boolean().default(true),
  createdAt: z.iso.datetime(),
  autoStart: z.boolean().default(true),
  tunnelEnabled: z.boolean().default(true),
  lastActiveAt: z.iso.datetime().optional(),
  legacyOpenAiTunnelId: z.string().nullable().optional(),
  selectedSkillNames: z.array(z.string()).nullable().default(null),
  selectedMcpNames: z.array(z.string()).nullable().default(null),
  agentsMode: z.enum(['auto', 'custom', 'disabled']).default('auto'),
  customAgents: z.string().default(''),
  tunnelBinding: tunnelBindingSchema.nullable().default(null),
});
export const skillSchema = z.strictObject({
  name, description: z.string(), source: z.string(), rootPath: z.string().nullable(),
  enabled: z.boolean(), createdAt: z.iso.datetime(),
});
export const downstreamMcpSchema = z.strictObject({
  name, source: z.string(), enabled: z.boolean(), transportRef: reference,
  startupTimeoutMs: z.number().nullable(), toolTimeoutMs: z.number().nullable(),
});
export const migrationRecordSchema = z.strictObject({
  id: z.string(), sourceId: z.string(), sourceDirectory: z.string(), sourceFingerprint: z.string(),
  importedAt: z.iso.datetime(), archiveRef: reference, beforeConfigRef: reference,
  assetDirectory: z.string(), dataHash: z.string(),
  counts: z.strictObject({ workspaces: z.int(), skills: z.int(), mcps: z.int(), files: z.int() }),
});
const versionedConfigSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2)]).transform(() => 2 as const),
  proxy: proxySchema,
  workspaces: z.array(workspaceSchema),
  tunnelProfiles: z.array(tunnelProfileSchema),
  skills: z.array(skillSchema).default([]),
  downstreamMcps: z.array(downstreamMcpSchema).default([]),
  migrations: z.array(migrationRecordSchema).default([]),
  service: z.strictObject({ host: z.string(), port: z.int().min(1).max(65535) }).default({ host: '127.0.0.1', port: 18921 }),
  computerUseEnabled: z.boolean().default(false),
  computerUseApprovedApps: z.array(z.string()).default([]),
  legacyStateRef: z.string().optional(),
}).superRefine((config, ctx) => {
  for (const [field, ids] of [
    ['workspaces', config.workspaces.map((workspace) => workspace.uuid)],
    ['tunnelProfiles', config.tunnelProfiles.map((profile) => profile.id)],
    ['skills', config.skills.map((skill) => skill.name)],
    ['downstreamMcps', config.downstreamMcps.map((mcp) => mcp.name)],
  ] as const) {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: [field], message: '存在重复标识' });
  }
  const usedTunnelIds = new Set<string>();
  const cloudflareIds = new Set<string>();
  config.tunnelProfiles.forEach((profile, index) => {
    if (profile.provider !== 'cloudflare') return;
    const id = profile.tunnelId.toLowerCase();
    if (cloudflareIds.has(id)) ctx.addIssue({ code: 'custom', path: ['tunnelProfiles', index, 'tunnelId'],
      message: '同一个 Cloudflare Tunnel ID 只能使用一个隧道配置；请将工作区绑定到同一配置' });
    cloudflareIds.add(id);
  });
  config.workspaces.forEach((workspace, index) => {
    const binding = workspace.tunnelBinding;
    if (!binding) return;
    const profile = config.tunnelProfiles.find((entry) => entry.id === binding.profileId);
    const path = ['workspaces', index, 'tunnelBinding'];
    if (!profile) { ctx.addIssue({ code: 'custom', path, message: '绑定的隧道配置不存在' }); return; }
    if (profile.provider === 'openai') {
      if (!profile.tunnelId && !binding.openAiTunnelId) ctx.addIssue({ code: 'custom', path, message: '请先为ChatGPT隧道配置一次共享Tunnel ID' });
      else if (!profile.tunnelId && binding.openAiTunnelId && usedTunnelIds.has(binding.openAiTunnelId.toLowerCase())) {
        ctx.addIssue({ code: 'custom', path, message: 'OpenAI Tunnel ID 不可重复绑定' });
      } else if (!profile.tunnelId && binding.openAiTunnelId) usedTunnelIds.add(binding.openAiTunnelId.toLowerCase());
    } else if (binding.openAiTunnelId) {
      ctx.addIssue({ code: 'custom', path, message: '只有 OpenAI 绑定可以设置 Tunnel ID' });
    }
  });
});
export const configSchema = versionedConfigSchema;

export type AppConfig = z.infer<typeof configSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type TunnelProfile = z.infer<typeof tunnelProfileSchema>;
export type ProxyConfig = z.infer<typeof proxySchema>;
export const tunnelControlSchema = z.strictObject({
  action: z.enum(['start', 'stop']),
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('all') }),
    z.strictObject({ kind: z.literal('workspace'), workspaceId: z.uuid() }),
    z.strictObject({ kind: z.literal('profile'), profileId: z.uuid() }),
    z.strictObject({ kind: z.literal('provider'), provider: z.enum(['cloudflare', 'openai', 'custom', 'frp', 'ssh', 'external']) }),
  ]),
});
export type TunnelControl = z.infer<typeof tunnelControlSchema>;
export const providerSetupSchema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('cloudflare'), name: z.string().trim().min(1), publicBaseUrl: publicBaseUrlSchema, credentialFile: z.string().min(1), executable: z.string().optional() }),
  z.strictObject({ provider: z.literal('openai'), name: z.string().trim().min(1), runtimeKey: z.string().trim().min(1), tunnelId: tunnelIdSchema, executable: z.string().optional() }),
]);
export const createEmptyConfig = (): AppConfig => configSchema.parse({
  schemaVersion: 2, proxy: {}, workspaces: [], tunnelProfiles: [],
});
export const workspacePath = (uuid: string): string => `/${z.uuid().parse(uuid)}/mcp`;
export type WorkspaceEndpoint =
  | { kind: 'local'; path: string }
  | { kind: 'https'; path: string; url: string }
  | { kind: 'openai'; path: string; tunnelId: string };

export function workspaceEndpoint(workspace: Workspace, config: AppConfig): WorkspaceEndpoint {
  const path = workspacePath(workspace.uuid);
  const binding = workspace.tunnelBinding;
  if (!binding) return { kind: 'local', path };
  const profile = config.tunnelProfiles.find((entry) => entry.id === binding.profileId);
  if (!profile) throw new Error('隧道绑定不存在');
  if (profile.provider === 'openai') {
    return { kind: 'openai', path, tunnelId: tunnelIdSchema.parse(profile.tunnelId ?? binding.openAiTunnelId) };
  }
  return { kind: 'https', path, url: new URL(path, profile.publicBaseUrl).href };
}

export interface LegacyInventory {
  directory: string;
  exists: boolean;
  files: { name: string; bytes: number }[];
  skillsDirectoryExists: boolean;
  cloudflareDirectoryExists: boolean;
  status: 'not-found' | 'detected';
}
export interface AppSnapshot {
  version: string; platform: string; dataDirectory: string; initialized: boolean;
  config: AppConfig; legacy: LegacyInventory[];
}
export const createWorkspaceInputSchema = z.strictObject({ name, projectRoot: reference });
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

export const execCommandInputSchema = z.strictObject({
  cmd: z.string().min(1).max(65_536), workdir: z.string().optional(),
  yield_time_ms: z.int().min(0).max(30_000).default(10_000),
  max_output_tokens: z.int().min(1).max(25_000).default(10_000),
  purpose: z.string().max(1000).default('执行命令'),
});
export const writeStdinInputSchema = z.strictObject({
  session_id: z.int().positive(), chars: z.string().max(65_536).default(''),
  yield_time_ms: z.int().min(0).max(30_000).default(1000),
  max_output_tokens: z.int().min(1).max(25_000).default(10_000),
  purpose: z.string().max(1000).default('读取进程输出'),
});
export type ExecCommandInput = z.infer<typeof execCommandInputSchema>;
export type WriteStdinInput = z.infer<typeof writeStdinInputSchema>;
export interface CallLog {
  id: string; workspaceId: string; name: string; purpose: string;
  startedAt: number; endedAt?: number; status: 'pending' | 'success' | 'error';
  args: string; result: string; command: string; sessionId?: number;
}
export interface ManagedProcessView {
  id: number; workspaceId: string; pid?: number; command: string; cwd: string;
  startedAt: number; endedAt?: number; running: boolean; exitCode: number | null;
  output: string; outputTruncated: boolean; terminationRequested: boolean;
}
export interface ProcessResult {
  session_id: number; running: boolean; exit_code: number | null; output: string; output_truncated: boolean; termination_requested: boolean;
}

export type TunnelStatus = 'starting' | 'connected' | 'reconnecting' | 'failed' | 'stopping' | 'stopped' | 'external';
export interface TunnelRuntime {
  profileId: string; name: string; provider: TunnelProfile['provider']; status: TunnelStatus;
  origin: string; output: string; error: string; pid?: number; connectedAt?: number;
}
export const tunnelStatusLabels: Record<TunnelStatus, string> = {
  starting: '连接中', connected: '已连接', reconnecting: '重连中', failed: '启动失败',
  stopping: '停止中', stopped: '未启动', external: '外部托管 · 未验证',
};

export interface MigrationPreview {
  sourceDirectory: string; sourceId: string; fingerprint: string;
  counts: { workspaces: number; skills: number; mcps: number; files: number };
  workspaceNames: string[]; skillNames: string[]; mcpNames: string[];
  provider: string; warnings: string[]; alreadyImported: boolean;
}
export interface MigrationResult {
  status: 'imported' | 'already-imported'; migrationId: string;
  counts: MigrationPreview['counts']; warnings: string[];
}
