import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Application, SecretVault, networkFetch } from '@better-gpt/core';

export async function doctorTunnels(app: Application, id?: string) {
  const { config } = await app.store.read(), profiles = config.tunnelProfiles.filter((profile) => !id || profile.id === id);
  if (id && !profiles.length) throw new Error('隧道配置不存在');
  const results = [];
  for (const profile of profiles) {
    const checks: { item: string; ok: boolean | null; message: string }[] = [];
    const file = async (item: string, path: string) => { try { await access(path); checks.push({ item, ok: true, message: path }); } catch { checks.push({ item, ok: false, message: `文件不存在或不可访问：${path}` }); } };
    if (profile.provider === 'ssh') {
      await file('SSH私钥', profile.identityFile); await file('known_hosts', profile.knownHostsFile);
      if ((await stat(profile.knownHostsFile).catch(() => undefined))?.size === 0) checks.push({ item: '主机信任', ok: false, message: '指纹文件为空，首次连接需要核验并导入服务器公钥；未自动信任' });
      if (profile.sshConfigFile) await file('SSH config', profile.sshConfigFile);
      await file('OpenSSH', profile.executable ?? (process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : '/usr/bin/ssh'));
    }
    if (profile.provider === 'frp') {
      if (profile.executable) await file('frpc', profile.executable);
      else checks.push({ item: 'frpc', ok: null, message: '启动时按需安装官方固定版本并核验SHA256；此检查不下载、不绕过系统安全软件' });
      try { const token = await new SecretVault(app.store.directory).read(profile.credentialRef); checks.push({ item: 'frp凭据', ok: token.length > 0, message: token.length ? '加密凭据可读取' : '凭据为空' }); }
      catch { checks.push({ item: 'frp凭据', ok: false, message: '加密凭据不可读取' }); }
    }
    if (profile.provider !== 'openai') {
      try {
        const response = await networkFetch(profile.proxy ?? config.proxy, app.store.directory)(new URL('/healthz', profile.publicBaseUrl), { signal: AbortSignal.timeout(6000) });
        const info = await response.json() as { profileId?: string };
        checks.push({ item: '公网入口', ok: response.ok && info.profileId === profile.id, message: response.ok && info.profileId === profile.id ? 'HTTPS可达且专用入口身份匹配' : `HTTP ${response.status}，入口身份不匹配` });
      } catch { checks.push({ item: '公网入口', ok: false, message: '未连通或TLS/返回内容不正确；先启动服务，再检查DNS、证书、代理和连接器日志' }); }
    }
    results.push({ id: profile.id, name: profile.name, provider: profile.provider, enabled: profile.enabled, boundWorkspaces: config.workspaces.filter((workspace) => workspace.tunnelBinding?.profileId === profile.id).length, checks });
  }
  return results;
}
