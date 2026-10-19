import { type AgentRole, type OperationOptions, type OperationResult, type SessionManifest } from "@bflow/contracts";

/** CLI-local queue for preparatory host health. Publication never waits for provider probes. */
export class RoleStartupChecks {
  private readonly queued = new Map<AgentRole, { manifest: SessionManifest; key: string; options?: OperationOptions }>();
  private readonly running = new Map<AgentRole, Promise<void>>();
  private readonly seen = new Map<AgentRole, string>();
  private readonly failures = new Map<AgentRole, OperationResult<void>>();
  private accepting = true;

  constructor(private readonly roles: readonly AgentRole[], private readonly verify:
    (manifest: SessionManifest, role: AgentRole, options?: OperationOptions) => Promise<OperationResult<void>>) {}

  published(manifest: SessionManifest, options?: OperationOptions): void {
    if (!this.accepting || this.failures.size || options?.signal?.aborted) return;
    for (const role of this.roles) {
      const pane = manifest.panes.find(binding => binding.role === role && binding.permanent);
      if (!pane?.session || !["idle", "done", "working", "accepted"].includes(pane.transportState)) continue;
      const key = JSON.stringify([pane.paneId, pane.agentId, pane.session, pane.metadata?.["launchId"], pane.metadata?.["launchFingerprint"]]);
      if (this.seen.get(role) === key) { this.queued.delete(role); continue; }
      this.queued.set(role, { manifest, key, ...(options ? { options } : {}) });
    }
    this.pump();
  }

  private pump(): void {
    if (this.failures.size) { this.queued.clear(); return; }
    for (const role of this.roles) {
      if (this.running.size >= 3) break;
      if (this.running.has(role)) continue;
      const job = this.queued.get(role);
      if (!job) continue;
      this.queued.delete(role);
      this.seen.set(role, job.key);
      const work = Promise.resolve().then(async () => {
        if (job.options?.signal?.aborted) {
          this.failures.set(role, { ok: false, error: { code: "cancelled", retryable: false, message: "Role startup checks were cancelled; state was preserved." } });
          return;
        }
        const result = await this.verify(job.manifest, role, job.options);
        if (job.options?.signal?.aborted) {
          this.failures.set(role, { ok: false, error: { code: "cancelled", retryable: false, message: "Role startup checks were cancelled; state was preserved." } });
          return;
        }
        if (!result.ok) {
          const details = result.error.details;
          if (details === null || typeof details !== "object" || Array.isArray(details) || details["stage"] !== "native_startup")
            this.failures.set(role, result);
        }
      }).catch(error => {
        this.failures.set(role, { ok: false, error: { code: "transport_unavailable", retryable: true, message: String(error) } });
      }).finally(() => { this.running.delete(role); this.pump(); });
      this.running.set(role, work);
    }
  }

  /** Consume every started check before lifecycle transitions; report failures in configured order. */
  async drain(stop = false): Promise<OperationResult<void>> {
    if (stop) { this.accepting = false; this.queued.clear(); }
    while (this.running.size) await Promise.all(this.running.values());
    for (const role of this.roles) {
      const failed = this.failures.get(role);
      if (failed) return failed;
    }
    return { ok: true, value: undefined };
  }
}
