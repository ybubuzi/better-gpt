import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select, TextInput, Spinner } from '@inkjs/ui';
import { planTunnels, formatConfigurationDiagnostics, type ConfigurationComparison } from '@better-gpt/core';
import type { TuiApplication } from './application.js';
import { workspaceEndpoint, tunnelStatusLabels, type AppSnapshot, type ProxyConfig, type MigrationPreview, type MigrationResult } from '@better-gpt/contracts';
import { copyToClipboard, workspaceCopyTarget } from './clipboard.js';
import { TunnelSetup } from './self-hosted-setup.js';
import { WorkspaceBinding } from './workspace-binding.js';
import { TextViewport, wrappedLines } from './view.js';

export type ManagementPage = 'home' | 'workspaces' | 'workspace-detail' | 'workspace-bind' | 'workspace-delete' | 'add-name' | 'add-path' | 'tunnels' | 'tunnel-setup' | 'migration' | 'migration-path' | 'migration-preview' | 'migration-result' | 'proxy' | 'proxy-url' | 'diagnostics';

export function ManagementPanel({ application, initialPage, initialWorkspaceId, onClose, onExit, onChanged, onBusyChange, height, width = 80 }: {
  application: TuiApplication; initialPage: ManagementPage; initialWorkspaceId?: string; onClose(): void; onExit(): void; onChanged(): Promise<void>; onBusyChange(busy: boolean): void; height: number; width?: number;
}) {
  const [state, setState] = useState<AppSnapshot>();
  const [page, setPage] = useState<ManagementPage>(initialPage);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [draftName, setDraftName] = useState('');
  const [preview, setPreview] = useState<MigrationPreview>();
  const [migrationResult, setMigrationResult] = useState<MigrationResult>();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(initialWorkspaceId ?? '');
  const [bindingSetup, setBindingSetup] = useState(false);
  const [diagnosticReport, setDiagnosticReport] = useState<ConfigurationComparison>();
  const [diagnosticOffset, setDiagnosticOffset] = useState(0);
  const [diagnosticReturn, setDiagnosticReturn] = useState<ManagementPage>('home');
  const exiting = useRef(false);
  const operation = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => { setState(await application.snapshot()); await onChanged(); }, [application, onChanged]);
  const perform = useCallback(async (action: () => Promise<void>, critical = true) => {
    if (operation.current || exiting.current) return;
    setBusy(true); onBusyChange(critical); setFailure('');
    operation.current = (async () => {
      try { await action(); await refresh(); }
      catch (error) {
        const message = error instanceof Error ? error.message : '操作失败';
        if (message.includes('工作区不存在')) {
          try { const latest = await application.snapshot(); setState(latest); await onChanged();
            if (!latest.config.workspaces.some((workspace) => workspace.uuid === selectedWorkspaceId)) { setSelectedWorkspaceId(''); setPage('workspaces'); }
          } catch {}
        }
        setFailure(message);
      }
      finally { setBusy(false); onBusyChange(false); }
    })();
    await operation.current;
    operation.current = null;
  }, [refresh, onBusyChange, application, onChanged, selectedWorkspaceId]);
  const openDiagnostics = useCallback((returnPage: ManagementPage) => {
    setDiagnosticReturn(returnPage); setDiagnosticOffset(0);
    void perform(async () => { setDiagnosticReport(await application.diagnoseConfiguration()); setPage('diagnostics'); }, false);
  }, [application, perform]);

  const quit = useCallback(async () => {
    if (exiting.current) return;
    exiting.current = true;
    try { await operation.current; onClose(); }
    catch (error) { exiting.current = false; setFailure(error instanceof Error ? error.message : '停止服务失败'); }
  }, [onClose]);

  useEffect(() => {
    if (initialPage === 'diagnostics') openDiagnostics('home');
    else void refresh().catch((error: unknown) => setFailure(error instanceof Error ? error.message : '读取配置失败'));
  }, [refresh, initialPage, openDiagnostics]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return;
    if (!['add-name', 'add-path', 'proxy-url', 'migration-path', 'tunnel-setup', 'workspace-bind'].includes(page) && input === 'q') { onExit(); return; }
    if (busy) return;
    if (page === 'diagnostics') {
      if (key.escape || input === 'd') { if (initialPage === 'diagnostics') void quit(); else setPage(diagnosticReturn); return; }
      if (input === 'r') { openDiagnostics(diagnosticReturn); return; }
      const delta = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -(height - 4) : key.pageDown ? height - 4 : 0;
      if (delta) setDiagnosticOffset((offset) => Math.min(Math.max(0, wrappedLines(diagnosticReport ? formatConfigurationDiagnostics(diagnosticReport) : '', width - 6).length - (height - 4)), Math.max(0, offset + delta)));
      if (key.home || key.end) setDiagnosticOffset(key.home ? 0 : Math.max(0, wrappedLines(diagnosticReport ? formatConfigurationDiagnostics(diagnosticReport) : '', width - 6).length - (height - 4)));
      return;
    }
    if (key.escape) {
      if (page === 'tunnel-setup' && bindingSetup) setPage('workspace-bind');
      else if (page === initialPage || page === 'home') void quit();
      else if (page === 'workspace-bind' || page === 'workspace-delete') setPage('workspace-detail');
      else setPage(page.startsWith('migration-') ? 'migration' : 'home');
      setFailure('');
    }
  });

  const mainOptions = [
    { label: '工作区 · 查看与新增', value: 'workspaces' },
    { label: '隧道 · 查看绑定与入口', value: 'tunnels' },
    { label: '网络 · 代理配置', value: 'proxy' },
    { label: '迁移 · 导入 Codexter 数据', value: 'migration' },
    { label: application.runtime.serviceOrigin ? '停止 MCP 与公网隧道' : '启动 MCP 与公网隧道', value: 'service' },
    { label: '启动 / 重试已绑定的公网隧道', value: 'retry-tunnels' },
    { label: '刷新状态', value: 'refresh' },
    { label: '加载配置诊断 · 前后台项目名称与绝对路径', value: 'diagnostics' },
    { label: '返回工作台', value: 'quit' },
  ];

  function onHomeAction(value: string) {
    if (value === 'quit') { void quit(); return; }
    if (value === 'refresh') { void perform(async () => { setNotice('状态已刷新'); }); return; }
    if (value === 'diagnostics') { openDiagnostics('home'); return; }
    if (value === 'service' || value === 'retry-tunnels') {
      void perform(async () => {
        if (value === 'service' && application.runtime.serviceOrigin) { await application.stopService(); setNotice('本次启动的服务及隧道已停止'); }
        else {
          const result = await application.controlTunnels({ action: 'start', scope: { kind: 'all' } });
          const failed = result.tunnels.filter((tunnel) => tunnel.status === 'failed');
          if (failed.length) throw new Error(failed.map((tunnel) => `${tunnel.name}：${tunnel.error}`).join('；'));
          setNotice(`本地 MCP 已启动；${result.tunnels.filter((tunnel) => tunnel.status === 'connected').length} 个公网隧道已连接`);
        }
      }, false); return;
    }
    setNotice(''); setPage(value as ManagementPage);
  }

  async function saveProxy(mode: ProxyConfig['mode'], url = '') {
    await application.setProxy({ mode, url });
    setNotice('代理配置已保存，下次启动子进程时生效；cloudflared 边缘连接仍使用其原生网络。');
    setPage('home');
  }

  function previewSource(directory: string) {
    void perform(async () => {
      setNotice('正在读取旧版数据并校验文件；首次使用会准备兼容工具。');
      setPreview(await application.migration.preview(directory));
      setNotice(''); setPage('migration-preview');
    });
  }

  const selectedWorkspace = state?.config.workspaces.find((workspace) => workspace.uuid === selectedWorkspaceId);

  return <Box flexDirection="column" paddingX={1} height={height} overflow="hidden">
    {failure && <Text color="red" wrap="truncate-end">{failure.replaceAll('\n', ' ')}</Text>}
    {notice && <Text color="green" wrap="truncate-end">{notice}</Text>}
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
    {busy && ['tunnel-setup', 'workspace-bind'].includes(page) && <Spinner label="正在保存…" />}
    {busy && !['tunnel-setup', 'workspace-bind'].includes(page) ? <Spinner label="正在处理…" /> : !state ? <Text>正在读取配置；按 q 退出。</Text> : <>
      {page === 'home' && <>
        {state.config.workspaces.length === 0 && <Box marginBottom={1}><Text color="yellow">尚无工作区。已有 Codexter 配置时，请选择“迁移”导入。</Text></Box>}
        <Select options={mainOptions} onChange={onHomeAction} />
      </>}
      {page === 'workspaces' && <>
        <Text bold>工作区</Text>
        {state.config.workspaces.length === 0 && <Text dimColor>还没有工作区。可以新增或迁移旧版项目。</Text>}
        <Box marginTop={1}><Select visibleOptionCount={Math.max(3, Math.min(7, height - 8))} options={[
          ...state.config.workspaces.map((workspace) => ({ label: `${workspace.name}${workspace.enabled ? '' : ' · 已停用'}`, value: `workspace:${workspace.uuid}` })),
          { label: '新增工作区', value: 'add' }, { label: '导入旧版工作区', value: 'migration' }, { label: '返回', value: 'back' },
        ]} onChange={(value) => {
          if (value.startsWith('workspace:')) { setSelectedWorkspaceId(value.slice(10)); setPage('workspace-detail'); }
          else setPage(value === 'add' ? 'add-name' : value === 'migration' ? 'migration' : 'home');
        }} /></Box>
      </>}
      {page === 'workspace-detail' && selectedWorkspace && <>
        <Text bold color="cyan">{selectedWorkspace.name}</Text>
        <Text>{selectedWorkspace.projectRoot}</Text>
        <Text dimColor>UUID：{selectedWorkspace.uuid}</Text>
        <Text>Skills：{selectedWorkspace.selectedSkillNames === null ? '继承全局' : selectedWorkspace.selectedSkillNames.join('、') || '全部禁用'}</Text>
        <Text>MCP：{selectedWorkspace.selectedMcpNames === null ? '继承全局' : selectedWorkspace.selectedMcpNames.join('、') || '全部禁用'}</Text>
        <Text>指令模式：{selectedWorkspace.agentsMode}</Text>
        {(() => { const endpoint = workspaceEndpoint(selectedWorkspace, state.config); return <Text>
          {endpoint.kind === 'https' ? endpoint.url : endpoint.kind === 'openai' ? endpoint.tunnelId : endpoint.path}
        </Text>; })()}
        <Box marginTop={1}><Select visibleOptionCount={Math.max(2, height - 11)} options={[{ label: '绑定 / 更换隧道', value: 'bind' }, { label: '解除隧道绑定', value: 'unbind' }, { label: '启动 / 恢复项目公网入口', value: 'start' }, { label: '暂停项目公网入口', value: 'stop' }, { label: '复制 MCP 地址 / Tunnel ID', value: 'copy' }, { label: '删除项目（仅移除管理记录）', value: 'delete' }, { label: '返回工作区列表', value: 'back' }]} onChange={(value) => {
          if (value === 'back') { setPage('workspaces'); return; }
          if (value === 'bind' || value === 'delete') { setPage(value === 'bind' ? 'workspace-bind' : 'workspace-delete'); return; }
          void perform(async () => {
            if (value === 'unbind') { await application.bindWorkspace(selectedWorkspace.uuid, null); setNotice('已解除绑定，隧道配置保留供其他项目复用。'); return; }
            if (value === 'start' || value === 'stop') { const result = await application.controlTunnels({ action: value, scope: { kind: 'workspace', workspaceId: selectedWorkspace.uuid } }); const failed = value === 'start' ? result.tunnels.find((tunnel) => tunnel.status === 'failed') : undefined; if (failed) throw new Error(failed.error); setNotice(value === 'start' ? '项目公网入口已启动' : '项目公网入口已暂停，共享连接器及本地MCP保留'); return; }
            const target = workspaceCopyTarget(selectedWorkspace, state.config, application.runtime.serviceOrigin);
            await copyToClipboard(target.value); setNotice(`已复制${target.label}：${target.value}`);
          });
        }} /></Box>
      </>}
      {page === 'add-name' && <>
        <Text bold>新增工作区 · 1 / 2</Text><Text>请输入工作区名称：</Text>
        <TextInput placeholder="例如：个人项目" onSubmit={(value) => {
          if (!value.trim()) { setFailure('名称不能为空'); return; }
          setDraftName(value.trim()); setFailure(''); setPage('add-path');
        }} />
      </>}
      {page === 'add-path' && <>
        <Text bold>新增工作区 · 2 / 2</Text><Text>请输入 {draftName} 的绝对目录路径：</Text>
        <TextInput placeholder={process.cwd()} onSubmit={(value) => { void perform(async () => {
          const created = await application.createWorkspace({ name: draftName, projectRoot: value.trim() || process.cwd() });
          setSelectedWorkspaceId(created.config.workspaces.at(-1)!.uuid);
          setPage('workspace-bind'); setNotice('项目已创建，选择要复用的隧道。');
        }); }} />
      </>}
      {page === 'tunnels' && <>
        <Text bold>隧道配置与路由</Text>
        <Select options={[{ label: '新建自建隧道 · frp / SSH / 外部', value: 'setup' }, { label: '返回', value: 'back' }]} onChange={(value) => setPage(value === 'setup' ? 'tunnel-setup' : 'home')} />
        <Text dimColor>显示本次程序的连接器状态；启动失败的具体原因可在工作台隧道模块查看。</Text>
        {state.config.tunnelProfiles.length === 0 && <Text>尚无隧道配置。</Text>}
        {state.config.tunnelProfiles.map((profile) => <Box flexDirection="column" key={profile.id} marginY={1}>
          <Text color="cyan">{profile.name} · {profile.provider} · {profile.enabled ? tunnelStatusLabels[application.runtime.tunnels.get(profile.id)?.status ?? 'stopped'] : '已停用'}</Text>
          <Text dimColor>{profile.id}</Text>
          {planTunnels(state.config).find((plan) => plan.profile.id === profile.id)?.workspaces.map((workspace) =>
            <Text key={workspace.uuid}>{workspace.endpoint.kind === 'https' ? workspace.endpoint.url
              : workspace.endpoint.kind === 'openai' ? workspace.endpoint.tunnelId : workspace.endpoint.path}</Text>)}
        </Box>)}
        <Box marginTop={1} flexDirection="column">
          <Text>配置入口：better-gpt tunnel add --file &lt;配置.json&gt;</Text>
          <Text>工作区绑定：better-gpt workspace bind --help</Text>
          <Text dimColor>Cloudflare / frp / SSH 已接入；OpenAI 运行器待完成。</Text>
          <Text dimColor>自建向导：CLI tunnel setup；入口检查：tunnel doctor。</Text>
        </Box>
      </>}
      {page === 'workspace-bind' && selectedWorkspace && <WorkspaceBinding disabled={busy} workspace={selectedWorkspace} config={state.config} height={height - 2} onCancel={() => { setPage('workspace-detail'); setNotice(''); }} onNew={() => { setBindingSetup(true); setPage('tunnel-setup'); setNotice(''); }} onDiagnostics={() => openDiagnostics('workspace-bind')}
        onBind={(profile) => { void perform(async () => { const result = await application.bindWorkspace(selectedWorkspace.uuid, { profileId: profile.id }, { selection: selectedWorkspace }); setPage('workspace-detail'); setNotice(result.warning ?? `已绑定 ${profile.name}；后续项目可直接复用。`); }); }}
        onConfigure={(raw) => { void perform(async () => { const profile = await application.configureProviderTunnel(raw); const result = await application.bindWorkspace(selectedWorkspace.uuid, { profileId: profile.id }, { selection: selectedWorkspace }); setPage('workspace-detail'); setNotice(result.warning ?? '首次配置已保存并绑定，后续项目直接复用。'); }); }}
        onSharedId={(profile, id) => { void perform(async () => { await application.setSharedOpenAiTunnelId(profile.id, id); const result = await application.bindWorkspace(selectedWorkspace.uuid, { profileId: profile.id }, { selection: selectedWorkspace }); setPage('workspace-detail'); setNotice(result.warning ?? '共享Tunnel ID已保存，所有绑定项目共用。'); }); }} />}
      {page === 'diagnostics' && <TextViewport lines={wrappedLines(diagnosticReport ? formatConfigurationDiagnostics(diagnosticReport) : '正在读取前后台配置…', width - 6)} height={Math.max(6, height - 2)} offset={diagnosticOffset} focus title="加载诊断 · r刷新 · Esc返回" />}
      {page === 'workspace-delete' && selectedWorkspace && <>
        <Text bold color="red">删除项目：{selectedWorkspace.name}？</Text><Text wrap="truncate-end">{selectedWorkspace.projectRoot}</Text>
        <Text>仅移除管理记录，项目文件和共享隧道配置保留。</Text>
        <Text>该项目的 {application.processes.runningCount(selectedWorkspace.uuid)} 个运行进程将停止。</Text>
        <Select options={[{ label: '取消', value: 'cancel' }, { label: '确认移除项目', value: 'delete' }]} onChange={(value) => {
          if (value === 'cancel') { setPage('workspace-detail'); return; }
          void perform(async () => { await application.removeWorkspace(selectedWorkspace.uuid); setSelectedWorkspaceId(''); setPage('workspaces'); setNotice('项目已移除，磁盘文件保留。'); });
        }} />
      </>}
      {page === 'tunnel-setup' && <TunnelSetup config={state.config} dataDirectory={state.dataDirectory} discover={(options) => application.discoverSshConnections(options)} saving={busy} height={height - 2} {...(bindingSetup ? { workspaceId: selectedWorkspaceId } : {})} onCancel={() => setPage(bindingSetup ? 'workspace-bind' : 'tunnels')}
        onReuse={(profileId, ids) => { void perform(async () => { for (const id of ids) await application.bindWorkspace(id, { profileId }); setPage(bindingSetup ? 'workspace-detail' : 'tunnels'); setBindingSetup(false); setNotice('已复用既有隧道配置。'); }); }}
        onSave={(raw, ids, token) => { void perform(async () => {
        await application.configureSelfHostedTunnel(raw, ids, token); setPage(bindingSetup ? 'workspace-detail' : 'tunnels'); setBindingSetup(false); setNotice('隧道已保存并绑定，后续项目可直接复用。');
      }); }} />}
      {page === 'migration' && <>
        <Text bold>导入 Codexter 数据</Text>
        <Text dimColor>选择旧配置目录，先预览，再确认导入。原数据保持不变。</Text>
        <Box marginTop={1}><Select visibleOptionCount={Math.max(3, Math.min(6, height - 8))} options={[
          ...state.legacy.filter((legacy) => legacy.files.some((file) => file.name === 'global_config.hive')).map((legacy) => ({
            label: legacy.directory, value: `source:${legacy.directory}`,
          })),
          { label: '选择其他目录', value: 'custom' }, { label: '重新检测', value: 'refresh' }, { label: '返回主菜单', value: 'back' },
        ]} onChange={(value) => {
          if (value.startsWith('source:')) previewSource(value.slice(7));
          else if (value === 'custom') setPage('migration-path');
          else if (value === 'refresh') void perform(async () => { setNotice('来源列表已刷新'); });
          else setPage('home');
        }} /></Box>
      </>}
      {page === 'migration-path' && <>
        <Text>请输入包含 global_config.hive 的旧配置目录：</Text>
        <TextInput placeholder="Codexter 数据目录的绝对路径" onSubmit={(value) => previewSource(value.trim())} />
      </>}
      {page === 'migration-preview' && preview && <>
        <Text bold>迁移预览{preview.alreadyImported ? ' · 已导入' : ''}</Text>
        <Text dimColor>{preview.sourceDirectory}</Text>
        <Text>工作区 {preview.counts.workspaces} · Skills {preview.counts.skills} · MCP {preview.counts.mcps} · 文件 {preview.counts.files}</Text>
        <Text>原隧道：{preview.provider}；保留 UUID、能力选择和连接参数。</Text>
        <Text dimColor>{preview.workspaceNames.slice(0, 3).join('、')}{preview.workspaceNames.length > 3 ? '…' : ''}</Text>
        {preview.warnings.slice(0, 3).map((warning) => <Text key={warning} color="yellow">{warning}</Text>)}
        <Text dimColor>凭据加密保存；导入不会启动或接管旧隧道。</Text>
        <Box marginTop={1}><Select options={[
          preview.alreadyImported ? { label: '查看已导入工作区', value: 'view' } : { label: '确认备份并导入', value: 'import' },
          { label: '刷新预览', value: 'refresh' }, { label: '返回选择来源', value: 'back' },
        ]} onChange={(value) => {
          if (value === 'view') setPage('workspaces');
          else if (value === 'refresh') previewSource(preview.sourceDirectory);
          else if (value === 'back') setPage('migration');
          else void perform(async () => {
            setNotice('正在备份、导入并校验数据…');
            setMigrationResult(await application.migration.import(preview.sourceDirectory, preview.fingerprint));
            setNotice(''); setPage('migration-result');
          });
        }} /></Box>
      </>}
      {page === 'migration-result' && migrationResult && <>
        <Text bold color="green">{migrationResult.status === 'already-imported' ? '数据已导入，无需重复创建' : '数据导入完成'}</Text>
        <Text>工作区 {migrationResult.counts.workspaces} · Skills {migrationResult.counts.skills} · MCP {migrationResult.counts.mcps}</Text>
        <Text dimColor>旧版数据保持不变，加密备份已保存。公网隧道没有切换。</Text>
        {migrationResult.warnings.slice(0, 2).map((warning) => <Text color="yellow" key={warning}>{warning}</Text>)}
        <Box marginTop={1}><Select options={[
          { label: '查看工作区', value: 'view' }, { label: '返回主菜单', value: 'back' }, { label: '回退本次导入', value: 'rollback' },
        ]} onChange={(value) => {
          if (value === 'view') setPage('workspaces');
          else if (value === 'back') setPage('home');
          else void perform(async () => {
            await application.migration.rollback(migrationResult.migrationId);
            setNotice('迁移前配置已恢复，备份继续保留。'); setPage('migration');
          });
        }} /></Box>
      </>}
      {page === 'proxy' && <>
        <Text bold>网络代理</Text><Text dimColor>当前模式：{state.config.proxy.mode}</Text>
        <Select options={[
          { label: '继承进程环境变量', value: 'environment' },
          { label: '直连', value: 'direct' },
          { label: '自定义 HTTP / HTTPS / SOCKS 代理', value: 'custom' },
          { label: '返回', value: 'back' },
        ]} onChange={(value) => {
          if (value === 'back') setPage('home');
          else if (value === 'custom') setPage('proxy-url');
          else void perform(() => saveProxy(value as ProxyConfig['mode']));
        }} />
      </>}
      {page === 'proxy-url' && <>
        <Text>代理地址（不含账号密码）：</Text>
        <TextInput placeholder="http://127.0.0.1:7890" onSubmit={(value) => { void perform(() => saveProxy('custom', value.trim())); }} />
      </>}
    </>}
    </Box>
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor wrap="truncate-end">↑↓ 选择 · Enter 确认 · Esc 返回 · q 关闭面板</Text>
    </Box>
  </Box>;
}
