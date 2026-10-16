export type SupportStatus = "supported" | "designed_unverified" | "unsupported";
export interface PlatformProfile {
  os: "linux" | "darwin" | "win32" | "other";
  arch: string;
  supportStatus: SupportStatus;
  shell: "bash" | "zsh" | "fish" | "sh" | "pwsh" | "cmd" | "unknown";
  shellPath: string | null;
  uid: number | null;
  gid: number | null;
  isRoot: boolean;
  elevationAvailable: boolean;
  homeDir: string;
  hostname: string;
  machineId: string;
  paths: { config: string; data: string; state: string; managedBin: string };
  pathEntries: string[];
}
export interface HostEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  hostname: string;
  uid: number | null;
  gid: number | null;
}
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export interface CommandRunner {
  run(
    argv: readonly string[],
    options?: { timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal }
  ): Promise<CommandResult>;
}
export interface ComponentObservation {
  stateDigest: string | null;
  valid: boolean;
  diagnostics: string[];
}
export interface ComponentDesiredState {
  digest: string;
  summary: string;
  targets: string[];
  machineWide: boolean;
  repairNeeded: boolean;
}
export interface SetupContext {
  platform: PlatformProfile;
  runner: CommandRunner;
  mode: "check" | "dry_run" | "apply" | "repair";
  now(): Date;
  signal?: AbortSignal;
}
export interface SetupComponent {
  readonly componentId: string;
  readonly action: "configure" | "register_mcp" | "resolve_skills" | "verify";
  readonly rollback: "restore_owned_config" | "remove_owned_install" | "manual" | "none";
  observe(ctx: SetupContext): Promise<ComponentObservation>;
  desired(ctx: SetupContext): Promise<ComponentDesiredState>;
  apply(ctx: SetupContext): Promise<{ ownedPaths: string[]; diagnostics: string[] }>;
}
