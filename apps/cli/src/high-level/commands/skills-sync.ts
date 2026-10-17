import { SkillsComponent, type SetupContext } from "@bflow/machine-setup";
import type { JsonValue } from "@bflow/contracts";
import type { CommandSpec } from "../args.js";
import {
  errorReport,
  HIGH_LEVEL_EXIT_CODES,
  HighLevelError,
  unavailableError,
  validationError,
  type CommandReport
} from "../envelope.js";
import { guarded, requireRepository, runJournaled, StepLog, type HighLevelHandler } from "../context.js";

export const PROVIDERS = ["claude", "codex", "agy"] as const;

export const SKILLS_SYNC_SPEC: CommandSpec = {
  name: "skills.sync",
  behavior: { summary: "Synchronize pinned role skills for providers", mutates: "machine", retry: "resume_required", idempotencyKey: "skills.sync:<providers>:<desired-digest>", permissionFlags: ["--allow-machine-scope"], outcomes: ["already_synced", "preview", "approval_required", "synced", "failed", "reconciliation_required"] },
  words: ["skills", "sync"],
  positionals: [],
  flags: {
    "--provider": { type: "string", multiple: true, choices: PROVIDERS },
    "--dry-run": { type: "boolean" },
    "--allow-machine-scope": { type: "boolean" },
    "--resume": { type: "boolean" }
  }
};

/** Synchronizes approved, pinned role skills through the injected P28 synchronizer port. */
export const skillsSync: HighLevelHandler = async (args, ctx, identity) => {
  const log = new StepLog();
  return guarded("skills.sync", log, {}, async () => {
    const providers = [...new Set(args.lists.get("--provider") ?? PROVIDERS)].sort();
    const synchronizer = await log.check("resolve-synchronizer", () => {
      const factory = ctx.services.skills;
      if (factory === undefined)
        throw new HighLevelError(unavailableError("No skills synchronizer is configured; the skill manager must be integrated before sync",
          { reason: "skills_synchronizer_not_configured" }));
      return factory(providers);
    }, () => ({ providers }));
    const component = new SkillsComponent(synchronizer);
    const platform = await ctx.services.machine.platform();
    const context = (mode: SetupContext["mode"]): SetupContext => ({ platform, runner: ctx.services.machine.runner(), mode,
      now: ctx.clock, ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) });

    const observed = await log.check("observe", () => component.observe(context("check")),
      value => ({ stateDigest: value.stateDigest, valid: value.valid, diagnostics: value.diagnostics }));
    const desired = await log.check("resolve-desired", () => component.desired(context("check")),
      value => ({ digest: value.digest, summary: value.summary, targets: value.targets, machineWide: value.machineWide }));
    if (desired.digest === "invalid-skills-desired")
      throw new HighLevelError(validationError(desired.summary, { reason: "invalid_desired_state" }));
    const inSync = (o: typeof observed) => o.valid && o.stateDigest === desired.digest && !desired.repairNeeded;
    const summary: JsonValue = { providers, targets: desired.targets, machineWide: desired.machineWide, digest: desired.digest };

    if (inSync(observed))
      return { command: "skills.sync", outcome: "already_synced", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS,
        steps: [...log.steps, { id: "sync", status: "skipped", message: "Skills already match the pinned manifest" }], data: summary };
    if (args.booleans.has("--dry-run"))
      return { command: "skills.sync", outcome: "preview", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS,
        steps: [...log.steps, { id: "sync", status: "skipped", message: "Dry run; nothing written" }], data: summary };
    if (desired.machineWide && !args.booleans.has("--allow-machine-scope"))
      return { command: "skills.sync", outcome: "approval_required", status: "waiting_user",
        exitCode: HIGH_LEVEL_EXIT_CODES.PERMISSION_REQUIRED,
        steps: [...log.steps, { id: "sync", status: "blocked", message: "Targets are machine-wide; pass --allow-machine-scope to permit it" }],
        data: summary };

    const repository = await requireRepository(ctx.cwd);
    const key = args.idempotencyKey ?? `skills.sync:${providers.join(",")}:${desired.digest}`;
    return runJournaled({ command: "skills.sync", repositoryRoot: repository.root, key,
      request: { providers, digest: desired.digest, targets: desired.targets }, retrySafe: false,
      resume: args.booleans.has("--resume"), identity, clock: ctx.clock }, async (journalLog, attempt): Promise<CommandReport> => {
      journalLog.steps.unshift(...log.steps);
      if (attempt.resumed) {
        // Reconcile before writing: an interrupted sync may already have completed.
        const current = await journalLog.check("reconcile", () => component.observe(context("check")),
          value => ({ stateDigest: value.stateDigest, inSync: inSync(value) }));
        if (inSync(current))
          return { command: "skills.sync", outcome: "synced", status: "succeeded", exitCode: 0, steps: journalLog.steps,
            idempotencyKey: key, data: { ...summary, ownedPaths: [], reconciled: true } };
      }
      const applied = await journalLog.sideEffect("sync", () => component.apply(context("apply")),
        value => ({ ownedPaths: value.ownedPaths, diagnostics: value.diagnostics }));
      const after = await journalLog.check("post-check", () => component.observe(context("check")),
        value => ({ stateDigest: value.stateDigest, valid: value.valid }));
      if (!inSync(after))
        throw new HighLevelError(validationError(`Skills did not converge to the pinned manifest: ${applied.diagnostics.join("; ") || "digest mismatch"}`,
          { reason: "sync_not_converged" }));
      return { command: "skills.sync", outcome: "synced", status: "succeeded", exitCode: 0, steps: journalLog.steps,
        idempotencyKey: key, data: { ...summary, ownedPaths: applied.ownedPaths, diagnostics: applied.diagnostics } };
    }, (error, journalLog) => errorReport("skills.sync", error, { idempotencyKey: key, steps: journalLog.steps }));
  });
};
