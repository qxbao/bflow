import { manifestFor, liveContract } from './fixtures.js';
import { describe, expect, it } from 'vitest';
import { DataContractSchema, candidateFromManifest, contractDigest, checkStructuralDrift } from '../../src/data/contract.js';
export const contract = () => ({ schemaVersion: 1 as const, id: 'orders-v1', revision: 1, model: 'orders',
  fields: [{ name: 'id', type: 'integer', nullable: false, unique: true }, { name: 'status', type: 'text', nullable: false, unique: false }],
  keys: ['id'], consumer: { direction: 'candidate_to_accepted', schema: 'open' }, policy: { integerWidening: true },
  checks: [{ id: 'id_null', kind: 'not_null', column: 'id', maxFailures: 0 }, { id: 'id_unique', kind: 'unique', column: 'id', maxFailures: 0 },
    { id: 'status_null', kind: 'not_null', column: 'status', maxFailures: 0 }, { id: 'status_values', kind: 'accepted_values', column: 'status', values: ['new', 'paid'], maxFailures: 0 }] });
export const candidate = () => ({ schemaVersion: 1, model: 'orders', fields: contract().fields, keys: ['id'], tests: contract().checks, renames: {} });
const drift = (mutate: (c: any) => void, direction = 'candidate_to_accepted') => { const c = candidate(); mutate(c); return checkStructuralDrift({ ...contract(), consumer: { direction, schema: 'open' } }, c); };
describe('approved data contract structural semantics', () => {
  it('validates strict versions, keys, fields and supported required checks', () => {
    expect(DataContractSchema.parse(contract()).revision).toBe(1);
    for (const change of [(c: any) => c.schemaVersion = 2, (c: any) => c.fields.push(c.fields[0]), (c: any) => c.keys = ['missing'],
      (c: any) => c.checks[0].kind = 'freshness', (c: any) => c.checks[0].column = 'absent', (c: any) => c.checks.pop() && c.checks.pop()]) {
      const c = contract(); change(c); expect(() => DataContractSchema.parse(c)).toThrow();
    }
  });
  it('pins canonical contract content including thresholds and revision', () => {
    expect(contractDigest(contract())).toBe(contractDigest(JSON.parse(JSON.stringify(contract()))));
    const c = contract(); c.checks[0]!.maxFailures = 1; expect(contractDigest(c)).not.toBe(contractDigest(contract()));
    expect(contractDigest({ ...contract(), revision: 2 })).not.toBe(contractDigest(contract()));
  });
  it('accepts unchanged schema while leaving runtime quality unmeasured', () => {
    expect(checkStructuralDrift(contract(), candidate())).toMatchObject({ status: 'compatible', runtimeQuality: 'not_executed', findings: [] });
  });
  it.each([
    ['smallint', 'integer', 'candidate_to_accepted', 'breaking'], ['integer', 'smallint', 'candidate_to_accepted', 'compatible'],
    ['smallint', 'integer', 'accepted_to_candidate', 'compatible'], ['integer', 'smallint', 'accepted_to_candidate', 'breaking'],
    ['smallint', 'integer', 'both', 'breaking'],
  ])('classifies %s → %s for %s as %s', (before, after, direction, status) => {
    const b = contract(), c = candidate(); b.fields[0]!.type = before; c.fields[0]!.type = after;
    expect(checkStructuralDrift({ ...b, consumer: { direction, schema: 'open' } }, c).status).toBe(status);
  });
  it.each([
    [false, true, 'candidate_to_accepted', 'breaking'], [true, false, 'candidate_to_accepted', 'compatible'],
    [false, true, 'accepted_to_candidate', 'compatible'], [true, false, 'accepted_to_candidate', 'breaking'],
  ])('classifies nullable %s → %s for %s as %s', (before, after, direction, status) => {
    const b = contract(), c = candidate(); b.fields[1]!.nullable = before; c.fields[1]!.nullable = after;
    expect(checkStructuralDrift({ ...b, consumer: { direction, schema: 'open' } }, c).status).toBe(status);
  });
  it('does not guess text or lossy type changes compatible', () => {
    expect(drift(c => c.fields[0].type = 'text').findings).toContainEqual(expect.objectContaining({ field: 'id', code: 'type_changed', compatibility: 'unsupported' }));
  });
  it('reports field-level removal and explicit rename without pretending old consumers understand it', () => {
    const result = drift(c => { c.fields[1].name = 'state'; c.renames = { status: 'state' }; });
    expect(result.status).toBe('breaking');
    expect(result.findings).toContainEqual(expect.objectContaining({ field: 'status', code: 'column_renamed', compatibility: 'breaking' }));
  });
  it('handles open/exact schema evolution and reverse consumer additions', () => {
    expect(drift(c => c.fields.push({ name: 'note', type: 'text', nullable: true, unique: false })).status).toBe('compatible');
    expect(drift(c => c.fields.push({ name: 'note', type: 'text', nullable: true, unique: false }), 'accepted_to_candidate').status).toBe('breaking');
    const b = contract(), c = candidate(); c.fields.push({ name: 'note', type: 'text', nullable: true, unique: false });
    expect(checkStructuralDrift({ ...b, consumer: { direction: 'candidate_to_accepted', schema: 'exact' } }, c).status).toBe('breaking');
  });
  it('detects weakened unique guarantees and missing keys separately from test declarations', () => {
    expect(drift(c => { c.fields[0].unique = false; c.keys = []; }).findings.map(f => f.code)).toEqual(expect.arrayContaining(['uniqueness_changed', 'key_removed']));
  });
  it('fails a missing required test even if all remaining tests pass', () => {
    expect(drift(c => c.tests.pop()).findings).toContainEqual(expect.objectContaining({ code: 'required_test_missing', field: 'status', checkId: 'status_values' }));
  });
  it('does not silently widen thresholds or accepted values', () => {
    expect(drift(c => c.tests[0].maxFailures = 1).status).toBe('breaking');
    expect(drift(c => c.tests[3].values.push('invalid')).findings).toContainEqual(expect.objectContaining({ code: 'required_test_changed' }));
  });
  it('extracts supported dbt manifest v12 schema/tests and rejects unknown schema versions', () => {
    const manifest: any = { metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json', dbt_version: '1.10.15' }, nodes: {
      'model.fixture.orders': { resource_type: 'model', name: 'orders', columns: { id: { name: 'id', data_type: 'INTEGER', meta: { nullable: false, unique: true, key: true } }, status: { name: 'status', data_type: 'TEXT', meta: { nullable: false } } } },
      ...Object.fromEntries(contract().checks.map(check => [`test.fixture.${check.id}`, { resource_type: 'test', depends_on: { nodes: ['model.fixture.orders'], macros: [`macro.dbt.test_${check.kind}`] },
        test_metadata: { name: check.kind, kwargs: { model: `{{ get_where_subquery(ref('orders')) }}`, column_name: check.column, ...(check.values ? { values: check.values } : {}) } }, config: { severity: 'ERROR', meta: { bflow_check_id: check.id }, error_if: '> 0', warn_if: '> 0' } }])) } };
    expect(checkStructuralDrift(contract(), candidateFromManifest(manifest, 'orders')).status).toBe('compatible');
    manifest.metadata.dbt_schema_version = 'https://schemas.getdbt.com/dbt/manifest/v99.json'; expect(() => candidateFromManifest(manifest, 'orders')).toThrow();
  });
});

it.each(['namespace', 'model', 'unknown_argument'])('rejects custom or unbound dbt test %s', kind => {
  const manifest = manifestFor(liveContract()), node = manifest.nodes['test.fixture.id_null'];
  if (kind === 'namespace') node.test_metadata.namespace = 'always_pass_package';
  else if (kind === 'model') node.test_metadata.kwargs.model = "{{ ref('other') }}";
  else node.test_metadata.kwargs.some_custom_argument = true;
  expect(() => candidateFromManifest(manifest, 'orders')).toThrow();
});
it.each(["O'Reilly", '{{ 1 }}', '{% set x=1 %}', '{# hidden #}'])('rejects unsupported accepted-values SQL/template text %s', value => {
  const c = contract(); c.checks[3]!.values = [value]; expect(() => DataContractSchema.parse(c)).toThrow();
});
it('uses an explicit manifest rename map without hiding the old consumer break', () => {
  const c = liveContract(), manifest = manifestFor(c), node = manifest.nodes['model.fixture.orders'];
  node.columns.state = { ...node.columns.status, name: 'state' }; delete node.columns.status;
  node.meta = { bflow_renames: { status: 'state' } };
  expect(checkStructuralDrift(c, candidateFromManifest(manifest, 'orders')).findings).toContainEqual(expect.objectContaining({ field: 'status', code: 'column_renamed', compatibility: 'breaking' }));
});
it.each([false, 0, '', null, 'false'])('rejects nonliteral dbt quote=%s', quote => {
  const manifest = manifestFor(liveContract()); manifest.nodes['test.fixture.status_values'].test_metadata.kwargs.quote = quote;
  expect(() => candidateFromManifest(manifest, 'orders')).toThrow();
});
it('does not count a required test for a removed field as valid coverage in reverse compatibility', () => {
  const c = candidate(); c.fields.pop();
  const b = { ...contract(), consumer: { direction: 'accepted_to_candidate', schema: 'open' } };
  expect(checkStructuralDrift(b, c).findings).toContainEqual(expect.objectContaining({ code: 'test_field_missing', field: 'status', checkId: 'status_null', compatibility: 'breaking' }));
});
it.each(['\ud800', '\0'])('rejects accepted-values text that cannot be measured faithfully: %s', value => {
  const c = contract(); c.checks[3]!.values = [value]; expect(() => DataContractSchema.parse(c)).toThrow();
});
