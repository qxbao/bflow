import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDbtFixture } from '../../src/data/fixture-runner.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
import { liveContract, snapshot } from './fixtures.js';
const toolchain = process.env.BFLOW_TEST_DBT_TOOLCHAIN;
describe('owned dbt fixture runner prerequisites', () => {
  it('returns a prerequisite gap without accepting a user-created report', async () => {
    const result = await runDbtFixture({ contract: liveContract(), snapshot: snapshot(), toolchain: '/nonexistent/bflow-dbt-toolchain' });
    expect(result).toMatchObject({ status: 'blocked', code: 'dbt_toolchain_unavailable' });
  });
  it('rejects text that cannot round-trip UTF-8 rather than measuring replacement bytes', async () => {
    const s = snapshot(); s.rows[0]![1] = '\ud800';
    expect(await runDbtFixture({ contract: liveContract(), snapshot: s, toolchain: '/absent' })).toMatchObject({ status: 'blocked', code: 'data_input_invalid' });
  });
  it('rejects malformed/injected snapshot data before any subprocess', async () => {
    const s = snapshot(); s.model = 'orders; drop schema main';
    expect(await runDbtFixture({ contract: liveContract(), snapshot: s, toolchain: '/absent' })).toMatchObject({ status: 'blocked', code: 'data_input_invalid' });
  });
});
describe.skipIf(!toolchain)('real dbt/DuckDB snapshot measurement (fixture-only)', () => {
  it('runs five real checks and removes only its owned fixture', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'bflow-data-sentinel-')); roots.push(outside); await writeFile(join(outside, 'keep'), 'outside');
    const result = await runDbtFixture({ contract: liveContract(), snapshot: snapshot(), toolchain: toolchain! });
    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.evidence).toMatchObject({ kind: 'snapshot_validation', adapter: 'dbt-duckdb', dbtVersion: '1.10.15', adapterVersion: '1.10.0', duckdbVersion: '1.4.1', result: { status: 'passed', checks: expect.arrayContaining([expect.objectContaining({ checkId: 'customer_fk', status: 'passed' })]) } });
    expect(result.evidence.result.checks).toHaveLength(5);
    expect(result.evidence.measuredFixtureSchemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.evidence.command.executable).toContain('bwrap');
    expect(result.cleanup).toBe('removed'); await expect(access(result.fixtureDirectory)).rejects.toThrow();
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('outside');
  }, 120000);
  it('observes actual null, uniqueness, values and referential-integrity violations', async () => {
    const s = snapshot(); s.rows = [[1, 'new', 99], [1, 'bad', 99], [null as any, null as any, null as any]];
    const result = await runDbtFixture({ contract: liveContract(), snapshot: s, toolchain: toolchain! });
    expect(result.status, JSON.stringify(result)).toBe('completed'); if (result.status !== 'completed') return;
    expect(result.evidence.result.status).toBe('failed');
    expect(result.evidence.result.checks.every(c => c.status === 'failed')).toBe(true);
    expect(result.evidence.result.checks.every(c => c.failures > 0)).toBe(true);
  }, 120000);
  it('measures template-looking snapshot strings as literal data', async () => {
    const c = liveContract(); c.checks.find(x => x.kind === 'accepted_values')!.values = ['1'];
    const s = snapshot(); s.rows = [[1, '{{ 1 }}', 10]];
    const result = await runDbtFixture({ contract: c, snapshot: s, toolchain: toolchain! });
    expect(result.status, JSON.stringify(result)).toBe('completed'); if (result.status !== 'completed') return;
    expect(result.evidence.result.status).toBe('failed');
    expect(result.evidence.result.checks.find(x => x.checkId === 'status_values')!.failures).toBe(1);
  }, 120000);
  it('never treats a timeout as success or permission to delete uncertain resources', async () => {
    const result = await runDbtFixture({ contract: liveContract(), snapshot: snapshot(), toolchain: toolchain!, timeoutMs: 1 });
    expect(result).toMatchObject({ status: 'blocked', code: 'dbt_execution_uncertain', cleanup: 'retained_uncertain' });
    if ('fixtureDirectory' in result && result.fixtureDirectory) { await access(result.fixtureDirectory); /* Intentionally retained: a deadline is not termination proof. */ }
  }, 120000);
});
