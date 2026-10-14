import type { Application, ProcessManager, RuntimeStore } from '@better-gpt/core';
import type { AppSnapshot, TunnelRuntime } from '@better-gpt/contracts';

export interface TuiApplication {
  readonly background?: boolean;
  readonly runtime: RuntimeStore;
  readonly processes: Pick<ProcessManager, 'list' | 'runningCount'>;
  readonly migration: Application['migration'];
  snapshot(): Promise<AppSnapshot>;
  diagnoseConfiguration: Application['diagnoseConfiguration'];
  createWorkspace(raw: unknown): Promise<AppSnapshot>;
  setProxy(raw: unknown): Promise<void>;
  configureSelfHostedTunnel: Application['configureSelfHostedTunnel'];
  configureProviderTunnel: Application['configureProviderTunnel'];
  discoverSshConnections: Application['discoverSshConnections'];
  setSharedOpenAiTunnelId: Application['setSharedOpenAiTunnelId'];
  bindWorkspace: Application['bindWorkspace'];
  removeWorkspace: Application['removeWorkspace'];
  controlTunnels: Application['controlTunnels'];
  selectWorkspace?(workspaceId: string): void;
  selectDetail?(kind: string, id?: string | number): void;
  startGateway(): Promise<{ service: { origin: string; port: number }; tunnels: TunnelRuntime[] }>;
  stopService(): Promise<void>;
  stopProcess(workspaceId: string, id: number): Promise<void>;
  dispose(): Promise<void>;
}
