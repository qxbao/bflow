/** Fixed synthetic fixtures only. Synthetic approvals here are not authority for another dataset or any warehouse. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFilesystemArtifactStore } from '@bflow/artifact-store';
import { ApprovalRequestSchema, ApprovalDecisionSchema, SpecificationSchema } from '@bflow/contracts';
import { DataVerificationHost, dataSpecificationContent, dataVerificationDigest } from '@bflow/runtime';
const toolchain = process.env.BFLOW_TEST_DBT_TOOLCHAIN;
if (!toolchain) throw new Error('Set BFLOW_TEST_DBT_TOOLCHAIN to an approved isolated Python virtualenv. No tools are installed automatically.');
const load = async name => JSON.parse(await readFile(new URL(`data/${name}.json`, import.meta.url), 'utf8'));
const contract = await load('contract');
const root = await mkdtemp(join(tmpdir(), 'bflow-dc01-evidence-'));
const opened = await openFilesystemArtifactStore({ root: join(root, 'artifacts'), storeId: 'dc01-fixture' });
if (!opened.ok) throw new Error(opened.error.message);
const artifacts = opened.value, results = [];
const candidateManifest = { metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json', dbt_version: '1.10.15' }, nodes: {
  'model.bflow_fixture.orders': { resource_type: 'model', name: contract.model, columns: Object.fromEntries(contract.fields.map(f => [f.name, { name: f.name, data_type: f.type, meta: { nullable: f.nullable, unique: f.unique, key: contract.keys.includes(f.name) } }])) },
  ...Object.fromEntries(contract.checks.map(c => [`test.bflow_fixture.${c.id}`, { resource_type: 'test', depends_on: { nodes: ['model.bflow_fixture.orders'], macros: [`macro.dbt.test_${c.kind}`] },
    test_metadata: { namespace: null, name: c.kind, kwargs: { model: "{{ get_where_subquery(ref('orders')) }}", column_name: c.column, ...(c.values ? { values: c.values } : {}), ...(c.reference ? { to: `ref('${c.reference.model}')`, field: c.reference.column } : {}) } },
    config: { meta: { bflow_check_id: c.id }, severity: 'ERROR', error_if: `> ${c.maxFailures}`, warn_if: `> ${c.maxFailures}` } }])) } };
try {
  for (const variant of ['good', 'bad']) {
    const snapshot = await load(`snapshot-${variant}`), now = new Date().toISOString(), runId = `fixture-${variant}`;
    const draft = SpecificationSchema.parse({ schemaVersion: 2, specId: runId, runId, sessionId: 'dc01-fixture', level: 'lightweight', title: 'Fixed synthetic dbt snapshot fixture', summary: 'Fixture-only host verification', problemStatement: 'Prove separate schema and measured data outcomes', scope: { inScope: ['this fixed isolated synthetic fixture'], outOfScope: ['warehouse', 'candidate transformation SQL', 'live acceptance'] },
      acceptanceCriteria: [{ id: 'schema', description: 'Compatible accepted schema', category: 'functional', verificationMethod: 'static_analysis', required: true, status: 'pending', evidenceArtifactIds: [] }, { id: 'quality', description: 'Accepted null, unique, values and reference checks', category: 'functional', verificationMethod: 'integration_test', required: true, status: 'pending', evidenceArtifactIds: [] }], affectedPaths: ['fixture/orders'], version: 1, status: 'draft', createdBy: 'fixture-harness', createdAt: now, updatedAt: now,
      metadata: { syntheticFixtureAuthority: true, dataVerification: { schemaVersion: 1, contractId: contract.id, contractRevision: contract.revision, contractDigest: dataVerificationDigest(contract), candidateSchemaDigest: dataVerificationDigest(candidateManifest), snapshotId: snapshot.id, snapshotDigest: dataVerificationDigest(snapshot), declaredModelRevision: snapshot.declaredModelRevision, structuralCriterionIds: ['schema'], qualityCriterionIds: ['quality'] } } });
    // The host compares canonical content; ArtifactStore verifies exact bytes and integrity.
    const content = dataSpecificationContent(draft), bytes = Buffer.from(JSON.stringify(content));
    const { createHash } = await import('node:crypto');
    const put = await artifacts.put({ options: { artifactId: `${runId}-spec`, runId, kind: 'document', mediaType: 'application/json', expectedIntegrity: { checksum: { algorithm: 'sha256', value: createHash('sha256').update(bytes).digest('hex') }, sizeBytes: bytes.length }, idempotencyKey: `${runId}-spec` }, content: (async function* () { yield bytes; })() });
    if (!put.ok) throw new Error(put.error.message);
    const specification = SpecificationSchema.parse({ ...draft, status: 'approved', approvedBy: 'synthetic-fixture-owner', artifactRef: put.value });
    const target = { type: 'specification', specId: specification.specId };
    const request = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: `${runId}-approval`, runId, sessionId: specification.sessionId, status: 'approved', target, revision: 1, generation: 0, requestedBy: 'fixture-harness', requestedAt: now, reason: 'Synthetic authority for fixed fixture only', evidence: [put.value], idempotencyKey: `${runId}-request` });
    const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId, runId, sessionId: specification.sessionId, target, revision: 1, generation: 0, decision: 'approved', decidedBy: 'synthetic-fixture-owner', decidedAt: now, feedbackArtifacts: [], idempotencyKey: `${runId}-decision` });
    const host = new DataVerificationHost({ artifacts, toolchain, readAuthority: async () => ({ specification, request, decision }) });
    const result = await host.verify({ runId, attemptId: `${runId}-attempt`, contract, candidateManifest, snapshot });
    if (!result.ok) throw new Error(result.error.message);
    results.push({ variant, syntheticFixtureAuthority: true, ...result.value });
    if (result.value.structural.status !== 'passed' || result.value.quality.status !== (variant === 'good' ? 'passed' : 'failed')) process.exitCode = 1;
  }
  const report = { kind: 'fixture_only_smoke', artifactDirectory: root, results };
  await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ evidenceDirectory: root, report: join(root, 'results.json'), outcomes: results.map(r => ({ fixture: r.variant, structural: r.structural.status, quality: r.quality.status, evidence: r.evidence })) }, null, 2));
} finally { artifacts.close(); }
