import type { AppConfig, TunnelRuntime, Workspace } from '@better-gpt/contracts';
import { colors } from './view.js';

export function workspaceTunnel(workspace: Workspace, config: AppConfig, runtimes: Map<string, TunnelRuntime>, online: boolean) {
  const profile = config.tunnelProfiles.find((entry) => entry.id === workspace.tunnelBinding?.profileId);
  const channel = !profile ? '本地' : profile.provider === 'cloudflare' ? 'CF' : profile.provider === 'openai' ? 'ChatGPT' : profile.provider === 'ssh' ? '自建SSH' : profile.provider === 'frp' ? '自建frp' : '自定义';
  const short = !profile ? '本地' : profile.provider === 'cloudflare' ? 'CF' : profile.provider === 'openai' ? 'GPT' : profile.provider === 'ssh' ? 'SSH' : profile.provider === 'frp' ? 'frp' : '外部';
  const runtime = profile ? runtimes.get(profile.id) : undefined;
  const state = !profile ? 'local' : !workspace.enabled || !profile.enabled ? 'disabled' : !workspace.tunnelEnabled ? 'paused' : !online ? 'stopped' : runtime?.status ?? 'stopped';
  const label = { local: '未绑定', disabled: '已停用', paused: '已暂停', starting: '连接中', connected: '已连接', reconnecting: '重连中', failed: '失败', stopping: '停止中', stopped: '未启动', external: '外部未验证' }[state];
  const color = state === 'connected' ? colors.success : state === 'failed' ? colors.danger : ['starting', 'reconnecting', 'stopping', 'external'].includes(state) ? colors.warning : colors.muted;
  const symbol = state === 'connected' ? '●' : state === 'failed' ? '×' : ['starting', 'reconnecting', 'stopping', 'external'].includes(state) ? '◐' : '○';
  return { channel, short, state, label, color, symbol };
}
