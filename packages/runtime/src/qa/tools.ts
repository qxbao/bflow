import type { QaBrowserStep } from "./model.js";

export const QA_HTTP_TOOL_ID = "qa-http";
export const QA_BROWSER_TOOL_ID = "qa-browser";

export interface QaHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
}

/**
 * Outcome of one HTTP exchange. `unavailable` means the request was provably not delivered (connection refused or
 * name not resolved); `interrupted` and `timeout` mean delivery is uncertain. A thrown error is a host failure.
 */
export type QaHttpOutcome =
  | { readonly kind: "response"; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "interrupted"; readonly message: string };

/** Tool adapter that Runtime uses for HTTP actions; redirects are never followed by the tool itself. */
export interface QaHttpTool {
  readonly toolId: string;
  readonly version: string;
  request(request: QaHttpRequest): Promise<QaHttpOutcome>;
}

export type QaBrowserOutcome =
  | { readonly kind: "done"; readonly url: string; readonly passed: boolean; readonly observations: Readonly<Record<string, string>> }
  | { readonly kind: "timeout" }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Browser adapter port. The persistent host would bind it to the Gateway browser MCP inside a
 * `BrowserResourceTransactions` lease; without that wiring every browser case is a prerequisite gap.
 */
export interface QaBrowserTool {
  readonly toolId: string;
  readonly version: string;
  /** `step.url`, when present, is already resolved against an approved origin. */
  perform(step: QaBrowserStep, timeoutMs: number): Promise<QaBrowserOutcome>;
}

const BODY_LIMIT = 256 * 1024;
const NOT_DELIVERED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

function causeCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Real HTTP tool on Node fetch: manual redirects, bounded body, explicit timeout. */
export function createHttpQaTool(): QaHttpTool {
  return {
    toolId: QA_HTTP_TOOL_ID,
    version: `node-fetch/${process.versions.node}`,
    async request(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetch(request.url, { method: request.method, headers: request.headers, redirect: "manual",
          signal: controller.signal, ...(request.body !== undefined ? { body: request.body } : {}) });
        let body = "";
        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            body += decoder.decode(value, { stream: true });
            if (body.length > BODY_LIMIT) { await reader.cancel(); body = body.slice(0, BODY_LIMIT); break; }
          }
        }
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => { headers[key] = value; });
        return { kind: "response", status: response.status, headers, body };
      } catch (error) {
        if (controller.signal.aborted) return { kind: "timeout" };
        const code = causeCode(error);
        const message = `${code ?? "error"}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512);
        return code && NOT_DELIVERED.has(code) ? { kind: "unavailable", message } : { kind: "interrupted", message };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
