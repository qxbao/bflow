import { afterEach, describe, expect, it } from "vitest";
import { pinRoleProfile, type ResolvedRoleProfileSnapshot } from "@bflow/contracts";
import { cleanups, fixture, git } from "../helpers/agentic-integration-fixture.js";
import * as admission from "../../src/agentic/runtime.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const definition = { schemaVersion: 3 as const, profileId: "backend-developer", version: "1.0.0", displayName: "Backend Developer",
  baseRole: "developer" as const, additionalInstructions: "Use transactions.", skillPins: [], toolRequirements: [], restrictions: {} };
const snapshot = (): ResolvedRoleProfileSnapshot => ({ schemaVersion: 3, pin: pinRoleProfile(definition), definition,
  baseRolePolicyDigest: "b".repeat(64), resolutionPolicyVersion: "custom-specialist-profiles-v1" });
function configure(f: Awaited<ReturnType<typeof fixture>>, profile = snapshot()) {
  f.ports.roleProfiles = [profile]; f.ports.preflightRoleProfile = async () => {};
  const manifest = f.panes.getManifest.bind(f.panes);
  f.ports.panes.getManifest = async () => { const result = await manifest(); return { ...result, value: { ...result.value, roleProfiles: [profile] } }; };
  f.ports.attestExecutorLineage = async (binding, purpose, assignmentId) => ({ schemaVersion: 3, executorId: binding.agentId,
    launchId: `launch-${binding.agentId}`, nativeSessionId: binding.session!.value, bindingId: binding.bindingId,
    freshContext: true, purpose, assignmentIds: [assignmentId] });
  const allocate = f.panes.allocateDeveloper.bind(f.panes);
  f.ports.panes.allocateDeveloper = async request => {
    const result = await allocate(request);
    if (result.ok && request.roleProfile) result.value.roleProfile = request.roleProfile.pin;
    return result;
  };
  f.def.tasks[0]!.roleProfile = profile.pin;
  return profile;
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
describe("RP-01 actual Runtime admission and dispatch", () => {
  it("rejects an unknown selected profile before creating a workflow or worktree", async () => {
    const f = await fixture(); f.def.tasks[0]!.roleProfile = snapshot().pin;
    await expect(f.runtime.proposeWorkflow("run-1", f.spec, f.def)).rejects.toThrow(/profile/i);
    expect((await f.inspect()).definition).toBeUndefined();
    expect(f.transport.sentRequests.filter(request => request.role === "developer")).toHaveLength(0);
  });
  it("pins a selected developer profile into acceptance, allocation and dispatch", async () => {
    const f = await fixture(), profile = snapshot();
    f.ports.roleProfiles = [profile]; f.ports.preflightRoleProfile = async () => {};
    f.ports.attestExecutorLineage = async (binding, purpose, assignmentId) => ({ schemaVersion: 3, executorId: binding.agentId,
      launchId: `launch-${binding.agentId}`, nativeSessionId: binding.session!.value, bindingId: binding.bindingId,
      freshContext: true, purpose, assignmentIds: [assignmentId] });
    const allocate = f.panes.allocateDeveloper.bind(f.panes);
    f.ports.panes.allocateDeveloper = async request => {
      const result = await allocate(request);
      if (result.ok && request.roleProfile) result.value.roleProfile = request.roleProfile.pin;
      return result;
    };
    f.def.tasks[0]!.roleProfile = profile.pin;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    expect((await f.inspect()).roleProfiles).toEqual([profile]);
    const request = f.transport.sentRequests.find(value => value.role === "developer")!;
    expect(request).toBeDefined();
    expect((request.context as any).payload.assignment.roleProfile).toEqual(profile.pin);
    expect((await f.runtime.inspect() as any).outbound.find((out: any) => out.assignment?.roleProfile)?.executorLineage).toMatchObject({ freshContext: true, purpose: "implementation" });
  });
  it("rejects capability escalation or an empty write intersection before allocation", async () => {
    for (const restrictions of [{ capabilityIds: [] }, { writablePaths: ["other.md"] }]) {
      const f = await fixture(), profile = snapshot(); profile.definition = { ...definition, restrictions }; profile.pin = pinRoleProfile(profile.definition);
      f.ports.roleProfiles = [profile]; f.ports.preflightRoleProfile = async () => {};
      f.def.tasks[0]!.roleProfile = profile.pin;
      await expect(f.runtime.proposeWorkflow("run-1", f.spec, f.def)).rejects.toThrow(/profile|capability|scope/i);
      expect(f.transport.sentRequests.filter(request => request.role === "developer")).toHaveLength(0);
    }
  });
  it("preflights a profiled task with its own required capabilities before design approval", async () => {
    const f = await fixture(); configure(f);
    const seen: string[][] = [];
    f.ports.preflightRoleProfile = async (_profile, _role, required) => {
      seen.push([...required]);
      if (required.includes("typescript")) throw new Error("Profile capability scope cannot satisfy the assignment");
    };
    f.def.tasks[0]!.metadata = { ...f.def.tasks[0]!.metadata, requiredCapabilities: ["typescript", "git"] };
    await expect(f.runtime.proposeWorkflow("run-1", f.spec, f.def)).rejects.toThrow(/capability scope/);
    expect(seen).toContainEqual(expect.arrayContaining(["typescript", "git"]));
    expect((await f.inspect()).definition).toBeUndefined();
  });
  it("refuses a base pane as fallback for a selected specialist profile", async () => {
    const f = await fixture(), profile = snapshot();
    profile.definition = { ...definition, profileId: "database-reviewer", baseRole: "reviewer" }; profile.pin = pinRoleProfile(profile.definition);
    f.ports.roleProfiles = [profile];
    await expect(f.runtime.requestSpecialist("run-1", "reviewer", "Review", ["review"], profile.pin)).rejects.toThrow(/profile|allocate|unsupported/i);
  });
  it("narrows actual task ownership and native file authorization", async () => {
    const f = await fixture(), profile = snapshot();
    profile.definition.restrictions = { writablePaths: ["guide.md"] }; profile.pin = pinRoleProfile(profile.definition);
    configure(f, profile); f.spec.affectedPaths = ["guide.md", "other.md"];
    f.def.tasks[0]!.metadata = { ...f.def.tasks[0]!.metadata, ownedPaths: ["guide.md", "other.md"] };
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    expect((await f.inspect()).definition.tasks[0].metadata.ownedPaths).toEqual(["guide.md"]);
    const binding = f.panes.bindings.find(value => value.role === "developer")!;
    const development = new HostDevelopment(() => f.runtime, []);
    await expect(development.authorizeFileEdit(binding, { tool_name: "Write", tool_input: { file_path: join(binding.worktreePath!, "other.md") } })).rejects.toThrow(/ownership/);
    await expect(development.check(binding, { runId: "run-1", taskId: "implement" })).rejects.toThrow(/profile.*unsupported/i);
  });
  it("recovers the pinned snapshot and assignment without resending an accepted execution", async () => {
    const f = await fixture(), profile = configure(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const before = f.transport.sentRequests.filter(value => value.role === "developer").length;
    const restarted = f.restart(); await restarted.tick();
    expect((await restarted.inspect("run-1") as any).roleProfiles[0]).toEqual(profile);
    expect(f.transport.sentRequests.filter(value => value.role === "developer")).toHaveLength(before);
  });
  it("blocks live workspace effects when profile source content changes under the selected identity", async () => {
    const f = await fixture(), profile = configure(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const binding = f.panes.bindings.find(value => value.role === "developer")!;
    const changed = { ...profile, definition: { ...profile.definition, additionalInstructions: "Changed after launch" } };
    changed.pin = pinRoleProfile(changed.definition); f.ports.roleProfiles = [changed];
    let called = false;
    await expect(f.runtime.withDeveloperWorkspace(binding, "run-1", "implement", async () => { called = true; })).rejects.toThrow(/profile|drift/i);
    expect(called).toBe(false);
    expect(binding.roleProfile).toEqual(profile.pin);
  });
  it.each(["workspace", "tool"] as const)("rechecks profile drift after awaited skill validation before a %s effect", async kind => {
    const f = await fixture(), profile = configure(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const binding = f.panes.bindings.find(value => value.role === "developer")!;
    f.ports.revalidateRoleSkills = async () => {
      const definition = { ...profile.definition, additionalInstructions: "Changed during validation" };
      f.ports.roleProfiles = [{ ...profile, definition, pin: pinRoleProfile(definition) }];
    };
    let called = false;
    const effect = async () => { called = true; };
    await expect(kind === "workspace" ? f.runtime.withDeveloperWorkspace(binding, "run-1", "implement", effect) :
      f.runtime.withAssignedToolAction(binding, effect)).rejects.toThrow(/profile|drift/i);
    expect(called).toBe(false);
  });
  it.each(["preflight", "worktree"] as const)("blocks the next allocation effect when the profile changes during %s preparation", async boundary => {
    const f = await fixture(), profile = configure(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const drift = () => { const definition = { ...profile.definition, additionalInstructions: "Changed while preparing" };
      f.ports.roleProfiles = [{ ...profile, definition, pin: pinRoleProfile(definition) }]; };
    if (boundary === "preflight") f.ports.preflightRoleProfile = async () => { drift(); };
    else {
      const prepare = f.ports.policies.git.prepareTask.bind(f.ports.policies.git);
      f.ports.policies.git.prepareTask = async request => { const result = await prepare(request); drift(); return result; };
    }
    const allocate = f.ports.panes.allocateDeveloper.bind(f.ports.panes); let allocated = false;
    f.ports.panes.allocateDeveloper = async request => { allocated = true; return allocate(request); };
    await f.runtime.tick();
    expect(allocated).toBe(false);
    if (boundary === "preflight") expect((await f.inspect()).tasks[0].worktrees).toHaveLength(0);
    expect(f.transport.sentRequests.filter(request => request.role === "developer")).toHaveLength(0);
  });
  it("rejects a missing durable snapshot at journal recovery instead of resolving a new profile", async () => {
    const f = await fixture(); configure(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const path = join(f.runtimeOptions.journalDirectory, "state.json");
    const state = JSON.parse(await readFile(path, "utf8")); delete state.runs[0].roleProfiles;
    await writeFile(path, JSON.stringify(state));
    await expect(f.restart().inspect("run-1")).rejects.toThrow(/profile|snapshot/i);
  });
  it("pins automatic reviewer selection at acceptance and refuses a removed default before dispatch", async () => {
    const f = await fixture(), profile = snapshot();
    profile.definition = { ...definition, profileId: "database-reviewer", baseRole: "reviewer" };
    profile.pin = pinRoleProfile(profile.definition);
    f.ports.roleProfiles = [profile]; f.ports.preflightRoleProfile = async () => {};
    f.ports.roleProfileDefaults = { reviewer: profile.pin };
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    f.ports.roleProfileDefaults = {};
    const result = f.runtime.herdrQualityGate("review").evaluate({ runId: "run-1", taskId: "implement", attemptId: "review-attempt",
      definition: f.ports.taskChecks![0]!, input: {}, artifacts: [] });
    await expect(result).rejects.toThrow(/profile.*(default|selection).*drift/i);
    expect(f.transport.sentRequests.filter(request => request.role === "reviewer")).toHaveLength(0);
    expect((await f.inspect()).roleProfileDefaults).toEqual({ reviewer: profile.pin });
  });
  it("marks profiled journals so an old binary cannot ignore specialist authority fields", async () => {
    const f = await fixture(); configure(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const path = join(f.runtimeOptions.journalDirectory, "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    expect(state.version).toBe(7);
    state.version = 6; await writeFile(path, JSON.stringify(state));
    await expect(f.restart().inspect("run-1")).rejects.toThrow(/profile.*journal.*v7/i);
  });
  it.each(["pin", "lineage"] as const)("rejects a removed durable %s on an accepted profiled execution", async field => {
    const f = await fixture(); configure(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const path = join(f.runtimeOptions.journalDirectory, "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    const out = state.outbound.find((value: any) => value.message.type === "task.assignment");
    delete out[field === "pin" ? "roleProfile" : "executorLineage"];
    await writeFile(path, JSON.stringify(state));
    await expect(f.restart().inspect("run-1")).rejects.toThrow(/profile|lineage/i);
  });
  it.each(["alternative", "red"] as const)("uses a dedicated pinned QA profile for automatic %s evidence", async phase => {
    const f = await fixture({ tdd: phase === "red" }), profile = snapshot();
    profile.definition = { ...definition, profileId: "database-qa", baseRole: "qa" }; profile.pin = pinRoleProfile(profile.definition);
    f.ports.roleProfiles = [profile]; f.ports.roleProfileDefaults = { qa: profile.pin }; f.ports.preflightRoleProfile = async () => {};
    f.ports.roleCapabilities.qa = ["verification", "repository.read", "testing"];
    const manifest = f.panes.getManifest.bind(f.panes);
    f.ports.panes.getManifest = async () => { const result = await manifest(); return { ...result, value: { ...result.value, roleProfiles: [profile] } }; };
    f.ports.attestExecutorLineage = async (binding, purpose, assignmentId) => ({ schemaVersion: 3, executorId: binding.agentId,
      launchId: `launch-${binding.agentId}`, nativeSessionId: binding.session!.value, bindingId: binding.bindingId,
      freshContext: true, purpose, assignmentIds: [assignmentId] });
    f.ports.panes.allocateSpecialist = async request => {
      const binding = { ...f.panes.bindings.find(value => value.role === "qa")!, bindingId: request.taskId, paneId: `pane-${request.taskId}`,
        agentId: `agent-${request.taskId}`, roleProfile: request.roleProfile.pin };
      f.panes.bindings.push(binding); return { ok: true, value: binding };
    };
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    if (phase === "red") {
      const binding = f.panes.bindings.find(value => value.role === "developer")!;
      await f.runtime.requestPhaseVerification(binding, "run-1", "implement", "red", git(binding.worktreePath!, "rev-parse", "HEAD"));
    } else {
      f.ports.automaticAlternativeEvidence = true; await f.submit();
    }
    await f.runtime.flushOutbound();
    const requests = (await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.recipient.role === "qa");
    expect(requests).toHaveLength(1);
    expect(requests[0].error).toBeUndefined();
    expect(requests[0]).toMatchObject({ status: "accepted", roleProfile: profile.pin });
    expect(requests[0].handle.target.paneId).not.toBe("pane-qa");
  });
  it.each(["result", "queued cancellation", "stopped cancellation", "idle cancellation", "unconfirmed cancellation"] as const)("retains specialist context until correlated settlement: %s", async settlement => {
    const f = await fixture(), profile = snapshot();
    profile.definition = { ...definition, profileId: "database-reviewer", baseRole: "reviewer" }; profile.pin = pinRoleProfile(profile.definition);
    f.ports.roleProfiles = [profile]; f.ports.preflightRoleProfile = async () => {};
    const manifest = f.panes.getManifest.bind(f.panes);
    f.ports.panes.getManifest = async () => { const result = await manifest(); return { ...result, value: { ...result.value, roleProfiles: [profile] } }; };
    f.ports.attestExecutorLineage = async (binding, purpose, assignmentId) => ({ schemaVersion: 3, executorId: binding.agentId,
      launchId: `launch-${binding.agentId}`, nativeSessionId: binding.session!.value, bindingId: binding.bindingId,
      freshContext: true, purpose, assignmentIds: [assignmentId] });
    f.ports.panes.allocateSpecialist = async request => {
      const binding = { ...f.panes.bindings.find(value => value.role === "reviewer")!, bindingId: request.taskId, paneId: `pane-${request.taskId}`,
        agentId: `agent-${request.taskId}`, roleProfile: request.roleProfile.pin };
      f.panes.bindings.push(binding); return { ok: true, value: binding };
    };
    let releases = 0;
    f.ports.panes.releaseSpecialist = async () => { releases++; return { ok: true, value: undefined }; };
    await f.runtime.requestSpecialist("run-1", "reviewer", "Review the database", ["review"], profile.pin);
    if (settlement === "queued cancellation") {
      f.panes.busy.add("reviewer"); // Allocation/startup may still be in progress; no task was sent.
      await f.runtime.cancel("run-1", "Cancel before delivery"); await f.runtime.tick();
      expect(releases).toBe(1); return;
    }
    await f.runtime.flushOutbound();
    if (settlement === "stopped cancellation" || settlement === "idle cancellation" || settlement === "unconfirmed cancellation") {
      if (settlement === "idle cancellation") await f.runtime.flushOutbound();
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(),
        correlationVerified: settlement !== "unconfirmed cancellation" } });
      await f.runtime.cancel("run-1", "Cancel the specialist");
      await f.runtime.reconcileCancellation("run-1"); await f.runtime.tick();
      expect(releases).toBe(settlement !== "unconfirmed cancellation" ? 1 : 0); return;
    }
    await f.runtime.flushOutbound();
    const out = (await f.runtime.inspect() as any).outbound.find((value: any) => value.message.recipient.role === "reviewer");
    expect(out.status).toBe("released");
    expect(releases).toBe(0);
    await f.runtime.receiveHerdr(f.envelope("task.status", { status: "completed", summary: "Reviewed the database" }, {
      sender: { role: "reviewer", agent_id: out.handle.target.agentId, pane_id: out.handle.target.paneId }, causation_id: out.message.message_id }));
    expect(releases).toBe(0); // Native acknowledgement and tool finalization still need the principal.
    await f.runtime.tick();
    expect(releases).toBe(1);
    await f.runtime.tick(); expect(releases).toBe(1);
  });
  it.each([true, false])("after cancellation releases a released specialist allocation only once its pane is gone: %s", async gone => {
    const f = await fixture(), profile = snapshot();
    profile.definition = { ...definition, profileId: "database-reviewer", baseRole: "reviewer" }; profile.pin = pinRoleProfile(profile.definition);
    f.ports.roleProfiles = [profile]; f.ports.preflightRoleProfile = async () => {};
    const manifest = f.panes.getManifest.bind(f.panes);
    f.ports.panes.getManifest = async () => { const result = await manifest(); return { ...result, value: { ...result.value, roleProfiles: [profile] } }; };
    f.ports.attestExecutorLineage = async (binding, purpose, assignmentId) => ({ schemaVersion: 3, executorId: binding.agentId,
      launchId: `launch-${binding.agentId}`, nativeSessionId: binding.session!.value, bindingId: binding.bindingId,
      freshContext: true, purpose, assignmentIds: [assignmentId] });
    f.ports.panes.allocateSpecialist = async request => {
      const binding = { ...f.panes.bindings.find(value => value.role === "reviewer")!, bindingId: request.taskId, paneId: `pane-${request.taskId}`,
        agentId: `agent-${request.taskId}`, roleProfile: request.roleProfile.pin };
      f.panes.bindings.push(binding); return { ok: true, value: binding };
    };
    let releases = 0;
    f.ports.panes.releaseSpecialist = async () => { releases++; return { ok: true, value: undefined }; };
    await f.runtime.requestSpecialist("run-1", "reviewer", "Review the database", ["review"], profile.pin);
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    const out = (await f.runtime.inspect() as any).outbound.find((value: any) => value.message.recipient.role === "reviewer");
    expect(out.status).toBe("released"); // The lease is relinquished but no result arrived (e.g. its gate timed out).
    // A host restart left the profiled pane from the previous generation; the operator closed it, so its process is gone.
    if (gone) f.panes.missing.add(out.handle.target.paneId);
    await f.runtime.cancel("run-1", "Cancel after a stranded review");
    await f.runtime.reconcileCancellation("run-1"); await f.runtime.tick();
    expect(releases).toBe(gone ? 1 : 0);
  });
  it("keeps the accepted profile on automatic integration conflict resolver allocations", async () => {
    const f = await fixture({ parallel: true, conflict: true }), profile = configure(f);
    for (const task of f.def.tasks) task.roleProfile = profile.pin;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.evidence("other");
    await f.submit("implement", "left\n"); await f.submit("other", "right\n");
    await f.runtime.tick(); await f.runtime.tick();
    const requests = f.transport.sentRequests.filter(value => value.role === "developer");
    expect(requests.length).toBeGreaterThan(2);
    const resolver = requests.find(request => (request.context as any).payload?.context?.kind === "conflict_resolution");
    expect(resolver).toBeDefined();
    expect((resolver!.context as any).payload.assignment.roleProfile).toEqual(profile.pin);
  });
});
describe("RP-01 executor history", () => {
  it("detects self-review after profile aliasing by authenticated native session history", () => {
    const implementation = { agentId: "old-developer", session: { source: "herdr:codex", kind: "id", value: "native-same" } };
    const reviewer = { agentId: "renamed-reviewer", session: { source: "herdr:codex", kind: "id", value: "native-same" } };
    expect(() => admission.assertIndependentProfileExecutor(reviewer as any, [implementation as any])).toThrow(/independen|implement/i);
    expect(() => admission.assertIndependentProfileExecutor({ ...reviewer, session: { ...reviewer.session, value: "native-fresh" } } as any, [implementation as any])).not.toThrow();
  });
});
