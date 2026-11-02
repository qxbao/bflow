import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  StoredRunSchema,
  type OperationOptions,
  type OperationResult,
  type Page,
  type RunQuery,
  type WorkflowRunSnapshot
} from "@bflow/contracts";
import {
  findPrivateRuntimeStateDirectory,
  openWorkspaceRuntime,
  type ConcreteRuntimeService
} from "@bflow/runtime";
import { identifyRepository } from "./repository.js";
import { loadRepositoryConfig, resolveReadableConfigPath } from "./config.js";
import type { BflowRepositoryConfig } from "./types.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface ComposeCliRuntimeOptions {
  readonly cwd?: string | undefined;
  readonly configPath?: string | undefined;
  readonly herdrBinary?: string | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly operationOptions?: OperationOptions | undefined;
  readonly readOnly?: boolean | undefined;
}

export interface ComposedCliRuntime {
  readonly runtime: ConcreteRuntimeService;
  readonly config: BflowRepositoryConfig;
  readonly configPath: string;
  close(): Promise<void>;
}

function collectExistingRunStorePaths(cwd: string, configuredRunStorePath: string): string[] {
  const candidates = new Set<string>();
  candidates.add(resolve(cwd, configuredRunStorePath));
  try {
    const privateState = findPrivateRuntimeStateDirectory(cwd);
    if (privateState) {
      candidates.add(resolve(privateState, "agentic", "runs.db"));
    }
  } catch {
    // Observational fallback only
  }
  candidates.add(resolve(cwd, ".bflow", "state", "agentic", "runs.db"));
  candidates.add(resolve(cwd, ".bflow", "state", "runs.db"));

  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        const info = lstatSync(candidate);
        if (info.isFile() && !info.isSymbolicLink()) {
          existing.push(candidate);
        }
      }
    } catch {
      // Ignore inaccessible candidate
    }
  }
  return existing;
}

function parseVerifiedStoredRun(
  dbPath: string,
  row: { run_id: string; status: string; payload: string; digest: string }
): OperationResult<WorkflowRunSnapshot> {
  const actualDigest = createHash("sha256").update(row.payload).digest("hex");
  if (actualDigest !== row.digest) {
    return {
      ok: false,
      error: {
        code: "corruption",
        retryable: false,
        message: `RunStore '${dbPath}' failed checksum verification for run '${row.run_id}'.`
      }
    };
  }
  try {
    const parsed = StoredRunSchema.parse(JSON.parse(row.payload));
    if (parsed.snapshot.runId !== row.run_id || parsed.snapshot.status !== row.status) {
      return {
        ok: false,
        error: {
          code: "corruption",
          retryable: false,
          message: `RunStore '${dbPath}' has inconsistent projection metadata for run '${row.run_id}'.`
        }
      };
    }
    return { ok: true, value: parsed.snapshot };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "corruption",
        retryable: false,
        message: `RunStore '${dbPath}' contains invalid stored run '${row.run_id}': ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }
}

function createReadOnlySqliteRuntime(dbPaths: readonly string[]): ConcreteRuntimeService {
  const readOnlyMutationError = (): OperationResult<never> => ({
    ok: false,
    error: {
      code: "validation",
      retryable: false,
      message: "Read-only status runtime cannot mutate workflow runs."
    }
  });

  const service = {
    async getRun(runId: string): Promise<OperationResult<WorkflowRunSnapshot | null>> {
      for (const dbPath of dbPaths) {
        let db: InstanceType<typeof DatabaseSync> | undefined;
        try {
          db = new DatabaseSync(dbPath, { readOnly: true });
          const hasRuns = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
            .get();
          if (!hasRuns) continue;
          const row = db
            .prepare("SELECT run_id, status, payload, digest FROM runs WHERE run_id = ?")
            .get(runId) as { run_id: string; status: string; payload: string; digest: string } | undefined;
          if (!row) continue;
          return parseVerifiedStoredRun(dbPath, row);
        } catch (error) {
          return {
            ok: false,
            error: {
              code: "corruption",
              retryable: false,
              message: `Cannot read RunStore '${dbPath}': ${error instanceof Error ? error.message : String(error)}`
            }
          };
        } finally {
          try { db?.close(); } catch { /* ignore */ }
        }
      }
      return { ok: true, value: null };
    },

    async findRuns(query?: RunQuery): Promise<OperationResult<Page<WorkflowRunSnapshot>>> {
      const byId = new Map<string, WorkflowRunSnapshot>();
      for (const dbPath of dbPaths) {
        let db: InstanceType<typeof DatabaseSync> | undefined;
        try {
          db = new DatabaseSync(dbPath, { readOnly: true });
          const hasRuns = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
            .get();
          if (!hasRuns) continue;
          const rows = db
            .prepare("SELECT run_id, status, payload, digest FROM runs ORDER BY created_at DESC, run_id ASC")
            .all() as Array<{ run_id: string; status: string; payload: string; digest: string }>;
          for (const row of rows) {
            if (byId.has(row.run_id)) continue;
            const parsed = parseVerifiedStoredRun(dbPath, row);
            if (!parsed.ok) return parsed;
            byId.set(row.run_id, parsed.value);
          }
        } catch (error) {
          return {
            ok: false,
            error: {
              code: "corruption",
              retryable: false,
              message: `Cannot query RunStore '${dbPath}': ${error instanceof Error ? error.message : String(error)}`
            }
          };
        } finally {
          try { db?.close(); } catch { /* ignore */ }
        }
      }

      const statusSet = query?.status && query.status.length > 0 ? new Set(query.status) : null;
      const filtered = [...byId.values()]
        .filter((snap) => (statusSet === null || statusSet.has(snap.status)) &&
          (query?.workflowId === undefined || snap.workflowId === query.workflowId))
        .sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : a.runId.localeCompare(b.runId)));

      let offset = 0;
      if (query?.cursor !== undefined) {
        const parsedOffset = Number.parseInt(query.cursor, 10);
        if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0 || String(parsedOffset) !== query.cursor) {
          return {
            ok: false,
            error: {
              code: "validation",
              retryable: false,
              message: `Invalid pagination cursor '${query.cursor}'.`
            }
          };
        }
        offset = parsedOffset;
      }
      const limit = query?.limit ?? 50;
      const items = filtered.slice(offset, offset + limit);
      const nextCursor = offset + limit < filtered.length ? String(offset + limit) : undefined;
      return { ok: true, value: nextCursor !== undefined ? { items, nextCursor } : { items } };
    },

    async start() { return readOnlyMutationError(); },
    async decide() { return readOnlyMutationError(); },
    async resume() { return readOnlyMutationError(); },
    async cancel() { return readOnlyMutationError(); }
  };

  return service as unknown as ConcreteRuntimeService;
}

export async function composeCliRuntime(
  options?: ComposeCliRuntimeOptions
): Promise<OperationResult<ComposedCliRuntime>> {
  let cwd = options?.cwd ?? process.cwd();
  // Environment config is rooted at the checkout even when invoked from a subdirectory.
  if (options?.configPath === undefined) {
    try {
      const repository = await identifyRepository(cwd);
      cwd = repository.root;
    } catch { /* Preserve the legacy explicit-directory Runtime error path. */ }
  }
  const resolvedConfigPath = resolveReadableConfigPath(cwd, options?.configPath);

  const configRes = await loadRepositoryConfig(resolvedConfigPath);
  if (!configRes.ok) {
    return configRes;
  }
  const config = configRes.value;

  if (options?.readOnly === true) {
    const dbPaths = collectExistingRunStorePaths(cwd, config.storage.runStorePath);
    return {
      ok: true,
      value: {
        runtime: createReadOnlySqliteRuntime(dbPaths),
        config,
        configPath: resolvedConfigPath,
        close: async () => undefined
      }
    };
  }

  const handleRes = await openWorkspaceRuntime({
    cwd,
    runtimeId: config.runtimeId,
    storage: config.storage,
    defaultWorkflow: config.defaultWorkflow,
    ...(options?.herdrBinary !== undefined ? { herdrBinary: options.herdrBinary } : {}),
    ...(options?.clock !== undefined ? { clock: options.clock } : {}),
    ...(options?.operationOptions !== undefined
      ? { operationOptions: options.operationOptions }
      : {})
  });

  if (!handleRes.ok) {
    return handleRes;
  }

  return {
    ok: true,
    value: {
      runtime: handleRes.value.runtime,
      config,
      configPath: resolvedConfigPath,
      close: () => handleRes.value.close()
    }
  };
}
