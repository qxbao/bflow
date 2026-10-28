import { AGENT_ROLES, type AgentRole, type JsonValue } from "@bflow/contracts";
import type { SkillImportSelection } from "@bflow/skills";
import {
  applySkillApproval,
  applySkillDisable,
  applySkillImport,
  applySkillRevoke,
  customSkillStatus,
  disabledConfig,
  listSkillApprovals,
  planSkillApproval,
  planSkillImport,
  readEnvironmentConfig,
  revocationPreview,
  type SkillImportPlan
} from "../custom-skills.js";
import type { CommandSpec } from "../args.js";
import { HIGH_LEVEL_EXIT_CODES, HighLevelError, conflictError, validationError } from "../envelope.js";
import { guarded, requireRepository, resolveInput, StepLog, type HighLevelContext, type HighLevelHandler } from "../context.js";
import { PROVIDERS } from "./skills-sync.js";

const SOURCE_FLAGS = {
  "--source": { type: "string", multiple: true, required: true },
  "--role": { type: "string", multiple: true, choices: AGENT_ROLES },
  "--provider": { type: "string", multiple: true, choices: PROVIDERS },
  "--version": { type: "string" },
  "--name": { type: "string" }
} as const;

export const SKILLS_SCAN_SPEC: CommandSpec = {
  name: "skills.scan",
  behavior: { summary: "Inventory selected IDE skills/rules and propose a role mapping (read-only)", mutates: "none", retry: "read_only",
    permissionFlags: [], outcomes: ["inspected", "failed"] },
  words: ["skills", "scan"],
  positionals: [],
  flags: SOURCE_FLAGS
};
export const SKILLS_IMPORT_SPEC: CommandSpec = {
  name: "skills.import",
  behavior: { summary: "Convert selected sources into reviewed, unapproved Bflow skill bundles", mutates: "repository", retry: "retry_safe",
    permissionFlags: [], outcomes: ["prepared", "preview", "not_ready", "failed"] },
  words: ["skills", "import"],
  positionals: [],
  flags: { ...SOURCE_FLAGS, "--depends-on": { type: "string", multiple: true }, "--dry-run": { type: "boolean" } }
};
export const SKILLS_APPROVE_SPEC: CommandSpec = {
  name: "skills.approve",
  behavior: { summary: "Approve an exact custom skill digest for its roles/providers in this repository session", mutates: "machine",
    retry: "retry_safe", permissionFlags: ["--approve"], outcomes: ["approval_required", "prepared", "failed"] },
  words: ["skills", "approve"],
  positionals: [{ name: "skill-id", required: true }],
  flags: { "--version": { type: "string" }, "--digest": { type: "string", required: true }, "--expires-in-days": { type: "integer" },
    "--approve": { type: "boolean" } }
};
export const SKILLS_DISABLE_SPEC: CommandSpec = {
  name: "skills.disable",
  behavior: { summary: "Unbind a custom skill from future role manifests (approval kept)", mutates: "repository", retry: "retry_safe",
    permissionFlags: [], outcomes: ["prepared", "preview", "failed"] },
  words: ["skills", "disable"],
  positionals: [{ name: "skill-id", required: true }],
  flags: { "--dry-run": { type: "boolean" } }
};
export const SKILLS_REVOKE_SPEC: CommandSpec = {
  name: "skills.revoke",
  behavior: { summary: "Delete this repository session's approval receipts for a custom skill and unbind it", mutates: "machine",
    retry: "retry_safe", permissionFlags: [], outcomes: ["prepared", "preview", "reconciliation_required", "failed"] },
  words: ["skills", "revoke"],
  positionals: [{ name: "skill-id", required: true }],
  flags: { "--version": { type: "string" }, "--dry-run": { type: "boolean" } }
};
export const SKILLS_STATUS_SPEC: CommandSpec = {
  name: "skills.status",
  behavior: { summary: "Report custom skill pins, approvals, installs and running-session reconciliation (read-only)", mutates: "none",
    retry: "read_only", permissionFlags: [], outcomes: ["checked", "reconciliation_required", "failed"] },
  words: ["skills", "status"],
  positionals: [],
  flags: {}
};

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

async function repositoryContext(ctx: HighLevelContext) {
  const repository = await requireRepository(ctx.cwd);
  return { repository, config: await readEnvironmentConfig(repository) };
}

function importRequest(args: Parameters<HighLevelHandler>[0], ctx: HighLevelContext) {
  const sources: SkillImportSelection[] = (args.lists.get("--source") ?? []).map(path => ({ path: resolveInput(ctx, path) }));
  return {
    sources,
    roles: (args.lists.get("--role") ?? []) as AgentRole[],
    providers: (args.lists.get("--provider") ?? []) as ("claude" | "codex" | "agy")[],
    version: args.strings.get("--version"),
    skillId: args.strings.get("--name"),
    dependsOn: args.lists.get("--depends-on") ?? []
  };
}

function planSummary(plan: SkillImportPlan) {
  return {
    inventoryDigest: plan.scanned.inventory.digest,
    proposalDigest: plan.proposal.digest,
    blocked: plan.blocked,
    duplicateGroups: plan.scanned.inventory.duplicateGroups,
    skills: plan.conversions.map(conversion => ({
      skillId: conversion.definition.skillId,
      version: conversion.definition.version,
      digest: conversion.definition.digest,
      roles: conversion.definition.allowedRoles,
      providers: conversion.definition.supportedProviders,
      dependencies: conversion.definition.dependencies,
      stagedPath: conversion.target,
      state: conversion.state,
      toolProposals: conversion.report.toolProposals,
      executableHooks: conversion.report.executableHooks,
      unconverted: conversion.report.unconverted.length,
      transformations: conversion.report.transformations.length
    }))
  };
}

export const skillsScan: HighLevelHandler = async (args, ctx) => {
  const log = new StepLog(undefined, ctx.onProgress);
  return guarded("skills.scan", log, {}, async () => {
    const { repository, config } = await repositoryContext(ctx);
    const plan = await log.check("scan", () => planSkillImport(repository, config, importRequest(args, ctx), true),
      value => ({ items: value.scanned.inventory.items.length, blocked: value.blocked.length }));
    return { command: "skills.scan", outcome: "inspected", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS, steps: log.steps,
      data: json({ inventory: plan.scanned.inventory, proposal: plan.proposal,
        next: "Review the inventory, then run 'bflow skills import' with the same --source to stage converted bundles." }) };
  });
};

export const skillsImport: HighLevelHandler = async (args, ctx) => {
  const log = new StepLog(undefined, ctx.onProgress);
  return guarded("skills.import", log, {}, async () => {
    const { repository, config } = await repositoryContext(ctx);
    const plan = await log.check("convert", () => planSkillImport(repository, config, importRequest(args, ctx)),
      value => ({ converted: value.conversions.length, blocked: value.blocked.length }));
    const summary = planSummary(plan);
    if (plan.blocked.length)
      return { command: "skills.import", outcome: "not_ready", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.NOT_READY,
        steps: [...log.steps, { id: "stage", status: "blocked", message: "Blocked sources; nothing was written" }],
        data: json({ ...summary, next: "Deselect or fix the blocked sources (see blockers), then rerun the import." }) };
    if (args.booleans.has("--dry-run"))
      return { command: "skills.import", outcome: "preview", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS,
        steps: [...log.steps, { id: "stage", status: "skipped", message: "Dry run; nothing written" }], data: json(summary) };
    const written = await log.sideEffect("stage", () => applySkillImport(plan), value => ({ written: value }));
    return { command: "skills.import", outcome: "prepared", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS, steps: log.steps,
      data: json({ ...summary, written, next: "Review bundle/, original/ and report.json under each staged path, then run 'bflow skills approve <skill-id> --digest <sha256>'." }) };
  });
};

export const skillsApprove: HighLevelHandler = async (args, ctx) => {
  const log = new StepLog(undefined, ctx.onProgress);
  return guarded("skills.approve", log, {}, async () => {
    const { repository, config } = await repositoryContext(ctx);
    const digest = args.strings.get("--digest")!;
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new HighLevelError(validationError("--digest must be the reviewed 64-character sha256 bundle digest"));
    const plan = await log.check("validate", () => planSkillApproval(repository, config, { skillId: args.positionals["skill-id"]!,
      version: args.strings.get("--version"), digest, expiresInDays: args.integers.get("--expires-in-days"), now: ctx.clock() }).catch(error => {
      throw new HighLevelError(conflictError(error instanceof Error ? error.message : String(error), { reason: "approval_conflict" }));
    }), value => ({ digest: value.definition.digest }));
    const preview = { skillId: plan.definition.skillId, version: plan.definition.version, digest: plan.definition.digest,
      dependencies: plan.definition.dependencies, roles: plan.receipt.roles, providers: plan.receipt.providers,
      scope: { repositoryId: plan.receipt.repositoryId, sessionId: plan.receipt.sessionId }, expiresAt: plan.receipt.expiresAt,
      boundRoles: plan.boundRoles, bundle: plan.bundleRoot };
    if (!args.booleans.has("--approve"))
      return { command: "skills.approve", outcome: "approval_required", status: "waiting_user", exitCode: HIGH_LEVEL_EXIT_CODES.PERMISSION_REQUIRED,
        steps: [...log.steps, { id: "approve", status: "blocked", message: "Review the exact grant, then rerun with --approve" }], data: json(preview) };
    const machine = await ctx.services.machine.platform();
    const applied = await log.sideEffect("approve", () => applySkillApproval(repository, config, plan, machine.paths.state),
      value => ({ approvalReceiptId: value.approvalReceiptId }));
    return { command: "skills.approve", outcome: "prepared", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS, steps: log.steps,
      data: json({ ...preview, ...applied, next: "Run 'bflow skills sync --allow-machine-scope' to install the exact pin, then 'bflow up'." }) };
  });
};

export const skillsDisable: HighLevelHandler = async (args, ctx) => {
  const log = new StepLog(undefined, ctx.onProgress);
  return guarded("skills.disable", log, {}, async () => {
    const { repository, config } = await repositoryContext(ctx);
    const skillId = args.positionals["skill-id"]!;
    const changed = disabledConfig(config, skillId).changed;
    if (args.booleans.has("--dry-run") || !changed)
      return { command: "skills.disable", outcome: "preview", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS,
        steps: [...log.steps, { id: "unbind", status: "skipped", message: changed ? "Dry run; nothing written" : "Skill is not bound" }],
        data: json({ skillId, changed }) };
    await log.sideEffect("unbind", () => applySkillDisable(repository, config, skillId));
    return { command: "skills.disable", outcome: "prepared", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS, steps: log.steps,
      data: json({ skillId, changed, next: "New role manifests omit the skill. Running roles keep loaded instructions: check 'bflow skills status' and relaunch them." }) };
  });
};

export const skillsRevoke: HighLevelHandler = async (args, ctx) => {
  const log = new StepLog(undefined, ctx.onProgress);
  return guarded("skills.revoke", log, {}, async () => {
    const { repository, config } = await repositoryContext(ctx);
    const skillId = args.positionals["skill-id"]!;
    const version = args.strings.get("--version");
    const machine = await ctx.services.machine.platform();
    const receipts = revocationPreview(await listSkillApprovals(machine.paths.state), repository, skillId, version);
    if (args.booleans.has("--dry-run"))
      return { command: "skills.revoke", outcome: "preview", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS,
        steps: [...log.steps, { id: "revoke", status: "skipped", message: "Dry run; nothing written" }],
        data: json({ skillId, receipts, unbind: disabledConfig(config, skillId).changed }) };
    const result = await log.sideEffect("revoke", () => applySkillRevoke(repository, config, machine.paths.state, skillId, version));
    const status = await log.check("reconcile", () => customSkillStatus(repository, config, { stateDirectory: machine.paths.state,
      dataDirectory: machine.paths.data }, ctx.clock()), value => ({ reconciliationRequired: value.sessions.reconciliationRequired }));
    const affected = status.sessions.records.filter(record => record.skills.some(skill => skill.skillId === skillId));
    return { command: "skills.revoke", outcome: affected.length ? "reconciliation_required" : "prepared",
      status: "succeeded", exitCode: affected.length ? HIGH_LEVEL_EXIT_CODES.NOT_READY : HIGH_LEVEL_EXIT_CODES.SUCCESS, steps: log.steps,
      data: json({ skillId, ...result, affectedSessionRecords: affected,
        next: affected.length
          ? "Running roles still hold the revoked instructions in their process: relaunch them ('bflow down' then 'bflow up'); recovery of the old manifest is refused."
          : "No persisted session manifest uses this skill; future manifests cannot resolve it." }) };
  });
};

export const skillsStatus: HighLevelHandler = async (_args, ctx) => {
  const log = new StepLog(undefined, ctx.onProgress);
  return guarded("skills.status", log, {}, async () => {
    const { repository, config } = await repositoryContext(ctx);
    const machine = await ctx.services.machine.platform();
    const status = await log.check("inspect", () => customSkillStatus(repository, config, { stateDirectory: machine.paths.state,
      dataDirectory: machine.paths.data }, ctx.clock()));
    const reconcile = status.sessions.reconciliationRequired;
    return { command: "skills.status", outcome: reconcile ? "reconciliation_required" : "checked", status: "succeeded",
      exitCode: reconcile ? HIGH_LEVEL_EXIT_CODES.NOT_READY : HIGH_LEVEL_EXIT_CODES.SUCCESS, steps: log.steps, data: json(status) };
  });
};
