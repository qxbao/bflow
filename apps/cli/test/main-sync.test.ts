import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvironmentDoctorReportSchema } from "@bflow/contracts";
import { main } from "../src/bin.js";
import { formatCommandSuccess } from "../src/formatters.js";
import { HighLevelEnvelopeSchema } from "../src/high-level/envelope.js";
import { createDefaultHighLevelServices } from "../src/high-level/services.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (text: string) => { out.push(text); }, stderr: (text: string) => { err.push(text); } } };
}

describe("main integration with upstream CLI commands", () => {
  let previousExitCode: typeof process.exitCode;
  beforeEach(() => { previousExitCode = process.exitCode; });
  afterEach(() => { process.exitCode = previousExitCode; });

  it("keeps a high-level operational failure envelope on stdout", async () => {
    const streams = capture();
    const result = await main(["tool", "status", "--tool", "bflow-test-unknown-tool", "--json"], {
      io: streams.io,
      highLevelServices: await createDefaultHighLevelServices()
    });
    expect(result.exitCode).toBe(4);
    expect(result.ok).toBe(false);
    expect(streams.out).toHaveLength(1);
    expect(streams.err).toEqual([]);
    const envelope = HighLevelEnvelopeSchema.parse(JSON.parse(streams.out[0]!));
    expect(envelope.command).toBe("tool.status");
    expect(envelope.result.error?.code).toBe("not_found");
  });

  it("passes the presentation JSON setting to the upstream command runner", async () => {
    const streams = capture();
    const result = await main(["tool", "status", "--tool", "bflow-test-unknown-tool"], {
      io: streams.io,
      presentation: { json: true },
      highLevelServices: await createDefaultHighLevelServices()
    });
    expect(result.exitCode).toBe(4);
    expect(streams.out).toHaveLength(1);
    expect(streams.err).toEqual([]);
    expect(HighLevelEnvelopeSchema.parse(JSON.parse(streams.out[0]!)).ok).toBe(false);
  });

  it("keeps legacy usage errors on stderr without duplicating stdout", async () => {
    const streams = capture();
    const result = await main(["run", "--json"], { io: streams.io });
    expect(result.exitCode).toBe(2);
    expect(streams.out).toEqual([]);
    expect(streams.err).toHaveLength(1);
    expect(JSON.parse(streams.err[0]!)).toMatchObject({ ok: false, command: "run" });
  });

  it("retains upstream doctor groups alongside the friendly diagnostic summary", () => {
    const report = EnvironmentDoctorReportSchema.parse({
      schemaVersion: 2,
      workspaceRoot: "/example/repository",
      healthy: false,
      checkedAt: "2026-10-17T00:00:00.000Z",
      checks: [{ checkId: "provider-codex", name: "Codex", status: "failed", message: "Login required" }],
      metadata: { groups: { Providers: [{ component: "codex", status: "failed", reason: "Login required; token=SYNTHETIC_SECRET", repair_command: "codex login" }] } }
    });
    const human = formatCommandSuccess("doctor", report, false);
    expect(human).toContain("✗ [CẦN XỬ LÝ] Phát hiện vấn đề trong môi trường");
    expect(human).toContain("[LỖI] Codex: Login required");
    expect(human).toContain("Nhóm thành phần:");
    expect(human).toContain("[Providers]");
    expect(human).toContain("Sửa chữa: codex login");
    expect(human).not.toContain("SYNTHETIC_SECRET");
    expect(JSON.parse(formatCommandSuccess("doctor", report, true)).data).toEqual(report);
  });
});
