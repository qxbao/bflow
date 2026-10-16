import {
  ArtifactReferenceSchema,
  IdentifierSchema,
  type ArtifactReference,
  type ContractError,
  type OperationResult
} from "@bflow/contracts";
import { getMvpRoleProfile, isMvpRole, type MvpRole } from "./roles.js";
import {
  UNTRUSTED_CONTENT_SAFETY_RULES,
  detectDangerousInstructions,
  validateUntrustedContentPolicy,
  wrapUntrustedRepositoryContent,
  type ContentSafetyReport,
  type DangerousInstructionFinding
} from "./safety.js";
import {
  NON_USER_FACING_AUTONOMOUS_POLICY,
  STRUCTURED_RESULT_REQUIRED_FIELDS
} from "./behavior-policy.js";

export { NON_USER_FACING_AUTONOMOUS_POLICY, STRUCTURED_RESULT_REQUIRED_FIELDS };

export interface PlannerPromptParams {
  readonly runId: string;
  readonly workflowKind: "feature" | "bugfix" | "refactor";
  readonly requirement: string;
  readonly repositoryContext: string;
  readonly constraints?: readonly string[];
  readonly inputArtifacts?: readonly ArtifactReference[];
}

export interface DeveloperPromptParams {
  readonly runId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskDescription?: string;
  readonly instruction: string;
  readonly acceptanceCriteria: readonly string[];
  readonly worktreePath: string;
  readonly branchName?: string;
  readonly repositoryContext?: string;
  readonly reworkFeedback?: string;
  readonly inputArtifacts?: readonly ArtifactReference[];
}

export interface ReviewerPromptParams {
  readonly runId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly acceptanceCriteria: readonly string[];
  readonly commitSha: string;
  readonly changedFiles: readonly string[];
  readonly diffSummary: string;
  readonly repositoryContext?: string;
  readonly inputArtifacts?: readonly ArtifactReference[];
}

export interface QaPromptParams {
  readonly runId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly acceptanceCriteria: readonly string[];
  readonly testExecutionSummary: string;
  readonly repositoryContext?: string;
  readonly inputArtifacts?: readonly ArtifactReference[];
}

export interface RolePromptParamsMap {
  readonly planner: PlannerPromptParams;
  readonly developer: DeveloperPromptParams;
  readonly reviewer: ReviewerPromptParams;
  readonly qa: QaPromptParams;
}

export interface RenderPromptOptions {
  readonly rejectDangerousRepositoryContent?: boolean;
}

export interface RenderedRolePrompt {
  readonly role: MvpRole;
  readonly prompt: string;
  readonly safetyRules: readonly string[];
  readonly inputArtifactUris: readonly string[];
  readonly safetyReport: ContentSafetyReport;
}

const ok = <T>(value: T): OperationResult<T> => ({ ok: true, value });
const fail = <T>(error: ContractError): OperationResult<T> => ({ ok: false, error });
const validation = (message: string): ContractError => ({ code: "validation", retryable: false, message });

function formatArtifactList(artifacts: readonly ArtifactReference[]): string {
  if (artifacts.length === 0) {
    return "None provided.";
  }
  return artifacts
    .map(
      (a) =>
        `- [${a.kind}] ${a.artifactId} (URI: ${a.uri}) [integrity: ${a.checksum.algorithm}:${a.checksum.value}]`
    )
    .join("\n");
}

export function renderRolePrompt<R extends MvpRole>(
  role: R,
  params: RolePromptParamsMap[R],
  options?: RenderPromptOptions
): OperationResult<RenderedRolePrompt> {
  if (!isMvpRole(role)) {
    return fail(validation(`Invalid MVP role: ${String(role)}`));
  }

  const runIdParsed = IdentifierSchema.safeParse(params.runId);
  if (!runIdParsed.success) {
    return fail(validation(`Invalid runId '${params.runId}': ${runIdParsed.error.message}`));
  }
  if (/[\r\n\0"]/.test(runIdParsed.data)) {
    return fail(validation("Invalid runId: must not contain newlines, control characters, or quotes"));
  }

  const profile = getMvpRoleProfile(role);

  // Validate taskId for developer, reviewer, and qa
  let validatedTaskId: string | undefined;
  if (role !== "planner") {
    const nonPlannerParams = params as DeveloperPromptParams | ReviewerPromptParams | QaPromptParams;
    const taskIdParsed = IdentifierSchema.safeParse(nonPlannerParams.taskId);
    if (!taskIdParsed.success) {
      return fail(validation(`Invalid taskId '${nonPlannerParams.taskId}': ${taskIdParsed.error.message}`));
    }
    if (/[\r\n\0"]/.test(taskIdParsed.data)) {
      return fail(validation("Invalid taskId: must not contain newlines, control characters, or quotes"));
    }
    validatedTaskId = taskIdParsed.data;
  }

  // Role-specific parameter validations
  const textFieldsToScan: { fieldName: string; content: string }[] = [];
  textFieldsToScan.push({ fieldName: "runId", content: runIdParsed.data });
  if (validatedTaskId !== undefined) {
    textFieldsToScan.push({ fieldName: "taskId", content: validatedTaskId });
  }

  let validatedWorktreePath: string | undefined;

  if (role === "planner") {
    const p = params as PlannerPromptParams;
    if (p.workflowKind !== "feature" && p.workflowKind !== "bugfix" && p.workflowKind !== "refactor") {
      return fail(validation("Planner 'workflowKind' must be 'feature', 'bugfix', or 'refactor'"));
    }
    if (typeof p.requirement !== "string" || p.requirement.trim().length === 0) {
      return fail(validation("Planner 'requirement' must be a non-empty string"));
    }
    if (typeof p.repositoryContext !== "string" || p.repositoryContext.trim().length === 0) {
      return fail(validation("Planner 'repositoryContext' must be a non-empty string"));
    }
    textFieldsToScan.push({ fieldName: "requirement", content: p.requirement });
    textFieldsToScan.push({ fieldName: "repositoryContext", content: p.repositoryContext });

    if (p.constraints !== undefined) {
      if (!Array.isArray(p.constraints)) {
        return fail(validation("Planner 'constraints' must be an array of strings"));
      }
      for (let i = 0; i < p.constraints.length; i++) {
        const c = p.constraints[i];
        if (typeof c !== "string" || c.trim().length === 0) {
          return fail(validation(`Planner 'constraints[${i}]' must be a non-empty string`));
        }
        textFieldsToScan.push({ fieldName: `constraints[${i}]`, content: c });
      }
    }
  } else if (role === "developer") {
    const d = params as DeveloperPromptParams;
    if (typeof d.taskTitle !== "string" || d.taskTitle.trim().length === 0) {
      return fail(validation("Developer 'taskTitle' must be a non-empty string"));
    }
    if (d.taskDescription !== undefined && (typeof d.taskDescription !== "string" || d.taskDescription.trim().length === 0)) {
      return fail(validation("Developer 'taskDescription' must be a non-empty string if provided"));
    }
    if (typeof d.instruction !== "string" || d.instruction.trim().length === 0) {
      return fail(validation("Developer 'instruction' must be a non-empty string"));
    }
    if (!Array.isArray(d.acceptanceCriteria) || d.acceptanceCriteria.length === 0) {
      return fail(validation("Developer 'acceptanceCriteria' must contain at least 1 item"));
    }
    for (let i = 0; i < d.acceptanceCriteria.length; i++) {
      const ac = d.acceptanceCriteria[i];
      if (typeof ac !== "string" || ac.trim().length === 0) {
        return fail(validation(`Developer 'acceptanceCriteria[${i}]' must be a non-empty string`));
      }
      textFieldsToScan.push({ fieldName: `acceptanceCriteria[${i}]`, content: ac });
    }
    if (typeof d.worktreePath !== "string" || d.worktreePath.trim().length === 0) {
      return fail(validation("Developer 'worktreePath' must be a non-empty string"));
    }
    const wt = d.worktreePath.trim();
    if (wt.split(/[/\\]/).includes("..") || /%2e%2e/i.test(wt)) {
      return fail(validation("Developer 'worktreePath' must not contain '..' path traversal segments"));
    }
    if (
      /[\0\r\n"\\]/.test(wt) ||
      wt.startsWith("~") ||
      /^[a-zA-Z]:/.test(wt) ||
      /%2e/i.test(wt) ||
      /^\/(etc|proc|root|sys|dev|boot|run|var\/run)(\/|$)/i.test(wt)
    ) {
      return fail(validation("Developer 'worktreePath' must be a safe POSIX path without NUL, backslashes, or system root paths"));
    }
    const rawSegments = wt.startsWith("/") ? wt.slice(1).split("/") : wt.split("/");
    if (rawSegments.length === 0 || rawSegments.some((seg) => seg.trim() === "" || seg.trim() === "." || seg.trim() === "..")) {
      return fail(validation("Developer 'worktreePath' must not contain '..' or '.' path traversal segments"));
    }
    validatedWorktreePath = wt;

    if (d.branchName !== undefined) {
      if (typeof d.branchName !== "string" || d.branchName.trim().length === 0) {
        return fail(validation("Developer 'branchName' must be a non-empty string if provided"));
      }
      if (/[\r\n\0"\\]/.test(d.branchName) || d.branchName.includes("..")) {
        return fail(validation("Developer 'branchName' must be a safe branch name without control characters, quotes, backslashes, or '..'"));
      }
    }
    if (d.repositoryContext !== undefined && (typeof d.repositoryContext !== "string" || d.repositoryContext.trim().length === 0)) {
      return fail(validation("Developer 'repositoryContext' must be a non-empty string if provided"));
    }
    if (d.reworkFeedback !== undefined && (typeof d.reworkFeedback !== "string" || d.reworkFeedback.trim().length === 0)) {
      return fail(validation("Developer 'reworkFeedback' must be a non-empty string if provided"));
    }

    textFieldsToScan.push({ fieldName: "taskTitle", content: d.taskTitle });
    if (d.taskDescription) textFieldsToScan.push({ fieldName: "taskDescription", content: d.taskDescription });
    textFieldsToScan.push({ fieldName: "instruction", content: d.instruction });
    textFieldsToScan.push({ fieldName: "worktreePath", content: wt });
    if (d.branchName !== undefined) textFieldsToScan.push({ fieldName: "branchName", content: d.branchName });
    if (d.repositoryContext) textFieldsToScan.push({ fieldName: "repositoryContext", content: d.repositoryContext });
    if (d.reworkFeedback) textFieldsToScan.push({ fieldName: "reworkFeedback", content: d.reworkFeedback });
  } else if (role === "reviewer") {
    const r = params as ReviewerPromptParams;
    if (typeof r.taskTitle !== "string" || r.taskTitle.trim().length === 0) {
      return fail(validation("Reviewer 'taskTitle' must be a non-empty string"));
    }
    if (!Array.isArray(r.acceptanceCriteria) || r.acceptanceCriteria.length === 0) {
      return fail(validation("Reviewer 'acceptanceCriteria' must contain at least 1 item"));
    }
    for (let i = 0; i < r.acceptanceCriteria.length; i++) {
      const ac = r.acceptanceCriteria[i];
      if (typeof ac !== "string" || ac.trim().length === 0) {
        return fail(validation(`Reviewer 'acceptanceCriteria[${i}]' must be a non-empty string`));
      }
      textFieldsToScan.push({ fieldName: `acceptanceCriteria[${i}]`, content: ac });
    }
    if (typeof r.commitSha !== "string" || !/^[0-9a-f]{7,40}$/i.test(r.commitSha.trim())) {
      return fail(validation("Reviewer 'commitSha' must be a 7-to-40 character hexadecimal string"));
    }
    if (!Array.isArray(r.changedFiles) || r.changedFiles.length === 0) {
      return fail(validation("Reviewer 'changedFiles' must contain at least 1 file path"));
    }
    for (let i = 0; i < r.changedFiles.length; i++) {
      const cf = r.changedFiles[i];
      if (typeof cf !== "string" || cf.trim().length === 0) {
        return fail(validation(`Reviewer 'changedFiles[${i}]' must be a non-empty string`));
      }
      const trimmed = cf.trim();
      if (
        trimmed.startsWith("/") ||
        trimmed.startsWith("\\") ||
        /[\r\n\0"]/.test(trimmed) ||
        trimmed.split(/[/\\]/).some((seg) => seg === "..")
      ) {
        return fail(validation(`Reviewer 'changedFiles[${i}]' must be a clean relative path without leading slashes, '..', or control characters`));
      }
    }
    if (typeof r.diffSummary !== "string" || r.diffSummary.trim().length === 0) {
      return fail(validation("Reviewer 'diffSummary' must be a non-empty string"));
    }
    if (r.repositoryContext !== undefined && (typeof r.repositoryContext !== "string" || r.repositoryContext.trim().length === 0)) {
      return fail(validation("Reviewer 'repositoryContext' must be a non-empty string if provided"));
    }

    textFieldsToScan.push({ fieldName: "taskTitle", content: r.taskTitle });
    textFieldsToScan.push({ fieldName: "commitSha", content: r.commitSha.trim() });
    for (let i = 0; i < r.changedFiles.length; i++) {
      textFieldsToScan.push({ fieldName: `changedFiles[${i}]`, content: r.changedFiles[i].trim() });
    }
    textFieldsToScan.push({ fieldName: "diffSummary", content: r.diffSummary });
    if (r.repositoryContext) textFieldsToScan.push({ fieldName: "repositoryContext", content: r.repositoryContext });
  } else if (role === "qa") {
    const q = params as QaPromptParams;
    if (typeof q.taskTitle !== "string" || q.taskTitle.trim().length === 0) {
      return fail(validation("QA 'taskTitle' must be a non-empty string"));
    }
    if (!Array.isArray(q.acceptanceCriteria) || q.acceptanceCriteria.length === 0) {
      return fail(validation("QA 'acceptanceCriteria' must contain at least 1 item"));
    }
    for (let i = 0; i < q.acceptanceCriteria.length; i++) {
      const ac = q.acceptanceCriteria[i];
      if (typeof ac !== "string" || ac.trim().length === 0) {
        return fail(validation(`QA 'acceptanceCriteria[${i}]' must be a non-empty string`));
      }
      textFieldsToScan.push({ fieldName: `acceptanceCriteria[${i}]`, content: ac });
    }
    if (typeof q.testExecutionSummary !== "string" || q.testExecutionSummary.trim().length === 0) {
      return fail(validation("QA 'testExecutionSummary' must be a non-empty string"));
    }
    if (q.repositoryContext !== undefined && (typeof q.repositoryContext !== "string" || q.repositoryContext.trim().length === 0)) {
      return fail(validation("QA 'repositoryContext' must be a non-empty string if provided"));
    }

    textFieldsToScan.push({ fieldName: "taskTitle", content: q.taskTitle });
    textFieldsToScan.push({ fieldName: "testExecutionSummary", content: q.testExecutionSummary });
    if (q.repositoryContext) textFieldsToScan.push({ fieldName: "repositoryContext", content: q.repositoryContext });
  }

  // Validate input artifacts
  const inputArtifacts = params.inputArtifacts ?? [];
  if (!Array.isArray(inputArtifacts)) {
    return fail(validation("Input artifacts must be an array"));
  }
  const seenArtifactIds = new Set<string>();
  const validatedArtifacts: ArtifactReference[] = [];
  for (const artifact of inputArtifacts) {
    if (typeof artifact !== "object" || artifact === null) {
      return fail(validation("Input artifact reference must be a non-null object"));
    }
    const rec = artifact as Record<string, unknown>;
    if ("proposalId" in rec || rec.trust !== "stored") {
      return fail(
        validation(
          `Input artifacts must be stored ArtifactReference values with trust === 'stored'; received ArtifactProposal or unstored artifact '${String(rec.artifactId ?? rec.proposalId ?? "unknown")}'`
        )
      );
    }
    const artifactParsed = ArtifactReferenceSchema.safeParse(artifact);
    if (!artifactParsed.success) {
      return fail(validation(`Invalid input artifact reference: ${artifactParsed.error.message}`));
    }
    if (seenArtifactIds.has(artifactParsed.data.artifactId)) {
      return fail(validation(`Duplicate artifactId '${artifactParsed.data.artifactId}' in inputArtifacts`));
    }
    seenArtifactIds.add(artifactParsed.data.artifactId);

    if (artifactParsed.data.runId !== runIdParsed.data) {
      return fail(
        validation(`Input artifact runId '${artifactParsed.data.runId}' does not match prompt runId '${runIdParsed.data}'`)
      );
    }
    if (!profile.allowedInputArtifactKinds.includes(artifactParsed.data.kind)) {
      return fail(
        validation(`Artifact kind '${artifactParsed.data.kind}' is not allowed as input for role '${role}'`)
      );
    }
    validatedArtifacts.push(artifactParsed.data);
  }
  const inputArtifactUris = Object.freeze(validatedArtifacts.map((a) => a.uri));

  // Dangerous instruction detection across all text fields
  const allFindings: DangerousInstructionFinding[] = [];
  for (const item of textFieldsToScan) {
    const report = detectDangerousInstructions(item.content);
    for (const finding of report.findings) {
      allFindings.push(finding);
    }
  }

  const safetyReport: ContentSafetyReport = {
    safe: allFindings.length === 0,
    findings: Object.freeze(allFindings)
  };

  const rejectDangerous = options?.rejectDangerousRepositoryContent !== false;
  if (rejectDangerous && !safetyReport.safe) {
    const sampleViolation = textFieldsToScan.find((t) => !detectDangerousInstructions(t.content).safe);
    if (sampleViolation) {
      const policyFail = validateUntrustedContentPolicy(sampleViolation.content, {
        rejectOnDangerousInstruction: true,
        fieldName: sampleViolation.fieldName
      });
      if (!policyFail.ok) {
        return policyFail;
      }
    }
    const details = safetyReport.findings
      .map((f) => `[${f.category}] ${f.message} (matched: "${f.matchedText}")`)
      .join("; ");
    return fail(validation(`Dangerous instructions detected in prompt content: ${details}`));
  }

  // Build role-specific prompt sections
  let promptBody = "";

  if (role === "planner") {
    const p = params as PlannerPromptParams;
    const constraintsSection = p.constraints && p.constraints.length > 0
      ? p.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")
      : "None specified.";

    const wrappedRepo = wrapUntrustedRepositoryContent("repository_context", p.repositoryContext);

    promptBody = `## Planner Parameters
- Run ID: ${runIdParsed.data}
- Workflow Kind: ${p.workflowKind}

### Requirement
${p.requirement}

### Architectural & Operational Constraints
${constraintsSection}

### Repository Context
${wrappedRepo}

## Output Format
Return ONLY a valid JSON object matching this schema:
\`\`\`json
{
  "role": "planner",
  "summary": "<High-level summary of the implementation strategy>",
  "tasks": [
    {
      "id": "<unique-task-identifier>",
      "title": "<Concise task title>",
      "description": "<Detailed task description>",
      "role": "developer" | "reviewer" | "qa",
      "instruction": "<Actionable task instruction>",
      "acceptanceCriteria": [
        "<Acceptance criterion 1>",
        "<Independent test verification requirement>"
      ]
    }
  ],
  "dependencies": [
    {
      "taskId": "<dependent-task-id>",
      "dependsOnTaskId": "<prerequisite-task-id>",
      "condition": "succeeded"
    }
  ],
  "consumedArtifactIds": [],
  "artifactProposals": []
}
\`\`\``;
  } else if (role === "developer") {
    const d = params as DeveloperPromptParams;
    const criteriaSection = d.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");
    const reworkSection = d.reworkFeedback
      ? `\n### Rework Feedback\n${wrapUntrustedRepositoryContent("rework_feedback", d.reworkFeedback)}\n`
      : "";
    const repoSection = d.repositoryContext
      ? `\n### Repository Context\n${wrapUntrustedRepositoryContent("repository_context", d.repositoryContext)}\n`
      : "";

    promptBody = `## Developer Task Parameters
- Run ID: ${runIdParsed.data}
- Task ID: ${validatedTaskId}
- Task Title: ${d.taskTitle}
- Task Description: ${d.taskDescription ?? "N/A"}
- Assigned Worktree Path: ${validatedWorktreePath}
- Target Branch: ${d.branchName ?? "HEAD"}

### Implementation Instruction
${d.instruction}

### Acceptance Criteria
${criteriaSection}
${reworkSection}${repoSection}
## Output Format
Return ONLY a valid JSON object matching this schema:
\`\`\`json
{
  "role": "developer",
  "taskId": "${validatedTaskId}",
  "worktreePath": "${validatedWorktreePath}",
  "commit": {
    "sha": "<7-to-40-hex-commit-sha>",
    "message": "<Commit message>",
    "branch": "${d.branchName ?? "HEAD"}"
  },
  "changedFiles": [
    {
      "path": "<relative/path/to/file>",
      "changeType": "added" | "modified" | "deleted" | "renamed"
    }
  ],
  "testReport": {
    "command": "<test-command-executed>",
    "exitCode": 0,
    "passed": 1,
    "failed": 0,
    "skipped": 0,
    "selfReportedOnly": true
  },
  "consumedArtifactIds": [],
  "artifactProposals": []
}
\`\`\``;
  } else if (role === "reviewer") {
    const r = params as ReviewerPromptParams;
    const criteriaSection = r.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");
    const filesSection = r.changedFiles.map((f) => `- ${f}`).join("\n");
    const wrappedDiff = wrapUntrustedRepositoryContent("diff_summary", r.diffSummary);
    const repoSection = r.repositoryContext
      ? `\n### Repository Context\n${wrapUntrustedRepositoryContent("repository_context", r.repositoryContext)}\n`
      : "";

    promptBody = `## Reviewer Task Parameters
- Run ID: ${runIdParsed.data}
- Task ID: ${validatedTaskId}
- Task Title: ${r.taskTitle}
- Commit SHA: ${r.commitSha}

### Changed Files
${filesSection}

### Acceptance Criteria to Verify
${criteriaSection}

### Diff Summary
${wrappedDiff}
${repoSection}
## Output Format
Return ONLY a valid JSON object matching this schema:
\`\`\`json
{
  "role": "reviewer",
  "taskId": "${validatedTaskId}",
  "decision": "approved" | "changes_requested",
  "summary": "<Review findings summary and rationale for decision>",
  "criteriaEvaluation": [
    {
      "criterion": "<Acceptance criterion text>",
      "met": true,
      "evidence": "<Concrete code/test evidence>"
    }
  ],
  "findings": [
    {
      "category": "logic" | "security" | "maintainability",
      "severity": "info" | "warning" | "error",
      "message": "<Actionable review finding>",
      "file": "<relative/path/to/file>",
      "line": 1,
      "evidence": "<Code snippet or line reference>"
    }
  ],
  "modifiedFiles": [],
  "consumedArtifactIds": [],
  "artifactProposals": []
}
\`\`\``;
  } else if (role === "qa") {
    const q = params as QaPromptParams;
    const criteriaSection = q.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");
    const wrappedTest = wrapUntrustedRepositoryContent("test_execution_summary", q.testExecutionSummary);
    const repoSection = q.repositoryContext
      ? `\n### Repository Context\n${wrapUntrustedRepositoryContent("repository_context", q.repositoryContext)}\n`
      : "";

    promptBody = `## QA Task Parameters
- Run ID: ${runIdParsed.data}
- Task ID: ${validatedTaskId}
- Task Title: ${q.taskTitle}

### Acceptance Criteria to Verify
${criteriaSection}

### Test Execution Summary & Runner Output
${wrappedTest}
${repoSection}
## Output Format
Return ONLY a valid JSON object matching this schema:
\`\`\`json
{
  "role": "qa",
  "taskId": "${validatedTaskId}",
  "verdict": "passed" | "failed",
  "summary": "<Summary of verification results and evaluation of test evidence>",
  "criteriaVerification": [
    {
      "criterion": "<Exact acceptance criterion text>",
      "passed": true,
      "evidence": "<Specific evidence from test logs verifying criterion>"
    }
  ],
  "testVerification": {
    "independentRunVerified": true,
    "command": "<test-command>",
    "exitCode": 0,
    "passedCount": 1,
    "failedCount": 0,
    "skippedCount": 0,
    "evidence": "<Verified runner output summary>",
    "evidenceArtifactIds": ["<artifact-id>"]
  },
  "consumedArtifactIds": [],
  "artifactProposals": []
}
\`\`\``;
  }

  // Role constraints summary
  let roleConstraintsText = "";
  const handoffConstraintsText =
    "- Structured Herdr handoff required: Emit a structured result containing all required fields: status, summary, evidence, artifacts, blockers, requested_action, next_role.";

  if (role === "planner") {
    roleConstraintsText = `- READ-ONLY ROLE: Do NOT modify repository files. Focus solely on workflow DAG decomposition.\n- Task delegation outside workflow scope is strictly prohibited.\n${handoffConstraintsText}`;
  } else if (role === "developer") {
    roleConstraintsText = `- CONFINED WORKSPACE: Modify files ONLY inside assigned worktreePath '${validatedWorktreePath}'. Modifying files outside this directory is strictly prohibited.\n- Independent test execution evidence is required for all changes.\n- Task delegation outside workflow scope is strictly prohibited.\n${handoffConstraintsText}`;
  } else if (role === "reviewer") {
    roleConstraintsText = `- READ-ONLY ROLE: Do NOT modify any source files. Your output 'modifiedFiles' must be strictly [].\n- Evaluate changes strictly against the provided acceptance criteria.\n- Task delegation outside workflow scope is strictly prohibited.\n${handoffConstraintsText}`;
  } else if (role === "qa") {
    roleConstraintsText = `- READ-ONLY ROLE: Do NOT modify repository files.\n- INDEPENDENT VERIFICATION: Do NOT assume agent self-assertions prove test success; verify independent test execution evidence.\n- Task delegation outside workflow scope is strictly prohibited.\n${handoffConstraintsText}`;
  }

  const prompt = `# ROLE: ${profile.title} (${role})

## Mission
${profile.description}

## Non-User-Facing Autonomous Execution Policy
${NON_USER_FACING_AUTONOMOUS_POLICY}

## Role Constraints
${roleConstraintsText}

## Core Safety Rules
${UNTRUSTED_CONTENT_SAFETY_RULES.map((rule, idx) => `${idx + 1}. ${rule}`).join("\n")}

## Input Artifacts
${formatArtifactList(validatedArtifacts)}

${promptBody}`;

  return ok({
    role,
    prompt,
    safetyRules: UNTRUSTED_CONTENT_SAFETY_RULES,
    inputArtifactUris,
    safetyReport
  });
}
