import { describe, expect, it } from "vitest";
import { shouldRunWatchdog } from "../../src/agentic/host.js";

describe("host watchdog lifecycle guard", () => {
  it("does not run while the workspace is active but the session manifest is not installed", () => {
    expect(shouldRunWatchdog({ workspace: true, manifest: false, quiesced: false, closing: false })).toBe(false);
  });

  it("runs only for an active workspace with a manifest during normal operation", () => {
    expect(shouldRunWatchdog({ workspace: true, manifest: true, quiesced: false, closing: false })).toBe(true);
  });
});
