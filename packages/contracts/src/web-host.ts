/** Server/host codecs only. Never import this subpath from the browser. */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, JsonValueSchema } from "./common.js";
import { WebCommandSchema, WebOperationSchema, WebOperationKindSchema } from "./web.js";
const id = IdentifierSchema;
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export function canonicalWebJson(input: unknown): string {
  const value = JsonValueSchema.parse(input);
  function encode(item: typeof value): string {
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    if (item !== null && typeof item === "object") return `{${Object.keys(item).sort()
      .map(key => `${JSON.stringify(key)}:${encode(item[key]!)}`).join(",")}}`;
    return JSON.stringify(item);
  }
  return encode(value);
}
export function webCommandFingerprint(input: unknown): string {
  return createHash("sha256").update(canonicalWebJson(WebCommandSchema.parse(input))).digest("hex");
}
// Shape/lifetime codec only. Signature, trusted issuer, expiry-at-ingress and
// nonce consumption MUST be checked by W02 against owner-registered keys.
export const WebPrincipalSchema = z.object({ schemaVersion: z.literal(1), source: z.literal("local_web"),
  issuerId: id, keyId: id, principalId: id, browserSessionId: id, projectId: id, hostSessionId: id,
  capability: z.literal("user_interaction"), commandId: uuid, commandDigest: digest,
  issuedAt: IsoDateTimeSchema, expiresAt: IsoDateTimeSchema, nonce: id,
  signature: z.object({ algorithm: z.literal("ed25519"), value: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict()
}).strict().refine(value => {
  const lifetime = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
  return lifetime > 0 && lifetime <= 60000;
}, "proof lifetime must be 1..60000 milliseconds");
export type WebPrincipal = z.infer<typeof WebPrincipalSchema>;

export const WebInteractionReceiptSchema = z.object({ version: z.literal(2), repository: z.string().min(1), sessionId: id,
  kind: z.literal("web-interaction"), id: uuid,
  payload: z.object({ principal: WebPrincipalSchema, command: WebCommandSchema, fingerprint: digest, operation: WebOperationSchema }).strict(),
  checksum: digest
}).strict().superRefine((value, ctx) => {
  const { principal, command, fingerprint, operation } = value.payload;
  // Nested refinements can leave a dirty command. safeParse must never throw.
  const parsedCommand = WebCommandSchema.safeParse(command);
  if (!parsedCommand.success) {
    ctx.addIssue({ code: "custom", path: ["payload", "command"], message: "invalid receipt command" });
    return;
  }
  const { checksum, ...body } = value;
  if (checksum !== createHash("sha256").update(canonicalWebJson(body)).digest("hex"))
    ctx.addIssue({ code: "custom", path: ["checksum"], message: "web receipt checksum mismatch" });
  if (value.id !== command.commandId || value.id !== principal.commandId || value.id !== operation.operationId ||
      command.projectId !== principal.projectId || command.projectId !== operation.projectId ||
      value.sessionId !== principal.hostSessionId || operation.owner !== "host_interaction" || operation.operationKind !== command.kind ||
      fingerprint !== principal.commandDigest || fingerprint !== webCommandFingerprint(command))
    ctx.addIssue({ code: "custom", path: ["payload"], message: "web receipt identity/fingerprint mismatch" });
});
export type WebInteractionReceipt = z.infer<typeof WebInteractionReceiptSchema>;

/** Durable private index; lookup remains project/principal scoped across host sessions. */
export const WebOperationIndexRecordSchema = z.object({ schemaVersion: z.literal(1), projectId: id, principalId: id, commandId: uuid,
  owner: z.enum(["host_interaction", "local_lifecycle"]), operationKind: WebOperationKindSchema, fingerprint: digest,
  hostSessionId: id.optional(), receiptId: uuid, createdAt: IsoDateTimeSchema }).strict().superRefine((value, ctx) => {
  const lifecycle = value.operationKind === "session_start" || value.operationKind === "session_stop";
  if (lifecycle !== (value.owner === "local_lifecycle") || (value.owner === "host_interaction") !== (value.hostSessionId !== undefined) || value.receiptId !== value.commandId)
    ctx.addIssue({ code: "custom", message: "index owner/session/receipt identity mismatch" });
});
export type WebOperationIndexRecord = z.infer<typeof WebOperationIndexRecordSchema>;

/** Tagged read views preserve native-v1 bytes and provenance; no implicit upcast. */
export type WebReceiptReplayView<TNative> =
  | { readonly source: "native"; readonly receiptVersion: 1; readonly payload: TNative }
  | { readonly source: "local_web"; readonly receiptVersion: 2; readonly payload: WebInteractionReceipt };

// D-WEB-02: owner-side construction/provenance only; never exported by contracts/web.
export const LocalWebServerConfigSchema = z.object({
  host: z.literal('127.0.0.1'), port: z.number().int().min(0).max(65535),
  stateDirectory: z.string().min(1).refine(isAbsolute, 'expected absolute state directory'),
  assetsDirectory: z.string().min(1).refine(isAbsolute, 'expected absolute asset directory'),
}).strict();
export const WebAuthenticatedContextSchema = z.object({
  principalId: id, browserSessionId: id, expiresAt: IsoDateTimeSchema,
}).strict();
export type WebAuthenticatedContext = z.infer<typeof WebAuthenticatedContextSchema>;
export const WebIssuerRegistrationSchema = z.object({
  issuerId: id, keyId: id, principalId: id, projectId: id, hostSessionId: id,
  publicKey: z.string().min(1).max(16384),
}).strict();
export const WebIssuerCredentialSchema = z.object({
  credential: z.string().min(32), principalId: id, socketPath: z.string().min(1),
}).strict();
