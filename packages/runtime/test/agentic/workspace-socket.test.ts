import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManifestSchema } from "@bflow/contracts";
import { openAgenticWorkspace } from "../../dist/agentic/workspace.js";

it("composes the named Herdr socket for a dynamic Developer's env-bearing pane", async () => {
  const root = await realpath(await mkdtemp("/tmp/bflow-workspace-socket-"));
  const sessionId = "workspace-socket", socketPath = join(root, "herdr.sock");
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const server = createServer(socket => {
    let input = "";
    socket.on("data", chunk => {
      input += String(chunk);
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!);
      requests.push(request);
      socket.end(JSON.stringify({ id: request.id, error: { code: "probe_refused", message: "fixture refuses before creation" } }) + "\n");
    });
  });
  let workspace: Awaited<ReturnType<typeof openAgenticWorkspace>> | undefined;
  try {
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "baseline"], { cwd: root });
    const taskTree = join(root, "task");
    execFileSync("git", ["worktree", "add", "--detach", taskTree], { cwd: root, stdio: "pipe" });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const binary = join(root, "herdr.mjs");
    await writeFile(binary, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==="--version") console.log("herdr fixture");
else if(args[0]==="api") console.log("protocol: 22\\nschema_version: 1");
else if(args[0]==="agent" && args[1]==="list") console.log(JSON.stringify({result:{type:"agent_list",agents:[]}}));
else if(args[0]==="worktree" && args[1]==="open") console.log(JSON.stringify({result:{type:"worktree_opened",workspace:{workspace_id:"w2",label:"developer",active_tab_id:"w2:t1"},tab:{tab_id:"w2:t1",workspace_id:"w2",label:"developer"},root_pane:{pane_id:"w2:p1",terminal_id:"term-dev",workspace_id:"w2",tab_id:"w2:t1",agent:null,agent_status:"idle",focused:false,revision:1},worktree:{path:${JSON.stringify(taskTree)},label:"developer",branch:null,is_linked_worktree:true,is_detached:true}}}));
else console.log(JSON.stringify({running:true,session:process.env.HERDR_SESSION,socket:${JSON.stringify(socketPath)}}));
`, { mode: 0o700 });
    const at = new Date().toISOString(), manifestDirectory = join(root, ".bflow/state/panes");
    await mkdir(manifestDirectory, { recursive: true });
    const manifest = SessionManifestSchema.parse({ schemaVersion: 2, sessionId, projectName: "fixture", workspaceRoot: root,
      herdrWorkspaceId: "w1", herdrTabId: "w1:t1", status: "up", conversationSessionId: "conversation", activeRunIds: [],
      panes: ["conversation", "coordinator"].map((role, index) => ({ schemaVersion: 2, bindingId: `binding-${role}`, sessionId,
        role, agentId: role, paneId: `w1:p${index + 1}`, workspaceId: "w1", tabId: "w1:t1", provider: "herdr", agentKind: "codex",
        cwd: root, isolationMode: "dedicated_pane", readOnlyWorkspace: true, permanent: true, transportState: "idle", boundAt: at })),
      attachTarget: { role: "conversation", paneId: "w1:p1" }, createdAt: at, updatedAt: at });
    await writeFile(join(manifestDirectory, `${sessionId}.manifest.json`), JSON.stringify(manifest));
    workspace = await openAgenticWorkspace({ repositoryPath: root, sessionId, herdrBinary: binary,
      roleCapabilities: {}, taskChecks: [], workflowChecks: [], deterministicGates: [],
      authenticateMessage: async () => false, authenticateResult: async () => false, authenticateEvidence: async () => false,
      authenticateGateResult: async () => false, authorizeHuman: async () => false,
      developerLaunches: { allocate: async () => ({ provider: "codex", argv: [], env: { BFLOW_TEST_TOKEN: "synthetic-secret" },
        launchId: "launch-developer", launchFingerprint: "a".repeat(64) }), release: async () => {},
        reachability: async () => { throw new Error("pane creation was refused before activation"); } } });
    const result = await workspace.runtime.ports.panes.allocateDeveloper({ taskId: "task", runId: "run", worktreePath: taskTree,
      branchName: "main", agentName: "dev-test" });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("probe_refused") } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "pane.split", params: { env: { BFLOW_TEST_TOKEN: "synthetic-secret" } } });
  } finally {
    await workspace?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
