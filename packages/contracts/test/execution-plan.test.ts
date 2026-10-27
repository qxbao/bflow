import { expect, it } from 'vitest';
import { ExecutionPlanInputSchema, WorkflowPackSchema, PlanObservationSchema } from '../src/execution-plan.js';
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
