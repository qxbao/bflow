import { isAbsolute, resolve } from "node:path";
import { ProgressPaneSchema, type ProgressPane } from "@bflow/contracts";
import type { CommandOutcome, HerdrPaneInfo, HerdrProcessInfo } from "./types.js";
import {
  isShellReadyForAgent,
  parsePaneInfoResult,
  parsePaneProcessInfoResult,
  parseTabCreatedResult
} from "./runner.js";

/**
 * Director-mode progress pane: a non-LLM tab running `bflow progress --follow`. Follows the receipt discipline of the
 * Runtime task-log pane: the launch intent is durable before `pane run`, an unacknowledged or unconfirmed launch is
 * never replayed, and a pane whose identity changed is never touched.
 */
export interface ProgressPaneDeps {
  /** Runs one Herdr CLI command; resolves to stdout, rejects with an error carrying `code` ("not_found" for a missing target). */
  herdr(args: string[]): Promise<string>;
  clock(): Date;
  workspaceRoot: string;
  /** Workspace that owns the progress tab; a missing/replaced pane is recreated here. */
  workspaceId: string;
  /** Durably records the progress pane. Called before every `pane run` (launch intent) and after each phase change. */
  persist(pane: ProgressPane): Promise<void>;
}

export const PROGRESS_TAB_LABEL = "progress";
export const PROGRESS_PANE_LABEL = "progress";
export const PROGRESS_RESTART_LIMIT = 5;
export const PROGRESS_RESTART_WINDOW_MS = 10 * 60 * 1000;

type Observation = "missing" | "replaced" | "foreign" | "viewer" | "shell" | "occupied" | "starting";

const PROCESS_POLL_MS = 100;
const PROCESS_MAX_POLLS = 25;
const PROCESS_DEADLINE_MS = 3_000;
const delay = (milliseconds: number) => new Promise<void>(resolveDelay => setTimeout(resolveDelay, milliseconds));
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const outcomeOf = (stdout: string): CommandOutcome => ({ exitCode: 0, stdout, stderr: "" });

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "not_found" || error.code === "pane_not_found";
}

/** True while fewer than five restarts happened within the last ten minutes. */
export function progressRestartAllowed(restarts: readonly string[], now: Date): boolean {
  return recentRestarts(restarts, now).length < PROGRESS_RESTART_LIMIT;
}

function recentRestarts(restarts: readonly string[], now: Date): string[] {
  return restarts.filter(at => {
    const age = now.getTime() - Date.parse(at);
    return Number.isFinite(age) && age < PROGRESS_RESTART_WINDOW_MS;
  });
}

/** The shell command line typed into the pane: each argument single-quoted, joined by spaces. */
export function progressShellCommand(command: readonly string[]): string {
  return command.map(quote).join(" ");
}

function matchesCommand(argv: readonly string[] | undefined, command: readonly string[]): boolean {
  if (!argv || argv.length !== command.length) return false;
  return command.every((part, index) => {
    const observed = argv[index]!;
    return index === 0 && isAbsolute(part) ? resolve(observed) === resolve(part) : observed === part;
  });
}

async function persist(deps: ProgressPaneDeps, pane: ProgressPane): Promise<ProgressPane> {
  const parsed = ProgressPaneSchema.parse(pane);
  await deps.persist(parsed);
  return parsed;
}

type ObserveDeps = Pick<ProgressPaneDeps, "herdr" | "workspaceId">;

async function observe(deps: ObserveDeps, current: ProgressPane): Promise<Observation> {
  let pane: HerdrPaneInfo;
  try { pane = parsePaneInfoResult(outcomeOf(await deps.herdr(["pane", "get", current.paneId]))); }
  catch (error) { if (isMissing(error)) return "missing"; throw error; }
  if (pane.paneId !== current.paneId) throw new Error("Herdr pane get returned a different pane identity");
  // Public pane IDs can be reused by a restarted server. The old terminal is gone; never touch its replacement.
  if (current.terminalId !== undefined && pane.terminalId !== current.terminalId) return "replaced";
  if (pane.workspaceId !== deps.workspaceId || pane.tabId !== current.tabId) return "foreign";
  let info: HerdrProcessInfo;
  try { info = parsePaneProcessInfoResult(outcomeOf(await deps.herdr(["pane", "process-info", "--pane", current.paneId]))); }
  catch (error) { if (isMissing(error)) return "missing"; throw error; }
  if (info.paneId !== current.paneId) throw new Error("Herdr process-info returned a different pane identity");
  if (info.foregroundSnapshotPending || info.foregroundProcessGroupId === null) return "starting";
  // The process group leader is the launched command; its children share the group.
  const leader = info.foregroundProcesses.find(proc => proc.pid === info.foregroundProcessGroupId);
  if (leader && matchesCommand(leader.argv, current.command)) return "viewer";
  if (pane.agent !== null) return "occupied";
  return isShellReadyForAgent(pane, info).ready ? "shell" : "occupied";
}

async function waitFor(deps: ObserveDeps, current: ProgressPane, target: "shell" | "viewer"): Promise<Observation> {
  let latest: Observation = "starting";
  const deadline = Date.now() + PROCESS_DEADLINE_MS;
  for (let attempt = 0; attempt < PROCESS_MAX_POLLS && Date.now() < deadline; attempt++) {
    latest = await observe(deps, current);
    if (latest === "missing" || latest === "replaced" || latest === "foreign" || latest === "viewer") return latest;
    if (target === "shell" && latest === "shell") return latest;
    if (attempt + 1 < PROCESS_MAX_POLLS) await delay(Math.max(0, Math.min(PROCESS_POLL_MS, deadline - Date.now())));
  }
  return latest;
}

/**
 * Launches the progress command in an owned shell pane. The launch intent is persisted before `pane run`; an error,
 * a non-empty acknowledgement or an unconfirmed process yields `launch_unknown`, which is never replayed.
 */
export async function launchProgressPane(
  deps: ProgressPaneDeps,
  input: { workspaceId: string; tabId: string; paneId: string; terminalId: string; command: readonly string[]; restarts?: readonly string[] }
): Promise<ProgressPane> {
  const base: ProgressPane = {
    tabId: input.tabId, paneId: input.paneId, ...(input.terminalId ? { terminalId: input.terminalId } : {}), command: [...input.command],
    phase: "created", restarts: [...input.restarts ?? []]
  };
  const scoped: ObserveDeps = { herdr: deps.herdr, workspaceId: input.workspaceId };
  const ready = await waitFor(scoped, base, "shell");
  if (ready === "viewer") return persist(deps, { ...base, phase: "running", launchedAt: deps.clock().toISOString() });
  if (ready === "foreign" || ready === "occupied") return persist(deps, { ...base, phase: "failed" });
  // Nothing was run: a later ensure launches once the shell is observed ready.
  if (ready !== "shell") return persist(deps, base);
  const intent = await persist(deps, { ...base, phase: "launch_intent" });
  try {
    const response = await deps.herdr(["pane", "run", intent.paneId, progressShellCommand(intent.command)]);
    if (response !== "") return persist(deps, { ...intent, phase: "launch_unknown" });
  } catch {
    return persist(deps, { ...intent, phase: "launch_unknown" });
  }
  const launched = await waitFor(scoped, intent, "viewer");
  return launched === "viewer"
    ? persist(deps, { ...intent, phase: "running", launchedAt: deps.clock().toISOString() })
    : persist(deps, { ...intent, phase: "launch_unknown" });
}

async function recreate(deps: ProgressPaneDeps, current: ProgressPane, now: Date): Promise<ProgressPane> {
  if (!progressRestartAllowed(current.restarts, now)) return persist(deps, { ...current, phase: "failed" });
  const created = parseTabCreatedResult(outcomeOf(await deps.herdr(["tab", "create", "--workspace", deps.workspaceId, "--cwd",
    deps.workspaceRoot, "--label", PROGRESS_TAB_LABEL, "--no-focus"])));
  const root = created.rootPane;
  if (created.tab.workspaceId !== deps.workspaceId || root.tabId !== created.tab.tabId || root.workspaceId !== deps.workspaceId)
    throw new Error("Herdr created a progress tab with mismatched identity");
  // The new pane is owned before it is renamed or launched, so a lost acknowledgement never orphans an unknown pane.
  const fresh = await persist(deps, { tabId: created.tab.tabId, paneId: root.paneId, terminalId: root.terminalId,
    command: current.command, phase: "created", restarts: [...recentRestarts(current.restarts, now), now.toISOString()] });
  parsePaneInfoResult(outcomeOf(await deps.herdr(["pane", "rename", root.paneId, PROGRESS_PANE_LABEL])));
  return launchProgressPane(deps, { workspaceId: deps.workspaceId, tabId: fresh.tabId, paneId: fresh.paneId,
    terminalId: root.terminalId, command: fresh.command, restarts: fresh.restarts });
}

/**
 * Reconciles the progress pane with its observed state. Never replays an uncertain `pane run`: `launch_intent` and
 * `launch_unknown` become `running` only when the exact command is observed, and `failed` when the shell is idle.
 */
export async function ensureProgressPane(deps: ProgressPaneDeps, current: ProgressPane): Promise<ProgressPane> {
  const now = deps.clock();
  const observed = await observe(deps, current);
  if (observed === "missing" || observed === "replaced") return recreate(deps, current, now);
  if (observed === "viewer") {
    return current.phase === "running" ? current
      : persist(deps, { ...current, phase: "running", launchedAt: current.launchedAt ?? now.toISOString() });
  }
  if (observed === "foreign" || observed === "occupied") {
    return current.phase === "failed" ? current : persist(deps, { ...current, phase: "failed" });
  }
  if (observed === "starting") {
    // An interrupted launch intent cannot be confirmed; it is uncertain, never replayed.
    return current.phase === "launch_intent" ? persist(deps, { ...current, phase: "launch_unknown" }) : current;
  }
  // The pane is an idle owned shell.
  if (current.phase === "created") {
    return launchProgressPane(deps, { workspaceId: deps.workspaceId, tabId: current.tabId, paneId: current.paneId,
      terminalId: current.terminalId ?? "", command: current.command, restarts: current.restarts });
  }
  if (current.phase === "running") {
    if (!progressRestartAllowed(current.restarts, now)) return persist(deps, { ...current, phase: "failed" });
    return launchProgressPane(deps, { workspaceId: deps.workspaceId, tabId: current.tabId, paneId: current.paneId,
      terminalId: current.terminalId ?? "", command: current.command,
      restarts: [...recentRestarts(current.restarts, now), now.toISOString()] });
  }
  return current.phase === "failed" ? current : persist(deps, { ...current, phase: "failed" });
}

/**
 * Closes the progress pane when its ownership is proven (same terminal, workspace and tab, running the command or an
 * idle shell). A missing/replaced pane is already gone; a foreign or occupied pane is preserved.
 */
export async function closeProgressPane(deps: ObserveDeps, current: ProgressPane): Promise<"closed" | "absent" | "preserved"> {
  const observed = await observe(deps, current);
  if (observed === "missing" || observed === "replaced") return "absent";
  if (observed !== "viewer" && observed !== "shell") return "preserved";
  try {
    await deps.herdr(["pane", "close", current.paneId]);
  } catch (error) {
    if (isMissing(error)) return "absent";
    throw error;
  }
  return "closed";
}
