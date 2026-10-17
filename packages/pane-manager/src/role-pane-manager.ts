import type {
  AgentSessionLocator,
  AgentTransportState,
  OperationOptions,
  OperationResult,
  PaneBinding,
  SessionManifest,
  SessionManifestStatus
} from "@bflow/contracts";
import {
  PaneBindingSchema,
  SessionManifestSchema
} from "@bflow/contracts";

import type {
  CommandOutcome,
  DeveloperAllocationRequest,
  DeveloperReleaseOutcome,
  DeveloperReleaseRequest,
  HerdrAgentInfo,
  HerdrCommandRunner,
  HerdrPaneInfo,
  HerdrTabInfo,
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
  readonly clock?: () => Date;
  readonly defaultTimeoutMs?: number;
}

export class RolePaneManager {
  readonly #config: RolePaneManagerConfig;
  readonly #runner: HerdrCommandRunner;
  readonly #store: SessionManifestStore;
  readonly #worktreeInspector: WorktreeInspector;
  readonly #clock: () => Date;
  readonly #defaultTimeoutMs: number;

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
    this.#clock = options.clock ?? (() => new Date());
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  async #runHerdr(args: readonly string[], options?: OperationOptions, env?: NodeJS.ProcessEnv): Promise<CommandOutcome> {
    const timeoutMs = options?.timeoutMs ?? this.#defaultTimeoutMs;
    return this.#runner.run({
      args,
      cwd: this.#config.workspaceRoot,
      ...(env !== undefined && { env }),
      ...(options?.signal && { signal: options.signal }),
      ...(timeoutMs !== undefined && { timeoutMs })
    });
  }

  async #closePane(paneId: string, options?: OperationOptions): Promise<void> {
    const outcome = await this.#runHerdr(["pane", "close", paneId], options);
    if (outcome.exitCode === 0 && !outcome.failure) {
      parseOkResponse(outcome);
    }
  }
  async #namePane(paneId: string, role: TopologyRole, agentName: string, options?: OperationOptions): Promise<OperationResult<void>> {
    const names: Record<TopologyRole, string> = { chat: "Chat · Conversation", coordinator: "Coordinator", planner: "Planner",
      analyst: "Analyst · Specification", architect: "Architect", reviewer: "Reviewer", "qa-verifier": "QA · Verifier", developer: `Developer · ${agentName}` };
    const outcome = await this.#runHerdr(["pane", "rename", paneId, names[role]], options);
    if (outcome.exitCode !== 0 || outcome.failure) return toCommandError(outcome, `Could not label ${role} pane '${paneId}'`);
    parsePaneInfoResult(outcome); return ok(undefined);
  }
  async #startupBlocked(role: TopologyRole, agentName: string, kind: string, paneId: string, state: string, options?: OperationOptions): Promise<OperationResult<PaneBinding>> {
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

      // A prior down may have closed a prefix before losing an acknowledgement.
      // Only a successful current listing proves those exact panes are absent.
      const listed = await this.#runHerdr(["pane", "list", "--workspace", manifest.herdrWorkspaceId], options);
      if (listed.exitCode !== 0 || listed.failure) return toCommandError(listed, "Cannot reconcile panes before shutdown");
      const livePaneIds = new Set(parsePaneListResult(listed).map(pane => pane.paneId));
      for (const pane of manifest.panes) {
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
      const createWsOutcome = await this.#runHerdr(
        ["workspace", "create", "--cwd", this.#config.workspaceRoot, "--label", this.#config.projectName, "--no-focus"],
        options
      );
      if (createWsOutcome.exitCode !== 0 || createWsOutcome.failure) {
        return toCommandError(createWsOutcome, `Failed to create workspace '${this.#config.projectName}'`);
      }
      const wsCreated = parseWorkspaceCreatedResult(createWsOutcome);
      herdrWorkspaceId = wsCreated.workspace.workspaceId;
      initialConversationTabId = wsCreated.tab.tabId;
      initialConversationRootPaneId = wsCreated.rootPane.paneId;
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
      const createConvOutcome = await this.#runHerdr(
        ["tab", "create", "--workspace", herdrWorkspaceId, "--cwd", this.#config.workspaceRoot, "--label", convLabel, "--no-focus"],
        options
      );
      if (createConvOutcome.exitCode !== 0 || createConvOutcome.failure) {
        return toCommandError(createConvOutcome, "Failed to create conversation tab");
      }
      const createdConv = parseTabCreatedResult(createConvOutcome);
      convTab = createdConv.tab;
      liveTabs = [...liveTabs, convTab];
      livePanes = [...livePanes, createdConv.rootPane];
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
        const createCoordOutcome = await this.#runHerdr(
          ["tab", "create", "--workspace", herdrWorkspaceId, "--cwd", this.#config.workspaceRoot, "--label", coordLabel, "--no-focus"],
          options
        );
        if (createCoordOutcome.exitCode !== 0 || createCoordOutcome.failure) {
          return toCommandError(createCoordOutcome, "Failed to create coordination tab");
        }
        const createdCoord = parseTabCreatedResult(createCoordOutcome);
        coordTab = createdCoord.tab;
        liveTabs = [...liveTabs, coordTab];
        livePanes = [...livePanes, createdCoord.rootPane];
      }
      finalCoordinationTabId = coordTab.tabId;
    }

    // 2.3 Ensure Verification Tab only when needed
    let finalVerificationTabId: string | null = null;
    if (hasVerifRoles) {
      let verifTab = liveTabs.find((t) => t.label === verifLabel || t.label === "verification");
      if (!verifTab) {
        const createVerifOutcome = await this.#runHerdr(
          ["tab", "create", "--workspace", herdrWorkspaceId, "--cwd", this.#config.workspaceRoot, "--label", verifLabel, "--no-focus"],
          options
        );
        if (createVerifOutcome.exitCode !== 0 || createVerifOutcome.failure) {
          return toCommandError(createVerifOutcome, "Failed to create verification tab");
        }
        const createdVerif = parseTabCreatedResult(createVerifOutcome);
        verifTab = createdVerif.tab;
        liveTabs = [...liveTabs, verifTab];
        livePanes = [...livePanes, createdVerif.rootPane];
      }
      finalVerificationTabId = verifTab.tabId;
    }

    const assignedPaneIds = new Set<string>();
    const splitDepths = new Map(livePanes.map(pane => [pane.paneId, 0]));
    const manifestPanes: PaneBinding[] = [];
    const persistProgress = async (binding: PaneBinding): Promise<OperationResult<SessionManifest>> => {
      const panes = [...manifestPanes.filter(p => p.paneId !== binding.paneId), binding];
      for (const previous of savedManifest?.panes ?? []) {
        if (!panes.some(p => p.paneId === previous.paneId || p.role === previous.role && p.permanent !== false)) panes.push(previous);
      }
      const conversation = panes.find(p => p.role === "conversation");
      return this.#store.save(SessionManifestSchema.parse({
        schemaVersion: 2, sessionId: this.#config.sessionId, projectName: this.#config.projectName,
        workspaceRoot: this.#config.workspaceRoot, herdrWorkspaceId, herdrTabId: finalConversationTabId,
        status: "initializing", conversationSessionId: this.#config.conversationSessionId ?? savedManifest?.conversationSessionId ?? `conv-${this.#config.sessionId}`,
        activeRunIds: savedManifest?.activeRunIds ?? [], panes,
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

      let healthyOccupant: HerdrAgentInfo | null = null;
      if (savedBinding) {
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

      if (!healthyOccupant) {
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

      // Otherwise, obtain an available shell pane in targetTabId
      let candidatePane: HerdrPaneInfo | null = null;
      // A recorded launch intent owns its pane even if startup is blocked or its
      // acknowledgement was lost. Inspect it in place; never split a duplicate.
      if (savedBinding) candidatePane = livePanes.find(p => p.paneId === savedBinding.paneId && p.tabId === targetTabId) ?? null;
      if (!candidatePane && initialConversationRootPaneId && targetTabId === finalConversationTabId && !assignedPaneIds.has(initialConversationRootPaneId)) {
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
              !assignedPaneIds.has(p.paneId)
          ) ?? null;
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
        const splitOutcome = await this.#runHerdr(
          ["pane", "split", sourcePane.paneId, "--direction", direction, "--cwd", this.#config.workspaceRoot, "--no-focus"],
          options
        );
        if (splitOutcome.exitCode !== 0 || splitOutcome.failure) {
          return toCommandError(splitOutcome, `Failed to split pane from '${sourcePane.paneId}'`);
        }
        const splitResult = parsePaneInfoResult(splitOutcome);
        selectedPaneId = splitResult.paneId;
        splitDepths.set(sourcePane.paneId, depth + 1); splitDepths.set(selectedPaneId, depth + 1);
        livePanes = [...livePanes, splitResult];
      }

      assignedPaneIds.add(selectedPaneId);

      const pending = this.#buildAndValidateBinding({ spec, agentName, agentKind,
        agentInfo: { name: agentName, agent: agentKind, paneId: selectedPaneId,
          terminalId: livePanes.find(p => p.paneId === selectedPaneId)!.terminalId,
          workspaceId: herdrWorkspaceId, tabId: targetTabId, focused: false, agentStatus: "unknown", revision: 0 },
        request: { role, paneId: selectedPaneId, workspaceId: herdrWorkspaceId, tabId: targetTabId,
          cwd: this.#config.workspaceRoot, permanent: true, metadata: { launchIntent: true } } });
      if (!pending.ok) return pending;
      const intentSaved = await persistProgress(pending.value);
      if (!intentSaved.ok) return intentSaved;

      const startResult = await this.startAgentInPane(
        {
          role,
          paneId: selectedPaneId,
          workspaceId: herdrWorkspaceId,
          tabId: targetTabId,
          cwd: this.#config.workspaceRoot,
          agentName,
          agentKind,
          permanent: true
        },
        options
      );
      if (!startResult.ok) {
        return startResult;
      }
      manifestPanes.push(startResult.value);
      const progress = await persistProgress(startResult.value);
      if (!progress.ok) return progress;
    }

    // Preserve any existing active/released developer panes
    if (savedManifest) {
      for (const p of savedManifest.panes) {
        if (p.role === "developer" && !assignedPaneIds.has(p.paneId)) {
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
    const allHealthy = manifestPanes.every(
      (p) =>
        (p.role === "developer" && p.metadata?.["allocationStatus"] === "released") ||
        p.transportState === "idle" ||
        p.transportState === "done" ||
        p.transportState === "working" ||
        p.transportState === "accepted"
    );
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
      const launchMetadata = launch !== undefined
        ? { launchId: launch.launchId, launchFingerprint: launch.launchFingerprint }
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
      const named = await this.#namePane(request.paneId, spec.topologyRole, agentName, options);
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
      for (let attempt = 0; attempt < 40 && (processInfo.foregroundSnapshotPending || processInfo.shellPid === null || processInfo.foregroundProcessGroupId === null); attempt++) {
        if (options?.signal?.aborted) return { ok: false, error: { code: "cancelled", retryable: false, message: "Shell startup wait interrupted; state preserved." } };
        await new Promise(resolve => setTimeout(resolve, 50));
        procOutcome = await this.#runHerdr(["pane", "process-info", "--pane", request.paneId], options);
        if (procOutcome.exitCode !== 0 || procOutcome.failure) return toCommandError(procOutcome, `Cannot observe startup shell in pane '${request.paneId}'`);
        processInfo = parsePaneProcessInfoResult(procOutcome);
      }
      const readiness = isShellReadyForAgent(pane, processInfo);
      if (!readiness.ready) {
        return conflictError(readiness.reason ?? `Pane '${request.paneId}' shell is not ready for agent startup`);
      }

      const startArgs = ["agent", "start", agentName, "--kind", agentKind, "--pane", request.paneId];
      const timeout = request.timeoutMs ?? roleConfig?.startupTimeoutMs;
      if (timeout !== undefined) {
        startArgs.push("--timeout", String(timeout));
      }
      let passedArgs = launch !== undefined ? [...launch.argv] : (request.args ?? roleConfig?.args);
      let originalPromptSource: string | undefined;
      if (launch !== undefined && ["chat", "coordinator"].includes(spec.topologyRole)) {
        // Launch profiles are not rewritten: the profile must already reference the original role prompt.
        const original = await readBuiltinRolePrompt(spec.topologyRole);
        if (!original) return validationError(`Required original prompt is missing for ${spec.topologyRole}`);
        if (agentKind !== "claude" && agentKind !== "codex") return validationError(`Native initial prompt injection for ${agentKind} is not verified. Configure role launch args for ${spec.topologyRole}.`);
        const argv = launch.argv;
        const referenced = agentKind === "claude"
          ? argv.some((value, index) => value === "--append-system-prompt-file" && argv[index + 1] === original.source)
          : argv.includes(`model_instructions_file=${JSON.stringify(original.source)}`);
        if (!referenced) return validationError(`Launch profile for ${spec.topologyRole} must reference the original Bflow role prompt; rebuild the launch profile.`);
        const file = await open(original.source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 131_072 || !(await file.readFile("utf8")).includes(original.prompt))
            return validationError(`The native ${spec.topologyRole} launch prompt does not contain its original Bflow role prompt. Rebuild the host launch configuration.`);
        } finally { await file.close(); }
        originalPromptSource = original.source;
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
      if (passedArgs && passedArgs.length > 0) {
        startArgs.push("--", ...passedArgs);
      }

      // Launch env travels only in the invocation environment, never in argv or the manifest.
      const startOutcome = await this.#runHerdr(
        startArgs,
        options,
        launch !== undefined ? { ...process.env, ...launch.env } : undefined
      );
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
        request: { ...request, metadata: { ...request.metadata, ...launchMetadata, ...(originalPromptSource ? { promptInitialized: true, promptSource: originalPromptSource } : {}),
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
      readonly paneId: string;
      readonly workspaceId: string;
      readonly tabId: string;
      readonly cwd: string;
      readonly worktreePath?: string;
      readonly model?: string;
      readonly permanent?: boolean;
      readonly metadata?: Record<string, unknown>;
    };
    readonly agentName: string;
    readonly agentKind: string;
  }): OperationResult<PaneBinding> {
    const { spec, agentInfo, request, agentName, agentKind } = args;
    const nowIso = this.#clock().toISOString();
    const roleConfig = this.#config.roleConfigs?.[spec.topologyRole];
    const provider = roleConfig?.provider ?? this.#config.defaultProvider ?? "herdr";
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
      const healthy = anomalies.length === 0;
      const newStatus: SessionManifestStatus = healthy && hasConversation && hasCoordinator ? "up" : "degraded";

      const updatedManifest: SessionManifest = {
        ...manifest,
        status: newStatus,
        panes: updatedPanes,
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
      const loadResult = await this.#store.load(this.#config.sessionId, options);
      if (!loadResult.ok) return loadResult;
      const savedManifest = loadResult.value;
      if (!savedManifest) {
        return notFoundError(`No persisted session manifest found for session '${this.#config.sessionId}' to recover`);
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
        const createWsOutcome = await this.#runHerdr(
          ["workspace", "create", "--cwd", savedManifest.workspaceRoot, "--label", savedManifest.projectName, "--no-focus"],
          options
        );
        if (createWsOutcome.exitCode !== 0 || createWsOutcome.failure) {
          return toCommandError(createWsOutcome, "Failed to recreate workspace during restart recovery");
        }
        const created = parseWorkspaceCreatedResult(createWsOutcome);
        herdrWorkspaceId = created.workspace.workspaceId;
        herdrTabId = created.tab.tabId;
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
        const topologyRole = ((binding.metadata?.["topologyRole"] as TopologyRole | undefined) ??
          resolveTopologyRole(binding.role) ??
          "developer") as TopologyRole;
        const spec = ROLE_TOPOLOGY_SPECS[topologyRole];

        // Case A: Matching live agent found
        const matchingLiveAgent = liveAgents.find(
          (a) => a.name === binding.agentId && a.agent === binding.agentKind && !usedPaneIds.has(a.paneId)
        );

        if (matchingLiveAgent) {
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
        if (existingPane) {
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
            const createTabOutcome = await this.#runHerdr(
              ["tab", "create", "--workspace", herdrWorkspaceId, "--cwd", binding.cwd, "--label", desiredTabLabel, "--no-focus"],
              options
            );
            if (createTabOutcome.exitCode !== 0 || createTabOutcome.failure) {
              return toCommandError(createTabOutcome, `Failed to recreate tab '${desiredTabLabel}' during restart recovery`);
            }
            const created = parseTabCreatedResult(createTabOutcome);
            roleTab = created.tab;
            currentTabs = [...currentTabs, roleTab];
            livePanes = [...livePanes, created.rootPane];
          }

          let targetPaneId: string;
          const availableShellPane = livePanes.find(
            (p) => p.tabId === roleTab?.tabId && p.agent === null && !usedPaneIds.has(p.paneId)
          );

          if (availableShellPane) {
            targetPaneId = availableShellPane.paneId;
          } else {
            const sourcePane = livePanes.find((p) => p.tabId === roleTab?.tabId) ?? livePanes[0];
            if (!sourcePane) {
              return validationError(`No pane available in workspace '${herdrWorkspaceId}' to split`);
            }
            const splitOutcome = await this.#runHerdr(
              ["pane", "split", sourcePane.paneId, "--direction", "right", "--cwd", binding.cwd, "--no-focus"],
              options
            );
            if (splitOutcome.exitCode !== 0 || splitOutcome.failure) {
              return toCommandError(splitOutcome, `Failed to split pane from '${sourcePane.paneId}'`);
            }
            const split = parsePaneInfoResult(splitOutcome);
            livePanes = [...livePanes, split];
            targetPaneId = split.paneId;
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
      const allHealthy = recoveredPanes.every(
        (p) =>
          (p.role === "developer" && p.metadata?.["allocationStatus"] === "released") ||
          p.transportState === "idle" ||
          p.transportState === "done" ||
          p.transportState === "working" ||
          p.transportState === "accepted"
      );
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

  async allocateDeveloper(
    request: DeveloperAllocationRequest,
    options?: OperationOptions
  ): Promise<OperationResult<PaneBinding>> {
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

      const loadResult = await this.#store.load(this.#config.sessionId, options);
      if (!loadResult.ok) return loadResult;
      const manifest = loadResult.value;
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
      if (existingTaskDeveloper && existingTaskDeveloper.worktreePath === request.worktreePath) {
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

      // Concurrency limit check
      const maxCapacity = this.#config.maxDeveloperCapacity ?? 2;
      if (activeDevelopers.length >= maxCapacity) {
        return conflictError(
          `Developer capacity limit reached: active developers (${activeDevelopers.length}) >= limit (${maxCapacity})`
        );
      }

      // Cleanliness check
      const inspected = await this.#worktreeInspector.inspect(request.worktreePath, options);
      if (!inspected.ok) {
        return inspected;
      }
      if (inspected.value.exists && !inspected.value.isClean) {
        return conflictError(
          `Cannot allocate developer in working tree with uncommitted changes not belonging to task: ${inspected.value.dirtyFiles.join(", ")}`
        );
      }

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
          const effectiveAgentName = request.agentName ?? (liveAgent ? releasedCandidate.agentId : this.#allocateUniqueDeveloperName(request.taskId, manifest, liveAgents));

          // If the live pane is already occupied by an agent with a different name than requested,
          // split a fresh pane in the same tab and close the old pane so the new agent does not conflict.
          if (paneInfo.agent !== null && liveAgent && liveAgent.name !== effectiveAgentName) {
            const splitOutcome = await this.#runHerdr(["pane", "split", releasedCandidate.paneId, "--direction", "right"], options);
            if (splitOutcome.exitCode === 0 && !splitOutcome.failure) {
              targetPane = parsePaneInfoResult(splitOutcome);
              oldPaneToClose = releasedCandidate.paneId;
            }
          }

          let startResult = await this.startAgentInPane(
            {
              role: "developer",
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
            const splitOutcome = await this.#runHerdr(["pane", "split", releasedCandidate.paneId, "--direction", "right"], options);
            if (splitOutcome.exitCode === 0 && !splitOutcome.failure) {
              targetPane = parsePaneInfoResult(splitOutcome);
              oldPaneToClose = releasedCandidate.paneId;
              startResult = await this.startAgentInPane(
                {
                  role: "developer",
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
            if (oldPaneToClose !== null) {
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

      const startResult = await this.startAgentInPane(
        {
          role: "developer",
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
      if (!inspected.value.isClean) {
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

export function createRolePaneManager(options: RolePaneManagerOptions): RolePaneManager {
  return new RolePaneManager(options);
}
