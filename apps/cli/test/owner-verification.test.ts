import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as runtime from "@bflow/runtime";
import { readOwnerVerification } from "../src/agentic-host.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const behavioralCommand = {
  id: "unit", command: "owner:test-unit", executable: process.execPath, args: ["--test", "--test-reporter=tap", "test/bucket.test.cjs"],
  method: "unit_test", levels: ["unit"], testNames: ["ac-1: concurrent takes grant one token"], testPaths: ["test/bucket.test.cjs"], timeoutMs: 15_000
};
const mutation = { id: "bucket-lock", commandId: "unit", file: "source.cjs", find: "this.lock.runExclusive(", replace: "((fn) => fn())(",
  expectFailingTests: ["ac-1: concurrent takes grant one token"] };

async function repositoryWith(config: unknown | undefined): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-owner-verification-")));
  roots.push(root);
  if (config !== undefined) {
    await mkdir(join(root, ".bflow"), { recursive: true });
    await writeFile(join(root, ".bflow/verification.json"), JSON.stringify(config));
  }
  return root;
}

describe("readOwnerVerification", () => {
  it("returns no owner commands or mutation checks when the file is absent", async () => {
    expect(await readOwnerVerification(await repositoryWith(undefined), runtime)).toEqual({ behavioralCommands: [], mutationChecks: [] });
  });

  it("accepts optional mutationChecks beside the behavioral commands", async () => {
    const value = await readOwnerVerification(await repositoryWith({ schemaVersion: 1, behavioralCommands: [behavioralCommand], mutationChecks: [mutation] }), runtime);
    expect(value.behavioralCommands.map(command => command.id)).toEqual(["unit"]);
    expect(value.mutationChecks).toEqual([mutation]);
  });

  it("keeps mutationChecks optional and rejects other unknown keys", async () => {
    expect((await readOwnerVerification(await repositoryWith({ schemaVersion: 1, behavioralCommands: [behavioralCommand] }), runtime)).mutationChecks).toEqual([]);
    await expect(readOwnerVerification(await repositoryWith({ schemaVersion: 1, behavioralCommands: [behavioralCommand], extra: true }), runtime))
      .rejects.toThrow(/Invalid owner verification configuration/);
  });

  it("rejects a mutation check that names an unconfigured behavioral command", async () => {
    await expect(readOwnerVerification(await repositoryWith({ schemaVersion: 1, behavioralCommands: [behavioralCommand], mutationChecks: [{ ...mutation, commandId: "missing" }] }), runtime))
      .rejects.toThrow(/unknown behavioral command/);
  });
});
