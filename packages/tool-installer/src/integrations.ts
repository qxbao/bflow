import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { ToolCapabilitySchema, type ToolCapability } from "@bflow/contracts";
import { z } from "zod";
import { createToolCapability, systemToolHost, type ProcessResult, type ToolHost } from "./installer.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const gitNexusFreshnessSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.string().min(1),
  status: z.enum(["up-to-date", "stale"])
}).passthrough();
const gitNexusUnindexedSchema = z.object({
  schemaVersion: z.literal(1), repository: z.string().min(1),
  error: z.enum(["not-indexed", "stale-kuzu-index"])
}).passthrough();
const gitNexusStatusSchema = z.union([gitNexusFreshnessSchema, gitNexusUnindexedSchema]);

function parseGitNexusStatus(result: { exitCode: number; stdout: string }): z.infer<typeof gitNexusStatusSchema> | null {
  if (result.exitCode !== 0) return null;
  const parsed = gitNexusStatusSchema.safeParse(JSON.parse(result.stdout));
  return parsed.success ? parsed.data : null;
}

/** Runtime should persist this inventory through MachineSetup. No capability is registered from install alone. */
export class ToolCapabilityRegistry {
  readonly #items = new Map<string, { scopeKey: string; capability: ToolCapability }>();
  register(raw: unknown, evidence: { verified: boolean; version: string; scopeKey: string }): ToolCapability {
    const capability = ToolCapabilitySchema.parse(raw);
    if (!evidence.verified || !evidence.scopeKey || capability.version !== evidence.version)
      throw new Error("Current functional verification is required to register a capability");
    const key = JSON.stringify([evidence.scopeKey, capability.toolId]);
    this.#items.set(key, { scopeKey: evidence.scopeKey, capability });
    return capability;
  }
  get(scopeKey: string, toolId: string): ToolCapability | null { return this.#items.get(JSON.stringify([scopeKey, toolId]))?.capability ?? null; }
  list(scopeKey: string): ToolCapability[] {
    return [...this.#items.values()].filter(item => item.scopeKey === scopeKey).map(item => item.capability);
  }
  revoke(scopeKey: string, toolId: string): void { this.#items.delete(JSON.stringify([scopeKey, toolId])); }
}

const registryFileSchema = z.object({ schemaVersion: z.literal(3), entries: z.array(z.object({
  scopeKey: z.string().min(1), capability: ToolCapabilitySchema
}).strict()) }).strict().superRefine((state, ctx) => {
  const keys = state.entries.map(entry => JSON.stringify([entry.scopeKey, entry.capability.toolId]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate capability registration" });
});

/** Durable inventory; lock is shared by processes and never stolen automatically. */
export class FileToolCapabilityRegistry {
  readonly #file: string;
  constructor(file: string) { if (!isAbsolute(file)) throw new Error("Registry file must be absolute"); this.#file = file; }
  async #read() {
    try {
      if ((await lstat(this.#file)).isSymbolicLink()) throw new Error("Capability registry must not be a symlink");
      return registryFileSchema.parse(JSON.parse(await readFile(this.#file, "utf8")));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 3 as const, entries: [] };
      throw error;
    }
  }
  async #write(entries: z.infer<typeof registryFileSchema>["entries"]): Promise<void> {
    const temporary = `${this.#file}.tmp-${randomUUID()}`;
    const payload = JSON.stringify(registryFileSchema.parse({ schemaVersion: 3, entries }));
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(payload); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await rename(temporary, this.#file);
      const directory = await open(dirname(this.#file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }
  async #locked<T>(action: (entries: z.infer<typeof registryFileSchema>["entries"]) => Promise<T>): Promise<T> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    const directory = await lstat(dirname(this.#file));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Capability registry directory is not a real directory");
    const lockPath = `${this.#file}.lock`;
    const lock = await open(lockPath, "wx", 0o600);
    try { return await action((await this.#read()).entries); }
    finally { await lock.close(); await rm(lockPath, { force: true }); }
  }
  async register(raw: unknown, evidence: { verified: boolean; version: string; scopeKey: string }): Promise<ToolCapability> {
    const capability = new ToolCapabilityRegistry().register(raw, evidence);
    return this.#locked(async entries => {
      const next = entries.filter(entry => entry.scopeKey !== evidence.scopeKey || entry.capability.toolId !== capability.toolId);
      next.push({ scopeKey: evidence.scopeKey, capability });
      await this.#write(next);
      return capability;
    });
  }
  async list(scopeKey: string): Promise<ToolCapability[]> {
    return this.#locked(async entries => entries.filter(entry => entry.scopeKey === scopeKey).map(entry => entry.capability));
  }
  async revoke(scopeKey: string, toolId: string): Promise<void> {
    await this.#locked(async entries => this.#write(entries.filter(entry => entry.scopeKey !== scopeKey || entry.capability.toolId !== toolId)));
  }
}

export interface OwnedConfigResult { status: "applied" | "already_satisfied" | "blocked"; digest: string; rollbackPath: string | null; }

/** Writes only a Bflow-owned generated config. An existing unowned file is never merged or overwritten. */
export async function writeOwnedToolConfig(path: string, content: string, expectedDigest: string | null): Promise<OwnedConfigResult> {
  if (!isAbsolute(path)) throw new Error("Owned config path must be absolute");
  const desired = sha(content);
  const markerPath = `${path}.bflow-owner`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) return { status: "blocked", digest: desired, rollbackPath: null };
  const lockPath = `${path}.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { return { status: "blocked", digest: desired, rollbackPath: null }; }
  try {
    let old: string | null = null;
    for (const candidate of [path, markerPath]) {
      try { if ((await lstat(candidate)).isSymbolicLink()) return { status: "blocked", digest: desired, rollbackPath: null }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { old = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (old !== null) {
      const marker = await readFile(markerPath, "utf8").catch(() => "");
      if (marker.trim() !== sha(old) || expectedDigest !== sha(old))
        return { status: "blocked", digest: desired, rollbackPath: null };
      if (old === content) return { status: "already_satisfied", digest: desired, rollbackPath: null };
    } else {
      if (expectedDigest !== null) return { status: "blocked", digest: desired, rollbackPath: null };
      try { await lstat(markerPath); return { status: "blocked", digest: desired, rollbackPath: null }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const nonce = randomUUID();
    const rollbackPath = old === null ? null : `${path}.previous-${nonce}`;
    const staging = `${path}.staging-${nonce}`;
    const markerStaging = `${markerPath}.staging-${nonce}`;
    try {
      await writeFile(staging, content, { flag: "wx", mode: 0o600 });
      await writeFile(markerStaging, desired, { flag: "wx", mode: 0o600 });
      if (rollbackPath) await rename(path, rollbackPath);
      await rename(staging, path);
      await rename(markerStaging, markerPath);
      return { status: "applied", digest: desired, rollbackPath };
    } catch (error) {
      if (rollbackPath) await rename(rollbackPath, path).catch(() => {});
      else await rm(path, { force: true }).catch(() => {});
      throw error;
    } finally { await rm(staging, { force: true }); await rm(markerStaging, { force: true }); }
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

export async function verifyRtk(executable: string, expectedVersion: string, host: ToolHost = systemToolHost): Promise<boolean> {
  const version = await host.run(executable, ["--version"], { timeoutMs: 15_000 });
  if (version.exitCode !== 0 || !(version.stdout + version.stderr).includes(expectedVersion)) return false;
  const gain = await host.run(executable, ["gain"], { timeoutMs: 15_000 });
  return gain.exitCode === 0 && (gain.stdout + gain.stderr).trim().length > 0;
}

/** Returns the real proxied exit status; fullOutput disables filtering for debugging. */
export async function runWithRtk(executable: string, command: readonly string[], fullOutput: boolean,
  host: ToolHost = systemToolHost): Promise<ProcessResult> {
  if (command.length === 0 || command.some(arg => arg.includes("\0"))) throw new Error("Invalid RTK command");
  return host.run(executable, [...(fullOutput ? ["proxy"] : []), ...command]);
}

export interface RtkProviderIntegration {
  provider: "claude" | "codex" | "agy";
  supported: boolean;
  configureCommand: readonly string[];
  fullOutputCommand: readonly string[];
  reason?: string;
}

/** Probe the installed binary's options; a release label alone never proves hook support. */
export async function rtkProviderIntegration(provider: RtkProviderIntegration["provider"], executable = "rtk",
  host: ToolHost = systemToolHost): Promise<RtkProviderIntegration> {
  const help = await host.run(executable, ["init", "--help"], { timeoutMs: 15_000 });
  const output = help.stdout + help.stderr;
  const supported = help.exitCode === 0 && (provider === "claude" ? /(?:^|\s)-g(?:\s|,)|--global/.test(output) :
    provider === "codex" ? output.includes("--codex") : output.includes("antigravity"));
  const commands = {
    claude: [executable, "init", "-g"], codex: [executable, "init", "-g", "--codex"],
    agy: [executable, "init", "--agent", "antigravity"]
  } as const;
  return { provider, supported, configureCommand: commands[provider], fullOutputCommand: [executable, "proxy", "<command>"],
    ...(!supported ? { reason: "Installed RTK init does not advertise this provider route" } : {}) };
}

export interface MemoryWorkerObservation {
  status: "ready" | "missing" | "blocked";
  endpoint: string | null;
  projectRoot: string;
  diagnostic: string;
  capability: ToolCapability | null;
}

/** Adopts the existing loopback worker only. Its HTTP API is never registered as raw MCP. */
export async function observeClaudeMemWorker(input: {
  dataDir: string; projectRoot: string; port?: number; version: string; timeoutMs?: number;
  fetcher?: typeof fetch;
}): Promise<MemoryWorkerObservation> {
  const projectRoot = await realpath(input.projectRoot);
  let port = input.port;
  if (port === undefined) {
    try { port = Number((await readFile(join(input.dataDir, ".worker.port"), "utf8")).trim()); }
    catch { return { status: "missing", endpoint: null, projectRoot, diagnostic: "Claude-Mem worker port file absent", capability: null }; }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { status: "blocked", endpoint: null, projectRoot, diagnostic: "Invalid Claude-Mem worker port", capability: null };
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    const response = await (input.fetcher ?? fetch)(`${endpoint}/api/health`, { signal: AbortSignal.timeout(input.timeoutMs ?? 3000), redirect: "error" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (!body || body.length > 64_000) throw new Error("Invalid health response");
    const health = z.object({ status: z.literal("ok"), version: z.string().min(1) }).passthrough().parse(JSON.parse(body));
    if (health.version !== input.version) throw new Error(`Worker version ${health.version} differs from ${input.version}`);
    return { status: "ready", endpoint, projectRoot,
      diagnostic: "Worker health verified; project-filtering adapter and Gateway authorization still required",
      capability: null };
  } catch (error) {
    return { status: "blocked", endpoint, projectRoot, diagnostic: `Worker health failed: ${String(error)}`, capability: null };
  }
}

const memoryObservationSchema = z.object({ id: z.number().int().positive(), project: z.string().min(1) }).passthrough();

/** Narrow read-only adapter. Only the batch endpoint is reachable and every returned row is checked again. */
export class ClaudeMemProjectReader {
  readonly #endpoint: string;
  readonly #project: string;
  readonly #fetcher: typeof fetch;
  constructor(endpoint: string, project: string, fetcher: typeof fetch = fetch) {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("Claude-Mem worker endpoint must be plain loopback HTTP origin");
    if (!project.trim()) throw new Error("Project mapping is required");
    this.#endpoint = url.origin;
    this.#project = project;
    this.#fetcher = fetcher;
  }
  async getObservations(ids: readonly number[]): Promise<readonly z.infer<typeof memoryObservationSchema>[]> {
    if (ids.length === 0 || ids.length > 50 || ids.some(id => !Number.isInteger(id) || id < 1)) throw new Error("Invalid observation IDs");
    const response = await this.#fetcher(`${this.#endpoint}/api/observations/batch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, project: this.#project, limit: ids.length }),
      signal: AbortSignal.timeout(5000), redirect: "error"
    });
    if (!response.ok) throw new Error(`Claude-Mem batch HTTP ${response.status}`);
    const content = await response.text();
    if (content.length > 1_000_000) throw new Error("Memory response too large");
    const observations = z.array(memoryObservationSchema).max(50).parse(JSON.parse(content));
    if (observations.some(row => row.project !== this.#project || !ids.includes(row.id))) throw new Error("Cross-project memory response rejected");
    return observations;
  }
}

/** Samples an adopted worker without starting another process. RSS is in kilobytes on supported ps implementations. */
export async function observeClaudeMemGrowth(input: {
  dataDir: string; host?: ToolHost; intervalMs: number; maxGrowthBytes: number;
}): Promise<{ status: "within_limit" | "growing" | "unavailable"; firstBytes: number | null; lastBytes: number | null }> {
  let pid: number;
  try { pid = Number((await readFile(join(input.dataDir, ".worker.pid"), "utf8")).trim()); }
  catch { return { status: "unavailable", firstBytes: null, lastBytes: null }; }
  if (!Number.isInteger(pid) || pid < 1 || !Number.isInteger(input.maxGrowthBytes) || input.maxGrowthBytes < 0 || input.intervalMs < 0)
    throw new Error("Invalid worker memory observation input");
  const host = input.host ?? systemToolHost;
  const sample = async () => {
    const result = await host.run("ps", ["-o", "rss=", "-p", String(pid)], { timeoutMs: 5_000 });
    const kb = Number(result.stdout.trim());
    return result.exitCode === 0 && Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
  };
  const firstBytes = await sample();
  if (input.intervalMs) await new Promise(done => setTimeout(done, input.intervalMs));
  const lastBytes = await sample();
  if (firstBytes === null || lastBytes === null) return { status: "unavailable", firstBytes, lastBytes };
  return { status: lastBytes - firstBytes > input.maxGrowthBytes ? "growing" : "within_limit", firstBytes, lastBytes };
}

/** Gateway owns the actual MCP process and protocol; a failed negotiation cannot publish a tool. */
export async function verifyMcpStartup(input: {
  toolId: "gitnexus" | "chrome-devtools-mcp"; version: string; repositoryId: string;
  negotiate: () => Promise<{ protocolVersion: string; discoveredTools: readonly string[] }>;
}): Promise<{ status: "ready" | "blocked"; capability: ToolCapability | null; diagnostic: string }> {
  try {
    const result = await input.negotiate();
    if (!result.protocolVersion || result.discoveredTools.length === 0) throw new Error("MCP negotiation returned no tools");
    return { status: "ready", capability: createToolCapability(input.toolId, input.version, input.repositoryId), diagnostic: "MCP protocol and tools discovered" };
  } catch (error) { return { status: "blocked", capability: null, diagnostic: `MCP startup failed: ${String(error)}` }; }
}

export interface GitNexusIndexObservation {
  status: "fresh" | "indexed" | "busy" | "failed" | "stale";
  repositoryRoot: string;
  fingerprint: string;
  diagnostic: string;
}

/** One machine-wide writer lock because independent repos may share a GitNexus registry/store. */
export async function ensureGitNexusIndex(input: {
  repositoryRoot: string; stateRoot: string; executable: string; host?: ToolHost; timeoutMs?: number;
}): Promise<GitNexusIndexObservation> {
  const host = input.host ?? systemToolHost;
  const root = await realpath(input.repositoryRoot);
  const head = await host.run("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 15_000 });
  const dirty = await host.run("git", ["status", "--porcelain"], { cwd: root, timeoutMs: 15_000 });
  if (head.exitCode !== 0 || dirty.exitCode !== 0) throw new Error("Repository fingerprint unavailable");
  const fingerprint = sha(head.stdout.trim() + "\n" + dirty.stdout);
  await mkdir(input.stateRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(input.stateRoot, "gitnexus-writer.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { return { status: "busy", repositoryRoot: root, fingerprint, diagnostic: "GitNexus writer already active" }; }
  const receiptPath = join(input.stateRoot, `gitnexus-${sha(root)}.json`);
  try {
    const statusResult = await host.run(input.executable, ["status", "--json"], { cwd: root, timeoutMs: input.timeoutMs ?? 30_000 });
    let status: z.infer<typeof gitNexusStatusSchema> | null = null;
    try { status = parseGitNexusStatus(statusResult); } catch { /* unsupported/malformed status */ }
    const statusRepo = status ? await realpath(status.repository).catch(() => null) : null;
    if (!status || statusResult.exitCode !== 0 || statusRepo !== root)
      return { status: "failed", repositoryRoot: root, fingerprint, diagnostic: "GitNexus status JSON is unsupported, invalid or identifies another repository" };
    if ("status" in status && status.status === "up-to-date")
      return { status: "fresh", repositoryRoot: root, fingerprint, diagnostic: "GitNexus status --json confirms a current index" };
    const analyzed = await host.run(input.executable, ["analyze", root, "--index-only"], { cwd: root, timeoutMs: input.timeoutMs ?? 300_000 });
    if (analyzed.exitCode !== 0)
      return { status: "failed", repositoryRoot: root, fingerprint, diagnostic: `gitnexus analyze exited ${analyzed.exitCode}: ${analyzed.stderr.slice(0, 400)}` };
    const afterResult = await host.run(input.executable, ["status", "--json"], { cwd: root, timeoutMs: input.timeoutMs ?? 30_000 });
    let after: z.infer<typeof gitNexusStatusSchema> | null = null;
    try { after = parseGitNexusStatus(afterResult); } catch { /* fail closed */ }
    const afterRepo = after ? await realpath(after.repository).catch(() => null) : null;
    if (afterRepo !== root || !after || !("status" in after) || after.status !== "up-to-date")
      return { status: "stale", repositoryRoot: root, fingerprint, diagnostic: "Post-index status did not verify freshness" };
    await writeFile(receiptPath, JSON.stringify({ repositoryRoot: root, fingerprint, indexedAt: new Date().toISOString() }), { mode: 0o600 });
    return { status: "indexed", repositoryRoot: root, fingerprint, diagnostic: "Index refreshed and status verified" };
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

export interface BrowserSessionPlan {
  status: "ready" | "profile_locked" | "browser_missing";
  profileDir: string;
  resourceKey: string;
  executable: string;
  argv: readonly string[];
  diagnostic: string;
}

/** Each task gets a private profile. Gateway must still lease the resourceKey per page call. */
export async function planChromeSession(input: {
  managedRoot: string; repositoryId: string; taskId: string; browserExecutable: string;
  serverExecutable: string; host?: ToolHost;
}): Promise<BrowserSessionPlan> {
  if (!isAbsolute(input.managedRoot) || !/^[A-Za-z0-9._-]+$/.test(input.repositoryId) || !/^[A-Za-z0-9._-]+$/.test(input.taskId) ||
    [input.repositoryId, input.taskId].includes(".") || [input.repositoryId, input.taskId].includes(".."))
    throw new Error("Invalid managed browser scope");
  const host = input.host ?? systemToolHost;
  await mkdir(input.managedRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(input.managedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Managed browser root is not a real directory");
  const canonicalRoot = await realpath(input.managedRoot);
  const profileDir = resolve(canonicalRoot, "chrome", input.repositoryId, input.taskId);
  if (!profileDir.startsWith(`${canonicalRoot}${sep}`)) throw new Error("Profile escaped managed root");
  const result = await host.run(input.browserExecutable, ["--version"], { timeoutMs: 15_000 });
  const base = { profileDir, resourceKey: `chrome-${sha(profileDir).slice(0, 24)}`, executable: input.serverExecutable,
    argv: ["--userDataDir", profileDir, "--executablePath", input.browserExecutable] };
  if (result.exitCode !== 0 || !/chrome|chromium/i.test(result.stdout + result.stderr))
    return { ...base, status: "browser_missing", diagnostic: "Chrome executable did not pass version probe" };
  const server = await host.run(input.serverExecutable, ["--version"], { timeoutMs: 15_000 });
  if (server.exitCode !== 0 || !(server.stdout + server.stderr).trim())
    return { ...base, status: "browser_missing", diagnostic: "Chrome DevTools MCP executable did not pass version probe" };
  for (const directory of [join(canonicalRoot, "chrome"), join(canonicalRoot, "chrome", input.repositoryId), profileDir]) {
    await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Browser profile path traverses a link or non-directory");
  }
  for (const name of ["SingletonLock", ".bflow-profile.lock"]) {
    try { await lstat(join(profileDir, name)); return { ...base, status: "profile_locked", diagnostic: `${name} exists; do not reuse this profile` }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { ...base, status: "ready", diagnostic: "Dedicated profile ready; server will launch Chrome on first browser tool use" };
}

export const SuperpowersProviderSchema = z.enum(["claude", "codex", "agy"]);
export function superpowersInstallRoute(provider: z.infer<typeof SuperpowersProviderSchema>): {
  provider: string; command: string; verification: string; bflowPolicy: string;
} {
  SuperpowersProviderSchema.parse(provider);
  const routes = {
    claude: { command: "/plugin install superpowers@claude-plugins-official", verification: "/plugins" },
    codex: { command: "/plugins → Superpowers → Install Plugin", verification: "/plugins" },
    agy: { command: "agy plugin install https://github.com/obra/superpowers", verification: "agy plugin list" }
  };
  return { provider, ...routes[provider], bflowPolicy: "External skills are namespaced and subordinate to Bflow's TDD decision and required gates" };
}

export function verifySuperpowersSkills(observedSkillIds: readonly string[], bflowSkillIds: readonly string[]): {
  ready: boolean; namespacedIds: readonly string[]; diagnostic: string;
} {
  const normalized = observedSkillIds.map(id => id.trim()).filter(Boolean);
  if (!normalized.includes("using-superpowers")) return { ready: false, namespacedIds: [], diagnostic: "using-superpowers skill was not discovered" };
  const namespacedIds = normalized.map(id => `superpowers:${id}`);
  if (namespacedIds.some(id => bflowSkillIds.includes(id)))
    return { ready: false, namespacedIds: [], diagnostic: "External skill ID collides with a Bflow skill" };
  return { ready: true, namespacedIds, diagnostic: "Provider skill discovery verified; Bflow policy still governs TDD" };
}
