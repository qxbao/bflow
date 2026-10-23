import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type {
  AgentSessionLocator,
  ContractError,
  OperationOptions,
  OperationResult
} from "@bflow/contracts";
import type {
  CommandInvocation,
  CommandOutcome,
  HerdrAgentInfo,
  HerdrCommandRunner,
  HerdrForegroundProcess,
  HerdrLifecycleStatus,
  HerdrPaneInfo,
  HerdrPaneMoveResult,
  HerdrProcessInfo,
  HerdrTabCreated,
  HerdrTabInfo,
  HerdrWorkspaceCreated,
  HerdrWorkspaceInfo,
  HerdrWorkspaceWorktreeInfo,
  HerdrWorktreeCreated,
  HerdrWorktreeInfo,
  HerdrWorktreeRemoved,
  WorktreeCleanlinessResult,
  WorktreeInspector
} from "./types.js";

export class HerdrProtocolError extends Error {
  readonly kind: "malformed" | "remote";
  readonly code?: string;

  constructor(message: string, kind: "malformed" | "remote", code?: string) {
    super(message);
    this.name = "HerdrProtocolError";
    this.kind = kind;
    if (code !== undefined) {
      this.code = code;
    }
  }
}

export function validArguments(args: readonly string[]): boolean {
  return Array.isArray(args) && args.every((arg) => typeof arg === "string" && !arg.includes("\0"));
}

const MAX_SAFE_TIMEOUT_MS = 2147483647; // 2^31 - 1, Node timer limit

export function createProcessRunner(binary = "herdr"): HerdrCommandRunner {
  return {
    run(invocation: CommandInvocation): Promise<CommandOutcome> {
      const { args, cwd, env, signal, timeoutMs, maxOutputBytes = 1024 * 1024 } = invocation;
      return new Promise<CommandOutcome>((resolve) => {
        if (typeof binary !== "string" || !binary || binary.includes("\0") || !validArguments(args)) {
          resolve({
            exitCode: null,
            stdout: "",
            stderr: "",
            failure: "invalid_arguments",
            started: false,
            cause: "Invalid command binary or arguments"
          });
          return;
        }

        if (signal?.aborted) {
          resolve({
            exitCode: null,
            stdout: "",
            stderr: "",
            failure: "aborted",
            started: false,
            cause: "Operation aborted before process spawn"
          });
          return;
        }

        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
          resolve({
            exitCode: null,
            stdout: "",
            stderr: "",
            failure: "timeout",
            started: false,
            cause: "Invalid timeout specified"
          });
          return;
        }

        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(binary, [...args], {
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            ...(cwd ? { cwd } : {}),
            env: env ?? process.env
          });
        } catch (spawnError) {
          resolve({
            exitCode: null,
            stdout: "",
            stderr: "",
            failure: "spawn",
            started: false,
            cause: (spawnError as Error).message || "Process could not launch"
          });
          return;
        }

        let started = false;
        child.once("spawn", () => {
          started = true;
        });

        let stdout = "";
        let stderr = "";
        let failure: CommandOutcome["failure"];
        let cause: string | undefined;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const stop = (reason: NonNullable<CommandOutcome["failure"]>, customCause?: string) => {
          failure ??= reason;
          if (customCause !== undefined) {
            cause ??= customCause;
          }
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore kill error
          }
        };

        const onAbort = () => stop("aborted", "Command aborted by signal");
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          stop("aborted", "Command aborted by signal");
        }

        if (timeoutMs !== undefined) {
          const clamped = Math.min(timeoutMs, MAX_SAFE_TIMEOUT_MS);
          timer = setTimeout(() => stop("timeout", `Command timed out after ${clamped}ms`), clamped);
        }

        const append = (which: "stdout" | "stderr", chunk: Buffer) => {
          if (failure === "output_limit") return;
          const next = (which === "stdout" ? stdout : stderr) + chunk.toString("utf8");
          const totalBytes =
            Buffer.byteLength(next) + Buffer.byteLength(which === "stdout" ? stderr : stdout);
          if (totalBytes > maxOutputBytes) {
            stop("output_limit", `Output exceeded maximum allowed limit of ${maxOutputBytes} bytes`);
            return;
          }
          if (which === "stdout") {
            stdout = next;
          } else {
            stderr = next;
          }
        };

        child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
        child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

        child.on("error", (error: Error) => {
          failure ??= "spawn";
          cause ??= error.name === "Error" ? `Process unavailable: ${error.message}` : error.message;
        });

        child.on("close", (exitCode) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve({
            exitCode,
            stdout,
            stderr,
            started,
            ...(failure !== undefined && { failure }),
            ...(cause !== undefined && { cause })
          });
        });
      });
    }
  };
}

export function createGitWorktreeInspector(gitBinary = "git"): WorktreeInspector {
  const runner = createProcessRunner(gitBinary);

  return {
    async inspect(
      worktreePath: string,
      options?: OperationOptions
    ): Promise<OperationResult<WorktreeCleanlinessResult>> {
      if (options?.signal?.aborted) {
        return {
          ok: false,
          error: { code: "cancelled", retryable: false, message: "Worktree inspection aborted" }
        };
      }

      try {
        await stat(worktreePath);
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === "ENOENT") {
          return {
            ok: true,
            value: {
              exists: false,
              isClean: true,
              dirtyFiles: []
            }
          };
        }
        return {
          ok: false,
          error: {
            code: "validation",
            retryable: false,
            message: `Failed to stat worktree path "${worktreePath}": ${nodeErr.message}`
          }
        };
      }

      // Repository/index overrides inherited from a caller must never make a
      // different checkout look clean. Disable fsmonitor, which can also hide
      // local changes (or invoke an external command configured by a repository).
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
      const inspectGit = (args: readonly string[]) => runner.run({
        args: ["-c", "core.fsmonitor=false", "-C", worktreePath, ...args], env,
        ...(options?.signal !== undefined && { signal: options.signal }),
        timeoutMs: options?.timeoutMs ?? 5000
      });
      const indexOutcome = await inspectGit(["ls-files", "-v", "-z"]);
      if (indexOutcome.failure || indexOutcome.exitCode !== 0) {
        return { ok: false, error: mapCommandFailure(indexOutcome) ?? {
          code: "validation", retryable: false,
          message: "Cannot inspect Git index flags; refusing to declare worktree clean"
        } };
      }
      if (indexOutcome.stdout.split("\0").some(entry => /^[a-zS] /.test(entry))) {
        return { ok: false, error: {
          code: "validation", retryable: false,
          message: "Git index contains assume-unchanged or skip-worktree flags; inspect hidden edits and clear flags explicitly before allocation or release"
        } };
      }
      // Ignored files are unpreserved user data too. NUL records preserve names
      // containing newlines or whitespace; no rename records need special parsing.
      const statusOutcome = await inspectGit([
        "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all",
        "--ignored=matching", "--ignore-submodules=none"
      ]);

      if (statusOutcome.failure) {
        const mapped = mapCommandFailure(statusOutcome);
        return {
          ok: false,
          error:
            mapped ?? {
              code: "validation",
              retryable: false,
              message: `Git status command failed: ${statusOutcome.cause || statusOutcome.failure}`
            }
        };
      }

      if (statusOutcome.exitCode !== 0) {
        return {
          ok: false,
          error: {
            code: "validation",
            retryable: false,
            message: `Git status exited with code ${statusOutcome.exitCode}: ${statusOutcome.stderr || statusOutcome.stdout}`
          }
        };
      }

      const statusEntries = statusOutcome.stdout.split("\0").filter(Boolean);
      const ignoredFiles = statusEntries.filter(line => line.startsWith("!! ")).map(line => line.slice(3));
      const dirtyFiles = statusEntries.map(line => line.slice(3));
      const isClean = dirtyFiles.length === 0;

      const revParseOutcome = await inspectGit(["rev-parse", "--abbrev-ref", "HEAD"]);

      let currentBranch: string | undefined;
      if (revParseOutcome.exitCode === 0) {
        const branchTrimmed = revParseOutcome.stdout.trim();
        if (branchTrimmed.length > 0) {
          currentBranch = branchTrimmed;
        }
      }

      return {
        ok: true,
        value: {
          exists: true,
          isClean,
          dirtyFiles, ignoredFiles,
          ...(currentBranch !== undefined && { currentBranch })
        }
      };
    }
  };
}

export function mapCommandFailure(outcome: CommandOutcome): ContractError | null {
  if (outcome.failure !== undefined) {
    switch (outcome.failure) {
      case "invalid_arguments":
        return {
          code: "validation",
          retryable: false,
          message: outcome.cause ?? "Invalid command arguments"
        };
      case "aborted":
        return {
          code: "cancelled",
          retryable: false,
          message: outcome.cause ?? "Command was cancelled"
        };
      case "timeout":
        return {
          code: "timeout",
          retryable: true,
          retrySafety: outcome.started === false ? "not_started" : "observation_only",
          message: outcome.cause ?? "Command timed out"
        };
      case "output_limit":
        return {
          code: "corruption",
          retryable: false,
          message: outcome.cause ?? "Command output exceeded limit"
        };
      case "runner":
        return {
          code: "corruption",
          retryable: false,
          message: outcome.cause ?? "Command runner encountered an unexpected failure"
        };
      case "spawn":
        return {
          code: "transport_unavailable",
          retryable: true,
          message: outcome.cause ?? "Failed to spawn command process"
        };
    }
  }

  if (outcome.exitCode === 0) {
    return null;
  }

  // Parse stderr JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stderr);
  } catch {
    return {
      code: "corruption",
      retryable: false,
      message: `Command exited with status ${outcome.exitCode} and malformed stderr JSON: ${outcome.stderr || "(empty)"}`
    };
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("error" in parsed) ||
    typeof (parsed as Record<string, unknown>).error !== "object" ||
    (parsed as Record<string, unknown>).error === null
  ) {
    return {
      code: "corruption",
      retryable: false,
      message: `Command exited with status ${outcome.exitCode} and invalid error envelope: ${outcome.stderr}`
    };
  }

  const errorObj = (parsed as { error: Record<string, unknown> }).error;
  const remoteCode = typeof errorObj.code === "string" ? errorObj.code : "";
  const remoteMessage =
    typeof errorObj.message === "string" && errorObj.message.length > 0
      ? errorObj.message
      : `Herdr error: ${remoteCode || "unknown"}`;

  switch (remoteCode) {
    case "agent_blocked":
    case "agent_not_ready":
    case "workspace_group_close_required":
    case "confirmation_required":
      return {
        code: "conflict",
        retryable: true,
        message: remoteMessage
      };

    case "timeout":
      return {
        code: "timeout",
        retryable: true,
        retrySafety: "observation_only",
        message: remoteMessage
      };

    case "invalid_target":
    case "agent_not_found":
    case "pane_not_found":
    case "tab_not_found":
    case "workspace_not_found":
    case "agent_not_running":
      return {
        code: "not_found",
        retryable: false,
        message: remoteMessage
      };

    case "unsupported_version":
      return {
        code: "unsupported_version",
        retryable: false,
        supportedVersions: [22],
        receivedVersion: 0,
        message: remoteMessage
      };

    default:
      return {
        code: "transport_unavailable",
        retryable: true,
        message: remoteMessage
      };
  }
}

function record(value: unknown, context = "JSON object"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HerdrProtocolError(`Malformed Herdr ${context}`, "malformed");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HerdrProtocolError(`Missing or invalid Herdr ${field}`, "malformed");
  }
  return value;
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HerdrProtocolError(`Missing or invalid Herdr ${field}`, "malformed");
  }
  return value;
}

const VALID_LIFECYCLE_STATUSES = new Set<string>(["idle", "working", "blocked", "done", "unknown"]);

function parseLifecycleStatus(value: unknown): HerdrLifecycleStatus {
  if (typeof value !== "string" || !VALID_LIFECYCLE_STATUSES.has(value)) {
    throw new HerdrProtocolError(`Unsupported Herdr agent status: ${String(value)}`, "malformed");
  }
  return value as HerdrLifecycleStatus;
}

function parseSessionLocator(raw: unknown, paneAgent?: string | null): AgentSessionLocator | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = record(raw, "agent_session");
  const kind = string(s.kind, "agent_session.kind");
  if (kind !== "id" && kind !== "path" && kind !== "opaque") {
    throw new HerdrProtocolError("Invalid Herdr session kind", "malformed");
  }
  if (s.agent !== undefined && s.agent !== null && typeof paneAgent === "string" && s.agent !== paneAgent) {
    throw new HerdrProtocolError("Herdr session agent does not match the pane agent", "malformed");
  }
  return {
    source: string(s.source, "agent_session.source"),
    kind,
    value: string(s.value, "agent_session.value")
  };
}

export function parseHerdrResponse(outcome: CommandOutcome): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(outcome.exitCode === 0 ? outcome.stdout : outcome.stderr);
  } catch {
    throw new HerdrProtocolError("Herdr returned malformed JSON", "malformed");
  }
  const envelope = record(value, "envelope");
  if (outcome.exitCode !== 0) {
    const error = record(envelope.error, "error envelope");
    throw new HerdrProtocolError(
      string(error.message, "error.message"),
      "remote",
      string(error.code, "error.code")
    );
  }
  return record(envelope.result, "result envelope");
}

export function parseOkResponse(outcome: CommandOutcome): void {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "ok") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected ok, got ${String(result.type)}`,
      "malformed"
    );
  }
}

export function parseWorkspaceInfo(raw: unknown): HerdrWorkspaceInfo {
  const info = record(raw, "workspace");
  const workspaceId = string(info.workspace_id ?? info.workspaceId, "workspace_id");
  const label = string(info.label, "label");
  const activeTabId = string(info.active_tab_id ?? info.activeTabId, "active_tab_id");
  const focused = Boolean(info.focused);
  const paneCount = number(info.pane_count ?? info.paneCount ?? 0, "pane_count");
  const tabCount = number(info.tab_count ?? info.tabCount ?? 0, "tab_count");
  const agentStatus = parseLifecycleStatus(info.agent_status ?? info.agentStatus ?? "unknown");

  let worktree: HerdrWorkspaceWorktreeInfo | undefined;
  const wtRaw = info.worktree;
  if (wtRaw !== undefined && wtRaw !== null) {
    const wt = record(wtRaw, "workspace.worktree");
    worktree = {
      repoKey: string(wt.repo_key ?? wt.repoKey, "repo_key"),
      repoName: string(wt.repo_name ?? wt.repoName, "repo_name"),
      repoRoot: string(wt.repo_root ?? wt.repoRoot, "repo_root"),
      checkoutPath: string(wt.checkout_path ?? wt.checkoutPath, "checkout_path"),
      isLinkedWorktree: Boolean(wt.is_linked_worktree ?? wt.isLinkedWorktree)
    };
  }

  return {
    workspaceId,
    label,
    activeTabId,
    focused,
    paneCount,
    tabCount,
    agentStatus,
    ...(worktree !== undefined && { worktree })
  };
}

export function parseTabInfo(raw: unknown): HerdrTabInfo {
  const info = record(raw, "tab");
  const tabId = string(info.tab_id ?? info.tabId, "tab_id");
  const workspaceId = string(info.workspace_id ?? info.workspaceId, "workspace_id");
  const label = string(info.label, "label");
  const focused = Boolean(info.focused);
  const paneCount = number(info.pane_count ?? info.paneCount ?? 0, "pane_count");
  const agentStatus = parseLifecycleStatus(info.agent_status ?? info.agentStatus ?? "unknown");

  return {
    tabId,
    workspaceId,
    label,
    focused,
    paneCount,
    agentStatus
  };
}

export function parsePaneInfo(raw: unknown): HerdrPaneInfo {
  const info = record(raw, "pane");
  const paneId = string(info.pane_id ?? info.paneId, "pane_id");
  const terminalId = string(info.terminal_id ?? info.terminalId, "terminal_id");
  const workspaceId = string(info.workspace_id ?? info.workspaceId, "workspace_id");
  const tabId = string(info.tab_id ?? info.tabId, "tab_id");
  const focused = Boolean(info.focused);
  const agent = info.agent === null || info.agent === undefined ? null : string(info.agent, "agent");
  const agentStatus = parseLifecycleStatus(info.agent_status ?? info.agentStatus ?? "unknown");
  const revision = number(info.revision, "revision");
  if (!Number.isInteger(revision) || revision < 0) {
    throw new HerdrProtocolError("Invalid Herdr revision", "malformed");
  }

  const label = info.label !== undefined && info.label !== null ? String(info.label) : info.label;
  const cwd = info.cwd !== undefined && info.cwd !== null ? String(info.cwd) : info.cwd;
  const foregroundCwd =
    info.foreground_cwd !== undefined && info.foreground_cwd !== null
      ? String(info.foreground_cwd)
      : info.foregroundCwd !== undefined && info.foregroundCwd !== null
        ? String(info.foregroundCwd)
        : undefined;

  const session = parseSessionLocator(info.agent_session ?? info.session, agent);

  return {
    paneId,
    terminalId,
    workspaceId,
    tabId,
    focused,
    agent,
    agentStatus,
    revision,
    ...(label !== undefined && { label }),
    ...(cwd !== undefined && { cwd }),
    ...(foregroundCwd !== undefined && { foregroundCwd }),
    ...(session !== undefined && { session })
  };
}

export function parseAgentInfo(raw: unknown): HerdrAgentInfo {
  const info = record(raw, "agent");
  const paneId = string(info.pane_id ?? info.paneId, "pane_id");
  const terminalId = string(info.terminal_id ?? info.terminalId, "terminal_id");
  const workspaceId = string(info.workspace_id ?? info.workspaceId, "workspace_id");
  const tabId = string(info.tab_id ?? info.tabId, "tab_id");
  const focused = Boolean(info.focused);
  const agent = info.agent === null || info.agent === undefined ? null : string(info.agent, "agent");
  const name = info.name === null || info.name === undefined ? null : string(info.name, "name");
  const agentStatus = parseLifecycleStatus(info.agent_status ?? info.agentStatus ?? "unknown");
  const revision = number(info.revision, "revision");
  if (!Number.isInteger(revision) || revision < 0) {
    throw new HerdrProtocolError("Invalid Herdr revision", "malformed");
  }

  const seq = info.state_change_seq ?? info.stateChangeSequence;
  if (seq !== undefined && seq !== null && (!Number.isInteger(seq) || (seq as number) < 0)) {
    throw new HerdrProtocolError("Invalid Herdr state sequence", "malformed");
  }

  const interactiveReady = info.interactive_ready ?? info.interactiveReady;
  const launchPending = info.launch_pending ?? info.launchPending;
  const cwd = info.cwd !== undefined && info.cwd !== null ? String(info.cwd) : info.cwd;
  const foregroundCwd =
    info.foreground_cwd !== undefined && info.foreground_cwd !== null
      ? String(info.foreground_cwd)
      : info.foregroundCwd !== undefined && info.foregroundCwd !== null
        ? String(info.foregroundCwd)
        : undefined;

  const session = parseSessionLocator(info.agent_session ?? info.session, agent);

  return {
    paneId,
    terminalId,
    workspaceId,
    tabId,
    focused,
    agent,
    name,
    agentStatus,
    revision,
    ...(seq !== undefined && seq !== null && { stateChangeSequence: seq as number }),
    ...(interactiveReady !== undefined && { interactiveReady: Boolean(interactiveReady) }),
    ...(launchPending !== undefined && { launchPending: Boolean(launchPending) }),
    ...(cwd !== undefined && { cwd }),
    ...(foregroundCwd !== undefined && { foregroundCwd }),
    ...(session !== undefined && { session })
  };
}

export function parseWorktreeInfo(raw: unknown): HerdrWorktreeInfo {
  const info = record(raw, "worktree");
  const path = string(info.path, "path");
  const label = string(info.label ?? info.path, "label");
  const branch = info.branch === null || info.branch === undefined ? null : string(info.branch, "branch");
  const isLinkedWorktree = Boolean(info.is_linked_worktree ?? info.isLinkedWorktree);
  const isDetached = Boolean(info.is_detached ?? info.isDetached);
  const isBare = Boolean(info.is_bare ?? info.isBare);
  const isPrunable = Boolean(info.is_prunable ?? info.isPrunable);
  const openWorkspaceId =
    info.open_workspace_id === null || info.open_workspace_id === undefined
      ? info.openWorkspaceId === null || info.openWorkspaceId === undefined
        ? null
        : String(info.openWorkspaceId)
      : String(info.open_workspace_id);

  return {
    path,
    label,
    branch,
    isLinkedWorktree,
    isDetached,
    isBare,
    isPrunable,
    openWorkspaceId
  };
}

export function parseWorkspaceListResult(outcome: CommandOutcome): readonly HerdrWorkspaceInfo[] {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "workspace_list") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected workspace_list, got ${String(result.type)}`,
      "malformed"
    );
  }
  const rawWorkspaces = result.workspaces;
  if (!Array.isArray(rawWorkspaces)) {
    throw new HerdrProtocolError("Missing or invalid workspaces array in workspace_list", "malformed");
  }
  return rawWorkspaces.map(parseWorkspaceInfo);
}

export function parseWorkspaceInfoResult(outcome: CommandOutcome): HerdrWorkspaceInfo {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "workspace_info") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected workspace_info, got ${String(result.type)}`,
      "malformed"
    );
  }
  return parseWorkspaceInfo(result.workspace);
}

export function parseWorkspaceCreatedResult(outcome: CommandOutcome): HerdrWorkspaceCreated {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "workspace_created") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected workspace_created, got ${String(result.type)}`,
      "malformed"
    );
  }
  return {
    workspace: parseWorkspaceInfo(result.workspace),
    tab: parseTabInfo(result.tab),
    rootPane: parsePaneInfo(result.root_pane ?? result.rootPane)
  };
}

export function parseTabListResult(outcome: CommandOutcome): readonly HerdrTabInfo[] {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "tab_list") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected tab_list, got ${String(result.type)}`,
      "malformed"
    );
  }
  const rawTabs = result.tabs;
  if (!Array.isArray(rawTabs)) {
    throw new HerdrProtocolError("Missing or invalid tabs array in tab_list", "malformed");
  }
  return rawTabs.map(parseTabInfo);
}

export function parseTabInfoResult(outcome: CommandOutcome): HerdrTabInfo {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "tab_info") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected tab_info, got ${String(result.type)}`,
      "malformed"
    );
  }
  return parseTabInfo(result.tab);
}

export function parseTabCreatedResult(outcome: CommandOutcome): HerdrTabCreated {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "tab_created") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected tab_created, got ${String(result.type)}`,
      "malformed"
    );
  }
  return {
    tab: parseTabInfo(result.tab),
    rootPane: parsePaneInfo(result.root_pane ?? result.rootPane)
  };
}

export function parsePaneListResult(outcome: CommandOutcome): readonly HerdrPaneInfo[] {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "pane_list") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected pane_list, got ${String(result.type)}`,
      "malformed"
    );
  }
  const rawPanes = result.panes;
  if (!Array.isArray(rawPanes)) {
    throw new HerdrProtocolError("Missing or invalid panes array in pane_list", "malformed");
  }
  return rawPanes.map(parsePaneInfo);
}

export function parsePaneInfoResult(outcome: CommandOutcome): HerdrPaneInfo {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "pane_info") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected pane_info, got ${String(result.type)}`,
      "malformed"
    );
  }
  return parsePaneInfo(result.pane);
}

export function parsePaneMoveResult(outcome: CommandOutcome): HerdrPaneMoveResult {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "pane_move") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected pane_move, got ${String(result.type)}`,
      "malformed"
    );
  }
  const raw = record(result.move_result ?? result.moveResult, "move_result");
  return {
    changed: Boolean(raw.changed),
    previousPaneId: string(raw.previous_pane_id ?? raw.previousPaneId, "previous_pane_id"),
    previousWorkspaceId: string(raw.previous_workspace_id ?? raw.previousWorkspaceId, "previous_workspace_id"),
    previousTabId: string(raw.previous_tab_id ?? raw.previousTabId, "previous_tab_id"),
    pane: parsePaneInfo(raw.pane),
    focusedPaneId: string(raw.focused_pane_id ?? raw.focusedPaneId, "focused_pane_id")
  };
}

export function parsePaneProcessInfoResult(outcome: CommandOutcome): HerdrProcessInfo {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "pane_process_info") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected pane_process_info, got ${String(result.type)}`,
      "malformed"
    );
  }
  const raw = record(result.process_info ?? result.processInfo, "process_info");
  const paneId = string(raw.pane_id ?? raw.paneId, "pane_id");
  const shellPid =
    raw.shell_pid !== undefined && raw.shell_pid !== null
      ? number(raw.shell_pid, "shell_pid")
      : raw.shellPid !== undefined && raw.shellPid !== null
        ? number(raw.shellPid, "shellPid")
        : null;
  const fgPgid =
    raw.foreground_process_group_id !== undefined && raw.foreground_process_group_id !== null
      ? number(raw.foreground_process_group_id, "foreground_process_group_id")
      : raw.foregroundProcessGroupId !== undefined && raw.foregroundProcessGroupId !== null
        ? number(raw.foregroundProcessGroupId, "foregroundProcessGroupId")
        : null;

  const fgProcsRaw = raw.foreground_processes !== undefined ? raw.foreground_processes : raw.foregroundProcesses;
  // Protocol 22 requires only pane_id here. Omitted process data is a pending
  // observation, never evidence that the foreground is empty or shell-ready.
  if (fgProcsRaw !== undefined && !Array.isArray(fgProcsRaw)) {
    throw new HerdrProtocolError("Invalid foreground_processes array in process_info", "malformed");
  }
  const foregroundProcesses: readonly HerdrForegroundProcess[] = (fgProcsRaw ?? []).map((pRaw: unknown) => {
    const p = record(pRaw, "foreground_process");
    const pid = number(p.pid, "foreground_process.pid");
    const command = typeof p.command === "string" ? p.command : undefined;
    const argv = Array.isArray(p.argv) ? p.argv.map(String) : undefined;
    return {
      pid,
      ...(command !== undefined && { command }),
      ...(argv !== undefined && { argv })
    };
  });
  const tty = raw.tty !== undefined && raw.tty !== null ? String(raw.tty) : raw.tty;

  return {
    paneId,
    shellPid,
    foregroundProcessGroupId: fgPgid,
    foregroundProcesses,
    ...(fgProcsRaw === undefined ? { foregroundSnapshotPending: true } : {}),
    ...(tty !== undefined && { tty })
  };
}

export function parseAgentListResult(outcome: CommandOutcome): readonly HerdrAgentInfo[] {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "agent_list") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected agent_list, got ${String(result.type)}`,
      "malformed"
    );
  }
  const rawAgents = result.agents;
  if (!Array.isArray(rawAgents)) {
    throw new HerdrProtocolError("Missing or invalid agents array in agent_list", "malformed");
  }
  return rawAgents.map(parseAgentInfo);
}

export function parseAgentInfoResult(
  outcome: CommandOutcome,
  expectedType?: "agent_info" | "agent_started" | "agent_prompted"
): HerdrAgentInfo {
  const result = parseHerdrResponse(outcome);
  if (expectedType !== undefined && result.type !== expectedType) {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected ${expectedType}, got ${String(result.type)}`,
      "malformed"
    );
  }
  return parseAgentInfo(result.agent);
}

export function parseWorktreeListResult(outcome: CommandOutcome): readonly HerdrWorktreeInfo[] {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "worktree_list") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected worktree_list, got ${String(result.type)}`,
      "malformed"
    );
  }
  const rawWorktrees = result.worktrees;
  if (!Array.isArray(rawWorktrees)) {
    throw new HerdrProtocolError("Missing or invalid worktrees array in worktree_list", "malformed");
  }
  return rawWorktrees.map(parseWorktreeInfo);
}

export function parseWorktreeCreatedResult(outcome: CommandOutcome): HerdrWorktreeCreated {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "worktree_created" && result.type !== "worktree_opened") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected worktree_created or worktree_opened, got ${String(result.type)}`,
      "malformed"
    );
  }
  const alreadyOpen =
    result.already_open !== undefined
      ? Boolean(result.already_open)
      : result.alreadyOpen !== undefined
        ? Boolean(result.alreadyOpen)
        : undefined;

  return {
    workspace: parseWorkspaceInfo(result.workspace),
    tab: parseTabInfo(result.tab),
    rootPane: parsePaneInfo(result.root_pane ?? result.rootPane),
    worktree: parseWorktreeInfo(result.worktree),
    ...(alreadyOpen !== undefined && { alreadyOpen })
  };
}

export function parseWorktreeRemovedResult(outcome: CommandOutcome): HerdrWorktreeRemoved {
  const result = parseHerdrResponse(outcome);
  if (result.type !== "worktree_removed") {
    throw new HerdrProtocolError(
      `Unexpected Herdr response type: expected worktree_removed, got ${String(result.type)}`,
      "malformed"
    );
  }
  return {
    workspaceId: string(result.workspace_id ?? result.workspaceId, "workspace_id"),
    path: string(result.path, "path"),
    forced: Boolean(result.forced)
  };
}

export function isShellReadyForAgent(
  pane: HerdrPaneInfo,
  processInfo?: HerdrProcessInfo
): { readonly ready: boolean; readonly reason?: string } {
  if (pane.agent !== null) {
    return {
      ready: false,
      reason: `Pane ${pane.paneId} is already occupied by agent ${pane.agent}`
    };
  }

  if (processInfo !== undefined) {
    if (processInfo.paneId !== pane.paneId) return { ready: false, reason: "Process observation belongs to a different pane" };
    if (processInfo.foregroundSnapshotPending || processInfo.foregroundProcessGroupId === null) return { ready: false,
      reason: `Pane ${pane.paneId} shell process metadata is still initializing; retry bflow up. No agent was started.` };
    if (processInfo.shellPid === null || processInfo.shellPid <= 0) {
      return {
        ready: false,
        reason: `Pane ${pane.paneId} has no active interactive shell process`
      };
    }

    if (
      processInfo.foregroundProcessGroupId !== null &&
      processInfo.foregroundProcessGroupId !== processInfo.shellPid
    ) {
      return {
        ready: false,
        reason: `Pane ${pane.paneId} foreground is busy (pgid ${processInfo.foregroundProcessGroupId} !== shell ${processInfo.shellPid})`
      };
    }

    if (processInfo.foregroundProcesses.some((p) => p.pid !== processInfo.shellPid)) {
      return {
        ready: false,
        reason: `Pane ${pane.paneId} has a non-shell foreground process running`
      };
    }
  }

  return { ready: true };
}
