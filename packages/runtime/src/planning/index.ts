import { createHash } from 'node:crypto';
import { ExecutionPlanInputSchema, ExecutionPlanSchema, ExecutionPlanExpectationSchema, PlanDiffSchema, PlanFieldSchema, PlanSourceSchema, WorkflowPackSchema, type ExecutionPlan, type ExecutionPlanInput, type ExecutionPlanExpectation, type PlanDecision, type PlanSource, type PlanDiff, isPlanFieldValue, type JsonValue, } from '@bflow/contracts';
/** Deterministic JSON; callers must supply nonsecret semantic projections, never raw configs. */
export function canonicalPlanDigest(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v !== 'object') {
      const s = JSON.stringify(v);
      if (s === undefined) {
        throw new Error('Invalid canonical plan value');
      }
      return s;
    }
    if (Array.isArray(v)) {
      return '[' + v.map(canonical).join(',') + ']';
    }
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}
const sensitive = /(?:^sk-|^gh[pousr]_|^github_pat_|^glpat-|^xox[baprs]-|^AKIA[A-Z0-9]{16}$|bearer\s|:\/\/[^/]*@)/i;
/** Public plans expose declarative selections only. Runtime secrets never enter this projection. */
function safe(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return sensitive.test(value) || value.includes('\n') || value.includes('://') || value.startsWith('/') ? '[redacted]' : value;
  }
  if (Array.isArray(value)) {
    return value.map(safe);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !sensitive.test(k)).map(([k, v]) => [k, k === 'reasonCode' ? v : safe(v)]));
  }
  return value;
}
function source(value: PlanSource): PlanSource {
  return {
    ...value,
    locator: PlanSourceSchema.safeParse(value).success ? value.locator : 'policy'
  };
}
function parseInput(value: unknown): ExecutionPlanInput {
  const parsed = ExecutionPlanInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Invalid execution plan input');
  }
  return parsed.data;
}
function normalized(input: ExecutionPlanInput): ExecutionPlanInput {
  const v = JSON.parse(JSON.stringify(input)) as ExecutionPlanInput;
  v.observations = [];
  v.blockers = [];
  v.unknowns = [];
  if (v.accepted) {
    v.accepted.approvalIds = [];
    v.accepted.tasks.sort((a, b) => a.id.localeCompare(b.id));
    for (const t of v.accepted.tasks) {
      t.dependsOn.sort();
      t.gates.sort();
    }
  }
  v.decisions.sort((a, b) => a.field.localeCompare(b.field));
  for (const d of v.decisions) {
    if (d.field.startsWith('skills.') || d.field === 'tools.required' || d.field === 'capabilities.required') {
      const ordered = (x: JsonValue): JsonValue => Array.isArray(x) ? [...x].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : x;
      d.effective = ordered(d.effective);
      for (const c of d.candidates) {
        c.value = ordered(c.value);
      }
    }
  }
  for (const k of ['gates', 'alternativeVerification', 'requiredTools', 'requiredCapabilities'] as const) {
    v.policy[k].sort();
  }
  v.policy.explanations.sort((a, b) => JSON.stringify([a.field, a.reasonCode, a.source]).localeCompare(JSON.stringify([b.field, b.reasonCode, b.source])));
  v.blockers.sort((a, b) => a.code.localeCompare(b.code));
  v.unknowns.sort();
  v.approvalPoints.sort();
  return v;
}
export function buildExecutionPlan(value: unknown): ExecutionPlan {
  const input = parseInput(value);
  // All public strings pass the same projection, including rejected values and locators.
  const projected = parseInput(safe(input as unknown as JsonValue));
  if (canonicalPlanDigest(normalized(input)) !== canonicalPlanDigest(normalized(projected))) {
    throw new Error('Unsafe execution plan public input');
  }
  return ExecutionPlanSchema.parse({
    ...projected,
    fingerprint: canonicalPlanDigest(normalized(projected))
  });
}
export function resolvePlanField(input: {
  field: string;
  candidates: {
    source: PlanSource;
    value: JsonValue;
  }[];
  lockedBy?: PlanSource;
}): PlanDecision {
  if (!PlanFieldSchema.safeParse(input.field).success || !input.candidates.length || input.candidates.some(c => !isPlanFieldValue(input.field, c.value))) {
    throw new Error('Unsupported plan field');
  }
  let selected = input.candidates[0]!;
  let locked = false;
  const candidates = input.candidates.map(candidate => {
    if (!PlanSourceSchema.safeParse(candidate.source).success) {
      throw new Error('Invalid plan source');
    }
    const rejected = locked;
    if (!rejected) {
      selected = candidate;
    }
    if (input.lockedBy && candidate.source.kind === input.lockedBy.kind && candidate.source.locator === input.lockedBy.locator) {
      locked = true;
    }
    return {
      source: source(candidate.source),
      value: safe(candidate.value),
      status: rejected ? 'rejected' as const : 'accepted' as const,
      reason: rejected ? 'pack_locked' as const : 'precedence' as const
    };
  });
  return {
    id: input.field,
    field: input.field,
    candidates,
    effective: safe(selected.value),
    source: source(selected.source),
    ...(input.lockedBy ? {
      rule: source(input.lockedBy)
    } : {})
  };
}
export function resolveWorkflowPack(input: {
  pack?: unknown;
  builtin?: Record<string, JsonValue>;
  project?: Record<string, JsonValue>;
  overrides?: Record<string, JsonValue>;
  unavailable?: {
    id: string;
    version: string;
  };
}): Pick<ExecutionPlanInput, 'pack' | 'decisions' | 'blockers'> {
  const parsedPack = input.pack === undefined ? undefined : WorkflowPackSchema.safeParse(input.pack);
  if (parsedPack && !parsedPack.success) {
    throw new Error('Invalid workflow pack');
  }
  const pack = parsedPack?.success ? parsedPack.data : undefined;
  if (pack && !verifyWorkflowPackDigest(pack)) {
    throw new Error('Workflow pack digest mismatch');
  }
  const selection: ExecutionPlanInput['pack'] = pack ? {
    status: 'selected',
    id: pack.id,
    version: pack.version,
    digest: pack.digest
  } : input.unavailable ? {
    status: 'unavailable',
    id: String(safe(input.unavailable.id)),
    version: String(safe(input.unavailable.version))
  } : {
    status: 'not_selected'
  };
  const layers: {
    kind: PlanSource['kind'];
    values: Record<string, JsonValue>;
    locator: string;
  }[] = [{
      kind: 'builtin',
      values: input.builtin ?? {},
      locator: 'builtin'
    }, {
      kind: 'pack',
      values: pack?.defaults ?? {},
      locator: 'pack'
    }, {
      kind: 'project',
      values: input.project ?? {},
      locator: 'project'
    }, {
      kind: 'override',
      values: input.overrides ?? {},
      locator: 'override'
    }];
  const decisions: PlanDecision[] = [];
  const blockers: ExecutionPlanInput['blockers'] = [];
  if (input.unavailable && !pack) {
    blockers.push({
      code: 'workflow_pack_unavailable',
      decisionIds: [],
      source: {
        kind: 'pack',
        locator: 'pack'
      }
    });
  }
  for (const field of [...new Set(layers.flatMap(l => Object.keys(l.values)))].sort()) {
    if (!PlanFieldSchema.safeParse(field).success) {
      blockers.push({
        code: 'unsupported_plan_field',
        decisionIds: [],
        source: {
          kind: 'policy',
          locator: 'workflow-pack-allowlist'
        }
      });
      continue;
    }
    const candidates = layers.filter(l => Object.hasOwn(l.values, field)).map(l => ({
      source: {
        kind: l.kind,
        locator: l.locator
      },
      value: l.values[field]!
    }));
    if (candidates.some(c => !isPlanFieldValue(field, c.value))) {
      blockers.push({
        code: 'invalid_plan_value',
        decisionIds: [field],
        source: {
          kind: 'policy',
          locator: 'workflow-pack-allowlist'
        }
      });
      continue;
    }
    const lockedBy = pack?.lockedFields.includes(field) ? {
      kind: 'pack' as const,
      locator: 'pack'
    } : undefined;
    decisions.push(resolvePlanField({
      field,
      candidates,
      ...(lockedBy ? {
        lockedBy
      } : {})
    }));
  }
  return {
    pack: selection,
    decisions,
    blockers
  };
}
export function executionPlanExpectation(value: unknown): ExecutionPlanExpectation {
  const plan = asPlan(value);
  const { fingerprint, ...input } = plan;
  return ExecutionPlanExpectationSchema.parse({
    schemaVersion: 3,
    fingerprint,
    components: plan.components,
    snapshot: normalized(parseInput(input))
  });
}
function asPlan(value: unknown): ExecutionPlan {
  const p = ExecutionPlanSchema.safeParse(value);
  if (p.success) {
    const { fingerprint: _, ...input } = p.data;
    return buildExecutionPlan(input);
  }
  return buildExecutionPlan(value);
}
export function diffExecutionPlans(before: unknown, after: unknown): PlanDiff {
  const a = asPlan(before), b = asPlan(after);
  const changes: PlanDiff['changes'] = [];
  const walk = (left: unknown, right: unknown, path: string) => {
    if (canonicalPlanDigest(left ?? null) === canonicalPlanDigest(right ?? null)) {
      return;
    }
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        walk((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], path ? path + '.' + key : key);
      }
      return;
    }
    changes.push({
      field: path,
      ...(left === undefined ? {} : {
        before: left as JsonValue
      }),
      ...(right === undefined ? {} : {
        after: right as JsonValue
      }),
      reason: 'stable_input_changed'
    });
  };
  const aa = normalized(parseInput((({ fingerprint: _, ...x }) => x)(a))), bb = normalized(parseInput((({ fingerprint: _, ...x }) => x)(b)));
  const ad = aa.decisions, bd = bb.decisions;
  aa.decisions = [];
  bb.decisions = [];
  walk(aa, bb, '');
  for (const field of [...new Set([...ad, ...bd].map(d => d.field))].sort()) {
    const left = ad.find(d => d.field === field), right = bd.find(d => d.field === field);
    if (canonicalPlanDigest(left ?? null) === canonicalPlanDigest(right ?? null)) {
      continue;
    }
    changes.push({
      field,
      ...(left ? {
        before: left.effective,
        beforeSource: left.source
      } : {}),
      ...(right ? {
        after: right.effective,
        afterSource: right.source
      } : {}),
      reason: left && right && canonicalPlanDigest(left.effective) === canonicalPlanDigest(right.effective) ? 'source_or_rule_changed' : 'effective_value_changed'
    });
  }
  return PlanDiffSchema.parse({
    schemaVersion: 3,
    beforeFingerprint: a.fingerprint,
    afterFingerprint: b.fingerprint,
    changed: a.fingerprint !== b.fingerprint,
    changes
  });
}
export function revalidateExecutionPlan(expectation: unknown, current: unknown): {
  valid: boolean;
  diff: PlanDiff;
} {
  const parsed = ExecutionPlanExpectationSchema.safeParse(expectation);
  if (!parsed.success) {
    throw new Error('Invalid execution plan expectation');
  }
  const e = parsed.data;
  const before = buildExecutionPlan(e.snapshot);
  if (before.fingerprint !== e.fingerprint || canonicalPlanDigest(e.components) !== canonicalPlanDigest(e.snapshot.components)) {
    throw new Error('Invalid execution plan expectation binding');
  }
  const now = asPlan(current);
  const diff = diffExecutionPlans(before, now);
  for (const blocker of now.blockers) {
    diff.changes.push({
      field: `prerequisites.${blocker.code}`,
      after: blocker.code,
      afterSource: blocker.source,
      reason: 'current_prerequisite_blocked'
    });
  }
  PlanDiffSchema.parse(diff);
  return {
    valid: !diff.changed && now.blockers.length === 0,
    diff
  };
}
/** Pack pin covers semantic normalized payload, excluding its self-referential digest. */
export function workflowPackDigest(value: unknown): string {
  const parsed = WorkflowPackSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Invalid workflow pack');
  }
  const { digest: _, ...payload } = parsed.data;
  payload.lockedFields.sort();
  return canonicalPlanDigest(payload);
}
export function verifyWorkflowPackDigest(value: unknown): boolean {
  const parsed = WorkflowPackSchema.safeParse(value);
  return parsed.success && parsed.data.digest === workflowPackDigest(parsed.data);
}
