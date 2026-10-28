import { expect, it } from "vitest";
import { WebInteractionAuthority } from "../../src/interaction/authority.js";
import { fixture, now } from "./web-command-fixtures.js";

it("authenticates only an owner-registered Ed25519 issuer with exact command scope", () => {
  const f = fixture(), authority = new WebInteractionAuthority("project-1", "host-1", () => now);
  expect(() => authority.verify(f.command, f.proof())).toThrow();
  authority.registerOwnerKey(f.registration);
  expect(authority.verify(f.command, f.proof())).toMatchObject({ principalId: "local-user-1", commandId: f.command.commandId });
});
it.each([
  { projectId: "other" }, { hostSessionId: "other" }, { principalId: "model-user" }, { keyId: "other" },
  { issuerId: "other" }, { capability: "coordinator" }, { authenticatedUser: true },
  { issuedAt: new Date(now + 5001).toISOString(), expiresAt: new Date(now + 60000).toISOString() },
  { issuedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now).toISOString() },
])("rejects signed wrong authority/lifetime/unknown fields: %j", overrides => {
  const f = fixture(), authority = new WebInteractionAuthority("project-1", "host-1", () => now);
  authority.registerOwnerKey(f.registration);
  expect(() => authority.verify(f.command, f.proof(f.command, overrides))).toThrow();
});
it("rejects modified command, signature and caller-supplied registration data", () => {
  const f = fixture(), authority = new WebInteractionAuthority("project-1", "host-1", () => now);
  authority.registerOwnerKey(f.registration);
  const proof = f.proof();
  expect(() => authority.verify({ ...f.command, title: "Different report" }, proof)).toThrow();
  expect(() => authority.verify(f.command, { ...proof, signature: { algorithm: "ed25519", value: "A".repeat(86) + "==" } })).toThrow();
  expect(() => authority.registerOwnerKey({ ...f.registration, roleToken: "role" })).toThrow();
});
it("requires re-registration after restart and supports explicit revocation", () => {
  const f = fixture(), authority = new WebInteractionAuthority("project-1", "host-1", () => now);
  authority.registerOwnerKey(f.registration);
  authority.revokeOwnerKey(f.registration.issuerId, f.registration.keyId);
  expect(() => authority.verify(f.command, f.proof())).toThrow();
  expect(() => new WebInteractionAuthority("project-1", "host-1", () => now).verify(f.command, f.proof())).toThrow();
});

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAgenticHost, registerUserInteractionIssuer } from "../../dist/agentic/host-controller.js";
import { openUserInteractionClient, interactionProjectId } from "../../src/interaction/client.js";
import { callHost } from "../../src/agentic/host-protocol.js";
it("registers a scoped user credential on actual owner IPC and rejects role/lifecycle use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-issuer-host-"));
  const herdrBinary = join(directory, "herdr-fixture.mjs");
  await writeFile(herdrBinary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:false}) + "\\n");\n', { mode: 0o700 });
  const controller = await ensureAgenticHost({ repositoryPath: directory, sessionId: "host-1", herdrBinary });
  try {
    const f = fixture(), projectId = interactionProjectId(directory);
    const registered = await registerUserInteractionIssuer({ repositoryPath: directory, sessionId: "host-1" },
      { ...f.registration, projectId, principalId: `local-user-${process.getuid?.() ?? "local"}` });
    expect(registered.credential).toEqual(expect.any(String));
    const client = await openUserInteractionClient({ repositoryPath: directory, sessionId: "host-1",
      interaction: { credential: registered.credential, sign: command => f.proof(command, { projectId, principalId: registered.principalId,
        issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }) } });
    const command = { ...f.command, projectId };
    expect(await client.execute(command)).toMatchObject({ ok: false, error: { code: "transport_unavailable" } });
    await expect(callHost(registered.socketPath, registered.credential, "prepare", {})).rejects.toThrow();
    await expect(callHost(registered.socketPath, registered.credential, "role_call", { name: "workspace_status", arguments: {} })).rejects.toThrow();
    await expect(callHost(registered.socketPath, "unregistered-role-token", "interaction_execute", { command, principal: f.proof(command) })).rejects.toThrow();
    await expect(callHost(registered.socketPath, registered.credential, "interaction_register", f.registration)).rejects.toThrow();
  } finally { await controller.shutdown(); await rm(directory, { recursive: true, force: true }); }
}, 30000);
