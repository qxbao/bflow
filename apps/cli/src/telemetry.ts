import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { buildWorkflowTelemetry, readExistingAgenticTelemetry, findPrivateRuntimeStateDirectory,
  WorkflowTelemetryReportSchema, type WorkflowTelemetryReport } from "@bflow/runtime";
import { identifyRepository } from "./repository.js";
import { sanitizeIdentifier } from "./presentation.js";
import type { CliContext } from "./types.js";

export async function executeTelemetryStatus(runId: string, context?: CliContext): Promise<WorkflowTelemetryReport> {
  const asOf = (context?.clock?.() ?? new Date()).toISOString();
  let source: "agentic" | "legacy" = "agentic";
  try {
    if (context?.telemetry) {
      const report = WorkflowTelemetryReportSchema.parse(await context.telemetry(runId));
      if (report.runId !== runId) throw new Error("Foreign report");
      return report;
    }
    const repository = await identifyRepository(context?.cwd ?? process.cwd());
    const stateDirectory = findPrivateRuntimeStateDirectory(repository.root);
    let agentic = false;
    for (const path of stateDirectory === undefined ? [] : [join(stateDirectory, "host", repository.sessionName, "host.json"), join(stateDirectory, "agentic")]) {
      try { await lstat(path); agentic = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (agentic) return await readExistingAgenticTelemetry({ repositoryPath: repository.root,
      sessionId: repository.sessionName, runId, asOf });
    source = "legacy";
    return buildWorkflowTelemetry({ runId, asOf, source, events: [], taskIds: [], complete: false,
      diagnostics: ["legacy_readonly_source_unavailable"] });
  } catch {
    return buildWorkflowTelemetry({ runId, asOf, source, events: [], taskIds: [], complete: false,
      diagnostics: ["source_unavailable"] });
  }
}

export function formatTelemetryReport(input: unknown): string {
  const report = WorkflowTelemetryReportSchema.parse(input);
  const lines = [`Telemetry ${sanitizeIdentifier(report.runId)} (${report.source})`,
    `Outcome: ${report.outcome} (${report.outcomeSource}); host phase: ${report.hostWorkStatus ?? "unavailable"}; as-of: ${report.asOf}`,
    `Coverage: ${report.coverage.quality}; sources: Core=${report.sourceCoverage.coreEvents}, host receipts=${report.sourceCoverage.hostReceipts}; core_events=${report.coverage.events}; high-water=${report.coverage.highWaterMark}`,
    `Tasks: succeeded=${report.cohort.succeeded}, failed=${report.cohort.failed}, cancelled=${report.cohort.cancelled}, incomplete=${report.cohort.incomplete}`];
  for (const name of ["firstPass", "reworkCycles", "retryAttempts", "approvalWait", "clarificationWait", "gateTurnaround",
    "gateExecution", "phaseRoleTime", "evidenceReuse", "regressionWidening", "tokens", "costUsd"] as const) {
    const metric = report[name];
    lines.push(`${name}: ${metric.value === null ? "unavailable" : metric.value} ${metric.unit} [${metric.quality}] numerator=${metric.numerator ?? "unavailable"} denominator=${metric.denominator}`);
    lines.push(`  ${metric.limitation}`);
  }
  for (const task of report.taskStateTime) lines.push(`Task ${sanitizeIdentifier(task.taskId)} / ${task.state}: ${task.durationMs ?? "unavailable"} ms closed (${task.intervals} intervals); open lower bound=${task.openLowerBoundMs ?? "unavailable"} ms [${task.quality}]`);
  for (const group of report.phaseRoleIntervals) lines.push(`Phase ${group.phase} / role ${group.role}: ${group.durationMs} ms sum / ${group.operations} operations [partial]`);
  for (const detail of report.regressionWideningDetails) lines.push(`Regression widening ${detail.tier}/${detail.reason}: ${detail.count}`);
  for (const detail of report.reviewGateDetails) lines.push(`Review gate ${sanitizeIdentifier(detail.gateId)} / role ${sanitizeIdentifier(detail.role)} / provider ${sanitizeIdentifier(detail.provider ?? "unknown")}: ${detail.operations} closed, ${detail.durationMs} ms sum, max ${detail.maxMs} ms, timeouts ${detail.timeouts}, near-deadline ${detail.nearDeadline}, open ${detail.open} [partial]`);
  lines.push(`Approvals: closed=${report.approvals.closed}, open=${report.approvals.open}, superseded=${report.approvals.superseded}, cancelled=${report.approvals.cancelled}, expired-deadline=${report.approvals.expired}, incomplete-terminal=${report.approvals.incompleteAtTerminal}, unpaired=${report.approvals.unpaired}`);
  lines.push(`Gates: closed=${report.gates.closed}, open=${report.gates.open}, interrupted=${report.gates.interrupted}, unpaired=${report.gates.unpaired}`);
  if (report.coverage.diagnostics.length) lines.push(`Diagnostics: ${report.coverage.diagnostics.join(", ")}`);
  return lines.join("\n");
}
