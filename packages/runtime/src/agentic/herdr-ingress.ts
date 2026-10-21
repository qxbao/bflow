import { AsyncLocalStorage } from "node:async_hooks";
import { createPublicKey, verify } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { RoleMessageSchema, canonicalReceiptJson, type RoleMessage } from "@bflow/contracts";
import { record, textField } from "./journal.js";
import { nativeEnvelopeIssues } from "./native-delivery-status.js";

const authenticated = new AsyncLocalStorage<string>();
/** Use only as a host authentication callback; an agent cannot supply this context. */
export async function authenticateNativeHerdrMessage(message: RoleMessage): Promise<boolean> {
  return authenticated.getStore() === canonicalReceiptJson(message);
}
/** Trusted Runtime recovery only: the caller must match the exact previously authenticated received journal row.
 * This restores that receipt's scoped provenance for result/evidence validators; it creates no transport receipt or delivery.
 * It is never exposed through an agent tool or selected by an envelope field.
 */
export function withRecoveredHerdrReceipt<T>(message: RoleMessage, apply: () => Promise<T>): Promise<T> {
  return authenticated.run(canonicalReceiptJson(RoleMessageSchema.parse(message)), apply);
}
/** Receives messages forwarded by a signed native Herdr plugin invocation, never terminal snapshots. */
export async function startHerdrReceiptIngress(options: {
  socketPath: string; publicKeys: Readonly<Record<string, string>>;
  receive(message: RoleMessage): Promise<unknown>;
  /** Called only for a signature-verified message whose processing failed, so the failure can be surfaced instead of vanishing. */
  failed?(message: RoleMessage, error: unknown): Promise<void>;
  /** Only after signature verification, and before Runtime receive or any business write. */
  rejected?(message: RoleMessage): Promise<void>;
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
        const issues = nativeEnvelopeIssues(message);
        if (issues.length) {
          // Keep native-required fields strict. Persist the observed refusal before responding, never promote a timeout to refusal.
          await options.rejected?.(message);
          socket.end(JSON.stringify({ ok: false, code: "native_envelope_rejected", issues }) + "\n");
          return;
        }
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
