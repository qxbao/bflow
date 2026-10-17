import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  GitChangeSetSchema,
  QualityGateResultSchema,
  SpecificationSchema,
  type ArtifactStore,
  type GitChangeSet,
  type OperationResult,
  type QualityGate,
  type QualityGateContext,
  type QualityGateResult,
  type Specification,
  type TestStrategy
} from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import type { IntegrationRecord, IntegrationRequest, TaskRecord, TaskRequest } from "@bflow/git-orchestrator";
import { SpecificationEngine } from "@bflow/specification";
import { TestStrategyResolver } from "@bflow/test-strategy";
import { CheckConfigurationSchema, ObservationSchema } from "@bflow/verification";
import type { PlatformProfile, SkillsSynchronizer } from "@bflow/machine-setup";
import {
  createDefaultHighLevelServices,
  HighLevelEnvelopeSchema,
  runCli,
  type CliIo,
  type GitOrchestratorPort,
  type HighLevelEnvelope,
  type HighLevelServices
} from "../../src/index.js";

export const NOW = "2026-10-17T05:00:00.000Z";
export const RUN_ID = "run-1";
export const TASK_ID = "implement";

export const hasFlock = spawnSync("flock", ["--version"]).status === 0;

export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: gitEnv(), encoding: "utf8" }).trim();
}

/** Real repository with one commit, ignoring CLI state. */
export function createRepository(): string {
  const root = tempDir("bflow-hl-repo-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "src/math"), { recursive: true });
  writeFileSync(join(root, "src/math/average.ts"), "export const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;\n");
  writeFileSync(join(root, ".gitignore"), ".bflow/state/\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", packageManager: "pnpm@12.5.1", scripts: { test: "vitest" } }));
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "initial");
  return root;
}

const examplePath = resolve(import.meta.dirname, "../../../../packages/specification/examples/standard.json");

/** P15 standard example plus the P16 assessment for its traced task. */
export function draftSpecification(): Record<string, unknown> {
  const spec = JSON.parse(readFileSync(examplePath, "utf8")) as Record<string, unknown> & { metadata: Record<string, unknown> };
  spec.metadata.conditionalTdd = {
    policyVersion: 1,
    taskId: TASK_ID,
    taskType: "bugfix",
    changeImpact: { surfaces: ["bugfix"], behaviorChanged: true, deterministic: true, regressionReproducible: true,
      securitySensitive: false, dataMigration: false, scope: "local" },
    infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: "pnpm test:math", level: "unit" }] },
    testability: { level: "automated", rationale: "Pure arithmetic function with deterministic numeric inputs." },
    riskClassification: "medium",
    conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] }
  };
  return spec;
}

export async function openStore(root: string): Promise<ArtifactStore & { close(): void }> {
  const result = await openFilesystemArtifactStore({ root: join(root, ".bflow/state/cli/artifacts"), storeId: "bflow-cli" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Stores the reviewed document through the real P15 engine, then records a human approval. */
export async function approvedSpecification(root: string, store?: ArtifactStore): Promise<Specification> {
  const owned = store === undefined ? await openStore(root) : undefined;
  try {
    const engine = new SpecificationEngine({ artifactStore: store ?? owned!, authorizeApprover: () => false });
    const reviewed = await engine.submitForReview(draftSpecification());
    return SpecificationSchema.parse({ ...reviewed, status: "approved", approvedBy: "human-owner" });
  } finally {
    owned?.close();
  }
}

export function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

/** In-memory stand-in for the P18 engine on hosts without Linux flock; records every call. */
export class RecordingGitPort implements GitOrchestratorPort {
  readonly tasks = new Map<string, TaskRecord>();
  readonly calls: string[] = [];
  integration?: IntegrationRecord;
  prepareDelayMs = 0;
  failPrepare?: Error;
  conflict = false;
  changeSet?: GitChangeSet;
  constructor(readonly root: string) {}

  async prepareTask(request: TaskRequest): Promise<TaskRecord> {
    this.calls.push(`prepare:${request.taskId}`);
    if (this.prepareDelayMs > 0) await new Promise(r => setTimeout(r, this.prepareDelayMs));
    if (this.failPrepare) throw this.failPrepare;
    const key = `${request.runId}-${request.taskId}-${request.attemptId}`;
    const existing = this.tasks.get(key);
    if (existing) return structuredClone(existing);
    const worktreePath = join(this.root, ".bflow/state/test-trees", key);
    mkdirSync(worktreePath, { recursive: true });
    const record: TaskRecord = {
      key, request: { ...request, forbiddenPaths: request.forbiddenPaths ?? [] }, baseCommitHash: git(this.root, "rev-parse", "HEAD"),
      branchName: `agent/bflow/${request.runId}/${request.taskId}/${request.attemptId}`, worktreePath, status: "active"
    };
    this.tasks.set(key, record);
    return structuredClone(record);
  }
  async getTask(key: string): Promise<TaskRecord> {
    const task = this.tasks.get(key);
    if (!task) throw new Error(`Unknown task ${key}`);
    return structuredClone(task);
  }
  async collectTask(key: string): Promise<GitChangeSet> {
    this.calls.push(`collect:${key}`);
    if (!this.changeSet) throw new Error("No submission");
    const task = this.tasks.get(key)!;
    task.changeSet = this.changeSet;
    return structuredClone(this.changeSet);
  }
  async beginIntegration(request: IntegrationRequest): Promise<IntegrationRecord> {
    this.calls.push(`integrate:${request.integrationId}`);
    if (this.integration) return structuredClone(this.integration);
    const head = "c".repeat(40);
    const order = request.tasks.map(t => t.taskKey);
    this.integration = {
      key: `${request.runId}-${request.integrationId}`,
      request: { ...request, tasks: request.tasks.map(t => ({ taskKey: t.taskKey, dependsOn: t.dependsOn ?? [] })) },
      branchName: `integration/bflow/${request.runId}/${request.integrationId}`,
      worktreePath: join(this.root, ".bflow/state/test-trees/integration"),
      baseCommitHash: "a".repeat(40), expectedHead: head, order,
      snapshots: Object.fromEntries(order.map(k => [k, this.changeSet!])), merged: this.conflict ? [] : order,
      ...(this.conflict ? { currentTask: order[0]! } : {}),
      status: this.conflict ? "conflict" : "awaiting_verification",
      conflictPaths: this.conflict ? ["src/math/average.ts"] : [],
      requests: [{
        schema_version: 2, message_id: "git-msg-1", correlation_id: request.runId, run_id: request.runId,
        sender: { role: "runtime" }, recipient: { role: "coordinator" },
        type: this.conflict ? "task.status" : "verification.requested",
        payload: this.conflict ? { reason: "merge_conflict" } : { verificationScope: "workflow", integrationCommitHash: head },
        artifact_references: [], occurred_at: NOW, idempotency_key: "git-msg-1"
      } as never]
    };
    return structuredClone(this.integration);
  }
  async resumeIntegration(): Promise<IntegrationRecord> {
    return structuredClone(this.integration!);
  }
}

/** Trusted host gate double: emits a valid independent observation; never runs a subprocess. */
export class IndependentGate implements QualityGate {
  readonly calls: QualityGateContext[] = [];
  delayMs = 0;
  constructor(readonly id: string, public mode: "passed" | "failed" = "passed") {}
  async evaluate(context: QualityGateContext): Promise<OperationResult<QualityGateResult>> {
    this.calls.push(context);
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    const config = CheckConfigurationSchema.parse(context.definition.configuration);
    const input = context.input as Record<string, unknown>;
    const passed = this.mode === "passed";
    const observation = ObservationSchema.parse({
      schemaVersion: 2, checkId: this.id, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
      sourceRevision: input.sourceRevision, specFingerprint: input.specFingerprint, scope: input.scope,
      independentExecution: true, isolated: true, executorId: "independent-verifier", role: config.role, method: config.method,
      ...(config.command ? { command: config.command, exitCode: passed ? 0 : 1 } : {}),
      testNames: config.testNames,
      criteria: config.criterionIds.map(criterionId => ({ criterionId, passed, summary: passed ? "Observed" : "Absent" })),
      summary: passed ? "Independent check passed" : "Independent check failed"
    });
    return { ok: true, value: QualityGateResultSchema.parse({
      gateId: this.id, runId: context.runId, taskId: context.taskId, evaluationId: `${this.id}-${context.attemptId}-${this.calls.length}`,
      status: passed ? "passed" : "failed",
      findings: passed ? [] : [{ code: "TARGET_BEHAVIOR", severity: "error", message: "Target assertion failed" }],
      producedArtifacts: [], evaluatedAt: new Date().toISOString(), metadata: { verification: observation }
    }) };
  }
}

/** Plan input whose checks follow the resolved P16 strategy. */
export function verificationPlanInput(spec: Specification, strategy: TestStrategy) {
  const criterionIds = spec.acceptanceCriteria.map(c => c.id);
  const testNames = strategy.criterionMappings.flatMap(m => m.testNames);
  const check = (id: string, configuration: unknown) => ({ id, name: id, evaluator: id, required: true,
    timeout: { executionTimeoutMs: 5000, onTimeout: "block" }, configuration });
  return {
    runId: RUN_ID, taskId: TASK_ID, scope: "task", specification: spec, strategy, implementerIds: ["developer-1"], maxIterations: 3,
    checks: [
      ...strategy.targetCommands.map((command, index) => check(`test-${index}`, { kind: "deterministic", method: "unit_test", command,
        criterionIds, testNames, role: "tester", levels: [...strategy.requiredTestLevels] })),
      check("review", { kind: "review", method: "manual_review", criterionIds: [], testNames: [], role: "reviewer", levels: [] })
    ]
  };
}

export async function storedChangeSet(store: ArtifactStore, attempt = 1): Promise<GitChangeSet> {
  const bytes = Buffer.from(`diff --git a/src/math/average.ts b/src/math/average.ts\n+// attempt ${attempt}\n`);
  const stored = await store.put({
    options: { artifactId: `patch-${attempt}`, runId: RUN_ID, taskId: TASK_ID, kind: "patch", mediaType: "text/x-diff",
      idempotencyKey: `patch-${attempt}`,
      expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length } },
    content: (async function* () { yield bytes; })()
  });
  if (!stored.ok) throw new Error(stored.error.message);
  return GitChangeSetSchema.parse({ schemaVersion: 2, changeSetId: `change-${attempt}`, runId: RUN_ID, taskId: TASK_ID,
    attemptId: `attempt-${attempt}`, worktreePath: "/tmp/task", branchName: "agent/bflow/run-1/implement/attempt-1",
    baseCommitHash: "a".repeat(40), headCommitHash: attempt.toString(16).repeat(40), dirtyWorkingTree: false,
    filesChanged: [{ path: "src/math/average.ts", changeType: "modified", additions: 1, deletions: 0 }],
    patchArtifact: stored.value, createdAt: new Date().toISOString() });
}

/** Host platform whose XDG config/state/data paths are private temporary directories. */
export async function isolatedPlatform(): Promise<PlatformProfile> {
  const base = await (await createDefaultHighLevelServices()).machine.platform();
  const home = tempDir("bflow-hl-xdg-home-");
  return { ...base, homeDir: home, paths: { config: join(home, "config"), data: join(home, "data"),
    state: join(home, "state"), managedBin: join(home, "data", "bin") } };
}

export interface ServiceOverrides {
  git?: GitOrchestratorPort;
  gates?: QualityGate[];
  skills?: (providers: readonly string[]) => SkillsSynchronizer;
  platform?: PlatformProfile;
  runnerVersions?: Record<string, string>;
  providerHealth?: HighLevelServices["providers"];
  mcpGateway?: HighLevelServices["mcpGateway"];
}

/** Real P15/P16/P17/P25/P26 composition with a filesystem ArtifactStore; only listed seams are replaced. */
export async function services(overrides: ServiceOverrides = {}): Promise<HighLevelServices> {
  const base = await createDefaultHighLevelServices();
  return {
    ...base,
    ...(overrides.gates ? { gates: overrides.gates } : {}),
    ...(overrides.skills ? { skills: overrides.skills } : {}),
    ...(overrides.mcpGateway ? { mcpGateway: overrides.mcpGateway } : {}),
    ...(overrides.providerHealth ? { providers: overrides.providerHealth } : {}),
    openRuntime: async () => undefined,
    machine: {
      platform: async () => overrides.platform ?? await base.machine.platform(),
      runner: () => overrides.runnerVersions === undefined ? base.machine.runner() : {
        async run(argv) {
          const name = argv[0]!.split("/").pop()!;
          const version = overrides.runnerVersions![name];
          return version === undefined ? { exitCode: 127, stdout: "", stderr: "not found", timedOut: false }
            : { exitCode: 0, stdout: `${version}\n`, stderr: "", timedOut: false };
        }
      }
    },
    async openResources(root, options) {
      if (overrides.git === undefined && hasFlock) return base.openResources(root, options);
      const store = await openStore(root);
      return { git: overrides.git ?? new RecordingGitPort(root), artifactStore: store, async close() { store.close(); } };
    }
  };
}

export function captureIo(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: m => out.push(m), stderr: m => err.push(m) };
}

/** Runs `bflow <argv> --json` and validates the envelope against the published contract. */
export async function bflow(cwd: string, svc: HighLevelServices, ...argv: string[]): Promise<HighLevelEnvelope> {
  const io = captureIo();
  const result = await runCli([...argv, "--json"], { cwd, io, highLevelServices: svc });
  const text = io.out.join("\n");
  const envelope = HighLevelEnvelopeSchema.parse(JSON.parse(text));
  if (envelope.exitCode !== result.exitCode) throw new Error("exit code mismatch between envelope and process result");
  return envelope;
}

export function output(envelope: HighLevelEnvelope) {
  return envelope.result.output as { outcome: string; replayed: boolean; ids: Record<string, string>;
    steps: { id: string; status: string; message?: string; data?: unknown }[]; data: any };
}

export const resolver = new TestStrategyResolver();
