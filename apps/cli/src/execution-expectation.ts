import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JsonValueSchema, ExecutionPlanSchema, type ExecutionPlan, type ExecutionPlanInput, type Specification, type WorkflowDefinition } from '@bflow/contracts';
import { buildExecutionPlan, canonicalPlanDigest, executionPlanExpectation, revalidateExecutionPlan } from '@bflow/runtime';
import { HighLevelEnvelopeSchema, HighLevelError, validationError, conflictError } from './high-level/envelope.js';
import { readPreviewFile } from './preview-files.js';
import { loadExecutionPreview } from './execution-preview.js';
/** Accept only an exported plan or the exact successful/blocked preview envelope. */
export async function readSavedExecutionPlan(path: string): Promise<ExecutionPlan> {
    try {
        const raw: unknown = JSON.parse(await readPreviewFile(path));
        const direct = ExecutionPlanSchema.safeParse(raw);
        if (direct.success)
            return direct.data;
        const envelope = HighLevelEnvelopeSchema.parse(raw);
        if (envelope.command !== 'task.preview')
            throw new Error('Not a preview');
        const output = envelope.result.output;
        if (!output || typeof output !== 'object' || Array.isArray(output))
            throw new Error('Missing preview output');
        const data = output.data;
        if (!data || typeof data !== 'object' || Array.isArray(data))
            throw new Error('Missing preview data');
        return ExecutionPlanSchema.parse(data.plan);
    }
    catch {
        throw new HighLevelError(validationError('Expected a valid saved execution preview.'));
    }
}
/** A repeatable read-only guard; callers repeat it after awaited preparation before effects. */
export interface ExecutionExpectationGuard {
    (actualResolution?: ExecutionPlanInput): Promise<void>;
    assertResolved(): void;
}
export async function prepareExecutionExpectation(cwd: string, file: string, target?: {
    runId: string; taskId: string; specification?: Specification; workflow?: WorkflowDefinition; baseRevision?: string;
}): Promise<ExecutionExpectationGuard> {
    const saved = await readSavedExecutionPlan(resolve(cwd, file));
    const mismatch = () => new HighLevelError(conflictError('Saved preview does not match the requested execution target.', { reason: 'preview_target_mismatch' }));
    if (target) {
        const accepted = saved.accepted;
        if (!accepted || accepted.runId !== target.runId ||
            !accepted.tasks.some(task => task.id === target.taskId && task.role === 'developer')) throw mismatch();
        if (target.specification) {
            const spec = target.specification;
            const digest = canonicalPlanDigest({ id: spec.specId, version: spec.version ?? 1, checksum: spec.artifactRef?.checksum ?? null });
            if (accepted.specificationId !== spec.specId || accepted.specificationVersion !== String(spec.version ?? 1) ||
                saved.components.acceptedSpecification !== digest) throw mismatch();
        }
        if (target.workflow && saved.components.acceptedWorkflow !== canonicalPlanDigest(JSON.parse(JSON.stringify(target.workflow)))) throw mismatch();
    }
    const expected = executionPlanExpectation(saved);
    let actualChecked = false;
    const check: ExecutionExpectationGuard = async (actualResolution?: ExecutionPlanInput) => {
        if (target?.baseRevision && target.baseRevision !== 'HEAD') {
            const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
            for (const key of Object.keys(environment)) if (key.startsWith('GIT_') && key !== 'GIT_OPTIONAL_LOCKS') delete environment[key];
            try {
                const base = await promisify(execFile)('git', ['rev-parse', '--verify', '--end-of-options', `${target.baseRevision}^{commit}`], { cwd, env: environment });
                if (base.stdout.trim() !== saved.repository.revision) throw mismatch();
            } catch { throw mismatch(); }
        }
        let current: ExecutionPlan;
        try {
            current = await loadExecutionPreview(cwd, saved.accepted?.runId);
        }
        catch {
            throw new HighLevelError(validationError('Current execution inputs cannot be safely resolved.'));
        }
        if (actualResolution) {
            const acceptedComponents = Object.fromEntries(Object.entries(current.components).filter(([key]) => key.startsWith('accepted')));
            current = buildExecutionPlan({ ...actualResolution, mode: current.mode, ...(current.accepted ? { accepted: current.accepted } : {}),
                components: { ...actualResolution.components, ...acceptedComponents }, policy: current.accepted ? current.policy : actualResolution.policy });
        }
        const result = revalidateExecutionPlan(expected, current);
        // A snapshot cannot inspect executables. Only the actual execution resolver may confirm conditional tool skills.
        const conditionalOnly = !target && !actualResolution && current.blockers.length === 0 && result.diff.changes.length > 0
            && result.diff.changes.every(change => change.field.startsWith('skills.'));
        if (!result.valid && !conditionalOnly)
            throw new HighLevelError(conflictError('Execution preview changed or a required prerequisite is unavailable; review the diff and current plan.', {
                reason: 'execution_plan_drift', diff: JsonValueSchema.parse(result.diff), currentPlan: JsonValueSchema.parse(current) }));
        if (actualResolution && result.valid) actualChecked = true;
    };
    check.assertResolved = () => {
        if (!actualChecked) throw new HighLevelError(validationError('Actual Runtime resolution was not confirmed before launch.', { reason: 'execution_resolution_not_confirmed' }));
    };
    await check();
    return check;
}
