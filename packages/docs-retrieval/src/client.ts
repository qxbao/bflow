import { cachePermitted, DEFAULT_CACHE_POLICY, type CacheKeyParts, type CachePolicy, type DocsCache } from "./cache.js";
import { parseResolveResult, selectLibrary, selectVersion, type LibraryCandidate, type VersionChoice } from "./context7.js";
import { classifyGatewayError, classifyToolError, failure, type DocsFailure, type GatewayErrorLike } from "./failures.js";
import { detectInstalledVersion, type DetectedVersion } from "./versions.js";

export type DocsTool = "resolve-library-id" | "query-docs";

export type ToolCallOutcome =
  | { readonly ok: true; readonly isError: boolean; readonly text: string }
  | { readonly ok: false; readonly error: GatewayErrorLike };

/** How the client reaches Context7. The production adapter goes through the shared Gateway with the caller's own registration. */
export interface DocsToolCaller {
  callTool(tool: DocsTool, args: Readonly<Record<string, unknown>>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ToolCallOutcome>;
  /** Names the upstream advertises; used by `probe`. Optional because a caller may not be able to list. */
  listTools?(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ ok: true; tools: readonly string[] } | { ok: false; error: GatewayErrorLike }>;
}

export interface DocsClientOptions {
  readonly caller: DocsToolCaller;
  readonly cache?: DocsCache;
  readonly cachePolicy?: CachePolicy;
  /** True when the Gateway talks to Context7 with an API key; gates caching (see `CachePolicy.allowAuthenticated`). */
  readonly authenticated?: boolean;
  readonly timeoutMs?: number;
  readonly detect?: (root: string, library: string, from?: string) => Promise<DetectedVersion | null>;
  readonly now?: () => Date;
}

export interface DocsMetricsSnapshot {
  readonly searches: number;
  readonly lookups: number;
  readonly resolveCalls: number;
  readonly queryCalls: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheStores: number;
  readonly cacheSkippedByPolicy: number;
  readonly failures: Readonly<Record<string, number>>;
}

export interface SearchInput { readonly library: string; readonly query?: string; readonly projectRoot?: string; /** Where the search for the project's dependency starts (inside `projectRoot`). */ readonly startDir?: string; readonly version?: string }
export interface SearchSuccess {
  readonly ok: true;
  readonly library: string;
  readonly candidates: readonly LibraryCandidate[];
  readonly selection: "selected" | "ambiguous" | "no_match";
  readonly selected?: LibraryCandidate;
  readonly installed?: DetectedVersion;
  readonly version?: VersionChoice;
  readonly warnings: readonly string[];
}

export interface LookupInput {
  /** A library name such as `react`. Either this or `libraryId` is required. */
  readonly library?: string;
  /** A Context7 id such as `/reactjs/react.dev`, optionally with a version suffix. */
  readonly libraryId?: string;
  readonly query: string;
  readonly language?: string;
  /** Overrides the version detected from the project. */
  readonly version?: string;
  readonly projectRoot?: string;
  readonly startDir?: string;
  readonly noCache?: boolean;
}

export interface LookupSuccess {
  readonly ok: true;
  readonly libraryId: string;
  readonly libraryTitle?: string;
  /** The version the project uses (or the caller gave) and the version whose documentation was actually returned. */
  readonly requestedVersion: string | null;
  readonly versionUsed: string | null;
  readonly versionSource: "explicit" | "installed" | "none";
  readonly versionMatch: VersionChoice["match"];
  readonly installed?: DetectedVersion;
  readonly content: string;
  readonly cache: { readonly hit: boolean; readonly stored: boolean };
  readonly warnings: readonly string[];
  readonly retrievedAt: string;
}

export type DocsStage = "detect" | "resolve" | "query";
export interface DocsFailureResult { readonly ok: false; readonly stage: DocsStage; readonly failure: DocsFailure }

export interface ProbeCheck {
  readonly name: "discovery" | "resolve-library-id" | "query-docs";
  readonly status: "ok" | "failed" | "skipped";
  readonly latencyMs: number;
  readonly failure?: DocsFailure;
  readonly detail?: string;
}

const REQUIRED_TOOLS: readonly DocsTool[] = ["resolve-library-id", "query-docs"];

/**
 * Looks documentation up through Context7: resolve the library, pick the version the project uses, query, and report
 * exactly what came back. It never invents documentation: when the library, the version or the content is missing it
 * says so with a typed failure, and when it falls back (for example to the unversioned library) it says that too.
 */
export class DocsClient {
  private readonly caller: DocsToolCaller;
  private readonly policy: CachePolicy;
  private readonly timeoutMs: number;
  private readonly detect: (root: string, library: string, from?: string) => Promise<DetectedVersion | null>;
  private readonly now: () => Date;
  private searches = 0; private lookups = 0; private resolveCalls = 0; private queryCalls = 0;
  private cacheStores = 0; private cacheHits = 0; private cacheMisses = 0; private skipped = 0;
  private readonly failures: Record<string, number> = {};

  constructor(private readonly options: DocsClientOptions) {
    this.caller = options.caller;
    this.policy = options.cachePolicy ?? DEFAULT_CACHE_POLICY;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.detect = options.detect ?? ((root, library, from) => detectInstalledVersion(root, library, from === undefined ? {} : { from }));
    this.now = options.now ?? (() => new Date());
  }

  metrics(): DocsMetricsSnapshot {
    return { searches: this.searches, lookups: this.lookups, resolveCalls: this.resolveCalls, queryCalls: this.queryCalls,
      cacheHits: this.cacheHits, cacheMisses: this.cacheMisses, cacheStores: this.cacheStores, cacheSkippedByPolicy: this.skipped, failures: { ...this.failures } };
  }

  private fail(stage: DocsStage, value: DocsFailure): DocsFailureResult {
    this.failures[value.kind] = (this.failures[value.kind] ?? 0) + 1;
    return { ok: false, stage, failure: value };
  }

  private async call(tool: DocsTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; failure: DocsFailure }> {
    if (tool === "resolve-library-id") this.resolveCalls++; else this.queryCalls++;
    const outcome = await this.caller.callTool(tool, args, { timeoutMs: this.timeoutMs, ...(signal ? { signal } : {}) });
    if (!outcome.ok) return { ok: false, failure: classifyGatewayError(outcome.error) };
    if (outcome.isError) return { ok: false, failure: classifyToolError(outcome.text) };
    return { ok: true, text: outcome.text };
  }

  async search(input: SearchInput, signal?: AbortSignal): Promise<SearchSuccess | DocsFailureResult> {
    this.searches++;
    const resolved = await this.call("resolve-library-id", { query: input.query?.trim() || input.library, libraryName: input.library }, signal);
    if (!resolved.ok) return this.fail("resolve", resolved.failure);
    const candidates = parseResolveResult(resolved.text);
    const detected = input.version ? null : input.projectRoot ? await this.detect(input.projectRoot, input.library, input.startDir).catch(() => null) : null;
    const requested = input.version ?? detected?.version ?? null;
    const selection = selectLibrary(candidates, input.library, requested);
    const warnings: string[] = [];
    if (selection.status === "no_match") warnings.push(`Context7 returned ${candidates.length} libraries, none matching "${input.library}".`);
    if (selection.status === "ambiguous") warnings.push(`More than one library matches "${input.library}" equally well; the first is shown.`);
    let installed: DetectedVersion | undefined;
    let version: VersionChoice | undefined;
    if (selection.library) {
      if (detected) installed = detected;
      version = selectVersion(selection.library, requested);
      if (requested && version.match === "none") warnings.push(versionWarning(requested, version));
    }
    return { ok: true, library: input.library, candidates, selection: selection.status,
      ...(selection.library ? { selected: selection.library } : {}), ...(installed ? { installed } : {}), ...(version ? { version } : {}), warnings };
  }

  async lookup(input: LookupInput, signal?: AbortSignal): Promise<LookupSuccess | DocsFailureResult> {
    this.lookups++;
    const query = input.query.trim();
    if (!query) return this.fail("query", failure("invalid_arguments", "A non-empty query is required."));
    if (!input.library && !input.libraryId) return this.fail("resolve", failure("invalid_arguments", "Give a library name or a library id."));
    const warnings: string[] = [];
    let installed: DetectedVersion | undefined;
    let versionSource: LookupSuccess["versionSource"] = "none";
    let requested: string | null = input.version ?? null;
    if (input.version) versionSource = "explicit";

    let libraryId: string;
    let title: string | undefined;
    let versionUsed: string | null = null;
    let match: VersionChoice["match"] = requested ? "none" : "unrequested";

    if (input.libraryId) {
      libraryId = input.libraryId.trim();
      if (requested) { libraryId = `${libraryId.replace(/\/+$/, "")}/${requested}`; versionUsed = requested; match = "exact"; }
    } else {
      const library = input.library!.trim();
      if (!input.version && input.projectRoot) {
        const detected = await this.detect(input.projectRoot, library, input.startDir).catch(() => null);
        if (detected) { installed = detected; requested = detected.version; versionSource = "installed"; if (!detected.exact) warnings.push(`The project declares ${detected.dependency} as "${detected.range ?? detected.version}" without a lockfile entry; ${detected.version} is the lowest version that range allows.`); }
        else warnings.push(`No dependency named "${library}" was found in the project, so no version was selected.`);
      }
      const resolved = await this.call("resolve-library-id", { query, libraryName: library }, signal);
      if (!resolved.ok) return this.fail("resolve", resolved.failure);
      const candidates = parseResolveResult(resolved.text);
      const selection = selectLibrary(candidates, library, requested);
      if (!selection.library) return this.fail("resolve", failure("library_not_found", `Context7 has no library matching "${library}".`));
      if (selection.status === "ambiguous") warnings.push(`More than one library matches "${library}" equally well; using ${selection.library.id}.`);
      title = selection.library.title;
      const choice = selectVersion(selection.library, requested);
      libraryId = choice.libraryId; versionUsed = choice.versionUsed; match = choice.match;
      if (requested && choice.match === "none") warnings.push(versionWarning(requested, choice));
      else if (requested && choice.match !== "exact") warnings.push(`Documentation for ${requested} is not offered; using ${choice.versionUsed}, the nearest version at or below it.`);
    }

    const language = input.language?.trim() || null;
    const keyParts: CacheKeyParts = { libraryId, version: versionUsed, query, language };
    const authenticated = this.options.authenticated === true;
    const cacheUsable = this.options.cache !== undefined && !input.noCache;
    const permitted = cachePermitted(this.policy, authenticated);
    if (cacheUsable && !permitted && this.policy.enabled) this.skipped++;
    if (cacheUsable && permitted) {
      const hit = await this.options.cache!.get(keyParts);
      if (hit) {
        this.cacheHits++;
        return this.success({ libraryId, title, requested, versionUsed, versionSource, match, installed, content: hit.content, hit: true, stored: false, warnings });
      }
      this.cacheMisses++;
    }

    let queried = await this.call("query-docs", { libraryId, query, ...(language ? { language } : {}) }, signal);
    if (!queried.ok && queried.failure.kind === "version_not_found" && queried.failure.availableVersions?.length && requested) {
      // The id was built from a version spelled differently than the server lists it; retry once from the server's list.
      const retry = selectVersion({ id: stripVersion(libraryId), versions: queried.failure.availableVersions }, requested);
      if (retry.versionUsed && retry.libraryId !== libraryId) {
        libraryId = retry.libraryId; versionUsed = retry.versionUsed; match = retry.match;
        warnings.push(`Version ${requested} is not offered; used ${retry.versionUsed}.`);
        queried = await this.call("query-docs", { libraryId, query, ...(language ? { language } : {}) }, signal);
      }
    }
    if (!queried.ok) return this.fail("query", queried.failure);
    const content = queried.text;
    if (!content.trim()) return this.fail("query", failure("no_documentation", `Context7 returned no documentation for ${libraryId}.`, { libraryId }));
    let stored = false;
    if (cacheUsable && permitted) {
      try { await this.options.cache!.set({ ...keyParts, libraryId, version: versionUsed }, content, this.policy.ttlSeconds); this.cacheStores++; stored = true; } catch { /* a cache fault never fails a lookup */ }
    }
    return this.success({ libraryId, title, requested, versionUsed, versionSource, match, installed, content, hit: false, stored, warnings });
  }

  private success(parts: { libraryId: string; title: string | undefined; requested: string | null; versionUsed: string | null;
    versionSource: LookupSuccess["versionSource"]; match: VersionChoice["match"]; installed: DetectedVersion | undefined; content: string;
    hit: boolean; stored: boolean; warnings: string[] }): LookupSuccess {
    return { ok: true, libraryId: parts.libraryId, ...(parts.title ? { libraryTitle: parts.title } : {}), requestedVersion: parts.requested,
      versionUsed: parts.versionUsed, versionSource: parts.versionSource, versionMatch: parts.match, ...(parts.installed ? { installed: parts.installed } : {}),
      content: parts.content, cache: { hit: parts.hit, stored: parts.stored }, warnings: parts.warnings, retrievedAt: this.now().toISOString() };
  }

  /** Exercises discovery and both tools with public, side-effect-free queries. Used by `docs status` and `doctor`. */
  async probe(signal?: AbortSignal): Promise<readonly ProbeCheck[]> {
    const checks: ProbeCheck[] = [];
    const timed = async <T>(run: () => Promise<T>): Promise<{ value: T; latencyMs: number }> => {
      const start = Date.now();
      const value = await run();
      return { value, latencyMs: Date.now() - start };
    };
    let discoveryOk = true;
    if (this.caller.listTools) {
      const { value, latencyMs } = await timed(() => this.caller.listTools!({ timeoutMs: this.timeoutMs, ...(signal ? { signal } : {}) }));
      if (!value.ok) { discoveryOk = false; checks.push({ name: "discovery", status: "failed", latencyMs, failure: classifyGatewayError(value.error) }); }
      else {
        const missing = REQUIRED_TOOLS.filter(tool => !value.tools.includes(tool));
        discoveryOk = missing.length === 0;
        checks.push(missing.length === 0 ? { name: "discovery", status: "ok", latencyMs, detail: value.tools.join(", ") }
          : { name: "discovery", status: "failed", latencyMs, failure: failure("protocol", `The service does not offer: ${missing.join(", ")}.`), detail: value.tools.join(", ") });
      }
    } else checks.push({ name: "discovery", status: "skipped", latencyMs: 0, detail: "The caller cannot list tools." });
    if (!discoveryOk) {
      checks.push({ name: "resolve-library-id", status: "skipped", latencyMs: 0 }, { name: "query-docs", status: "skipped", latencyMs: 0 });
      return checks;
    }
    const resolved = await timed(() => this.call("resolve-library-id", { query: "state management hooks", libraryName: "react" }, signal));
    let probeId: string | undefined;
    if (!resolved.value.ok) checks.push({ name: "resolve-library-id", status: "failed", latencyMs: resolved.latencyMs, failure: resolved.value.failure });
    else {
      const selected = selectLibrary(parseResolveResult(resolved.value.text), "react").library;
      if (!selected) checks.push({ name: "resolve-library-id", status: "failed", latencyMs: resolved.latencyMs, failure: failure("protocol", "resolve-library-id answered but returned no parsable library.") });
      else { probeId = selected.id; checks.push({ name: "resolve-library-id", status: "ok", latencyMs: resolved.latencyMs, detail: selected.id }); }
    }
    if (!probeId) { checks.push({ name: "query-docs", status: "skipped", latencyMs: 0, detail: "No library id to query." }); return checks; }
    const queried = await timed(() => this.call("query-docs", { libraryId: probeId, query: "useState" }, signal));
    if (!queried.value.ok) checks.push({ name: "query-docs", status: "failed", latencyMs: queried.latencyMs, failure: queried.value.failure });
    else if (!queried.value.text.trim()) checks.push({ name: "query-docs", status: "failed", latencyMs: queried.latencyMs, failure: failure("no_documentation", "query-docs answered with an empty body.") });
    else checks.push({ name: "query-docs", status: "ok", latencyMs: queried.latencyMs, detail: `${queried.value.text.length} characters` });
    for (const check of checks) if (check.failure) this.failures[check.failure.kind] = (this.failures[check.failure.kind] ?? 0) + 1;
    return checks;
  }
}

const stripVersion = (id: string) => id.split("/").slice(0, 3).join("/");

function versionWarning(requested: string, choice: VersionChoice): string {
  const offered = choice.availableVersions.length ? ` Offered versions: ${choice.availableVersions.join(", ")}.` : " The library lists no versions.";
  return `No documentation matches version ${requested}; the unversioned library id is used, which may describe a different release.${offered}`;
}
