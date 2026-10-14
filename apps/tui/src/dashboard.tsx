import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { Select, TextInput } from '@inkjs/ui';
import type { TuiApplication } from './application.js';
import type { AppSnapshot, ManagedProcessView, TunnelControl } from '@better-gpt/contracts';
import { tunnelStatusLabels } from '@better-gpt/contracts';
import { ManagementPanel, type ManagementPage } from './management.js';
import { copyToClipboard, workspaceCopyTarget } from './clipboard.js';
import { bounded, clock, colors, elapsed, Empty, oneLine, TextViewport, windowStart, wrappedLines } from './view.js';
import { workspaceTunnel } from './tunnel-state.js';

type Module = 'workspace' | 'skills' | 'mcps' | 'tunnels' | 'migration' | 'settings';
type Focus = 'sidebar' | 'list' | 'detail';
type DetailSelection = { kind: 'log'; id: string } | { kind: 'process'; id: number } | { kind: 'catalog'; id: string };
const moduleNames: Record<Module, string> = { workspace: '工作区', skills: 'Skills', mcps: 'MCP', tunnels: '隧道', migration: '迁移', settings: '设置' };
const modules = Object.entries(moduleNames).map(([value, label]) => ({ value, label }));

export function Dashboard({ application }: { application: TuiApplication }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const width = columns || 80;
  const height = Math.max(8, (rows || 24) - 1);
  const showSidebar = width >= 72;
  const sidebarWidth = showSidebar ? (width >= 110 ? 30 : 26) : 0;
  const rightWidth = width - sidebarWidth;
  const bodyHeight = height - 3;
  const contentHeight = Math.max(6, bodyHeight - 5);
  const listHeight = contentHeight;
  const detailHeight = contentHeight;
  const listVisible = Math.max(1, contentHeight - 2);
  const workspaceRows = bodyHeight >= 28 ? 2 : 1;
  const sidebarVisible = Math.max(1, Math.floor((bodyHeight - 8) / workspaceRows));
  const version = useSyncExternalStore(application.runtime.subscribe, application.runtime.getVersion);
  const [state, setState] = useState<AppSnapshot>();
  const [selectedId, setSelectedId] = useState('');
  const [sidebarIndex, setSidebarIndex] = useState(0);
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [editingWorkspaceFilter, setEditingWorkspaceFilter] = useState(false);
  const [focus, setFocus] = useState<Focus>('sidebar');
  const [detailSelection, setDetailSelection] = useState<DetailSelection | null>(null);
  const [module, setModule] = useState<Module>('workspace');
  const [tab, setTab] = useState<'logs' | 'terminal'>('logs');
  const [logIndex, setLogIndex] = useState(0);
  const [processIndex, setProcessIndex] = useState(0);
  const [catalogIndex, setCatalogIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [followCalls, setFollowCalls] = useState(true);
  const [followOutput, setFollowOutput] = useState(true);
  const [filter, setFilter] = useState('');
  const [editingFilter, setEditingFilter] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [menu, setMenu] = useState(false);
  const [tunnelMenu, setTunnelMenu] = useState<'workspace' | 'channels' | null>(null);
  const [help, setHelp] = useState(false);
  const [management, setManagement] = useState<ManagementPage | null>(null);
  const [managementWorkspaceId, setManagementWorkspaceId] = useState('');
  const [confirmStop, setConfirmStop] = useState<ManagedProcessView | null>(null);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pending = useRef<Promise<void> | null>(null);
  const quitting = useRef(false);
  const panelBusy = useRef(false);
  const exitAfterPanel = useRef(false);
  const knownWorkspaceIds = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    const snapshot = await application.snapshot();
    setState(snapshot);
    const added = knownWorkspaceIds.current ? snapshot.config.workspaces.filter((workspace) => !knownWorkspaceIds.current!.has(workspace.uuid)).at(-1) : undefined;
    const removed = knownWorkspaceIds.current ? [...knownWorkspaceIds.current].some((id) => !snapshot.config.workspaces.some((workspace) => workspace.uuid === id)) : false;
    knownWorkspaceIds.current = new Set(snapshot.config.workspaces.map((workspace) => workspace.uuid));
    if (added) { setSelectedId(added.uuid); setSidebarIndex(snapshot.config.workspaces.indexOf(added)); setWorkspaceFilter(''); }
    else setSelectedId((id) => snapshot.config.workspaces.some((workspace) => workspace.uuid === id) ? id : snapshot.config.workspaces[0]?.uuid ?? '');
    if (removed) { setWorkspaceFilter(''); setSidebarIndex(0); }
  }, [application]);
  const run = useCallback((action: () => Promise<void>) => {
    if (pending.current || quitting.current) return;
    setBusy(true); setFailure('');
    pending.current = (async () => {
      try { await action(); }
      catch (error) { setFailure(application.runtime.redact(error instanceof Error ? error.message : '操作失败')); }
      finally { setBusy(false); pending.current = null; }
    })();
  }, [application]);
  const quit = useCallback(async () => {
    if (quitting.current) return;
    if (panelBusy.current) { exitAfterPanel.current = true; setNotice('正在完成配置写入，随后退出…'); return; }
    quitting.current = true; setExiting(true);
    try { await application.dispose(); exit(); }
    catch (error) { quitting.current = false; setExiting(false); setFailure(error instanceof Error ? error.message : '退出失败，可按 q 重试'); }
  }, [application, exit]);
  const onPanelBusy = useCallback((value: boolean) => {
    panelBusy.current = value;
    if (!value && exitAfterPanel.current) void quit();
  }, [quit]);
  const closePanel = useCallback(() => { setDetailSelection(null); setManagement(null); setModule('workspace'); void refresh(); }, [refresh]);
  useEffect(() => {
    void refresh().catch((error: unknown) => setFailure(error instanceof Error ? error.message : '读取失败'));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const signal = () => { void quit(); };
    process.on('SIGTERM', signal);
    return () => { clearInterval(timer); process.off('SIGTERM', signal); };
  }, [refresh, quit]);

  const workspaces = state?.config.workspaces ?? [];
  const sidebarWorkspaces = workspaces.filter((workspace) => `${workspace.name} ${workspace.projectRoot}`.toLowerCase().includes(workspaceFilter.toLowerCase()));
  useEffect(() => { application.selectWorkspace?.(selectedId); }, [application, selectedId]);
  useEffect(() => { application.selectDetail?.(detailSelection?.kind ?? '', detailSelection?.id); }, [application, detailSelection?.kind, detailSelection?.id]);
  const selected = workspaces.find((workspace) => workspace.uuid === selectedId);
  const allLogs = useMemo(() => application.runtime.logs(selectedId), [application, selectedId, version]);
  const logs = useMemo(() => [...allLogs].reverse().filter((entry) => (!errorsOnly || entry.status === 'error')
    && `${entry.name} ${entry.purpose} ${entry.command} ${entry.args} ${entry.result}`.toLowerCase().includes(filter.toLowerCase())), [allLogs, errorsOnly, filter]);
  const processes = useMemo(() => application.processes.list(selectedId), [application, selectedId, version]);
  const log = detailSelection?.kind === 'log' ? allLogs.find((entry) => entry.id === detailSelection.id) : logs[bounded(logIndex, logs.length)];
  const selectedProcess = detailSelection?.kind === 'process' ? processes.find((entry) => entry.id === detailSelection.id) : processes[bounded(processIndex, processes.length)];
  const running = processes.filter((entry) => entry.running).length;
  const calls = allLogs.filter((entry) => entry.name !== 'stop_process').length;
  const errors = allLogs.filter((entry) => entry.status === 'error').length;
  useEffect(() => { if (followCalls) setLogIndex(0); }, [logs[0]?.id, followCalls]);
  useEffect(() => { setOffset(0); setFollowOutput(true); }, [selectedId, tab, detailSelection?.kind, detailSelection?.id, module]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    const summary = application.runtime.summary;
    if (summary?.workspaceId === selectedId && Date.now() - Date.parse(summary.endedAt) < 10000) setNotice(`${summary.title}：${summary.text}`);
  }, [application, application.runtime.summary?.endedAt, selectedId]);

  const catalog = useMemo(() => {
    const config = state?.config;
    if (!config) return [];
    if (module === 'skills') return config.skills.map((skill) => ({ id: skill.name, title: skill.name,
      subtitle: skill.enabled ? '已加载' : '已停用', detail: `${skill.description || '(无描述)'}\n\n目录：${skill.rootPath ?? '(目录缺失)'}\n来源：${skill.source}` }));
    if (module === 'mcps') return config.downstreamMcps.map((mcp) => {
      const runtime = application.runtime.mcps.find((entry) => entry.name === mcp.name);
      return { id: mcp.name, title: mcp.name, subtitle: mcp.enabled ? runtime ? `${runtime.state} · ${runtime.toolCount} 个工具` : '已启用 · 等待首次发现' : '已停用',
        detail: `来源：${mcp.source}\n状态：${runtime?.state ?? '等待mcp_tools首次发现'}\n启动超时：${mcp.startupTimeoutMs ?? '默认'}\n调用超时：${mcp.toolTimeoutMs ?? '默认'}\n${runtime?.error ? `\n错误：${runtime.error}` : ''}\n连接参数已安全保存。` };
    });
    if (module === 'tunnels') return config.tunnelProfiles.map((profile) => {
      const runtime = application.runtime.tunnels.get(profile.id);
      const status = runtime ? tunnelStatusLabels[runtime.status] : profile.enabled ? '未启动' : '已停用';
      return { id: profile.id, title: profile.name, subtitle: `${profile.provider} · ${status}`,
        detail: `提供方：${profile.provider}\n状态：${status}\n${'publicBaseUrl' in profile ? `域名：${profile.publicBaseUrl}` : '接入方式：OpenAI Tunnel ID'}\n${runtime?.origin ? `转发入口：${runtime.origin}\n` : ''}${runtime?.error ? `\n原因：${runtime.error}\n` : ''}\n绑定工作区：\n${config.workspaces.filter((workspace) => workspace.tunnelBinding?.profileId === profile.id).map((workspace) => `  ${workspace.name}`).join('\n') || '  (无)'}\n\nt 启动 / 重试隧道 · s 停止全部服务\n\n连接器日志：\n${runtime?.output || '(尚无日志)'}` };
    });
    return [];
  }, [state, module, version, application]);
  const catalogItem = detailSelection?.kind === 'catalog' ? catalog.find((entry) => entry.id === detailSelection.id) : catalog[bounded(catalogIndex, catalog.length)];
  const detailText = module !== 'workspace' ? catalogItem?.detail ?? '' : tab === 'terminal'
    ? selectedProcess ? `命令：${selectedProcess.command}\n目录：${selectedProcess.cwd}\nPID：${selectedProcess.pid ?? '-'}  ${selectedProcess.running ? '运行中' : selectedProcess.terminationRequested ? '已手动结束' : `退出码 ${selectedProcess.exitCode}`}\n\n${selectedProcess.output || '(等待输出…)'}${selectedProcess.outputTruncated ? '\n[较早输出已截断]' : ''}` : ''
    : log ? `工具：${log.name}\n状态：${log.status === 'error' ? '失败' : log.status === 'pending' ? '执行中' : '成功'}  时间：${clock(log.startedAt)}  耗时：${elapsed(log.startedAt, log.endedAt ?? now)}\n用途：${log.purpose}\n${log.command ? `命令：${log.command}\n` : ''}\n参数：\n${log.args}\n\n${log.status === 'pending' ? '等待调用完成…' : `结果：\n${log.result}`}` : '(该记录已离开内存缓存，按 Esc 返回列表)';
  const detailLines = useMemo(() => wrappedLines(detailText, rightWidth - 2), [detailText, rightWidth]);
  const maxOffset = Math.max(0, detailLines.length - (detailHeight - 2));
  const actualOffset = tab === 'terminal' && module === 'workspace' && followOutput ? maxOffset : Math.min(offset, maxOffset);
  const sidebarStart = windowStart(bounded(sidebarIndex, sidebarWorkspaces.length), sidebarWorkspaces.length, sidebarVisible);
  const focusedWorkspace = focus === 'sidebar' ? sidebarWorkspaces[bounded(sidebarIndex, sidebarWorkspaces.length)] : selected;

  const controlTunnels = (input: TunnelControl) => {
    setTunnelMenu(null);
    run(async () => {
      const result = await application.controlTunnels(input); await refresh();
      const failures = input.action === 'start' ? result.tunnels.filter((entry) => entry.status === 'failed') : [];
      if (failures.length) throw new Error(failures.map((entry) => `${entry.name}：${entry.error}`).join('；'));
      setNotice(`${input.action === 'start' ? '已启动 / 恢复' : '已暂停'} ${result.affectedWorkspaces} 个工作区公网入口；本地 MCP 保持运行`);
    });
  };

  const closeDetail = () => {
    if (detailSelection?.kind === 'log') { const index = logs.findIndex((entry) => entry.id === detailSelection.id); if (index >= 0) setLogIndex(index); }
    if (detailSelection?.kind === 'process') { const index = processes.findIndex((entry) => entry.id === detailSelection.id); if (index >= 0) setProcessIndex(index); }
    if (detailSelection?.kind === 'catalog') { const index = catalog.findIndex((entry) => entry.id === detailSelection.id); if (index >= 0) setCatalogIndex(index); }
    setDetailSelection(null); setFocus('list'); setOffset(0);
  };

  const chooseModule = (value: string) => {
    const next = value as Module;
    setDetailSelection(null);
    setMenu(false); setModule(next); setCatalogIndex(0); setOffset(0); setNotice(''); setFailure('');
    if (next === 'migration') setManagement('migration');
    else if (next === 'settings') setManagement('home');
    else { setManagement(null); setFocus(next === 'workspace' ? 'sidebar' : 'list'); }
  };
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { void quit(); return; }
    if (management) return;
    if (menu || confirmStop || tunnelMenu) { if (input === 'q') void quit(); if (key.escape) { setMenu(false); setConfirmStop(null); setTunnelMenu(null); } return; }
    if (help) { if (input === 'q') void quit(); if (key.escape || input === '?' || key.return) setHelp(false); return; }
    if (editingFilter) { if (key.escape) setEditingFilter(false); return; }
    if (editingWorkspaceFilter) { if (key.escape) { setEditingWorkspaceFilter(false); setWorkspaceFilter(''); setSidebarIndex(0); } return; }
    if (input === 'q') { void quit(); return; }
    if (input === '?') { setHelp(true); return; }
    if (input === 'm') { setMenu(true); return; }
    if (input === 'd') { setManagement('diagnostics'); return; }
    if (input === 'p') { setTunnelMenu('workspace'); return; }
    if (input === 'u') { setTunnelMenu('channels'); return; }
    if (input === 'n') { setManagement(module === 'tunnels' ? 'tunnel-setup' : 'add-name'); return; }
    if (input === 'c') {
      run(async () => {
        const workspace = focusedWorkspace;
        if (!workspace || !state) throw new Error('请先选择工作区');
        const target = workspaceCopyTarget(workspace, state.config, application.runtime.serviceOrigin);
        await copyToClipboard(target.value);
        setNotice(`已复制 ${workspace.name} 的${target.label}：${target.value}`);
      }); return;
    }
    if (input === 'r') { run(async () => { await refresh(); setNotice('配置已刷新'); }); return; }
    if (input === 't') {
      controlTunnels({ action: 'start', scope: { kind: 'all' } }); return;
    }
    if (input === 's') {
      run(async () => {
        if (application.runtime.serviceOrigin) { await application.stopService(); setNotice('本地服务、隧道和受管进程已停止'); }
        else {
          const result = await application.controlTunnels({ action: 'start', scope: { kind: 'all' } });
          await refresh();
          const failures = result.tunnels.filter((entry) => entry.status === 'failed');
          if (failures.length) { setDetailSelection(null); setFailure('本地 MCP 已启动，但公网隧道失败；Enter 查看详情'); setModule('tunnels'); setFocus('list'); }
          else setNotice(`服务已启动；隧道 ${result.tunnels.filter((entry) => entry.status === 'connected').length} 个已连接`);
        }
      }); return;
    }
    if (input === '1' || input === '2') { setDetailSelection(null); setModule('workspace'); setTab(input === '1' ? 'logs' : 'terminal'); setFocus('list'); return; }
    if (detailSelection && (key.escape || key.return || key.leftArrow)) { closeDetail(); return; }
    if (key.tab) {
      if (detailSelection) { closeDetail(); return; }
      setFocus(focus === 'sidebar' ? 'list' : 'sidebar'); return;
    }
    if (key.escape) { setFocus('sidebar'); return; }
    if (input === '/' && focus !== 'sidebar' && module === 'workspace' && tab === 'logs') { setDetailSelection(null); setEditingFilter(true); setFocus('list'); return; }
    if (input === 'e' && module === 'workspace' && tab === 'logs') { setDetailSelection(null); setErrorsOnly((value) => !value); setLogIndex(0); setFocus('list'); return; }
    if (input === 'f') { setFollowCalls(true); setLogIndex(0); setFollowOutput(true); return; }
    if (input === 'x' && module === 'workspace' && tab === 'terminal' && selectedProcess?.running) { setConfirmStop(selectedProcess); return; }
    if (focus === 'sidebar') {
      if (input === '/') { setEditingWorkspaceFilter(true); return; }
      const delta = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -sidebarVisible : key.pageDown ? sidebarVisible : 0;
      if (delta) setSidebarIndex((index) => bounded(index + delta, sidebarWorkspaces.length));
      if (key.home || key.end) setSidebarIndex(key.home ? 0 : Math.max(0, sidebarWorkspaces.length - 1));
      if (key.return || key.rightArrow) {
        const workspace = sidebarWorkspaces[bounded(sidebarIndex, sidebarWorkspaces.length)];
        if (workspace) { setDetailSelection(null); setSelectedId(workspace.uuid); setModule('workspace'); setLogIndex(0); setProcessIndex(0); setFocus('list'); }
      }
      return;
    }
    if (focus === 'list') {
      const delta = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -listVisible : key.pageDown ? listVisible : 0;
      if (delta) {
        if (module !== 'workspace') setCatalogIndex((index) => bounded(index + delta, catalog.length));
        else if (tab === 'logs') { setFollowCalls(false); setLogIndex((index) => bounded(index + delta, logs.length)); }
        else setProcessIndex((index) => bounded(index + delta, processes.length));
      }
      if (key.home || key.end) {
        if (module !== 'workspace') setCatalogIndex(key.home ? 0 : Math.max(0, catalog.length - 1));
        else if (tab === 'logs') { setFollowCalls(false); setLogIndex(key.home ? 0 : Math.max(0, logs.length - 1)); }
        else setProcessIndex(key.home ? 0 : Math.max(0, processes.length - 1));
      }
      if (key.return || key.rightArrow) {
        const selection: DetailSelection | null = module !== 'workspace' ? catalogItem ? { kind: 'catalog', id: catalogItem.id } : null
          : tab === 'logs' ? log ? { kind: 'log', id: log.id } : null : selectedProcess ? { kind: 'process', id: selectedProcess.id } : null;
        if (selection) { setDetailSelection(selection); setFollowCalls(false); setOffset(0); setFollowOutput(true); setFocus('detail'); }
      }
      if (key.leftArrow) setFocus('sidebar');
      return;
    }
    if (key.leftArrow || key.return) { setFocus('list'); return; }
    const delta = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -(detailHeight - 2) : key.pageDown ? detailHeight - 2 : 0;
    if (delta || key.home || key.end) {
      setFollowOutput(false);
      setOffset(key.home ? 0 : key.end ? maxOffset : Math.max(0, Math.min(maxOffset, actualOffset + delta)));
      if (key.end && tab === 'terminal') setFollowOutput(true);
    }
  });

  if (width < 60 || height < 17) return <Box flexDirection="column" height={height} overflow="hidden">
    <Text color={colors.accent}>better-gpt</Text><Text>请将终端调整到至少 60 列 × 18 行。</Text><Text dimColor>当前 {width} × {height + 1} · q 退出</Text>
  </Box>;

  const selectedLogIndex = bounded(logIndex, logs.length);
  const selectedProcessIndex = bounded(processIndex, processes.length);
  const selectedCatalogIndex = bounded(catalogIndex, catalog.length);
  const viewIndex = module !== 'workspace' ? selectedCatalogIndex : tab === 'logs' ? selectedLogIndex : selectedProcessIndex;
  const viewCount = module !== 'workspace' ? catalog.length : tab === 'logs' ? logs.length : processes.length;
  const viewStart = windowStart(viewIndex, viewCount, listVisible);
  const selectedTunnel = selected && state ? workspaceTunnel(selected, state.config, application.runtime.tunnels, !!application.runtime.serviceOrigin) : undefined;
  const boundProfiles = state?.config.tunnelProfiles.filter((profile) => profile.enabled && workspaces.some((workspace) => workspace.enabled && workspace.tunnelBinding?.profileId === profile.id)) ?? [];
  const connectedTunnels = application.runtime.serviceOrigin ? boundProfiles.filter((profile) => application.runtime.tunnels.get(profile.id)?.status === 'connected').length : 0;
  const failedTunnels = boundProfiles.filter((profile) => application.runtime.tunnels.get(profile.id)?.status === 'failed').length;
  const status = !state ? '加载中' : !selected ? '未选择' : !selected.enabled ? '已停用' : !application.runtime.serviceOrigin ? '未监听' : running ? '执行中' : '等待调用';
  const hasOverlay = menu || management || confirmStop || help || tunnelMenu;

  return <Box flexDirection="column" width={width} height={height} backgroundColor={colors.background} overflow="hidden">
    <Box height={2} flexShrink={0} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderColor={colors.border} paddingX={1} justifyContent="space-between">
      <Text color={colors.accent} bold>◆ better-gpt <Text color={colors.muted}>/ {moduleNames[module]}</Text></Text>
      <Text color={colors.muted}>d 诊断  m 模块  ? 帮助  {clock(now)}</Text>
    </Box>
    <Box height={bodyHeight} flexShrink={0}>
      {showSidebar && <Box width={sidebarWidth} flexShrink={0} flexDirection="column" borderStyle="single" borderTop={false} borderLeft={false} borderBottom={false}
        borderColor={focus === 'sidebar' && !hasOverlay ? colors.accent : colors.border} backgroundColor={colors.sidebar}>
        <Box height={2} paddingX={1} flexDirection="column"><Text color={colors.muted}>工作区 <Text color={colors.foreground}>{workspaces.length}</Text>  <Text dimColor>n新建 p项目</Text></Text>
          {editingWorkspaceFilter ? <TextInput placeholder="搜索工作区…" defaultValue={workspaceFilter} onChange={(value) => { setWorkspaceFilter(value); setSidebarIndex(0); }} onSubmit={() => setEditingWorkspaceFilter(false)} /> : <Text dimColor wrap="truncate-end">{workspaceFilter ? `筛选：${workspaceFilter} · /修改` : '↑↓选择  /搜索  Home/End'}</Text>}
        </Box>
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {sidebarWorkspaces.slice(sidebarStart, sidebarStart + sidebarVisible).map((workspace, index) => {
            const cursor = sidebarStart + index === bounded(sidebarIndex, sidebarWorkspaces.length);
            const active = selectedId === workspace.uuid;
            const tunnel = workspaceTunnel(workspace, state!.config, application.runtime.tunnels, !!application.runtime.serviceOrigin);
            return <Box key={workspace.uuid} height={workspaceRows} flexShrink={0} flexDirection="column" paddingX={1} backgroundColor={cursor && focus === 'sidebar' ? colors.active : active ? '#252a33' : colors.sidebar}>
              <Box justifyContent="space-between"><Box flexShrink={1} overflow="hidden"><Text color={active ? colors.foreground : colors.muted} bold={active} wrap="truncate-end">{cursor && focus === 'sidebar' ? '›' : active ? '▎' : ' '} {oneLine(workspace.name)}</Text></Box>
                {workspaceRows === 1 && <Box flexShrink={0} paddingLeft={1}><Text color={tunnel.color}>{tunnel.short} {tunnel.symbol}</Text></Box>}
              </Box>
              {workspaceRows === 2 && <Text color={tunnel.color} wrap="truncate-end">  {tunnel.symbol} {tunnel.channel} · {tunnel.label}</Text>}
            </Box>;
          })}
          {sidebarWorkspaces.length === 0 && <Text color={colors.muted}>{workspaces.length ? '  没有匹配工作区' : '  暂无工作区'}</Text>}
        </Box>
        <Box height={1} flexShrink={0} paddingX={1}><Text dimColor wrap="truncate-end">{sidebarWorkspaces.length ? `${sidebarStart + 1}–${Math.min(sidebarStart + sidebarVisible, sidebarWorkspaces.length)} / ${sidebarWorkspaces.length}` : '0 / 0'}　PgUp/PgDn</Text></Box>
        <Box height={5} flexShrink={0} flexDirection="column" paddingX={1} borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderColor={colors.border}>
          <Text color={application.runtime.serviceOrigin ? colors.success : colors.muted} wrap="truncate-end">● {application.background ? '后台 MCP' : '本地服务'} {application.runtime.serviceOrigin ? '运行中' : '未启动'}</Text>
          <Text color={colors.muted} wrap="truncate-end">{application.runtime.serviceOrigin.replace('http://', '') || 's 启动 / 停止'}</Text>
          <Text color={failedTunnels ? colors.danger : connectedTunnels ? colors.success : colors.muted} wrap="truncate-end">◇ 公网 {connectedTunnels}/{boundProfiles.length} 已连接{failedTunnels ? ` ${failedTunnels}异常` : ''}</Text>
          <Text color={colors.muted} wrap="truncate-end">u渠道  t全部启动</Text>
        </Box>
      </Box>}
      <Box width={rightWidth} flexDirection="column" backgroundColor={colors.panel} overflow="hidden">
        <Box height={5} flexShrink={0} paddingX={1} flexDirection="column" borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderColor={colors.border}>
          <Box justifyContent="space-between" height={1}>
            <Box flexShrink={1} overflow="hidden"><Text color={colors.foreground} bold wrap="truncate-end">{module === 'workspace' ? oneLine(selected?.name ?? '工作区') : moduleNames[module]} <Text color={module === 'workspace' && application.runtime.serviceOrigin && selected?.enabled ? colors.success : colors.muted}>● {module === 'workspace' ? status : '管理'}</Text></Text></Box>
            {module === 'workspace' && <Box flexShrink={0} paddingLeft={1}><Text color={colors.accent}>[c 复制 MCP]</Text></Box>}
          </Box>
          <Text color={module === 'workspace' && selectedTunnel ? selectedTunnel.color : colors.muted} wrap="truncate-end">{module === 'workspace' ? `${selectedTunnel ? `${selectedTunnel.symbol} ${selectedTunnel.channel} · ${selectedTunnel.label}  ` : ''}${oneLine(selected?.projectRoot ?? 'n 新建工作区 · m 进入迁移')}` : '工作区 / Skills / MCP / 隧道 / 迁移 / 设置'}</Text>
          <Text color={colors.muted} wrap="truncate-end"><Text color={tab === 'logs' && module === 'workspace' ? colors.accent : colors.muted}>[1 实时日志]</Text>  <Text color={tab === 'terminal' && module === 'workspace' ? colors.accent : colors.muted}>[2 运行终端]</Text>  {module === 'workspace' && tab === 'logs' ? `[e] ${errorsOnly ? '仅看异常' : '全部调用'}` : ''}</Text>
          <Text color={colors.muted} wrap="truncate-end">{module === 'workspace'
            ? `${calls} 次调用  ${errors} 次异常  ${running} 个运行进程${filter && tab === 'logs' ? `  筛选:${oneLine(filter)}` : ''}`
            : module === 'migration' ? `${state?.config.migrations.length ?? 0} 次数据迁移 · 原数据保留`
            : module === 'settings' ? '配置与运行状态独立管理' : `${catalog.length} 项配置 · ${module === 'tunnels' ? 'n 新建自建隧道 · ' : ''}详情显示实际状态`}</Text>
        </Box>
        {!showSidebar && focus === 'sidebar' && !hasOverlay ? <Box flexDirection="column" paddingX={1} height={contentHeight}>
          <Text color={colors.accent}>工作区 · Enter选择 /搜索 p项目</Text>
          {editingWorkspaceFilter && <TextInput defaultValue={workspaceFilter} onChange={(value) => { setWorkspaceFilter(value); setSidebarIndex(0); }} onSubmit={() => setEditingWorkspaceFilter(false)} />}
          {sidebarWorkspaces.slice(windowStart(bounded(sidebarIndex, sidebarWorkspaces.length), sidebarWorkspaces.length, contentHeight - 3),
            windowStart(bounded(sidebarIndex, sidebarWorkspaces.length), sidebarWorkspaces.length, contentHeight - 3) + contentHeight - 3).map((workspace) => {
            const tunnel = workspaceTunnel(workspace, state!.config, application.runtime.tunnels, !!application.runtime.serviceOrigin);
            return <Text key={workspace.uuid} color={workspace.uuid === focusedWorkspace?.uuid ? colors.accent : colors.foreground} wrap="truncate-end">{workspace.uuid === focusedWorkspace?.uuid ? '› ' : '  '}{oneLine(workspace.name)}　<Text color={tunnel.color}>{tunnel.symbol} {tunnel.channel} · {tunnel.label}</Text></Text>;
          })}
          <Text dimColor>{sidebarWorkspaces.length} 项 · Home/End PgUp/PgDn</Text>
        </Box> : management ? <ManagementPanel application={application} initialPage={management} initialWorkspaceId={managementWorkspaceId} onClose={closePanel} onExit={() => { void quit(); }} onChanged={refresh} onBusyChange={onPanelBusy} height={contentHeight} width={rightWidth} />
          : tunnelMenu ? <Box flexDirection="column" paddingX={1} height={contentHeight}>
            <Text bold color={colors.accent}>{tunnelMenu === 'workspace' ? `项目：${focusedWorkspace?.name ?? '未选择'}` : '隧道控制 · 选择范围'}</Text>
            <Text dimColor>{tunnelMenu === 'workspace' ? '仅影响此项目公网入口，共享连接继续服务其他项目。' : '按渠道操作保留其他渠道；全部启动恢复已暂停项目。'}</Text>
            <Select visibleOptionCount={Math.max(2, contentHeight - 4)} options={tunnelMenu === 'workspace' ? [
              { label: '绑定 / 更换隧道', value: 'bind' }, { label: '解除隧道绑定', value: 'unbind' },
              { label: '启动 / 恢复此项目公网入口', value: 'start:workspace' }, { label: '暂停此项目公网入口', value: 'stop:workspace' },
              { label: '复制此项目MCP地址', value: 'copy' }, { label: '删除项目（保留磁盘文件）', value: 'delete' }, { label: '返回', value: 'back' },
            ] : [
              { label: '全部工作区 · 一键启动 / 恢复', value: 'start:all' }, { label: '全部工作区 · 暂停公网入口', value: 'stop:all' },
              { label: 'Cloudflare · 一键启动', value: 'start:cloudflare' }, { label: 'Cloudflare · 暂停', value: 'stop:cloudflare' },
              { label: '自定义 · 一键启动（frp / SSH / 外部）', value: 'start:custom' }, { label: '自定义 · 暂停', value: 'stop:custom' },
              { label: 'ChatGPT · 一键启动', value: 'start:openai' }, { label: 'ChatGPT · 暂停', value: 'stop:openai' }, { label: '返回', value: 'back' },
            ]} onChange={(value) => {
              setTunnelMenu(null); if (value === 'back') return;
              if (['bind', 'unbind', 'delete'].includes(value)) {
                if (!focusedWorkspace) { setFailure('请先选择工作区'); return; }
                if (value === 'unbind') run(async () => { await application.bindWorkspace(focusedWorkspace.uuid, null); await refresh(); setNotice('已解除隧道绑定，项目文件与共享隧道配置保留。'); });
                else { setManagementWorkspaceId(focusedWorkspace.uuid); setManagement(value === 'bind' ? 'workspace-bind' : 'workspace-delete'); }
                return;
              }
              if (value === 'copy') { run(async () => { if (!focusedWorkspace || !state) throw new Error('请先选择工作区'); const target = workspaceCopyTarget(focusedWorkspace, state.config, application.runtime.serviceOrigin); await copyToClipboard(target.value); setNotice(`已复制${focusedWorkspace.name}的MCP地址`); }); return; }
              const [action, target] = value.split(':') as ['start' | 'stop', string];
              if (target === 'workspace') { if (!focusedWorkspace) { setFailure('请先选择工作区'); return; } controlTunnels({ action, scope: { kind: 'workspace', workspaceId: focusedWorkspace.uuid } }); }
              else if (target === 'all') controlTunnels({ action, scope: { kind: 'all' } });
              else controlTunnels({ action, scope: { kind: 'provider', provider: target as 'cloudflare' | 'openai' | 'custom' } });
            }} />
          </Box>
          : menu ? <Box flexDirection="column" paddingX={2} paddingY={1} height={contentHeight}><Text bold color={colors.accent}>切换模块</Text><Select visibleOptionCount={6} options={modules} onChange={chooseModule} /></Box>
          : confirmStop ? <Box flexDirection="column" paddingX={1} height={contentHeight}><Text color={colors.danger} bold>结束进程 #{confirmStop.id}？</Text>
            <Text wrap="truncate-end">{oneLine(confirmStop.command)}</Text><Text dimColor>先请求结束，未退出时再强制结束。</Text>
            <Select options={[{ label: '取消', value: 'cancel' }, { label: '确认结束', value: 'stop' }]} onChange={(value) => {
              const target = confirmStop; setConfirmStop(null);
              if (value === 'stop') run(async () => { await application.stopProcess(target.workspaceId, target.id); setNotice('进程已结束'); });
            }} /></Box>
          : help ? <Box flexDirection="column" paddingX={1} height={contentHeight}>
            <Text bold color={colors.accent}>键盘操作</Text>
            <Text>Tab / Shift+Tab  工作区与列表之间切换</Text><Text>↑↓ / Enter       选择工作区或记录，打开详情</Text>
            <Text>Esc / Enter      关闭详情，返回原列表位置</Text><Text>c                复制聚焦工作区的 MCP 地址 / Tunnel ID</Text>
            <Text>1 / 2            实时日志 / 运行终端</Text><Text>/ / e            搜索工作区或日志 / 仅看异常</Text>
            <Text>PgUp/PgDn        列表及详情翻页；Home/End 首尾</Text><Text>f / x            恢复跟随 / 结束选中进程</Text>
            <Text>m / n / r        模块、新建工作区、刷新/重连</Text><Text>p / u / t        项目菜单 / 渠道控制 / 全部启动</Text>
            <Text>s / q            启停全部后台服务 / 退出界面</Text>
            <Text dimColor>{application.background ? 'q 只断开管理界面，后台 MCP、隧道和调用记录继续保留。' : '本次前台实例退出时会关闭自己托管的服务。'}</Text>
            <Text dimColor>终端沿用 Flutter 的进程输出查看方式，不运行嵌入式编辑器。</Text><Text dimColor>Esc 或 Enter 返回</Text>
          </Box>
          : editingFilter ? <Box flexDirection="column" paddingX={1} height={contentHeight}>
            <Text color={colors.accent}>按工具、命令、参数或结果筛选</Text><TextInput defaultValue={filter} onChange={(value) => { setFilter(value); setLogIndex(0); }} onSubmit={() => setEditingFilter(false)} />
            <Text dimColor>Enter 应用 · Esc 返回 · 清空后显示全部</Text>
          </Box>
          : !state ? <Empty title="正在读取配置…" />
          : module === 'workspace' && !selected ? <Empty title="没有工作区"><Text color={colors.muted}>按 n 新建，或按 m 导入 Codexter 配置。</Text></Empty>
          : detailSelection ? <TextViewport lines={detailLines} height={detailHeight} offset={actualOffset} focus={true}
              title={`${module === 'workspace' ? tab === 'logs' ? '调用详情 · 参数与结果' : `进程输出${selectedProcess?.running ? ' · x 结束' : ''}` : '配置详情'} · Esc / Enter 返回列表`}
              follow={module === 'workspace' && tab === 'terminal' && followOutput} />
          : viewCount === 0 ? <Empty title={module === 'workspace' ? tab === 'logs' ? filter || errorsOnly ? '没有匹配调用' : '暂无日志' : '没有受管进程' : `暂无 ${moduleNames[module]}`}>
            <Text color={colors.muted}>{module === 'workspace' ? tab === 'logs' ? '本进程收到工具调用后，命令和结果会显示在这里。' : 'exec_command 启动的进程会显示在这里。' : '按 m 切换模块，或从 Codexter 导入已有配置。'}</Text>
            <Text color={colors.muted}>{module === 'workspace' && !application.runtime.serviceOrigin ? '按 s 启动本地服务。' : ''}</Text>
          </Empty>
          : <Box flexDirection="column" height={contentHeight}>
            <Box flexDirection="column" height={listHeight} flexShrink={0} overflow="hidden">
              <Box paddingX={1}><Text color={focus === 'list' ? colors.accent : colors.muted} wrap="truncate-end">{focus === 'list' ? '▸ ' : '  '}{module === 'workspace' ? tab === 'logs' ? '调用记录' : '受管进程' : moduleNames[module]}  {viewIndex + 1}/{viewCount} · Enter 详情 {module === 'workspace' && tab === 'logs' && followCalls ? '· 跟随' : ''}</Text></Box>
              <Box paddingX={1} height={1}><Text color={colors.muted} wrap="truncate-end">{module === 'workspace' ? tab === 'logs' ? '  状态  时间      工具 / 命令或用途' : '  会话与状态 / 命令' : '  名称 / 状态'}</Text></Box>
              {module !== 'workspace' ? catalog.slice(viewStart, viewStart + listVisible).map((entry, index) => <Box key={entry.id} paddingX={1} height={1} flexShrink={0} backgroundColor={viewStart + index === viewIndex ? colors.active : colors.panel}>
                <Text color={colors.foreground} wrap="truncate-end">{viewStart + index === viewIndex ? '› ' : '  '}{oneLine(entry.title)} · <Text color={colors.muted}>{oneLine(entry.subtitle)}</Text></Text>
              </Box>) : tab === 'logs' ? logs.slice(viewStart, viewStart + listVisible).map((entry, index) => <Box key={entry.id} paddingX={1} height={1} flexShrink={0} backgroundColor={viewStart + index === viewIndex ? colors.active : colors.panel}>
                <Text color={entry.status === 'error' ? colors.danger : entry.status === 'pending' ? colors.accent : colors.success} wrap="truncate-end">{viewStart + index === viewIndex ? '›' : ' '} {entry.status === 'pending' ? '执行' : entry.status === 'error' ? '失败' : '成功'}  {clock(entry.startedAt)}  {entry.name} <Text color={colors.muted}>{elapsed(entry.startedAt, entry.endedAt ?? now)} · {oneLine(entry.command || entry.purpose)}</Text></Text>
              </Box>) : processes.slice(viewStart, viewStart + listVisible).map((entry, index) => <Box key={entry.id} paddingX={1} height={1} flexShrink={0} backgroundColor={viewStart + index === viewIndex ? colors.active : colors.panel}>
                <Text color={entry.running ? colors.success : entry.terminationRequested || entry.exitCode === 0 ? colors.muted : colors.danger} wrap="truncate-end">{viewStart + index === viewIndex ? '›' : ' '} #{entry.id} {entry.running ? '运行中' : entry.terminationRequested ? '已结束' : `退出 ${entry.exitCode}`} · {elapsed(entry.startedAt, entry.endedAt ?? now)} · <Text color={colors.foreground}>{oneLine(entry.command)}</Text></Text>
              </Box>)}
            </Box>
          </Box>}
      </Box>
    </Box>
    <Box height={1} flexShrink={0} backgroundColor="#242933" paddingX={1}>
      <Text color={failure ? colors.danger : colors.muted} wrap="truncate-end">{oneLine(exiting ? application.background ? '正在退出管理界面；后台服务继续运行…' : '正在关闭前台服务和连接器…' : failure || application.runtime.serviceError || (busy ? '正在处理…' : notice) || (management ? '管理面板 · Esc 返回 · Ctrl+C 退出界面' : editingFilter || editingWorkspaceFilter ? '正在筛选 · Enter应用 · Esc取消' : detailSelection ? '详情 · ↑↓/PgUp/PgDn 滚动 · Esc / Enter 返回列表 · c 复制 MCP' : `焦点:${focus === 'sidebar' ? '工作区' : '列表'} Tab切换 · p项目 u渠道 t全部启动 · c复制 m模块 q退出`))}</Text>
    </Box>
  </Box>;
}
