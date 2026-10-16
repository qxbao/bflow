import type {
  AgentRole,
  AgentSessionLocator,
  AgentTransportState,
  OperationOptions,
  OperationResult,
  PaneBinding,
  PaneGroup,
  SessionManifest
} from "@bflow/contracts";

export const PERMANENT_TOPOLOGY_ROLES = [
  "chat",
  "coordinator",
  "planner",
  "analyst",
  "architect",
  "reviewer",
  "qa-verifier"
] as const;

export const TOPOLOGY_ROLES = [
  ...PERMANENT_TOPOLOGY_ROLES,
  "developer"
] as const;

export type PermanentTopologyRole = (typeof PERMANENT_TOPOLOGY_ROLES)[number];
export type TopologyRole = (typeof TOPOLOGY_ROLES)[number];
export type RoleSelector = TopologyRole | AgentRole;

export const SUPPORTED_HERDR_AGENT_KINDS = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "qwen",
  "letta",
  "maki",
  "muse"
] as const;

export type SupportedHerdrAgentKind = (typeof SUPPORTED_HERDR_AGENT_KINDS)[number];

export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export interface RoleTopologySpec {
  readonly topologyRole: TopologyRole;
  readonly contractRole: AgentRole;
  readonly paneGroup: PaneGroup;
  readonly tabKey: "conversation" | "coordination" | "verification" | "developer";
  readonly defaultTabLabel: string;
  readonly defaultAgentName: string;
  readonly permanent: boolean;
  readonly readOnlyWorkspace: boolean;
  readonly focusByDefault: boolean;
}

export const ROLE_TOPOLOGY_SPECS: Record<TopologyRole, RoleTopologySpec> = {
  chat: {
    topologyRole: "chat",
    contractRole: "conversation",
    paneGroup: "conversation",
    tabKey: "conversation",
    defaultTabLabel: "conversation",
    defaultAgentName: "chat",
    permanent: true,
    readOnlyWorkspace: true,
    focusByDefault: true
  },
  coordinator: {
    topologyRole: "coordinator",
    contractRole: "coordinator",
    paneGroup: "coordination",
    tabKey: "coordination",
    defaultTabLabel: "coordination",
    defaultAgentName: "coordinator",
    permanent: true,
    readOnlyWorkspace: true,
    focusByDefault: false
  },
  planner: {
    topologyRole: "planner",
    contractRole: "planner",
    paneGroup: "coordination",
    tabKey: "coordination",
    defaultTabLabel: "coordination",
    defaultAgentName: "planner",
    permanent: true,
    readOnlyWorkspace: true,
    focusByDefault: false
  },
  analyst: {
    topologyRole: "analyst",
    contractRole: "specifier",
    paneGroup: "coordination",
    tabKey: "coordination",
    defaultTabLabel: "coordination",
    defaultAgentName: "analyst",
    permanent: true,
    readOnlyWorkspace: true,
    focusByDefault: false
  },
  architect: {
    topologyRole: "architect",
    contractRole: "architect",
    paneGroup: "coordination",
    tabKey: "coordination",
    defaultTabLabel: "coordination",
    defaultAgentName: "architect",
    permanent: true,
    readOnlyWorkspace: true,
    focusByDefault: false
  },
  reviewer: {
    topologyRole: "reviewer",
    contractRole: "reviewer",
    paneGroup: "verification",
    tabKey: "verification",
    defaultTabLabel: "verification",
    defaultAgentName: "reviewer",
    permanent: true,
    readOnlyWorkspace: true,
    focusByDefault: false
  },
  "qa-verifier": {
    topologyRole: "qa-verifier",
    contractRole: "qa",
    paneGroup: "verification",
    tabKey: "verification",
    defaultTabLabel: "verification",
    defaultAgentName: "qa-verifier",
    permanent: true,
    readOnlyWorkspace: true,
    focusByDefault: false
  },
  developer: {
    topologyRole: "developer",
    contractRole: "developer",
    paneGroup: "developer_worktree",
    tabKey: "developer",
    defaultTabLabel: "developer",
    defaultAgentName: "developer",
    permanent: false,
    readOnlyWorkspace: false,
    focusByDefault: false
  }
};

export function resolveTopologyRole(selector: string): TopologyRole | null {
  switch (selector) {
    case "chat":
    case "conversation":
      return "chat";
    case "coordinator":
      return "coordinator";
    case "planner":
      return "planner";
    case "analyst":
    case "specifier":
      return "analyst";
    case "architect":
      return "architect";
    case "reviewer":
      return "reviewer";
    case "qa-verifier":
    case "qa":
    case "tester":
      return "qa-verifier";
    case "developer":
      return "developer";
    default:
      return null;
  }
}

export function getRoleTopologySpec(selector: string): RoleTopologySpec | null {
  const role = resolveTopologyRole(selector);
  return role === null ? null : ROLE_TOPOLOGY_SPECS[role];
}

export function isValidAgentName(name: string): boolean {
  return typeof name === "string" && AGENT_NAME_PATTERN.test(name);
}

export function isSupportedAgentKind(kind: string): boolean {
  return (SUPPORTED_HERDR_AGENT_KINDS as readonly string[]).includes(kind);
}

export interface RoleAgentConfig {
  readonly agentKind: string;
  readonly provider?: string;
  readonly model?: string;
  readonly agentName?: string;
  readonly args?: readonly string[];
  readonly startupTimeoutMs?: number;
  readonly splitDirection?: "right" | "down";
}

export interface RolePaneManagerConfig {
  readonly sessionId: string;
  readonly projectName: string;
  readonly workspaceRoot: string;
  readonly conversationSessionId?: string;
  readonly defaultAgentKind?: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly permanentRoles?: readonly PermanentTopologyRole[];
  readonly roleConfigs?: Partial<Record<TopologyRole, Partial<RoleAgentConfig>>>;
  readonly maxDeveloperCapacity?: number;
  readonly reuseIdleDeveloperPanes?: boolean;
  readonly tabLabels?: Partial<Record<"conversation" | "coordination" | "verification", string>>;
}

export interface CommandInvocation {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface CommandOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure?: "spawn" | "timeout" | "aborted" | "output_limit" | "invalid_arguments" | "runner";
  readonly started?: boolean;
  readonly cause?: string;
}

export interface HerdrCommandRunner {
  run(invocation: CommandInvocation): Promise<CommandOutcome>;
}

export interface WorktreeCleanlinessResult {
  readonly exists: boolean;
  readonly isClean: boolean;
  readonly dirtyFiles: readonly string[];
  readonly currentBranch?: string;
}

export interface WorktreeInspector {
  inspect(worktreePath: string, options?: OperationOptions): Promise<OperationResult<WorktreeCleanlinessResult>>;
}

export type HerdrLifecycleStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrWorkspaceWorktreeInfo {
  readonly repoKey: string;
  readonly repoName: string;
  readonly repoRoot: string;
  readonly checkoutPath: string;
  readonly isLinkedWorktree: boolean;
}

export interface HerdrWorkspaceInfo {
  readonly workspaceId: string;
  readonly label: string;
  readonly activeTabId: string;
  readonly focused: boolean;
  readonly paneCount: number;
  readonly tabCount: number;
  readonly agentStatus: HerdrLifecycleStatus;
  readonly worktree?: HerdrWorkspaceWorktreeInfo;
}

export interface HerdrTabInfo {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly label: string;
  readonly focused: boolean;
  readonly paneCount: number;
  readonly agentStatus: HerdrLifecycleStatus;
}

export interface HerdrPaneInfo {
  readonly paneId: string;
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly focused: boolean;
  readonly agent: string | null;
  readonly agentStatus: HerdrLifecycleStatus;
  readonly revision: number;
  readonly label?: string | null;
  readonly cwd?: string | null;
  readonly foregroundCwd?: string | null;
  readonly session?: AgentSessionLocator;
}

export interface HerdrAgentInfo {
  readonly paneId: string;
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly focused: boolean;
  readonly agent: string | null;
  readonly name: string | null;
  readonly agentStatus: HerdrLifecycleStatus;
  readonly revision: number;
  readonly stateChangeSequence?: number;
  readonly interactiveReady?: boolean;
  readonly launchPending?: boolean;
  readonly cwd?: string | null;
  readonly foregroundCwd?: string | null;
  readonly session?: AgentSessionLocator;
}

export interface HerdrForegroundProcess {
  readonly pid: number;
  readonly command?: string;
  readonly argv?: readonly string[];
}

export interface HerdrProcessInfo {
  readonly paneId: string;
  readonly shellPid: number | null;
  readonly foregroundProcessGroupId: number | null;
  readonly foregroundProcesses: readonly HerdrForegroundProcess[];
  readonly tty?: string | null;
}

export interface HerdrWorktreeInfo {
  readonly path: string;
  readonly label: string;
  readonly branch: string | null;
  readonly isLinkedWorktree: boolean;
  readonly isDetached: boolean;
  readonly isBare: boolean;
  readonly isPrunable: boolean;
  readonly openWorkspaceId: string | null;
}

export interface HerdrWorkspaceCreated {
  readonly workspace: HerdrWorkspaceInfo;
  readonly tab: HerdrTabInfo;
  readonly rootPane: HerdrPaneInfo;
}

export interface HerdrTabCreated {
  readonly tab: HerdrTabInfo;
  readonly rootPane: HerdrPaneInfo;
}

export interface HerdrWorktreeCreated {
  readonly workspace: HerdrWorkspaceInfo;
  readonly tab: HerdrTabInfo;
  readonly rootPane: HerdrPaneInfo;
  readonly worktree: HerdrWorktreeInfo;
  readonly alreadyOpen?: boolean;
}

export interface HerdrWorktreeRemoved {
  readonly workspaceId: string;
  readonly path: string;
  readonly forced: boolean;
}

export interface HerdrPaneMoveResult {
  readonly changed: boolean;
  readonly previousPaneId: string;
  readonly previousWorkspaceId: string;
  readonly previousTabId: string;
  readonly pane: HerdrPaneInfo;
  readonly focusedPaneId: string;
}

export interface SessionManifestStore {
  load(sessionId: string, options?: OperationOptions): Promise<OperationResult<SessionManifest | null>>;
  save(manifest: SessionManifest, options?: OperationOptions): Promise<OperationResult<SessionManifest>>;
  delete(sessionId: string, options?: OperationOptions): Promise<OperationResult<boolean>>;
}

export type RoleReadinessStatus =
  | "ready"
  | "working"
  | "blocked"
  | "unknown"
  | "not_ready"
  | "pane_missing"
  | "agent_replaced";

export interface RoleHealthReport {
  readonly bindingId: string;
  readonly topologyRole: TopologyRole;
  readonly contractRole: AgentRole;
  readonly agentId: string;
  readonly paneId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly status: RoleReadinessStatus;
  readonly transportState: AgentTransportState;
  readonly readyForPrompt: boolean;
  readonly paneExists: boolean;
  readonly occupantMatches: boolean;
  readonly reason?: string;
  readonly observedAgent?: HerdrAgentInfo;
}

export type TopologyAnomalyKind =
  | "pane_missing"
  | "agent_replaced"
  | "agent_not_ready"
  | "agent_blocked"
  | "agent_unknown"
  | "pane_id_changed";

export interface TopologyAnomaly {
  readonly kind: TopologyAnomalyKind;
  readonly bindingId: string;
  readonly topologyRole: TopologyRole;
  readonly agentId: string;
  readonly expectedPaneId: string;
  readonly observedPaneId?: string;
  readonly message: string;
}

export interface TopologyHealthSummary {
  readonly sessionId: string;
  readonly healthy: boolean;
  readonly roles: readonly RoleHealthReport[];
  readonly anomalies: readonly TopologyAnomaly[];
}

export interface DeveloperAllocationRequest {
  readonly taskId: string;
  readonly runId?: string;
  readonly worktreePath: string;
  readonly branchName?: string;
  readonly baseRef?: string;
  readonly agentName?: string;
  readonly agentKind?: string;
  readonly model?: string;
  readonly args?: readonly string[];
  readonly startupTimeoutMs?: number;
}

export interface DeveloperReleaseRequest {
  readonly taskId?: string;
  readonly agentId?: string;
  readonly paneId?: string;
  readonly closePane?: boolean;
  readonly removeWorktree?: boolean;
}

export interface DeveloperReleaseOutcome {
  readonly releasedBinding: PaneBinding;
  readonly paneClosed: boolean;
  readonly worktreeRemoved: boolean;
  readonly retainedForReuse: boolean;
  readonly manifest: SessionManifest;
}

export type PaneMoveDestinationSpec =
  | {
      readonly mode: "tab";
      readonly tabId: string;
      readonly splitDirection: "right" | "down";
      readonly targetPaneId?: string;
      readonly focus?: boolean;
    }
  | {
      readonly mode: "new_tab";
      readonly workspaceId?: string;
      readonly label?: string;
      readonly focus?: boolean;
    }
  | {
      readonly mode: "new_workspace";
      readonly label?: string;
      readonly tabLabel?: string;
      readonly focus?: boolean;
    };
