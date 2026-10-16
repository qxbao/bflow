import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  type AgentEnvironment,
  type AgentLaunchAttestation,
  AgentLaunchAttestationSchema,
  type AgentLaunchProfile,
  type AgentProviderId,
  canonicalReceiptJson
} from "@bflow/contracts";

export const ATTESTATION_SIGNING_PREFIX = "bflow.agent-launch-attestation.v3\n";

export function attestationSigningBytes(
  attestation: Omit<AgentLaunchAttestation, "signature"> | AgentLaunchAttestation
): Uint8Array {
  const { signature: _sig, ...body } = attestation as AgentLaunchAttestation;
  return Buffer.from(ATTESTATION_SIGNING_PREFIX + canonicalReceiptJson(body), "utf8");
}

export function createSignedLaunchAttestation(input: {
  readonly receiptId: string;
  readonly issuerId: string;
  readonly launchId: string;
  readonly launchFingerprint: string;
  readonly sessionId: string;
  readonly paneId: string;
  readonly nativeSession: AgentLaunchAttestation["nativeSession"];
  readonly observedAt: string;
  readonly privateKeyPem: string;
}): AgentLaunchAttestation {
  const body = {
    schemaVersion: 3 as const,
    receiptId: input.receiptId,
    issuerId: input.issuerId,
    launchId: input.launchId,
    launchFingerprint: input.launchFingerprint,
    sessionId: input.sessionId,
    paneId: input.paneId,
    nativeSession: input.nativeSession,
    observedAt: input.observedAt
  };

  const signingBytes = attestationSigningBytes(body);
  const privateKey = createPrivateKey(input.privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Private key must be an Ed25519 key");
  }

  const signatureBytes = sign(null, signingBytes, privateKey);
  const signatureValue = Buffer.from(signatureBytes).toString("base64");

  return AgentLaunchAttestationSchema.parse({
    ...body,
    signature: {
      algorithm: "ed25519" as const,
      value: signatureValue
    }
  });
}

export function verifyLaunchAttestation(
  attestation: AgentLaunchAttestation,
  trustedIssuerKeys: Readonly<Record<string, string>>,
  expected?: {
    readonly launchProfile?: AgentLaunchProfile;
    readonly sessionId?: string;
    readonly provider?: AgentProviderId;
    readonly maxObservedAtMs?: number;
    readonly now?: Date;
  }
): { valid: boolean; code: string; message: string } {
  const parseResult = AgentLaunchAttestationSchema.safeParse(attestation);
  if (!parseResult.success) {
    return {
      valid: false,
      code: "invalid_schema",
      message: `Attestation failed schema validation: ${parseResult.error.message}`
    };
  }

  const trustedKeyPem = trustedIssuerKeys[attestation.issuerId];
  if (!trustedKeyPem) {
    return {
      valid: false,
      code: "unknown_issuer",
      message: `Issuer '${attestation.issuerId}' is not configured in trusted issuer keys`
    };
  }

  try {
    const publicKey = createPublicKey(trustedKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      return {
        valid: false,
        code: "invalid_key_type",
        message: `Issuer key for '${attestation.issuerId}' is not an Ed25519 public key`
      };
    }

    const signingBytes = attestationSigningBytes(attestation);
    const signatureBuffer = Buffer.from(attestation.signature.value, "base64");
    const verified = verify(null, signingBytes, publicKey, signatureBuffer);
    if (!verified) {
      return {
        valid: false,
        code: "invalid_signature",
        message: "Launch attestation signature verification failed"
      };
    }
  } catch (err) {
    return {
      valid: false,
      code: "signature_verification_error",
      message: `Signature verification error: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  if (expected?.launchProfile !== undefined) {
    if (attestation.launchId !== expected.launchProfile.launchId) {
      return {
        valid: false,
        code: "launch_id_mismatch",
        message: `Attestation launchId '${attestation.launchId}' does not match expected profile launchId '${expected.launchProfile.launchId}'`
      };
    }
    if (attestation.launchFingerprint !== expected.launchProfile.launchFingerprint) {
      return {
        valid: false,
        code: "launch_fingerprint_mismatch",
        message: `Attestation launchFingerprint '${attestation.launchFingerprint}' does not match expected profile '${expected.launchProfile.launchFingerprint}'`
      };
    }
  }

  if (expected?.sessionId !== undefined) {
    if (attestation.sessionId !== expected.sessionId) {
      return {
        valid: false,
        code: "session_id_mismatch",
        message: `Attestation sessionId '${attestation.sessionId}' does not match expected sessionId '${expected.sessionId}'`
      };
    }
  }

  if (expected?.provider !== undefined) {
    if (attestation.nativeSession.source !== expected.provider) {
      return {
        valid: false,
        code: "provider_mismatch",
        message: `Attestation nativeSession.source '${attestation.nativeSession.source}' does not match expected provider '${expected.provider}'`
      };
    }
  }

  const nowMs = (expected?.now ?? new Date()).getTime();
  const observedAtMs = Date.parse(attestation.observedAt);

  if (observedAtMs > nowMs + 5_000) {
    return {
      valid: false,
      code: "future_timestamp",
      message: "Launch attestation observedAt timestamp is in the future"
    };
  }

  if (expected?.maxObservedAtMs !== undefined) {
    if (nowMs - observedAtMs > expected.maxObservedAtMs) {
      return {
        valid: false,
        code: "expired",
        message: `Launch attestation expired (${nowMs - observedAtMs}ms old > max ${expected.maxObservedAtMs}ms)`
      };
    }
  }

  return {
    valid: true,
    code: "verified",
    message: "Launch attestation verified successfully"
  };
}

export function computeCanonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalReceiptJson(value), "utf8").digest("hex");
}

export async function computeFileSha256(
  filePath: string,
  options?: { readonly maxSizeBytes?: number }
): Promise<string> {
  const maxBytes = options?.maxSizeBytes ?? 64 * 1024 * 1024;
  const fd = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) {
      throw new Error(`File at '${filePath}' is not a regular file`);
    }
    if (stat.size > maxBytes) {
      throw new Error(
        `File at '${filePath}' exceeds maximum allowed size of ${maxBytes} bytes (size: ${stat.size})`
      );
    }
    const buffer = await fd.readFile();
    return createHash("sha256").update(buffer).digest("hex");
  } finally {
    await fd.close();
  }
}

export async function resolveAndVerifyExecutable(
  executableOrName: string,
  options?: {
    readonly searchPath?: string;
    readonly allowTestFilesystemOwnership?: boolean;
  }
): Promise<{ readonly canonicalPath: string; readonly digest: string }> {
  if (!executableOrName || executableOrName.includes("\0") || !executableOrName.trim()) {
    const err = new Error("Executable name is empty or contains NUL");
    (err as NodeJS.ErrnoException).code = "binary_missing";
    throw err;
  }

  let candidatePath: string | undefined;
  if (executableOrName.includes("/")) {
    candidatePath = isAbsolute(executableOrName) ? executableOrName : resolve(executableOrName);
  } else {
    const pathEnv = options?.searchPath ?? process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue;
      const full = join(dir, executableOrName);
      try {
        const real = await realpath(full);
        candidatePath = real;
        break;
      } catch {
        // continue searching PATH
      }
    }
  }

  if (!candidatePath) {
    const err = new Error(`Executable '${executableOrName}' was not found on PATH`);
    (err as NodeJS.ErrnoException).code = "binary_missing";
    throw err;
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidatePath);
  } catch (cause) {
    const err = new Error(
      `Executable '${candidatePath}' does not exist: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    (err as NodeJS.ErrnoException).code = "binary_missing";
    throw err;
  }

  const fd = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) {
      const err = new Error(`Executable '${canonicalPath}' is not a regular file`);
      (err as NodeJS.ErrnoException).code = "binary_not_executable";
      throw err;
    }
    if ((stat.mode & 0o111) === 0) {
      const err = new Error(`Executable '${canonicalPath}' does not have execute permissions`);
      (err as NodeJS.ErrnoException).code = "binary_not_executable";
      throw err;
    }
    if ((stat.mode & 0o022) !== 0) {
      const err = new Error(
        `Executable '${canonicalPath}' is group/world writable (${(stat.mode & 0o777).toString(8)})`
      );
      (err as NodeJS.ErrnoException).code = "binary_untrusted";
      throw err;
    }
    if (!options?.allowTestFilesystemOwnership) {
      if (typeof process.getuid === "function") {
        const currentUid = process.getuid();
        if (stat.uid !== 0 && stat.uid !== currentUid) {
          const err = new Error(
            `Executable '${canonicalPath}' has untrusted owner UID ${stat.uid} (expected 0 or ${currentUid})`
          );
          (err as NodeJS.ErrnoException).code = "binary_untrusted";
          throw err;
        }
      }
    }
    if (stat.size > 256 * 1024 * 1024) {
      const err = new Error(`Executable '${canonicalPath}' exceeds maximum binary size`);
      (err as NodeJS.ErrnoException).code = "binary_untrusted";
      throw err;
    }
    const buffer = await fd.readFile();
    const digest = createHash("sha256").update(buffer).digest("hex");
    return { canonicalPath, digest };
  } finally {
    await fd.close();
  }
}

export function computeLaunchFingerprint(input: {
  readonly environment: AgentEnvironment;
  readonly executableDigest: string;
  readonly providerVersion: string;
  readonly argv: readonly string[];
  readonly configFiles: readonly { readonly path: string; readonly digest: string }[];
  readonly interaction: "conversation" | "no_direct_user_input";
}): string {
  const sortedSecretKeys = Object.keys(input.environment.secretBindings).sort();
  const sortedSecretBindings = sortedSecretKeys.map((key) => ({
    key,
    reference: input.environment.secretBindings[key]
  }));

  const sortedConfigFiles = [...input.configFiles]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((cf) => ({ path: cf.path, digest: cf.digest }));

  const fingerprintData = {
    schemaVersion: 3,
    environmentId: input.environment.environmentId,
    provider: input.environment.provider,
    role: input.environment.role,
    scope: input.environment.scope,
    cwd: input.environment.cwd,
    stateDirectory: input.environment.stateDirectory,
    configFingerprint: input.environment.configFingerprint,
    permissionProfile: input.environment.permissionProfile,
    environmentVariables: input.environment.environmentVariables,
    secretBindings: sortedSecretBindings,
    requiredCapabilityIds: [...input.environment.requiredCapabilityIds].sort(),
    requiredMcpServiceIds: [...input.environment.requiredMcpServiceIds].sort(),
    skillManifestDigest: input.environment.skillManifestDigest,
    executableDigest: input.executableDigest,
    providerVersion: input.providerVersion,
    argv: input.argv,
    configFiles: sortedConfigFiles,
    interaction: input.interaction
  };

  return computeCanonicalSha256(fingerprintData);
}
