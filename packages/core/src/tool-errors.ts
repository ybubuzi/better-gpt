import { readRequestBody, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { RuntimeStore } from './runtime-store.js';

const maxBody = 4 * 1024 * 1024;
interface ToolCall { method?: string; id?: unknown; params?: { name?: unknown; arguments?: unknown } }

async function errorMessages(response: Response): Promise<Record<string, unknown>[]> {
  const reader = response.clone().body?.getReader();
  if (!reader) return [];
  let text = '', received = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBody) { void reader.cancel(); return []; }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const parsed: unknown[] = [];
    if (/^[\[{]/.test(text.trim())) {
      const json: unknown = JSON.parse(text); parsed.push(...(Array.isArray(json) ? json : [json]));
    } else for (const line of text.split('\n')) if (line.startsWith('data:')) {
      try { parsed.push(JSON.parse(line.slice(5)) as unknown); } catch {}
    }
    return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  } finally { reader.releaseLock(); }
}

/** Capture SDK rejections once; valid callbacks are traced by Application. */
export function observeRejectedCalls(handler: McpHttpHandler, runtime: RuntimeStore, workspaceId: string,
  schemas: ReadonlyMap<string, { safeParse(value: unknown): { success: boolean } }>): McpHttpHandler {
  return {
    ...handler,
    fetch: async (request, options) => {
      if (request.method !== 'POST') return handler.fetch(request, options);
      // The Node adapter already enforces this limit. Keep it here for direct use as well.
      const body = await readRequestBody(request, maxBody);
      if (body.tooLarge) return Response.json({ jsonrpc: '2.0', id: null,
        error: { code: -32000, message: 'Request body exceeds 4 MiB' } }, { status: 413 });
      let parsed: unknown;
      try { parsed = JSON.parse(body.text) as unknown; }
      catch { return handler.fetch(new Request(request, { body: body.text }), options); }
      const calls = (Array.isArray(parsed) ? parsed : [parsed]).filter((item): item is ToolCall =>
        !!item && typeof item === 'object' && 'method' in item && item.method === 'tools/call');
      const rejected = calls.slice(0, 128).flatMap((message) => {
        const name = typeof message.params?.name === 'string' ? message.params.name : '(未提供工具名)';
        const args = message.params?.arguments === undefined ? {} : message.params.arguments;
        if (schemas.get(name)?.safeParse(args).success) return [];
        return [{ name, args, id: message.id }];
      });
      const dispatch = () => handler.fetch(request, { ...options, parsedBody: parsed });
      if (!rejected.length) return dispatch();
      let response: Promise<Response> | undefined;
      let messages: Promise<Record<string, unknown>[]> | undefined;
      await Promise.all(rejected.map(({ name, args, id }) => runtime.trace(workspaceId, name,
        args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : { invalidArguments: args }, async () => {
          const result = await (response ??= dispatch());
          const payload = (await (messages ??= errorMessages(result))).find((item) => item.id === id);
          return { isError: true, response: payload ?? { error: '请求被 MCP 拒绝，或响应日志超过显示限制', status: result.status } };
        })));
      return response!;
    },
  };
}
