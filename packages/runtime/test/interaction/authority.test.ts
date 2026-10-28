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
