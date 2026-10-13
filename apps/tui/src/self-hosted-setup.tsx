import { useState } from 'react';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { Box, Text } from 'ink';
import { Select, MultiSelect, TextInput, PasswordInput, Spinner } from '@inkjs/ui';
import { tunnelProfileSchema, type AppConfig } from '@better-gpt/contracts';
import { advancedSetupFields, applySshChoice, applySshLogin, normalizeSetupDomain, setupDefaults, setupProfile, validateSetupField, type SshDiscovery, type SshConnectionChoice } from '@better-gpt/core';

type Provider = 'ssh' | 'frp' | 'external';
type Stage = 'provider' | 'domain' | 'reuse' | 'permission' | 'connections' | 'identity' | 'login' | 'token' | 'advanced' | 'bindings' | 'review';
export function TunnelSetup({ config, dataDirectory, discover, onSave, onReuse, onCancel, workspaceId, saving = false, height = 15 }: {
  config: AppConfig; dataDirectory: string; discover(options: { authorized: boolean }): Promise<SshDiscovery>;
  onSave(raw: unknown, ids: string[], token?: string): void; onReuse(profileId: string, ids: string[]): void; onCancel(): void;
  workspaceId?: string; saving?: boolean; height?: number;
}) {
  const [provider, setProvider] = useState<Provider>('ssh');
  const [stage, setStage] = useState<Stage>('provider');
  const [id] = useState(randomUUID);
  const [values, setValues] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>(workspaceId ? [workspaceId] : []);
  const [discovery, setDiscovery] = useState<SshDiscovery>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [advancedKey, setAdvancedKey] = useState('');
  const [reuseId, setReuseId] = useState('');
  const disabled = saving || busy;
  const matching = config.tunnelProfiles.filter((profile) => 'publicBaseUrl' in profile && profile.publicBaseUrl.replace(/\/$/, '') === values.publicBaseUrl);
  const fields = advancedSetupFields(provider), field = fields.find((entry) => entry.key === advancedKey);
  function nextConnection(next = values) { setValues(next); setStage(workspaceId || !config.workspaces.length ? 'review' : 'bindings'); }
  function afterDomain() { setStage(provider === 'ssh' ? 'permission' : provider === 'frp' ? 'token' : workspaceId || !config.workspaces.length ? 'review' : 'bindings'); }
  async function scan() {
    setBusy(true); setFailure('');
    try { const found = await discover({ authorized: true }); setDiscovery(found); setStage('connections'); }
    catch (error) { setFailure(error instanceof Error ? error.message : '发现失败，可手动填写'); setStage('identity'); }
    finally { setBusy(false); }
  }
  function choose(choice: SshConnectionChoice) {
    const next = applySshChoice(values, choice, config); setValues(next);
    if (!choice.identityFile) setStage('identity');
    else if (choice.kind === 'key') setStage('login');
    else nextConnection(next);
  }
  function submit(value: string) {
    if (disabled) return;
    value = stage === 'token' ? value : value.trim(); setFailure('');
    try {
      if (stage === 'domain') {
        const next = setupDefaults(provider, normalizeSetupDomain(value), config, dataDirectory); setValues(next);
        const exists = config.tunnelProfiles.some((profile) => 'publicBaseUrl' in profile && profile.publicBaseUrl.replace(/\/$/, '') === next.publicBaseUrl);
        if (exists) setStage('reuse'); else afterDomain();
      } else if (stage === 'identity') {
        validateSetupField({ key: 'identityFile', label: '' }, value);
        const next = { ...values, identityFile: value }; setValues(next);
        if (values.sshHostAlias) nextConnection(next); else setStage('login');
      } else if (stage === 'login') nextConnection(applySshLogin(values, value, config));
      else if (stage === 'token') { if (!value.trim()) throw new Error('请输入frps Token'); nextConnection({ ...values, token: value }); }
      else if (stage === 'advanced' && field) { validateSetupField(field, value); setValues({ ...values, [field.key]: value }); setAdvancedKey(''); }
    } catch (error) { setFailure(error instanceof Error ? error.message : '输入无效'); }
  }
  if (busy) return <Spinner label="读取已授权的SSH配置和文件名…" />;
  return <Box flexDirection="column">
    <Text bold>新建自建隧道{stage !== 'provider' ? ` · ${provider}` : ''}</Text>
    {failure && <Text color="red" wrap="truncate-end">{failure}</Text>}
    {stage === 'provider' && <Select isDisabled={disabled} options={[{ label: 'SSH · 复用本机连接配置', value: 'ssh' }, { label: 'frp · 连接自建frps', value: 'frp' }, { label: '外部隧道 · 自行管理连接器', value: 'external' }, { label: '取消', value: 'cancel' }]} onChange={(value) => { if (value === 'cancel') onCancel(); else { setProvider(value as Provider); setStage('domain'); } }} />}
    {stage === 'domain' && <><Text>公网域名（支持直接输入 mcp.example.com）</Text><Text dimColor>同时作为服务器默认地址，确认页可修改。</Text><TextInput isDisabled={disabled} onSubmit={submit} /></>}
    {stage === 'reuse' && <><Text>这个域名已有配置，直接复用可省去重复配置。</Text><Select isDisabled={disabled} options={[...matching.map((profile) => ({ label: `复用 ${profile.name} · ${profile.provider}`, value: profile.id })), { label: '修改域名', value: 'domain' }, { label: '仍新建独立配置', value: 'new' }]} onChange={(value) => { if (value === 'domain') setStage('domain'); else if (value === 'new') afterDomain(); else { setReuseId(value); setStage(workspaceId || !config.workspaces.length ? 'review' : 'bindings'); } }} /></>}
    {stage === 'permission' && <>
      <Text>是否允许本次扫描本机 .ssh？</Text><Text dimColor>读取config和密钥文件名，不读取私钥内容，不尝试登录。</Text>
      <Select isDisabled={disabled} options={[{ label: '允许扫描，选择已有SSH别名或密钥', value: 'yes' }, { label: '不扫描，手动填写私钥绝对路径', value: 'no' }]} onChange={(value) => { if (value === 'yes') void scan(); else setStage('identity'); }} />
    </>}
    {stage === 'connections' && <>
      <Text>选择SSH别名或候选密钥</Text>
      <Select isDisabled={disabled} visibleOptionCount={Math.max(3, height - 6)} options={[...(discovery?.choices ?? []).map((choice) => ({ label: choice.kind === 'alias' ? `${choice.label} · ${choice.username}:${choice.serverPort}` : `${choice.label} · 密钥文件`, value: choice.id })), { label: '手动填写私钥绝对路径', value: 'manual' }, { label: '返回授权选择', value: 'back' }]} onChange={(value) => { if (value === 'manual') setStage('identity'); else if (value === 'back') setStage('permission'); else { const choice = discovery?.choices.find((choice) => choice.id === value); if (choice) choose(choice); } }} />
      {!!discovery?.warnings.length && <Text color="yellow" wrap="truncate-end">{discovery.warnings[0]}</Text>}
    </>}
    {stage === 'identity' && <><Text>私钥绝对路径（只引用文件）</Text><TextInput isDisabled={disabled} defaultValue={values.identityFile ?? ''} onSubmit={submit} /></>}
    {stage === 'login' && <><Text>SSH登录地址 · 用户名@主机，端口默认22</Text><TextInput isDisabled={disabled} defaultValue={`${values.username}@${values.serverAddress?.includes(':') ? `[${values.serverAddress}]` : values.serverAddress}${values.serverPort !== '22' ? `:${values.serverPort}` : ''}`} onSubmit={submit} /></>}
    {stage === 'token' && <><Text>frps Token（加密保存）</Text><Text dimColor>默认端口7000，其余参数可在高级设置修改。</Text><PasswordInput isDisabled={disabled} onSubmit={submit} /></>}
    {stage === 'bindings' && <>
      <Text>绑定工作区 · 空格选择，Enter确认</Text>
      <MultiSelect isDisabled={disabled} visibleOptionCount={Math.max(3, height - 5)} defaultValue={selected} options={config.workspaces.map((workspace) => ({ label: workspace.name, value: workspace.uuid }))} onSubmit={(ids) => { setSelected(ids); setStage('review'); }} />
    </>}
    {stage === 'advanced' && (field ? <><Text>{field.label}</Text><TextInput key={field.key} isDisabled={disabled} defaultValue={values[field.key] ?? ''} onSubmit={submit} /></> : <>
      <Text>高级设置 · 只修改需要调整的项</Text><Select isDisabled={disabled} visibleOptionCount={Math.max(3, height - 5)} options={[...fields.map((field) => ({ label: `${field.label}：${values[field.key] || '自动'}`, value: field.key })), { label: '返回确认', value: 'back' }]} onChange={(value) => { if (value === 'back') setStage('review'); else setAdvancedKey(value); }} />
    </>)}
    {stage === 'review' && <>
      <Text>{reuseId ? `复用 ${config.tunnelProfiles.find((profile) => profile.id === reuseId)?.name}` : values.name}</Text>
      <Text>{values.publicBaseUrl}</Text>
      {!reuseId && <>
        <Text>{provider === 'external' ? `本机专用入口 127.0.0.1:${values.localPort}` : `${provider === 'ssh' ? `${values.username}@` : ''}${values.serverAddress}:${values.serverPort} → 回环${values.remotePort}`}</Text>
        {provider === 'ssh' && <Text wrap="truncate-end">密钥 {basename(values.identityFile ?? '')} · {values.sshHostAlias ? `SSH别名 ${values.sshHostAlias}` : '手动连接'}</Text>}
        {provider === 'ssh' && <Text dimColor wrap="truncate-end">指纹文件：{values.knownHostsFile}</Text>}
        {values.useSshProxy === 'true' && <Text dimColor>沿用SSH配置中的代理/跳板机。</Text>}
        {provider !== 'external' && <Text dimColor>服务器HTTPS代理需指向回环端口{values.remotePort}。</Text>}
      </>}
      <Text>绑定{selected.length}个工作区</Text>
      <Select isDisabled={disabled} options={[{ label: reuseId ? '确认复用并绑定' : '确认保存并绑定', value: 'save' }, ...(!reuseId ? [{ label: '高级设置', value: 'advanced' }] : []), { label: '修改域名 / 连接', value: 'change' }, { label: '取消', value: 'cancel' }]} onChange={(value) => {
        if (value === 'cancel') onCancel(); else if (value === 'advanced') setStage('advanced'); else if (value === 'change') { setReuseId(''); setStage('domain'); }
        else if (reuseId) onReuse(reuseId, selected);
        else { try { onSave(tunnelProfileSchema.parse(setupProfile(provider, id, values)), selected, values.token); } catch (error) { setFailure(error instanceof Error ? error.message : '配置无效'); } }
      }} />
    </>}
    <Text dimColor>Esc取消 · 只保存本机配置；首次连接仍需已核验的服务器指纹。</Text>
  </Box>;
}
