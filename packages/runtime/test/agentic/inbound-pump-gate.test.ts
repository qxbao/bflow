import { describe, expect, it } from "vitest";
import { inboundPumpWork } from "../../src/agentic/host.js";

const idle = { workspace: true, pumping: false, quiesced: false, closing: false, prompts: 0, stopsUnreconciled: false, stopRetryDue: false };
describe("inbound pump gate", () => {
  it("drains queued inbound prompts after quiesce so shutdown can complete", () => {
    // A quiesce that times out leaves the host quiesced; a frozen pump then kept every later shutdown "still draining".
    expect(inboundPumpWork({ ...idle, quiesced: true, prompts: 1 })).toBe("prompts");
  });
  it("does not settle Stop receipts or run with nothing queued while quiesced", () => {
    expect(inboundPumpWork({ ...idle, quiesced: true, stopsUnreconciled: true, stopRetryDue: true })).toBe("none");
  });
  it("runs both phases when active and stops entirely while closing or already pumping", () => {
    expect(inboundPumpWork({ ...idle, prompts: 1 })).toBe("all");
    expect(inboundPumpWork({ ...idle, stopsUnreconciled: true })).toBe("all");
    expect(inboundPumpWork(idle)).toBe("none");
    expect(inboundPumpWork({ ...idle, closing: true, prompts: 1 })).toBe("none");
    expect(inboundPumpWork({ ...idle, pumping: true, prompts: 1 })).toBe("none");
    expect(inboundPumpWork({ ...idle, workspace: false, prompts: 1 })).toBe("none");
  });
});
