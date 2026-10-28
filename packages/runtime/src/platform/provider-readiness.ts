import { createHash } from "node:crypto";
import {
  type AgentEnvironment,
  AgentHealthRequestSchema,
  type AgentHealthResult,
  AgentHealthResultSchema,
  type AgentLaunchAttestation,
  AgentLaunchProfileSchema,
  type AgentLaunchProfile,
  CURRENT_PLATFORM_SCHEMA_VERSION,
  canonicalReceiptJson,
  type OperationOptions,
  type OperationResult
} from "@bflow/contracts";
import { scrubDiagnosticText } from "@bflow/agent-providers";
import { fail, ok } from "./errors.js";
import type {
  ActivationRequest,
  ProviderAdapterContext,
  ProviderAdapterFactory,
  ProviderReadinessPort,
  LaunchJournalPort
} from "./ports.js";

export interface ProviderReadinessOptions {
  readonly factory: ProviderAdapterFactory;
  readonly journal: LaunchJournalPort;
  readonly now?: () => Date;
}

interface FreshHealth {
  readonly result: AgentHealthResult;
  readonly environment: AgentEnvironment;
}

interface PreparedLaunch {
  readonly profile: AgentLaunchProfile;
  readonly environment: AgentEnvironment;
}

const STALE_HEALTH = "health expired or missing; recheck before launch/dispatch";
const MAX_JOURNAL_MESSAGE = 2000;

function freshnessKey(environmentId: string, configFingerprint: string): string {
  return `${environmentId}:${configFingerprint}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scrubbedChecks(health: AgentHealthResult): Array<Record<string, string>> {
  return health.checks.map((check) => ({
    check: check.check,
    status: check.status,
    code: check.code,
    message: scrubDiagnosticText(check.message),
    ...(check.remediation !== undefined ? { remediation: scrubDiagnosticText(check.remediation) } : {})
  }));
}

function notReady(health: AgentHealthResult): OperationResult<AgentHealthResult> {
  const failing = health.checks.filter((check) => check.status !== "passed");
  const summary = failing.map((check) => `${check.check}:${check.code}`).join(", ") || "no passing checks";
  return fail<AgentHealthResult>(
    "validation",
    `Provider ${health.provider} ${health.stage} health is ${health.status} (${summary})`,
    { status: health.status, checks: scrubbedChecks(health) }
  );
}

/**
 * Gates provider launches on fail-closed preflight health, a journaled launch intent and
 * activated health backed by a host-signed startup attestation.
 */
export class ProviderReadiness implements ProviderReadinessPort {
  private readonly factory: ProviderAdapterFactory;
  private readonly journal: LaunchJournalPort;
  private readonly now: () => Date;
  private readonly fresh = new Map<string, FreshHealth>();
  private readonly launches = new Map<string, PreparedLaunch>();

  constructor(options: ProviderReadinessOptions) {
    this.factory = options.factory;
    this.journal = options.journal;
    this.now = options.now ?? (() => new Date());
  }

  async preflight(
    environment: AgentEnvironment,
    context: ProviderAdapterContext,
    options?: OperationOptions
  ): Promise<OperationResult<AgentHealthResult>> {
    const requestedAt = this.now().toISOString();
    const request = AgentHealthRequestSchema.safeParse({
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      environment,
      stage: "preflight",
      requestedAt
    });
    if (!request.success) {
      return fail("validation", `preflight request failed schema validation: ${request.error.message}`);
    }

    const adapter = this.factory(environment.provider, context, options);
    const outcome = await adapter.checkHealth(request.data, options);
    if (!outcome.ok) return outcome;

    const validated = this.validateHealth(outcome.value, environment, "preflight");
    if (!validated.ok) return validated;

    const key = freshnessKey(environment.environmentId, environment.configFingerprint);
    if (validated.value.status !== "ready") {
      this.fresh.delete(key);
      return notReady(validated.value);
    }
    this.fresh.set(key, { result: validated.value, environment });
    return ok(validated.value);
  }

  async prepareLaunch(
    environment: AgentEnvironment,
    context: ProviderAdapterContext,
    generation: number,
    options?: OperationOptions
  ): Promise<OperationResult<AgentLaunchProfile>> {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      return fail("validation", "launch generation must be a positive integer");
    }

    const now = this.now();
    const entry = this.lookupFresh(environment.environmentId, environment.configFingerprint, now);
    if (entry === undefined) return fail("conflict", STALE_HEALTH);
    if (entry.result.stage !== "preflight") {
      return fail("conflict", "fresh preflight required before launch; activated health does not authorize a new launch");
    }
    if (canonicalReceiptJson(entry.environment) !== canonicalReceiptJson(environment)) {
      return fail("conflict", "environment changed since preflight; recheck before launch");
    }

    const adapter = this.factory(environment.provider, context, options);
    const outcome = await adapter.prepareLaunch(environment, options);
    if (!outcome.ok) return outcome;

    const parsed = AgentLaunchProfileSchema.safeParse(outcome.value);
    if (!parsed.success) {
      return fail("validation", `launch profile failed schema validation: ${parsed.error.message}`);
    }
    const profile = parsed.data;
    if (canonicalReceiptJson(profile.environment) !== canonicalReceiptJson(environment)) {
      return fail("validation", "launch profile environment does not match the requested environment");
    }
    if (Date.parse(profile.expiresAt) <= now.getTime()) {
      return fail("validation", "launch profile is already expired");
    }

    try {
      await this.journal.append({
        kind: "intent",
        launchId: profile.launchId,
        role: environment.role,
        provider: environment.provider,
        ...(environment.roleProfile ? { roleProfile: environment.roleProfile } : {}),
        environmentId: environment.environmentId,
        configFingerprint: environment.configFingerprint,
        launchFingerprint: profile.launchFingerprint,
        generation,
        recordedAt: now.toISOString()
      });
    } catch (error) {
      return fail("conflict", `launch intent could not be journaled; launch not started: ${errorText(error)}`);
    }

    this.launches.set(profile.launchId, { profile, environment });
    return ok(profile);
  }

  async verifyActivated(
    request: ActivationRequest,
    options?: OperationOptions
  ): Promise<OperationResult<AgentHealthResult>> {
    const { profile, context, paneId, nativeSession, signer } = request;
    const prepared = this.launches.get(profile.launchId);
    if (prepared === undefined || canonicalReceiptJson(prepared.profile) !== canonicalReceiptJson(profile)) {
      return fail("conflict", "launch profile was not prepared by this readiness instance; prepare a fresh launch");
    }
    const { environment } = prepared;
    if (environment.scope.kind !== "session") {
      return fail("validation", "activation requires a session-scoped environment");
    }
    const launchId = profile.launchId;

    const observedAt = this.now().toISOString();
    const receiptId = `receipt-${sha256Hex(`${launchId}\n${paneId}\n${nativeSession.value}`).slice(0, 48)}`;

    let attestation: AgentLaunchAttestation;
    try {
      attestation = signer.sign({
        receiptId,
        launchId,
        launchFingerprint: profile.launchFingerprint,
        sessionId: environment.scope.sessionId,
        paneId,
        nativeSession,
        observedAt
      });
    } catch (error) {
      return fail("validation", `launch attestation could not be signed: ${errorText(error)}`);
    }

    try {
      await this.journal.append({ kind: "attested", launchId, paneId, receiptId, recordedAt: observedAt });
    } catch (error) {
      return fail("conflict", `launch attestation could not be journaled: ${errorText(error)}`);
    }

    const activationContext: ProviderAdapterContext = {
      ...context,
      trustedIssuerKeys: { ...context.trustedIssuerKeys, [signer.issuerId]: signer.publicKeyPem }
    };
    const adapter = this.factory(environment.provider, activationContext, options);
    const healthRequest = AgentHealthRequestSchema.safeParse({
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      environment,
      stage: "activated",
      launchProfile: profile,
      launchAttestation: attestation,
      requestedAt: observedAt
    });
    if (!healthRequest.success) {
      return this.recordFailure(launchId, "activation_request_invalid",
        `activated health request failed schema validation: ${healthRequest.error.message}`);
    }

    const outcome = await adapter.checkHealth(healthRequest.data, options);
    if (!outcome.ok) {
      return this.recordFailure(launchId, outcome.error.code, outcome.error.message);
    }

    const validated = this.validateHealth(outcome.value, environment, "activated");
    if (!validated.ok) {
      return this.recordFailure(launchId, validated.error.code, validated.error.message);
    }
    const health = validated.value;
    if (health.status !== "ready" || health.launchAttestation === undefined) {
      const firstFailure = health.checks.find((check) => check.status !== "passed");
      const failed = notReady(health);
      return this.recordFailure(launchId, firstFailure?.code ?? health.status,
        failed.ok ? "activated health is not ready" : failed.error.message);
    }
    if (health.launchAttestation.receiptId !== attestation.receiptId ||
        health.launchAttestation.launchId !== launchId) {
      return this.recordFailure(launchId, "attestation_mismatch",
        "activated health did not echo the attestation that was signed for this launch");
    }

    try {
      await this.journal.append({
        kind: "activated",
        launchId,
        status: health.status,
        validUntil: health.validUntil,
        recordedAt: this.now().toISOString()
      });
    } catch (error) {
      return fail("conflict", `activation could not be journaled: ${errorText(error)}`);
    }

    this.fresh.set(freshnessKey(environment.environmentId, environment.configFingerprint), {
      result: health,
      environment
    });
    return ok(health);
  }

  assertFresh(environmentId: string, configFingerprint: string, now: Date = this.now()): OperationResult<AgentHealthResult> {
    const entry = this.lookupFresh(environmentId, configFingerprint, now);
    if (entry === undefined) return fail("conflict", STALE_HEALTH);
    return ok(entry.result);
  }

  private lookupFresh(environmentId: string, configFingerprint: string, now: Date): FreshHealth | undefined {
    const key = freshnessKey(environmentId, configFingerprint);
    const entry = this.fresh.get(key);
    if (entry === undefined) return undefined;
    if (now.getTime() >= Date.parse(entry.result.validUntil)) {
      this.fresh.delete(key);
      return undefined;
    }
    return entry;
  }

  private validateHealth(
    value: unknown,
    environment: AgentEnvironment,
    stage: "preflight" | "activated"
  ): OperationResult<AgentHealthResult> {
    const parsed = AgentHealthResultSchema.safeParse(value);
    if (!parsed.success) {
      return fail("validation", `health result failed schema validation: ${parsed.error.message}`);
    }
    const health = parsed.data;
    if (health.environmentId !== environment.environmentId ||
        health.configFingerprint !== environment.configFingerprint ||
        health.provider !== environment.provider ||
        health.role !== environment.role ||
        health.stage !== stage) {
      return fail("validation", "health result does not match the requested environment and stage");
    }
    return ok(health);
  }

  /** Best-effort journal record of a failed activation; the failure is returned either way. */
  private async recordFailure(launchId: string, code: string, message: string): Promise<OperationResult<AgentHealthResult>> {
    const scrubbed = scrubDiagnosticText(message).slice(0, MAX_JOURNAL_MESSAGE);
    try {
      await this.journal.append({
        kind: "failed",
        launchId,
        code,
        message: scrubbed.length > 0 ? scrubbed : "activation failed",
        recordedAt: this.now().toISOString()
      });
    } catch {
      // Fail-closed regardless: the launch is not marked activated and nothing is cached.
    }
    return fail("validation", scrubbed.length > 0 ? scrubbed : "activation failed", { code });
  }
}
