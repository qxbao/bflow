import { z } from 'zod';
import type { QualityCommandOutcome } from '@bflow/quality-gates';
import { DataContractSchema, assertBuiltinTest, canonical, manifestSchema, type DataCheck } from './contract.js';
const resultSchema = z.object({ metadata: z.object({ dbt_schema_version: z.literal('https://schemas.getdbt.com/dbt/run-results/v6.json'),
  dbt_version: z.string().regex(/^1\.10\./), invocation_id: z.string().min(1), generated_at: z.string().datetime({ offset: true }) }).passthrough(),
  elapsed_time: z.number().finite().nonnegative(), results: z.array(z.object({ unique_id: z.string().min(1), status: z.string(), failures: z.number().int().nonnegative().nullable(), execution_time: z.number().finite().nonnegative() }).passthrough()).min(1).max(400)
}).passthrough();
export interface DbtCheckResult { checkId: string; kind: DataCheck['kind']; column: string; uniqueId: string; status: 'passed' | 'failed'; failures: number }
/** Internal ingress only. A parsed document is evidence only when collected by the host-owned fixture runner. */
export function parseDbtEvidence(input: { contract: unknown; manifest: unknown; runResults: unknown; outcome: QualityCommandOutcome; startedAt: string; finishedAt: string; expectedModels: readonly string[] }) {
  const c = DataContractSchema.parse(input.contract), manifest = manifestSchema.parse(input.manifest), report = resultSchema.parse(input.runResults), outcome = input.outcome;
  function fail(message: string): never { throw new Error(`dbt_report_invalid: ${message}`); }
  if (outcome.spawnError || outcome.timedOut || outcome.aborted || outcome.outputTruncated || outcome.signal || ![0, 1].includes(outcome.exitCode ?? -1)) fail('infrastructure outcome');
  const metadata = z.object({ invocation_id: z.string().min(1), generated_at: z.string().datetime({ offset: true }) }).passthrough().parse(manifest.metadata);
  if (metadata.invocation_id !== report.metadata.invocation_id || manifest.metadata.dbt_version !== report.metadata.dbt_version) fail('foreign invocation/version');
  const start = Date.parse(input.startedAt), finish = Date.parse(input.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) fail('invalid measurement window');
  for (const time of [metadata.generated_at, report.metadata.generated_at]) if (Date.parse(time) < start - 1000 || Date.parse(time) > finish + 1000) fail('stale or future report');
  const expected = new Map<string, DataCheck | null>();
  for (const model of input.expectedModels) {
    const models = Object.entries(manifest.nodes).filter(([, n]) => n.resource_type === 'model' && n.name === model);
    if (models.length !== 1) fail('missing/ambiguous selected model'); expected.set(models[0]![0], null);
  }
  const selectedModel = Object.entries(manifest.nodes).find(([, n]) => n.resource_type === 'model' && n.name === c.model)?.[0];
  if (!selectedModel) fail('target model absent');
  const seenChecks = new Set<string>();
  for (const [id, node] of Object.entries(manifest.nodes).filter(([, n]) => n.resource_type === 'test')) {
    const test = assertBuiltinTest(node, c.model), check = c.checks.find(x => x.id === test.config.meta.bflow_check_id);
    if (!check || seenChecks.has(check.id) || !test.depends_on.nodes.includes(selectedModel!)) fail('unapproved, duplicate or foreign test');
    seenChecks.add(check.id);
    const config = test.config, kwargs = test.test_metadata.kwargs;
    if (test.test_metadata.name !== check.kind || kwargs.column_name !== check.column || config.severity.toUpperCase() !== 'ERROR' || config.error_if !== `> ${check.maxFailures}` || config.warn_if !== config.error_if || config.enabled === false || config.where != null || config.limit != null || config.fail_calc && config.fail_calc !== 'count(*)') fail('test definition drift');
    if (check.kind === 'accepted_values' && (canonical(kwargs.values) !== canonical(check.values) || kwargs.quote === false)) fail('accepted-values drift');
    if (check.reference) {
      const to = kwargs.to;
      if (typeof to !== 'string' || ![ `{{ ref('${check.reference.model}') }}`, `{{ ref("${check.reference.model}") }}`, `ref('${check.reference.model}')`, `ref("${check.reference.model}")` ].includes(to) || kwargs.field !== check.reference.column) fail('relationship drift');
    }
    expected.set(id, check);
  }
  if (seenChecks.size !== c.checks.length || expected.size !== report.results.length) fail('incomplete selection');
  const seenResults = new Set<string>(), checks: DbtCheckResult[] = [];
  for (const result of report.results) {
    if (!expected.has(result.unique_id) || seenResults.has(result.unique_id)) fail('unexpected/duplicate result');
    seenResults.add(result.unique_id);
    const check = expected.get(result.unique_id);
    if (!check) { if (result.status !== 'success' || result.failures !== null && result.failures !== 0) fail('model did not succeed'); continue; }
    if (result.failures === null || !['pass', 'fail'].includes(result.status) || (result.status === 'fail') !== (result.failures > check.maxFailures)) fail('skipped, inconsistent or incomplete check');
    checks.push({ checkId: check.id, kind: check.kind, column: check.column, uniqueId: result.unique_id, status: result.status === 'pass' ? 'passed' : 'failed', failures: result.failures! });
  }
  const failed = checks.some(c => c.status === 'failed');
  if (outcome.exitCode !== (failed ? 1 : 0)) fail('exit status contradicts measured checks');
  return { status: failed ? 'failed' as const : 'passed' as const, invocationId: metadata.invocation_id, dbtVersion: report.metadata.dbt_version, checks };
}
