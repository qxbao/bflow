import { z } from "zod";
import { IdentifierSchema } from "@bflow/contracts";
import type { WorkflowExtensionHost } from "./extension-host.js";

const WorkView = z.object({ runId: IdentifierSchema, coreCreated: z.boolean(), extensionStatus: z.string(),
  cancelled: z.boolean().default(false), queuedDecisions: z.array(IdentifierSchema).default([]) }).passthrough();

/** Each SDK drives its existing Core DAG. This pump only owns the lifetime of the host's asynchronous calls. */
export class WorkflowExtensionPump {
  private readonly active = new Map<string, Promise<void>>();
  private readonly held = new Set<string>();
  private readonly requested = new Set<string>();
  private quiesced = false;
  private quiescing = false;
  constructor(private readonly host: Pick<WorkflowExtensionHost, "inspect" | "drive">,
    private readonly reportFailure: (runId: string, error: unknown) => Promise<void>) {}

  snapshot() { return { activeRunIds: [...this.active.keys()], heldRunIds: [...this.held], quiesced: this.quiesced }; }
  wake(runId: string): void {
    if (this.quiesced || this.quiescing) throw new Error("Extension pump is quiesced");
    this.held.delete(IdentifierSchema.parse(runId)); this.requested.add(runId);
  }
  async wakeStarted(runId: string): Promise<boolean> {
    const run = WorkView.parse(await this.host.inspect(IdentifierSchema.parse(runId)));
    if (!run.coreCreated) return false;
    this.wake(runId); return true;
  }
  async tick(): Promise<void> {
    if (this.quiesced || this.quiescing) return;
    const state = z.object({ runs: z.array(WorkView) }).passthrough().parse(await this.host.inspect());
    if (this.quiesced || this.quiescing) return;
    for (const run of state.runs) {
      if (!run.coreCreated || run.cancelled || this.active.has(run.runId) || this.held.has(run.runId) ||
          run.extensionStatus !== "running" && !run.queuedDecisions.length && !this.requested.has(run.runId)) continue;
      this.requested.delete(run.runId);
      const job = Promise.resolve().then(async () => {
        if (this.quiesced) return;
        try { await this.host.drive(run.runId); }
        catch (error) {
          // Unknown delivery must never become a scheduler resend loop. The receipt remains in the existing WAL.
          this.held.add(run.runId);
          await this.reportFailure(run.runId, error);
        }
      }).finally(() => { this.active.delete(run.runId); });
      this.active.set(run.runId, job);
      // Drain/snapshot retain the job; attach an observer now so a failed notice cannot cause an unhandled rejection.
      void job.catch(() => undefined);
    }
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.active.values()]); }
  async quiesce(beforeCommit?: () => Promise<unknown>): Promise<void> {
    if (this.active.size) throw new Error("Native extension work is active; let it drain before quiescing");
    this.quiescing = true;
    try { await beforeCommit?.(); this.quiesced = true; }
    finally { this.quiescing = false; }
  }
}
