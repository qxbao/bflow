import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLaunchJournal, LaunchJournalCorruptionError } from "../../src/platform/launch-journal.js";
import type { LaunchJournalEntry } from "../../src/platform/ports.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function intent(launchId: string, recordedAt = "2026-10-18T10:00:00.000Z"): LaunchJournalEntry {
  return {
    kind: "intent",
    launchId,
    role: "developer",
    provider: "claude",
    environmentId: "env-developer-1",
    configFingerprint: DIGEST_A,
    launchFingerprint: DIGEST_B,
    generation: 1,
    recordedAt
  };
}

describe("FileLaunchJournal", () => {
  let baseDir: string;
  let journalDir: string;
  let journalPath: string;

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-launch-journal-")));
    journalDir = join(baseDir, "platform");
    journalPath = join(journalDir, "launches.jsonl");
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("returns an empty replay when the journal does not exist yet", async () => {
    const journal = new FileLaunchJournal(journalPath);
    await expect(journal.entries()).resolves.toEqual([]);
  });

  it("replays appended entries in write order", async () => {
    const journal = new FileLaunchJournal(journalPath);
    const entries: LaunchJournalEntry[] = [
      intent("launch-1"),
      { kind: "attested", launchId: "launch-1", paneId: "pane-1", receiptId: "receipt-1", recordedAt: "2026-10-18T10:00:01.000Z" },
      { kind: "activated", launchId: "launch-1", status: "ready", validUntil: "2026-10-18T10:05:00.000Z", recordedAt: "2026-10-18T10:00:02.000Z" },
      { kind: "failed", launchId: "launch-2", code: "auth_expired", message: "re-authenticate", recordedAt: "2026-10-18T10:00:03.000Z" },
      { kind: "released", launchId: "launch-1", recordedAt: "2026-10-18T10:00:04.000Z" }
    ];
    for (const entry of entries) {
      await journal.append(entry);
    }
    await expect(journal.entries()).resolves.toEqual(entries);
  });

  it("creates the journal with mode 0600 inside a 0700 directory", async () => {
    const journal = new FileLaunchJournal(journalPath);
    await journal.append(intent("launch-1"));

    expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
    expect((await stat(journalDir)).mode & 0o777).toBe(0o700);
  });

  it("reports a truncated trailing line as corruption instead of skipping it", async () => {
    await mkdir(journalDir, { recursive: true, mode: 0o700 });
    const good = `${JSON.stringify(intent("launch-1"))}\n`;
    await writeFile(journalPath, `${good}{"kind":"intent","launchId":"lau`, { mode: 0o600 });

    const journal = new FileLaunchJournal(journalPath);
    const error = await journal.entries().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LaunchJournalCorruptionError);
    expect((error as LaunchJournalCorruptionError).code).toBe("corruption");
  });

  it("reports a malformed or schema-invalid complete line as corruption", async () => {
    await mkdir(journalDir, { recursive: true, mode: 0o700 });
    await writeFile(journalPath, "{not json}\n", { mode: 0o600 });
    await expect(new FileLaunchJournal(journalPath).entries()).rejects.toBeInstanceOf(LaunchJournalCorruptionError);

    const extraKey = { ...intent("launch-1"), unexpected: true };
    await writeFile(journalPath, `${JSON.stringify(extraKey)}\n`, { mode: 0o600 });
    await expect(new FileLaunchJournal(journalPath).entries()).rejects.toBeInstanceOf(LaunchJournalCorruptionError);
  });

  it("rejects entries that fail the strict schema before writing anything", async () => {
    const journal = new FileLaunchJournal(journalPath);
    const invalid = { ...intent("launch-1"), configFingerprint: "not-a-digest" } as unknown as LaunchJournalEntry;
    await expect(journal.append(invalid)).rejects.toThrow(/schema validation/);
    await expect(journal.entries()).resolves.toEqual([]);
  });

  it("keeps every concurrent append as one valid line", async () => {
    const journal = new FileLaunchJournal(journalPath);
    const writes = Array.from({ length: 25 }, (_, index) => journal.append(intent(`launch-${index}`)));
    await Promise.all(writes);

    const raw = await readFile(journalPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(25);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const replayed = await journal.entries();
    expect(replayed.map((entry) => entry.launchId)).toEqual(
      Array.from({ length: 25 }, (_, index) => `launch-${index}`)
    );
  });

  it("keeps the intent durable across a new instance (restart)", async () => {
    const first = new FileLaunchJournal(journalPath);
    await first.append(intent("launch-restart"));

    const restarted = new FileLaunchJournal(journalPath);
    const replayed = await restarted.entries();
    expect(replayed).toEqual([intent("launch-restart")]);
  });

  it("never deletes an existing journal when replay fails", async () => {
    await mkdir(journalDir, { recursive: true, mode: 0o700 });
    await writeFile(journalPath, "garbage", { mode: 0o600 });
    await expect(new FileLaunchJournal(journalPath).entries()).rejects.toBeInstanceOf(LaunchJournalCorruptionError);
    expect(await readFile(journalPath, "utf8")).toBe("garbage");
  });

  it("refuses a journal directory reached through a symlink", async () => {
    const realDir = join(baseDir, "real");
    await mkdir(realDir, { mode: 0o700 });
    const linkDir = join(baseDir, "link");
    await symlink(realDir, linkDir);

    const journal = new FileLaunchJournal(join(linkDir, "launches.jsonl"));
    await expect(journal.append(intent("launch-1"))).rejects.toThrow(/symlink/);
  });

  it("refuses a journal file that is a symlink", async () => {
    await mkdir(journalDir, { recursive: true, mode: 0o700 });
    const target = join(baseDir, "target.jsonl");
    await writeFile(target, "", { mode: 0o600 });
    await symlink(target, journalPath);

    await expect(new FileLaunchJournal(journalPath).append(intent("launch-1"))).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("");
  });

  it("appends after an existing journal without rewriting earlier lines", async () => {
    const first = new FileLaunchJournal(journalPath);
    await first.append(intent("launch-1"));
    await new FileLaunchJournal(journalPath).append(intent("launch-2"));
    const replayed = await first.entries();
    expect(replayed.map((entry) => entry.launchId)).toEqual(["launch-1", "launch-2"]);
  });
});
