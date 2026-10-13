import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Application } from './application.js';
import { childEnvironment } from './process-manager.js';
import { proxyAddress } from './network.js';

const string = { type: 'string' }, number = { type: 'number' }, integer = { type: 'integer', minimum: 0 };
const windowSchema = { type: 'object', properties: { app: string, id: integer, title: string }, required: ['app', 'id'] };
const window = { window: windowSchema }, screenshot = { screenshotId: string };
const specs: [string, Record<string, unknown>, string[]][] = [
  ['list_windows', {}, []], ['get_window', { id: integer, app: string }, ['id']], ['list_apps', {}, []], ['launch_app', { app: string }, ['app']],
  ['get_window_state', { ...window, include_screenshot: { type: 'boolean', default: true }, include_text: { type: 'boolean', default: false } }, ['window']],
  ['click', { ...window, ...screenshot, element_index: integer, x: number, y: number, click_count: { type: 'integer', default: 1 }, mouse_button: { type: 'string', enum: ['left', 'right', 'middle', 'l', 'r', 'm'] } }, ['window']],
  ['press_key', { ...window, key: string }, ['window', 'key']], ['type_text', { ...window, text: string }, ['window', 'text']],
  ['scroll', { ...window, ...screenshot, x: number, y: number, scrollX: number, scrollY: number }, ['window', 'x', 'y', 'scrollX', 'scrollY']],
  ['set_value', { ...window, element_index: integer, value: string }, ['window', 'element_index', 'value']],
  ['drag', { ...window, ...screenshot, from_x: number, from_y: number, to_x: number, to_y: number }, ['window', 'from_x', 'from_y', 'to_x', 'to_y']],
  ['perform_secondary_action', { ...window, element_index: integer, action: string }, ['window', 'element_index', 'action']],
  ['activate_window', window, ['window']], ['end_turn', {}, []],
];
export const computerUseDefinitions: Record<string, unknown>[] = specs.map(([name, properties, required]) => ({ name,
  description: `Windows Computer Use: ${name}. Use observed window/element identities. end_turn finishes the current desktop task.`,
  inputSchema: { type: 'object', properties, required }, annotations: { readOnlyHint: ['list_windows', 'list_apps', 'get_window', 'get_window_state'].includes(name) } }));

async function newest(paths: string[]): Promise<string | undefined> {
  const found = await Promise.all(paths.map(async (path) => { try { return { path, time: (await stat(path)).mtimeMs }; } catch { return undefined; } }));
  return found.filter((item) => item !== undefined).sort((a, b) => b.time - a.time)[0]?.path;
}

export class ComputerUseClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private closing = false;
  private nextId = 1;
  private pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private generation = 0;
  private screenshots = new Map<string, { original: string; app: string; id: number }>();
  constructor(private readonly app: Application) {}
  async start(): Promise<void> {
    if (this.closing) throw new Error('Computer Use正在停止');
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return;
    return this.starting ??= this.launch().finally(() => { this.starting = undefined; });
  }
  private async launch(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('Computer Use仅支持Windows');
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    let source = ''; try { source = await readFile(join(codexHome, 'config.toml'), 'utf8'); } catch {}
    const setting = (key: string) => process.env[key] ?? new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, 'm').exec(source)?.[1];
    const directories = (setting('NODE_REPL_NODE_MODULE_DIRS') ?? '').split(';').filter(Boolean);
    const runtime = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex');
    const children = await readdir(join(runtime, 'runtimes', 'cua_node')).catch(() => []);
    const helper = await newest([...directories.map((directory) => join(directory, '@oai', 'sky', 'bin', 'windows', 'codex-computer-use.exe')),
      ...children.map((name) => join(runtime, 'runtimes', 'cua_node', name, 'bin', 'node_modules', '@oai', 'sky', 'bin', 'windows', 'codex-computer-use.exe'))]);
    const bins = await readdir(join(runtime, 'bin')).catch(() => []);
    const cli = setting('CODEX_CLI_PATH') ?? await newest(bins.map((name) => join(runtime, 'bin', name, 'codex.exe')));
    if (!helper || !cli) throw new Error('未找到已安装的Codex Computer Use helper/CLI');
    await access(cli);
    const { config } = await this.app.store.read();
    const address = await proxyAddress(config.proxy, this.app.store.directory); if (address) this.app.runtime.protectSecret(address);
    if (this.closing) throw new Error('Computer Use启动已取消');
    const child = spawn(helper, ['--parent-pid', String(process.pid)], { cwd: dirname(helper), windowsHide: true,
      env: { ...childEnvironment(config.proxy, address), CODEX_HOME: codexHome, CODEX_CLI_PATH: cli }, stdio: 'pipe' });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk; if (buffer.length > 40 * 1024 * 1024) { child.kill(); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try { const message = JSON.parse(line) as Record<string, unknown>; const id = Number(message.id), pending = this.pending.get(id); if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(message); } } catch {}
      }
    });
    child.stderr.resume(); child.stdin.on('error', () => {});
    const closed = () => { if (this.child !== child) return; this.child = undefined; this.screenshots.clear(); for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Computer Use helper已退出')); } this.pending.clear(); };
    child.once('close', closed); child.once('error', closed);
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    try { if (this.closing) throw new Error('Computer Use启动已取消'); await this.request('list_windows', {}, 15000); } catch (error) { await this.stopChild(); throw error; }
  }
  private async send(method: string, params: Record<string, unknown>, timeout: number, meta?: Record<string, unknown>) {
    if (!this.child) throw new Error('Computer Use helper未启动'); const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Computer Use ${method} 超时`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.child!.stdin.write(JSON.stringify({ id, method, params, ...(meta ? { meta } : {}) }) + '\n');
    });
  }
  private async request(method: string, params: Record<string, unknown>, timeout = 60000): Promise<unknown> {
    let meta: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await this.send(method, params, timeout, meta);
      if (response.ok === true) return response.result;
      if (response.approvalRequest && typeof response.approvalRequest === 'object') {
        const application = (response.approvalRequest as { app?: unknown }).app;
        const { config } = await this.app.store.read();
        if (typeof application !== 'string' || !config.computerUseApprovedApps.includes(application)) throw new Error(`Computer Use需要本机授权应用：${String(application)}；请通过本地 CLI computer-use allow --app <应用标识> 明确批准`);
        meta = { 'x-oai-cua-approved-app': application }; continue;
      }
      throw new Error(`Computer Use: ${JSON.stringify(response.error ?? '请求失败')}`);
    }
    throw new Error('Computer Use审批重试次数超限');
  }
  async call(tool: string, args: Record<string, unknown>) {
    if (!specs.some(([name]) => name === tool)) throw new Error(`Unknown Computer Use tool: ${tool}`);
    await this.start(); const params = { ...args };
    if (tool === 'end_turn') { this.screenshots.clear(); await this.request('end_turn', {}, 2000); return this.generic(null); }
    const requested = params.window as { app?: string; id?: number } | undefined;
    if (!(tool === 'click' && params.element_index !== undefined) && params.screenshotId !== undefined) {
      const binding = this.screenshots.get(String(params.screenshotId)) ?? [...this.screenshots.values()].find((entry) => entry.original === params.screenshotId);
      if (!binding || binding.app !== requested?.app || binding.id !== requested?.id) throw new Error('截图标识已过期或不属于当前窗口，请重新观察');
      params.screenshotId = binding.original;
    }
    const result = tool === 'click' && params.element_index !== undefined ? await this.request('click_element', { window: params.window, element_index: params.element_index, click_count: params.click_count ?? 1, mouse_button: params.mouse_button ?? 'left' }) : await this.request(tool, params);
    if (tool === 'get_window_state' && result && typeof result === 'object' && !Array.isArray(result)) {
      const state = { ...result as Record<string, unknown> }, screenshots = Array.isArray(state.screenshots) ? state.screenshots : [];
      if (params.include_screenshot !== false || screenshots.length) { this.screenshots.clear(); this.generation++; }
      const images: { type: 'image'; data: string; mimeType: string }[] = [];
      state.screenshots = screenshots.map((raw, index) => {
        const item = { ...raw as Record<string, unknown> }, match = /^data:([^;]+);base64,(.+)$/.exec(String(item.url ?? ''));
        if (match) images.push({ type: 'image', mimeType: match[1]!, data: match[2]! }); delete item.url;
        const id = `codexter-shot-${this.generation}-${index}`;
        this.screenshots.set(id, { original: String(item.id ?? ''), app: String(requested?.app ?? ''), id: Number(requested?.id) }); item.id = id; return item;
      });
      const text = JSON.stringify(state, null, 2); return { content: [{ type: 'text' as const, text }, ...images], structuredContent: { ...state, text } };
    }
    return this.generic(result);
  }
  private generic(result: unknown) {
    const text = result == null ? 'OK' : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text' as const, text }], structuredContent: { ...(result && typeof result === 'object' && !Array.isArray(result) ? result : result == null ? {} : { result }), text } };
  }
  private async stopChild(): Promise<void> {
    const child = this.child; if (!child) return;
    await this.send('close', {}, 1500).catch(() => {}); child.kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); this.child = undefined; this.screenshots.clear();
  }
  async close(): Promise<void> { this.closing = true; await this.stopChild(); await this.starting?.catch(() => {}); await this.stopChild(); }
}
