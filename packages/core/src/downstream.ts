import { Client, StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { stat } from 'node:fs/promises';
import type { AppConfig, Workspace } from '@better-gpt/contracts';
import { appVersion } from '@better-gpt/contracts';
import type { Application } from './application.js';
import { childEnvironment } from './process-manager.js';
import { networkFetch, proxyAddress } from './network.js';
import { ComputerUseClient, computerUseDefinitions } from './computer-use.js';

interface Connection {
  name: string; state: 'idle' | 'connecting' | 'connected' | 'failed' | 'closed'; tools: Record<string, unknown>[];
  target: string; transport: string; signature: string; error: string; client?: Client; channel?: Transport;
  connecting?: Promise<void>; computer?: ComputerUseClient; toolTimeout: number; startupTimeout: number; closing?: boolean;
}

export class DownstreamPool {
  private connections = new Map<string, Connection>();
  private loading: Promise<void> | undefined;
  private closed = false;
  constructor(private readonly app: Application) {}
  activate(): void { this.closed = false; }
  private changed(): void {
    this.app.runtime.mcps = [...this.connections.values()].map((entry) => ({ name: entry.name, transport: entry.transport, target: entry.target, state: entry.state, toolCount: entry.tools.length, ...(entry.error ? { error: entry.error } : {}) }));
    this.app.runtime.changed();
  }
  async refresh(): Promise<void> {
    if (this.closed) throw new Error('下游MCP正在停止');
    return this.loading ??= this.synchronize().finally(() => { this.loading = undefined; });
  }
  private async synchronize(): Promise<void> {
    const { config } = await this.app.store.read();
    if (this.closed) return;
    const desired = config.downstreamMcps.filter((entry) => entry.enabled).map((entry) => ({ name: entry.name, signature: JSON.stringify({ entry, proxy: config.proxy }), entry }));
    if (config.computerUseEnabled && process.platform === 'win32') desired.push({ name: 'computer-use', signature: 'builtin', entry: undefined as never });
    for (const [name, connection] of this.connections) if (!desired.some((item) => item.name === name && item.signature === connection.signature)) { await this.closeConnection(connection); this.connections.delete(name); }
    await Promise.all(desired.map(async ({ name, signature, entry }) => {
      if (this.closed) return;
      let connection = this.connections.get(name);
      if (connection) return;
      connection = { name, signature, state: 'idle', tools: [], error: '', target: '', transport: 'unknown', startupTimeout: entry?.startupTimeoutMs ?? 15000, toolTimeout: entry?.toolTimeoutMs ?? 60000 };
      if (name === 'computer-use' && signature === 'builtin') { connection.computer = new ComputerUseClient(this.app); connection.transport = 'builtin'; connection.target = 'Auto-discover Codex Computer Use runtime'; connection.tools = computerUseDefinitions; }
      this.connections.set(name, connection);
      await this.connect(connection, config).catch(() => {});
    }));
    this.changed();
  }
  private async connect(connection: Connection, config: AppConfig): Promise<void> {
    const check = () => { if (this.closed || connection.closing) throw new Error('下游MCP正在停止'); };
    check();
    if (connection.state === 'connected') return;
    return connection.connecting ??= (async () => {
      connection.state = 'connecting'; connection.error = ''; this.changed();
      try {
        if (connection.computer) { await connection.computer.start(); check(); connection.state = 'connected'; return; }
        const raw = await this.app.migration.readTransport(connection.name);
        check();
        this.protect(raw);
        const client = new Client({ name: 'better-gpt', version: appVersion });
        client.onclose = () => { if (connection.state === 'connected') { connection.state = 'closed'; this.changed(); } };
        connection.client = client;
        let channel: Transport;
        if (typeof raw.command === 'string') {
          await stat(raw.command).catch((error: NodeJS.ErrnoException) => { if ((raw.command as string).includes(':') && error.code === 'ENOENT') throw new Error(`MCP 可执行程序不存在：${raw.command}`); });
          connection.transport = 'stdio'; connection.target = raw.command;
          const overrides = raw.env && typeof raw.env === 'object' ? raw.env as Record<string, string> : {};
          const address = await proxyAddress(config.proxy, this.app.store.directory); if (address) this.app.runtime.protectSecret(address); check();
          const env = Object.fromEntries(Object.entries({ ...childEnvironment(config.proxy, address), ...overrides }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
          const stdio = new StdioClientTransport({ command: raw.command, args: Array.isArray(raw.args) ? raw.args.map(String) : [], env, stderr: 'pipe', ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}) });
          stdio.stderr?.on('data', (chunk: Buffer) => { connection.error = this.app.runtime.redact(chunk.toString()).slice(-2000); });
          channel = stdio;
        } else if (typeof raw.url === 'string') {
          const url = new URL(raw.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('MCP URL必须使用HTTP/HTTPS');
          connection.transport = 'http'; connection.target = `${url.origin}${url.pathname}`;
          const headers = raw.headers && typeof raw.headers === 'object' ? raw.headers as Record<string, string> : {};
          channel = new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: networkFetch(config.proxy, this.app.store.directory), protocolVersion: '2025-03-26' });
        } else throw new Error('MCP没有command或url');
        connection.channel = channel;
        check();
        await Promise.race([client.connect(channel), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('MCP连接超时')), connection.startupTimeout); timer.unref(); })]);
        check();
        const listed = await client.listTools({}, { timeout: connection.startupTimeout });
        check();
        connection.tools = listed.tools as unknown as Record<string, unknown>[]; connection.state = 'connected'; connection.error = '';
      } catch (error) {
        connection.error = this.app.runtime.redact(error instanceof Error ? error.message : 'MCP连接失败');
        await connection.client?.close().catch(() => {}); connection.state = 'failed'; throw error;
      } finally { this.changed(); }
    })().finally(() => { delete connection.connecting; });
  }
  private protect(value: unknown, key = ''): void {
    if (typeof value === 'string' && /secret|password|token|authorization|api[_-]?key/i.test(key)) this.app.runtime.protectSecret(value);
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) this.protect(child, key);
  }
  private allowed(workspace: Workspace): Connection[] {
    return [...this.connections.values()].filter((entry) => workspace.selectedMcpNames === null || workspace.selectedMcpNames.includes(entry.name));
  }
  async list(workspace: Workspace, name?: string) {
    await this.refresh();
    const allowed = this.allowed(workspace), targets = name ? allowed.filter((entry) => entry.name === name) : allowed;
    if (name && !targets.length) throw new Error(`Unknown MCP server: ${name}`);
    const servers = targets.map((entry) => ({ name: entry.name, transport: entry.transport, target: entry.target, state: entry.state, toolCount: entry.tools.length,
      ...(entry.computer ? { builtIn: true, displayName: 'Computer Use' } : {}), ...(entry.error ? { error: entry.error } : {}) }));
    return { servers, tools: Object.fromEntries(targets.map((entry) => [entry.name, entry.tools])), text: targets.length ? targets.map((entry) => `=== ${entry.name} [${entry.state}] ${entry.tools.length} tools ===\n${entry.tools.map((tool) => `  ${tool.name}: ${String(tool.description ?? '').slice(0, 160)}\n`).join('')}`).join('') : 'No MCP servers enabled for this workspace.' };
  }
  async call(workspace: Workspace, server: string, tool: string, args: Record<string, unknown>) {
    await this.refresh(); const connection = this.allowed(workspace).find((entry) => entry.name === server); if (!connection) throw new Error(`Unknown MCP server: ${server}`);
    if (connection.state !== 'connected') { const { config } = await this.app.store.read(); await this.connect(connection, config); }
    if (this.closed || connection.closing) throw new Error('下游MCP正在停止');
    if (connection.computer) return connection.computer.call(tool, args);
    if (!connection.client) throw new Error('MCP未连接');
    return connection.client.callTool({ name: tool, arguments: args }, { timeout: connection.toolTimeout });
  }
  private async closeConnection(connection: Connection): Promise<void> {
    connection.closing = true;
    await connection.client?.close().catch(() => {});
    await connection.connecting?.catch(() => {});
    await connection.computer?.close(); await connection.client?.close().catch(() => {}); connection.state = 'closed';
  }
  async close(): Promise<void> {
    this.closed = true; await this.loading?.catch(() => {});
    await Promise.all([...this.connections.values()].map((entry) => this.closeConnection(entry))); this.connections.clear(); this.changed();
  }
}
