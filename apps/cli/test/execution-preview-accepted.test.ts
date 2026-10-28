import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { openFilesystemArtifactStore } from '@bflow/artifact-store';
import { SpecificationSchema, WorkflowDefinitionSchema } from '@bflow/contracts';
import { draft, workflow } from '../../../packages/specification/test/fixtures.js';
import { initializeEnvironmentConfig } from '../src/environment-config.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('the built binary reads a private accepted journal and fingerprints full accepted workflow content', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'preview-accepted-'))); roots.push(root);
  execFileSync('git', ['init', '--quiet', root]);
  await initializeEnvironmentConfig({ cwd: root });
  const opened = await openFilesystemArtifactStore({ root: join(root, 'artifacts'), storeId: 'accepted-test' });
  if (!opened.ok) throw Error(opened.error.message);
  const original = draft('api');
  const content = Buffer.from(JSON.stringify(original));
  const stored = await opened.value.put({ options: { artifactId: 'accepted-spec', runId: 'run-1', kind: 'document',
    mediaType: 'application/json', expectedIntegrity: { checksum: { algorithm: 'sha256', value: createHash('sha256').update(content).digest('hex') } }, idempotencyKey: 'accepted-spec' },
    content: (async function* () { yield content; })() });
  opened.value.close();
  if (!stored.ok) throw Error(stored.error.message);
  const spec = SpecificationSchema.parse({ ...original, status: 'approved', approvedBy: 'human-1', artifactRef: stored.value });
  const definition = WorkflowDefinitionSchema.parse(workflow());
  definition.tasks[0]!.requiresApproval = true;
  const time = new Date().toISOString();
  const request = { schemaVersion: 2, approvalId: 'design-1', runId: 'run-1', sessionId: 'session-1', status: 'approved',
    target: { type: 'run' }, revision: 1, generation: 0, requestedBy: 'coordinator', requestedAt: time,
    reason: 'Accepted test design', evidence: [stored.value], idempotencyKey: 'design-1' };
  const decision = { schemaVersion: 2, approvalId: 'design-1', runId: 'run-1', sessionId: 'session-1', target: { type: 'run' },
    revision: 1, generation: 0, decision: 'approved', decidedBy: 'human-1', decidedAt: time, feedbackArtifacts: [], idempotencyKey: 'decision-1' };
  const run = { runId: 'run-1', status: 'implementing', coreCreated: false, cancelled: false, maxIterations: 3, tasks: [], definition,
    workflowSpec: { specification: spec, request, decision, strategy: spec.testStrategy! }, decision, baseRevision: 'unborn',
    delegation: { schemaVersion: 2, delegationId: 'delegation-1', messageId: 'intake-1', correlationId: 'correlation-1', sessionId: 'session-1', runId: 'run-1',
      requestedBy: 'conversation', targetRole: 'coordinator', title: spec.title, objective: spec.summary, specificationId: spec.specId,
      sddLevel: spec.level, acceptanceCriteria: spec.acceptanceCriteria, inputArtifacts: [], priority: 'normal', requestedAt: time, idempotencyKey: 'intake-1' } };
  const journal = { version: 1, repository: root, runs: [run], outbound: [], inbox: [], pendingCore: [], pendingVerifications: [] };
  const directory = join(root, '.bflow/state/agentic/journal');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'state.json');
  await writeFile(file, JSON.stringify(journal), { mode: 0o600 });
  const binary = (args = ['task', 'preview', '--run', 'run-1', '--json']) => spawnSync(process.execPath, [resolve('apps/cli/dist/bin.js'), ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: join(root, 'home'), BFLOW_HOME: join(root, 'machine') } });
  const beforeFiles = await readdir(directory);
  const first = binary(); expect(first.status, first.stdout + first.stderr).toBe(0);
  const before = JSON.parse(first.stdout).result.output.data.plan;
  expect(before.accepted).toMatchObject({ specificationId: spec.specId, workflowId: definition.id, tasks: [{ id: 'implement', role: 'developer' }] });
  expect(before.accepted.tasks[0].requiresApproval).toBe(true);
  expect(before.policy.tdd).toBe('required');
  expect(before.policy.explanations).toContainEqual(expect.objectContaining({field:'tdd',
    source:{kind:'policy',locator:'conditional-tdd-policy'},decisionId:spec.testStrategy!.tddDecision.decisionId,
    requiresFailingTestFirst:true}));
  expect(before.policy.explanations).toContainEqual(expect.objectContaining({field:'approvalPoints',
    source:{kind:'runtime',locator:'accepted-workflow'},reasonCode:'accepted_task_approval',required:true}));
  expect(before.policy.explanations.some((item: { reasonCode: string }) => item.reasonCode === 'awaiting_accepted_specification')).toBe(false);
  const text = binary(['task', 'preview', '--run', 'run-1']);
  expect(text.stdout).toContain('Why tdd: accepted_conditional_tdd_policy (policy: conditional-tdd-policy)');
  expect(before.components.acceptedWorkflow).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(join(root,'.bflow/preview.json'),JSON.stringify(before));
  const wrong=binary(['task','implement','implement','--run','other-run','--spec','missing-spec.json','--expect-plan','.bflow/preview.json','--json']);
  expect(wrong.status).not.toBe(0);
  expect(wrong.stdout+wrong.stderr).toContain('preview_target_mismatch');
  definition.tasks[0]!.instruction += ' Preserve additional accepted behavior.';
  await writeFile(file, JSON.stringify(journal), { mode: 0o600 });
  const second = binary(); expect(second.status, second.stdout + second.stderr).toBe(0);
  const after = JSON.parse(second.stdout).result.output.data.plan;
  expect(after.fingerprint).not.toBe(before.fingerprint);
  expect(await readdir(directory)).toEqual(beforeFiles);
});
