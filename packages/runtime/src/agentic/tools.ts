import { AgentRoleProfileSchema, JsonValueSchema, SpecificationSchema, type AgentRole, type JsonValue } from "@bflow/contracts";
import { z } from "zod";
import { record, strings, textField } from "./journal.js";
import type { AgenticWorkflowRuntime } from "./runtime.js";

// Keep tool-argument paths distinct from the nested public contract fields. The Runtime
// also validates direct callers; provider discovery is guidance, never ingress proof.
const AssessArgumentsSchema = z.object({ specification: SpecificationSchema }).strict();

export const COORDINATOR_ROLE_PROFILE = AgentRoleProfileSchema.parse({
  role: "coordinator", title: "Bflow Technical Coordinator", description: "Adaptive planning through the authoritative Workflow Runtime",
  defaultCapabilities: ["coordination", "specification", "planning"],
  allowedRecipients: ["conversation", "runtime", "specifier", "architect", "planner", "developer", "tester", "reviewer", "qa", "security"],
  canDelegateToSpecialist: true, userFacing: false, readOnlyWorkspace: true,
  requiresDedicatedPane: true, requiresIndependentVerification: true
});
export const COORDINATOR_TOOLS = [
  { name: "inspect", description: "Read durable SDLC state, inbox, assignments, evidence and uncertain handoffs." },
  { name: "report_progress", description: "Send progress or clarification questions to Conversation through Herdr." },
  { name: "assess", description: "Evaluate the actual P15 complexity policy and available role capabilities." },
  { name: "request_specialist", description: "Queue a capability-constrained specialist delegation through Herdr." },
  { name: "propose_workflow", description: "Submit draft Specification and implementation DAG; Runtime enforces SDD, approvals and TDD policy." },
  { name: "tick", description: "Schedule a background Runtime step and return immediately; yield the Coordinator turn so Herdr replies can arrive." },
  { name: "tick_status", description: "Read host scheduler status without waiting for another agent's turn." },
  { name: "reconcile_delivery", description: "Reconcile an uncertain Herdr handoff; resend is allowed only after proven non-delivery." },
  { name: "retry_verification", description: "Resume verification of an escalated run whose verification could not be delivered or stored; finishes durable outcomes and re-runs only unfinished checks." },
  { name: "authorize_implementation", description: "Check accepted specification and the required independent Red evidence before implementation." },
  { name: "accept_conflict_resolution", description: "Validate a committed scoped conflict resolution using P18; never auto-resolve conflicts." },
  { name: "cancel", description: "Persist cancellation intent, stop new dispatch and request interrupts without inventing stop confirmations." }
] as const;

/** Host injects the authenticated role; an agent may not choose its own principal in tool arguments. */
export class CoordinatorTools {
  constructor(private readonly runtime: AgenticWorkflowRuntime) {}
  private pendingTick: Promise<JsonValue> | undefined;
  private tickError: string | undefined;
  private scheduleTick(): JsonValue {
    const alreadyRunning = this.pendingTick !== undefined;
    if (!this.pendingTick) {
      this.tickError = undefined;
      const task = this.runtime.tick();
      this.pendingTick = task;
      void task.then(() => { if (this.pendingTick === task) this.pendingTick = undefined; }, error => {
        this.tickError = String(error); if (this.pendingTick === task) this.pendingTick = undefined;
      });
    }
    return JsonValueSchema.parse({ scheduled: true, alreadyRunning });
  }
  /** Host lifecycle only. Never wait for this from the Coordinator's own message handler. */
  async drain(): Promise<void> { await this.pendingTick; }
  async invoke(name: string, input: unknown, principal: { role: AgentRole }): Promise<JsonValue> {
    const args = record(JsonValueSchema.parse(input));
    if (principal.role !== "coordinator" && !(principal.role === "developer" && name === "authorize_implementation"))
      throw new Error("Only Coordinator may invoke orchestration tools");
    switch (name) {
      case "inspect": return this.runtime.inspect(args.runId === undefined ? undefined : textField(args.runId));
      case "report_progress": return this.runtime.reportProgress(textField(args.runId), textField(args.headline), args.questions === undefined ? [] : strings(args.questions));
      case "assess": return this.runtime.assess(AssessArgumentsSchema.parse(args).specification);
      case "request_specialist": return this.runtime.requestSpecialist(textField(args.runId), textField(args.role), textField(args.objective), strings(args.requiredCapabilities));
      case "propose_workflow": return this.runtime.proposeWorkflow(textField(args.runId), args.specification, args.definition,
        args.maxIterations === undefined ? 3 : Number(args.maxIterations));
      case "tick": return this.scheduleTick();
      case "tick_status": return JsonValueSchema.parse({ running: !!this.pendingTick, error: this.tickError ?? null });
      case "reconcile_delivery": return this.runtime.reconcileDelivery(textField(args.messageId));
      case "retry_verification": return this.runtime.retryVerification(textField(args.runId));
      case "authorize_implementation": return this.runtime.authorizeImplementation(textField(args.runId), textField(args.taskId));
      case "accept_conflict_resolution": return this.runtime.acceptConflictResolution(textField(args.runId), textField(args.taskKey), textField(args.resolutionCommitHash));
      case "cancel": return this.runtime.cancel(textField(args.runId), textField(args.reason));
      default: throw new Error(`Unknown Coordinator tool: ${name}`);
    }
  }
}
