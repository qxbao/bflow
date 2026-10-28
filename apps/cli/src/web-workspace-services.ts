import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  IdentifierSchema, ContractErrorSchema, EnvironmentDoctorReportSchema, ExecutionPlanSchema,
  type OperationResult,
} from '@bflow/contracts';
import {
  WebProjectSchema, WebProjectInspectionResultSchema, WebProjectSessionResultSchema,
  WebProjectPreviewResultSchema, WebOperationSchema, WebOperationResponseSchema,
  WebSessionStartRequestSchema,
  type LocalWorkspaceServices, type WebProject, type WebProjectSession,
} from '@bflow/contracts/web';
import { openUserInteractionClient } from '@bflow/runtime';
import { EnvironmentLifecycle, type EnvironmentDependencies } from './environment.js';
import { identifyRepository } from './repository.js';
import { readEnvironmentConfig } from './environment-config.js';
import { readPreviewFile } from './preview-files.js';
import { loadExecutionPreview } from './execution-preview.js';

/** Owner-side resolver only. Never accept a path or cwd from an HTTP command. */
export interface WebWorkspaceOptions {
  resolveProject(projectId: string): Promise<WebProject>;
  environment?: EnvironmentDependencies;
  createLifecycle?: (path: string) => Pick<EnvironmentLifecycle, 'up' | 'down' | 'doctor'>;
  readSession?: (project: WebProject, sessionId: string) => Promise<OperationResult<WebProjectSession>>;
}
const error = <T>(code: 'validation' | 'transport_unavailable', message: string): OperationResult<T> =>
  ({ ok: false, error: ContractErrorSchema.parse({ code, message, retryable: code === 'transport_unavailable' }) });

export function createWebWorkspaceServices(options: WebWorkspaceOptions): LocalWorkspaceServices {
  const context = async (projectId: string) => {
    IdentifierSchema.parse(projectId);
    const project = WebProjectSchema.parse(await options.resolveProject(projectId));
    if (project.projectId !== projectId || project.registrationState !== 'registered' ||
        await realpath(project.canonicalPath) !== project.canonicalPath ||
        projectId !== 'project-' + createHash('sha256').update(project.canonicalPath).digest('hex').slice(0, 32))
      throw new Error('Registered project identity mismatch');
    const repository = await identifyRepository(project.canonicalPath, options.environment?.runner);
    if (repository.root !== project.canonicalPath) throw new Error('Registered repository root changed');
    // No fallback configuration, init, setup, index or repository plugin execution.
    await readPreviewFile(join(repository.root, '.bflow/config.yml'));
    await readEnvironmentConfig(repository);
    return { project, repository };
  };
  const lifecycle = (path: string) => options.createLifecycle?.(path) ?? new EnvironmentLifecycle(path, options.environment);
  const readSession = options.readSession ?? (async (project, sessionId) => {
    const client = await openUserInteractionClient({ repositoryPath: project.canonicalPath, sessionId });
    return client.readProjectSession(project.projectId);
  });
  const remediation = 'Kiểm tra project đã đăng ký và cấu hình. Chạy bflow init trong kho mã; chạy bflow setup --check để kiểm tra môi trường. Web không tự khởi tạo hoặc cài đặt.';
  return {
    async inspectProject(projectId) {
      try {
        const { repository } = await context(projectId);
        const report = EnvironmentDoctorReportSchema.parse(await lifecycle(repository.root).doctor(false));
        return WebProjectInspectionResultSchema.parse({ ok: true, value: {
          apiVersion: 1, projectId, ready: report.healthy,
          checks: report.checks.slice(0, 100).map(check => ({ id: check.checkId,
            state: check.status === 'passed' ? 'passed' : 'failed',
            message: check.message })), observedAt: new Date().toISOString(),
        }});
      } catch { return error('validation', remediation); }
    },
    async startSession(projectId, operationId) {
      let ctx: Awaited<ReturnType<typeof context>>;
      try { WebSessionStartRequestSchema.parse({ apiVersion: 1, operationId }); ctx = await context(projectId); }
      catch { return error('validation', remediation); }
      try {
        // EnvironmentLifecycle owns locks, provider preflight, startup receipts and activation.
        await lifecycle(ctx.repository.root).up();
        const health = WebProjectSessionResultSchema.parse(await readSession(ctx.project, ctx.repository.sessionName));
        if (!health.ok || health.value.projectId !== projectId || health.value.state !== 'ready')
          return error('transport_unavailable', 'Chưa xác nhận activated host health. Đọc lại operation; không tự gửi lại start.');
        return health;
      } catch { return error('transport_unavailable', 'Khởi động chưa được xác nhận. Giữ operation ID; kiểm tra bflow status và bflow doctor trước khi khôi phục.'); }
    },
    async stopSession(projectId, operationId) {
      let ctx: Awaited<ReturnType<typeof context>>;
      try { WebSessionStartRequestSchema.parse({ apiVersion: 1, operationId }); ctx = await context(projectId); }
      catch { return error('validation', remediation); }
      try {
        // Explicit web confirmation is checked by W03. Never force past unverified writers/checkpoints.
        const stopped = await lifecycle(ctx.repository.root).down(true, undefined, false);
        if (!('status' in stopped && stopped.status === 'down') && !('server' in stopped && stopped.server === 'stopped'))
          return error('transport_unavailable', 'Chưa xác nhận dừng phiên. Đọc lại operation; không tự gửi lại stop.');
        return WebProjectSessionResultSchema.parse({ ok: true, value: { apiVersion: 1, projectId,
          sessionId: ctx.repository.sessionName, state: 'stopped', pendingIntakes: [], blockers: [], updatedAt: new Date().toISOString() } });
      } catch { return error('transport_unavailable', 'Dừng phiên chưa được xác nhận. Giữ nguyên checkpoint và kiểm tra bflow doctor; không tự gửi lại stop.'); }
    },
    async reconcileSessionOperation(input) {
      try {
        const operation = WebOperationSchema.parse(input);
        if (operation.owner !== 'local_lifecycle') return error('validation', 'Operation không thuộc lifecycle.');
        // Existing lifecycle receipts do not bind the web operationId. Running/stopped is not proof
        // of this operation's effect. Preserve final receipts; never resend an uncertain mutation.
        if (operation.state === 'applied' || operation.state === 'failed')
          return WebOperationResponseSchema.parse({ ok: true, value: operation });
        return WebOperationResponseSchema.parse({ ok: true, value: {
          ...operation, state: 'reconciliation_required', updatedAt: operation.updatedAt,
        }});
      } catch { return error('validation', 'Operation lifecycle không hợp lệ.'); }
    },
    async preview(projectId) {
      try {
        const { repository } = await context(projectId);
        const plan = ExecutionPlanSchema.parse(await loadExecutionPreview(repository.root));
        return WebProjectPreviewResultSchema.parse({ ok: true, value: { apiVersion: 1, projectId,
          available: true, summary: `Execution preview: ${plan.mode}. Đây là cấu hình dự kiến, chưa cấp quyền hay xác nhận readiness.`,
          blockers: plan.blockers.slice(0, 100).map(blocker => ({ code: blocker.code, message: blocker.code })),
          observedAt: new Date().toISOString(),
        }});
      } catch { return error('validation', remediation); }
    },
  };
}
