import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface SshConnectionChoice {
  id: string; kind: 'alias' | 'key'; label: string; description: string;
  identityFile?: string; serverAddress?: string; serverPort?: number; username?: string;
  knownHostsFile?: string; hostKeyAlias?: string; sshHostAlias?: string; sshConfigFile?: string;
  usesConfiguredProxy?: boolean; needsIdentity?: boolean;
}
export interface SshDiscovery {
  directory: string; configFile?: string; choices: SshConnectionChoice[]; warnings: string[]; knownHostsFile: string;
}
const within = (root: string, path: string) => { const value = relative(root, path); return !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`); };
const exists = async (path: string) => (await stat(path).catch(() => undefined))?.isFile() === true;
const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`, 'i');
function tokens(line: string): string[] {
  const result: string[] = []; let current = '', quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === '"') { quoted = !quoted; continue; }
    if (char === '#' && !quoted) break;
    if (/\s/.test(char) && !quoted) { if (current) { result.push(current); current = ''; } }
    else current += char;
  }
  if (current) result.push(current); return result;
}
function expandPath(value: string, root: string, host = '', username = ''): string {
  const home = dirname(root);
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, key: string) => process.env[key] ?? _all)
    .replaceAll('%d', home).replaceAll('%u', userInfo().username).replaceAll('%r', username).replaceAll('%h', host).replaceAll('%%', '%');
  if (value === '~') value = home; else if (/^~[\\/]/.test(value)) value = join(home, value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

/** Metadata-only discovery: explicit consent, bounded config reads, no ssh -G/Match exec or private-key reads. */
export async function discoverSshConnections(options: { authorized: boolean; managedKnownHostsFile: string; directory?: string }): Promise<SshDiscovery> {
  if (options.authorized !== true) throw new Error('自动发现SSH需要用户明确同意；未读取SSH目录');
  const directory = resolve(options.directory ?? join(homedir(), '.ssh'));
  const warnings: string[] = [], choices: SshConnectionChoice[] = [];
  const knownHostsFile = await exists(join(directory, 'known_hosts')) ? join(directory, 'known_hosts') : options.managedKnownHostsFile;
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw new Error('SSH目录无法读取，请使用手动配置'); });
  if (entries.length > 2000) throw new Error('SSH目录条目过多，请使用手动配置');
  const keyFiles = entries.filter((entry) => entry.isFile() && !/^(config(?:[._-].*)?|known_hosts.*|authorized_keys.*|environment|rc|\.DS_Store)$/i.test(entry.name)
    && !/\.(pub|log|txt|json|toml|conf|sock|old|bak)$/i.test(entry.name)).map((entry) => join(directory, entry.name));
  const configFile = join(directory, 'config'), seen = new Set<string>(), lines: string[][] = [];
  const keyPath = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const privatePaths = new Set(keyFiles.map(keyPath));
  const rootReal = await realpath(directory).catch(() => directory);
  for (const file of keyFiles) { const actual = await realpath(file).catch(() => undefined); if (actual) privatePaths.add(keyPath(actual)); }
  async function load(file: string, depth: number): Promise<void> {
    if (depth > 4 || seen.size >= 32) { warnings.push('Include层级或文件数量超限，部分配置未展开'); return; }
    const actual = await realpath(file).catch(() => undefined);
    if (!actual || !within(rootReal, actual)) { warnings.push('已跳过SSH目录外或不存在的Include文件'); return; }
    if (privatePaths.has(keyPath(actual)) || /\.(pem|key|pub)$/i.test(actual) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i.test(basename(actual))) { warnings.push('Include指向候选密钥文件，已跳过'); return; }
    if (seen.has(actual)) return; seen.add(actual);
    const info = await stat(actual); if (info.size > 512 * 1024) { warnings.push('配置文件过大，已跳过'); return; }
    const source = await readFile(actual, 'utf8');
    for (const raw of source.split(/\r?\n/)) { const parsed = tokens(raw.replace(/^\s*([^\s=]+)\s*=\s*/, '$1 ')); if (parsed[0]?.toLowerCase() === 'identityfile') for (const path of parsed.slice(1)) { const expanded = expandPath(path, directory); privatePaths.add(keyPath(expanded)); const actual = await realpath(expanded).catch(() => undefined); if (actual) privatePaths.add(keyPath(actual)); } }
    for (const raw of source.split(/\r?\n/)) {
      if (lines.length >= 20000) { warnings.push('配置条目过多，已停止展开'); break; }
      const parsed = tokens(raw.replace(/^\s*([^\s=]+)\s*=\s*/, '$1 ')); if (!parsed.length) continue;
      const key = parsed[0]!.toLowerCase();
      if (key === 'include') {
        for (const pattern of parsed.slice(1)) {
          const path = expandPath(pattern, directory);
          if (!within(directory, path)) { warnings.push('已跳过SSH目录外的Include路径'); continue; }
          if (/[?*]/.test(basename(path)) && !/[?*]/.test(dirname(path))) {
            const parentReal = await realpath(dirname(path)).catch(() => undefined);
            if (!parentReal || !within(rootReal, parentReal)) { warnings.push('已跳过目录外的Include'); continue; }
            const names = await readdir(parentReal).catch(() => []);
            for (const name of names.filter((name) => wildcard(basename(path)).test(name)).sort()) await load(join(parentReal, name), depth + 1);
          } else if (/[?*]/.test(path)) warnings.push('复杂Include通配路径请在高级设置中核对');
          else await load(path, depth + 1);
        }
      } else {
        // Never retain comments or arbitrary command bodies in discovery results.
        lines.push(key === 'proxycommand' ? [key, parsed.slice(1).join(' ').toLowerCase() === 'none' ? 'none' : 'configured'] : [key, ...parsed.slice(1)]);
      }
    }
  }
  const hasConfig = await exists(configFile); if (hasConfig) await load(configFile, 0);
  if (lines.some((line) => line[0] === 'match')) warnings.push('发现Match条件：自动发现不执行条件命令，请在确认页核对基础连接信息');
  const aliases = [...new Set(lines.filter((line) => line[0] === 'host').flatMap((line) => line.slice(1)).filter((alias) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(alias)))];
  for (const alias of aliases.slice(0, 300)) {
    let applies = true; const fields = new Map<string, string[]>(), identities: string[] = [];
    for (const line of lines) {
      const [key, ...values] = line;
      if (key === 'host') applies = !values.some((pattern) => pattern.startsWith('!') && wildcard(pattern.slice(1)).test(alias)) && values.some((pattern) => !pattern.startsWith('!') && wildcard(pattern).test(alias));
      else if (key === 'match') applies = values.length === 1 && values[0]?.toLowerCase() === 'all';
      else if (applies && key === 'identityfile') identities.push(...values);
      else if (applies && key && !fields.has(key)) fields.set(key, values);
    }
    const username = fields.get('user')?.[0] ?? userInfo().username;
    const serverAddress = (fields.get('hostname')?.[0] ?? alias).replaceAll('%h', alias);
    const serverPort = Number(fields.get('port')?.[0] ?? 22);
    if (!/^[A-Za-z0-9_.:-]+$/.test(serverAddress) || !/^[A-Za-z0-9_.-]+$/.test(username) || !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) { warnings.push(`别名${alias}需要手动核对连接信息`); continue; }
    const paths = (identities.length ? identities : ['id_ed25519', 'id_ecdsa', 'id_rsa']).map((path) => expandPath(path, directory, serverAddress, username));
    const identityFile = (await Promise.all(paths.map(async (path) => await exists(path) ? path : undefined))).find(Boolean);
    const hosts = fields.get('userknownhostsfile')?.find((path) => path.toLowerCase() !== 'none');
    const configuredTrust = hosts ? expandPath(hosts, directory, serverAddress, username) : undefined;
    const trust = configuredTrust && await exists(configuredTrust) ? configuredTrust : knownHostsFile;
    if (configuredTrust && trust !== configuredTrust) warnings.push(`别名${alias}的指纹文件不存在，将使用默认指纹文件`);
    const hostKeyAlias = fields.get('hostkeyalias')?.[0];
    choices.push({ id: `alias:${alias}`, kind: 'alias', label: alias, description: `${username}@${serverAddress}:${serverPort}${identityFile ? ` · ${basename(identityFile)}` : ' · 需选择密钥'}`,
      serverAddress, serverPort, username, ...(identityFile ? { identityFile } : { needsIdentity: true }), knownHostsFile: trust,
      ...(hostKeyAlias && /^[A-Za-z0-9_.-]+$/.test(hostKeyAlias) ? { hostKeyAlias } : {}), sshHostAlias: alias, sshConfigFile: configFile,
      usesConfiguredProxy: (fields.has('proxyjump') && fields.get('proxyjump')?.[0] !== 'none') || (fields.has('proxycommand') && fields.get('proxycommand')?.[0] !== 'none') });
  }
  const assigned = new Set(choices.map((choice) => choice.identityFile));
  for (const path of keyFiles.sort()) if (!assigned.has(path)) choices.push({ id: `key:${path}`, kind: 'key', label: basename(path), description: '候选密钥文件 · 未读取内容', identityFile: path, knownHostsFile });
  return { directory, ...(hasConfig ? { configFile } : {}), choices, warnings: [...new Set(warnings)], knownHostsFile };
}
