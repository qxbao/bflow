import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";

/** Where a version came from. `declared` is a range from a manifest; `locked` is an exact resolution. */
export interface DetectedVersion {
  /** The dependency name as the project spells it (for example `next` when the caller asked for `next.js`). */
  readonly dependency: string;
  /** Exact version when a lockfile or pin provides one; otherwise the lowest version a range allows. */
  readonly version: string;
  readonly exact: boolean;
  /** The declared range, when the version came from a manifest. */
  readonly range?: string;
  /** File the version was read from, relative to the project root. */
  readonly source: string;
  readonly ecosystem: "npm" | "python" | "go" | "cargo";
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;

async function read(root: string, relative: string): Promise<string | null> {
  try {
    const path = join(root, relative);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(path, "utf8");
  } catch { return null; }
}

/** Name variants that people and registries use for the same project. */
export function dependencyNameCandidates(library: string): string[] {
  const base = library.trim().toLowerCase().replace(/^\//, "");
  const tail = base.split("/").pop() ?? base;
  const variants = new Set<string>([base, tail, tail.replace(/\.js$/, ""), tail.replace(/js$/, ""), tail.replace(/\./g, "-"),
    tail.replace(/_/g, "-"), tail.replace(/-/g, "_")]);
  if (base.includes("/")) variants.add(base);
  return [...variants].filter(Boolean);
}

const normalizePython = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
const SEMVER = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/;

/** Lowest version a simple npm/python range admits, e.g. `^18.2.0` -> `18.2.0`. Complex ranges return null. */
export function floorOfRange(range: string): string | null {
  const trimmed = range.trim();
  if (!trimmed || /\|\||\s-\s|\*|latest|workspace:|file:|git[+:]|https?:|link:/.test(trimmed)) return null;
  const match = /^(?:[~^]|>=|==|=|~=)?\s*v?(\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?)/.exec(trimmed);
  return match?.[1] ?? null;
}

function npmDeclared(manifest: unknown, names: readonly string[]): { dependency: string; range: string } | null {
  if (!manifest || typeof manifest !== "object") return null;
  const record = manifest as Record<string, unknown>;
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const table = record[section];
    if (!table || typeof table !== "object") continue;
    for (const [name, range] of Object.entries(table as Record<string, unknown>)) {
      if (typeof range === "string" && names.includes(name.toLowerCase())) return { dependency: name, range };
    }
  }
  return null;
}

function fromPackageLock(text: string, dependency: string): string | null {
  try {
    const lock = JSON.parse(text) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
    const direct = lock.packages?.[`node_modules/${dependency}`]?.version ?? lock.dependencies?.[dependency]?.version;
    return typeof direct === "string" ? direct : null;
  } catch { return null; }
}

function fromPnpmLock(text: string, dependency: string): string | null {
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  // pnpm v9: `importers: .: dependencies: name: specifier: ^1  version: 1.2.3(peer...)` ; v6/v7 have `version: 1.2.3`.
  const importer = new RegExp(`^\\s{6}['"]?${escaped}['"]?:\\s*\\n\\s{8}specifier:[^\\n]*\\n\\s{8}version:\\s*['"]?(\\d[^\\s('"]*)`, "m").exec(text);
  if (importer?.[1]) return importer[1];
  const legacy = new RegExp(`^\\s{2,6}['"]?${escaped}['"]?:\\s*\\n\\s+specifier:[^\\n]*\\n\\s+version:\\s*['"]?(\\d[^\\s('"]*)`, "m").exec(text);
  if (legacy?.[1]) return legacy[1];
  // The `packages:` section lists every resolved copy, including transitive ones. Only an unambiguous single version is a safe answer.
  const found = new Set<string>();
  for (const match of text.matchAll(new RegExp(`^\\s{2}['"]?/?${escaped}@(\\d[^'":\\s(]*)(?:\\([^)]*\\))*['"]?:`, "gm"))) found.add(match[1]!);
  return found.size === 1 ? [...found][0]! : null;
}

function fromYarnLock(text: string, dependency: string, range?: string): string | null {
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const versions = new Map<string, string>();
  for (const match of text.matchAll(new RegExp(`^((?:"?${escaped}@[^\\n]*?)):\\n\\s+version:?\\s+"?([^"\\n]+)"?`, "gm"))) versions.set(match[1]!, match[2]!);
  if (range !== undefined) {
    // A yarn block header lists every range that resolved to it, so the declared range identifies this project's copy.
    for (const [header, version] of versions) if (header.split(",").some(part => part.trim().replace(/^"|"$/g, "") === `${dependency}@${range}`)) return version;
  }
  const distinct = new Set(versions.values());
  return distinct.size === 1 ? [...distinct][0]! : null;
}

async function detectNpm(root: string, names: readonly string[], lockDirectories: readonly string[], boundary: string): Promise<DetectedVersion | null> {
  const manifestText = await read(root, "package.json");
  if (manifestText === null) return null;
  let manifest: unknown;
  try { manifest = JSON.parse(manifestText); } catch { return null; }
  const declared = npmDeclared(manifest, names);
  if (!declared) return null;
  const lockers: Array<[string, (text: string, name: string, range: string) => string | null]> = [
    ["package-lock.json", fromPackageLock], ["npm-shrinkwrap.json", fromPackageLock], ["pnpm-lock.yaml", fromPnpmLock], ["yarn.lock", fromYarnLock]
  ];
  // A workspace keeps one lockfile at its root, above the package that declares the dependency.
  for (const directory of lockDirectories) {
    for (const [file, parse] of lockers) {
      const text = await read(directory, file);
      const locked = text === null ? null : parse(text, declared.dependency, declared.range);
      const label = relative(boundary, join(directory, file));
      if (locked && SEMVER.test(locked)) return { dependency: declared.dependency, version: locked, exact: true, range: declared.range, source: label, ecosystem: "npm" };
    }
  }
  const floor = floorOfRange(declared.range);
  return floor ? { dependency: declared.dependency, version: floor, exact: /^\d/.test(declared.range.trim()) && !/[~^<>*|x]/.test(declared.range), range: declared.range, source: relative(boundary, join(root, "package.json")), ecosystem: "npm" } : null;
}

function tomlPackages(text: string): Array<{ name: string; version: string }> {
  const found: Array<{ name: string; version: string }> = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version) found.push({ name, version });
  }
  return found;
}

async function detectPython(root: string, names: readonly string[]): Promise<DetectedVersion | null> {
  const wanted = new Set(names.map(normalizePython));
  for (const file of ["uv.lock", "poetry.lock", "Pipfile.lock"]) {
    const text = await read(root, file);
    if (text === null) continue;
    if (file === "Pipfile.lock") {
      try {
        const lock = JSON.parse(text) as { default?: Record<string, { version?: string }>; develop?: Record<string, { version?: string }> };
        for (const table of [lock.default, lock.develop]) for (const [name, entry] of Object.entries(table ?? {}))
          if (wanted.has(normalizePython(name)) && entry.version) return { dependency: name, version: entry.version.replace(/^==/, ""), exact: true, source: file, ecosystem: "python" };
      } catch { /* try the next source */ }
      continue;
    }
    const hit = tomlPackages(text).find(entry => wanted.has(normalizePython(entry.name)));
    if (hit) return { dependency: hit.name, version: hit.version, exact: true, source: file, ecosystem: "python" };
  }
  const requirementFiles = ["requirements.txt", "requirements-dev.txt", "requirements/base.txt", "requirements/dev.txt"];
  for (const file of requirementFiles) {
    const text = await read(root, file);
    if (text === null) continue;
    for (const line of text.split("\n")) {
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(==|~=|>=|<=|>|<)\s*([0-9][^\s;,#]*)/.exec(line);
      if (match && wanted.has(normalizePython(match[1]!))) {
        const exact = match[2] === "==";
        return { dependency: match[1]!, version: match[3]!, exact, range: `${match[2]}${match[3]}`, source: file, ecosystem: "python" };
      }
    }
  }
  const pyproject = await read(root, "pyproject.toml");
  if (pyproject !== null) {
    for (const match of pyproject.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(==|~=|>=)\s*([0-9][^"',;\s]*)["']/g)) {
      if (wanted.has(normalizePython(match[1]!))) return { dependency: match[1]!, version: match[3]!, exact: match[2] === "==", range: `${match[2]}${match[3]}`, source: "pyproject.toml", ecosystem: "python" };
    }
  }
  return null;
}

async function detectGo(root: string, names: readonly string[]): Promise<DetectedVersion | null> {
  const text = await read(root, "go.mod");
  if (text === null) return null;
  for (const match of text.matchAll(/^\s*(?:require\s+)?([A-Za-z0-9._~/-]+\.[A-Za-z0-9._~/-]+)\s+v(\d[^\s/]*)/gm)) {
    const module = match[1]!.toLowerCase();
    if (names.some(name => module === name || module.endsWith(`/${name}`))) return { dependency: match[1]!, version: match[2]!, exact: true, source: "go.mod", ecosystem: "go" };
  }
  return null;
}

async function detectCargo(root: string, names: readonly string[]): Promise<DetectedVersion | null> {
  const text = await read(root, "Cargo.lock");
  if (text === null) return null;
  const hit = tomlPackages(text).find(entry => names.includes(entry.name.toLowerCase()));
  return hit ? { dependency: hit.name, version: hit.version, exact: true, source: "Cargo.lock", ecosystem: "cargo" } : null;
}

/** Directories from `from` up to and including `boundary`; just the boundary when `from` lies outside it. */
function ancestry(from: string, boundary: string): string[] {
  const top = resolve(boundary);
  let current = resolve(from);
  const inside = (path: string) => { const rel = relative(top, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
  if (!inside(current)) return [top];
  const directories: string[] = [];
  for (;;) {
    directories.push(current);
    if (current === top) return directories;
    current = dirname(current);
  }
}

/**
 * Finds the version of `library` that the project actually uses. The search starts in `options.from` (default `root`) and walks
 * up to `root`, so a package inside a workspace is found from its own directory, and a lockfile kept at the workspace root is
 * still used. Lockfiles win over manifests, and the result says whether the version is exact. When a lockfile holds several
 * copies and none can be tied to the declared range, it is not guessed: the manifest's lowest version is reported as inexact.
 * Returns null when nothing in the searched directories depends on the library.
 */
export async function detectInstalledVersion(root: string, library: string, options: { from?: string } = {}): Promise<DetectedVersion | null> {
  const names = dependencyNameCandidates(library);
  const directories = ancestry(options.from ?? root, root);
  for (const [index, directory] of directories.entries()) {
    // npm labels are already relative to `root`; the other ecosystems label a file in the directory they searched.
    const npm = await detectNpm(directory, names, directories.slice(index), resolve(root));
    if (npm) return npm;
    const found = (await detectPython(directory, names)) ?? (await detectGo(directory, names)) ?? (await detectCargo(directory, names));
    if (found) return directory === resolve(root) ? found : { ...found, source: join(relative(root, directory), found.source) };
  }
  return null;
}
