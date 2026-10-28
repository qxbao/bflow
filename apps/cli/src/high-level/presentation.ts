import type { CliCommandName } from "../types.js";
import type { HighLevelCommandName, HighLevelEnvelope, HighLevelOutput } from "./envelope.js";
import { bold, cyan, dim, extractSafeDetails, fieldLabel, formatProgressStep, formatTargetPaths, green, humanText,
  readableLabel, red, resolveActionableRemediation, statusTag, yellow } from "../presentation.js";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
// Redact complete values before bounding or joining them. Keep literal spaces in paths and IDs.
const text = (value: unknown, max = 300) => humanText(value, max).replace(/[\n\t]/g, " ");
const healthy = (record: Record<string, unknown>) => record.healthy !== false &&
  ["healthy", "present", "passed", "ready"].includes(String(record.status ?? record.state));
const supportsResume = (command: HighLevelCommandName) => ["task.implement", "git.prepare", "skills.sync"].includes(command);

function reconciliationNext(command: HighLevelCommandName): string {
  return "Inspect and reconcile the existing receipt before repeating any work; preserve the original arguments and idempotency key."
    + (supportsResume(command) ? " Use --resume to reconcile that invocation." : " Use --json to inspect the full receipt; obtain operator guidance if its state remains uncertain.");
}

function closedVerificationCycle(data: Record<string, unknown>): boolean {
  const cycle = object(data.cycle);
  const iteration = cycle.iteration ?? cycle.currentIteration;
  return cycle.status === "escalated" || cycle.status === "aborted" ||
    (typeof iteration === "number" && typeof cycle.maxIterations === "number" && iteration >= cycle.maxIterations);
}

function verificationNext(data: Record<string, unknown>): string {
  const verification = object(data.verification), cycle = object(data.cycle);
  if (closedVerificationCycle(data))
    return "Review the evidence with the Coordinator and human operator; this verification cycle is closed or its iteration limit is exhausted. A human decision is required before further work.";
  if (verification.status === "blocked")
    return "Resolve the reported runner, gate or prerequisite blockers with the Coordinator; review the evidence before requesting further verification.";
  if (verification.status === "inconclusive")
    return "Review missing or inconclusive evidence and runner diagnostics with the Coordinator before requesting further verification.";
  if (cycle.status === "rework_required")
    return "Review failed criteria and evidence with the Coordinator, prepare the required repair record, then request the next permitted verification iteration.";
  return "Review failed criteria, evidence and the cycle state with the Coordinator before requesting further verification.";
}

function mcpNext(data: Record<string, unknown>): string {
  const config = object(data.config), gateway = object(data.gateway);
  const backends = Array.isArray(data.backends) ? data.backends.map(object) : [];
  const actions: string[] = [];
  if (config.state === "invalid") actions.push("Review the reported config file and repair it against the approved schema/setup plan");
  if (config.state === "absent" || gateway.configured === false) actions.push("Review bflow setup --plan for the missing configuration");
  if (gateway.reachable !== true) actions.push("Diagnose the shared Gateway connection and its setup/doctor report");
  if (backends.some(backend => backend.state === "invalid")) actions.push("Check executable pin integrity against the approved setup plan before restoring the pinned binary");
  if (backends.some(backend => !healthy(backend) && backend.state !== "invalid")) actions.push("Inspect the reported backend diagnostics and Gateway health before checking readiness again");
  return actions.length ? `${actions.join(". ")}.` : "Inspect the full MCP report with --json and diagnose the reported readiness state.";
}

function summaryLines(command: HighLevelCommandName, value: unknown, useColor: boolean): string[] {
  const data = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const lines: string[] = [];
  // Keep literal spaces in copyable filesystem paths; only flatten line breaks/tabs.
  const add = (label: string, value: unknown, max = 180) => {
    if (value === undefined || value === null || typeof value === "object") return;
    lines.push(`  ${label}: ${typeof value === "boolean" ? (value ? "yes" : "no") : text(value, max) || "(empty)"}`);
  };
  const list = (label: string, items: unknown, render: (item: unknown) => string, limit = 10) => {
    if (!Array.isArray(items)) return;
    if (items.length === 0) { lines.push(`  ${label}: none`); return; }
    lines.push(`  ${label}:`);
    for (const item of items.slice(0, limit)) lines.push(`    - ${text(render(item), 1200)}`);
    if (items.length > limit) lines.push(`    … ${items.length - limit} more; use --json for the full report`);
  };
  const records = (label: string, items: unknown, name: (v: Record<string, unknown>) => unknown,
    details: (v: Record<string, unknown>) => Record<string, unknown>) => {
    if (!Array.isArray(items)) return;
    const all = items.map(object);
    const findings = all.filter(record => !healthy(record));
    const healthyCount = all.length - findings.length;
    lines.push(`  ${label} (${items.length}):${healthyCount ? ` ${healthyCount} healthy${findings.length ? `; ${findings.length} need attention` : ""}` : ""}`);
    if (!items.length) lines.push("    None configured.");
    // Unhealthy/unknown entries and their diagnostics never compete with healthy entries for a display cap.
    for (const record of findings) {
      lines.push(`    - ${text(name(record), 120)} ${statusTag(record.status ?? record.state, useColor)}`);
      for (const [key, value] of Object.entries(details(record))) {
        if (value === null || value === undefined || value === "") continue;
        if (Array.isArray(value)) {
          for (const entry of value) lines.push(`        ${key}: ${text(entry, 300)}`);
        } else lines.push(`        ${key}: ${text(value, key === "Path" ? 1024 : 350)}`);
      }
    }
  };
  switch (command) {
    case "task.preview": {
      const plan = data.plan as Record<string, unknown> | undefined;
      if (!plan) break;
      lines.push(`  Mode: ${text(plan.mode)}`, `  Fingerprint: ${text(plan.fingerprint)}`);
      const pack = object(plan.pack), policy = object(plan.policy), accepted = object(plan.accepted);
      lines.push(`  Pack: ${text(pack.id ?? pack.status)}${pack.version ? ` v${text(pack.version)}` : ""}`);
      if (accepted.runId) {
        lines.push(`  Specification: ${text(accepted.specificationId)} v${text(accepted.specificationVersion)}`,
          `  Workflow: ${text(accepted.workflowId)} v${text(accepted.workflowVersion)}`);
        for (const task of Array.isArray(accepted.tasks) ? accepted.tasks : []) {
          const row = object(task);
          lines.push(`  Task ${text(row.id)} (${text(row.role)}), depends on: ${text(JSON.stringify(row.dependsOn))}${row.requiresApproval === true ? "; human approval required" : ""}`);
        }
      } else lines.push("  Accepted specification/DAG: unresolved; analysis and clarification come first.");
      lines.push(`  Gates: ${text(JSON.stringify(policy.gates), 2000)}`,
        `  Conditional TDD: ${text(policy.tdd)}`,
        `  Alternative verification: ${text(JSON.stringify(policy.alternativeVerification), 2000)}`);
      for (const item of Array.isArray(policy.explanations) ? policy.explanations : []) {
        const explanation = object(item), source = object(explanation.source);
        lines.push(`  Why ${text(explanation.field)}: ${text(explanation.reasonCode)} (${text(source.kind)}: ${text(source.locator)})`);
      }
      for (const item of Array.isArray(plan.decisions) ? plan.decisions : []) {
        const decision = item as Record<string, unknown>;
        const source = decision.source as Record<string, unknown>;
        lines.push(`  ${text(decision.field)}: ${text(JSON.stringify(decision.effective), 1000)} (${text(source?.kind)}: ${text(source?.locator)})`);
      }
      for (const item of Array.isArray(plan.observations) ? plan.observations : []) {
        const observation = object(item), source = object(observation.source);
        lines.push(`  Readiness: ${text(observation.id)}: ${text(observation.status)} / ${text(observation.outcome ?? "unknown")} (${text(source.locator)})`);
      }
      for (const item of Array.isArray(plan.blockers) ? plan.blockers : []) {
        const blocker = object(item), source = object(blocker.source);
        lines.push(`  Blocked: ${text(blocker.code)} (${text(source.kind)}: ${text(source.locator)})`);
      }
      if (data.diff) lines.push(`  Drift: ${text(JSON.stringify(data.diff), 4000)}`);
      for (const item of Array.isArray(plan.unknowns) ? plan.unknowns : []) lines.push(`  Unknown: ${text(item)}`);
      for (const item of Array.isArray(plan.approvalPoints) ? plan.approvalPoints : []) lines.push(`  Approval point: ${text(item)}`);
      lines.push("  Preview does not establish readiness, approval, reservation or task success.");
      break;
    }
    case "repo.inspect": {
      const repo = object(data.repository), git = object(data.git), project = object(data.project);
      add("Root", repo.root, 1024); add("Branch", git.branch ?? (git.detached === true ? "detached HEAD" : undefined)); add("HEAD", typeof git.head === "string" ? git.head.slice(0, 12) : undefined);
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
      add("Plan file", data.path, 1024); add("Written", data.written); add("Preview", data.written === false ? "no files changed" : undefined);
      list("Task graph", graph.tasks, item => {
        const task = object(item);
        const id = text(task.id ?? task.taskId ?? "task", 100);
        const deps = Array.isArray(task.dependsOn) ? task.dependsOn.map(x => text(x, 80)).join(", ") || "none" : "none";
        return `${id} (depends on: ${deps})`;
      });
      list("Unmapped criteria", trace.orphanCriterionIds, x => text(x, 100), Infinity);
      list("Unmapped workflow tasks", trace.unmappedWorkflowTaskIds, x => text(x, 100), Infinity);
      list("Unknown task mappings", trace.unknownMappedTaskIds, x => text(x, 100), Infinity);
      list("Unknown criteria", trace.unknownCriterionIds, x => text(x, 100), Infinity);
      const mappings = object(trace.criterionToTasks);
      list("Criterion mappings", Object.entries(mappings), entry => {
        const [criterion, tasks] = entry as [string, unknown];
        return `${text(criterion, 100)} → ${Array.isArray(tasks) ? tasks.map(x => text(x, 80)).join(", ") || "unmapped" : "unmapped"}`;
      });
      break;
    }
    case "task.implement": {
      const assignment = object(data.assignment), strategy = object(data.testStrategy), decision = object(strategy.tddDecision ?? data.tddDecision);
      add("Task", data.taskKey ?? data.taskId); add("Worktree", data.worktreePath, 1024); add("Branch", data.branchName);
      if (Object.keys(assignment).length) {
        add("TDD", object(assignment.tdd).mode ?? object(assignment.tdd).classification ?? decision.mode ?? decision.classification);
        add("Assignment", readableLabel(assignment.status ?? "awaiting_runtime_dispatch"));
        lines.push("  Dispatch: Runtime/Coordinator must issue the leased assignment; this command does not dispatch an agent");
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
      const evidence = Array.isArray(verification.evidenceArtifacts) ? verification.evidenceArtifacts.map(object) : [];
      const evidenceRef = (id: unknown) => {
        const artifact = evidence.find(artifact => artifact.artifactId === id);
        return text(artifact?.uri ?? id, 1000);
      };
      const criteria = Array.isArray(verification.evaluatedCriteria) ? verification.evaluatedCriteria.map(object).filter(criterion => criterion.passed !== true) : [];
      if (criteria.length) list("Failed criteria", criteria, item => {
        const criterion = object(item);
        return `${text(criterion.criterionId, 150)}: ${text(criterion.summary, 300)}`;
      }, Infinity);
      for (const criterion of criteria) {
        if (criterion.evidenceArtifactId) lines.push(`    Evidence (${text(criterion.criterionId, 150)}): ${evidenceRef(criterion.evidenceArtifactId)}`);
      }
      // Put errors and warnings first, while retaining every finding and its reference.
      const priority = (item: unknown) => object(item).severity === "error" ? 0 : object(item).severity === "warning" ? 1 : 2;
      if (findings.length) lines.push("  Findings:");
      for (const item of [...findings].sort((a, b) => priority(a) - priority(b))) {
        const f = object(item);
        lines.push(`    - ${text(f.severity ?? "finding", 40)}${f.code ? ` [${text(f.code, 120)}]` : ""}: ${text(f.message ?? f.title ?? f.check ?? "No message", 350)}`);
        if (f.location) lines.push(`        Location: ${text(f.location, 1024)}`);
        if (f.artifactId) lines.push(`        Evidence: ${evidenceRef(f.artifactId)}`);
      }
      const cycle = object(data.cycle);
      if (Object.keys(cycle).length) add("Verification cycle", `${readableLabel(cycle.status ?? "unknown")}, iteration ${cycle.iteration ?? cycle.currentIteration ?? "?"}/${cycle.maxIterations ?? "?"}`);
      const escalation = object(cycle.escalation);
      add("Escalation", escalation.reason); add("Approval request", escalation.approvalRequestId);
      if (Array.isArray(data.pendingMessages)) for (const message of data.pendingMessages) {
        if (object(message).type !== "verification.escalation") continue;
        const payload = object(object(message).payload);
        add("Escalation", payload.reason, 350); add("Escalation target", payload.target); add("Approval request", payload.approvalRequestId);
      }
      break;
    }
    case "git.prepare": {
      const integration = object(data.integration), verification = object(data.workflowVerification);
      add("Integration", integration.status ?? integration.outcome); add("Branch", integration.branchName);
      add("Worktree", integration.worktreePath, 1024);
      add("Head", integration.headCommitHash); add("Workflow verification", verification.required === true ? "requested through Runtime" : verification.required === false ? "not requested" : undefined);
      const conflict = object(integration.conflict);
      if (Object.keys(conflict).length) {
        add("Conflict", conflict.taskKey ?? "review integration record");
        list("Conflicting paths", conflict.paths, path => text(path, 1024), Infinity);
      }
      const preview = object(data.preview);
      if (Object.keys(preview).length) {
        add("Integration ID", preview.integrationId); add("Base revision", preview.baseRevision);
        add("Target", preview.mergesInto);
        list("Integration tasks", preview.tasks, item => {
          const task = object(item);
          const deps = Array.isArray(task.dependsOn) ? task.dependsOn.map(x => text(x, 80)).join(", ") || "none" : "none";
          return `${text(task.taskKey ?? task.taskId ?? "task", 100)} (depends on: ${deps})`;
        });
        const tasks = Array.isArray(data.tasks) ? [...data.tasks].sort((a, b) => Number(object(a).ready === true) - Number(object(b).ready === true)) : data.tasks;
        list("Task readiness", tasks, item => {
          const task = object(item);
          return `${text(task.taskId ?? task.taskKey ?? "task", 100)}: ${text(task.status ?? "unknown", 60)}; branch ${text(task.branchName ?? "unknown", 100)}; head ${text(task.headCommitHash ?? "unknown", 16)}; ${task.clean === true ? "clean" : task.clean === false ? "has changes" : "cleanliness unknown"}; ${task.ready === true ? "ready" : "not ready"}`;
        }, Infinity);
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
      add("Config", config.state ?? "unknown"); add("Config path", config.path, 1024);
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
      add("Changed paths", Array.isArray(data.ownedPaths) ? data.ownedPaths.length : undefined);
      list("Providers", data.providers, x => text(x, 100));
      if (Array.isArray(data.targets)) {
        lines.push("  Target locations:", ...formatTargetPaths(data.targets.filter((x): x is string => typeof x === "string"), "    ", { skillBundles: true }));
      }
      list("Diagnostics", data.diagnostics, x => text(x, 350), Infinity);
      break;
    }
    case "skills.scan":
    case "skills.import":
    case "skills.approve":
    case "skills.disable":
    case "skills.revoke":
    case "skills.status": {
      const inventory = data.inventory !== null && typeof data.inventory === "object" ? data.inventory as Record<string, unknown> : undefined;
      if (inventory && Array.isArray(inventory.items))
        records("Sources", inventory.items, item => item.itemId, item => ({ Kind: (item.origin as Record<string, unknown> | undefined)?.kind,
          Status: item.status, Path: (item.origin as Record<string, unknown> | undefined)?.path,
          Warnings: Array.isArray(item.warnings) ? item.warnings.map(w => `${(w as Record<string, unknown>).code}`).join(", ") : undefined }));
      if (Array.isArray(data.skills))
        records("Skills", data.skills, item => item.skillId, item => ({ Version: item.version, Digest: item.digest, Pin: item.pin,
          Installed: item.installed, Bound: item.bound, Staged: item.stagedPath,
          Approvals: Array.isArray(item.approvals) ? item.approvals.map(a => { const v = a as Record<string, unknown>; return `${v.role}/${v.provider}: ${v.approval}`; }) : undefined }));
      add("Skill", data.skillId);
      add("Version", data.version);
      add("Digest", data.digest);
      add("Approval receipt", data.approvalReceiptId);
      add("Expires", data.expiresAt);
      list("Roles", data.roles, x => text(x, 100));
      list("Providers", data.providers, x => text(x, 100));
      list("Blocked sources", data.blocked, x => text(JSON.stringify(x), 350), Infinity);
      list("Pending imports", data.pendingImports, x => text(JSON.stringify(x), 350), Infinity);
      add("Next", data.next);
      break;
    }
  }
  return lines;
}

function commandForRemediation(command: HighLevelCommandName): CliCommandName {
  switch (command) {
    case "repo.inspect": return "repo inspect";
    case "task.preview": return "task preview";
    case "task.plan": return "task plan";
    case "task.implement": return "task implement";
    case "verify": return "verify";
    case "git.prepare": return "git prepare";
    case "mcp.status": return "mcp status";
    case "tool.status": return "tool status";
    case "skills.sync":
    case "skills.scan":
    case "skills.import":
    case "skills.approve":
    case "skills.disable":
    case "skills.revoke":
    case "skills.status": return "skills sync";
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
  const lines = [useColor ? markerColor(bold(title), true) : title];
  const ids = { runId: output.ids.runId, taskId: output.ids.taskId,
    ...((waiting || failed || output.replayed || dataRecord.reconciled === true) ? { idempotencyKey: output.ids.idempotencyKey } : {}) };
  for (const [key, value] of Object.entries(ids)) {
    if (value) lines.push(dim(`  ${fieldLabel(key)}: ${text(value, 1024)}`, useColor));
  }
  if (output.replayed) lines.push("  Notice: Replayed receipt; no work repeated.");
  if (dataRecord.reconciled === true) lines.push("  Notice: Existing state reconciled; no work repeated.");
  lines.push(...summaryLines(envelope.command, output.data, useColor));
  const importantSteps = output.steps.filter(step => !["succeeded", "reused"].includes(step.status)
    && !(envelope.command === "skills.sync" && ["already_synced", "preview"].includes(output.outcome) && step.id === "sync" && step.status === "skipped"));
  if (importantSteps.length) {
    lines.push("  Steps needing attention:");
    for (const [index, step] of importantSteps.entries()) {
      lines.push(`    ${formatProgressStep(text(readableLabel(step.id), 150), useColor, index + 1)} ${statusTag(step.status, useColor)}`);
      if (step.message) lines.push(dim(`        ${text(step.message, 350)}`, useColor));
    }
  }
  if (envelope.result.error) {
    const error = envelope.result.error;
    lines.push(`${useColor ? red(bold(`Error [${error.code}]:`), true) : `Error [${error.code}]:`} ${humanText(error.message, 350)}`);
    if (error.details !== undefined) {
      const details = extractSafeDetails(error.details);
      if (details) for (const [key, value] of Object.entries(details)) lines.push(`  ${fieldLabel(key)}: ${text(value, 350)}`);
    }
    const reason = extractSafeDetails(error.details)?.reason;
    const next = output.outcome === "reconciliation_required" || error.code === "unknown_delivery" || reason === "interrupted" ? reconciliationNext(envelope.command)
      : envelope.command === "verify" && closedVerificationCycle(dataRecord) ? verificationNext(dataRecord)
      : reason === "file_not_found" ? "Check the input path and pass an existing file; use --help to review the required arguments."
      : reason === "invalid_json" || reason === "invalid_workflow" || reason === "invalid_plan" ? "Fix the input JSON to match the documented schema, then rerun the command."
      : reason === "permission_required" ? "Review the requested scope and provide the explicit approval flag only when authorized."
      : reason === "busy" ? "Wait for the active invocation to finish, then retry with the same request."
      : resolveActionableRemediation(error, commandForRemediation(envelope.command));
    lines.push(`  ${useColor ? cyan("Next:", true) : "Next:"} ${text(next, 1000)}`);
  } else {
    const next = output.outcome === "reconciliation_required" ? reconciliationNext(envelope.command)
      : output.outcome === "approval_required"
      ? envelope.command === "skills.sync" ? (dataRecord.machineWide === true
        ? "Review the listed targets, then rerun with --allow-machine-scope to authorize machine-wide writes."
        : "Review the listed targets and request the explicit approval required for this synchronization.")
        : envelope.command === "git.prepare" ? "Review the preview and task readiness, resolve blockers, then use --yes to authorize collecting submissions and preparing integration."
          : "Review the preview and provide the command's explicit approval flag when authorized."
      : output.outcome === "not_passed" && envelope.command === "verify" ? verificationNext(dataRecord)
      : output.outcome === "not_passed" ? "Review each finding and its evidence with the Coordinator before requesting further verification."
      : output.outcome === "not_ready" ? envelope.command === "mcp.status" ? mcpNext(dataRecord) : "Resolve the reported readiness findings and rerun the check."
      : output.outcome === "conflict_detected" ? "Inspect the integration conflict and resolve it before requesting workflow verification."
      : undefined;
    if (next) lines.push(`  ${useColor ? cyan("Next:", true) : "Next:"} ${text(next, 1000)}`);
  }
  if (failed || waiting || output.replayed || dataRecord.reconciled === true || importantSteps.length > 0 ||
    ["tool.status", "mcp.status", "agent.check", "verify"].includes(envelope.command))
    lines.push("  Use --json for the full command report.");
  return lines.join("\n");
}
