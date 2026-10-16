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

export interface ProviderAdapterOptions {
  readonly executablePath?: string;
  readonly pinnedExecutableDigest?: string;
  readonly minimumVersion?: string;
  readonly runner?: ProviderCommandRunner;
  readonly rolePrompt?: string;
  readonly model?: string;
  readonly supportedModels?: readonly string[];
  readonly mcpRegistrations?: readonly MCPClientRegistration[];
  readonly mcpObservations?: readonly MCPServiceObservation[];
  readonly skillManifest?: SkillManifest;
  readonly renderedSkillsContent?: string;
  readonly nativeSessionHookCommand?: string;
  readonly trustedIssuerKeys?: Readonly<Record<string, string>>;
  readonly liveObservation?: LiveReadinessObservation;
  readonly osSandboxPath?: string;
  readonly allowTestFilesystemOwnership?: boolean;
  readonly now?: () => Date;
  readonly healthTtlMs?: number;
}
