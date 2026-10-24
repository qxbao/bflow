import { expect, it } from "vitest";
import { DefaultBrowserLauncher } from "../src/browser-runtime.js";

it.runIf(process.platform === "darwin")("measures an owned live process rather than reporting the fixed 50 MiB estimate on macOS", async () => {
  // Exercise the process handle using an actual bounded Node child, without starting or touching a user's browser.
  const launched = await new DefaultBrowserLauncher().launch({ executablePath: process.execPath, profileDir: "/unused", debuggingHost: "127.0.0.1",
    debuggingPort: 1, headless: true, extraArgs: ["-e", "globalThis.bytes=Buffer.alloc(110*1024*1024,1);setInterval(()=>globalThis.bytes[0],1000)"] });
  if (!launched.ok) throw new Error(launched.error.message);
  try { await expect.poll(() => launched.value.getMemoryRssBytes(), { timeout: 3000 }).toBeGreaterThan(100 * 1024 * 1024); }
  finally { await launched.value.stop(); }
});
