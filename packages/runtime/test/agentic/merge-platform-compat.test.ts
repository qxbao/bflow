import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { javascriptAdapter } from "../../src/agentic/javascript-adapter.js";
import { sandboxBehavior } from "../../src/agentic/behavioral-sandbox.js";
import type { BoundBehavioralCommand } from "../../src/agentic/behavioral-runner.js";
vi.mock("../../src/agentic/sandbox-readiness.js", () => ({ probeBehavioralSandbox: async () => ({ status: "ready", executable: "/usr/bin/sandbox-exec", platform: "darwin" }) }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
afterEach(async () => { Object.defineProperty(process, "platform", platform); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "bflow-platform-merge-")); roots.push(root); return root; }
const command: BoundBehavioralCommand = { id: "fixture", command: "owner:fixture", executable: process.execPath, args: [], method: "unit_test", levels: ["unit"], testNames: ["target"], testPaths: ["test.js"], timeoutMs: 1000 };
it("retains allowlisted Node flags in nested JS projects without forwarding arbitrary loaders", async () => {
  const root = await fixture(); await mkdir(join(root, "nested"));
  const context = { root, files: ["nested/package.json"] };
  await writeFile(join(root, "nested/package.json"), JSON.stringify({ scripts: { test: "node --experimental-strip-types --disable-warning=ExperimentalWarning --test" } }));
  const found = await javascriptAdapter.detect(context);
  expect(found.runners).toHaveLength(1);
  expect(found.runners[0]!.bind({ testNames: ["target"], testPaths: ["nested/test.ts"] }, "/reports").args).toEqual(["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test", "--test-reporter=tap", "--test-name-pattern=^(?:target)$", "test.ts"]);
  await writeFile(join(root, "nested/package.json"), JSON.stringify({ scripts: { test: "node --require ./loader.js --test" } }));
  expect((await javascriptAdapter.detect(context)).runners).toEqual([]);
});
it("rejects unsupported adapter grants before constructing a Darwin sandbox", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const adapter = { adapterId: "jest", version: "1", executable: process.execPath, projectDirectory: ".", format: "jest_json" as const, nameRule: "fullName", mounts: [], environment: {}, protectedPaths: [], bind: () => ({ args: [] }) };
  await expect(sandboxBehavior({ ...command, adapter }, "/unused", [])).rejects.toThrow("runner_setup_required");
});
it("applies credential-tree rejection before granting Darwin dependency reads", async () => {
  const root = await fixture(), modules = join(root, "node_modules"); await mkdir(modules);
  await writeFile(join(modules, ".npmrc"), "fixture credential must never be granted");
  Object.defineProperty(process, "platform", { value: "darwin" });
  await expect(sandboxBehavior({ ...command, dependencyRoots: [modules] }, root, [])).rejects.toThrow("Credential material in dependency tree");
});
