import { CancellationReconciliationReportSchema, reconcileExistingAgenticCancellation } from "@bflow/runtime";
import { identifyRepository } from "./repository.js";
import type { CliContext } from "./types.js";

export async function executeCancellationReconciliation(runId: string, context?: CliContext) {
  const input = context?.reconcileCancellation ? await context.reconcileCancellation(runId) : await (async () => {
    const repository = await identifyRepository(context?.cwd ?? process.cwd());
    return reconcileExistingAgenticCancellation({ repositoryPath: repository.root, sessionId: repository.sessionName, runId });
  })();
  const report = CancellationReconciliationReportSchema.parse(input);
  if (report.runId !== runId) throw new Error("Foreign cancellation report");
  return report;
}
