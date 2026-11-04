import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveGitExcludePath } from "./git-exclude.js";
import { BFLOW_START_SKILL_VERSION, renderBflowStartSkill, shellQuoteArgv } from "./director-skill.js";

export type DirectorProvider = "claude" | "codex" | "agy";
export interface DirectorRepoFilesInput {
  readonly repositoryRoot: string;
  readonly bflowCommand: readonly string[];
  readonly providers: readonly DirectorProvider[];
  /** When true the skill files are meant to be committed: no managed git exclude block. */
  readonly commitSkills?: boolean;
}
export type DirectorRepoFileStatus = "missing" | "current" | "modified";
export interface DirectorRepoFileCheck {
  readonly path: string;
  readonly status: DirectorRepoFileStatus;
}

type UnitKind = "file" | "json-key" | "toml-block" | "exclude-block" | "gitignore-block";
interface Expectation {
  readonly kind: UnitKind;
  readonly key?: string;
  readonly sha256: string;
}
interface ReceiptUnit extends Expectation {
  readonly path: string;
}

const RECEIPT_PATH = ".bflow/director-files.json";
/** Legacy (pre-exclude) location of the managed block; only read to migrate/remove it. */
const GITIGNORE_PATH = ".gitignore";
/**
 * Logical, repository-stable name recorded in the receipt for the Git exclude file. The real file is
 * `<git-common-dir>/info/exclude` (shared by linked worktrees) and is resolved at run time, so no
 * absolute path is persisted.
 */
const EXCLUDE_LOGICAL_PATH = ".git/info/exclude";
const START = "# >>> bflow director >>>";
const END = "# <<< bflow director <<<";
const ALL_PROVIDERS: readonly DirectorProvider[] = ["claude", "codex", "agy"];
const CLAUDE_SKILL = ".claude/skills/bflow-start/SKILL.md";
const AGENTS_SKILL = ".agents/skills/bflow-start/SKILL.md";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalProviders(providers: readonly DirectorProvider[]): DirectorProvider[] {
  return ALL_PROVIDERS.filter(p => providers.includes(p));
}

/** Repository-relative files (excluding the git exclude file and the receipt) written for the providers, sorted. */
export function directorRepoFilePaths(providers: readonly DirectorProvider[]): string[] {
  const paths = new Set<string>();
  for (const provider of canonicalProviders(providers)) {
    if (provider === "claude") {
      paths.add(CLAUDE_SKILL);
      paths.add(".mcp.json");
      paths.add(".claude/settings.local.json");
    } else if (provider === "codex") {
      paths.add(AGENTS_SKILL);
      paths.add(".codex/config.toml");
      paths.add(".codex/hooks.json");
    } else {
      paths.add(AGENTS_SKILL);
    }
  }
  return [...paths].sort();
}

// ---------- block helpers ----------

interface BlockMatch {
  readonly start: number;
  readonly end: number;
  readonly inner: string;
}

class MalformedBlockError extends Error {}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/** Returns the single valid block, null when there is no marker at all; throws MalformedBlockError otherwise. */
function findBlock(text: string): BlockMatch | null {
  const starts = countOccurrences(text, START);
  const ends = countOccurrences(text, END);
  if (starts === 0 && ends === 0) return null;
  if (starts !== 1 || ends !== 1) throw new MalformedBlockError();
  const start = text.indexOf(START);
  const endMarker = text.indexOf(END);
  if (endMarker < start + START.length) throw new MalformedBlockError();
  let innerStart = start + START.length;
  if (text[innerStart] === "\n") innerStart += 1;
  let inner = text.slice(innerStart, endMarker);
  if (inner.endsWith("\n")) inner = inner.slice(0, -1);
  let end = endMarker + END.length;
  if (text[end] === "\n") end += 1;
  return { start, end, inner };
}

function upsertBlock(text: string | null, inner: string): string {
  const block = `${START}\n${inner}\n${END}\n`;
  const existing = text ?? "";
  const found = findBlock(existing);
  if (found) return existing.slice(0, found.start) + block + existing.slice(found.end);
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  return existing + separator + block;
}

function removeBlock(text: string): string {
  const found = findBlock(text);
  if (!found) return text;
  return text.slice(0, found.start) + text.slice(found.end);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------- JSON unit definitions ----------

interface JsonUnitDef {
  readonly key: string;
  readonly expected: unknown;
  read(obj: JsonRecord): unknown;
  write(obj: JsonRecord, path: string): void;
  remove(obj: JsonRecord): void;
}

function structureError(path: string): Error {
  return new Error(`Cannot merge ${path}: unexpected structure`);
}

function childRecord(parent: JsonRecord, key: string, path: string): JsonRecord {
  const existing = parent[key];
  if (existing === undefined) {
    const created: JsonRecord = {};
    parent[key] = created;
    return created;
  }
  if (!isRecord(existing)) throw structureError(path);
  return existing;
}

function mcpServerDef(bflowCommand: readonly string[]): JsonUnitDef {
  const expected = { command: bflowCommand[0], args: [...bflowCommand.slice(1), "director", "mcp"] };
  return {
    key: "mcpServers.bflow",
    expected,
    read: obj => (isRecord(obj.mcpServers) ? obj.mcpServers.bflow : undefined),
    write: (obj, path) => {
      childRecord(obj, "mcpServers", path).bflow = expected;
    },
    remove: obj => {
      if (!isRecord(obj.mcpServers)) return;
      delete obj.mcpServers.bflow;
      if (Object.keys(obj.mcpServers).length === 0) delete obj.mcpServers;
    },
  };
}

function enabledServerDef(): JsonUnitDef {
  return {
    key: "enabledMcpjsonServers[bflow]",
    expected: "bflow",
    read: obj => (Array.isArray(obj.enabledMcpjsonServers) && obj.enabledMcpjsonServers.includes("bflow") ? "bflow" : undefined),
    write: (obj, path) => {
      const current = obj.enabledMcpjsonServers;
      if (current === undefined) {
        obj.enabledMcpjsonServers = ["bflow"];
      } else if (!Array.isArray(current)) {
        throw structureError(path);
      } else if (!current.includes("bflow")) {
        current.push("bflow");
      }
    },
    remove: obj => {
      if (!Array.isArray(obj.enabledMcpjsonServers)) return;
      const rest = obj.enabledMcpjsonServers.filter(item => item !== "bflow");
      if (rest.length === 0) delete obj.enabledMcpjsonServers;
      else obj.enabledMcpjsonServers = rest;
    },
  };
}

function isBflowHookEntry(entry: unknown, provider: "claude" | "codex"): boolean {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) return false;
  const suffix = ` director hook ${provider}`;
  return entry.hooks.some(h => isRecord(h) && typeof h.command === "string" && h.command.endsWith(suffix));
}

function hookDef(bflowCommand: readonly string[], provider: "claude" | "codex"): JsonUnitDef {
  const expected = { hooks: [{ type: "command", command: `${shellQuoteArgv(bflowCommand)} director hook ${provider}` }] };
  const list = (obj: JsonRecord): unknown[] | undefined =>
    isRecord(obj.hooks) && Array.isArray(obj.hooks.UserPromptSubmit) ? obj.hooks.UserPromptSubmit : undefined;
  return {
    key: "hooks.UserPromptSubmit[bflow]",
    expected,
    read: obj => list(obj)?.find(entry => isBflowHookEntry(entry, provider)),
    write: (obj, path) => {
      const hooks = childRecord(obj, "hooks", path);
      const existing = hooks.UserPromptSubmit;
      if (existing !== undefined && !Array.isArray(existing)) throw structureError(path);
      const entries: unknown[] = existing ?? [];
      const next: unknown[] = [];
      let placed = false;
      for (const entry of entries) {
        if (isBflowHookEntry(entry, provider)) {
          if (!placed) next.push(expected);
          placed = true;
        } else {
          next.push(entry);
        }
      }
      if (!placed) next.push(expected);
      hooks.UserPromptSubmit = next;
    },
    remove: obj => {
      const entries = list(obj);
      if (!entries || !isRecord(obj.hooks)) return;
      const rest = entries.filter(entry => !isBflowHookEntry(entry, provider));
      if (rest.length === 0) delete obj.hooks.UserPromptSubmit;
      else obj.hooks.UserPromptSubmit = rest;
      if (Object.keys(obj.hooks).length === 0) delete obj.hooks;
    },
  };
}

// ---------- file specs ----------

interface FileSpec {
  readonly path: string;
  readonly expected: readonly Expectation[];
  /** Hash of each Bflow-owned unit currently present (undefined when absent). Throws on invalid JSON. */
  current(text: string | null): (string | undefined)[];
  /** New file text with the Bflow units written. Throws on invalid JSON. */
  merge(text: string | null): string;
  /** New file text with flagged units removed; null means delete the file. */
  remove(text: string, flags: readonly boolean[]): string | null;
}

function fileSpec(path: string, content: string): FileSpec {
  return {
    path,
    expected: [{ kind: "file", sha256: sha256(content) }],
    current: text => [text === null ? undefined : sha256(text)],
    merge: () => content,
    remove: () => null,
  };
}

function guardBlock<T>(path: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof MalformedBlockError) throw new Error(`Cannot merge ${path}: malformed bflow director block`);
    throw error;
  }
}

function blockSpec(path: string, kind: "toml-block" | "exclude-block" | "gitignore-block", inner: string): FileSpec {
  return {
    path,
    expected: [{ kind, sha256: sha256(inner) }],
    current: text =>
      guardBlock(path, () => {
        const found = text === null ? null : findBlock(text);
        return [found ? sha256(found.inner) : undefined];
      }),
    merge: text => guardBlock(path, () => upsertBlock(text, inner)),
    remove: (text, flags) => {
      if (!flags[0]) return text;
      const rest = guardBlock(path, () => removeBlock(text));
      return rest.trim() === "" ? null : rest;
    },
  };
}

function parseJsonObject(path: string, text: string | null): JsonRecord {
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Cannot merge ${path}: invalid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`Cannot merge ${path}: invalid JSON`);
  return parsed;
}

function jsonSpec(path: string, defs: readonly JsonUnitDef[]): FileSpec {
  return {
    path,
    expected: defs.map(def => ({ kind: "json-key" as const, key: def.key, sha256: sha256(JSON.stringify(def.expected)) })),
    current: text => {
      if (text === null) return defs.map(() => undefined);
      const obj = parseJsonObject(path, text);
      return defs.map(def => {
        const value = def.read(obj);
        return value === undefined ? undefined : sha256(JSON.stringify(value));
      });
    },
    merge: text => {
      const obj = parseJsonObject(path, text);
      for (const def of defs) def.write(obj, path);
      return `${JSON.stringify(obj, null, 2)}\n`;
    },
    remove: (text, flags) => {
      const obj = parseJsonObject(path, text);
      defs.forEach((def, i) => {
        if (flags[i]) def.remove(obj);
      });
      return Object.keys(obj).length === 0 ? null : `${JSON.stringify(obj, null, 2)}\n`;
    },
  };
}

function buildSpecs(providers: readonly DirectorProvider[], bflowCommand: readonly string[], commitSkills = false): FileSpec[] {
  const selected = canonicalProviders(providers);
  const specs: FileSpec[] = [];
  const skill = renderBflowStartSkill({ bflowCommand });
  const mcpArgs = [...bflowCommand.slice(1), "director", "mcp"].map(tomlString).join(", ");
  if (selected.includes("claude")) {
    specs.push(fileSpec(CLAUDE_SKILL, skill));
    specs.push(jsonSpec(".mcp.json", [mcpServerDef(bflowCommand)]));
    specs.push(jsonSpec(".claude/settings.local.json", [enabledServerDef(), hookDef(bflowCommand, "claude")]));
  }
  if (selected.includes("codex") || selected.includes("agy")) specs.push(fileSpec(AGENTS_SKILL, skill));
  if (selected.includes("codex")) {
    specs.push(
      blockSpec(
        ".codex/config.toml",
        "toml-block",
        [
          "[mcp_servers.bflow]",
          `command = ${tomlString(bflowCommand[0]!)}`,
          `args = [${mcpArgs}]`,
          'default_tools_approval_mode = "approve"',
          "tool_timeout_sec = 330",
        ].join("\n"),
      ),
    );
    specs.push(jsonSpec(".codex/hooks.json", [hookDef(bflowCommand, "codex")]));
  }
  const ignored = [...directorRepoFilePaths(selected), RECEIPT_PATH].sort();
  if (!commitSkills) specs.push(blockSpec(EXCLUDE_LOGICAL_PATH, "exclude-block", ignored.join("\n")));
  return specs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------- filesystem ----------

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
}

/** Maps a receipt/spec path to a filesystem path; the logical exclude path resolves through Git. */
type Locator = (rel: string) => string;

async function makeLocator(root: string): Promise<Locator> {
  let exclude: string | undefined;
  let failure: unknown;
  try {
    exclude = await resolveGitExcludePath(root);
  } catch (error) {
    failure = error;
  }
  return rel => {
    if (rel !== EXCLUDE_LOGICAL_PATH) return join(root, rel);
    if (exclude === undefined) throw failure instanceof Error ? failure : new Error("Cannot resolve the Git exclude file.");
    return exclude;
  };
}

/** Throws if any existing component of `rel` below `root` is a symlink (the exclude file: the file itself). */
async function assertNoSymlink(root: string, rel: string, locate: Locator): Promise<void> {
  if (rel === EXCLUDE_LOGICAL_PATH) {
    const full = locate(rel);
    try {
      if ((await lstat(full)).isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${full}`);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return;
      throw error;
    }
    return;
  }
  let current = root;
  for (const part of rel.split("/")) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${current}`);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return;
      throw error;
    }
  }
}

async function readIfExists(locate: Locator, rel: string): Promise<string | null> {
  try {
    return await readFile(locate(rel), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
    throw error;
  }
}

async function writeText(locate: Locator, rel: string, text: string, mode?: number): Promise<void> {
  const full = locate(rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, text, mode === undefined ? "utf8" : { encoding: "utf8", mode });
}

/** Every spec Bflow may ever have written (all providers plus the legacy `.gitignore` block), keyed by path. */
function allKnownSpecs(): Map<string, FileSpec> {
  const map = new Map(buildSpecs(ALL_PROVIDERS, ["/bflow"]).map(spec => [spec.path, spec]));
  map.set(GITIGNORE_PATH, blockSpec(GITIGNORE_PATH, "gitignore-block", ""));
  return map;
}

// ---------- public API ----------

export async function applyDirectorRepoFiles(input: DirectorRepoFilesInput): Promise<{ written: string[] }> {
  const { repositoryRoot: root } = input;
  const specs = buildSpecs(input.providers, input.bflowCommand, input.commitSkills === true);
  const locate = await makeLocator(root);

  // Plan phase: check every path and compute every new text before the first write.
  await assertNoSymlink(root, RECEIPT_PATH, locate);
  const pending: { path: string; text: string }[] = [];
  for (const spec of specs) {
    await assertNoSymlink(root, spec.path, locate);
    const existing = await readIfExists(locate, spec.path);
    const next = spec.merge(existing);
    if (next !== existing) pending.push({ path: spec.path, text: next });
  }
  const units: ReceiptUnit[] = specs
    .flatMap(spec => spec.expected.map(unit => ({ path: spec.path, ...unit })))
    .sort((a, b) => (a.path === b.path ? (a.key ?? "").localeCompare(b.key ?? "") : a.path < b.path ? -1 : 1));
  const receipt = `${JSON.stringify(
    { schemaVersion: 1, skillVersion: BFLOW_START_SKILL_VERSION, providers: canonicalProviders(input.providers), units },
    null,
    2,
  )}\n`;
  const previousText = await readIfExists(locate, RECEIPT_PATH);
  const unitId = (u: ReceiptUnit): string => `${u.path}\0${u.kind}\0${u.key ?? ""}`;
  const newIds = new Set(units.map(unitId));
  const specPaths = new Set(specs.map(spec => spec.path));
  const orphans: { path: string; text: string | null }[] = [];
  const finalReceipt = receipt;
  if (previousText !== null) {
    let previous: ReceiptUnit[] = [];
    try {
      previous = parseReceipt(previousText);
    } catch {
      previous = [];
    }
    const dropped = previous.filter(u => !newIds.has(unitId(u)) && !specPaths.has(u.path));
    const allSpecs = allKnownSpecs();
    for (const path of [...new Set(dropped.map(u => u.path))]) {
      const spec = allSpecs.get(path);
      const pathUnits = dropped.filter(u => u.path === path);
      if (!spec) continue;
      await assertNoSymlink(root, path, locate);
      const text = await readIfExists(locate, path);
      if (text === null) continue;
      let current: (string | undefined)[];
      try {
        current = spec.current(text);
      } catch {
        continue;
      }
      const flags = spec.expected.map((expected, i) => {
        const unit = pathUnits.find(u => u.kind === expected.kind && u.key === expected.key);
        return unit !== undefined && current[i] !== undefined && current[i] === unit.sha256;
      });
      if (flags.some(Boolean)) orphans.push({ path, text: spec.remove(text, flags) });
    }
  }
  const receiptChanged = (await readIfExists(locate, RECEIPT_PATH)) !== finalReceipt;

  for (const item of pending) await writeText(locate, item.path, item.text);
  for (const item of orphans) {
    if (item.text === null) await unlink(locate(item.path));
    else await writeText(locate, item.path, item.text);
  }
  if (orphans.length > 0) {
    for (const dir of [".claude/skills/bflow-start", ".agents/skills/bflow-start", ".codex", ".claude"]) {
      await rmdir(join(root, dir)).catch(() => undefined);
    }
  }
  if (receiptChanged) await writeText(locate, RECEIPT_PATH, finalReceipt, 0o644);
  return { written: [...pending.map(item => item.path), ...orphans.map(item => item.path)].sort() };
}

export async function checkDirectorRepoFiles(input: DirectorRepoFilesInput): Promise<DirectorRepoFileCheck[]> {
  const specs = buildSpecs(input.providers, input.bflowCommand, input.commitSkills === true);
  const results: DirectorRepoFileCheck[] = [];
  const locate = await makeLocator(input.repositoryRoot);
  for (const spec of specs) {
    let text: string | null;
    try {
      text = await readIfExists(locate, spec.path);
    } catch (error) {
      if (spec.path !== EXCLUDE_LOGICAL_PATH) throw error;
      results.push({ path: spec.path, status: "missing" });
      continue;
    }
    let current: (string | undefined)[];
    try {
      current = spec.current(text);
    } catch {
      results.push({ path: spec.path, status: "modified" });
      continue;
    }
    let status: DirectorRepoFileStatus = "current";
    if (current.some(hash => hash === undefined)) status = "missing";
    else if (current.some((hash, i) => hash !== spec.expected[i]!.sha256)) status = "modified";
    results.push({ path: spec.path, status });
  }
  return results;
}

function parseReceipt(text: string): ReceiptUnit[] {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.units)) throw new Error(`Invalid receipt: ${RECEIPT_PATH}`);
  const units: ReceiptUnit[] = [];
  for (const unit of parsed.units) {
    if (!isRecord(unit) || typeof unit.path !== "string" || typeof unit.sha256 !== "string" || typeof unit.kind !== "string") {
      throw new Error(`Invalid receipt: ${RECEIPT_PATH}`);
    }
    units.push({
      path: unit.path,
      kind: unit.kind as UnitKind,
      sha256: unit.sha256,
      ...(typeof unit.key === "string" ? { key: unit.key } : {}),
    });
  }
  return units;
}

export async function removeDirectorRepoFiles(repositoryRoot: string): Promise<{ removed: string[]; kept: string[] }> {
  const root = repositoryRoot;
  const locate = await makeLocator(root);
  await assertNoSymlink(root, RECEIPT_PATH, locate);
  const receiptText = await readIfExists(locate, RECEIPT_PATH);
  if (receiptText === null) return { removed: [], kept: [] };
  const units = parseReceipt(receiptText);

  // Structure only; the command value is irrelevant for locating Bflow-owned units.
  const specs = allKnownSpecs();
  const removed = new Set<string>();
  const kept = new Set<string>();
  const plans: { path: string; text: string | null }[] = [];

  for (const path of [...new Set(units.map(u => u.path))]) {
    const spec = specs.get(path);
    if (!spec) {
      kept.add(path);
      continue;
    }
    await assertNoSymlink(root, path, locate);
    const text = await readIfExists(locate, path);
    if (text === null) continue;
    let current: (string | undefined)[];
    try {
      current = spec.current(text);
    } catch {
      kept.add(path);
      continue;
    }
    const flags = spec.expected.map((expected, i) => {
      const receiptUnit = units.find(u => u.path === path && u.kind === expected.kind && u.key === expected.key);
      if (!receiptUnit || current[i] === undefined) return false;
      if (current[i] === receiptUnit.sha256) return true;
      kept.add(path);
      return false;
    });
    if (flags.some(Boolean)) {
      plans.push({ path, text: spec.remove(text, flags) });
      removed.add(path);
    }
  }

  for (const plan of plans) {
    if (plan.text === null) await unlink(locate(plan.path));
    else await writeText(locate, plan.path, plan.text);
  }
  await unlink(join(root, RECEIPT_PATH)).catch(() => undefined);
  for (const dir of [".claude/skills/bflow-start", ".agents/skills/bflow-start", ".bflow"]) {
    await rmdir(join(root, dir)).catch(() => undefined);
  }
  return { removed: [...removed].sort(), kept: [...kept].sort() };
}
