import type {
  ContractError,
  EnvironmentDoctorReport,
  Page,
  SessionManifest,
  WorkflowRunSnapshot
} from "@bflow/contracts";
import type {
  CliCommandData,
  CliCommandName,
  HighLevelCommandOutput,
  InitCommandOutput,
  SetupCommandOutput,
  PresentationOptions
} from "./types.js";
import {
  bold,
  boundMessage,
  cyan,
  dim,
  extractSafeDetails,
  formatProgressStep,
  formatSetupPreview,
  green,
  humanText,
  readableLabel,
  red,
  redactSensitive,
  resolveActionableRemediation,
  sanitizeIdentifier,
  SETUP_COMPONENT_LABELS,
  stripAnsi,
  yellow
} from "./presentation.js";
import type { EnvironmentStatus } from "./environment.js";
import { formatCodexHookSetupOutput } from "./codex-hook-setup.js";
import { renderPreview } from "@bflow/machine-setup";
import { boundReadinessReport, summarizeReadinessReport } from "./readiness-output.js";
import { formatDoctorReport } from "./doctor-output.js";
import { docsFailureRemediation } from "./docs-output.js";

export interface FormatterOptions {
  readonly color?: boolean | undefined;
  readonly stdoutColor?: boolean | undefined;
  readonly stderrColor?: boolean | undefined;
}

function resolveColor(options: FormatterOptions | PresentationOptions | undefined, stream: "stdout" | "stderr"): boolean {
  if (!options) return false;
  if ("color" in options && options.color !== undefined) return options.color;
  if (stream === "stdout" && "stdoutColor" in options && options.stdoutColor !== undefined) return Boolean(options.stdoutColor);
  if (stream === "stderr" && "stderrColor" in options && options.stderrColor !== undefined) return Boolean(options.stderrColor);
  return false;
}

function isInitOutput(data: CliCommandData): data is InitCommandOutput {
  return typeof data === "object" && data !== null && "configPath" in data && "config" in data;
}

function isConfigMigrationOutput(command: CliCommandName, data: CliCommandData): data is import("./config-migration.js").ConfigMigrationOutput {
  return command === "config-migrate" && typeof data === "object" && data !== null && "sourcePath" in data && "configPath" in data && "migrated" in data;
}

function isDocsOutput(data: CliCommandData): data is import("./docs-command.js").DocsCommandOutput {
  return typeof data === "object" && data !== null && "docs" in data && (data as { docs?: unknown }).docs === true && "action" in data;
}

function formatDocsOutput(output: import("./docs-command.js").DocsCommandOutput, useColor = false): string {
  const lines: string[] = [];
  const mark = (status: "pass" | "warn" | "fail" | "skipped") =>
    status === "pass" ? (useColor ? green(bold("[OK]"), true) : "[OK]") : status === "fail" ? "[FAIL]" : status === "warn" ? "[WARN]" : "[SKIP]";
  if (output.action === "status" && output.health) {
    const health = output.health;
    lines.push(`Context7: ${health.state}${health.enabled ? (health.required ? " (required)" : " (optional)") : ""}`);
    for (const check of health.checks) {
      lines.push(`  ${mark(check.status)} ${check.id}: ${sanitizeIdentifier(check.message)}`);
      if (check.remediation && check.status !== "pass" && check.status !== "skipped") lines.push(`        Fix: ${sanitizeIdentifier(check.remediation)}`);
    }
    lines.push(`  Provider access (from configuration): ${health.providers.map(item => `${item.provider} ${item.granted ? `yes (${item.roles.join(", ")})` : "no"}`).join("; ")}`);
    lines.push(`  Live probe: ${health.probe.mode === "none" ? `not run${health.probe.reason ? ` (${sanitizeIdentifier(health.probe.reason)})` : ""}` : `through the Gateway as ${health.probe.mode}`}`);
    return lines.join("\n");
  }
  if (output.failure) {
    const failure = output.failure;
    lines.push(`[FAIL] docs ${output.action}${failure.stage ? ` (${failure.stage})` : ""}: ${failure.kind}${failure.retryable ? " (retryable)" : ""}`);
    lines.push(`  ${sanitizeIdentifier(failure.message)}`);
    if (failure.retryAfterMs) lines.push(`  Retry after about ${Math.ceil(failure.retryAfterMs / 1000)}s.`);
    if (failure.availableVersions?.length) lines.push(`  Available versions: ${failure.availableVersions.map(sanitizeIdentifier).join(", ")}`);
    if (output.access.mode === "none" && output.access.reason) lines.push(`  Access: ${sanitizeIdentifier(output.access.reason)}`);
    for (const warning of output.warnings) lines.push(`  Warning: ${sanitizeIdentifier(warning)}`);
    lines.push(`  Next: ${docsFailureRemediation(failure)}`);
    return lines.join("\n");
  }
  if (output.search) {
    const search = output.search;
    lines.push(`Library search: ${sanitizeIdentifier(search.library)} (${search.selection})`);
    if (search.installed) lines.push(`  Project uses ${sanitizeIdentifier(search.installed.dependency)} ${sanitizeIdentifier(search.installed.version)} (${search.installed.exact ? "exact" : "lowest of range"}, from ${sanitizeIdentifier(search.installed.source)})`);
    if (search.version) lines.push(`  Documentation choice: ${search.version.versionUsed ? `${sanitizeIdentifier(search.version.libraryId)} (${search.version.match})` : `${sanitizeIdentifier(search.version.libraryId)} (no matching version)`}`);
    for (const candidate of search.candidates.slice(0, 8)) {
      const versions = candidate.versions.length ? ` versions: ${candidate.versions.slice(0, 6).map(sanitizeIdentifier).join(", ")}${candidate.versions.length > 6 ? ", ..." : ""}` : "";
      lines.push(`  - ${sanitizeIdentifier(candidate.id)}  ${sanitizeIdentifier(candidate.title)}${candidate.reputation ? `  [${sanitizeIdentifier(candidate.reputation)}]` : ""}${versions}`);
    }
    for (const warning of output.warnings) lines.push(`  Warning: ${sanitizeIdentifier(warning)}`);
    if (search.selection !== "no_match") lines.push("Next: Use 'bflow docs lookup --library-id <id> --query <question>' with a listed library ID.");
    return lines.join("\n");
  }
  if (output.lookup) {
    const lookup = output.lookup;
    lines.push(`Documentation for ${sanitizeIdentifier(lookup.libraryTitle ?? lookup.libraryId)} (${sanitizeIdentifier(lookup.libraryId)})`);
    lines.push(`  Version: requested ${lookup.requestedVersion ? sanitizeIdentifier(lookup.requestedVersion) : "none"} (${lookup.versionSource}), documentation ${lookup.versionUsed ? sanitizeIdentifier(lookup.versionUsed) : "unversioned"} (${lookup.versionMatch})`);
    lines.push("  Source: Context7 via the shared Gateway");
    for (const warning of output.warnings) lines.push(`  Warning: ${sanitizeIdentifier(warning)}`);
    // Retrieved text is untrusted: drop terminal control characters (including escape sequences) before it reaches a terminal.
    lines.push("", lookup.content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""));
    return lines.join("\n");
  }
  return JSON.stringify(output, null, 2);
}

function isSetupOutput(data: CliCommandData): data is SetupCommandOutput {
  return typeof data === "object" && data !== null && "machineId" in data && "serviceManagerKind" in data && "plan" in data;
}

function isCodexHookSetupOutput(data: CliCommandData): data is import("./codex-hook-setup.js").CodexHookSetupOutput {
  return typeof data === "object" && data !== null && "codexHooks" in data && data.codexHooks === true && "review" in data && "outcome" in data;
}

function isSnapshot(data: CliCommandData): data is WorkflowRunSnapshot {
  return typeof data === "object" && data !== null && "runId" in data && "tasks" in data && !("items" in data);
}

function isPage(data: CliCommandData): data is Page<WorkflowRunSnapshot> {
  return typeof data === "object" && data !== null && "items" in data && Array.isArray((data as Page<WorkflowRunSnapshot>).items);
}

function isHelpData(data: CliCommandData): data is { readonly helpText: string; readonly topic?: string | undefined } {
  return typeof data === "object" && data !== null && "helpText" in data;
}

function isVersionData(data: CliCommandData): data is { readonly version: string } {
  return typeof data === "object" && data !== null && "version" in data && !("runId" in data) && !("configPath" in data);
}

function isHighLevelOutput(data: CliCommandData): data is HighLevelCommandOutput {
  return (
    typeof data === "object" &&
    data !== null &&
    "schemaVersion" in data &&
    (data as any).schemaVersion === 3 &&
    "executionResult" in data &&
    "steps" in data &&
    Array.isArray((data as any).steps)
  );
}

function formatHighLevelOutput(output: HighLevelCommandOutput, useColor = false): string {
  const lines: string[] = [];

  const statusStr = output.status.toUpperCase();
  const statusPaint = output.status === "succeeded" ? green : output.status === "failed" || output.status === "unknown" ? red : yellow;
  lines.push(`${useColor ? cyan(bold("Command:"), true) : "Command:"}   ${humanText(output.command, 100)}`);
  if (output.status !== "succeeded") lines.push(`${useColor ? cyan(bold("Status:"), true) : "Status:"}    ${useColor ? statusPaint(statusStr, true) : statusStr}`);
  if (output.status === "unknown") {
    lines.push(`Command ID: ${humanText(output.commandId, 100)}`);
    lines.push(`Correlation ID: ${humanText(output.correlationId, 100)}`);
    lines.push(`Idempotency key: ${humanText(output.idempotencyKey, 4096)}`);
  }
  if (output.runId) {
    lines.push(`Run ID:    ${humanText(output.runId, 100)}`);
  }
  if (output.taskId) {
    lines.push(`Task ID:   ${humanText(output.taskId, 100)}`);
  }
  if (output.reusedReceipt) {
    lines.push(`Notice:    Reused prior successful receipt (${humanText(output.idempotencyKey, 100)})`);
  }
  if (output.resumedFromStep) {
    lines.push(`Notice:    Resumed from step '${humanText(output.resumedFromStep, 100)}'`);
  }

  const attentionSteps = output.steps?.filter(step => step.status !== "succeeded" || step.error);
  if (attentionSteps && attentionSteps.length > 0) {
    lines.push("");
    lines.push("Steps:");
    for (const [index, step] of attentionSteps.entries()) {
      const stepStatus = step.status.toUpperCase();
      const mutating = step.mutating ? " [mutating]" : "";
      const paint = step.status === "succeeded" ? green : step.status === "failed" ? red : yellow;
      lines.push(`  ${formatProgressStep(readableLabel(step.name || step.stepId), useColor, index + 1)} [${useColor ? paint(stepStatus, true) : stepStatus}]${mutating}`);
      if (step.error) {
        lines.push(`      ${useColor ? red("Error:", true) : "Error:"} [${humanText(step.error.code, 60)}] ${humanText(step.error.message, 220)}`);
      }
    }
  }

  const details = output.details;
  if (details && typeof details === "object") {
    switch (output.command) {
      case "repo inspect": {
        const repo = details.repository as any;
        const git = details.git as any;
        lines.push("");
        lines.push("Repository Summary:");
        if (repo?.root) lines.push(`  Root:    ${humanText(repo.root, 220)}`);
        if (repo?.sessionName) lines.push(`  Session: ${humanText(repo.sessionName, 100)}`);
        if (git?.branch) lines.push(`  Branch:  ${humanText(git.branch, 100)} (${git.head ? humanText(git.head, 12) : "unknown"})`);
        if (git !== undefined && "dirty" in git) lines.push(`  Dirty:   ${git.dirty ? "yes" : "clean"}`);
        break;
      }
      case "task plan": {
        const wf = (details.workflow ?? details.plan) as any;
        if (wf?.tasks && Array.isArray(wf.tasks)) {
          lines.push("");
          lines.push(`Planned Tasks (${wf.tasks.length}):`);
          for (const t of wf.tasks) {
            lines.push(`  - ${humanText(t.id ?? t.taskId, 100)}: ${humanText(t.title ?? t.name ?? "", 180)}`);
          }
        }
        break;
      }
      case "task implement": {
        const execStatus = (details.executionStatus ?? details.task) as any;
        const tdd = (details.testStrategy as any)?.tddDecision ?? (details.tddDecision as any);
        const wtPath = (details.worktree as any)?.worktreePath ?? (details.worktree as any)?.path ?? details.worktree;
        lines.push("");
        lines.push("Implementation Summary:");
        if (execStatus?.taskId ?? execStatus?.id) lines.push(`  Task:     ${humanText(execStatus?.taskId ?? execStatus?.id, 100)}`);
        if (tdd?.mode) lines.push(`  TDD Mode: ${humanText(tdd.mode, 80)}`);
        if (wtPath) lines.push(`  Worktree: ${humanText(wtPath, 220)}`);
        break;
      }
      case "verify": {
        const res = (details.result ?? details.verificationResult) as any;
        lines.push("");
        lines.push("Verification Result:");
        if (res?.status) lines.push(`  Status:    ${humanText(String(res.status).toUpperCase(), 60)}`);
        if (res?.summary) lines.push(`  Summary:   ${humanText(res.summary, 220)}`);
        if (res?.score !== undefined) lines.push(`  Score:     ${res.score}`);
        break;
      }
      case "git prepare": {
        lines.push("");
        lines.push("Git Integration Summary:");
        if (details.targetBranch) lines.push(`  Target Branch: ${humanText(details.targetBranch, 120)}`);
        if (details.conflictsDetected !== undefined) {
          lines.push(`  Conflicts:     ${details.conflictsDetected ? "YES (conflicts found)" : "none"}`);
        }
        if (Array.isArray(details.branches)) {
          lines.push(`  Branches (${details.branches.length}): ${details.branches.map((x: unknown) => humanText(x, 100)).slice(0, 10).join(", ")}`);
        }
        break;
      }
      case "mcp status": {
        lines.push("");
        const services = Array.isArray(details.services) ? details.services : [];
        const healthy = details.healthy;
        lines.push(`MCP Services (${services.length}) - Healthy: ${healthy === true ? "YES" : healthy === false ? "NO" : "UNKNOWN"}:`);
        for (const s of services) {
          const sName = s.serviceId ?? s.name ?? "unknown";
          const sStatus = String(s.status ?? (s.healthy !== undefined ? (s.healthy ? "healthy" : "unhealthy") : "unknown")).toUpperCase();
          lines.push(`  - ${humanText(sName, 100)}: ${humanText(sStatus, 60)}`);
        }
        break;
      }
      case "tool status": {
        lines.push("");
        const tools = Array.isArray(details.tools) ? details.tools : [];
        const healthy = details.healthy;
        lines.push(`Pinned Tools (${tools.length}) - Healthy: ${healthy === true ? "YES" : healthy === false ? "NO" : "UNKNOWN"}:`);
        for (const t of tools) {
          const tName = t.toolId ?? t.name ?? "unknown";
          const tStatus = String(t.status ?? (t.available !== undefined ? (t.available ? "available" : "missing") : "unknown")).toUpperCase();
          const tVer = t.version ? ` (v${t.version})` : "";
          lines.push(`  - ${humanText(tName, 100)}: ${humanText(tStatus, 60)}${humanText(tVer, 80)}`);
        }
        break;
      }
      case "skills sync": {
        lines.push("");
        lines.push("Skills Synchronization Summary:");
        if (details.mode) lines.push(`  Mode:     ${humanText(details.mode, 80)}`);
        if (details.provider) lines.push(`  Provider: ${humanText(details.provider, 80)}`);
        if (Array.isArray(details.skills)) {
          lines.push(`  Skills (${details.skills.length}): ${details.skills.slice(0, 10).map((s: any) => humanText(s.skillId ?? s.name ?? s, 100)).join(", ")}`);
        } else if (Array.isArray(details.syncedSkills)) {
          lines.push(`  Synced Skills (${details.syncedSkills.length}): ${details.syncedSkills.slice(0, 10).map((s: unknown) => humanText(s, 100)).join(", ")}`);
        }
        if (Array.isArray(details.syncedManifests)) {
          lines.push(`  Synced Manifests: ${details.syncedManifests.length}`);
        }
        if (Array.isArray(details.catalogSkills) || Array.isArray(details.catalog)) {
          const cat = (details.catalogSkills ?? details.catalog) as any[];
          lines.push(`  Catalog Skills:   ${cat.length}`);
        }
        break;
      }
      case "agent check": {
        lines.push("");
        const providers = Array.isArray(details.results)
          ? details.results
          : Array.isArray(details.providers)
          ? details.providers
          : [];
        const healthy = details.healthy;
        lines.push(`Agent Providers (${providers.length}) - Healthy: ${healthy === true ? "YES" : healthy === false ? "NO" : "UNKNOWN"}:`);
        for (const p of providers) {
          const pName = p.provider ?? p.providerId ?? p.name ?? "unknown";
          const pStatus = String(p.status ?? (p.healthy !== undefined ? (p.healthy ? "ready" : "blocked") : "unknown")).toUpperCase();
          lines.push(`  - ${humanText(pName, 100)}: ${humanText(pStatus, 60)}`);
        }
        break;
      }
    }
  }

  return lines.join("\n");
}

function isDoctorReport(data: CliCommandData): data is EnvironmentDoctorReport {
  return typeof data === "object" && data !== null && "checks" in data && Array.isArray((data as EnvironmentDoctorReport).checks);
}

function isEnvironmentStatus(data: CliCommandData): data is EnvironmentStatus {
  return typeof data === "object" && data !== null && "server" in data && "configuration" in data;
}

function isSessionManifest(data: CliCommandData): data is SessionManifest {
  return typeof data === "object" && data !== null && "panes" in data && Array.isArray((data as SessionManifest).panes) && !("server" in data);
}

function formatStatusTag(status: string, useColor: boolean): string {
  const upper = status.trim().toUpperCase();
  switch (upper) {
    // Green: confirmed success / pass / up / valid / idle / done
    case "PASSED":
    case "PASS":
    case "SUCCEEDED":
    case "UP":
    case "IDLE":
    case "DONE":
    case "VALID":
      return green(upper, useColor);

    // Yellow: warning / waiting / blocked / degraded / unknown / stale / cancelling / initializing
    case "WAITING":
    case "BLOCKED":
    case "DEGRADED":
    case "UNKNOWN":
    case "WARN":
    case "WARNING":
    case "CANCELLING":
    case "INITIALIZING":
    case "STOPPING":
      return yellow(upper, useColor);

    // Red: errors / failed / invalid
    case "FAILED":
    case "FAIL":
    case "INVALID":
      return red(upper, useColor);

    // Cyan: active steps / working / running / starting / accepted
    case "WORKING":
    case "RUNNING":
    case "STARTING":
    case "ACCEPTED":
      return cyan(upper, useColor);

    // Dim / Neutral: stopped / down / cancelled / queued / not started
    case "STOPPED":
    case "DOWN":
    case "CANCELLED":
    case "QUEUED":
    case "NOT STARTED":
      return dim(upper, useColor);

    default:
      return upper;
  }
}

function formatWorkflowRun(snapshot: WorkflowRunSnapshot, useColor = false): string {
  const lines: string[] = [];
  lines.push(`Run ID:   ${sanitizeIdentifier(snapshot.runId)}`);
  lines.push(`Workflow: ${sanitizeIdentifier(snapshot.workflowId)} (v${sanitizeIdentifier(snapshot.workflowVersion)})`);
  const statusStr = snapshot.status === "cancelling"
    ? `CANCELLING (Cancellation requested)`
    : snapshot.status.toUpperCase();
  lines.push(`Status:   ${formatStatusTag(statusStr, useColor)}`);
  lines.push("");
  lines.push("Tasks:");
  for (const t of snapshot.tasks) {
    const rawTag = `[${t.status.toUpperCase()}]`;
    const tag = useColor ? formatStatusTag(t.status, true) : rawTag;
    const cleanTaskId = sanitizeIdentifier(t.taskId);
    let taskLine = `  - ${cleanTaskId.padEnd(14)} ${useColor ? `[${tag}]` : rawTag}`;
    if (t.blockage) {
      const cleanCode = humanText(t.blockage.code, 50);
      const cleanMsg = t.blockage.message ? ` - ${humanText(t.blockage.message, 150)}` : "";
      taskLine += ` [Blockage: ${cleanCode}${cleanMsg}]`;
      taskLine += ` (generation ${t.generation}, attempt ${t.attempt})`;
    }
    lines.push(taskLine);
  }

  if (snapshot.status === "waiting" || snapshot.status === "blocked") {
    const blockingTasks = snapshot.tasks.filter((t) => t.status === "waiting" || t.status === "blocked");
    const taskNames = blockingTasks.length > 0 ? blockingTasks.map((t) => `'${sanitizeIdentifier(t.taskId)}'`).join(", ") : "a task";
    lines.push("");
    lines.push(`Notice: Run is ${snapshot.status} on ${taskNames}.`);
    // Human approval guidance ONLY when blockage.code === "awaiting_approval", never waiting alone!
    if (blockingTasks.some((t) => t.blockage?.code === "awaiting_approval")) {
      const waitTask = blockingTasks.find((t) => t.blockage?.code === "awaiting_approval") ?? blockingTasks[0];
      lines.push(`  To record human approval: bflow approve ${sanitizeIdentifier(waitTask?.taskId ?? "<task-id>")} --run ${sanitizeIdentifier(snapshot.runId)}`);
    }
    lines.push(`  To resume the run: bflow resume ${sanitizeIdentifier(snapshot.runId)}`);
  } else if (snapshot.status === "running") {
    lines.push("", `Next: bflow status ${sanitizeIdentifier(snapshot.runId)}`);
  } else if (snapshot.status === "failed") {
    lines.push("", "Next: Review the failed tasks and their evidence before requesting another attempt.");
  }

  return lines.join("\n");
}

function formatRunPage(page: Page<WorkflowRunSnapshot>, useColor = false): string {
  if (page.items.length === 0) {
    return "No workflow runs found.";
  }
  const lines: string[] = [];
  lines.push(`Found ${page.items.length} run(s):`);
  lines.push("");

  const runIdColWidth = Math.max(24, ...page.items.map((r) => sanitizeIdentifier(r.runId).length));
  const wfColWidth = Math.max(25, ...page.items.map((r) => `${sanitizeIdentifier(r.workflowId)} (v${sanitizeIdentifier(r.workflowVersion)})`.length));

  lines.push(`  ${"RUN ID".padEnd(runIdColWidth)} ${"STATUS".padEnd(12)} ${"WORKFLOW".padEnd(wfColWidth)} UPDATED`);
  lines.push(`  ${"-".repeat(runIdColWidth)} ${"-".repeat(12)} ${"-".repeat(wfColWidth)} ${"-".repeat(24)}`);
  for (const r of page.items) {
    const cleanRunId = sanitizeIdentifier(r.runId);
    const rawStatus = r.status.toUpperCase();
    const paddedStatus = rawStatus.padEnd(12);
    const statusCol = useColor
      ? formatStatusTag(rawStatus, true) + " ".repeat(Math.max(0, 12 - rawStatus.length))
      : paddedStatus;
    const cleanWf = `${sanitizeIdentifier(r.workflowId)} (v${sanitizeIdentifier(r.workflowVersion)})`;
    lines.push(
      `  ${cleanRunId.padEnd(runIdColWidth)} ${statusCol} ${cleanWf.padEnd(wfColWidth)} ${humanText(r.updatedAt, 30)}`
    );
  }
  if (page.nextCursor) {
    const cleanCursor = sanitizeIdentifier(page.nextCursor);
    lines.push("");
    lines.push(`Next page cursor: ${cleanCursor} (use --cursor ${cleanCursor})`);
  }
  return lines.join("\n");
}

function formatInitOutput(output: InitCommandOutput, useColor = false): string {
  const lines: string[] = [];
  const okMarker = useColor ? green(bold("[OK]"), true) : "[OK]";
  if (output.updated) {
    lines.push(`${okMarker} bflow repository configuration (updated) at:`);
  } else if (output.overwritten) {
    lines.push(`${okMarker} bflow repository configuration (overwritten) at:`);
  } else {
    // overwritten: false is either creation OR preservation, cannot say created
    lines.push(`${okMarker} bflow repository configuration ready at:`);
  }
  lines.push(`  ${sanitizeIdentifier(output.configPath)}`);
  lines.push("");
  lines.push(`Project Name:  ${sanitizeIdentifier(output.config.projectName)}`);
  lines.push(`Default Tasks: ${output.config.defaultWorkflow.tasks.map((t) => sanitizeIdentifier(t.id)).join(" -> ")}`);
  lines.push("");
  lines.push("Next action:");
  lines.push("  Run 'bflow up' to start the environment.");
  lines.push("  Default provider is Codex; required provider checks run before startup.");
  return lines.join("\n");
}

export function formatEnvironmentStatus(status: EnvironmentStatus, useColor = false): string {
  const lines: string[] = [];
  // This is an observation, not an authenticated readiness verdict.
  lines.push("Repository Environment Status");
  lines.push(`Repository:              ${sanitizeIdentifier(status.workspaceRoot)}`);
  lines.push(`Session:                 ${sanitizeIdentifier(status.sessionName)}`);
  lines.push(`Server:                  ${useColor ? formatStatusTag(status.server, true) : status.server}`);
  lines.push(`Configuration:           ${useColor ? formatStatusTag(status.configuration, true) : status.configuration}`);
  const obsLabel = status.liveObservation ? "live" : "persisted (may be stale)";
  lines.push(`Pane/agent observation:  ${useColor ? (status.liveObservation ? green("live", true) : yellow("persisted (may be stale)", true)) : obsLabel}`);
  const envStatus = status.manifest?.status ?? "not started";
  lines.push(`Environment:             ${useColor ? formatStatusTag(envStatus, true) : envStatus}`);
  if (status.manifest?.panes && status.manifest.panes.length > 0) {
    lines.push("");
    lines.push("Roles:");
    for (const pane of status.manifest.panes) {
      const stateStr = pane.transportState.toUpperCase();
      const cleanRole = sanitizeIdentifier(pane.role);
      const paddedRole = cleanRole.padEnd(16);
      const coloredState = useColor ? formatStatusTag(stateStr, true) : stateStr;
      lines.push(`  - ${paddedRole} [${coloredState}]`);
    }
  }
  if (status.issues.length > 0) {
    lines.push("");
    lines.push("Issues:");
    for (const issue of status.issues) {
      const cleanIssue = humanText(issue, 300);
      lines.push(`  - ${useColor ? yellow(cleanIssue, true) : cleanIssue}`);
    }
  }
  lines.push("");
  if (status.configuration === "valid" && status.server === "stopped" && (!status.manifest || status.manifest.status === "down") && !status.issues.length)
    lines.push("Next: Run 'bflow up' to start this repository environment.");
  else if (status.server === "running" && status.manifest?.status === "up" && status.liveObservation && !status.issues.length)
    lines.push("Next: Run 'bflow attach' to open Conversation.");
  else lines.push("Next: Run 'bflow doctor' to diagnose the current environment.");
  return lines.join("\n");
}

export function formatUpOutput(manifest: SessionManifest, useColor = false): string {
  const lines: string[] = [];
  const okMarker = useColor ? green(bold("[OK]"), true) : "[OK]";
  lines.push(`${okMarker} Environment ready`);
  lines.push(`Repository:  ${sanitizeIdentifier(manifest.workspaceRoot)}`);
  lines.push(`Session:     ${sanitizeIdentifier(manifest.sessionId)}`);
  lines.push(`Environment: ${useColor ? formatStatusTag(manifest.status, true) : manifest.status}`);
  lines.push("");
  lines.push("Roles:");
  for (const pane of manifest.panes) {
    const stateStr = pane.transportState.toUpperCase();
    const cleanRole = sanitizeIdentifier(pane.role);
    const coloredState = useColor ? formatStatusTag(stateStr, true) : stateStr;
    lines.push(`  - ${cleanRole.padEnd(14)} [${coloredState}]`);
  }
  lines.push("");
  lines.push("Next: run 'bflow attach' to interact with the Conversation Agent.");
  return lines.join("\n");
}

function isDownConfirmed(data: SessionManifest | EnvironmentStatus): boolean {
  if ("server" in data) {
    // For EnvironmentStatus, only an actual server==stopped observation permits claiming stopped
    return data.server === "stopped";
  }
  if ("status" in data) {
    // For SessionManifest, only status==down permits claiming stopped
    return data.status === "down";
  }
  return false;
}

export function formatDownOutput(data: SessionManifest | EnvironmentStatus, useColor = false): string {
  const lines: string[] = [];
  if (isDownConfirmed(data)) {
    const okMarker = useColor ? green(bold("[OK]"), true) : "[OK]";
    lines.push(`${okMarker} Environment stopped`);
  } else {
    const currentStatus = "server" in data ? data.server : "status" in data ? data.status : "unknown";
    const statusTag = useColor ? formatStatusTag(currentStatus, true) : currentStatus;
    lines.push(`Environment status: ${statusTag}`);
  }
  const root = "workspaceRoot" in data ? data.workspaceRoot : "";
  const session = "sessionName" in data ? data.sessionName : "sessionId" in data ? data.sessionId : "";
  if (root) lines.push(`Repository:  ${sanitizeIdentifier(root)}`);
  if (session) lines.push(`Session:     ${sanitizeIdentifier(session)}`);
  return lines.join("\n");
}

function formatSetupOutput(output: SetupCommandOutput, useColor = false): string {
  const lines: string[] = [];
  const shownDiagnostics = new Set(output.diagnostics);
  const positive = (value: string) => useColor ? green(value, true) : value;
  const warning = (value: string) => useColor ? yellow(value, true) : value;
  const heading = (value: string) => useColor ? cyan(value, true) : value;
  const concise = output.outcome === "healthy" || output.outcome === "applied";
  if (output.outcome) lines.push(`${concise ? positive("[OK]") : warning("[ATTENTION]")} Setup ${readableLabel(output.outcome)}`);
  lines.push(`${heading("Setup Mode:")}         ${readableLabel(output.mode).toUpperCase()}`);
  if (!concise) {
    lines.push(`${heading("Operating System:")}   ${sanitizeIdentifier(output.os)}`);
    lines.push(`${heading("Service Manager:")}    ${sanitizeIdentifier(output.serviceManagerKind)}`);
  }
  if (output.serviceUnitNamespace && !concise) {
    const prefix = output.serviceManagerKind === "launchd" ? "dev.bflow." : "bflow-";
    lines.push(`${heading("Service Units:")}      ${sanitizeIdentifier(`${prefix}${output.serviceUnitNamespace}-<service>`)} (isolated namespace)`);
  }
  if (output.plan) {
    if (!concise) lines.push(`${heading("Plan ID:")}            ${sanitizeIdentifier(output.plan.planId)} (revision ${output.plan.revision})`);
    lines.push(`${heading("Plan Steps:")}         ${output.plan.steps.length}`);
    const showPreview = output.preview && (output.mode === "dry_run" || output.outcome === "approval_declined");
    for (const [index, step] of (showPreview || concise ? [] : output.plan.steps).entries()) {
      const receipt = output.receipts?.find(r => r.stepId === step.stepId) ??
        (output.receipt?.stepId === step.stepId ? output.receipt : undefined);
      const approval = !receipt && step.requiresApproval ? ` ${warning("[requires approval]")}` : "";
      const status = receipt ? readableLabel(receipt.status) : "planned";
      const label = step.action === "install_tool" ? `Install ${sanitizeIdentifier(step.componentId)}`
        : SETUP_COMPONENT_LABELS[step.componentId] ?? readableLabel(step.componentId);
      const paintedStatus = receipt?.status === "applied" || receipt?.status === "already_satisfied" ? positive(status)
        : receipt?.status === "failed" ? (useColor ? red(status) : status) : warning(status);
      lines.push(`  ${formatProgressStep(label, useColor, index + 1)} [${paintedStatus}]${approval}`);
      for (const diagnostic of receipt?.diagnostics ?? []) {
        lines.push(dim(`      ${humanText(diagnostic, 250)}`, useColor));
        shownDiagnostics.add(diagnostic);
      }
    }
  }
  if (output.preview && (output.mode === "dry_run" || output.outcome === "approval_declined")) {
    // The same grouped scope is visible in a dry run and at the approval prompt.
    lines.push("", formatSetupPreview(renderPreview(output.preview), useColor));
  }
  if (output.receipt && !concise) {
    const receiptStatus = output.receipt.status === "applied" || output.receipt.status === "already_satisfied"
        ? positive(readableLabel(output.receipt.status)) : output.receipt.status === "failed"
        ? (useColor ? red(readableLabel(output.receipt.status), true) : readableLabel(output.receipt.status)) : warning(readableLabel(output.receipt.status));
    lines.push(`${heading("Receipt ID:")}         ${sanitizeIdentifier(output.receipt.receiptId)} (status: ${receiptStatus})`);
  }
  if (output.tools && output.tools.length > 0) {
    lines.push("");
    const healthyTools = output.tools.filter(tool => ["present", "installed", "ready", "healthy", "available"].includes(tool.status.toLowerCase()));
    lines.push(`Tools: ${healthyTools.length} ready${healthyTools.length < output.tools.length ? `, ${output.tools.length - healthyTools.length} need attention` : ""}`);
    for (const tool of concise ? output.tools.filter(tool => !healthyTools.includes(tool)) : output.tools) {
      const ver = tool.version ? ` (${sanitizeIdentifier(tool.version)})` : "";
      const status = ["present", "installed", "ready", "healthy", "available"].includes(tool.status.toLowerCase())
        ? positive(readableLabel(tool.status))
        : ["failed", "missing", "unavailable", "error"].includes(tool.status.toLowerCase())
          ? (useColor ? red(readableLabel(tool.status), true) : readableLabel(tool.status))
          : warning(readableLabel(tool.status));
      lines.push(`  - ${sanitizeIdentifier(tool.toolId)}: ${status}${ver}`);
    }
  }
  lines.push("");
  lines.push("Skills:");
  lines.push(`  Catalog Loaded:   ${output.skills.catalogLoaded ? "yes" : "no"}`);
  lines.push(`  Skill Count:      ${output.skills.skillCount}`);
  if (output.skills.installedSkillCount !== undefined) lines.push(`  Installed Skills: ${output.skills.installedSkillCount}`);
  if (!concise || !output.skills.catalogLoaded) lines.push(`  Store Root:       ${sanitizeIdentifier(output.skills.storeRoot)}`);

  if (output.doctor) {
    const failed = output.doctor.checks.filter(check => check.status === "failed" || check.status === "warning");
    lines.push("");
    lines.push(`Machine checks: ${output.doctor.healthy ? positive("passed") : warning("failed")}`);
    for (const check of failed) {
      lines.push(`  - ${humanText(check.summary)}`);
      if (check.remediation) lines.push(`    Next: ${humanText(check.remediation)}`);
    }
  }

  const diagnostics = [...new Set(output.diagnostics)].filter(diagnostic => !concise || diagnostic !== "Setup completed successfully");
  if (diagnostics.length > 0) {
    lines.push("");
    lines.push("Diagnostics:");
    for (const diag of diagnostics) {
      lines.push(dim(`  - ${humanText(diag, 250)}`, useColor));
    }
  }
  // Applied receipts may still carry journal-write warnings or reconciliation evidence.
  // Preserve these even when the successful step inventory is condensed.
  const receiptDiagnostics: string[] = [];
  for (const receipt of [...(output.receipts ?? []), ...(output.receipt ? [output.receipt] : [])]) {
    for (const diagnostic of receipt.diagnostics) {
      if (shownDiagnostics.has(diagnostic)) continue;
      shownDiagnostics.add(diagnostic);
      receiptDiagnostics.push(`  - ${sanitizeIdentifier(receipt.stepId)}: ${humanText(diagnostic, 250)}`);
    }
  }
  if (receiptDiagnostics.length) lines.push("", "Receipt diagnostics:", ...receiptDiagnostics);
  lines.push("");
  if (concise) lines.push("Next: Run 'bflow doctor' in your repository to check readiness.");
  else if (output.outcome === "changes_pending" || output.outcome === "approval_declined") lines.push("Next: Review 'bflow setup --plan', then run 'bflow setup --apply' when you intend to apply it.");
  else lines.push("Next: Resolve the reported blockers and run 'bflow setup --check' to inspect setup state.");
  return lines.join("\n");
}

export function formatCommandSuccess(
  command: CliCommandName,
  data: CliCommandData,
  json: boolean,
  options?: FormatterOptions | PresentationOptions | undefined
): string {
  const isJson = Boolean(json) || (options !== undefined && "json" in options && Boolean((options as PresentationOptions).json));
  if (isJson) {
    return JSON.stringify(
      {
        ok: true,
        command,
        data
      },
      null,
      2
    );
  }

  // Default to plain deterministic output if color options are omitted or false
  const useColor = resolveColor(options, "stdout");

  if (isHelpData(data)) {
    return data.helpText;
  }

  if (isVersionData(data)) {
    return data.version;
  }

  if (isInitOutput(data)) {
    return formatInitOutput(data, useColor);
  }

  if (isConfigMigrationOutput(command, data)) {
    const okMarker = useColor ? green(bold("[OK]"), true) : "[OK]";
    return [
      `${okMarker} ${data.migrated ? "Migrated" : "Already migrated"} repository configuration:`,
      `  Config: ${sanitizeIdentifier(data.configPath)}`,
      ...(data.backupPath ? [`  Backup: ${sanitizeIdentifier(data.backupPath)}`] : [])
    ].join("\n");
  }

  if (isDocsOutput(data)) {
    return formatDocsOutput(data, useColor);
  }

  if (isSetupOutput(data)) {
    return formatSetupOutput(data, useColor);
  }

  if (isCodexHookSetupOutput(data)) {
    return formatCodexHookSetupOutput(data, useColor);
  }

  if (isHighLevelOutput(data)) {
    return formatHighLevelOutput(data, useColor);
  }

  if (isDoctorReport(data)) {
    return formatDoctorReport(data, useColor);
  }

  if (command === "attach") {
    const okMarker = useColor ? green(bold("[OK]"), true) : "[OK]";
    return `${okMarker} Returned from Conversation attach.`;
  }

  if (command === "down") {
    if (isEnvironmentStatus(data) || isSessionManifest(data)) {
      return formatDownOutput(data, useColor);
    }
  }

  if (command === "up" && isSessionManifest(data)) {
    return formatUpOutput(data, useColor);
  }

  if (isEnvironmentStatus(data)) {
    return formatEnvironmentStatus(data, useColor);
  }

  if (isSessionManifest(data)) {
    return formatUpOutput(data, useColor);
  }

  if (isSnapshot(data)) {
    switch (command) {
      case "run":
        return `Started workflow run '${sanitizeIdentifier(data.runId)}':\n\n${formatWorkflowRun(data, useColor)}`;
      case "approve":
        return `Approval decision recorded for run '${sanitizeIdentifier(data.runId)}':\n\n${formatWorkflowRun(data, useColor)}`;
      case "resume":
        return `Resumed workflow run '${sanitizeIdentifier(data.runId)}':\n\n${formatWorkflowRun(data, useColor)}`;
      case "cancel":
        return `Cancellation requested for run '${sanitizeIdentifier(data.runId)}':\n\n${formatWorkflowRun(data, useColor)}`;
      case "status":
      default:
        return formatWorkflowRun(data, useColor);
    }
  }

  if (isPage(data)) {
    return formatRunPage(data, useColor);
  }

  return "Command completed. Run with --json to inspect the full result.";
}

export function formatCommandError(
  error: ContractError,
  command: CliCommandName | undefined,
  json: boolean,
  options?: FormatterOptions | PresentationOptions | undefined
): string {
  const isJson = Boolean(json) || (options !== undefined && "json" in options && Boolean((options as PresentationOptions).json));
  if (isJson) {
    return JSON.stringify(
      {
        ok: false,
        ...(command !== undefined ? { command } : {}),
        error
      },
      null,
      2
    );
  }

  // Default to plain deterministic output if color options are omitted or false
  const useColor = resolveColor(options, "stderr");

  // Clean, redact sensitive credentials, and bound untrusted messages
  const redactedMessage = redactSensitive(stripAnsi(error.message));
  // Sanitize and bound the full report before grouping shared causes for humans.
  const isReadinessReport = redactedMessage.startsWith("Provider readiness is not satisfied; no panes were started.\n");
  const report = redactedMessage.split("\n").filter(line => !/^\s+at\s+/.test(line));
  const boundedMessage = isReadinessReport
    ? boundReadinessReport(report.join("\n"))
    : boundMessage(redactedMessage);
  const summary = isReadinessReport ? summarizeReadinessReport(boundedMessage) : undefined;
  const cleanMessage = summary === undefined ? boundedMessage : boundReadinessReport(summary);

  const errorTag = useColor ? red(bold(`Error [${error.code}]:`), true) : `Error [${error.code}]:`;
  let out = `${errorTag} ${cleanMessage}`;

  // Safe details only: show validated scalar fields stage/role/provider/pane/session
  const safe = extractSafeDetails(error.details);
  if (safe !== null) {
    let detailsStr = Object.entries(safe)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    if (detailsStr.length > 500) {
      detailsStr = detailsStr.slice(0, 500).trimEnd() + "... [truncated]";
    }
    const detailsTag = useColor ? dim(`Details: ${detailsStr}`) : `Details: ${detailsStr}`;
    out += `\n${detailsTag}`;
  }

  // Next: specific useful supported action
  const remediation = resolveActionableRemediation(error, command);
  const nextTag = useColor ? cyan(bold("Next:")) : "Next:";
  out += `\n${nextTag} ${remediation}`;

  return out;
}
