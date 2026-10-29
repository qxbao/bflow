import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "smol-toml";

export type CodexTrustResult = "already_trusted" | "trusted" | "skipped";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Records the "Trust this folder?" answer Codex would otherwise ask for in each headless pane.
 * Callers must hold an explicit repository opt-in (`environment.permissions.trustedWorkspace: true`).
 * The user's file is never rewritten: only a `[projects."<root>"] trust_level = "trusted"` table is
 * appended, the result is re-parsed before an atomic replace, and an existing decision (including
 * "untrusted"), an unreadable/unparsable file or a missing Codex home is left alone.
 */
export async function ensureCodexWorkspaceTrust(workspaceRoot: string, configFile: string): Promise<CodexTrustResult> {
  try {
    const home = await lstat(dirname(configFile));
    if (!home.isDirectory()) return "skipped";
  } catch { return "skipped"; }
  let text = "";
  let mode = 0o600;
  try {
    const info = await lstat(configFile);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return "skipped";
    mode = info.mode & 0o777;
    const handle = await open(configFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "skipped";
  }
  let parsed: Record<string, unknown>;
  try { parsed = parse(text) as Record<string, unknown>; } catch { return "skipped"; }
  const projects = parsed["projects"];
  if (projects !== undefined && record(projects) === undefined) return "skipped";
  const current = record(projects)?.[workspaceRoot];
  if (current !== undefined) return record(current)?.["trust_level"] === "trusted" ? "already_trusted" : "skipped";
  // JSON string escaping is a valid TOML basic string for a path key.
  const next = `${text}${text.length && !text.endsWith("\n") ? "\n" : ""}${text.length ? "\n" : ""}[projects.${JSON.stringify(workspaceRoot)}]\ntrust_level = "trusted"\n`;
  try {
    const check = record(record(parse(next) as Record<string, unknown>)?.["projects"])?.[workspaceRoot];
    if (record(check)?.["trust_level"] !== "trusted") return "skipped";
  } catch { return "skipped"; }
  const temporary = `${configFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try { await handle.writeFile(next, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await chmod(temporary, mode);
    // Lost race with another writer: keep their file.
    try { if ((await stat(configFile)).size !== Buffer.byteLength(text)) { await rm(temporary, { force: true }); return "skipped"; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(temporary, configFile);
    return "trusted";
  } catch {
    await rm(temporary, { force: true });
    return "skipped";
  }
}
