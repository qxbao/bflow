import type { Specification, TestStrategy } from "@bflow/contracts";
import { z } from "zod";
import { digest } from "./journal.js";

/**
 * In-run scope amendment (GĐ3, D3). The Coordinator may narrow a task's planned paths or edit its test names inside the
 * ownership the human-approved design already granted. Runtime re-derives and checks every invariant here; nothing the
 * Coordinator says about criteria, waivers or TDD is trusted.
 *
 * Ownership itself (`metadata.ownedPaths` of the accepted workflow definition) is NOT amendable: Core persists that
 * definition and refuses any run whose definition digest differs, so widening or narrowing it is a requirement revision.
 */
const PathList = z.array(z.string().trim().min(1).max(1024)).min(1).max(50);
export const ScopeChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("drop_planned_paths"), paths: PathList }).strict(),
  z.object({ kind: z.literal("add_paths_within_ownership"), paths: PathList }).strict(),
  z.object({ kind: z.literal("set_test_names"), criterionId: z.string().trim().min(1).max(200),
    testNames: z.array(z.string().trim().min(1).max(500)).min(1).max(20) }).strict()
]);
export type ScopeChange = z.infer<typeof ScopeChangeSchema>;
export const AmendTaskScopeInputSchema = z.object({
  runId: z.string().trim().min(1), taskId: z.string().trim().min(1),
  reason: z.string().trim().min(10).max(1000),
  changes: z.array(ScopeChangeSchema).min(1).max(20),
}).strict();
export type AmendTaskScopeInput = z.infer<typeof AmendTaskScopeInputSchema>;

export type ScopeRefusalCode = "invalid_path" | "criteria_changed" | "criterion_unmapped" | "unknown_criterion" | "tdd_weakened" |
  "ownership_empty" | "path_not_planned" | "path_exists_or_unobserved" | "not_within_ownership" | "empty_amendment" | "not_amendable";
export class ScopeAmendmentRefusal extends Error {
  constructor(readonly code: ScopeRefusalCode, message: string) { super(message); this.name = `ScopeAmendmentRefusal[${code}]`; }
}

/** Same normalization `propose_workflow` applies to ownership: repository-relative literal paths only. */
export function normalizeLiteralRepoPrefix(rawPath: string, label: string): string {
  const normalized = rawPath.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/g, "");
  const segments = normalized ? normalized.split("/") : [];
  if (!normalized || rawPath.trim().startsWith("/") || /^[A-Za-z]:/.test(normalized) ||
      segments.some(seg => seg === "" || seg === "." || seg === ".."))
    throw new ScopeAmendmentRefusal("invalid_path", `Task ownership must be within approved literal affectedPaths (invalid ${label}: ${rawPath})`);
  return normalized;
}
const within = (path: string, prefixes: readonly string[]) => prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
const uniq = (values: readonly string[]) => [...new Set(values)];

export interface ScopeState {
  specification: Pick<Specification, "acceptanceCriteria" | "affectedPaths">;
  strategy: Pick<TestStrategy, "criterionMappings">;
  ownedPaths: readonly string[];
}
export interface ScopeAmendmentPlan {
  affectedPaths: string[]; ownedPaths: string[];
  criterionMappings: { criterionId: string; testNames: string[] }[];
  diff: { droppedAffectedPaths: string[]; addedAffectedPaths: string[]; ownedPathsBefore: string[]; ownedPathsAfter: string[];
    testNamesChanged: { criterionId: string; before: string[]; after: string[] }[] };
}

/**
 * Applies the requested changes to the current scope and rejects anything outside the allowed set.
 * `missingPaths` are test paths the Runtime itself recorded as absent from the commit (the blocker's evidence);
 * only those may be dropped. Ownership never changes.
 */
export function planScopeAmendment(current: ScopeState, changesInput: readonly ScopeChange[], context: { missingPaths: readonly string[] }): ScopeAmendmentPlan {
  const owned = uniq(current.ownedPaths.map(path => normalizeLiteralRepoPrefix(path, "ownedPath")));
  if (!owned.length) throw new ScopeAmendmentRefusal("ownership_empty", "A task must keep at least one owned path");
  let affected = uniq(current.specification.affectedPaths.map(path => normalizeLiteralRepoPrefix(path, "affectedPath")));
  const affectedBefore = [...affected];
  const missing = new Set(context.missingPaths.map(path => normalizeLiteralRepoPrefix(path, "missing path")));
  const mappings = current.strategy.criterionMappings.map(mapping => ({ criterionId: mapping.criterionId, testNames: [...mapping.testNames] }));
  const changedNames: ScopeAmendmentPlan["diff"]["testNamesChanged"] = [];
  const criterionIds = new Set(current.specification.acceptanceCriteria.map(criterion => criterion.id));
  for (const change of changesInput) {
    if (change.kind === "drop_planned_paths") {
      for (const raw of change.paths) {
        const path = normalizeLiteralRepoPrefix(raw, "dropped path");
        if (!affected.includes(path)) throw new ScopeAmendmentRefusal("path_not_planned", `${path} is not a planned path of this task`);
        // Only a path the Runtime observed missing may go: a source file a criterion relies on is never droppable.
        if (!missing.has(path)) throw new ScopeAmendmentRefusal("path_exists_or_unobserved",
          `${path} was not recorded as missing by the Runtime; only paths named by the blocker evidence can be dropped`);
        affected = affected.filter(item => item !== path);
      }
    } else if (change.kind === "add_paths_within_ownership") {
      for (const raw of change.paths) {
        const path = normalizeLiteralRepoPrefix(raw, "added path");
        if (!within(path, owned)) throw new ScopeAmendmentRefusal("not_within_ownership", `${path} is outside the task's current ownership`);
        if (!affected.includes(path)) affected.push(path);
      }
    } else {
      const criterionId = change.criterionId.normalize("NFC");
      const index = mappings.findIndex(mapping => mapping.criterionId.normalize("NFC") === criterionId);
      if (index < 0 || !criterionIds.has(mappings[index]!.criterionId))
        throw new ScopeAmendmentRefusal("unknown_criterion", `Criterion ${change.criterionId} is not part of this task`);
      const after = uniq(change.testNames.map(name => name.normalize("NFC")));
      changedNames.push({ criterionId: mappings[index]!.criterionId, before: mappings[index]!.testNames, after });
      mappings[index] = { criterionId: mappings[index]!.criterionId, testNames: after };
    }
  }
  if (!affected.some(path => within(path, owned))) throw new ScopeAmendmentRefusal("ownership_empty", "A task must keep at least one planned path inside its ownership");
  return { affectedPaths: affected, ownedPaths: owned, criterionMappings: mappings,
    diff: { droppedAffectedPaths: affectedBefore.filter(path => !affected.includes(path)),
      addedAffectedPaths: affected.filter(path => !affectedBefore.includes(path)),
      ownedPathsBefore: owned, ownedPathsAfter: owned, testNamesChanged: changedNames } };
}

/** Invariants checked on the re-resolved result. These do not depend on anything the Coordinator supplied. */
export function assertScopeInvariants(before: { specification: Pick<Specification, "acceptanceCriteria">;
  strategy: Pick<TestStrategy, "tddDecision" | "requiredTestLevels" | "independentVerificationRequired" | "criterionMappings"> },
after: typeof before): void {
  if (digest(before.specification.acceptanceCriteria) !== digest(after.specification.acceptanceCriteria))
    throw new ScopeAmendmentRefusal("criteria_changed", "Acceptance criteria are immutable in a scope amendment; a requirement change needs a new revision");
  for (const criterion of after.specification.acceptanceCriteria) {
    if (criterion.required === false) continue;
    const mapping = after.strategy.criterionMappings.find(item => item.criterionId.normalize("NFC") === criterion.id.normalize("NFC"));
    if (!mapping || !mapping.testNames.some(name => name.trim().length > 0))
      throw new ScopeAmendmentRefusal("criterion_unmapped", `Required criterion ${criterion.id} must keep at least one test`);
  }
  const a = before.strategy, b = after.strategy;
  if (a.tddDecision.mode !== b.tddDecision.mode || a.tddDecision.requiresFailingTestFirst !== b.tddDecision.requiresFailingTestFirst ||
      !a.requiredTestLevels.every(level => b.requiredTestLevels.includes(level)) || b.independentVerificationRequired !== true)
    throw new ScopeAmendmentRefusal("tdd_weakened", "The amendment would change the TDD decision or weaken the required test levels");
}
