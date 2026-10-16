import { randomBytes, createHash } from "node:crypto";
import {
  type JsonValue,
  type MCPServiceDefinition,
  type OperationResult,
  type TrustScope,
  canonicalReceiptJson,
  isTrustScopeWithin
} from "@bflow/contracts";
import type { MCPBackendSharingPolicy } from "./types.js";
import { err, ok } from "./types.js";

/**
 * Validates platform schemaVersion against supported version 3.
 */
export function checkSchemaVersion(input: unknown): OperationResult<number> {
  if (typeof input === "object" && input !== null && "schemaVersion" in input) {
    const v = (input as { schemaVersion?: unknown }).schemaVersion;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v !== 3) {
      return err({
        code: "unsupported_version",
        retryable: false,
        supportedVersions: [3],
        receivedVersion: v,
        message: `Unsupported platform schemaVersion: ${v}`
      });
    }
    if (v === 3) {
      return ok(3);
    }
  }
  return err({
    code: "validation",
    retryable: false,
    message: "Missing or invalid schemaVersion (expected 3)"
  });
}

/**
 * Redacts secret credentials, bearer tokens, and API keys from string text.
 */
export function scrubSecrets(text: string, customSecrets?: readonly string[]): string {
  if (!text) {
    return text;
  }
  let result = text;

  // 1. Bearer tokens: Bearer\s+[A-Za-z0-9._~+/=-]+ -> Bearer [REDACTED]
  result = result.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]");

  // 2. Secret references: secret://[A-Za-z0-9._/-]+ -> secret://[REDACTED]
  result = result.replace(/secret:\/\/[A-Za-z0-9._/-]+/g, "secret://[REDACTED]");

  // 3. OpenAI/Claude-style secret keys: sk-[A-Za-z0-9_-]{8,} -> [REDACTED_KEY]
  result = result.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_KEY]");

  // 4. GitHub personal access tokens: ghp_[A-Za-z0-9]{8,} -> [REDACTED_TOKEN]
  result = result.replace(/ghp_[A-Za-z0-9]{8,}/g, "[REDACTED_TOKEN]");

  // 5. Google API keys: AIza[A-Za-z0-9_-]{8,} -> [REDACTED_KEY]
  result = result.replace(/AIza[A-Za-z0-9_-]{8,}/g, "[REDACTED_KEY]");

  // 6. URL credentials: https?:\/\/[^/\s:@]+:[^/\s@]+@ -> https://[REDACTED]@
  result = result.replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/g, "https://[REDACTED]@");

  // 7. Optional custom registered raw secrets
  if (customSecrets && customSecrets.length > 0) {
    for (const secret of customSecrets) {
      if (secret && secret.length >= 4) {
        result = result.split(secret).join("[REDACTED]");
      }
    }
  }

  return result;
}

const SENSITIVE_KEY_REGEX = /token|secret|password|authorization|credential/i;
const SENSITIVE_KEY_WHITELIST = new Set([
  "fencingtoken",
  "schemaversion",
  "totaltokens",
  "inputtokens",
  "outputtokens",
  "maxtokens",
  "prompttokens",
  "completiontokens"
]);

/**
 * Deep-clones JSON-like values, scrubbing string values with scrubSecrets
 * and redacting keys matching /token|secret|password|authorization|credential/i.
 */
export function scrubObjectSecrets<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      return scrubSecrets(value) as unknown as T;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubObjectSecrets(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, "");
    if (SENSITIVE_KEY_REGEX.test(key) && !SENSITIVE_KEY_WHITELIST.has(normalized)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = scrubObjectSecrets(val);
    }
  }
  return result as T;
}

/**
 * Computes SHA-256 digest over canonical JSON representation of input.
 */
export function computePayloadFingerprint(value: unknown): string {
  const json = canonicalReceiptJson(value as JsonValue);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/**
 * Gateway-managed secret and client bearer token store.
 */
export class GatewaySecretStore {
  private readonly secretRefToValue = new Map<string, string>();
  private readonly registrationToToken = new Map<string, string>();
  private readonly tokenToRegistration = new Map<string, string>();
  private readonly registrationToSecretRef = new Map<string, string>();

  issueClientToken(registrationId: string, secretRef: string): string {
    const oldToken = this.registrationToToken.get(registrationId);
    if (oldToken) {
      this.tokenToRegistration.delete(oldToken);
      this.registrationToToken.delete(registrationId);
    }
    const token = randomBytes(32).toString("hex");
    this.registrationToToken.set(registrationId, token);
    this.tokenToRegistration.set(token, registrationId);
    this.registrationToSecretRef.set(registrationId, secretRef);
    return token;
  }

  getClientTokenByRegistration(registrationId: string): string | undefined {
    return this.registrationToToken.get(registrationId);
  }

  setSecret(secretRef: string, rawValue: string): void {
    this.secretRefToValue.set(secretRef, rawValue);
  }

  getSecret(secretRef: string): string | undefined {
    return this.secretRefToValue.get(secretRef);
  }

  resolveRegistrationByToken(bearerToken: string): string | undefined {
    const token = bearerToken.startsWith("Bearer ")
      ? bearerToken.slice(7).trim()
      : bearerToken.trim();
    return this.tokenToRegistration.get(token) ?? this.tokenToRegistration.get(bearerToken);
  }

  revokeClientToken(registrationId: string): void {
    const token = this.registrationToToken.get(registrationId);
    if (token) {
      this.tokenToRegistration.delete(token);
      this.registrationToToken.delete(registrationId);
    }
    this.registrationToSecretRef.delete(registrationId);
  }

  rotateSecret(secretRef: string, newRawValue: string): void {
    this.setSecret(secretRef, newRawValue);
    for (const [registrationId, ref] of this.registrationToSecretRef.entries()) {
      if (ref === secretRef) {
        this.issueClientToken(registrationId, secretRef);
      }
    }
  }

  getAllSecrets(): readonly string[] {
    return Array.from(this.secretRefToValue.values());
  }
}

/**
 * Validates that an incoming HTTP Host header points to a local loopback interface.
 */
export function validateLoopbackHost(
  hostHeader: string | undefined,
  allowedHosts?: readonly string[]
): boolean {
  if (!hostHeader || typeof hostHeader !== "string") {
    return false;
  }
  const trimmed = hostHeader.trim();
  if (!trimmed) {
    return false;
  }
  if (allowedHosts && allowedHosts.includes(trimmed)) {
    return true;
  }

  let hostWithoutPort = trimmed;
  if (trimmed.startsWith("[")) {
    const closeIndex = trimmed.indexOf("]");
    if (closeIndex !== -1) {
      hostWithoutPort = trimmed.slice(0, closeIndex + 1);
    }
  } else {
    const colonIndex = trimmed.lastIndexOf(":");
    if (colonIndex !== -1 && trimmed.indexOf(":") === colonIndex) {
      hostWithoutPort = trimmed.slice(0, colonIndex);
    }
  }

  const unbracketed =
    hostWithoutPort.startsWith("[") && hostWithoutPort.endsWith("]")
      ? hostWithoutPort.slice(1, -1)
      : hostWithoutPort;

  const valid = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "[127.0.0.1]"]);
  if (valid.has(hostWithoutPort) || valid.has(unbracketed)) {
    return true;
  }
  if (allowedHosts) {
    if (allowedHosts.includes(hostWithoutPort) || allowedHosts.includes(unbracketed)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates the Origin header: missing or empty is allowed for local daemon/CLI callers,
 * while browser origins are rejected unless explicitly allowed.
 */
export function validateRequestOrigin(
  originHeader: string | undefined,
  allowedOrigins?: readonly string[]
): boolean {
  if (originHeader === undefined || originHeader.trim() === "") {
    return true;
  }
  return Boolean(allowedOrigins && allowedOrigins.includes(originHeader));
}

/**
 * Computes deterministic partition key for service instance multiplexing and isolation.
 */
export function computePartitionKey(
  service: MCPServiceDefinition,
  policy: MCPBackendSharingPolicy,
  callerScope: TrustScope
): OperationResult<string> {
  if (
    policy.concurrencyModel === "unsupported" ||
    policy.sessionIsolationPolicy === "unsupported" ||
    policy.sharedStatePolicy === "unsafe_unshareable"
  ) {
    return err({
      code: "validation",
      retryable: false,
      message: `Service '${service.serviceId}' cannot be safely shared or multiplexed under its policy`,
      details: { diagnosticCode: "sharing_unsupported" }
    });
  }

  if (!isTrustScopeWithin(callerScope, service.scope)) {
    return err({
      code: "validation",
      retryable: false,
      message: `Scope violation: caller scope is outside service '${service.serviceId}' trust scope`,
      details: { diagnosticCode: "cross_scope_denied" }
    });
  }

  const base = `${service.serviceId}@r${service.revision}:m:${callerScope.machineId}`;

  if (
    policy.sessionIsolationPolicy === "session_partition" ||
    policy.sessionIsolationPolicy === "task_isolated" ||
    policy.concurrencyModel === "single_client_isolated" ||
    policy.sharedStatePolicy === "partitioned_by_session"
  ) {
    if (callerScope.kind !== "session") {
      return err({
        code: "validation",
        retryable: false,
        message: `Service '${service.serviceId}' requires session-level isolation scope`,
        details: { diagnosticCode: "session_scope_required" }
      });
    }
    return ok(
      `${base}:repo:${callerScope.repositoryId}:root:${callerScope.workspaceRoot}:session:${callerScope.sessionId}`
    );
  }

  if (
    policy.sessionIsolationPolicy === "repository_partition" ||
    policy.sharedStatePolicy === "partitioned_by_repo" ||
    service.scope.kind !== "machine"
  ) {
    if (callerScope.kind === "machine") {
      return ok(`${base}:machine-only`);
    }
    return ok(`${base}:repo:${callerScope.repositoryId}:root:${callerScope.workspaceRoot}`);
  }

  if (
    service.scope.kind === "machine" &&
    (policy.sharedStatePolicy === "stateless" ||
      policy.sharedStatePolicy === "mutable_shared_exclusive")
  ) {
    return ok(`${base}:machine-shared`);
  }

  return ok(
    callerScope.kind === "machine"
      ? `${base}:machine`
      : `${base}:repo:${callerScope.repositoryId}:root:${callerScope.workspaceRoot}`
  );
}

/**
 * Evaluates whether an existing active partition can be shared with a new client connection.
 */
export function evaluateSharingCompatibility(
  service: MCPServiceDefinition,
  policy: MCPBackendSharingPolicy,
  callerScope: TrustScope,
  existingActiveClients: number
): OperationResult<{ partitionKey: string; canShareExisting: boolean }> {
  const partitionRes = computePartitionKey(service, policy, callerScope);
  if (!partitionRes.ok) {
    return err(partitionRes.error);
  }

  if (policy.concurrencyModel === "single_client_isolated" && existingActiveClients > 0) {
    return err({
      code: "conflict",
      retryable: true,
      message: `Service '${service.serviceId}' policy 'single_client_isolated' forbids multiple concurrent clients in the same partition`,
      details: { diagnosticCode: "single_client_limit" }
    });
  }

  return ok({
    partitionKey: partitionRes.value,
    canShareExisting: true
  });
}

const FORBIDDEN_INTERACTIVE_METHODS = new Set([
  "elicitation/create",
  "sampling/createMessage",
  "oauth/interactive",
  "browser/permissionPrompt",
  "roots/list_interactive"
]);

/**
 * Checks if an MCP method is an unauthorized direct interactive prompt that must be
 * routed through Conversation rather than executed directly by the upstream worker.
 */
export function isInteractiveMethodForbidden(method: string): boolean {
  return FORBIDDEN_INTERACTIVE_METHODS.has(method) || method.startsWith("elicitation/");
}
