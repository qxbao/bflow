import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  ApprovalDecisionSchema,
  ArtifactReferenceSchema,
  PaneBindingSchema,
  RoleMessageSchema,
  pinRoleProfile,
  type ResolvedRoleProfileSnapshot,
  type RoleProfileDefinition,
  type Specification
} from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { CoreSession } from "../../src/agentic/core-session.js";
import {
  normalizeSpecificationOptionals,
  normalizeWorkflowDefinitionOptionals
} from "../../src/agentic/assessment-input.js";
import {
  planningReferenceView,
  summarizeInspectRun
} from "../../src/agentic/mcp-output-views.js";
import { digest, type JournalState, type RunRecord } from "../../src/agentic/journal.js";
import { lifecycleFixture } from "../helpers/lifecycle-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

function makeProfileSnapshot(
  baseRole: "reviewer" | "architect" | "developer",
  profileId = `${baseRole}-custom`
): ResolvedRoleProfileSnapshot {
  const definition: RoleProfileDefinition = {
    schemaVersion: 3,
    profileId,
    version: "1.0.0",
    baseRole,
    displayName: `Custom ${baseRole}`,
    additionalInstructions: "Follow policy.",
    skillPins: [],
    toolRequirements: [],
    restrictions: {}
  };
  return {
    schemaVersion: 3,
    pin: pinRoleProfile(definition),
    definition,
    baseRolePolicyDigest: "b".repeat(64),
    resolutionPolicyVersion: "custom-specialist-profiles-v1"
  };
}

async function bootIntake(f: Awaited<ReturnType<typeof lifecycleFixture>>) {
  await f.runtime.initialize();
  await f.runtime.queueHerdr(f.intakeMessage);
  await f.runtime.flushOutbound();
  await f.runtime.receiveHerdr(f.intakeMessage);
}

describe("Flow 05 — Coordinator, SDD, Planning & Core DAG Hardening", () => {
  it("blocks fastPath design auto-approval bypass on human changes_requested follow-up runs and supports revised version > 1 specifications with revisionReason", async () => {
    const f = await lifecycleFixture(cleanups);
    (f.ports as { fastPathMode?: "auto" | "off" }).fastPathMode = "auto";
    (f.ports as { projectApprovalRequired: () => boolean }).projectApprovalRequired = () => true;
    await bootIntake(f);

    // Make initial proposal human-approval gated by setting requiresApproval: true on run1Def.tasks[0]
    const run1Def = structuredClone(f.def);
    run1Def.tasks[0]!.requiresApproval = true;
    await f.runtime.proposeWorkflow("run-1", f.spec, run1Def);
    expect((await f.run("run-1")).status).toBe("awaiting_approval");

    // Human requests design changes -> creates follow-up run-1-r2
    await f.approve("changes_requested", "run-1");
    const parent = await f.run("run-1");
    expect(parent.supersededBy).toBe("run-1-r2");
    const childBefore = await f.run("run-1-r2");
    expect(childBefore.status).toBe("planning");

    // On run-1-r2, even when requiresApproval is dropped so trivial docs spec qualifies for fastPath,
    // followUpOrRevision is detected and human design approval CANNOT be bypassed after human requested design changes!
    // Also test version: 2 enforcement of revisionReason.
    const followUpSpecNoReason: Specification = {
      ...structuredClone(f.spec),
      runId: "run-1-r2",
      version: 2
    };
    await expect(f.runtime.proposeWorkflow("run-1-r2", followUpSpecNoReason, f.def)).rejects.toThrow(
      /revisionReason/i
    );

    const followUpSpecWithReason: Specification = {
      ...followUpSpecNoReason,
      metadata: {
        ...followUpSpecNoReason.metadata,
        sdd: {
          ...(followUpSpecNoReason.metadata!.sdd as Record<string, unknown>),
          revisionReason: "Incorporate human design feedback on header phrasing"
        }
      }
    };
    await f.runtime.proposeWorkflow("run-1-r2", followUpSpecWithReason, f.def);
    const childAfter = await f.run("run-1-r2");
    expect(childAfter.fastPath?.reasons).toContain("recomputed for follow-up or requirement revision");
    expect(childAfter.status).toBe("awaiting_approval");
    expect(childAfter.approvalKind).toBe("design");
    expect(childAfter.workflowSpec?.specification.version).toBe(2);
    expect(childAfter.approval?.revision).toBe(2);
  }, 60_000);

  it("inherits accepted evolvable prototype across design changes_requested follow-up runs and verifies lineage evidence while rejecting foreign artifacts", async () => {
    const f = await lifecycleFixture(cleanups);
    (f.ports as { projectApprovalRequired: () => boolean }).projectApprovalRequired = () => true;
    await bootIntake(f);

    await f.runtime.proposePrototype("run-1", {
      purpose: "Preview layout flow",
      flows: [{ id: "flow-main", description: "Main preview layout flow" }],
      allowedPaths: ["prototype/index.html"],
      artifacts: ["HTML layout preview"],
      criteria: [{ id: "proto-c1", description: "Renders preview card", flowIds: ["flow-main"] }],
      disposition: "evolvable",
      environment: "mock",
      dataPolicy: "synthetic",
      maxRevisions: 2
    });
    await f.runtime.submitPrototype("run-1", {
      scopeVersion: 1,
      summary: "Prototype v1",
      files: [{ path: "prototype/index.html", mediaType: "text/html", flowIds: ["flow-main"], content: "<main>Demo</main>" }]
    });
    const protoApproval = (await f.run("run-1")).prototype!.approvals.at(-1)!.request;
    await f.runtime.receiveHerdr(
      f.envelope(
        "approval.decision",
        ApprovalDecisionSchema.parse({
          schemaVersion: 2,
          approvalId: protoApproval.approvalId,
          runId: "run-1",
          sessionId: "session-1",
          target: protoApproval.target,
          revision: protoApproval.revision,
          generation: protoApproval.generation,
          decision: "approved",
          decidedBy: "human-1",
          decidedAt: new Date().toISOString(),
          feedbackArtifacts: [],
          idempotencyKey: randomUUID()
        }),
        { run_id: "run-1" }
      )
    );
    expect((await f.run("run-1")).prototype?.status).toBe("accepted");

    const defWithProto = structuredClone(f.def);
    defWithProto.tasks[0]!.metadata = { ...defWithProto.tasks[0]!.metadata, retainsPrototype: true };
    await f.runtime.proposeWorkflow("run-1", f.spec, defWithProto);
    expect((await f.run("run-1")).status).toBe("awaiting_approval");

    // Request design changes WITH a feedbackArtifact on run-1 -> run-1-r2 must rebind feedbackArtifacts & prototype artifacts
    // so BOTH requestSpecialist and proposeWorkflow + design approval succeed without RoleMessageSchema runId mismatch!
    const feedbackBytes = Buffer.from("Human markup notes");
    const feedbackRef = ArtifactReferenceSchema.parse(
      unwrap(
        await f.ports.artifactStore.put({
          options: {
            artifactId: `feedback-${randomUUID()}`,
            runId: "run-1",
            kind: "document",
            mediaType: "text/plain",
            expectedIntegrity: {
              checksum: { algorithm: "sha256", value: createHash("sha256").update(feedbackBytes).digest("hex") },
              sizeBytes: feedbackBytes.length
            },
            idempotencyKey: `feedback-${randomUUID()}`
          },
          content: (async function* () {
            yield feedbackBytes;
          })()
        })
      )
    );
    const run1DesignApproval = (await f.run("run-1")).approval!;
    await f.runtime.receiveHerdr(
      f.envelope(
        "approval.decision",
        ApprovalDecisionSchema.parse({
          schemaVersion: 2,
          approvalId: run1DesignApproval.approvalId,
          runId: "run-1",
          sessionId: "session-1",
          target: run1DesignApproval.target,
          revision: run1DesignApproval.revision,
          generation: run1DesignApproval.generation,
          decision: "changes_requested",
          reason: "Adjust header spacing per attached markup",
          decidedBy: "human-1",
          decidedAt: new Date().toISOString(),
          feedbackArtifacts: [feedbackRef],
          idempotencyKey: randomUUID()
        }),
        { run_id: "run-1" }
      )
    );

    const specMsg = RoleMessageSchema.parse(
      await f.runtime.requestSpecialist("run-1-r2", "architect", "Review feedback markup", ["architecture"])
    );
    expect(specMsg.artifact_references[0]?.runId).toBe("run-1-r2");

    const r2Spec = { ...structuredClone(f.spec), runId: "run-1-r2" };
    await f.runtime.proposeWorkflow("run-1-r2", r2Spec, defWithProto);
    expect((await f.run("run-1-r2")).status).toBe("awaiting_approval");

    await f.approve("approved", "run-1-r2");
    const approvedChild = await f.run("run-1-r2");
    expect(approvedChild.status).toBe("implementing");
    expect(approvedChild.coreCreated).toBe(true);

    // Verify an unrelated foreign-run artifact is STILL rejected by verifyReferences
    const foreignBytes = Buffer.from("foreign-content");
    const foreignRef = ArtifactReferenceSchema.parse(
      unwrap(
        await f.ports.artifactStore.put({
          options: {
            artifactId: `foreign-${randomUUID()}`,
            runId: "unrelated-foreign-run",
            kind: "document",
            mediaType: "text/plain",
            expectedIntegrity: {
              checksum: { algorithm: "sha256", value: createHash("sha256").update(foreignBytes).digest("hex") },
              sizeBytes: foreignBytes.length
            },
            idempotencyKey: `foreign-${randomUUID()}`
          },
          content: (async function* () {
            yield foreignBytes;
          })()
        })
      )
    );
    await expect((f.runtime as any).verifyReferences([foreignRef], "run-1-r2", ["run-1", "run-1-r2"])).rejects.toThrow(
      "Foreign artifact"
    );
  }, 60_000);

  it("allows Runtime-bound verifiers to request user decisions and routes profiled specialist/verifier decision answers to the profiled pane binding", async () => {
    const f = await lifecycleFixture(cleanups);
    const architectProfile = makeProfileSnapshot("architect", "sec-architect");
    f.ports.roleProfiles = [architectProfile];
    f.ports.preflightRoleProfile = async () => {};
    f.ports.roleCapabilities.qa = ["testing", "verification", "repository.read"];
    const baseGetManifest = f.panes.getManifest.bind(f.panes);
    f.ports.panes.getManifest = async () => {
      const res = await baseGetManifest();
      return { ...res, value: { ...res.value, roleProfiles: [architectProfile] } };
    };
    f.ports.attestExecutorLineage = async (binding, purpose, assignmentId) => ({
      schemaVersion: 3,
      executorId: binding.agentId,
      launchId: `launch-${binding.agentId}`,
      nativeSessionId: binding.session!.value,
      bindingId: binding.bindingId,
      freshContext: true,
      purpose,
      assignmentIds: [assignmentId]
    });
    f.ports.panes.allocateSpecialist = async request => {
      const binding = PaneBindingSchema.parse({
        ...f.binding("architect"),
        bindingId: `profile-bind-${request.taskId}`,
        paneId: `pane-profile-${request.taskId}`,
        agentId: `agent-profile-${request.taskId}`,
        session: { source: "test", kind: "id", value: `session-profile-${request.taskId}` },
        roleProfile: request.roleProfile.pin
      });
      f.panes.bindings.push(binding);
      await f.ports.registry.upsert({
        agentId: binding.agentId,
        role: "architect",
        transport: "herdr",
        enabled: true,
        priority: 1,
        maxConcurrentTasks: 1,
        capabilities: ["architecture", "repository.read"],
        settings: {}
      });
      return { ok: true, value: binding };
    };

    await bootIntake(f);

    // 1. Profiled architect requests a user decision; answer must enqueue to profile binding selector with roleProfile
    await f.runtime.requestSpecialist("run-1", "architect", "Review threat boundaries", ["architecture"], architectProfile.pin);
    const profiledBinding = f.panes.bindings.find(b => b.bindingId.startsWith("profile-bind-"))!;
    await f.runtime.flushOutbound();

    const archReceipt = (await f.runtime.requestUserDecision(profiledBinding, "architect", {
      runId: "run-1",
      taskId: "arch-scope",
      question: "Allow internal service mesh header?",
      options: ["Allow mesh header", "Deny mesh header"]
    })) as { approvalId: string };

    const archReq = (await f.run("run-1")).userDecisions![archReceipt.approvalId]!.request;
    await f.runtime.receiveHerdr(
      f.envelope(
        "approval.decision",
        ApprovalDecisionSchema.parse({
          schemaVersion: 2,
          approvalId: archReq.approvalId,
          runId: "run-1",
          sessionId: "session-1",
          target: archReq.target,
          revision: archReq.revision,
          generation: archReq.generation,
          decision: "approved",
          reason: "Approved mesh header",
          metadata: { selectedOption: "Allow mesh header" },
          decidedBy: "human-1",
          decidedAt: new Date().toISOString(),
          feedbackArtifacts: [],
          idempotencyKey: randomUUID()
        }),
        { run_id: "run-1" }
      )
    );

    const resumedArchOut = [...(await f.state()).outbound]
      .reverse()
      .find(o => o.message.recipient.role === "architect" && o.message.type === "task.status");
    expect(resumedArchOut).toBeDefined();
    expect(resumedArchOut?.selector).toBe(profiledBinding.bindingId);
    expect(resumedArchOut?.roleProfile).toEqual(architectProfile.pin);

    // 2. Verifier bound via verification.requested can call requestUserDecision
    (f.ports as { automaticAlternativeEvidence?: boolean }).automaticAlternativeEvidence = true;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    await f.submit("implement", "updated docs\n", "run-1");
    await f.runtime.flushOutbound();

    const qaBinding = f.binding("qa");
    const qaReceipt = (await f.runtime.requestUserDecision(qaBinding, "qa", {
      runId: "run-1",
      taskId: "implement",
      question: "Confirm manual formatting acceptability?",
      options: ["Accept formatting", "Reject formatting"]
    })) as { approvalId: string; status: string };
    expect(qaReceipt.status).toBe("pending");
  }, 60_000);

  it("deduplicates active requestSpecialist calls idempotently, advances attempt keys after inconclusive/failed replies, and cleans up settled profiled specialists immediately", async () => {
    const f = await lifecycleFixture(cleanups);
    const reviewerProfile = makeProfileSnapshot("reviewer", "db-reviewer");
    f.ports.roleProfiles = [reviewerProfile];
    f.ports.preflightRoleProfile = async () => {};
    const baseGetManifest2 = f.panes.getManifest.bind(f.panes);
    f.ports.panes.getManifest = async () => {
      const res = await baseGetManifest2();
      return { ...res, value: { ...res.value, roleProfiles: [reviewerProfile] } };
    };
    f.ports.attestExecutorLineage = async (binding, purpose, assignmentId) => ({
      schemaVersion: 3,
      executorId: binding.agentId,
      launchId: `launch-${binding.agentId}`,
      nativeSessionId: binding.session!.value,
      bindingId: binding.bindingId,
      freshContext: true,
      purpose,
      assignmentIds: [assignmentId]
    });
    let allocatedTaskIds: string[] = [];
    let releasedTaskIds: string[] = [];
    f.ports.panes.allocateSpecialist = async request => {
      allocatedTaskIds.push(request.taskId);
      const binding = PaneBindingSchema.parse({
        ...f.binding("reviewer"),
        bindingId: `bind-${request.taskId}`,
        paneId: `pane-${request.taskId}`,
        agentId: `agent-${request.taskId}`,
        session: { source: "test", kind: "id", value: `session-${request.taskId}` },
        roleProfile: request.roleProfile.pin
      });
      f.panes.bindings.push(binding);
      await f.ports.registry.upsert({
        agentId: binding.agentId,
        role: "reviewer",
        transport: "herdr",
        enabled: true,
        priority: 1,
        maxConcurrentTasks: 1,
        capabilities: ["review", "repository.read"],
        settings: {}
      });
      return { ok: true, value: binding };
    };
    f.ports.panes.releaseSpecialist = async request => {
      releasedTaskIds.push(request.taskId);
      return { ok: true, value: undefined };
    };

    await bootIntake(f);

    // Duplicate call while first request is queued/accepted returns identical message idempotently
    const first = RoleMessageSchema.parse(
      await f.runtime.requestSpecialist("run-1", "reviewer", "Audit SQL indexes", ["review"], reviewerProfile.pin)
    );
    const duplicate = RoleMessageSchema.parse(
      await f.runtime.requestSpecialist("run-1", "reviewer", "Audit SQL indexes", ["review"], reviewerProfile.pin)
    );
    expect(duplicate.message_id).toBe(first.message_id);
    expect(allocatedTaskIds).toHaveLength(1);

    await f.runtime.flushOutbound();
    const firstOut = (await f.state()).outbound.find(o => o.message.message_id === first.message_id)!;
    expect(firstOut.handle).toBeDefined();
    // Specialist replies with status: "inconclusive" -> settles attempt 1 (even before a second flushOutbound / tick!)
    await f.runtime.receiveHerdr(
      f.envelope(
        "task.status",
        { status: "inconclusive", summary: "Need second pass after schema check" },
        {
          causation_id: first.message_id,
          sender: {
            role: "reviewer",
            agent_id: firstOut.handle!.target.agentId,
            pane_id: firstOut.handle!.target.paneId
          },
          recipient: { role: "coordinator" },
          run_id: "run-1"
        }
      )
    );

    // Retry WITHOUT an intervening tick() or second flushOutbound(): must release settled profile allocation and advance to #attempt-2!
    const retry = RoleMessageSchema.parse(
      await f.runtime.requestSpecialist("run-1", "reviewer", "Audit SQL indexes", ["review"], reviewerProfile.pin)
    );
    expect(retry.message_id).not.toBe(first.message_id);
    expect(String((retry.payload as Record<string, unknown>).idempotencyKey)).toContain("#attempt-2");
    expect(releasedTaskIds).toHaveLength(1);
    expect(allocatedTaskIds).toHaveLength(2);
    expect(allocatedTaskIds[1]).not.toBe(allocatedTaskIds[0]);
  }, 60_000);

  it("normalizes flat-JSON LLM nulls/empty optionals, blocks path traversal & empty requiredCapabilities bypass, accepts trailing-slash affectedPaths, and matches NFC/NFD criteria", async () => {
    const f = await lifecycleFixture(cleanups);

    // 1. Flat-JSON null/empty-string normalization
    const normalizedSpec = normalizeSpecificationOptionals({
      ...structuredClone(f.spec),
      architectureNotes: "",
      scope: { inScope: ["guide.md"], outOfScope: null },
      acceptanceCriteria: [
        {
          ...f.spec.acceptanceCriteria[0]!,
          evidenceArtifactIds: null,
          waiverReason: ""
        }
      ],
      metadata: {
        ...f.spec.metadata,
        sdd: {
          ...(f.spec.metadata!.sdd as Record<string, unknown>),
          designProposal: "",
          revisionReason: null,
          assessment: {
            ...((f.spec.metadata!.sdd as Record<string, unknown>).assessment as Record<string, unknown>),
            unresolvedQuestions: null
          }
        }
      }
    }) as Record<string, any>;
    expect(normalizedSpec.architectureNotes).toBeUndefined();
    expect(normalizedSpec.scope.outOfScope).toEqual([]);
    expect(normalizedSpec.acceptanceCriteria[0].evidenceArtifactIds).toEqual([]);
    expect(normalizedSpec.acceptanceCriteria[0].waiverReason).toBeUndefined();

    const normalizedDef = normalizeWorkflowDefinitionOptionals({
      ...structuredClone(f.def),
      description: "",
      dependencies: null,
      qualityGates: null,
      tasks: [
        {
          ...f.def.tasks[0]!,
          description: "",
          qualityGates: null,
          metadata: { ownedPaths: ["guide.md"], conditionalTdd: null, forbiddenPaths: null }
        }
      ]
    }) as Record<string, any>;
    expect(normalizedDef.description).toBeUndefined();
    expect(normalizedDef.dependencies).toEqual([]);
    expect(normalizedDef.qualityGates).toEqual([]);
    expect(normalizedDef.tasks[0].qualityGates).toEqual([]);

    // 2. NFC/NFD criterion IDs + trailing-slash affectedPaths + traversal & empty requiredCapabilities rejection
    const nfcCritId = "ac-hướng-dẫn-1".normalize("NFC");
    const nfdCritId = "ac-hướng-dẫn-1".normalize("NFD");
    f.spec.acceptanceCriteria[0]!.id = nfcCritId;
    (f.spec.metadata!.sdd as any).traceability[0].criterionId = nfdCritId;
    const intake = f.envelope(
      "delegation.request",
      {
        ...(f.intakeMessage.payload as Record<string, unknown>),
        acceptanceCriteria: [{ ...f.spec.acceptanceCriteria[0]!, id: nfcCritId }]
      },
      { message_id: "intake-1", idempotency_key: "intake-1" }
    );
    await f.runtime.queueHerdr(intake);
    await f.runtime.flushOutbound();
    await f.runtime.receiveHerdr(intake);

    // Rejects path traversal '..' inside ownedPaths
    const traversalSpec = { ...structuredClone(f.spec), affectedPaths: ["packages/foo"] };
    const traversalDef = structuredClone(f.def);
    traversalDef.tasks[0]!.acceptanceCriteria = [nfdCritId];
    traversalDef.tasks[0]!.metadata = { ownedPaths: ["packages/foo/../contracts/src"] };
    await expect(f.runtime.proposeWorkflow("run-1", traversalSpec, traversalDef)).rejects.toThrow(
      /Task ownership must be within approved literal affectedPaths/
    );

    // Rejects empty requiredCapabilities: [] bypass
    const emptyCapsDef = structuredClone(f.def);
    emptyCapsDef.tasks[0]!.acceptanceCriteria = [nfdCritId];
    emptyCapsDef.tasks[0]!.metadata = { ownedPaths: ["guide.md"], requiredCapabilities: [] };
    await expect(f.runtime.proposeWorkflow("run-1", f.spec, emptyCapsDef)).rejects.toThrow(
      /requiredCapabilities cannot be empty/
    );

    // Accepts trailing-slash affectedPaths ("docs/") with nested ownedPaths ("docs/guide.md") and NFD criterionId
    const slashSpec = {
      ...structuredClone(f.spec),
      affectedPaths: ["docs/"],
      acceptanceCriteria: [{ ...f.spec.acceptanceCriteria[0]!, id: nfdCritId }]
    };
    const slashDef = structuredClone(f.def);
    slashDef.tasks[0]!.acceptanceCriteria = [nfdCritId];
    slashDef.tasks[0]!.metadata = { ownedPaths: ["docs/guide.md"] };
    await f.runtime.proposeWorkflow("run-1", slashSpec, slashDef);
    expect((await f.run("run-1")).status).toBe("implementing");
  }, 60_000);

  it("keeps sibling tasks running on retryable multi-task developer allocation contention and re-arms unsent cancelled task.assignments after run resume", async () => {
    const f = await lifecycleFixture(cleanups);
    await bootIntake(f);

    const twoTaskSpec = {
      ...structuredClone(f.spec),
      affectedPaths: ["docs-a", "docs-b"],
      traceabilityTaskIds: ["task-a", "task-b"],
      metadata: {
        ...f.spec.metadata,
        sdd: {
          ...(f.spec.metadata!.sdd as Record<string, unknown>),
          traceability: [{ criterionId: "ac-1", taskIds: ["task-a", "task-b"] }]
        }
      }
    };
    const baseTask = f.def.tasks[0]!;
    const twoTaskDef = {
      ...structuredClone(f.def),
      maxConcurrency: 2,
      tasks: [
        { ...structuredClone(baseTask), id: "task-a", metadata: { ownedPaths: ["docs-a"] } },
        { ...structuredClone(baseTask), id: "task-b", metadata: { ownedPaths: ["docs-b"] } }
      ]
    };

    // First: retryable non-"conflict" error on task-b must NOT escalate the run while task-a is queued!
    const origAlloc = f.panes.allocateDeveloper.bind(f.panes);
    let mode: "retryable_transient" | "fatal_once" | "ok" = "retryable_transient";
    f.panes.allocateDeveloper = (async (req: { taskId: string; worktreePath: string; agentName: string }) => {
      if (req.taskId.endsWith("task-b") && mode === "retryable_transient") {
        return { ok: false as const, error: { code: "unavailable" as const, message: "pane warming up", retryable: true } };
      }
      if (req.taskId.endsWith("task-b") && mode === "fatal_once") {
        return { ok: false as const, error: { code: "unavailable" as const, message: "broken launcher", retryable: false } };
      }
      return origAlloc(req);
    }) as any;

    await f.runtime.proposeWorkflow("run-1", twoTaskSpec, twoTaskDef);
    await f.runtime.tick();
    expect((await f.run("run-1")).status).toBe("implementing");
    const taskAOut = (await f.state()).outbound.find(o => o.taskId === "task-a" && o.message.type === "task.assignment");
    expect(taskAOut?.status).toBe("accepted");

    // Second: simulate a run where task-a was queued (unsent) when task-b hit a fatal escalation that cancelled task-a's unsent outbound,
    // then operator repairs and resumes -> task-a MUST be re-armed instead of stranded!
    const f2 = await lifecycleFixture(cleanups);
    await bootIntake(f2);
    const origAlloc2 = f2.panes.allocateDeveloper.bind(f2.panes);
    let failTaskB = true;
    f2.panes.allocateDeveloper = (async (req: { taskId: string; worktreePath: string; agentName: string }) => {
      if (req.taskId.endsWith("task-b") && failTaskB) {
        return { ok: false as const, error: { code: "unavailable" as const, message: "broken launcher", retryable: false } };
      }
      return origAlloc2(req);
    }) as any;
    await f2.runtime.proposeWorkflow("run-1", twoTaskSpec, twoTaskDef);
    await f2.runtime.tick();
    expect((await f2.run("run-1")).status).toBe("escalated");
    const cancelledTaskA = (await f2.state()).outbound.find(o => o.taskId === "task-a" && o.message.type === "task.assignment");
    expect(cancelledTaskA?.status).toBe("cancelled");

    // Operator repairs launcher and resumes run
    failTaskB = false;
    await (f2.runtime as any).journal.exclusive(async (s: JournalState, save: () => Promise<void>) => {
      const r = s.runs[0]!;
      r.status = "implementing";
      delete r.error;
      delete r.pendingAction;
      await save();
    });
    await f2.runtime.tick();
    const afterResume = (await f2.state()).outbound.filter(o => o.message.type === "task.assignment" && o.status === "accepted");
    expect(afterResume.map(o => o.taskId).sort()).toEqual(["task-a", "task-b"]);
  }, 60_000);

  it("recovers CoreSession.create cleanly after a crash between runStore.appendEvents and coreCreated=true, and skips idle multi-task advance() spam after checkpoint", async () => {
    const f = await lifecycleFixture(cleanups);
    await bootIntake(f);

    const seqSpec = {
      ...structuredClone(f.spec),
      affectedPaths: ["docs-1", "docs-2"],
      traceabilityTaskIds: ["task-1", "task-2"],
      metadata: {
        ...f.spec.metadata,
        sdd: {
          ...(f.spec.metadata!.sdd as Record<string, unknown>),
          traceability: [{ criterionId: "ac-1", taskIds: ["task-1", "task-2"] }]
        }
      }
    };
    const baseTask = f.def.tasks[0]!;
    const seqDef = {
      ...structuredClone(f.def),
      maxConcurrency: 1,
      tasks: [
        { ...structuredClone(baseTask), id: "task-1", metadata: { ownedPaths: ["docs-1"] } },
        { ...structuredClone(baseTask), id: "task-2", metadata: { ownedPaths: ["docs-2"] } }
      ],
      dependencies: [{ taskId: "task-2", dependsOnTaskId: "task-1", condition: "succeeded" as const }]
    };

    await f.runtime.proposeWorkflow("run-1", seqSpec, seqDef);

    // 1. Simulate crash BEFORE run.coreCreated = true was saved, AFTER runStore already committed version 2 events, with a fresh engine on restart
    const freshEngine = new DeterministicWorkflowEngine();
    await (f.runtime as any).journal.exclusive(async (s: JournalState, save: () => Promise<void>) => {
      s.runs[0]!.coreCreated = false;
      await save();
      const session = new CoreSession({ ...f.ports, engine: freshEngine }, s, save);
      await session.create(s.runs[0]!);
    });
    expect((await f.run("run-1")).coreCreated).toBe(true);
    expect(unwrap(await freshEngine.getSnapshot("run-1"))?.version).toBe(2);

    // 2. Dispatch task-1, checkpoint the Core session, and verify a subsequent idle tick does NOT spam engine.advance() while task-2 is pending on task-1
    await f.runtime.tick();
    await (f.runtime as any).journal.exclusive(async (s: JournalState, save: () => Promise<void>) => {
      const session = new CoreSession(f.ports, s, save, (f.runtime as any).coreRestoreCache);
      await session.checkpoint("run-1");
    });
    const versionAfterCheckpoint = unwrap(await f.ports.engine.getSnapshot("run-1"))!.version;
    const advanceSpy = vi.spyOn(f.ports.engine, "advance");
    await f.runtime.tick();
    expect(advanceSpy).not.toHaveBeenCalled();
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))!.version).toBe(versionAfterCheckpoint);
  }, 60_000);

  it("reports only verified tasks in completedTaskIds, surfaces rework/drift/prototype/fastPath in compact inspect views, and keeps compact planning_reference < 6 KB", async () => {
    const sampleRun: Partial<RunRecord> & Record<string, unknown> = {
      runId: "run-compact-1",
      status: "implementing",
      cancelled: false,
      coreCreated: true,
      fastPath: {
        status: "downgraded",
        decidedAt: "2026-10-31T00:00:00.000Z",
        downgradedAt: "2026-10-31T00:01:00.000Z",
        downgradeReason: "Test integrity check triggered",
        blockers: [],
        reasons: ["trivial"],
        classificationDigest: digest("cls")
      },
      executionPlanDrift: {
        detectedAt: "2026-10-31T00:02:00.000Z",
        reason: "Provider changed",
        differences: ["developer provider"]
      },
      tasks: [
        {
          taskId: "task-verified",
          outboundIds: ["m-1"],
          result: { status: "succeeded" },
          cycle: { cycleId: "c-1", iteration: 1, maxIterations: 3, status: "passed" },
          spec: { request: {}, strategy: {} }
        } as any,
        {
          taskId: "task-rework",
          outboundIds: ["m-2"],
          result: { status: "succeeded" },
          cycle: { cycleId: "c-2", iteration: 1, maxIterations: 3, status: "rework_required" },
          spec: { request: {}, strategy: {} }
        } as any
      ]
    };

    const statusView = summarizeInspectRun(sampleRun, { runId: "run-compact-1", view: "status" }) as Record<string, any>;
    expect(statusView.completedTaskIds).toEqual(["task-verified"]);
    expect(statusView.submittedUnverifiedTaskIds).toEqual(["task-rework"]);
    expect(statusView.pendingTaskIds).toEqual(["task-rework"]);
    expect(statusView.fastPath.status).toBe("downgraded");
    expect(statusView.executionPlanDrift.reason).toBe("Provider changed");

    const blockersView = summarizeInspectRun(sampleRun, { runId: "run-compact-1", view: "blockers" }) as Record<string, any>;
    expect(blockersView.taskBlockers.map((t: any) => t.taskId)).toEqual(["task-rework"]);
    expect(blockersView.fastPath.status).toBe("downgraded");
    expect(blockersView.executionPlanDrift.reason).toBe("Provider changed");

    const compactPlanning = (await planningReferenceView(
      { section: "all", view: "compact" },
      { runnerInfo: { mode: "automatic" }, verificationSandbox: { status: "ready" }, behavioralCommands: [] }
    )) as Record<string, any>;
    expect(Buffer.byteLength(JSON.stringify(compactPlanning), "utf8")).toBeLessThan(6000);
    expect(compactPlanning.sections.specification.schema.superRefineRules.join(" ")).toContain("testStrategy & tddDecision");
  });
});
