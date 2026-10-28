import { lstat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, resolve } from "node:path";
import { z } from "zod";
import {
  AgentProviderIdSchema,
  AgentRoleSchema,
  SkillPinSchema,
  type AgentRole,
  type SkillDefinition,
  type SkillPin,
} from "@bflow/contracts";
import {
  bundleDigest,
  readBundle,
  readSourceFile,
  sha256,
  type BundleFiles,
} from "./storage.js";
import {
  SKILL_SECTIONS,
  SupportedCommandsSchema,
  bflowCommandIssues,
  compareText,
  digestJson,
  validateSkill,
} from "./validation.js";

/**
 * Operator-selected import of existing IDE skills/rules into reviewed Bflow bundles.
 * Only the exact selected paths are read (a selected bundle or Cursor rules directory is
 * walked with the normal bundle bounds). Nothing here installs, approves, executes hooks or
 * registers MCP servers: tool and hook content becomes a proposal for separate review.
 */
export const SKILL_IMPORT_SOURCE_KINDS = [
  "skill_bundle",
  "claude_md",
  "agents_md",
  "gemini_md",
  "cursor_rules",
] as const;
export const SkillImportSourceKindSchema = z.enum(SKILL_IMPORT_SOURCE_KINDS);
export type SkillImportSourceKind = z.infer<typeof SkillImportSourceKindSchema>;
export const SkillImportSelectionSchema = z
  .object({
    path: z.string().min(1).refine(isAbsolute, "selected source path must be absolute"),
    kind: SkillImportSourceKindSchema.optional(),
  })
  .strict();
export type SkillImportSelection = z.infer<typeof SkillImportSelectionSchema>;

export type SkillImportSeverity = "info" | "warning" | "blocker";
export interface SkillImportWarning {
  code: string;
  severity: SkillImportSeverity;
  message: string;
  path?: string;
  line?: number;
}
export type SkillImportFileRole =
  | "instruction"
  | "resource"
  | "metadata"
  | "executable"
  | "tool_config"
  | "unsupported";
export interface SkillImportItem {
  itemId: string;
  origin: { path: string; entry: string; kind: SkillImportSourceKind; selection: "user_selected" };
  status: "convertible" | "blocked";
  name: string | null;
  description: string | null;
  /** Bundle digest over every selected file (same algorithm as installed skills). */
  contentDigest: string;
  /** Normalized instruction-body digest used for duplicate detection. */
  instructionDigest: string;
  files: { path: string; sha256: string; bytes: number; role: SkillImportFileRole }[];
  resources: { path: string; from: string; present: boolean }[];
  references: {
    dependencies: string[];
    tools: string[];
    mcpServers: string[];
    hooks: string[];
    imports: string[];
    remote: string[];
  };
  frontmatter: Record<string, string | string[]>;
  warnings: SkillImportWarning[];
}
export interface SkillImportDuplicateGroup {
  reason: "identical_content" | "same_name";
  key: string;
  itemIds: string[];
}
export interface SkillImportInventory {
  schemaVersion: 1;
  digest: string;
  items: SkillImportItem[];
  duplicateGroups: SkillImportDuplicateGroup[];
}
export interface ScannedSkillSources {
  inventory: SkillImportInventory;
  /** Verbatim bytes per item; never serialized into the inventory. */
  files: ReadonlyMap<string, BundleFiles>;
}

const TEXT_RESOURCE = new Set([".md", ".mdc", ".txt", ".json", ".yaml", ".yml", ".csv"]);
const EXECUTABLE = new Set([".sh", ".bash", ".zsh", ".fish", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".bat", ".cmd"]);
const FORGED_KEYS = new Set(["source", "provenance", "trusted", "trust", "approved", "approval", "approvalreceiptid", "builtin", "origin", "signature", "digest", "verified"]);
const SECRET_PATTERNS: { code: string; pattern: RegExp }[] = [
  { code: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { code: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { code: "api_key", pattern: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35})/ },
  { code: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { code: "url_credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i },
  {
    code: "credential_assignment",
    pattern: /\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{16,}/i,
  },
];
const URL_PATTERN = /\b(?:https?|ftp|file|secret):\/\/[^\s)>\]"'`]*/g;

function warn(
  list: SkillImportWarning[],
  code: string,
  severity: SkillImportSeverity,
  message: string,
  location: { path?: string; line?: number } = {},
): void {
  list.push({ code, severity, message, ...location });
}
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}
function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}
export function slugSkillId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "imported-skill";
}

interface Frontmatter {
  fields: Record<string, string | string[]>;
  body: string;
  raw: string | null;
}
/** Minimal, non-executing frontmatter reader: top-level scalars and simple lists only. */
export function readFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text, raw: null };
  const fields: Record<string, string | string[]> = {};
  let current: string | null = null;
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (pair) {
      current = pair[1]!;
      const value = pair[2]!.trim();
      fields[current] = value.replace(/^(["'])(.*)\1$/, "$2");
      continue;
    }
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && current) {
      const existing = fields[current];
      const list = Array.isArray(existing) ? existing : existing ? [existing] : [];
      list.push(item[1]!.trim().replace(/^(["'])(.*)\1$/, "$2"));
      fields[current] = list;
    } else if (line.trim() && current) {
      const existing = fields[current];
      fields[current] = Array.isArray(existing) ? [...existing, line.trim()] : `${existing ?? ""}${existing ? " " : ""}${line.trim()}`;
    }
  }
  return { fields, body: text.slice(match[0].length), raw: match[1]! };
}
function listValue(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : value.replace(/^\[|\]$/g, "").split(/[,\s]+/);
  return items.map((item) => item.trim().replace(/^(["'])(.*)\1$/, "$2")).filter(Boolean);
}

function classify(path: string, entry: string): SkillImportFileRole {
  const name = basename(path).toLowerCase();
  if (path === entry) return "instruction";
  if (path === "skill.json") return "metadata";
  if (name === ".mcp.json" || name === "mcp.json") return "tool_config";
  if (name === "hooks.json" || path.split("/")[0] === "hooks") return "executable";
  const extension = extname(name);
  if (EXECUTABLE.has(extension)) return "executable";
  if (TEXT_RESOURCE.has(extension)) return "resource";
  return "unsupported";
}

/** Relative local references of one Markdown file: inline links, definitions and file code spans. */
function localReferences(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)) targets.push((match[1] ?? match[2])!);
  for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)) targets.push(match[1]!);
  for (const match of text.matchAll(/`((?:\.{0,2}\/)?[\w./-]+\.(?:md|txt|json|ya?ml|png|svg|py|sh|ts|js))`/g)) targets.push(match[1]!);
  return targets.filter((target) => !target.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(target));
}
function resolveLocal(target: string, from: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split("#")[0] ?? "");
  } catch {
    return null;
  }
  if (!decoded || decoded.startsWith("/") || /[\\\0?]/.test(decoded)) return null;
  const path = posix.normalize(posix.join(posix.dirname(from), decoded));
  return path.startsWith("../") || path === ".." ? null : path;
}

function analyze(
  kind: SkillImportSourceKind,
  originPath: string,
  entry: string,
  files: BundleFiles,
  itemId: string,
): SkillImportItem {
  const warnings: SkillImportWarning[] = [];
  const entryText = files[entry] ?? "";
  const fm = readFrontmatter(entryText);
  const references = {
    dependencies: new Set<string>(),
    tools: new Set<string>(),
    mcpServers: new Set<string>(),
    hooks: new Set<string>(),
    imports: new Set<string>(),
    remote: new Set<string>(),
  };
  const fileRoles = Object.keys(files)
    .sort(compareText)
    .map((path) => ({ path, sha256: sha256(files[path]!), bytes: Buffer.byteLength(files[path]!), role: classify(path, entry) }));
  const resources: SkillImportItem["resources"] = [];
  for (const file of fileRoles) {
    const text = files[file.path]!;
    for (const { code, pattern } of SECRET_PATTERNS) {
      const found = pattern.exec(text);
      if (found)
        warn(warnings, "secret_detected", "blocker", `Possible secret (${code}); the source is not converted and the value is never copied`,
          { path: file.path, line: lineOf(text, found.index) });
    }
  }
  // A source holding a possible secret exposes no derived text: only file digests, frontmatter keys and secret locations.
  if (warnings.length)
    return {
      itemId,
      origin: { path: originPath, entry, kind, selection: "user_selected" },
      status: "blocked",
      name: null,
      description: null,
      contentDigest: bundleDigest(files),
      instructionDigest: sha256(fm.body.replace(/\s+/g, " ").trim().toLowerCase()),
      files: fileRoles,
      resources: [],
      references: { dependencies: [], tools: [], mcpServers: [], hooks: [], imports: [], remote: [] },
      frontmatter: Object.fromEntries(Object.keys(fm.fields).map((key) => [key, "[redacted]"])),
      warnings,
    };
  for (const file of fileRoles) {
    const text = files[file.path]!;
    if (file.role === "executable") {
      references.hooks.add(file.path);
      warn(warnings, "executable_excluded", "warning", "Executable/hook file is proposed for separate review and is never installed or run", { path: file.path });
    } else if (file.role === "tool_config") {
      try {
        const parsed = z.object({ mcpServers: z.record(z.unknown()) }).passthrough().parse(JSON.parse(text));
        for (const server of Object.keys(parsed.mcpServers)) references.mcpServers.add(server);
      } catch {
        warn(warnings, "tool_config_unreadable", "warning", "MCP configuration could not be parsed; it is reported, not installed", { path: file.path });
      }
    } else if (file.role === "unsupported") {
      warn(warnings, "unsupported_resource", "warning", "Resource type is not carried into an instruction-only bundle", { path: file.path });
    }
    if (file.role === "instruction" || file.role === "resource") {
      for (const match of text.matchAll(URL_PATTERN)) references.remote.add(match[0]);
      for (const match of text.matchAll(/\bmcp__([A-Za-z0-9_-]+?)__[A-Za-z0-9_-]+/g)) references.mcpServers.add(match[1]!);
      for (const match of text.matchAll(/!`[^`\n]+`/g)) {
        references.hooks.add(`${file.path}:${lineOf(text, match.index)}`);
        warn(warnings, "dynamic_shell", "warning", "Dynamic shell interpolation is executable content and will not be converted", { path: file.path, line: lineOf(text, match.index) });
      }
      if (/\.(md|mdc)$/i.test(file.path)) {
        for (const target of localReferences(text)) {
          const resolved = resolveLocal(target, file.path);
          if (resolved?.endsWith("/SKILL.md") || resolved === "SKILL.md") {
            if (resolved !== "SKILL.md") references.dependencies.add(basename(dirname(resolved)));
            continue;
          }
          if (/(^|\/)\.\.\//.test(target) && /SKILL\.md$/.test(target)) {
            references.dependencies.add(basename(dirname(target)));
            continue;
          }
          resources.push({ path: resolved ?? target, from: file.path, present: resolved !== null && Object.hasOwn(files, resolved) });
        }
      }
    }
  }
  if (kind === "claude_md" || kind === "gemini_md" || kind === "agents_md") {
    let fenced = false;
    for (const [index, line] of entryText.split(/\r?\n/).entries()) {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const directive = fenced ? null : /^@(\S+)\s*$/.exec(line.trim());
      if (directive) {
        references.imports.add(directive[1]!);
        warn(warnings, "import_not_followed", "warning", "Import directive is reported but never followed outside the selected sources", { path: entry, line: index + 1 });
      }
    }
  }
  for (const [key, value] of Object.entries(fm.fields)) {
    const normalized = key.toLowerCase();
    if (FORGED_KEYS.has(normalized))
      warn(warnings, "forged_provenance", "blocker", `Frontmatter field '${key}' claims provenance/trust; provenance is asserted only by the importer`, { path: entry });
    else if (normalized === "allowed-tools" || normalized === "tools") for (const tool of listValue(value)) references.tools.add(tool);
    else if (normalized === "hooks") {
      references.hooks.add(`${entry}#frontmatter.hooks`);
      warn(warnings, "frontmatter_hooks", "warning", "Frontmatter hooks are executable content and are never installed", { path: entry });
    }
  }
  if (files["skill.json"] !== undefined) {
    try {
      const metadata = z.record(z.unknown()).parse(JSON.parse(files["skill.json"]));
      for (const key of Object.keys(metadata))
        if (FORGED_KEYS.has(key.toLowerCase()))
          warn(warnings, "forged_provenance", "blocker", `skill.json field '${key}' claims provenance/trust`, { path: "skill.json" });
      const dependencies = z.array(z.object({ skillId: z.string() }).passthrough()).safeParse(metadata["dependencies"]);
      if (dependencies.success) for (const dependency of dependencies.data) references.dependencies.add(dependency.skillId);
      for (const tool of z.array(z.string()).catch([]).parse(metadata["requiredToolIds"])) references.tools.add(tool);
    } catch {
      warn(warnings, "metadata_unreadable", "warning", "skill.json is not valid JSON; metadata is regenerated from the proposal", { path: "skill.json" });
    }
  }
  if (!fm.body.trim()) warn(warnings, "empty_instructions", "blocker", "Selected source has no instruction text", { path: entry });
  for (const resource of resources)
    if (!resource.present)
      warn(warnings, "resource_missing", "warning", `Referenced resource is outside the selected source or missing: ${resource.path}`, { path: resource.from });
  const name = typeof fm.fields["name"] === "string" ? fm.fields["name"] : null;
  const description = typeof fm.fields["description"] === "string" && fm.fields["description"].trim()
    ? fm.fields["description"].trim()
    : firstParagraph(fm.body);
  const normalizedBody = fm.body.replace(/\s+/g, " ").trim().toLowerCase();
  return {
    itemId,
    origin: { path: originPath, entry, kind, selection: "user_selected" },
    status: warnings.some((item) => item.severity === "blocker") ? "blocked" : "convertible",
    name,
    description,
    contentDigest: bundleDigest(files),
    instructionDigest: sha256(normalizedBody),
    files: fileRoles,
    resources,
    references: {
      dependencies: unique(references.dependencies),
      tools: unique(references.tools),
      mcpServers: unique(references.mcpServers),
      hooks: unique(references.hooks),
      imports: unique(references.imports),
      remote: unique(references.remote),
    },
    frontmatter: fm.fields,
    warnings,
  };
}
function firstParagraph(body: string): string | null {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block
      .split(/\r?\n/)
      .filter((line) => !/^\s*(#|```|~~~|@|---)/.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.slice(0, 240);
  }
  return null;
}

function blockedItem(itemId: string, path: string, kind: SkillImportSourceKind, code: string, message: string): SkillImportItem {
  return {
    itemId,
    origin: { path, entry: basename(path), kind, selection: "user_selected" },
    status: "blocked",
    name: null,
    description: null,
    contentDigest: sha256(""),
    instructionDigest: sha256(""),
    files: [],
    resources: [],
    references: { dependencies: [], tools: [], mcpServers: [], hooks: [], imports: [], remote: [] },
    frontmatter: {},
    warnings: [{ code, severity: "blocker", message }],
  };
}
function fileKind(name: string): SkillImportSourceKind | null {
  const lower = name.toLowerCase();
  if (lower === "claude.md" || lower === "claude.local.md") return "claude_md";
  if (lower === "agents.md" || lower === "agents.override.md") return "agents_md";
  if (lower === "gemini.md") return "gemini_md";
  if (lower === ".cursorrules" || lower.endsWith(".mdc")) return "cursor_rules";
  if (lower === "skill.md") return "skill_bundle";
  return null;
}
function itemIdFor(kind: SkillImportSourceKind, key: string): string {
  return `${kind.replace(/_/g, "-")}-${sha256(key).slice(0, 12)}`;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Scans exactly the selected sources. Read-only: no state, cache or catalog is written. */
export async function scanSkillSources(input: readonly SkillImportSelection[]): Promise<ScannedSkillSources> {
  const selections = z.array(SkillImportSelectionSchema).min(1).max(64).parse(input);
  const items: SkillImportItem[] = [];
  const contents = new Map<string, BundleFiles>();
  const seen = new Set<string>();
  for (const selection of selections) {
    const path = resolve(selection.path);
    if (path !== selection.path || seen.has(path)) {
      items.push(blockedItem(itemIdFor(selection.kind ?? "skill_bundle", `${selection.path}\0${items.length}`), selection.path, selection.kind ?? "skill_bundle",
        path !== selection.path ? "unsafe_path" : "duplicate_selection", path !== selection.path ? "Selected path must be normalized (no '.' or '..' segments)" : "Path was selected more than once"));
      continue;
    }
    seen.add(path);
    const fallbackKind = selection.kind ?? fileKind(basename(path)) ?? "skill_bundle";
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("Selected source is a symlink");
      if (stat.isDirectory()) {
        const hasSkill = await lstat(join(path, "SKILL.md")).then(() => true, () => false);
        const kind = selection.kind ?? (hasSkill ? "skill_bundle" : "cursor_rules");
        if (kind === "skill_bundle") {
          if (!hasSkill) throw new Error("Selected skill directory has no SKILL.md");
          const files = await readBundle(path);
          const itemId = itemIdFor(kind, path);
          items.push(analyze(kind, path, "SKILL.md", files, itemId));
          contents.set(itemId, files);
        } else if (kind === "cursor_rules") {
          const files = await readBundle(path);
          const rules = Object.keys(files).filter((name) => /\.mdc$/i.test(name)).sort(compareText);
          if (!rules.length) throw new Error("Selected directory has neither SKILL.md nor Cursor .mdc rules");
          for (const rule of rules) {
            const itemId = itemIdFor(kind, `${path}/${rule}`);
            const own = { [basename(rule)]: files[rule]! };
            items.push(analyze(kind, `${path}/${rule}`, basename(rule), own, itemId));
            contents.set(itemId, own);
          }
        } else throw new Error(`A ${kind} source must be a file`);
      } else if (stat.isFile()) {
        const kind = selection.kind ?? fileKind(basename(path));
        if (kind === null) throw new Error("Unsupported source; select SKILL.md bundles, CLAUDE.md, AGENTS.md, GEMINI.md or Cursor rules");
        if (kind === "skill_bundle") {
          const root = dirname(path);
          if (basename(path) !== "SKILL.md") throw new Error("A skill bundle is selected by its directory or SKILL.md");
          const files = await readBundle(root);
          const itemId = itemIdFor(kind, root);
          items.push(analyze(kind, root, "SKILL.md", files, itemId));
          contents.set(itemId, files);
        } else {
          const name = basename(path);
          const files = { [name]: await readSourceFile(path) };
          bundleDigest(files);
          const itemId = itemIdFor(kind, path);
          items.push(analyze(kind, path, name, files, itemId));
          contents.set(itemId, files);
        }
      } else throw new Error("Selected source is not a regular file or directory");
    } catch (error) {
      items.push(blockedItem(itemIdFor(fallbackKind, path), path, fallbackKind, "unreadable_source", errorMessage(error)));
    }
  }
  const duplicateGroups: SkillImportDuplicateGroup[] = [];
  const group = (reason: SkillImportDuplicateGroup["reason"], key: (item: SkillImportItem) => string | null) => {
    const groups = new Map<string, string[]>();
    for (const item of items.filter((candidate) => candidate.files.length > 0)) {
      const value = key(item);
      if (value) groups.set(value, [...(groups.get(value) ?? []), item.itemId]);
    }
    for (const [value, ids] of [...groups].sort(([a], [b]) => compareText(a, b)))
      if (ids.length > 1) duplicateGroups.push({ reason, key: value, itemIds: ids });
  };
  group("identical_content", (item) => item.instructionDigest);
  group("same_name", (item) => (item.name ? slugSkillId(item.name) : null));
  for (const duplicate of duplicateGroups)
    for (const id of duplicate.itemIds.slice(1)) {
      const item = items.find((candidate) => candidate.itemId === id)!;
      warn(item.warnings, `duplicate_${duplicate.reason}`, "warning", `Duplicates ${duplicate.itemIds[0]} (${duplicate.reason}); import only one`);
    }
  const body = { schemaVersion: 1 as const, items, duplicateGroups };
  return { inventory: { ...body, digest: digestJson(body) }, files: contents };
}

const ROLE_KEYWORDS: readonly [AgentRole, RegExp][] = [
  ["reviewer", /\b(code review|review(ing|er)?|pull request|pr review)\b/],
  ["security", /\b(security|threat model|vulnerabilit(y|ies)|owasp|secrets?)\b/],
  ["qa", /\b(qa|quality assurance|acceptance test(ing)?|exploratory)\b/],
  ["tester", /\b(tests?|testing|unit test|tdd|coverage|test plan)\b/],
  ["specifier", /\b(requirements?|specification|user stor(y|ies)|acceptance criteria)\b/],
  ["architect", /\b(architecture|architect|system design|adr)\b/],
  ["planner", /\b(planning|roadmap|task breakdown|decompos(e|ition))\b/],
  ["developer", /\b(implement(ation)?|coding|refactor(ing)?|build|code style|conventions?)\b/],
];

export const SkillImportProposalOptionsSchema = z
  .object({
    roles: z.array(AgentRoleSchema).min(1).optional(),
    providers: z.array(AgentProviderIdSchema).min(1).optional(),
    version: z.string().trim().min(1).max(64).regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/).optional(),
    /** Explicit target skill IDs by item ID. */
    skillIds: z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64)).optional(),
    /** Builtin/approved distribution IDs that an import must never shadow. */
    reservedSkillIds: z.array(z.string()).optional(),
  })
  .strict();
export type SkillImportProposalOptions = z.infer<typeof SkillImportProposalOptionsSchema>;
export interface SkillImportProposalItem {
  itemId: string;
  contentDigest: string;
  status: "proposed" | "blocked";
  blockers: string[];
  skillId: string;
  version: string;
  description: string;
  roles: AgentRole[];
  roleSource: "operator" | "heuristic";
  roleRationale: string[];
  providers: z.infer<typeof AgentProviderIdSchema>[];
  instructionFiles: string[];
  resourceFiles: string[];
  toolProposals: { kind: "tool" | "mcp_server"; id: string; action: "requires_tool_policy_review" }[];
  executableHooks: { reference: string; action: "not_installed_requires_separate_review" }[];
  dependencyReferences: string[];
}
export interface SkillImportProposal {
  schemaVersion: 1;
  inventoryDigest: string;
  digest: string;
  items: SkillImportProposalItem[];
}

function defaultSkillId(item: SkillImportItem): string {
  if (item.name) return slugSkillId(item.name);
  const parent = basename(dirname(item.origin.path));
  if (item.origin.kind === "cursor_rules")
    return slugSkillId(`cursor-${basename(item.origin.entry).replace(/\.mdc$/i, "").replace(/^\.cursorrules$/, parent)}`);
  return slugSkillId(`${parent}-${item.origin.kind.replace(/_md$/, "")}-rules`);
}

/** Maps inventory items onto canonical roles and separates instructions, tool proposals and executable hooks. */
export function proposeSkillImport(inventory: SkillImportInventory, input: SkillImportProposalOptions = {}): SkillImportProposal {
  const options = SkillImportProposalOptionsSchema.parse(input);
  const { digest, ...body } = inventory;
  if (digestJson(body) !== digest) throw new Error("Skill import inventory digest mismatch");
  const reserved = new Set(options.reservedSkillIds ?? []);
  const taken = new Set<string>();
  const items = inventory.items.map((item): SkillImportProposalItem => {
    const blockers = item.warnings.filter((entry) => entry.severity === "blocker").map((entry) => `${entry.code}: ${entry.message}`);
    const skillId = options.skillIds?.[item.itemId] ?? defaultSkillId(item);
    if (reserved.has(skillId)) blockers.push(`builtin_name_collision: '${skillId}' is an approved distribution skill and cannot be shadowed`);
    if (taken.has(skillId)) blockers.push(`duplicate_skill_id: '${skillId}' is proposed by another selected source`);
    taken.add(skillId);
    const haystack = [item.name ?? "", item.description ?? "", item.origin.entry].join(" ").toLowerCase();
    const matched = ROLE_KEYWORDS.filter(([, pattern]) => pattern.test(haystack));
    const roles = options.roles ?? (matched.length ? unique(matched.map(([role]) => role)) as AgentRole[] : ["developer" as AgentRole]);
    return {
      itemId: item.itemId,
      contentDigest: item.contentDigest,
      status: blockers.length ? "blocked" : "proposed",
      blockers,
      skillId,
      version: options.version ?? "1.0.0",
      description: (item.description ?? `Imported ${item.origin.kind.replace(/_/g, " ")} instructions`).replace(/\s+/g, " ").trim().slice(0, 1024),
      roles,
      roleSource: options.roles ? "operator" : "heuristic",
      roleRationale: options.roles
        ? ["roles selected by the operator"]
        : matched.length
          ? matched.map(([role, pattern]) => `${role}: matched ${pattern.source}`)
          : ["developer: default when no role keyword matched"],
      providers: options.providers ?? ["claude", "codex", "agy"],
      instructionFiles: item.files.filter((file) => file.role === "instruction").map((file) => file.path),
      resourceFiles: item.files.filter((file) => file.role === "resource").map((file) => file.path),
      toolProposals: [
        ...item.references.tools.map((id) => ({ kind: "tool" as const, id, action: "requires_tool_policy_review" as const })),
        ...item.references.mcpServers.map((id) => ({ kind: "mcp_server" as const, id, action: "requires_tool_policy_review" as const })),
      ],
      executableHooks: item.references.hooks.map((reference) => ({ reference, action: "not_installed_requires_separate_review" as const })),
      dependencyReferences: item.references.dependencies,
    };
  });
  const proposal = { schemaVersion: 1 as const, inventoryDigest: digest, items };
  return { ...proposal, digest: digestJson(proposal) };
}

export interface SkillImportReport {
  schemaVersion: 1;
  itemId: string;
  origin: SkillImportItem["origin"];
  originalDigest: string;
  proposalDigest: string;
  skillId: string;
  version: string;
  roles: AgentRole[];
  providers: SkillImportProposalItem["providers"];
  bundleDigest: string;
  dependencies: SkillPin[];
  originals: { path: string; sha256: string; bytes: number; disposition: "converted" | "copied" | "excluded" }[];
  bundleFiles: { path: string; sha256: string }[];
  transformations: { code: string; path: string; count: number; detail: string }[];
  unconverted: { code: string; path: string; line?: number; original: string; reason: string }[];
  toolProposals: SkillImportProposalItem["toolProposals"];
  executableHooks: SkillImportProposalItem["executableHooks"];
}
export interface SkillImportConversion {
  itemId: string;
  bundle: BundleFiles;
  definition: SkillDefinition;
  /** Verbatim selected bytes, kept beside the bundle for review. */
  originals: BundleFiles;
  report: SkillImportReport;
}
export const SkillImportConvertOptionsSchema = z
  .object({
    supportedCommands: SupportedCommandsSchema,
    source: z.enum(["repository", "operator"]).default("repository"),
    dependencies: z.array(SkillPinSchema).default([]),
  })
  .strict();
export type SkillImportConvertOptions = z.input<typeof SkillImportConvertOptionsSchema>;

class Rewriter {
  readonly transformations = new Map<string, { code: string; path: string; count: number; detail: string }>();
  readonly unconverted: SkillImportReport["unconverted"] = [];
  constructor(private readonly supported: readonly string[]) {}
  transform(code: string, path: string, detail: string): void {
    const key = `${code}\0${path}`;
    const existing = this.transformations.get(key);
    if (existing) existing.count++;
    else this.transformations.set(key, { code, path, count: 1, detail });
  }
  lose(code: string, path: string, text: string, index: number, original: string, reason: string): void {
    this.unconverted.push({ code, path, line: lineOf(text, index), original: original.slice(0, 300), reason });
  }
  /** Rewrites validator-rejected references in Markdown/text so the bundle validates, reporting every loss. */
  rewrite(text: string, path: string, bundlePaths: ReadonlySet<string>, markdown: boolean): string {
    let out = text;
    if (markdown) {
      out = out.replace(/(!?)\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g, (whole, _bang: string, label: string, angled?: string, plain?: string, offset?: number) => {
        const target = (angled ?? plain)!;
        if (target.startsWith("#")) return whole;
        const local = /^[a-z][a-z0-9+.-]*:/i.test(target) ? null : resolveLocal(target, path);
        if (local !== null && bundlePaths.has(local)) return whole;
        this.lose(local === null ? "remote_link" : "external_local_link", path, text, offset ?? 0, whole,
          local === null ? "remote/unfetched link target removed; link text kept" : "link target is outside the converted bundle; link text kept");
        return `${label || "link"} (link removed: ${local === null ? hostOf(target) : `repository path ${local}`})`;
      });
      const removedKeys = new Set<string>();
      out = out.replace(/^(\s*)\[([^\]]+)\]:\s*<?([^\s>]+)>?.*$/gm, (whole, _indent: string, key: string, target: string, offset: number) => {
        const local = /^[a-z][a-z0-9+.-]*:/i.test(target) ? null : resolveLocal(target, path);
        if (local !== null && bundlePaths.has(local)) return whole;
        removedKeys.add(key.toLowerCase());
        this.lose("reference_definition", path, text, offset, whole, "reference definition target is remote or outside the bundle");
        return `(reference ${key} removed: ${local === null ? hostOf(target) : `repository path ${local}`})`;
      });
      const defined = new Set([...out.matchAll(/^\s*\[([^\]]+)\]:/gm)].map((match) => match[1]!.toLowerCase()));
      out = out.replace(/(!?)\[([^\]]+)\]\[([^\]]*)\]/g, (whole, bang: string, label: string, key: string) => {
        const name = (key || label).toLowerCase();
        if (defined.has(name)) return whole;
        this.transform(removedKeys.has(name) ? "reference_use_unlinked" : "bracket_sequence_spaced", path, "bracket pair that is not a defined reference was separated");
        return `${bang}[${label}] [${key}]`;
      });
      out = out.replace(/`((?:\.{0,2}\/)?[\w./-]+\.(?:md|txt|json|ya?ml|png|svg|py|sh|ts|js))`/g, (whole, target: string) => {
        const local = resolveLocal(target, path);
        if (local !== null && bundlePaths.has(local)) return whole;
        this.transform("repository_path_reference", path, "file path outside the bundle is kept as plain text, not a bundle resource");
        return `${target} (repository path)`;
      });
      out = out.replace(/<\/?(?:img|script|iframe|a|link|object|embed|source)\b[^>]*>/gi, (whole, offset: number) => {
        this.lose("html_resource", path, text, offset, whole, "HTML resource/link tags are not supported in instruction-only bundles");
        return "";
      });
      out = out.replace(/<([A-Za-z][\w+.-]*:[^>]*)>/g, (whole, inner: string, offset: number) => {
        this.lose("autolink", path, text, offset, whole, "autolink target removed");
        return `(link removed: ${hostOf(inner)})`;
      });
    }
    out = out.replace(URL_PATTERN, (whole, offset: number) => {
      this.lose("remote_reference", path, text, offset, whole, "remote content is never fetched; reference removed");
      return `[remote reference removed: ${hostOf(whole)}]`;
    });
    for (const issue of bflowCommandIssues(out, this.supported).reverse()) {
      const original = issue.match.replace(/\s+$/, "");
      this.lose("unsupported_bflow_command", path, text, Math.max(0, text.indexOf(original)), original,
        issue.reason === "syntax" ? "dynamic or option-first Bflow command syntax is not supported" : "command is not in the host command inventory");
      out = out.slice(0, issue.index) + "[unsupported Bflow command removed]" + out.slice(issue.index + original.length);
    }
    return out;
  }
}
function hostOf(target: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*)/i.exec(target);
  return match?.[1]?.replace(/^.*@/, "") || target.split(":")[0] || "unknown";
}

/** Demotes headings and removes executable/import lines of an instruction body that is wrapped into Procedure. */
function wrapBody(body: string, path: string, rewriter: Rewriter, kind: SkillImportSourceKind): string {
  let fenced = false;
  const lines = body.split(/\r?\n/);
  return lines
    .map((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) {
        if (/^## /.test(line)) {
          rewriter.transform("fenced_heading_indented", path, "a fenced line starting with '## ' was indented to keep Bflow sections unambiguous");
          return ` ${line}`;
        }
        return line;
      }
      const heading = /^(#{1,6})(\s.*)$/.exec(line);
      if (heading) {
        rewriter.transform("heading_demoted", path, "original headings were demoted below the Procedure section");
        return `${"#".repeat(Math.min(6, heading[1]!.length + 2))}${heading[2]}`;
      }
      if (kind !== "skill_bundle" && kind !== "cursor_rules" && /^@\S+\s*$/.test(line.trim())) {
        rewriter.lose("import_directive", path, body, lines.slice(0, index).join("\n").length, line.trim(), "import directives are never followed; selected sources only");
        return `(import directive removed: ${line.trim().slice(1)})`;
      }
      return line.replace(/!`([^`\n]+)`/g, (whole) => {
        rewriter.lose("dynamic_shell", path, body, lines.slice(0, index).join("\n").length, whole, "dynamic shell interpolation is executable content");
        return "[dynamic shell interpolation removed]";
      });
    })
    .join("\n");
}
function hasBflowSections(body: string): boolean {
  return SKILL_SECTIONS.every((heading) =>
    new RegExp(`^## ${heading}\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(body)?.[1]?.trim(),
  );
}

/**
 * Converts one proposed item into an instruction-only Bflow bundle and validates it with the
 * normal validator. The originals and a transformation report are returned; nothing is written.
 */
export function convertSkillImport(
  scanned: ScannedSkillSources,
  proposal: SkillImportProposal,
  itemId: string,
  input: SkillImportConvertOptions,
): SkillImportConversion {
  const options = SkillImportConvertOptionsSchema.parse(input);
  const { digest, ...proposalBody } = proposal;
  if (digestJson(proposalBody) !== digest) throw new Error("Skill import proposal digest mismatch");
  if (proposal.inventoryDigest !== scanned.inventory.digest) throw new Error("Skill import proposal does not belong to this scan");
  const item = scanned.inventory.items.find((candidate) => candidate.itemId === itemId);
  const proposed = proposal.items.find((candidate) => candidate.itemId === itemId);
  const files = scanned.files.get(itemId);
  if (!item || !proposed || !files) throw new Error(`Unknown skill import item: ${itemId}`);
  if (proposed.status !== "proposed") throw new Error(`Skill import item is blocked: ${proposed.blockers.join("; ")}`);
  if (bundleDigest(files) !== item.contentDigest || proposed.contentDigest !== item.contentDigest)
    throw new Error("Selected source content changed after scan");
  const roles = z.array(AgentRoleSchema).min(1).parse(proposed.roles);
  const rewriter = new Rewriter(options.supportedCommands);
  const entry = item.origin.entry;
  const fm = readFrontmatter(files[entry]!);
  const carried = item.files.filter((file) => file.role === "resource").map((file) => file.path);
  const bundlePaths = new Set(["SKILL.md", "skill.json", ...carried]);
  for (const [key, value] of Object.entries(fm.fields)) {
    const normalized = key.toLowerCase();
    if (["name", "description"].includes(normalized)) continue;
    if (["globs", "alwaysapply", "paths"].includes(normalized)) {
      rewriter.transform("scope_hint_preserved", entry, `frontmatter '${key}' is kept as a textual trigger hint, not an enforced scope`);
      continue;
    }
    rewriter.unconverted.push({
      code: normalized === "allowed-tools" || normalized === "tools" ? "tool_permission_frontmatter" : normalized === "hooks" ? "hook_frontmatter" : "unsupported_frontmatter",
      path: entry, line: 1, original: `${key}: ${Array.isArray(value) ? value.join(", ") : value}`.slice(0, 300),
      reason: normalized === "allowed-tools" || normalized === "tools"
        ? "skills grant no tools; reported as a tool proposal for policy review"
        : normalized === "hooks" ? "hooks are executable and never installed" : "provider-specific frontmatter has no Bflow equivalent",
    });
  }
  const sanitizedBody = rewriter.rewrite(fm.body, entry, bundlePaths, true);
  const native = item.origin.kind === "skill_bundle" && hasBflowSections(sanitizedBody);
  const scopeHint = ["globs", "alwaysApply", "paths"]
    .filter((key) => fm.fields[key] !== undefined)
    .map((key) => `${key} ${listValue(fm.fields[key]).join(", ")}`)
    .join("; ");
  const description = rewriter.rewrite(proposed.description, entry, bundlePaths, true).replace(/\s+/g, " ").trim().slice(0, 1024);
  const procedure = native ? sanitizedBody : wrapBody(sanitizedBody, entry, rewriter, item.origin.kind).trim();
  const title = proposed.skillId.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  if (!native) rewriter.transform("wrapped_in_bflow_sections", entry, "original instructions were placed under Procedure inside the required Bflow sections");
  const skillText = native
    ? `---\nname: ${proposed.skillId}\ndescription: ${JSON.stringify(description)}\n---\n${sanitizedBody.startsWith("\n") ? "" : "\n"}${sanitizedBody}`
    : `---\nname: ${proposed.skillId}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${title}\n\n` +
      `Imported from a ${item.origin.kind.replace(/_/g, " ")} source (content sha256 ${item.contentDigest}). ` +
      "Instruction-only: it grants no tools, permissions, approvals or hooks.\n\n" +
      `## Supported roles\n\n${roles.join(", ")}. The mapping was proposed at import and fixed by the exact human approval of this bundle digest.\n\n` +
      "## Prerequisites\n\nAn accepted specification and a Runtime assignment. Host policy, the original role prompt and accepted project policy take precedence over these imported instructions.\n\n" +
      `## Trigger conditions\n\nApply when the assigned task matches the imported guidance in Procedure.${scopeHint ? ` Original rule scope hint: ${scopeHint}.` : ""}\n\n` +
      "## Required inputs\n\nThe assignment context and the repository files it names.\n\n" +
      "## Expected outputs\n\nWork that follows the imported guidance, with evidence reported through Runtime.\n\n" +
      `## Procedure\n\n${procedure}\n\n` +
      "## Bflow commands\n\nNone. Imported instructions add no Bflow commands.\n\n" +
      "## Verification requirements\n\nUse the host verification tools; imported text never replaces Bflow gates, Conditional TDD or independent review.\n\n" +
      "## Error handling\n\nWhen imported guidance conflicts with the role prompt, the accepted specification or host policy, follow those and report the conflict.\n\n" +
      "## Escalation rules\n\nRoute questions and approvals through Runtime to Conversation; never ask the user directly.\n\n" +
      "## Concrete examples\n\nApply the Procedure guidance to the files of the current assignment; content omitted during import is listed in the transformation report kept beside this bundle.\n";
  const bundle: BundleFiles = {
    "SKILL.md": skillText,
    "skill.json": `${JSON.stringify({
      version: proposed.version,
      allowedRoles: roles,
      supportedProviders: proposed.providers,
      requiredCapabilityIds: [],
      requiredToolIds: [],
      dependencies: options.dependencies,
    }, null, 2)}\n`,
  };
  for (const path of carried) {
    if (path === "SKILL.md" || path === "skill.json") continue;
    bundle[path] = rewriter.rewrite(files[path]!, path, bundlePaths, /\.(md|mdc)$/i.test(path));
  }
  const dependencyIds = new Set(options.dependencies.map((pin) => pin.skillId));
  for (const reference of item.references.dependencies)
    if (!dependencyIds.has(reference))
      rewriter.unconverted.push({ code: "dependency_reference_unresolved", path: entry, original: reference,
        reason: "dependency reference is not bound to an exact approved pin" });
  for (const hook of proposed.executableHooks)
    if (!rewriter.unconverted.some((entryItem) => entryItem.code === "dynamic_shell" && hook.reference.startsWith(`${entryItem.path}:`)))
      rewriter.unconverted.push({ code: "executable_hook", path: hook.reference.split(/[:#]/)[0]!, original: hook.reference,
        reason: "executable content is proposed for separate review; never installed or run" });
  for (const tool of proposed.toolProposals)
    rewriter.unconverted.push({ code: tool.kind === "mcp_server" ? "mcp_server_proposal" : "tool_proposal", path: entry, original: tool.id,
      reason: "tool/MCP access requires a reviewed tool policy grant; the skill grants nothing" });
  const definition = validateSkill(bundle, { source: options.source, supportedCommands: options.supportedCommands });
  if (definition.skillId !== proposed.skillId) throw new Error("Converted skill identity mismatch");
  const report: SkillImportReport = {
    schemaVersion: 1,
    itemId,
    origin: item.origin,
    originalDigest: item.contentDigest,
    proposalDigest: proposal.digest,
    skillId: definition.skillId,
    version: definition.version,
    roles,
    providers: proposed.providers,
    bundleDigest: definition.digest,
    dependencies: options.dependencies,
    originals: item.files.map((file) => ({
      path: file.path, sha256: file.sha256, bytes: file.bytes,
      disposition: file.role === "instruction" ? "converted" : file.role === "resource" ? "copied" : "excluded",
    })),
    bundleFiles: Object.keys(bundle).sort(compareText).map((path) => ({ path, sha256: sha256(bundle[path]!) })),
    transformations: [...rewriter.transformations.values()],
    unconverted: rewriter.unconverted,
    toolProposals: proposed.toolProposals,
    executableHooks: proposed.executableHooks,
  };
  return { itemId, bundle, definition, originals: { ...files }, report };
}
