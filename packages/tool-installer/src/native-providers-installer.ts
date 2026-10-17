import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SetupApplyRequestSchema, SetupReceiptSchema, SetupStepSchema, ToolInstallRequestSchema,
  type OperationOptions, type OperationResult, type SetupApplyRequest, type SetupReceipt, type SetupStep,
  type ToolInstallRequest, type ToolInstaller } from "@bflow/contracts";
import { ManagedToolInstaller, ManagedToolPinSchema, type ManagedToolPin, type ToolInspection, type ProviderPluginAdapter, type ToolHost } from "./installer.js";
import { OfficialProviderPluginAdapter } from "./provider-plugins.js";
import type { NativeProvider, NativeRuntimeOptions } from "./native-runtime.js";
import { resolveMemoryProvider } from "./memory-provider.js";
import { systemToolHost } from "./installer.js";

/** One machine-approved tool step composes provider-specific native activations.
 * Each child's ManagedToolInstaller retains uncertain native delivery; an aggregate retry
 * reconciles those child intents before it can invoke another provider command. */
export class NativeProvidersToolInstaller implements ToolInstaller {
  readonly installerId: string;
  readonly #root: string;
  readonly #pin: ManagedToolPin;
  readonly #host: ToolHost;
  readonly #configuration: Omit<NativeRuntimeOptions, "managedRoot"> | undefined;
  readonly #providerPlugin: ProviderPluginAdapter | undefined;
  readonly #children: { provider: NativeProvider; pin: ManagedToolPin; installer: ManagedToolInstaller }[];
  constructor(options: { managedRoot: string; pin: ManagedToolPin; providers: readonly NativeProvider[];
    host?: ToolHost; configuration?: Omit<NativeRuntimeOptions, "managedRoot">; providerPlugin?: ProviderPluginAdapter }) {
    const pin = ManagedToolPinSchema.parse(options.pin);
    if (pin.recipe.kind !== "provider_plugin" || !["superpowers", "claude-mem"].includes(pin.toolId)) throw Error("Native plugin pin required");
    this.#root = resolve(options.managedRoot); this.#pin = pin; this.installerId = pin.installerId;
    if (!options.providers.length || new Set(options.providers).size !== options.providers.length) throw Error("Unique selected providers required");
    const host = options.host ?? systemToolHost;
    this.#host = host; this.#configuration = options.configuration; this.#providerPlugin = options.providerPlugin;
    this.#children = options.providers.map(provider => {
      const childPin = ManagedToolPinSchema.parse({ ...pin, installerId: `${pin.installerId}-${provider}`, recipe: { kind: "provider_plugin", provider } });
      return { provider, pin: childPin, installer: new ManagedToolInstaller({ managedRoot: this.#root, pins: [childPin], host,
        providerPlugin: options.providerPlugin ?? new OfficialProviderPluginAdapter({ host,
          configuration: { ...options.configuration, managedRoot: join(this.#root, ".native") } }) }) };
    });
  }
  #fail<T>(message: string): OperationResult<T> { return { ok: false, error: { code: "validation", retryable: false, message } }; }
  async #childSteps(request: ToolInstallRequest): Promise<OperationResult<{ provider: NativeProvider; installer: ManagedToolInstaller; step: SetupStep }[]>> {
    const plans: { provider: NativeProvider; installer: ManagedToolInstaller; step: SetupStep }[] = [];
    let selected: Awaited<ReturnType<typeof resolveMemoryProvider>> | undefined;
    const home = this.#configuration?.homeDirectory ?? homedir();
    const memory = this.#configuration?.memory ?? { dataDir: join(home, ".claude-mem"), projectRoot: process.cwd(), project: process.cwd() };
    if (this.#pin.toolId === "claude-mem") {
      try { selected = await resolveMemoryProvider({ provider: memory.provider ?? "auto", homeDirectory: home, dataDir: memory.dataDir,
        host: this.#host, ...(this.#configuration?.executables ? { executables: this.#configuration.executables } : {}),
        ...(process.env.CODEX_HOME ? { environment: { CODEX_HOME: process.env.CODEX_HOME } } : {}) }); }
      catch (error) { return this.#fail(error instanceof Error ? error.message : "Claude-Mem subscription login could not be verified"); }
    }
    for (const child of this.#children) {
      const installer = selected ? new ManagedToolInstaller({ managedRoot: this.#root, pins: [child.pin], host: this.#host,
        desiredStateContext: { memoryProvider: selected.provider, memoryDataDir: memory.dataDir },
        providerPlugin: this.#providerPlugin ?? new OfficialProviderPluginAdapter({ host: this.#host,
          configuration: { ...this.#configuration, managedRoot: join(this.#root, ".native"), memory: { ...memory, provider: selected.provider } } }) }) : child.installer;
      const planned = await installer.plan({ ...request, installerId: child.pin.installerId,
        destination: join(request.destination, child.provider), idempotencyKey: `${request.idempotencyKey}:${child.provider}` });
      if (!planned.ok) return planned;
      plans.push({ provider: child.provider, installer, step: planned.value });
    }
    return { ok: true, value: plans };
  }
  async plan(raw: ToolInstallRequest): Promise<OperationResult<SetupStep>> {
    const parsed = ToolInstallRequestSchema.safeParse(raw);
    if (!parsed.success) return this.#fail(parsed.error.message);
    const request = parsed.data, pin = this.#pin;
    if (request.toolId !== pin.toolId || request.installerId !== pin.installerId || request.version !== pin.version ||
      request.source !== pin.source || request.integrity !== pin.integrity || request.scope.kind !== "machine" ||
      resolve(request.destination) !== join(this.#root, pin.toolId)) return this.#fail("Native request differs from approved machine pin or destination");
    const children = await this.#childSteps(request);
    if (!children.ok) return children;
    const desiredStateDigest = createHash("sha256").update(JSON.stringify(children.value.map(child => child.step))).digest("hex");
    return { ok: true, value: SetupStepSchema.parse({ schemaVersion: 3, stepId: `install-${pin.toolId}`, action: "install_tool",
      componentId: pin.toolId, level: "machine", scope: request.scope, dependsOn: [], desiredStateDigest,
      expectedStateDigest: null, requiresApproval: true, rollback: "manual", toolInstall: request,
      idempotencyKey: request.idempotencyKey }) };
  }
  async inspect(raw: ToolInstallRequest, options?: OperationOptions): Promise<OperationResult<ToolInspection>> {
    const planned = await this.plan(raw);
    if (!planned.ok) return planned;
    const children = await this.#childSteps(planned.value.toolInstall!);
    if (!children.ok) return children;
    const diagnostics: string[] = [], ownedPaths: string[] = [];
    for (const child of children.value) {
      const result = await child.installer.inspect(child.step.toolInstall!, options);
      if (!result.ok) return result;
      diagnostics.push(...result.value.diagnostics.map(message => `${child.provider}: ${message}`));
      ownedPaths.push(...result.value.ownedPaths);
      if (result.value.status !== "already_satisfied") return { ok: true, value: { status: result.value.status, diagnostics, ownedPaths } };
    }
    return { ok: true, value: { status: "already_satisfied", diagnostics, ownedPaths } };
  }
  async #run(raw: SetupApplyRequest, apply: boolean, options?: OperationOptions): Promise<OperationResult<SetupReceipt>> {
    const parsed = SetupApplyRequestSchema.safeParse(raw);
    if (!parsed.success) return this.#fail(parsed.error.message);
    const request = parsed.data;
    if (!request.step.toolInstall) return this.#fail("Native tool install request required");
    const planned = await this.plan(request.step.toolInstall);
    if (!planned.ok) return planned;
    if (JSON.stringify(planned.value) !== JSON.stringify(request.step)) return this.#fail("Native setup step differs from approved plan");
    if (apply && !request.approvalReceiptId) return this.#fail("Machine setup approval is required");
    const childSteps = await this.#childSteps(request.step.toolInstall);
    if (!childSteps.ok) return childSteps;
    const currentDigest = createHash("sha256").update(JSON.stringify(childSteps.value.map(child => child.step))).digest("hex");
    if (currentDigest !== request.step.desiredStateDigest) return this.#fail("Native subscription route changed after plan validation; create a new approved plan");
    const receipts: SetupReceipt[] = [], diagnostics: string[] = [];
    let status: SetupReceipt["status"] = "already_satisfied";
    for (const child of childSteps.value) {
      const input = SetupApplyRequestSchema.parse({ ...request, step: child.step });
      const result = apply ? await child.installer.apply(input, options) : await child.installer.reconcile(input, options);
      if (!result.ok) return result;
      receipts.push(result.value);
      diagnostics.push(...result.value.diagnostics.map(message => `${child.provider}: ${message}`));
      if (result.value.status === "applied") status = "applied";
      else if (result.value.status !== "already_satisfied") { status = result.value.status; break; }
    }
    return { ok: true, value: SetupReceiptSchema.parse({ schemaVersion: 3, receiptId: randomUUID(), planId: request.planId,
      planDigest: request.planDigest, stepId: request.step.stepId, scope: request.step.scope, status,
      desiredStateDigest: request.step.desiredStateDigest,
      observedStateDigest: status === "applied" || status === "already_satisfied" ? request.step.desiredStateDigest : null,
      ownedPaths: [...new Set(receipts.flatMap(receipt => receipt.ownedPaths))],
      ...(request.approvalReceiptId ? { approvalReceiptId: request.approvalReceiptId } : {}),
      observedAt: new Date().toISOString(), diagnostics, idempotencyKey: request.step.idempotencyKey }) };
  }
  apply(request: SetupApplyRequest, options?: OperationOptions) { return this.#run(request, true, options); }
  reconcile(request: SetupApplyRequest, options?: OperationOptions) { return this.#run(request, false, options); }
}
