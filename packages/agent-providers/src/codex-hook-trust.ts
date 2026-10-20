import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { open, lstat, mkdir, opendir, realpath, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { parseCodexEnabledPlugins, parseCodexTomlHooks } from "./codex-hook-toml.js";
import { managedCodexDisabledPlugins, managedCodexPluginArgs } from "./codex-plugin-policy.js";

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const ABSOLUTE = z.string().min(1).refine(isAbsolute, "must be an absolute path");
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_DEPENDENCIES = 64;
const MAX_HOOKS = 128;
const MAX_COMMAND_BYTES = 16 * 1024;
const REVIEWED_ORCA_WRAPPER_SHA256 = "33d44c305023507bd8fc33a4c49b4343519b2f99b99295c62b695ffe13ba7e63";
export const CODEX_HOOK_APPROVAL_FILE = "codex-hook-approvals.json";

export const CodexHookDependencySchema = z.object({
  requestedPath: ABSOLUTE,
  resolvedPath: ABSOLUTE.nullable(),
  sha256: SHA256.nullable(),
  exists: z.boolean()
}).strict();
export type CodexHookDependency = z.infer<typeof CodexHookDependencySchema>;

export const CodexHookSourceSchema = z.object({
  kind: z.enum(["hooks_json", "config_toml", "orca_candidate", "script", "plugin_manifest", "plugin_hooks"]),
  path: ABSOLUTE,
  exists: z.boolean(),
  sha256: SHA256.nullable()
}).strict();
export type CodexHookSource = z.infer<typeof CodexHookSourceSchema>;

export const CodexHookInventoryEntrySchema = z.object({
  event: z.string().min(1).max(200),
  matcher: z.unknown().optional(),
  command: z.string().min(1).max(MAX_COMMAND_BYTES),
  digest: SHA256,
  dependencies: z.array(CodexHookDependencySchema).max(MAX_DEPENDENCIES)
}).strict();
export type CodexHookInventoryEntry = z.infer<typeof CodexHookInventoryEntrySchema>;

export const CodexHookReviewSchema = z.object({
  schemaVersion: z.literal(1),
  codexHomeDirectory: ABSOLUTE,
  approvalStorePath: ABSOLUTE,
  digest: SHA256,
  status: z.enum(["none", "approved", "approval_required", "unsupported"]),
  sources: z.array(CodexHookSourceSchema).max(MAX_DEPENDENCIES),
  hooks: z.array(CodexHookInventoryEntrySchema).max(MAX_HOOKS),
  diagnostics: z.array(z.string().max(1000)),
  unsupportedReasons: z.array(z.string().max(1000)),
  approvalMode: z.literal("trust_all").optional()
}).strict();
export type CodexHookReview = z.infer<typeof CodexHookReviewSchema>;

export const CodexHookApprovalSchema = z.object({
  schemaVersion: z.literal(1),
  codexHomeDirectory: ABSOLUTE,
  approvalStorePath: ABSOLUTE,
  digest: SHA256,
  approvedAt: z.string().datetime({ offset: true }),
  approvedBy: z.string().trim().min(1).max(200)
}).strict();
export type CodexHookApproval = z.infer<typeof CodexHookApprovalSchema>;

/** Explicit operator policy, separate from exact-digest snapshot receipts. */
export const CodexHookPolicySchema = z.object({
  schemaVersion: z.literal(1), policy: z.literal("trust_all"), codexHomeDirectory: ABSOLUTE,
  approvalStorePath: ABSOLUTE, approvedAt: z.string().datetime({ offset: true }),
  approvedBy: z.string().trim().min(1).max(200)
}).strict();
export type CodexHookPolicy = z.infer<typeof CodexHookPolicySchema>;
const HookPolicyStoreSchema = z.object({ schemaVersion: z.literal(1), policies: z.array(CodexHookPolicySchema).max(256) }).strict();

export function codexHookPolicyPath(approvalStorePath: string): string {
  return approvalStorePath.replace(/\.json$/, "") + ".policy.json";
}

const ApprovalStoreSchema = z.object({
  schemaVersion: z.literal(1),
  approvals: z.array(CodexHookApprovalSchema).max(256)
}).strict();

export interface CodexHookTrustOptions {
  readonly codexHomeDirectory?: string;
  readonly approvalStorePath?: string;
  /** Trusted selected profile HOME, supplied by Runtime, never repository hook configuration. */
  readonly isolatorHomeDirectory?: string;
  /** Machine-selected native Codex source; only its exact linked hooks.json can reuse its existing policy. */
  readonly sharedNativeCodexHomeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface CodexHookApprovalOptions extends CodexHookTrustOptions {
  readonly expectedDigest: string;
  readonly approvedBy: string;
}

/** Bflow owns its child panes; outer Orca pane selectors must not attach those panes to the parent session. */
export function createManagedCodexHookEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string
): Record<string, string> {
  return {
    HOME: homeDirectory,
    PATH: environment["PATH"] ?? "",
    ORCA_AGENT_HOOK_ROOT: "",
    ORCA_AGENT_HOOK_ENDPOINT: "",
    ORCA_PANE_KEY: "",
    ORCA_AGENT_HOOK_PORT: ""
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function userHomeFor(environment: Readonly<Record<string, string | undefined>>, homeDirectory?: string): string {
  const home = homeDirectory ?? environment["HOME"] ?? homedir();
  if (!isAbsolute(home)) throw new Error("HOME must be an absolute trusted path.");
  return resolve(home);
}

function codexHomeFor(environment: Readonly<Record<string, string | undefined>>, codexHomeDirectory?: string): string {
  const home = codexHomeDirectory ?? environment["CODEX_HOME"] ?? join(userHomeFor(environment), ".codex");
  if (!isAbsolute(home)) throw new Error("CODEX_HOME must be an absolute trusted path.");
  return resolve(home);
}

export function defaultCodexHookApprovalPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  homeDirectory?: string
): string {
  if (environment["XDG_STATE_HOME"] !== undefined && !isAbsolute(environment["XDG_STATE_HOME"]))
    throw new Error("XDG_STATE_HOME must be an absolute trusted path.");
  const state = environment["XDG_STATE_HOME"]
    ? resolve(environment["XDG_STATE_HOME"])
    : join(userHomeFor(environment, homeDirectory), ".local", "state");
  return join(state, "bflow", CODEX_HOOK_APPROVAL_FILE);
}

function pathOptions(options: CodexHookTrustOptions = {}): { home: string; store: string; environment: Readonly<Record<string, string | undefined>> } {
  const environment = options.environment ?? process.env;
  const home = codexHomeFor(environment, options.codexHomeDirectory);
  if (options.approvalStorePath !== undefined && !isAbsolute(options.approvalStorePath))
    throw new Error("Codex hook approval store path must be absolute.");
  const store = resolve(options.approvalStorePath ?? defaultCodexHookApprovalPath(environment));
  const relativeStore = relative(home, store);
  if (relativeStore === "" || (!relativeStore.startsWith(`..${sep}`) && relativeStore !== ".." && !isAbsolute(relativeStore)))
    throw new Error("Codex hook approval store must be outside the provider's Codex home.");
  return { home, store, environment };
}

function notFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function ownedByCurrentUserOrRoot(stat: { uid?: number }): boolean {
  if (typeof process.getuid !== "function") return true;
  const uid = process.getuid();
  return stat.uid === uid || stat.uid === 0;
}

async function readBoundedRegular(path: string, maxBytes: number, privateFile = false, protectedDirectory?: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    const beforePrecise = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    const protectedRelative = protectedDirectory === undefined ? undefined : relative(protectedDirectory, path);
    const protectedFile = protectedDirectory !== undefined && protectedRelative !== undefined &&
      protectedRelative !== "" && protectedRelative !== ".." && !protectedRelative.startsWith(`..${sep}`) &&
      !isAbsolute(protectedRelative) && await isPrivateOwnedDirectory(protectedDirectory);
    if (!ownedByCurrentUserOrRoot(stat) || ((stat.mode & 0o022) !== 0 && !protectedFile))
      throw new Error(`File has unsafe ownership or is group/world writable: ${path}`);
    if (privateFile && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())))
      throw new Error(`Approval state file must be current-user-owned with mode 0600 or stricter: ${path}`);
    if (stat.size > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte inspection limit: ${path}`);
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(Math.min(16 * 1024, maxBytes + 1));
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte inspection limit: ${path}`);
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    const after = await handle.stat({ bigint: true });
    if (after.dev !== beforePrecise.dev || after.ino !== beforePrecise.ino || after.size !== beforePrecise.size || after.mtimeNs !== beforePrecise.mtimeNs || after.ctimeNs !== beforePrecise.ctimeNs)
      throw new Error(`File changed during bounded inspection: ${path}`);
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function inspectPath(path: string, maxBytes: number, hashContent = true, protectedDirectory?: string): Promise<{ readonly exists: boolean; readonly resolvedPath: string | null; readonly sha256: string | null; readonly bytes?: Buffer }> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (notFound(error)) return { exists: false, resolvedPath: null, sha256: null }; throw error; }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Hook source is symlinked or not a regular file: ${path}`);
  const bytes = await readBoundedRegular(path, maxBytes, false, protectedDirectory);
  const after = await lstat(path);
  if (after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
    throw new Error(`Hook source changed during inspection: ${path}`);
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) throw new Error(`Hook source has a symlinked path component: ${path}`);
  return { exists: true, resolvedPath: canonical, sha256: hashContent ? sha256(bytes) : null, bytes };
}

async function executableDependency(path: string, capturePrefix?: (bytes: Buffer) => void, maxBytes = MAX_EXECUTABLE_BYTES): Promise<CodexHookDependency> {
  if (!isAbsolute(path)) throw new Error(`Executable dependency must be absolute: ${path}`);
  const canonical = await realpath(path);
  const before = await lstat(canonical);
  if (!before.isFile() || !ownedByCurrentUserOrRoot(before) || (before.mode & 0o022) !== 0 || (before.mode & 0o111) === 0)
    throw new Error(`Executable dependency is not a safe user-owned regular file: ${path}`);
  if (before.size > maxBytes) throw new Error(`Executable dependency exceeds ${maxBytes} bytes: ${path}`);
  const digest = createHash("sha256");
  let bytes = 0;
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile() || fileStat.dev !== before.dev || fileStat.ino !== before.ino)
      throw new Error(`Executable dependency changed while opening: ${path}`);
    const stream = file.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      if (bytes === 0 && capturePrefix) capturePrefix(Buffer.from(chunk.subarray(0, 4096)));
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`Executable dependency exceeds ${maxBytes} bytes: ${path}`);
      digest.update(chunk);
    }
  } finally { await file.close(); }
  const after = await lstat(canonical);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    throw new Error(`Executable dependency changed during hashing: ${path}`);
  return CodexHookDependencySchema.parse({ requestedPath: path, resolvedPath: canonical, sha256: digest.digest("hex"), exists: true });
}

function resolvePathExecutable(name: string, environment: Readonly<Record<string, string | undefined>>): string | undefined {
  if (isAbsolute(name)) return name;
  const pathValue = environment["PATH"] ?? "";
  for (const directory of pathValue.split(":")) {
    if (!directory || !isAbsolute(directory)) continue;
    // Preserve the same physical symlink/.. traversal as execvp and the shell.
    const candidate = `${directory}/${name}`;
    try { if (requireExecutable(candidate)) return candidate; } catch { /* try next PATH entry */ }
  }
  return undefined;
}

function requireExecutable(path: string): boolean {
  // Read-only mode check is intentionally bounded to a path stat; the file bytes are pinned below.
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o111) === 0) return false;
  accessSync(path, constants.X_OK);
  return true;
}

interface TokenizedCommand { readonly tokens: readonly string[]; readonly error?: string }

/** Tiny shell-word lexer. It preserves literal words but rejects every expansion/control operator. */
function tokenizeLiteralCommand(command: string): TokenizedCommand {
  if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES || /[\0\r\n]/.test(command)) return { tokens: [], error: "command is too large or contains a line break" };
  const tokens: string[] = [];
  let token = "", quote: "'" | '"' | undefined, escaped = false, active = false;
  for (const char of command) {
    if (escaped) {
      // In POSIX double quotes a backslash only escapes $, `, ", or another backslash.
      if (quote === '"' && !/[\$`"\\]/.test(char)) token += "\\";
      token += char; escaped = false; active = true; continue;
    }
    if (quote !== "'" && char === "\\") { escaped = true; active = true; continue; }
    if (quote === undefined && (char === "'" || char === '"')) { quote = char; active = true; continue; }
    if (quote === char) { quote = undefined; active = true; continue; }
    if ((quote === undefined || quote === '"') && /[$`]/.test(char)) return { tokens: [], error: `shell expansion '${char}' is unsupported` };
    if (quote === undefined && !active && (char === "~" || char === "#")) return { tokens: [], error: "shell tilde expansion and comments are unsupported" };
    if (quote === undefined && /[;&|<>*?(){}\[\]]/.test(char)) return { tokens: [], error: `shell metacharacter '${char}' is unsupported` };
    if (quote === undefined && /[ \t]/.test(char)) {
      if (active) { tokens.push(token); token = ""; active = false; }
      continue;
    }
    token += char; active = true;
  }
  if (escaped || quote !== undefined) return { tokens: [], error: "command has an unterminated quote or escape" };
  if (active) tokens.push(token);
  if (tokens.length === 0) return { tokens: [], error: "command is empty" };
  return { tokens };
}

function isOrcaWrapperSource(text: string): boolean {
  return sha256(text) === REVIEWED_ORCA_WRAPPER_SHA256;
}

const ORCA_CONDITIONAL_COMMAND = `: orca-agent-hook-form=1; if [ -n "\${ORCA_PANE_KEY-}" ] && [ -n "\${ORCA_AGENT_HOOK_ROOT-}" ] && [ -f "\${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" ]; then /bin/sh "\${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" || :; elif [ -z "\${ORCA_AGENT_HOOK_ROOT-}" ] && [ -n "\${ORCA_PANE_KEY-}" ] && [ -n "\${ORCA_AGENT_HOOK_PORT-}" ] && [ -f "\${HOME-}/.orca/agent-hooks/codex-hook.sh" ]; then /bin/sh "\${HOME-}/.orca/agent-hooks/codex-hook.sh" || :; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi`;

function configuredOrcaCandidates(environment: Readonly<Record<string, string | undefined>>): string[] {
  const roots = new Set<string>();
  const selected = environment["ORCA_AGENT_HOOK_ROOT"];
  if (selected) roots.add(resolve(selected, "agent-hooks"));
  const home = environment["HOME"] ?? homedir();
  roots.add(resolve(home, ".orca", "agent-hooks"));
  return [...roots].map(root => join(root, "codex-hook.sh"));
}

async function scriptDependency(path: string, maxBytes = MAX_SCRIPT_BYTES): Promise<CodexHookDependency> {
  const inspected = await inspectPath(path, maxBytes);
  return CodexHookDependencySchema.parse({
    requestedPath: path,
    resolvedPath: inspected.resolvedPath,
    sha256: inspected.sha256,
    exists: inspected.exists
  });
}

async function directExecutableDependencies(path: string): Promise<CodexHookDependency[]> {
  let prefix: Buffer = Buffer.alloc(0);
  const executable = await executableDependency(path, bytes => { prefix = bytes; });
  if (prefix[0] !== 35 || prefix[1] !== 33) return [executable];
  const line = prefix.subarray(2).toString("utf8").split("\n", 1)[0]!.trim();
  // An env shebang can select a different program through runtime PATH; inline
  // interpreter flags can execute additional code. Only an absolute interpreter is supported.
  if (!/^\/[A-Za-z0-9_./+-]+$/.test(line) || /\/(?:env)$/.test(line))
    throw new Error("Direct hook shebang must select one absolute interpreter without flags or env lookup");
  if (/\/(?:ba)?sh$/.test(line)) {
    const bytes = await readBoundedRegular(executable.resolvedPath!, MAX_SCRIPT_BYTES);
    if (sha256(bytes) !== executable.sha256) throw new Error("Direct hook script changed during inspection");
    if (/^\s*(?:source\s|\.\s|eval\s)/m.test(bytes.toString("utf8")))
      throw new Error("Direct shell hook has an unsupported source or eval dependency");
  }
  return [executable, await executableDependency(line)];
}

async function dependenciesForCommand(
  command: string,
  candidates: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  unsupportedReasons: string[],
  diagnostics: string[]
): Promise<CodexHookDependency[]> {
  const isOrcaCommand = command.includes("codex-hook.sh") && command.includes("ORCA_AGENT_HOOK_ROOT");
  if (isOrcaCommand && isOrcaConditionalCommand(command)) {
    const dependencies: CodexHookDependency[] = [];
    for (const path of candidates) dependencies.push(await scriptDependency(path));
    const active = environment["ORCA_AGENT_HOOK_ENDPOINT"];
    const selectedRoot = environment["ORCA_AGENT_HOOK_ROOT"];
    if (active) unsupportedReasons.push("ORCA_AGENT_HOOK_ENDPOINT selects a dynamically sourced endpoint script; inspect/approval cannot pin that runtime source safely.");
    else diagnostics.push("Orca endpoint selector ORCA_AGENT_HOOK_ENDPOINT is absent; this absence is part of the snapshot.");
    if (selectedRoot && !isAbsolute(selectedRoot)) unsupportedReasons.push("ORCA_AGENT_HOOK_ROOT must be an absolute path for Orca dependency pinning.");
    for (const dependency of dependencies) {
      if (!dependency.exists) continue;
      const bytes = await readBoundedRegular(dependency.resolvedPath!, MAX_SCRIPT_BYTES);
      if (!isOrcaWrapperSource(bytes.toString("utf8"))) unsupportedReasons.push(`Orca wrapper does not match the bounded reviewed script shape: ${dependency.resolvedPath}`);
    }
    return dependencies;
  }
  const parsed = tokenizeLiteralCommand(command);
  if (parsed.error) { unsupportedReasons.push(`Unsupported hook command: ${parsed.error}.`); return []; }
  const tokens = parsed.tokens;
  if (tokens.length > 16) { unsupportedReasons.push("Hook command exceeds the 16 literal argument limit."); return []; }
  const executableName = tokens[0]?.split("/").at(-1);
  const shellInterpreter = (tokens[0] === "bash" || tokens[0] === "sh" || (tokens[0] !== undefined && isAbsolute(tokens[0]))) &&
    (executableName === "bash" || executableName === "sh");
  const runtimeIndex = tokens[0] && isAbsolute(tokens[0]) && /^(?:bun|node|python(?:3(?:\.[0-9]+)?)?)$/.test(tokens[0].split("/").at(-1) ?? "") ? 0 : -1;
  const supportedInterpreter = shellInterpreter || runtimeIndex === 0;
  const scriptIndex = supportedInterpreter ? 1 : 0;
  const possibleScript = tokens[scriptIndex];
  if (!possibleScript || !isAbsolute(possibleScript)) {
    unsupportedReasons.push("Hook command must identify an absolute executable/script path; inspect the command in the hook inventory.");
    return [];
  }
  if (supportedInterpreter && (tokens.length < 2 || tokens.length > 16)) {
    unsupportedReasons.push("Hook command must be <known-interpreter> <absolute-script> [literal arguments]; inspect the command in the hook inventory.");
    return [];
  }
  if (!supportedInterpreter) {
    try { return await directExecutableDependencies(possibleScript); }
    catch (error) { unsupportedReasons.push(`Cannot pin direct hook executable '${possibleScript}': ${error instanceof Error ? error.message : String(error)}`); return []; }
  }
  const dependencyPaths = new Set<string>([possibleScript]);
  if (dependencyPaths.size > MAX_DEPENDENCIES) {
    unsupportedReasons.push(`Hook dependency count exceeds ${MAX_DEPENDENCIES}.`);
    return [];
  }
  const dependencies: CodexHookDependency[] = [];
  if (supportedInterpreter) {
    const executablePath = resolvePathExecutable(tokens[0]!, environment);
    if (!executablePath) {
      unsupportedReasons.push(`Cannot resolve known hook interpreter '${tokens[0]}' to an absolute executable on the trusted PATH.`);
      return [];
    }
    dependencies.push(await executableDependency(executablePath));
  }
  for (const path of dependencyPaths) dependencies.push(await scriptDependency(path));
  for (const dependency of dependencies) if (!dependency.exists)
    unsupportedReasons.push(`Hook executable/script dependency is absent: ${dependency.requestedPath}`);
  const inspectedScript = await inspectPath(possibleScript, MAX_SCRIPT_BYTES);
  if (inspectedScript.bytes && shellInterpreter) {
    const text = inspectedScript.bytes.toString("utf8");
    const isPinnedOrcaWrapper = candidates.includes(resolve(possibleScript)) && isOrcaWrapperSource(text);
    const sourceLines = text.split(/\r?\n/).map(line => line.trim()).filter(line => /^(?:source\s+(?=["'/$A-Za-z])|\.\s+(?=["'/$A-Za-z]))/.test(line));
    for (const line of sourceLines) {
      const sourceMatch = /^(?:source|\.)\s+(['"]?)(\/[^\s'"]+)\1(?:\s|$)/.exec(line);
      if (!sourceMatch) {
        unsupportedReasons.push(`Hook script contains a dynamic or relative source dependency that cannot be pinned: ${possibleScript}`);
        continue;
      }
      const dependency = await scriptDependency(sourceMatch[2]!);
      dependencies.push(dependency);
      if (!dependency.exists) unsupportedReasons.push(`Hook script source dependency is absent: ${sourceMatch[2]}`);
      if (!isPinnedOrcaWrapper) unsupportedReasons.push(`Hook script sources another executable file outside the recognized Orca endpoint guard; transitive source closure is unsupported: ${sourceMatch[2]}`);
    }
    if (/^\s*eval\s+/m.test(text)) unsupportedReasons.push(`Hook script uses eval-style dynamic execution that cannot be pinned safely: ${possibleScript}`);
  }
  return dependencies;
}

function isOrcaConditionalCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized === ORCA_CONDITIONAL_COMMAND;
}

function extractHooks(raw: unknown, unsupportedReasons: string[]): Array<{ event: string; matcher?: unknown; command: string }> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    unsupportedReasons.push("hooks.json must contain a top-level object."); return [];
  }
  const hooks = (raw as Record<string, unknown>)["hooks"];
  if (hooks === undefined || hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    unsupportedReasons.push("hooks.json must contain a hooks object."); return [];
  }
  const entries: Array<{ event: string; matcher?: unknown; command: string }> = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) { unsupportedReasons.push(`Hook event '${event}' must contain an array.`); continue; }
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group)) { unsupportedReasons.push(`Hook event '${event}' has a malformed group.`); continue; }
      const record = group as Record<string, unknown>;
      const commands = record["hooks"];
      if (!Array.isArray(commands)) { unsupportedReasons.push(`Hook event '${event}' is missing its hooks array.`); continue; }
      for (const item of commands) {
        if (!item || typeof item !== "object" || Array.isArray(item)) { unsupportedReasons.push(`Hook event '${event}' has a malformed command entry.`); continue; }
        const commandRecord = item as Record<string, unknown>;
        if (commandRecord["type"] !== "command" || typeof commandRecord["command"] !== "string") {
          unsupportedReasons.push(`Hook event '${event}' uses an unsupported non-command hook form.`); continue;
        }
        entries.push({ event, ...(record["matcher"] !== undefined ? { matcher: record["matcher"] } : {}), command: commandRecord["command"] });
        if (entries.length > MAX_HOOKS) unsupportedReasons.push(`Hook count exceeds ${MAX_HOOKS}.`);
      }
    }
  }
  return entries.slice(0, MAX_HOOKS);
}

async function isPrivateOwnedDirectory(path: string): Promise<boolean> {
  const info = await lstat(path);
  return info.isDirectory() && !info.isSymbolicLink() &&
    (typeof process.getuid !== "function" || info.uid === process.getuid()) &&
    (info.mode & 0o077) === 0 && await realpath(path) === resolve(path);
}

async function canonicalCodexHome(home: string, isolatorHome?: string): Promise<string> {
  let canonical: string;
  try { canonical = await realpath(home); }
  catch (error) { if (notFound(error)) return resolve(home); throw error; }
  const info = await lstat(canonical);
  let protectedProfile = false;
  if (isolatorHome !== undefined) {
    const selected = resolve(isolatorHome), root = dirname(selected);
    if (resolve(home) !== join(selected, ".codex") || !await isPrivateOwnedDirectory(root))
      throw new Error("Selected Codex profile must remain inside its private user-owned profile root.");
    for (const path of [selected, resolve(home)]) {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== path ||
          (typeof process.getuid === "function" && entry.uid !== process.getuid()))
        throw new Error("Selected Codex profile directories must be canonical and user-owned.");
    }
    protectedProfile = true;
  }
  if (info.isSymbolicLink() || !info.isDirectory() || !ownedByCurrentUserOrRoot(info) ||
      ((info.mode & 0o022) !== 0 && !protectedProfile))
    throw new Error("Codex home must be a user-owned directory that is not group/world writable.");
  return canonical;
}

async function trustedSharedNativeHooks(options: CodexHookTrustOptions, home: string, store: string): Promise<{ sources: CodexHookSource[]; authorityDigest: string } | undefined> {
  if (options.isolatorHomeDirectory === undefined || options.sharedNativeCodexHomeDirectory === undefined) return undefined;
  const link = join(home, "hooks.json");
  let before;
  try { before = await lstat(link); } catch (error) { if (notFound(error)) return undefined; throw error; }
  if (!before.isSymbolicLink()) return undefined;
  const native = await canonicalCodexHome(options.sharedNativeCodexHomeDirectory);
  if (native === home) return undefined;
  const source = join(native, "hooks.json");
  if (await realpath(link) !== source) return undefined;
  const policy = (await readHookPolicyStore(store))?.policies.find(item => item.codexHomeDirectory === native);
  if (!policy) return undefined;
  // Reuse authority over this exact native source, never a trust-all policy for profile-local hooks/plugins.
  const bytes = await readBoundedRegular(source, MAX_SOURCE_BYTES, false, native);
  if ((await lstat(source)).isSymbolicLink() || await realpath(source) !== source || await realpath(link) !== source)
    throw new Error("Shared native hooks changed their canonical source during inspection.");
  const after = await lstat(link);
  if (!after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
    throw new Error("Shared native hook binding changed during inspection.");
  const sourceDigest = sha256(bytes);
  return { authorityDigest: sha256(JSON.stringify({ native, source, policy })), sources: [
    { kind: "hooks_json", path: link, exists: true, sha256: sourceDigest },
    { kind: "hooks_json", path: source, exists: true, sha256: sourceDigest }
  ] };
}

async function ensurePrivateStoreParent(storePath: string, create: boolean): Promise<boolean> {
  const parent = dirname(storePath);
  const components = resolve(parent).split("/").filter(Boolean);
  let current = "/";
  for (let i = 0; i < components.length; i++) {
    current = join(current, components[i]!);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (!notFound(error)) throw error;
      if (!create) return false;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
      stat = await lstat(current);
    }
    const stickyTempAncestor = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUserOrRoot(stat) || ((stat.mode & 0o022) !== 0 && !stickyTempAncestor))
      throw new Error(`Approval state directory is symlinked, foreign-owned or group/world writable: ${current}`);
    if (i === components.length - 1 && ((typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0))
      throw new Error(`Approval state parent must be private user-owned mode 0700: ${current}`);
  }
  return true;
}

async function readApprovalStore(storePath: string): Promise<z.infer<typeof ApprovalStoreSchema> | undefined> {
  if (!await ensurePrivateStoreParent(storePath, false)) return undefined;
  let bytes: Buffer;
  try { bytes = await readBoundedRegular(storePath, 128 * 1024, true); }
  catch (error) { if (notFound(error)) return undefined; throw error; }
  const parsed = ApprovalStoreSchema.safeParse(JSON.parse(bytes.toString("utf8")) as unknown);
  if (!parsed.success) throw new Error(`Codex hook approval store is malformed: ${parsed.error.message}`);
  if (parsed.data.approvals.some(a => a.approvalStorePath !== storePath))
    throw new Error("Codex hook approval store contains a receipt bound to a different store path.");
  return parsed.data;
}

async function writePrivateStore(storePath: string, value: unknown): Promise<void> {
  const parent = dirname(storePath);
  await ensurePrivateStoreParent(storePath, true);
  const tempPath = join(parent, `.${CODEX_HOOK_APPROVAL_FILE}.${randomBytes(8).toString("hex")}.tmp`);
  let renamed = false;
  try {
    const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(tempPath, storePath);
    renamed = true;
    const dir = await open(parent, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { if (!renamed) await unlink(tempPath).catch(() => undefined); }
}

function jsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${label} contains malformed JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Resolve only an unambiguous, local cache installation; never guess the newest version. */
async function pluginInstallationRoot(home: string, id: string, protectedHome = false): Promise<string> {
  const [name, marketplace] = id.split("@");
  const cache = join(home, "plugins", "cache", marketplace!, name!);
  const versions: string[] = [];
  const directory = await opendir(cache);
  let entryCount = 0;
  for await (const entry of directory) {
    if (++entryCount > MAX_DEPENDENCIES) throw new Error("Plugin cache exceeds the bounded entry limit");
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Plugin cache contains an unsupported version entry");
    versions.push(entry.name);
    if (versions.length > 1) throw new Error("Plugin cache has multiple versions; the active version cannot be proven");
  }
  if (versions.length !== 1) throw new Error("Plugin has no installed version");
  const root = join(cache, versions[0]!);
  if (await realpath(root) !== resolve(root)) throw new Error("Plugin installation has a symlinked path component");
  const stat = await lstat(root);
  if (!ownedByCurrentUserOrRoot(stat) || ((stat.mode & 0o022) !== 0 && !protectedHome)) throw new Error("Plugin installation has unsafe ownership or permissions");
  return root;
}

async function pluginHookInputs(home: string, id: string, sources: CodexHookSource[], protectedDirectory?: string): Promise<{ root: string; inputs: unknown[] }> {
  if (protectedDirectory !== undefined && !await isPrivateOwnedDirectory(protectedDirectory))
    throw new Error("Profile plugin inspection requires its private enclosing directory");
  const root = await pluginInstallationRoot(home, id, protectedDirectory !== undefined);
  const manifests = [join(root, "plugin.json"), join(root, ".codex-plugin", "plugin.json"), join(root, ".claude-plugin", "plugin.json")];
  let declaration: unknown;
  let selected = false;
  const trackSource = (source: CodexHookSource): void => {
    if (sources.length >= MAX_DEPENDENCIES) throw new Error("Plugin source count exceeds the inspection limit");
    sources.push(source);
  };
  for (const [index, path] of manifests.entries()) {
    const inspected = await inspectPath(path, MAX_SOURCE_BYTES, true, protectedDirectory);
    trackSource({ kind: "plugin_manifest", path, exists: inspected.exists, sha256: inspected.sha256 });
    if (!inspected.bytes || selected) continue;
    const manifest = jsonObject(inspected.bytes, "Plugin manifest");
    if (index === 0) {
      const extensions = manifest["extensions"];
      const openai = extensions && typeof extensions === "object" && !Array.isArray(extensions)
        ? (extensions as Record<string, unknown>)["com.openai"] : undefined;
      if (!openai || typeof openai !== "object" || Array.isArray(openai)) continue;
      declaration = (openai as Record<string, unknown>)["hooks"];
    } else declaration = manifest["hooks"];
    selected = true;
  }
  if (!selected) throw new Error("Plugin has no supported manifest");
  const inputs: unknown[] = [];
  const append = async (value: unknown, required: boolean): Promise<void> => {
    if (Array.isArray(value)) {
      if (value.length > 16 || value.some(Array.isArray)) throw new Error("Plugin hook declaration array exceeds the supported bounds");
      for (const item of value) await append(item, true);
    } else if (typeof value === "string") {
      if (!value.startsWith("./") || value.includes("\\") || value.includes("\0") || value.slice(2).split("/").some(part => !part || part === "." || part === ".."))
        throw new Error("Plugin hook path must stay inside the plugin installation");
      const path = join(root, value);
      const inspected = await inspectPath(path, MAX_SOURCE_BYTES, true, protectedDirectory);
      trackSource({ kind: "plugin_hooks", path, exists: inspected.exists, sha256: inspected.sha256 });
      if (inspected.bytes) inputs.push(jsonObject(inspected.bytes, "Plugin hooks"));
      else if (required) throw new Error("Declared plugin hook file is absent");
    } else if (value && typeof value === "object") {
      // An explicit empty inline declaration means no hooks, not the fallback hook file.
      // File-backed hooks.json still goes through the strict extractHooks envelope check.
      if (Object.keys(value).length === 0) return;
      inputs.push(value);
    } else throw new Error("Plugin hooks have an unsupported declaration shape");
  };
  await append(declaration === undefined ? "./hooks/hooks.json" : declaration, declaration !== undefined);
  return { root, inputs };
}

async function pluginTreeDigest(root: string, protectedDirectory: string): Promise<string> {
  if (!await isPrivateOwnedDirectory(protectedDirectory)) throw new Error("Shared plugin authority requires a private enclosing directory");
  const digest = createHash("sha256");
  let count = 0, total = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (++count > 1024 || depth > 20) throw new Error("Shared plugin exceeds the bounded tree limit");
    const info = await lstat(path);
    if (info.isSymbolicLink() || !ownedByCurrentUserOrRoot(info) || await realpath(path) !== resolve(path))
      throw new Error("Shared plugin contains an unsafe path");
    const name = relative(root, path);
    if (info.isDirectory()) {
      digest.update(`directory:${name}\0`);
      const entries: string[] = [];
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (entries.length >= 1024) throw new Error("Shared plugin exceeds the bounded tree limit");
        entries.push(entry.name);
      }
      for (const entry of entries.sort()) await visit(join(path, entry), depth + 1);
    } else if (info.isFile()) {
      const bytes = await readBoundedRegular(path, MAX_SCRIPT_BYTES, false, protectedDirectory);
      total += bytes.length;
      if (total > 32 * 1024 * 1024) throw new Error("Shared plugin exceeds the bounded byte limit");
      digest.update(`file:${name}\0`).update(sha256(bytes));
    } else throw new Error("Shared plugin contains a non-regular asset");
  };
  await visit(root, 0);
  return digest.digest("hex");
}

async function trustedNativePluginCopy(options: CodexHookTrustOptions, home: string, id: string): Promise<string | undefined> {
  if (options.isolatorHomeDirectory === undefined || options.sharedNativeCodexHomeDirectory === undefined) return undefined;
  const native = await canonicalCodexHome(options.sharedNativeCodexHomeDirectory);
  let config: Buffer;
  try { config = await readBoundedRegular(join(native, "config.toml"), MAX_SOURCE_BYTES, false, native); }
  catch (error) { if (notFound(error)) return undefined; throw error; }
  if (!parseCodexEnabledPlugins(config.toString("utf8")).includes(id)) return undefined;
  const source = await pluginInstallationRoot(native, id, true);
  const target = await pluginInstallationRoot(home, id, true);
  if (source === target || source.split(sep).at(-1) !== target.split(sep).at(-1)) return undefined;
  const sourceDigest = await pluginTreeDigest(source, native);
  const targetDigest = await pluginTreeDigest(target, dirname(options.isolatorHomeDirectory));
  if (sourceDigest !== targetDigest) return undefined;
  return sha256(JSON.stringify({ source, target, sourceDigest, targetDigest }));
}

async function buildInventory(options: CodexHookTrustOptions = {}): Promise<Omit<CodexHookReview, "status"> & { sharedNativeHooksTrusted: boolean }> {
  const paths = pathOptions(options);
  const home = await canonicalCodexHome(paths.home, options.isolatorHomeDirectory);
  const store = paths.store;
  const sources: CodexHookSource[] = [];
  const hooks: CodexHookInventoryEntry[] = [];
  const diagnostics: string[] = [];
  const unsupportedReasons: string[] = [];
  const candidates = configuredOrcaCandidates(paths.environment);

  const hooksPath = join(home, "hooks.json");
  const sharedNative = await trustedSharedNativeHooks(options, home, store);
  try {
    if (sharedNative) {
      sources.push(...sharedNative.sources);
      diagnostics.push(`Existing native operator policy approves only this exact linked shared native hooks source (authority ${sharedNative.authorityDigest}); profile-local hooks remain independently reviewed.`);
    } else {
      const inspected = await inspectPath(hooksPath, MAX_SOURCE_BYTES);
      sources.push({ kind: "hooks_json", path: resolve(hooksPath), exists: inspected.exists, sha256: inspected.sha256 });
      if (inspected.bytes) {
        let raw: unknown;
        try { raw = JSON.parse(inspected.bytes.toString("utf8")) as unknown; }
        catch { unsupportedReasons.push("hooks.json is malformed JSON."); raw = undefined; }
        if (raw !== undefined) {
          const entries = extractHooks(raw, unsupportedReasons);
          for (const entry of entries) {
            const dependencies = await dependenciesForCommand(entry.command, candidates, paths.environment, unsupportedReasons, diagnostics);
            for (const dependency of dependencies) {
              if (!sources.some(source => source.path === dependency.requestedPath))
                sources.push(CodexHookSourceSchema.parse({ kind: candidates.includes(dependency.requestedPath) ? "orca_candidate" : "script",
                  path: dependency.requestedPath, exists: dependency.exists, sha256: dependency.sha256 }));
            }
            hooks.push(CodexHookInventoryEntrySchema.parse({
              ...entry,
              digest: sha256(JSON.stringify({ event: entry.event, matcher: entry.matcher ?? null, command: entry.command })),
              dependencies
            }));
          }
        }
      }
    }
  } catch (error) {
    unsupportedReasons.push(`Cannot safely inspect ${hooksPath}: ${error instanceof Error ? error.message : String(error)}`);
    sources.push({ kind: "hooks_json", path: resolve(hooksPath), exists: true, sha256: null });
  }

  // config.toml can contain credentials and MCP endpoint tokens. Inspect its bounded
  // bytes only for hook declarations; bind the declaration fact, never the contents.
  const configPath = join(home, "config.toml");
  try {
    const config = await inspectPath(configPath, MAX_SOURCE_BYTES, false);
    const tomlHooks = config.bytes ? parseCodexTomlHooks(config.bytes.toString("utf8")) : {};
    const enabledPlugins = config.bytes ? parseCodexEnabledPlugins(config.bytes.toString("utf8")) : [];
    const hasTomlHooks = Object.keys(tomlHooks).length > 0;
    const tomlDigest = sha256(JSON.stringify({ hooks: tomlHooks, enabledPlugins }));
    sources.push({ kind: "config_toml", path: resolve(configPath), exists: config.exists, sha256: tomlDigest });
    diagnostics.push(hasTomlHooks ? "Codex executable TOML hook declarations are included in this snapshot." : "Codex executable TOML hook declarations are absent; native hooks.state metadata is excluded.");
    const entries = extractHooks({ hooks: tomlHooks }, unsupportedReasons);
    const pluginOrigins = new Map<(typeof entries)[number], string>();
    const disabledPlugins = new Set(managedCodexDisabledPlugins(enabledPlugins));
    for (const id of enabledPlugins) {
      if (disabledPlugins.has(id)) {
        diagnostics.push(`Plugin ${id} is disabled only in Bflow-managed Codex processes (${managedCodexPluginArgs().join(" ")}); its hooks are excluded from this snapshot.`);
        continue;
      }
      try {
        const nativeCopy = sharedNative ? await trustedNativePluginCopy(options, home, id) : undefined;
        if (nativeCopy) {
          diagnostics.push(`Existing native operator policy approves unchanged shared native plugin ${id} (content binding ${nativeCopy}); modified profile copies require their own approval.`);
          continue;
        }
        const { inputs } = await pluginHookInputs(home, id, sources,
          options.isolatorHomeDirectory === undefined ? undefined : dirname(options.isolatorHomeDirectory));
        for (const input of inputs) {
          const pluginEntries = extractHooks(input, unsupportedReasons);
          for (const entry of pluginEntries) { pluginOrigins.set(entry, id); }
          entries.push(...pluginEntries);
          if (entries.length > MAX_HOOKS) throw new Error("Combined hook count exceeds the inspection limit");
        }
        diagnostics.push(`Enabled plugin ${id} hook sources are included in the snapshot.`);
      } catch (error) {
        unsupportedReasons.push(`Cannot inspect enabled plugin ${id}: ${error instanceof Error ? error.message : "inspection failed"}`);
      }
    }
    for (const entry of entries) {
      const previousReasons = unsupportedReasons.length;
      const dependencies = await dependenciesForCommand(entry.command, candidates, paths.environment, unsupportedReasons, diagnostics);
      const origin = pluginOrigins.get(entry);
      if (origin) for (let index = previousReasons; index < unsupportedReasons.length; index++)
        unsupportedReasons[index] = `Plugin ${origin}, event ${entry.event}: ${unsupportedReasons[index]}`;
      for (const dependency of dependencies) if (!sources.some(source => source.path === dependency.requestedPath))
        sources.push(CodexHookSourceSchema.parse({ kind: candidates.includes(dependency.requestedPath) ? "orca_candidate" : "script",
          path: dependency.requestedPath, exists: dependency.exists, sha256: dependency.sha256 }));
      hooks.push(CodexHookInventoryEntrySchema.parse({
        ...entry, digest: sha256(JSON.stringify({ event: entry.event, matcher: entry.matcher ?? null, command: entry.command })), dependencies
      }));
    }
  } catch (error) {
    unsupportedReasons.push(`Cannot safely inspect Codex hook declarations in config.toml: ${error instanceof Error ? error.message : String(error)}`);
    sources.push({ kind: "config_toml", path: resolve(configPath), exists: true, sha256: null });
  }
  if (sources.length > MAX_DEPENDENCIES) unsupportedReasons.push(`Hook inventory exceeds ${MAX_DEPENDENCIES} source/dependency entries.`);
  const selectorState = { orcaAgentHookEndpointPresent: Boolean(paths.environment["ORCA_AGENT_HOOK_ENDPOINT"]),
    orcaAgentHookRoot: paths.environment["ORCA_AGENT_HOOK_ROOT"] ?? null,
    home: paths.environment["HOME"] ?? null };
  const uniqueDiagnostics = [...new Set(diagnostics)];
  const uniqueReasons = [...new Set(unsupportedReasons)];
  const digest = sha256(JSON.stringify({ schemaVersion: 1, codexHomeDirectory: home, approvalStorePath: store, selectorState, sources, hooks, diagnostics: uniqueDiagnostics, unsupportedReasons: uniqueReasons }));
  return { schemaVersion: 1, codexHomeDirectory: home, approvalStorePath: store, digest, sources, hooks, diagnostics: uniqueDiagnostics, unsupportedReasons: uniqueReasons,
    sharedNativeHooksTrusted: sharedNative !== undefined };
}

async function policyHome(home: string, store: string): Promise<string> {
  // All-hook trust is an operator decision even when source permissions are lax.
  // Bind the actual selected directory, without treating its contents as verified.
  let canonical: string;
  try { canonical = await realpath(home); }
  catch (error) { if (notFound(error)) return resolve(home); throw error; }
  if (!(await lstat(canonical)).isDirectory()) throw new Error("Codex hook policy home must be a directory.");
  const location = relative(canonical, store);
  if (location === "" || (location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location)))
    throw new Error("Codex hook policy store must be outside the resolved provider home.");
  return canonical;
}

async function readHookPolicyStore(approvalStorePath: string): Promise<z.infer<typeof HookPolicyStoreSchema> | undefined> {
  const path = codexHookPolicyPath(approvalStorePath);
  try { await lstat(path); } catch (error) { if (notFound(error)) return undefined; throw error; }
  if (!await ensurePrivateStoreParent(path, false)) return undefined;
  let bytes: Buffer;
  try { bytes = await readBoundedRegular(path, 128 * 1024, true); }
  catch (error) { if (notFound(error)) return undefined; throw error; }
  const corrupt = (detail: string): Error => new Error(`Codex hook policy store ${path} is invalid (${detail}); preserve and inspect it, then remove it manually to reset all-hook trust.`);
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw corrupt("malformed JSON"); }
  const parsed = HookPolicyStoreSchema.safeParse(raw);
  if (!parsed.success) throw corrupt(`schema mismatch: ${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ").slice(0, 300)}`);
  if (parsed.data.policies.some(policy => policy.approvalStorePath !== approvalStorePath))
    throw corrupt("bound to a different approval store");
  return parsed.data;
}

async function laxTrustAllWarnings(home: string): Promise<string[]> {
  const warnings: string[] = [];
  for (const [name, path] of [["Codex home", home], ["hooks.json", join(home, "hooks.json")], ["config.toml", join(home, "config.toml")]] as const) {
    let info;
    // Best effort only: trust_all deliberately does not block on these facts.
    try { info = await lstat(path); if (info.isSymbolicLink()) info = await stat(path); } catch { continue; }
    if (!ownedByCurrentUserOrRoot(info) || (info.mode & 0o022) !== 0)
      warnings.push(`Warning: ${name} is group/world-writable or not owned by the current user; under trust_all another local account could install hooks that run as you.`);
  }
  return warnings;
}

async function withHookPolicyLock<T>(store: string, update: () => Promise<T>): Promise<T> {
  const path = codexHookPolicyPath(store) + ".lock";
  await ensurePrivateStoreParent(path, true);
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid()))
      throw new Error("Hook policy lock must be a private current-user-owned regular file.");
    // Linux flock follows the inherited open-file description: the parent holds
    // fd 3's lock through the complete read/modify/write, including child exit.
    await new Promise<void>((accept, reject) => {
      const child = spawn("flock", ["--exclusive", "--timeout", "5", "3"], { stdio: ["ignore", "ignore", "ignore", file.fd] });
      child.once("error", error => reject(notFound(error)
        ? new Error("Hook policy updates require the util-linux 'flock' command (Linux); install it and retry.") : error));
      child.once("exit", code => code === 0 ? accept() : reject(new Error("Another hook policy update is busy; retry the setup action.")));
    });
    return await update();
  } finally { await file.close(); }
}

/** Trust current/future global hooks for this exact Codex home; never executes or edits them. */
export async function trustAllCodexHooks(options: CodexHookTrustOptions & { readonly approvedBy: string }): Promise<CodexHookPolicy> {
  const paths = pathOptions(options), home = await policyHome(paths.home, paths.store);
  return withHookPolicyLock(paths.store, async () => {
    const previous = await readHookPolicyStore(paths.store);
    const existing = previous?.policies.find(item => item.codexHomeDirectory === home);
    if (existing) return existing;
    const policy = CodexHookPolicySchema.parse({ schemaVersion: 1, policy: "trust_all", codexHomeDirectory: home,
      approvalStorePath: paths.store, approvedAt: new Date().toISOString(), approvedBy: options.approvedBy });
    const policies = [...(previous?.policies ?? []).filter(item => item.codexHomeDirectory !== home), policy];
    await writePrivateStore(codexHookPolicyPath(paths.store), HookPolicyStoreSchema.parse({ schemaVersion: 1, policies }));
    return policy;
  });
}

export async function revokeAllCodexHookTrust(options: CodexHookTrustOptions = {}): Promise<void> {
  const paths = pathOptions(options), home = await policyHome(paths.home, paths.store);
  await withHookPolicyLock(paths.store, async () => {
    const previous = await readHookPolicyStore(paths.store);
    if (!previous || !previous.policies.some(policy => policy.codexHomeDirectory === home)) return;
    await writePrivateStore(codexHookPolicyPath(paths.store), HookPolicyStoreSchema.parse({ schemaVersion: 1,
      policies: previous.policies.filter(policy => policy.codexHomeDirectory !== home) }));
  });
}

export async function inspectCodexHooks(options: CodexHookTrustOptions = {}): Promise<CodexHookReview> {
  try {
    const paths = pathOptions(options), home = await policyHome(paths.home, paths.store);
    const policies = await readHookPolicyStore(paths.store);
    const policy = policies?.policies.find(item => item.codexHomeDirectory === home);
    // Diagnostics are advisory and intentionally excluded from the policy digest.
    if (policy) return CodexHookReviewSchema.parse({ schemaVersion: 1, codexHomeDirectory: home, approvalStorePath: paths.store,
      digest: sha256(JSON.stringify(policy)), status: "approved", approvalMode: "trust_all", sources: [], hooks: [], unsupportedReasons: [],
      diagnostics: ["Operator policy trusts all current and future Codex global hooks; source inspection is skipped.", ...await laxTrustAllWarnings(home)] });
    const { sharedNativeHooksTrusted, ...inventory } = await buildInventory(options);
    if (inventory.unsupportedReasons.length === 0 && inventory.hooks.length === 0)
      return CodexHookReviewSchema.parse({ ...inventory, status: sharedNativeHooksTrusted ? "approved" : "none" });
    const store = await readApprovalStore(inventory.approvalStorePath);
    const approved = store?.approvals.some(item => item.digest === inventory.digest && item.codexHomeDirectory === inventory.codexHomeDirectory) ?? false;
    const status: CodexHookReview["status"] = inventory.unsupportedReasons.length > 0
      ? "unsupported"
      : inventory.hooks.length === 0
        ? "none"
        : approved ? "approved" : "approval_required";
    return CodexHookReviewSchema.parse({ ...inventory, status });
  } catch (error) {
    const paths = pathOptions(options);
    const message = error instanceof Error ? error.message : String(error);
    const digest = sha256(JSON.stringify({ home: paths.home, store: paths.store, error: message }));
    return CodexHookReviewSchema.parse({ schemaVersion: 1, codexHomeDirectory: paths.home, approvalStorePath: paths.store,
      digest, status: "unsupported", sources: [], hooks: [], diagnostics: [], unsupportedReasons: [message] });
  }
}

export async function approveCodexHooks(reviewInput: CodexHookReview, options: CodexHookApprovalOptions): Promise<CodexHookApproval> {
  const review = CodexHookReviewSchema.parse(reviewInput);
  if (!SHA256.safeParse(options.expectedDigest).success || options.expectedDigest !== review.digest)
    throw new Error("Reviewed Codex hook digest does not match the expected digest.");
  if (review.status === "unsupported") throw new Error(`Unsupported Codex hooks cannot be approved: ${review.unsupportedReasons.join("; ")}`);
  if (review.hooks.length === 0) throw new Error("There are no Codex hooks to approve.");
  const paths = pathOptions(options);
  const home = await canonicalCodexHome(paths.home);
  if (home !== review.codexHomeDirectory || paths.store !== review.approvalStorePath)
    throw new Error("Codex hook approval home or store path changed after review.");
  const current = await inspectCodexHooks(options);
  if (current.digest !== options.expectedDigest || current.status === "unsupported")
    throw new Error("Codex hook configuration changed after review; inspect and approve the new digest.");
  const previous = await readApprovalStore(paths.store);
  const approval = CodexHookApprovalSchema.parse({ schemaVersion: 1, codexHomeDirectory: home, approvalStorePath: paths.store,
    digest: current.digest, approvedAt: new Date().toISOString(), approvedBy: options.approvedBy });
  const approvals = [...(previous?.approvals ?? []).filter(item => item.digest !== approval.digest), approval];
  await writePrivateStore(paths.store, ApprovalStoreSchema.parse({ schemaVersion: 1, approvals }));
  return approval;
}
