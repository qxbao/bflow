import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

describe("verified executable ingress", () => {
  const identity = { schemaVersion: 3, toolId: "rtk", version: "1.0.1",
    artifactIntegrity: "a".repeat(64), desiredStateDigest: "b".repeat(64),
    executablePath: "/owned/tools/rtk/rtk", executableDigest: "c".repeat(64) };
  it("exports a strict identity bound to the approved artifact and current bytes", () => {
    expect(contracts.VerifiedToolExecutableIdentitySchema).toBeDefined();
    expect(contracts.VerifiedToolExecutableIdentitySchema.safeParse(identity).success).toBe(true);
    expect(contracts.VerifiedToolExecutableIdentitySchema.safeParse({ ...identity, permission: "all" }).success).toBe(false);
  });
  it("rejects relative paths, NUL, malformed hashes, and other versions", () => {
    expect(contracts.VerifiedToolExecutableIdentitySchema).toBeDefined();
    for (const override of [{ executablePath: "rtk" }, { executablePath: "/rtk\0" },
      { executableDigest: "unverified" }, { artifactIntegrity: "unverified" }, { schemaVersion: 2 }])
      expect(contracts.VerifiedToolExecutableIdentitySchema.safeParse({ ...identity, ...override }).success).toBe(false);
  });
});
