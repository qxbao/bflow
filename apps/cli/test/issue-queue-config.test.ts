import { describe, expect, it } from "vitest";
import { EnvironmentConfigSchema, defaultEnvironmentConfig } from "../src/environment-config.js";

describe("environment.issueQueue", () => {
  const base = () => defaultEnvironmentConfig({ id: "repo-1", root: "/tmp/repo", gitDir: "/tmp/repo/.git", sessionName: "repo-session" });
  it("defaults to auto-park with the existing resume limit", () => {
    const config = base(); const raw = { ...config, environment: { ...config.environment } };
    delete (raw.environment as Partial<typeof raw.environment>).issueQueue;
    expect(EnvironmentConfigSchema.parse(raw).environment.issueQueue).toEqual({ autoPark: true, maxAutoResumesBeforePark: 3 });
  });
  it.each([0, 1, 2, 3])("accepts owner threshold %s", maxAutoResumesBeforePark => {
    const config = base(); config.environment.issueQueue = { autoPark: false, maxAutoResumesBeforePark };
    expect(EnvironmentConfigSchema.parse(config).environment.issueQueue).toEqual({ autoPark: false, maxAutoResumesBeforePark });
  });
  it.each([-1, 4, 1.5])("rejects out-of-range threshold %s with a Vietnamese message", value => {
    const config = base(); config.environment.issueQueue.maxAutoResumesBeforePark = value;
    expect(() => EnvironmentConfigSchema.parse(config)).toThrow("issueQueue.maxAutoResumesBeforePark phải trong khoảng 0–3");
  });
  it("rejects unknown keys and non-boolean autoPark", () => {
    const config = base();
    expect(() => EnvironmentConfigSchema.parse({ ...config, environment: { ...config.environment, issueQueue: { autoPark: "false" } } })).toThrow();
    expect(() => EnvironmentConfigSchema.parse({ ...config, environment: { ...config.environment, issueQueue: { extra: true } } })).toThrow();
  });
});
