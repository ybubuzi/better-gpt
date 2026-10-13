import { isAbsolute, join } from 'node:path';
import type { AppConfig } from '@better-gpt/contracts';
import type { SshConnectionChoice } from './ssh-discovery.js';

export function normalizeSetupDomain(value: string): string {
  const url = new URL(value.includes('://') ? value.trim() : `https://${value.trim()}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('请输入HTTPS域名，不包含路径或账号密码');
  return url.origin;
}
export function suggestedRemotePort(config: AppConfig, _provider: 'ssh' | 'frp', host: string, port: number): number {
  const used = new Set(config.tunnelProfiles.flatMap((profile) => (profile.provider === 'ssh' || profile.provider === 'frp') && profile.serverAddress.toLowerCase() === host.toLowerCase() && profile.serverPort === port ? [profile.remotePort] : []));
  let selected = 19080; while (used.has(selected) && selected < 65535) selected++; return selected;
}
export function setupDefaults(provider: 'ssh' | 'frp' | 'external', domain: string, config: AppConfig, directory: string): Record<string, string> {
  const publicBaseUrl = normalizeSetupDomain(domain), host = new URL(publicBaseUrl).hostname.replace(/^\[|\]$/g, '');
  const used = new Set(config.tunnelProfiles.filter((profile) => profile.provider === 'external').map((profile) => profile.localPort));
  let localPort = 19090; while (used.has(localPort)) localPort++;
  return { name: `${host} · ${provider}`, publicBaseUrl, serverAddress: host, serverPort: provider === 'frp' ? '7000' : '22', username: 'root',
    remotePort: String(provider === 'external' ? 19080 : suggestedRemotePort(config, provider, host, provider === 'ssh' ? 22 : 7000)), localPort: String(localPort), knownHostsFile: join(directory, 'ssh', 'known_hosts') };
}
export function applySshChoice(values: Record<string, string>, choice: SshConnectionChoice, config: AppConfig): Record<string, string> {
  const next = { ...values };
  for (const key of ['identityFile', 'serverAddress', 'username', 'knownHostsFile', 'hostKeyAlias', 'sshHostAlias', 'sshConfigFile'] as const) if (choice[key]) next[key] = choice[key];
  if (choice.serverPort) next.serverPort = String(choice.serverPort);
  next.name = `${choice.label} · SSH`;
  next.remotePort = String(suggestedRemotePort(config, 'ssh', next.serverAddress!, Number(next.serverPort)));
  if (choice.usesConfiguredProxy) next.useSshProxy = 'true';
  return next;
}
export function applySshLogin(values: Record<string, string>, value: string, config: AppConfig): Record<string, string> {
  const url = new URL(value.includes('://') ? value : `ssh://${value}`);
  if (url.protocol !== 'ssh:' || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/') || !url.username) throw new Error('请输入 用户名@主机，可附加:端口');
  const host = url.hostname.replace(/^\[|\]$/g, ''), port = Number(url.port || 22);
  if (!/^[A-Za-z0-9_.-]+$/.test(url.username) || !/^[A-Za-z0-9_.:-]+$/.test(host)) throw new Error('SSH登录地址无效');
  return { ...values, username: url.username, serverAddress: host, serverPort: String(port), remotePort: String(suggestedRemotePort(config, 'ssh', host, port)) };
}
export interface SetupField { key: string; label: string; optional?: boolean }
export const advancedSetupFields = (provider: 'ssh' | 'frp' | 'external'): SetupField[] => [
  { key: 'name', label: '隧道名称' },
  ...(provider === 'external' ? [{ key: 'localPort', label: '本机专用端口' }] : [
    { key: 'serverAddress', label: provider === 'ssh' ? 'SSH主机（可与公网域名不同）' : 'frps主机（可与公网域名不同）' },
    { key: 'serverPort', label: provider === 'ssh' ? 'SSH连接端口' : 'frps连接端口' },
    { key: 'remotePort', label: '远端回环转发端口（HTTPS代理指向此端口）' },
    ...(provider === 'ssh' ? [{ key: 'username', label: 'SSH用户名' }, { key: 'identityFile', label: '私钥绝对路径' }, { key: 'knownHostsFile', label: '已核验公钥文件绝对路径' }, { key: 'hostKeyAlias', label: 'HostKeyAlias', optional: true }] : []),
  ]), ...(provider === 'external' ? [] : [{ key: 'executable', label: '连接器绝对路径（留空自动查找/安装）', optional: true }]),
];
export function validateSetupField(field: SetupField, value: string): void {
  if (!value && !field.optional) throw new Error('此项不能为空');
  if (field.key.endsWith('Port') && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new Error('端口须为1–65535');
  if (['identityFile', 'knownHostsFile', 'executable'].includes(field.key) && value && !isAbsolute(value)) throw new Error('请输入绝对路径');
}
export function setupProfile(provider: 'ssh' | 'frp' | 'external', id: string, values: Record<string, string>): Record<string, unknown> {
  const base = { id, name: values.name, provider, publicBaseUrl: values.publicBaseUrl, ...(values.executable && provider !== 'external' ? { executable: values.executable } : {}) };
  if (provider === 'external') return { ...base, localPort: Number(values.localPort) };
  const address = { serverAddress: values.serverAddress, serverPort: Number(values.serverPort), remotePort: Number(values.remotePort) };
  if (provider === 'frp') return { ...base, ...address, credentialRef: `vault:frp:${id}` };
  return { ...base, ...address, username: values.username, identityFile: values.identityFile, knownHostsFile: values.knownHostsFile,
    ...(values.hostKeyAlias ? { hostKeyAlias: values.hostKeyAlias } : {}), ...(values.sshConfigFile ? { sshConfigFile: values.sshConfigFile, sshHostAlias: values.sshHostAlias } : {}),
    ...(values.useSshProxy === 'true' ? { proxy: { mode: 'direct' } } : {}) };
}
