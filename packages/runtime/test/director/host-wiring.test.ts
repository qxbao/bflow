import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DirectorEndpoint } from "../../src/director/endpoint.js";
import { DIRECTOR_OWNER_METHODS, isDirectorCoordinatorTool, isDirectorCredential, parseDirectorCredentialCall } from "../../src/director/host-methods.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe("director host wiring helpers", () => {
  it("rejects every method but director_call for Director credentials", () => {
    expect(() => parseDirectorCredentialCall("role_call", {})).toThrow("Director credentials can only call director tools");
    expect(() => parseDirectorCredentialCall("director_register", {})).toThrow("Director credentials can only call director tools");
    expect(parseDirectorCredentialCall("director_call", { name: "inspect" })).toEqual({ name: "inspect" });
    expect(() => parseDirectorCredentialCall("director_call", { name: "inspect", extra: 1 })).toThrow();
  });
  it("routes only dotted tokens to the Director branch", () => {
    const owner = "a".repeat(64);
    expect(isDirectorCredential("a".repeat(64), owner)).toBe(false);
    expect(isDirectorCredential("b".repeat(64), owner)).toBe(false);
    expect(isDirectorCredential(`${"t".repeat(12)}.${"s".repeat(43)}`, owner)).toBe(true);
    expect(isDirectorCredential(owner, owner)).toBe(false);
  });
  it("admits coordinator tools except report_progress", () => {
    expect(isDirectorCoordinatorTool("inspect")).toBe(true);
    expect(isDirectorCoordinatorTool("propose_workflow")).toBe(true);
    expect(isDirectorCoordinatorTool("report_progress")).toBe(false);
    expect(isDirectorCoordinatorTool("repository_read")).toBe(false);
  });
  it("validates owner method inputs strictly", () => {
    expect(() => DIRECTOR_OWNER_METHODS.director_register.parse({ provider: "claude", x: 1 })).toThrow();
    expect(() => DIRECTOR_OWNER_METHODS.director_hook_note.parse({ provider: "claude", prompt: "é".repeat(8193) })).toThrow();
    expect(DIRECTOR_OWNER_METHODS.director_hook_note.parse({ provider: "claude", prompt: "hi" }).prompt).toBe("hi");
    expect(() => DIRECTOR_OWNER_METHODS.director_issue_status.parse({ issueId: "i", status: "open" })).toThrow();
    expect(DIRECTOR_OWNER_METHODS.director_issue_status.parse({ issueId: "i", status: "dismissed" }).status).toBe("dismissed");
  });
  it("director_register yields a token the Director branch recognises", async () => {
    const directory = await mkdtemp(join(tmpdir(), "director-wiring-")); dirs.push(directory);
    const endpoint = new DirectorEndpoint({ directory, repositoryRoot: directory, feed: { read: () => ({ items: [] }) },
      inspect: async () => ({}), coordinator: { invoke: async () => null } });
    const { token } = await endpoint.register(DIRECTOR_OWNER_METHODS.director_register.parse({ provider: "claude" }));
    expect(isDirectorCredential(token, "f".repeat(64))).toBe(true);
  });
});
