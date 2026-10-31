import { connect } from "node:net";
import { JsonValueSchema } from "@bflow/contracts";
import { record, textField } from "./journal.js";

/** Private control protocol. Role traffic still travels through signed native Herdr actions. */
export async function callHost(socketPath: string, token: string, method: string, params: unknown = {}, timeoutMs = 30_000, signal?: AbortSignal): Promise<unknown> {
  // Aggregate checkpoints legitimately exceed ordinary status/control replies; keep both paths bounded.
  const maxResponseBytes = (method === "checkpoint" ? 16 : 4) * 1024 * 1024;
  JsonValueSchema.parse(params);
  signal?.throwIfAborted();
  return new Promise((accept, reject) => {
    const socket = connect(socketPath);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const abort = () => { socket.destroy(); finish(() => reject(signal?.reason ?? new Error("Host request aborted; reconcile before retry"))); };
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("close", () => signal?.removeEventListener("abort", abort));
    socket.setTimeout(timeoutMs, () => { socket.destroy(); finish(() => reject(new Error(`Bflow host ${method} acknowledgement timed out after ${timeoutMs}ms; reconcile before retry`))); });
    socket.once("error", error => finish(() => reject(error)));
    socket.once("close", () => finish(() => reject(new Error("Bflow host closed before acknowledgement; reconcile before retry"))));
    socket.once("connect", () => socket.write(JSON.stringify({ token, method, params }) + "\n"));
    socket.on("data", chunk => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxResponseBytes) { socket.destroy(); finish(() => reject(new Error("Host response exceeds limit"))); return; }
      chunks.push(buf);
      if (buf.indexOf(10) < 0) return;
      const full = Buffer.concat(chunks, totalBytes);
      const lineEnd = full.indexOf(10);
      socket.end();
      try {
        const response = record(JSON.parse(full.subarray(0, lineEnd).toString("utf8")));
        if (response.ok === true) {
          finish(() => accept(response.value));
        } else {
          const errMessage = typeof response.error === "string" && response.error.trim().length > 0
            ? response.error
            : response.error && typeof response.error === "object" && !Array.isArray(response.error)
              ? textField((response.error as Record<string, unknown>).message)
              : textField(response.error);
          const err = new Error(errMessage);
          finish(() => reject(err));
        }
      } catch (error) { finish(() => reject(error)); }
    });
  });
}
