import type {
  ContractError,
  Page,
  WorkflowRunSnapshot
} from "@bflow/contracts";
import type {
  CliCommandData,
  CliCommandName,
  HighLevelCommandOutput,
  InitCommandOutput,
  SetupCommandOutput
} from "./types.js";

function isInitOutput(data: CliCommandData): data is InitCommandOutput {
  return typeof data === "object" && data !== null && "configPath" in data && "config" in data;
}

function isSetupOutput(data: CliCommandData): data is SetupCommandOutput {
  return typeof data === "object" && data !== null && "machineId" in data && "serviceManagerKind" in data && "plan" in data;
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

function formatHighLevelOutput(output: HighLevelCommandOutput): string {
  const lines: string[] = [];

  const statusStr = output.status.toUpperCase();
  lines.push(`Command:   ${output.command}`);
  lines.push(`Status:    ${statusStr}`);
  lines.push(`CommandId: ${output.commandId}`);
  lines.push(`CorrId:    ${output.correlationId}`);
  if (output.runId) {
    lines.push(`Run ID:    ${output.runId}`);
  }
  if (output.taskId) {
    lines.push(`Task ID:   ${output.taskId}`);
  }
  if (output.reusedReceipt) {
    lines.push(`Notice:    Reused prior successful receipt (${output.idempotencyKey})`);
  }
  if (output.resumedFromStep) {
    lines.push(`Notice:    Resumed from step '${output.resumedFromStep}'`);
  }

  if (output.steps && output.steps.length > 0) {
    lines.push("");
    lines.push("Steps:");
    for (const step of output.steps) {
      const stepStatus = step.status.toUpperCase().padEnd(9);
      const mutating = step.mutating ? " [mutating]" : "";
      lines.push(`  - [${stepStatus}] ${step.stepId}: ${step.name}${mutating}`);
      if (step.error) {
        lines.push(`      Error: [${step.error.code}] ${step.error.message}`);
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
        if (repo?.root) lines.push(`  Root:    ${repo.root}`);
        if (repo?.sessionName) lines.push(`  Session: ${repo.sessionName}`);
        if (git?.branch) lines.push(`  Branch:  ${git.branch} (${git.head ? git.head.slice(0, 8) : "unknown"})`);
        if (git !== undefined && "dirty" in git) lines.push(`  Dirty:   ${git.dirty ? "yes" : "clean"}`);
        break;
      }
      case "task plan": {
        const wf = (details.workflow ?? details.plan) as any;
        if (wf?.tasks && Array.isArray(wf.tasks)) {
          lines.push("");
          lines.push(`Planned Tasks (${wf.tasks.length}):`);
          for (const t of wf.tasks) {
            lines.push(`  - ${t.id ?? t.taskId}: ${t.title ?? t.name ?? ""}`);
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
        if (execStatus?.taskId ?? execStatus?.id) lines.push(`  Task:     ${execStatus?.taskId ?? execStatus?.id}`);
        if (tdd?.mode) lines.push(`  TDD Mode: ${tdd.mode}`);
        if (wtPath) lines.push(`  Worktree: ${wtPath}`);
        break;
      }
      case "verify": {
        const res = (details.result ?? details.verificationResult) as any;
        lines.push("");
        lines.push("Verification Result:");
        if (res?.status) lines.push(`  Status:    ${String(res.status).toUpperCase()}`);
        if (res?.summary) lines.push(`  Summary:   ${res.summary}`);
        if (res?.score !== undefined) lines.push(`  Score:     ${res.score}`);
        break;
      }
      case "git prepare": {
        lines.push("");
        lines.push("Git Integration Summary:");
        if (details.targetBranch) lines.push(`  Target Branch: ${details.targetBranch}`);
        if (details.conflictsDetected !== undefined) {
          lines.push(`  Conflicts:     ${details.conflictsDetected ? "YES (conflicts found)" : "none"}`);
        }
        if (Array.isArray(details.branches)) {
          lines.push(`  Branches (${details.branches.length}): ${details.branches.join(", ")}`);
        }
        break;
      }
      case "mcp status": {
        lines.push("");
        const services = Array.isArray(details.services) ? details.services : [];
        const healthy = details.healthy;
        lines.push(`MCP Services (${services.length}) - Healthy: ${healthy === false ? "NO" : "YES"}:`);
        for (const s of services) {
          const sName = s.serviceId ?? s.name ?? "unknown";
          const sStatus = String(s.status ?? (s.healthy !== undefined ? (s.healthy ? "healthy" : "unhealthy") : "unknown")).toUpperCase();
          lines.push(`  - ${sName}: ${sStatus}`);
        }
        break;
      }
      case "tool status": {
        lines.push("");
        const tools = Array.isArray(details.tools) ? details.tools : [];
        const healthy = details.healthy;
        lines.push(`Pinned Tools (${tools.length}) - Healthy: ${healthy === false ? "NO" : "YES"}:`);
        for (const t of tools) {
          const tName = t.toolId ?? t.name ?? "unknown";
          const tStatus = String(t.status ?? (t.available !== undefined ? (t.available ? "available" : "missing") : "unknown")).toUpperCase();
          const tVer = t.version ? ` (v${t.version})` : "";
          lines.push(`  - ${tName}: ${tStatus}${tVer}`);
        }
        break;
      }
      case "skills sync": {
        lines.push("");
        lines.push("Skills Synchronization Summary:");
        if (details.mode) lines.push(`  Mode:     ${details.mode}`);
        if (details.provider) lines.push(`  Provider: ${details.provider}`);
        if (Array.isArray(details.skills)) {
          lines.push(`  Skills (${details.skills.length}): ${details.skills.map((s: any) => s.skillId ?? s.name ?? s).join(", ")}`);
        } else if (Array.isArray(details.syncedSkills)) {
          lines.push(`  Synced Skills (${details.syncedSkills.length}): ${details.syncedSkills.join(", ")}`);
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
        lines.push(`Agent Providers (${providers.length}) - Healthy: ${healthy === false ? "NO" : "YES"}:`);
        for (const p of providers) {
          const pName = p.provider ?? p.providerId ?? p.name ?? "unknown";
          const pStatus = String(p.status ?? (p.healthy !== undefined ? (p.healthy ? "ready" : "blocked") : "unknown")).toUpperCase();
          lines.push(`  - ${pName}: ${pStatus}`);
        }
        break;
      }
    }
  }

  return lines.join("\n");
}

function formatWorkflowRun(snapshot: WorkflowRunSnapshot): string {
  const lines: string[] = [];
  lines.push(`Run ID:   ${snapshot.runId}`);
  lines.push(`Workflow: ${snapshot.workflowId} (v${snapshot.workflowVersion})`);
  lines.push(`Status:   ${snapshot.status.toUpperCase()}`);
  lines.push(`Version:  ${snapshot.version}`);
  lines.push(`Created:  ${snapshot.createdAt}`);
  lines.push(`Updated:  ${snapshot.updatedAt}`);
  lines.push("");
  lines.push("Tasks:");
  for (const t of snapshot.tasks) {
    let taskLine = `  - ${t.taskId.padEnd(14)} [${t.status.toUpperCase()}] (gen: ${t.generation}, attempt: ${t.attempt})`;
    if (t.blockage) {
      taskLine += ` [Blockage: ${t.blockage.code}${t.blockage.message ? ` - ${t.blockage.message}` : ""}]`;
    }
    lines.push(taskLine);
  }

  if (snapshot.status === "waiting" || snapshot.status === "blocked") {
    const blockingTasks = snapshot.tasks.filter((t) => t.status === "waiting" || t.status === "blocked");
    const taskNames = blockingTasks.length > 0 ? blockingTasks.map((t) => `'${t.taskId}'`).join(", ") : "a task";
    lines.push("");
    lines.push(`Notice: Run is ${snapshot.status} on ${taskNames}.`);
    if (blockingTasks.some((t) => t.blockage?.code === "awaiting_approval" || t.status === "waiting")) {
      const waitTask = blockingTasks.find((t) => t.status === "waiting") ?? blockingTasks[0];
      lines.push(`  To record human approval: bflow approve ${waitTask?.taskId ?? "<task-id>"} --run ${snapshot.runId}`);
    }
    lines.push(`  To resume the run: bflow resume ${snapshot.runId}`);
  }

  return lines.join("\n");
}

function formatRunPage(page: Page<WorkflowRunSnapshot>): string {
  if (page.items.length === 0) {
    return "No workflow runs found.";
  }
  const lines: string[] = [];
  lines.push(`Found ${page.items.length} run(s):`);
  lines.push("");
  lines.push(`  ${"RUN ID".padEnd(24)} ${"STATUS".padEnd(12)} ${"WORKFLOW".padEnd(25)} UPDATED`);
  lines.push(`  ${"-".repeat(24)} ${"-".repeat(12)} ${"-".repeat(25)} ${"-".repeat(24)}`);
  for (const r of page.items) {
    lines.push(
      `  ${r.runId.padEnd(24)} ${r.status.toUpperCase().padEnd(12)} ${(r.workflowId + " (v" + r.workflowVersion + ")").padEnd(25)} ${r.updatedAt}`
    );
  }
  if (page.nextCursor) {
    lines.push("");
    lines.push(`Next page cursor: ${page.nextCursor} (use --cursor ${page.nextCursor})`);
  }
  return lines.join("\n");
}

function formatInitOutput(output: InitCommandOutput): string {
  const lines: string[] = [];
  if (output.overwritten) {
    lines.push(`Initialized bflow repository configuration (overwritten) at:`);
  } else {
    lines.push(`Initialized bflow repository configuration at:`);
  }
  lines.push(`  ${output.configPath}`);
  lines.push("");
  lines.push(`Project Name:  ${output.config.projectName}`);
  lines.push(`Runtime ID:    ${output.config.runtimeId}`);
  lines.push(`Run Store:     ${output.config.storage.runStorePath}`);
  lines.push(`Artifacts:     ${output.config.storage.artifactStoreRoot}`);
  lines.push(`Registry:      ${output.config.storage.registryStateFile}`);
  lines.push(`Default Tasks: ${output.config.defaultWorkflow.tasks.map((t) => t.id).join(" -> ")}`);
  return lines.join("\n");
}

function formatSetupOutput(output: SetupCommandOutput): string {
  const lines: string[] = [];
  lines.push(`Setup Mode:         ${output.mode.toUpperCase()}`);
  lines.push(`Machine ID:         ${output.machineId}`);
  lines.push(`Operating System:   ${output.os}`);
  lines.push(`Service Manager:    ${output.serviceManagerKind}`);
  if (output.plan) {
    lines.push(`Plan ID:            ${output.plan.planId} (revision ${output.plan.revision})`);
    lines.push(`Plan Steps:         ${output.plan.steps.length}`);
    for (const step of output.plan.steps) {
      const approval = step.requiresApproval ? " [requires approval]" : "";
      lines.push(`  - [${step.action}] ${step.stepId} (${step.componentId})${approval}`);
    }
  }
  if (output.receipt) {
    lines.push(`Receipt ID:         ${output.receipt.receiptId} (status: ${output.receipt.status})`);
  }
  if (output.tools && output.tools.length > 0) {
    lines.push("");
    lines.push("Tools:");
    for (const tool of output.tools) {
      const ver = tool.version ? ` (${tool.version})` : "";
      lines.push(`  - ${tool.toolId}: ${tool.status}${ver}`);
    }
  }
  lines.push("");
  lines.push("Skills:");
  lines.push(`  Catalog Loaded:   ${output.skills.catalogLoaded ? "yes" : "no"}`);
  lines.push(`  Skill Count:      ${output.skills.skillCount}`);
  lines.push(`  Synced Manifests: ${output.skills.syncedManifests}`);
  lines.push(`  Store Root:       ${output.skills.storeRoot}`);

  if (output.diagnostics && output.diagnostics.length > 0) {
    lines.push("");
    lines.push("Diagnostics:");
    for (const diag of output.diagnostics) {
      lines.push(`  - ${diag}`);
    }
  }
  return lines.join("\n");
}

function formatDoctorGroups(groups: unknown): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push("Component Groups:");

  const renderItem = (item: any) => {
    if (!item || typeof item !== "object") return;
    const status = (item.status ?? "unknown").toString().toUpperCase();
    const component = item.component ?? item.name ?? item.toolId ?? item.checkId ?? "unknown";
    const ver = item.detected_version ?? item.version ?? item.detectedVersion;
    const verStr = ver ? ` (version: ${ver})` : "";
    lines.push(`  - [${status}] ${component}${verStr}`);
    if (item.reason ?? item.message) {
      lines.push(`      Reason: ${item.reason ?? item.message}`);
    }
    if (item.remediation) {
      lines.push(`      Remediation: ${item.remediation}`);
    }
    if (item.repair_command ?? item.repairCommand) {
      lines.push(`      Repair: ${item.repair_command ?? item.repairCommand}`);
    }
  };

  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (group && typeof group === "object") {
        const title = group.group ?? group.name ?? group.title ?? "Group";
        lines.push(`\n[${title}]`);
        const items = Array.isArray(group.items) ? group.items : Array.isArray(group.checks) ? group.checks : [group];
        for (const item of items) renderItem(item);
      }
    }
  } else if (groups && typeof groups === "object") {
    for (const [groupName, groupContent] of Object.entries(groups)) {
      lines.push(`\n[${groupName}]`);
      if (Array.isArray(groupContent)) {
        for (const item of groupContent) renderItem(item);
      } else if (groupContent && typeof groupContent === "object") {
        renderItem(groupContent);
      }
    }
  }
  return lines;
}

export function formatCommandSuccess(
  command: CliCommandName,
  data: CliCommandData,
  json: boolean
): string {
  if (json) {
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

  if (isHelpData(data)) {
    return data.helpText;
  }

  if (isVersionData(data)) {
    return data.version;
  }

  if (isInitOutput(data)) {
    return formatInitOutput(data);
  }

  if (isSetupOutput(data)) {
    return formatSetupOutput(data);
  }

  if (isHighLevelOutput(data)) {
    return formatHighLevelOutput(data);
  }

  if ("checks" in data) {
    const lines = [
      `Repository: ${data.workspaceRoot}`,
      `Session: ${data.sessionId ?? "none"}`,
      ...data.checks.map(
        (check) => `${check.status.toUpperCase()} ${check.name}: ${check.message}${check.remediation ? `\n  Next: ${check.remediation}` : ""}`
      )
    ];
    if (command === "doctor" && (data as any).metadata?.groups) {
      lines.push(...formatDoctorGroups((data as any).metadata.groups));
    }
    return lines.join("\n");
  }
  if ("server" in data) {
    return [`Repository: ${data.workspaceRoot}`, `Session: ${data.sessionName}`,
      `Server: ${data.server}; configuration: ${data.configuration}`,
      `Pane/agent observation: ${data.liveObservation ? "live" : "persisted (may be stale)"}`,
      `Environment: ${data.manifest?.status ?? "not started"}`,
      ...(data.manifest?.panes.map((pane) => `${pane.role}: ${pane.transportState} (${pane.workspaceId}/${pane.tabId}/${pane.paneId}, agent ${pane.agentId})`) ?? []),
      ...data.issues].join("\n");
  }
  if ("panes" in data) {
    return [`Repository: ${data.workspaceRoot}`, `Session: ${data.sessionId}; environment: ${data.status}`,
      ...data.panes.map((pane) => `${pane.role}: ${pane.transportState} (${pane.paneId}, agent ${pane.agentId})`)].join("\n");
  }

  if (isSnapshot(data)) {
    switch (command) {
      case "run":
        return `Started workflow run '${data.runId}':\n\n${formatWorkflowRun(data)}`;
      case "approve":
        return `Approval decision recorded for run '${data.runId}':\n\n${formatWorkflowRun(data)}`;
      case "resume":
        return `Resumed workflow run '${data.runId}':\n\n${formatWorkflowRun(data)}`;
      case "cancel":
        return `Cancellation applied to run '${data.runId}':\n\n${formatWorkflowRun(data)}`;
      case "status":
      default:
        return formatWorkflowRun(data);
    }
  }

  if (isPage(data)) {
    return formatRunPage(data);
  }

  return JSON.stringify(data, null, 2);
}

export function formatCommandError(
  error: ContractError,
  command: CliCommandName | undefined,
  json: boolean
): string {
  if (json) {
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

  let out = `Error [${error.code}]: ${error.message}`;
  if (error.details !== undefined && error.details !== null) {
    out += `\nDetails: ${JSON.stringify(error.details, null, 2)}`;
  }
  if (command && ["up", "down", "attach", "status", "doctor", "recover"].includes(command)) {
    out += "\nNext: bflow status and bflow doctor show this repository's session and recovery instructions. Preserve .bflow; use bflow down --yes for a checked shutdown.";
  }
  return out;
}
