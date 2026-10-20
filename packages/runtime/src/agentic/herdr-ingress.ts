import { AsyncLocalStorage } from "node:async_hooks";
import { createPublicKey, verify } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { RoleMessageSchema, canonicalReceiptJson, type RoleMessage } from "@bflow/contracts";
import { record, textField } from "./journal.js";

const authenticated = new AsyncLocalStorage<string>();
/** Use only as a host authentication callback; an agent cannot supply this context. */
export async function authenticateNativeHerdrMessage(message: RoleMessage): Promise<boolean> {
  return authenticated.getStore() === canonicalReceiptJson(message);
}
/**
 * Host-internal delivery of a Runtime-authored message that has no pane to sign it. The caller must already have proven the
 * message is the exact Runtime outbox delivery (validateProviderDelivery); pane or model content never reaches this.
 */
export function runAsHostAuthenticated<T>(message: RoleMessage, work: () => Promise<T>): Promise<T> {
  if (message.sender.role !== "runtime" || message.sender.agent_id !== undefined || message.sender.pane_id !== undefined)
    throw new Error("Host authentication is only for Runtime-authored messages");
  return authenticated.run(canonicalReceiptJson(message), work);
}
/** Receives messages forwarded by a signed native Herdr plugin invocation, never terminal snapshots. */
export async function startHerdrReceiptIngress(options: {
  socketPath: string; publicKeys: Readonly<Record<string, string>>;
  receive(message: RoleMessage): Promise<unknown>;
  /** Called only for a signature-verified message whose processing failed, so the failure can be surfaced instead of vanishing. */
  failed?(message: RoleMessage, error: unknown): Promise<void>;
}): Promise<{ close(): Promise<void> }> {
  // Refuse to steal an existing socket, including a potentially live host's endpoint.
  try { await lstat(options.socketPath); throw new Error("Herdr receipt endpoint already exists; reconcile its owner"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.setTimeout(15_000, () => socket.destroy());
    let buffer = Buffer.alloc(0), started = false;
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", chunk => {
      if (started) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      const end = buffer.indexOf(10); if (end < 0) return;
      started = true;
      void (async () => {
        const packet = record(JSON.parse(buffer.subarray(0, end).toString("utf8")));
        const issuer = textField(packet.issuerId), signature = textField(packet.signature);
        const message = RoleMessageSchema.parse(packet.message);
        const key = options.publicKeys[issuer];
        if (!key || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error("Untrusted Herdr native issuer/signature");
        const publicKey = createPublicKey(key);
        if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(canonicalReceiptJson(message)), publicKey, Buffer.from(signature, "base64")))
          throw new Error("Invalid native Herdr message signature");
        try { await authenticated.run(canonicalReceiptJson(message), () => options.receive(message)); }
        catch (error) { await options.failed?.(message, error).catch(() => undefined); throw error; }
        socket.end(JSON.stringify({ ok: true, messageId: message.message_id }) + "\n");
      })().catch(() => { socket.end(JSON.stringify({ ok: false, error: "Herdr message authentication or processing failed" }) + "\n"); });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.socketPath, resolve); });
  await chmod(options.socketPath, 0o600);
  return { async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try { await unlink(options.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } };
}
