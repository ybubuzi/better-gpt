import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isMissing } from './config-store.js';
import { decodeHive, hiveNames, type HiveExport } from './legacy-hive.js';
import { readLegacySecrets, type LegacySecrets } from './legacy-secrets.js';

export interface SourceAsset { path: string; relativePath: string; kind: 'skill' | 'binary' | 'credential'; size: number; sha256: string }
export interface SourceSkill { folder: string; name: string; description: string }
export interface LegacySource {
  directory: string; sourceId: string; fingerprint: string; rawFiles: Record<string, Buffer>;
  assets: SourceAsset[]; directories: string[]; skills: SourceSkill[]; hive: HiveExport;
  global: Record<string, unknown>; secrets: LegacySecrets; warnings: string[];
}
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes as Buffer);
  return hash.digest('hex');
}
export function containedPath(root: string, child: string): string {
  const path = resolve(root, child);
  const rel = relative(resolve(root), path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('迁移文件路径超出目标目录');
  return path;
}
export async function optionalFile(path: string): Promise<Buffer | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('迁移源文件不是普通文件');
    return await readFile(path);
  } catch (error) { if (isMissing(error)) return null; throw error; }
}
export function rawFields(hive: HiveExport, box: string, typeId: number): Record<string, unknown>[] {
  const rows = hive.boxes[box];
  if (!Array.isArray(rows)) throw new Error(`旧配置缺少 ${box} 数据库`);
  return rows.map((row) => {
    if (row.value?.typeId !== typeId || !row.value.fields) throw new Error(`${box} 类型不匹配`);
    const identity = row.value.fields['0'];
    if (box !== 'global_config' && identity !== row.key) throw new Error(`${box} 的记录标识与存储键不一致`);
    return row.value.fields;
  });
}
export function textField(fields: Record<string, unknown>, key: string, fallback?: string): string {
  const value = fields[key];
  if (typeof value === 'string') return value;
  if (value == null && fallback !== undefined) return fallback;
  throw new Error(`旧数据字段 ${key} 应为字符串，迁移已停止`);
}
export function booleanField(fields: Record<string, unknown>, key: string, fallback?: boolean): boolean {
  const value = fields[key];
  if (typeof value === 'boolean') return value;
  if (value == null && fallback !== undefined) return fallback;
  throw new Error(`旧数据字段 ${key} 应为布尔值，迁移已停止`);
}
export function dateField(value: unknown): string {
  if (value && typeof value === 'object' && 'dateTime' in value && typeof value.dateTime === 'string') {
    const date = new Date(value.dateTime);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  throw new Error('旧数据时间字段无效，迁移已停止');
}

// Match Codexter's literal frontmatter semantics; YAML coercion would rename skills such as "123".
export function legacySkillMetadata(source: string, fallbackName: string): { name: string; description: string } {
  const lines = source.split(/\r?\n/);
  let name = fallbackName;
  let description = '';
  if (lines[0]?.trim() !== '---') return { name, description };
  const unquote = (value: string) => {
    if (value.length < 2) return value;
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    return value;
  };
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === '---') break;
    const nameMatch = /^name:\s*(.*)$/.exec(line);
    if (nameMatch) { if (nameMatch[1]!.trim()) name = unquote(nameMatch[1]!.trim()); continue; }
    const descriptionMatch = /^description:\s*(.*)$/.exec(line);
    if (!descriptionMatch) continue;
    let value = descriptionMatch[1]!.trim();
    if (['>', '|', '>-', '|-'].includes(value)) {
      const folded: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!)) folded.push(lines[++index]!.trim());
      value = folded.join(' ');
    }
    description = unquote(value);
  }
  return { name, description };
}

export async function loadLegacySource(sourceDirectory: string): Promise<LegacySource> {
  const directory = await realpath(resolve(sourceDirectory));
  const rawFiles: Record<string, Buffer> = {};
  for (const name of hiveNames) {
    if (await optionalFile(join(directory, `${name}.hivec`))) throw new Error('发现 Hive 压缩恢复文件，请先在旧版完成恢复并正常退出后重试');
    const bytes = await optionalFile(join(directory, `${name}.hive`));
    if (!bytes) throw new Error(`源目录缺少 ${name}.hive，不能认定为完整配置`);
    rawFiles[`${name}.hive`] = bytes;
  }
  const yml = await optionalFile(join(directory, 'cloudflared.yml'));
  if (yml) rawFiles['cloudflared.yml'] = yml;
  const hive = await decodeHive(rawFiles);
  rawFields(hive, 'global_config', 0);
  const globals = hive.boxes.global_config ?? [];
  const saved = globals.find((row) => row.key === 'config');
  if (!saved) throw new Error('源配置没有 global_config/config 记录');
  const global = saved.value.fields;
  const secrets = await readLegacySecrets(textField(global, '19', ''));
  if (secrets.encryptedSource) rawFiles['system/flutter_secure_storage.dat'] = secrets.encryptedSource;
  const assets: SourceAsset[] = [];
  const directories: string[] = [];
  const warnings: string[] = [];
  async function walk(root: string, rel: string, kind: SourceAsset['kind']) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return; throw error; }
    directories.push(rel);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (kind === 'credential' && (entry.name === '.login-home' || entry.name.startsWith('.create-tunnel-'))) continue;
      const path = containedPath(root, entry.name);
      const relativePath = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`源目录包含链接 ${relativePath}；为避免遗漏链接目标，本次导入已停止`);
      if (entry.isDirectory()) await walk(path, relativePath, kind);
      else if (entry.isFile()) {
        const info = await stat(path);
        assets.push({ path, relativePath, kind, size: info.size, sha256: await fileHash(path) });
      } else throw new Error(`无法迁移特殊文件 ${relativePath}`);
    }
  }
  await walk(join(directory, 'skills'), 'skills', 'skill');
  await walk(join(directory, 'bin'), 'bin', 'binary');
  await walk(join(directory, 'cloudflare'), 'cloudflare', 'credential');
  const tunnelId = typeof global['4'] === 'string' ? global['4'] : '';
  if (tunnelId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tunnelId)) {
    throw new Error('旧 Cloudflare Tunnel ID 格式无效');
  }
  if (tunnelId && !assets.some((asset) => asset.relativePath.toLowerCase() === `cloudflare/${tunnelId}.json`.toLowerCase())) {
    for (const candidate of [join(directory, `${tunnelId}.json`), join(homedir(), '.cloudflared', `${tunnelId}.json`)]) {
      const data = await optionalFile(candidate);
      if (!data) continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(data.toString('utf8')) as Record<string, unknown>; } catch { throw new Error('历史 Cloudflare 运行凭据格式无效'); }
      if (String(parsed.TunnelID).toLowerCase() !== tunnelId.toLowerCase()) throw new Error('历史 Cloudflare 凭据不匹配 Tunnel ID');
      assets.push({ path: candidate, relativePath: `cloudflare/${tunnelId}.json`, kind: 'credential', size: data.length, sha256: sha256(data) });
      break;
    }
  }
  const skills: SourceSkill[] = [];
  for (const dir of directories.filter((entry) => /^skills\/[^/.][^/]*$/.test(entry))) {
    const folder = dir.split('/')[1]!;
    // Resolve SKILL.md through the source filesystem, preserving its actual case sensitivity.
    const bytes = await optionalFile(join(directory, dir, 'SKILL.md'));
    if (!bytes) continue;
    const { name, description } = legacySkillMetadata(bytes.toString('utf8'), folder);
    if (skills.some((skill) => skill.name === name)) throw new Error('旧技能存在重名，不能无损合并');
    skills.push({ folder, name, description });
  }
  // Re-read the small databases after traversing assets: reject an inconsistent live snapshot.
  for (const name of hiveNames) {
    if (sha256(await readFile(join(directory, `${name}.hive`))) !== sha256(rawFiles[`${name}.hive`]!)) {
      throw new Error('旧配置在读取期间发生变化，请停止修改后刷新预览');
    }
  }
  const identity = process.platform === 'win32' ? directory.toLowerCase() : directory;
  const sourceId = sha256(identity).slice(0, 24);
  const fingerprint = sha256(JSON.stringify({
    files: Object.entries(rawFiles).sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, sha256(bytes)]),
    assets: assets.map((asset) => [asset.relativePath, asset.sha256]).sort(([a], [b]) => String(a).localeCompare(String(b))),
    directories: [...directories].sort(), keyDigest: sha256(secrets.key),
  }));
  return { directory, sourceId, fingerprint, rawFiles, assets, directories, skills, hive, global, secrets, warnings };
}
