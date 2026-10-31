import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StoredRunSchema,
  type RunStatus,
  type RuntimeService,
  type SessionManifest
} from "@bflow/contracts";
import { findPrivateRuntimeStateDirectory } from "@bflow/runtime";

// Vite 5's built-in list predates node:sqlite; load Node's native module directly.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "cancelling"
];

export interface AuthoritativeActiveRun {
  readonly runId: string;
  readonly status: RunStatus;
}

export interface RuntimeObservationCheck {
  readonly status: "pass" | "warning" | "fail";
  readonly reason: string;
  readonly remediation: string;
}

export interface AuthoritativeRuntimeObservation {
  readonly activeRuns: readonly AuthoritativeActiveRun[];
  readonly issues: readonly string[];
  readonly activeRunsCheck: RuntimeObservationCheck;
  readonly hostBuildCheck: {
    readonly status: "pass" | "warning";
    readonly reason: string;
    readonly remediation: string;
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

function readActiveRunsFromSqlite(dbPath: string): {
  readonly runs: readonly AuthoritativeActiveRun[];
  readonly corruptError?: string;
} {
  try {
    if (!existsSync(dbPath)) return { runs: [] };
    const info = lstatSync(dbPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      return {
        runs: [],
        corruptError: `Authoritative RunStore '${dbPath}' is not a regular file.`
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [] };
    return {
      runs: [],
      corruptError: `Cannot inspect RunStore '${dbPath}': ${error instanceof Error ? error.message : String(error)}`
    };
  }

  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const hasRunsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
      .get();
    if (!hasRunsTable) return { runs: [] };
    const rows = db
      .prepare(
        "SELECT run_id, status, payload, digest FROM runs WHERE status IN ('queued', 'running', 'waiting', 'blocked', 'cancelling') ORDER BY created_at ASC, run_id ASC LIMIT 500"
      )
      .all() as Array<{ run_id: string; status: string; payload: string; digest: string }>;
    const runs: AuthoritativeActiveRun[] = [];
    for (const row of rows) {
      const actualDigest = createHash("sha256").update(row.payload).digest("hex");
      if (actualDigest !== row.digest) {
        return {
          runs: [],
          corruptError: `Authoritative RunStore '${dbPath}' failed checksum verification for run '${row.run_id}'.`
        };
      }
      const parsed = StoredRunSchema.parse(JSON.parse(row.payload));
      if (parsed.snapshot.runId !== row.run_id || parsed.snapshot.status !== row.status) {
        return {
          runs: [],
          corruptError: `Authoritative RunStore '${dbPath}' has inconsistent projection metadata for run '${row.run_id}'.`
        };
      }
      runs.push({ runId: parsed.snapshot.runId, status: parsed.snapshot.status });
    }
    return { runs };
  } catch (error) {
    return {
      runs: [],
      corruptError: `Authoritative RunStore '${dbPath}' could not be verified: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    try {
      db?.close();
    } catch {
      // read-only handle cleanup
    }
  }
}

async function probeUnixSocketReachable(socketPath: string, timeoutMs = 400): Promise<boolean> {
  try {
    if (!existsSync(socketPath)) return false;
    const info = lstatSync(socketPath);
    if (!info.isSocket()) return false;
  } catch {
    return false;
  }
  return new Promise<boolean>((resolveProbe) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(ok);
    };
    const socket = createConnection(socketPath);
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function newestLocalBuildMtimeMs(): number {
  const candidates: string[] = [];
  try {
    candidates.push(fileURLToPath(import.meta.url));
  } catch { /* ignore */ }
  try {
    candidates.push(fileURLToPath(new URL("./environment.js", import.meta.url)));
  } catch { /* ignore */ }
  try {
    candidates.push(createRequire(import.meta.url).resolve("@bflow/runtime"));
  } catch { /* ignore */ }

  let newest = 0;
  for (const candidate of candidates) {
    try {
      const mtimeMs = statSync(candidate).mtimeMs;
      if (Number.isFinite(mtimeMs) && mtimeMs > newest) newest = mtimeMs;
    } catch {
      // ignore unavailable candidate
    }
  }
  return newest;
}

async function observeHostBuildSkew(
  privateState: string | undefined,
  repositoryRoot: string,
  sessionName: string
): Promise<{
  readonly status: "pass" | "warning";
  readonly reason: string;
  readonly remediation: string;
  readonly issue?: string;
}> {
  if (!privateState) {
    return {
      status: "pass",
      reason: "No persisted Runtime host authority present.",
      remediation: ""
    };
  }
  const hostDir = join(privateState, "host", sessionName);
  const hostJsonPath = join(hostDir, "host.json");
  const ownerJsonPath = join(hostDir, "owner.json");
  if (!existsSync(hostJsonPath) || !existsSync(ownerJsonPath)) {
    return {
      status: "pass",
      reason: "No active Runtime host daemon receipt present.",
      remediation: ""
    };
  }
  try {
    const hostInfo = lstatSync(hostJsonPath);
    const ownerInfo = lstatSync(ownerJsonPath);
    if (
      !hostInfo.isFile() ||
      hostInfo.isSymbolicLink() ||
      hostInfo.size > 1_000_000 ||
      !ownerInfo.isFile() ||
      ownerInfo.isSymbolicLink() ||
      ownerInfo.size > 1_000_000
    ) {
      return {
        status: "pass",
        reason: "Runtime host receipt is absent or non-regular.",
        remediation: ""
      };
    }
    const hostRaw = JSON.parse(readFileSync(hostJsonPath, "utf8")) as {
      repositoryPath?: unknown;
      sessionId?: unknown;
      socketPath?: unknown;
    };
    const ownerRaw = JSON.parse(readFileSync(ownerJsonPath, "utf8")) as {
      pid?: unknown;
      startedAt?: unknown;
    };
    if (
      typeof hostRaw.socketPath !== "string" ||
      hostRaw.sessionId !== sessionName ||
      (typeof hostRaw.repositoryPath === "string" && resolve(hostRaw.repositoryPath) !== resolve(repositoryRoot)) ||
      typeof ownerRaw.pid !== "number" ||
      !Number.isSafeInteger(ownerRaw.pid) ||
      ownerRaw.pid <= 1 ||
      typeof ownerRaw.startedAt !== "string"
    ) {
      return {
        status: "pass",
        reason: "Runtime host receipt does not reference a live session host.",
        remediation: ""
      };
    }
    if (!processAlive(ownerRaw.pid) || !(await probeUnixSocketReachable(hostRaw.socketPath))) {
      return {
        status: "pass",
        reason: "Runtime host daemon is not currently active.",
        remediation: ""
      };
    }
    const startedAtMs = Date.parse(ownerRaw.startedAt);
    const newestBuildMs = newestLocalBuildMtimeMs();
    if (Number.isFinite(startedAtMs) && newestBuildMs > startedAtMs + 1_000) {
      const remediation =
        "Run 'bflow down --yes && bflow up' after active runs settle to reload the Runtime host.";
      const reason = `Loaded Runtime host (pid ${ownerRaw.pid}, started ${ownerRaw.startedAt}) predates newer local CLI/Runtime build artifacts.`;
      return {
        status: "warning",
        reason,
        remediation,
        issue: `${reason} ${remediation}`
      };
    }
    return {
      status: "pass",
      reason: `Loaded Runtime host (pid ${ownerRaw.pid}, started ${ownerRaw.startedAt}) matches current local build.`,
      remediation: ""
    };
  } catch {
    return {
      status: "pass",
      reason: "Runtime host build metadata could not be read; host may be restarting.",
      remediation: ""
    };
  }
}

/**
 * Read-only inspection of authoritative SQLite RunStore active runs, session.json projection drift,
 * and Gate B loaded-host build skew. Never creates directories or spawns a background host daemon.
 */
export async function observeAuthoritativeRuntime(input: {
  readonly repositoryRoot: string;
  readonly sessionName: string;
  readonly server: "running" | "stopped" | "unknown";
  readonly manifest: SessionManifest | null;
  readonly injectedRuntime?: Pick<RuntimeService, "findRuns"> | undefined;
}): Promise<AuthoritativeRuntimeObservation> {
  let privateState: string | undefined;
  try {
    privateState = findPrivateRuntimeStateDirectory(input.repositoryRoot);
  } catch {
    privateState = undefined;
  }

  const candidateDbs = new Set<string>();
  if (privateState) {
    candidateDbs.add(resolve(privateState, "agentic", "runs.db"));
  }
  const localStateDir = resolve(input.repositoryRoot, ".bflow", "state");
  if (existsSync(localStateDir)) {
    candidateDbs.add(resolve(localStateDir, "agentic", "runs.db"));
    candidateDbs.add(resolve(localStateDir, "runs.db"));
  }

  const mergedRuns = new Map<string, AuthoritativeActiveRun>();
  let corruptError: string | undefined;
  for (const dbPath of candidateDbs) {
    const inspected = readActiveRunsFromSqlite(dbPath);
    if (inspected.corruptError && !corruptError) {
      corruptError = inspected.corruptError;
    }
    for (const run of inspected.runs) {
      mergedRuns.set(run.runId, run);
    }
  }

  if (input.injectedRuntime) {
    try {
      const queried = await input.injectedRuntime.findRuns({
        status: [...ACTIVE_RUN_STATUSES]
      });
      if (queried.ok) {
        for (const item of queried.value.items) {
          if (ACTIVE_RUN_STATUSES.includes(item.status)) {
            mergedRuns.set(item.runId, { runId: item.runId, status: item.status });
          }
        }
      }
    } catch {
      // Observational fallback only
    }
  }

  const issues: string[] = [];
  let activeRunsCheck: RuntimeObservationCheck;

  if (corruptError) {
    issues.push(corruptError);
    activeRunsCheck = {
      status: "fail",
      reason: corruptError,
      remediation:
        "Preserve .bflow/state and private Runtime state; inspect SQLite RunStore integrity before retrying."
    };
  } else {
    const runs = [...mergedRuns.values()];
    const cancelling = runs.filter((r) => r.status === "cancelling");
    const manifestIds = input.manifest?.activeRunIds ?? [];
    const runSummary = runs.map((r) => `${r.runId} [${r.status}]`).join(", ");
    const sameProjection =
      input.manifest !== null &&
      manifestIds.length === runs.length &&
      runs.every((r) => manifestIds.includes(r.runId));
    const reconcileHint =
      cancelling.length > 0
        ? ` Reconcile stuck cancellation with 'bflow cancel ${cancelling[0]!.runId} --reconcile'.`
        : "";

    if (input.server === "stopped" && runs.length > 0) {
      const msg = `Session is stopped while authoritative RunStore still has ${runs.length} unfinished run(s): ${runSummary}. Run 'bflow up' to resume or 'bflow status <run-id>' to inspect.${reconcileHint}`;
      issues.push(msg);
      activeRunsCheck = {
        status: "warning",
        reason: msg,
        remediation:
          cancelling.length > 0
            ? `Run 'bflow cancel ${cancelling[0]!.runId} --reconcile' or 'bflow up'.`
            : "Run 'bflow up' to resume active workflows or inspect them with 'bflow status <run-id>'."
      };
    } else if (input.manifest !== null && !sameProjection) {
      const projectedLabel = manifestIds.length > 0 ? manifestIds.join(", ") : "none";
      const actualLabel = runs.length > 0 ? runSummary : "none";
      const msg = `Session projection drift: session.json reports activeRunIds=[${projectedLabel}] while authoritative RunStore has [${actualLabel}].${reconcileHint}`;
      issues.push(msg);
      activeRunsCheck = {
        status: "warning",
        reason: msg,
        remediation:
          cancelling.length > 0
            ? `Run 'bflow cancel ${cancelling[0]!.runId} --reconcile' to reconcile stuck cancellation.`
            : "Inspect active runs with 'bflow status <run-id>' before shutting down."
      };
    } else if (cancelling.length > 0) {
      const msg = `Authoritative RunStore has ${cancelling.length} run(s) in 'cancelling' state (${cancelling.map((r) => r.runId).join(", ")}).${reconcileHint}`;
      issues.push(msg);
      activeRunsCheck = {
        status: "warning",
        reason: msg,
        remediation: `Run 'bflow cancel ${cancelling[0]!.runId} --reconcile' to confirm stop and finalize cancellation.`
      };
    } else {
      activeRunsCheck = {
        status: "pass",
        reason:
          runs.length === 0
            ? "Authoritative RunStore has no unfinished runs."
            : `Authoritative RunStore matches session projection (${runSummary}).`,
        remediation: ""
      };
    }
  }

  const hostSkew = await observeHostBuildSkew(privateState, input.repositoryRoot, input.sessionName);
  if (hostSkew.issue) {
    issues.push(hostSkew.issue);
  }

  return {
    activeRuns: [...mergedRuns.values()],
    issues,
    activeRunsCheck,
    hostBuildCheck: {
      status: hostSkew.status,
      reason: hostSkew.reason,
      remediation: hostSkew.remediation
    }
  };
}
