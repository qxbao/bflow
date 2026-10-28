import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { ApprovalRequestSchema, WebCommandSchema, type WebCommand, type WebPrincipal } from "@bflow/contracts";
import { WebPrincipalSchema } from "@bflow/contracts/web-host";
import { FileConversationContextStore } from "@bflow/conversation";
import { fixture as runtimeFixture, unwrap } from "../helpers/agentic-integration-fixture.js";
import { fixture as signerFixture, now } from "./web-command-fixtures.js";
import { createAgenticConversationHost, type StructuredConversationCallbacks } from "../../src/agentic/conversation.js";
import { AgenticJournal, digest } from "../../src/agentic/journal.js";
import { projectRun } from "../../src/interaction/views.js";
import { HostStructuredCommands, observeStructuredAdmission, observeStructuredDecision, structuredDecisionEffects } from "../../src/interaction/commands.js";
import { WebInteractionAuthority } from "../../src/interaction/authority.js";
import { WebOperationStore } from "../../src/interaction/operation-store.js";
export async function structuredHostFixture() {
  const f = await runtimeFixture({ intake: false, humanApproval: true }), signer = signerFixture();
  const authority = new WebInteractionAuthority("project-1", "session-1", () => now);
  authority.registerOwnerKey({ ...signer.registration, hostSessionId: "session-1" });
  const options = { directory: join(f.root, "web-receipts"), repository: f.repository, sessionId: "session-1", projectId: "project-1" };
  const store = new WebOperationStore(options), journal = new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository);
  f.ports.authorizeHuman = async decision => await f.receipts.authenticateHuman(decision) || await store.authenticateHuman(decision, "session-1");
  const native = f.panes.bindings.find(pane => pane.role === "conversation")!;
  const contextStore = new FileConversationContextStore(join(f.root, "conversation"));
  const openChat = async () => createAgenticConversationHost({ runtime: f.runtime, manifest: unwrap(await f.panes.getManifest()), contextDirectory: join(f.root, "conversation"),
    onHumanDecision: async decision => f.receipts.recordHuman(decision, { origin: "UserPromptSubmit", binding: native,
      nativeSessionId: native.session!.value, conversationSessionId: "session-1", userId: decision.decidedBy,
      messageId: "native-fixture-message", promptDigest: digest("reject native") }) });
  let chat = await openChat();
  const context = new AsyncLocalStorage<{ command: WebCommand; principal: WebPrincipal; acceptedAt: string }>();
  const callbacks: StructuredConversationCallbacks = { now: () => context.getStore()?.acceptedAt ?? new Date().toISOString(),
    authorize: async (command, principal) => context.getStore()?.command.commandId === command.commandId && context.getStore()?.principal.principalId === principal.principalId,
    approval: async (decision, command, principal) => store.recordHumanDecision(principal.principalId, command.commandId, decision, "session-1"),
    resume: async command => { await f.runtime.resumeBlockedRun(command.runId, command.actionId, { webCommand: command });
      return { ok: true, value: { kind: "interaction", runId: command.runId, currentRunId: command.runId } }; }
  };
  chat.configureStructuredInteraction(callbacks);
  const runView = (runId: string) => journal.exclusive(async state => {
    const core = new Map();
    const r = state.runs.find(run => run.runId === runId);
    if (r?.coreCreated) { const snapshot = await f.ports.engine.getSnapshot(runId); if (snapshot.ok && snapshot.value) core.set(runId, snapshot.value); }
    const context = unwrap(await contextStore.load("session-1"));
    return projectRun({ state, sessionId: "session-1", observedAt: new Date().toISOString(), core, ready: true, commandsSupported: true,
      pendingClarifications: context?.pendingClarifications }, runId);
  });
  const port = { authority, store, conversationSessionId: () => "session-1", ready: () => true, run: runView,
    session: async () => { throw new Error("No pre-run fixture pending intake"); },
    admit: (command: WebCommand, principal: WebPrincipal, acceptedAt: string) =>
      context.run({ command, principal, acceptedAt }, () => chat.handleStructuredInteraction(command, principal)),
    reconcile: async (command: WebCommand) => {
      if (command.kind === "answer_decision") {
        const snapshot = await f.runtime.inspect() as any;
        return observeStructuredDecision(command, await chat.readStructuredInteraction(command.commandId), snapshot.inbox, runView,
          structuredDecisionEffects(snapshot.runs.find((run: any) => run.runId === command.runId)));
      }
      const cached = await chat.readStructuredInteraction(command.commandId);
      if (cached) return cached;
      const snapshot = await f.runtime.inspect() as any;
      return observeStructuredAdmission(command, snapshot.outbound, runView);
    }
  };
  const commands = new HostStructuredCommands(port);
  const proof = (command: WebCommand) => WebPrincipalSchema.parse(signer.proof(command, { hostSessionId: "session-1" }));
  const create = async () => {
    const command = WebCommandSchema.parse({ ...signer.command, commandId: randomUUID() });
    const result = unwrap(await commands.execute(command, proof(command)));
    if (result.result?.kind !== "interaction") throw new Error("Expected actual admitted run");
    return result.result.runId;
  };
  const approval = async (runId: string) => {
    await journal.exclusive(async (state, save) => {
      const run = state.runs.find(run => run.runId === runId)!;
      run.status = "awaiting_approval"; run.approvalKind = "design";
      run.approval = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: `approval-${runId}`, runId, sessionId: "session-1", status: "pending",
        target: { type: "run" }, revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: new Date().toISOString(),
        reason: "Review exact design", evidence: [], idempotencyKey: `approval-${runId}` });
      await save();
    });
    await chat.reconcileApprovals();
    return (await runView(runId)).decisions[0]!;
  };
  return { ...f, signer, commands, store, options, port, get chat() { return chat; }, callbacks, journal, proof, create, approval, runView, contextStore,
    async reopenConversation() { chat = await openChat(); chat.configureStructuredInteraction(callbacks); } };
}
