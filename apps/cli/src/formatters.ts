import type {
  ContractError,
  Page,
  WorkflowRunSnapshot
} from "@ai-flow/contracts";
import type {
  CliCommandData,
  CliCommandName,
  InitCommandOutput
} from "./types.js";

function isInitOutput(data: CliCommandData): data is InitCommandOutput {
  return typeof data === "object" && data !== null && "configPath" in data && "config" in data;
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
      lines.push(`  To record human approval: flow approve ${waitTask?.taskId ?? "<task-id>"} --run ${snapshot.runId}`);
    }
    lines.push(`  To resume the run: flow resume ${snapshot.runId}`);
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
    lines.push(`Initialized AI Flow repository configuration (overwritten) at:`);
  } else {
    lines.push(`Initialized AI Flow repository configuration at:`);
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
  return out;
}
