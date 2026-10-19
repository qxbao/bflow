import type { CliCommandName } from "../types.js";
import type { HighLevelCommandName, HighLevelEnvelope, HighLevelOutput } from "./envelope.js";
import { bold, cyan, dim, extractSafeDetails, fieldLabel, formatProgressStep, formatTargetPaths, green, humanLine, humanText,
  readableLabel, red, resolveActionableRemediation, sanitizeIdentifier, statusTag, yellow } from "../presentation.js";

function summaryLines(command: HighLevelCommandName, value: unknown, useColor: boolean): string[] {
  const data = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const lines: string[] = [];
  // Keep literal spaces in copyable filesystem paths; only flatten line breaks/tabs.
  const text = (v: unknown, n = 180) => humanText(v, n).replace(/[\n\t]/g, " ");
  const add = (label: string, value: unknown, max = 180) => {
    if (value === undefined || value === null || typeof value === "object") return;
    lines.push(`  ${label}: ${typeof value === "boolean" ? (value ? "yes" : "no") : text(value, max) || "(empty)"}`);
  };
  const list = (label: string, items: unknown, render: (item: unknown) => string) => {
    if (!Array.isArray(items)) return;
    if (items.length === 0) { lines.push(`  ${label}: none`); return; }
    lines.push(`  ${label}:`);
    for (const item of items.slice(0, 10)) lines.push(`    - ${humanText(render(item), 450)}`);
    if (items.length > 10) lines.push(`    … ${items.length - 10} more`);
  };
  const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const records = (label: string, items: unknown, name: (v: Record<string, unknown>) => unknown,
    details: (v: Record<string, unknown>) => Record<string, unknown>) => {
    if (!Array.isArray(items)) return;
    lines.push(`  ${label} (${items.length}):`);
    if (!items.length) lines.push("    None configured.");
    for (const item of items.slice(0, 20)) {
      const record = object(item);
      lines.push(`    - ${text(name(record), 120)} ${statusTag(record.status ?? record.state, useColor)}`);
      for (const [key, value] of Object.entries(details(record))) {
        if (value === null || value === undefined || value === "") continue;
        if (Array.isArray(value)) {
          for (const entry of value.slice(0, 10)) lines.push(`        ${key}: ${text(entry, 300)}`);
          if (value.length > 10) lines.push(`        … ${value.length - 10} more; use --json for details`);
        } else lines.push(`        ${key}: ${text(value, 300)}`);
      }
    }
    if (items.length > 20) lines.push(`    … ${items.length - 20} more; use --json for details`);
  };
  switch (command) {
    case "repo.inspect": {
      const repo = object(data.repository), git = object(data.git), project = object(data.project);
      add("Root", repo.root); add("Branch", git.branch ?? (git.detached === true ? "detached HEAD" : undefined)); add("HEAD", typeof git.head === "string" ? git.head.slice(0, 12) : undefined);
      add("Working tree", typeof git.dirty === "boolean" ? (git.dirty ? "has changes" : "clean") : undefined);
      add("Commits", git.hasCommits === false ? "none yet" : undefined);
      add("Git operation", git.inProgressOperation);
      add("Changed files", git.changeCount);
      list("Changes", git.changes, value => { const change = object(value); return `${text(change.status, 10)} ${text(change.path, 300)}`; });
      add("Project markers", Array.isArray(project.markers) ? project.markers.join(", ") : undefined);
      add("Package manager", project.packageManager);
      add("Workspace packages", Array.isArray(project.workspacePackages) ? project.workspacePackages.length : undefined);
      break;
    }
    case "task.plan": {
      const graph = object(data.graph), trace = object(data.traceability);
      add("Specification", data.specId); add("Traceability", typeof trace.valid === "boolean" ? (trace.valid ? "valid" : "incomplete") : undefined);
      add("Tasks", Array.isArray(graph.tasks) ? graph.tasks.length : graph.taskCount);
      add("Plan file", data.path); add("Written", data.written); add("Preview", data.written === false ? "no files changed" : undefined);
      list("Task graph", graph.tasks, item => {
        const task = object(item);
        const id = text(task.id ?? task.taskId ?? "task", 100);
        const deps = Array.isArray(task.dependsOn) ? task.dependsOn.map(x => text(x, 80)).join(", ") || "none" : "none";
        return `${id} (depends on: ${deps})`;
      });
      list("Unmapped criteria", trace.orphanCriterionIds, x => text(x, 100));
      list("Unmapped workflow tasks", trace.unmappedWorkflowTaskIds, x => text(x, 100));
      list("Unknown task mappings", trace.unknownMappedTaskIds, x => text(x, 100));
      list("Unknown criteria", trace.unknownCriterionIds, x => text(x, 100));
      const mappings = object(trace.criterionToTasks);
      list("Criterion mappings", Object.entries(mappings), entry => {
        const [criterion, tasks] = entry as [string, unknown];
        return `${text(criterion, 100)} → ${Array.isArray(tasks) ? tasks.map(x => text(x, 80)).join(", ") || "unmapped" : "unmapped"}`;
      });
      break;
    }
    case "task.implement": {
      const assignment = object(data.assignment), strategy = object(data.testStrategy), decision = object(strategy.tddDecision ?? data.tddDecision);
      add("Task", data.taskKey ?? data.taskId); add("Worktree", data.worktreePath); add("Branch", data.branchName);
      if (Object.keys(assignment).length) {
        add("TDD", object(assignment.tdd).mode ?? object(assignment.tdd).classification ?? decision.mode ?? decision.classification);
        add("Assignment", readableLabel(assignment.status ?? "awaiting_runtime_dispatch"));
        lines.push("  Next: Runtime/Coordinator must issue the leased assignment; this command does not dispatch an agent");
      } else add("TDD", decision.mode ?? decision.classification);
      break;
    }
    case "verify": {
      const verification = object(data.verification);
      const findings = Array.isArray(verification.findings) ? verification.findings : [];
      add("Verification", verification.status);
      const counts: Record<string, number> = {};
      for (const finding of findings) { const severity = String(object(finding).severity ?? "unspecified"); counts[severity] = (counts[severity] ?? 0) + 1; }
      if (findings.length) add("Findings", Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", "));
      list("Findings", findings, item => {
        const f = object(item);
        return `${text(f.severity ?? "finding", 40)}: ${text(f.message ?? f.title ?? f.check ?? "No message", 220)}`;
      });
      const cycle = object(data.cycle);
      if (Object.keys(cycle).length) add("Verification cycle", `${readableLabel(cycle.status ?? "unknown")}, iteration ${cycle.iteration ?? "?"}/${cycle.maxIterations ?? "?"}`);
      break;
    }
    case "git.prepare": {
      const integration = object(data.integration), verification = object(data.workflowVerification);
      add("Integration", integration.status ?? integration.outcome); add("Branch", integration.branchName);
      add("Head", integration.headCommitHash); add("Workflow verification", verification.required === true ? "requested through Runtime" : verification.required === false ? "not requested" : undefined);
      const conflict = object(integration.conflict);
      if (Object.keys(conflict).length) add("Conflict", `${conflict.taskKey ?? "task"}: ${Array.isArray(conflict.paths) ? conflict.paths.map(x => text(x, 100)).join(", ") : "review integration record"}`);
      const preview = object(data.preview);
      if (Object.keys(preview).length) {
        add("Integration ID", preview.integrationId); add("Base revision", preview.baseRevision);
        add("Target", preview.mergesInto);
        list("Integration tasks", preview.tasks, item => {
          const task = object(item);
          const deps = Array.isArray(task.dependsOn) ? task.dependsOn.map(x => text(x, 80)).join(", ") || "none" : "none";
          return `${text(task.taskKey ?? task.taskId ?? "task", 100)} (depends on: ${deps})`;
        });
        list("Task readiness", data.tasks, item => {
          const task = object(item);
          return `${text(task.taskId ?? task.taskKey ?? "task", 100)}: ${text(task.status ?? "unknown", 60)}; branch ${text(task.branchName ?? "unknown", 100)}; head ${text(task.headCommitHash ?? "unknown", 16)}; ${task.clean === true ? "clean" : task.clean === false ? "has changes" : "cleanliness unknown"}; ${task.ready === true ? "ready" : "not ready"}`;
        });
        lines.push("  Next: Review the preview, then rerun with --yes to collect submissions and prepare integration");
      } else add("Publication", "No push or protected-branch merge was performed");
      break;
    }
    case "agent.check": {
      add("Provider", data.provider); add("Role", data.role); add("Stage", data.stage); add("Readiness", data.status);
      records("Checks", data.checks, c => readableLabel(c.check ?? c.name ?? "check"),
        c => ({ Reason: c.message, Next: c.remediation }));
      add("Note", data.note); break;
    }
    case "mcp.status": {
      const gateway = object(data.gateway), config = object(data.config);
      add("Gateway", gateway.reachable === true ? "reachable" : gateway.reachable === false ? `unavailable${gateway.reason ? `: ${text(gateway.reason)}` : ""}` : "unknown");
      add("Config", `${config.state ?? "unknown"}${config.path ? ` (${text(config.path)})` : ""}`);
      add("Config issue", config.reason);
      records("Backends", data.backends, b => b.serviceId ?? b.id ?? "backend",
        b => ({ Local: b.local, Gateway: b.gateway, Reason: b.reason }));
      break;
    }
    case "tool.status": {
      add("Platform", object(data.platform).os); add("Blocking tools", Array.isArray(data.blocking) ? data.blocking.join(", ") || "none" : undefined);
      records("Tools", data.tools, t => t.toolId, t => ({ Version: t.version, Required: t.required === true ? "yes" : "optional",
        Requirement: t.requirement, Path: t.path, Diagnostics: t.diagnostics, Next: t.remediation }));
      break;
    }
    case "skills.sync": {
      add("Providers", Array.isArray(data.providers) ? data.providers.join(", ") : data.provider);
      add("Targets", Array.isArray(data.targets) ? data.targets.length : undefined);
      add("Machine-wide targets", data.machineWide);
      add("Manifest digest", data.digest);
      add("Changed paths", Array.isArray(data.ownedPaths) ? data.ownedPaths.length : undefined);
      list("Providers", data.providers, x => text(x, 100));
      if (Array.isArray(data.targets)) {
        lines.push("  Target locations:", ...formatTargetPaths(data.targets.filter((x): x is string => typeof x === "string"), "    ", { skillBundles: true }));
      }
      list("Diagnostics", data.diagnostics, x => text(x, 180));
      break;
    }
  }
  return lines;
}

function commandForRemediation(command: HighLevelCommandName): CliCommandName {
  switch (command) {
    case "repo.inspect": return "repo inspect";
    case "task.plan": return "task plan";
    case "task.implement": return "task implement";
    case "verify": return "verify";
    case "git.prepare": return "git prepare";
    case "mcp.status": return "mcp status";
    case "tool.status": return "tool status";
    case "skills.sync": return "skills sync";
    case "agent.check": return "agent check";
  }
}

export function formatHighLevelHuman(envelope: HighLevelEnvelope, useColor = false): string {
  const output = envelope.result.output as HighLevelOutput;
  const dataRecord = output.data !== null && typeof output.data === "object" && !Array.isArray(output.data)
    ? output.data as Record<string, unknown> : {};
  const heading = `bflow ${envelope.command.replace(".", " ")}`;
  const waiting = output.outcome === "approval_required" || output.outcome === "reconciliation_required" || envelope.result.status === "waiting_user" || envelope.result.status === "unknown";
  const failed = !waiting && (!envelope.ok || ["failed", "not_passed", "not_ready", "conflict_detected"].includes(output.outcome));
  const marker = waiting ? "[WAIT]" : failed ? "[FAIL]" : "[OK]";
  const markerColor = waiting ? yellow : failed ? red : green;
  const title = `${heading}: ${readableLabel(output.outcome)} ${marker}`;
  const lines = [useColor ? markerColor(bold(title), true) : title,
    `  Command status: ${statusTag(envelope.result.status, useColor)}`,
    `  Exit code: ${envelope.exitCode}`];
  const ids = { commandId: envelope.result.commandId, correlationId: envelope.result.correlationId, ...output.ids };
  for (const [key, value] of Object.entries(ids)) {
    if (value) lines.push(dim(`  ${fieldLabel(key)}: ${sanitizeIdentifier(value)}`, useColor));
  }
  if (output.replayed) lines.push("  Notice: Replayed receipt; no work repeated.");
  if (output.steps.length > 0) {
    lines.push("  Steps:");
    for (const [index, step] of output.steps.slice(0, 20).entries()) {
      lines.push(`    ${formatProgressStep(readableLabel(step.id), useColor, index + 1)} ${statusTag(step.status, useColor)}`);
      if (step.message) lines.push(dim(`        ${humanText(step.message, 220)}`, useColor));
    }
    if (output.steps.length > 20) lines.push(`    … ${output.steps.length - 20} more steps`);
  }
  lines.push(...summaryLines(envelope.command, output.data, useColor));
  if (envelope.result.error) {
    const error = envelope.result.error;
    lines.push(`${useColor ? red(bold(`Error [${error.code}]:`), true) : `Error [${error.code}]:`} ${humanText(error.message, 350)}`);
    if (error.details !== undefined) {
      const details = extractSafeDetails(error.details);
      if (details) for (const [key, value] of Object.entries(details)) lines.push(`  ${fieldLabel(key)}: ${humanLine(value, 240)}`);
    }
    const reason = extractSafeDetails(error.details)?.reason;
    const next = reason === "file_not_found" ? "Check the input path and pass an existing file; use --help to review the required arguments."
      : reason === "invalid_json" || reason === "invalid_workflow" || reason === "invalid_plan" ? "Fix the input JSON to match the documented schema, then rerun the command."
      : reason === "permission_required" ? "Review the requested scope and provide the explicit approval flag only when authorized."
      : reason === "interrupted" || error.code === "unknown_delivery" ? "Inspect the existing receipt, then rerun the same invocation with --resume where supported; preserve the original arguments and idempotency key."
      : reason === "busy" ? "Wait for the active invocation to finish, then retry with the same request."
      : resolveActionableRemediation(error, commandForRemediation(envelope.command));
    lines.push(`  ${useColor ? cyan("Next:", true) : "Next:"} ${humanText(next, 240)}`);
  } else {
    const next = output.outcome === "approval_required"
      ? envelope.command === "skills.sync" ? (dataRecord.machineWide === true
        ? "Review the listed targets, then rerun with --allow-machine-scope to authorize machine-wide writes."
        : "Review the listed targets and request the explicit approval required for this synchronization.")
        : "Review the preview and provide the command's explicit approval flag when authorized."
      : output.outcome === "not_passed" ? "Review each finding and its evidence, address blockers, then rerun verification."
      : output.outcome === "not_ready" ? "Resolve the reported readiness findings and rerun the check."
      : output.outcome === "conflict_detected" ? "Inspect the integration conflict and resolve it before requesting workflow verification."
      : undefined;
    if (next) lines.push(`  ${useColor ? cyan("Next:", true) : "Next:"} ${humanText(next, 240)}`);
  }
  return lines.join("\n");
}
