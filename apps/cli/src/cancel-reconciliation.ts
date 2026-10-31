import { CancellationReconciliationReportSchema, reconcileExistingAgenticCancellation } from "@bflow/runtime";
import { EnvironmentError } from "./environment-error.js";
import { identifyRepository } from "./repository.js";
import type { CliContext } from "./types.js";

export async function executeCancellationReconciliation(runId: string, context?: CliContext) {
  const input = context?.reconcileCancellation ? await context.reconcileCancellation(runId) : await (async () => {
    const repository = await identifyRepository(context?.cwd ?? process.cwd());
    try {
      return await reconcileExistingAgenticCancellation({ repositoryPath: repository.root, sessionId: repository.sessionName, runId });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const msg = error instanceof Error ? error.message : String(error);
      if (
        code === "ENOENT" ||
        code === "ECONNREFUSED" ||
        code === "ECONNRESET" ||
        code === "EPIPE" ||
        /ENOENT|ECONNREFUSED|host\.json|socket/i.test(msg)
      ) {
        throw new EnvironmentError({
          code: "conflict",
          retryable: true,
          message: `Runtime host is not running for session '${repository.sessionName}' (run '${runId}'). Run 'bflow up' to start the Runtime host and reconcile stuck cancellation, then rerun 'bflow cancel ${runId} --reconcile' if needed.`
        });
      }
      throw error;
    }
  })();
  const report = CancellationReconciliationReportSchema.parse(input);
  if (report.runId !== runId) throw new Error("Foreign cancellation report");
  return report;
}
