import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  configSchema, createEmptyConfig, downstreamMcpSchema, skillSchema, tunnelProfileSchema, workspaceSchema,
  type AppConfig, type MigrationPreview, type MigrationResult, type TunnelProfile, type Workspace,
} from '@better-gpt/contracts';
import { ConfigStore, isMissing } from './config-store.js';
import { SecretVault } from './secret-vault.js';
import { assertNoDestinationLinks } from './destination-guard.js';
import { booleanField, containedPath, dateField, fileHash, loadLegacySource, rawFields, sha256, textField,
  type LegacySource } from './legacy-source.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function dataHash(config: AppConfig): string {
  const { migrations: _migrations, ...data } = config;
  return sha256(canonical(data));
}
function stableUuid(seed: string): string {
  const chars = sha256(seed).slice(0, 32).split('');
  chars[12] = '5'; chars[16] = '8';
  const text = chars.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
function nullableNames(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value) && value.every((name) => typeof name === 'string')) return value;
  throw new Error('旧能力选择名单格式无效');
}
function safeParseTransport(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new Error('旧 MCP 连接参数格式无效，未输出敏感内容'); }
}
function publicUrl(domain: string): string {
  return domain.includes('://') ? domain : `https://${domain}`;
}
function executable(source: LegacySource, field: string, assetDirectory: string): string | undefined {
  const old = source.global[field];
  if (typeof old !== 'string' || !old) {
    const filename = `${field === '6' ? 'cloudflared' : 'tunnel-client'}${process.platform === 'win32' ? '.exe' : ''}`;
    const managed = source.assets.find((asset) => asset.kind === 'binary' && basename(asset.path) === filename);
    return managed ? containedPath(assetDirectory, managed.relativePath) : undefined;
  }
  const rel = relative(source.directory, old);
  if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
    && source.assets.some((asset) => resolve(asset.path) === resolve(old) && asset.kind === 'binary')) {
    return containedPath(assetDirectory, rel);
  }
  return old;
}

interface Conversion {
  workspaces: Workspace[]; profiles: TunnelProfile[];
  skills: AppConfig['skills']; mcps: AppConfig['downstreamMcps'];
  secrets: Map<string, Buffer>; warnings: string[]; legacyStateRef: string;
  proxy: AppConfig['proxy']; service: AppConfig['service']; computerUseEnabled: boolean;
}

async function convert(source: LegacySource, assetDirectory: string): Promise<Conversion> {
  const g = source.global;
  const warnings = [...source.warnings];
  const secretValues = new Map<string, Buffer>();
  const prefix = `vault:migration:${source.sourceId}:${source.fingerprint}`;
  const legacyStateRef = `${prefix}:archive`;
  const provider = textField(g, '17', 'cloudflare');
  if (!['cloudflare', 'openai'].includes(provider)) throw new Error('旧隧道提供方无法识别');
  const useCf = booleanField(g, '3');
  const domain = textField(g, '0');
  const profiles: TunnelProfile[] = [];
  let activeProfile: TunnelProfile | undefined;
  const cfId = typeof g['4'] === 'string' ? g['4'] : '';
  if (cfId && domain) {
    const runtimeAsset = source.assets.find((asset) => asset.relativePath.toLowerCase() === `cloudflare/${cfId}.json`.toLowerCase());
    if (runtimeAsset) {
      const bytes = await readFile(runtimeAsset.path);
      if (sha256(bytes) !== runtimeAsset.sha256) throw new Error('Cloudflare 凭据在读取时发生变化');
      let credentials: Record<string, unknown>;
      try { credentials = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; }
      catch { throw new Error('Cloudflare 运行凭据无法解析'); }
      if (String(credentials.TunnelID).toLowerCase() !== cfId.toLowerCase()
        || typeof credentials.TunnelSecret !== 'string' || !credentials.TunnelSecret) throw new Error('Cloudflare 运行凭据不匹配');
      const credentialRef = `${prefix}:cloudflare-runtime`;
      secretValues.set(credentialRef, bytes);
      const cert = source.assets.find((asset) => asset.relativePath === 'cloudflare/cert.pem');
      let managementCredentialRef: string | undefined;
      if (cert) {
        managementCredentialRef = `${prefix}:cloudflare-management`;
        const data = await readFile(cert.path);
        if (sha256(data) !== cert.sha256) throw new Error('Cloudflare 管理凭据在读取时发生变化');
        secretValues.set(managementCredentialRef, data);
      }
      const bin = executable(source, '6', assetDirectory);
      const profile = tunnelProfileSchema.parse({ id: stableUuid(`${source.sourceId}:cloudflare`),
        name: textField(g, '5') || 'Codexter Cloudflare', provider: 'cloudflare', publicBaseUrl: publicUrl(domain),
        tunnelId: cfId, credentialRef, enabled: provider === 'cloudflare' && useCf,
        ...(managementCredentialRef ? { managementCredentialRef } : {}), ...(bin ? { executable: bin } : {}) });
      profiles.push(profile);
      if (provider === 'cloudflare' && useCf) activeProfile = profile;
    } else if (provider === 'cloudflare' && useCf) throw new Error('活动 Cloudflare 隧道缺少运行凭据，不能完成完整迁移');
    else warnings.push('休眠的 Cloudflare 配置缺少运行凭据，原字段已保存在加密归档中。');
  } else if (provider === 'cloudflare' && useCf) warnings.push('旧版未完成 Cloudflare 配置，工作区先保留为本地入口。');
  if (source.secrets.key) {
    const runtimeKeyRef = `${prefix}:openai-runtime-key`;
    secretValues.set(runtimeKeyRef, Buffer.from(source.secrets.key));
    const bin = executable(source, '18', assetDirectory);
    const profile = tunnelProfileSchema.parse({ id: stableUuid(`${source.sourceId}:openai`), name: 'Codexter OpenAI',
      provider: 'openai', runtimeKeyRef, enabled: provider === 'openai', ...(bin ? { executable: bin } : {}) });
    profiles.push(profile);
    if (provider === 'openai') activeProfile = profile;
  } else if (provider === 'openai') throw new Error('旧版活动 OpenAI 隧道没有可读取的 Runtime Key，完整迁移已停止');
  if (provider === 'cloudflare' && !useCf && domain) {
    activeProfile = tunnelProfileSchema.parse({ id: stableUuid(`${source.sourceId}:external`),
      name: 'Codexter 外部入口', provider: 'external', publicBaseUrl: publicUrl(domain), enabled: true });
    profiles.push(activeProfile);
  }
  const workspaces = rawFields(source.hive, 'workspaces', 1).map((fields) => {
    const openAiTunnelId = typeof fields['11'] === 'string' ? fields['11'] : null;
    const binding = activeProfile?.provider === 'openai'
      ? (openAiTunnelId ? { profileId: activeProfile.id, openAiTunnelId } : null)
      : activeProfile ? { profileId: activeProfile.id } : null;
    if (activeProfile?.provider === 'openai' && !openAiTunnelId) warnings.push('有工作区没有 OpenAI Tunnel ID，已按旧状态保留为未绑定。');
    return workspaceSchema.parse({ uuid: textField(fields, '0'), name: textField(fields, '1'),
      projectRoot: textField(fields, '2'), autoStart: booleanField(fields, '3'),
      createdAt: dateField(fields['4']), lastActiveAt: dateField(fields['5']), enabled: booleanField(fields, '6'),
      selectedSkillNames: nullableNames(fields['7']), selectedMcpNames: nullableNames(fields['8']),
      agentsMode: textField(fields, '9', 'auto'), customAgents: textField(fields, '10', ''),
      legacyOpenAiTunnelId: openAiTunnelId, tunnelBinding: binding });
  });
  const skillFields = rawFields(source.hive, 'skills', 2);
  const now = new Date().toISOString();
  const skills = source.skills.map((skill) => {
    const saved = skillFields.find((fields) => fields['0'] === skill.name);
    return skillSchema.parse({ name: skill.name, description: skill.description, source: 'local_directory',
      rootPath: containedPath(assetDirectory, `skills/${skill.folder}`), enabled: saved ? booleanField(saved, '4') : true,
      createdAt: saved ? dateField(saved['5']) : now });
  });
  for (const fields of skillFields.filter((entry) => !skills.some((skill) => skill.name === entry['0']))) {
    skills.push(skillSchema.parse({ name: textField(fields, '0'), description: textField(fields, '1'), source: textField(fields, '2'),
      rootPath: typeof fields['3'] === 'string' ? fields['3'] : null, enabled: booleanField(fields, '4'), createdAt: dateField(fields['5']) }));
    warnings.push('有历史技能元数据没有对应本地目录，已保留原路径和启停状态。');
  }
  const mcps = rawFields(source.hive, 'downstream_mcps', 3).map((fields) => {
    const name = textField(fields, '0');
    const transport = textField(fields, '1');
    safeParseTransport(transport);
    const transportRef = `${prefix}:mcp:${sha256(name)}`;
    secretValues.set(transportRef, Buffer.from(transport));
    return downstreamMcpSchema.parse({ name, source: textField(fields, '3'), enabled: booleanField(fields, '2'), transportRef,
      startupTimeoutMs: fields['4'] ?? null, toolTimeoutMs: fields['5'] ?? null });
  });
  const defaultConfig = createEmptyConfig();
  const proxy = booleanField(g, '15', false)
    ? { ...defaultConfig.proxy, mode: 'custom' as const, url: textField(g, '16', '') }
    : { ...defaultConfig.proxy, mode: 'environment' as const };
  const service = { host: textField(g, '1'), port: g['2'] as number };
  const result = { workspaces, profiles, skills, mcps, secrets: secretValues, warnings: [...new Set(warnings)],
    legacyStateRef, proxy, service, computerUseEnabled: booleanField(g, '14', false) };
  try { configSchema.parse({ ...defaultConfig, workspaces, tunnelProfiles: profiles, skills, downstreamMcps: mcps, proxy, service }); }
  catch { throw new Error('旧配置存在无法兼容的字段或重复绑定，尚未写入新配置'); }
  return result;
}

export class MigrationService {
  constructor(private readonly store: ConfigStore) {}

  private async source(directory: string): Promise<LegacySource> {
    const source = await loadLegacySource(directory);
    async function canonicalDestination(path: string): Promise<string> {
      try { return await realpath(path); }
      catch (error) {
        if (!isMissing(error)) throw error;
        const parent = dirname(path);
        if (parent === path) throw error;
        return join(await canonicalDestination(parent), basename(path));
      }
    }
    const destination = await canonicalDestination(resolve(this.store.directory));
    const toSource = relative(source.directory, destination);
    if (!toSource || (!isAbsolute(toSource) && toSource !== '..' && !toSource.startsWith(`..${sep}`))) {
      throw new Error('Better GPT 数据目录不能位于旧版数据目录中');
    }
    const fromSource = relative(destination, source.directory);
    if (!isAbsolute(fromSource) && fromSource !== '..' && !fromSource.startsWith(`..${sep}`)) throw new Error('迁移源不能位于目标数据目录内');
    await assertNoDestinationLinks(this.store.directory, join(this.store.directory, 'imports'));
    await assertNoDestinationLinks(this.store.directory, join(this.store.directory, 'secrets'));
    return source;
  }
  async preview(directory: string): Promise<MigrationPreview> {
    const source = await this.source(directory);
    const converted = await convert(source, join(this.store.directory, 'imports', source.sourceId, 'preview'));
    const current = (await this.store.read()).config;
    const existing = current.migrations.find((entry) => entry.sourceId === source.sourceId);
    if (existing && existing.sourceFingerprint !== source.fingerprint) {
      throw new Error('此来源已导入，但旧数据后来发生变化。请先回退原导入；不会自动覆盖现有工作区。');
    }
    return { sourceDirectory: source.directory, sourceId: source.sourceId, fingerprint: source.fingerprint,
      counts: { workspaces: converted.workspaces.length, skills: converted.skills.length, mcps: converted.mcps.length,
        files: Object.keys(source.rawFiles).length + source.assets.length },
      workspaceNames: converted.workspaces.map((item) => item.name), skillNames: converted.skills.map((item) => item.name),
      mcpNames: converted.mcps.map((item) => item.name), provider: textField(source.global, '17', 'cloudflare'),
      warnings: [...converted.warnings, ...this.globalWarnings(current, converted)], alreadyImported: !!existing };
  }
  private globalWarnings(current: AppConfig, converted: Conversion): string[] {
    const defaults = createEmptyConfig();
    const warnings = [];
    if (canonical(current.proxy) !== canonical(defaults.proxy) && canonical(current.proxy) !== canonical(converted.proxy)) {
      warnings.push('Better GPT 已有自定义代理，将保留现设置；旧代理保存在加密归档中。');
    }
    if (canonical(current.service) !== canonical(defaults.service) && canonical(current.service) !== canonical(converted.service)) {
      warnings.push('Better GPT 已有自定义监听设置，将保留现设置；旧值保存在加密归档中。');
    }
    return warnings;
  }
  async import(directory: string, expectedFingerprint: string): Promise<MigrationResult> {
    const source = await this.source(directory);
    if (source.fingerprint !== expectedFingerprint) throw new Error('源数据与预览不一致，请刷新预览再导入');
    let result: MigrationResult | undefined;
    await this.store.update(async (current) => {
      const previous = current.migrations.find((entry) => entry.sourceId === source.sourceId);
      if (previous) {
        if (previous.sourceFingerprint !== source.fingerprint) throw new Error('来源已变化，拒绝覆盖以前的迁移');
        result = { status: 'already-imported', migrationId: previous.id, counts: previous.counts, warnings: [] };
        return current;
      }
      const id = randomUUID();
      const parent = containedPath(this.store.directory, `imports/${source.sourceId}`);
      const stage = containedPath(parent, `.${id}.staging`);
      const destination = containedPath(parent, id);
      await assertNoDestinationLinks(this.store.directory, stage);
      await assertNoDestinationLinks(this.store.directory, join(this.store.directory, 'secrets'));
      const converted = await convert(source, destination);
      const counts = { workspaces: converted.workspaces.length, skills: converted.skills.length,
        mcps: converted.mcps.length, files: Object.keys(source.rawFiles).length + source.assets.length };
      for (const [label, incoming, existing] of [
        ['工作区 UUID', converted.workspaces.map((item) => item.uuid.toLowerCase()), current.workspaces.map((item) => item.uuid.toLowerCase())],
        ['隧道配置', converted.profiles.map((item) => item.id), current.tunnelProfiles.map((item) => item.id)],
        ['技能名称', converted.skills.map((item) => item.name), current.skills.map((item) => item.name)],
        ['MCP 名称', converted.mcps.map((item) => item.name), current.downstreamMcps.map((item) => item.name)],
      ] as const) {
        if (incoming.some((value) => existing.includes(value))) throw new Error(`${label} 与现有配置冲突，未覆盖任何数据`);
      }
      const defaults = createEmptyConfig();
      const candidate = configSchema.parse({ ...current, workspaces: [...current.workspaces, ...converted.workspaces],
        tunnelProfiles: [...current.tunnelProfiles, ...converted.profiles], skills: [...current.skills, ...converted.skills],
        downstreamMcps: [...current.downstreamMcps, ...converted.mcps], legacyStateRef: converted.legacyStateRef,
        proxy: canonical(current.proxy) === canonical(defaults.proxy) ? converted.proxy : current.proxy,
        service: canonical(current.service) === canonical(defaults.service) ? converted.service : current.service,
        computerUseEnabled: current.computerUseEnabled || converted.computerUseEnabled });
      const vault = new SecretVault(this.store.directory);
      const beforeConfigRef = `vault:migration:${id}:before-config`;
      const before = await this.store.read();
      await vault.put(beforeConfigRef, Buffer.from(JSON.stringify(before)));
      await mkdir(stage, { recursive: true, mode: 0o700 });
      await assertNoDestinationLinks(this.store.directory, stage);
      try {
        for (const rel of source.directories.filter((entry) => !entry.startsWith('cloudflare'))) {
          await mkdir(containedPath(stage, rel), { recursive: true, mode: 0o700 });
        }
        for (const asset of source.assets.filter((entry) => entry.kind !== 'credential')) {
          const target = containedPath(stage, asset.relativePath);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await copyFile(asset.path, target);
          if (await fileHash(target) !== asset.sha256) throw new Error('复制文件校验失败，未提交迁移');
          const sourceStat = await stat(asset.path);
          await chmod(target, sourceStat.mode & 0o777);
          await utimes(target, sourceStat.atime, sourceStat.mtime);
        }
        const credentialAssets: Record<string, string> = {};
        for (const asset of source.assets.filter((entry) => entry.kind === 'credential')) {
          const bytes = await readFile(asset.path);
          if (sha256(bytes) !== asset.sha256) throw new Error('凭据文件在迁移期间变化');
          credentialAssets[asset.relativePath] = bytes.toString('base64');
        }
        await vault.put(converted.legacyStateRef, Buffer.from(JSON.stringify({
          formatVersion: 1, sourceDirectory: source.directory, sourceFingerprint: source.fingerprint,
          rawFiles: Object.fromEntries(Object.entries(source.rawFiles).map(([name, data]) => [name, data.toString('base64')])),
          hive: source.hive, credentialAssets, assetManifest: source.assets.map(({ path: _path, ...asset }) => asset),
          directories: source.directories,
        })));
        for (const [reference, bytes] of converted.secrets) await vault.put(reference, bytes);
        const check = await this.source(source.directory);
        if (check.fingerprint !== source.fingerprint) throw new Error('迁移期间源文件发生变化，未提交新配置');
        await rename(stage, destination);
      } catch (error) {
        // Only remove our verified staging directory, never a source or completed archive.
        const checked = containedPath(parent, basename(stage));
        if (checked !== stage) throw new Error('迁移暂存路径检查失败');
        await assertNoDestinationLinks(this.store.directory, checked);
        await rm(checked, { recursive: true, force: true });
        throw error;
      }
      const record = { id, sourceId: source.sourceId, sourceDirectory: source.directory, sourceFingerprint: source.fingerprint,
        importedAt: new Date().toISOString(), archiveRef: converted.legacyStateRef, beforeConfigRef,
        assetDirectory: destination, dataHash: dataHash(candidate), counts };
      result = { status: 'imported', migrationId: id, counts, warnings: [...converted.warnings, ...this.globalWarnings(current, converted)] };
      return { ...candidate, migrations: [...current.migrations, record] };
    });
    if (!result) throw new Error('迁移没有生成结果');
    return result;
  }

  async rollback(id: string): Promise<void> {
    await this.store.update(async (current) => {
      const record = current.migrations.at(-1);
      if (!record || record.id !== id) throw new Error('只能回退最近一次迁移');
      if (dataHash(current) !== record.dataHash) throw new Error('迁移后配置已被修改，不能自动回退并覆盖新修改');
      const vault = new SecretVault(this.store.directory);
      const saved = JSON.parse((await vault.read(record.beforeConfigRef)).toString('utf8')) as { initialized: boolean; config: unknown };
      const config = configSchema.parse(saved.config);
      return saved.initialized ? config : null;
    });
  }
  async readTransport(name: string): Promise<Record<string, unknown>> {
    const config = (await this.store.read()).config;
    const entry = config.downstreamMcps.find((mcp) => mcp.name === name);
    if (!entry) throw new Error('MCP 配置不存在');
    return safeParseTransport((await new SecretVault(this.store.directory).read(entry.transportRef)).toString('utf8'));
  }
}
