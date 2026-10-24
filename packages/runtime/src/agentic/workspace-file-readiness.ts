import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { darwinWorkspaceFile } from "./workspace-file-darwin.js";

let probe: Promise<void> | undefined;
/** Probe real descriptor access and bounded create/read/digest replacement before provider launch.
 * Only a fresh owned fixture is touched, never the user's worktree or current run. */
export function assertWorkspaceFileCapability(): Promise<void> {
  // Memoize per process: concurrent callers share one in-flight probe and success is kept; a failure is dropped so repairs (free TMPDIR, Command Line Tools) are picked up on the next call.
  if (!probe) {
    const current = probe = probeWorkspaceFileCapability().catch((error: unknown) => { if (probe === current) probe = undefined; throw error; });
  }
  return probe;
}

async function probeWorkspaceFileCapability(): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bflow-workspace-probe-")));
  try {
    if (process.platform === "darwin") {
      const bytes = Buffer.from("Bflow workspace probe\n");
      await darwinWorkspaceFile(directory, "probe", { bytes, expectedSha256: null });
      if (!(await darwinWorkspaceFile(directory, "probe"))?.equals(bytes)) throw new Error("workspace read probe mismatch");
      await darwinWorkspaceFile(directory, "probe", { bytes: Buffer.from("replacement"), expectedSha256: createHash("sha256").update(bytes).digest("hex") });
      if (await readFile(join(directory, "probe"), "utf8") !== "replacement") throw new Error("workspace write probe mismatch");
    } else if (process.platform === "linux") {
      const root = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        await writeFile(`/proc/self/fd/${root.fd}/probe`, "probe", { flag: "wx", mode: 0o600 });
        const leaf = await open(`/proc/self/fd/${root.fd}/probe`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { if (await leaf.readFile("utf8") !== "probe") throw new Error("workspace descriptor read probe mismatch"); }
        finally { await leaf.close(); }
      } finally { await root.close(); }
    } else throw new Error(`No workspace file backend for ${process.platform}`);
  } catch (error) {
    throw new Error(`Runtime workspace file capability unavailable: ${error instanceof Error ? error.message : "probe failed"}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
