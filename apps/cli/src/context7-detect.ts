import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ExistingContext7Registration {
  readonly provider: "claude" | "codex" | "agy";
  /** Where it was found: a file path, or the provider command that reported it. */
  readonly source: string;
  readonly name: string;
}

export interface Context7DetectionRunner {
  run(command: readonly string[], options?: { timeoutMs?: number }): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

const isContext7 = (name: string, ...fields: ReadonlyArray<unknown>): boolean =>
  /context7/i.test(name) || fields.some(field => typeof field === "string" && /context7\.com|@upstash\/context7-mcp/i.test(field)) ||
  fields.some(field => Array.isArray(field) && field.some(item => typeof item === "string" && /@upstash\/context7-mcp/i.test(item)));

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

/** Claude Code keeps user-scope MCP servers in `~/.claude.json` (`mcpServers`, plus one table per project). Read-only. */
export async function detectClaudeContext7(homeDirectory: string): Promise<ExistingContext7Registration[]> {
  const text = await readText(join(homeDirectory, ".claude.json"));
  if (text === null) return [];
  let root: any;
  try { root = JSON.parse(text); } catch { return []; }
  const found: ExistingContext7Registration[] = [];
  const scan = (servers: unknown) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, entry] of Object.entries(servers as Record<string, any>))
      if (isContext7(name, entry?.url, entry?.command, entry?.args)) found.push({ provider: "claude", source: join(homeDirectory, ".claude.json"), name });
  };
  scan(root?.mcpServers);
  for (const project of Object.values(root?.projects ?? {}) as any[]) scan(project?.mcpServers);
  return found;
}

/** Codex keeps MCP servers as `[mcp_servers.<name>]` tables in `config.toml`. Read-only text scan. */
export async function detectCodexContext7(codexHome: string): Promise<ExistingContext7Registration[]> {
  const path = join(codexHome, "config.toml");
  const text = await readText(path);
  if (text === null) return [];
  const found: ExistingContext7Registration[] = [];
  const tables = text.split(/^\s*\[/m).slice(1);
  for (const table of tables) {
    const header = /^\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*(?:\.[^\]]*)?\]/.exec(table);
    if (!header) continue;
    const name = header[1] ?? header[2] ?? "";
    if (isContext7(name, table)) found.push({ provider: "codex", source: path, name });
  }
  return [...new Map(found.map(item => [item.name, item])).values()];
}

/** Agy reports its servers through `agy mcp list` (name, type, status, command or URL). The command only reads configuration. */
export async function detectAgyContext7(runner: Context7DetectionRunner): Promise<ExistingContext7Registration[]> {
  try {
    const result = await runner.run(["agy", "mcp", "list"], { timeoutMs: 8000 });
    if (result.exitCode !== 0) return [];
    const found: ExistingContext7Registration[] = [];
    for (const line of result.stdout.split("\n").slice(1)) {
      const columns = line.trim().split(/\s{2,}|\s+/);
      const name = columns[0];
      if (name && isContext7(name, line)) found.push({ provider: "agy", source: "agy mcp list", name });
    }
    return found;
  } catch { return []; }
}

export async function detectExistingContext7(input: { homeDirectory: string; codexHome: string; runner: Context7DetectionRunner }): Promise<ExistingContext7Registration[]> {
  const [claude, codex, agy] = await Promise.all([detectClaudeContext7(input.homeDirectory), detectCodexContext7(input.codexHome), detectAgyContext7(input.runner)]);
  return [...claude, ...codex, ...agy];
}

/** One diagnostic line per provider for the setup report. */
export function describeExistingContext7(found: readonly ExistingContext7Registration[]): string[] {
  if (found.length === 0) return [];
  const byProvider = new Map<string, string[]>();
  for (const item of found) byProvider.set(item.provider, [...(byProvider.get(item.provider) ?? []), item.name]);
  const where = [...byProvider.entries()].map(([provider, names]) => `${provider} (${[...new Set(names)].join(", ")})`).join("; ");
  return [`Context7 is already registered directly with ${where}. Bflow leaves those entries untouched. Roles launched by Bflow receive MCP servers only through the shared Gateway, because provider launches ignore the account's global MCP servers, so no duplicate registration is created.`];
}
