import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, readdir, link, unlink } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { AgentExecutionHandleSchema, AgentRequestSchema, AgentTargetLocatorSchema, IsoDateTimeSchema, JsonValueSchema, PaneBindingSchema, canonicalReceiptJson, type AgentExecutionHandle, type AgentRequest, type PaneBinding } from "@bflow/contracts";
import { HostLaunchMaterialSchema, type HostLaunchMaterial } from "../platform/host-options.js";
import { CancellationStopProofSchema, NamespaceExitProofSchema, ownsCancellationPane, type NamespaceExitProof, type CancellationStopProof } from "./cancellation-stop.js";
import { PROCESS_SCOPE_SUPERVISOR } from "./process-scope-supervisor.js";
const execute = promisify(execFile);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const ConfigSchema = z.object({ schemaVersion: z.literal(1), scopeId: z.string().uuid(), runId: z.string().min(1), taskId: z.string().min(1), launchId: z.string().min(1),
  launchFingerprint: sha, secret: sha, python: z.string().min(1), bwrap: z.string().min(1), target: z.string().min(1), targetDigest: sha,
  originalPath: z.string(), supervisorDigest: sha }).strict();
const WitnessSchema = z.object({ scopeId: z.string().uuid(), launchId: z.string().min(1), launchFingerprint: sha, bootId: z.string().uuid(),
  initPid: z.number().int().positive(), initStartTime: z.string().regex(/^\d+$/), namespace: z.string().regex(/^pid:\[\d+\]$/), startedAt: IsoDateTimeSchema }).strict();
const NativeSchema = z.object({ witnessDigest: sha, paneId: z.string(), agentId: z.string(), terminalId: z.string().optional(), session: z.object({
  source: z.string(), kind: z.enum(["id", "path", "opaque"]), value: z.string() }).strict() }).strict();
const RequestPinSchema = z.object({ requestId: z.string(), runId: z.string(), taskId: z.string(), attemptId: z.string(),
  idempotencyKey: z.string(), target: AgentTargetLocatorSchema, nativeDigest: sha }).strict();
const ExecutionSchema = z.object({ nativeDigest: sha, handle: AgentExecutionHandleSchema }).strict();
const ClosedSchema = z.object({ scopeId: z.string().uuid(), witnessDigest: sha, observedAt: IsoDateTimeSchema }).strict();
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function privateJSON(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error("Unsafe process-scope record");
    return JSON.parse(await file.readFile("utf8")); } finally { await file.close(); }
}
async function writeRecord(path: string, value: unknown): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path); const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function writeImmutable(path: string, value: unknown): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  const bytes = JSON.stringify(value), file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try {
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JsonValueSchema.parse(await privateJSON(path));
      if (canonicalReceiptJson(existing) !== canonicalReceiptJson(JsonValueSchema.parse(JSON.parse(bytes)))) throw new Error("Conflicting immutable process-scope receipt");
    }
  } finally { await unlink(temporary); }
  const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function executable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    try { const path = await realpath(join(directory, name)); await access(path, constants.X_OK); return path; } catch { /* continue installed discovery */ }
  }
  throw new Error(`Developer process supervision requires installed ${name}`);
}

/** Future Linux Developer launches only. No recovery proof is manufactured for legacy native sessions. */
export class DeveloperProcessScopes {
  private ready: Promise<{ python: string; bwrap: string }> | undefined;
  private readonly directory: string;
  constructor(options: { directory: string }) { this.directory = resolve(options.directory); }
  assertReady(): Promise<{ python: string; bwrap: string }> {
    return this.ready ??= (async () => {
      if (process.platform !== "linux") throw new Error("Developer process supervision requires a supported Linux PID-namespace backend");
      const python = await executable("python3"), bwrap = await executable("bwrap");
      try {
        await execute(python, ["-c", "import os,signal; assert hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'); fd=os.pidfd_open(os.getpid()); signal.pidfd_send_signal(fd,0); os.close(fd)"], { timeout: 5000 });
        await execute(bwrap, ["--unshare-user", "--unshare-pid", "--die-with-parent", "--cap-drop", "ALL", "--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc", "--", "/bin/true"], { timeout: 10000 });
      } catch { throw new Error("Developer process supervision is unavailable: verify Bubblewrap user namespaces/AppArmor and Python pidfd support before allocating a writer"); }
      return { python, bwrap };
    })().catch(error => { this.ready = undefined; throw error; });
  }
  async prepare(input: { runId: string; taskId: string; material: HostLaunchMaterial; executable: string; executableDigest: string; configFiles: readonly { path: string; digest: string }[] }): Promise<HostLaunchMaterial> {
    const tools = await this.assertReady(), material = HostLaunchMaterialSchema.parse(input.material);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await realpath(this.directory) !== this.directory || ((await lstat(this.directory)).mode & 0o077)) throw new Error("Unsafe Developer process-scope directory");
    const originalPath = material.env.PATH ?? process.env.PATH ?? "/usr/bin:/bin";
    const name = material.provider === "claude" ? "claude" : material.provider === "agy" ? "agy" : "codex";
    let target: string | undefined;
    for (const dir of originalPath.split(delimiter)) {
      try { const candidate = await realpath(join(dir, name)); await access(candidate, constants.X_OK); target = candidate; break; } catch { /* continue effective Herdr PATH */ }
    }
    if (!target) throw new Error("Provider command is absent from its actual launch PATH");
    const targetDigest = hash(await readFile(target));
    const expected = target === await realpath(input.executable) ? input.executableDigest : input.configFiles.find(file => file.path === target)?.digest;
    if (targetDigest !== expected) throw new Error("Actual Herdr provider command does not match the pinned executable/environment wrapper");
    const scopeId = randomUUID(), root = join(this.directory, scopeId); await mkdir(join(root, "bin"), { recursive: true, mode: 0o700 });
    const script = join(root, "supervisor.py"), config = join(root, "config.json");
    await writeFilePrivate(script, PROCESS_SCOPE_SUPERVISOR, 0o500);
    await writeRecord(config, ConfigSchema.parse({ schemaVersion: 1, scopeId, runId: input.runId, taskId: input.taskId, launchId: material.launchId,
      launchFingerprint: material.launchFingerprint, secret: randomBytes(32).toString("hex"), ...tools, target, targetDigest, originalPath,
      supervisorDigest: hash(PROCESS_SCOPE_SUPERVISOR) }));
    await writeFilePrivate(join(root, "bin", name), `#!/bin/sh\nexec ${quote(tools.python)} ${quote(script)} launch ${quote(config)} "$@"\n`, 0o500);
    return HostLaunchMaterialSchema.parse({ ...material, env: { ...material.env, PATH: join(root, "bin") + delimiter + originalPath, BFLOW_PROCESS_SCOPE_ID: scopeId } });
  }
  private async entries(binding: PaneBinding): Promise<{ root: string; config: z.infer<typeof ConfigSchema> }[]> {
    const scope = z.string().uuid().safeParse(binding.metadata?.processScopeId);
    if (!scope.success) return [];
    const entries = [scope.data];
    const found = [];
    for (const id of entries) {
      if (!z.string().uuid().safeParse(id).success) throw new Error("Malformed process-scope identity");
      const root = join(this.directory, id);
      const raw = await privateJSON(join(root, "config.json")).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try { await lstat(join(root, "started")); throw new Error("Started process scope lost its configuration"); }
        catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw missing; }
      });
      if (raw === undefined) continue;
      const config = ConfigSchema.parse(raw);
      if (config.scopeId !== id || hash(await readFile(join(root, "supervisor.py"))) !== config.supervisorDigest) throw new Error("Process-scope bootstrap integrity mismatch");
      if (config.launchId === binding.metadata?.launchId && config.launchFingerprint === binding.metadata?.launchFingerprint &&
          config.runId === binding.metadata?.runId && config.taskId === binding.metadata?.taskId)
        found.push({ root, config });
    }
    return found;
  }
  private async signed<T>(root: string, name: string, config: z.infer<typeof ConfigSchema>, schema: z.ZodType<T>): Promise<T> {
    const value = z.object({ payload: z.unknown(), signature: sha }).strict().parse(await privateJSON(join(root, name)));
    const signature = createHmac("sha256", Buffer.from(config.secret, "hex")).update(canonicalReceiptJson(JsonValueSchema.parse(value.payload))).digest("hex");
    if (value.signature !== signature) throw new Error("Process-scope receipt authentication failed");
    return schema.parse(value.payload);
  }
  async assertBindingReady(bindingInput: PaneBinding): Promise<void> {
    const binding = PaneBindingSchema.parse(bindingInput);
    const entries = await this.entries(binding);
    for (const { root, config } of entries.reverse()) {
      let witness; try { witness = await this.signed(root, "witness.json", config, WitnessSchema); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (witness.scopeId !== config.scopeId || witness.launchId !== config.launchId || witness.launchFingerprint !== config.launchFingerprint) throw new Error("Foreign namespace launch witness");
      const native = NativeSchema.parse({ witnessDigest: hash(canonicalReceiptJson(witness)), paneId: binding.paneId, agentId: binding.agentId,
        ...(binding.terminalId ? { terminalId: binding.terminalId } : {}), session: binding.session });
      const saved = await privateJSON(join(root, "native.json")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (saved !== undefined && canonicalReceiptJson(NativeSchema.parse(saved)) !== canonicalReceiptJson(native)) continue;
      await execute(config.python, [join(root, "supervisor.py"), "inspect", join(root, "config.json")], { timeout: 5000, maxBuffer: 8192 });
      if (saved === undefined) await writeImmutable(join(root, "native.json"), native);
      return;
    }
    throw new Error("Developer has no started, authenticated process-scope witness; reconcile launch readiness before dispatch");
  }
  async pinDispatch(requestInput: AgentRequest, bindingInput: PaneBinding): Promise<void> {
    const request = AgentRequestSchema.parse(requestInput), binding = PaneBindingSchema.parse(bindingInput);
    if (request.role !== "developer" || binding.metadata?.runId !== request.runId || request.target.paneId !== binding.paneId || request.target.agentId !== binding.agentId ||
        request.target.worktreePath !== binding.worktreePath || binding.metadata?.taskId !== `${request.runId}-${request.taskId}` ||
        canonicalReceiptJson(request.target.session ?? null) !== canonicalReceiptJson(binding.session ?? null)) throw new Error("Foreign process-scope dispatch");
    await this.assertBindingReady(binding);
    for (const { root } of (await this.entries(binding)).reverse()) {
      const raw = await privateJSON(join(root, "native.json")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (raw === undefined) continue;
      const native = NativeSchema.parse(raw);
      if (canonicalReceiptJson(native.session) !== canonicalReceiptJson(binding.session)) continue;
      const pin = RequestPinSchema.parse({ requestId: request.requestId, runId: request.runId, taskId: request.taskId, attemptId: request.attemptId,
        idempotencyKey: request.idempotency.key, target: request.target, nativeDigest: hash(canonicalReceiptJson(native)) });
      const previous = await privateJSON(join(root, "request.json")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (previous !== undefined && canonicalReceiptJson(RequestPinSchema.parse(previous)) !== canonicalReceiptJson(pin)) throw new Error("Process scope already owns another dispatch");
      if (previous === undefined) await writeImmutable(join(root, "request.json"), pin);
      return;
    }
    throw new Error("Process scope has no authenticated native binding");
  }
  private async linkExecution(root: string, handle: AgentExecutionHandle): Promise<boolean> {
    const raw = await privateJSON(join(root, "request.json")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (raw === undefined) return false;
    const pin = RequestPinSchema.parse(raw);
    if (pin.requestId !== handle.requestId || pin.runId !== handle.runId || pin.taskId !== handle.taskId || pin.attemptId !== handle.attemptId ||
        pin.idempotencyKey !== handle.idempotencyKey || canonicalReceiptJson(pin.target) !== canonicalReceiptJson(handle.target)) return false;
    const next = ExecutionSchema.parse({ nativeDigest: pin.nativeDigest, handle });
    const old = await privateJSON(join(root, "execution.json")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (old !== undefined && canonicalReceiptJson(ExecutionSchema.parse(old)) !== canonicalReceiptJson(next)) return false;
    if (old === undefined) await writeImmutable(join(root, "execution.json"), next);
    return true;
  }
  async bindExecution(handleInput: AgentExecutionHandle, bindingInput: PaneBinding): Promise<void> {
    const handle = AgentExecutionHandleSchema.parse(handleInput), binding = PaneBindingSchema.parse(bindingInput);
    if (!ownsCancellationPane(handle, binding)) throw new Error("Foreign Developer process-scope binding");
    for (const { root } of await this.entries(binding)) if (await this.linkExecution(root, handle)) return;
    throw new Error("Developer process scope lacks a started witness/pinned dispatch");
  }
  async stop(handleInput: AgentExecutionHandle, bindingInput: PaneBinding): Promise<CancellationStopProof | undefined> {
    const handle = AgentExecutionHandleSchema.parse(handleInput), binding = PaneBindingSchema.parse(bindingInput);
    if (!ownsCancellationPane(handle, binding)) return undefined;
    for (const { root, config } of await this.entries(binding)) {
      const raw = await privateJSON(join(root, "execution.json")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (raw === undefined && !(await this.linkExecution(root, handle))) continue;
      const execution = ExecutionSchema.parse(raw ?? await privateJSON(join(root, "execution.json")));
      if (canonicalReceiptJson(execution.handle) !== canonicalReceiptJson(handle)) continue;
      const native = NativeSchema.parse(await privateJSON(join(root, "native.json")));
      const witness = await this.signed(root, "witness.json", config, WitnessSchema);
      if (execution.nativeDigest !== hash(canonicalReceiptJson(native)) || native.witnessDigest !== hash(canonicalReceiptJson(witness))) throw new Error("Process-scope binding integrity mismatch");
      const exit = await this.exitScope(root, config, witness);
      const previous = await privateJSON(join(root, "execution-stop-proof.json")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (previous !== undefined) {
        const proof = CancellationStopProofSchema.parse(previous);
        if (proof.source !== "linux_pid_namespace" || canonicalReceiptJson(proof.handle) !== canonicalReceiptJson(handle) ||
            proof.scopeId !== exit.scopeId || proof.receiptDigest !== exit.receiptDigest || proof.bootId !== exit.bootId ||
            proof.initPid !== exit.initPid || proof.initStartTime !== exit.initStartTime || proof.namespace !== exit.namespace)
          throw new Error("Foreign execution stop proof");
        return proof;
      }
      const proof = CancellationStopProofSchema.parse({ ...exit, handle, observedAt: new Date().toISOString() });
      await writeImmutable(join(root, "execution-stop-proof.json"), proof); return proof;
    }
    return undefined;
  }
  async stopUnbound(bindingInput: PaneBinding): Promise<NamespaceExitProof | undefined> {
    const binding = PaneBindingSchema.parse(bindingInput);
    for (const { root, config } of await this.entries(binding)) {
      const execution = await privateJSON(join(root, "execution.json")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (execution !== undefined) continue;
      await this.seal(root, config);
      let witness;
      const deadline = Date.now() + 1500;
      while (!witness) {
        try { witness = await this.signed(root, "witness.json", config, WitnessSchema); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          if (Date.now() >= deadline) throw new Error("Prepared scope admission is sealed; bootstrap stop lacks a namespace witness and requires reconciliation");
          await new Promise(resolveWait => setTimeout(resolveWait, 25));
        }
      }
      return this.exitScope(root, config, witness);
    }
    return undefined;
  }
  async hasStoppedProof(bindingInput: PaneBinding): Promise<boolean> {
    const binding = PaneBindingSchema.parse(bindingInput);
    for (const { root, config } of await this.entries(binding)) {
      const raw = await privateJSON(join(root, "namespace-proof.json")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (raw === undefined) continue;
      const proof = NamespaceExitProofSchema.parse(raw), witness = await this.signed(root, "witness.json", config, WitnessSchema),
        closed = await this.signed(root, "closed.json", config, ClosedSchema);
      const sealed = await this.signed(root, "sealed.json", config, z.object({ scopeId: z.string().uuid() }).strict());
      if (sealed.scopeId !== config.scopeId || proof.scopeId !== config.scopeId || witness.scopeId !== config.scopeId ||
          witness.launchId !== config.launchId || witness.launchFingerprint !== config.launchFingerprint || closed.scopeId !== config.scopeId ||
          proof.bootId !== witness.bootId || proof.initPid !== witness.initPid || proof.initStartTime !== witness.initStartTime ||
          proof.namespace !== witness.namespace || closed.witnessDigest !== hash(canonicalReceiptJson(witness)) ||
          proof.receiptDigest !== hash(canonicalReceiptJson(closed))) throw new Error("Stopped allocation proof does not match its exact namespace");
      const native = await privateJSON(join(root, "native.json")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (native !== undefined) {
        const pin = NativeSchema.parse(native);
        if (pin.witnessDigest !== hash(canonicalReceiptJson(witness)) || pin.paneId !== binding.paneId || pin.agentId !== binding.agentId || pin.terminalId !== binding.terminalId ||
            canonicalReceiptJson(pin.session) !== canonicalReceiptJson(binding.session ?? null)) return false;
      }
      return true;
    }
    return false;
  }
  private async seal(root: string, config: z.infer<typeof ConfigSchema>): Promise<void> {
    const payload = { scopeId: config.scopeId }, signature = createHmac("sha256", Buffer.from(config.secret, "hex")).update(canonicalReceiptJson(payload)).digest("hex");
    await writeImmutable(join(root, "sealed.json"), { payload, signature });
  }
  async sealLaunch(taskId: string, launchId: string): Promise<void> {
    let ids: string[];
    try { ids = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const id of ids) {
      if (!z.string().uuid().safeParse(id).success) throw new Error("Malformed process-scope identity");
      const root = join(this.directory, id);
      const raw = await privateJSON(join(root, "config.json")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (raw === undefined) continue;
      const config = ConfigSchema.parse(raw);
      if (config.taskId === taskId && config.launchId === launchId) await this.seal(root, config);
    }
  }
  private async exitScope(root: string, config: z.infer<typeof ConfigSchema>, witness: z.infer<typeof WitnessSchema>): Promise<NamespaceExitProof> {
    if (witness.scopeId !== config.scopeId || witness.launchId !== config.launchId || witness.launchFingerprint !== config.launchFingerprint)
      throw new Error("Foreign namespace launch witness");
    const witnessDigest = hash(canonicalReceiptJson(witness));
    await this.seal(root, config);
    await execute(config.python, [join(root, "supervisor.py"), "stop", join(root, "config.json")], { timeout: 10000, maxBuffer: 8192 });
    const closed = await this.signed(root, "closed.json", config, ClosedSchema);
    if (closed.scopeId !== config.scopeId || closed.witnessDigest !== witnessDigest) throw new Error("Foreign namespace exit receipt");
    const cached = await privateJSON(join(root, "namespace-proof.json")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (cached !== undefined) {
      const proof = NamespaceExitProofSchema.parse(cached);
      if (proof.scopeId !== config.scopeId || proof.bootId !== witness.bootId || proof.initPid !== witness.initPid ||
          proof.initStartTime !== witness.initStartTime || proof.namespace !== witness.namespace ||
          proof.receiptDigest !== hash(canonicalReceiptJson(closed))) throw new Error("Foreign namespace stop proof");
      return proof;
    }
    const proof = NamespaceExitProofSchema.parse({ source: "linux_pid_namespace", observedAt: new Date().toISOString(), scopeId: config.scopeId,
      bootId: witness.bootId, initPid: witness.initPid, initStartTime: witness.initStartTime, namespace: witness.namespace,
      receiptDigest: hash(canonicalReceiptJson(closed)) });
    await writeRecord(join(root, "namespace-proof.json"), proof); return proof;
  }

}
async function writeFilePrivate(path: string, content: string, mode: number): Promise<void> {
  const file = await open(path, "wx", mode); try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  await chmod(path, mode);
}
