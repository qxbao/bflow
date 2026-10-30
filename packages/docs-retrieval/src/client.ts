import { cachePermitted, DEFAULT_CACHE_POLICY, type CachePolicy, type DocsCache } from "./cache.js";
import { checkQuestion, DEEPWIKI_PROBE_REPO, DEEPWIKI_TOOL_NAMES, resolveRepository } from "./deepwiki.js";
import { classifyGatewayError, classifyToolError, failure, type DocsFailure, type GatewayErrorLike } from "./failures.js";

export type DocsTool = "ask_wiki_question" | "read_wiki_contents" | "read_wiki_structure";

export type ToolCallOutcome =
  | { readonly ok: true; readonly isError: boolean; readonly text: string }
  | { readonly ok: false; readonly error: GatewayErrorLike };

/** How the client reaches DeepWiki. The production adapter goes through the shared Gateway with the caller's own registration. */
export interface DocsToolCaller {
  callTool(tool: DocsTool, args: Readonly<Record<string, unknown>>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ToolCallOutcome>;
  /** Names the upstream advertises; used by `probe`. Optional because a caller may not be able to list. */
  listTools?(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ ok: true; tools: readonly string[] } | { ok: false; error: GatewayErrorLike }>;
}

export interface DocsClientOptions {
  readonly caller: DocsToolCaller;
  readonly cache?: DocsCache;
  readonly cachePolicy?: CachePolicy;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export interface DocsMetricsSnapshot {
  readonly lookups: number;
  readonly toolCalls: number;
  readonly refused: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheStores: number;
  readonly failures: Readonly<Record<string, number>>;
}

/**
 * `visibility` is a local declaration by the operator; it is checked here and never forwarded. `library` is accepted only when
 * it exactly matches the built-in public mapping.
 */
export interface RepoInput { readonly repoName?: unknown; readonly library?: string; readonly visibility?: unknown }
export interface AskInput extends RepoInput { readonly question: unknown; readonly noCache?: boolean }

export interface DocsSuccess {
  readonly ok: true;
  readonly repoName: string;
  readonly tool: DocsTool;
  readonly content: string;
  readonly cache: { readonly hit: boolean; readonly stored: boolean };
  readonly retrievedAt: string;
}

export type DocsStage = "validate" | "query";
export interface DocsFailureResult { readonly ok: false; readonly stage: DocsStage; readonly failure: DocsFailure }

export interface ProbeCheck {
  readonly name: "discovery" | "read_wiki_structure";
  readonly status: "ok" | "failed" | "skipped";
  readonly latencyMs: number;
  readonly failure?: DocsFailure;
  readonly detail?: string;
}

/**
 * Reads public repository documentation through DeepWiki. Only an explicitly named, explicitly public `owner/repo` (or an exact
 * entry of the built-in mapping) and a short question leave the machine; anything else is refused before any call is made.
 * It never invents documentation: a missing wiki, an empty answer or a transport problem is reported as a typed failure.
 */
export class DocsClient {
  private readonly caller: DocsToolCaller;
  private readonly policy: CachePolicy;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private lookups = 0; private toolCalls = 0; private refused = 0;
  private cacheHits = 0; private cacheMisses = 0; private cacheStores = 0;
  private readonly failures: Record<string, number> = {};

  constructor(private readonly options: DocsClientOptions) {
    this.caller = options.caller;
    this.policy = options.cachePolicy ?? DEFAULT_CACHE_POLICY;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
  }

  metrics(): DocsMetricsSnapshot {
    return { lookups: this.lookups, toolCalls: this.toolCalls, refused: this.refused, cacheHits: this.cacheHits, cacheMisses: this.cacheMisses,
      cacheStores: this.cacheStores, failures: { ...this.failures } };
  }

  private fail(stage: DocsStage, value: DocsFailure): DocsFailureResult {
    this.failures[value.kind] = (this.failures[value.kind] ?? 0) + 1;
    return { ok: false, stage, failure: value };
  }

  private refuse(message: string, kind: "invalid_arguments" | "library_not_found" = "invalid_arguments"): DocsFailureResult {
    this.refused++;
    return this.fail("validate", failure(kind, message));
  }

  private resolve(input: RepoInput): { repoName: string } | DocsFailureResult {
    const resolved = resolveRepository(input);
    if (resolved.status === "refused") return this.refuse(resolved.message);
    if (resolved.status === "no_match") return this.refuse(resolved.message, "library_not_found");
    return { repoName: resolved.repoName };
  }

  private async run(tool: DocsTool, args: Record<string, unknown>, repoName: string, signal?: AbortSignal): Promise<{ content: string } | DocsFailureResult> {
    this.toolCalls++;
    const outcome = await this.caller.callTool(tool, args, { timeoutMs: this.timeoutMs, ...(signal ? { signal } : {}) });
    if (!outcome.ok) return this.fail("query", classifyGatewayError(outcome.error));
    if (outcome.isError) return this.fail("query", classifyToolError(outcome.text));
    if (!outcome.text.trim()) return this.fail("query", failure("no_documentation", `DeepWiki returned no documentation for ${repoName}.`));
    return { content: outcome.text };
  }

  private success(repoName: string, tool: DocsTool, content: string, hit = false, stored = false): DocsSuccess {
    return { ok: true, repoName, tool, content, cache: { hit, stored }, retrievedAt: this.now().toISOString() };
  }

  /** `ask_wiki_question`: a question about one public repository. */
  async ask(input: AskInput, signal?: AbortSignal): Promise<DocsSuccess | DocsFailureResult> {
    this.lookups++;
    const target = this.resolve(input);
    if ("ok" in target) return target;
    const question = checkQuestion(input.question);
    if (!question.ok) return this.refuse(question.message);
    const text = input.question as string;
    const keyParts = { libraryId: target.repoName, version: null, query: text, language: null };
    const usable = this.options.cache !== undefined && !input.noCache && cachePermitted(this.policy, false);
    if (usable) {
      const hit = await this.options.cache!.get(keyParts);
      if (hit) { this.cacheHits++; return this.success(target.repoName, "ask_wiki_question", hit.content, true, false); }
      this.cacheMisses++;
    }
    const result = await this.run("ask_wiki_question", { repoName: target.repoName, question: text }, target.repoName, signal);
    if ("ok" in result) return result;
    let stored = false;
    if (usable) {
      try { await this.options.cache!.set(keyParts, result.content, this.policy.ttlSeconds); this.cacheStores++; stored = true; } catch { /* a cache fault never fails a lookup */ }
    }
    return this.success(target.repoName, "ask_wiki_question", result.content, false, stored);
  }

  private async read(tool: "read_wiki_structure" | "read_wiki_contents", input: RepoInput, signal?: AbortSignal): Promise<DocsSuccess | DocsFailureResult> {
    this.lookups++;
    const target = this.resolve(input);
    if ("ok" in target) return target;
    const result = await this.run(tool, { repoName: target.repoName }, target.repoName, signal);
    return "ok" in result ? result : this.success(target.repoName, tool, result.content);
  }

  /** `read_wiki_structure`: the topic outline of one public repository's wiki. */
  structure(input: RepoInput, signal?: AbortSignal) { return this.read("read_wiki_structure", input, signal); }

  /** `read_wiki_contents`: the wiki pages of one public repository. */
  contents(input: RepoInput, signal?: AbortSignal) { return this.read("read_wiki_contents", input, signal); }

  /** Exercises discovery and one read-only call about a well-known public repository. Used by `docs status`, `doctor` and the live probe. */
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
        const missing = DEEPWIKI_TOOL_NAMES.filter(tool => !value.tools.includes(tool));
        discoveryOk = missing.length === 0;
        checks.push(missing.length === 0 ? { name: "discovery", status: "ok", latencyMs, detail: value.tools.join(", ") }
          : { name: "discovery", status: "failed", latencyMs, failure: failure("protocol", `The service does not offer: ${missing.join(", ")}.`), detail: value.tools.join(", ") });
      }
    } else checks.push({ name: "discovery", status: "skipped", latencyMs: 0, detail: "The caller cannot list tools." });
    if (!discoveryOk) { checks.push({ name: "read_wiki_structure", status: "skipped", latencyMs: 0 }); return checks; }
    const read = await timed(() => this.structure({ repoName: DEEPWIKI_PROBE_REPO, visibility: "public" }, signal));
    if (!read.value.ok) checks.push({ name: "read_wiki_structure", status: "failed", latencyMs: read.latencyMs, failure: read.value.failure });
    else checks.push({ name: "read_wiki_structure", status: "ok", latencyMs: read.latencyMs, detail: `${read.value.content.length} characters` });
    return checks;
  }
}
