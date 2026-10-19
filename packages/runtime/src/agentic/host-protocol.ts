import { connect } from "node:net";
import { JsonValueSchema } from "@bflow/contracts";
import { record, textField } from "./journal.js";

/** Private control protocol. Role traffic still travels through signed native Herdr actions. */
export async function callHost(socketPath: string, token: string, method: string, params: unknown = {}, timeoutMs = 30_000, signal?: AbortSignal): Promise<unknown> {
  JsonValueSchema.parse(params);
  signal?.throwIfAborted();
  return new Promise((accept, reject) => {
    const socket = connect(socketPath); let buffer = "";
    const abort = () => { socket.destroy(); reject(signal?.reason ?? new Error("Host request aborted; reconcile before retry")); };
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("close", () => signal?.removeEventListener("abort", abort));
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error(`Bflow host ${method} acknowledgement timed out after ${timeoutMs}ms; reconcile before retry`)); });
    socket.once("error", reject);
    socket.once("close", () => { if (!buffer.includes("\n")) reject(new Error("Bflow host closed before acknowledgement; reconcile before retry")); });
    socket.once("connect", () => socket.write(JSON.stringify({ token, method, params }) + "\n"));
    socket.on("data", chunk => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { socket.destroy(); reject(new Error("Host response exceeds limit")); return; }
      if (!buffer.includes("\n")) return;
      socket.end();
      try { const response = record(JSON.parse(buffer.split("\n")[0]!));
        response.ok === true ? accept(response.value) : reject(new Error(textField(response.error)));
      } catch (error) { reject(error); }
    });
  });
}
