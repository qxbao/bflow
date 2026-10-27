import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema } from "@bflow/contracts";
import { WorkflowTelemetryReportSchema, type WorkflowTelemetryReport } from "./report.js";

export const HostTelemetryObservationsSchema = z.object({ complete: z.boolean(),
  regression: z.array(z.object({ evaluationId: IdentifierSchema,
    widening: z.array(z.object({ tier: z.enum(["package", "full"]),
      reason: z.enum(["root_config", "package_manifest", "non_code_change", "index_unavailable", "other"]) }).strict()) }).strict()),
  phases: z.array(z.object({ verificationId: IdentifierSchema, phase: z.enum(["red", "green", "refactor", "verification"]),
    role: z.enum(["quality_gate", "qa", "reviewer", "tester"]), startedAt: IsoDateTimeSchema, completedAt: IsoDateTimeSchema }).strict())
}).strict();
export type HostTelemetryObservations = z.infer<typeof HostTelemetryObservationsSchema>;

/** Input is the owning host receipt reader's allowlisted projection, never agent metadata. */
export function enrichHostTelemetry(input: WorkflowTelemetryReport, raw: HostTelemetryObservations): WorkflowTelemetryReport {
  const report = WorkflowTelemetryReportSchema.parse(input), observations = HostTelemetryObservationsSchema.parse(raw);
  const regressions = new Map(observations.regression.map(item => [item.evaluationId, item]));
  let widened = 0;
  const reasons = new Map<string, WorkflowTelemetryReport["regressionWideningDetails"][number]>();
  for (const item of regressions.values()) {
    if (item.widening.length) widened++;
    for (const w of item.widening) {
      const key = `${w.tier}:${w.reason}`;
      const entry = reasons.get(key) ?? { ...w, count: 0 };
      entry.count++; reasons.set(key, entry);
    }
  }
  if (regressions.size) report.regressionWidening = { value: widened / regressions.size, numerator: widened,
    denominator: regressions.size, quality: "partial", unit: "ratio", source: "host_regression_receipts",
    limitation: "Current authenticated receipt inventory only; no immutable publication timestamps or complete expected population. Missing/failed selections excluded." };
  report.regressionWideningDetails = [...reasons.values()].sort((a, b) => a.tier.localeCompare(b.tier) || a.reason.localeCompare(b.reason));
  const phases = new Map(observations.phases.map(item => [item.verificationId, item]));
  const groups = new Map<string, WorkflowTelemetryReport["phaseRoleIntervals"][number]>();
  let totalMs = 0, pairs = 0;
  for (const item of phases.values()) {
    const duration = Date.parse(item.completedAt) - Date.parse(item.startedAt);
    if (duration < 0 || Date.parse(item.completedAt) > Date.parse(report.asOf)) continue;
    const key = `${item.phase}:${item.role}`, entry = groups.get(key) ?? { phase: item.phase, role: item.role, durationMs: 0, operations: 0 };
    entry.durationMs += duration; entry.operations++; totalMs += duration; pairs++; groups.set(key, entry);
  }
  report.phaseRoleIntervals = [...groups.values()].sort((a, b) => a.phase.localeCompare(b.phase) || a.role.localeCompare(b.role));
  if (pairs) report.phaseRoleTime = { value: totalMs / pairs, numerator: totalMs, denominator: pairs, quality: "partial", unit: "ms",
    source: "host_behavioral_receipts", limitation: "Mean of host-generated verification operation pairs only; failed/interrupted operations may have no receipt. Group sums may overlap in wall time." };
  report.sourceCoverage.hostReceipts = observations.complete ? "measured" : "partial";
  if (!observations.complete && report.coverage.quality === "measured") report.coverage.quality = "partial";
  if (!observations.complete) report.coverage.diagnostics = [...new Set([...report.coverage.diagnostics, "host_receipts_partial"])].sort();
  return WorkflowTelemetryReportSchema.parse(report);
}
