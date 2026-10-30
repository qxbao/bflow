import { afterEach, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { TestRunnerSource, describeTestRunners } from "../../src/agentic/task-commands.js";
import { captureTypecheck, captureTypeScriptSyntax } from "../../src/agentic/typecheck.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { SpecificationSchema, QualityGateContextSchema } from "@bflow/contracts";
import { TestStrategyResolver } from "@bflow/test-strategy";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

export async function compilerFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-compiler-"))); roots.push(root);
  await mkdir(join(root, "node_modules"));
  const require = createRequire(import.meta.url);
  await cp(dirname(require.resolve("typescript/package.json")), join(root, "node_modules/typescript"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\n*.tsbuildinfo\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "compiler-fixture", scripts: { test: "node --test", typecheck: "tsc -b --pretty false" } }));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, outDir: "dist" }, include: ["source.ts"] }));
  await writeFile(join(root, "source.ts"), "export const answer: number = 42;\n");
  await mkdir(join(root, "test"));
  await writeFile(join(root, "logic.cjs"), "exports.double = n => n * 2;\n");
  await writeFile(join(root, "test/unit.test.cjs"), "const {test}=require('node:test');const assert=require('node:assert/strict');const {double}=require('../logic.cjs');test('ac-behavior: Actual behavior',()=>assert.equal(double(21),42));\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Compiler Test", "-c", "user.email=compiler@localhost", "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Compiler Test", "-c", "user.email=compiler@localhost", "commit", "-qm", "baseline"]);
  return root;
}

it("advertises a host-measured TypeScript compiler without replacing behavioral test runners", async () => {
  const root = await compilerFixture(), source = new TestRunnerSource([], root);
  await source.refresh();
  const planning = describeTestRunners(source);
  expect(planning.testRunners).toEqual(expect.arrayContaining([
    expect.objectContaining({ command: "auto:typecheck", method: "typecheck" }),
    expect.objectContaining({ command: "auto:unit", method: "unit_test" })
  ]));
});

it("keeps behavioral discovery available when optional compiler metadata is malformed", async () => {
  const root = await compilerFixture();
  await writeFile(join(root, "node_modules/typescript/package.json"), "{broken");
  const source = new TestRunnerSource([], root);
  await source.refresh();
  expect(source.typecheck).toBeUndefined();
  expect(describeTestRunners(source).testRunners).toEqual(expect.arrayContaining([expect.objectContaining({ command: "auto:unit" })]));
});

it.skipIf(process.platform !== "linux")("measures real compiler errors and clean success without modifying the source worktree", async () => {
  const root = await compilerFixture(), source = new TestRunnerSource([], root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Compiler Test", "-c", "user.email=compiler@localhost", ...args], { encoding: "utf8" }).trim();
  await source.refresh();
  const compiler = source.typecheck!;
  // A Vitest repository must never pass Vitest reporter argv to the compiler.
  compiler.runner.reporter = "vitest_json";
  const base = git("rev-parse", "HEAD");
  expect(await captureTypecheck(compiler, root, base, base)).toMatchObject({ exitCode: 0 });
  await writeFile(join(root, "source.ts"), "export const answer: number = 'wrong';\n");
  git("add", "source.ts"); git("commit", "-qm", "type error");
  const revision = git("rev-parse", "HEAD");
  const failed = await captureTypecheck(compiler, root, revision, base);
  expect(failed.exitCode).not.toBe(0);
  expect(failed.output).toContain("TS2322");
  expect(git("rev-parse", "HEAD")).toBe(revision);
  expect(git("status", "--porcelain")).toBe("");
  expect(await readFile(join(root, "source.ts"), "utf8")).toContain("'wrong'");
  await writeFile(join(root, "tsconfig.json"), '{"compilerOptions":{},"files":[]}\n');
  git("add", "tsconfig.json"); git("commit", "-qm", "weaken config");
  await expect(captureTypecheck(compiler, root, git("rev-parse", "HEAD"), base)).rejects.toThrow();
});

it.skipIf(process.platform !== "linux")("rejects a new unreviewed compiler project while allowing only selected behavioral test edits", async () => {
  const root = await compilerFixture(), source = new TestRunnerSource([], root); await source.refresh();
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Compiler Test", "-c", "user.email=compiler@localhost", ...args], { encoding: "utf8" }).trim();
  const base = git("rev-parse", "HEAD"), compiler = source.typecheck!;
  await writeFile(join(root, "test/unit.test.cjs"), "require('node:test').test('updated',()=>{});\n");
  git("add", "test/unit.test.cjs"); git("commit", "-qm", "selected test edit");
  expect(await captureTypecheck(compiler, root, git("rev-parse", "HEAD"), base, ["test/unit.test.cjs"])).toMatchObject({ exitCode: 0 });
  await mkdir(join(root, "new-project"));
  await writeFile(join(root, "new-project/tsconfig.json"), '{"files":[]}\n');
  git("add", "new-project"); git("commit", "-qm", "unreviewed project");
  await expect(captureTypecheck(compiler, root, git("rev-parse", "HEAD"), base, ["test/unit.test.cjs"])).rejects.toThrow("Runner definitions differ");
});

it.skipIf(process.platform !== "linux")("checks syntax of changed test files outside tsconfig includes without executing them", async () => {
  const root = await compilerFixture();
  await writeFile(join(root, "test/outside.test.ts"), "throw new Error('must never execute');\nexport const x = ;\n");
  execFileSync("git", ["-C", root, "add", "test/outside.test.ts"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Compiler Test", "-c", "user.email=compiler@localhost", "commit", "-qm", "invalid syntax outside project"]);
  const source = new TestRunnerSource([], root); await source.refresh();
  const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const result = await captureTypeScriptSyntax(source.typecheck!, root, revision, ["test/outside.test.ts"], revision);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("Expression expected");
  expect(result.output).not.toContain("must never execute");
  await writeFile(join(root, "test/outside.test.ts"), "throw new Error('must never execute');\nexport const x: number = 1;\n");
  await writeFile(join(root, "test/declaration.d.ts"), "export declare const answer: number;\n");
  execFileSync("git", ["-C", root, "add", "test"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Compiler Test", "-c", "user.email=compiler@localhost", "commit", "-qm", "valid syntax and declaration"]);
  await source.refresh();
  const validRevision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  expect(await captureTypeScriptSyntax(source.typecheck!, root, validRevision, ["test/outside.test.ts", "test/declaration.d.ts"], validRevision)).toMatchObject({ exitCode: 0 });
});

it.skipIf(process.platform !== "linux")("admits compiler criteria through policy and authenticates criterion-bound compiler evidence", async () => {
  const root = await compilerFixture(), source = new TestRunnerSource([], root); await source.refresh();
  const at = "2026-10-29T00:00:00.000Z";
  const specification = SpecificationSchema.parse({ schemaVersion: 2, specId: "compiler-spec", runId: "compiler-run", sessionId: "compiler-session",
    level: "lightweight", title: "Compiler acceptance", summary: "Type safety", problemStatement: "Check the configured project",
    scope: { inScope: ["Project types"], outOfScope: [] }, affectedPaths: ["source.ts", "tsconfig.json", "test/unit.test.cjs"], status: "draft", createdBy: "architect", createdAt: at, updatedAt: at,
    acceptanceCriteria: [{ id: "ac-types", description: "Project compiles without type errors", category: "functional", verificationMethod: "typecheck", required: true, status: "pending", evidenceArtifactIds: [] },
      { id: "ac-behavior", description: "Actual behavior", category: "functional", verificationMethod: "unit_test", required: true, status: "pending", evidenceArtifactIds: [] }],
    metadata: { conditionalTdd: { policyVersion: 1, taskId: "compiler-task", taskType: "configuration",
      changeImpact: { behaviorChanged: false, deterministic: true, regressionReproducible: false, securitySensitive: false, dataMigration: false, scope: "local", surfaces: ["configuration"] },
      testability: { level: "automated", rationale: "Compiler diagnostics" }, infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: "auto:unit", level: "unit" }, { method: "typecheck", command: "auto:typecheck" }, { method: "static_analysis", command: "auto:static" }] },
      riskClassification: "low", conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] } } } });
  const strategy = new TestStrategyResolver().resolve(specification);
  const host = new HostVerification(() => { throw Error("not used"); }, () => { throw Error("not used"); }, undefined, source);
  expect(host.configuredMethods()).toContain("typecheck");
  expect(() => host.assertSupported(specification, strategy)).not.toThrow();
  expect(() => host.assertTaskSupported(specification, strategy, ["source.ts", "tsconfig.json", "test/unit.test.cjs"])).not.toThrow();
  const taskSpecification = SpecificationSchema.parse({ ...specification, acceptanceCriteria: specification.acceptanceCriteria.filter(criterion => criterion.verificationMethod === "unit_test") });
  const taskStrategy = new TestStrategyResolver().resolve(taskSpecification);
  expect(() => host.assertTaskSupported(taskSpecification, taskStrategy, ["test/unit.test.cjs"])).not.toThrow();
  const definition = host.behavioralChecks(specification, strategy).find(check => check.configuration?.command === "auto:typecheck")!;
  expect(definition.configuration?.method).toBe("typecheck");
  expect(definition.configuration?.testNames).toEqual(strategy.criterionMappings.find(mapping => mapping.criterionId === "ac-types")!.testNames);
  const gate = host.behavioralGates().find(item => item.id === definition.id)!;
  const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const result = await gate.evaluate(QualityGateContextSchema.parse({ runId: "compiler-run", taskId: "compiler-task", attemptId: "compiler-attempt",
    definition: { ...definition, configuration: { ...definition.configuration, criterionIds: ["ac-types"] } }, artifacts: [],
    input: { sourceWorktreePath: root, baseRevision: revision, sourceRevision: revision, specFingerprint: "a".repeat(64), scope: "task" } }));
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.error.message);
  expect(result.value).toMatchObject({ status: "passed", metadata: { verification: { method: "typecheck", criteria: [{ criterionId: "ac-types", passed: true }] } } });
  expect(await host.authenticateGate(result.value)).toBe(true);
  expect(await host.authenticateGate({ ...result.value, status: "failed" })).toBe(false);
});
