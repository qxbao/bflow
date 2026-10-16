import { connect } from "node:net";
import { JsonValueSchema } from "@bflow/contracts";
import { record, textField } from "./journal.js";

/** Private control protocol. Role traffic still travels through signed native Herdr actions. */
export async function callHost(socketPath: string, token: string, method: string, params: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
  JsonValueSchema.parse(params);
  return new Promise((accept, reject) => {
    const socket = connect(socketPath); let buffer = "";
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error("Bflow host acknowledgement timed out; reconcile before retry")); });
    socket.once("error", reject);
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
