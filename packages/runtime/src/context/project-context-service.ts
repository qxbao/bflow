import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  AcceptanceCriterion,
  AgentRole,
  AgentRoleProfile,
  ArtifactReference,
  Specification
} from "@bflow/contracts";
import {
  AgentRoleProfileSchema,
  ArtifactReferenceSchema,
  SpecificationSchema
} from "@bflow/contracts";
import type { StructuredLogger } from "../resilience/structured-logger.js";
import type { ObservabilityTracker } from "../observability/metrics.js";
import { redactString, isSensitiveKey } from "../resilience/redaction.js";
import { runtimeGitDirectoryFlags } from "../agentic/patch-paths.js";

// --- Types & Interfaces ---

export interface ProjectContextServiceOptions {
  readonly repositoryRoot: string;
  readonly logger?: StructuredLogger | undefined;
  readonly observability?: ObservabilityTracker | undefined;
}

export interface WorkspacePackageSummary {
  readonly name: string;
  readonly relativePath: string;
  readonly packageJsonPath: string;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
  readonly entrypoints: readonly string[];
}

export interface AgentProfileSummary {
  readonly role: string;
  readonly directory: string;
  readonly roleProfilePath?: string | undefined;
  readonly promptPaths: readonly string[];
  readonly profile?: AgentRoleProfile | undefined;
}

export type RepositoryFileCategory =
  | "source"
  | "test"
  | "doc"
  | "adr"
  | "agent_instruction"
  | "config"
  | "other";

export interface RepositoryFileEntry {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly category: RepositoryFileCategory;
  readonly imports: readonly string[];
}

export interface RepositoryStructureAnalysis {
  readonly repositoryRoot: string;
  readonly analyzedAt: string;
  readonly structureFingerprint: string;
  readonly packages: readonly WorkspacePackageSummary[];
  readonly agentProfiles: readonly AgentProfileSummary[];
  readonly documentationFiles: readonly string[];
  readonly adrFiles: readonly string[];
  readonly files: readonly RepositoryFileEntry[];
}

export interface LoadedDocument {
  readonly relativePath: string;
  readonly content: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly category: "doc" | "agent_instruction" | "adr";
}

export interface AgentRoleInstructions {
  readonly role: AgentRole | string;
  readonly directory: string;
  readonly roleProfile?: AgentRoleProfile | undefined;
  readonly systemPrompt?: string | undefined;
  readonly prompt?: string | undefined;
  readonly readme?: string | undefined;
  readonly combinedInstructions: string;
  readonly sourceFiles: readonly string[];
  readonly contentSha256: string;
}

export interface ProjectDocumentationBundle {
  readonly documents: readonly LoadedDocument[];
  readonly agentInstructions: Readonly<Record<string, AgentRoleInstructions>>;
}

export interface ArchitecturalDecisionRecord {
  readonly decisionId: string;
  readonly title: string;
  readonly status: "proposed" | "accepted" | "superseded" | "deprecated";
  readonly summary: string;
  readonly rationale?: string | undefined;
  readonly consequences?: string | undefined;
  readonly affectedPaths: readonly string[];
  readonly sourcePath?: string | undefined;
  readonly recordedAt: string;
  readonly sha256: string;
}

export interface RecordDecisionInput {
  readonly decisionId: string;
  readonly title: string;
  readonly status: "proposed" | "accepted" | "superseded" | "deprecated";
  readonly summary: string;
  readonly rationale?: string | undefined;
  readonly consequences?: string | undefined;
  readonly affectedPaths: readonly string[];
  readonly sourcePath?: string | undefined;
  readonly recordedAt?: string | undefined;
}

export interface FindDecisionsQuery {
  readonly ownedPaths?: readonly string[] | undefined;
  readonly affectedPaths?: readonly string[] | undefined;
  readonly keywords?: readonly string[] | undefined;
}

export interface SelectTaskFilesQuery {
  readonly taskId: string;
  readonly role?: AgentRole | undefined;
  readonly title: string;
  readonly description: string;
  readonly ownedPaths: readonly string[];
  readonly affectedPaths: readonly string[];
  readonly acceptanceCriteria?: readonly (AcceptanceCriterion | string)[] | undefined;
  readonly maxFiles?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
  readonly maxBytesPerFile?: number | undefined;
}

export interface SelectedFileContent {
  readonly relativePath: string;
  readonly content: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly truncated: boolean;
  readonly score: number;
  readonly scoreTier: string;
}

export interface SelectedTaskFilesResult {
  readonly includedFiles: readonly SelectedFileContent[];
  readonly excludedMatchingFiles: readonly string[];
  readonly totalRepoFiles: number;
  readonly totalBytes: number;
}

export interface SpecificationVersionRecord {
  readonly specId: string;
  readonly version: number;
  readonly specFingerprint: string;
  readonly status: Specification["status"];
  readonly artifactRef?: ArtifactReference | undefined;
  readonly recordedAt: string;
  readonly previousVersion?: number | undefined;
  readonly spec: Specification;
}

export interface PrepareRoleContextRequest {
  /** Host launch already supplies canonical instructions; avoid duplicating them in survey attachments. */
  readonly includeRoleInstructions?: boolean | undefined;
  readonly role: AgentRole;
  readonly taskId?: string | undefined;
  readonly runId?: string | undefined;
  readonly title: string;
  readonly description: string;
  readonly ownedPaths: readonly string[];
  readonly affectedPaths: readonly string[];
  readonly specId?: string | undefined;
  readonly acceptanceCriteria?: readonly (AcceptanceCriterion | string)[] | undefined;
  readonly maxFiles?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
}

export interface SurveyRepositoryIdentity {
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly sourceRevision: string;
  readonly workingTreeState: "clean" | "dirty" | "unknown";
}

export interface RoleTaskContextBundle {
  readonly repositoryIdentity?: SurveyRepositoryIdentity | undefined;
  readonly baselineFiles?: readonly string[] | undefined;
  readonly role: AgentRole;
  readonly taskId?: string | undefined;
  readonly runId?: string | undefined;
  readonly specId?: string | undefined;
  readonly contextHash: string;
  readonly fileFingerprints: Readonly<Record<string, string>>;
  readonly specVersion?: number | undefined;
  readonly specFingerprint?: string | undefined;
  readonly totalBytes: number;
  readonly includedFiles: readonly string[];
  readonly excludedFileCount: number;
  readonly preparedAt: string;
  readonly formattedPromptContext: string;
  readonly adrSummaries: readonly { readonly id: string; readonly title: string; readonly status: string }[];
  readonly adrFingerprints?: Readonly<Record<string, string>> | undefined;
  readonly artifactReferences: readonly ArtifactReference[];
}

export interface ContextDriftReport {
  readonly drifted: boolean;
  readonly reasons: readonly string[];
  readonly modifiedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
  readonly addedOwnedFiles: readonly string[];
  readonly specVersionDrifted: boolean;
  readonly checkedAt: string;
}

// --- Constants & Helpers ---

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".bflow",
  ".agents",
  ".skillforge",
  "graphify-out",
  ".gitnexus",
  ".agy-staff",
  ".worktrees",
  "worktrees"
]);

const ROLE_TO_AGENT_DIR: Readonly<Record<string, string>> = {
  conversation: "agents/chat",
  specifier: "agents/analyst",
  architect: "agents/architect",
  coordinator: "agents/coordinator",
  qa: "agents/verifier",
  reviewer: "agents/reviewer",
  tester: "agents/verifier",
  developer: "agents/developer",
  planner: "agents/planner",
  security: "agents/security"
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "he", "in", "is", "it", "its", "of", "on", "or", "that",
  "the", "to", "was", "were", "will", "with", "this", "each", "some",
  "into", "have", "been", "must", "should", "could", "would"
]);

/**
 * Secret scrubbing to prevent secret tokens, private keys, or credentials
 * from leaking into agent prompt contexts. Delegates to centralized redactString.
 */
export function scrubSecrets(text: string): string {
  // Preserve source line anchors when replacing multiline private-key material.
  const lineStable = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    match => `[REDACTED]${"\n".repeat((match.match(/\n/g) ?? []).length)}`);
  return redactString(lineStable).replace(
    /(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1(\s*:\s*)(["'][^"'\r\n]*["']|[^\s,;{}\r\n]+)/g,
    (match: string, quote: string, key: string, separator: string, value: string) => {
      if (/^(?:authorization|proxy-authorization)$/i.test(key) && /^(?:Bearer|Basic)$/i.test(value)) return match;
      if (!isSensitiveKey(key)) return match;
      const valueQuote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
      return `${quote}${key}${quote}${separator}${valueQuote}[REDACTED]${valueQuote}`;
    }
  );
}

/**
 * Atomic file writing: writes to unique temp file, fsyncs, and atomically renames.
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const jsonStr = JSON.stringify(data, null, 2);
  const fileHandle = await fs.promises.open(tmpPath, "w");
  try {
    await fileHandle.writeFile(jsonStr, "utf8");
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
  await fs.promises.rename(tmpPath, filePath);
}

/**
 * Canonical JSON serialization for deterministic hashing.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const entries = keys.map((key) => {
    const val = (obj as Record<string, unknown>)[key];
    return `${JSON.stringify(key)}:${canonicalJson(val)}`;
  });
  return `{${entries.join(",")}}`;
}

/**
 * Lightweight static import extraction for TS/JS files.
 */
export function extractImports(text: string): readonly string[] {
  const imports = new Set<string>();
  const importExportRegex = /(?:import|export)\s+(?:(?:[\w\s{},*]+from\s+)?|(?:type\s+[\w\s{},*]+from\s+)?)\s*['"]([^'"]+)['"]/g;
  const callRegex = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = importExportRegex.exec(text)) !== null) {
    const specifier = match[1];
    if (specifier !== undefined && specifier.trim().length > 0) {
      imports.add(specifier.trim());
    }
  }
  while ((match = callRegex.exec(text)) !== null) {
    const specifier = match[1];
    if (specifier !== undefined && specifier.trim().length > 0) {
      imports.add(specifier.trim());
    }
  }
  return Array.from(imports).sort();
}

/**
 * Lightweight gitignore rule structure.
 */
interface GitignorePattern {
  readonly rawPattern: string;
  readonly regex: RegExp;
  readonly isNegative: boolean;
  readonly directoryOnly: boolean;
}

function parseGitignore(content: string): GitignorePattern[] {
  const lines = content.split(/\r?\n/);
  const patterns: GitignorePattern[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    let isNegative = false;
    let pattern = line;
    if (pattern.startsWith("!")) {
      isNegative = true;
      pattern = pattern.slice(1);
    }
    const directoryOnly = pattern.endsWith("/");
    if (directoryOnly) {
      pattern = pattern.slice(0, -1);
    }
    const rawPattern = pattern;
    const leadingSlash = pattern.startsWith("/");
    if (leadingSlash) {
      pattern = pattern.slice(1);
    }

    // Convert git glob pattern to RegExp:
    // * matches non-slash chars
    // ** matches anything
    // ? matches single non-slash char
    let regexStr = "";
    let i = 0;
    while (i < pattern.length) {
      const c = pattern[i];
      if (c === "*") {
        if (pattern[i + 1] === "*") {
          if (pattern[i + 2] === "/") {
            regexStr += "(?:.+/)?";
            i += 3;
            continue;
          } else {
            regexStr += ".*";
            i += 2;
            continue;
          }
        } else {
          regexStr += "[^/]*";
          i += 1;
          continue;
        }
      } else if (c === "?") {
        regexStr += "[^/]";
        i += 1;
        continue;
      } else if (c === "." || c === "+" || c === "^" || c === "$" || c === "(" || c === ")" || c === "[" || c === "]" || c === "{" || c === "}") {
        regexStr += `\\${c}`;
        i += 1;
      } else {
        regexStr += c;
        i += 1;
      }
    }

    if (leadingSlash) {
      regexStr = `^${regexStr}(?:$|/)`;
    } else {
      regexStr = `(?:^|/)${regexStr}(?:$|/)`;
    }

    try {
      patterns.push({
        rawPattern,
        regex: new RegExp(regexStr),
        isNegative,
        directoryOnly
      });
    } catch {
      // Ignore invalid regex
    }
  }
  return patterns;
}

function matchesGitignore(
  normalizedRelativePath: string,
  isDirectory: boolean,
  patterns: readonly GitignorePattern[]
): boolean {
  if (isDirectory) {
    // If a negative rule matches or is inside this directory, do not prune directory
    for (const pattern of patterns) {
      if (
        pattern.isNegative &&
        (pattern.rawPattern === normalizedRelativePath || pattern.rawPattern.startsWith(`${normalizedRelativePath}/`))
      ) {
        return false;
      }
    }
  }

  let ignored = false;
  const pathToCheck = isDirectory ? `${normalizedRelativePath}/` : normalizedRelativePath;
  for (const pattern of patterns) {
    if (pattern.directoryOnly && !isDirectory) {
      // If rule is directory-only (e.g. temp/), it matches any file inside that directory
      if (pattern.regex.test(pathToCheck) && normalizedRelativePath !== pattern.rawPattern) {
        ignored = !pattern.isNegative;
      }
    } else {
      if (pattern.regex.test(pathToCheck)) {
        ignored = !pattern.isNegative;
      }
    }
  }
  return ignored;
}

function categorizeFile(relPath: string): RepositoryFileCategory {
  const norm = relPath.replace(/\\/g, "/");
  if (norm.startsWith("docs/adr/") && norm.endsWith(".md")) {
    return "adr";
  }
  if (norm.startsWith("agents/") && (norm.endsWith(".md") || norm.endsWith(".json"))) {
    return "agent_instruction";
  }
  if (norm.endsWith(".md") || norm.endsWith(".txt") || norm.endsWith(".rst")) {
    return "doc";
  }
  if (
    norm.includes("/test/") ||
    norm.includes("/tests/") ||
    norm.includes("/__tests__/") ||
    norm.endsWith(".test.ts") ||
    norm.endsWith(".spec.ts") ||
    norm.endsWith(".test.js") ||
    norm.endsWith(".spec.js")
  ) {
    return "test";
  }
  const basename = path.basename(norm);
  if (
    basename === "package.json" ||
    basename.startsWith("tsconfig") ||
    basename.startsWith("vitest.config") ||
    basename.startsWith("pnpm-") ||
    basename === ".gitignore" ||
    basename.startsWith("eslint")
  ) {
    return "config";
  }
  if (
    norm.endsWith(".ts") ||
    norm.endsWith(".tsx") ||
    norm.endsWith(".js") ||
    norm.endsWith(".jsx") ||
    norm.endsWith(".mjs") ||
    norm.endsWith(".cjs") ||
    norm.endsWith(".py") ||
    norm.endsWith(".rs") ||
    norm.endsWith(".go") ||
    norm.endsWith(".json")
  ) {
    return "source";
  }
  return "other";
}

/** Sensitive files are excluded before reading, including aliases resolved at read time. */
function isSensitivePath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some(part =>
    /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.ssh|\.aws|\.azure|\.gnupg|id_(?:rsa|dsa|ed25519|ecdsa)(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(part) ||
    /\.(?:pem|key|p12|pfx|keystore|secret|token|credentials)$/i.test(part));
}

const executeFile = promisify(execFile);

async function identifyRepository(repositoryRoot: string): Promise<SurveyRepositoryIdentity> {
  const realRoot = await fs.promises.realpath(repositoryRoot);
  // Inherited Git routing/configuration must never redirect the survey to another worktree.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SYSTEMROOT: process.env.SYSTEMROOT,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1"
  };
  const dirFlags = await runtimeGitDirectoryFlags(realRoot, { resetSafeDirectory: true });
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await executeFile("git", ["-C", realRoot, ...dirFlags,
      "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null",
      "-c", "core.pager=cat", "-c", "diff.external=", ...args], {
      env, encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024
    });
    return stdout.trim();
  };
  try {
    const worktreeRoot = await fs.promises.realpath(await git(["rev-parse", "--show-toplevel"]));
    if (worktreeRoot !== realRoot) throw new Error("Survey root is not the Git worktree root");
    const sourceRevision = await git(["rev-parse", "--verify", "HEAD"]);
    // Like repository_read, never compare working files through repository-controlled
    // clean/process filters. Keep the independently observed HEAD, but leave dirtiness unknown.
    const configKeys = await git(["config", "--includes", "--name-only", "--list"]);
    if (configKeys.split(/\r?\n/).some(key => /^filter\..+\.(?:clean|smudge|process)$/i.test(key))) {
      return { repositoryRoot: realRoot, worktreeRoot, sourceRevision, workingTreeState: "unknown" };
    }
    return { repositoryRoot: realRoot, worktreeRoot, sourceRevision,
      workingTreeState: (await git(["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=all"])).length > 0 ? "dirty" : "clean" };
  } catch {
    return { repositoryRoot: realRoot, worktreeRoot: realRoot, sourceRevision: "unknown", workingTreeState: "unknown" };
  }
}

/** Read repository content through a confined regular-file descriptor. */
async function readRepositoryFile(repositoryRoot: string, fullPath: string): Promise<Buffer> {
  const rootReal = await fs.promises.realpath(repositoryRoot);
  // Relative to the caller's root spelling: a symlinked ancestor of the root (e.g. macOS /var → /private/var) is not repository content.
  const lexicalRelative = path.relative(path.resolve(repositoryRoot), path.resolve(fullPath));
  if (lexicalRelative === "" || lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw new Error("Path escapes repository root");
  }
  if (isSensitivePath(lexicalRelative)) throw new Error("Sensitive repository file excluded");
  // Reject symlink components and nested repositories/worktrees even when inside the root.
  let current = rootReal;
  const components = lexicalRelative.split(path.sep);
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i] ?? "");
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Symlink repository content excluded");
    if (i < components.length - 1 && fs.existsSync(path.join(current, ".git"))) {
      throw new Error("Nested repository content excluded");
    }
  }
  const realPath = await fs.promises.realpath(fullPath);
  const relative = path.relative(rootReal, realPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Path escapes repository root");
  }
  const file = await fs.promises.open(realPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile()) throw new Error("Repository content must be a regular file");
    const currentPath = await fs.promises.realpath(fullPath);
    const current = await fs.promises.stat(currentPath);
    if (currentPath !== realPath || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("Repository file changed during open");
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

// --- Architectural Decision Store ---

export class ArchitecturalDecisionStore {
  private readonly repositoryRoot: string;
  private readonly stateFile: string;

  constructor(repositoryRoot: string) {
    this.repositoryRoot = path.resolve(repositoryRoot);
    this.stateFile = path.join(this.repositoryRoot, ".bflow", "state", "context", "decisions.json");
  }

  public async parseRepoAdrs(): Promise<readonly ArchitecturalDecisionRecord[]> {
    const adrDir = path.join(this.repositoryRoot, "docs", "adr");
    const records: ArchitecturalDecisionRecord[] = [];
    try {
      const entries = await fs.promises.readdir(adrDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) {
          continue;
        }
        const fullPath = path.join(adrDir, entry.name);
        const relPath = path.relative(this.repositoryRoot, fullPath).replace(/\\/g, "/");
        const content = (await readRepositoryFile(this.repositoryRoot, fullPath)).toString("utf8");
        const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");

        const parsed = this.parseAdrContent(content, relPath, sha256);
        if (parsed !== undefined) {
          records.push(parsed);
        }
      }
    } catch {
      // docs/adr directory might not exist yet
    }
    return records.sort((a, b) => a.decisionId.localeCompare(b.decisionId));
  }

  private parseAdrContent(content: string, relPath: string, sha256: string): ArchitecturalDecisionRecord | undefined {
    const lines = content.split(/\r?\n/);
    let titleLine = "";
    let status: ArchitecturalDecisionRecord["status"] = "accepted";
    let summary = "";
    let rationale: string | undefined = undefined;
    let consequences: string | undefined = undefined;
    const affectedPaths: string[] = [];

    let currentSection: "none" | "context" | "decision" | "consequences" = "none";
    const contextLines: string[] = [];
    const decisionLines: string[] = [];
    const consequencesLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("# ") && titleLine.length === 0) {
        titleLine = line.slice(2).trim();
        continue;
      }
      const statusMatch = line.match(/^[-*]\s*Status:\s*(.+)$/i);
      if (statusMatch?.[1] !== undefined) {
        const rawStatus = statusMatch[1].toLowerCase();
        if (rawStatus.includes("superseded")) {
          status = "superseded";
        } else if (rawStatus.includes("deprecated")) {
          status = "deprecated";
        } else if (rawStatus.includes("proposed")) {
          status = "proposed";
        } else {
          status = "accepted";
        }
        continue;
      }
      if (line.startsWith("## Context") || line.startsWith("## Summary")) {
        currentSection = "context";
        continue;
      }
      if (line.startsWith("## Decision")) {
        currentSection = "decision";
        continue;
      }
      if (line.startsWith("## Consequences") || line.startsWith("## Compatibility")) {
        currentSection = "consequences";
        continue;
      }
      if (line.startsWith("## ")) {
        currentSection = "none";
        continue;
      }

      if (currentSection === "context") {
        contextLines.push(line);
      } else if (currentSection === "decision") {
        decisionLines.push(line);
      } else if (currentSection === "consequences") {
        consequencesLines.push(line);
      }

      // Extract affected paths from table or backticks
      const pathMatches = line.matchAll(/`([^`]+\.[a-zA-Z0-9]+)`/g);
      for (const m of pathMatches) {
        const candidate = m[1];
        if (candidate !== undefined && (candidate.includes("/") || candidate.endsWith(".ts") || candidate.endsWith(".md"))) {
          if (!affectedPaths.includes(candidate)) {
            affectedPaths.push(candidate);
          }
        }
      }
    }

    if (titleLine.length === 0) {
      return undefined;
    }

    // Parse ID and Title from `# ADR 0001: Harden contracts` or `# 0001: Harden contracts`
    const idMatch = titleLine.match(/^(?:ADR\s+)?([0-9A-Za-z_-]+)[:\s]+(.*)$/i);
    let decisionId: string;
    let title: string;
    if (idMatch?.[1] !== undefined && idMatch[2] !== undefined) {
      const rawId = idMatch[1];
      decisionId = rawId.toUpperCase().startsWith("ADR") ? rawId : `ADR-${rawId}`;
      title = idMatch[2].trim();
    } else {
      decisionId = path.basename(relPath, ".md");
      title = titleLine;
    }

    summary = contextLines.join("\n").trim();
    if (summary.length === 0) {
      summary = title;
    }
    const decText = decisionLines.join("\n").trim();
    if (decText.length > 0) {
      rationale = decText;
    }
    const conText = consequencesLines.join("\n").trim();
    if (conText.length > 0) {
      consequences = conText;
    }

    return {
      decisionId,
      title,
      status,
      summary,
      ...(rationale !== undefined ? { rationale } : {}),
      ...(consequences !== undefined ? { consequences } : {}),
      affectedPaths,
      sourcePath: relPath,
      recordedAt: new Date().toISOString(),
      sha256
    };
  }

  public async recordDecision(input: RecordDecisionInput): Promise<ArchitecturalDecisionRecord> {
    const existing = await this.listPersistedDecisions();
    const sha256 = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          id: input.decisionId,
          title: input.title,
          status: input.status,
          summary: input.summary,
          affectedPaths: input.affectedPaths
        }),
        "utf8"
      )
      .digest("hex");

    const record: ArchitecturalDecisionRecord = {
      decisionId: input.decisionId,
      title: input.title,
      status: input.status,
      summary: input.summary,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...(input.consequences !== undefined ? { consequences: input.consequences } : {}),
      affectedPaths: [...input.affectedPaths],
      ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
      recordedAt: input.recordedAt ?? new Date().toISOString(),
      sha256
    };

    const updated = existing.filter((d) => d.decisionId !== record.decisionId);
    updated.push(record);
    updated.sort((a, b) => a.decisionId.localeCompare(b.decisionId));

    await atomicWriteJson(this.stateFile, updated);
    return record;
  }

  private async listPersistedDecisions(): Promise<ArchitecturalDecisionRecord[]> {
    try {
      const content = (await readRepositoryFile(this.repositoryRoot, this.stateFile)).toString("utf8");
      return z.array(z.object({
        decisionId: z.string(), title: z.string(), status: z.enum(["proposed", "accepted", "superseded", "deprecated"]),
        summary: z.string(), rationale: z.string().optional(), consequences: z.string().optional(),
        affectedPaths: z.array(z.string()), sourcePath: z.string().optional(), recordedAt: z.string(), sha256: z.string()
      }).strict()).parse(JSON.parse(content));
    } catch {
      // Return empty if file does not exist
    }
    return [];
  }

  public async listDecisions(): Promise<readonly ArchitecturalDecisionRecord[]> {
    const repoAdrs = await this.parseRepoAdrs();
    const persisted = await this.listPersistedDecisions();

    const decisionMap = new Map<string, ArchitecturalDecisionRecord>();
    for (const adr of repoAdrs) {
      decisionMap.set(adr.decisionId, adr);
    }
    for (const record of persisted) {
      decisionMap.set(record.decisionId, record);
    }

    return Array.from(decisionMap.values()).sort((a, b) => a.decisionId.localeCompare(b.decisionId));
  }

  public async findDecisionsForTask(query: FindDecisionsQuery): Promise<readonly ArchitecturalDecisionRecord[]> {
    const all = await this.listDecisions();
    const owned = (query.ownedPaths ?? []).map((p) => p.replace(/\\/g, "/"));
    const affected = (query.affectedPaths ?? []).map((p) => p.replace(/\\/g, "/"));
    const targetPaths = [...owned, ...affected];
    const keywords = (query.keywords ?? []).map((k) => k.toLowerCase().trim()).filter((k) => k.length > 0);

    return all.filter((decision) => {
      // Path match
      for (const decPath of decision.affectedPaths) {
        const normDecPath = decPath.replace(/\\/g, "/");
        for (const target of targetPaths) {
          if (
            normDecPath === target ||
            normDecPath.startsWith(`${target}/`) ||
            target.startsWith(`${normDecPath}/`) ||
            path.basename(normDecPath) === path.basename(target)
          ) {
            return true;
          }
        }
      }
      // Keyword match
      if (keywords.length > 0) {
        const textToSearch = `${decision.title} ${decision.summary} ${decision.rationale ?? ""} ${decision.consequences ?? ""}`.toLowerCase();
        for (const kw of keywords) {
          if (textToSearch.includes(kw)) {
            return true;
          }
        }
      }
      return false;
    });
  }
}

// --- Specification & Artifact Version Manager ---

export class SpecArtifactVersionManager {
  private readonly repositoryRoot: string;
  private readonly specVersionsFile: string;
  private readonly artifactsFile: string;

  constructor(repositoryRoot: string) {
    this.repositoryRoot = path.resolve(repositoryRoot);
    this.specVersionsFile = path.join(this.repositoryRoot, ".bflow", "state", "context", "spec-versions.json");
    this.artifactsFile = path.join(this.repositoryRoot, ".bflow", "state", "context", "artifacts.json");
  }

  public async registerSpecification(specInput: Specification): Promise<SpecificationVersionRecord> {
    const spec = SpecificationSchema.parse(specInput);
    const specFingerprint = crypto
      .createHash("sha256")
      .update(canonicalJson(spec), "utf8")
      .digest("hex");
    const version = spec.version ?? 1;

    const allRecords = await this.loadSpecVersions();
    const history = allRecords.filter((r) => r.specId === spec.specId).sort((a, b) => a.version - b.version);
    const latest = history[history.length - 1];
    if (latest !== undefined && version < latest.version) {
      throw new Error(
        `Version regression: cannot register version ${version} after version ${latest.version} for specId "${spec.specId}".`
      );
    }

    const existingSameVersion = history.find((r) => r.version === version);
    if (existingSameVersion !== undefined) {
      if (existingSameVersion.specFingerprint === specFingerprint) {
        return existingSameVersion;
      }
      throw new Error(
        `Conflicting specification content for specId "${spec.specId}" version ${version}. Content fingerprint does not match previously registered version.`
      );
    }

    const record: SpecificationVersionRecord = {
      specId: spec.specId,
      version,
      specFingerprint,
      status: spec.status,
      ...(spec.artifactRef !== undefined ? { artifactRef: spec.artifactRef } : {}),
      recordedAt: new Date().toISOString(),
      ...(latest !== undefined ? { previousVersion: latest.version } : {}),
      spec
    };

    allRecords.push(record);
    await atomicWriteJson(this.specVersionsFile, allRecords);
    return record;
  }

  public async getLatestSpecification(specId: string): Promise<Specification | null> {
    const all = await this.loadSpecVersions();
    const history = all.filter((r) => r.specId === specId).sort((a, b) => b.version - a.version);
    const latest = history[0];
    return latest !== undefined ? latest.spec : null;
  }

  public async getSpecificationHistory(specId: string): Promise<readonly SpecificationVersionRecord[]> {
    const all = await this.loadSpecVersions();
    return all.filter((r) => r.specId === specId).sort((a, b) => a.version - b.version);
  }

  public async registerArtifact(taskOrRunId: string, artifactInput: ArtifactReference): Promise<void> {
    const artifact = ArtifactReferenceSchema.parse(artifactInput);
    const map = await this.loadArtifactsMap();
    const existing = map[taskOrRunId] ?? [];
    if (!existing.some((a) => a.artifactId === artifact.artifactId)) {
      map[taskOrRunId] = [...existing, artifact];
      await atomicWriteJson(this.artifactsFile, map);
    }
  }

  public async getArtifactsForTask(taskOrRunId: string): Promise<readonly ArtifactReference[]> {
    const map = await this.loadArtifactsMap();
    return map[taskOrRunId] ?? [];
  }

  private async loadSpecVersions(): Promise<SpecificationVersionRecord[]> {
    try {
      const content = (await readRepositoryFile(this.repositoryRoot, this.specVersionsFile)).toString("utf8");
      return z.array(z.object({
        specId: z.string(), version: z.number().int().positive(), specFingerprint: z.string(),
        status: z.enum(["draft", "review_pending", "approved", "superseded", "rejected"]), artifactRef: ArtifactReferenceSchema.optional(),
        recordedAt: z.string(), previousVersion: z.number().int().positive().optional(), spec: SpecificationSchema
      }).strict()).parse(JSON.parse(content)).filter(record => record.specId === record.spec.specId &&
        record.version === (record.spec.version ?? 1) && record.status === record.spec.status &&
        record.specFingerprint === crypto.createHash("sha256").update(canonicalJson(record.spec), "utf8").digest("hex"));
    } catch {
      // Empty
    }
    return [];
  }

  private async loadArtifactsMap(): Promise<Record<string, ArtifactReference[]>> {
    try {
      const content = (await readRepositoryFile(this.repositoryRoot, this.artifactsFile)).toString("utf8");
      return z.record(z.array(ArtifactReferenceSchema)).parse(JSON.parse(content));
    } catch {
      // Empty
    }
    return {};
  }
}

// --- Main Project Context Service ---

export class ProjectContextService {
  public readonly repositoryRoot: string;
  public readonly adrStore: ArchitecturalDecisionStore;
  public readonly versionManager: SpecArtifactVersionManager;
  private readonly logger?: StructuredLogger | undefined;
  private readonly observability?: ObservabilityTracker | undefined;
  private cachedAnalysis: RepositoryStructureAnalysis | null = null;

  constructor(repositoryRootOrOptions: string | ProjectContextServiceOptions) {
    if (typeof repositoryRootOrOptions === "string") {
      this.repositoryRoot = path.resolve(repositoryRootOrOptions);
    } else {
      this.repositoryRoot = path.resolve(repositoryRootOrOptions.repositoryRoot);
      this.logger = repositoryRootOrOptions.logger;
      this.observability = repositoryRootOrOptions.observability;
    }
    this.adrStore = new ArchitecturalDecisionStore(this.repositoryRoot);
    this.versionManager = new SpecArtifactVersionManager(this.repositoryRoot);
  }

  /**
   * Deterministically analyzes repository structure, respecting .gitignore,
   * excluding generated/internal directories, rejecting escaping symlinks or special files.
   */
  public async analyzeRepositoryStructure(options?: {
    readonly forceReanalysis?: boolean | undefined;
  }): Promise<RepositoryStructureAnalysis> {
    if (this.cachedAnalysis !== null && options?.forceReanalysis !== true) {
      return this.cachedAnalysis;
    }

    let gitignorePatterns: GitignorePattern[] = [];
    const gitignorePath = path.join(this.repositoryRoot, ".gitignore");
    try {
      const gitignoreContent = (await readRepositoryFile(this.repositoryRoot, gitignorePath)).toString("utf8");
      gitignorePatterns = parseGitignore(gitignoreContent);
    } catch {
      // No .gitignore present
    }

    const files: RepositoryFileEntry[] = [];
    const packages: WorkspacePackageSummary[] = [];
    const documentationFiles: string[] = [];
    const adrFiles: string[] = [];

    const rootReal = await fs.promises.realpath(this.repositoryRoot);
    const visitedRealDirs = new Set<string>([rootReal]);

    const walk = async (currentDir: string): Promise<void> => {
      let dirents: fs.Dirent[];
      try {
        dirents = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      dirents.sort((a, b) => a.name.localeCompare(b.name));

      for (const dirent of dirents) {
        const fullPath = path.join(currentDir, dirent.name);
        const relPath = path.relative(this.repositoryRoot, fullPath).replace(/\\/g, "/");

        if (isSensitivePath(relPath)) continue;
        if (dirent.isDirectory() && fs.existsSync(path.join(fullPath, ".git"))) continue;

        // Hardcoded excluded directories
        if (DEFAULT_IGNORED_DIRS.has(dirent.name)) {
          continue;
        }

        // Gitignore check
        if (matchesGitignore(relPath, dirent.isDirectory(), gitignorePatterns)) {
          continue;
        }

        // Symlink and special file safety checks
        let isFile = false;
        let isDir = false;
        try {
          const lstat = await fs.promises.lstat(fullPath);
          if (lstat.isSymbolicLink()) {
            continue;
          } else if (lstat.isFIFO() || lstat.isSocket() || lstat.isBlockDevice() || lstat.isCharacterDevice()) {
            // Reject special files
            continue;
          } else {
            isDir = lstat.isDirectory();
            isFile = lstat.isFile();
          }
        } catch {
          continue;
        }

        if (isDir) {
          const realFull = await fs.promises.realpath(fullPath);
          if (visitedRealDirs.has(realFull)) {
            continue;
          }
          visitedRealDirs.add(realFull);
          await walk(fullPath);
        } else if (isFile) {
          let buffer: Buffer;
          try {
            buffer = await readRepositoryFile(this.repositoryRoot, fullPath);
          } catch {
            continue;
          }
          if (buffer.includes(0)) continue;
          const sizeBytes = buffer.byteLength;
          const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
          const category = categorizeFile(relPath);

          let imports: readonly string[] = [];
          if (
            relPath.endsWith(".ts") ||
            relPath.endsWith(".tsx") ||
            relPath.endsWith(".js") ||
            relPath.endsWith(".jsx") ||
            relPath.endsWith(".mjs") ||
            relPath.endsWith(".cjs")
          ) {
            try {
              const text = buffer.toString("utf8");
              imports = extractImports(text);
            } catch {
              // Ignore parse error
            }
          }

          if (category === "doc") {
            documentationFiles.push(relPath);
          } else if (category === "adr") {
            adrFiles.push(relPath);
            documentationFiles.push(relPath);
          }

          if (path.basename(relPath) === "package.json") {
            const pkgSummary = this.parsePackageJson(relPath, buffer);
            if (pkgSummary !== undefined) {
              packages.push(pkgSummary);
            }
          }

          files.push({
            relativePath: relPath,
            sizeBytes,
            sha256,
            category,
            imports
          });
        }
      }
    };

    await walk(this.repositoryRoot);

    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    packages.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    documentationFiles.sort();
    adrFiles.sort();

    const structureFingerprint = crypto
      .createHash("sha256")
      .update(files.map((f) => `${f.relativePath}:${f.sha256}`).join("\n"), "utf8")
      .digest("hex");

    const agentProfiles = await this.discoverAgentProfiles();

    const analysis: RepositoryStructureAnalysis = {
      repositoryRoot: this.repositoryRoot,
      analyzedAt: new Date().toISOString(),
      structureFingerprint,
      packages,
      agentProfiles,
      documentationFiles,
      adrFiles,
      files
    };

    this.cachedAnalysis = analysis;
    return analysis;
  }

  private parsePackageJson(relPath: string, buffer: Buffer): WorkspacePackageSummary | undefined {
    try {
      const parsed = JSON.parse(buffer.toString("utf8")) as Record<string, unknown>;
      const pkgDir = path.dirname(relPath).replace(/\\/g, "/");
      const name = typeof parsed["name"] === "string" ? parsed["name"] : path.basename(pkgDir);
      const dependencies = typeof parsed["dependencies"] === "object" && parsed["dependencies"] !== null
        ? Object.keys(parsed["dependencies"]).sort()
        : [];
      const devDependencies = typeof parsed["devDependencies"] === "object" && parsed["devDependencies"] !== null
        ? Object.keys(parsed["devDependencies"]).sort()
        : [];

      const entrypoints = new Set<string>();
      if (typeof parsed["main"] === "string") entrypoints.add(parsed["main"]);
      if (typeof parsed["module"] === "string") entrypoints.add(parsed["module"]);
      if (typeof parsed["types"] === "string") entrypoints.add(parsed["types"]);
      if (typeof parsed["exports"] === "object" && parsed["exports"] !== null) {
        const exportsObj = parsed["exports"] as Record<string, unknown>;
        for (const [key, val] of Object.entries(exportsObj)) {
          if (typeof val === "string") {
            entrypoints.add(val);
          } else if (typeof val === "object" && val !== null) {
            for (const subVal of Object.values(val as Record<string, unknown>)) {
              if (typeof subVal === "string") entrypoints.add(subVal);
            }
          } else {
            entrypoints.add(key);
          }
        }
      }

      return {
        name,
        relativePath: pkgDir === "" ? "." : pkgDir,
        packageJsonPath: relPath,
        dependencies,
        devDependencies,
        entrypoints: Array.from(entrypoints).sort()
      };
    } catch {
      return undefined;
    }
  }

  private async discoverAgentProfiles(): Promise<readonly AgentProfileSummary[]> {
    const agentsDir = path.join(this.repositoryRoot, "agents");
    const profiles: AgentProfileSummary[] = [];
    try {
      const dirents = await fs.promises.readdir(agentsDir, { withFileTypes: true });
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        const agentFolder = path.join(agentsDir, dirent.name);
        const relDir = path.relative(this.repositoryRoot, agentFolder).replace(/\\/g, "/");

        const promptPaths: string[] = [];
        let role = dirent.name;
        let roleProfile: AgentRoleProfile | undefined = undefined;
        let roleProfilePath: string | undefined = undefined;

        const files = await fs.promises.readdir(agentFolder, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile()) continue;
          const fRel = `${relDir}/${f.name}`;
          if (f.name === "role-profile.json") {
            roleProfilePath = fRel;
            try {
              const content = (await readRepositoryFile(this.repositoryRoot, path.join(agentFolder, f.name))).toString("utf8");
              const parsed = JSON.parse(content);
              const validated = AgentRoleProfileSchema.safeParse(parsed);
              if (validated.success) {
                roleProfile = validated.data;
                role = validated.data.role;
              }
            } catch {
              // Ignore invalid JSON
            }
          } else if (f.name.endsWith(".md")) {
            promptPaths.push(fRel);
          }
        }

        promptPaths.sort();
        profiles.push({
          role,
          directory: relDir,
          ...(roleProfilePath !== undefined ? { roleProfilePath } : {}),
          promptPaths,
          ...(roleProfile !== undefined ? { profile: roleProfile } : {})
        });
      }
    } catch {
      // agents directory may not exist
    }
    return profiles.sort((a, b) => a.directory.localeCompare(b.directory));
  }

  /**
   * Reads project documentation and agent role instructions.
   */
  public async loadProjectDocumentation(): Promise<ProjectDocumentationBundle> {
    const analysis = await this.analyzeRepositoryStructure();
    const documents: LoadedDocument[] = [];
    const agentInstructions: Record<string, AgentRoleInstructions> = {};

    // Load documentation files
    for (const relPath of analysis.documentationFiles) {
      const fullPath = path.join(this.repositoryRoot, relPath);
      try {
        const content = (await readRepositoryFile(this.repositoryRoot, fullPath)).toString("utf8");
        const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
        documents.push({
          relativePath: relPath,
          content,
          sizeBytes: Buffer.byteLength(content, "utf8"),
          sha256,
          category: relPath.startsWith("docs/adr/") ? "adr" : "doc"
        });
      } catch {
        // Skip unreadable
      }
    }

    // Load agent profiles and instructions
    for (const profileSummary of analysis.agentProfiles) {
      const sourceFiles: string[] = [];
      let systemPrompt: string | undefined = undefined;
      let prompt: string | undefined = undefined;
      let readme: string | undefined = undefined;

      for (const promptFile of profileSummary.promptPaths) {
        const fullPath = path.join(this.repositoryRoot, promptFile);
        try {
          const content = (await readRepositoryFile(this.repositoryRoot, fullPath)).toString("utf8");
          const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
          documents.push({
            relativePath: promptFile,
            content,
            sizeBytes: Buffer.byteLength(content, "utf8"),
            sha256,
            category: "agent_instruction"
          });
          sourceFiles.push(promptFile);

          if (promptFile.endsWith("system-prompt.md")) {
            systemPrompt = content;
          } else if (promptFile.endsWith("prompt.md")) {
            prompt = content;
          } else if (promptFile.endsWith("README.md")) {
            readme = content;
          }
        } catch {
          // Skip unreadable
        }
      }

      if (profileSummary.roleProfilePath !== undefined) {
        sourceFiles.push(profileSummary.roleProfilePath);
      }

      const combinedText = [systemPrompt, prompt, readme].filter((t) => typeof t === "string" && t.trim().length > 0).join("\n\n---\n\n");
      const contentSha256 = crypto.createHash("sha256").update(combinedText, "utf8").digest("hex");

      const instructionSummary: AgentRoleInstructions = {
        role: profileSummary.role,
        directory: profileSummary.directory,
        ...(profileSummary.profile !== undefined ? { roleProfile: profileSummary.profile } : {}),
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(readme !== undefined ? { readme } : {}),
        combinedInstructions: combinedText,
        sourceFiles: sourceFiles.sort(),
        contentSha256
      };

      agentInstructions[profileSummary.role] = instructionSummary;
    }

    return {
      documents,
      agentInstructions
    };
  }

  /**
   * Looks up instructions for a specific AgentRole with canonical mappings.
   */
  public async getAgentRoleInstructions(role: AgentRole): Promise<AgentRoleInstructions | undefined> {
    const docs = await this.loadProjectDocumentation();
    if (docs.agentInstructions[role] !== undefined) {
      return docs.agentInstructions[role];
    }
    const mappedDir = ROLE_TO_AGENT_DIR[role];
    if (mappedDir !== undefined) {
      for (const instr of Object.values(docs.agentInstructions)) {
        if (instr.directory === mappedDir) {
          return instr;
        }
      }
      if (mappedDir === "agents/reviewer" || mappedDir === "agents/security") {
        for (const instr of Object.values(docs.agentInstructions)) {
          if (instr.directory === "agents/verifier") {
            return instr;
          }
        }
        if (docs.agentInstructions["verifier"] !== undefined) {
          return docs.agentInstructions["verifier"];
        }
        if (docs.agentInstructions["qa"] !== undefined) {
          return docs.agentInstructions["qa"];
        }
      }
    }
    return undefined;
  }

  /**
   * Deterministic Task-Relevant File Selection (NO Vector DB)
   * Enforces 6 deterministic tiers and strict file/byte budgets.
   */
  public async selectFilesForTask(query: SelectTaskFilesQuery): Promise<SelectedTaskFilesResult> {
    const analysis = await this.analyzeRepositoryStructure();
    const maxFiles = query.maxFiles ?? 15;
    const maxTotalBytes = query.maxTotalBytes ?? 64_000;
    const maxBytesPerFile = query.maxBytesPerFile ?? 16_000;

    const normalizeScope = (value: string): string => {
      const normalized = value.replace(/\\/g, "/").replace(/\/\*\*$/, "").replace(/\/$/, "");
      if (path.isAbsolute(normalized) || normalized.split("/").includes("..") || isSensitivePath(normalized)) {
        throw new Error("Unsafe survey scope");
      }
      return normalized;
    };
    const normOwned = query.ownedPaths.map(normalizeScope);
    const normAffected = query.affectedPaths.map(normalizeScope);

    // Prepare token search terms for Tier 6
    const queryTokens = new Set<string>();
    const extractTokens = (text: string): void => {
      const words = text.toLowerCase().split(/[^a-z0-9_-]+/);
      for (const w of words) {
        if (w.length >= 3 && !STOP_WORDS.has(w)) {
          queryTokens.add(w);
        }
      }
    };
    extractTokens(query.title);
    extractTokens(query.description);
    if (query.acceptanceCriteria !== undefined) {
      for (const crit of query.acceptanceCriteria) {
        if (typeof crit === "string") {
          extractTokens(crit);
        } else {
          extractTokens(crit.description);
        }
      }
    }

    // Step 1: Identify Tier 1 & Tier 2 files
    const scoredMap = new Map<string, { score: number; scoreTier: string }>();

    for (const file of analysis.files) {
      const p = file.relativePath;
      let matchedTier1 = false;
      for (const owned of normOwned) {
        if (owned === "." || p === owned || p.startsWith(`${owned}/`)) {
          scoredMap.set(p, { score: 100, scoreTier: "Tier 1: Owned" });
          matchedTier1 = true;
          break;
        }
      }
      if (matchedTier1) continue;

      for (const aff of normAffected) {
        if (aff === "." || p === aff || p.startsWith(`${aff}/`)) {
          scoredMap.set(p, { score: 80, scoreTier: "Tier 2: Affected" });
          break;
        }
      }
    }

    const tier1And2Paths = new Set(scoredMap.keys());

    // Step 2: Tier 3 (1-hop static import/export neighbors)
    // Resolve relative imports of Tier 1/2 files and find files importing Tier 1/2 files
    const fileLookup = new Map<string, RepositoryFileEntry>();
    for (const file of analysis.files) {
      fileLookup.set(file.relativePath, file);
    }

    const workspaceTargets = (specifier: string): string[] => {
      const pkg = analysis.packages.find(candidate => specifier === candidate.name || specifier.startsWith(`${candidate.name}/`));
      if (pkg === undefined) return [];
      const subpath = specifier.slice(pkg.name.length).replace(/^\//, "");
      const entries = subpath.length > 0 ? [subpath] : [...pkg.entrypoints, "src/index.ts", "index.ts"];
      return entries.flatMap(entry => {
        const base = path.posix.join(pkg.relativePath, entry.replace(/^\.\//, "").replace(/^dist\//, "src/"));
        return [base, base.replace(/\.js$/, ".ts"), base.replace(/\.d\.ts$/, ".ts"), `${base}.ts`, `${base}/index.ts`];
      }).filter(candidate => fileLookup.has(candidate));
    };

    for (const seedPath of tier1And2Paths) {
      const seedFile = fileLookup.get(seedPath);
      if (seedFile === undefined) continue;

      // Forward imports: files that seed imports
      for (const imp of seedFile.imports) {
        for (const target of workspaceTargets(imp)) {
          if (!scoredMap.has(target)) scoredMap.set(target, { score: 60, scoreTier: "Tier 3: Neighbor (workspace import)" });
        }
        if (imp.startsWith(".")) {
          const resolvedBase = path.normalize(path.join(path.dirname(seedPath), imp)).replace(/\\/g, "/");
          const candidates = [
            resolvedBase,
            `${resolvedBase}.ts`,
            `${resolvedBase}.js`,
            resolvedBase.replace(/\.js$/, ".ts"),
            `${resolvedBase}/index.ts`,
            `${resolvedBase}/index.js`
          ];
          for (const cand of candidates) {
            if (fileLookup.has(cand) && !scoredMap.has(cand)) {
              scoredMap.set(cand, { score: 60, scoreTier: "Tier 3: Neighbor" });
            }
          }
        }
      }

      // Reverse imports: files that import seed
      for (const candidateFile of analysis.files) {
        if (scoredMap.has(candidateFile.relativePath)) continue;
        for (const imp of candidateFile.imports) {
          if (workspaceTargets(imp).includes(seedPath)) {
            scoredMap.set(candidateFile.relativePath, { score: 60, scoreTier: "Tier 3: Neighbor (workspace consumer)" });
            break;
          }
          if (imp.startsWith(".")) {
            const resolvedBase = path.normalize(path.join(path.dirname(candidateFile.relativePath), imp)).replace(/\\/g, "/");
            const candidates = [
              resolvedBase,
              `${resolvedBase}.ts`,
              `${resolvedBase}.js`,
              resolvedBase.replace(/\.js$/, ".ts"),
              `${resolvedBase}/index.ts`,
              `${resolvedBase}/index.js`
            ];
            if (candidates.includes(seedPath)) {
              scoredMap.set(candidateFile.relativePath, { score: 60, scoreTier: "Tier 3: Neighbor" });
              break;
            }
          }
        }
      }
    }

    // Step 3: Tier 4 (Corresponding test files)
    for (const seedPath of tier1And2Paths) {
      const basename = path.basename(seedPath);
      const stem = basename.replace(/\.(?:test|spec)?\.[a-zA-Z0-9]+$/, "").replace(/\.[a-zA-Z0-9]+$/, "");
      if (stem.length < 2) continue;

      for (const file of analysis.files) {
        if (scoredMap.has(file.relativePath)) continue;
        const fileBasename = path.basename(file.relativePath);
        const seedPackage = analysis.packages.filter(pkg => pkg.relativePath !== "." && seedPath.startsWith(`${pkg.relativePath}/`))
          .sort((a, b) => b.relativePath.length - a.relativePath.length)[0];
        const samePackage = seedPackage === undefined || file.relativePath.startsWith(`${seedPackage.relativePath}/`);
        if (samePackage && file.category === "test" && fileBasename.includes(stem)) {
          scoredMap.set(file.relativePath, { score: 50, scoreTier: "Tier 4: Test" });
        }
      }
    }

    // Step 4: Tier 5 (Package manifest & README of affected workspace packages)
    const affectedPackages = new Set<WorkspacePackageSummary>();
    for (const seedPath of tier1And2Paths) {
      for (const pkg of analysis.packages) {
        if (
          (pkg.relativePath !== "." && seedPath.startsWith(`${pkg.relativePath}/`)) ||
          (pkg.relativePath === "." && !seedPath.includes("/"))
        ) {
          affectedPackages.add(pkg);
        }
      }
    }
    for (const pkg of affectedPackages) {
      if (fileLookup.has(pkg.packageJsonPath) && !scoredMap.has(pkg.packageJsonPath)) {
        scoredMap.set(pkg.packageJsonPath, { score: 40, scoreTier: "Tier 5: Package Manifest" });
      }
      const readmePath = pkg.relativePath === "." ? "README.md" : `${pkg.relativePath}/README.md`;
      if (fileLookup.has(readmePath) && !scoredMap.has(readmePath)) {
        scoredMap.set(readmePath, { score: 40, scoreTier: "Tier 5: Package Manifest" });
      }
    }

    // Step 5: Tier 6 (Path or exported tokens match query tokens)
    if (queryTokens.size > 0 && tier1And2Paths.size === 0 && normOwned.length === 0 && normAffected.length === 0) {
      for (const file of analysis.files) {
        if (scoredMap.has(file.relativePath)) continue;
        const basename = path.basename(file.relativePath).toLowerCase();
        const basenameTokens = basename.split(/[^a-z0-9_-]+/);
        let matched = false;
        for (const token of queryTokens) {
          if (basenameTokens.includes(token)) {
            matched = true;
            break;
          }
        }
        if (matched) {
          scoredMap.set(file.relativePath, { score: 25, scoreTier: "Tier 6: Token Match" });
        }
      }
    }

    // Step 6: Exclude unrelated files (score === 0), sort deterministically
    const candidates: Array<{ entry: RepositoryFileEntry; score: number; scoreTier: string }> = [];
    for (const [relPath, scoreInfo] of scoredMap.entries()) {
      const entry = fileLookup.get(relPath);
      if (entry !== undefined && scoreInfo.score > 0) {
        candidates.push({ entry, score: scoreInfo.score, scoreTier: scoreInfo.scoreTier });
      }
    }

    // Deterministic sort: score descending, then relativePath ascending
    candidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.entry.relativePath.localeCompare(b.entry.relativePath);
    });

    // Step 7: Enforce strict budgets
    const includedFiles: SelectedFileContent[] = [];
    const excludedMatchingFiles: string[] = [];
    let totalBytes = 0;
    for (const candidate of candidates) {
      const fullPath = path.join(this.repositoryRoot, candidate.entry.relativePath);
      let buffer: Buffer;
      try {
        buffer = await readRepositoryFile(this.repositoryRoot, fullPath);
      } catch {
        excludedMatchingFiles.push(candidate.entry.relativePath);
        continue;
      }

      const content = scrubSecrets(buffer.toString("utf8"));
      const sizeBytes = buffer.byteLength;
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      let truncated = false;
      let finalContent = content;

      if (Buffer.byteLength(content, "utf8") > maxBytesPerFile) {
        const suffix = `\n[TRUNCATED: original size ${sizeBytes} bytes]`;
        const suffixBytes = Buffer.byteLength(suffix, "utf8");
        if (maxBytesPerFile <= suffixBytes) {
          finalContent = Buffer.from(suffix, "utf8").subarray(0, maxBytesPerFile).toString("utf8");
        } else {
          const maxBodyBytes = maxBytesPerFile - suffixBytes;
          const body = Buffer.from(content, "utf8").subarray(0, maxBodyBytes).toString("utf8");
          finalContent = body + suffix;
        }
        truncated = true;
      }

      const fileBytes = Buffer.byteLength(finalContent, "utf8");

      if (includedFiles.length < maxFiles && totalBytes + fileBytes <= maxTotalBytes) {
        includedFiles.push({
          relativePath: candidate.entry.relativePath,
          content: finalContent,
          sizeBytes,
          sha256,
          truncated,
          score: candidate.score,
          scoreTier: candidate.scoreTier
        });
        totalBytes += fileBytes;
      } else {
        excludedMatchingFiles.push(candidate.entry.relativePath);
      }
    }

    return {
      includedFiles,
      excludedMatchingFiles,
      totalRepoFiles: analysis.files.length,
      totalBytes
    };
  }

  /**
   * Prepares a role-specific task context bundle with secret scrubbing and deterministic fingerprinting.
   */
  public async prepareRoleTaskContext(request: PrepareRoleContextRequest): Promise<RoleTaskContextBundle> {
    const totalBudget = request.maxTotalBytes ?? 64_000;
    if (!Number.isSafeInteger(totalBudget) || totalBudget < 1) throw new Error("Context byte budget must be a positive safe integer");
    const repositoryIdentity = await identifyRepository(this.repositoryRoot);
    const analysis = await this.analyzeRepositoryStructure({ forceReanalysis: true });
    const roleInstructions = request.includeRoleInstructions === false ? undefined : await this.getAgentRoleInstructions(request.role);

    // Look up specification
    let spec: Specification | null = null;
    let specFingerprint: string | undefined = undefined;
    if (request.specId !== undefined) {
      spec = await this.versionManager.getLatestSpecification(request.specId);
      if (spec !== null) {
        specFingerprint = crypto.createHash("sha256").update(canonicalJson(spec), "utf8").digest("hex");
      }
    }

    // Look up ADRs
    const relevantAdrs = await this.adrStore.findDecisionsForTask({
      ownedPaths: request.ownedPaths,
      affectedPaths: request.affectedPaths,
      keywords: [request.title]
    });

    // Look up Artifacts
    const artifacts = request.taskId !== undefined || request.runId !== undefined
      ? await this.versionManager.getArtifactsForTask(request.taskId ?? request.runId ?? "")
      : [];

    // Role-tailored file selection
    let fileResult: SelectedTaskFilesResult;
    if (request.role === "conversation") {
      // Conversation agent gets lightweight project summary, no source code dumps
      fileResult = {
        includedFiles: [],
        excludedMatchingFiles: [],
        totalRepoFiles: 0,
        totalBytes: 0
      };
    } else {
      fileResult = await this.selectFilesForTask({
        taskId: request.taskId ?? "context",
        role: request.role,
        title: request.title,
        description: request.description,
        ownedPaths: request.ownedPaths,
        affectedPaths: request.affectedPaths,
        acceptanceCriteria: request.acceptanceCriteria,
        maxFiles: request.maxFiles,
        maxTotalBytes: request.maxTotalBytes
      });
    }

    // Build formatted prompt context with secret scrubbing
    const promptSections: string[] = [
      `## Repository Survey Evidence\n` +
      `Repository: ${repositoryIdentity.repositoryRoot}\nWorktree: ${repositoryIdentity.worktreeRoot}\n` +
      `Source revision: ${repositoryIdentity.sourceRevision}; working tree: ${repositoryIdentity.workingTreeState}\n` +
      `Snapshot: working-tree file fingerprints (not necessarily committed HEAD content).\n` +
      `Observed: numbered source excerpts below, with source paths and SHA-256 fingerprints, are evidence of existing implementation only.\n` +
      `Inferred: scope-selected files are candidate edit locations; static imports, workspace entrypoint mapping and test filename matches suggest dependencies/tests, not verified runtime behavior or full downstream coverage.\n` +
      `Unknown: business intent, approved requirements not supplied in the specification, dynamic dependencies and behavior not demonstrated by source/tests. Do not infer approved requirements from code.\n` +
      `GitNexus: unverified availability/index revision; using allowed source fallback. A registered GitNexus tool may supplement this survey only after its repository/revision match is proven and material claims checked against source. Missing/stale index alone does not block this fallback.\n` +
      `Limits: bounded selection and one-hop static relationships; unselected files, dynamic dispatch and unexecuted tests are not surveyed. Symlinks, nested worktrees, generated/ignored and sensitive paths are excluded.\n` +
      `Keep survey observations separate from acceptance criteria, approval, leases and task status. Human decisions go through Runtime → Conversation; read-only authority is unchanged.`
    ];

    // Role instructions
    if (roleInstructions !== undefined) {
      promptSections.push(`## Role Instructions (${request.role})\n${scrubSecrets(roleInstructions.combinedInstructions)}`);
    }

    // Task details
    promptSections.push(
      `## Task Overview\n**Title**: ${scrubSecrets(request.title)}\n**Description**: ${scrubSecrets(request.description)}\n` +
      `**Owned Paths**: ${request.ownedPaths.join(", ") || "(none)"}\n**Affected Paths**: ${request.affectedPaths.join(", ") || "(none)"}`
    );

    // Specification summary & criteria
    if (spec !== null) {
      promptSections.push(
        `## Specification: ${scrubSecrets(spec.title)} (v${spec.version ?? 1}, status: ${spec.status})\n` +
        `**Problem Statement**: ${scrubSecrets(spec.problemStatement)}\n**Summary**: ${scrubSecrets(spec.summary)}`
      );
      if (spec.acceptanceCriteria.length > 0) {
        const critList = spec.acceptanceCriteria
          .map((c) => `- [${c.id}] (${c.category}, ${c.verificationMethod}) ${c.required ? "[REQUIRED]" : "[OPTIONAL]"}: ${c.description}`)
          .join("\n");
        promptSections.push(`### Acceptance Criteria\n${scrubSecrets(critList)}`);
      }
    } else if (request.acceptanceCriteria !== undefined && request.acceptanceCriteria.length > 0) {
      const critList = request.acceptanceCriteria
        .map((c, i) => (typeof c === "string" ? `- Criterion ${i + 1}: ${c}` : `- [${c.id}] ${c.description}`))
        .join("\n");
      promptSections.push(`### Acceptance Criteria\n${scrubSecrets(critList)}`);
    }

    // Architectural Decisions
    if (relevantAdrs.length > 0) {
      const adrList = relevantAdrs
        .map((a) => `- [${a.decisionId}] ${a.title} (${a.status}): ${a.summary}`)
        .join("\n");
      promptSections.push(`## Architectural Decisions\n${scrubSecrets(adrList)}`);
    }

    // Artifact References
    if (artifacts.length > 0) {
      const artList = artifacts
        .map((a) => `- [${a.artifactId}] (${a.kind}) URI: ${a.uri}`)
        .join("\n");
      promptSections.push(`## Artifact References\n${scrubSecrets(artList)}`);
    }

    // Governance is mandatory; source excerpts use the remaining complete-prompt budget.
    const selectedFiles = [...fileResult.includedFiles];
    const omittedFiles = [...fileResult.excludedMatchingFiles];
    const formatFile = (file: SelectedFileContent): string => {
      const numbered = scrubSecrets(file.content).split(/\r?\n/).map((line, i) => `${i + 1}: ${line}`).join("\n");
      return `### File: ${file.relativePath}:1 (${file.scoreTier})\n` +
        `Observed source; SHA-256: ${file.sha256}; ${file.truncated ? "partial excerpt; remaining lines not surveyed" : "complete excerpt"}.\n` +
        `\`\`\`\n${numbered}\n\`\`\``;
    };
    const formatPrompt = (): string => scrubSecrets([
      ...promptSections,
      `## Survey Coverage\nIncluded: ${selectedFiles.length}; omitted matching files: ${omittedFiles.length}; ` +
        `truncated files: ${selectedFiles.filter(file => file.truncated).length}. ` +
        `Omitted for budget or inaccessible/unsafe source: ${omittedFiles.slice(0, 8).join(", ") || "none"}` +
        (omittedFiles.length > 8 ? ` (+${omittedFiles.length - 8} more)` : "") + ".",
      ...(selectedFiles.length > 0 ? [`## Existing Behavior, Candidate Edits, Dependencies and Tests\n` + selectedFiles.map(formatFile).join("\n\n")] : ["Unknown: no source excerpt available within scope/budget; insufficient evidence to conclude existing behavior."])
    ].join("\n\n"));
    let formattedPromptContext = formatPrompt();
    while (Buffer.byteLength(formattedPromptContext, "utf8") > totalBudget && selectedFiles.length > 0) {
      const removed = selectedFiles.pop();
      if (removed !== undefined) omittedFiles.push(removed.relativePath);
      formattedPromptContext = formatPrompt();
    }
    if (Buffer.byteLength(formattedPromptContext, "utf8") > totalBudget) {
      throw new Error(`Complete role context exceeds ${totalBudget} byte budget; narrow the task or increase its explicit budget`);
    }

    // Build file fingerprints
    const fileFingerprints: Record<string, string> = {};
    for (const f of selectedFiles) {
      fileFingerprints[f.relativePath] = f.sha256;
    }

    for (const instructionPath of roleInstructions?.sourceFiles ?? []) {
      const entry = analysis.files.find(file => file.relativePath === instructionPath);
      if (entry !== undefined) fileFingerprints[instructionPath] = entry.sha256;
    }

    // Deterministic context hash
    const contextHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          role: request.role,
          taskId: request.taskId,
          repositoryIdentity,
          files: fileFingerprints,
          specVersion: spec?.version,
          specFingerprint,
          adrs: relevantAdrs.map((a) => `${a.decisionId}:${a.sha256}`)
        }),
        "utf8"
      )
      .digest("hex");

    const adrSummaries = relevantAdrs.map((a) => ({
      id: a.decisionId,
      title: a.title,
      status: a.status
    }));

    const adrFingerprints: Record<string, string> = {};
    for (const a of relevantAdrs) {
      adrFingerprints[a.decisionId] = a.sha256;
    }

    const bundle: RoleTaskContextBundle = {
      role: request.role,
      repositoryIdentity,
      baselineFiles: analysis.files.map(file => file.relativePath),
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      ...(request.specId !== undefined ? { specId: request.specId } : {}),
      contextHash,
      fileFingerprints,
      ...(spec?.version !== undefined ? { specVersion: spec.version } : {}),
      ...(specFingerprint !== undefined ? { specFingerprint } : {}),
      totalBytes: Buffer.byteLength(formattedPromptContext, "utf8"),
      includedFiles: selectedFiles.map((f) => f.relativePath),
      excludedFileCount: omittedFiles.length,
      preparedAt: new Date().toISOString(),
      formattedPromptContext,
      adrSummaries,
      adrFingerprints,
      artifactReferences: artifacts
    };

    if (this.observability !== undefined) {
      this.observability.recordContextBundle({
        runId: request.runId ?? "adhoc",
        taskId: request.taskId ?? "adhoc",
        role: request.role,
        contextBytes: bundle.totalBytes,
        includedFileCount: bundle.includedFiles.length,
        excludedFileCount: bundle.excludedFileCount,
        specVersion: bundle.specVersion !== undefined ? String(bundle.specVersion) : undefined,
        contextHash: bundle.contextHash,
        recordedAt: bundle.preparedAt
      });
    }

    if (this.logger !== undefined) {
      const activeLogger =
        request.runId !== undefined || request.taskId !== undefined
          ? this.logger.child({
              ...(request.runId !== undefined ? { runId: request.runId } : {}),
              ...(request.taskId !== undefined ? { taskId: request.taskId } : {})
            })
          : this.logger;
      activeLogger.info("context.prepared", `Role task context prepared for ${request.role}`, {
        role: request.role,
        totalBytes: bundle.totalBytes,
        includedFileCount: bundle.includedFiles.length,
        excludedFileCount: bundle.excludedFileCount,
        contextHash: bundle.contextHash
      });
    }

    return bundle;
  }

  /**
   * Detects whether repository files, documentation, ADRs, or specification
   * versions have drifted since a context bundle was prepared.
   */
  public async detectContextDrift(bundle: RoleTaskContextBundle): Promise<ContextDriftReport> {
    const reasons: string[] = [];
    const modifiedFiles: string[] = [];
    const deletedFiles: string[] = [];
    const addedOwnedFiles: string[] = [];
    let specVersionDrifted = false;
    if (bundle.repositoryIdentity !== undefined) {
      const currentIdentity = await identifyRepository(this.repositoryRoot);
      if (currentIdentity.repositoryRoot !== bundle.repositoryIdentity.repositoryRoot ||
          currentIdentity.worktreeRoot !== bundle.repositoryIdentity.worktreeRoot) {
        reasons.push("Survey repository/worktree identity changed; refresh context for this assignment.");
      }
      if (currentIdentity.sourceRevision !== bundle.repositoryIdentity.sourceRevision) {
        reasons.push("Survey source revision changed; refresh context before relying on its evidence.");
      }
    }

    // 1. Check all included files for modification, deletion, or symlink escaping
    for (const [relPath, recordedHash] of Object.entries(bundle.fileFingerprints)) {
      const fullPath = path.resolve(this.repositoryRoot, relPath);
      try {
        const buffer = await readRepositoryFile(this.repositoryRoot, fullPath);
        const currentHash = crypto.createHash("sha256").update(buffer).digest("hex");
        if (currentHash !== recordedHash) {
          modifiedFiles.push(relPath);
          reasons.push(`File "${relPath}" content was modified (hash mismatch).`);
        }
      } catch (error) {
        deletedFiles.push(relPath);
        reasons.push(`File "${relPath}" was deleted, became inaccessible or unsafe: ${error instanceof Error ? error.message : "unknown error"}.`);
      }
    }

    // 2. Check current repository structure for newly added files
    const currentAnalysis = await this.analyzeRepositoryStructure({ forceReanalysis: true });
    const knownFiles = new Set(bundle.baselineFiles ?? Object.keys(bundle.fileFingerprints));

    // Check if new files appeared
    for (const currentFile of currentAnalysis.files) {
      if (
        (currentFile.category === "source" || currentFile.category === "test") &&
        !knownFiles.has(currentFile.relativePath)
      ) {
        // If file belongs to previously included directory paths
        for (const includedPath of bundle.includedFiles) {
          const dir = path.dirname(includedPath);
          if (dir !== "." && currentFile.relativePath.startsWith(`${dir}/`)) {
            addedOwnedFiles.push(currentFile.relativePath);
            reasons.push(`New file "${currentFile.relativePath}" was added under owned directory "${dir}".`);
            break;
          }
        }
      }
    }

    // 3. Check ADR modifications or status changes
    const allAdrs = await this.adrStore.listDecisions();
    const adrLookup = new Map(allAdrs.map((a) => [a.decisionId, a]));

    for (const adrSummary of bundle.adrSummaries) {
      const current = adrLookup.get(adrSummary.id);
      if (current === undefined) {
        reasons.push(`Architectural decision "${adrSummary.id}" is no longer found.`);
      } else if (current.status !== adrSummary.status) {
        reasons.push(
          `Architectural decision "${adrSummary.id}" status changed from "${adrSummary.status}" to "${current.status}".`
        );
      }
    }

    if (bundle.adrFingerprints !== undefined) {
      for (const [id, recordedHash] of Object.entries(bundle.adrFingerprints)) {
        const current = adrLookup.get(id);
        if (current !== undefined && current.sha256 !== recordedHash) {
          reasons.push(`Architectural decision "${id}" was modified (hash mismatch).`);
        }
      }
    }

    // 4. Check specification drift if bundle was created with a spec
    if (bundle.specId !== undefined) {
      const latest = await this.versionManager.getLatestSpecification(bundle.specId);
      if (latest === null) {
        specVersionDrifted = true;
        reasons.push(`Specification "${bundle.specId}" was not found or was deleted.`);
      } else {
        if (bundle.specVersion !== undefined && latest.version !== bundle.specVersion) {
          specVersionDrifted = true;
          reasons.push(`Specification version changed from v${bundle.specVersion} to v${latest.version}.`);
        } else if (bundle.specFingerprint !== undefined) {
          const currentFingerprint = crypto.createHash("sha256").update(canonicalJson(latest), "utf8").digest("hex");
          if (currentFingerprint !== bundle.specFingerprint) {
            specVersionDrifted = true;
            reasons.push(`Specification content has changed for version ${latest.version}.`);
          }
        }
      }
    }

    const drifted =
      modifiedFiles.length > 0 ||
      deletedFiles.length > 0 ||
      addedOwnedFiles.length > 0 ||
      specVersionDrifted ||
      reasons.length > 0;

    if (this.logger !== undefined && drifted) {
      const activeLogger =
        bundle.runId !== undefined || bundle.taskId !== undefined
          ? this.logger.child({
              ...(bundle.runId !== undefined ? { runId: bundle.runId } : {}),
              ...(bundle.taskId !== undefined ? { taskId: bundle.taskId } : {})
            })
          : this.logger;
      activeLogger.warn("context.drift_detected", `Context drift detected for role ${bundle.role}`, {
        role: bundle.role,
        reasons,
        modifiedFiles: modifiedFiles.sort(),
        deletedFiles: deletedFiles.sort(),
        addedOwnedFiles: addedOwnedFiles.sort(),
        specVersionDrifted
      });
    }

    return {
      drifted,
      reasons,
      modifiedFiles: modifiedFiles.sort(),
      deletedFiles: deletedFiles.sort(),
      addedOwnedFiles: addedOwnedFiles.sort(),
      specVersionDrifted,
      checkedAt: new Date().toISOString()
    };
  }
}
