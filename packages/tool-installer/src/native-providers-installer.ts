import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { SetupApplyRequestSchema, SetupReceiptSchema, SetupStepSchema, ToolInstallRequestSchema,
  type OperationOptions, type OperationResult, type SetupApplyRequest, type SetupReceipt, type SetupStep,
  type ToolInstallRequest, type ToolInstaller } from "@bflow/contracts";
import { ManagedToolInstaller, ManagedToolPinSchema, type ManagedToolPin, type ProviderPluginAdapter, type ToolHost } from "./installer.js";
import { OfficialProviderPluginAdapter } from "./provider-plugins.js";
import type { NativeProvider, NativeRuntimeOptions } from "./native-runtime.js";
import { systemToolHost } from "./installer.js";

/** One machine-approved tool step composes provider-specific native activations.
 * Each child's ManagedToolInstaller retains uncertain native delivery; an aggregate retry
 * reconciles those child intents before it can invoke another provider command. */
export class NativeProvidersToolInstaller implements ToolInstaller {
  readonly installerId: string;
  readonly #root: string;
  readonly #pin: ManagedToolPin;
  readonly #children: { provider: NativeProvider; pin: ManagedToolPin; installer: ManagedToolInstaller }[];
  constructor(options: { managedRoot: string; pin: ManagedToolPin; providers: readonly NativeProvider[];
    host?: ToolHost; configuration?: Omit<NativeRuntimeOptions, "managedRoot">; providerPlugin?: ProviderPluginAdapter }) {
    const pin = ManagedToolPinSchema.parse(options.pin);
    if (pin.recipe.kind !== "provider_plugin" || !["superpowers", "claude-mem"].includes(pin.toolId)) throw Error("Native plugin pin required");
    this.#root = resolve(options.managedRoot); this.#pin = pin; this.installerId = pin.installerId;
    if (!options.providers.length || new Set(options.providers).size !== options.providers.length) throw Error("Unique selected providers required");
    const host = options.host ?? systemToolHost;
    this.#children = options.providers.map(provider => {
      const childPin = ManagedToolPinSchema.parse({ ...pin, installerId: `${pin.installerId}-${provider}`, recipe: { kind: "provider_plugin", provider } });
      return { provider, pin: childPin, installer: new ManagedToolInstaller({ managedRoot: this.#root, pins: [childPin], host,
        providerPlugin: options.providerPlugin ?? new OfficialProviderPluginAdapter({ host,
          configuration: { ...options.configuration, managedRoot: join(this.#root, ".native") } }) }) };
    });
  }
  #fail<T>(message: string): OperationResult<T> { return { ok: false, error: { code: "validation", retryable: false, message } }; }
  async #childSteps(request: ToolInstallRequest): Promise<OperationResult<SetupStep[]>> {
    const steps: SetupStep[] = [];
    for (const child of this.#children) {
      const planned = await child.installer.plan({ ...request, installerId: child.pin.installerId,
        destination: join(request.destination, child.provider), idempotencyKey: `${request.idempotencyKey}:${child.provider}` });
      if (!planned.ok) return planned;
      steps.push(planned.value);
    }
    return { ok: true, value: steps };
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
    const desiredStateDigest = createHash("sha256").update(JSON.stringify(children.value)).digest("hex");
    return { ok: true, value: SetupStepSchema.parse({ schemaVersion: 3, stepId: `install-${pin.toolId}`, action: "install_tool",
      componentId: pin.toolId, level: "machine", scope: request.scope, dependsOn: [], desiredStateDigest,
      expectedStateDigest: null, requiresApproval: true, rollback: "manual", toolInstall: request,
      idempotencyKey: request.idempotencyKey }) };
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
    const receipts: SetupReceipt[] = [], diagnostics: string[] = [];
    let status: SetupReceipt["status"] = "already_satisfied";
    for (const [index, child] of this.#children.entries()) {
      const input = SetupApplyRequestSchema.parse({ ...request, step: childSteps.value[index] });
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
