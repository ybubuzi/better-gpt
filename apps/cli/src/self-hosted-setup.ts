import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as prompts from '@clack/prompts';
import { Application, DaemonClient, advancedSetupFields, applySshChoice, applySshLogin, normalizeSetupDomain, setupDefaults, setupProfile, validateSetupField } from '@better-gpt/core';
import { tunnelProfileSchema, type AppConfig } from '@better-gpt/contracts';

function cancel(): never { prompts.cancel('已取消，未保存配置'); process.exit(0); }
function answer<T>(value: T): Exclude<T, symbol> { if (prompts.isCancel(value)) return cancel(); return value as Exclude<T, symbol>; }
async function workspaceIds(config: AppConfig) {
  return config.workspaces.length ? answer(await prompts.multiselect({ message: '绑定工作区（空格选择，Enter确认；可不选）', required: false,
    options: config.workspaces.map((workspace) => ({ value: workspace.uuid, label: workspace.name })) })) : [];
}
export async function setupTunnel(app: Application, initialProvider?: 'ssh') {
  prompts.intro('Better GPT · 自建隧道');
  const provider = initialProvider ?? answer(await prompts.select({ message: '连接方式', options: [{ value: 'ssh', label: 'SSH · 复用已有连接' }, { value: 'frp', label: 'frp' }, { value: 'external', label: '外部隧道' }] }));
  const config = (await app.store.read()).config;
  const domain = answer(await prompts.text({ message: '公网域名（同时作为服务器默认地址）', validate: (value) => { try { normalizeSetupDomain(value ?? ''); } catch { return '请输入HTTPS域名，不包含路径'; } return undefined; } }));
  let values = setupDefaults(provider, domain, config, app.store.directory);
  const id = randomUUID(); let reuseId = '';
  const matching = config.tunnelProfiles.filter((profile) => 'publicBaseUrl' in profile && profile.publicBaseUrl.replace(/\/$/, '') === values.publicBaseUrl);
  if (matching.length) reuseId = answer(await prompts.select({ message: '这个域名已有配置', options: [...matching.map((profile) => ({ value: profile.id, label: `复用 ${profile.name} · ${profile.provider}` })), { value: '', label: '仍新建独立配置' }] }));
  if (!reuseId && provider === 'ssh') {
    const consent = answer(await prompts.select({ message: '是否允许本次扫描本机.ssh？仅读取config和密钥文件名，不读取私钥或尝试登录。', options: [{ value: true, label: '允许扫描并选择已有连接' }, { value: false, label: '不扫描，手动填写私钥绝对路径' }] }));
    let alias = false;
    if (consent) {
      const discovery = await app.discoverSshConnections({ authorized: true });
      for (const warning of discovery.warnings) prompts.log.warn(warning);
      const selected = answer(await prompts.select({ message: 'SSH别名或候选密钥', options: [...discovery.choices.map((choice) => ({ value: choice.id, label: choice.label, hint: choice.description })), { value: 'manual', label: '手动填写私钥绝对路径' }] }));
      const choice = discovery.choices.find((choice) => choice.id === selected);
      if (choice) { values = applySshChoice(values, choice, config); alias = choice.kind === 'alias'; }
    }
    if (!values.identityFile) values.identityFile = answer(await prompts.text({ message: '私钥绝对路径', validate: (value) => { try { validateSetupField({ key: 'identityFile', label: '' }, value ?? ''); return undefined; } catch { return '请输入私钥绝对路径'; } } }));
    if (!alias) values = applySshLogin(values, answer(await prompts.text({ message: 'SSH登录地址 · 用户名@主机，默认22端口', initialValue: `${values.username}@${values.serverAddress}`, validate: (value) => { try { applySshLogin(values, value ?? '', config); return undefined; } catch { return '请输入用户名@主机，可附加:端口'; } } })), config);
  } else if (!reuseId && provider === 'frp') values.token = answer(await prompts.password({ message: 'frps Token（加密保存；默认端口7000）', validate: (value) => value?.trim() ? undefined : '请输入Token' }));
  const selected = await workspaceIds(config);
  let persisted = !!reuseId;
  while (true) {
    prompts.note([reuseId ? `复用 ${matching.find((profile) => profile.id === reuseId)?.name}` : values.name, values.publicBaseUrl,
      ...(!reuseId ? [provider === 'external' ? `本机回环端口${values.localPort}` : `${provider === 'ssh' ? `${values.username}@` : ''}${values.serverAddress}:${values.serverPort} → 远端回环${values.remotePort}`,
        ...(provider === 'ssh' ? [`密钥：${values.identityFile}`, `指纹文件：${values.knownHostsFile}`] : [])] : []), `绑定${selected.length}个工作区`].join('\n'), '确认配置');
    const action = answer(await prompts.select({ message: '下一步', options: [{ value: 'save', label: '确认保存并绑定' }, ...(!reuseId ? [{ value: 'advanced', label: '高级设置 · 只修改需要调整的项' }] : []), { value: 'cancel', label: '取消' }] }));
    if (action === 'cancel') return cancel();
    if (action === 'save') {
      try {
        if (!persisted) { const profile = tunnelProfileSchema.parse(setupProfile(provider, id, values)); await app.configureSelfHostedTunnel(profile, [], values.token); persisted = true; }
        const client = new DaemonClient(app.store.directory, fileURLToPath(new URL('./daemon.js', import.meta.url)));
        try { for (const uuid of selected) { const result = await client.bindWorkspace(uuid, { profileId: reuseId || id }); if (result.warning) prompts.log.warn(result.warning); } }
        finally { await client.dispose(); }
        prompts.outro(`已${reuseId ? '复用' : '保存'}隧道配置，绑定${selected.length}个工作区。服务器HTTPS代理需指向对应回环端口；首次SSH连接仍需已核验的指纹。`);
        return;
      } catch (error) { prompts.log.error(error instanceof Error ? error.message : '保存失败；输入已保留，可通过高级设置修改后重试'); continue; }
    }
    const fields = advancedSetupFields(provider);
    const key = answer(await prompts.select({ message: '选择要修改的参数', options: [...fields.map((field) => ({ value: field.key, label: field.label, hint: values[field.key] || '自动' })), { value: 'back', label: '返回确认' }] }));
    if (key === 'back') continue;
    const field = fields.find((field) => field.key === key)!;
    values[key] = answer(await prompts.text({ message: field.label, initialValue: values[key] ?? '', validate: (value) => { try { validateSetupField(field, value ?? ''); return undefined; } catch (error) { return error instanceof Error ? error.message : '参数无效'; } } }));
  }
}
