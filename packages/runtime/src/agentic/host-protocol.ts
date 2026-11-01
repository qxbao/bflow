import { connect } from "node:net";
import { JsonValueSchema } from "@bflow/contracts";
import { record, textField } from "./journal.js";

const MAX_SAFE_TIMEOUT_MS = 2147483647;

/** Private control protocol. Role traffic still travels through signed native Herdr actions. */
export async function callHost(socketPath: string, token: string, method: string, params: unknown = {}, timeoutMs = 30_000, signal?: AbortSignal): Promise<unknown> {
  // Aggregate checkpoints legitimately exceed ordinary status/control replies; keep both paths bounded.
  const maxResponseBytes = (method === "checkpoint" ? 16 : 4) * 1024 * 1024;
  JsonValueSchema.parse(params);
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Bflow host ${method} acknowledgement timed out after ${timeoutMs}ms; reconcile before retry`);
  }
  const effectiveTimeoutMs = Math.min(timeoutMs, MAX_SAFE_TIMEOUT_MS);
  return new Promise((accept, reject) => {
    const socket = connect(socketPath);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        if (wallTimer !== undefined) {
          clearTimeout(wallTimer);
          wallTimer = undefined;
        }
        signal?.removeEventListener("abort", abort);
        fn();
      }
    };
    const onTimeout = () => {
      socket.destroy();
      finish(() => reject(new Error(`Bflow host ${method} acknowledgement timed out after ${timeoutMs}ms; reconcile before retry`)));
    };
    const abort = () => { socket.destroy(); finish(() => reject(signal?.reason ?? new Error("Host request aborted; reconcile before retry"))); };
    signal?.addEventListener("abort", abort, { once: true });
    wallTimer = setTimeout(onTimeout, effectiveTimeoutMs);
    socket.setTimeout(effectiveTimeoutMs, onTimeout);
    socket.once("error", error => finish(() => reject(error)));
    socket.once("close", () => finish(() => reject(new Error("Bflow host closed before acknowledgement; reconcile before retry"))));
    socket.once("connect", () => socket.write(JSON.stringify({ token, method, params }) + "\n"));
    socket.on("data", chunk => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const newlineInChunk = buf.indexOf(10);
      if (newlineInChunk < 0) {
        totalBytes += buf.length;
        if (totalBytes > maxResponseBytes) { socket.destroy(); finish(() => reject(new Error("Host response exceeds limit"))); return; }
        chunks.push(buf);
        return;
      }
      const lineBytes = totalBytes + newlineInChunk;
      if (lineBytes > maxResponseBytes) { socket.destroy(); finish(() => reject(new Error("Host response exceeds limit"))); return; }
      const prefix = buf.subarray(0, newlineInChunk);
      chunks.push(prefix);
      const full = Buffer.concat(chunks, lineBytes);
      socket.end();
      try {
        const response = record(JSON.parse(full.toString("utf8")));
        if (response.ok === true) {
          const value = response.value;
          finish(() => accept(value));
        } else {
          const rawError = response.error;
          const message =
            typeof rawError === "string" && rawError.trim().length > 0
              ? rawError
              : typeof rawError === "object" &&
                  rawError !== null &&
                  !Array.isArray(rawError) &&
                  typeof (rawError as Record<string, unknown>).message === "string" &&
                  ((rawError as Record<string, unknown>).message as string).trim().length > 0
                ? ((rawError as Record<string, unknown>).message as string)
                : textField(rawError);
          finish(() => reject(new Error(message)));
        }
      } catch (error) { finish(() => reject(error)); }
    });
  });
}
