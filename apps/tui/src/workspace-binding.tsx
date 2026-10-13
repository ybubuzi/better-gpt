import { useState } from 'react';
import { Box, Text } from 'ink';
import { PasswordInput, Select, TextInput } from '@inkjs/ui';
import { providerSetupSchema, tunnelIdSchema, type AppConfig, type TunnelProfile, type Workspace } from '@better-gpt/contracts';

export function WorkspaceBinding({ workspace, config, onBind, onConfigure, onSharedId, onNew, onCancel, height, disabled = false }: {
  workspace: Workspace; config: AppConfig; height: number; disabled?: boolean;
  onBind(profile: TunnelProfile): void; onConfigure(raw: unknown): void;
  onSharedId(profile: TunnelProfile, tunnelId: string): void; onNew(): void; onCancel(): void;
}) {
  const [mode, setMode] = useState<'list' | 'profiles' | 'shared-id' | 'setup'>('list');
  const [provider, setProvider] = useState<'cloudflare' | 'openai'>('cloudflare');
  const [profile, setProfile] = useState<TunnelProfile>();
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState('');
  const cf = config.tunnelProfiles.filter((entry) => entry.provider === 'cloudflare');
  const gpt = config.tunnelProfiles.filter((entry) => entry.provider === 'openai');
  const custom = config.tunnelProfiles.filter((entry) => !['cloudflare', 'openai'].includes(entry.provider));
  function choose(entry: TunnelProfile) {
    if (disabled) return;
    if (entry.provider === 'openai' && !entry.tunnelId) {
      const legacyIds = [...new Set(config.workspaces.filter((item) => item.tunnelBinding?.profileId === entry.id).map((item) => item.tunnelBinding?.openAiTunnelId).filter((id): id is string => !!id))];
      if (legacyIds.length === 1) onSharedId(entry, legacyIds[0]!);
      else { setProfile(entry); setMode('shared-id'); }
    } else onBind(entry);
  }
  function category(value: 'cloudflare' | 'openai') {
    if (disabled) return;
    setProvider(value); const profiles = value === 'cloudflare' ? cf : gpt;
    if (profiles.length === 1) choose(profiles[0]!);
    else if (profiles.length > 1) setMode('profiles');
    else { setMode('setup'); setStep(0); setValues({}); }
  }
  const fields = provider === 'cloudflare' ? [
    { key: 'publicBaseUrl', label: 'Cloudflare公网域名，例如 https://mcp.example.com' },
    { key: 'credentialFile', label: '已有Cloudflare隧道凭据JSON文件绝对路径' },
    { key: 'executable', label: 'cloudflared路径；留空从已安装程序查找', optional: true },
  ] : [
    { key: 'tunnelId', label: '此ChatGPT配置共用的Tunnel ID（只填一次）' },
    { key: 'runtimeKey', label: 'Runtime Key（只填一次，加密保存）' },
    { key: 'executable', label: 'tunnel-client路径；可留空', optional: true },
  ];
  const field = fields[step];
  function submit(value: string) {
    if (disabled) return;
    value = value.trim(); if (!field) return;
    if (!value && !field.optional) { setFailure('此项不能为空'); return; }
    if (field.key === 'tunnelId' && !tunnelIdSchema.safeParse(value).success) { setFailure('Tunnel ID应为tunnel_及32位十六进制字符'); return; }
    const next = { ...values, [field.key]: value }; setValues(next); setFailure('');
    if (step + 1 < fields.length) { setStep(step + 1); return; }
    const parsed = providerSetupSchema.safeParse({ provider, name: provider === 'cloudflare' ? 'Cloudflare' : 'ChatGPT', ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== '')) });
    if (!parsed.success) { setFailure(parsed.error.issues.map((issue) => issue.message).join('；')); return; }
    onConfigure(parsed.data);
  }
  return <Box flexDirection="column">
    <Text bold>绑定隧道 · {workspace.name}</Text>
    {failure && <Text color="red" wrap="truncate-end">{failure}</Text>}
    {mode === 'list' && <>
      <Text dimColor>已有配置直接复用，无需重复填写凭据。</Text>
      <Select isDisabled={disabled} visibleOptionCount={Math.max(3, height - 5)} options={[
        { label: `CF${cf.length ? ' · 已配置' : ' · 首次配置'}`, value: 'cf' },
        { label: `ChatGPT${gpt.length ? ' · 已配置' : ' · 首次配置'}`, value: 'gpt' },
        ...custom.map((entry) => ({ label: `${entry.name} · ${entry.provider}${entry.enabled ? '' : '（已停用）'}`, value: `profile:${entry.id}` })),
        { label: '新建 SSH/frp 隧道', value: 'new' }, { label: '暂不绑定 / 返回', value: 'back' },
      ]} onChange={(value) => {
        if (value === 'cf' || value === 'gpt') category(value === 'cf' ? 'cloudflare' : 'openai');
        else if (value === 'new') onNew(); else if (value === 'back') onCancel();
        else { const entry = config.tunnelProfiles.find((entry) => entry.id === value.slice(8)); if (entry) choose(entry); }
      }} />
    </>}
    {mode === 'profiles' && <Select isDisabled={disabled} options={[...(provider === 'cloudflare' ? cf : gpt).map((entry) => ({ label: `${entry.name}${entry.enabled ? '' : '（已停用）'}`, value: entry.id })), { label: '返回', value: 'back' }]} onChange={(id) => { if (id === 'back') setMode('list'); else { const entry = config.tunnelProfiles.find((entry) => entry.id === id); if (entry) choose(entry); } }} />}
    {mode === 'shared-id' && profile && <>
      <Text>为 {profile.name} 设置一次共享Tunnel ID，后续项目直接复用。</Text>
      <Text color="yellow">ChatGPT运行器尚未接入，目前保存配置。</Text>
      <TextInput isDisabled={disabled} placeholder="tunnel_…" onSubmit={(value) => { if (disabled) return; const id = tunnelIdSchema.safeParse(value.trim()); if (!id.success) setFailure('请输入有效Tunnel ID'); else onSharedId(profile, id.data); }} />
    </>}
    {mode === 'setup' && field && <>
      <Text>{provider === 'cloudflare' ? 'CF首次配置，后续项目直接复用。' : 'ChatGPT首次配置；运行器尚未接入。'}</Text>
      <Text>{step + 1}/{fields.length}　{field.label}</Text>
      {field.key === 'runtimeKey' ? <PasswordInput isDisabled={disabled} key={field.key} onSubmit={submit} /> : <TextInput isDisabled={disabled} key={field.key} onSubmit={submit} />}
    </>}
  </Box>;
}
