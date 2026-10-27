import { formatTelemetryReport } from "./telemetry.js";
import { CancellationReconciliationReportSchema } from "@bflow/runtime";
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
  blue,
  bold,
  boundMessage,
  cyan,
  dim,
  extractSafeDetails,
  formatProgressStep,
  formatSetupPreview,
  green,
  greenTick,
  humanText,
  magenta,
  readableLabel,
  red,
  redactSensitive,
  resolveActionableRemediation,
  sanitizeIdentifier,
  SETUP_COMPONENT_LABELS,
  statusTag,
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
  readonly debug?: boolean | undefined;
  readonly presentation?: PresentationOptions | undefined;
}

function resolveColor(options: FormatterOptions | PresentationOptions | undefined, stream: "stdout" | "stderr"): boolean {
  if (!options) return false;
  if ("color" in options && options.color !== undefined) return options.color;
  if (stream === "stdout" && "stdoutColor" in options && options.stdoutColor !== undefined) return Boolean(options.stdoutColor);
  if (stream === "stderr" && "stderrColor" in options && options.stderrColor !== undefined) return Boolean(options.stderrColor);
  if ("presentation" in options && options.presentation) {
    if (stream === "stdout" && options.presentation.stdoutColor !== undefined) return Boolean(options.presentation.stdoutColor);
    if (stream === "stderr" && options.presentation.stderrColor !== undefined) return Boolean(options.presentation.stderrColor);
  }
  return false;
}

function resolveDebug(options: FormatterOptions | PresentationOptions | undefined): boolean {
  if (!options) return false;
  if ("debug" in options && options.debug !== undefined) return Boolean(options.debug);
  if ("presentation" in options && options.presentation?.debug !== undefined) return Boolean(options.presentation.debug);
  return false;
}

function isInitOutput(data: CliCommandData): data is InitCommandOutput {
  return typeof data === "object" && data !== null && "configPath" in data && ("config" in data || (data as { mode?: unknown }).mode === "remove");
}

function isConfigMigrationOutput(command: CliCommandName, data: CliCommandData): data is import("./config-migration.js").ConfigMigrationOutput {
  return command === "config-migrate" && typeof data === "object" && data !== null && "sourcePath" in data && ("configPath" in data || "targetPath" in data) && "migrated" in data;
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

function formatWorkflowRun(snapshot: WorkflowRunSnapshot, useColor = false, debug = false): string {
  const lines: string[] = [];
  const statusStr = snapshot.status === "cancelling"
    ? "CANCELLING (Đang hủy)"
    : snapshot.status.toUpperCase();
  lines.push(
    `${useColor ? cyan(bold("✦ Luồng chạy:"), true) : "✦ Luồng chạy:"} ${sanitizeIdentifier(snapshot.runId)} (${sanitizeIdentifier(snapshot.workflowId)}) — ${formatStatusTag(statusStr, useColor)}${snapshot.status === "succeeded" ? ` ${greenTick(useColor)}` : ""}`
  );

  if (debug) {
    lines.push(`Phiên bản:       v${sanitizeIdentifier(snapshot.workflowVersion ?? snapshot.version)} (bản ghi v${sanitizeIdentifier(snapshot.version)})`);
    if (snapshot.createdAt) lines.push(`Tạo lúc:         ${sanitizeIdentifier(snapshot.createdAt)}`);
    if (snapshot.updatedAt) lines.push(`Cập nhật lúc:    ${sanitizeIdentifier(snapshot.updatedAt)}`);
    if ((snapshot as any).lastActivityAt) lines.push(`Hoạt động cuối:  ${sanitizeIdentifier((snapshot as any).lastActivityAt)}`);
    if ((snapshot as any).recovery) {
      const rec = (snapshot as any).recovery;
      lines.push(`Khôi phục:       ${humanText(typeof rec === "string" ? rec : JSON.stringify(rec), 200)}`);
    }
  }

  const roleStyle = (role: string) => (useColor ? magenta(`[${role}]`, true) : `[${role}]`);
  lines.push("");
  lines.push(useColor ? blue(bold(`Tác vụ (${snapshot.tasks.length}):`), true) : `Tác vụ (${snapshot.tasks.length}):`);
  for (const t of snapshot.tasks) {
    const rawTag = `[${t.status.toUpperCase()}]`;
    const tag = useColor ? `[${formatStatusTag(t.status, true)}]` : rawTag;
    const cleanTaskId = sanitizeIdentifier(t.taskId);
    const paddedId = cleanTaskId.padEnd(14);
    const roleRaw = (t as any).role ?? (t.agentExecution as any)?.role ?? (t as any).agentId;
    const rolePart = roleRaw ? ` ${roleStyle(sanitizeIdentifier(roleRaw))}` : "";
    const isTaskCompleted = t.status === "succeeded" || (t.status as string) === "done" || (t.status as string) === "passed";
    let taskLine = `  • ${paddedId}${rolePart}  ${tag}${isTaskCompleted ? ` ${greenTick(useColor)}` : ""}`;
    if (t.blockage) {
      const cleanCode = humanText(t.blockage.code, 50);
      const cleanMsg = t.blockage.message ? ` - ${humanText(t.blockage.message, 150)}` : "";
      taskLine += ` [Chặn: ${cleanCode}${cleanMsg}]`;
      if (debug) taskLine += ` (thế hệ ${t.generation}, lần thử ${t.attempt})`;
    } else if (Array.isArray((t as any).blockingReasons) && (t as any).blockingReasons.length > 0) {
      taskLine += ` [Chặn: ${(t as any).blockingReasons.map((r: unknown) => humanText(r, 80)).join(", ")}]`;
    }
    if (debug) {
      const attempts = (t as any).attempts ?? t.attempt ?? 0;
      const debugParts: string[] = [`lần thử=${attempts}`];
      if ((t as any).lease) debugParts.push(`lease=${sanitizeIdentifier(typeof (t as any).lease === "string" ? (t as any).lease : (t as any).lease.leaseId ?? "active")}`);
      if ((t as any).gate) debugParts.push(`gate=${sanitizeIdentifier(typeof (t as any).gate === "string" ? (t as any).gate : (t as any).gate.status ?? "checked")}`);
      taskLine += ` (${debugParts.join(", ")})`;
    }
    lines.push(taskLine);
  }

  if (snapshot.status === "waiting" || snapshot.status === "blocked") {
    const approvalTasks = snapshot.tasks.filter(
      (t) =>
        t.blockage?.code === "awaiting_approval" ||
        (t.status === "waiting" && !t.blockage)
    );
    const blockedTasks = snapshot.tasks.filter(
      (t) => t.status === "waiting" || t.status === "blocked"
    );
    lines.push("");
    // Human approval guidance ONLY when blockage.code === "awaiting_approval" (or waiting without non-approval blockage)
    if (approvalTasks.length > 0 && snapshot.tasks.some((t) => t.blockage?.code === "awaiting_approval" || !t.blockage)) {
      const waitingTaskIds = approvalTasks.map((t) => sanitizeIdentifier(t.taskId));
      const firstWaiting = waitingTaskIds[0] ?? "<task-id>";
      lines.push(
        `⏳ Đang chờ phê duyệt tại '${waitingTaskIds.join(", ")}'. Chạy: bflow approve ${firstWaiting} --run ${sanitizeIdentifier(snapshot.runId)} --by <tên-bạn>`
      );
      lines.push(`  Để tiếp tục luồng chạy: bflow resume ${sanitizeIdentifier(snapshot.runId)}`);
    } else {
      const blockedTaskIds = blockedTasks.map((t) => sanitizeIdentifier(t.taskId));
      lines.push(
        `⚠ Luồng chạy đang bị chặn${blockedTaskIds.length > 0 ? ` tại: ${blockedTaskIds.join(", ")}` : ""}. Chạy: bflow resume ${sanitizeIdentifier(snapshot.runId)}`
      );
    }
  } else if (snapshot.status === "running") {
    lines.push("", `${useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:"} bflow status ${sanitizeIdentifier(snapshot.runId)}`);
  } else if (snapshot.status === "failed") {
    const failedTaskIds = snapshot.tasks
      .filter((t) => t.status === "failed")
      .map((t) => sanitizeIdentifier(t.taskId));
    lines.push(
      "",
      `✗ Luồng chạy thất bại${failedTaskIds.length > 0 ? ` tại: ${failedTaskIds.join(", ")}` : ""}. Chạy: bflow resume ${sanitizeIdentifier(snapshot.runId)}`
    );
  }

  return lines.join("\n");
}

function formatRunPage(page: Page<WorkflowRunSnapshot>, useColor = false, debug = false): string {
  if (page.items.length === 0) {
    return "ℹ Chưa có luồng chạy (workflow run) nào.";
  }
  const lines: string[] = [];
  lines.push(
    useColor
      ? cyan(bold(`✦ Danh sách luồng chạy (${page.items.length}):`), true)
      : `✦ Danh sách luồng chạy (${page.items.length}):`
  );
  lines.push("");

  const runIdColWidth = Math.max(24, ...page.items.map((r) => sanitizeIdentifier(r.runId).length));
  const wfColWidth = Math.max(20, ...page.items.map((r) => sanitizeIdentifier(r.workflowId).length));

  for (const r of page.items) {
    const cleanRunId = sanitizeIdentifier(r.runId).padEnd(runIdColWidth);
    const rawStatus = r.status.toUpperCase();
    const paddedStatus = rawStatus.padEnd(12);
    const statusCol = useColor
      ? formatStatusTag(rawStatus, true) + " ".repeat(Math.max(0, 12 - rawStatus.length))
      : paddedStatus;
    const cleanWf = sanitizeIdentifier(r.workflowId).padEnd(wfColWidth);
    const tasks = Array.isArray(r.tasks) ? r.tasks : [];
    const doneTasks = tasks.filter(
      (t) => t.status === "succeeded" || (t.status as string) === "done" || (t.status as string) === "passed"
    ).length;
    const tick = r.status === "succeeded" ? ` ${greenTick(useColor)}` : "";
    const debugSuffix = debug
      ? `  v${sanitizeIdentifier(r.workflowVersion ?? r.version)}  cập nhật=${humanText(r.updatedAt, 30)}`
      : "";
    lines.push(
      `  • ${cleanRunId}  ${statusCol}  ${cleanWf}  (${doneTasks}/${tasks.length} tác vụ hoàn thành)${tick}${debugSuffix}`
    );
  }
  if (page.nextCursor) {
    const cleanCursor = sanitizeIdentifier(page.nextCursor);
    lines.push("");
    lines.push(
      `${useColor ? cyan(bold("👉 Trang tiếp:"), true) : "👉 Trang tiếp:"} bflow status --cursor ${cleanCursor}`
    );
  }
  return lines.join("\n");
}

/**
 * Summarizes the provider `cli` of each environment role: `claude` when all roles share one provider,
 * `claude ×2, agy ×6` (first-appearance order) when mixed, and undefined when no role declares one.
 */
function summarizeRoleProviders(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null || !("environment" in config)) return undefined;
  const environment = config.environment;
  if (typeof environment !== "object" || environment === null || !("roles" in environment) || !Array.isArray(environment.roles)) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const role of environment.roles as unknown[]) {
    if (typeof role !== "object" || role === null || !("cli" in role) || typeof role.cli !== "string") continue;
    counts.set(role.cli, (counts.get(role.cli) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  if (counts.size === 1) return counts.keys().next().value;
  return [...counts].map(([provider, count]) => `${provider} ×${count}`).join(", ");
}

function formatInitOutput(output: InitCommandOutput, useColor = false, debug = false): string {
  const lines: string[] = [];
  const projName = output.config?.projectName
    ? ` (${sanitizeIdentifier(output.config.projectName)})`
    : "";

  if (output.mode === "remove" || output.gitnexus?.status === "removed") {
    lines.push(
      `${statusTag("removed", useColor)} Đã gỡ cấu hình GitNexus khỏi kho mã nguồn${projName} ${greenTick(useColor)}`
    );
    lines.push(`Tệp cấu hình: ${sanitizeIdentifier(output.configPath)}`);
    if (output.gitnexus?.serviceId) {
      lines.push(
        `GitNexus:     ${sanitizeIdentifier(output.gitnexus.serviceId)} (${sanitizeIdentifier(output.gitnexus.status)})`
      );
    }
    if (debug && output.diagnostics && output.diagnostics.length > 0) {
      lines.push("", "Chẩn đoán:");
      for (const diag of output.diagnostics) {
        lines.push(`  - ${humanText(diag, 250)}`);
      }
    }
    lines.push("");
    lines.push(
      `${useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:"} Chạy 'bflow init' để tạo lại chỉ mục GitNexus.`
    );
    return lines.join("\n");
  }

  if (output.mode === "check" || Boolean((output as any).checkOnly)) {
    const gnStatus = output.gitnexus?.status ?? (output.healthy ? "ready" : "attention");
    const isHealthy = output.healthy ?? gnStatus === "ready";
    lines.push(
      `${statusTag(isHealthy ? "ready" : gnStatus, useColor)} Kiểm tra khởi tạo kho mã nguồn Bflow${projName}${
        isHealthy ? ` ${greenTick(useColor)}` : ""
      }`
    );
    lines.push(
      `Tệp cấu hình: ${sanitizeIdentifier(output.configPath)}${
        output.configValid !== undefined
          ? ` (${output.configValid ? "hợp lệ" : "thiếu/không hợp lệ"})`
          : ""
      }`
    );
    if (output.gitnexus) {
      lines.push(
        `GitNexus:     ${sanitizeIdentifier(output.gitnexus.status)}${
          output.gitnexus.serviceId ? ` (dịch vụ: ${sanitizeIdentifier(output.gitnexus.serviceId)})` : ""
        }${output.gitnexus.status === "ready" ? ` ${greenTick(useColor)}` : ""}`
      );
    }
    if ((!isHealthy || debug) && output.diagnostics && output.diagnostics.length > 0) {
      lines.push("", "Chẩn đoán:");
      for (const diag of output.diagnostics) {
        lines.push(`  - ${humanText(diag, 250)}`);
      }
    }
    lines.push("");
    lines.push(
      `${useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:"} ${
        isHealthy
          ? "Chạy 'bflow up' để khởi động môi trường."
          : "Chạy 'bflow init' để hoàn tất khởi tạo kho mã nguồn."
      }`
    );
    return lines.join("\n");
  }

  const action = output.updated
    ? "Đã cập nhật"
    : output.overwritten
    ? "Đã ghi đè"
    : (output as any).created === false
    ? "Giữ nguyên"
    : "Đã khởi tạo";
  const header = `[HOÀN TẤT] ${action} cấu hình kho mã nguồn bflow`;
  lines.push(`${useColor ? green(bold(header), true) : header} ${greenTick(useColor)}`);

  if (output.config) {
    const providers = summarizeRoleProviders(output.config);
    lines.push(
      `Dự án:        ${sanitizeIdentifier(output.config.projectName)}${
        providers ? ` (${sanitizeIdentifier(providers)})` : ""
      }`
    );
  }
  lines.push(`Tệp cấu hình: ${sanitizeIdentifier(output.configPath)}`);
  if (output.gitnexus) {
    lines.push(
      `GitNexus:     ${sanitizeIdentifier(output.gitnexus.status)}${
        output.gitnexus.status === "ready" ? ` ${greenTick(useColor)}` : ""
      }`
    );
  }

  if (debug) {
    if (output.config?.defaultWorkflow) {
      const wf = output.config.defaultWorkflow;
      lines.push(`Quy trình mặc định: ${sanitizeIdentifier(wf.id)} (v${sanitizeIdentifier(wf.version)})`);
      lines.push(`Tác vụ mặc định (${wf.tasks.length}):`);
      for (const t of wf.tasks) {
        const rolePart = (t as any).role ? ` [${sanitizeIdentifier((t as any).role)}]` : "";
        lines.push(`  • ${sanitizeIdentifier(t.id)}${rolePart} ${greenTick(useColor)}`);
      }
    }
    if (output.diagnostics && output.diagnostics.length > 0) {
      lines.push("", "Chẩn đoán:");
      for (const diag of output.diagnostics) {
        lines.push(`  - ${humanText(diag, 250)}`);
      }
    }
  } else if (
    output.gitnexus &&
    output.gitnexus.status !== "ready" &&
    output.diagnostics &&
    output.diagnostics.length > 0
  ) {
    lines.push("", "Chẩn đoán:");
    for (const diag of output.diagnostics) {
      lines.push(`  - ${humanText(diag, 250)}`);
    }
  }

  lines.push("");
  lines.push(
    `${useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:"} Chạy 'bflow up' để khởi động môi trường (hoặc 'bflow run "<yêu cầu>"').`
  );
  return lines.join("\n");
}

export function formatEnvironmentStatus(status: EnvironmentStatus, useColor = false, debug = false): string {
  const lines: string[] = [];
  // This is an observation, not an authenticated readiness verdict.
  const projectLabel = sanitizeIdentifier(
    (status as any).projectName ||
      status.manifest?.projectName ||
      status.sessionName ||
      status.workspaceRoot
  );
  const envStatus =
    (status as any).status ??
    status.manifest?.status ??
    (status.server === "stopped" ? "stopped" : "not started");
  const isFullyUp =
    envStatus === "up" &&
    status.server === "running" &&
    status.liveObservation !== false &&
    (!status.issues || status.issues.length === 0);

  lines.push(
    `${useColor ? cyan(bold("✦ Trạng thái môi trường:"), true) : "✦ Trạng thái môi trường:"} ${projectLabel} — ${formatStatusTag(envStatus, useColor)}${
      isFullyUp ? ` ${greenTick(useColor)}` : ""
    }`
  );
  lines.push(
    `Máy chủ Herdr: ${formatStatusTag(status.server ?? "unknown", useColor)}  •  Cấu hình: ${formatStatusTag(status.configuration ?? "valid", useColor)}`
  );

  if (status.liveObservation === false) {
    const staleText = "dữ liệu lưu trữ - persisted (may be stale)";
    lines.push(`Quan sát:      ${useColor ? yellow(staleText, true) : staleText}`);
  } else if (debug) {
    lines.push(`Quan sát:      ${useColor ? green("trực tiếp (live)", true) : "trực tiếp (live)"}`);
  }

  if (debug) {
    if (status.workspaceRoot) lines.push(`Kho mã nguồn:  ${sanitizeIdentifier(status.workspaceRoot)}`);
    if (status.sessionName) lines.push(`Phiên:         ${sanitizeIdentifier(status.sessionName)}`);
  }

  const roles: any[] = Array.isArray((status as any).roles)
    ? (status as any).roles
    : status.manifest?.panes ?? [];
  if (roles.length > 0) {
    const readyRoles = roles.filter((p) =>
      ["idle", "done", "working", "accepted", "ready"].includes(
        String(p.transportState ?? p.status ?? "").toLowerCase()
      )
    );
    lines.push(
      `Vai trò (${roles.length}): ${readyRoles.length}/${roles.length} sẵn sàng${
        readyRoles.length === roles.length && isFullyUp ? ` ${greenTick(useColor)}` : ""
      }`
    );
    const rolesToShow = debug ? roles : roles.filter((p) => !readyRoles.includes(p));
    for (const pane of rolesToShow) {
      const isRoleReady = readyRoles.includes(pane);
      const stateStr = String(pane.transportState ?? pane.status ?? "unknown").toUpperCase();
      const cleanRole = sanitizeIdentifier(pane.role);
      const paddedRole = cleanRole.padEnd(16);
      const coloredState = useColor ? formatStatusTag(stateStr, true) : stateStr;
      const debugInfo =
        debug && pane.paneId
          ? ` (pane ${sanitizeIdentifier(pane.paneId)}${
              pane.agentKind ? `, ${sanitizeIdentifier(pane.agentKind)}/${sanitizeIdentifier(pane.provider ?? "")}` : ""
            })`
          : "";
      lines.push(
        `  - ${paddedRole} [${coloredState}]${debugInfo}${debug && isRoleReady ? ` ${greenTick(useColor)}` : ""}`
      );
    }
  }

  if (status.issues && status.issues.length > 0) {
    lines.push("");
    lines.push("Vấn đề phát hiện:");
    for (const issue of status.issues) {
      const cleanIssue = humanText(issue, 300);
      lines.push(`  - ${useColor ? yellow(cleanIssue, true) : cleanIssue}`);
    }
  }

  lines.push("");
  const nextLabel = useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:";
  if (
    status.configuration === "valid" &&
    status.server === "stopped" &&
    (!status.manifest || status.manifest.status === "down") &&
    (!status.issues || status.issues.length === 0)
  ) {
    lines.push(`${nextLabel} Chạy 'bflow up' để khởi động môi trường.`);
  } else if (isFullyUp) {
    lines.push(`${nextLabel} Chạy 'bflow attach' để làm việc với Conversation.`);
  } else {
    lines.push(`${nextLabel} Chạy 'bflow doctor' để chẩn đoán môi trường hiện tại.`);
  }
  return lines.join("\n");
}

export function formatUpOutput(manifest: SessionManifest, useColor = false, debug = false): string {
  const lines: string[] = [];
  const header = "[SẴN SÀNG] Môi trường đã khởi động";
  const projectLabel = sanitizeIdentifier(manifest.projectName || manifest.workspaceRoot);
  lines.push(
    `${useColor ? green(bold(header), true) : header}${projectLabel ? ` (${projectLabel})` : ""} ${greenTick(useColor)}`
  );
  lines.push(`Phiên:    ${sanitizeIdentifier(manifest.sessionId)}`);

  const panes = Array.isArray(manifest.panes) ? manifest.panes : [];
  const readyPanes = panes.filter((p) =>
    ["idle", "done", "working", "accepted", "ready"].includes(String(p.transportState).toLowerCase())
  );
  lines.push(
    `Vai trò:  ${readyPanes.length}/${panes.length} sẵn sàng${
      readyPanes.length === panes.length && panes.length > 0 ? ` ${greenTick(useColor)}` : ""
    }`
  );

  if (debug) {
    if (manifest.workspaceRoot) lines.push(`Thư mục gốc:     ${sanitizeIdentifier(manifest.workspaceRoot)}`);
    if (manifest.herdrWorkspaceId) lines.push(`Herdr Workspace: ${sanitizeIdentifier(manifest.herdrWorkspaceId)}`);
    if (manifest.herdrTabId) lines.push(`Herdr Tab:       ${sanitizeIdentifier(manifest.herdrTabId)}`);
    if (manifest.attachTarget?.paneId) {
      lines.push(
        `Khung chat:      pane ${sanitizeIdentifier(manifest.attachTarget.paneId)} (${sanitizeIdentifier(manifest.attachTarget.role)})`
      );
    }
    for (const p of panes) {
      const isRoleReady = readyPanes.includes(p);
      const stateStr = String(p.transportState).toUpperCase();
      const coloredState = useColor ? formatStatusTag(stateStr, true) : stateStr;
      lines.push(
        `  - ${sanitizeIdentifier(p.role)}: ${coloredState} (pane ${sanitizeIdentifier(p.paneId)}, ${sanitizeIdentifier(p.agentKind)}/${sanitizeIdentifier(p.provider)})${
          isRoleReady ? ` ${greenTick(useColor)}` : ""
        }`
      );
    }
    if (manifest.metadata?.["readiness"]) {
      lines.push(`Sẵn sàng (Readiness): ${humanText(manifest.metadata["readiness"], 200)}`);
    }
    if (manifest.metadata?.["notes"]) {
      lines.push(`Ghi chú:         ${humanText(manifest.metadata["notes"], 200)}`);
    }
  } else {
    for (const p of panes.filter((pane) => !readyPanes.includes(pane))) {
      const stateStr = String(p.transportState).toUpperCase();
      const coloredState = useColor ? formatStatusTag(stateStr, true) : stateStr;
      lines.push(`  - ${sanitizeIdentifier(p.role)}: ${coloredState} (pane ${sanitizeIdentifier(p.paneId)})`);
    }
  }

  lines.push("");
  lines.push(
    `${useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:"} Chạy 'bflow attach' để mở khung chat Conversation.`
  );
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

export function formatDownOutput(
  data: SessionManifest | EnvironmentStatus,
  useColor = false,
  debug = false
): string {
  const lines: string[] = [];
  const currentStatus =
    "server" in data ? data.server : "status" in data ? data.status : "unknown";

  if (isDownConfirmed(data)) {
    const alreadyStopped = Boolean(
      (data as any).alreadyStopped || (data as any).metadata?.alreadyStopped
    );
    const title = alreadyStopped
      ? "[HOÀN TẤT] Môi trường đã dừng sẵn"
      : "[HOÀN TẤT] Đã dừng môi trường";
    const projectLabel = sanitizeIdentifier(
      (data as any).projectName ||
        (data as any).sessionName ||
        (data as any).workspaceRoot ||
        (data as any).sessionId
    );
    lines.push(
      `${useColor ? green(bold(title), true) : title}${projectLabel ? ` (${projectLabel})` : ""} ${greenTick(useColor)}`
    );
    lines.push(`Trạng thái: ${formatStatusTag(currentStatus, useColor)}`);
  } else {
    const statusTagStr = useColor ? formatStatusTag(currentStatus, true) : currentStatus;
    lines.push(`Trạng thái môi trường: ${statusTagStr}`);
  }

  if (debug) {
    const root = "workspaceRoot" in data ? data.workspaceRoot : "";
    const session =
      "sessionName" in data
        ? data.sessionName
        : "sessionId" in data
        ? data.sessionId
        : "";
    if (root) lines.push(`Kho mã nguồn: ${sanitizeIdentifier(root)}`);
    if (session) lines.push(`Phiên:        ${sanitizeIdentifier(session)}`);
    if ("stoppedAt" in data && data.stoppedAt) {
      lines.push(`Dừng lúc:     ${sanitizeIdentifier(data.stoppedAt)}`);
    }
    if (Array.isArray((data as any).stoppedServices) && (data as any).stoppedServices.length > 0) {
      lines.push(
        `Tác vụ nền đã dừng: ${(data as any).stoppedServices.map(sanitizeIdentifier).join(", ")}`
      );
    }
    if ((data as any).metadata?.notes) {
      lines.push(`Ghi chú:      ${humanText((data as any).metadata.notes, 200)}`);
    }
  }

  lines.push(
    `${useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:"} Chạy 'bflow up' khi cần khởi động lại môi trường.`
  );
  return lines.join("\n");
}

function formatAttachOutput(data: CliCommandData, useColor = false, debug = false): string {
  const lines: string[] = [];
  const attached = (data as any)?.attached !== false;
  const paneId = sanitizeIdentifier(
    (data as any)?.paneId ?? (data as any)?.attachTarget?.paneId ?? "conversation"
  );
  const sessionId = sanitizeIdentifier(
    (data as any)?.sessionId ?? (data as any)?.sessionName ?? ""
  );
  const projectName = sanitizeIdentifier(
    (data as any)?.projectName ?? (data as any)?.workspaceRoot ?? ""
  );
  const role = sanitizeIdentifier(
    (data as any)?.role ?? (data as any)?.attachTarget?.role ?? "conversation"
  );

  if (attached) {
    const title = "[HOÀN TẤT] Đã rời khung chat Conversation.";
    lines.push(`${useColor ? green(bold(title), true) : title} ${greenTick(useColor)}`);
  } else {
    lines.push(
      `ℹ Khung chat Conversation sẵn sàng tại pane ${paneId}${sessionId ? ` (phiên ${sessionId})` : ""}.`
    );
  }

  if (debug) {
    if (projectName) lines.push(`Dự án:   ${projectName}`);
    if (sessionId) lines.push(`Phiên:   ${sessionId}`);
    if (role) lines.push(`Vai trò: ${role}`);
    if (paneId) lines.push(`Pane:    ${paneId}`);
  }

  lines.push(
    `${useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:"} ${
      attached
        ? "Chạy 'bflow attach' để kết nối lại hoặc 'bflow status' để xem tiến độ."
        : "Chạy 'bflow attach' trong terminal tương tác."
    }`
  );
  return lines.join("\n");
}

function formatRecoverOutput(data: CliCommandData, useColor = false, debug = false): string {
  const lines: string[] = [];
  const sessionId = sanitizeIdentifier(
    (data as any)?.sessionId ??
      (data as any)?.sessionName ??
      (data as any)?.manifest?.sessionId ??
      ""
  );
  const statusVal = sanitizeIdentifier(
    (data as any)?.status ??
      (data as any)?.manifest?.status ??
      (data as any)?.server ??
      "recovered"
  );
  const roles: any[] = Array.isArray((data as any)?.roles)
    ? (data as any).roles
    : Array.isArray((data as any)?.panes)
    ? (data as any).panes
    : Array.isArray((data as any)?.manifest?.panes)
    ? (data as any).manifest.panes
    : [];
  const readyRoles = roles.filter((r) =>
    ["idle", "done", "working", "accepted", "ready", "reused", "recreated"].includes(
      String(r.transportState ?? r.status ?? r.action ?? "").toLowerCase()
    ) && r.action !== "failed"
  );
  const issues: string[] = Array.isArray((data as any)?.issues) ? (data as any).issues : [];
  const isHealthy =
    ["up", "healthy", "running", "stopped", "recovered"].includes(statusVal.toLowerCase()) &&
    issues.length === 0 &&
    (roles.length === 0 || readyRoles.length === roles.length);

  const headerTag = isHealthy
    ? useColor
      ? green(bold("[HOÀN TẤT]"), true)
      : "[HOÀN TẤT]"
    : useColor
    ? yellow(bold("[CHÚ Ý]"), true)
    : "[CHÚ Ý]";
  lines.push(
    `${headerTag} Đã khôi phục phiên${sessionId ? ` ${sessionId}` : ""} (${statusVal})${
      isHealthy ? ` ${greenTick(useColor)}` : ""
    }`
  );

  if (roles.length > 0) {
    lines.push(
      `Vai trò: ${readyRoles.length}/${roles.length} sẵn sàng${
        readyRoles.length === roles.length ? ` ${greenTick(useColor)}` : ""
      }`
    );
    const rolesToShow = debug
      ? roles
      : roles.filter(
          (r) =>
            r.action === "failed" ||
            r.action === "recreated" ||
            !readyRoles.includes(r)
        );
    for (const r of rolesToShow) {
      const isRoleReady = readyRoles.includes(r);
      const roleName = sanitizeIdentifier(r.role);
      const actionStr = r.action ? `${sanitizeIdentifier(r.action)}: ` : "";
      const stateStr = sanitizeIdentifier(r.transportState ?? r.status ?? "unknown");
      const panePart = r.paneId ? ` (pane ${sanitizeIdentifier(r.paneId)})` : "";
      lines.push(
        `  - ${roleName}: ${actionStr}${stateStr}${panePart}${
          isRoleReady ? ` ${greenTick(useColor)}` : ""
        }`
      );
    }
  }

  if (debug && (data as any)?.notes) {
    lines.push(`Ghi chú: ${humanText((data as any).notes, 250)}`);
  }

  if (issues.length > 0) {
    lines.push("Vấn đề:");
    for (const issue of issues) {
      lines.push(`  - ${humanText(issue, 250)}`);
    }
  }

  lines.push(
    `${useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:"} ${
      isHealthy
        ? "Chạy 'bflow attach' để tiếp tục công việc."
        : "Chạy 'bflow doctor' để kiểm tra các thành phần chưa sẵn sàng."
    }`
  );
  return lines.join("\n");
}

function formatSetupOutput(output: SetupCommandOutput, useColor = false, debug = false): string {
  const lines: string[] = [];
  const shownDiagnostics = new Set(output.diagnostics);
  const positive = (value: string) => (useColor ? green(value, true) : value);
  const warning = (value: string) => (useColor ? yellow(value, true) : value);
  const heading = (value: string) => (useColor ? cyan(value, true) : value);
  const concise = !debug && (output.outcome === undefined || output.outcome === "healthy" || output.outcome === "applied");

  if (output.outcome === "applied") {
    lines.push(`${positive(bold("[HOÀN TẤT] Đã áp dụng thiết lập", useColor))} ${greenTick(useColor)}`);
  } else if (output.outcome === "healthy") {
    lines.push(`${positive(bold("[ĐẠT] Thiết lập hoàn toàn khỏe mạnh", useColor))} ${greenTick(useColor)}`);
  } else if (output.mode === "dry_run" || output.outcome === "changes_pending") {
    lines.push(
      heading(bold(`[XEM TRƯỚC] Kế hoạch thiết lập (${output.plan?.steps.length ?? 0} bước)`, useColor))
    );
  } else if (
    (output.outcome as string) === "approval_required" ||
    output.outcome === "approval_declined" ||
    output.outcome === "partially_applied"
  ) {
    lines.push(warning(bold("[CẦN XỬ LÝ] Thiết lập cần phê duyệt hoặc khắc phục", useColor)));
  } else if (output.outcome) {
    const errHeader = `[LỖI] Thiết lập thất bại (${readableLabel(output.outcome)})`;
    lines.push(useColor ? red(bold(errHeader, true), true) : errHeader);
  } else {
    lines.push(`${positive(bold("[HOÀN TẤT] Đã áp dụng thiết lập", useColor))} ${greenTick(useColor)}`);
  }

  if (debug || !concise) {
    lines.push(`${heading("Chế độ:")}                ${readableLabel(output.mode).toUpperCase()}`);
    lines.push(`${heading("Hệ điều hành:")}          ${sanitizeIdentifier(output.os)}`);
    lines.push(`${heading("Trình quản lý dịch vụ:")} ${sanitizeIdentifier(output.serviceManagerKind)}`);
    if (output.serviceUnitNamespace) {
      const prefix = output.serviceManagerKind === "launchd" ? "dev.bflow." : "bflow-";
      lines.push(
        `${heading("Đơn vị dịch vụ:")}        ${sanitizeIdentifier(`${prefix}${output.serviceUnitNamespace}-<service>`)} (không gian tên cô lập)`
      );
    }
  }

  if (output.plan) {
    if (debug || !concise) {
      lines.push(
        `${heading("Mã kế hoạch:")}           ${sanitizeIdentifier(output.plan.planId)} (phiên bản ${output.plan.revision}, ${output.plan.steps.length} bước)`
      );
    }
    const showPreview =
      output.preview && (output.mode === "dry_run" || output.outcome === "approval_declined");
    for (const [index, step] of (showPreview || concise ? [] : output.plan.steps).entries()) {
      const receipt =
        output.receipts?.find((r) => r.stepId === step.stepId) ??
        (output.receipt?.stepId === step.stepId ? output.receipt : undefined);
      const approval = !receipt && step.requiresApproval ? ` ${warning("[cần phê duyệt]")}` : "";
      const isStepDone =
        receipt?.status === "applied" || receipt?.status === "already_satisfied";
      const status = receipt ? readableLabel(receipt.status) : "dự kiến";
      const label =
        step.action === "install_tool"
          ? `Cài đặt ${sanitizeIdentifier(step.componentId)}`
          : SETUP_COMPONENT_LABELS[step.componentId] ?? readableLabel(step.componentId);
      const paintedStatus = isStepDone
        ? positive(status)
        : receipt?.status === "failed"
        ? useColor
          ? red(status, true)
          : status
        : warning(status);
      lines.push(
        `  ${formatProgressStep(label, useColor, index + 1)} [${paintedStatus}]${approval}${
          isStepDone ? ` ${greenTick(useColor)}` : ""
        }`
      );
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

  if (output.receipt && (debug || !concise)) {
    const isReceiptOk =
      output.receipt.status === "applied" || output.receipt.status === "already_satisfied";
    const receiptStatus = isReceiptOk
      ? positive(readableLabel(output.receipt.status))
      : output.receipt.status === "failed"
      ? useColor
        ? red(readableLabel(output.receipt.status), true)
        : readableLabel(output.receipt.status)
      : warning(readableLabel(output.receipt.status));
    lines.push(
      `${heading("Biên nhận thực thi:")}    ${sanitizeIdentifier(output.receipt.receiptId)} (trạng thái: ${receiptStatus})${
        isReceiptOk ? ` ${greenTick(useColor)}` : ""
      }`
    );
  }

  if (output.tools && output.tools.length > 0) {
    lines.push("");
    const readyTools = output.tools.filter((tool) =>
      ["present", "installed", "ready", "healthy", "available"].includes(
        tool.status.toLowerCase()
      )
    );
    const attentionCount = output.tools.length - readyTools.length;
    lines.push(
      `🔧 Công cụ: ${readyTools.length}/${output.tools.length} sẵn sàng${
        attentionCount > 0 ? `, ${attentionCount} cần chú ý` : ""
      }${readyTools.length === output.tools.length ? ` ${greenTick(useColor)}` : ""}`
    );
    for (const tool of debug
      ? output.tools
      : output.tools.filter((tool) => !readyTools.includes(tool))) {
      const isToolReady = readyTools.includes(tool);
      const ver = tool.version ? ` (${sanitizeIdentifier(tool.version)})` : "";
      const status = isToolReady
        ? positive(readableLabel(tool.status))
        : ["failed", "missing", "unavailable", "error"].includes(tool.status.toLowerCase())
        ? useColor
          ? red(readableLabel(tool.status), true)
          : readableLabel(tool.status)
        : warning(readableLabel(tool.status));
      lines.push(
        `  - ${sanitizeIdentifier(tool.toolId)}: ${status}${ver}${
          isToolReady ? ` ${greenTick(useColor)}` : ""
        }`
      );
    }
  }

  lines.push("");
  lines.push(
    `📚 Kỹ năng: ${output.skills.skillCount} gói kỹ năng đã ghim${
      output.skills.catalogLoaded ? ` ${greenTick(useColor)}` : " (chưa nạp danh mục)"
    }`
  );
  if (debug || !output.skills.catalogLoaded) {
    lines.push(`  Đã nạp danh mục:     ${output.skills.catalogLoaded ? "có" : "không"}`);
    lines.push(`  Số lượng kỹ năng:    ${output.skills.skillCount}`);
    lines.push(`  Manifest đã đồng bộ: ${output.skills.syncedManifests}`);
    if (output.skills.installedSkillCount !== undefined) {
      lines.push(`  Kỹ năng đã cài:      ${output.skills.installedSkillCount}`);
    }
    lines.push(`  Kho lưu trữ:         ${sanitizeIdentifier(output.skills.storeRoot)}`);
  }

  if (output.doctor) {
    const failed = output.doctor.checks.filter(
      (check) => check.status === "failed" || check.status === "warning"
    );
    if (!output.doctor.healthy || failed.length > 0 || debug) {
      lines.push("");
      lines.push(
        `Kiểm tra máy: ${
          output.doctor.healthy
            ? `${positive("Đạt")} ${greenTick(useColor)}`
            : warning("Cần xử lý")
        }`
      );
      for (const check of failed) {
        lines.push(`  - ${humanText(check.summary)}`);
        if (check.remediation) {
          lines.push(`    👉 Tiếp theo: ${humanText(check.remediation)}`);
        }
      }
    }
  }

  const diagnostics = [...new Set(output.diagnostics)].filter(
    (diagnostic) => !concise || diagnostic !== "Setup completed successfully"
  );
  if (diagnostics.length > 0) {
    lines.push("");
    lines.push("Chẩn đoán:");
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
      receiptDiagnostics.push(
        `  - ${sanitizeIdentifier(receipt.stepId)}: ${humanText(diagnostic, 250)}`
      );
    }
  }
  if (receiptDiagnostics.length) {
    lines.push("", "Chẩn đoán biên nhận:", ...receiptDiagnostics);
  }
  lines.push("");
  const nextLabel = useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:";
  if (output.outcome === undefined || output.outcome === "healthy" || output.outcome === "applied") {
    lines.push(`${nextLabel} Chạy 'bflow doctor' trong kho mã nguồn để kiểm tra mức độ sẵn sàng.`);
  } else if (
    output.outcome === "changes_pending" ||
    output.outcome === "approval_declined" ||
    output.mode === "dry_run"
  ) {
    lines.push(
      `${nextLabel} Xem kỹ 'bflow setup --plan', sau đó chạy 'bflow setup --apply' khi bạn muốn áp dụng.`
    );
  } else {
    lines.push(
      `${nextLabel} Khắc phục các vấn đề được báo cáo ở trên và chạy 'bflow setup --check' để kiểm tra lại.`
    );
  }
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
  const debug = resolveDebug(options);

  if (isHelpData(data)) {
    return data.helpText;
  }

  if (isVersionData(data)) {
    return data.version;
  }

  if (isInitOutput(data)) {
    return formatInitOutput(data, useColor, debug);
  }

  if (isConfigMigrationOutput(command, data)) {
    const targetPath = sanitizeIdentifier((data as any).targetPath ?? data.configPath);
    if (data.migrated) {
      const header = "[HOÀN TẤT] Đã chuyển đổi cấu hình kho mã nguồn";
      return [
        `${useColor ? green(bold(header), true) : header} ${greenTick(useColor)}`,
        `  Từ:   ${sanitizeIdentifier(data.sourcePath)}`,
        `  Sang: ${targetPath}`,
        ...(debug && data.backupPath ? [`  Sao lưu: ${sanitizeIdentifier(data.backupPath)}`] : [])
      ].join("\n");
    }
    const header = "[HOÀN TẤT] Cấu hình đã ở định dạng chuẩn";
    return [
      `${useColor ? green(bold(header), true) : header} (${targetPath}) ${greenTick(useColor)}`,
      ...(debug && data.backupPath ? [`  Sao lưu: ${sanitizeIdentifier(data.backupPath)}`] : [])
    ].join("\n");
  }

  if (isDocsOutput(data)) {
    return formatDocsOutput(data, useColor);
  }

  if (isSetupOutput(data)) {
    return formatSetupOutput(data, useColor, debug);
  }

  if (isCodexHookSetupOutput(data)) {
    return formatCodexHookSetupOutput(data, { color: useColor, debug });
  }

  if (isHighLevelOutput(data)) {
    return formatHighLevelOutput(data, useColor);
  }

  if (isDoctorReport(data)) {
    return formatDoctorReport(data, { color: useColor, debug });
  }

  if (command === "attach") {
    return formatAttachOutput(data, useColor, debug);
  }

  if (command === "recover") {
    return formatRecoverOutput(data, useColor, debug);
  }

  if (command === "down") {
    if (isEnvironmentStatus(data) || isSessionManifest(data)) {
      return formatDownOutput(data, useColor, debug);
    }
  }

  if (command === "up" && isSessionManifest(data)) {
    return formatUpOutput(data, useColor, debug);
  }

  if (isEnvironmentStatus(data)) {
    return formatEnvironmentStatus(data, useColor, debug);
  }

  if (isSessionManifest(data)) {
    return formatUpOutput(data, useColor, debug);
  }

  if ("reportVersion" in data && data.reportVersion === 1) return formatTelemetryReport(data);
  if (command === "cancel" && "fullyStopped" in data && typeof data.fullyStopped === "boolean") {
    const report = CancellationReconciliationReportSchema.parse(data);
    return [report.fullyStopped ? "Đã xác nhận dừng và hoàn tất đối soát hủy." : "Chưa hoàn tất đối soát hủy; chưa xác nhận an toàn để tiếp tục công việc mới.",
      ...report.blockers, ...report.retainedWorktrees.map(path => `Giữ bản làm việc: ${path}`)].join("\n");
  }

  if (isSnapshot(data)) {
    const runFormatted = formatWorkflowRun(data, useColor, debug);
    const tick = greenTick(useColor);
    switch (command) {
      case "run":
        return `${useColor ? green(bold("[ĐÃ BẮT ĐẦU]"), true) : "[ĐÃ BẮT ĐẦU]"} Đã khởi chạy luồng '${sanitizeIdentifier(data.runId)}' ${tick}\n\n${runFormatted}`;
      case "approve":
        return `${useColor ? green(bold("[HOÀN TẤT]"), true) : "[HOÀN TẤT]"} Đã ghi nhận quyết định phê duyệt cho luồng '${sanitizeIdentifier(data.runId)}' ${tick}\n\n${runFormatted}`;
      case "resume":
        return `${useColor ? green(bold("[ĐÃ TIẾP TỤC]"), true) : "[ĐÃ TIẾP TỤC]"} Đã tiếp tục luồng chạy '${sanitizeIdentifier(data.runId)}' ${tick}\n\n${runFormatted}`;
      case "cancel":
        return `${useColor ? yellow(bold("[ĐÃ YÊU CẦU HỦY]"), true) : "[ĐÃ YÊU CẦU HỦY]"} Đã gửi yêu cầu hủy cho luồng chạy '${sanitizeIdentifier(data.runId)}' ${tick}\n\n${runFormatted}`;
      case "status":
      default:
        return runFormatted;
    }
  }

  if (isPage(data)) {
    return formatRunPage(data, useColor, debug);
  }

  return `${useColor ? green(bold("[HOÀN TẤT]"), true) : "[HOÀN TẤT]"} Đã thực thi lệnh xong ${greenTick(useColor)}. Dùng --json để xem toàn bộ kết quả.`;
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
  const debug = resolveDebug(options);

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

  const errorTag = useColor ? red(bold(`✗ Lỗi [${error.code}]:`), true) : `✗ Lỗi [${error.code}]:`;
  let out = `${errorTag} ${cleanMessage}`;

  if (debug) {
    const retryText = `Có thể thử lại: ${error.retryable ? "có (lỗi tạm thời)" : "không (cần xử lý nguyên nhân trước)"}`;
    out += `\n${useColor ? dim(retryText, true) : retryText}`;

    // Safe details only: show validated scalar fields stage/role/provider/pane/session
    const safe = extractSafeDetails(error.details);
    if (safe !== null) {
      let detailsStr = Object.entries(safe)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      if (detailsStr.length > 500) {
        detailsStr = detailsStr.slice(0, 500).trimEnd() + "... [truncated]";
      }
      const detailsTag = useColor ? dim(`Chi tiết: ${detailsStr}`, true) : `Chi tiết: ${detailsStr}`;
      out += `\n${detailsTag}`;
    }
  }

  // Next: specific useful supported action
  const remediation = resolveActionableRemediation(error, command);
  const nextTag = useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:";
  out += `\n${nextTag} ${remediation}`;

  return out;
}
