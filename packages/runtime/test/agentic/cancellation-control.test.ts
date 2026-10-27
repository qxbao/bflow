import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileExistingAgenticCancellation } from "../../src/agentic/host-controller.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function endpoint(answer: (request: any) => unknown) {
  const root = await mkdtemp(join(tmpdir(), "bflow-cancel-control-")), directory = join(root, ".bflow/state/host/session-1"), socketPath = join(root, "host.sock");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const requests: any[] = [];
  const server = createServer(socket => { let input = ""; socket.on("data", chunk => { input += chunk;
    if (!input.includes("\n")) return;
    const request = JSON.parse(input.split("\n")[0]!); requests.push(request); socket.end(JSON.stringify(answer(request)) + "\n");
  }); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await writeFile(join(directory, "host.json"), JSON.stringify({ repositoryPath: root, sessionId: "session-1", directory, socketPath, token: "root-control-token" }), { mode: 0o600 });
  return { root, directory, requests, options: { repositoryPath: root, sessionId: "session-1", runId: "run-1" } };
}
describe("connect-only cancellation administration", () => {
  it("uses only the pinned host root control token and never invokes activation or a scheduler tick", async () => {
    const f = await endpoint(() => ({ ok: true, value: { runId: "run-1", fullyStopped: false, blockers: ["process alive"], retainedWorktrees: ["/tmp/keep"] } }));
    const before = await readdir(f.directory);
    expect(await reconcileExistingAgenticCancellation(f.options)).toMatchObject({ fullyStopped: false, blockers: ["process alive"] });
    expect(f.requests).toEqual([{ token: "root-control-token", method: "reconcile_cancellation", params: { runId: "run-1" } }]);
    expect(await readdir(f.directory)).toEqual(before);
  });
  it("does not fall back to another host or legacy runtime when the running binary lacks the operation", async () => {
    const f = await endpoint(() => ({ ok: false, error: "Unknown host operation" }));
    await expect(reconcileExistingAgenticCancellation(f.options)).rejects.toThrow("Unknown host operation");
    expect(f.requests).toHaveLength(1);
  });
  it("rejects foreign response or configuration before trusting a recovery outcome", async () => {
    const f = await endpoint(() => ({ ok: true, value: { runId: "foreign", fullyStopped: true, blockers: [], retainedWorktrees: [] } }));
    await expect(reconcileExistingAgenticCancellation(f.options)).rejects.toThrow("Foreign cancellation report");
    await expect(reconcileExistingAgenticCancellation({ ...f.options, sessionId: "../foreign" })).rejects.toThrow("Invalid host");
    expect(f.requests).toHaveLength(1);
  });
});
