import { describe, expect, it } from 'vitest';
import { CandidateSchema, DataContractSchema, candidateFromManifest } from '../../src/data/contract.js';
import { runDbtFixture } from '../../src/data/fixture-runner.js';
import { liveContract, manifestFor, snapshot } from './fixtures.js';

describe('review round 2: supported schema constraints fail closed', () => {
  it.each(['check', 'foreign_key', 'primary_key', 'unsupported'])('rejects unimplemented column constraint %s', type => {
    const manifest = manifestFor(); manifest.nodes['model.fixture.orders'].columns.customer_id.constraints = [{ type, expression: 'customer_id > 0' }];
    expect(() => candidateFromManifest(manifest, 'orders')).toThrow(/constraint/i);
  });
  it('rejects model-level constraints instead of dropping consumer expectations', () => {
    const manifest = manifestFor(); manifest.nodes['model.fixture.orders'].constraints = [{ type: 'check', expression: 'customer_id > 0' }];
    expect(() => candidateFromManifest(manifest, 'orders')).toThrow(/constraint/i);
  });
  it.each(['nullable', 'unique'])('rejects contradictory %s metadata and supported constraints', property => {
    const manifest = manifestFor(), col = manifest.nodes['model.fixture.orders'].columns.status;
    col.constraints = [{ type: property === 'nullable' ? 'not_null' : 'unique' }];
    col.meta[property] = property === 'nullable';
    expect(() => candidateFromManifest(manifest, 'orders')).toThrow(/contradict|constraint/i);
  });
  it.each(['nullable', 'unique', 'missing'])('rejects invalid candidate key declaration %s', invalid => {
    const c = liveContract(); const candidate: any = { schemaVersion: 1, model: c.model, fields: c.fields, keys: c.keys, tests: c.checks, renames: {} };
    if (invalid === 'nullable') candidate.fields[0].nullable = true;
    else if (invalid === 'unique') candidate.fields[0].unique = false;
    else candidate.keys = ['missing'];
    expect(() => CandidateSchema.parse(candidate)).toThrow(/key/i);
  });
  it.each(['not_null', 'unique'])('rejects hidden expression semantics inside %s constraints', type => {
    const manifest = manifestFor(); manifest.nodes['model.fixture.orders'].columns.id.constraints = [{ type, name: null, expression: 'check (id > 0)', warn_unenforced: true, warn_unsupported: true, to: null, to_columns: [] }];
    expect(() => candidateFromManifest(manifest, 'orders')).toThrow(/expression|constraint/i);
  });
  it.each([{ to: 'other' }, { to_columns: ['other'] }, { unexpected_semantics: true }])('rejects unsupported column constraint fields %j', extra => {
    const manifest = manifestFor(); manifest.nodes['model.fixture.orders'].columns.id.constraints = [{ type: 'not_null', ...extra }];
    expect(() => candidateFromManifest(manifest, 'orders')).toThrow();
  });
  it('accepts real dbt decorative constraint defaults without dropping executable semantics', () => {
    const manifest = manifestFor(); manifest.nodes['model.fixture.orders'].columns.id.constraints = [{ type: 'not_null', name: null, expression: null, warn_unenforced: true, warn_unsupported: true, to: null, to_columns: [] }];
    expect(candidateFromManifest(manifest, 'orders').fields[0]!.nullable).toBe(false);
  });
  it('retains supported column-level not-null/unique constraints when metadata agrees', () => {
    const manifest = manifestFor(), col = manifest.nodes['model.fixture.orders'].columns.id;
    col.constraints = [{ type: 'not_null' }, { type: 'unique' }];
    expect(candidateFromManifest(manifest, 'orders').keys).toEqual(['id']);
  });
});

describe('review round 2: dbt accepted-values must preserve scalar meaning', () => {
  it.each([{ values: [null] }, { values: [true] }, { values: [1] }])('rejects unsupported accepted-values for a text column: %j', ({ values }) => {
    const c: any = liveContract(); c.checks.find((x: any) => x.kind === 'accepted_values').values = values;
    expect(() => DataContractSchema.parse(c)).toThrow(/value|type|null/i);
  });
  it.each([{ type: 'boolean', values: [true, false] }, { type: 'integer', values: [-2147483648, 2147483647] }, { type: 'double', values: [0.25, 1.5] }])('retains valid typed accepted-values %j', ({ type, values }) => {
    const c: any = liveContract(); c.fields[1].type = type; c.checks.find((x: any) => x.kind === 'accepted_values').values = values;
    expect(() => DataContractSchema.parse(c)).not.toThrow();
  });
  it('rejects a scalar that exceeds the declared integer width', () => {
    const c: any = liveContract(); c.checks.push({ id: 'id_values', kind: 'accepted_values', column: 'id', maxFailures: 0, values: [2147483648] });
    expect(() => DataContractSchema.parse(c)).toThrow(/value|type|integer/i);
  });
  it.skipIf(!process.env.BFLOW_TEST_DBT_TOOLCHAIN)('never converts approved null into the passing text value None in real dbt', async () => {
    const c: any = liveContract(); c.fields[1].nullable = true; c.checks = c.checks.filter((x: any) => x.id !== 'status_null');
    c.checks.find((x: any) => x.kind === 'accepted_values').values = [null];
    const data = snapshot(); data.rows = [[1, 'None', 10]];
    expect(await runDbtFixture({ contract: c, snapshot: data, toolchain: process.env.BFLOW_TEST_DBT_TOOLCHAIN! })).toMatchObject({ status: 'blocked', code: 'data_input_invalid' });
  }, 120000);
});
