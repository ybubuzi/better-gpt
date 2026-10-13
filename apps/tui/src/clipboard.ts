import { spawn } from 'node:child_process';
import { shellExecutable } from '@better-gpt/core';
import { workspaceEndpoint, type AppConfig, type Workspace } from '@better-gpt/contracts';

export function workspaceCopyTarget(workspace: Workspace, config: AppConfig, localOrigin: string): { value: string; label: string } {
  if (!workspace.enabled) throw new Error('工作区已停用');
  const profile = config.tunnelProfiles.find((entry) => entry.id === workspace.tunnelBinding?.profileId);
  if (profile && !profile.enabled) throw new Error('绑定的隧道已停用');
  const endpoint = workspaceEndpoint(workspace, config);
  if (endpoint.kind === 'openai') return { value: endpoint.tunnelId, label: 'OpenAI Tunnel ID' };
  if (endpoint.kind === 'https') return { value: endpoint.url, label: '公网 MCP URL' };
  if (!localOrigin) throw new Error('本地服务尚未启动，启动后可复制本地 MCP URL');
  return { value: new URL(endpoint.path, localOrigin).href, label: '本地 MCP URL' };
}

async function writeClipboard(command: string, args: string[], value: string): Promise<void> {
  const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('剪贴板操作超时')); }, 5000);
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (part: string) => { stderr = (stderr + part).slice(-1000); });
    child.stdin.on('error', () => {});
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.trim() || '系统剪贴板不可用')); });
    child.stdin.end(value, 'utf8');
  });
}

/** Native clipboard tools receive text through stdin, never through shell interpolation. */
export async function copyToClipboard(value: string): Promise<void> {
  if (process.platform === 'win32') {
    await writeClipboard(await shellExecutable(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); Set-Clipboard -Value ([Console]::In.ReadToEnd()) -ErrorAction Stop'], value);
    return;
  }
  if (process.platform === 'darwin') { await writeClipboard('/usr/bin/pbcopy', [], value); return; }
  const candidates: [string, string[]][] = [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [command, args] of candidates) {
    try { await writeClipboard(command, args, value); return; }
    catch {}
  }
  throw new Error('系统剪贴板不可用；Linux 需可用的图形会话及 wl-copy、xclip 或 xsel');
}
