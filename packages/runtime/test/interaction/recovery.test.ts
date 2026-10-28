import { mkdtemp, rm, readdir, readFile, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { WebInteractionAuthority } from "../../src/interaction/authority.js";
import { WebOperationStore } from "../../src/interaction/operation-store.js";
import { fixture, now } from "./web-command-fixtures.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "web-operations-")); dirs.push(directory);
  const f = fixture(), authority = new WebInteractionAuthority("project-1", "host-1", () => now);
  authority.registerOwnerKey(f.registration);
  const options = { directory, repository: "/repo", sessionId: "host-1", projectId: "project-1" };
  return { ...f, directory, authority, options, store: new WebOperationStore(options) };
}
it("persists checksummed intent and consumes nonce before allowing an effect", async () => {
  const f = await setup(), proof = f.proof();
  const operation = await f.store.accept(f.command, proof, f.authority);
  expect(operation.state).toBe("accepted");
  const files = await readdir(f.directory);
  expect(files).toHaveLength(1);
  expect(JSON.parse(await readFile(join(f.directory, files[0]!), "utf8"))).toMatchObject({ version: 2, kind: "web-interaction" });
  const other = { ...f.command, commandId: randomUUID() };
  await expect(f.store.accept(other, f.proof(other, { nonce: proof.nonce }), f.authority)).rejects.toThrow(/nonce/);
  expect(await f.store.begin("local-user-1", f.command.commandId)).toBe(true);
  expect(await f.store.begin("local-user-1", f.command.commandId)).toBe(false);
});
it("replays identical intent/result but conflicts on changed command", async () => {
  const f = await setup();
  const accepted = await f.store.accept(f.command, f.proof(), f.authority);
  expect(await f.store.accept(f.command, f.proof(), f.authority)).toEqual(accepted);
  await expect(f.store.accept({ ...f.command, title: "Another title" }, f.proof({ ...f.command, title: "Another title" }), f.authority)).rejects.toThrow(/conflict/);
  await f.store.begin("local-user-1", f.command.commandId);
  const result = { ...accepted, state: "applied", result: { kind: "intake", intakeId: "intake-1" } };
  await f.store.settle("local-user-1", f.command.commandId, result);
  expect(await f.store.accept(f.command, f.proof(), f.authority)).toEqual(result);
  expect(await new WebOperationStore(f.options).read("local-user-1", f.command.commandId)).toEqual(result);
  await expect(f.store.settle("local-user-1", f.command.commandId, { ...result, result: { kind: "intake", intakeId: "different" } })).rejects.toThrow(/conflict/);
});
it.each(["intent", "dispatch", "external_effect_without_ack"])("restart after %s is uncertain and cannot resend", async stage => {
  const f = await setup();
  await f.store.accept(f.command, f.proof(), f.authority);
  if (stage !== "intent") await f.store.begin("local-user-1", f.command.commandId);
  const recovered = new WebOperationStore(f.options);
  expect(await recovered.read("local-user-1", f.command.commandId)).toMatchObject({ state: "reconciliation_required" });
  expect(await recovered.begin("local-user-1", f.command.commandId)).toBe(false);
  expect(await recovered.accept(f.command, f.proof(), f.authority)).toMatchObject({ state: "reconciliation_required" });
});
it("historical reads ignore live proof TTL but new submit rejects expired proof", async () => {
  const f = await setup(), proof = f.proof();
  await f.store.accept(f.command, proof, f.authority);
  const expired = new WebInteractionAuthority("project-1", "host-1", () => now + 60001);
  expired.registerOwnerKey(f.registration);
  const recovered = new WebOperationStore(f.options);
  expect(await recovered.read("local-user-1", f.command.commandId)).toMatchObject({ state: "reconciliation_required" });
  await expect(recovered.accept(f.command, proof, expired)).rejects.toThrow();
});
it("scopes reads to principal, original repository and host session", async () => {
  const f = await setup(); await f.store.accept(f.command, f.proof(), f.authority);
  expect(await f.store.read("other-user", f.command.commandId)).toBeUndefined();
  for (const changed of [{ repository: "/other" }, { sessionId: "other" }]) {
    await expect(new WebOperationStore({ ...f.options, ...changed }).read("local-user-1", f.command.commandId)).rejects.toThrow();
  }
  expect(await new WebOperationStore({ ...f.options, projectId: "other" }).read("local-user-1", f.command.commandId)).toBeUndefined();
});
it("fails closed on unsafe files, symlinks and corruption", async () => {
  const f = await setup(); await f.store.accept(f.command, f.proof(), f.authority);
  const file = join(f.directory, (await readdir(f.directory))[0]!);
  await chmod(file, 0o644);
  await expect(f.store.read("local-user-1", f.command.commandId)).rejects.toThrow();
  await chmod(file, 0o600); await writeFile(file, "{}");
  await expect(f.store.read("local-user-1", f.command.commandId)).rejects.toThrow();
  await rm(file); await symlink("/dev/zero", file);
  await expect(f.store.read("local-user-1", f.command.commandId)).rejects.toThrow();
});
it("does not create intent for invalid authority or unsafe directories", async () => {
  const f = await setup();
  await expect(f.store.accept(f.command, { ...f.proof(), authenticatedUser: true }, f.authority)).rejects.toThrow();
  expect(await readdir(f.directory)).toEqual([]);
  await chmod(f.directory, 0o755);
  await expect(f.store.accept(f.command, f.proof(), f.authority)).rejects.toThrow();
});
it("serializes simultaneous acceptance and permits only one dispatch claim", async () => {
  const f = await setup();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.store.accept(f.command, f.proof(), f.authority)));
  expect(results.every(value => value.operationId === f.command.commandId)).toBe(true);
  const claims = await Promise.all(Array.from({ length: 8 }, () => f.store.begin("local-user-1", f.command.commandId)));
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await readdir(f.directory)).toHaveLength(2);
});
it("never settles using a corrupt dispatch marker as authority", async () => {
  const f = await setup(); const accepted = await f.store.accept(f.command, f.proof(), f.authority);
  await f.store.begin("local-user-1", f.command.commandId);
  const marker = (await readdir(f.directory)).find(name => name.endsWith(".running.json"))!;
  await writeFile(join(f.directory, marker), "{}");
  await expect(f.store.settle("local-user-1", f.command.commandId, { ...accepted, state: "applied", result: { kind: "intake", intakeId: "intake-1" } })).rejects.toThrow();
});
it("allows observation-proven resolution after explicitly recording uncertain delivery", async () => {
  const f = await setup(), accepted = await f.store.accept(f.command, f.proof(), f.authority);
  await f.store.begin("local-user-1", f.command.commandId);
  await f.store.settle("local-user-1", f.command.commandId, { ...accepted, state: "reconciliation_required" });
  expect(await f.store.read("local-user-1", f.command.commandId)).toMatchObject({ state: "reconciliation_required" });
  expect(await f.store.begin("local-user-1", f.command.commandId)).toBe(false);
  const resolved = { ...accepted, state: "applied", result: { kind: "intake", intakeId: "intake-1" } };
  const recovered = new WebOperationStore(f.options);
  await recovered.settle("local-user-1", f.command.commandId, resolved);
  expect(await recovered.read("local-user-1", f.command.commandId)).toEqual(resolved);
});
