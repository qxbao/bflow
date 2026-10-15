import {
  AgentResultSchema,
  ApprovalDecisionSchema,
  ArtifactIdSchema,
  ArtifactProposalSchema,
  IdentifierSchema,
  QualityGateResultSchema,
  TaskDependencySchema,
  type AgentResult,
  type ApprovalDecision,
  type ArtifactProposal,
  type ArtifactReference,
  type JsonValue,
  type OperationResult,
  type QualityFinding,
  type QualityGateResult,
  type SubmissionCorrelation,
  type TaskDependency
} from "@ai-flow/contracts";
import { getMvpRoleProfile, isMvpRole, type MvpRole } from "./roles.js";

export interface PlannedTaskItem {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly role: MvpRole;
  readonly instruction: string;
  readonly acceptanceCriteria: readonly string[];
  readonly requiresApproval?: boolean;
}

export interface PlannerOutput {
  readonly role: "planner";
  readonly summary: string;
  readonly tasks: readonly PlannedTaskItem[];
  readonly dependencies: readonly TaskDependency[];
  readonly consumedArtifactIds: readonly string[];
  readonly artifactProposals: readonly ArtifactProposal[];
}

export interface DeveloperChangedFile {
  readonly path: string;
  readonly changeType: "added" | "modified" | "deleted" | "renamed";
}

export interface DeveloperTestReport {
  readonly command: string;
  readonly exitCode: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly selfReportedOnly: true;
  readonly evidenceArtifactName?: string;
}

export interface DeveloperOutput {
  readonly role: "developer";
  readonly taskId: string;
  readonly worktreePath: string;
  readonly commit: {
    readonly sha: string;
    readonly message: string;
    readonly branch?: string;
  };
  readonly changedFiles: readonly DeveloperChangedFile[];
  readonly testReport: DeveloperTestReport;
  readonly consumedArtifactIds: readonly string[];
  readonly artifactProposals: readonly ArtifactProposal[];
}

export interface ReviewCriterionEvaluation {
  readonly criterion: string;
  readonly met: boolean;
  readonly evidence: string;
}

export interface ReviewerFinding {
  readonly category: "logic" | "security" | "maintainability";
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly evidence: string;
}

export interface ReviewerOutput {
  readonly role: "reviewer";
  readonly taskId: string;
  readonly decision: "approved" | "changes_requested";
  readonly summary: string;
  readonly criteriaEvaluation: readonly ReviewCriterionEvaluation[];
  readonly findings: readonly ReviewerFinding[];
  readonly modifiedFiles: readonly [];
  readonly consumedArtifactIds: readonly string[];
  readonly artifactProposals: readonly ArtifactProposal[];
}

export interface QaCriterionVerification {
  readonly criterion: string;
  readonly passed: boolean;
  readonly evidence: string;
}

export interface QaTestVerification {
  readonly independentRunVerified: boolean;
  readonly command: string;
  readonly exitCode: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly skippedCount?: number;
  readonly evidence: string;
  readonly evidenceArtifactIds: readonly string[];
}

export interface QaOutput {
  readonly role: "qa";
  readonly taskId: string;
  readonly verdict: "passed" | "failed";
  readonly summary: string;
  readonly criteriaVerification: readonly QaCriterionVerification[];
  readonly testVerification: QaTestVerification;
  readonly consumedArtifactIds: readonly string[];
  readonly artifactProposals: readonly ArtifactProposal[];
}

export type RoleStructuredOutput = PlannerOutput | DeveloperOutput | ReviewerOutput | QaOutput;

export interface RoleOutputMap {
  readonly planner: PlannerOutput;
  readonly developer: DeveloperOutput;
  readonly reviewer: ReviewerOutput;
  readonly qa: QaOutput;
}

export interface RoleOutputValidationContext {
  readonly runId?: string;
  readonly expectedTaskId?: string;
  readonly assignedWorktreePath?: string;
  readonly availableInputArtifacts?: readonly ArtifactReference[];
  readonly expectedAcceptanceCriteria?: readonly string[];
}

function failure<T>(message: string, details?: JsonValue): OperationResult<T> {
  return {
    ok: false,
    error: {
      code: "validation",
      retryable: false,
      message,
      ...(details !== undefined ? { details } : {})
    }
  };
}

function success<T>(value: T): OperationResult<T> {
  return { ok: true, value };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkDisallowedKeys(
  obj: Record<string, unknown>,
  allowedKeys: readonly string[],
  scope: string
): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) {
      return `Unknown key '${key}' on ${scope}`;
    }
  }
  return null;
}

function hasDelegationField(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if ("delegatedTasks" in value || "delegation" in value || "subagents" in value || "delegate" in value) {
    return true;
  }
  for (const child of Object.values(value)) {
    if (hasDelegationField(child)) {
      return true;
    }
  }
  return false;
}

function validateConsumedArtifacts(
  rawIds: unknown,
  availableArtifacts?: readonly ArtifactReference[]
): OperationResult<readonly string[]> {
  if (rawIds === undefined) {
    return success([]);
  }
  if (!Array.isArray(rawIds)) {
    return failure("consumedArtifactIds must be an array of artifact IDs");
  }
  const result: string[] = [];
  const seenIds = new Set<string>();
  const availableSet = availableArtifacts ? new Set(availableArtifacts.map((a) => a.artifactId)) : null;

  for (let i = 0; i < rawIds.length; i++) {
    const id = rawIds[i];
    if (typeof id !== "string") {
      return failure(`consumedArtifactIds[${i}] must be a string`);
    }
    const parseRes = ArtifactIdSchema.safeParse(id);
    if (!parseRes.success) {
      return failure(`consumedArtifactIds[${i}] is not a valid artifact ID: ${parseRes.error.message}`);
    }
    if (seenIds.has(parseRes.data)) {
      return failure(`Duplicate artifactId in consumedArtifactIds: '${parseRes.data}'`);
    }
    seenIds.add(parseRes.data);
    if (availableSet && !availableSet.has(id)) {
      return failure(`Consumed artifact '${id}' is not available in input artifacts`);
    }
    result.push(parseRes.data);
  }
  return success(result);
}

function validateArtifactProposals(
  rawProposals: unknown,
  role: MvpRole,
  context?: RoleOutputValidationContext
): OperationResult<readonly ArtifactProposal[]> {
  if (rawProposals === undefined) {
    return success([]);
  }
  if (!Array.isArray(rawProposals)) {
    return failure("artifactProposals must be an array");
  }
  const result: ArtifactProposal[] = [];
  const seenProposalIds = new Set<string>();
  const profile = getMvpRoleProfile(role);

  for (let i = 0; i < rawProposals.length; i++) {
    const p = rawProposals[i];
    const parseRes = ArtifactProposalSchema.safeParse(p);
    if (!parseRes.success) {
      return failure(`artifactProposals[${i}] is invalid: ${parseRes.error.message}`);
    }
    const proposal = parseRes.data;
    if (seenProposalIds.has(proposal.proposalId)) {
      return failure(`Duplicate proposalId in artifactProposals: '${proposal.proposalId}'`);
    }
    seenProposalIds.add(proposal.proposalId);

    if (context?.runId !== undefined && proposal.runId !== context.runId) {
      return failure(
        `Artifact proposal runId '${proposal.runId}' does not match context runId '${context.runId}'`
      );
    }
    if (
      context?.expectedTaskId !== undefined &&
      proposal.taskId !== undefined &&
      proposal.taskId !== context.expectedTaskId
    ) {
      return failure(
        `Artifact proposal taskId '${proposal.taskId}' does not match expected taskId '${context.expectedTaskId}'`
      );
    }
    if (!profile.producedArtifactKinds.includes(proposal.kind)) {
      return failure(
        `Artifact proposal kind '${proposal.kind}' is not produced by role '${role}'. Allowed kinds: ${profile.producedArtifactKinds.join(", ")}`
      );
    }
    result.push(proposal);
  }
  return success(result);
}

function validatePlannerOutput(
  raw: Record<string, unknown>,
  context?: RoleOutputValidationContext
): OperationResult<PlannerOutput> {
  const allowed = ["role", "summary", "tasks", "dependencies", "consumedArtifactIds", "artifactProposals"];
  const keyError = checkDisallowedKeys(raw, allowed, "planner output");
  if (keyError) return failure(keyError);

  if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) {
    return failure("Planner output summary must be a non-empty string");
  }

  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    return failure("Planner output tasks must be a non-empty array");
  }

  const taskIds = new Set<string>();
  const tasks: PlannedTaskItem[] = [];
  const plannedTaskAllowedKeys = [
    "id",
    "title",
    "description",
    "role",
    "instruction",
    "acceptanceCriteria",
    "requiresApproval"
  ];

  for (let i = 0; i < raw.tasks.length; i++) {
    const item = raw.tasks[i];
    if (!isPlainObject(item)) {
      return failure(`Planner tasks[${i}] must be an object`);
    }
    const itemKeyErr = checkDisallowedKeys(item, plannedTaskAllowedKeys, `planner task[${i}]`);
    if (itemKeyErr) return failure(itemKeyErr);

    const idRes = IdentifierSchema.safeParse(item.id);
    if (!idRes.success) {
      return failure(`Planner task[${i}] id is invalid: ${idRes.error.message}`);
    }
    if (taskIds.has(idRes.data)) {
      return failure(`Duplicate task id in planner output: '${idRes.data}'`);
    }
    taskIds.add(idRes.data);

    if (!isMvpRole(item.role)) {
      return failure(`Planner task[${i}] has invalid role '${item.role}'. Only MVP roles are permitted.`);
    }

    if (typeof item.title !== "string" || item.title.trim().length === 0) {
      return failure(`Planner task[${i}] title must be a non-empty string`);
    }

    if (item.description !== undefined && typeof item.description !== "string") {
      return failure(`Planner task[${i}] description must be a string if provided`);
    }

    if (typeof item.instruction !== "string" || item.instruction.trim().length === 0) {
      return failure(`Planner task[${i}] instruction must be a non-empty string`);
    }

    if (!Array.isArray(item.acceptanceCriteria) || item.acceptanceCriteria.length === 0) {
      return failure(`Planner task[${i}] acceptanceCriteria must be a non-empty array of strings`);
    }
    for (let c = 0; c < item.acceptanceCriteria.length; c++) {
      const crit = item.acceptanceCriteria[c];
      if (typeof crit !== "string" || crit.trim().length === 0) {
        return failure(`Planner task[${i}] acceptanceCriteria[${c}] must be a non-empty string`);
      }
    }

    if (item.requiresApproval !== undefined && typeof item.requiresApproval !== "boolean") {
      return failure(`Planner task[${i}] requiresApproval must be a boolean if provided`);
    }

    let requiresApproval = item.requiresApproval;
    if (item.role === "reviewer") {
      if (item.requiresApproval === false) {
        return failure(`Planner reviewer task '${idRes.data}' must have requiresApproval: true`);
      }
      if (item.requiresApproval === undefined) {
        requiresApproval = true;
      }
    }

    tasks.push({
      id: idRes.data,
      title: item.title,
      ...(item.description !== undefined ? { description: item.description } : {}),
      role: item.role,
      instruction: item.instruction,
      acceptanceCriteria: item.acceptanceCriteria,
      ...(requiresApproval !== undefined ? { requiresApproval } : {})
    });
  }

  if (!tasks.some((t) => t.role === "developer")) {
    return failure("Planner output must include at least one 'developer' task");
  }

  const rawDeps = raw.dependencies ?? [];
  if (!Array.isArray(rawDeps)) {
    return failure("Planner output dependencies must be an array");
  }

  const dependencies: TaskDependency[] = [];
  const edgeKeys = new Set<string>();
  const adj = new Map<string, string[]>();
  for (const id of taskIds) {
    adj.set(id, []);
  }

  for (let i = 0; i < rawDeps.length; i++) {
    const dep = rawDeps[i];
    const depParse = TaskDependencySchema.safeParse(dep);
    if (!depParse.success) {
      return failure(`Planner dependency[${i}] is invalid: ${depParse.error.message}`);
    }
    const d = depParse.data;
    if (!taskIds.has(d.taskId)) {
      return failure(`Planner dependency[${i}] taskId '${d.taskId}' does not exist in planned tasks`);
    }
    if (!taskIds.has(d.dependsOnTaskId)) {
      return failure(
        `Planner dependency[${i}] dependsOnTaskId '${d.dependsOnTaskId}' does not exist in planned tasks`
      );
    }
    if (d.taskId === d.dependsOnTaskId) {
      return failure(`Planner dependency[${i}] taskId cannot depend on itself: '${d.taskId}'`);
    }
    const edgeKey = `${d.taskId}\0${d.dependsOnTaskId}\0${d.condition}`;
    if (edgeKeys.has(edgeKey)) {
      return failure(`Duplicate dependency edge in planner output: '${d.taskId}' -> '${d.dependsOnTaskId}'`);
    }
    edgeKeys.add(edgeKey);
    dependencies.push(d);
    adj.get(d.taskId)?.push(d.dependsOnTaskId);
  }

  // Cycle detection
  const visited = new Set<string>();
  const recStack = new Set<string>();
  function hasCycle(node: string): boolean {
    visited.add(node);
    recStack.add(node);
    for (const prereq of adj.get(node) ?? []) {
      if (!visited.has(prereq) && hasCycle(prereq)) {
        return true;
      }
      if (recStack.has(prereq)) {
        return true;
      }
    }
    recStack.delete(node);
    return false;
  }

  for (const taskId of taskIds) {
    if (!visited.has(taskId)) {
      if (hasCycle(taskId)) {
        return failure("Cycle detected in planner task dependencies");
      }
    }
  }

  const ROLE_STAGE_ORDER: Readonly<Record<MvpRole, number>> = {
    planner: 0,
    developer: 1,
    reviewer: 2,
    qa: 3
  };
  const taskRoleById = new Map<string, MvpRole>();
  for (const t of tasks) {
    taskRoleById.set(t.id, t.role);
  }

  for (const d of dependencies) {
    const childRole = taskRoleById.get(d.taskId)!;
    const parentRole = taskRoleById.get(d.dependsOnTaskId)!;
    if (ROLE_STAGE_ORDER[childRole] < ROLE_STAGE_ORDER[parentRole]) {
      return failure(
        `Invalid role dependency order: '${d.taskId}' (${childRole}) cannot depend on later stage '${d.dependsOnTaskId}' (${parentRole})`
      );
    }
  }

  function canReachRole(startTaskId: string, targetRoles: readonly MvpRole[]): boolean {
    const queue = [startTaskId];
    const seen = new Set<string>([startTaskId]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const prereq of adj.get(current) ?? []) {
        const prereqRole = taskRoleById.get(prereq);
        if (prereqRole && targetRoles.includes(prereqRole)) {
          return true;
        }
        if (!seen.has(prereq)) {
          seen.add(prereq);
          queue.push(prereq);
        }
      }
    }
    return false;
  }

  for (const t of tasks) {
    if (t.role === "reviewer") {
      if (!canReachRole(t.id, ["developer"])) {
        return failure(`Reviewer task '${t.id}' must depend on at least one 'developer' task`);
      }
    } else if (t.role === "qa") {
      if (!canReachRole(t.id, ["reviewer", "developer"])) {
        return failure(`QA task '${t.id}' must depend on at least one 'reviewer' or 'developer' task`);
      }
    }
  }

  const consumedRes = validateConsumedArtifacts(raw.consumedArtifactIds, context?.availableInputArtifacts);
  if (!consumedRes.ok) return consumedRes;

  const proposalsRes = validateArtifactProposals(raw.artifactProposals, "planner", context);
  if (!proposalsRes.ok) return proposalsRes;

  return success({
    role: "planner",
    summary: raw.summary,
    tasks,
    dependencies,
    consumedArtifactIds: consumedRes.value,
    artifactProposals: proposalsRes.value
  });
}

function validateDeveloperOutput(
  raw: Record<string, unknown>,
  context?: RoleOutputValidationContext
): OperationResult<DeveloperOutput> {
  const allowed = [
    "role",
    "taskId",
    "worktreePath",
    "commit",
    "changedFiles",
    "testReport",
    "consumedArtifactIds",
    "artifactProposals"
  ];
  const keyError = checkDisallowedKeys(raw, allowed, "developer output");
  if (keyError) return failure(keyError);

  const taskIdRes = IdentifierSchema.safeParse(raw.taskId);
  if (!taskIdRes.success) {
    return failure(`Developer taskId is invalid: ${taskIdRes.error.message}`);
  }
  if (context?.expectedTaskId !== undefined && taskIdRes.data !== context.expectedTaskId) {
    return failure(`Developer taskId '${taskIdRes.data}' does not match expected taskId '${context.expectedTaskId}'`);
  }

  if (typeof raw.worktreePath !== "string" || raw.worktreePath.trim().length === 0) {
    return failure("Developer worktreePath must be a non-empty string");
  }
  if (raw.worktreePath.includes("\0") || raw.worktreePath !== raw.worktreePath.trim()) {
    return failure("Developer worktreePath must be trimmed and not contain NUL characters");
  }
  if (raw.worktreePath.split("/").includes("..") || raw.worktreePath.split("\\").includes("..")) {
    return failure("Developer worktreePath must not contain '..' path segments");
  }
  if (context?.assignedWorktreePath !== undefined && raw.worktreePath !== context.assignedWorktreePath) {
    return failure(
      `Developer worktreePath '${raw.worktreePath}' does not match assigned worktreePath '${context.assignedWorktreePath}'`
    );
  }

  if (!isPlainObject(raw.commit)) {
    return failure("Developer commit must be an object");
  }
  const commitKeyErr = checkDisallowedKeys(raw.commit, ["sha", "message", "branch"], "developer commit");
  if (commitKeyErr) return failure(commitKeyErr);

  if (typeof raw.commit.sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(raw.commit.sha)) {
    return failure("Developer commit sha must be a valid 7-40 char hex git SHA");
  }
  if (typeof raw.commit.message !== "string" || raw.commit.message.trim().length === 0) {
    return failure("Developer commit message must be a non-empty string");
  }
  if (raw.commit.branch !== undefined && typeof raw.commit.branch !== "string") {
    return failure("Developer commit branch must be a string if provided");
  }

  if (!Array.isArray(raw.changedFiles) || raw.changedFiles.length === 0) {
    return failure("Developer changedFiles must be a non-empty array");
  }
  const changedFiles: DeveloperChangedFile[] = [];
  const seenPaths = new Set<string>();
  const validChangeTypes = ["added", "modified", "deleted", "renamed"] as const;
  for (let i = 0; i < raw.changedFiles.length; i++) {
    const file = raw.changedFiles[i];
    if (!isPlainObject(file)) {
      return failure(`Developer changedFiles[${i}] must be an object`);
    }
    const fileKeyErr = checkDisallowedKeys(file, ["path", "changeType"], `developer changedFiles[${i}]`);
    if (fileKeyErr) return failure(fileKeyErr);

    if (
      typeof file.path !== "string" ||
      file.path.trim().length === 0 ||
      file.path !== file.path.trim() ||
      file.path.includes("\0") ||
      file.path.startsWith("/") ||
      file.path.startsWith("\\") ||
      /^[a-zA-Z]:/.test(file.path) ||
      file.path.split(/[\\/]/).some((seg) => seg === "" || seg === "." || seg === "..")
    ) {
      return failure(
        `Developer changedFiles[${i}] path must be a non-empty relative path without '..' segments`
      );
    }
    if (seenPaths.has(file.path)) {
      return failure(`Duplicate path in developer changedFiles: '${file.path}'`);
    }
    seenPaths.add(file.path);
    if (typeof file.changeType !== "string" || !validChangeTypes.includes(file.changeType as DeveloperChangedFile["changeType"])) {
      return failure(`Developer changedFiles[${i}] changeType must be one of: ${validChangeTypes.join(", ")}`);
    }
    changedFiles.push({
      path: file.path,
      changeType: file.changeType as DeveloperChangedFile["changeType"]
    });
  }

  if (!isPlainObject(raw.testReport)) {
    return failure("Developer testReport must be an object");
  }
  const report = raw.testReport;
  const reportKeyErr = checkDisallowedKeys(
    report,
    ["command", "exitCode", "passed", "failed", "skipped", "selfReportedOnly", "evidenceArtifactName"],
    "developer testReport"
  );
  if (reportKeyErr) return failure(reportKeyErr);

  if (typeof report.command !== "string" || report.command.trim().length === 0) {
    return failure("Developer testReport command must be a non-empty string");
  }
  if (typeof report.exitCode !== "number" || !Number.isSafeInteger(report.exitCode)) {
    return failure("Developer testReport exitCode must be an integer");
  }
  if (typeof report.passed !== "number" || !Number.isSafeInteger(report.passed) || report.passed < 0) {
    return failure("Developer testReport passed must be a non-negative integer");
  }
  if (typeof report.failed !== "number" || !Number.isSafeInteger(report.failed) || report.failed < 0) {
    return failure("Developer testReport failed must be a non-negative integer");
  }
  if (typeof report.skipped !== "number" || !Number.isSafeInteger(report.skipped) || report.skipped < 0) {
    return failure("Developer testReport skipped must be a non-negative integer");
  }
  if (report.selfReportedOnly !== true) {
    return failure(
      "Developer testReport selfReportedOnly must be true (developer self-report is never treated as verified test success)"
    );
  }
  if (report.evidenceArtifactName !== undefined) {
    if (
      typeof report.evidenceArtifactName !== "string" ||
      report.evidenceArtifactName.trim().length === 0 ||
      report.evidenceArtifactName !== report.evidenceArtifactName.trim() ||
      report.evidenceArtifactName.includes("/") ||
      report.evidenceArtifactName.includes("\\") ||
      report.evidenceArtifactName.includes("..") ||
      report.evidenceArtifactName.includes("\0")
    ) {
      return failure(
        "Developer testReport evidenceArtifactName must be a trimmed non-empty filename without path separators, '..', or NUL characters"
      );
    }
  }

  if (report.exitCode === 0 && report.passed === 0) {
    return failure("Developer testReport with exitCode 0 must have passed > 0");
  }
  if (report.exitCode === 0 && report.failed !== 0) {
    return failure("Developer testReport with exitCode 0 cannot have failed > 0");
  }
  if (report.failed > 0 && report.exitCode === 0) {
    return failure("Developer testReport with failed > 0 must not have exitCode 0");
  }

  const consumedRes = validateConsumedArtifacts(raw.consumedArtifactIds, context?.availableInputArtifacts);
  if (!consumedRes.ok) return consumedRes;

  const proposalsRes = validateArtifactProposals(raw.artifactProposals, "developer", context);
  if (!proposalsRes.ok) return proposalsRes;

  return success({
    role: "developer",
    taskId: taskIdRes.data,
    worktreePath: raw.worktreePath,
    commit: {
      sha: raw.commit.sha,
      message: raw.commit.message,
      ...(raw.commit.branch !== undefined ? { branch: raw.commit.branch } : {})
    },
    changedFiles,
    testReport: {
      command: report.command,
      exitCode: report.exitCode,
      passed: report.passed,
      failed: report.failed,
      skipped: report.skipped,
      selfReportedOnly: true,
      ...(report.evidenceArtifactName !== undefined ? { evidenceArtifactName: report.evidenceArtifactName } : {})
    },
    consumedArtifactIds: consumedRes.value,
    artifactProposals: proposalsRes.value
  });
}

function validateReviewerOutput(
  raw: Record<string, unknown>,
  context?: RoleOutputValidationContext
): OperationResult<ReviewerOutput> {
  const allowed = [
    "role",
    "taskId",
    "decision",
    "summary",
    "criteriaEvaluation",
    "findings",
    "modifiedFiles",
    "consumedArtifactIds",
    "artifactProposals"
  ];
  const keyError = checkDisallowedKeys(raw, allowed, "reviewer output");
  if (keyError) return failure(keyError);

  const taskIdRes = IdentifierSchema.safeParse(raw.taskId);
  if (!taskIdRes.success) {
    return failure(`Reviewer taskId is invalid: ${taskIdRes.error.message}`);
  }
  if (context?.expectedTaskId !== undefined && taskIdRes.data !== context.expectedTaskId) {
    return failure(`Reviewer taskId '${taskIdRes.data}' does not match expected taskId '${context.expectedTaskId}'`);
  }

  if (raw.decision !== "approved" && raw.decision !== "changes_requested") {
    return failure("Reviewer decision must be either 'approved' or 'changes_requested'");
  }

  if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) {
    return failure("Reviewer summary must be a non-empty string");
  }

  if (!Array.isArray(raw.modifiedFiles) || raw.modifiedFiles.length > 0) {
    return failure("Reviewer is forbidden from modifying source files");
  }

  if (!Array.isArray(raw.criteriaEvaluation) || raw.criteriaEvaluation.length === 0) {
    return failure("Reviewer criteriaEvaluation must be a non-empty array");
  }
  const criteriaEvaluation: ReviewCriterionEvaluation[] = [];
  const evaluatedCriteria = new Set<string>();
  for (let i = 0; i < raw.criteriaEvaluation.length; i++) {
    const item = raw.criteriaEvaluation[i];
    if (!isPlainObject(item)) {
      return failure(`Reviewer criteriaEvaluation[${i}] must be an object`);
    }
    const critKeyErr = checkDisallowedKeys(item, ["criterion", "met", "evidence"], `reviewer criteriaEvaluation[${i}]`);
    if (critKeyErr) return failure(critKeyErr);

    if (typeof item.criterion !== "string" || item.criterion.trim().length === 0) {
      return failure(`Reviewer criteriaEvaluation[${i}] criterion must be a non-empty string`);
    }
    if (evaluatedCriteria.has(item.criterion)) {
      return failure(`Duplicate criterion '${item.criterion}'`);
    }
    if (typeof item.met !== "boolean") {
      return failure(`Reviewer criteriaEvaluation[${i}] met must be a boolean`);
    }
    if (typeof item.evidence !== "string" || item.evidence.trim().length === 0) {
      return failure(`Reviewer criteriaEvaluation[${i}] evidence must be a non-empty string`);
    }
    evaluatedCriteria.add(item.criterion);
    criteriaEvaluation.push({
      criterion: item.criterion,
      met: item.met,
      evidence: item.evidence
    });
  }

  if (context?.expectedAcceptanceCriteria) {
    const expectedSet = new Set(context.expectedAcceptanceCriteria);
    for (const expected of context.expectedAcceptanceCriteria) {
      if (!evaluatedCriteria.has(expected)) {
        return failure(`Missing reviewer criteria evaluation for expected criterion: '${expected}'`);
      }
    }
    for (const evaluated of evaluatedCriteria) {
      if (!expectedSet.has(evaluated)) {
        return failure(`Unexpected criterion in reviewer criteria evaluation: '${evaluated}'`);
      }
    }
  }

  const rawFindings = raw.findings ?? [];
  if (!Array.isArray(rawFindings)) {
    return failure("Reviewer findings must be an array");
  }
  const findings: ReviewerFinding[] = [];
  const validCategories = ["logic", "security", "maintainability"] as const;
  const validSeverities = ["info", "warning", "error"] as const;
  for (let i = 0; i < rawFindings.length; i++) {
    const f = rawFindings[i];
    if (!isPlainObject(f)) {
      return failure(`Reviewer findings[${i}] must be an object`);
    }
    const findKeyErr = checkDisallowedKeys(
      f,
      ["category", "severity", "message", "file", "line", "evidence"],
      `reviewer findings[${i}]`
    );
    if (findKeyErr) return failure(findKeyErr);

    if (typeof f.category !== "string" || !validCategories.includes(f.category as ReviewerFinding["category"])) {
      return failure(`Reviewer findings[${i}] category must be one of: ${validCategories.join(", ")}`);
    }
    if (typeof f.severity !== "string" || !validSeverities.includes(f.severity as ReviewerFinding["severity"])) {
      return failure(`Reviewer findings[${i}] severity must be one of: ${validSeverities.join(", ")}`);
    }
    if (typeof f.message !== "string" || f.message.trim().length === 0) {
      return failure(`Reviewer findings[${i}] message must be a non-empty string`);
    }
    if (f.file !== undefined && typeof f.file !== "string") {
      return failure(`Reviewer findings[${i}] file must be a string if provided`);
    }
    if (f.line !== undefined && (typeof f.line !== "number" || !Number.isInteger(f.line) || f.line < 1)) {
      return failure(`Reviewer findings[${i}] line must be a positive integer if provided`);
    }
    if (typeof f.evidence !== "string" || f.evidence.trim().length === 0) {
      return failure(`Reviewer findings[${i}] evidence must be a non-empty string`);
    }
    findings.push({
      category: f.category as ReviewerFinding["category"],
      severity: f.severity as ReviewerFinding["severity"],
      message: f.message,
      ...(f.file !== undefined ? { file: f.file } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      evidence: f.evidence
    });
  }

  if (raw.decision === "approved") {
    for (const c of criteriaEvaluation) {
      if (!c.met) {
        return failure(`Approved reviewer decision requires all criteria to be met; unmet: '${c.criterion}'`);
      }
    }
    for (const f of findings) {
      if (f.severity === "error") {
        return failure(`Approved reviewer decision cannot contain error findings: '${f.message}'`);
      }
    }
  } else {
    // changes_requested
    const hasUnmet = criteriaEvaluation.some((c) => !c.met);
    const hasFindings = findings.length > 0;
    if (!hasUnmet && !hasFindings) {
      return failure(
        "Changes requested reviewer decision requires at least one unmet criterion or finding"
      );
    }
  }

  const consumedRes = validateConsumedArtifacts(raw.consumedArtifactIds, context?.availableInputArtifacts);
  if (!consumedRes.ok) return consumedRes;

  const proposalsRes = validateArtifactProposals(raw.artifactProposals, "reviewer", context);
  if (!proposalsRes.ok) return proposalsRes;

  return success({
    role: "reviewer",
    taskId: taskIdRes.data,
    decision: raw.decision,
    summary: raw.summary,
    criteriaEvaluation,
    findings,
    modifiedFiles: [],
    consumedArtifactIds: consumedRes.value,
    artifactProposals: proposalsRes.value
  });
}

function validateQaOutput(
  raw: Record<string, unknown>,
  context?: RoleOutputValidationContext
): OperationResult<QaOutput> {
  const allowed = [
    "role",
    "taskId",
    "verdict",
    "summary",
    "criteriaVerification",
    "testVerification",
    "consumedArtifactIds",
    "artifactProposals"
  ];
  const keyError = checkDisallowedKeys(raw, allowed, "qa output");
  if (keyError) return failure(keyError);

  const taskIdRes = IdentifierSchema.safeParse(raw.taskId);
  if (!taskIdRes.success) {
    return failure(`QA taskId is invalid: ${taskIdRes.error.message}`);
  }
  if (context?.expectedTaskId !== undefined && taskIdRes.data !== context.expectedTaskId) {
    return failure(`QA taskId '${taskIdRes.data}' does not match expected taskId '${context.expectedTaskId}'`);
  }

  if (raw.verdict !== "passed" && raw.verdict !== "failed") {
    return failure("QA verdict must be either 'passed' or 'failed'");
  }

  if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) {
    return failure("QA summary must be a non-empty string");
  }

  if (!Array.isArray(raw.criteriaVerification) || raw.criteriaVerification.length === 0) {
    return failure("QA criteriaVerification must be a non-empty array");
  }
  const criteriaVerification: QaCriterionVerification[] = [];
  const verifiedCriteria = new Set<string>();
  for (let i = 0; i < raw.criteriaVerification.length; i++) {
    const item = raw.criteriaVerification[i];
    if (!isPlainObject(item)) {
      return failure(`QA criteriaVerification[${i}] must be an object`);
    }
    const critKeyErr = checkDisallowedKeys(item, ["criterion", "passed", "evidence"], `qa criteriaVerification[${i}]`);
    if (critKeyErr) return failure(critKeyErr);

    if (typeof item.criterion !== "string" || item.criterion.trim().length === 0) {
      return failure(`QA criteriaVerification[${i}] criterion must be a non-empty string`);
    }
    if (verifiedCriteria.has(item.criterion)) {
      return failure(`Duplicate criterion '${item.criterion}'`);
    }
    if (typeof item.passed !== "boolean") {
      return failure(`QA criteriaVerification[${i}] passed must be a boolean`);
    }
    if (typeof item.evidence !== "string" || item.evidence.trim().length === 0) {
      return failure(`QA criteriaVerification[${i}] evidence must be a non-empty string`);
    }
    verifiedCriteria.add(item.criterion);
    criteriaVerification.push({
      criterion: item.criterion,
      passed: item.passed,
      evidence: item.evidence
    });
  }

  if (context?.expectedAcceptanceCriteria) {
    const expectedSet = new Set(context.expectedAcceptanceCriteria);
    for (const expected of context.expectedAcceptanceCriteria) {
      if (!verifiedCriteria.has(expected)) {
        return failure(`Missing QA verification for expected criterion: '${expected}'`);
      }
    }
    for (const verified of verifiedCriteria) {
      if (!expectedSet.has(verified)) {
        return failure(`Unexpected criterion in QA criteria verification: '${verified}'`);
      }
    }
  }

  if (!isPlainObject(raw.testVerification)) {
    return failure("QA testVerification must be an object");
  }
  const tv = raw.testVerification;
  const tvKeyErr = checkDisallowedKeys(
    tv,
    [
      "independentRunVerified",
      "command",
      "exitCode",
      "passedCount",
      "failedCount",
      "skippedCount",
      "evidence",
      "evidenceArtifactIds"
    ],
    "qa testVerification"
  );
  if (tvKeyErr) return failure(tvKeyErr);

  if (typeof tv.independentRunVerified !== "boolean") {
    return failure("QA testVerification independentRunVerified must be a boolean");
  }
  if (typeof tv.command !== "string" || tv.command.trim().length === 0) {
    return failure("QA testVerification command must be a non-empty string");
  }
  if (typeof tv.exitCode !== "number" || !Number.isSafeInteger(tv.exitCode)) {
    return failure("QA testVerification exitCode must be an integer");
  }
  if (typeof tv.passedCount !== "number" || !Number.isSafeInteger(tv.passedCount) || tv.passedCount < 0) {
    return failure("QA testVerification passedCount must be a non-negative integer");
  }
  if (typeof tv.failedCount !== "number" || !Number.isSafeInteger(tv.failedCount) || tv.failedCount < 0) {
    return failure("QA testVerification failedCount must be a non-negative integer");
  }
  if (
    tv.skippedCount !== undefined &&
    (typeof tv.skippedCount !== "number" || !Number.isSafeInteger(tv.skippedCount) || tv.skippedCount < 0)
  ) {
    return failure("QA testVerification skippedCount must be a non-negative integer if provided");
  }
  if (typeof tv.evidence !== "string" || tv.evidence.trim().length === 0) {
    return failure("QA testVerification evidence must be a non-empty string");
  }

  if (!Array.isArray(tv.evidenceArtifactIds)) {
    return failure("QA testVerification evidenceArtifactIds must be an array of artifact IDs");
  }
  const evidenceArtifactIds: string[] = [];
  const seenEvidenceIds = new Set<string>();
  const availableSet = context?.availableInputArtifacts
    ? new Set(context.availableInputArtifacts.map((a) => a.artifactId))
    : null;

  for (let i = 0; i < tv.evidenceArtifactIds.length; i++) {
    const id = tv.evidenceArtifactIds[i];
    if (typeof id !== "string") {
      return failure(`QA testVerification evidenceArtifactIds[${i}] must be a string`);
    }
    const parseRes = ArtifactIdSchema.safeParse(id);
    if (!parseRes.success) {
      return failure(`QA testVerification evidenceArtifactIds[${i}] is invalid: ${parseRes.error.message}`);
    }
    if (seenEvidenceIds.has(parseRes.data)) {
      return failure(
        `Duplicate artifactId in QA testVerification evidenceArtifactIds: '${parseRes.data}'`
      );
    }
    seenEvidenceIds.add(parseRes.data);
    if (availableSet && !availableSet.has(id)) {
      return failure(
        `QA testVerification evidence artifact '${id}' is not available in input artifacts`
      );
    }
    evidenceArtifactIds.push(parseRes.data);
  }

  if (tv.exitCode === 0 && tv.failedCount > 0) {
    return failure("QA testVerification with exitCode 0 cannot have failedCount > 0");
  }

  if (raw.verdict === "passed") {
    if (!tv.independentRunVerified) {
      return failure(
        "QA passed verdict requires independentRunVerified === true (agent reply alone is never accepted as proof of test success)"
      );
    }
    if (tv.exitCode !== 0) {
      return failure(`QA passed verdict requires testVerification.exitCode === 0, got ${tv.exitCode}`);
    }
    if (tv.failedCount !== 0) {
      return failure(`QA passed verdict requires testVerification.failedCount === 0, got ${tv.failedCount}`);
    }
    if (tv.passedCount === 0) {
      return failure("QA passed verdict requires testVerification.passedCount > 0");
    }
    if (evidenceArtifactIds.length === 0) {
      return failure("QA passed verdict requires non-empty evidenceArtifactIds");
    }
    for (const c of criteriaVerification) {
      if (!c.passed) {
        return failure(`QA passed verdict requires all criteria to pass; unverified: '${c.criterion}'`);
      }
    }
  } else {
    // verdict === "failed"
    const hasFailedCriterion = criteriaVerification.some((c) => !c.passed);
    const hasTestFailure = tv.exitCode !== 0 || tv.failedCount > 0;
    const isVerificationInvalid =
      !tv.independentRunVerified || tv.passedCount === 0 || evidenceArtifactIds.length === 0;
    if (!hasFailedCriterion && !hasTestFailure && !isVerificationInvalid) {
      return failure(
        "QA failed verdict requires at least one failed criterion or failing test"
      );
    }
  }

  const consumedRes = validateConsumedArtifacts(raw.consumedArtifactIds, context?.availableInputArtifacts);
  if (!consumedRes.ok) return consumedRes;

  const proposalsRes = validateArtifactProposals(raw.artifactProposals, "qa", context);
  if (!proposalsRes.ok) return proposalsRes;

  return success({
    role: "qa",
    taskId: taskIdRes.data,
    verdict: raw.verdict,
    summary: raw.summary,
    criteriaVerification,
    testVerification: {
      independentRunVerified: tv.independentRunVerified,
      command: tv.command,
      exitCode: tv.exitCode,
      passedCount: tv.passedCount,
      failedCount: tv.failedCount,
      ...(tv.skippedCount !== undefined ? { skippedCount: tv.skippedCount } : {}),
      evidence: tv.evidence,
      evidenceArtifactIds
    },
    consumedArtifactIds: consumedRes.value,
    artifactProposals: proposalsRes.value
  });
}

export function validateRoleOutput<R extends MvpRole>(
  role: R,
  rawOutput: unknown,
  context?: RoleOutputValidationContext
): OperationResult<RoleOutputMap[R]> {
  let parsed: unknown = rawOutput;
  if (typeof rawOutput === "string") {
    try {
      parsed = JSON.parse(rawOutput);
    } catch (err) {
      return failure(`Failed to parse JSON output: ${(err as Error).message}`);
    }
  }

  if (!isPlainObject(parsed)) {
    return failure(`Role output for '${role}' must be a non-null object`);
  }

  if (hasDelegationField(parsed)) {
    return failure(
      "Unauthorized delegation detected: role output must not include delegated tasks"
    );
  }

  if (parsed.role !== role) {
    return failure(`Role mismatch in structured output: expected '${role}', got '${String(parsed.role)}'`);
  }

  switch (role) {
    case "planner":
      return validatePlannerOutput(parsed, context) as OperationResult<RoleOutputMap[R]>;
    case "developer":
      return validateDeveloperOutput(parsed, context) as OperationResult<RoleOutputMap[R]>;
    case "reviewer":
      return validateReviewerOutput(parsed, context) as OperationResult<RoleOutputMap[R]>;
    case "qa":
      return validateQaOutput(parsed, context) as OperationResult<RoleOutputMap[R]>;
    default:
      return failure(`Unsupported MVP role: ${String(role)}`);
  }
}

export function toContractAgentResult(
  output: RoleStructuredOutput,
  envelope: {
    readonly requestId: string;
    readonly attemptId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly executionId: string;
    readonly correlation: SubmissionCorrelation;
    readonly evidence: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly resumeCursor?: string;
    readonly metadata?: Record<string, JsonValue>;
  }
): OperationResult<AgentResult> {
  if (output.role !== "planner" && output.taskId !== envelope.taskId) {
    return failure(`AgentResult taskId mismatch: output has '${output.taskId}', envelope has '${envelope.taskId}'`);
  }

  const isQaFailed = output.role === "qa" && output.verdict === "failed";
  const candidate = {
    requestId: envelope.requestId,
    attemptId: envelope.attemptId,
    runId: envelope.runId,
    taskId: envelope.taskId,
    executionId: envelope.executionId,
    status: isQaFailed ? ("failed" as const) : ("succeeded" as const),
    verification: {
      status: "verified" as const,
      evidence: envelope.evidence,
      correlation: envelope.correlation
    },
    output: output as unknown as JsonValue,
    artifactProposals: [...output.artifactProposals],
    ...(isQaFailed
      ? {
          error: {
            code: "qa_verification_failed",
            message: output.summary,
            retryable: false
          }
        }
      : {}),
    retryable: false,
    startedAt: envelope.startedAt,
    completedAt: envelope.completedAt,
    ...(envelope.resumeCursor !== undefined ? { resumeCursor: envelope.resumeCursor } : {}),
    ...(envelope.metadata !== undefined ? { metadata: envelope.metadata } : {})
  };

  const parseRes = AgentResultSchema.safeParse(candidate);
  if (!parseRes.success) {
    return failure(`Invalid contract AgentResult: ${parseRes.error.message}`);
  }
  return success(parseRes.data);
}

export function toContractApprovalDecision(
  output: ReviewerOutput,
  envelope: {
    readonly approvalId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly revision: number;
    readonly generation: number;
    readonly decidedBy: string;
    readonly decidedAt: string;
    readonly feedbackArtifacts?: readonly ArtifactReference[];
    readonly idempotencyKey: string;
    readonly metadata?: Record<string, JsonValue>;
  }
): OperationResult<ApprovalDecision> {
  if (output.taskId !== envelope.taskId) {
    return failure(`ApprovalDecision taskId mismatch: output has '${output.taskId}', envelope has '${envelope.taskId}'`);
  }

  const unmetCriteria = output.criteriaEvaluation.filter((c) => !c.met);
  const findings = output.findings;

  let reason = output.summary;
  let metadata: Record<string, JsonValue> = { ...(envelope.metadata ?? {}) };

  if (output.decision === "changes_requested") {
    const feedbackParts: string[] = [output.summary];
    if (unmetCriteria.length > 0) {
      feedbackParts.push(`Unmet criteria: ${unmetCriteria.map((c) => c.criterion).join("; ")}`);
    }
    if (findings.length > 0) {
      feedbackParts.push(`Findings: ${findings.map((f) => `[${f.severity}] ${f.message}`).join("; ")}`);
    }
    reason = feedbackParts.join(" | ");

    metadata = {
      ...metadata,
      unmetCriteria: unmetCriteria.map((c) => ({ criterion: c.criterion, evidence: c.evidence })),
      findings: findings.map((f) => ({
        category: f.category,
        severity: f.severity,
        message: f.message,
        ...(f.file !== undefined ? { file: f.file } : {}),
        ...(f.line !== undefined ? { line: f.line } : {}),
        evidence: f.evidence
      }))
    };
  }

  const candidate = {
    schemaVersion: 1 as const,
    approvalId: envelope.approvalId,
    runId: envelope.runId,
    target: {
      type: "task" as const,
      taskId: envelope.taskId
    },
    revision: envelope.revision,
    generation: envelope.generation,
    decision: output.decision,
    decidedBy: envelope.decidedBy,
    decidedAt: envelope.decidedAt,
    reason,
    feedbackArtifacts: envelope.feedbackArtifacts ? [...envelope.feedbackArtifacts] : [],
    idempotencyKey: envelope.idempotencyKey,
    metadata
  };

  const parseRes = ApprovalDecisionSchema.safeParse(candidate);
  if (!parseRes.success) {
    return failure(`Invalid contract ApprovalDecision: ${parseRes.error.message}`);
  }
  return success(parseRes.data);
}

export function toContractQualityGateResult(
  output: QaOutput,
  envelope: {
    readonly gateId: string;
    readonly runId: string;
    readonly taskId?: string;
    readonly evaluationId: string;
    readonly evaluatedAt: string;
    readonly metadata?: Record<string, JsonValue>;
  }
): OperationResult<QualityGateResult> {
  if (envelope.taskId !== undefined && output.taskId !== envelope.taskId) {
    return failure(`QualityGateResult taskId mismatch: output has '${output.taskId}', envelope has '${envelope.taskId}'`);
  }

  const findings: QualityFinding[] = [];

  if (output.verdict === "failed") {
    for (const crit of output.criteriaVerification) {
      if (!crit.passed) {
        findings.push({
          code: "CRITERION_FAILED",
          severity: "error",
          message: `Criterion failed: ${crit.criterion}`,
          details: { evidence: crit.evidence }
        });
      }
    }
    if (output.testVerification.exitCode !== 0 || output.testVerification.failedCount > 0) {
      findings.push({
        code: "TESTS_FAILED",
        severity: "error",
        message: `Independent test run failed with exit code ${output.testVerification.exitCode} (${output.testVerification.failedCount} failed)`,
        details: {
          command: output.testVerification.command,
          passed: output.testVerification.passedCount,
          failed: output.testVerification.failedCount,
          evidence: output.testVerification.evidence
        }
      });
    }
    if (!output.testVerification.independentRunVerified) {
      findings.push({
        code: "INDEPENDENT_RUN_UNVERIFIED",
        severity: "error",
        message: "Test run was not independently verified",
        details: { evidence: output.testVerification.evidence }
      });
    }
    if (output.testVerification.passedCount === 0) {
      findings.push({
        code: "NO_TESTS_PASSED",
        severity: "error",
        message: "Zero tests passed during verification",
        details: { command: output.testVerification.command }
      });
    }
  }

  const candidate = {
    gateId: envelope.gateId,
    runId: envelope.runId,
    ...(envelope.taskId !== undefined ? { taskId: envelope.taskId } : {}),
    evaluationId: envelope.evaluationId,
    status: output.verdict === "passed" ? ("passed" as const) : ("failed" as const),
    findings,
    producedArtifacts: [...output.artifactProposals],
    evaluatedAt: envelope.evaluatedAt,
    ...(envelope.metadata !== undefined ? { metadata: envelope.metadata } : {})
  };

  const parseRes = QualityGateResultSchema.safeParse(candidate);
  if (!parseRes.success) {
    return failure(`Invalid contract QualityGateResult: ${parseRes.error.message}`);
  }
  return success(parseRes.data);
}
