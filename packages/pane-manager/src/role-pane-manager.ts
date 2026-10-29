import { resolveNativeAgyPrompt } from "./native-agy-prompt.js";
import type {
  AgentSessionLocator,
  ResolvedRoleProfileSnapshot,
  AgentRole,
  AgentTransportState,
  ContractError,
  OperationOptions,
  OperationResult,
  PaneBinding,
  SessionManifest,
  SessionManifestStatus
} from "@bflow/contracts";
import {
  DeveloperContinuationAllocationSchema,
  PaneBindingSchema,
  ResolvedRoleProfileSnapshotSchema,
  RoleProfilePinSchema,
  sameRoleProfilePin,
  ROLE_PROFILE_FEATURE,
  SessionManifestSchema,
  canonicalReceiptJson
} from "@bflow/contracts";

import type {
  CommandOutcome,
  DeveloperAllocationRequest,
  SpecialistAllocationRequest,
  SpecialistReleaseRequest,
  DeveloperReleaseOutcome,
  DeveloperReleaseRequest,
  HerdrAgentInfo,
  HerdrCommandRunner,
  HerdrPaneInfo,
  HerdrSocketPort,
  HerdrTabCreated,
  HerdrTabInfo,
  HerdrWorkspaceCreated,
  HerdrWorkspaceInfo,
  LaunchObservation,
  PaneMoveDestinationSpec,
  PermanentTopologyRole,
  RoleHealthReport,
  RolePaneManagerConfig,
  RoleSelector,
  RoleTopologySpec,
  SessionManifestStore,
  TopologyAnomaly,
  TopologyHealthSummary,
  TopologyRole,
  WorktreeInspector
} from "./types.js";
import type { AgentLaunchProfile } from "./types.js";
import { checkLaunchProfile } from "./launch-profile.js";
import { balanceOwnedTab } from "./layout.js";
import { readBuiltinRolePrompt } from "./role-prompts.js";
import { buildProviderRoleLaunch } from "./provider-launch.js";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import {
  AGENT_NAME_PATTERN,
  PERMANENT_TOPOLOGY_ROLES,
  ROLE_TOPOLOGY_SPECS,
  getRoleTopologySpec,
  isSupportedAgentKind,
  isValidAgentName,
  resolveTopologyRole
} from "./types.js";

import {
  HerdrProtocolError,
  createGitWorktreeInspector,
  createProcessRunner,
  isShellReadyForAgent,
  mapCommandFailure,
  parseAgentInfoResult,
  parseAgentListResult,
  parseOkResponse,
  parsePaneInfoResult,
  parsePaneListResult,
  parsePaneMoveResult,
  parsePaneProcessInfoResult,
  parseTabCreatedResult,
  parseTabInfoResult,
  parseTabListResult,
  parseWorkspaceCreatedResult,
  parseWorkspaceInfoResult,
  parseWorkspaceListResult,
  parseWorktreeCreatedResult,
  parseWorktreeRemovedResult
} from "./runner.js";

import { InMemorySessionManifestStore } from "./manifest-store.js";

function ok<T>(value: T): OperationResult<T> {
  return { ok: true, value };
}

const MAX_PERMANENT_STARTUP_CONCURRENCY = 4;

function validationError<T = never>(message: string, details?: unknown): OperationResult<T> {
  return {
    ok: false,
    error: {
      code: "validation",
      retryable: false,
      message,
      ...(details !== undefined && { details: details as any })
    }
  };
}

function conflictError<T = never>(message: string, details?: unknown): OperationResult<T> {
  return {
    ok: false,
    error: {
      code: "conflict",
      retryable: true,
      message,
      ...(details !== undefined && { details: details as any })
    }
  };
}

function notFoundError<T = never>(message: string, details?: unknown): OperationResult<T> {
  return {
    ok: false,
    error: {
      code: "not_found",
      retryable: false,
      message,
      ...(details !== undefined && { details: details as any })
    }
  };
}

function toCommandError<T = never>(outcome: CommandOutcome, fallbackMessage: string): OperationResult<T> {
  const err = mapCommandFailure(outcome);
  if (err !== null) {
    return { ok: false, error: err };
  }
  return {
    ok: false,
    error: {
      code: "transport_unavailable",
      retryable: true,
      message: fallbackMessage
    }
  };
}

function toProtocolError<T = never>(err: unknown, fallbackMessage: string): OperationResult<T> {
  if (err instanceof HerdrProtocolError) {
    if (err.kind === "malformed") {
      return {
        ok: false,
        error: {
          code: "corruption",
          retryable: false,
          message: err.message
        }
      };
    }
    if (err.kind === "remote") {
      return {
        ok: false,
        error: {
          code: "transport_unavailable",
          retryable: true,
          message: err.message
        }
      };
    }
  }
  return {
    ok: false,
    error: {
      code: "corruption",
      retryable: false,
      message: err instanceof Error ? err.message : fallbackMessage
    }
  };
}

export interface RolePaneManagerOptions {
  readonly config: RolePaneManagerConfig;
  readonly runner?: HerdrCommandRunner;
  readonly store?: SessionManifestStore;
  readonly worktreeInspector?: WorktreeInspector;
  /** Trusted host proof: permits metadata-only retirement of a stopped writer while retaining its dirty worktree and pane. */
  readonly authorizeStoppedRetainedRelease?: (binding: PaneBinding) => Promise<boolean>;
  /**
   * Herdr socket API. Required whenever a launch carries non-empty env: env is fixed at pane
   * creation (the `agent start` invocation env never reaches the provider), so such panes are
   * created through `workspace.create` / `tab.create` / `pane.split` with `env`.
   */
  readonly socket?: HerdrSocketPort;
  readonly clock?: () => Date;
  readonly defaultTimeoutMs?: number;
}

const PROMPT_FILE_MAX_BYTES = 131_072;

/** Launch env that must be applied when a pane is created; undefined when the launch has none. */
function launchEnvOf(launch: AgentLaunchProfile | undefined): Readonly<Record<string, string>> | undefined {
  return launch !== undefined && Object.keys(launch.env).length > 0 ? launch.env : undefined;
}

/** Validation message when an env-bearing pane creation is attempted without a configured socket port. */
const SOCKET_REQUIRED_MESSAGE = "A Herdr socket port is required to create panes with launch env";

/** True only for a regular, non-symlink file no larger than the prompt limit that contains `text`. */
async function regularFileContains(path: string, text: string, expectedJson = false, prefix = false): Promise<string | false> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > PROMPT_FILE_MAX_BYTES) return false;
    const content = await file.readFile("utf8");
    if (expectedJson) return content;
    return (prefix ? content.startsWith(text) : content.includes(text)) ? path : false;
  } catch {
    return false;
  } finally {
    await file.close();
  }
}

/**
 * Finds the provider prompt file that carries the original Bflow role prompt. Provider-neutral: a launch argv token
 * may name it directly (`--append-system-prompt-file <path>`, `key=<json path>`), or name a JSON settings file whose
 * `systemPromptFile` does. Returns the referenced prompt path, or undefined when the launch does not reference it.
 */
async function launchPromptSource(argv: readonly string[], prompt: string): Promise<string | undefined> {
  const candidates = new Set<string>();
  for (const token of argv) {
    candidates.add(token);
    const equals = token.indexOf("=");
    if (equals > 0) {
      const value = token.slice(equals + 1);
      candidates.add(value);
      try {
        const unquoted: unknown = JSON.parse(value);
        if (typeof unquoted === "string") candidates.add(unquoted);
      } catch {
        // Not a JSON string; the raw value candidate is enough.
      }
    }
  }
  const absolute = [...candidates].filter(candidate => isAbsolute(candidate));
  for (const candidate of absolute) {
    const matched = await regularFileContains(candidate, prompt);
    if (matched !== false) return matched;
  }
  for (const candidate of absolute) {
    const content = await regularFileContains(candidate, "", true);
    if (content === false) continue;
    let settings: unknown;
    try {
      settings = JSON.parse(content);
    } catch {
      continue;
    }
    const systemPromptFile = typeof settings === "object" && settings !== null && "systemPromptFile" in settings ? settings.systemPromptFile : undefined;
    if (typeof systemPromptFile !== "string" || !isAbsolute(systemPromptFile)) continue;
    const matched = await regularFileContains(systemPromptFile, prompt);
    if (matched !== false) return matched;
  }
  return undefined;
}

export class RolePaneManager {
  readonly #config: RolePaneManagerConfig;
  readonly #runner: HerdrCommandRunner;
  readonly #store: SessionManifestStore;
  readonly #worktreeInspector: WorktreeInspector;
  readonly #authorizeStoppedRetainedRelease: RolePaneManagerOptions["authorizeStoppedRetainedRelease"];
  readonly #socket: HerdrSocketPort | undefined;
  readonly #clock: () => Date;
  readonly #defaultTimeoutMs: number;
  #allocations: Promise<void> = Promise.resolve();

  #serializeAllocation<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.#allocations.then(action);
    this.#allocations = pending.then(() => undefined, () => undefined);
    return pending;
  }

  constructor(options: RolePaneManagerOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("RolePaneManagerOptions must be an object");
    }
    if (!options.config || typeof options.config !== "object") {
      throw new TypeError("RolePaneManagerConfig is required");
    }
    if (!options.config.sessionId || typeof options.config.sessionId !== "string") {
      throw new TypeError("RolePaneManagerConfig.sessionId is required");
    }
    if (!options.config.projectName || typeof options.config.projectName !== "string") {
      throw new TypeError("RolePaneManagerConfig.projectName is required");
    }
    if (!options.config.workspaceRoot || typeof options.config.workspaceRoot !== "string") {
      throw new TypeError("RolePaneManagerConfig.workspaceRoot is required");
    }

    this.#config = options.config;
    this.#runner = options.runner ?? createProcessRunner();
    this.#store = options.store ?? new InMemorySessionManifestStore();
    this.#worktreeInspector = options.worktreeInspector ?? createGitWorktreeInspector();
    this.#authorizeStoppedRetainedRelease = options.authorizeStoppedRetainedRelease;
    this.#socket = options.socket;
    this.#clock = options.clock ?? (() => new Date());
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  /**
   * Runs a Herdr CLI command. Never passes launch env: `agent start` types the provider command
   * into an existing shell, so env given to that invocation does not reach the provider.
   */
  async #runHerdr(args: readonly string[], options?: OperationOptions): Promise<CommandOutcome> {
    const timeoutMs = options?.timeoutMs ?? this.#defaultTimeoutMs;
    return this.#runner.run({
      args,
      cwd: this.#config.workspaceRoot,
      ...(options?.signal && { signal: options.signal }),
      ...(timeoutMs !== undefined && { timeoutMs })
    });
  }

  /** Validation error when any launch in the list needs env-at-creation but no socket port is configured. */
  #requireSocketFor(launches: readonly (AgentLaunchProfile | undefined)[]): OperationResult<void> {
    if (this.#socket === undefined && launches.some(launch => launchEnvOf(launch) !== undefined)) {
      return validationError(SOCKET_REQUIRED_MESSAGE);
    }
    return ok(undefined);
  }

  /** Creates a tab whose root pane is born with the launch env (CLI when the launch has none). */
  async #createTab(
    workspaceId: string,
    label: string,
    launch: AgentLaunchProfile | undefined,
    fallbackMessage: string,
    options?: OperationOptions
  ): Promise<OperationResult<HerdrTabCreated>> {
    const root = this.#config.workspaceRoot;
    return this.#herdrCreate<HerdrTabCreated>(
      {
        method: "tab.create",
        params: { workspace_id: workspaceId, cwd: root, label, focus: false },
        args: ["tab", "create", "--workspace", workspaceId, "--cwd", root, "--label", label, "--no-focus"]
      },
      launchEnvOf(launch),
      parseTabCreatedResult,
      fallbackMessage,
      options
    );
  }

  /** Splits a pane; the new pane is born with the launch env (CLI when the launch has none). */
  async #splitPane(
    sourcePaneId: string,
    direction: "right" | "down",
    cwd: string,
    launch: AgentLaunchProfile | undefined,
    fallbackMessage: string,
    options?: OperationOptions
  ): Promise<OperationResult<HerdrPaneInfo>> {
    return this.#herdrCreate<HerdrPaneInfo>(
      {
        method: "pane.split",
        params: { target_pane_id: sourcePaneId, direction, cwd, focus: false },
        args: ["pane", "split", sourcePaneId, "--direction", direction, "--cwd", cwd, "--no-focus"]
      },
      launchEnvOf(launch),
      parsePaneInfoResult,
      fallbackMessage,
      options
    );
  }

  /**
   * Creates a workspace, tab or split pane. Without env the existing CLI command is used unchanged.
   * With env the same operation runs through the Herdr socket API so the pane is born with env.
   * Errors never include env values: CLI failures are mapped from Herdr codes, socket failures from
   * their codes only.
   */
  async #herdrCreate<T>(
    request: { readonly method: "workspace.create" | "tab.create" | "pane.split"; readonly params: Record<string, unknown>; readonly args: readonly string[] },
    env: Readonly<Record<string, string>> | undefined,
    parse: (outcome: CommandOutcome) => T,
    fallbackMessage: string,
    options?: OperationOptions
  ): Promise<OperationResult<T>> {
    if (env === undefined) {
      const outcome = await this.#runHerdr(request.args, options);
      if (outcome.exitCode !== 0 || outcome.failure) return toCommandError(outcome, fallbackMessage);
      try {
        return ok(parse(outcome));
      } catch (err) {
        return toProtocolError(err, fallbackMessage);
      }
    }
    if (this.#socket === undefined) return validationError(SOCKET_REQUIRED_MESSAGE);
    const response = await this.#socket.request(request.method, { ...request.params, env: { ...env } }, options);
    if (!response.ok) return { ok: false, error: response.error };
    try {
      return ok(parse({ exitCode: 0, stdout: JSON.stringify({ result: response.value }), stderr: "" }));
    } catch (err) {
      return toProtocolError(err, fallbackMessage);
    }
  }

  async #closePane(paneId: string, options?: OperationOptions): Promise<void> {
    const outcome = await this.#runHerdr(["pane", "close", paneId], options);
    if (outcome.exitCode === 0 && !outcome.failure) {
      parseOkResponse(outcome);
    }
  }
  async #namePane(paneId: string, role: TopologyRole, agentName: string, options?: OperationOptions, roleProfile?: ResolvedRoleProfileSnapshot): Promise<OperationResult<void>> {
    const names: Record<TopologyRole, string> = { chat: "Chat · Conversation", coordinator: "Coordinator", planner: "Planner",
      analyst: "Analyst · Specification", architect: "Architect", reviewer: "Reviewer", "qa-verifier": "QA · Verifier", developer: `Developer · ${agentName}` };
    const outcome = await this.#runHerdr(["pane", "rename", paneId, roleProfile ? `${roleProfile.definition.displayName} · ${roleProfile.definition.baseRole} · ${roleProfile.pin.version} · ${roleProfile.pin.digest.slice(0, 12)}` : names[role]], options);
    if (outcome.exitCode !== 0 || outcome.failure) return toCommandError(outcome, `Could not label ${role} pane '${paneId}'`);
    parsePaneInfoResult(outcome); return ok(undefined);
  }
  async #startupBlocked(role: TopologyRole, agentName: string, kind: string, paneId: string, state: string, options?: OperationOptions): Promise<OperationResult<never>> {
    // Classify locally. Terminal snapshots can contain secrets; do not return or
    // log raw screens and never answer an update/trust/permission dialog here.
    const session = this.#config.sessionId;
    const inspected = await this.#runHerdr(["pane", "read", paneId, "--source", "detection", "--lines", "35"], options);
    const screen = inspected.exitCode === 0 ? inspected.stdout : "";
    const reason = /updat(?:e|ing).{0,50}(?:cli|codex|available)|(?:cli|codex).{0,50}updat|new version available/is.test(screen)
      ? "CLI update confirmation is waiting for your choice"
      : /trust.{0,50}(?:folder|directory|repo)|safety check/is.test(screen) ? "Repository trust confirmation is waiting for your choice"
      : /sign.?in|log.?in|authenticat/is.test(screen) ? "Provider sign-in is required in this pane"
      : "An interactive dialog or provider startup is waiting in this pane";
    return conflictError(`${role} (${agentName}, ${kind}) in pane '${paneId}' is ${state}. ${reason}.\n` +
      `Open this exact session: herdr --session ${session} session attach ${session}\n` +
      `Select pane ${paneId} (${role}), resolve the dialog, then rerun bflow up.\n` +
      `Inspect: herdr --session ${session} pane read ${paneId} --source detection --lines 35\n` +
      "To stop safely: bflow down --yes. State and panes were preserved; do not delete .bflow.",
      { role, agentName, provider: kind, paneId, sessionId: session, reason,
        remediation: ["Resolve the interactive dialog in the named session", "bflow up", "bflow down --yes"] });
  }

  async initializeTopology(options?: OperationOptions): Promise<OperationResult<SessionManifest>> {
    try {
      return await this.#reconcileTopologyInternal(false, options);
    } catch (err) {
      return toProtocolError(err, "Failed to initialize topology");
    }
  }

  async reconcileTopology(options?: OperationOptions): Promise<OperationResult<SessionManifest>> {
    try {
      return await this.#reconcileTopologyInternal(true, options);
    } catch (err) {
      return toProtocolError(err, "Failed to reconcile topology");
    }
  }

  async shutdownTopology(options?: OperationOptions): Promise<OperationResult<SessionManifest>> {
    try {
      const loadResult = await this.#store.load(this.#config.sessionId, options);
      if (!loadResult.ok) return loadResult;
      const manifest = loadResult.value;
      if (!manifest) {
        return notFoundError(`Session manifest not found for session '${this.#config.sessionId}'`);
      }

      // A prior down may have closed panes or their entire workspace before
      // losing an acknowledgement. Reconcile every recorded workspace, including
      // Developer workspaces, before closing any remaining owned pane.
      const livePaneIds = new Set<string>();
      const workspaceIds = new Set([manifest.herdrWorkspaceId, ...manifest.panes.map(pane => pane.workspaceId)]);
      for (const workspaceId of workspaceIds) {
        const listed = await this.#runHerdr(["pane", "list", "--workspace", workspaceId], options);
        if (listed.exitCode !== 0 || listed.failure) {
          const failure = toCommandError(listed, "Cannot reconcile panes before shutdown");
          if (failure.ok || failure.error.code !== "not_found") return failure;
          // A not_found response alone is insufficient: confirm the workspace is
          // absent using a fresh successful listing. Uncertain/malformed reads or
          // a contradictory listing preserve the manifest for another attempt.
          const workspaces = await this.#runHerdr(["workspace", "list"], options);
          if (workspaces.exitCode !== 0 || workspaces.failure) {
            return toCommandError(workspaces, "Cannot confirm workspace absence before shutdown");
          }
          if (parseWorkspaceListResult(workspaces).some(workspace => workspace.workspaceId === workspaceId)) {
            return failure;
          }
          continue;
        }
        for (const pane of parsePaneListResult(listed)) {
          if (pane.workspaceId !== workspaceId) {
            return conflictError(`Pane listing does not match workspace '${workspaceId}'; shutdown state preserved`);
          }
          livePaneIds.add(pane.paneId);
        }
      }
      // Herdr refuses to close the source workspace's last pane while a linked worktree workspace is still open
      // ("would close a worktree group"), so Developer worktree panes close first.
      const closeOrder = [...manifest.panes.filter(pane => pane.role === "developer"), ...manifest.panes.filter(pane => pane.role !== "developer")];
      for (const pane of closeOrder) {
        if (!livePaneIds.has(pane.paneId)) continue;
        const outcome = await this.#runHerdr(["pane", "close", pane.paneId], options);
        if (outcome.exitCode !== 0 || outcome.failure) {
          return toCommandError(outcome, `Shutdown did not confirm closure of pane '${pane.paneId}'`);
        }
        parseOkResponse(outcome);
      }

      const nowIso = this.#clock().toISOString();
      const updatedPanes: PaneBinding[] = manifest.panes.map((p) => ({
        ...p,
        transportState: "cancelled" as AgentTransportState,
        lastHeartbeatAt: nowIso
      }));

      const updatedManifest: SessionManifest = {
        ...manifest,
        status: "down",
        panes: updatedPanes,
        updatedAt: nowIso
      };

      const parsedManifest = SessionManifestSchema.safeParse(updatedManifest);
      if (!parsedManifest.success) {
        return validationError(
          `Failed to validate shutdown session manifest: ${parsedManifest.error.message}`,
          parsedManifest.error.issues
        );
      }

      const saveResult = await this.#store.save(parsedManifest.data, options);
      if (!saveResult.ok) return saveResult;

      return ok(saveResult.value);
    } catch (err) {
      return toProtocolError(err, "Failed to shutdown topology");
    }
  }

  async #reconcileTopologyInternal(
    _isReconcile: boolean,
    options?: OperationOptions
  ): Promise<OperationResult<SessionManifest>> {
    // Validate env-at-creation requirements before any Herdr or store side effect.
    const configuredRoles: readonly PermanentTopologyRole[] = this.#config.permanentRoles ?? PERMANENT_TOPOLOGY_ROLES;
    // Concurrent uniqueness checks cannot reserve a name. Reject configured
    // collisions before topology side effects rather than racing two starts.
    const configuredNames = new Set<string>();
    for (const role of configuredRoles) {
      const name = this.#config.roleConfigs?.[role]?.agentName ?? ROLE_TOPOLOGY_SPECS[role].defaultAgentName;
      if (configuredNames.has(name)) return conflictError(`Permanent agent name '${name}' is configured for multiple roles`);
      configuredNames.add(name);
    }
    const socketCheck = this.#requireSocketFor(configuredRoles.map(role => this.#config.roleConfigs?.[role]?.launch));
    if (!socketCheck.ok) return socketCheck;
    // Panes created by this run with launch env, mapped to the launchId they were created for.
    // Env-bearing roles may only occupy a pane recorded for their own launch.
    const envPaneLaunch = new Map<string, string>();
    // A tab's root pane is born with the env of the first env-bearing permanent role in that tab.
    const launchForTab = (tabKey: RoleTopologySpec["tabKey"]): AgentLaunchProfile | undefined =>
      configuredRoles
        .filter(role => ROLE_TOPOLOGY_SPECS[role].tabKey === tabKey)
        .map(role => this.#config.roleConfigs?.[role]?.launch)
        .find(launch => launchEnvOf(launch) !== undefined);

    const loadResult = await this.#store.load(this.#config.sessionId, options);
    if (!loadResult.ok) return loadResult;
    const savedManifest = loadResult.value;

    // Step 1: Workspace
    const wsListOutcome = await this.#runHerdr(["workspace", "list"], options);
    if (wsListOutcome.exitCode !== 0 || wsListOutcome.failure) {
      return toCommandError(wsListOutcome, "Failed to list Herdr workspaces");
    }
    const workspaces: readonly HerdrWorkspaceInfo[] = parseWorkspaceListResult(wsListOutcome);

    let herdrWorkspaceId: string | null = null;
    let initialConversationTabId: string | null = null;
    let initialConversationRootPaneId: string | null = null;

    const matchedWorkspace = workspaces.find((w) =>
      (savedManifest !== null && w.workspaceId === savedManifest.herdrWorkspaceId) ||
      w.label === this.#config.projectName ||
      w.worktree?.checkoutPath === this.#config.workspaceRoot
    );

    if (matchedWorkspace) {
      herdrWorkspaceId = matchedWorkspace.workspaceId;
    } else {
      // The initial root pane is created with the Conversation launch env when Conversation has one.
      const chatLaunch = this.#config.roleConfigs?.chat?.launch;
      const chatEnv = launchEnvOf(chatLaunch);
      const created = await this.#herdrCreate<HerdrWorkspaceCreated>(
        {
          method: "workspace.create",
          params: { cwd: this.#config.workspaceRoot, label: this.#config.projectName, focus: false },
          args: ["workspace", "create", "--cwd", this.#config.workspaceRoot, "--label", this.#config.projectName, "--no-focus"]
        },
        chatEnv,
        parseWorkspaceCreatedResult,
        `Failed to create workspace '${this.#config.projectName}'`,
        options
      );
      if (!created.ok) return created;
      const wsCreated = created.value;
      herdrWorkspaceId = wsCreated.workspace.workspaceId;
      initialConversationTabId = wsCreated.tab.tabId;
      initialConversationRootPaneId = wsCreated.rootPane.paneId;
      if (chatLaunch !== undefined && chatEnv !== undefined) envPaneLaunch.set(wsCreated.rootPane.paneId, chatLaunch.launchId);
    }

    // Step 2: Tabs & Panes for Permanent Roles
    const tabListOutcome = await this.#runHerdr(["tab", "list", "--workspace", herdrWorkspaceId], options);
    if (tabListOutcome.exitCode !== 0 || tabListOutcome.failure) {
      return toCommandError(tabListOutcome, `Failed to list tabs for workspace '${herdrWorkspaceId}'`);
    }
    let liveTabs: readonly HerdrTabInfo[] = parseTabListResult(tabListOutcome);

    const paneListOutcome = await this.#runHerdr(["pane", "list", "--workspace", herdrWorkspaceId], options);
    if (paneListOutcome.exitCode !== 0 || paneListOutcome.failure) {
      return toCommandError(paneListOutcome, `Failed to list panes for workspace '${herdrWorkspaceId}'`);
    }
    let livePanes: readonly HerdrPaneInfo[] = parsePaneListResult(paneListOutcome);

    const agentListOutcome = await this.#runHerdr(["agent", "list"], options);
    if (agentListOutcome.exitCode !== 0 || agentListOutcome.failure) {
      return toCommandError(agentListOutcome, "Failed to list agents");
    }
    let liveAgents: readonly HerdrAgentInfo[] = parseAgentListResult(agentListOutcome);

    const convLabel = this.#config.tabLabels?.conversation ?? "conversation";
    const coordLabel = this.#config.tabLabels?.coordination ?? "coordination";
    const verifLabel = this.#config.tabLabels?.verification ?? "verification";

    // 2.1 Ensure Conversation Tab
    let convTab = liveTabs.find(
      (t) =>
        t.tabId === initialConversationTabId ||
        t.label === convLabel ||
        (savedManifest !== null && t.tabId === savedManifest.herdrTabId)
    );
    if (!convTab && liveTabs.length > 0) {
      const firstTab = liveTabs[0];
      if (
        firstTab !== undefined &&
        firstTab.label !== coordLabel &&
        firstTab.label !== "coordination" &&
        firstTab.label !== verifLabel &&
        firstTab.label !== "verification"
      ) {
        convTab = firstTab;
      }
    }
    if (!convTab) {
      const convLaunch = launchForTab("conversation");
      const createdConv = await this.#createTab(herdrWorkspaceId, convLabel, convLaunch, "Failed to create conversation tab", options);
      if (!createdConv.ok) return createdConv;
      convTab = createdConv.value.tab;
      liveTabs = [...liveTabs, convTab];
      livePanes = [...livePanes, createdConv.value.rootPane];
      if (convLaunch !== undefined && launchEnvOf(convLaunch) !== undefined) envPaneLaunch.set(createdConv.value.rootPane.paneId, convLaunch.launchId);
    }
    const finalConversationTabId = convTab.tabId;
    if (convTab.label !== convLabel) {
      const renamed = await this.#runHerdr(["tab", "rename", convTab.tabId, convLabel], options);
      if (renamed.exitCode !== 0 || renamed.failure) return toCommandError(renamed, "Could not name the Conversation tab");
      parseTabInfoResult(renamed);
    }

    const configuredPermanentRoles: readonly PermanentTopologyRole[] =
      this.#config.permanentRoles ?? PERMANENT_TOPOLOGY_ROLES;

    const hasCoordRoles = configuredPermanentRoles.some((r) => ROLE_TOPOLOGY_SPECS[r].tabKey === "coordination");
    const hasVerifRoles = configuredPermanentRoles.some((r) => ROLE_TOPOLOGY_SPECS[r].tabKey === "verification");

    // 2.2 Ensure Coordination Tab only when needed
    let finalCoordinationTabId: string | null = null;
    if (hasCoordRoles) {
      let coordTab = liveTabs.find((t) => t.label === coordLabel || t.label === "coordination");
      if (!coordTab) {
        const coordLaunch = launchForTab("coordination");
        const createdCoord = await this.#createTab(herdrWorkspaceId, coordLabel, coordLaunch, "Failed to create coordination tab", options);
        if (!createdCoord.ok) return createdCoord;
        coordTab = createdCoord.value.tab;
        liveTabs = [...liveTabs, coordTab];
        livePanes = [...livePanes, createdCoord.value.rootPane];
        if (coordLaunch !== undefined && launchEnvOf(coordLaunch) !== undefined) envPaneLaunch.set(createdCoord.value.rootPane.paneId, coordLaunch.launchId);
      }
      finalCoordinationTabId = coordTab.tabId;
    }

    // 2.3 Ensure Verification Tab only when needed
    let finalVerificationTabId: string | null = null;
    if (hasVerifRoles) {
      let verifTab = liveTabs.find((t) => t.label === verifLabel || t.label === "verification");
      if (!verifTab) {
        const verifLaunch = launchForTab("verification");
        const createdVerif = await this.#createTab(herdrWorkspaceId, verifLabel, verifLaunch, "Failed to create verification tab", options);
        if (!createdVerif.ok) return createdVerif;
        verifTab = createdVerif.value.tab;
        liveTabs = [...liveTabs, verifTab];
        livePanes = [...livePanes, createdVerif.value.rootPane];
        if (verifLaunch !== undefined && launchEnvOf(verifLaunch) !== undefined) envPaneLaunch.set(createdVerif.value.rootPane.paneId, verifLaunch.launchId);
      }
      finalVerificationTabId = verifTab.tabId;
    }

    const assignedPaneIds = new Set<string>();
    const splitDepths = new Map(livePanes.map(pane => [pane.paneId, 0]));
    const manifestPanes: PaneBinding[] = [];
    const startups: { readonly role: PermanentTopologyRole; readonly pending: PaneBinding }[] = [];
    const persistProgress = async (binding: PaneBinding): Promise<OperationResult<SessionManifest>> => {
      const panes = [...manifestPanes.filter(p => p.paneId !== binding.paneId), binding];
      for (const previous of savedManifest?.panes ?? []) {
        if (!panes.some(p => p.paneId === previous.paneId || p.role === previous.role && p.permanent !== false && previous.permanent !== false)) panes.push(previous);
      }
      const conversation = panes.find(p => p.role === "conversation");
      return this.#store.save(SessionManifestSchema.parse({
        schemaVersion: 2, sessionId: this.#config.sessionId, projectName: this.#config.projectName,
        workspaceRoot: this.#config.workspaceRoot, herdrWorkspaceId, herdrTabId: finalConversationTabId,
        status: "initializing", conversationSessionId: this.#config.conversationSessionId ?? savedManifest?.conversationSessionId ?? `conv-${this.#config.sessionId}`,
        activeRunIds: savedManifest?.activeRunIds ?? [], panes,
        ...(savedManifest?.roleProfiles ? { roleProfiles: savedManifest.roleProfiles } : {}),
        attachTarget: { role: "conversation", paneId: conversation?.paneId ?? binding.paneId },
        createdAt: savedManifest?.createdAt ?? this.#clock().toISOString(), updatedAt: this.#clock().toISOString(),
        metadata: { ...savedManifest?.metadata, startupPending: true }
      }), options);
    };

    for (const role of configuredPermanentRoles) {
      const spec = ROLE_TOPOLOGY_SPECS[role];
      const roleConfig = this.#config.roleConfigs?.[role];
      const agentName = roleConfig?.agentName ?? spec.defaultAgentName;
      const agentKind = roleConfig?.agentKind ?? this.#config.defaultAgentKind ?? "codex";

      let targetTabId: string;
      if (spec.tabKey === "conversation") {
        targetTabId = finalConversationTabId;
      } else if (spec.tabKey === "coordination") {
        if (!finalCoordinationTabId) {
          return validationError("Coordination tab was not initialized");
        }
        targetTabId = finalCoordinationTabId;
      } else {
        if (!finalVerificationTabId) {
          return validationError("Verification tab was not initialized");
        }
        targetTabId = finalVerificationTabId;
      }

      // Check if role is already healthy in Herdr
      const savedBinding = savedManifest?.panes.find(
        (p) => p.role === spec.contractRole && (p.metadata?.["topologyRole"] === role || p.agentId === agentName)
      );

      // Env is fixed at pane creation: an env-bearing launch may only reuse a pane recorded for that exact launch.
      const launch = roleConfig?.launch;
      const env = launchEnvOf(launch);
      const reusable = env === undefined || savedBinding?.metadata?.["launchId"] === launch?.launchId;
      const staleBinding = env !== undefined && savedBinding !== undefined && !reusable ? savedBinding : undefined;

      let healthyOccupant: HerdrAgentInfo | null = null;
      if (savedBinding && reusable) {
        const liveOccupant = liveAgents.find(
          (a) =>
            a.name === agentName &&
            a.agent === agentKind &&
            (a.paneId === savedBinding.paneId || a.tabId === targetTabId)
        );
        if (
          liveOccupant &&
          (liveOccupant.agentStatus === "idle" ||
            liveOccupant.agentStatus === "done" ||
            liveOccupant.agentStatus === "working") &&
          liveOccupant.interactiveReady !== false &&
          liveOccupant.launchPending !== true
        ) {
          healthyOccupant = liveOccupant;
        }
      }

      if (!healthyOccupant && reusable) {
        const match = liveAgents.find(
          (a) =>
            a.name === agentName &&
            a.agent === agentKind &&
            a.tabId === targetTabId &&
            (a.agentStatus === "idle" || a.agentStatus === "done" || a.agentStatus === "working") &&
            a.interactiveReady !== false &&
            a.launchPending !== true &&
            !assignedPaneIds.has(a.paneId)
        );
        if (match) {
          healthyOccupant = match;
        }
      }

      if (healthyOccupant) {
        if (savedBinding?.session && healthyOccupant.session && savedManifest?.status !== "down" &&
            savedBinding.paneId === healthyOccupant.paneId &&
            (savedBinding.session.source !== healthyOccupant.session.source || savedBinding.session.kind !== healthyOccupant.session.kind || savedBinding.session.value !== healthyOccupant.session.value))
          return conflictError(`Native session changed for ${role} in pane '${healthyOccupant.paneId}'; refusing to adopt it as the old role execution. Preserve work, inspect bflow doctor, and use bflow down --yes before a fresh startup.`);
        const named = await this.#namePane(healthyOccupant.paneId, role, agentName, options);
        if (!named.ok) return named;
        assignedPaneIds.add(healthyOccupant.paneId);
        const bindingResult = this.#buildAndValidateBinding({
          spec,
          agentInfo: healthyOccupant,
          request: {
            role,
            paneId: healthyOccupant.paneId,
            workspaceId: healthyOccupant.workspaceId,
            tabId: healthyOccupant.tabId,
            cwd: this.#config.workspaceRoot,
            permanent: true, ...(savedBinding?.metadata ? { metadata: savedBinding.metadata } : {})
          },
          agentName,
          agentKind
        });
        if (!bindingResult.ok) return bindingResult;
        manifestPanes.push(bindingResult.value);
        const progress = await persistProgress(bindingResult.value);
        if (!progress.ok) return progress;
        continue;
      }

      // A known pending/blocked occupant is a recovery boundary, not queued new
      // work. Refuse it before dispatching any of the other reserved role panes.
      const pendingOccupant = savedBinding && reusable
        ? liveAgents.find(agent => agent.paneId === savedBinding.paneId && agent.name === agentName && agent.agent === agentKind)
        : undefined;
      if (pendingOccupant && (pendingOccupant.agentStatus === "blocked" || pendingOccupant.agentStatus === "unknown" ||
          pendingOccupant.launchPending === true || pendingOccupant.interactiveReady === false)) {
        return this.#startupBlocked(spec.topologyRole, agentName, agentKind, pendingOccupant.paneId,
          "launch pending or interactive not ready", options);
      }

      // Otherwise, obtain an available shell pane in targetTabId
      let candidatePane: HerdrPaneInfo | null = null;
      // A recorded launch intent owns its pane even if startup is blocked or its
      // acknowledgement was lost. Inspect it in place; never split a duplicate.
      if (savedBinding && reusable) candidatePane = livePanes.find(p => p.paneId === savedBinding.paneId && p.tabId === targetTabId) ?? null;
      if (env !== undefined) {
        // Only a pane created by this run for this exact launch can carry its env; unbound shells cannot prove theirs.
        if (!candidatePane) {
          candidatePane = livePanes.find(p => envPaneLaunch.get(p.paneId) === launch?.launchId && p.tabId === targetTabId &&
            p.agent === null && !assignedPaneIds.has(p.paneId)) ?? null;
        }
      } else {
        if (!candidatePane && initialConversationRootPaneId && targetTabId === finalConversationTabId && !assignedPaneIds.has(initialConversationRootPaneId) &&
          !envPaneLaunch.has(initialConversationRootPaneId)) {
          const p = livePanes.find((item) => item.paneId === initialConversationRootPaneId);
          if (p && p.agent === null) {
            candidatePane = p;
          }
        }

        if (!candidatePane) {
          candidatePane =
            livePanes.find(
              (p) =>
                p.tabId === targetTabId &&
                p.agent === null &&
                !assignedPaneIds.has(p.paneId) &&
                !envPaneLaunch.has(p.paneId)
            ) ?? null;
        }
      }

      let selectedPaneId: string;
      if (candidatePane) {
        selectedPaneId = candidatePane.paneId;
      } else {
        // Split existing pane in targetTabId
        const sourcePane = livePanes.filter(p => p.tabId === targetTabId)
          .sort((a, b) => (splitDepths.get(a.paneId) ?? 0) - (splitDepths.get(b.paneId) ?? 0))[0];
        if (!sourcePane) {
          return validationError(`No pane available to split in tab '${targetTabId}'`);
        }
        const depth = splitDepths.get(sourcePane.paneId) ?? 0;
        const direction = roleConfig?.splitDirection ?? (depth % 2 === 0 ? "right" : "down");
        // The new pane is created before a stale pane is closed, so the tab never loses its last pane.
        const split = await this.#splitPane(sourcePane.paneId, direction, this.#config.workspaceRoot, launch,
          `Failed to split pane from '${sourcePane.paneId}'`, options);
        if (!split.ok) return split;
        const splitResult = split.value;
        selectedPaneId = splitResult.paneId;
        splitDepths.set(sourcePane.paneId, depth + 1); splitDepths.set(selectedPaneId, depth + 1);
        livePanes = [...livePanes, splitResult];
        if (env !== undefined && launch !== undefined) envPaneLaunch.set(selectedPaneId, launch.launchId);
      }

      // Close the Bflow-owned role pane whose env belongs to a different launch; it is never reused.
      if (staleBinding !== undefined && staleBinding.paneId !== selectedPaneId && livePanes.some(p => p.paneId === staleBinding.paneId)) {
        await this.#closePane(staleBinding.paneId, options);
        livePanes = livePanes.filter(p => p.paneId !== staleBinding.paneId);
      }

      assignedPaneIds.add(selectedPaneId);

      const pending = this.#buildAndValidateBinding({ spec, agentName, agentKind,
        agentInfo: { name: agentName, agent: agentKind, paneId: selectedPaneId,
          terminalId: livePanes.find(p => p.paneId === selectedPaneId)!.terminalId,
          workspaceId: herdrWorkspaceId, tabId: targetTabId, focused: false, agentStatus: "unknown", revision: 0 },
        request: { role, paneId: selectedPaneId, workspaceId: herdrWorkspaceId, tabId: targetTabId,
          cwd: this.#config.workspaceRoot, permanent: true,
          metadata: { launchIntent: true, launchQueued: true, ...(launch !== undefined ? { launchId: launch.launchId, launchFingerprint: launch.launchFingerprint } : {}) } } });
      if (!pending.ok) return pending;
      manifestPanes.push(pending.value);
      const intentSaved = await persistProgress(pending.value);
      if (!intentSaved.ok) return intentSaved;
      startups.push({ role, pending: pending.value });
    }

    // Pane allocation is ordered. Only independent startup observations and agent
    // launches overlap; every queued role is already represented in durable state.
    // Serialize binding replacement and the corresponding snapshot write together.
    let publications: Promise<void> = Promise.resolve();
    const publish = (binding: PaneBinding): Promise<OperationResult<SessionManifest>> => {
      const write = publications.then(async () => {
        const index = manifestPanes.findIndex(pane => pane.paneId === binding.paneId);
        manifestPanes[index] = binding;
        return persistProgress(binding);
      });
      publications = write.then(() => undefined, () => undefined);
      return write;
    };
    let nextStartup = 0;
    const failures = new Map<number, ContractError>();
    const hasHostAgyStartup = startups.some(({ role, pending }) =>
      pending.agentKind === "agy" && Boolean(this.#config.roleConfigs?.[role]?.launch?.env?.["HOME"]));
    const startupConcurrency = hasHostAgyStartup ? 2 : MAX_PERMANENT_STARTUP_CONCURRENCY;
    await Promise.all(Array.from({ length: Math.min(startupConcurrency, startups.length) }, async () => {
      while (failures.size === 0 && nextStartup < startups.length) {
        const index = nextStartup++;
        if (options?.signal?.aborted) {
          failures.set(index, { code: "cancelled", retryable: false, message: "Role startup interrupted; queued launch intents preserved" });
          break;
        }
        const { role, pending } = startups[index]!;
        try {
          // Distinguish untouched queued work from an attempted dispatch. A lost
          // agent.start acknowledgement keeps this exact intent for reconciliation.
          const intent = await publish({ ...pending, metadata: { ...pending.metadata, launchQueued: false } });
          if (!intent.ok) { failures.set(index, intent.error); break; }
          // This worker may have waited behind a failed publication. Its grant
          // does not permit a new launch after failure or cancellation is known.
          if (failures.size > 0) break;
          if (options?.signal?.aborted) {
            failures.set(index, { code: "cancelled", retryable: false, message: "Role startup interrupted; queued launch intents preserved" });
            break;
          }
          const started = await this.startAgentInPane({
            role, paneId: pending.paneId, workspaceId: pending.workspaceId, tabId: pending.tabId,
            cwd: this.#config.workspaceRoot, agentName: pending.agentId, agentKind: pending.agentKind!, permanent: true
          }, options);
          if (!started.ok) { failures.set(index, started.error); break; }
          let currentBinding = started.value;
          const roleLaunch = this.#config.roleConfigs?.[role]?.launch;
          if (currentBinding.agentKind === "agy" && Boolean(roleLaunch?.env?.["HOME"]) && !currentBinding.session) {
            const settleDeadline = Math.min(
              this.#clock().getTime() + 8_000,
              options?.deadline !== undefined ? Date.parse(options.deadline) - 5_000 : Infinity
            );
            while (!options?.signal?.aborted && this.#clock().getTime() < settleDeadline) {
              await new Promise(resolve => setTimeout(resolve, 400));
              const agentGet = await this.#runHerdr(["agent", "get", currentBinding.paneId], options);
              if (agentGet.exitCode !== 0 || agentGet.failure) break;
              let info: HerdrAgentInfo;
              try { info = parseAgentInfoResult(agentGet, "agent_info"); } catch { break; }
              if (info.session) {
                currentBinding = {
                  ...currentBinding,
                  session: info.session,
                  transportState: info.agentStatus as AgentTransportState,
                  metadata: { ...currentBinding.metadata, nativeSessionPending: false }
                };
                break;
              }
              if (info.agentStatus !== "working") {
                break;
              }
            }
          }
          const saved = await publish(currentBinding);
          if (!saved.ok) { failures.set(index, saved.error); break; }
        } catch (error) {
          const failed = toProtocolError(error, `Failed to start permanent role '${role}'`);
          if (!failed.ok) failures.set(index, failed.error);
        }
      }
    }));
    await publications;
    // Returning only after all workers/publications drain prevents cleanup from
    // racing a late launch or manifest write. Failure priority is role order.
    for (let index = 0; index < startups.length; index++) {
      const error = failures.get(index);
      if (error) return { ok: false, error };
    }

    // Preserve any existing active/released developer panes
    if (savedManifest) {
      for (const p of savedManifest.panes) {
        if ((p.role === "developer" || p.roleProfile) && !assignedPaneIds.has(p.paneId)) {
          manifestPanes.push(p);
          assignedPaneIds.add(p.paneId);
        }
      }
    }

    for (const tabId of new Set(manifestPanes.filter(p => p.permanent).map(p => p.tabId))) {
      await balanceOwnedTab(args => this.#runHerdr(args, options), herdrWorkspaceId, tabId, manifestPanes.filter(p => p.tabId === tabId).map(p => p.paneId));
    }
    // Step 3: Focus Conversation Pane
    const chatBinding = manifestPanes.find((p) => p.role === "conversation");
    if (!chatBinding) {
      return validationError("Cannot complete topology without conversation (chat) pane");
    }

    const wsFocusOutcome = await this.#runHerdr(["workspace", "focus", herdrWorkspaceId], options);
    if (wsFocusOutcome.exitCode !== 0 || wsFocusOutcome.failure) {
      return toCommandError(wsFocusOutcome, `Failed to focus workspace '${herdrWorkspaceId}'`);
    }
    parseWorkspaceInfoResult(wsFocusOutcome);

    const tabFocusOutcome = await this.#runHerdr(["tab", "focus", chatBinding.tabId], options);
    if (tabFocusOutcome.exitCode !== 0 || tabFocusOutcome.failure) {
      return toCommandError(tabFocusOutcome, `Failed to focus tab '${chatBinding.tabId}'`);
    }
    parseTabInfoResult(tabFocusOutcome);

    const agentFocusOutcome = await this.#runHerdr(["agent", "focus", chatBinding.paneId], options);
    if (agentFocusOutcome.exitCode !== 0 || agentFocusOutcome.failure) {
      return toCommandError(agentFocusOutcome, `Failed to focus agent in pane '${chatBinding.paneId}'`);
    }
    parseAgentInfoResult(agentFocusOutcome, "agent_info");

    // Step 4: Persist Manifest
    const coordinatorBinding = manifestPanes.find((p) => p.role === "coordinator");
    // Runtime-owned panes (Developers, profiled specialists) are reconciled by Runtime after activation; see startupPanesHealthy.
    const allHealthy = startupPanesHealthy(manifestPanes);
    const status: SessionManifestStatus = (allHealthy && chatBinding && coordinatorBinding) ? "up" : "degraded";

    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessionId: this.#config.sessionId,
      projectName: this.#config.projectName,
      workspaceRoot: this.#config.workspaceRoot,
      herdrWorkspaceId,
      herdrTabId: finalConversationTabId,
      status,
      conversationSessionId:
        this.#config.conversationSessionId ?? savedManifest?.conversationSessionId ?? `conv-${this.#config.sessionId}`,
      activeRunIds: savedManifest?.activeRunIds ?? [],
      panes: manifestPanes,
      ...(savedManifest?.roleProfiles ? { roleProfiles: savedManifest.roleProfiles } : {}),
      attachTarget: {
        role: "conversation",
        paneId: chatBinding.paneId,
        ...(chatBinding.terminalId !== undefined ? { terminalId: chatBinding.terminalId } : {})
      },
      createdAt: savedManifest?.createdAt ?? this.#clock().toISOString(),
      updatedAt: this.#clock().toISOString(),
      metadata: { ...savedManifest?.metadata, startupPending: false, panePresentationVersion: 1 }
    };

    const parsedManifest = SessionManifestSchema.safeParse(manifest);
    if (!parsedManifest.success) {
      return validationError(`Failed to create valid SessionManifest: ${parsedManifest.error.message}`, parsedManifest.error.issues);
    }

    const saveResult = await this.#store.save(parsedManifest.data, options);
    if (!saveResult.ok) {
      return saveResult;
    }

    return ok(saveResult.value);
  }

  async startAgentInPane(
    request: {
      readonly role: RoleSelector;
      readonly roleProfile?: ResolvedRoleProfileSnapshot;
      readonly paneId: string;
      readonly workspaceId: string;
      readonly tabId: string;
      readonly cwd: string;
      readonly worktreePath?: string;
      readonly agentName?: string;
      readonly agentKind?: string;
      readonly model?: string;
      readonly args?: readonly string[];
      readonly launch?: AgentLaunchProfile;
      readonly timeoutMs?: number;
      readonly permanent?: boolean;
      readonly metadata?: Record<string, unknown>;
    },
    options?: OperationOptions
  ): Promise<OperationResult<PaneBinding>> {
    try {
      const spec = getRoleTopologySpec(request.role);
      if (!spec) {
        return validationError(`Unsupported role selector: ${request.role}`);
      }

      const roleConfig = this.#config.roleConfigs?.[spec.topologyRole];
      const startupTimeoutMs = request.timeoutMs ?? roleConfig?.startupTimeoutMs ?? 60000;
      if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0)
        return validationError("Agent startup timeout must be a positive safe integer in milliseconds");
      if (options?.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0))
        return validationError("Operation timeout must be a positive safe integer in milliseconds");
      const deadline = options?.deadline === undefined ? Infinity : Date.parse(options.deadline);
      if (Number.isNaN(deadline)) return validationError("Operation deadline must be a valid timestamp");
      const operationDeadline = Math.min(deadline, options?.timeoutMs === undefined ? Infinity : this.#clock().getTime() + options.timeoutMs);
      const launchBudget = (): OperationResult<number> => {
        if (options?.signal?.aborted)
          return { ok: false, error: { code: "cancelled", retryable: false, message: "Agent startup interrupted; state preserved." } };
        // Herdr protocol 22 accepts integer readiness waits in (3000, 300000].
        const timeoutMs = Math.floor(Math.min(startupTimeoutMs, 300000, operationDeadline - this.#clock().getTime()));
        if (timeoutMs <= 3000)
          return { ok: false, error: { code: "timeout", retryable: true, retrySafety: "not_started",
            message: "Agent was not started: the remaining startup budget must exceed 3000ms. Increase the configured startup timeout or lifecycle timeout and retry.",
            details: { started: false } } };
        return ok(timeoutMs);
      };
      const initialBudget = launchBudget();
      if (!initialBudget.ok) return initialBudget;
      const agentName = request.agentName ?? roleConfig?.agentName ?? spec.defaultAgentName;
      if (!isValidAgentName(agentName)) {
        return validationError(
          `Invalid agent name '${agentName}'. Agent names must match ${AGENT_NAME_PATTERN}`
        );
      }

      const agentKind = request.agentKind ?? roleConfig?.agentKind ?? this.#config.defaultAgentKind ?? "codex";
      if (typeof agentKind !== "string" || agentKind.length === 0 || !isSupportedAgentKind(agentKind)) {
        return validationError(`Unsupported or invalid agent kind '${agentKind}'`);
      }

      // Launch profiles are validated before any Herdr side effect.
      const launch = request.launch ?? roleConfig?.launch;
      if (launch !== undefined) {
        const problem = checkLaunchProfile(launch, agentKind);
        if (problem) return validationError(problem.message);
      }
      const profileCheck = await this.#validateRoleProfileLaunch(request.roleProfile, spec.contractRole, launch, agentKind);
      if (!profileCheck.ok) return profileCheck;
      // The caller cannot bind a different profile to an already running native context.
      if (request.roleProfile) {
        const stored = await this.#store.load(this.#config.sessionId, options);
        if (!stored.ok) return stored;
        const previous = stored.value?.panes.find(pane => pane.paneId === request.paneId);
        if (previous && (!sameRoleProfilePin(previous.roleProfile, request.roleProfile.pin) ||
            previous.metadata?.["launchId"] !== launch?.launchId))
          return conflictError("Native pane profile/launch binding mismatch");
      }
      const launchMetadata = launch !== undefined
        ? { launchId: launch.launchId, launchFingerprint: launch.launchFingerprint,
          ...(launch.env.BFLOW_PROCESS_SCOPE_ID ? { processScopeId: launch.env.BFLOW_PROCESS_SCOPE_ID } : {}) }
        : {};

      // Name uniqueness check across session
      const agentListOutcome = await this.#runHerdr(["agent", "list"], options);
      if (agentListOutcome.exitCode !== 0 || agentListOutcome.failure) {
        return toCommandError(agentListOutcome, "Failed to list agents for uniqueness check");
      }
      const liveAgents = parseAgentListResult(agentListOutcome);
      const conflictingAgent = liveAgents.find((a) => a.name === agentName && a.paneId !== request.paneId);
      if (conflictingAgent) {
        return conflictError(
          `Agent name '${agentName}' is already in use in pane '${conflictingAgent.paneId}'`
        );
      }

      // Shell readiness check
      const paneGetOutcome = await this.#runHerdr(["pane", "get", request.paneId], options);
      if (paneGetOutcome.exitCode !== 0 || paneGetOutcome.failure) {
        return toCommandError(paneGetOutcome, `Pane '${request.paneId}' not found`);
      }
      const pane = parsePaneInfoResult(paneGetOutcome);
      if (request.roleProfile && pane.agent !== null)
        return conflictError("Profile launch cannot adopt an existing native context; reconcile the saved allocation");
      const named = await this.#namePane(request.paneId, spec.topologyRole, agentName, options, request.roleProfile);
      if (!named.ok) return named;

      if (pane.agent !== null) {
        const agentGetOutcome = await this.#runHerdr(["agent", "get", request.paneId], options);
        if (agentGetOutcome.exitCode === 0 && !agentGetOutcome.failure) {
          const existingAgent = parseAgentInfoResult(agentGetOutcome, "agent_info");
          if (existingAgent.name === agentName && existingAgent.agent === agentKind) {
            if (existingAgent.agentStatus === "blocked" || existingAgent.agentStatus === "unknown") {
              return this.#startupBlocked(spec.topologyRole, agentName, agentKind, request.paneId, existingAgent.agentStatus, options);
            }
            if (existingAgent.launchPending === true || existingAgent.interactiveReady === false) {
              return this.#startupBlocked(spec.topologyRole, agentName, agentKind, request.paneId, "launch pending or interactive not ready", options);
            }
            return this.#buildAndValidateBinding({
              spec,
              agentInfo: existingAgent,
              request,
              agentName,
              agentKind
            });
          }
          return conflictError(
            `Pane '${request.paneId}' is already occupied by a different agent: ${existingAgent.name ?? "unnamed"} (${existingAgent.agent ?? "unknown"})`
          );
        }
        return conflictError(`Pane '${request.paneId}' is already occupied by agent '${pane.agent}'`);
      }

      let procOutcome = await this.#runHerdr(["pane", "process-info", "--pane", request.paneId], options);
      if (procOutcome.exitCode !== 0 || procOutcome.failure) {
        return toCommandError(procOutcome, `Failed to inspect process info for pane '${request.paneId}'`);
      }
      let processInfo = parsePaneProcessInfoResult(procOutcome);
      let stableReadyCount = 0;
      for (let attempt = 0; attempt < 60; attempt++) {
        const budget = launchBudget();
        if (!budget.ok) return budget;
        const readiness = isShellReadyForAgent(pane, processInfo);
        if (readiness.ready) {
          stableReadyCount++;
          if (stableReadyCount >= 4) break;
        } else {
          stableReadyCount = 0;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
        procOutcome = await this.#runHerdr(["pane", "process-info", "--pane", request.paneId], options);
        if (procOutcome.exitCode !== 0 || procOutcome.failure) return toCommandError(procOutcome, `Cannot observe startup shell in pane '${request.paneId}'`);
        processInfo = parsePaneProcessInfoResult(procOutcome);
      }
      const readiness = isShellReadyForAgent(pane, processInfo);
      if (!readiness.ready) {
        return conflictError(readiness.reason ?? `Pane '${request.paneId}' shell is not ready for agent startup`);
      }

      const startArgs = ["agent", "start", agentName, "--kind", agentKind, "--pane", request.paneId];
      let passedArgs = launch !== undefined ? [...launch.argv] : (request.args ?? roleConfig?.args);
      let originalPromptSource: string | undefined;
      if (launch !== undefined && ["chat", "coordinator"].includes(spec.topologyRole)) {
        // Launch profiles are not rewritten: any provider's profile must already reference the original role prompt.
        const original = await readBuiltinRolePrompt(spec.topologyRole);
        if (!original) return validationError(`Required original prompt is missing for ${spec.topologyRole}`);
        const promptSource = await launchPromptSource(launch.argv, original.prompt) ?? (launch.provider === "agy" && launch.env.HOME
          ? await resolveNativeAgyPrompt(launch.env.HOME, spec.topologyRole === "chat" ? "conversation" : "coordinator", original.prompt) : undefined);
        if (promptSource === undefined)
          return validationError(`Launch profile for ${spec.topologyRole} must reference the original Bflow role prompt; rebuild the launch profile.`);
        originalPromptSource = promptSource;
      } else if (["chat", "coordinator"].includes(spec.topologyRole)) {
        const original = await readBuiltinRolePrompt(spec.topologyRole);
        if (!original) return validationError(`Required original prompt is missing for ${spec.topologyRole}`);
        if (agentKind !== "claude" && agentKind !== "codex") return validationError(`Native initial prompt injection for ${agentKind} is not verified. Configure role launch args for ${spec.topologyRole}.`);
        const args = passedArgs?.length ? [...passedArgs] : [...buildProviderRoleLaunch({ agentKind, role: spec.topologyRole, systemPrompt: original.prompt })];
        if (agentKind === "claude") {
          const index = args.indexOf("--append-system-prompt"), fromFile = args.indexOf("--append-system-prompt-file");
          if (index >= 0) {
            if (passedArgs?.length && args[index + 1] !== original.prompt) return validationError("Use a launch prompt file containing the original Bflow role plus custom instructions; inline override would lose role or host instructions.");
            args[index] = "--append-system-prompt-file"; args[index + 1] = original.source;
          }
          else if (fromFile < 0) args.push("--append-system-prompt-file", original.source);
          originalPromptSource = args[args.indexOf("--append-system-prompt-file") + 1];
        } else {
          const configuredFile = args.findIndex(value => value.startsWith("model_instructions_file="));
          if (configuredFile >= 0) originalPromptSource = JSON.parse(args[configuredFile]!.slice("model_instructions_file=".length)) as string;
          else {
            const inline = args.findIndex(value => value.startsWith("developer_instructions="));
            const fileOption = `model_instructions_file=${JSON.stringify(original.source)}`;
            if (inline >= 0 && !passedArgs?.length) args[inline] = fileOption;
            else args.push("-c", fileOption);
            originalPromptSource = original.source;
          }
        }
        if (typeof originalPromptSource !== "string") return validationError("Original role prompt file is missing from native launch arguments");
        const file = await open(originalPromptSource, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 131_072 || !(await file.readFile("utf8")).includes(original.prompt))
            return validationError(`The native ${spec.topologyRole} launch prompt does not contain its original Bflow role prompt. Rebuild the host launch configuration.`);
        } finally { await file.close(); }
        passedArgs = args;
      }
      const providerArgs = passedArgs?.length ? ["--", ...passedArgs] : [];
      // Launch env is NOT passed here: `agent start` types the command into the pane's existing shell, so
      // invocation env never reaches the provider. Env is applied at pane creation (see #herdrCreate).
      const dispatchStart = async (): Promise<OperationResult<CommandOutcome>> => {
        // Shell readiness, prompt validation and acknowledged busy waits consume the lifecycle budget.
        const budget = launchBudget();
        if (!budget.ok) return budget;
        const args = [...startArgs, "--timeout", String(budget.value), ...providerArgs];
        return ok(await this.#runHerdr(args, { ...options, timeoutMs: budget.value }));
      };
      if (request.roleProfile) {
        const stored = await this.#store.load(this.#config.sessionId, options);
        if (!stored.ok) return stored;
        if (!stored.value) return notFoundError("Session manifest is required for profile launch");
        const intent = this.#buildAndValidateBinding({ spec, agentName, agentKind,
          agentInfo: { ...pane, name: agentName, agent: agentKind, agentStatus: "unknown", revision: pane.revision },
          request: { ...request, metadata: { ...request.metadata, ...launchMetadata, launchIntent: true } } });
        if (!intent.ok) return intent;
        const saved = await this.#store.save({ ...stored.value,
          panes: [...stored.value.panes.filter(item => item.paneId !== pane.paneId), intent.value] }, options);
        if (!saved.ok) return saved;
      }
      let dispatched = await dispatchStart();
      if (!dispatched.ok) return dispatched;
      let startOutcome = dispatched.value;
      const isBusyError = (outcome: CommandOutcome): boolean => {
        // Only an acknowledged pre-dispatch rejection proves that retry cannot
        // duplicate a launch. Timeouts/partial output require reconciliation.
        if (outcome.failure || outcome.exitCode === null || outcome.exitCode === 0) return false;
        try { parseAgentInfoResult(outcome, "agent_started"); }
        catch (error) {
          return error instanceof HerdrProtocolError && error.kind === "remote" && error.code === "agent_pane_busy";
        }
        return false;
      };

      for (let busyRetry = 0; busyRetry < 20 && isBusyError(startOutcome); busyRetry++) {
        if (options?.signal?.aborted) return { ok: false, error: { code: "cancelled", retryable: false, message: "Agent startup wait interrupted; state preserved." } };
        await new Promise(resolve => setTimeout(resolve, 500));
        dispatched = await dispatchStart();
        if (!dispatched.ok) return dispatched;
        startOutcome = dispatched.value;
      }

      if (startOutcome.exitCode !== 0 || startOutcome.failure) {
        if (
          startOutcome.stderr.includes("agent_not_ready") ||
          startOutcome.stdout.includes("agent_not_ready") ||
          startOutcome.stderr.includes("agent_blocked") ||
          startOutcome.stdout.includes("agent_blocked")
        ) {
          return this.#startupBlocked(spec.topologyRole, agentName, agentKind, request.paneId, "blocked during startup", options);
        }
        return toCommandError(startOutcome, `Failed to start agent '${agentName}' in pane '${request.paneId}'`);
      }

      const agentInfo = parseAgentInfoResult(startOutcome, "agent_started");

      if (agentInfo.agentStatus === "blocked" || agentInfo.agentStatus === "unknown") {
        return this.#startupBlocked(spec.topologyRole, agentName, agentKind, request.paneId, agentInfo.agentStatus, options);
      }
      if (agentInfo.launchPending === true || agentInfo.interactiveReady === false) {
        return this.#startupBlocked(spec.topologyRole, agentName, agentKind, request.paneId, "launch pending or interactive not ready", options);
      }

      return this.#buildAndValidateBinding({
        spec,
        agentInfo,
        request: { ...request, provider: launch?.provider ?? this.#config.roleConfigs?.[spec.topologyRole]?.provider ?? this.#config.defaultProvider ?? "herdr", metadata: { ...request.metadata, ...launchMetadata, ...(originalPromptSource ? { promptInitialized: true, promptSource: originalPromptSource } : {}),
          ...(!agentInfo.session ? { nativeSessionPending: true } : {}) } },
        agentName,
        agentKind
      });
    } catch (err) {
      return toProtocolError(err, `Failed to start agent in pane '${request.paneId}'`);
    }
  }

  #buildAndValidateBinding(args: {
    readonly spec: RoleTopologySpec;
    readonly agentInfo: HerdrAgentInfo;
    readonly request: {
      readonly role: RoleSelector;
      readonly roleProfile?: ResolvedRoleProfileSnapshot;
      readonly paneId: string;
      readonly workspaceId: string;
      readonly tabId: string;
      readonly cwd: string;
      readonly worktreePath?: string;
      readonly model?: string;
      readonly launch?: AgentLaunchProfile;
      readonly provider?: string;
      readonly permanent?: boolean;
      readonly metadata?: Record<string, unknown>;
    };
    readonly agentName: string;
    readonly agentKind: string;
  }): OperationResult<PaneBinding> {
    const { spec, agentInfo, request, agentName, agentKind } = args;
    const nowIso = this.#clock().toISOString();
    const roleConfig = this.#config.roleConfigs?.[spec.topologyRole];
    const provider = request.launch?.provider ?? request.provider ?? roleConfig?.provider ?? this.#config.defaultProvider ?? "herdr";
    const model = request.model ?? roleConfig?.model ?? this.#config.defaultModel;

    const rawBinding = {
      schemaVersion: 2 as const,
      bindingId: `binding-${spec.topologyRole}-${agentInfo.paneId}`,
      sessionId: this.#config.sessionId,
      role: spec.contractRole,
      paneGroup: spec.paneGroup,
      agentId: agentName,
      workspaceId: agentInfo.workspaceId,
      tabId: agentInfo.tabId,
      paneId: agentInfo.paneId,
      ...(agentInfo.terminalId !== undefined ? { terminalId: agentInfo.terminalId } : {}),
      ...(agentInfo.session !== undefined ? { session: agentInfo.session } : {}),
      provider,
      agentKind,
      ...(model !== undefined ? { model } : {}),
      ...(request.roleProfile ? { roleProfile: request.roleProfile.pin } : {}),
      cwd: request.cwd,
      ...(request.worktreePath !== undefined ? { worktreePath: request.worktreePath } : {}),
      isolationMode: "dedicated_pane" as const,
      readOnlyWorkspace: spec.readOnlyWorkspace,
      ...(request.permanent !== undefined
        ? { permanent: request.permanent }
        : spec.permanent !== undefined
        ? { permanent: spec.permanent }
        : {}),
      transportState: agentInfo.agentStatus as AgentTransportState,
      boundAt: nowIso,
      lastHeartbeatAt: nowIso,
      metadata: {
        topologyRole: spec.topologyRole,
        ...(request.metadata !== undefined ? request.metadata : {})
      }
    };

    const parsed = PaneBindingSchema.safeParse(rawBinding);
    if (!parsed.success) {
      return validationError(`Failed to create valid PaneBinding: ${parsed.error.message}`, parsed.error.issues);
    }
    return ok(parsed.data);
  }

  /**
   * Reports the Herdr-observed state of a launched role using the same pane/agent
   * inspection as inspectRoleHealth. It never reports task success or readiness
   * beyond interactive transport state.
   */
  async inspectLaunchObservation(
    selector: RoleSelector | string,
    options?: OperationOptions
  ): Promise<OperationResult<LaunchObservation>> {
    const health = await this.inspectRoleHealth(selector, options);
    if (!health.ok) return health;
    const report = health.value;
    const observed = report.observedAgent;
    const transportState = report.transportState;
    const interactiveReady =
      (transportState === "idle" || transportState === "working" || transportState === "done") &&
      observed?.interactiveReady !== false &&
      observed?.launchPending !== true;
    const session = observed?.session;
    return ok<LaunchObservation>({
      paneId: report.paneId,
      agentName: observed?.name ?? report.agentId,
      transportState,
      interactiveReady,
      ...(observed?.launchPending !== undefined ? { launchPending: observed.launchPending } : {}),
      ...(session ? { nativeSession: { source: session.source, kind: session.kind, value: session.value } } : {})
    });
  }

  async inspectRoleHealth(
    selector: RoleSelector | string,
    options?: OperationOptions
  ): Promise<OperationResult<RoleHealthReport>> {
    try {
      const loadResult = await this.#store.load(this.#config.sessionId, options);
      if (!loadResult.ok) return loadResult;
      const manifest = loadResult.value;
      if (!manifest) {
        return notFoundError(`Session manifest not found for session '${this.#config.sessionId}'`);
      }

      const topoRole = resolveTopologyRole(selector);
      const binding = manifest.panes.find(
        (p) =>
          p.bindingId === selector ||
          p.paneId === selector ||
          p.agentId === selector ||
          p.role === selector ||
          (topoRole !== null && (p.metadata?.["topologyRole"] === topoRole || p.role === topoRole))
      );

      if (!binding) {
        return notFoundError(`Role binding not found for selector '${selector}'`);
      }

      const topologyRole = ((binding.metadata?.["topologyRole"] as TopologyRole | undefined) ??
        resolveTopologyRole(binding.role) ??
        "developer") as TopologyRole;

      const paneOutcome = await this.#runHerdr(["pane", "get", binding.paneId], options);
      if (paneOutcome.exitCode !== 0 || paneOutcome.failure) {
        return ok<RoleHealthReport>({
          bindingId: binding.bindingId,
          topologyRole,
          contractRole: binding.role,
          agentId: binding.agentId,
          paneId: binding.paneId,
          workspaceId: binding.workspaceId,
          tabId: binding.tabId,
          status: "pane_missing",
          transportState: "disconnected",
          readyForPrompt: false,
          paneExists: false,
          occupantMatches: false,
          reason: `Pane '${binding.paneId}' was not found in Herdr`
        });
      }

      const pane = parsePaneInfoResult(paneOutcome);

      if (pane.agent === null) {
        return ok<RoleHealthReport>({
          bindingId: binding.bindingId,
          topologyRole,
          contractRole: binding.role,
          agentId: binding.agentId,
          paneId: binding.paneId,
          workspaceId: binding.workspaceId,
          tabId: binding.tabId,
          status: "not_ready",
          transportState: "disconnected",
          readyForPrompt: false,
          paneExists: true,
          occupantMatches: false,
          reason: `Pane '${binding.paneId}' exists at a shell prompt with no running agent`
        });
      }

      const agentOutcome = await this.#runHerdr(["agent", "get", binding.paneId], options);
      if (agentOutcome.exitCode !== 0 || agentOutcome.failure) {
        return ok<RoleHealthReport>({
          bindingId: binding.bindingId,
          topologyRole,
          contractRole: binding.role,
          agentId: binding.agentId,
          paneId: binding.paneId,
          workspaceId: binding.workspaceId,
          tabId: binding.tabId,
          status: "agent_replaced",
          transportState: "unknown",
          readyForPrompt: false,
          paneExists: true,
          occupantMatches: false,
          reason: `Could not inspect agent in pane '${binding.paneId}'`
        });
      }

      const agentInfo = parseAgentInfoResult(agentOutcome, "agent_info");
      const nameMatches = agentInfo.name === binding.agentId;
      const kindMatches = agentInfo.agent === binding.agentKind;
      const sessionMatches = !binding.session || !agentInfo.session || (
        binding.session.source === agentInfo.session.source &&
        binding.session.kind === agentInfo.session.kind &&
        binding.session.value === agentInfo.session.value
      );
      const terminalMatches = !binding.terminalId || agentInfo.terminalId === binding.terminalId;

      if (!nameMatches || !kindMatches || !sessionMatches || !terminalMatches) {
        return ok<RoleHealthReport>({
          bindingId: binding.bindingId,
          topologyRole,
          contractRole: binding.role,
          agentId: binding.agentId,
          paneId: binding.paneId,
          workspaceId: binding.workspaceId,
          tabId: binding.tabId,
          status: "agent_replaced",
          transportState: "unknown",
          readyForPrompt: false,
          paneExists: true,
          occupantMatches: false,
          reason: `Agent occupant mismatch in pane '${binding.paneId}': expected ${binding.agentId} (${binding.agentKind}), observed ${agentInfo.name} (${agentInfo.agent})`,
          observedAgent: agentInfo
        });
      }

      if (agentInfo.agentStatus === "blocked") {
        return ok<RoleHealthReport>({
          bindingId: binding.bindingId,
          topologyRole,
          contractRole: binding.role,
          agentId: binding.agentId,
          paneId: binding.paneId,
          workspaceId: binding.workspaceId,
          tabId: binding.tabId,
          status: "blocked",
          transportState: "blocked",
          readyForPrompt: false,
          paneExists: true,
          occupantMatches: true,
          reason: "Agent is blocked",
          observedAgent: agentInfo
        });
      }

      if (agentInfo.agentStatus === "unknown") {
        return ok<RoleHealthReport>({
          bindingId: binding.bindingId,
          topologyRole,
          contractRole: binding.role,
          agentId: binding.agentId,
          paneId: binding.paneId,
          workspaceId: binding.workspaceId,
          tabId: binding.tabId,
          status: "unknown",
          transportState: "unknown",
          readyForPrompt: false,
          paneExists: true,
          occupantMatches: true,
          reason: "Agent status is unknown",
          observedAgent: agentInfo
        });
      }

      if (agentInfo.launchPending === true || agentInfo.interactiveReady === false) {
        return ok<RoleHealthReport>({
          bindingId: binding.bindingId,
          topologyRole,
          contractRole: binding.role,
          agentId: binding.agentId,
          paneId: binding.paneId,
          workspaceId: binding.workspaceId,
          tabId: binding.tabId,
          status: "not_ready",
          transportState: "unknown",
          readyForPrompt: false,
          paneExists: true,
          occupantMatches: true,
          reason: "Agent launch is pending or interactive prompt is not ready",
          observedAgent: agentInfo
        });
      }

      if (agentInfo.agentStatus === "working") {
        return ok<RoleHealthReport>({
          bindingId: binding.bindingId,
          topologyRole,
          contractRole: binding.role,
          agentId: binding.agentId,
          paneId: binding.paneId,
          workspaceId: binding.workspaceId,
          tabId: binding.tabId,
          status: "working",
          transportState: "working",
          readyForPrompt: false,
          paneExists: true,
          occupantMatches: true,
          observedAgent: agentInfo
        });
      }

      return ok<RoleHealthReport>({
        bindingId: binding.bindingId,
        topologyRole,
        contractRole: binding.role,
        agentId: binding.agentId,
        paneId: binding.paneId,
        workspaceId: binding.workspaceId,
        tabId: binding.tabId,
        status: "ready",
        transportState: agentInfo.agentStatus as AgentTransportState,
        readyForPrompt: true,
        paneExists: true,
        occupantMatches: true,
        observedAgent: agentInfo
      });
    } catch (err) {
      return toProtocolError(err, `Failed to inspect health for selector '${selector}'`);
    }
  }

  async inspectTopologyHealth(options?: OperationOptions): Promise<OperationResult<TopologyHealthSummary>> {
    try {
      const loadResult = await this.#store.load(this.#config.sessionId, options);
      if (!loadResult.ok) return loadResult;
      const manifest = loadResult.value;
      if (!manifest) {
        return notFoundError(`Session manifest not found for session '${this.#config.sessionId}'`);
      }

      const reports: RoleHealthReport[] = [];
      const anomalies: TopologyAnomaly[] = [];

      const updatedPanes: PaneBinding[] = [];

      for (const binding of manifest.panes) {
        const healthResult = await this.inspectRoleHealth(binding.bindingId, options);
        if (!healthResult.ok) return healthResult;
        const report = healthResult.value;
        reports.push(report);

        if (report.status === "pane_missing") {
          anomalies.push({
            kind: "pane_missing",
            bindingId: binding.bindingId,
            topologyRole: report.topologyRole,
            agentId: binding.agentId,
            expectedPaneId: binding.paneId,
            message: report.reason ?? `Pane '${binding.paneId}' is missing`
          });
        } else if (report.status === "agent_replaced") {
          anomalies.push({
            kind: "agent_replaced",
            bindingId: binding.bindingId,
            topologyRole: report.topologyRole,
            agentId: binding.agentId,
            expectedPaneId: binding.paneId,
            ...(report.observedAgent?.paneId !== undefined ? { observedPaneId: report.observedAgent.paneId } : {}),
            message: report.reason ?? "Agent occupant was replaced"
          });
        } else if (report.status === "blocked") {
          anomalies.push({
            kind: "agent_blocked",
            bindingId: binding.bindingId,
            topologyRole: report.topologyRole,
            agentId: binding.agentId,
            expectedPaneId: binding.paneId,
            message: "Agent is blocked"
          });
        } else if (report.status === "unknown") {
          anomalies.push({
            kind: "agent_unknown",
            bindingId: binding.bindingId,
            topologyRole: report.topologyRole,
            agentId: binding.agentId,
            expectedPaneId: binding.paneId,
            message: "Agent status is unknown"
          });
        } else if (report.status === "not_ready") {
          anomalies.push({
            kind: "agent_not_ready",
            bindingId: binding.bindingId,
            topologyRole: report.topologyRole,
            agentId: binding.agentId,
            expectedPaneId: binding.paneId,
            message: report.reason ?? "Agent is not ready"
          });
        }

        const roleLaunch = this.#config.roleConfigs?.[report.topologyRole]?.launch;
        const retries = typeof binding.metadata?.["nativeSessionRetries"] === "number" ? binding.metadata["nativeSessionRetries"] : 0;
        const ageMs = this.#clock().getTime() - Date.parse(binding.boundAt);
        if (
          binding.permanent === true &&
          binding.agentKind === "agy" &&
          roleLaunch?.provider === "agy" &&
          Boolean(roleLaunch.env["HOME"]) &&
          this.#socket !== undefined &&
          binding.metadata?.["nativeSessionPending"] === true &&
          !binding.session &&
          !report.observedAgent?.session &&
          report.occupantMatches &&
          (report.transportState === "idle" || report.transportState === "done") &&
          ageMs >= 8_000 &&
          retries < 2
        ) {
          const split = await this.#splitPane(
            binding.paneId,
            "right",
            binding.cwd,
            roleLaunch,
            `Failed to split replacement pane for '${report.topologyRole}'`,
            options
          );
          if (split.ok) {
            await this.#closePane(binding.paneId, options);
            const restarted = await this.startAgentInPane({
              role: report.topologyRole,
              paneId: split.value.paneId,
              workspaceId: binding.workspaceId,
              tabId: binding.tabId,
              cwd: binding.cwd,
              agentName: binding.agentId,
              agentKind: binding.agentKind,
              permanent: true,
              metadata: {
                ...binding.metadata,
                nativeSessionRetries: retries + 1
              }
            }, options);
            if (restarted.ok) {
              updatedPanes.push(restarted.value);
              await balanceOwnedTab(
                args => this.#runHerdr(args, options),
                manifest.herdrWorkspaceId,
                binding.tabId,
                updatedPanes.filter(p => p.permanent && p.tabId === binding.tabId).map(p => p.paneId)
              );
              continue;
            }
          }
        }

        updatedPanes.push({
          ...binding,
          ...(!binding.session && report.occupantMatches && report.observedAgent?.session &&
            (binding.metadata?.nativeSessionPending === true || binding.metadata?.launchIntent === true)
            ? { session: report.observedAgent.session, metadata: { ...binding.metadata, nativeSessionPending: false } } : {}),
          transportState: report.transportState,
          lastHeartbeatAt: this.#clock().toISOString()
        });
      }

      const isHealthyTransport = (state: AgentTransportState) =>
        state === "idle" || state === "done" || state === "working" || state === "accepted";
      const hasConversation = updatedPanes.some(
        (p) => p.role === "conversation" && isHealthyTransport(p.transportState)
      );
      const hasCoordinator = updatedPanes.some(
        (p) => p.role === "coordinator" && isHealthyTransport(p.transportState)
      );
      // A stale Runtime-owned pane is reported, but only permanent role panes decide the topology status.
      const runtimeOwned = new Set(manifest.panes.filter(isRuntimeOwnedPane).map((p) => p.bindingId));
      const healthy = anomalies.every((anomaly) => runtimeOwned.has(anomaly.bindingId));
      const newStatus: SessionManifestStatus = healthy && hasConversation && hasCoordinator ? "up" : "degraded";
      const updatedConversation = updatedPanes.find((p) => p.role === "conversation" && p.permanent);

      const updatedManifest: SessionManifest = {
        ...manifest,
        status: newStatus,
        panes: updatedPanes,
        ...(updatedConversation
          ? {
              attachTarget: {
                paneId: updatedConversation.paneId,
                role: "conversation",
                ...(updatedConversation.terminalId !== undefined ? { terminalId: updatedConversation.terminalId } : {})
              }
            }
          : {}),
        updatedAt: this.#clock().toISOString()
      };

      const validatedManifest = SessionManifestSchema.safeParse(updatedManifest);
      if (!validatedManifest.success) {
        return validationError(
          `Failed to validate updated session manifest: ${validatedManifest.error.message}`,
          validatedManifest.error.issues
        );
      }

      const saveResult = await this.#store.save(validatedManifest.data, options);
      if (!saveResult.ok) return saveResult;

      return ok<TopologyHealthSummary>({
        sessionId: manifest.sessionId,
        healthy,
        roles: reports,
        anomalies
      });
    } catch (err) {
      return toProtocolError(err, "Failed to inspect topology health");
    }
  }

  async recoverAfterRestart(options?: OperationOptions): Promise<OperationResult<SessionManifest>> {
    try {
      // Env-at-creation requirements are validated before any side effect.
      const socketCheck = this.#requireSocketFor(PERMANENT_TOPOLOGY_ROLES.map(role => this.#config.roleConfigs?.[role]?.launch));
      if (!socketCheck.ok) return socketCheck;
      const envPaneLaunch = new Map<string, string>();

      const loadResult = await this.#store.load(this.#config.sessionId, options);
      if (!loadResult.ok) return loadResult;
      const savedManifest = loadResult.value;
      if (!savedManifest) {
        return notFoundError(`No persisted session manifest found for session '${this.#config.sessionId}' to recover`);
      }

      const profiledAgents = savedManifest.panes.filter(pane => pane.roleProfile && pane.metadata?.["allocationStatus"] !== "released");
      const confirmedProfiles = new Map<string, HerdrAgentInfo>();
      if (profiledAgents.length) {
        const observed = await this.#runHerdr(["agent", "list"], options);
        if (observed.exitCode !== 0 || observed.failure) return toCommandError(observed, "Cannot reconcile profile native bindings");
        const agents = parseAgentListResult(observed);
        for (const binding of profiledAgents) {
          const snapshot = savedManifest.roleProfiles?.find(item => sameRoleProfilePin(item.pin, binding.roleProfile));
          const live = agents.find(agent => agent.paneId === binding.paneId && agent.name === binding.agentId && agent.agent === binding.agentKind);
          if (!snapshot || snapshot.definition.baseRole !== binding.role || !binding.session || !live?.session ||
              JSON.stringify(binding.session) !== JSON.stringify(live.session) || !binding.metadata?.["launchId"] || !binding.metadata?.["launchFingerprint"])
            return conflictError("Profile recovery requires the exact authenticated native binding; host reconciliation is required");
          confirmedProfiles.set(binding.bindingId, live);
        }
      }
      const wsListOutcome = await this.#runHerdr(["workspace", "list"], options);
      if (wsListOutcome.exitCode !== 0 || wsListOutcome.failure) {
        return toCommandError(wsListOutcome, "Failed to list workspaces during restart recovery");
      }
      const workspaces = parseWorkspaceListResult(wsListOutcome);

      let herdrWorkspaceId = savedManifest.herdrWorkspaceId;
      let herdrTabId = savedManifest.herdrTabId;

      const matchedWorkspace = workspaces.find(
        (w) =>
          w.workspaceId === savedManifest.herdrWorkspaceId ||
          w.label === savedManifest.projectName ||
          w.worktree?.checkoutPath === savedManifest.workspaceRoot
      );

      if (matchedWorkspace) {
        herdrWorkspaceId = matchedWorkspace.workspaceId;
      } else {
        const chatLaunch = this.#config.roleConfigs?.chat?.launch;
        const created = await this.#herdrCreate<HerdrWorkspaceCreated>(
          {
            method: "workspace.create",
            params: { cwd: savedManifest.workspaceRoot, label: savedManifest.projectName, focus: false },
            args: ["workspace", "create", "--cwd", savedManifest.workspaceRoot, "--label", savedManifest.projectName, "--no-focus"]
          },
          launchEnvOf(chatLaunch),
          parseWorkspaceCreatedResult,
          "Failed to recreate workspace during restart recovery",
          options
        );
        if (!created.ok) return created;
        herdrWorkspaceId = created.value.workspace.workspaceId;
        herdrTabId = created.value.tab.tabId;
        if (chatLaunch !== undefined && launchEnvOf(chatLaunch) !== undefined) envPaneLaunch.set(created.value.rootPane.paneId, chatLaunch.launchId);
      }

      const tabListOutcome = await this.#runHerdr(["tab", "list", "--workspace", herdrWorkspaceId], options);
      if (tabListOutcome.exitCode !== 0 || tabListOutcome.failure) {
        return toCommandError(tabListOutcome, `Failed to list tabs for workspace '${herdrWorkspaceId}'`);
      }
      let currentTabs = parseTabListResult(tabListOutcome);

      const paneListOutcome = await this.#runHerdr(["pane", "list", "--workspace", herdrWorkspaceId], options);
      if (paneListOutcome.exitCode !== 0 || paneListOutcome.failure) {
        return toCommandError(paneListOutcome, "Failed to list panes during restart recovery");
      }
      let livePanes = parsePaneListResult(paneListOutcome);

      const agentListOutcome = await this.#runHerdr(["agent", "list"], options);
      if (agentListOutcome.exitCode !== 0 || agentListOutcome.failure) {
        return toCommandError(agentListOutcome, "Failed to list agents during restart recovery");
      }
      let liveAgents = parseAgentListResult(agentListOutcome);

      const usedPaneIds = new Set<string>();
      const recoveredPanes: PaneBinding[] = [];

      for (const binding of savedManifest.panes) {
        if (binding.roleProfile) {
          const live = confirmedProfiles.get(binding.bindingId);
          if (live) {
            usedPaneIds.add(live.paneId);
            recoveredPanes.push({ ...binding, transportState: live.agentStatus as AgentTransportState, lastHeartbeatAt: this.#clock().toISOString() });
          } else if (binding.metadata?.["allocationStatus"] === "released") {
            recoveredPanes.push({ ...binding, transportState: "disconnected" });
          } else return conflictError("Profile native launch cannot be reconstructed from base role configuration");
          continue;
        }
        const topologyRole = ((binding.metadata?.["topologyRole"] as TopologyRole | undefined) ??
          resolveTopologyRole(binding.role) ??
          "developer") as TopologyRole;
        const spec = ROLE_TOPOLOGY_SPECS[topologyRole];

        // Env is fixed at pane creation: a binding recorded for another launch (or none) is never reused for an env launch.
        const roleLaunch = this.#config.roleConfigs?.[topologyRole]?.launch;
        const stalePane = launchEnvOf(roleLaunch) !== undefined && binding.metadata?.["launchId"] !== roleLaunch?.launchId;
        const roleEnvLaunchId = launchEnvOf(roleLaunch) !== undefined ? roleLaunch?.launchId : undefined;

        // Case A: Matching live agent found
        const matchingLiveAgent = liveAgents.find(
          (a) => a.name === binding.agentId && a.agent === binding.agentKind && !usedPaneIds.has(a.paneId)
        );

        if (matchingLiveAgent && !stalePane) {
          usedPaneIds.add(matchingLiveAgent.paneId);
          const updatedBinding: PaneBinding = {
            ...binding,
            bindingId: `binding-${topologyRole}-${matchingLiveAgent.paneId}`,
            paneId: matchingLiveAgent.paneId,
            workspaceId: matchingLiveAgent.workspaceId,
            tabId: matchingLiveAgent.tabId,
            ...(matchingLiveAgent.terminalId !== undefined ? { terminalId: matchingLiveAgent.terminalId } : {}),
            ...(matchingLiveAgent.session !== undefined ? { session: matchingLiveAgent.session } : {}),
            transportState: matchingLiveAgent.agentStatus as AgentTransportState,
            lastHeartbeatAt: this.#clock().toISOString()
          };
          if (matchingLiveAgent.terminalId === undefined) {
            delete (updatedBinding as { terminalId?: string }).terminalId;
          }
          if (matchingLiveAgent.session === undefined) {
            delete (updatedBinding as { session?: AgentSessionLocator }).session;
          }
          const parsedBinding = PaneBindingSchema.safeParse(updatedBinding);
          if (!parsedBinding.success) {
            return validationError(
              `Failed to validate recovered binding: ${parsedBinding.error.message}`,
              parsedBinding.error.issues
            );
          }
          recoveredPanes.push(parsedBinding.data);
          continue;
        }

        // Released developer binding: do not respawn live agent
        if (binding.role === "developer" && binding.metadata?.["allocationStatus"] === "released") {
          const existingPane = livePanes.find((p) => p.paneId === binding.paneId && !usedPaneIds.has(p.paneId));
          const releasedBinding: PaneBinding = {
            ...binding,
            transportState: "disconnected",
            lastHeartbeatAt: this.#clock().toISOString(),
            ...(existingPane ? { paneId: existingPane.paneId, workspaceId: existingPane.workspaceId, tabId: existingPane.tabId } : {})
          };
          if (existingPane) {
            usedPaneIds.add(existingPane.paneId);
          }
          const parsed = PaneBindingSchema.safeParse(releasedBinding);
          if (parsed.success) {
            recoveredPanes.push(parsed.data);
          } else {
            recoveredPanes.push(releasedBinding);
          }
          continue;
        }

        // Case B: Existing pane ID still exists at shell prompt (pane.agent === null)
        const existingPane = livePanes.find(
          (p) => p.paneId === binding.paneId && p.agent === null && !usedPaneIds.has(p.paneId)
        );
        if (existingPane && !stalePane) {
          const startResult = await this.startAgentInPane(
            {
              role: topologyRole,
              paneId: existingPane.paneId,
              workspaceId: existingPane.workspaceId,
              tabId: existingPane.tabId,
              cwd: binding.cwd,
              ...(binding.worktreePath !== undefined ? { worktreePath: binding.worktreePath } : {}),
              agentName: binding.agentId,
              agentKind: binding.agentKind,
              ...(binding.model !== undefined ? { model: binding.model } : {}),
              ...(binding.permanent !== undefined ? { permanent: binding.permanent } : {}),
              ...(binding.metadata !== undefined ? { metadata: binding.metadata } : {})
            },
            options
          );
          if (!startResult.ok) {
            return startResult;
          }
          usedPaneIds.add(startResult.value.paneId);
          recoveredPanes.push(startResult.value);
          continue;
        }

        // Case C: Permanent role whose old paneId is gone or renumbered
        if (binding.permanent || spec.permanent) {
          const desiredTabLabel =
            spec.tabKey === "conversation"
              ? (this.#config.tabLabels?.conversation ?? "conversation")
              : spec.tabKey === "coordination"
              ? (this.#config.tabLabels?.coordination ?? "coordination")
              : (this.#config.tabLabels?.verification ?? "verification");

          let roleTab = currentTabs.find(
            (t) => t.tabId === binding.tabId || t.label === desiredTabLabel || t.label === spec.tabKey
          );
          if (!roleTab && spec.tabKey === "conversation" && currentTabs.length > 0) {
            const firstTab = currentTabs[0];
            if (
              firstTab !== undefined &&
              firstTab.label !== "coordination" &&
              firstTab.label !== (this.#config.tabLabels?.coordination ?? "coordination") &&
              firstTab.label !== "verification" &&
              firstTab.label !== (this.#config.tabLabels?.verification ?? "verification")
            ) {
              roleTab = firstTab;
            }
          }

          if (!roleTab) {
            const createdTab = await this.#herdrCreate<HerdrTabCreated>(
              {
                method: "tab.create",
                params: { workspace_id: herdrWorkspaceId, cwd: binding.cwd, label: desiredTabLabel, focus: false },
                args: ["tab", "create", "--workspace", herdrWorkspaceId, "--cwd", binding.cwd, "--label", desiredTabLabel, "--no-focus"]
              },
              launchEnvOf(roleLaunch),
              parseTabCreatedResult,
              `Failed to recreate tab '${desiredTabLabel}' during restart recovery`,
              options
            );
            if (!createdTab.ok) return createdTab;
            const created = createdTab.value;
            roleTab = created.tab;
            currentTabs = [...currentTabs, roleTab];
            livePanes = [...livePanes, created.rootPane];
            if (roleEnvLaunchId !== undefined) envPaneLaunch.set(created.rootPane.paneId, roleEnvLaunchId);
          }

          let targetPaneId: string;
          // A pane is reusable only if it was created by this run for this role's env (env roles) or carries no env (legacy roles).
          const availableShellPane = livePanes.find(
            (p) => p.tabId === roleTab?.tabId && p.agent === null && !usedPaneIds.has(p.paneId) &&
              (roleEnvLaunchId !== undefined ? envPaneLaunch.get(p.paneId) === roleEnvLaunchId : !envPaneLaunch.has(p.paneId))
          );

          if (availableShellPane) {
            targetPaneId = availableShellPane.paneId;
          } else {
            const sourcePane = livePanes.find((p) => p.tabId === roleTab?.tabId) ?? livePanes[0];
            if (!sourcePane) {
              return validationError(`No pane available in workspace '${herdrWorkspaceId}' to split`);
            }
            const split = await this.#herdrCreate<HerdrPaneInfo>(
              {
                method: "pane.split",
                params: { target_pane_id: sourcePane.paneId, direction: "right", cwd: binding.cwd, focus: false },
                args: ["pane", "split", sourcePane.paneId, "--direction", "right", "--cwd", binding.cwd, "--no-focus"]
              },
              launchEnvOf(roleLaunch),
              parsePaneInfoResult,
              `Failed to split pane from '${sourcePane.paneId}'`,
              options
            );
            if (!split.ok) return split;
            livePanes = [...livePanes, split.value];
            targetPaneId = split.value.paneId;
            if (roleEnvLaunchId !== undefined) envPaneLaunch.set(targetPaneId, roleEnvLaunchId);
          }

          // A stale pane still runs the previous launch (and possibly its agent name): close it before starting the new one.
          if (stalePane && binding.paneId !== targetPaneId && livePanes.some(p => p.paneId === binding.paneId)) {
            await this.#closePane(binding.paneId, options);
            livePanes = livePanes.filter(p => p.paneId !== binding.paneId);
          }

          usedPaneIds.add(targetPaneId);
          const startResult = await this.startAgentInPane(
            {
              role: topologyRole,
              paneId: targetPaneId,
              workspaceId: herdrWorkspaceId,
              tabId: roleTab.tabId,
              cwd: binding.cwd,
              agentName: binding.agentId,
              agentKind: binding.agentKind,
              ...(binding.model !== undefined ? { model: binding.model } : {}),
              permanent: true,
              ...(binding.metadata !== undefined ? { metadata: binding.metadata } : {})
            },
            options
          );
          if (!startResult.ok) {
            return startResult;
          }
          recoveredPanes.push(startResult.value);
          continue;
        } else if (binding.role === "developer" && binding.worktreePath) {
          // Developer worktree
          const wtInspect = await this.#worktreeInspector.inspect(binding.worktreePath, options);
          if (wtInspect.ok && wtInspect.value.exists) {
            const openWtOutcome = await this.#runHerdr(
              ["worktree", "open", "--workspace", herdrWorkspaceId, "--path", binding.worktreePath, "--label", binding.agentId, "--no-focus"],
              options
            );
            if (openWtOutcome.exitCode !== 0 || openWtOutcome.failure) {
              return toCommandError(openWtOutcome, `Failed to reopen developer worktree at '${binding.worktreePath}'`);
            }
            const wtCreated = parseWorktreeCreatedResult(openWtOutcome);
            usedPaneIds.add(wtCreated.rootPane.paneId);
            const startResult = await this.startAgentInPane(
              {
                role: "developer",
                paneId: wtCreated.rootPane.paneId,
                workspaceId: wtCreated.workspace.workspaceId,
                tabId: wtCreated.tab.tabId,
                cwd: binding.worktreePath,
                worktreePath: binding.worktreePath,
                agentName: binding.agentId,
                agentKind: binding.agentKind,
                ...(binding.model !== undefined ? { model: binding.model } : {}),
                permanent: false,
                ...(binding.metadata !== undefined ? { metadata: binding.metadata } : {})
              },
              options
            );
            if (!startResult.ok) {
              return startResult;
            }
            recoveredPanes.push(startResult.value);
            continue;
          }
        }
      }

      const chatBinding = recoveredPanes.find((p) => p.role === "conversation");
      if (!chatBinding) {
        return validationError("Restart recovery failed to restore conversation (chat) pane");
      }

      herdrTabId = chatBinding.tabId;

      const wsFocusOutcome = await this.#runHerdr(["workspace", "focus", herdrWorkspaceId], options);
      if (wsFocusOutcome.exitCode !== 0 || wsFocusOutcome.failure) {
        return toCommandError(wsFocusOutcome, `Failed to focus workspace '${herdrWorkspaceId}'`);
      }
      parseWorkspaceInfoResult(wsFocusOutcome);

      const tabFocusOutcome = await this.#runHerdr(["tab", "focus", chatBinding.tabId], options);
      if (tabFocusOutcome.exitCode !== 0 || tabFocusOutcome.failure) {
        return toCommandError(tabFocusOutcome, `Failed to focus tab '${chatBinding.tabId}'`);
      }
      parseTabInfoResult(tabFocusOutcome);

      const agentFocusOutcome = await this.#runHerdr(["agent", "focus", chatBinding.paneId], options);
      if (agentFocusOutcome.exitCode !== 0 || agentFocusOutcome.failure) {
        return toCommandError(agentFocusOutcome, `Failed to focus agent in pane '${chatBinding.paneId}'`);
      }
      parseAgentInfoResult(agentFocusOutcome, "agent_info");

      const coordinatorBinding = recoveredPanes.find((p) => p.role === "coordinator");
      const allHealthy = startupPanesHealthy(recoveredPanes);
      const newStatus: SessionManifestStatus = (allHealthy && chatBinding && coordinatorBinding) ? "up" : "degraded";

      const recoveredManifest: SessionManifest = {
        ...savedManifest,
        herdrWorkspaceId,
        herdrTabId,
        status: newStatus,
        panes: recoveredPanes,
        attachTarget: {
          role: "conversation",
          paneId: chatBinding.paneId,
          ...(chatBinding.terminalId !== undefined ? { terminalId: chatBinding.terminalId } : {})
        },
        updatedAt: this.#clock().toISOString()
      };

      const parsed = SessionManifestSchema.safeParse(recoveredManifest);
      if (!parsed.success) {
        return validationError(`Failed to validate recovered manifest: ${parsed.error.message}`, parsed.error.issues);
      }

      const saveResult = await this.#store.save(parsed.data, options);
      if (!saveResult.ok) return saveResult;

      return ok(saveResult.value);
    } catch (err) {
      return toProtocolError(err, "Failed to recover session after restart");
    }
  }

  async focusConversationPane(options?: OperationOptions): Promise<OperationResult<PaneBinding>> {
    try {
      const loadResult = await this.#store.load(this.#config.sessionId, options);
      if (!loadResult.ok) return loadResult;
      const manifest = loadResult.value;
      if (!manifest) {
        return notFoundError(`Session manifest not found for session '${this.#config.sessionId}'`);
      }

      const chatBinding = manifest.panes.find((p) => p.role === "conversation");
      if (!chatBinding) {
        return notFoundError("Conversation pane binding not found in session manifest");
      }

      const health = await this.inspectRoleHealth("chat", options);
      if (!health.ok) return health;
      if (health.value.status === "pane_missing") {
        return conflictError(`Conversation pane '${chatBinding.paneId}' is missing`);
      }
      if (health.value.status === "agent_replaced") {
        return conflictError(`Conversation agent in pane '${chatBinding.paneId}' has been replaced`);
      }
      if (
        health.value.status === "not_ready" ||
        health.value.status === "blocked" ||
        health.value.status === "unknown"
      ) {
        return conflictError(`Conversation agent in pane '${chatBinding.paneId}' is not ready: ${health.value.status}`);
      }

      const wsFocusOutcome = await this.#runHerdr(["workspace", "focus", chatBinding.workspaceId], options);
      if (wsFocusOutcome.exitCode !== 0 || wsFocusOutcome.failure) {
        return toCommandError(wsFocusOutcome, `Failed to focus workspace '${chatBinding.workspaceId}'`);
      }
      parseWorkspaceInfoResult(wsFocusOutcome);

      const tabFocusOutcome = await this.#runHerdr(["tab", "focus", chatBinding.tabId], options);
      if (tabFocusOutcome.exitCode !== 0 || tabFocusOutcome.failure) {
        return toCommandError(tabFocusOutcome, `Failed to focus tab '${chatBinding.tabId}'`);
      }
      parseTabInfoResult(tabFocusOutcome);

      const agentFocusOutcome = await this.#runHerdr(["agent", "focus", chatBinding.paneId], options);
      if (agentFocusOutcome.exitCode !== 0 || agentFocusOutcome.failure) {
        return toCommandError(agentFocusOutcome, `Failed to focus agent in pane '${chatBinding.paneId}'`);
      }
      parseAgentInfoResult(agentFocusOutcome, "agent_info");

      const updatedManifest: SessionManifest = {
        ...manifest,
        attachTarget: {
          role: "conversation",
          paneId: chatBinding.paneId,
          ...(chatBinding.terminalId !== undefined ? { terminalId: chatBinding.terminalId } : {})
        },
        updatedAt: this.#clock().toISOString()
      };

      const saveResult = await this.#store.save(updatedManifest, options);
      if (!saveResult.ok) return saveResult;

      return ok(chatBinding);
    } catch (err) {
      return toProtocolError(err, "Failed to focus conversation pane");
    }
  }

  async #validateRoleProfileLaunch(
    snapshot: ResolvedRoleProfileSnapshot | undefined,
    role: AgentRole,
    launch: AgentLaunchProfile | undefined,
    agentKind: string
  ): Promise<OperationResult<void>> {
    if (!snapshot) return launch?.roleProfile === undefined ? ok(undefined) : validationError("Profile launch requires its immutable snapshot");
    const parsed = ResolvedRoleProfileSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) return validationError("Invalid role profile snapshot");
    if (parsed.data.definition.baseRole !== role) return validationError("Role profile base role does not match governance role");
    if (!launch || !launch.features?.includes(ROLE_PROFILE_FEATURE))
      return validationError(`Profile launch requires negotiated ${ROLE_PROFILE_FEATURE} support`);
    const problem = checkLaunchProfile(launch, agentKind);
    if (problem) return validationError(problem.message);
    const pin = RoleProfilePinSchema.safeParse(launch.roleProfile);
    if (!pin.success || !sameRoleProfilePin(pin.data, parsed.data.pin))
      return validationError("Role profile launch pin mismatch");
    if (launch.argv.some(arg => ["resume", "fork", "--resume", "--continue", "--fork-session"].includes(arg.split("=")[0]!)))
      return validationError("Profile allocation requires a fresh native launch context");
    const original = await readBuiltinRolePrompt(role);
    if (!original) return validationError("Profile launch requires original base role instructions");
    const path = await launchPromptSource(launch.argv, original.prompt) ?? launch.promptSource;
    if (!path || await regularFileContains(path, original.prompt, false, true) === false)
      return validationError("Profile launch must preserve the original base role prompt prefix");
    return ok(undefined);
  }

  async #retainRoleProfile(
    manifest: SessionManifest,
    snapshot: ResolvedRoleProfileSnapshot | undefined,
    options?: OperationOptions
  ): Promise<OperationResult<SessionManifest>> {
    if (!snapshot) return ok(manifest);
    const parsed = ResolvedRoleProfileSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) return validationError("Invalid role profile snapshot");
    const previous = manifest.roleProfiles?.find(item => item.pin.profileId === parsed.data.pin.profileId && item.pin.version === parsed.data.pin.version);
    if (previous) return canonicalReceiptJson(previous) === canonicalReceiptJson(parsed.data)
      ? ok(manifest) : conflictError("Session role profile snapshot cannot be replaced");
    return this.#store.save({ ...manifest, roleProfiles: [...manifest.roleProfiles ?? [], parsed.data] }, options);
  }

  async allocateSpecialist(request: SpecialistAllocationRequest, options?: OperationOptions): Promise<OperationResult<PaneBinding>> {
    return this.#serializeAllocation(() => this.#allocateSpecialist(request, options));
  }

  async #allocateSpecialist(request: SpecialistAllocationRequest, options?: OperationOptions): Promise<OperationResult<PaneBinding>> {
    try {
      if (!request || typeof request !== "object" || typeof request.taskId !== "string" || !request.taskId)
        return validationError("Specialist allocation requires taskId");
      const spec = getRoleTopologySpec(request.role);
      // Do not turn tester->qa legacy aliases into profile authority or invent unsupported topology.
      if (!spec || request.role === "developer" || spec.contractRole !== request.role || !spec.permanent)
        return validationError("Profile specialist base role has no dedicated supported topology");
      const kind = request.agentKind ?? this.#config.roleConfigs?.[spec.topologyRole]?.agentKind ?? this.#config.defaultAgentKind ?? "codex";
      const valid = await this.#validateRoleProfileLaunch(request.roleProfile, request.role, request.launch, kind);
      if (!valid.ok) return valid;
      if (!request.roleProfile) return validationError("Specialist profile snapshot is required");
      const socketCheck = this.#requireSocketFor([request.launch]);
      if (!socketCheck.ok) return socketCheck;
      const loaded = await this.#store.load(this.#config.sessionId, options);
      if (!loaded.ok) return loaded;
      if (!loaded.value) return notFoundError("Session manifest is required for specialist allocation");
      let manifest = loaded.value;
      const active = manifest.panes.find(pane => pane.role === request.role && pane.permanent === false && pane.metadata?.["allocationStatus"] !== "released");
      if (active) {
        if (active.metadata?.["taskId"] !== request.taskId || !sameRoleProfilePin(active.roleProfile, request.roleProfile.pin) ||
            active.metadata?.["launchId"] !== request.launch.launchId || active.metadata?.["launchFingerprint"] !== request.launch.launchFingerprint)
          return conflictError("Base specialist capacity is occupied by another assignment/profile");
        const health = await this.inspectRoleHealth(active.bindingId, options);
        return health.ok && health.value.status === "ready" ? ok(active) : conflictError("Profile specialist launch requires reconciliation");
      }
      const base = manifest.panes.find(pane => pane.role === request.role && pane.permanent !== false && !pane.roleProfile);
      if (!base) return conflictError("Base specialist topology is not ready");
      const health = await this.inspectRoleHealth(base.bindingId, options);
      if (!health.ok) return health;
      if (health.value.status !== "ready") return conflictError("Base specialist capacity is busy or not ready");
      const retained = await this.#retainRoleProfile(manifest, request.roleProfile, options);
      if (!retained.ok) return retained;
      manifest = retained.value;
      const name = request.agentName ?? `profile-${request.role}-${request.launch.launchId.replace(/[^a-z0-9_-]/gi, "").toLowerCase()}`.slice(0, 32);
      if (!isValidAgentName(name)) return validationError("Invalid specialist agent name");
      if (manifest.panes.some(pane => pane.metadata?.["launchId"] === request.launch.launchId))
        return conflictError("Specialist launch context is already bound");
      const split = await this.#splitPane(base.paneId, "right", request.cwd ?? this.#config.workspaceRoot, request.launch,
        "Failed to create dedicated profiled specialist pane", options);
      if (!split.ok) return split;
      const started = await this.startAgentInPane({ role: request.role, roleProfile: request.roleProfile,
        paneId: split.value.paneId, workspaceId: split.value.workspaceId, tabId: split.value.tabId,
        cwd: request.cwd ?? this.#config.workspaceRoot, agentName: name, agentKind: kind,
        ...(request.model !== undefined ? { model: request.model } : {}), launch: request.launch,
        ...(request.startupTimeoutMs !== undefined ? { timeoutMs: request.startupTimeoutMs } : {}), permanent: false,
        metadata: { topologyRole: spec.topologyRole, taskId: request.taskId, allocationStatus: "active",
          ...(request.runId !== undefined ? { runId: request.runId } : {}) } }, options);
      // Uncertain launch remains in the manifest; never retry/close it as if delivery were known.
      if (!started.ok) return started;
      const saved = await this.#store.save({ ...manifest, panes: [...manifest.panes, started.value], updatedAt: this.#clock().toISOString() }, options);
      return saved.ok ? ok(started.value) : saved;
    } catch (error) { return toProtocolError(error, "Failed to allocate profiled specialist"); }
  }

  async releaseSpecialist(request: SpecialistReleaseRequest, options?: OperationOptions): Promise<OperationResult<DeveloperReleaseOutcome>> {
    return this.#serializeAllocation(async () => {
      try {
        if (!request || typeof request !== "object") return validationError("Specialist release request is required");
        const loaded = await this.#store.load(this.#config.sessionId, options);
        if (!loaded.ok) return loaded;
        if (!loaded.value) return notFoundError("Session manifest is required for specialist release");
        const manifest = loaded.value;
        const binding = manifest.panes.find(pane => pane.role !== "developer" && pane.permanent === false && pane.roleProfile &&
          (request.taskId !== undefined && pane.metadata?.["taskId"] === request.taskId ||
            request.agentId !== undefined && pane.agentId === request.agentId || request.paneId !== undefined && pane.paneId === request.paneId));
        if (!binding) return notFoundError("Profile specialist binding not found");
        // Record the release intent before the irreversible close. If we stop in between, restart recovery sees a
        // released allocation instead of an "active" binding whose agent no longer exists (which would block the session).
        const releasing = await this.#store.save({ ...manifest, updatedAt: this.#clock().toISOString(),
          panes: manifest.panes.map(pane => pane.bindingId === binding.bindingId
            ? { ...pane, metadata: { ...pane.metadata, allocationStatus: "released" } } : pane) }, options);
        if (!releasing.ok) return releasing;
        const closed = await this.#runHerdr(["pane", "close", binding.paneId], options);
        if (closed.exitCode !== 0 || closed.failure) {
          // The pane may already be gone (an interrupted release, or a stale pane the operator closed). Only an observed absence completes it.
          const probe = await this.#runHerdr(["pane", "get", binding.paneId], options);
          if (probe.exitCode === 0 && !probe.failure) return toCommandError(closed, "Failed to close specialist pane");
        } else parseOkResponse(closed);
        const saved = await this.#store.save({ ...releasing.value, panes: releasing.value.panes.filter(pane => pane.bindingId !== binding.bindingId),
          updatedAt: this.#clock().toISOString() }, options);
        return saved.ok ? ok({ releasedBinding: binding, paneClosed: true, worktreeRemoved: false, retainedForReuse: false, manifest: saved.value }) : saved;
      } catch (error) { return toProtocolError(error, "Failed to release profiled specialist"); }
    });
  }

  async allocateDeveloper(
    request: DeveloperAllocationRequest,
    options?: OperationOptions
  ): Promise<OperationResult<PaneBinding>> {
    return this.#serializeAllocation(() => this.#allocateDeveloper(request, options));
  }

  async #allocateDeveloper(request: DeveloperAllocationRequest, options?: OperationOptions): Promise<OperationResult<PaneBinding>> {
    try {
      if (!request || typeof request !== "object") {
        return validationError("DeveloperAllocationRequest must be an object");
      }
      if (!request.taskId || typeof request.taskId !== "string") {
        return validationError("DeveloperAllocationRequest.taskId is required");
      }
      if (!request.worktreePath || typeof request.worktreePath !== "string") {
        return validationError("DeveloperAllocationRequest.worktreePath is required");
      }
      const profileCheck = await this.#validateRoleProfileLaunch(request.roleProfile, "developer", request.launch,
        request.agentKind ?? this.#config.roleConfigs?.developer?.agentKind ?? this.#config.defaultAgentKind ?? "codex");
      if (!profileCheck.ok) return profileCheck;
      if (request.roleProfile && request.args !== undefined) return validationError("Profile launch arguments must come from Runtime launch material");
      const socketCheck = this.#requireSocketFor([request.launch]);
      if (!socketCheck.ok) return socketCheck;
      const developerEnv = launchEnvOf(request.launch);

      const loadResult = await this.#store.load(this.#config.sessionId, options);
      if (!loadResult.ok) return loadResult;
      let manifest = loadResult.value;
      if (!manifest) {
        return notFoundError(`Session manifest not found for session '${this.#config.sessionId}'`);
      }

      // Idempotent safe reuse if task is already active
      const existingTaskDeveloper = manifest.panes.find(
        (p) =>
          p.role === "developer" &&
          p.metadata?.["taskId"] === request.taskId &&
          p.metadata?.["allocationStatus"] !== "released"
      );
      if (existingTaskDeveloper && (!sameRoleProfilePin(existingTaskDeveloper.roleProfile, request.roleProfile?.pin) ||
          (request.roleProfile && (existingTaskDeveloper.metadata?.["launchId"] !== request.launch?.launchId ||
            existingTaskDeveloper.metadata?.["launchFingerprint"] !== request.launch?.launchFingerprint))))
        return conflictError("Active task profile/launch cannot change without a new accepted allocation");
      // The same allocation whose pane vanished (e.g. with an earlier host generation) runs no provider process; drop it so
      // Runtime can reallocate the task instead of colliding with its stale binding or a reused Herdr pane ID.
      if (existingTaskDeveloper) {
        const health = await this.inspectRoleHealth(existingTaskDeveloper.bindingId, options);
        if (health.ok && (!health.value.paneExists || !health.value.occupantMatches)) {
          const pruned = await this.#store.save({ ...manifest, updatedAt: this.#clock().toISOString(),
            panes: manifest.panes.filter(pane => pane.bindingId !== existingTaskDeveloper.bindingId) }, options);
          if (!pruned.ok) return pruned;
          manifest = pruned.value;
        }
      }
      if (existingTaskDeveloper && manifest.panes.includes(existingTaskDeveloper) && existingTaskDeveloper.worktreePath === request.worktreePath) {
        const health = await this.inspectRoleHealth(existingTaskDeveloper.bindingId, options);
        if (health.ok && (health.value.status === "ready" || health.value.status === "working")) {
          return ok(existingTaskDeveloper);
        }
      }

      const activeDevelopers = manifest.panes.filter(
        (p) => p.role === "developer" && p.metadata?.["allocationStatus"] !== "released"
      );

      // Single-writer check
      const conflictingDeveloper = activeDevelopers.find(
        (p) =>
          p.worktreePath === request.worktreePath ||
          (request.branchName !== undefined && p.metadata?.["branchName"] === request.branchName)
      );
      if (conflictingDeveloper) {
        return conflictError(
          `Another developer agent '${conflictingDeveloper.agentId}' is already writing to worktree '${request.worktreePath}'`
        );
      }

      // Concurrency limit check. A retained allocation whose pane is gone (or now holds another occupant) runs no provider
      // process, so it uses no capacity; its worktree stays guarded by the single-writer check above until Runtime settles it.
      const maxCapacity = this.#config.maxDeveloperCapacity ?? 2;
      const occupying: PaneBinding[] = [];
      for (const developer of activeDevelopers) {
        const health = await this.inspectRoleHealth(developer.bindingId, options);
        if (!health.ok || health.value.paneExists && health.value.occupantMatches) occupying.push(developer);
      }
      if (occupying.length >= maxCapacity) {
        return conflictError(
          `Developer capacity limit reached: active developers (${occupying.length}) >= limit (${maxCapacity})`
        );
      }

      let retainedContinuation = false;
      if (request.continuation !== undefined) {
        const continuation = DeveloperContinuationAllocationSchema.safeParse(request.continuation);
        if (!continuation.success) return validationError("Invalid Developer continuation allocation");
        const proof = continuation.data;
        const source = manifest.panes.find(pane => pane.bindingId === proof.sourceBindingId && pane.role === "developer" &&
          pane.metadata?.["allocationStatus"] === "released" && pane.metadata?.["taskId"] === request.taskId && pane.metadata?.["runId"] === request.runId);
        if (!source || proof.allocationTaskId !== request.taskId || proof.runId !== request.runId || proof.worktreePath !== request.worktreePath ||
            source.worktreePath !== request.worktreePath || !await this.#authorizeStoppedRetainedRelease?.(source))
          return conflictError("Continuation requires the exact released, proven-stopped source binding in the same task worktree");
        retainedContinuation = true;
      }
      // Cleanliness check: an exact stopped task continuation may preserve its scoped unfinished files.
      const inspected = await this.#worktreeInspector.inspect(request.worktreePath, options);
      if (!inspected.ok) {
        return inspected;
      }
      const within = (path: string, prefix: string) => prefix === "." || path === prefix.replace(/\/$/, "") || path.startsWith(prefix.replace(/\/$/, "") + "/");
      const retainedDirty = retainedContinuation && request.continuation !== undefined && inspected.value.dirtyFiles.every(path =>
        !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..") &&
        !request.continuation!.forbiddenPaths.some(prefix => within(path, prefix)) &&
        (request.continuation!.ownedPaths.some(prefix => within(path, prefix)) || inspected.value.ignoredFiles?.includes(path)));
      if (inspected.value.exists && !inspected.value.isClean && !retainedDirty) {
        return conflictError(
          `Cannot allocate developer in working tree with uncommitted changes not belonging to task: ${inspected.value.dirtyFiles.join(", ")}`
        );
      }

      const snapshotted = await this.#retainRoleProfile(manifest, request.roleProfile, options);
      if (!snapshotted.ok) return snapshotted;
      manifest = snapshotted.value;
      const agentListOutcome = await this.#runHerdr(["agent", "list"], options);
      const liveAgents = agentListOutcome.exitCode === 0 && !agentListOutcome.failure
        ? parseAgentListResult(agentListOutcome)
        : [];

      // Safe reuse of idle released developer pane
      const releasedCandidate = manifest.panes.find(
        (p) =>
          p.role === "developer" &&
          p.metadata?.["allocationStatus"] === "released" &&
          p.worktreePath === request.worktreePath
      );

      if (this.#config.reuseIdleDeveloperPanes !== false && releasedCandidate) {
        const paneOutcome = await this.#runHerdr(["pane", "get", releasedCandidate.paneId], options);
        if (paneOutcome.exitCode === 0 && !paneOutcome.failure) {
          const paneInfo = parsePaneInfoResult(paneOutcome);
          let targetPane = paneInfo;
          let oldPaneToClose: string | null = null;

          const liveAgent = liveAgents.find((a) => a.paneId === releasedCandidate.paneId);
          const profileContext = request.roleProfile !== undefined || releasedCandidate.roleProfile !== undefined;
          const effectiveAgentName = request.agentName ?? (liveAgent && !profileContext ? releasedCandidate.agentId : this.#allocateUniqueDeveloperName(request.taskId, manifest, liveAgents));
          // Env is fixed at pane creation: a released pane made for another launch is never reused.
          const releasedEnvMismatch = profileContext || developerEnv !== undefined && releasedCandidate.metadata?.["launchId"] !== request.launch?.launchId;
          const splitReleased = () => this.#herdrCreate<HerdrPaneInfo>(
            {
              method: "pane.split",
              params: { target_pane_id: releasedCandidate.paneId, direction: "right" },
              args: ["pane", "split", releasedCandidate.paneId, "--direction", "right"]
            },
            developerEnv,
            parsePaneInfoResult,
            `Failed to split pane from '${releasedCandidate.paneId}'`,
            options
          );

          // If the live pane is already occupied by an agent with a different name than requested,
          // split a fresh pane in the same tab and close the old pane so the new agent does not conflict.
          let oldPaneClosedEarly = false;
          if ((paneInfo.agent !== null && liveAgent && liveAgent.name !== effectiveAgentName) || releasedEnvMismatch) {
            const split = await splitReleased();
            if (split.ok) {
              targetPane = split.value;
              oldPaneToClose = releasedCandidate.paneId;
              if (releasedEnvMismatch) {
                // The same agent name cannot start while the old pane still owns it; the released pane carries another launch's env.
                await this.#closePane(oldPaneToClose, options);
                oldPaneClosedEarly = true;
              }
            } else if (releasedEnvMismatch) {
              return split;
            }
          }

          let startResult = await this.startAgentInPane(
            {
              role: "developer",
              ...(request.roleProfile ? { roleProfile: request.roleProfile } : {}),
              paneId: targetPane.paneId,
              workspaceId: targetPane.workspaceId,
              tabId: targetPane.tabId,
              cwd: request.worktreePath,
              worktreePath: request.worktreePath,
              agentName: effectiveAgentName,
              agentKind: request.agentKind ?? this.#config.defaultAgentKind ?? "codex",
              ...(request.model !== undefined ? { model: request.model } : {}),
              ...(request.args !== undefined ? { args: request.args } : {}), ...(request.launch !== undefined ? { launch: request.launch } : {}),
              ...(request.startupTimeoutMs !== undefined ? { timeoutMs: request.startupTimeoutMs } : {}),
              permanent: false,
              metadata: {
                topologyRole: "developer",
                taskId: request.taskId,
                ...(request.runId !== undefined ? { runId: request.runId } : {}),
                ...(request.branchName !== undefined ? { branchName: request.branchName } : {}),
                allocationStatus: "active"
              }
            },
            options
          );

          if (!startResult.ok && oldPaneToClose === null && startResult.error.code === "conflict") {
            const splitOutcome = await splitReleased();
            if (splitOutcome.ok) {
              targetPane = splitOutcome.value;
              oldPaneToClose = releasedCandidate.paneId;
              startResult = await this.startAgentInPane(
                {
                  role: "developer",
                  ...(request.roleProfile ? { roleProfile: request.roleProfile } : {}),
                  paneId: targetPane.paneId,
                  workspaceId: targetPane.workspaceId,
                  tabId: targetPane.tabId,
                  cwd: request.worktreePath,
                  worktreePath: request.worktreePath,
                  agentName: effectiveAgentName,
                  agentKind: request.agentKind ?? this.#config.defaultAgentKind ?? "codex",
                  ...(request.model !== undefined ? { model: request.model } : {}),
                  ...(request.args !== undefined ? { args: request.args } : {}), ...(request.launch !== undefined ? { launch: request.launch } : {}),
                  ...(request.startupTimeoutMs !== undefined ? { timeoutMs: request.startupTimeoutMs } : {}),
                  permanent: false,
                  metadata: {
                    topologyRole: "developer",
                    taskId: request.taskId,
                    ...(request.runId !== undefined ? { runId: request.runId } : {}),
                    ...(request.branchName !== undefined ? { branchName: request.branchName } : {}),
                    allocationStatus: "active"
                  }
                },
                options
              );
            }
          }

          if (startResult.ok) {
            if (oldPaneToClose !== null && !oldPaneClosedEarly) {
              await this.#closePane(oldPaneToClose, options);
            }
            const updatedPanes = oldPaneToClose !== null
              ? [
                  ...manifest.panes.filter(
                    (p) => p.paneId !== oldPaneToClose && p.bindingId !== releasedCandidate.bindingId
                  ),
                  startResult.value
                ]
              : manifest.panes.map((p) =>
                  p.bindingId === releasedCandidate.bindingId || p.paneId === startResult.value.paneId
                    ? startResult.value
                    : p
                );
            const updatedManifest: SessionManifest = {
              ...manifest,
              panes: updatedPanes,
              updatedAt: this.#clock().toISOString()
            };
            const validatedManifest = SessionManifestSchema.safeParse(updatedManifest);
            if (!validatedManifest.success) {
              return validationError(`Updated session manifest is invalid: ${validatedManifest.error.message}`);
            }
            const saveResult = await this.#store.save(validatedManifest.data, options);
            if (!saveResult.ok) return saveResult;
            return ok(startResult.value);
          } else if (oldPaneToClose !== null) {
            await this.#closePane(targetPane.paneId, options);
          }
        }
      }

      const agentName = request.agentName ?? this.#allocateUniqueDeveloperName(request.taskId, manifest, liveAgents);
      if (!isValidAgentName(agentName)) {
        return validationError(`Invalid developer agent name '${agentName}'`);
      }

      // Create or open worktree
      let wtWorkspaceId: string;
      let wtTabId: string;
      let wtPaneId: string;

      if (inspected.value.exists) {
        const openOutcome = await this.#runHerdr(
          ["worktree", "open", "--workspace", manifest.herdrWorkspaceId, "--path", request.worktreePath, "--label", agentName, "--no-focus"],
          options
        );
        if (openOutcome.exitCode !== 0 || openOutcome.failure) {
          return toCommandError(openOutcome, `Failed to open existing worktree at '${request.worktreePath}'`);
        }
        const wtCreated = parseWorktreeCreatedResult(openOutcome);
        wtWorkspaceId = wtCreated.workspace.workspaceId;
        wtTabId = wtCreated.tab.tabId;
        wtPaneId = wtCreated.rootPane.paneId;
      } else {
        const createArgs = [
          "worktree",
          "create",
          "--workspace",
          manifest.herdrWorkspaceId,
          "--path",
          request.worktreePath,
          "--label",
          agentName,
          "--no-focus"
        ];
        if (request.branchName) {
          createArgs.push("--branch", request.branchName);
        }
        if (request.baseRef) {
          createArgs.push("--base", request.baseRef);
        }
        const createOutcome = await this.#runHerdr(createArgs, options);
        if (createOutcome.exitCode !== 0 || createOutcome.failure) {
          return toCommandError(createOutcome, `Failed to create worktree at '${request.worktreePath}'`);
        }
        const wtCreated = parseWorktreeCreatedResult(createOutcome);
        wtWorkspaceId = wtCreated.workspace.workspaceId;
        wtTabId = wtCreated.tab.tabId;
        wtPaneId = wtCreated.rootPane.paneId;
      }

      if (developerEnv !== undefined || request.roleProfile !== undefined) {
        // The worktree root pane was created without launch env. The Developer pane is split with env instead,
        // and the root is closed unless the manifest still owns it.
        const split = await this.#herdrCreate<HerdrPaneInfo>(
          {
            method: "pane.split",
            params: { target_pane_id: wtPaneId, direction: "right", cwd: request.worktreePath, focus: false },
            args: ["pane", "split", wtPaneId, "--direction", "right", "--cwd", request.worktreePath, "--no-focus"]
          },
          developerEnv,
          parsePaneInfoResult,
          `Failed to create developer pane for '${request.worktreePath}'`,
          options
        );
        if (!split.ok) return split;
        if (!manifest.panes.some(p => p.paneId === wtPaneId)) await this.#closePane(wtPaneId, options);
        wtPaneId = split.value.paneId;
        wtWorkspaceId = split.value.workspaceId;
        wtTabId = split.value.tabId;
      }

      const startResult = await this.startAgentInPane(
        {
          role: "developer",
          ...(request.roleProfile ? { roleProfile: request.roleProfile } : {}),
          paneId: wtPaneId,
          workspaceId: wtWorkspaceId,
          tabId: wtTabId,
          cwd: request.worktreePath,
          worktreePath: request.worktreePath,
          agentName,
          agentKind: request.agentKind ?? this.#config.defaultAgentKind ?? "codex",
          ...(request.model !== undefined ? { model: request.model } : {}),
          ...(request.args !== undefined ? { args: request.args } : {}), ...(request.launch !== undefined ? { launch: request.launch } : {}),
          ...(request.startupTimeoutMs !== undefined ? { timeoutMs: request.startupTimeoutMs } : {}),
          permanent: false,
          metadata: {
            topologyRole: "developer",
            taskId: request.taskId,
            ...(request.runId !== undefined ? { runId: request.runId } : {}),
            ...(request.branchName !== undefined ? { branchName: request.branchName } : {}),
            allocationStatus: "active"
          }
        },
        options
      );
      if (!startResult.ok) {
        return startResult;
      }

      const updatedPanes = [
        ...manifest.panes.filter((p) => p.paneId !== startResult.value.paneId),
        startResult.value
      ];
      const updatedManifest: SessionManifest = {
        ...manifest,
        panes: updatedPanes,
        updatedAt: this.#clock().toISOString()
      };
      const saveResult = await this.#store.save(updatedManifest, options);
      if (!saveResult.ok) return saveResult;

      return ok(startResult.value);
    } catch (err) {
      return toProtocolError(err, `Failed to allocate developer for task '${request.taskId}'`);
    }
  }

  async releaseDeveloper(
    request: DeveloperReleaseRequest,
    options?: OperationOptions
  ): Promise<OperationResult<DeveloperReleaseOutcome>> {
    try {
      if (!request || typeof request !== "object") {
        return validationError("DeveloperReleaseRequest must be an object");
      }

      const loadResult = await this.#store.load(this.#config.sessionId, options);
      if (!loadResult.ok) return loadResult;
      const manifest = loadResult.value;
      if (!manifest) {
        return notFoundError(`Session manifest not found for session '${this.#config.sessionId}'`);
      }

      const binding = manifest.panes.find(
        (p) =>
          p.role === "developer" &&
          ((request.taskId !== undefined && p.metadata?.["taskId"] === request.taskId) ||
            (request.agentId !== undefined && p.agentId === request.agentId) ||
            (request.paneId !== undefined && p.paneId === request.paneId))
      );

      if (!binding) {
        return notFoundError("Developer binding not found for release request");
      }

      const worktreePath = binding.worktreePath ?? binding.cwd;
      const inspected = await this.#worktreeInspector.inspect(worktreePath, options);
      if (!inspected.ok) return inspected;
      const retainsWorktreeData = request.removeWorktree !== true;
      const ignoredOnly = inspected.value.dirtyFiles.length > 0 && inspected.value.ignoredFiles !== undefined &&
        inspected.value.dirtyFiles.every(path => inspected.value.ignoredFiles!.includes(path));
      // The host stop proof is consulted only when it is what permits the release: a clean worktree never depends on it.
      const needsStopProof = !inspected.value.isClean && !(retainsWorktreeData && ignoredOnly);
      const stoppedRetained = needsStopProof && retainsWorktreeData && request.closePane !== true && this.#config.reuseIdleDeveloperPanes !== false &&
        await this.#authorizeStoppedRetainedRelease?.(PaneBindingSchema.parse(binding)) === true;
      if (needsStopProof && !stoppedRetained) {
        return conflictError(
          `Cannot release, close, or remove developer worktree containing uncommitted changes: ${inspected.value.dirtyFiles.join(", ")}`
        );
      }

      let paneClosed = false;
      let worktreeRemoved = false;
      let retainedForReuse = false;
      let updatedPanes: PaneBinding[];

      if (request.removeWorktree === true) {
        const removeOutcome = await this.#runHerdr(["worktree", "remove", "--workspace", binding.workspaceId], options);
        if (removeOutcome.exitCode !== 0 || removeOutcome.failure) {
          return toCommandError(removeOutcome, `Failed to remove worktree for workspace '${binding.workspaceId}'`);
        }
        parseWorktreeRemovedResult(removeOutcome);
        worktreeRemoved = true;
        paneClosed = true;
        updatedPanes = manifest.panes.filter((p) => p.bindingId !== binding.bindingId);
      } else if (request.closePane === true || this.#config.reuseIdleDeveloperPanes === false) {
        const closeOutcome = await this.#runHerdr(["pane", "close", binding.paneId], options);
        if (closeOutcome.exitCode !== 0 || closeOutcome.failure) {
          return toCommandError(closeOutcome, `Failed to close pane '${binding.paneId}'`);
        }
        parseOkResponse(closeOutcome);
        paneClosed = true;
        updatedPanes = manifest.panes.filter((p) => p.bindingId !== binding.bindingId);
      } else {
        retainedForReuse = true;
        const releasedBinding: PaneBinding = {
          ...binding,
          ...(stoppedRetained ? { readOnlyWorkspace: true, transportState: "cancelled" as const } : {}),
          metadata: {
            ...binding.metadata,
            allocationStatus: "released",
            releasedAt: this.#clock().toISOString()
          }
        };
        updatedPanes = manifest.panes.map((p) => (p.bindingId === binding.bindingId ? releasedBinding : p));
      }

      const updatedManifest: SessionManifest = {
        ...manifest,
        panes: updatedPanes,
        updatedAt: this.#clock().toISOString()
      };

      const saved = await this.#store.save(updatedManifest, options);
      if (!saved.ok) return saved;

      return ok<DeveloperReleaseOutcome>({
        releasedBinding: binding,
        paneClosed,
        worktreeRemoved,
        retainedForReuse,
        manifest: saved.value
      });
    } catch (err) {
      return toProtocolError(err, "Failed to release developer");
    }
  }

  async moveRolePane(
    selector: RoleSelector | string,
    destination: PaneMoveDestinationSpec,
    options?: OperationOptions
  ): Promise<OperationResult<PaneBinding>> {
    try {
      const loadResult = await this.#store.load(this.#config.sessionId, options);
      if (!loadResult.ok) return loadResult;
      const manifest = loadResult.value;
      if (!manifest) {
        return notFoundError(`Session manifest not found for session '${this.#config.sessionId}'`);
      }

      const topoRole = resolveTopologyRole(selector);
      const binding = manifest.panes.find(
        (p) =>
          p.bindingId === selector ||
          p.paneId === selector ||
          p.agentId === selector ||
          p.role === selector ||
          (topoRole !== null && (p.metadata?.["topologyRole"] === topoRole || p.role === topoRole))
      );

      if (!binding) {
        return notFoundError(`Pane binding not found for selector '${selector}'`);
      }

      const moveArgs = ["pane", "move", binding.paneId];
      if (destination.mode === "tab") {
        moveArgs.push("--tab", destination.tabId, "--split", destination.splitDirection);
        if (destination.targetPaneId) {
          moveArgs.push("--target-pane", destination.targetPaneId);
        }
        moveArgs.push(destination.focus ? "--focus" : "--no-focus");
      } else if (destination.mode === "new_tab") {
        moveArgs.push("--new-tab");
        if (destination.workspaceId) {
          moveArgs.push("--workspace", destination.workspaceId);
        }
        if (destination.label) {
          moveArgs.push("--label", destination.label);
        }
        moveArgs.push(destination.focus ? "--focus" : "--no-focus");
      } else if (destination.mode === "new_workspace") {
        moveArgs.push("--new-workspace");
        if (destination.label) {
          moveArgs.push("--label", destination.label);
        }
        if (destination.tabLabel) {
          moveArgs.push("--tab-label", destination.tabLabel);
        }
        moveArgs.push(destination.focus ? "--focus" : "--no-focus");
      }

      const moveOutcome = await this.#runHerdr(moveArgs, options);
      if (moveOutcome.exitCode !== 0 || moveOutcome.failure) {
        return toCommandError(moveOutcome, `Failed to move pane '${binding.paneId}'`);
      }

      const moveResult = parsePaneMoveResult(moveOutcome);

      const role =
        (binding.metadata?.["topologyRole"] as TopologyRole | undefined) ??
        resolveTopologyRole(binding.role) ??
        binding.role;
      const newBindingId = `binding-${role}-${moveResult.pane.paneId}`;

      const updatedBinding: PaneBinding = {
        ...binding,
        bindingId: newBindingId,
        paneId: moveResult.pane.paneId,
        workspaceId: moveResult.pane.workspaceId,
        tabId: moveResult.pane.tabId,
        ...(moveResult.pane.terminalId !== undefined ? { terminalId: moveResult.pane.terminalId } : {}),
        lastHeartbeatAt: this.#clock().toISOString()
      };

      const parsedBinding = PaneBindingSchema.safeParse(updatedBinding);
      if (!parsedBinding.success) {
        return validationError(
          `Failed to validate moved pane binding: ${parsedBinding.error.message}`,
          parsedBinding.error.issues
        );
      }
      const validatedBinding = parsedBinding.data;

      const updatedPanes = manifest.panes.map((p) =>
        p.bindingId === binding.bindingId ? validatedBinding : p
      );

      const updatedManifest: SessionManifest = {
        ...manifest,
        panes: updatedPanes,
        ...(binding.role === "conversation"
          ? {
              herdrWorkspaceId: moveResult.pane.workspaceId,
              herdrTabId: moveResult.pane.tabId,
              attachTarget: {
                role: "conversation" as const,
                paneId: moveResult.pane.paneId,
                ...(moveResult.pane.terminalId !== undefined ? { terminalId: moveResult.pane.terminalId } : {})
              }
            }
          : {}),
        updatedAt: this.#clock().toISOString()
      };

      const validatedManifest = SessionManifestSchema.safeParse(updatedManifest);
      if (!validatedManifest.success) {
        return validationError(
          `Failed to validate updated session manifest: ${validatedManifest.error.message}`,
          validatedManifest.error.issues
        );
      }

      const saveResult = await this.#store.save(validatedManifest.data, options);
      if (!saveResult.ok) return saveResult;

      return ok(validatedBinding);
    } catch (err) {
      return toProtocolError(err, `Failed to move pane for selector '${selector}'`);
    }
  }

  async getManifest(options?: OperationOptions): Promise<OperationResult<SessionManifest | null>> {
    try {
      return await this.#store.load(this.#config.sessionId, options);
    } catch (err) {
      return toProtocolError(err, "Failed to get session manifest");
    }
  }

  async getRoleBinding(
    selector: RoleSelector | string,
    options?: OperationOptions
  ): Promise<OperationResult<PaneBinding | null>> {
    try {
      const loadResult = await this.#store.load(this.#config.sessionId, options);
      if (!loadResult.ok) return loadResult;
      const manifest = loadResult.value;
      if (!manifest) {
        return ok(null);
      }

      const topoRole = resolveTopologyRole(selector);
      const binding =
        manifest.panes.find(
          (p) =>
            p.bindingId === selector ||
            p.paneId === selector ||
            p.agentId === selector ||
            p.role === selector ||
            (topoRole !== null && (p.metadata?.["topologyRole"] === topoRole || p.role === topoRole))
        ) ?? null;

      return ok(binding);
    } catch (err) {
      return toProtocolError(err, `Failed to get role binding for selector '${selector}'`);
    }
  }

  async listDeveloperBindings(options?: OperationOptions): Promise<OperationResult<readonly PaneBinding[]>> {
    try {
      const loadResult = await this.#store.load(this.#config.sessionId, options);
      if (!loadResult.ok) return loadResult;
      const manifest = loadResult.value;
      if (!manifest) {
        return ok([]);
      }

      return ok(manifest.panes.filter((p) => p.role === "developer"));
    } catch (err) {
      return toProtocolError(err, "Failed to list developer bindings");
    }
  }

  #allocateUniqueDeveloperName(
    taskId: string,
    manifest: SessionManifest | null,
    liveAgents: readonly HerdrAgentInfo[]
  ): string {
    const raw = taskId.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
    const baseSlug = raw.length > 0 ? raw.slice(0, 20) : "task";
    let candidate = `dev-${baseSlug}`;
    if (candidate.length > 32) {
      candidate = candidate.slice(0, 32);
    }
    const takenNames = new Set<string>();
    if (manifest) {
      for (const p of manifest.panes) {
        takenNames.add(p.agentId);
      }
    }
    for (const a of liveAgents) {
      if (a.name) takenNames.add(a.name);
    }

    if (!takenNames.has(candidate) && isValidAgentName(candidate)) {
      return candidate;
    }

    for (let i = 1; i < 1000; i++) {
      const suffixed = `dev-${baseSlug.slice(0, 26 - String(i).length)}-${i}`;
      if (!takenNames.has(suffixed) && isValidAgentName(suffixed)) {
        return suffixed;
      }
    }
    return `dev-${Date.now().toString(36).slice(-6)}`;
  }
}

/** Developer task panes and profiled specialist panes (permanent: false) belong to Runtime, not to the startup topology. */
function isRuntimeOwnedPane(pane: Pick<PaneBinding, "role" | "permanent">): boolean {
  return pane.role === "developer" || pane.permanent === false;
}
/**
 * Whether the permanent role panes are healthy enough for "up". A stale Runtime-owned pane (e.g. from a cancelled run, or a
 * profiled reviewer whose provider died with the previous host) is reconciled by Runtime after activation instead.
 */
export function startupPanesHealthy(panes: readonly Pick<PaneBinding, "role" | "permanent" | "transportState">[]): boolean {
  return panes.every((p) => isRuntimeOwnedPane(p) || ["idle", "done", "working", "accepted"].includes(p.transportState));
}

export function createRolePaneManager(options: RolePaneManagerOptions): RolePaneManager {
  return new RolePaneManager(options);
}
