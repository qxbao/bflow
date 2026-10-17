import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { type AgentLaunchAttestation, IdentifierSchema } from "@bflow/contracts";
import { createSignedLaunchAttestation } from "@bflow/agent-providers";
import type { LaunchAttestationInput, LaunchAttestationSigner } from "./ports.js";

export interface Ed25519LaunchAttestationSignerOptions {
  readonly issuerId: string;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}

const PROBE_MESSAGE = Buffer.from("bflow.launch-attestation-signer.probe.v3", "utf8");

/**
 * Host-held Ed25519 launch attestation issuer. The private key is kept in an ES private
 * field: it is never exposed as a property, serialized or included in error messages.
 */
export class Ed25519LaunchAttestationSigner implements LaunchAttestationSigner {
  readonly issuerId: string;
  readonly publicKeyPem: string;
  readonly #privateKeyPem: string;

  constructor(options: Ed25519LaunchAttestationSignerOptions) {
    const issuer = IdentifierSchema.safeParse(options.issuerId);
    if (!issuer.success) {
      throw new Error("launch attestation issuerId must be a valid identifier");
    }

    let privateKey;
    let publicKey;
    try {
      privateKey = createPrivateKey(options.privateKeyPem);
      publicKey = createPublicKey(options.publicKeyPem);
    } catch {
      throw new Error("launch attestation key material could not be parsed as PEM");
    }
    if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("launch attestation signer requires an Ed25519 key pair");
    }
    const signature = sign(null, PROBE_MESSAGE, privateKey);
    if (!verify(null, PROBE_MESSAGE, publicKey, signature)) {
      throw new Error("launch attestation private and public keys do not form a pair");
    }

    this.issuerId = issuer.data;
    this.publicKeyPem = options.publicKeyPem;
    this.#privateKeyPem = options.privateKeyPem;
  }

  sign(input: LaunchAttestationInput): AgentLaunchAttestation {
    return createSignedLaunchAttestation({
      receiptId: input.receiptId,
      issuerId: this.issuerId,
      launchId: input.launchId,
      launchFingerprint: input.launchFingerprint,
      sessionId: input.sessionId,
      paneId: input.paneId,
      nativeSession: input.nativeSession,
      observedAt: input.observedAt,
      privateKeyPem: this.#privateKeyPem
    });
  }

  /** Test and bootstrap helper: generates a fresh Ed25519 pair for the given issuer. */
  static generate(issuerId: string): Ed25519LaunchAttestationSigner {
    const pair = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    return new Ed25519LaunchAttestationSigner({
      issuerId,
      privateKeyPem: pair.privateKey,
      publicKeyPem: pair.publicKey
    });
  }
}
