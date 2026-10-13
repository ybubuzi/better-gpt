import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { ProxyAgent } from 'proxy-agent';
import type { ProxyConfig } from '@better-gpt/contracts';
import { SecretVault } from './secret-vault.js';

function bypasses(url: URL, entries: string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return entries.flatMap((entry) => entry.split(/[\s,]+/)).some((entry) => {
    entry = entry.trim().toLowerCase(); if (!entry) return false; if (entry === '*') return true;
    if (entry.replace(/^\[|\]$/g, '') === host) return true;
    const match = /^(.*?)(?::(\d+))?$/.exec(entry)!;
    if (match[2] && match[2] !== port) return false;
    const domain = match[1]!.replace(/^\[|\]$/g, '');
    if (domain.startsWith('*.') || domain.startsWith('.')) return host.endsWith(domain.replace(/^\*/, ''));
    return host === domain;
  });
}

export async function proxyAddress(config: ProxyConfig, directory: string, target?: URL): Promise<string> {
  if (config.mode === 'direct') return '';
  if (target && bypasses(target, ['localhost', '127.0.0.1', '::1', ...config.bypass,
    ...(config.mode === 'environment' ? [process.env.no_proxy ?? process.env.NO_PROXY ?? ''] : [])])) return '';
  if (config.mode === 'environment') {
    const scheme = target?.protocol === 'http:' ? 'http' : 'https';
    return process.env[`${scheme}_proxy`] ?? process.env[`${scheme.toUpperCase()}_PROXY`] ?? process.env.all_proxy ?? process.env.ALL_PROXY ?? '';
  }
  const url = new URL(config.url);
  if (config.credentialRef) {
    const credentials = JSON.parse((await new SecretVault(directory).read(config.credentialRef)).toString('utf8')) as { username: string; password: string };
    if (typeof credentials.username !== 'string' || typeof credentials.password !== 'string') throw new Error('代理凭据格式无效');
    url.username = credentials.username; url.password = credentials.password;
  }
  return url.href;
}

/** Fetch-compatible HTTP transport with HTTP/HTTPS/SOCKS agent support and streamed responses. */
export function networkFetch(proxy: ProxyConfig, directory: string): typeof globalThis.fetch {
  return async (input, init) => {
    let request = new Request(input, init);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const url = new URL(request.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持HTTP/HTTPS请求');
      const address = await proxyAddress(proxy, directory, url);
      const agent = address ? new ProxyAgent({ getProxyForUrl: () => address }) : undefined;
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.clone().arrayBuffer());
      const response = await new Promise<Response>((resolve, reject) => {
        const headers: Record<string, string> = {}; request.headers.forEach((value, key) => { headers[key] = value; });
        const outgoing = (url.protocol === 'https:' ? https : http).request(url, { method: request.method, headers, ...(agent ? { agent } : {}), signal: request.signal }, (incoming) => {
          const responseHeaders = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) for (const part of Array.isArray(value) ? value : [value]) responseHeaders.append(key, part);
          incoming.once('close', () => agent?.destroy());
          resolve(new Response([204, 205, 304].includes(incoming.statusCode ?? 200) || request.method === 'HEAD' ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status: incoming.statusCode ?? 200, headers: responseHeaders }));
        });
        outgoing.once('error', (error) => { agent?.destroy(); reject(error); }); outgoing.end(body);
      });
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.has('location') || request.redirect === 'manual') return response;
      if (request.redirect === 'error') { void response.body?.cancel(); throw new Error('请求发生重定向'); }
      if (redirects === 5) throw new Error('重定向次数过多');
      const next = new URL(response.headers.get('location')!, request.url), headers = new Headers(request.headers);
      if (next.origin !== url.origin) { headers.delete('authorization'); headers.delete('cookie'); }
      const method = response.status === 303 || ([301, 302].includes(response.status) && request.method === 'POST') ? 'GET' : request.method;
      void response.body?.cancel();
      request = new Request(next, { method, headers, signal: request.signal, ...(!['GET', 'HEAD'].includes(method) && body ? { body } : {}) });
    }
    throw new Error('请求失败');
  };
}
