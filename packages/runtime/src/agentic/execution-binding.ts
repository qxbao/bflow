import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TaskRecordSchema, IntegrationRecordSchema } from '@bflow/git-orchestrator';
import { stripCodexWorkspaceTrustForComparison } from '@bflow/agent-providers';
import {
  ExecutionPlanInputSchema, ExecutionResolutionSourcesSchema, PlanDiffSchema, PlanPolicyExplanationSchema,
  type ExecutionPlanInput, type PlanDiff, type WorkflowDefinition
} from '@bflow/contracts';
import {
  buildExecutionPlan, executionPlanExpectation, revalidateExecutionPlan, canonicalPlanDigest
} from '../planning/index.js';
import { findPrivateRuntimeStateDirectory } from '../private-state.js';
import { parseAgenticJournalState, type RunRecord } from './journal.js';
import { runtimeGitDirectoryFlags } from './patch-paths.js';
import { managedWorktreeRoot } from './worktree-root.js';

/** Private file-watch evidence; it never enters public plan fingerprints or diagnostics. */
export interface ExecutionResolutionReader {
  (): Promise<ExecutionPlanInput>;
  readPrivateSources?(): Promise<Record<string, string>>;
}

/** Diagnostics deliberately exclude watched paths, contents and private digests. */
export class ExecutionPlanDriftError extends Error {
  readonly code = 'execution_plan_drift';
  constructor(readonly diff: PlanDiff) {
    super('Execution plan inputs changed; read-only re-resolution is required before execution');
    this.name = 'ExecutionPlanDriftError';
  }
}

/** Bounded, nonblocking, no-follow read; symlinked ancestors are refused too. */
export async function readResolutionFile(path: string, limit = 8 * 1024 * 1024): Promise<Buffer> {
  const absolute = resolve(path);
  if (path !== absolute) throw Error('Invalid resolution source');
  let parent = parse(absolute).root;
  for (const part of dirname(absolute).slice(parent.length).split('/').filter(Boolean)) {
    parent = join(parent, part);
    const stats = await lstat(parent);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw Error('Invalid resolution source');
  }
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw Error('Invalid resolution source');
    const bytes = Buffer.alloc(Math.min(before.size + 1, limit + 1));
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, null);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await file.stat();
    if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw Error('Resolution source changed during read');
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}

const executeGit = promisify(execFile);
const MAX_GIT_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** Source/config watches cover managed metadata separately; never publish credential content hashes. */
function repositorySnapshotPath(path: string): boolean {
  return !path.startsWith('.bflow/') &&
    !/(^|\/)(?:\.ssh|\.aws|\.gnupg|\.codex|\.claude)(?:\/|$)/.test(path) &&
    !/(^|\/)(?:\.env(?:\..*)?|\.netrc|(?:credentials?|secrets?|tokens?|auth)\.(?:json|ya?ml|toml|env))$/i.test(path);
}

/** Shared CLI/execution snapshot. Git inspection disables optional writes and external diff/textconv hooks. */
export async function readExecutionRepositorySnapshot(repositoryPath: string): Promise<ExecutionPlanInput['repository']> {
  const root = await realpath(repositoryPath);
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith('GIT_')) delete environment[name];
  environment.GIT_OPTIONAL_LOCKS = '0';
  const dirFlags = await runtimeGitDirectoryFlags(root);
  const git = async (args: string[]): Promise<string> => (await executeGit('git', [
    ...dirFlags, '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.hooksPath=/dev/null', ...args
  ], { cwd: root, env: environment, encoding: 'utf8', maxBuffer: MAX_GIT_SNAPSHOT_BYTES, timeout: 10_000 })).stdout;
  try {
    if (await realpath((await git(['rev-parse', '--show-toplevel'])).trim()) !== root)
      throw Error('Repository root mismatch');
    const revision = async (): Promise<string> => {
      try { return (await git(['rev-parse', '--verify', '--quiet', 'HEAD'])).trim(); }
      catch (error) {
        if ((error as { code?: unknown }).code === 1)
          return 'unborn';
        throw error;
      }
    };
    const index = async (): Promise<string[]> => (await git(['ls-files', '--stage', '-z']))
      .split('\0').filter(Boolean).filter(entry => repositorySnapshotPath(entry.slice(entry.indexOf('\t') + 1))).sort();
    const beforeRevision = await revision();
    const beforeIndex = await index();
    const tracked = (await git(beforeRevision === 'unborn' ? ['ls-files', '-z']
      : ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--'])).split('\0').filter(Boolean);
    const untracked = (await git(['ls-files', '-o', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    const dirtyDigests: Record<string, string> = { '@git-index': canonicalPlanDigest(beforeIndex) };
    for (const path of [...new Set([...tracked, ...untracked])].filter(repositorySnapshotPath).sort()) {
      if (['@git-index', '__proto__', 'constructor', 'prototype'].includes(path) || path.startsWith('/') || path.split('/').some(part => part === '..') || path.includes('\ufffd'))
        throw Error('Invalid repository source identity');
      try {
        const bytes = await readResolutionFile(resolve(root, path));
        const mode = (await lstat(resolve(root, path))).mode & 0o111;
        dirtyDigests[path] = canonicalPlanDigest({ content: createHash('sha256').update(bytes).digest('hex'), executable: mode !== 0 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') dirtyDigests[path] = canonicalPlanDigest({ missing: true });
        else throw error;
      }
    }
    if (beforeRevision !== await revision() || canonicalPlanDigest(beforeIndex) !== canonicalPlanDigest(await index()))
      throw Error('Repository changed during snapshot');
    return { revision: beforeRevision, dirtyDigests };
  } catch {
    // No raw Git stderr, source paths or file contents cross the diagnostic boundary.
    throw Error('Execution repository snapshot is unavailable or changed during observation');
  }
}

function privateSourceDrift(fingerprint: string, components: readonly string[]): ExecutionPlanDriftError {
  return new ExecutionPlanDriftError(PlanDiffSchema.parse({
    schemaVersion: 3, beforeFingerprint: fingerprint, afterFingerprint: fingerprint, changed: true,
    changes: components.map(component => ({
      field: `inputs.${component}`, reason: 'source_changed_re_resolution_required',
      beforeSource: { kind: 'project', locator: 'execution-source' }, afterSource: { kind: 'project', locator: 'execution-source' }
    }))
  }));
}

/** @internal Read-only normalization shared with CLI capture. No trust is granted here. */
export async function normalizeManagedCodexWorkspaceTrust(text: string, repositoryRoot: string): Promise<string> {
  const table = (path: string) => `[projects.${JSON.stringify(path).replace(/\u007f/g, '\\u007f')}]\ntrust_level = "trusted"\n`;
  const atLine = (source: string, entry: string) => {
    const at = source.indexOf(entry);
    return at >= 0 && (at === 0 || source[at - 1] === '\n') ? at : -1;
  };
  const worktreeRoot = managedWorktreeRoot(repositoryRoot);
  // No native worktree table means there is no exception to verify and no Git command to run.
  if (!text.includes(`[projects.${JSON.stringify(worktreeRoot).replace(/\u007f/g, '\\u007f').slice(0, -1)}/`)) return text;
  try {
    if (await realpath(repositoryRoot) !== repositoryRoot) return text;
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (key.startsWith('GIT_')) delete environment[key];
    environment.GIT_OPTIONAL_LOCKS = '0';
    const flags = await runtimeGitDirectoryFlags(repositoryRoot);
    const git = async (args: string[]) => (await executeGit('git', [...flags, '--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repositoryRoot, env: environment, encoding: 'utf8', timeout: 10_000,
      maxBuffer: MAX_GIT_SNAPSHOT_BYTES })).stdout;
    const common = await realpath((await git(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    const journal = z.object({ version: z.literal(1), repository: z.literal(common), tasks: z.record(TaskRecordSchema),
      integrations: z.record(IntegrationRecordSchema) }).strict().parse(JSON.parse((await readResolutionFile(join(common, 'bflow-git/state.json'), 32 * 1024 * 1024)).toString('utf8')));
    const registered = (await git(['worktree', 'list', '--porcelain', '-z'])).split('\0\0').map(block => block.split('\0'));
    let result = text;
    for (const [kind, records] of [['task', journal.tasks], ['integration', journal.integrations]] as const) {
      for (const [key, record] of Object.entries(records)) {
        if (!/^[a-f0-9]{64}$/.test(key) || record.key !== key ||
          record.worktreePath !== join(worktreeRoot, `${kind}-${key}`)) continue;
        const entry = table(record.worktreePath), at = atLine(result, entry);
        if (at < 0 || result.indexOf(entry, at + entry.length) >= 0) continue;
        const rest = result.slice(at + entry.length);
        // Any additional property/comment in this project table stays guarded byte-for-byte.
        if (rest !== '' && !/^\n?\[/.test(rest)) continue;
        let missing = false;
        try { await lstat(record.worktreePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing = true; }
        if (missing) {
          if (record.status !== 'cleaned') continue;
        } else {
          if (await realpath(record.worktreePath) !== record.worktreePath) continue;
          const binding = registered.find(lines => lines.includes(`worktree ${record.worktreePath}`));
          if (!binding?.includes(`branch refs/heads/${record.branchName}`)) continue;
          const marker = join(record.worktreePath, '.git');
          const raw = (await readResolutionFile(marker, 4096)).toString('utf8').trim();
          if (!raw.startsWith('gitdir: ')) continue;
          const gitDirectory = resolve(record.worktreePath, raw.slice(8));
          if (dirname(gitDirectory) !== join(common, 'worktrees') || await realpath(gitDirectory) !== gitDirectory) continue;
          if ((await readResolutionFile(join(gitDirectory, 'gitdir'), 4096)).toString('utf8').trim() !== marker ||
            resolve(gitDirectory, (await readResolutionFile(join(gitDirectory, 'commondir'), 4096)).toString('utf8').trim()) !== common) continue;
        }
        result = stripCodexWorkspaceTrustForComparison(result, repositoryRoot, record.worktreePath) ?? result;
      }
    }
    return result;
  } catch {
    // Missing, malformed, foreign or unsafe proof cannot create an exception to the drift guard.
    return text;
  }
}

/** Private watches are conservative; non-JSON changes require a new read-only semantic resolution. */
export async function createExecutionResolutionReader(input: unknown): Promise<ExecutionResolutionReader> {
  const source = ExecutionResolutionSourcesSchema.parse(input);
  if (new Set(source.files.map(file => file.component)).size !== source.files.length ||
      source.files.some(file => !/^[A-Za-z0-9._-]{1,128}$/.test(file.component) || ['__proto__', 'constructor', 'prototype'].includes(file.component)))
    throw Error('Invalid execution resolution component identities');
  const plan = buildExecutionPlan(source.plan);
  const capture = async (): Promise<Record<string, string>> => {
    const snapshots: Record<string, string> = {};
    for (const file of source.files) {
      try {
        let bytes = await readResolutionFile(file.path);
        if (source.repositoryRoot && /^native-profile-settings-\d+$/.test(file.component) &&
          file.path.endsWith('/home/.codex/config.toml')) {
          const text = bytes.toString('utf8');
          // Invalid encodings must retain their original bytes, not collapse to replacement characters.
          if (Buffer.from(text).equals(bytes)) bytes = Buffer.from(await normalizeManagedCodexWorkspaceTrust(text, source.repositoryRoot));
        }
        snapshots[file.component] = file.format === 'json'
          ? canonicalPlanDigest(JSON.parse(bytes.toString('utf8')))
          : createHash('sha256').update(bytes).digest('hex');
      } catch (error) {
        if (file.optional && (error as NodeJS.ErrnoException).code === 'ENOENT') snapshots[file.component] = canonicalPlanDigest({ missing: true });
        else throw privateSourceDrift(plan.fingerprint, [file.component]);
      }
    }
    if (source.repositoryRoot !== undefined) {
      try { snapshots['repository-snapshot'] = canonicalPlanDigest(await readExecutionRepositorySnapshot(source.repositoryRoot)); }
      catch { throw privateSourceDrift(plan.fingerprint, ['repository-snapshot']); }
    }
    return snapshots;
  };
  const baseline = await capture();
  if (source.repositoryRoot !== undefined && baseline['repository-snapshot'] !== canonicalPlanDigest(source.plan.repository))
    throw privateSourceDrift(plan.fingerprint, ['repository-snapshot']);
  const initialMismatch = source.files.filter(file => file.expectedDigest !== undefined && file.expectedDigest !== baseline[file.component]);
  if (initialMismatch.length) throw privateSourceDrift(plan.fingerprint, initialMismatch.map(file => file.component));
  const read: ExecutionResolutionReader = async () => {
    const current = await capture();
    const changed = Object.keys(baseline).filter(key => current[key] !== baseline[key]);
    if (changed.length) throw privateSourceDrift(plan.fingerprint, changed);
    return ExecutionPlanInputSchema.parse(source.plan);
  };
  read.readPrivateSources = capture;
  return read;
}

/** Compare persisted private evidence without disclosing its values in the returned diff. */
export async function assertPrivateExecutionSources(read: ExecutionResolutionReader | undefined, expected: Record<string, string> | undefined): Promise<void> {
  if (!read || !expected) return;
  const input = await read();
  if (!read.readPrivateSources) throw privateSourceDrift(buildExecutionPlan(input).fingerprint, ['source-reader-unavailable']);
  const current = await read.readPrivateSources();
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(current)])];
  const changed = keys.filter(key => current[key] !== expected[key]);
  if (changed.length) throw privateSourceDrift(buildExecutionPlan(input).fingerprint, changed);
  await read();
}

/** A pack may describe a candidate workflow, but a locked selection cannot silently execute another DAG. */
export function assertAcceptedWorkflowSelection(definition: WorkflowDefinition, input: ExecutionPlanInput): void {
  const values: Record<string, string> = {
    'workflow.id': definition.id,
    'workflow.version': definition.version,
    'workflow.digest': canonicalPlanDigest(JSON.parse(JSON.stringify(definition)))
  };
  for (const decision of input.decisions) {
    if (decision.rule?.kind === 'pack' && Object.hasOwn(values, decision.field) && decision.effective !== values[decision.field])
      throw new Error(`Accepted workflow violates locked pack field ${decision.field}`);
  }
}

type PolicyExplanation = ExecutionPlanInput['policy']['explanations'][number];
/** Host/project gate and governance provenance is kept; TDD and task approvals come from the accepted dossier. */
function acceptedPolicyExplanations(previous: readonly PolicyExplanation[], definition: WorkflowDefinition,
  tdd: { decisionId: string; mode: string; requiresFailingTestFirst: boolean }): PolicyExplanation[] {
  const kept = previous.filter(item => (item.field === 'gates' || item.field === 'approvalPoints') &&
    item.reasonCode !== 'accepted_workflow_gates' && item.reasonCode !== 'accepted_task_approval');
  const decisionId = PlanPolicyExplanationSchema.shape.decisionId.safeParse(tdd.decisionId).success ? tdd.decisionId : undefined;
  const strategy = { source: { kind: 'policy' as const, locator: 'conditional-tdd-policy' as const }, ...(decisionId ? { decisionId } : {}), classification: tdd.mode };
  const workflow = { kind: 'runtime' as const, locator: 'accepted-workflow' as const };
  return [
    ...kept,
    ...(definition.qualityGates.length ? [{ field: 'gates' as const, source: workflow, reasonCode: 'accepted_workflow_gates' as const }] : []),
    { field: 'tdd', ...strategy, reasonCode: 'accepted_conditional_tdd_policy', requiresFailingTestFirst: tdd.requiresFailingTestFirst },
    { field: 'alternativeVerification', ...strategy, reasonCode: 'accepted_alternative_verification_policy', required: tdd.mode === 'not_applicable' },
    ...(definition.tasks.some(task => task.requiresApproval)
      ? [{ field: 'approvalPoints' as const, source: workflow, reasonCode: 'accepted_task_approval' as const, required: true }] : [])
  ];
}

export function acceptedExecutionPlanInput(run: RunRecord, input: unknown): ExecutionPlanInput {
  const current = ExecutionPlanInputSchema.parse(input);
  const dossier = run.workflowSpec;
  const spec = dossier?.specification;
  const definition = run.definition;
  if (!spec || spec.status !== 'approved' || !definition || dossier?.decision?.decision !== 'approved')
    throw Error('No authoritative accepted execution plan');
  assertAcceptedWorkflowSelection(definition, current);
  const originalApprovalIds = run.executionPlan?.snapshot.accepted?.approvalIds;
  const designApprovalId = dossier.decision.metadata?.approvedBundleId;
  const approvalIds = originalApprovalIds ?? [typeof designApprovalId === 'string' ? designApprovalId : dossier.decision.approvalId];
  const accepted = {
    runId: run.runId, specificationId: spec.specId, specificationVersion: String(spec.version ?? 1),
    workflowId: definition.id, workflowVersion: definition.version, revision: run.baseRevision ?? current.repository.revision, approvalIds,
    tasks: definition.tasks.map(task => ({
      id: task.id, role: task.role, requiresApproval: task.requiresApproval,
      dependsOn: definition.dependencies.filter(dependency => dependency.taskId === task.id).map(dependency => dependency.dependsOnTaskId),
      gates: task.qualityGates.map(gate => gate.gateId)
    }))
  };
  const strategy = dossier.strategy;
  const policySnapshot = strategy.metadata?.conditionalTdd;
  const alternativeMethods = policySnapshot && typeof policySnapshot === 'object' && !Array.isArray(policySnapshot)
    ? policySnapshot.requiredVerificationMethods : undefined;
  const policy = {
    ...current.policy,
    gates: [...new Set([...current.policy.gates, ...definition.qualityGates.map(gate => gate.id)])],
    tdd: strategy.tddDecision.mode,
    alternativeVerification: strategy.tddDecision.mode === 'not_applicable'
      ? Array.isArray(alternativeMethods) ? alternativeMethods.filter((value): value is string => typeof value === 'string')
        : [...new Set(spec.acceptanceCriteria.filter(criterion => criterion.required).map(criterion => criterion.verificationMethod))]
      : [],
    explanations: acceptedPolicyExplanations(current.policy.explanations, definition, strategy.tddDecision)
  };
  const components = {
    ...current.components,
    acceptedSpecification: canonicalPlanDigest({ id: spec.specId, version: spec.version ?? 1, checksum: spec.artifactRef?.checksum ?? null }),
    acceptedWorkflow: canonicalPlanDigest(JSON.parse(JSON.stringify(definition))),
    acceptedStrategy: canonicalPlanDigest(JSON.parse(JSON.stringify({
      strategyId: strategy.strategyId, specId: strategy.specId,
      tddDecision: strategy.tddDecision, requiredTestLevels: strategy.requiredTestLevels,
      targetCommands: strategy.targetCommands, criterionMappings: strategy.criterionMappings,
      policySnapshot: strategy.metadata?.conditionalTdd ?? null
    })))
  };
  const decisions = current.decisions.map(decision => Object.hasOwn({ 'workflow.id': true, 'workflow.version': true }, decision.field)
    ? { ...decision, effective: decision.field === 'workflow.id' ? definition.id : definition.version,
      source: { kind: 'runtime' as const, locator: 'accepted-workflow' } } : decision);
  return ExecutionPlanInputSchema.parse({ ...current, repository: { ...current.repository, revision: accepted.revision },
    mode: 'accepted', accepted, policy, components, decisions });
}

/** New accepted runs bind without a CLI expectation; historical journals never get an invented baseline. */
export async function bindAcceptedExecutionPlan(run: RunRecord, read: ExecutionResolutionReader | undefined): Promise<void> {
  if (!read) return;
  const current = acceptedExecutionPlanInput(run, await read());
  const sources = await read.readPrivateSources?.();
  await read(); // Recheck after asynchronous source capture; do not bind old semantics to newer files.
  run.executionPlan = executionPlanExpectation(buildExecutionPlan(current));
  if (sources) run.executionSourceDigests = sources;
  delete run.executionPlanDrift;
}

export async function assertRunExecutionPlan(run: RunRecord | undefined, read: ExecutionResolutionReader | undefined): Promise<void> {
  if (!read) return;
  try {
    const current = await read();
    if (!run?.executionPlan) return;
    if (run.executionSourceDigests) {
      if (!read.readPrivateSources) throw privateSourceDrift(run.executionPlan.fingerprint, ['source-reader-unavailable']);
      const sources = await read.readPrivateSources();
      const keys = [...new Set([...Object.keys(run.executionSourceDigests), ...Object.keys(sources)])];
      const changed = keys.filter(key => sources[key] !== run.executionSourceDigests![key]);
      if (changed.length) throw privateSourceDrift(run.executionPlan.fingerprint, changed);
      await read();
    }
    const checked = revalidateExecutionPlan(run.executionPlan, acceptedExecutionPlanInput(run, current));
    if (!checked.valid) throw new ExecutionPlanDriftError(checked.diff);
    delete run.executionPlanDrift;
  } catch (error) {
    if (error instanceof ExecutionPlanDriftError && run) run.executionPlanDrift = error.diff;
    throw error;
  }
}

/** No mutable workspace, database, flock, recovery, or launch is opened for accepted preview. */
export async function readAcceptedExecutionPlanInput(repositoryPath: string, runId: string): Promise<ExecutionPlanInput | null> {
  const repository = await realpath(repositoryPath);
  const directory = findPrivateRuntimeStateDirectory(repository);
  if (!directory) return null;
  let bytes: Buffer;
  try {
    const path = join(directory, 'agentic', 'journal', 'state.json');
    const file = await lstat(path);
    const parent = await lstat(dirname(path));
    const uid = process.getuid?.();
    if ((file.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0 ||
        (uid !== undefined && (file.uid !== uid || parent.uid !== uid))) throw Error('Unsafe accepted state');
    bytes = await readResolutionFile(path, 32 * 1024 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw Error('Accepted execution plan state is unavailable');
  }
  let state;
  try { state = parseAgenticJournalState(JSON.parse(bytes.toString('utf8')), repository); }
  catch { throw Error('Accepted execution plan state is invalid'); }
  const run = state.runs.find(candidate => candidate.runId === runId);
  if (!run?.workflowSpec || run.workflowSpec.specification.status !== 'approved' ||
      run.workflowSpec.decision?.decision !== 'approved' || !run.definition) return null;
  if (run.executionPlan) return acceptedExecutionPlanInput(run, run.executionPlan.snapshot);
  return acceptedExecutionPlanInput(run, {
    schemaVersion: 3, resolverVersion: 'legacy-unbound', policyVersion: 'legacy-unbound',
    repository: { revision: run.baseRevision ?? 'unknown' }, mode: 'intake', unknowns: ['legacy_resolution_baseline_unavailable']
  });
}

/** Strip private watch evidence from every externally returned Runtime run document. */
export function publicExecutionRun(run: RunRecord): Omit<RunRecord, 'executionSourceDigests'> {
  const { executionSourceDigests: _, ...publicRun } = run;
  return publicRun;
}
