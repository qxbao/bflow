import { connect } from "node:net";
import { isAbsolute } from "node:path";
import type { ContractError, OperationOptions, OperationResult } from "@bflow/contracts";
import type { HerdrCommandRunner, HerdrSocketPort } from "./types.js";

/** Maximum bytes accepted from one Herdr socket response (one JSON line). */
export const HERDR_SOCKET_RESPONSE_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_SOCKET_TIMEOUT_MS = 30_000;

export interface HerdrSocketPortOptions {
  /** Repository-scoped Herdr CLI runner; used only for `status server --json` socket discovery. */
  readonly runner: HerdrCommandRunner;
  /** Named Herdr session that must own the socket (the repository session name). */
  readonly sessionId: string;
  readonly defaultTimeoutMs?: number;
  readonly responseLimitBytes?: number;
}

function failure<T = never>(error: ContractError): OperationResult<T> {
  return { ok: false, error };
}

function transportError(message: string): ContractError {
  return { code: "transport_unavailable", retryable: true, message };
}

/**
 * Maps a Herdr error response to a contract error without echoing request params or
 * Herdr's free-form message (which could quote an env value). Only the code is kept.
 */
function remoteError(method: string, code: string): ContractError {
  if (code.endsWith("_not_found") || code === "not_found") {
    return { code: "not_found", retryable: false, message: `Herdr ${method} target was not found (${code})` };
  }
  return { code: "validation", retryable: false, message: `Herdr ${method} was rejected (${code})` };
}

async function resolveSocketPath(
  runner: HerdrCommandRunner,
  sessionId: string,
  options: OperationOptions | undefined,
  timeoutMs: number
): Promise<OperationResult<string>> {
  const outcome = await runner.run({
    args: ["status", "server", "--json"],
    timeoutMs,
    ...(options?.signal !== undefined && { signal: options.signal })
  });
  if (outcome.exitCode !== 0 || outcome.failure !== undefined) {
    return failure(transportError("Cannot resolve the Herdr socket: server status is unavailable"));
  }
  let status: unknown;
  try {
    status = JSON.parse(outcome.stdout);
  } catch {
    return failure({ code: "corruption", retryable: false, message: "Herdr server status returned malformed JSON" });
  }
  if (status === null || typeof status !== "object" || Array.isArray(status)) {
    return failure({ code: "corruption", retryable: false, message: "Herdr server status returned an invalid object" });
  }
  const record = status as Record<string, unknown>;
  if (record["session"] !== sessionId) {
    return failure({ code: "validation", retryable: false, message: "Herdr socket belongs to a different session" });
  }
  if (record["running"] !== true) {
    return failure(transportError("Herdr session is not running; the socket is unavailable"));
  }
  const socket = record["socket"];
  if (typeof socket !== "string" || socket.length === 0 || socket.includes("\0") || !isAbsolute(socket)) {
    return failure({ code: "corruption", retryable: false, message: "Herdr server status did not report a valid socket path" });
  }
  return { ok: true, value: socket };
}

function remainingBudgetMs(
  timeoutMs: number,
  startedAtMs: number,
  deadline: string | undefined
): number | null {
  const elapsedMs = performance.now() - startedAtMs;
  let budgetMs = timeoutMs - elapsedMs;
  if (deadline !== undefined) {
    const deadlineMs = Date.parse(deadline);
    if (!Number.isFinite(deadlineMs)) return null;
    budgetMs = Math.min(budgetMs, deadlineMs - Date.now());
  }
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return null;
  return Math.max(1, Math.floor(Math.min(budgetMs, 2_147_483_647)));
}

function sendOneRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  responseLimitBytes: number,
  signal: AbortSignal | undefined
): Promise<OperationResult<unknown>> {
  const id = `bflow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let payload: string;
  try {
    payload = `${JSON.stringify({ id, method, params })}\n`;
  } catch {
    return Promise.resolve(failure({ code: "validation", retryable: false, message: `Herdr ${method} request parameters are not JSON-serializable` }));
  }
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(failure({ code: "cancelled", retryable: false, message: "Herdr socket request was cancelled before sending" }));
      return;
    }
    let socket: ReturnType<typeof connect>;
    try {
      socket = connect({ path: socketPath });
    } catch {
      resolve(failure(transportError(`Herdr ${method} socket connection failed; reconcile before retry`)));
      return;
    }
    const chunks: Buffer[] = [];
    let receivedBeforeNewline = 0;
    let settled = false;
    const finish = (value: OperationResult<unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(value);
    };
    const onAbort = (): void => {
      finish(failure({ code: "cancelled", retryable: false, message: "Herdr socket request was cancelled; reconcile before retry" }));
    };
    const timer = setTimeout(() => {
      finish(failure(transportError(`Herdr ${method} did not respond in time; reconcile before retry`)));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    socket.once("error", () => {
      finish(failure(transportError(`Herdr ${method} socket request failed; reconcile before retry`)));
    });
    socket.once("close", () => {
      finish(failure(transportError(`Herdr ${method} socket closed before a response; reconcile before retry`)));
    });
    socket.once("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      const chunkNewline = chunk.indexOf(0x0a);
      if (chunkNewline < 0) {
        receivedBeforeNewline += chunk.length;
        if (receivedBeforeNewline > responseLimitBytes) {
          finish({ ok: false, error: { code: "corruption", retryable: false, message: `Herdr ${method} response exceeded the ${responseLimitBytes}-byte limit` } });
          return;
        }
        chunks.push(chunk);
        return;
      }
      const frameLength = receivedBeforeNewline + chunkNewline;
      if (frameLength > responseLimitBytes) {
        finish({ ok: false, error: { code: "corruption", retryable: false, message: `Herdr ${method} response exceeded the ${responseLimitBytes}-byte limit` } });
        return;
      }
      const lineBuffer =
        chunks.length === 0
          ? chunk.subarray(0, chunkNewline)
          : Buffer.concat([...chunks, chunk.subarray(0, chunkNewline)], frameLength);
      let response: unknown;
      try {
        response = JSON.parse(lineBuffer.toString("utf8"));
      } catch {
        finish({ ok: false, error: { code: "corruption", retryable: false, message: `Herdr ${method} returned malformed JSON` } });
        return;
      }
      finish(parseResponse(method, id, response));
    });
  });
}

function parseResponse(method: string, id: string, response: unknown): OperationResult<unknown> {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    return failure({ code: "corruption", retryable: false, message: `Herdr ${method} returned an invalid envelope` });
  }
  const envelope = response as Record<string, unknown>;
  if (envelope["id"] !== id) {
    return failure({ code: "corruption", retryable: false, message: `Herdr ${method} response was not correlated with its request` });
  }
  if (envelope["error"] !== undefined) {
    const error = envelope["error"] as Record<string, unknown> | null;
    const code = error !== null && typeof error === "object" && typeof error["code"] === "string" ? error["code"] : "unknown";
    return failure(remoteError(method, code));
  }
  if (envelope["result"] === null || typeof envelope["result"] !== "object") {
    return failure({ code: "corruption", retryable: false, message: `Herdr ${method} response has no result object` });
  }
  return { ok: true, value: envelope["result"] };
}

/**
 * Default Herdr socket port. Resolves the socket path through the repository-scoped CLI
 * (`herdr status server --json`), requires the expected named session, then sends one
 * newline-delimited JSON request per call. Only pane creation with launch env uses it.
 */
export function createHerdrSocketPort(options: HerdrSocketPortOptions): HerdrSocketPort {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
  const responseLimitBytes = options.responseLimitBytes ?? HERDR_SOCKET_RESPONSE_LIMIT_BYTES;
  return {
    async request(method, params, requestOptions) {
      if (requestOptions?.signal?.aborted) {
        return failure({ code: "cancelled", retryable: false, message: "Herdr socket request was cancelled before sending" });
      }
      const startedAtMs = performance.now();
      const timeoutMs = requestOptions?.timeoutMs ?? defaultTimeoutMs;
      const resolveBudget = remainingBudgetMs(timeoutMs, startedAtMs, requestOptions?.deadline);
      if (resolveBudget === null) {
        return failure(transportError(`Herdr ${method} deadline expired before sending`));
      }
      const socketPath = await resolveSocketPath(options.runner, options.sessionId, requestOptions, resolveBudget);
      if (!socketPath.ok) return socketPath;
      const socketBudget = remainingBudgetMs(timeoutMs, startedAtMs, requestOptions?.deadline);
      if (socketBudget === null) {
        return failure(transportError(`Herdr ${method} deadline expired before socket request`));
      }
      return sendOneRequest(socketPath.value, method, params, socketBudget, responseLimitBytes, requestOptions?.signal);
    }
  };
}
