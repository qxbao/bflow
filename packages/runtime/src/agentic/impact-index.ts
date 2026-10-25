import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { z } from "zod";

export type IndexUnavailableCode =
  | "not_configured"
  | "status_failed"
  | "repository_mismatch"
  | "not_up_to_date"
  | "content_drift"
  | "commit_mismatch"
  | "incomplete"
  | "storage_locked"
  | "query_failed"
  | "changed_during_query";

export type ImportersResult =
  | { status: "ok"; indexCommit: string; files: string[] }
  | { status: "unavailable"; code: IndexUnavailableCode; detail: string };

export interface ImpactIndex {
  importersOf(input: { repositoryRoot: string; base: string; files: readonly string[] }): Promise<ImportersResult>;
}

export interface GitNexusImpactIndexOptions {
  executable: string;
  home: string;
  storageLockPath: string;
  run?: (
    executable: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; timeoutMs: number }
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

const CYPHER_ROW_LIMIT = 5000;
const CYPHER_BATCH_SIZE = 100;
const COMMAND_TIMEOUT_MS = 30_000;

const cypherResultSchema = z
  .object({
    markdown: z.string().optional().default(""),
    row_count: z.number().int().nonnegative()
  })
  .passthrough();

const gitNexusStatusSchema = z
  .object({
    repository: z.string().min(1),
    status: z.string().optional(),
    contentDrift: z
      .object({
        status: z.string().optional()
      })
      .passthrough()
      .optional(),
    index: z
      .object({
        commit: z.string().optional(),
        incompleteReasons: z.array(z.string()).optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

function parseTrailingJson(stdout: string): unknown {
  const lines = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const brace = line.indexOf("{");
    if (brace < 0) continue;
    const candidate = [line.slice(brace), ...lines.slice(i + 1)].join("\n");
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue scanning upward in case the trailing JSON object spans multiple lines.
    }
  }
  throw new Error("No trailing JSON object found in GitNexus output");
}

function isSafeRelativeFilePath(filePath: string): boolean {
  if (!filePath || filePath.startsWith("/")) return false;
  if (/['\\\r\n\0]/.test(filePath)) return false;
  const segments = filePath.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return false;
  return true;
}

export function parseCypherFilePaths(stdout: string): string[] {
  const parsed = cypherResultSchema.parse(parseTrailingJson(stdout));
  if (parsed.row_count >= CYPHER_ROW_LIMIT) {
    throw new Error(`Cypher query reached row limit (${parsed.row_count}); refusing truncated closure`);
  }
  const lines = parsed.markdown
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    if (parsed.row_count !== 0) {
      throw new Error(`Cypher row_count mismatch: expected ${parsed.row_count}, parsed 0`);
    }
    return [];
  }
  const separatorIndex = lines.findIndex(line => /^\|\s*:?-{3,}:?\s*\|$/.test(line));
  if (separatorIndex < 0) {
    if (parsed.row_count === 0) {
      return [];
    }
    throw new Error("Cypher markdown output is missing table separator");
  }
  const dataLines = lines.slice(separatorIndex + 1);
  const files: string[] = [];
  for (const line of dataLines) {
    if (!line.startsWith("|") || !line.endsWith("|")) {
      throw new Error(`Malformed Cypher markdown table row: ${line}`);
    }
    const cell = line.slice(1, -1).trim();
    if (!cell) {
      throw new Error("Empty filePath cell in Cypher markdown table row");
    }
    files.push(cell);
  }
  if (files.length !== parsed.row_count) {
    throw new Error(`Cypher row_count mismatch: expected ${parsed.row_count}, parsed ${files.length}`);
  }
  return files;
}

function defaultRun(
  executable: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number }
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...options.env
        }
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const code =
          typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : null;
        resolve({
          exitCode: code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? error.message ?? "")
        });
      }
    );
  });
}

async function validateStatusProbe(
  result: { exitCode: number | null; stdout: string; stderr: string },
  expectedRoot: string,
  expectedBase: string
): Promise<{ ok: true } | { ok: false; code: Exclude<IndexUnavailableCode, "not_configured" | "storage_locked" | "query_failed" | "changed_during_query">; detail: string }> {
  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: "status_failed",
      detail: `gitnexus status --json exited ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 240)}`
    };
  }
  let status: z.infer<typeof gitNexusStatusSchema>;
  try {
    status = gitNexusStatusSchema.parse(parseTrailingJson(result.stdout));
  } catch (error) {
    return {
      ok: false,
      code: "status_failed",
      detail: `Failed to parse gitnexus status --json: ${String(error)}`
    };
  }
  const statusRepo = await realpath(status.repository).catch(() => status.repository);
  if (statusRepo !== expectedRoot) {
    return {
      ok: false,
      code: "repository_mismatch",
      detail: `GitNexus status repository ${status.repository} does not match ${expectedRoot}`
    };
  }
  if (status.index?.commit !== expectedBase) {
    return {
      ok: false,
      code: "commit_mismatch",
      detail: `GitNexus index commit ${status.index?.commit ?? "missing"} does not match base ${expectedBase}`
    };
  }
  if ((status.index?.incompleteReasons?.length ?? 0) > 0) {
    return {
      ok: false,
      code: "incomplete",
      detail: `GitNexus index has incompleteReasons: ${status.index?.incompleteReasons?.join(", ")}`
    };
  }
  if (status.contentDrift?.status === "drifted") {
    return {
      ok: false,
      code: "content_drift",
      detail: `GitNexus contentDrift status is ${status.contentDrift.status}`
    };
  }
  if (status.status !== "up-to-date") {
    return {
      ok: false,
      code: "not_up_to_date",
      detail: `GitNexus index status is ${status.status ?? "unknown"}`
    };
  }
  if (status.contentDrift?.status !== "current") {
    return {
      ok: false,
      code: "content_drift",
      detail: `GitNexus contentDrift status is ${status.contentDrift?.status ?? "missing"}`
    };
  }
  return { ok: true };
}

export const unconfiguredImpactIndex: ImpactIndex = {
  async importersOf(): Promise<ImportersResult> {
    return {
      status: "unavailable",
      code: "not_configured",
      detail: "GitNexus impact index is not configured"
    };
  }
};

export function createGitNexusImpactIndex(options: GitNexusImpactIndexOptions): ImpactIndex {
  const run = options.run ?? defaultRun;
  return {
    async importersOf(input: { repositoryRoot: string; base: string; files: readonly string[] }): Promise<ImportersResult> {
      for (const filePath of input.files) {
        if (!isSafeRelativeFilePath(filePath)) {
          return {
            status: "unavailable",
            code: "query_failed",
            detail: `Unsafe file path rejected before Cypher query: ${JSON.stringify(filePath)}`
          };
        }
      }

      if (existsSync(options.storageLockPath)) {
        return {
          status: "unavailable",
          code: "storage_locked",
          detail: `GitNexus storage lock is present at ${options.storageLockPath}`
        };
      }

      const root = await realpath(input.repositoryRoot).catch(() => input.repositoryRoot);
      const env: Record<string, string> = {
        GITNEXUS_HOME: options.home,
        GITNEXUS_SHARED_STORE: "off"
      };

      const firstStatus = await run(options.executable, ["status", "--json"], {
        cwd: root,
        env,
        timeoutMs: COMMAND_TIMEOUT_MS
      });
      const firstValidation = await validateStatusProbe(firstStatus, root, input.base);
      if (!firstValidation.ok) {
        return {
          status: "unavailable",
          code: firstValidation.code,
          detail: firstValidation.detail
        };
      }

      const collected: string[] = [];
      for (let offset = 0; offset < input.files.length; offset += CYPHER_BATCH_SIZE) {
        const batch = input.files.slice(offset, offset + CYPHER_BATCH_SIZE);
        const query = `MATCH (t:File)-[:CodeRelation* 1..10 (r, n | WHERE r.type = 'IMPORTS')]->(f:File) WHERE f.filePath IN [${batch.map(filePath => `'${filePath}'`).join(",")}] RETURN DISTINCT t.filePath`;
        const cypherResult = await run(
          options.executable,
          ["cypher", "-r", root, "-l", String(CYPHER_ROW_LIMIT), query],
          {
            cwd: root,
            env,
            timeoutMs: COMMAND_TIMEOUT_MS
          }
        );
        if (cypherResult.exitCode !== 0) {
          return {
            status: "unavailable",
            code: "query_failed",
            detail: `gitnexus cypher exited ${String(cypherResult.exitCode)}: ${cypherResult.stderr.trim().slice(0, 240)}`
          };
        }
        try {
          collected.push(...parseCypherFilePaths(cypherResult.stdout));
        } catch (error) {
          return {
            status: "unavailable",
            code: "query_failed",
            detail: `Failed to parse gitnexus cypher output: ${String(error)}`
          };
        }
      }

      if (existsSync(options.storageLockPath)) {
        return {
          status: "unavailable",
          code: "changed_during_query",
          detail: `GitNexus storage lock appeared during query at ${options.storageLockPath}`
        };
      }

      const secondStatus = await run(options.executable, ["status", "--json"], {
        cwd: root,
        env,
        timeoutMs: COMMAND_TIMEOUT_MS
      });
      const secondValidation = await validateStatusProbe(secondStatus, root, input.base);
      if (!secondValidation.ok) {
        return {
          status: "unavailable",
          code: "changed_during_query",
          detail: `GitNexus status changed during query (${secondValidation.code}): ${secondValidation.detail}`
        };
      }

      return {
        status: "ok",
        indexCommit: input.base,
        files: [...new Set(collected)]
      };
    }
  };
}
