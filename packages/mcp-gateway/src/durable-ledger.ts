import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalReceiptJson, MCPToolCallSchema, type MCPToolCall, type MCPToolCallResult } from "@bflow/contracts";
import { z } from "zod";

const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const CallIdentitySchema = z.object({ callId: z.string().min(1), registrationId: z.string().min(1),
  serviceId: z.string().min(1), tool: z.string().min(1), requestDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const LedgerLineSchema = z.discriminatedUnion("phase", [
  z.object({ ledgerVersion: z.literal(2), phase: z.literal("intent"), call: CallIdentitySchema }).strict(),
  z.object({ ledgerVersion: z.literal(2), phase: z.literal("result"), callId: z.string().min(1),
    status: z.enum(["completed", "failed", "unknown"]), outputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    observedAt: z.string().datetime() }).strict(),
  z.object({ ledgerVersion: z.literal(2), phase: z.literal("service_schema"), serviceId: z.string().min(1),
    revision: z.number().int().positive(), serviceConfigDigest: z.string().regex(/^[a-f0-9]{64}$/),
    schemaDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
]);
type CallIdentity = z.infer<typeof CallIdentitySchema>;
interface StoredCall { call: CallIdentity; status: "intent" | "completed" | "failed" | "unknown"; outputDigest?: string; resultSeen: boolean }
interface ServiceSchemaPin { revision: number; serviceConfigDigest: string; schemaDigest: string }

/** Private, owner-only fsynced journal. Payloads are represented only by a digest. */
export class DurableGatewayCallLedger {
  readonly #entries = new Map<string, StoredCall>();
  readonly #serviceSchemas = new Map<string, ServiceSchemaPin>();

  constructor(readonly path: string) {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Gateway call ledger path must be absolute and canonical");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const directory = lstatSync(dirname(path));
    if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(dirname(path)) !== dirname(path) ||
        (directory.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && directory.uid !== process.getuid())) {
      throw new Error("Gateway call ledger directory must be a private owner-controlled directory");
    }
    this.#withLock(() => this.#load());
  }

  get(callId: string): { requestDigest: string; registrationId: string; result: MCPToolCallResult } | undefined {
    return this.#withLock(() => {
      this.#reload();
      const value = this.#entries.get(callId);
      if (!value) return undefined;
      return { requestDigest: value.call.requestDigest, registrationId: value.call.registrationId,
        result: this.#unknown(callId, value.status === "completed" || value.status === "failed"
          ? "gateway_response_unavailable_after_restart" : "gateway_restart_after_intent", value.outputDigest) };
    });
  }

  /** First negotiated schema at a service revision becomes the durable pin. A same-revision drift blocks calls. */
  pinServiceSchema(input: { serviceId: string; revision: number; serviceConfigDigest: string; schemaDigest: string }): boolean {
    const parsed = z.object({ serviceId: z.string().min(1), revision: z.number().int().positive(),
      serviceConfigDigest: z.string().regex(/^[a-f0-9]{64}$/), schemaDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input);
    return this.#withLock(() => {
      this.#reload();
      const previous = this.#serviceSchemas.get(parsed.serviceId);
      if (previous && parsed.revision < previous.revision) return false;
      if (previous && parsed.revision === previous.revision) {
        return previous.serviceConfigDigest === parsed.serviceConfigDigest && previous.schemaDigest === parsed.schemaDigest;
      }
      const line = { ledgerVersion: 2 as const, phase: "service_schema" as const, ...parsed };
      this.#append(line);
      this.#serviceSchemas.set(parsed.serviceId, { revision: parsed.revision, serviceConfigDigest: parsed.serviceConfigDigest,
        schemaDigest: parsed.schemaDigest });
      return true;
    });
  }

  recordIntent(call: MCPToolCall): void {
    const parsed = MCPToolCallSchema.parse(call);
    const identity: CallIdentity = { callId: parsed.callId, registrationId: parsed.registrationId,
      serviceId: parsed.serviceId, tool: parsed.tool, requestDigest: sha(canonicalReceiptJson(parsed)) };
    this.#withLock(() => {
      this.#reload();
      const old = this.#entries.get(parsed.callId);
      if (old) {
        if (JSON.stringify(old.call) !== JSON.stringify(identity)) throw new Error("Gateway callId is already bound to another request");
        throw new Error("Gateway call intent is already durable and must not be dispatched again");
      }
      this.#append({ ledgerVersion: 2, phase: "intent", call: identity });
      this.#entries.set(parsed.callId, { call: identity, status: "intent", resultSeen: false });
    });
  }

  recordResult(callId: string, result: MCPToolCallResult): void {
    this.#withLock(() => {
      this.#reload();
      const entry = this.#entries.get(callId);
      if (!entry) throw new Error("Gateway result cannot be recorded without durable intent");
      if (result.callId !== callId) throw new Error("Gateway result callId does not match intent");
      const outputDigest = sha(canonicalReceiptJson(result.output));
      if (entry.resultSeen && (entry.status !== "unknown" || result.status === "unknown") &&
          (entry.status !== result.status || entry.outputDigest !== outputDigest)) {
        throw new Error("Gateway call has a contradictory durable result");
      }
      this.#append({ ledgerVersion: 2, phase: "result", callId, status: result.status, outputDigest, observedAt: result.observedAt });
      entry.status = result.status;
      entry.outputDigest = outputDigest;
      entry.resultSeen = true;
    });
  }

  #unknown(callId: string, diagnosticCode: string, outputDigest?: string): MCPToolCallResult {
    return { schemaVersion: 3, callId, status: "unknown", observedAt: new Date().toISOString(),
      output: { diagnosticCode, ...(outputDigest ? { outputDigest } : {}),
        message: "Gateway retained receipt metadata only; reconcile through the host before any retry" } };
  }

  #load(): void {
    let fd: number;
    try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    let contents: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_LEDGER_BYTES || (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw new Error("Gateway call ledger must be a bounded private owner-controlled regular file");
      }
      contents = readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
    for (const [index, line] of contents.split("\n").entries()) {
      if (!line) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { throw new Error(`Gateway call ledger is corrupt at line ${index + 1}`); }
      const parsed = LedgerLineSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`Gateway call ledger is invalid at line ${index + 1}`);
      if (parsed.data.phase === "intent") {
        const identity = parsed.data.call;
        if (this.#entries.has(identity.callId)) throw new Error(`Gateway call ledger has duplicate intent at line ${index + 1}`);
        this.#entries.set(identity.callId, { call: identity, status: "intent", resultSeen: false });
      } else if (parsed.data.phase === "result") {
        const entry = this.#entries.get(parsed.data.callId);
        if (!entry) throw new Error(`Gateway call ledger has orphan result at line ${index + 1}`);
        if (entry.resultSeen && (entry.status !== "unknown" || parsed.data.status === "unknown") &&
            (entry.status !== parsed.data.status || entry.outputDigest !== parsed.data.outputDigest)) {
          throw new Error(`Gateway call ledger has contradictory result at line ${index + 1}`);
        }
        entry.status = parsed.data.status;
        entry.outputDigest = parsed.data.outputDigest;
        entry.resultSeen = true;
      } else {
        const previous = this.#serviceSchemas.get(parsed.data.serviceId);
        const next = { revision: parsed.data.revision, serviceConfigDigest: parsed.data.serviceConfigDigest,
          schemaDigest: parsed.data.schemaDigest };
        if (previous && (next.revision < previous.revision || next.revision === previous.revision &&
            (next.serviceConfigDigest !== previous.serviceConfigDigest || next.schemaDigest !== previous.schemaDigest))) {
          throw new Error(`Gateway call ledger has contradictory schema pin at line ${index + 1}`);
        }
        this.#serviceSchemas.set(parsed.data.serviceId, next);
      }
    }
  }

  #reload(): void {
    this.#entries.clear();
    this.#serviceSchemas.clear();
    this.#load();
  }

  #withLock<T>(action: () => T): T {
    const lockPath = `${this.path}.lock`;
    const fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid()))
        throw new Error("Gateway call ledger lock must be a private owner-controlled regular file");
      // flock holds a kernel lock on the shared open-file description. If this
      // process exits, the kernel releases it; stale file contents are irrelevant.
      const acquired = spawnSync("flock", ["--exclusive", "--timeout", "5", "3"], {
        stdio: ["ignore", "ignore", "ignore", fd], timeout: 6000
      });
      if (acquired.error || acquired.status !== 0)
        throw new Error(`Gateway call ledger is busy or flock is unavailable${acquired.error ? `: ${acquired.error.message}` : ""}`);
      return action();
    } finally {
      closeSync(fd);
    }
  }

  #append(value: z.infer<typeof LedgerLineSchema>): void {
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
    const fd = openSync(this.path, flags, 0o600);
    try {
      const stat = fstatSync(fd);
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
      if (!stat.isFile() || stat.nlink !== 1 || stat.size + bytes.length > MAX_LEDGER_BYTES || (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw new Error("Gateway call ledger is not a bounded private owner-controlled regular file");
      }
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
}
