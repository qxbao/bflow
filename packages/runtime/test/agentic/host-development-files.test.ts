import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaneBinding } from "@bflow/contracts";
import { HostDevelopment } from "../../src/agentic/host-development.js";

const at = "2031-01-01T00:00:00.000Z", digest = (value: string) => createHash("sha256").update(value).digest("hex");
describe("guarded host workspace files", () => {
  let root: string, binding: PaneBinding, development: HostDevelopment, evidence: unknown[], denial: string | undefined;
  let resolver: boolean, guardActive: boolean, beforeGuardRelease: (() => Promise<void>) | undefined;
  let forbidden: string[];
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "bflow-workspace-files-")));
    await mkdir(join(root, "src")); await mkdir(join(root, "test"));
    await writeFile(join(root, "src/math.ts"), "original");
    binding = { schemaVersion: 2, bindingId: "binding", sessionId: "session", role: "developer", paneGroup: "developer_worktree",
      agentId: "dev", workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p2", provider: "herdr", agentKind: "agy", cwd: root, worktreePath: root,
      isolationMode: "dedicated_pane", readOnlyWorkspace: false, permanent: false, transportState: "idle", boundAt: at };
    evidence = []; denial = undefined; resolver = false; guardActive = false; beforeGuardRelease = undefined;
    forbidden = ["src/private"];
    const strategy = { tddDecision: { mode: "required" }, targetCommands: ["test"], criterionMappings: [], metadata: { tddEvidence: evidence } };
    const use = async (callback: (...args: any[]) => Promise<unknown>, ...args: any[]) => {
      if (denial) throw new Error(denial);
      guardActive = true;
      try { const result = await callback(...args); await beforeGuardRelease?.(); return result; } finally { guardActive = false; }
    };
    const runtime = {
      inspect: async () => ({ outbound: [{ status: "accepted", message: { schema_version: 2, message_id: "assignment", correlation_id: "correlation", run_id: "run",
        sender: { role: "coordinator" }, recipient: { role: "developer", agent_id: "dev", pane_id: "w2:p2" }, type: "task.assignment",
        payload: resolver ? { kind: "conflict_resolution" } : {}, artifact_references: [], occurred_at: at, idempotency_key: "assignment" },
      handle: { executionId: "execution", requestId: "request", attemptId: "attempt", runId: "run", taskId: "task", idempotencyKey: "assignment",
        target: { transport: "herdr", agentId: "dev", workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p2", worktreePath: root },
        correlation: { token: "request", provenance: "orchestrator", verified: false }, acceptedAt: at } }] }),
      withDeveloperWorkspace: async (_binding: unknown, run: string, task: string, callback: (...args: any[]) => Promise<unknown>) => {
        expect([run, task]).toEqual(["run", "task"]);
        return use(callback, { spec: { strategy, specification: { acceptanceCriteria: [] } } }, { metadata: { ownedPaths: ["src", "test"], forbiddenPaths: forbidden } });
      },
      withConflictResolverWorkspace: async (_binding: unknown, _run: string, _task: string, callback: (...args: any[]) => Promise<unknown>) => use(callback, { conflictPaths: ["src/math.ts"] }),
      ports: { policies: { assertReadyToImplement: () => {
        expect(guardActive).toBe(true);
        if (!evidence.length) throw new Error("Independent Red required");
      } } }
    };
    development = new HostDevelopment(() => runtime as never, [{ id: "unit", command: "test", executable: process.execPath, args: ["--test"],
      method: "unit_test", levels: ["unit"], testNames: ["math"], testPaths: ["test/math.test.ts", "test/input.ts"], timeoutMs: 1000 }]);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("reads scoped source before Red and permits a new test, but blocks implementation until Red and freezes tests afterwards", async () => {
    expect(await development.readWorkspaceFile(binding, { path: "src/math.ts" })).toMatchObject({ exists: true, content: "original", sha256: digest("original") });
    expect(await development.readWorkspaceFile(binding, { path: "test/math.test.ts" })).toMatchObject({ exists: false, sha256: null });
    await development.writeWorkspaceFile(binding, { path: "test/math.test.ts", content: "failing test", expectedSha256: null });
    await expect(development.writeWorkspaceFile(binding, { path: "src/math.ts", content: "fixed", expectedSha256: digest("original") })).rejects.toThrow(/Red/);
    expect(await readFile(join(root, "src/math.ts"), "utf8")).toBe("original");
    evidence.push({ independent: "red" });
    await expect(development.writeWorkspaceFile(binding, { path: "test/math.test.ts", content: "weakened", expectedSha256: digest("failing test") })).rejects.toThrow(/frozen/);
    expect(await development.writeWorkspaceFile(binding, { path: "src/math.ts", content: "fixed", expectedSha256: digest("original") })).toMatchObject({ sha256: digest("fixed"), bytes: 5 });
    expect(await readFile(join(root, "src/math.ts"), "utf8")).toBe("fixed");
  });
  it.each(["../escape", "/etc/passwd", "src/../math.ts", "src/private/secret", "other/file", ".git/config", "src\\math.ts", "src/.git/config", "src/.bflow/state"])("refuses unowned or unsafe path %s for reads and writes", async path => {
    evidence.push({});
    await expect(development.readWorkspaceFile(binding, { path })).rejects.toThrow();
    await expect(development.writeWorkspaceFile(binding, { path, content: "bad", expectedSha256: null })).rejects.toThrow();
  });
  it("refuses case aliases of repository controls on every platform", async () => {
    evidence.push({});
    for (const path of ["src/.GIT/config", "src/.Bflow/state"]) {
      await mkdir(join(root, path.split("/").slice(0, -1).join("/")), { recursive: true });
      await writeFile(join(root, path), "control");
      await expect(development.readWorkspaceFile(binding, { path })).rejects.toThrow(/Unsafe/);
      await expect(development.writeWorkspaceFile(binding, { path, content: "bad", expectedSha256: digest("control") })).rejects.toThrow(/Unsafe/);
    }
  });
  it.runIf(process.platform === "darwin")("refuses case aliases of forbidden paths on case-insensitive macOS volumes", async () => {
    evidence.push({}); await mkdir(join(root, "src/private")); await writeFile(join(root, "src/private/secret"), "secret");
    await expect(development.readWorkspaceFile(binding, { path: "src/PRIVATE/secret" })).rejects.toThrow(/ownership/);
    await expect(development.writeWorkspaceFile(binding, { path: "src/PRIVATE/secret", content: "bad", expectedSha256: digest("secret") })).rejects.toThrow(/ownership/);
  });
  it.runIf(process.platform === "darwin").each([
    { denied: "src/secret", existing: "src/secret", alias: "src/ſecret" },
    { denied: "src/straße", existing: "src/straße", alias: "src/STRASSE" },
    { denied: "src/strasse", existing: "src/straße", alias: "src/STRAẞE" }
  ])("refuses Unicode case-fold aliases before reading, replacing or creating $alias", async ({ denied, existing, alias }) => {
    evidence.push({}); forbidden.push(denied);
    await expect(development.writeWorkspaceFile(binding, { path: alias, content: "unauthorized", expectedSha256: null })).rejects.toThrow(/ownership/);
    await writeFile(join(root, existing), "private");
    expect(await readFile(join(root, alias), "utf8")).toBe("private"); // actual APFS alias, no mocked platform
    await expect(development.readWorkspaceFile(binding, { path: alias })).rejects.toThrow(/ownership/);
    await expect(development.writeWorkspaceFile(binding, { path: alias, content: "unauthorized", expectedSha256: digest("private") })).rejects.toThrow(/ownership/);
    expect(await readFile(join(root, existing), "utf8")).toBe("private");
  });
  it.runIf(process.platform === "darwin")("refuses a ligature alias of nested .bflow and preserves accent-distinct allowed files", async () => {
    evidence.push({}); forbidden.push("src/resume");
    await writeFile(join(root, "src/.bflow"), "control");
    expect(await readFile(join(root, "src/.bﬂow"), "utf8")).toBe("control");
    await expect(development.readWorkspaceFile(binding, { path: "src/.bﬂow" })).rejects.toThrow(/Unsafe/);
    await expect(development.writeWorkspaceFile(binding, { path: "src/.bﬂow", content: "bad", expectedSha256: digest("control") })).rejects.toThrow(/Unsafe/);
    await writeFile(join(root, "src/résumé"), "allowed");
    expect(await development.readWorkspaceFile(binding, { path: "src/résumé" })).toMatchObject({ content: "allowed" });
  });
  it.runIf(process.platform === "darwin").each(["workspace", "native"])("freezes the same test inode through case aliases after Red for %s edits", async kind => {
    await writeFile(join(root, "test/math.test.ts"), "frozen"); evidence.push({ independent: "red" });
    expect(await readFile(join(root, "test/MATH.TEST.TS"), "utf8")).toBe("frozen");
    const edit = kind === "workspace"
      ? development.writeWorkspaceFile(binding, { path: "test/MATH.TEST.TS", content: "weakened", expectedSha256: digest("frozen") })
      : development.authorizeFileEdit(binding, { tool_name: "Write", tool_input: { file_path: join(root, "test/MATH.TEST.TS") } });
    await expect(edit).rejects.toThrow(/frozen/);
    expect(await readFile(join(root, "test/math.test.ts"), "utf8")).toBe("frozen");
  });
  it.runIf(process.platform === "darwin")("recognizes the configured test through its case alias before Red", async () => {
    await writeFile(join(root, "test/math.test.ts"), "test draft");
    await development.writeWorkspaceFile(binding, { path: "test/MATH.TEST.TS", content: "regression", expectedSha256: digest("test draft") });
    expect(await readFile(join(root, "test/math.test.ts"), "utf8")).toBe("regression");
  });
  it.runIf(process.platform === "darwin")("does not grant test-first edit permission for casing-key collisions that are distinct filesystem entries", async () => {
    await writeFile(join(root, "test/input.ts"), "configured test"); await writeFile(join(root, "test/ınput.ts"), "implementation");
    expect(await readFile(join(root, "test/input.ts"), "utf8")).toBe("configured test");
    await expect(development.writeWorkspaceFile(binding, { path: "test/ınput.ts", content: "unauthorized implementation", expectedSha256: digest("implementation") })).rejects.toThrow(/Red/);
    await expect(development.authorizeFileEdit(binding, { tool_name: "Write", tool_input: { file_path: join(root, "test/ınput.ts") } })).rejects.toThrow(/Red/);
    expect(await readFile(join(root, "test/ınput.ts"), "utf8")).toBe("implementation");
  });
  it("refuses stale digests, blind writes, missing parents and unknown arguments without overwriting", async () => {
    evidence.push({});
    for (const args of [ { path: "src/math.ts", content: "bad", expectedSha256: digest("old") },
      { path: "src/math.ts", content: "bad", expectedSha256: null }, { path: "src/math.ts", content: "bad" },
      { path: "src/new/file", content: "bad", expectedSha256: null }, { path: "src/math.ts", content: "bad", expectedSha256: digest("original"), shell: "anything" } ])
      await expect(development.writeWorkspaceFile(binding, args)).rejects.toThrow();
    expect(await readFile(join(root, "src/math.ts"), "utf8")).toBe("original");
  });
  it.each(["stale lease/fence", "Run is cancelled", "pending human decision"])("does no IO when the Runtime guard refuses %s", async reason => {
    denial = reason; evidence.push({});
    await expect(development.readWorkspaceFile(binding, { path: "src/math.ts" })).rejects.toThrow(reason);
    await expect(development.writeWorkspaceFile(binding, { path: "src/math.ts", content: "bad", expectedSha256: digest("original") })).rejects.toThrow(reason);
    expect(await readFile(join(root, "src/math.ts"), "utf8")).toBe("original");
  });
  it.each([false, true])("preserves a read-only binding for ordinary and conflict assignments (resolver=%s)", async resolving => {
    resolver = resolving; evidence.push({}); binding = { ...binding, readOnlyWorkspace: true };
    expect(await development.readWorkspaceFile(binding, { path: "src/math.ts" })).toMatchObject({ content: "original" });
    await expect(development.writeWorkspaceFile(binding, { path: "src/math.ts", content: "bad", expectedSha256: digest("original") })).rejects.toThrow(/read.only/i);
    expect(await readFile(join(root, "src/math.ts"), "utf8")).toBe("original");
  });
  it.each([false, true])("refuses native edit authorization for a read-only Developer binding (resolver=%s)", async resolving => {
    resolver = resolving; evidence.push({}); binding = { ...binding, readOnlyWorkspace: true };
    await expect(development.authorizeFileEdit(binding, { tool_name: "Write", tool_input: { file_path: join(root, "src/math.ts") } })).rejects.toThrow(/read.only/i);
    expect(await readFile(join(root, "src/math.ts"), "utf8")).toBe("original");
  });
  it("rejects symlink directories, symlink files, hardlinks and FIFOs without following them", async () => {
    evidence.push({});
    await symlink(join(root, "test"), join(root, "src/linked-dir"));
    await symlink(join(root, "src/math.ts"), join(root, "src/linked-file"));
    await writeFile(join(root, "test/linked-target"), "external");
    await link(join(root, "test/linked-target"), join(root, "src/hardlink"));
    await promisify(execFile)("mkfifo", [join(root, "src/pipe")]);
    for (const path of ["src/linked-dir/new", "src/linked-file", "src/hardlink", "src/pipe"]) {
      await expect(development.readWorkspaceFile(binding, { path })).rejects.toThrow();
      await expect(development.writeWorkspaceFile(binding, { path, content: "bad", expectedSha256: digest("external") })).rejects.toThrow();
    }
    expect(await readFile(join(root, "test/linked-target"), "utf8")).toBe("external");
  });
  it("bounds reads and writes and rejects invalid UTF8 rather than replacing bytes", async () => {
    evidence.push({});
    await writeFile(join(root, "src/big"), "x".repeat(131073));
    await writeFile(join(root, "src/binary"), Buffer.from([0xff]));
    for (const path of ["src/big", "src/binary"]) await expect(development.readWorkspaceFile(binding, { path })).rejects.toThrow();
    await expect(development.writeWorkspaceFile(binding, { path: "src/binary", content: "replacement",
      expectedSha256: createHash("sha256").update(Buffer.from([0xff])).digest("hex") })).rejects.toThrow();
    expect(await readFile(join(root, "src/binary"))).toEqual(Buffer.from([0xff]));
    for (const content of ["x".repeat(131073), "\ud800"]) await expect(development.writeWorkspaceFile(binding, { path: "src/math.ts", content, expectedSha256: digest("original") })).rejects.toThrow();
    expect(await readFile(join(root, "src/math.ts"), "utf8")).toBe("original");
  });
  it("round-trips a BOM and multibyte text at the byte limit and truncates without changing file mode", async () => {
    evidence.push({});
    const content = "\ufeff" + "é".repeat(65534) + "!";
    expect(Buffer.byteLength(content)).toBe(131072);
    await chmod(join(root, "src/math.ts"), 0o755);
    expect(await development.writeWorkspaceFile(binding, { path: "src/math.ts", content, expectedSha256: digest("original") })).toMatchObject({ bytes: 131072, sha256: digest(content), created: false });
    expect(await development.readWorkspaceFile(binding, { path: "src/math.ts" })).toMatchObject({ content, bytes: 131072, sha256: digest(content) });
    await expect(development.writeWorkspaceFile(binding, { path: "src/math.ts", content: content + "!", expectedSha256: digest(content) })).rejects.toThrow();
    expect(await readFile(join(root, "src/math.ts"), "utf8")).toBe(content);
    await development.writeWorkspaceFile(binding, { path: "src/math.ts", content: "", expectedSha256: digest(content) });
    expect(await readFile(join(root, "src/math.ts"), "utf8")).toBe("");
    expect((await stat(join(root, "src/math.ts"))).mode & 0o777).toBe(0o755);
  });
  it.each([{ runId: "other" }, { taskId: "other" }, { runId: "run", taskId: "other" }])("refuses an unrelated explicit assignment selector %j", async selector => {
    evidence.push({});
    await expect(development.readWorkspaceFile(binding, { path: "src/math.ts", ...selector })).rejects.toThrow(/assignment/);
    await expect(development.writeWorkspaceFile(binding, { path: "src/math.ts", content: "bad", expectedSha256: digest("original"), ...selector })).rejects.toThrow(/assignment/);
    expect(await readFile(join(root, "src/math.ts"), "utf8")).toBe("original");
  });
  it("refuses a symlink at the worktree root and directories at the file leaf", async () => {
    evidence.push({});
    await symlink(".", join(root, "alias"));
    const alias = { ...binding, cwd: join(root, "alias"), worktreePath: join(root, "alias") };
    for (const pane of [binding, alias]) {
      const path = pane === alias ? "src/math.ts" : "src";
      await expect(development.readWorkspaceFile(pane, { path })).rejects.toThrow();
      await expect(development.writeWorkspaceFile(pane, { path, content: "bad", expectedSha256: digest("original") })).rejects.toThrow();
    }
    expect(await readFile(join(root, "src/math.ts"), "utf8")).toBe("original");
  });
  it("allows conflict resolution only for the exact conflicted file with digest protection", async () => {
    resolver = true;
    await development.writeWorkspaceFile(binding, { path: "src/math.ts", content: "combined", expectedSha256: digest("original") });
    expect(await development.readWorkspaceFile(binding, { path: "src/math.ts" })).toMatchObject({ content: "combined" });
    await expect(development.readWorkspaceFile(binding, { path: "test/math.test.ts" })).rejects.toThrow(/conflict/);
    await expect(development.writeWorkspaceFile(binding, { path: "test/math.test.ts", content: "bad", expectedSha256: null })).rejects.toThrow(/conflict/);
  });
  it.each([false, true])("finishes the actual write before releasing the Runtime guard (resolver=%s)", async resolving => {
    resolver = resolving; evidence.push({});
    beforeGuardRelease = async () => { expect(await readFile(join(root, "src/math.ts"), "utf8")).toBe("inside guard"); };
    await development.writeWorkspaceFile(binding, { path: "src/math.ts", content: "inside guard", expectedSha256: digest("original") });
  });
});
