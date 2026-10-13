import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { CallLog, TunnelRuntime, ProcessResult } from '@better-gpt/contracts';

export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export class RuntimeStore {
  private readonly listeners = new Set<() => void>();
  private entries: CallLog[] = [];
  private readonly activeSessions = new Set<number>();
  private revision = 0;
  private timer: NodeJS.Timeout | undefined;
  serviceOrigin = '';
  serviceError = '';
  readonly tunnels = new Map<string, TunnelRuntime>();
  mcps: Record<string, unknown>[] = [];
  summary: { workspaceId: string; title: string; text: string; endedAt: string } | undefined;
  private readonly knownSecrets = Object.entries(process.env).filter(([key, value]) =>
    /token|password|secret|api_?key|credential/i.test(key) && value && value.length >= 8).map(([, value]) => value!);

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getVersion = (): number => this.revision;
  protectSecret(value: string): void {
    if (value.length >= 4 && !this.knownSecrets.includes(value)) this.knownSecrets.push(value);
  }
  changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined; this.revision++;
      for (const listener of this.listeners) listener();
    }, 60);
    this.timer.unref();
  }
  redact(text: string): string {
    let output = terminalText(text);
    for (const secret of this.knownSecrets) output = output.split(secret).join('[已隐藏]');
    return output.replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏]')
      .replace(/((?:password|token|secret|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi, '$1[已隐藏]')
      .replace(/((?:https?|socks4a?|socks5h?):\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[已隐藏]@');
  }
  private describe(value: unknown): string {
    if (value && typeof value === 'object' && 'output' in value && typeof value.output === 'string') {
      const { output, ...metadata } = value;
      return `${this.describe(metadata)}\n\n输出：\n${this.redact(output).slice(-32_000) || '(无输出)'}`;
    }
    let text: string;
    try {
      text = JSON.stringify(value, (key: string, item: unknown) => {
        if (/authorization|cookie|password|token|secret|api[_-]?key|credential/i.test(key)
          && !/^(max_output_tokens|input_tokens|output_tokens|token_count)$/i.test(key)) return '[已隐藏]';
        if (key === 'data' && typeof item === 'string' && item.length > 4000) return `[二进制内容 ${item.length} 字符]`;
        return item;
      }, 2) ?? '';
    } catch { text = '[无法显示该值]'; }
    const clean = this.redact(text);
    return clean.length > 32_000 ? `${clean.slice(0, 16_000)}\n…内容已截断…\n${clean.slice(-16_000)}` : clean;
  }
  logs(workspaceId: string): readonly CallLog[] { return this.entries.filter((entry) => entry.workspaceId === workspaceId); }
  importRemote(state: { serviceOrigin: string; serviceError: string; tunnels: TunnelRuntime[]; logs: CallLog[]; mcps?: Record<string, unknown>[]; summary?: { workspaceId: string; title: string; text: string; endedAt: string } }): void {
    this.serviceOrigin = state.serviceOrigin; this.serviceError = state.serviceError;
    this.entries = state.logs; this.tunnels.clear();
    this.mcps = state.mcps ?? []; this.summary = state.summary;
    for (const tunnel of state.tunnels) this.tunnels.set(tunnel.profileId, tunnel);
    this.changed();
  }
  processFinished(workspaceId: string, result: ProcessResult): void {
    this.activeSessions.delete(result.session_id);
    const entry = this.entries.findLast((item) => item.workspaceId === workspaceId && item.name === 'exec_command' && item.sessionId === result.session_id);
    if (!entry || entry.status === 'pending') return;
    entry.status = result.exit_code !== null && result.exit_code !== 0 && !result.termination_requested ? 'error' : 'success';
    entry.result = this.describe(result); entry.endedAt = Date.now(); this.changed();
  }
  async trace<T>(workspaceId: string, name: string, args: Record<string, unknown>, action: () => Promise<T>): Promise<T> {
    if (this.entries.filter((entry) => entry.status === 'pending').length >= 128) throw new Error('同时处理的调用过多，请稍后重试');
    const entry: CallLog = { id: randomUUID(), workspaceId, name: this.redact(name).replace(/\s+/g, ' ').slice(0, 200), startedAt: Date.now(), status: 'pending',
      purpose: this.redact(typeof args.purpose === 'string' ? args.purpose : name).slice(0, 1000),
      args: this.describe(name === 'write_stdin' && args.chars ? { ...args, chars: '[输入内容已隐藏]' } : args), result: '',
      command: this.redact(typeof args.cmd === 'string' ? args.cmd : '').slice(0, 65_536) };
    this.entries.push(entry);
    const own = this.entries.filter((item) => item.workspaceId === workspaceId);
    if (own.length > 500) {
      const expired = new Set(own.slice(0, own.length - 500).filter((item) => item.status !== 'pending'
        && (item.name !== 'exec_command' || item.sessionId === undefined || !this.activeSessions.has(item.sessionId))).map((item) => item.id));
      this.entries = this.entries.filter((item) => !expired.has(item.id));
    }
    this.changed();
    try {
      const value = await action();
      const result = value as { isError?: boolean; exit_code?: number | null; session_id?: number; termination_requested?: boolean; running?: boolean } | null;
      entry.status = result?.isError || (result?.exit_code != null && result.exit_code !== 0 && !result.termination_requested) ? 'error' : 'success';
      if (typeof result?.session_id === 'number') {
        entry.sessionId = result.session_id;
        if (name === 'exec_command' && result.running) this.activeSessions.add(result.session_id);
      }
      entry.result = this.describe(value);
      return value;
    } catch (error) {
      entry.status = 'error'; entry.result = this.redact(error instanceof Error ? error.message : '调用失败');
      throw error;
    } finally { entry.endedAt = Date.now(); this.changed(); }
  }
  dispose(): void { if (this.timer) clearTimeout(this.timer); this.listeners.clear(); this.activeSessions.clear(); }
}
