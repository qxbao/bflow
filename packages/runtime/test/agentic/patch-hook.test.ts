import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([false, true])("checks all native patch targets through the existing scoped edit guard (forbidden target: %s)", async forbidden => {
  const root = await mkdtemp("/tmp/bflow-patch-hook-");
  const path = join(root, "role.json"), socketPath = join(root, "host.sock");
  const observed: { tool_name: string; tool_input: { file_path: string }; session_id: string }[] = [];
  const server = createServer(socket => {
    let input = "";
    socket.on("data", chunk => {
      input += String(chunk); if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!);
      expect(request.method).toBe("tool_guard");
      expect(request.token).toBe("synthetic-token");
      expect(request.params.paneId).toBe("developer-pane");
      const hook = request.params.hook; observed.push(hook);
      const permitted = hook.tool_name === "Write" && ["test/owned.test.ts", "src/owned.ts"].includes(hook.tool_input.file_path);
      socket.end(JSON.stringify(permitted ? { ok: true, value: { permitted: true } } : { ok: false, error: "Scoped edit denied" }) + "\n");
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    await writeFile(path, JSON.stringify({ socketPath, token: "synthetic-token", role: "developer", provider: "codex",
      herdrBinary: "herdr", sessionId: "test-session" }), { mode: 0o600 });
    const patch = `*** Begin Patch\n*** Update File: test/owned.test.ts\n@@\n-old\n+new\n*** Update File: ${forbidden ? "outside.ts" : "src/owned.ts"}\n@@\n-old\n+new\n*** End Patch`;
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url)), "hook", path, "PreToolUse"],
        { env: { ...process.env, HERDR_PANE_ID: "developer-pane" }, timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin!.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "native-session", tool_name: "apply_patch", tool_input: { command: patch } }));
    });
    expect(observed.map(hook => hook.tool_name)).toEqual(["Write", "Write"]);
    expect(observed.map(hook => hook.tool_input.file_path)).toEqual(["test/owned.test.ts", forbidden ? "outside.ts" : "src/owned.ts"]);
    expect(observed.every(hook => hook.session_id === "native-session")).toBe(true);
    if (forbidden) expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    else expect(stdout).toBe("");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
