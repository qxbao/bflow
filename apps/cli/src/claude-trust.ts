import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClaudeTrustResult = "already_trusted" | "trusted" | "skipped";

/** Where Claude Code keeps per-project trust: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeConfigFile(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? join(dir, ".claude.json") : join(home, ".claude.json");
}

/**
 * Records the trust-dialog acceptance Claude Code would otherwise ask for in each pane. Callers must have an explicit
 * repository opt-in (`environment.permissions.trustedWorkspace: true`). Only `projects[<root>].hasTrustDialogAccepted`
 * is touched; an unreadable or unparseable file is left alone (the dialog then simply appears) and the write is atomic.
 */
export async function ensureClaudeWorkspaceTrust(workspaceRoot: string, file: string): Promise<ClaudeTrustResult> {
  let document: Record<string, unknown> = {};
  let mode = 0o600;
  try {
    mode = (await stat(file)).mode & 0o777;
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "skipped";
    document = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "skipped";
  }
  const projects = document.projects;
  if (projects !== undefined && (projects === null || typeof projects !== "object" || Array.isArray(projects))) return "skipped";
  const map = (projects ?? {}) as Record<string, unknown>;
  const current = map[workspaceRoot];
  if (current !== undefined && (current === null || typeof current !== "object" || Array.isArray(current))) return "skipped";
  if ((current as Record<string, unknown> | undefined)?.hasTrustDialogAccepted === true) return "already_trusted";
  document.projects = { ...map, [workspaceRoot]: { ...(current as Record<string, unknown> | undefined), hasTrustDialogAccepted: true } };
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(document, null, 2), { mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
    return "trusted";
  } catch {
    await rm(temporary, { force: true });
    return "skipped";
  }
}
