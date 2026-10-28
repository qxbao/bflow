import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { createQualityCommandRunner, type QualityCommandOutcome } from '@bflow/quality-gates';
import { DataContractSchema, candidateFromManifest, isDataValueCompatible, digest, fieldSchema, identifier, type DataContract } from './contract.js';
import { parseDbtEvidence } from './report.js';
import { probeBehavioralSandbox } from '../agentic/sandbox-readiness.js';
import { redactText } from '../agentic/app-check-evidence.js';
import { collectRunnerReports } from '../agentic/runner-reports.js';
const cell = z.union([z.string().max(4096).refine(s => !s.includes('\0') && Buffer.from(s, 'utf8').toString('utf8') === s), z.number().finite(), z.boolean(), z.null()]);
const rows = z.array(z.array(cell).max(100)).max(10000);
export const SnapshotSchema = z.object({ schemaVersion: z.literal(1), id: identifier, declaredModelRevision: z.string().regex(/^[a-f0-9]{40,64}$/), model: identifier,
  rows, references: z.array(z.object({ model: identifier, fields: z.array(fieldSchema).min(1).max(100), rows }).strict()).max(20) }).strict();
export type DataSnapshot = z.infer<typeof SnapshotSchema>;
export interface FixtureBlocked { status: 'blocked'; code: 'data_input_invalid' | 'dbt_toolchain_unavailable' | 'data_sandbox_unavailable' | 'dbt_execution_uncertain' | 'dbt_execution_failed' | 'dbt_report_invalid'; message: string; cleanup?: 'removed' | 'retained_uncertain'; fixtureDirectory?: string }
export interface FixtureCompleted { status: 'completed'; fixtureDirectory: string; cleanup: 'removed'; evidence: {
  schemaVersion: 1; kind: 'snapshot_validation'; adapter: 'dbt-duckdb'; declaredModelRevision: string; contractRevision: number; contractDigest: string; snapshotId: string; snapshotDigest: string;
  dbtVersion: string; adapterVersion: string; duckdbVersion: string; measuredFixtureSchemaDigest: string; command: { executable: string; args: readonly string[] }; startedAt: string; finishedAt: string; durationMs: number;
  result: ReturnType<typeof parseDbtEvidence>; reportDigests: { manifest: string; runResults: string }; outcome: { exitCode: number | null; signal: string | null; timedOut: boolean; aborted: boolean; outputTruncated: boolean };
} }
export type FixtureRun = FixtureBlocked | FixtureCompleted;
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const literal = (value: z.infer<typeof cell>) => value === null ? 'NULL' : typeof value === 'string' ? `decode(from_hex('${Buffer.from(value, 'utf8').toString('hex')}'))` : typeof value === 'boolean' ? String(value).toUpperCase() : String(value);
function modelSql(fields: z.infer<typeof fieldSchema>[], tableRows: DataSnapshot['rows']): string {
  if (tableRows.some(row => row.length !== fields.length)) throw new Error('Snapshot row width differs from its field schema');
  const checked = tableRows.length ? tableRows : [fields.map(() => null)];
  for (const row of tableRows) for (const [i, value] of row.entries()) {
    if (!isDataValueCompatible(value, fields[i]!.type)) throw new Error('Snapshot value type is unsupported; implicit coercion is forbidden');
  }
  return checked.map(row => 'select ' + fields.map((f, i) => `cast(${literal(row[i]!)} as ${f.type}) as "${f.name}"`).join(', ')).join('\nunion all\n') + (tableRows.length ? '\n' : '\nwhere false\n');
}
function fixtureProject(contract: DataContract, snapshot: DataSnapshot) {
  if (snapshot.model !== contract.model || new Set(snapshot.references.map(t => t.model)).size !== snapshot.references.length || snapshot.references.some(t => t.model === contract.model)) throw new Error('Snapshot model identity mismatch');
  for (const ref of snapshot.references) if (new Set(ref.fields.map(f => f.name)).size !== ref.fields.length) throw new Error('Duplicate reference fields');
  for (const check of contract.checks) if (check.reference && !snapshot.references.some(t => t.model === check.reference!.model && t.fields.some(f => f.name === check.reference!.column && f.type === contract.fields.find(x => x.name === check.column)!.type))) throw new Error('Required reference dataset/compatible field is missing');
  const tables = [{ model: contract.model, fields: contract.fields, rows: snapshot.rows }, ...snapshot.references];
  const sql = tables.map(t => ({ model: t.model, sql: modelSql(t.fields, t.rows) }));
  const schema = { version: 2, models: tables.map(table => ({ name: table.model, columns: table.fields.map(field => ({ name: field.name, data_type: field.type,
    meta: { nullable: field.nullable, unique: field.unique, key: table.model === contract.model && contract.keys.includes(field.name) },
    data_tests: table.model === contract.model ? contract.checks.filter(t => t.column === field.name).map(check => ({ [check.kind]: {
      ...(check.values ? { values: check.values } : {}), ...(check.reference ? { to: `ref('${check.reference.model}')`, field: check.reference.column } : {}),
      config: { meta: { bflow_check_id: check.id }, severity: 'error', error_if: `> ${check.maxFailures}`, warn_if: `> ${check.maxFailures}` }
    } })) : [] })) })) };
  return { sql, schema };
}
const VERSION_CODE = "import json,importlib.metadata as m; print(json.dumps({k:m.version(v) for k,v in [('dbtVersion','dbt-core'),('adapterVersion','dbt-duckdb'),('duckdbVersion','duckdb')]}))";
const DBT_CODE = 'from dbt.cli.main import cli; cli()';
/** Fixed host templates only. No warehouse profile, caller SQL, role-authored executable or supplied report is accepted. */
export async function runDbtFixture(input: { contract: unknown; snapshot: unknown; toolchain: string; timeoutMs?: number; beforeLaunch?: () => Promise<void> }): Promise<FixtureRun> {
  let contract: DataContract, snapshot: DataSnapshot, project: ReturnType<typeof fixtureProject>;
  const timeoutMs = input.timeoutMs ?? 90000;
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Fixture timeout must be 1..120000ms');
    contract = DataContractSchema.parse(input.contract); snapshot = SnapshotSchema.parse(input.snapshot); project = fixtureProject(contract, snapshot);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 2097152) throw new Error('Snapshot exceeds fixture budget');
  } catch { return { status: 'blocked', code: 'data_input_invalid', message: 'Invalid or unsupported contract/snapshot fixture input' }; }
  let toolchain: string, pythonRoot: string, pythonAlias: string;
  try {
    if (!isAbsolute(input.toolchain) || input.toolchain === '/' || await realpath(input.toolchain) !== input.toolchain || !(await lstat(input.toolchain)).isDirectory()) throw new Error('Unsafe toolchain');
    toolchain = input.toolchain;
    const python = await realpath(join(toolchain, 'bin/python'));
    if (!/^python3(?:\.\d+)?$/.test(basename(python)) || basename(dirname(python)) !== 'bin') throw new Error('Unsupported Python layout');
    pythonRoot = dirname(dirname(python)); await access(python, constants.X_OK);
    const config = await readFile(join(toolchain, 'pyvenv.cfg'), 'utf8');
    const home = /^home\s*=\s*(.+)$/m.exec(config)?.[1]?.trim();
    if (!home || !isAbsolute(home) || basename(home) !== 'bin' || await realpath(home) !== dirname(python)) throw new Error('Unsupported virtualenv home');
    pythonAlias = dirname(home);
  } catch { return { status: 'blocked', code: 'dbt_toolchain_unavailable', message: 'An approved isolated Python virtualenv with dbt-core, dbt-duckdb and DuckDB is required' }; }
  const sandbox = await probeBehavioralSandbox();
  if (sandbox.status !== 'ready' || sandbox.platform !== 'linux') return { status: 'blocked', code: 'data_sandbox_unavailable', message: 'dbt fixture requires a working Linux Bubblewrap sandbox; no unsandboxed fallback' };
  const root = await mkdtemp(join(tmpdir(), 'bflow-dbt-fixture-'));
  let uncertain = false;
  try {
    for (const directory of ['models', 'home', 'tmp']) await mkdir(join(root, directory), { mode: 0o700 });
    await writeFile(join(root, 'dbt_project.yml'), JSON.stringify({ name: 'bflow_fixture', version: '1.0.0', 'config-version': 2, profile: 'bflow_fixture', 'model-paths': ['models'], 'target-path': 'target', 'clean-targets': ['target'], models: { bflow_fixture: { '+materialized': 'table' } } }));
    await writeFile(join(root, 'profiles.yml'), JSON.stringify({ bflow_fixture: { target: 'fixture', outputs: { fixture: { type: 'duckdb', path: '/work/fixture.duckdb', schema: 'main', threads: 1, settings: { enable_external_access: false } } } } }));
    await writeFile(join(root, 'models/schema.yml'), JSON.stringify(project.schema));
    for (const model of project.sql) await writeFile(join(root, 'models', model.model + '.sql'), model.sql);
    const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/work', '--bind', root, '/work', '--dir', '/toolchain', '--ro-bind', toolchain, '/toolchain'];
    if (pythonRoot !== '/usr') args.push('--ro-bind', pythonRoot, pythonRoot);
    if (pythonAlias !== pythonRoot) args.push('--ro-bind', pythonRoot, pythonAlias);
    args.push('--chdir', '/work', '--clearenv');
    for (const [key, value] of Object.entries({ HOME: '/work/home', PATH: '/toolchain/bin:/usr/bin:/bin', TMPDIR: '/work/tmp', LANG: 'C.UTF-8', PYTHONNOUSERSITE: '1', DBT_SEND_ANONYMOUS_USAGE_STATS: 'false', DBT_PROFILES_DIR: '/work', DBT_LOG_PATH: '/work/logs' })) args.push('--setenv', key, value);
    const runner = createQualityCommandRunner();
    const run = async (command: string[], budget: number): Promise<QualityCommandOutcome> => {
      await input.beforeLaunch?.();
      const result = await runner.run({ executable: sandbox.executable, args: [...args, '--', '/toolchain/bin/python', '-I', '-c', ...command], cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeoutMs: budget, maxOutputBytes: 1048576 });
      if (!result.ok) throw new Error('Command runner rejected dbt invocation');
      const outcome = result.value;
      if (outcome.timedOut || outcome.aborted || outcome.signal) uncertain = true;
      return outcome;
    };
    const probe = await run([VERSION_CODE], Math.min(timeoutMs, 10000));
    if (uncertain) return { status: 'blocked', code: 'dbt_execution_uncertain', message: 'Tool probe deadline/signal; retain fixture for host reconciliation', cleanup: 'retained_uncertain', fixtureDirectory: root };
    if (probe.exitCode !== 0 || probe.spawnError || probe.outputTruncated) return { status: 'blocked', code: 'dbt_toolchain_unavailable', message: `dbt/DuckDB dependencies could not execute inside the sandbox: ${redactText(probe.stderr).slice(-1024)}`, cleanup: 'removed', fixtureDirectory: root };
    const versions = z.object({ dbtVersion: z.string().regex(/^1\.10\./), adapterVersion: z.string().regex(/^1\.10\./), duckdbVersion: z.string().regex(/^1\.4\./) }).strict().parse(JSON.parse(probe.stdout.trim()));
    const command = [DBT_CODE, 'build', '--project-dir', '/work', '--profiles-dir', '/work', '--no-partial-parse', '--no-use-colors'];
    const startedAt = new Date().toISOString(), outcome = await run(command, timeoutMs), finishedAt = new Date().toISOString();
    if (uncertain) return { status: 'blocked', code: 'dbt_execution_uncertain', message: 'dbt deadline/signal does not prove termination; retain owned resources for reconciliation', cleanup: 'retained_uncertain', fixtureDirectory: root };
    const reports = await collectRunnerReports([join(root, 'target/manifest.json'), join(root, 'target/run_results.json')], root, join(root, 'target'));
    if (reports.length !== 2) throw new Error('dbt_report_invalid: missing reports');
    const measuredFixtureSchemaDigest = digest(candidateFromManifest(JSON.parse(reports[0]!), contract.model));
    const result = parseDbtEvidence({ contract, manifest: JSON.parse(reports[0]!), runResults: JSON.parse(reports[1]!), outcome, startedAt, finishedAt, expectedModels: project.sql.map(m => m.model) });
    return { status: 'completed', fixtureDirectory: root, cleanup: 'removed', evidence: { schemaVersion: 1, kind: 'snapshot_validation', adapter: 'dbt-duckdb', declaredModelRevision: snapshot.declaredModelRevision,
      contractRevision: contract.revision, contractDigest: digest(contract), snapshotId: snapshot.id, snapshotDigest: digest(snapshot), ...versions, measuredFixtureSchemaDigest, command: { executable: sandbox.executable, args: [...args, '--', '/toolchain/bin/python', '-I', '-c', ...command] },
      startedAt, finishedAt, durationMs: outcome.durationMs, result, reportDigests: { manifest: hash(reports[0]!), runResults: hash(reports[1]!) }, outcome: { exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut, aborted: outcome.aborted, outputTruncated: outcome.outputTruncated } } };
  } catch (error) {
    return { status: 'blocked', code: String(error).includes('dbt_report_invalid') ? 'dbt_report_invalid' : 'dbt_execution_failed', message: `dbt fixture could not produce complete validated data-quality evidence: ${redactText(String(error)).slice(-1024)}`, cleanup: uncertain ? 'retained_uncertain' : 'removed', fixtureDirectory: root };
  } finally { if (!uncertain) await rm(root, { recursive: true, force: true }); }
}
