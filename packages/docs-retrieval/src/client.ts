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

const LEGACY_ASK_TOOL_ALIAS = "ask_question";
const MCP_ENVELOPE_KEYS = new Set(["content", "structuredContent", "isError", "_meta"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractTextFromItems(items: readonly unknown[]): string | undefined {
  const texts: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      texts.push(item);
    } else if (isPlainRecord(item) && typeof item.text === "string") {
      texts.push(item.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function extractTextFromStructured(structured: Record<string, unknown>): string {
  for (const field of ["result", "answer", "content", "text", "message"]) {
    if (typeof structured[field] === "string") {
      return structured[field] as string;
    }
  }
  return JSON.stringify(structured);
}

function decodeEnvelopeValue(value: unknown, depth = 0): { unwrapped: boolean; isError: boolean; text: string } {
  if (depth > 4) {
    return { unwrapped: false, isError: false, text: typeof value === "string" ? value : JSON.stringify(value) ?? "" };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return { unwrapped: false, isError: false, text: value };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { unwrapped: false, isError: false, text: value };
    }
    if (Array.isArray(parsed)) {
      const fromArray = extractTextFromItems(parsed);
      if (fromArray !== undefined) {
        const nested = decodeEnvelopeValue(fromArray, depth + 1);
        return { unwrapped: true, isError: nested.isError, text: nested.text };
      }
      return { unwrapped: false, isError: false, text: value };
    }
    if (!isPlainRecord(parsed)) {
      return { unwrapped: false, isError: false, text: value };
    }
    const inner = decodeEnvelopeRecord(parsed, depth + 1);
    return inner ?? { unwrapped: false, isError: false, text: value };
  }
  if (Array.isArray(value)) {
    const fromArray = extractTextFromItems(value);
    if (fromArray !== undefined) {
      const nested = decodeEnvelopeValue(fromArray, depth + 1);
      return { unwrapped: true, isError: nested.isError, text: nested.text };
    }
    return { unwrapped: true, isError: false, text: JSON.stringify(value) };
  }
  if (isPlainRecord(value)) {
    const inner = decodeEnvelopeRecord(value, depth + 1);
    if (inner) return inner;
    return { unwrapped: true, isError: false, text: extractTextFromStructured(value) };
  }
  return { unwrapped: true, isError: false, text: value === null || value === undefined ? "" : String(value) };
}

function decodeEnvelopeRecord(
  record: Record<string, unknown>,
  depth: number
): { unwrapped: boolean; isError: boolean; text: string } | undefined {
  // 1. Gateway MCPToolCallResult envelope: { schemaVersion: 3, callId, status: "completed"|"failed"|"unknown", output, observedAt }
  if (
    typeof record.status === "string" &&
    (record.status === "completed" || record.status === "failed" || record.status === "unknown") &&
    ("output" in record || "callId" in record)
  ) {
    const inner = decodeEnvelopeValue(record.output, depth + 1);
    const failed = record.status !== "completed" || inner.isError;
    return { unwrapped: true, isError: failed, text: inner.text };
  }

  // 2. JSON-RPC 2.0 response envelope: { jsonrpc: "2.0", id, result?, error? }
  if (record.jsonrpc === "2.0" && ("result" in record || "error" in record)) {
    if (record.error !== undefined && record.error !== null) {
      const errMsg =
        isPlainRecord(record.error) && typeof record.error.message === "string"
          ? record.error.message
          : JSON.stringify(record.error);
      return { unwrapped: true, isError: true, text: errMsg };
    }
    const inner = decodeEnvelopeValue(record.result, depth + 1);
    return { unwrapped: true, isError: inner.isError, text: inner.text };
  }

  // 3. MCP CallToolResult / preserveStructuredToolOutput envelope: { content?, structuredContent?, isError? }
  const keys = Object.keys(record);
  const hasMcpPayloadKey = Array.isArray(record.content) || isPlainRecord(record.structuredContent) || typeof record.isError === "boolean";
  if (hasMcpPayloadKey && keys.length > 0 && keys.every((k) => MCP_ENVELOPE_KEYS.has(k))) {
    const flaggedError = record.isError === true;
    if (Array.isArray(record.content)) {
      const fromContent = extractTextFromItems(record.content);
      if (fromContent !== undefined) {
        const nested = decodeEnvelopeValue(fromContent, depth + 1);
        return { unwrapped: true, isError: flaggedError || nested.isError, text: nested.text };
      }
    }
    if (isPlainRecord(record.structuredContent)) {
      const text = extractTextFromStructured(record.structuredContent);
      return { unwrapped: true, isError: flaggedError, text };
    }
    return { unwrapped: true, isError: flaggedError, text: "" };
  }

  return undefined;
}

function isUnknownAskWikiToolFailure(outcome: ToolCallOutcome): boolean {
  if (!outcome.ok) {
    return (
      outcome.error.code === "validation" &&
      /ask_wiki_question/i.test(outcome.error.message) &&
      /(not part of|unknown tool|not found|unrecognized)/i.test(outcome.error.message)
    );
  }
  return (
    outcome.isError &&
    /ask_wiki_question/i.test(outcome.text) &&
    /(unknown tool|tool .* not found|unrecognized tool)/i.test(outcome.text)
  );
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
  private askToolWireName: DocsTool = "ask_wiki_question";

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
    let outcome = await this.caller.callTool(tool, args, { timeoutMs: this.timeoutMs, ...(signal ? { signal } : {}) });
    if (tool === "ask_wiki_question" && isUnknownAskWikiToolFailure(outcome)) {
      this.askToolWireName = LEGACY_ASK_TOOL_ALIAS as DocsTool;
      this.toolCalls++;
      outcome = await this.caller.callTool(this.askToolWireName, args, { timeoutMs: this.timeoutMs, ...(signal ? { signal } : {}) });
    }
    if (!outcome.ok) return this.fail("query", classifyGatewayError(outcome.error));
    const decoded = decodeEnvelopeValue(outcome.text);
    if (outcome.isError || decoded.isError) return this.fail("query", classifyToolError(decoded.text));
    if (!decoded.text.trim()) return this.fail("query", failure("no_documentation", `DeepWiki returned no documentation for ${repoName}.`));
    return { content: decoded.text };
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
    const result = await this.run(this.askToolWireName, { repoName: target.repoName, question: text }, target.repoName, signal);
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
        if (!value.tools.includes("ask_wiki_question") && value.tools.includes(LEGACY_ASK_TOOL_ALIAS)) {
          this.askToolWireName = LEGACY_ASK_TOOL_ALIAS as DocsTool;
        }
        const missing = DEEPWIKI_TOOL_NAMES.filter(
          tool =>
            !value.tools.includes(tool) &&
            !(tool === "ask_wiki_question" && value.tools.includes(LEGACY_ASK_TOOL_ALIAS))
        );
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
