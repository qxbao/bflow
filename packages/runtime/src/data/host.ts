import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApprovalDecisionSchema, ApprovalRequestSchema, ArtifactReferenceSchema, IdentifierSchema, JsonValueSchema, QualityGateContextSchema, QualityGateDefinitionSchema, QualityGateResultSchema, SpecificationSchema,
  type ArtifactReference, type ArtifactStore, type JsonValue, type OperationResult, type QualityFinding, type QualityGate, type QualityGateResult } from '@bflow/contracts';
import { DataContractSchema, candidateFromManifest, canonical, checkStructuralDrift, digest, sha256 } from './contract.js';
import { SnapshotSchema, runDbtFixture } from './fixture-runner.js';
const pinSchema = z.object({ schemaVersion: z.literal(1), contractId: IdentifierSchema, contractRevision: z.number().int().positive(), contractDigest: sha256,
  candidateSchemaDigest: sha256, snapshotId: IdentifierSchema, snapshotDigest: sha256, declaredModelRevision: z.string().regex(/^[a-f0-9]{40,64}$/),
  structuralCriterionIds: z.array(IdentifierSchema).min(1), qualityCriterionIds: z.array(IdentifierSchema).min(1) }).strict();
const authoritySchema = z.object({ specification: SpecificationSchema, request: ApprovalRequestSchema, decision: ApprovalDecisionSchema }).strict();
/** Approval changes the envelope; the stored immutable document binds all specification content besides those approval fields. */
export function specificationContent(input: unknown): JsonValue {
  const { status: _status, approvedBy: _approvedBy, artifactRef: _artifactRef, ...content } = SpecificationSchema.parse(input);
  return JsonValueSchema.parse(content);
}
export interface DataVerificationResult { structural: QualityGateResult; quality: QualityGateResult; evidence: ArtifactReference[] }
export interface DataVerificationInput { runId: string; attemptId: string; taskId?: string; contract: unknown; candidateManifest: unknown; snapshot: unknown }
/** Opt-in host library, not persistent daemon/CLI wiring. Construct only from owner authority, never role messages. */
export class DataVerificationHost {
  constructor(private readonly options: { artifacts: ArtifactStore; toolchain: string; readAuthority: () => Promise<unknown>; now?: () => Date }) {}
  private now() { return (this.options.now?.() ?? new Date()).toISOString(); }
  private async authority(input: DataVerificationInput, expected?: string) {
    const authority = authoritySchema.parse(await this.options.readAuthority()), { specification: spec, request, decision } = authority;
    const pin = pinSchema.parse(spec.metadata?.dataVerification), contract = DataContractSchema.parse(input.contract), snapshot = SnapshotSchema.parse(input.snapshot);
    if (request.status !== 'approved' || decision.decision !== 'approved' || spec.status !== 'approved' || !spec.artifactRef || !spec.version || spec.approvedBy !== decision.decidedBy ||
      request.runId !== input.runId || decision.runId !== input.runId || spec.runId !== input.runId || request.sessionId !== spec.sessionId || decision.sessionId !== spec.sessionId ||
      request.approvalId !== decision.approvalId || request.revision !== spec.version || decision.revision !== request.revision || decision.generation !== request.generation ||
      request.target.type !== 'specification' || decision.target.type !== 'specification' || request.target.specId !== spec.specId || decision.target.specId !== spec.specId ||
      request.expiresAt && Date.parse(request.expiresAt) <= Date.parse(this.now()) || Date.parse(decision.decidedAt) < Date.parse(request.requestedAt) || Date.parse(decision.decidedAt) > Date.parse(this.now()) + 1000)
      throw new Error('data_authority_stale');
    if (pin.contractId !== contract.id || pin.contractRevision !== contract.revision || pin.contractDigest !== digest(contract) || pin.candidateSchemaDigest !== digest(input.candidateManifest) ||
      pin.snapshotId !== snapshot.id || pin.snapshotDigest !== digest(snapshot) || pin.declaredModelRevision !== snapshot.declaredModelRevision) throw new Error('data_authority_stale');
    const criteria = [...pin.structuralCriterionIds, ...pin.qualityCriterionIds];
    if (new Set(criteria).size !== criteria.length || spec.acceptanceCriteria.filter(c => c.required && c.status !== 'waived').some(c => !criteria.includes(c.id)) ||
      criteria.some(id => !spec.acceptanceCriteria.some(c => c.id === id && c.required && c.status !== 'waived' && c.verificationMethod === (pin.structuralCriterionIds.includes(id) ? 'static_analysis' : 'integration_test')))) throw new Error('Accepted data criteria are incomplete or unsupported');
    const resolved = await this.options.artifacts.resolve(spec.artifactRef.artifactId);
    if (!resolved.ok || !resolved.value || canonical(resolved.value) !== canonical(spec.artifactRef) || spec.artifactRef.runId !== input.runId || !request.evidence.some(ref => canonical(ref) === canonical(spec.artifactRef))) throw new Error('Accepted specification has no trusted stored document');
    let bytes = Buffer.alloc(0);
    for await (const chunk of this.options.artifacts.get(spec.artifactRef)) {
      if (!chunk.ok) throw new Error('Accepted specification artifact failed integrity verification');
      bytes = Buffer.concat([bytes, chunk.value]); if (bytes.length > 2097152) throw new Error('Accepted specification too large');
    }
    if (canonical(JSON.parse(bytes.toString('utf8'))) !== canonical(specificationContent(spec))) throw new Error('Stored specification content mismatch');
    // Artifact reads may await IO long enough for revocation/expiry. Read current authority last.
    const latest = authoritySchema.parse(await this.options.readAuthority());
    if (digest(latest) !== digest(authority) || latest.request.expiresAt && Date.parse(latest.request.expiresAt) <= Date.parse(this.now())) throw new Error('data_authority_stale');
    const fingerprint = digest(authority);
    if (expected && fingerprint !== expected) throw new Error('data_authority_stale');
    return { ...authority, pin, fingerprint, contract, snapshot };
  }
  private async put(input: DataVerificationInput, value: unknown): Promise<ArtifactReference> {
    const document = JsonValueSchema.parse(value), bytes = Buffer.from(canonical(document)), artifactId = `data-${randomUUID()}`;
    const result = await this.options.artifacts.put({ options: { artifactId, runId: input.runId, ...(input.taskId ? { taskId: input.taskId } : {}), kind: 'test-result', mediaType: 'application/json',
      expectedIntegrity: { checksum: { algorithm: 'sha256', value: digest(document) }, sizeBytes: bytes.length }, idempotencyKey: artifactId }, content: (async function* () { yield bytes; })() });
    if (!result.ok) throw new Error(`Data evidence storage failed: ${result.error.code}`);
    return ArtifactReferenceSchema.parse(result.value);
  }
  private result(input: DataVerificationInput, id: string, status: QualityGateResult['status'], findings: QualityFinding[], metadata: unknown): QualityGateResult {
    return QualityGateResultSchema.parse({ gateId: id, runId: input.runId, ...(input.taskId ? { taskId: input.taskId } : {}), evaluationId: randomUUID(), status, findings, producedArtifacts: [], evaluatedAt: this.now(), metadata });
  }
  async verify(raw: DataVerificationInput): Promise<OperationResult<DataVerificationResult>> {
    let input: DataVerificationInput;
    try {
      input = z.object({ runId: IdentifierSchema, attemptId: IdentifierSchema, taskId: IdentifierSchema.optional(), contract: z.unknown(), candidateManifest: z.unknown(), snapshot: z.unknown() }).strict().parse(raw) as DataVerificationInput;
      // z.unknown retains caller references. Own the exchanged JSON before the first awaited authority read.
      input = { ...input, contract: JsonValueSchema.parse(input.contract), candidateManifest: JsonValueSchema.parse(input.candidateManifest), snapshot: JsonValueSchema.parse(input.snapshot) };
      if (Buffer.byteLength(canonical({ contract: input.contract, candidateManifest: input.candidateManifest, snapshot: input.snapshot })) > 4194304) throw new Error('Data input budget exceeded');
    } catch { return { ok: false, error: { code: 'validation', retryable: false, message: 'Invalid data verification input' } }; }
    const evidence: ArtifactReference[] = [];
    let accepted: Awaited<ReturnType<DataVerificationHost['authority']>>;
    try { accepted = await this.authority(input); }
    catch { return { ok: true, value: { structural: this.result(input, 'host-data-structural', 'blocked', [{ code: 'data_authority_stale', severity: 'error', message: 'Accepted contract/specification approval is missing, stale, mismatched or unsupported' }], {}),
      quality: this.result(input, 'host-data-quality', 'blocked', [{ code: 'data_authority_stale', severity: 'error', message: 'No data-quality execution accepted without current pinned authority' }], {}), evidence } }; }
    const contextFor = (id: string) => QualityGateContextSchema.parse({ runId: input.runId, ...(input.taskId ? { taskId: input.taskId } : {}), attemptId: input.attemptId,
      artifacts: [accepted.specification.artifactRef], definition: QualityGateDefinitionSchema.parse({ id, name: id, evaluator: 'bflow-runtime-data', required: true, timeout: { executionTimeoutMs: 120000, onTimeout: 'block' }, configuration: { authorityFingerprint: accepted.fingerprint } }), input: { authorityFingerprint: accepted.fingerprint } });
    const gate = (id: string, measure: () => Promise<{ status: QualityGateResult['status']; findings: QualityFinding[]; document: unknown; measured: boolean }>): QualityGate => ({ id, evaluate: async rawContext => {
      try {
        const context = QualityGateContextSchema.parse(rawContext);
        if (canonical(context) !== canonical(contextFor(id))) throw new Error('Data gate context does not match pinned host authority');
        await this.authority(input, accepted.fingerprint);
        const measured = await measure();
        await this.authority(input, accepted.fingerprint);
        const ref = await this.put(input, measured.document); evidence.push(ref);
        await this.authority(input, accepted.fingerprint);
        return { ok: true, value: this.result(input, id, measured.status, measured.findings.map(f => ({ ...f, artifactId: ref.artifactId })), {
          dataVerification: { evidence: ref, contractDigest: accepted.pin.contractDigest, candidateSchemaDigest: accepted.pin.candidateSchemaDigest, snapshotDigest: accepted.pin.snapshotDigest, approvalId: accepted.request.approvalId },
          verification: { schemaVersion: 2, runId: input.runId, attemptId: input.attemptId, sourceRevision: accepted.snapshot.declaredModelRevision, specFingerprint: accepted.fingerprint,
            independentExecution: true, isolated: measured.measured, executorId: 'bflow-host-data-check', role: 'quality_gate', method: id === 'host-data-structural' ? 'static_analysis' : 'integration_test',
            criteria: (id === 'host-data-structural' ? accepted.pin.structuralCriterionIds : accepted.pin.qualityCriterionIds).map(criterionId => ({ criterionId, passed: measured.status === 'passed', summary: measured.status })) }
        }) };
      } catch (error) { return { ok: true, value: this.result(input, id, 'blocked', [{ code: String(error).includes('data_authority_stale') ? 'data_authority_stale' : 'data_evidence_unavailable', severity: 'error', message: 'Host could not validate current approval and complete independent evidence' }], {}) }; }
    } });
    const structural = gate('host-data-structural', async () => {
      const candidate = candidateFromManifest(input.candidateManifest, accepted.contract.model), report = checkStructuralDrift(accepted.contract, candidate);
      return { status: report.status === 'compatible' ? 'passed' : 'failed', measured: false,
        findings: report.findings.map(f => ({ code: f.code, severity: f.compatibility === 'compatible' ? 'info' as const : 'error' as const, location: f.field, message: `${f.field}: ${f.code} (${f.direction}, ${f.compatibility})`, details: JsonValueSchema.parse(f) })),
        document: { schemaVersion: 1, kind: 'structural_drift', ...report, candidateSchemaDigest: accepted.pin.candidateSchemaDigest, contractDigest: accepted.pin.contractDigest, contractRevision: accepted.contract.revision, approvalId: accepted.request.approvalId, declaredModelRevision: accepted.snapshot.declaredModelRevision } };
    });
    const quality = gate('host-data-quality', async () => {
      const run = await runDbtFixture({ contract: accepted.contract, snapshot: accepted.snapshot, toolchain: this.options.toolchain, beforeLaunch: async () => { await this.authority(input, accepted.fingerprint); } });
      if (run.status === 'blocked') return { status: 'blocked', findings: [{ code: run.code, severity: 'error', message: run.message }], measured: false, document: { schemaVersion: 1, kind: 'data_quality_prerequisite', ...run } };
      return { status: run.evidence.result.status, measured: true, findings: run.evidence.result.checks.filter(c => c.status === 'failed').map(c => ({ code: 'data_violation', severity: 'error', location: c.column, message: `${c.checkId}: ${c.failures} measured failures`, details: JsonValueSchema.parse(c) })),
        document: { ...run.evidence, candidateSchemaDigest: accepted.pin.candidateSchemaDigest, approvalId: accepted.request.approvalId, approvalRevision: accepted.request.revision, approvalGeneration: accepted.request.generation } };
    });
    const a = await structural.evaluate(contextFor(structural.id)); if (!a.ok) return a;
    const b = await quality.evaluate(contextFor(quality.id)); if (!b.ok) return b;
    return { ok: true, value: { structural: a.value, quality: b.value, evidence } };
  }
}
