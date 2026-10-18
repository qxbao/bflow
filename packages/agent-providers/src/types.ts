import type {
  MCPClientRegistration,
  MCPServiceObservation,
  SkillManifest
} from "@bflow/contracts";

export interface ProviderCommandInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ProviderCommandOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly started: boolean;
  readonly failure?: "spawn" | "timeout" | "aborted" | "output_limit" | "invalid_arguments";
  readonly cause?: string;
}

export interface ProviderCommandRunner {
  run(invocation: ProviderCommandInvocation): Promise<ProviderCommandOutcome>;
}

export interface DetectedProviderCapabilities {
  readonly version: string;
  readonly rawVersionOutput: string;
  readonly supportedFlags: ReadonlySet<string>;
  readonly supportedSubcommands: ReadonlySet<string>;
  readonly supportsMcpStdio: boolean;
  readonly supportsMcpHttp: boolean;
  readonly supportsSkills: boolean;
  readonly supportsWorkspaceTrust: boolean;
  readonly supportsDangerouslySkipPermissions: boolean;
  readonly supportsSandboxFlag: boolean;
  readonly supportsApprovalPolicyFlag: boolean;
  readonly supportsAddDirFlag: boolean;
  readonly supportsNativeHooks: boolean;
  readonly supportsUnattendedMode: boolean;
}

export interface LiveReadinessObservation {
  readonly paneId: string;
  readonly agentName?: string;
  readonly transportState:
    | "starting"
    | "accepted"
    | "idle"
    | "working"
    | "blocked"
    | "done"
    | "unknown"
    | "disconnected"
    | "cancelled";
  readonly interactiveReady: boolean;
  readonly launchPending?: boolean;
  readonly nativeSession?: {
    readonly source: string;
    readonly kind: "id" | "path" | "opaque";
    readonly value: string;
  };
  readonly permissionDenied?: boolean;
}

export type HostHookEvent = "SessionStart" | "UserPromptSubmit" | "Stop" | "PreToolUse";

export interface HostMcpServer {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ProviderAdapterOptions {
  readonly executablePath?: string;
  readonly pinnedExecutableDigest?: string;
  readonly minimumVersion?: string;
  readonly runner?: ProviderCommandRunner;
  readonly rolePrompt?: string;
  readonly model?: string;
  readonly effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly supportedModels?: readonly string[];
  readonly mcpRegistrations?: readonly MCPClientRegistration[];
  readonly mcpObservations?: readonly MCPServiceObservation[];
  readonly skillManifest?: SkillManifest;
  readonly renderedSkillsContent?: string;
  readonly nativeSessionHookCommand?: string;
  /** Trusted Bflow host stdio MCP servers; command must be absolute. Names must not collide with registrations. */
  readonly hostMcpServers?: Readonly<Record<string, HostMcpServer>>;
  /** Full shell command per native hook event. `SessionStart` here supersedes `nativeSessionHookCommand`. */
  readonly hostHooks?: Readonly<Partial<Record<HostHookEvent, string>>>;
  /** registrationId -> environment variable NAME holding the bearer token of a streamable_http registration. */
  readonly mcpTokenEnvironmentNames?: Readonly<Record<string, string>>;
  readonly trustedIssuerKeys?: Readonly<Record<string, string>>;
  readonly liveObservation?: LiveReadinessObservation;
  readonly osSandboxPath?: string;
  readonly allowTestFilesystemOwnership?: boolean;
  /** Codex home used only for read-only inspection of inherited global MCP servers and hooks. Defaults to $CODEX_HOME or ~/.codex. */
  readonly codexHomeDirectory?: string;
  readonly now?: () => Date;
  readonly healthTtlMs?: number;
}
