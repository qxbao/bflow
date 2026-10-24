import { expect, it } from "vitest";
import { readLinuxProcessRssBytes } from "../src/metrics.js";

it.runIf(process.platform === "darwin" || process.platform === "linux")("measures the current real process instead of treating missing procfs as zero memory", async () => {
  expect(await readLinuxProcessRssBytes(process.pid)).toBeGreaterThan(1024 * 1024);
});
it.each([0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid process identity %s", async pid => {
  expect(await readLinuxProcessRssBytes(pid)).toBe(0);
});
