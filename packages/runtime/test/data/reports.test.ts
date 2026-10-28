import { describe, expect, it } from 'vitest';
import { parseDbtEvidence } from '../../src/data/report.js';
const start = '2026-10-28T00:00:00.000Z', finish = '2026-10-28T00:00:05.000Z';
const input = () => ({ contract: { schemaVersion: 1, id: 'example', revision: 1, model: 'orders', fields: [{ name: 'id', type: 'integer', nullable: false, unique: false }], keys: [], checks: [{ id: 'id_null', kind: 'not_null', column: 'id', maxFailures: 0 }], consumer: { direction: 'candidate_to_accepted', schema: 'open' }, policy: { integerWidening: true } },
  manifest: { metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json', dbt_version: '1.10.15', invocation_id: 'invocation-1', generated_at: start }, nodes: {
    'model.bflow_fixture.orders': { resource_type: 'model', name: 'orders' },
    'test.bflow_fixture.id_null': { resource_type: 'test', depends_on: { nodes: ['model.bflow_fixture.orders'], macros: ['macro.dbt.test_not_null'] }, test_metadata: { name: 'not_null', kwargs: { model: "{{ get_where_subquery(ref('orders')) }}", column_name: 'id' } }, config: { meta: { bflow_check_id: 'id_null' }, severity: 'ERROR', error_if: '> 0', warn_if: '> 0' } } } },
  runResults: { metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/run-results/v6.json', dbt_version: '1.10.15', invocation_id: 'invocation-1', generated_at: finish }, elapsed_time: 4,
    results: [{ unique_id: 'model.bflow_fixture.orders', status: 'success', failures: null, execution_time: 1 }, { unique_id: 'test.bflow_fixture.id_null', status: 'pass', failures: 0, execution_time: 1 }] },
  outcome: { executable: '/usr/bin/bwrap', args: [], cwd: '/tmp/fixture', exitCode: 0, signal: null, stdout: '', stderr: '', combinedOutput: '', durationMs: 5000, timedOut: false, aborted: false, outputTruncated: false }, startedAt: start, finishedAt: finish, expectedModels: ['orders'] });
describe('strict dbt measured report ingress (reduced official shapes, not live evidence)', () => {
  it('reports complete per-check outcomes independently of schema parsing', () => {
    expect(parseDbtEvidence(input())).toMatchObject({ status: 'passed', checks: [{ checkId: 'id_null', status: 'passed', failures: 0 }] });
    const x = input(); x.outcome.exitCode = 1; x.runResults.results[1]!.status = 'fail'; x.runResults.results[1]!.failures = 2;
    expect(parseDbtEvidence(x)).toMatchObject({ status: 'failed', checks: [{ status: 'failed', failures: 2 }] });
  });
  it.each([
    ['stale report', (x: any) => x.runResults.metadata.generated_at = '2020-01-01T00:00:00Z'],
    ['foreign invocation', (x: any) => x.runResults.metadata.invocation_id = 'other'],
    ['skipped check', (x: any) => x.runResults.results[1].status = 'skipped'],
    ['missing check', (x: any) => x.runResults.results.pop()],
    ['duplicate check', (x: any) => x.runResults.results.push(x.runResults.results[1])],
    ['inconsistent failure', (x: any) => x.runResults.results[1].failures = 1],
    ['model failure', (x: any) => x.runResults.results[0].status = 'error'],
    ['infrastructure exit', (x: any) => x.outcome.exitCode = 2],
    ['nonzero pass', (x: any) => x.outcome.exitCode = 1],
    ['timeout', (x: any) => x.outcome.timedOut = true],
    ['truncated output', (x: any) => x.outcome.outputTruncated = true],
    ['changed threshold', (x: any) => x.manifest.nodes['test.bflow_fixture.id_null'].config.error_if = '> 10'],
    ['wrong test kind', (x: any) => x.manifest.nodes['test.bflow_fixture.id_null'].test_metadata.name = 'unique'],
    ['unselected test', (x: any) => x.runResults.results.push({ unique_id: 'test.unknown', status: 'pass', failures: 0, execution_time: 0 })],
    ['custom test namespace', (x: any) => x.manifest.nodes['test.bflow_fixture.id_null'].test_metadata.namespace = 'always_pass'],
    ['foreign test model', (x: any) => x.manifest.nodes['test.bflow_fixture.id_null'].test_metadata.kwargs.model = "{{ ref('other') }}"],
    ['custom test macro', (x: any) => x.manifest.nodes['test.bflow_fixture.id_null'].depends_on.macros = ['macro.custom.test_not_null']],
    ['malformed report', (x: any) => x.runResults.results = 'success'],
  ])('rejects %s', (_label, mutate) => { const x = input(); mutate(x); expect(() => parseDbtEvidence(x)).toThrow(); });
});
it.each([0, '', null, 'false'])('rejects malformed accepted-values quote=%s in measured report metadata', quote => {
  const x: any = input(); x.contract.fields[0].nullable = true; x.contract.fields[0].type = 'text';
  Object.assign(x.contract.checks[0], { kind: 'accepted_values', values: ['value_field'] });
  const t = x.manifest.nodes['test.bflow_fixture.id_null']; t.test_metadata.name = 'accepted_values';
  Object.assign(t.test_metadata.kwargs, { values: ['value_field'], quote }); t.depends_on.macros = ['macro.dbt.test_accepted_values'];
  expect(() => parseDbtEvidence(x)).toThrow();
});
