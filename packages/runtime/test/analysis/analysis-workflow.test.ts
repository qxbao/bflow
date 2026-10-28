import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import type { ArtifactStore, RunStore, WorkflowEngine } from "@bflow/contracts";
import {
  AnalysisPackRejected, AnalysisWorkflowRejected, AnalysisWorkflowRuntime, buildAnalysisPack, planAnalysisWorkflow, resolveAnalysisPack,
  verifyAnalysisDocument, type AnalysisAssignment, type AnalysisDocument, type AnalysisIntakeInput, type AnalysisRolePort, type AnalysisReconciliation
} from "../../src/index.js";
import { AnalysisIntakeSchema } from "../../src/analysis/model.js";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const PACK = buildAnalysisPack({ id: "ba-handoff", version: "2026.10" });
const PIN = { id: PACK.id, version: PACK.version, digest: PACK.digest };
const SOURCE = "export const REFUND_STATES = ['requested', 'approved', 'paid'] as const;\n";

function intake(overrides: Partial<AnalysisIntakeInput> = {}): AnalysisIntakeInput {
  return {
    schemaVersion: 1, requestId: "refund-ba", sessionId: "session-1", title: "Customer refund request",
    userStatements: [
      { id: "U-1", text: "Customers must be able to request a refund for a delivered order from their account." },
      { id: "U-2", text: "Peak load is 200 concurrent refund requests and customers expect a reply within 2 seconds." }
    ],
    deliverables: ["scope", "functional_requirements", "acceptance_criteria", "nfr", "business_flows", "glossary", "data_notes"],
    acceptanceCriteria: [
      { id: "AAC-1", description: "The refund flow is specified with traceable FR and AC", required: true },
      { id: "AAC-2", description: "Every NFR is measurable or marked undecided", required: true }
    ],
    requiredDecisions: [{ id: "D-1", question: "Which refund amount needs manager approval?", blocking: true }],
    surveyPaths: ["src/refunds"], documentRoot: "docs/analysis",
    ...overrides
  };
}

function goodDocument(context: AnalysisAssignment["context"], options: { dropAcFor?: string; blockingQuestion?: boolean } = {}): AnalysisDocument {
  const availability = context.decisions["D-3"];
  const source = context.observations.find(item => item.path === "src/refunds/states.ts")!;
  const sourceRef = `source:${source.path}#${source.sha256}`;
  const acs = [
    { id: "AC-1", requirementIds: ["FR-1"], given: "a delivered order inside the decided refund window", when: "the customer submits a refund request",
      then: "the request is stored with status requested", oracle: "refund record status equals requested", text: "Refund request is accepted",
      provenance: { kind: "inference" as const, refs: ["FR-1"] } },
    { id: "AC-2", requirementIds: ["FR-2"], given: "a refund above the decided approval amount", when: "it is submitted",
      then: "it waits for manager approval before payment", oracle: "refund status stays requested until a manager approves", text: "Large refunds wait for approval",
      provenance: { kind: "inference" as const, refs: ["FR-2"] } },
    { id: "AC-3", requirementIds: ["FR-3"], given: "an approved refund", when: "payment completes",
      then: "the status becomes paid", oracle: "refund status sequence is requested, approved, paid", text: "Status sequence is recorded",
      provenance: { kind: "source" as const, refs: [sourceRef] } }
  ];
  return {
    schemaVersion: 1, title: "Customer refund request",
    scope: {
      inScope: [{ id: "S-1", text: "Refund requests for delivered orders", provenance: { kind: "user", refs: ["intake:U-1"] } }],
      outOfScope: [{ id: "S-2", text: "Changes to the payment gateway", provenance: { kind: "inference", refs: ["S-1"] } }]
    },
    functionalRequirements: [
      { id: "FR-1", text: "A customer can request a refund for a delivered order within the decided refund window", provenance: { kind: "user", refs: ["intake:U-1", "decision:D-2"] } },
      { id: "FR-2", text: "Refunds above the decided amount require manager approval", provenance: { kind: "user", refs: ["decision:D-1"] } },
      { id: "FR-3", text: "The refund status moves through requested, approved and paid", provenance: { kind: "source", refs: [sourceRef] } }
    ],
    acceptanceCriteria: acs.filter(item => !item.requirementIds.includes(options.dropAcFor ?? "none")),
    nfrs: [
      { id: "NFR-1", category: "performance", text: "Refund request response time", status: "accepted", metric: "p95 response time of refund submission",
        oracle: "load test report", workload: "200 concurrent refund requests", threshold: "at most 2 s", provenance: { kind: "user", refs: ["intake:U-2"] } },
      availability
        ? { id: "NFR-2", category: "availability", text: "Availability target of the refund service", status: "accepted", metric: "monthly availability of refund submission",
          oracle: "uptime monitoring report", workload: "all refund requests in a calendar month", threshold: availability.answer, provenance: { kind: "user", refs: ["decision:D-3"] } }
        : { id: "NFR-2", category: "availability", text: "Availability target of the refund service", status: "undecided", decisionId: "D-3",
          provenance: { kind: "open_decision", refs: ["decision:D-3"] } }
    ],
    businessFlows: [{ id: "BF-1", text: "Refund request", requirementIds: ["FR-1", "FR-2", "FR-3"], provenance: { kind: "inference", refs: ["FR-1", "FR-2"] },
      steps: [{ actor: "Customer", action: "Submits a refund request" }, { actor: "Manager", action: "Approves refunds above the amount" }, { actor: "System", action: "Marks the refund paid" }] }],
    glossary: [{ id: "G-1", term: "Refund window", text: "Days after delivery during which a refund may be requested", provenance: { kind: "inference", refs: ["FR-1"] } }],
    notes: [{ id: "N-1", kind: "data", text: "Refund status values are requested, approved and paid", provenance: { kind: "source", refs: [sourceRef] } }],
    openQuestions: availability ? [] : [{ id: "D-3", question: "What availability target applies to refunds?", blocking: options.blockingQuestion === true }],
    criteriaCoverage: [{ criterionId: "AAC-1", statementIds: ["FR-1", "AC-1", "BF-1"] }, { criterionId: "AAC-2", statementIds: ["NFR-1", "NFR-2"] }]
  };
}

type Behaviour = Partial<Record<AnalysisAssignment["taskId"], (assignment: AnalysisAssignment, call: number) => { agentId?: string; output: unknown } | Promise<never>>>;

class FixtureRoles implements AnalysisRolePort {
  readonly calls: AnalysisAssignment[] = [];
  readonly reconciled: string[] = [];
  constructor(private readonly behaviour: Behaviour = {}, private readonly completed = new Map<string, AnalysisReconciliation>()) {}
  async dispatch(assignment: AnalysisAssignment) {
    this.calls.push(structuredClone(assignment));
    const call = this.calls.filter(item => item.taskId === assignment.taskId).length;
    const custom = this.behaviour[assignment.taskId]?.(assignment, call);
    if (custom) { const value = await custom; return { agentId: value.agentId ?? `${assignment.role}:pane`, output: value.output }; }
    switch (assignment.taskId) {
      case "survey": return { agentId: "architect:pane", output: { observations: [{ path: "src/refunds/states.ts", note: "Refund states are defined here" }] } };
      case "elicitation": return { agentId: "specifier:pane", output: { questions: [{ id: "D-2", question: "How many days is the refund window?", blocking: true }] } };
      case "specification": return { agentId: "specifier:pane", output: { document: goodDocument(assignment.context) } };
      case "review": return { agentId: "reviewer:pane", output: { verdict: "approved", documentDigest: assignment.context.document!.digest, findings: [] } };
      default: throw new Error(`unexpected ${assignment.taskId}`);
    }
  }
  async reconcile(executionId: string): Promise<AnalysisReconciliation> {
    this.reconciled.push(executionId);
    return this.completed.get(executionId) ?? { status: "unknown" };
  }
}

let root: string, repo: string, state: string, clock: number, base: number;
const runStores: { close?: () => void }[] = [];
// Monotonic test clock anchored at wall time: ArtifactStore stamps artifacts with its own clock.
const now = () => new Date(base + 1000 * clock++).toISOString();
async function stores() {
  const runStore = unwrap(openSqliteRunStore({ filename: join(state, "runs.db") })) as unknown as RunStore & { close?: () => void };
  runStores.push(runStore);
  const artifactStore = unwrap(await openFilesystemArtifactStore({ root: join(state, "artifacts"), storeId: "analysis" })) as ArtifactStore;
  return { runStore, artifactStore };
}
async function open(roles: AnalysisRolePort, humans = ["user:anh"], engine: WorkflowEngine = new DeterministicWorkflowEngine()) {
  const { runStore, artifactStore } = await stores();
  return AnalysisWorkflowRuntime.open({ engine, runStore, artifactStore, roles, repositoryRoot: repo,
    journalPath: join(state, "analysis-journal.json"), authorizeHuman: decision => humans.includes(decision.decidedBy), now });
}
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) { const path = join(entry.parentPath, entry.name); out[relative(repo, path)] = sha(await readFile(path)); }
  return out;
}
const docDigest = (runtime: AnalysisWorkflowRuntime, runId: string) => runtime.status(runId).documents.at(-1)!.digest;

beforeEach(async () => {
  clock = 0; base = Math.floor(Date.now() / 1000) * 1000 - 60_000;
  root = await realpath(await mkdtemp(join(tmpdir(), "bflow-analysis-")));
  repo = join(root, "repo"); state = join(root, "state");
  await mkdir(join(repo, "src/refunds"), { recursive: true });
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(repo, "src/refunds/states.ts"), SOURCE);
  await writeFile(join(repo, "src/secret.ts"), "export const notForSurvey = true;\n");
  await writeFile(join(repo, "package.json"), "{\"name\":\"fixture\"}\n");
});
afterEach(async () => {
  for (const store of runStores.splice(0)) store.close?.();
  await rm(root, { recursive: true, force: true });
});

describe("analysis-only pack and DAG policy", () => {
  it("resolves a pinned pack into output policy and refuses implementation bindings or a wrong pin", () => {
    const policy = resolveAnalysisPack(PACK, PIN);
    expect(policy.pack).toEqual(PIN);
    expect(policy.outputSections).toContain("api_notes");
    expect(() => resolveAnalysisPack(PACK, { ...PIN, digest: "f".repeat(64) })).toThrow(AnalysisPackRejected);
    const tampered = { ...PACK, defaults: { ...PACK.defaults, "roles.developer.provider": "codex" } };
    expect(() => resolveAnalysisPack(tampered, PIN)).toThrow(/pin/);
    const developer = buildAnalysisPack({ id: "x", version: "1", skills: { developer: [] } });
    expect(() => resolveAnalysisPack(developer, { id: "x", version: "1", digest: developer.digest })).toThrow(/cannot set 'skills.developer'/);
    const noNfr = buildAnalysisPack({ id: "y", version: "1", outputSections: ["scope", "functional_requirements", "acceptance_criteria"] });
    expect(() => resolveAnalysisPack(noNfr, { id: "y", version: "1", digest: noNfr.digest })).toThrow(/core sections/);
  });

  it("ships a valid example pack whose digest matches its content", async () => {
    const example = JSON.parse(await readFile(fileURLToPath(new URL("../../support/analysis-only-pack.json", import.meta.url)), "utf8"));
    expect(resolveAnalysisPack(example, { id: example.id, version: example.version, digest: example.digest }).outputSections).toHaveLength(9);
  });

  it("plans only survey/elicitation/specification/review/publication and rejects implementation DAGs", async () => {
    const parsed = AnalysisIntakeSchema.parse(intake());
    const policy = resolveAnalysisPack(PACK, PIN);
    const plan = planAnalysisWorkflow(parsed, policy);
    expect(plan.tasks.map(item => [item.id, item.role, item.requiresApproval])).toEqual([
      ["survey", "architect", false], ["elicitation", "specifier", true], ["specification", "specifier", false],
      ["review", "reviewer", true], ["publication", "coordinator", false]]);
    expect(plan.tasks.some(item => item.role === "developer")).toBe(false);
    const runtime = await open(new FixtureRoles());
    const implementation = { ...plan, qualityGates: [], tasks: [...plan.tasks.map(item => ({ ...item, qualityGates: [] })),
      { ...plan.tasks[2]!, id: "implement", role: "developer", qualityGates: [], metadata: { analysisKind: "specification", ownedPaths: ["src"] } }] };
    await expect(runtime.start({ runId: "bad-1", intake: intake(), pack: PACK, packPin: PIN, definition: implementation })).rejects.toThrow(AnalysisWorkflowRejected);
    const noReview = { ...plan, qualityGates: [], tasks: plan.tasks.filter(item => item.id !== "review").map(item => ({ ...item, qualityGates: [] })),
      dependencies: plan.dependencies.filter(item => item.taskId !== "review" && item.dependsOnTaskId !== "review") };
    await expect(runtime.start({ runId: "bad-2", intake: intake(), pack: PACK, packPin: PIN, definition: noReview })).rejects.toThrow(/review/);
    const deploy = { ...plan, qualityGates: [], tasks: plan.tasks.map(item => ({ ...item, qualityGates: [],
      ...(item.id === "publication" ? { metadata: { analysisKind: "deploy" } } : {}) })) };
    await expect(runtime.start({ runId: "bad-3", intake: intake(), pack: PACK, packPin: PIN, definition: deploy })).rejects.toThrow(/analysisKind/);
    await expect(runtime.start({ runId: "bad-4", intake: intake({ documentRoot: "src/refunds/docs" }), pack: PACK, packPin: PIN }))
      .rejects.toThrow(/overlap/);
  });
});

describe("analysis-only workflow on a fixture repository", () => {
  it("runs survey → decisions → specification (bounded repair) → independent review → document approval → handoff", async () => {
    const before = await tree(repo);
    const roles = new FixtureRoles({
      specification: (assignment, call) => ({ output: { document: goodDocument(assignment.context, call === 1 ? { dropAcFor: "FR-3" } : {}) } })
    });
    const runtime = await open(roles);
    const started = await runtime.start({ runId: "ba-1", intake: intake(), pack: PACK, packPin: PIN });
    expect(started.tdd).toEqual({ mode: "not_applicable", alternativeVerification: ["manual_review"] });

    let status = await runtime.drive("ba-1");
    // Blocked on the user's business decisions: specification was never dispatched.
    expect(status.status).toBe("awaiting_business_decision");
    expect(roles.calls.map(item => item.taskId)).toEqual(["survey", "elicitation"]);
    expect(roles.calls.every(item => item.permissions.write === "none" && item.permissions.commands === "none")).toBe(true);
    await expect(runtime.decideBusinessQuestions("ba-1", { decision: "approved", answers: { "D-1": "Above 5,000,000 VND" }, decidedBy: "user:anh" }))
      .rejects.toThrow(/D-2/);
    expect(runtime.status("ba-1").status).toBe("awaiting_business_decision");
    await expect(runtime.decideBusinessQuestions("ba-1", { decision: "approved", answers: { "D-1": "x", "D-2": "y" }, decidedBy: "coordinator" }))
      .rejects.toThrow(/human/);

    status = await runtime.decideBusinessQuestions("ba-1", { decision: "approved",
      answers: { "D-1": "Above 5,000,000 VND", "D-2": "30 days after delivery" }, decidedBy: "user:anh" });
    expect(status.status).toBe("awaiting_document_approval");
    // First document missed AC for FR-3: verification failed and the bounded loop re-dispatched with findings.
    const specCalls = roles.calls.filter(item => item.taskId === "specification");
    expect(specCalls).toHaveLength(2);
    expect(specCalls[1]!.context.findings.map(item => item.code)).toContain("fr_without_ac");
    expect(status.documents).toHaveLength(2);
    expect(status.verification!.status).toBe("passed");
    expect(status.review).toMatchObject({ verdict: "approved", documentDigest: status.documents[1]!.digest });
    await expect(runtime.decideDocument("ba-1", { decision: "approved", documentDigest: status.documents[0]!.digest, decidedBy: "user:anh" }))
      .rejects.toThrow(/exact reviewed document digest/);

    status = await runtime.decideDocument("ba-1", { decision: "approved", documentDigest: docDigest(runtime, "ba-1"), decidedBy: "user:anh" });
    expect(status.status).toBe("published");
    expect(roles.calls.some(item => item.role === "developer")).toBe(false);

    const after = await tree(repo);
    const changed = Object.keys(after).filter(path => before[path] !== after[path]);
    expect(changed.sort()).toEqual(["docs/analysis/refund-ba/r1/analysis.md", "docs/analysis/refund-ba/r1/handoff.md"]);
    expect(Object.keys(before).every(path => after[path] === before[path])).toBe(true);
    const handoff = await readFile(join(repo, "docs/analysis/refund-ba/r1/handoff.md"), "utf8");
    const manifest = JSON.parse(handoff.slice(handoff.indexOf("```json") + 7, handoff.lastIndexOf("```")));
    expect(manifest).toMatchObject({ pack: PIN, revision: 1, productAcceptance: "not_established",
      document: { version: 2, digest: status.documents[1]!.digest }, review: { verdict: "approved", independentOf: "specifier:pane" },
      approval: { decidedBy: "user:anh", scope: "analysis_document" }, tdd: { mode: "not_applicable", alternativeVerification: ["manual_review"] } });
    expect(manifest.sources.observations).toEqual([{ ref: `source:src/refunds/states.ts#${sha(SOURCE)}`, path: "src/refunds/states.ts", sha256: sha(SOURCE) }]);
    expect(manifest.sources.decisions.map((item: { ref: string }) => item.ref)).toEqual(["decision:D-1", "decision:D-2"]);
    expect(manifest.unresolvedQuestions).toEqual([{ id: "D-3", question: "What availability target applies to refunds?", blocking: false }]);
    expect(handoff).toContain("không phải nghiệm thu sản phẩm");
    const analysis = await readFile(join(repo, "docs/analysis/refund-ba/r1/analysis.md"), "utf8");
    for (const label of ["Người dùng", "Quan sát source", "Suy luận", "Quyết định còn thiếu"]) expect(analysis).toContain(label);
  });

  it("denies writes, out-of-scope reads and non-independent review, and refuses agent approvals", async () => {
    const roles = new FixtureRoles({
      survey: (_assignment, call) => ({ output: { observations: [{ path: call === 1 ? "src/secret.ts" : "src/refunds/states.ts", note: "read" }] } }),
      specification: (assignment, call) => ({ output: call === 1
        ? { document: goodDocument(assignment.context), writes: [{ path: "src/refunds/states.ts", content: "hacked" }] }
        : { document: goodDocument(assignment.context) } }),
      review: assignment => ({ agentId: "specifier:pane", output: { verdict: "approved", documentDigest: assignment.context.document!.digest, findings: [] } })
    });
    const runtime = await open(roles);
    await runtime.start({ runId: "deny-1", intake: intake(), pack: PACK, packPin: PIN });
    await runtime.drive("deny-1");
    await runtime.decideBusinessQuestions("deny-1", { decision: "approved", answers: { "D-1": "5,000,000 VND", "D-2": "30 days" }, decidedBy: "user:anh" });
    const status = runtime.status("deny-1");
    expect(status.denials.map(item => [item.taskId, item.reason])).toEqual([
      ["survey", expect.stringContaining("outside the permitted paths")],
      ["specification", expect.stringContaining("writes")],
      ["review", expect.stringContaining("not the assigned reviewer role")],
      ["review", expect.stringContaining("not the assigned reviewer role")]
    ]);
    expect(await readFile(join(repo, "src/refunds/states.ts"), "utf8")).toBe(SOURCE);
    // A reviewer output from the author's identity is denied; the bounded retry is still not independent and exhausts the review.
    expect(status.status).toBe("blocked");
    expect(status.handoff).toBeUndefined();
  });

  it("blocks on a missing mandatory business decision raised during analysis and resumes through a document revision", async () => {
    const roles = new FixtureRoles({
      specification: (assignment) => ({ output: { document: goodDocument(assignment.context, { blockingQuestion: !assignment.context.decisions["D-3"] }) } })
    });
    const runtime = await open(roles);
    await runtime.start({ runId: "ba-r1", intake: intake(), pack: PACK, packPin: PIN });
    await runtime.drive("ba-r1");
    let status = await runtime.decideBusinessQuestions("ba-r1", { decision: "approved", answers: { "D-1": "5,000,000 VND", "D-2": "30 days" }, decidedBy: "user:anh" });
    expect(status.status).toBe("needs_revision");
    expect(status.blockers).toEqual(["blocking_decision_unresolved:D-3"]);
    expect(roles.calls.some(item => item.taskId === "review")).toBe(false);
    await expect(runtime.drive("ba-r1")).resolves.toMatchObject({ status: "needs_revision" });

    await runtime.revise("ba-r1", { runId: "ba-r2", reason: "User decided the availability target", answers: { "D-3": "99.5% monthly" },
      decidedBy: "user:anh", pack: PACK, packPin: PIN });
    status = await runtime.drive("ba-r2");
    expect(status.status).toBe("awaiting_business_decision");
    status = await runtime.decideBusinessQuestions("ba-r2", { decision: "approved", answers: {}, decidedBy: "user:anh" });
    expect(status.status).toBe("awaiting_document_approval");
    status = await runtime.decideDocument("ba-r2", { decision: "approved", documentDigest: docDigest(runtime, "ba-r2"), decidedBy: "user:anh" });
    expect(status.status).toBe("published");
    expect(runtime.status("ba-r1")).toMatchObject({ status: "superseded", supersededBy: "ba-r2" });
    await expect(runtime.drive("ba-r1")).rejects.toThrow(/superseded/);
    const handoff = await readFile(join(repo, "docs/analysis/refund-ba/r2/handoff.md"), "utf8");
    expect(handoff).toContain("\"supersedes\": \"ba-r1\"");
    expect(handoff).toContain("\"ref\": \"decision:D-3\"");
  });

  it("keeps a document that the human did not approve unpublished and requires a revision", async () => {
    const runtime = await open(new FixtureRoles());
    await runtime.start({ runId: "ba-cr", intake: intake(), pack: PACK, packPin: PIN });
    await runtime.drive("ba-cr");
    await runtime.decideBusinessQuestions("ba-cr", { decision: "approved", answers: { "D-1": "5,000,000 VND", "D-2": "30 days" }, decidedBy: "user:anh" });
    await expect(runtime.decideDocument("ba-cr", { decision: "approved", documentDigest: docDigest(runtime, "ba-cr"), decidedBy: "reviewer:pane" }))
      .rejects.toThrow(/human/);
    const status = await runtime.decideDocument("ba-cr", { decision: "changes_requested", reason: "Add the cancellation flow",
      documentDigest: docDigest(runtime, "ba-cr"), decidedBy: "user:anh" });
    expect(status).toMatchObject({ status: "needs_revision", blockers: ["document_changes_requested"] });
    expect((await runtime.drive("ba-cr")).handoff).toBeUndefined();
    await expect(readdir(join(repo, "docs"))).rejects.toThrow();
    // The revision hands the human feedback to the specifier of r2.
    const roles = new FixtureRoles();
    const revised = await open(roles);
    await revised.revise("ba-cr", { runId: "ba-cr2", reason: "Add the cancellation flow", pack: PACK, packPin: PIN });
    await revised.drive("ba-cr2");
    await revised.decideBusinessQuestions("ba-cr2", { decision: "approved", answers: {}, decidedBy: "user:anh" });
    const spec = roles.calls.find(item => item.taskId === "specification")!;
    expect(spec.context.findings).toContainEqual({ code: "document_feedback", ids: [], message: "Add the cancellation flow" });
  });

  it("keeps survey outputs all-or-nothing and refuses a symlinked document root", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(repo, "docs"));
    const roles = new FixtureRoles({
      survey: () => ({ output: { observations: [{ path: "src/refunds/states.ts", note: "ok" }, { path: "package.json", note: "outside" }] } })
    });
    const runtime = await open(roles);
    await runtime.start({ runId: "atomic-1", intake: intake(), pack: PACK, packPin: PIN });
    const status = await runtime.drive("atomic-1");
    expect(status.denials).toHaveLength(2);
    expect(status.status).toBe("blocked");
    expect(roles.calls.some(item => item.taskId === "specification")).toBe(false);
    expect(status.approvals.elicitation).toBeUndefined();
    const journal = JSON.parse(await readFile(join(state, "analysis-journal.json"), "utf8"));
    expect(journal.runs[0].observations).toEqual([]);

    const publish = await open(new FixtureRoles());
    await publish.start({ runId: "link-1", intake: intake({ requestId: "linked" }), pack: PACK, packPin: PIN });
    await publish.drive("link-1");
    await publish.decideBusinessQuestions("link-1", { decision: "approved", answers: { "D-1": "5,000,000 VND", "D-2": "30 days" }, decidedBy: "user:anh" });
    const final = await publish.decideDocument("link-1", { decision: "approved", documentDigest: docDigest(publish, "link-1"), decidedBy: "user:anh" });
    expect(final.handoff).toBeUndefined();
    expect(final.denials.map(item => item.reason)).toEqual([expect.stringContaining("Symlinked path refused: docs")]);
    expect(await readdir(outside)).toEqual([]);
  });

  it("re-records a journaled result after a crash before Core accepted it, without redoing publication", async () => {
    const real = new DeterministicWorkflowEngine();
    let fail = true;
    const crashing = new Proxy(real, { get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === "recordAgentResult") return async (command: { taskId: string }) => {
        if (fail && command.taskId === "publication") { fail = false; throw new Error("crash before Core result"); }
        return value.call(target, command);
      };
      return typeof value === "function" ? value.bind(target) : value;
    } }) as WorkflowEngine;
    const runtime = await open(new FixtureRoles(), ["user:anh"], crashing);
    await runtime.start({ runId: "pub-1", intake: intake(), pack: PACK, packPin: PIN });
    await runtime.drive("pub-1");
    await runtime.decideBusinessQuestions("pub-1", { decision: "approved", answers: { "D-1": "5,000,000 VND", "D-2": "30 days" }, decidedBy: "user:anh" });
    await expect(runtime.decideDocument("pub-1", { decision: "approved", documentDigest: docDigest(runtime, "pub-1"), decidedBy: "user:anh" }))
      .rejects.toThrow(/crash before Core result/);
    const restarted = await open(new FixtureRoles());
    const status = await restarted.drive("pub-1");
    expect(status.status).toBe("published");
    expect(status.rejections).toEqual([]);
  });

  it("recovers after a restart: completed tasks are not re-dispatched and an unjournaled delivery is reconciled", async () => {
    let crash = true;
    const first = new FixtureRoles({ specification: () => crash ? Promise.reject(new Error("host crashed during delivery")) as Promise<never> : undefined as never });
    const runtime = await open(first);
    await runtime.start({ runId: "rec-1", intake: intake(), pack: PACK, packPin: PIN });
    await runtime.drive("rec-1");
    await expect(runtime.decideBusinessQuestions("rec-1", { decision: "approved", answers: { "D-1": "5,000,000 VND", "D-2": "30 days" }, decidedBy: "user:anh" }))
      .rejects.toThrow(/crashed/);
    crash = false;
    const execution = "rec-1.specification.g0.a1";

    // Unknown delivery after restart: never resent.
    const blind = new FixtureRoles();
    const restartedUnknown = await open(blind);
    await expect(restartedUnknown.drive("rec-1")).rejects.toThrow(/unknown delivery/);
    expect(blind.calls).toHaveLength(0);

    // Reconciliation proves the delivered result; the run resumes without resending it or redoing earlier tasks.
    const delivered = goodDocument({ observations: [{ path: "src/refunds/states.ts", sha256: sha(SOURCE), bytes: SOURCE.length, note: "" }],
      questions: [], decisions: {}, findings: [] });
    const second = new FixtureRoles({}, new Map([[execution, { status: "completed", agentId: "specifier:pane", output: { document: delivered } }]]));
    const resumed = await open(second);
    expect(resumed.status("rec-1")).toMatchObject({ status: "blocked", blockers: [`unknown_delivery:${execution}`] });
    let status = await resumed.drive("rec-1");
    expect(second.reconciled).toEqual([execution]);
    expect(second.calls.map(item => item.taskId)).toEqual(["review"]);
    expect(status.status).toBe("awaiting_document_approval");

    // Restart again at the human gate; the approval is applied on the recovered Core aggregate.
    const third = new FixtureRoles();
    const again = await open(third);
    status = await again.decideDocument("rec-1", { decision: "approved", documentDigest: docDigest(again, "rec-1"), decidedBy: "user:anh" });
    expect(status.status).toBe("published");
    expect(third.calls).toHaveLength(0);
  });
});

describe("analysis verification", () => {
  const context = { observations: [{ path: "src/refunds/states.ts", sha256: sha(SOURCE), bytes: SOURCE.length, note: "" }],
    questions: [], decisions: {}, findings: [] };
  const verify = (document: AnalysisDocument, answered: Record<string, unknown> = { "D-1": {}, "D-2": {} }) => verifyAnalysisDocument(document, {
    intake: AnalysisIntakeSchema.parse(intake()), outputSections: resolveAnalysisPack(PACK, PIN).outputSections, observations: context.observations,
    answeredDecisions: answered, elicitedQuestions: [{ id: "D-2", question: "Window?", blocking: true }] });

  it("passes a consistent, traceable document and fails one that only exists", () => {
    expect(verify(goodDocument(context)).status).toBe("passed");
    const empty: AnalysisDocument = { schemaVersion: 1, title: "x", scope: { inScope: [], outOfScope: [] }, functionalRequirements: [], acceptanceCriteria: [],
      nfrs: [], businessFlows: [], glossary: [], notes: [], openQuestions: [], criteriaCoverage: [] };
    const result = verify(empty);
    expect(result.status).toBe("failed");
    expect(result.findings.map(item => item.code)).toEqual(expect.arrayContaining(["empty_section", "analysis_criterion_uncovered"]));
  });

  it("checks NFR oracle/workload/threshold, testable wording, provenance, scope and glossary consistency", () => {
    const document = goodDocument(context);
    document.nfrs[0] = { ...document.nfrs[0]!, threshold: undefined } as never;
    document.nfrs[1] = { ...document.nfrs[1]!, decisionId: undefined } as never;
    document.functionalRequirements[0]!.text = "Refunds are processed quickly and user-friendly";
    document.functionalRequirements[2]!.provenance = { kind: "source", refs: [`source:src/refunds/states.ts#${"0".repeat(64)}`] };
    document.scope.outOfScope.push({ id: "S-3", text: "Refund requests for delivered orders.", provenance: { kind: "user", refs: ["intake:U-1"] } });
    document.glossary.push({ id: "G-2", term: "refund window", text: "Something else", provenance: { kind: "inference", refs: ["FR-1"] } });
    document.notes.push({ id: "N-2", kind: "api", text: "POST /refunds", provenance: { kind: "inference", refs: ["FR-1"] } });
    const codes = verify(document).findings.map(item => item.code);
    expect(codes).toEqual(expect.arrayContaining(["nfr_incomplete", "untestable_wording", "provenance_invalid", "scope_conflict", "glossary_conflict", "deliverable_missing"]));
    expect(codes.filter(item => item === "nfr_incomplete")).toHaveLength(2);
  });

  it("blocks on unanswered blocking decisions and keeps non-blocking ones as unresolved", () => {
    const blocked = verify(goodDocument(context), { "D-1": {} });
    expect(blocked.status).toBe("blocked");
    expect(blocked.findings.find(item => item.severity === "blocking")!.ids).toEqual(["D-2"]);
    expect(verify(goodDocument(context)).unresolved.map(item => item.id)).toEqual(["D-3"]);
  });
});
