import { createServer, type ServerResponse } from 'node:http';
import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { appVersion, legacyToolSchemas, workspacePath, type LegacyToolName } from '@better-gpt/contracts';
import type { Application } from './application.js';
import { allowedWorkspace } from './tunnels.js';
import { observeRejectedCalls } from './tool-errors.js';
import { annotations, callLegacyTool, serverInstructions, toolDescriptions, workspaceOverview } from './tool-service.js';
import { summaryHtml } from './summary-ui.js';

const toolSchemas = new Map<string, { safeParse(value: unknown): { success: boolean } }>([
  ['workspace_info', { safeParse: (value) => ({ success: value !== null && typeof value === 'object' && !Array.isArray(value) }) }],
  ...Object.entries(legacyToolSchemas),
]);

export interface LocalService {
  port: number;
  origin: string;
  close(): Promise<void>;
}

export interface ServiceOptions {
  publicHostname?: string;
  /** A profile listener shares application state but does not own the local service lifecycle. */
  managedListener?: boolean;
}

/** Every tunnel receives a dedicated loopback listener with an immutable profile scope. */
export async function startLocalService(app: Application, port = 18921, profileId?: string, options: ServiceOptions = {}): Promise<LocalService> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须在 0–65535 之间');
  if (profileId && !(await app.store.read()).config.tunnelProfiles.some((profile) => profile.id === profileId && profile.enabled)) {
    throw new Error('指定的隧道配置不存在或已停用');
  }
  const handlers = new Map<string, McpHttpHandler>();
  let stopping = false;
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const reply = (response: ServerResponse, code: number, body: unknown) => {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (stopping) { reply(response, 503, { error: 'service is stopping' }); return; }
      if (!validateHost(request, response)) return;
      const origin = request.headers.origin;
      if (!(options.publicHostname && origin === `https://${options.publicHostname}`)
        && !validateOrigin(request, response)) return;
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/healthz' && request.method === 'GET') {
        reply(response, 200, { status: 'ok', version: appVersion, mode: profileId ? 'tunnel-origin' : 'local', profileId: profileId ?? null });
        return;
      }
      const config = (await app.store.read()).config;
      const workspace = config.workspaces.find((item) => item.enabled && workspacePath(item.uuid) === path);
      if (!workspace || (profileId && !allowedWorkspace(config, profileId, workspace.uuid))) {
        reply(response, 404, { error: 'workspace not found' });
        return;
      }
      let handler = handlers.get(workspace.uuid);
      if (!handler) {
        const uuid = workspace.uuid;
        handler = createMcpHandler(async () => {
          const currentWorkspace = await app.workspace(uuid);
          const mcp = new McpServer({ name: 'better-gpt', version: appVersion }, { instructions: await serverInstructions(app, currentWorkspace) });
          mcp.registerTool('workspace_info', {
            description: 'Read the current workspace identity and local gateway development status.',
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          }, async () => {
            const info = await app.runtime.trace(uuid, 'workspace_info', {}, async () => {
              const current = (await app.store.read()).config.workspaces.find((item) => item.uuid === uuid && item.enabled);
              if (!current) throw new Error('工作区已停用或删除');
              return { uuid: current.uuid, name: current.name, projectRoot: current.projectRoot,
                mcpPath: workspacePath(uuid), stage: 'development' };
            });
            return { content: [{ type: 'text', text: JSON.stringify(info) }], structuredContent: info };
          });
          for (const name of Object.keys(legacyToolSchemas) as LegacyToolName[]) {
            mcp.registerTool(name, { description: toolDescriptions[name], inputSchema: legacyToolSchemas[name], annotations: annotations(name) }, async (input: Record<string, unknown>) => {
              if (stopping) throw new Error('服务正在停止');
              return callLegacyTool(app, uuid, name, input);
            });
          }
          mcp.registerResource('workspace-overview', `ui://workspace/${uuid}`, { mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(workspaceOverview(await app.workspace(uuid))) }] }));
          mcp.registerResource('round-summary-ui', 'ui://codexter/round-summary-ui.html', { mimeType: 'text/html;profile=mcp-app',
            _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: summaryHtml }] }));
          return mcp;
        }, { legacy: 'stateless' });
        handler = observeRejectedCalls(handler, app.runtime, uuid, toolSchemas);
        handlers.set(uuid, handler);
      }
      await toNodeHandler(handler)({
        method: request.method ?? 'GET', url: request.url ?? '/', headers: request.headers,
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      }, response);
    })().catch((error: unknown) => {
      if (!response.headersSent) reply(response, 500, { error: 'local service error' });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取服务端口');
  if (!options.managedListener) {
    app.processes.activate();
    app.runtime.serviceOrigin = `http://127.0.0.1:${address.port}`;
    app.runtime.serviceError = '';
    app.runtime.changed();
  }
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closing ??= (async () => {
      stopping = true;
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const stoppedProcesses = options.managedListener ? Promise.resolve() : app.processes.shutdown();
      server.closeAllConnections();
      try { await Promise.all([closed, stoppedProcesses, ...[...handlers.values()].map((handler) => handler.close())]); }
      finally { if (!options.managedListener) { app.runtime.serviceOrigin = ''; app.runtime.changed(); } }
    })(),
  };
}
