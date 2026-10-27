import { mkdtemp, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readExistingAgenticTelemetry } from "../../src/agentic/host-controller.js";
import { buildWorkflowTelemetry } from "../../src/telemetry/report.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("does not create host configuration, locks, sockets or runtime stores when the host is absent", async () => {
  const root = await mkdtemp("/tmp/bflow-telemetry-"); roots.push(root);
  const before = await readdir(root);
  const report = await readExistingAgenticTelemetry({ repositoryPath: root, sessionId: "session", runId: "run-1" });
  expect(report.source).toBe("agentic");
  expect(report.coverage.quality).toBe("unavailable");
  expect(report.coverage.diagnostics).toContain("host_unavailable");
  expect(await readdir(root)).toEqual(before);
  expect(JSON.stringify(report)).not.toContain(join(root, "host"));
});
it("uses only the existing authenticated report RPC and rejects a foreign report", async () => {
  const root = await mkdtemp("/tmp/bflow-telemetry-"); roots.push(root);
  const directory = join(root, ".bflow/state/host/session"); await mkdir(directory, { recursive: true, mode: 0o700 });
  const socketPath = join(root, "control.sock");
  await writeFile(join(directory, "host.json"), JSON.stringify({ repositoryPath: root, sessionId: "session", directory, socketPath, token: "test-token" }), { mode: 0o600 });
  const calls: string[] = []; let foreign = false;
  const server = createServer(socket => {
    socket.once("data", bytes => {
      const request = JSON.parse(String(bytes)); calls.push(request.method);
      expect(request.token).toBe("test-token");
      const report = buildWorkflowTelemetry({ runId: foreign ? "foreign" : request.params.runId, asOf: request.params.asOf,
        source: "agentic", events: [], taskIds: [], complete: false });
      socket.end(JSON.stringify({ ok: true, value: report }) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    const report = await readExistingAgenticTelemetry({ repositoryPath: root, sessionId: "session", runId: "run-1" });
    expect(report.coverage.diagnostics).not.toContain("host_unavailable");
    foreign = true;
    const rejected = await readExistingAgenticTelemetry({ repositoryPath: root, sessionId: "session", runId: "run-1" });
    expect(rejected.coverage.diagnostics).toContain("host_unavailable");
    expect(calls).toEqual(["telemetry_report", "telemetry_report"]);
    expect(await readdir(directory)).toEqual(["host.json"]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
