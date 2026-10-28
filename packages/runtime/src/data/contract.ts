import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdentifierSchema, JsonValueSchema } from '@bflow/contracts';

export const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const scalar = z.union([z.string().max(4096).refine(s => !s.includes('\0') && Buffer.from(s, 'utf8').toString('utf8') === s), z.number().finite(), z.boolean(), z.null()]);
export const fieldSchema = z.object({ name: identifier, type: z.enum(['smallint', 'integer', 'bigint', 'double', 'text', 'boolean', 'timestamp']), nullable: z.boolean(), unique: z.boolean() }).strict();
/** The fixture and enum checks use the same scalar/type domain; nullability is checked independently. */
export function isDataValueCompatible(value: unknown, type: z.infer<typeof fieldSchema>['type']): boolean {
  if (value === null) return true;
  if (type === 'smallint' || type === 'integer' || type === 'bigint') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return false;
    return type === 'smallint' ? value >= -32768 && value <= 32767 : type === 'integer' ? value >= -2147483648 && value <= 2147483647 : true;
  }
  if (type === 'double') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string';
}
export const checkSchema = z.object({ id: identifier, kind: z.enum(['not_null', 'unique', 'relationships', 'accepted_values']), column: identifier,
  maxFailures: z.number().int().min(0).max(100000), values: z.array(scalar).min(1).max(100).optional(),
  reference: z.object({ model: identifier, column: identifier }).strict().optional()
}).strict().superRefine((c, ctx) => {
  if ((c.kind === 'accepted_values') !== (c.values !== undefined) || (c.kind === 'relationships') !== (c.reference !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Check arguments must match its kind' });
  if (c.values?.some(value => value === null)) ctx.addIssue({ code: 'custom', message: 'Null accepted-values are unsupported by dbt; use nullability and not_null checks' });
  if (c.values && new Set(c.values.map(v => canonical(v))).size !== c.values.length) ctx.addIssue({ code: 'custom', message: 'Duplicate accepted value' });
  if (c.values?.some(v => typeof v === 'string' && /'|\{[\{%#]/.test(v))) ctx.addIssue({ code: 'custom', message: 'dbt built-in accepted-values SQL/template text is unsupported' });
});
const fields = z.array(fieldSchema).min(1).max(100);
const checks = z.array(checkSchema).min(1).max(200);
export const DataContractSchema = z.object({ schemaVersion: z.literal(1), id: IdentifierSchema, revision: z.number().int().positive(), model: identifier,
  fields, keys: z.array(identifier).max(100), checks,
  consumer: z.object({ direction: z.enum(['candidate_to_accepted', 'accepted_to_candidate', 'both']), schema: z.enum(['open', 'exact']) }).strict(),
  policy: z.object({ integerWidening: z.boolean() }).strict()
}).strict().superRefine((c, ctx) => {
  const names = c.fields.map(f => f.name);
  if (new Set(names).size !== names.length || new Set(c.keys).size !== c.keys.length || new Set(c.checks.map(t => t.id)).size !== c.checks.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate field, key or check' });
  for (const key of c.keys) if (!c.fields.some(f => f.name === key && !f.nullable && f.unique)) ctx.addIssue({ code: 'custom', message: `Key ${key} must be a non-null unique field` });
  for (const [index, test] of c.checks.entries()) {
    const field = c.fields.find(f => f.name === test.column);
    if (!field) ctx.addIssue({ code: 'custom', message: `Unknown check field ${test.column}` });
    else if (test.values?.some(value => !isDataValueCompatible(value, field.type))) ctx.addIssue({ code: 'custom', message: `Accepted values do not match field type ${field.type}`, path: ['checks', index, 'values'] });
  }
  for (const f of c.fields) for (const kind of [...(!f.nullable ? ['not_null'] : []), ...(f.unique ? ['unique'] : [])])
    if (!c.checks.some(t => t.column === f.name && t.kind === kind)) ctx.addIssue({ code: 'custom', message: `Missing required ${kind} test for ${f.name}` });
});
export type DataContract = z.infer<typeof DataContractSchema>;
export type DataCheck = z.infer<typeof checkSchema>;
export const CandidateSchema = z.object({ schemaVersion: z.literal(1), model: identifier, fields, keys: z.array(identifier).max(100),
  tests: z.array(checkSchema).max(200), renames: z.record(identifier).default({}) }).strict().superRefine((c, ctx) => {
  if (new Set(c.fields.map(f => f.name)).size !== c.fields.length || new Set(c.tests.map(t => t.id)).size !== c.tests.length || new Set(c.keys).size !== c.keys.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate candidate fields, keys or tests' });
  for (const [index, key] of c.keys.entries()) if (!c.fields.some(f => f.name === key && !f.nullable && f.unique))
    ctx.addIssue({ code: 'custom', message: `Candidate key ${key} must name a non-null unique field`, path: ['keys', index] });
  for (const [before, after] of Object.entries(c.renames)) if (!identifier.safeParse(before).success || !c.fields.some(f => f.name === after))
    ctx.addIssue({ code: 'custom', message: 'Rename must name safe identifiers and a candidate field' });
});
export type Candidate = z.infer<typeof CandidateSchema>;
export function canonical(value: unknown): string {
  const parsed = JsonValueSchema.parse(value);
  const sort = (v: typeof parsed): typeof parsed => Array.isArray(v) ? v.map(sort) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k]!)])) : v;
  return JSON.stringify(sort(parsed));
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const contractDigest = (value: unknown) => digest(DataContractSchema.parse(value));
export interface DriftFinding { code: string; field: string; checkId?: string; direction: DataContract['consumer']['direction']; compatibility: 'compatible' | 'breaking' | 'unsupported'; before: unknown; after: unknown }
export function checkStructuralDrift(baseInput: unknown, candidateInput: unknown) {
  const base = DataContractSchema.parse(baseInput), candidate = CandidateSchema.parse(candidateInput), findings: DriftFinding[] = [];
  const forward = base.consumer.direction !== 'accepted_to_candidate', reverse = base.consumer.direction !== 'candidate_to_accepted';
  const add = (code: string, field: string, before: unknown, after: unknown, compatibility: DriftFinding['compatibility'], checkId?: string) =>
    findings.push({ code, field, before, after, compatibility, direction: base.consumer.direction, ...(checkId ? { checkId } : {}) });
  if (base.model !== candidate.model) add('model_changed', '$model', base.model, candidate.model, 'breaking');
  const ranks: Record<string, number> = { smallint: 1, integer: 2, bigint: 3 };
  for (const old of base.fields) {
    const next = candidate.fields.find(f => f.name === old.name);
    if (!next) { add(candidate.renames[old.name] ? 'column_renamed' : 'column_removed', old.name, old.name, candidate.renames[old.name] ?? null, forward || base.consumer.schema === 'exact' ? 'breaking' : 'compatible'); continue; }
    if (old.type !== next.type) {
      const a = ranks[old.type], b = ranks[next.type];
      add('type_changed', old.name, old.type, next.type, a && b && base.policy.integerWidening ? (forward && b > a || reverse && a > b ? 'breaking' : 'compatible') : 'unsupported');
    }
    for (const [property, code] of [['nullable', 'nullability_changed'], ['unique', 'uniqueness_changed']] as const) if (old[property] !== next[property]) {
      const weaker = property === 'nullable' ? next[property] : !next[property];
      add(code, old.name, old[property], next[property], (forward && weaker || reverse && !weaker) ? 'breaking' : 'compatible');
    }
  }
  for (const field of candidate.fields.filter(f => !base.fields.some(b => b.name === f.name)))
    add('column_added', field.name, null, field, reverse || base.consumer.schema === 'exact' ? 'breaking' : 'compatible');
  for (const key of base.keys.filter(k => !candidate.keys.includes(k))) add('key_removed', key, true, false, forward ? 'breaking' : 'compatible');
  for (const key of candidate.keys.filter(k => !base.keys.includes(k))) add('key_added', key, false, true, reverse ? 'breaking' : 'compatible');
  for (const test of candidate.tests) if (!candidate.fields.some(f => f.name === test.column)) add('test_field_missing', test.column, test, null, 'breaking', test.id);
  for (const required of base.checks) {
    const found = candidate.tests.find(t => t.id === required.id);
    if (!found) add('required_test_missing', required.column, required, null, 'breaking', required.id);
    else if (canonical(found) !== canonical(required)) add('required_test_changed', required.column, required, found, 'breaking', required.id);
  }
  return { status: findings.some(f => f.compatibility !== 'compatible') ? 'breaking' as const : 'compatible' as const, runtimeQuality: 'not_executed' as const, findings };
}

const metadataSchema = z.object({ dbt_schema_version: z.literal('https://schemas.getdbt.com/dbt/manifest/v12.json'), dbt_version: z.string().regex(/^1\.10\./) }).passthrough();
const nodeSchema = z.object({ resource_type: z.string(), name: z.string().optional() }).passthrough();
export const manifestSchema = z.object({ metadata: metadataSchema, nodes: z.record(nodeSchema) }).passthrough();
const columnConstraintSchema = z.object({
  type: z.enum(['not_null', 'unique']),
  name: z.string().max(4096).nullable().optional(),
  expression: z.string().max(4096).refine(value => value.trim() === '', 'Column constraint expressions are unsupported').nullable().optional(),
  warn_unenforced: z.boolean().optional(), warn_unsupported: z.boolean().optional(),
  to: z.null().optional(), to_columns: z.array(z.string()).max(0, 'Constraint references are unsupported').optional()
}).strict();
const columnSchema = z.object({ name: identifier, data_type: z.string(), meta: z.object({ nullable: z.boolean().optional(), unique: z.boolean().optional(), key: z.boolean().optional() }).passthrough().default({}),
  constraints: z.array(columnConstraintSchema).default([]) }).passthrough().superRefine((column, ctx) => {
    if (column.meta.nullable === true && column.constraints.some(c => c.type === 'not_null') || column.meta.unique === false && column.constraints.some(c => c.type === 'unique'))
      ctx.addIssue({ code: 'custom', message: 'Contradictory column metadata and constraints' });
  });
const testNodeSchema = z.object({ depends_on: z.object({ nodes: z.array(z.string()), macros: z.array(z.string()).min(1) }).passthrough(),
  test_metadata: z.object({ namespace: z.union([z.null(), z.literal('dbt')]).optional(), name: z.enum(['not_null', 'unique', 'relationships', 'accepted_values']), kwargs: z.record(z.unknown()) }).passthrough(),
  config: z.object({ severity: z.string(), meta: z.object({ bflow_check_id: identifier }).passthrough(), error_if: z.string(), warn_if: z.string(),
    enabled: z.boolean().optional(), where: z.unknown().optional(), limit: z.unknown().optional(), fail_calc: z.string().optional() }).passthrough()
}).passthrough();
/** Accept only the supported dbt built-in invocation, not an identically named custom/foreign test. */
export function assertBuiltinTest(input: unknown, model: string) {
  const test = testNodeSchema.parse(input), kind = test.test_metadata.name, kwargs = test.test_metadata.kwargs;
  const allowed = ['model', 'column_name', ...(kind === 'accepted_values' ? ['values', 'quote'] : []), ...(kind === 'relationships' ? ['to', 'field'] : [])];
  const expected = [`{{ get_where_subquery(ref('${model}')) }}`, `{{ get_where_subquery(ref("${model}")) }}`];
  if (Object.hasOwn(kwargs, 'quote') && kwargs.quote !== true) throw new Error('Only literal quote=true is supported');
  if (Object.keys(kwargs).some(key => !allowed.includes(key))) throw new Error('Unsupported custom test arguments');
  if (typeof kwargs.model !== 'string' || !expected.includes(kwargs.model)) throw new Error('Unsupported test model binding');
  if (!test.depends_on.macros.includes(`macro.dbt.test_${kind}`)) throw new Error('Missing built-in test macro');
  if (test.depends_on.macros.some(id => !/^macro\.dbt\.[A-Za-z_][A-Za-z0-9_]*$/.test(id))) throw new Error('Unsupported custom macro dependency: ' + test.depends_on.macros.join(',').slice(0,512));
  return test;
}
export function candidateFromManifest(input: unknown, model: string): Candidate {
  identifier.parse(model);
  const manifest = manifestSchema.parse(input);
  const models = Object.entries(manifest.nodes).filter(([, n]) => n.resource_type === 'model' && n.name === model);
  if (models.length !== 1) throw new Error('Exactly one candidate model is required');
  const [modelId, node] = models[0]!;
  z.array(z.unknown()).max(0, 'Model-level constraints are unsupported').default([]).parse(node.constraints);
  const columns = z.record(columnSchema).parse(node.columns);
  const parsedFields = Object.entries(columns).map(([name, c]) => {
    if (c.name !== name) throw new Error('Manifest column name mismatch');
    return fieldSchema.parse({ name, type: c.data_type.toLowerCase(), nullable: c.meta.nullable ?? !c.constraints.some(x => x.type === 'not_null'), unique: c.meta.unique ?? c.constraints.some(x => x.type === 'unique') });
  });
  const tests: DataCheck[] = [];
  for (const node of Object.values(manifest.nodes).filter(n => n.resource_type === 'test')) {
    const deps = z.object({ nodes: z.array(z.string()) }).passthrough().parse(node.depends_on);
    if (!deps.nodes.includes(modelId)) continue;
    const test = assertBuiltinTest(node, model), config = test.config, kwargs = test.test_metadata.kwargs;
    if (config.severity.toUpperCase() !== 'ERROR' || config.enabled === false || config.where != null || config.limit != null || config.fail_calc && config.fail_calc !== 'count(*)' || config.error_if !== config.warn_if)
      throw new Error('Unsupported or weakened dbt test configuration');
    const threshold = /^> (\d+)$/.exec(config.error_if);
    if (!threshold) throw new Error('Unsupported dbt failure threshold');
    const check: Record<string, unknown> = { id: config.meta.bflow_check_id, kind: test.test_metadata.name, column: kwargs.column_name, maxFailures: Number(threshold[1]) };
    if (check.kind === 'accepted_values') { if (kwargs.quote === false) throw new Error('Unquoted accepted values unsupported'); check.values = kwargs.values; }
    if (check.kind === 'relationships') {
      const to = z.string().parse(kwargs.to), match = /^\{\{\s*ref\(['"]([a-z][a-z0-9_]*)['"]\)\s*\}\}$/.exec(to) ?? /^ref\(['"]([a-z][a-z0-9_]*)['"]\)$/.exec(to);
      if (!match) throw new Error('Only model ref relationships supported');
      check.reference = { model: match[1], column: kwargs.field };
    }
    tests.push(checkSchema.parse(check));
  }
  return CandidateSchema.parse({ schemaVersion: 1, model, fields: parsedFields, keys: Object.entries(columns).filter(([, c]) => c.meta.key).map(([name]) => name), tests, renames: z.object({ bflow_renames: z.record(identifier).optional() }).passthrough().parse(node.meta ?? {}).bflow_renames ?? {} });
}
