import { resolve } from 'node:path';
import { type JsonValue } from '@bflow/contracts';
import { CONFIG_REPOSITORY_IDENTITY_MISMATCH, readSavedExecutionPlan } from '../execution-preview.js';
import { diffExecutionPlans } from '@bflow/runtime';
import { loadExecutionPreview } from '../execution-preview.js';
import type { CommandSpec } from '../args.js';
import type { HighLevelHandler } from '../context.js';
import { HIGH_LEVEL_EXIT_CODES, HighLevelError, validationError } from '../envelope.js';
export const TASK_PREVIEW_SPEC: CommandSpec = { name: 'task.preview', words: ['task', 'preview'], positionals: [], flags: { '--run': { type: 'string' }, '--compare': { type: 'string' } }, behavior: { summary: 'Explain the current execution plan from read-only snapshots', mutates: 'none', retry: 'read_only', permissionFlags: [], outcomes: ['preview', 'not_ready', 'failed'] } };
export const taskPreview: HighLevelHandler = async (args, ctx) => {
    try {
        const plan = await loadExecutionPreview(ctx.cwd, args.strings.get('--run'));
        const compare = args.strings.get('--compare');
        const diff = compare ? diffExecutionPlans(await readSavedExecutionPlan(resolve(ctx.cwd, compare)), plan) : undefined;
        return { command: 'task.preview', outcome: plan.blockers.length ? 'not_ready' : 'preview', status: 'succeeded', exitCode: plan.blockers.length ? HIGH_LEVEL_EXIT_CODES.NOT_READY : HIGH_LEVEL_EXIT_CODES.SUCCESS, steps: [], data: { plan, ...(diff ? { diff } : {}) } as unknown as JsonValue };
    }
    catch (error) {
        // Other causes may echo configuration values, so only value-free diagnostics are named.
        if (error instanceof Error && error.message === CONFIG_REPOSITORY_IDENTITY_MISMATCH)
            throw new HighLevelError(validationError(CONFIG_REPOSITORY_IDENTITY_MISMATCH, { reason: 'repository_identity_mismatch' }));
        throw new HighLevelError(validationError('Execution preview input is invalid or its accepted run is unavailable. Check repository configuration, pinned local inputs and --compare schema.'));
    }
};
