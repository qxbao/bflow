import { describe, expect, it } from 'vitest';
import { buildExecutionPlan, resolveWorkflowPack, executionPlanExpectation, revalidateExecutionPlan, diffExecutionPlans, workflowPackDigest, verifyWorkflowPackDigest } from '../src/planning/index.js';
const input = () => ({
  schemaVersion: 3,
  resolverVersion: '1',
  policyVersion: '1',
  repository: {
    revision: 'abc'
  },
  mode: 'intake',
  pack: {
    status: 'not_selected'
  }
});
describe('execution planning', () => {
  it('is stable across map order and observations but detects semantic drift', () => {
    const a = buildExecutionPlan({
      ...input(),
      components: {
        profile: 'a'.repeat(64),
        skill: 'b'.repeat(64)
      }
    });
    const b = buildExecutionPlan({
      ...input(),
      components: {
        skill: 'b'.repeat(64),
        profile: 'a'.repeat(64)
      },
      observations: [{
          id: 'ready',
          status: 'stale',
          source: {
            kind: 'runtime',
            locator: 'health'
          },
          checkedAt: '2026-10-27T00:00:00Z'
        }]
    });
    expect(a.fingerprint).toBe(b.fingerprint);
    const c = buildExecutionPlan({
      ...input(),
      components: {
        profile: 'c'.repeat(64)
      }
    });
    expect(revalidateExecutionPlan(executionPlanExpectation(a), c).valid).toBe(false);
    expect(diffExecutionPlans(a, c).changes.some(x => x.field === 'components.profile')).toBe(true);
  });
  it('applies pack precedence while retaining a rejected locked override', () => {
    const pack = {
      schemaVersion: 3,
      id: 'strict',
      version: '1',
      digest: 'a'.repeat(64),
      defaults: {
        'roles.developer.model': 'pack'
      },
      lockedFields: ['roles.developer.model']
    };
    pack.digest = workflowPackDigest(pack);
    const result = resolveWorkflowPack({
      builtin: {
        'roles.developer.model': 'base'
      },
      pack,
      project: {
        'roles.developer.model': 'project'
      },
      overrides: {
        'roles.developer.model': 'override'
      }
    });
    expect(result.decisions[0]?.effective).toBe('pack');
    expect(result.decisions[0]?.candidates.map(x => x.status)).toEqual(['accepted', 'accepted', 'rejected', 'rejected']);
    expect(result.decisions[0]?.rule?.kind).toBe('pack');
  });
  it('redacts forbidden fields and does not preserve rejected arbitrary values', () => {
    const secret = 'canary-secret-token';
    const result = resolveWorkflowPack({
      project: {
        'environment.API_KEY': secret
      }
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.blockers[0]?.code).toBe('unsupported_plan_field');
  });
  it('never invents accepted tasks and rejects inconsistent accepted mode', () => {
    expect(buildExecutionPlan(input()).accepted).toBeUndefined();
    expect(() => buildExecutionPlan({
      ...input(),
      mode: 'accepted'
    })).toThrow();
  });
  it('reports provenance drift even when effective value is identical', () => {
    const make = (kind: 'builtin' | 'project') => buildExecutionPlan({
      ...input(),
      decisions: resolveWorkflowPack({
        [kind]: {
          'roles.developer.model': 'same'
        }
      }).decisions
    });
    expect(diffExecutionPlans(make('builtin'), make('project')).changes.some(x => x.field === 'roles.developer.model')).toBe(true);
  });
});
it('diffs decisions by field with before/after sources', () => {
  const make = (kind: 'builtin' | 'project') => buildExecutionPlan({
    ...input(),
    decisions: resolveWorkflowPack({
      [kind]: {
        'roles.developer.model': 'same'
      }
    }).decisions
  });
  const diff = diffExecutionPlans(make('builtin'), make('project'));
  expect(diff.changes.find(c => c.field === 'roles.developer.model')?.beforeSource?.kind).toBe('builtin');
  expect(diff.changes.find(c => c.field === 'roles.developer.model')?.afterSource?.kind).toBe('project');
});
it('projects only pin identity instead of arbitrary nested skill metadata', () => {
  const resolved = resolveWorkflowPack({
    project: {
      'skills.developer': [{
          skillId: 'custom',
          version: '1',
          digest: 'a'.repeat(64),
          description: 'arbitrary-canary-description'
        }]
    }
  });
  expect(JSON.stringify(resolved)).not.toContain('arbitrary-canary-description');
  expect(resolved.blockers.some(b => b.code === 'invalid_plan_value')).toBe(true);
});
it('excludes approval issuance from stable identity and rejects forged expectations', () => {
  const accepted = {
    runId: 'r',
    specificationId: 's',
    specificationVersion: '1',
    workflowId: 'w',
    workflowVersion: '1',
    revision: 'abc',
    tasks: [{
        id: 't',
        role: 'developer',
        dependsOn: []
      }]
  };
  const a = buildExecutionPlan({
    ...input(),
    mode: 'accepted',
    accepted
  });
  const b = buildExecutionPlan({
    ...input(),
    mode: 'accepted',
    accepted: {
      ...accepted,
      approvalIds: ['approved']
    }
  });
  expect(a.fingerprint).toBe(b.fingerprint);
  expect(() => revalidateExecutionPlan({
    ...executionPlanExpectation(a),
    fingerprint: '0'.repeat(64)
  }, a)).toThrow();
});
it('rejects secret-bearing selections without exposing rejection values', () => {
  for (const credential of ['sk-proj-abc123', 'sk-abc123', 'Bearer abc123', 'https://user:pass@example.test', 'opaque-canary-env']) {
    const field = credential === 'opaque-canary-env' ? 'env.CUSTOM' : 'roles.developer.model';
    const result = resolveWorkflowPack({
      project: {
        [field]: credential
      }
    });
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(result.blockers.length).toBeGreaterThan(0);
  }
});
it('blocks revalidation of current prerequisites without observational fingerprint drift', () => {
  const plan = buildExecutionPlan(input());
  const blocked = buildExecutionPlan({
    ...input(),
    blockers: [{
        code: 'stale_readiness',
        source: {
          kind: 'runtime',
          locator: 'health'
        }
      }]
  });
  expect(blocked.fingerprint).toBe(plan.fingerprint);
  expect(revalidateExecutionPlan(executionPlanExpectation(plan), blocked).valid).toBe(false);
});
it('rejects mismatched pack pins before applying defaults', () => {
  const pack = {
    schemaVersion: 3,
    id: 'p',
    version: '1',
    digest: 'a'.repeat(64),
    defaults: {
      'roles.developer.model': 'safe'
    },
    lockedFields: []
  };
  expect(verifyWorkflowPackDigest(pack)).toBe(false);
  expect(() => resolveWorkflowPack({
    pack
  })).toThrow('Workflow pack digest mismatch');
  pack.digest = workflowPackDigest(pack);
  expect(verifyWorkflowPackDigest(pack)).toBe(true);
});
it('does not permit arbitrary diagnostics or credential-shaped public values', () => {
  const credential = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';
  expect(() => buildExecutionPlan({
    ...input(),
    unknowns: [credential]
  })).toThrow('Invalid execution plan input');
  expect(() => buildExecutionPlan({
    ...input(),
    observations: [{
        id: 'health',
        status: 'observed',
        source: {
          kind: 'runtime',
          locator: credential
        }
      }]
  })).toThrow('Invalid execution plan input');
  expect(resolveWorkflowPack({
    project: {
      'roles.developer.model': credential
    }
  }).blockers.length).toBe(1);
});
it('returns actionable prerequisite diagnostics while keeping stable fingerprint', () => {
  const a = buildExecutionPlan(input());
  const b = buildExecutionPlan({
    ...input(),
    blockers: [{
        code: 'stale_readiness',
        source: {
          kind: 'runtime',
          locator: 'health'
        }
      }]
  });
  const result = revalidateExecutionPlan(executionPlanExpectation(a), b);
  expect(result.valid).toBe(false);
  expect(result.diff.changed).toBe(false);
  expect(result.diff.changes[0]).toMatchObject({
    field: 'prerequisites.stale_readiness',
    after: 'stale_readiness',
    afterSource: {
      kind: 'runtime',
      locator: 'health'
    },
    reason: 'current_prerequisite_blocked'
  });
});
it('rejects duplicate decision IDs and fields instead of ambiguous diffs', () => {
  const first = resolveWorkflowPack({
    project: {
      'roles.developer.model': 'one'
    }
  }).decisions[0]!;
  const second = resolveWorkflowPack({
    project: {
      'roles.developer.effort': 'high'
    }
  }).decisions[0]!;
  expect(() => buildExecutionPlan({
    ...input(),
    decisions: [first, {
        ...second,
        id: first.id
      }]
  })).toThrow('Invalid execution plan input');
  expect(() => buildExecutionPlan({
    ...input(),
    decisions: [first, {
        ...first,
        id: 'another'
      }]
  })).toThrow('Invalid execution plan input');
});
