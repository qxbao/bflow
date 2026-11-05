import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DirectorNdjsonSupervisor, agyDirectorProtocol, waitAndWakeDirector } from "../src/director-wake-agy.js";

const roots: string[] = [];
const supervisors: DirectorNdjsonSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map(item => item.stop().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bflow-agy-director-")); roots.push(root);
  const executable = join(root, "fake-agy.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = process.env.FAKE_LOG;
for await (const line of createInterface({ input: process.stdin })) {
  const event = JSON.parse(line);
  appendFileSync(log, JSON.stringify(event) + '\\n');
  const content = event.message.content;
  if (content === 'CRASH') process.exit(7);
  process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: '123e4567-e89b-42d3-a456-426614174000', response: content } }) + '\\n');
}
`); await chmod(executable, 0o700);
  return { root, executable, log: join(root, "prompts.jsonl") };
}

async function lines(path: string): Promise<unknown[]> {
  try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(x => JSON.parse(x)); }
  catch { return []; }
}

describe("Agy Director supervised NDJSON", () => {
  it("waits outside the model and repeats the original cursor until one event", async () => {
    const cursor = "m4.i0.b2.rZmVlZDox";
    const empty = { cursor, timedOut: true, messages: [], issues: [], runtimeEvents: [], mailbox: [] };
    const event = { ...empty, timedOut: false, messages: [{ schemaVersion: 1, seq: 5,
      messageId: "message-5", author: "user", channel: "web", text: "Làm tiếp", at: "2026-11-05T00:00:00.000Z" }] };
    const seen: string[] = []; const wakes: string[] = []; let count = 0;
    expect(await waitAndWakeDirector({ cursor, wait: async value => { seen.push(value); return count++ < 2 ? empty : event; },
      wake: async message => { wakes.push(message); } })).toBe("woken");
    expect(seen).toEqual([cursor, cursor, cursor]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(cursor);
  });
  it("runs the initial turn, stays idle, and sends exactly one wake for one event", async () => {
    const f = await fixture(); const transcript: string[] = [];
    const driver = new DirectorNdjsonSupervisor({ provider: "agy", executable: f.executable,
      args: ["--input-format", "stream-json", "--output-format", "stream-json"], cwd: f.root,
      env: { ...process.env, FAKE_LOG: f.log, BFLOW_DIRECTOR_TOKEN: "private-token" },
      stateRoot: f.root, sessionName: "test", initialPrompt: "/bflow-start",
      protocol: agyDirectorProtocol, onTranscript: line => transcript.push(line) });
    supervisors.push(driver);
    await driver.start();
    expect(driver.status()).toBe("idle");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await lines(f.log)).toHaveLength(1);
    await driver.sendWake("BFLOW_DIRECTOR_WAKE cursor-1");
    expect((await lines(f.log))).toHaveLength(2);
    expect(JSON.stringify(await lines(f.log))).not.toContain("private-token");
    expect(transcript.join("\n")).not.toContain("private-token");
  });

  it("rejects a duplicate launch while the first process owns the session", async () => {
    const f = await fixture();
    const options = { provider: "agy", executable: f.executable, args: [], cwd: f.root,
      env: { ...process.env, FAKE_LOG: f.log }, stateRoot: f.root, sessionName: "test",
      initialPrompt: "/bflow-start", protocol: agyDirectorProtocol } as const;
    const first = new DirectorNdjsonSupervisor(options); supervisors.push(first); await first.start();
    const second = new DirectorNdjsonSupervisor(options); supervisors.push(second);
    await expect(second.start()).rejects.toThrow(/already running/i);
    expect(await lines(f.log)).toHaveLength(1);
  });

  it("serializes two wake calls in one process", async () => {
    const f = await fixture();
    const driver = new DirectorNdjsonSupervisor({ provider: "agy", executable: f.executable, args: [], cwd: f.root,
      env: { ...process.env, FAKE_LOG: f.log }, stateRoot: f.root, sessionName: "test",
      initialPrompt: "/bflow-start", protocol: agyDirectorProtocol });
    supervisors.push(driver); await driver.start();
    const first = driver.sendWake("first");
    await expect(driver.sendWake("second")).rejects.toThrow(/sending/);
    await first;
    expect(await lines(f.log)).toHaveLength(2);
  });

  it("marks a crash during wake delivery uncertain and refuses automatic resend", async () => {
    const f = await fixture();
    const options = { provider: "agy", executable: f.executable, args: [], cwd: f.root,
      env: { ...process.env, FAKE_LOG: f.log }, stateRoot: f.root, sessionName: "test",
      initialPrompt: "/bflow-start", protocol: agyDirectorProtocol } as const;
    const first = new DirectorNdjsonSupervisor(options); supervisors.push(first); await first.start();
    await expect(first.sendWake("CRASH")).rejects.toThrow(/uncertain/i);
    expect(first.status()).toBe("uncertain");
    const second = new DirectorNdjsonSupervisor(options); supervisors.push(second);
    await expect(second.start()).rejects.toThrow(/uncertain/i);
    expect(await lines(f.log)).toHaveLength(2);
  });
});
