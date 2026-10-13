import { workspaceEndpoint, type AppConfig, type TunnelControl, type TunnelProfile, type WorkspaceEndpoint } from '@better-gpt/contracts';

export interface TunnelPlan {
  profile: TunnelProfile;
  workspaces: { uuid: string; endpoint: WorkspaceEndpoint }[];
}

/** Planning is pure: it never starts executables or modifies DNS. */
export function planTunnels(config: AppConfig): TunnelPlan[] {
  return config.tunnelProfiles.filter((profile) => profile.enabled).map((profile) => ({
    profile,
    workspaces: config.workspaces.filter((workspace) => workspace.enabled && workspace.tunnelEnabled
      && workspace.tunnelBinding?.profileId === profile.id)
      .map((workspace) => ({ uuid: workspace.uuid, endpoint: workspaceEndpoint(workspace, config) })),
  })).filter((plan) => plan.workspaces.length > 0);
}

export function allowedWorkspace(config: AppConfig, profileId: string, workspaceUuid: string): boolean {
  const profile = config.tunnelProfiles.find((entry) => entry.id === profileId && entry.enabled);
  return !!profile && config.workspaces.some((workspace) => workspace.uuid === workspaceUuid
    && workspace.enabled && workspace.tunnelEnabled && workspace.tunnelBinding?.profileId === profileId);
}

export function tunnelMatches(profile: TunnelProfile, scope: TunnelControl['scope']): boolean {
  if (scope.kind === 'all' || scope.kind === 'workspace') return true;
  if (scope.kind === 'profile') return profile.id === scope.profileId;
  return scope.provider === 'custom' ? ['frp', 'ssh', 'external'].includes(profile.provider) : profile.provider === scope.provider;
}

export interface TunnelDriver {
  readonly provider: TunnelProfile['provider'];
  start(plan: TunnelPlan, localOrigin: string, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}
