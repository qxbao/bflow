import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from '@bflow/artifact-store';
import { SpecificationSchema, ApprovalRequestSchema, ApprovalDecisionSchema } from '@bflow/contracts';
import { DataVerificationHost, specificationContent } from '../../src/data/host.js';
import { canonical, digest } from '../../src/data/contract.js';
import { liveContract, snapshot, manifestFor } from './fixtures.js';
const roots: string[] = [], stores: FilesystemArtifactStore[] = [];
afterEach(async () => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
async function fixture(data = snapshot(), manifest = manifestFor()) {
  const root = await mkdtemp(join(tmpdir(), 'bflow-data-host-')); roots.push(root);
  const opened = await openFilesystemArtifactStore({ root: join(root, 'artifacts'), storeId: 'dc-fixture' }); if (!opened.ok) throw new Error(opened.error.message);
  const store = opened.value; stores.push(store);
  const c = liveContract(), now = new Date().toISOString();
  // Synthetic human authority is only a test fixture. Actual approvals are supplied by the host owner.
  const spec = SpecificationSchema.parse({ schemaVersion: 2, specId: 'data-spec', runId: 'run-data', sessionId: 'session-data', level: 'lightweight', title: 'Approved snapshot checks', summary: 'Check schema and fixture data', problemStatement: 'Detect drift and data violations', scope: { inScope: ['fixture snapshot'], outOfScope: ['warehouse'] },
    acceptanceCriteria: [{ id: 'schema', description: 'Contract compatibility', category: 'functional', verificationMethod: 'static_analysis', required: true, status: 'pending', evidenceArtifactIds: [] }, { id: 'quality', description: 'All approved data checks', category: 'functional', verificationMethod: 'integration_test', required: true, status: 'pending', evidenceArtifactIds: [] }], affectedPaths: ['fixtures/orders'], version: 1, status: 'draft', createdBy: 'coordinator', createdAt: now, updatedAt: now,
    metadata: { dataVerification: { schemaVersion: 1, contractId: c.id, contractRevision: c.revision, contractDigest: digest(c), candidateSchemaDigest: digest(manifest), snapshotId: data.id, snapshotDigest: digest(data), declaredModelRevision: data.declaredModelRevision, structuralCriterionIds: ['schema'], qualityCriterionIds: ['quality'] } } });
  const bytes = Buffer.from(canonical(specificationContent(spec)));
  const put = await store.put({ options: { artifactId: 'accepted-spec', runId: 'run-data', kind: 'document', mediaType: 'application/json', expectedIntegrity: { checksum: { algorithm: 'sha256', value: digest(specificationContent(spec)) }, sizeBytes: bytes.length }, idempotencyKey: 'spec-1' }, content: (async function*() { yield bytes; })() }); if (!put.ok) throw new Error(put.error.message);
  const accepted = SpecificationSchema.parse({ ...spec, status: 'approved', approvedBy: 'fixture-owner', artifactRef: put.value });
  const request = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: 'approval-data', runId: 'run-data', sessionId: 'session-data', target: { type: 'specification', specId: spec.specId }, revision: 1, generation: 0, requestedBy: 'coordinator', requestedAt: now, status: 'approved', reason: 'Fixture-only synthetic approval', evidence: [put.value], idempotencyKey: 'request-1' });
  const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId, runId: request.runId, sessionId: request.sessionId, target: request.target, revision: 1, generation: 0, decision: 'approved', decidedBy: 'fixture-owner', decidedAt: now, feedbackArtifacts: [], idempotencyKey: 'decision-1' });
  const authority = { specification: accepted, request, decision };
  const host = new DataVerificationHost({ artifacts: store, toolchain: process.env.BFLOW_TEST_DBT_TOOLCHAIN ?? '/absent', readAuthority: async () => authority });
  return { host, store, authority, input: { runId: 'run-data', attemptId: 'attempt-data', contract: c, candidateManifest: manifest, snapshot: data } };
}
describe('DataVerificationHost exact accepted authority', () => {
  it.each(['revision', 'generation', 'approvalId', 'runId', 'target', 'expired', 'superseded', 'threshold', 'snapshot', 'candidate'] as const)('blocks stale/mismatched %s before running a tool', async kind => {
    const f = await fixture(); const a: any = f.authority;
    if (['revision', 'generation', 'approvalId', 'runId'].includes(kind)) a.decision[kind] = kind === 'revision' || kind === 'generation' ? 2 : 'other';
    else if (kind === 'target') a.decision.target.specId = 'foreign';
    else if (kind === 'expired') a.request.expiresAt = '2020-01-01T00:00:00Z';
    else if (kind === 'superseded') a.request.status = 'superseded';
    else if (kind === 'threshold') f.input.contract.checks[0]!.maxFailures = 1;
    else if (kind === 'snapshot') f.input.snapshot.rows[0]![0] = 99;
    else f.input.candidateManifest.nodes['model.fixture.orders'].columns.id.data_type = 'text';
    const result = await f.host.verify(f.input); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.structural.status).toBe('blocked'); expect(result.value.quality.status).toBe('blocked'); expect(result.value.evidence).toHaveLength(0);
  });
  it('owns the pinned candidate input across artifact IO instead of measuring caller mutations', async () => {
    const manifest = manifestFor(), id = 'test.fixture.status_values', saved = manifest.nodes[id];
    delete manifest.nodes[id];
    const f = await fixture(snapshot(), manifest); let reads = 0, specReads = 0;
    const store = new Proxy(f.store, { get(target, property) {
      if (property === 'get') return async function* (ref: any) {
        if (++specReads === 2) f.input.candidateManifest.nodes[id] = saved;
        yield* target.get(ref);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const host = new DataVerificationHost({ artifacts: store, toolchain: '/absent', readAuthority: async () => {
      if (++reads === 5) delete f.input.candidateManifest.nodes[id];
      return f.authority;
    } });
    const result = await host.verify(f.input); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.structural.status).toBe('failed');
    expect(result.value.structural.findings.some(x => x.code === 'required_test_missing')).toBe(true);
  });
  it('keeps compatible structural outcome separate from missing dbt prerequisites', async () => {
    const f = await fixture(); const host = new DataVerificationHost({ artifacts: f.store, toolchain: '/absent', readAuthority: async () => f.authority });
    const result = await host.verify(f.input); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.structural.status).toBe('passed'); expect(result.value.quality.status).toBe('blocked');
  });
});
describe.skipIf(!process.env.BFLOW_TEST_DBT_TOOLCHAIN)('host → independent gates → real dbt → ArtifactStore', () => {
  it('stores trusted evidence for passing checks and actual violations while structural schema stays compatible', async () => {
    for (const violation of [false, true]) {
      const data = snapshot(); if (violation) data.rows[0]![1] = 'invalid';
      const f = await fixture(data), result = await f.host.verify(f.input); expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) continue;
      expect(result.value.structural.status).toBe('passed'); expect(result.value.quality.status, JSON.stringify(result.value.quality)).toBe(violation ? 'failed' : 'passed');
      expect(result.value.evidence).toHaveLength(2);
      for (const ref of result.value.evidence) expect(await f.store.resolve(ref.artifactId)).toMatchObject({ ok: true, value: { trust: 'stored', checksum: ref.checksum } });
      const ref = result.value.evidence[1]!; let text = ''; for await (const chunk of f.store.get(ref)) { if (!chunk.ok) throw new Error(chunk.error.message); text += Buffer.from(chunk.value).toString(); }
      expect(JSON.parse(text)).toMatchObject({ kind: 'snapshot_validation', candidateSchemaDigest: digest(f.input.candidateManifest), approvalId: f.authority.request.approvalId });
    }
  }, 120000);
  it('does not let passing fixture data erase a missing required schema test', async () => {
    const manifest = manifestFor(); delete manifest.nodes['test.fixture.status_values'];
    const f = await fixture(snapshot(), manifest), result = await f.host.verify(f.input);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.structural.status).toBe('failed');
    expect(result.value.structural.findings.some(f => f.code === 'required_test_missing')).toBe(true);
    expect(result.value.quality.status).toBe('passed');
  }, 120000);
  it('blocks supersession during the final awaited artifact read', async () => {
    const f = await fixture(); let testResults = 0, revoked = false;
    const store = new Proxy(f.store, { get(target, property) {
      if (property === 'put') return async (write: any) => { const result = await target.put(write); if (write.options.kind === 'test-result') testResults++; return result; };
      if (property === 'get') return async function* (ref: any) { if (testResults === 2 && !revoked) { revoked = true; f.authority.request.status = 'superseded'; } yield* target.get(ref); };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const host = new DataVerificationHost({ artifacts: store, toolchain: process.env.BFLOW_TEST_DBT_TOOLCHAIN!, readAuthority: async () => f.authority });
    const result = await host.verify(f.input); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(revoked).toBe(true); expect(result.value.structural.status).toBe('passed');
    expect(result.value.quality.status).toBe('blocked');
    expect(result.value.quality.findings.some(x => x.code === 'data_authority_stale')).toBe(true);
  }, 120000);
});
