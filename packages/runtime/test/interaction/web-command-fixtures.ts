import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { canonicalWebJson, webCommandFingerprint } from "@bflow/contracts/web-host";
import { WebCommandSchema } from "@bflow/contracts";

export const now = Date.parse("2026-10-28T00:00:00.000Z");
export function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const command = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project-1",
    kind: "create_request", title: "Create a report", requestKind: "feature", objective: "Export a report",
    acceptanceCriteria: [{ description: "Report opens", verificationMethod: "unit_test" }], constraints: [] });
  const registration = { issuerId: "server-1", keyId: "key-1", principalId: "local-user-1", projectId: "project-1",
    hostSessionId: "host-1", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const proof = (body = command, overrides: Record<string, unknown> = {}) => {
    const payload = { schemaVersion: 1, source: "local_web", issuerId: "server-1", keyId: "key-1",
      principalId: "local-user-1", browserSessionId: "browser-1", projectId: "project-1", hostSessionId: "host-1",
      capability: "user_interaction", commandId: body.commandId, commandDigest: webCommandFingerprint(body),
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), nonce: randomUUID(), ...overrides };
    return { ...payload, signature: { algorithm: "ed25519", value: sign(null, Buffer.from(canonicalWebJson(payload)), keys.privateKey).toString("base64") } };
  };
  return { command, registration, proof };
}
