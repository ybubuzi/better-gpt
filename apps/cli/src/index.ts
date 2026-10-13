#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import * as prompts from '@clack/prompts';
import { Application, DaemonClient, inspectLegacy, planTunnels } from '@better-gpt/core';
import { appVersion, workspaceEndpoint, tunnelStatusLabels } from '@better-gpt/contracts';
import { setupTunnel } from './self-hosted-setup.js';
import { doctorTunnels } from './tunnel-doctor.js';

const program = new Command().name('better-gpt').version(appVersion)
  .description('Better GPT — 本地 MCP 网关开发版')
  .option('--data-dir <directory>', '独立配置目录（也可设置 BETTER_GPT_DATA_DIR）');
const application = () => {
  const directory = program.opts<{ dataDir?: string }>().dataDir;
  return directory ? new Application(resolve(directory)) : new Application();
};
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const daemonClient = () => new DaemonClient(application().store.directory, fileURLToPath(new URL('./daemon.js', import.meta.url)));

async function openTui() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('TUI 需要交互式终端；脚本环境请使用 status、serve 或 --help。');
  }
  const { runTui } = await import('@better-gpt/tui');
  const client = daemonClient();
  await client.attach();
  await runTui(client);
}
program.action(openTui);
program.command('tui').description('打开交互式终端界面').action(openTui);

const serviceCommands = program.command('service').description('独立后台 MCP 与隧道服务');
serviceCommands.command('start').option('--port <port>', '本机 MCP 端口', '18921')
  .option('--local-only', '仅启动本地 MCP').option('--profile <uuid>', '指定隧道配置')
  .action(async (options: { port: string; localOnly?: boolean; profile?: string }) => {
    const client = daemonClient();
    try {
      const result = await client.startGateway(Number(options.port), options.profile, options.localOnly);
      print({ pid: client.daemonPid, listening: result.service.origin, mode: 'background',
        tunnels: result.tunnels.map(({ profileId, name, status, error }) => ({ profileId, name, status, error })) });
    }
    finally { await client.dispose(); }
  });
serviceCommands.command('status').action(async () => {
  const client = daemonClient();
  try { const state = await client.status(); print(state ? { running: true, pid: state.pid, listening: state.serviceOrigin || null,
    tunnels: state.tunnels.map(({ name, status, error }) => ({ name, status, error })) } : { running: false }); }
  finally { await client.dispose(); }
});
serviceCommands.command('stop').description('停止后台 MCP、隧道、受管进程并退出后台服务').action(async () => {
  const client = daemonClient();
  try { if (!await client.attach()) { print({ running: false }); return; } await client.shutdown(); print({ stopped: true }); }
  finally { await client.dispose(); }
});

const computerUse = program.command('computer-use').description('本机Windows桌面工具设置');
computerUse.command('enable').option('--disable', '停用桌面工具').action(async (options: { disable?: boolean }) => {
  await application().store.update((config) => ({ ...config, computerUseEnabled: !options.disable }));
  console.log(options.disable ? 'Computer Use已停用' : 'Computer Use已启用，后续mcp_tools将自动发现');
});
computerUse.command('allow').requiredOption('--app <application>', '明确批准的应用标识').action(async (options: { app: string }) => {
  await application().store.update((config) => ({ ...config, computerUseApprovedApps: [...new Set([...config.computerUseApprovedApps, options.app])] }));
  console.log('应用授权已保存');
});

program.command('serve').description('前台运行 MCP 服务并启动已绑定的隧道')
  .option('--port <port>', '本机监听端口；0 表示分配空闲端口', '18921')
  .option('--profile <uuid>', '只允许这个隧道配置绑定的工作区')
  .option('--local-only', '仅启动本地 MCP，不启动公网隧道')
  .action(async (options: { port: string; profile?: string; localOnly?: boolean }) => {
    const app = application();
    let stopping = false;
    const last = new Map<string, string>();
    const unsubscribe = app.runtime.subscribe(() => {
      for (const tunnel of app.runtime.tunnels.values()) {
        const status = `${tunnel.status}:${tunnel.error}`;
        if (last.get(tunnel.profileId) === status) continue;
        last.set(tunnel.profileId, status);
        print({ tunnel: tunnel.name, status: tunnelStatusLabels[tunnel.status], error: tunnel.error || undefined });
      }
    });
    const shutdown = () => {
      if (stopping) return; stopping = true;
      void app.dispose().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : '停止服务失败'); process.exitCode = 1;
      }).finally(() => { unsubscribe(); process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    try {
      const service = await app.startService(Number(options.port), options.profile);
      print({ listening: service.origin, mode: options.localOnly ? 'local-only' : 'gateway', tools: ['workspace_info', 'read', 'read_image', 'apply_patch', 'ls', 'grep', 'glob', 'code_explore', 'exec_command', 'write_stdin', 'skills_list', 'skill_read', 'mcp_tools', 'mcp_call', 'summary'] });
      if (!options.localOnly && !stopping) {
        const result = await app.startGateway(Number(options.port), options.profile);
        const failures = result.tunnels.filter((tunnel) => tunnel.status === 'failed');
        print({ tunnels: result.tunnels.map(({ profileId, name, status, error }) => ({ profileId, name, status, error })),
          message: failures.length ? '本地 MCP 已运行，但部分公网隧道启动失败；请处理上述原因后重新启动。'
            : result.tunnels.length ? '已完成已绑定隧道的启动流程。' : '没有启用且绑定工作区的隧道，本次仅提供本地 MCP。' });
      }
    } catch (error) {
      await app.dispose(); unsubscribe(); process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
      if (!stopping) throw error;
    }
  });

program.command('init').description('初始化独立配置，不读取或覆盖旧版内容')
  .action(async () => { const state = await application().initialize(); print({ dataDirectory: state.dataDirectory, initialized: state.initialized }); });
program.command('status').description('查看本地配置和已配置入口（不表示隧道已运行）')
  .action(async () => {
    const state = await application().snapshot();
    print({ ...state, endpoints: state.config.workspaces.map((workspace) => ({
      uuid: workspace.uuid, ...workspaceEndpoint(workspace, state.config),
    })) });
  });
program.command('setup').description('交互式初始化并添加本地工作区')
  .action(async () => {
    prompts.intro('Better GPT · 本地配置');
    const values = await prompts.group({
      name: () => prompts.text({ message: '工作区名称', validate: (value) => value?.trim() ? undefined : '请输入名称' }),
      projectRoot: () => prompts.text({ message: '项目目录（绝对路径）', initialValue: process.cwd() }),
    }, { onCancel: () => { prompts.cancel('已取消，未写入配置'); process.exit(0); } });
    const state = await application().createWorkspace(values);
    prompts.outro(`工作区已保存到 ${state.dataDirectory}；未启动公网隧道。`);
  });
const workspace = program.command('workspace').description('工作区配置');
workspace.command('add').requiredOption('--name <name>').requiredOption('--path <directory>')
  .action(async (options: { name: string; path: string }) => {
    const state = await application().createWorkspace({ name: options.name, projectRoot: options.path });
    print(state.config.workspaces.at(-1));
  });
workspace.command('bind').requiredOption('--workspace <uuid>').requiredOption('--profile <uuid>')
  .option('--tunnel-id <id>', '兼容旧OpenAI项目绑定；新配置共用profile中的Tunnel ID')
  .action(async (options: { workspace: string; profile: string; tunnelId?: string }) => {
    const client = daemonClient();
    try { const result = await client.bindWorkspace(options.workspace, { profileId: options.profile, ...(options.tunnelId ? { openAiTunnelId: options.tunnelId } : {}) }); console.log(result.warning ?? '绑定已保存；后台运行时同步更新入口。'); }
    finally { await client.dispose(); }
  });
workspace.command('unbind').requiredOption('--workspace <uuid>').description('解除项目隧道绑定，保留隧道配置').action(async (options: { workspace: string }) => {
  const client = daemonClient(); try { await client.bindWorkspace(options.workspace, null); console.log('已解除绑定；隧道配置保留。'); } finally { await client.dispose(); }
});
workspace.command('remove').requiredOption('--workspace <uuid>').description('移除项目管理记录并停止其受管进程，保留磁盘文件').action(async (options: { workspace: string }) => {
  const client = daemonClient(); try { print(await client.removeWorkspace(options.workspace)); } finally { await client.dispose(); }
});
const tunnel = program.command('tunnel').description('隧道配置与路由预览');
for (const action of ['start', 'stop'] as const) {
  tunnel.command(action).description(`${action === 'start' ? '启动' : '暂停'}项目、渠道或全部公网入口，保留本地MCP`)
    .option('--workspace <uuid>', '单个工作区').option('--profile <uuid>', '单个隧道配置')
    .option('--provider <provider>', 'cloudflare / openai / custom / frp / ssh / external')
    .option('--all', '全部已启用工作区（默认）')
    .action(async (options: { workspace?: string; profile?: string; provider?: string; all?: boolean }) => {
      if ([options.workspace, options.profile, options.provider, options.all].filter(Boolean).length > 1) throw new Error('请仅指定一个控制范围');
      const scope = options.workspace ? { kind: 'workspace', workspaceId: options.workspace } : options.profile ? { kind: 'profile', profileId: options.profile } : options.provider ? { kind: 'provider', provider: options.provider } : { kind: 'all' };
      const client = daemonClient();
      try { const result = await client.controlTunnels({ action, scope } as Parameters<DaemonClient['controlTunnels']>[0]); print({ affectedWorkspaces: result.affectedWorkspaces,
        tunnels: result.tunnels.map(({ name, provider, status, error }) => ({ name, provider, status, ...(error ? { error } : {}) })) }); }
      finally { await client.dispose(); }
    });
}
tunnel.command('setup').description('交互配置frp、SSH或已有外部隧道，并绑定工作区').action(async () => setupTunnel(application()));
tunnel.command('doctor').option('--profile <uuid>', '只检查指定隧道').description('只读检查依赖、凭据和公网专用入口').action(async (options: { profile?: string }) => print(await doctorTunnels(application(), options.profile)));
tunnel.command('setup-ssh').description('交互配置自建服务器SSH反向隧道').action(async () => {
  await setupTunnel(application(), 'ssh');
});
tunnel.command('add').requiredOption('--file <path>', '仅含凭据引用的隧道 JSON')
  .action(async (options: { file: string }) => {
    const raw: unknown = JSON.parse(await readFile(resolve(options.file), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('隧道配置必须是 JSON 对象');
    print(await application().addTunnelProfile({ id: randomUUID(), ...raw }));
  });
tunnel.command('plan').description('显示各隧道允许访问的工作区，不启动隧道')
  .action(async () => print(planTunnels((await application().store.read()).config)));
program.command('migration-inspect').option('--source <directory>', '旧版数据目录')
  .description('仅查看旧配置文件元数据；不解析 Hive、不读取密钥、不执行迁移')
  .action(async (options: { source?: string }) => {
    print(options.source ? await inspectLegacy(resolve(options.source)) : (await application().snapshot()).legacy);
  });

const migration = program.command('migration').description('Codexter 数据迁移、校验与回退');
migration.command('preview').requiredOption('--source <directory>', '旧版数据目录')
  .description('只读解码并预览，不输出凭据')
  .action(async (options: { source: string }) => print(await application().migration.preview(resolve(options.source))));
migration.command('import').requiredOption('--source <directory>', '旧版数据目录')
  .requiredOption('--fingerprint <sha256>', '预览返回的 fingerprint，防止导入期间源数据变化')
  .description('备份并导入已预览的数据；不启动或接管隧道')
  .action(async (options: { source: string; fingerprint: string }) => print(await application().migration.import(resolve(options.source), options.fingerprint)));
migration.command('rollback').argument('<migration-id>', '最近一次迁移的标识')
  .description('恢复迁移前配置；配置被修改时拒绝覆盖')
  .action(async (id: string) => { await application().migration.rollback(id); console.log('迁移前配置已恢复；旧版源文件与加密备份仍保留。'); });

try { await program.parseAsync(); }
catch (error) { console.error(error instanceof Error ? error.message : '执行失败'); process.exitCode = 1; }
