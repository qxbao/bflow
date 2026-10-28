import { describe, expect, it } from 'vitest';
import { ExecutionPlanInputSchema, WorkflowPackSchema, PlanObservationSchema, PlanFieldSchema, PlanLocatorSchema, isPlanFieldValue } from '../src/execution-plan.js';
it('rejects unknown schema versions and unknown pack policy powers', () => {
  expect(ExecutionPlanInputSchema.safeParse({
    schemaVersion: 4
  }).success).toBe(false);
  expect(WorkflowPackSchema.safeParse({
    schemaVersion: 3,
    id: 'p',
    version: '1',
    digest: 'a'.repeat(64),
    defaults: {
      'permissions.mode': 'bypass'
    },
    lockedFields: []
  }).success).toBe(false);
});

it('separates observation freshness from outcome and grant state',()=>{
 expect(PlanObservationSchema.safeParse({id:'health',status:'observed',outcome:'blocked',reasonCode:'sandbox_unavailable',grantState:'not_granted',source:{kind:'runtime',locator:'preflight'}}).success).toBe(true);
});
it('rejects duplicate private source component IDs and conflicting file formats',async()=>{
 const {ExecutionResolutionSourcesSchema}=await import('../src/execution-plan.js');
 const plan={schemaVersion:3,resolverVersion:'1',policyVersion:'1',repository:{revision:'abc'},mode:'intake'};
 expect(ExecutionResolutionSourcesSchema.safeParse({schemaVersion:3,plan,files:[{component:'config',path:'/a',format:'json'},{component:'config',path:'/b',format:'json'}]}).success).toBe(false);
 expect(ExecutionResolutionSourcesSchema.safeParse({schemaVersion:3,plan,files:[{component:'a',path:'/a',format:'json'},{component:'b',path:'/a',format:'bytes'}]}).success).toBe(false);
});

describe('role failover plan field', () => {
  const policy = { schemaVersion: 3, policyVersion: 'approved-1', role: 'developer',
    candidates: [{ provider: 'codex', model: 'm2', profile: 'backup' }], maxSwitches: 2, cooldownMs: 1000, maxRetries: 2 };
  it('accepts only a validated policy under a governance role', () => {
    expect(PlanFieldSchema.safeParse('roles.developer.failover').success).toBe(true);
    expect(PlanFieldSchema.safeParse('roles.unknown.failover').success).toBe(false);
    expect(isPlanFieldValue('roles.developer.failover', policy)).toBe(true);
    expect(isPlanFieldValue('roles.developer.failover', 'codex')).toBe(false);
  });
  it('allows the project locator for the failover field', () => {
    expect(PlanLocatorSchema.safeParse('environment.roles.developer.failover').success).toBe(true);
  });
});
