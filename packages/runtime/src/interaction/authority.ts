import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { IdentifierSchema, WebCommandSchema } from "@bflow/contracts";
import { canonicalWebJson, WebPrincipalSchema, webCommandFingerprint, type WebPrincipal } from "@bflow/contracts/web-host";

// Private owner-composition input. This is deliberately not a role tool, browser
// payload, persisted trust root, or public contracts amendment.
export const OwnerKeySchema = z.object({
  issuerId: IdentifierSchema, keyId: IdentifierSchema, principalId: IdentifierSchema,
  projectId: IdentifierSchema, hostSessionId: IdentifierSchema, publicKey: z.string().min(1).max(16384),
}).strict();
type OwnerKey = z.infer<typeof OwnerKeySchema>;

/** Registration must be invoked only by owner-authenticated host composition.
 * A fresh host has no trusted issuers. Proof data can never register a key.
 * Nonce consumption belongs to the durable operation admission transaction.
 */
export class WebInteractionAuthority {
  private readonly issuers = new Map<string, { registration: OwnerKey; key: KeyObject }>();
  constructor(readonly projectId: string, readonly sessionId: string, private readonly now = Date.now) {
    IdentifierSchema.parse(projectId); IdentifierSchema.parse(sessionId);
  }
  private keyId(issuerId: string, keyId: string) { return canonicalWebJson([issuerId, keyId]); }
  registerOwnerKey(input: unknown): void {
    const registration = OwnerKeySchema.parse(input);
    if (registration.projectId !== this.projectId || registration.hostSessionId !== this.sessionId)
      throw new Error("Owner registration scope mismatch");
    const key = createPublicKey(registration.publicKey);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Owner key must be Ed25519");
    const id = this.keyId(registration.issuerId, registration.keyId), previous = this.issuers.get(id);
    if (previous && canonicalWebJson(previous.registration) !== canonicalWebJson(registration))
      throw new Error("Owner key identity conflict; rotate keyId explicitly");
    this.issuers.set(id, { registration, key });
  }
  revokeOwnerKey(issuerId: string, keyId: string): void { this.issuers.delete(this.keyId(issuerId, keyId)); }
  verify(commandInput: unknown, principalInput: unknown): WebPrincipal {
    const command = WebCommandSchema.parse(commandInput), principal = WebPrincipalSchema.parse(principalInput);
    const trusted = this.issuers.get(this.keyId(principal.issuerId, principal.keyId));
    if (!trusted || principal.principalId !== trusted.registration.principalId ||
      principal.projectId !== this.projectId || command.projectId !== this.projectId ||
      principal.hostSessionId !== this.sessionId || principal.commandId !== command.commandId ||
      principal.commandDigest !== webCommandFingerprint(command)) throw new Error("Web authority scope mismatch");
    const now = this.now();
    if (Date.parse(principal.issuedAt) > now + 5000 || Date.parse(principal.expiresAt) <= now)
      throw new Error("Web authority proof expired or issued in future");
    const { signature, ...body } = principal;
    if (!verify(null, Buffer.from(canonicalWebJson(body), "utf8"), trusted.key, Buffer.from(signature.value, "base64")))
      throw new Error("Web authority signature mismatch");
    return principal;
  }
}
