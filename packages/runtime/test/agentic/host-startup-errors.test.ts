import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAgenticHost } from "../../dist/agentic/host-controller.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("host startup failure diagnostics", () => {
  async function failedStartup(code: string, previousLog = "") {
    const root = await realpath(await mkdtemp("/tmp/bflow-boot-error-")); roots.push(root);
    const directory = join(root, ".bflow/state/host/denied");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "host.log"), previousLog, { mode: 0o600 });
    const preload = join(root, "deny-listen.cjs");
    await writeFile(preload, `if (process.argv[2] === "daemon") {
  const net = require("node:net");
  net.Server.prototype.listen = function () {
    throw new Error(${JSON.stringify(`listen ${code}: fixture startup failure`)});
  };
}
`);
    const previous = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = [previous, "--require", preload].filter(Boolean).join(" ");
      const error = await ensureAgenticHost({ repositoryPath: root, sessionId: "denied" }).then(
        async controller => { await controller.shutdown(); throw new Error("fixture unexpectedly started"); }, error => error as Error);
      return { error, log: await readFile(join(directory, "host.log"), "utf8") };
    } finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
  }

  it.each(["EPERM", "EACCES"])("reports the actual listen %s rather than the missing client socket", async code => {
    const { error, log } = await failedStartup(code);
    expect(log).toContain(`listen ${code}`);
    expect(error.message).toContain(`Host Unix socket permission denied (listen ${code})`);
    expect(error.message).not.toContain("connect ENOENT");
    expect(error.message).not.toContain("fixture startup failure");
    expect(error.message).toContain("host.log");
  });

  it("does not misdiagnose an unrelated failure using an older permission error in the append-only log", async () => {
    const { error } = await failedStartup("EADDRINUSE", "Error: listen EPERM: old attempt\n");
    expect(error.message).not.toContain("Host Unix socket permission denied");
    expect(error.message).toContain("exited during startup");
  });
});
