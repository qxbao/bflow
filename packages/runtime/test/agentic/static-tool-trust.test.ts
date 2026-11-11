import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonAnalyzer, shellAnalyzer, xmlAnalyzer } from "../../src/agentic/static-analyzers.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(repositoryTool: boolean) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "bflow-static-tool-trust-")));
  temporary.push(parent);
  const root = join(parent, "repo"), bin = join(repositoryTool ? root : parent, "bin");
  await mkdir(root); await mkdir(bin, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Acceptance"); git("config", "user.email", "acceptance@example.test");
  await writeFile(join(root, "input.xml"), "<root/>\n");
  const tool = join(bin, "xmllint"), marker = join(parent, "executed-on-host");
  await writeFile(tool, `#!/bin/sh\nprintf invoked > '${marker}'\n`);
  await chmod(tool, 0o755);
  git("add", "."); git("commit", "-m", "committed analyzer input");
  return { parent, root, bin, tool, marker, revision: git("rev-parse", "HEAD") };
}

describe("static analyzer executable trust", () => {
  it("does not execute a repository-provided which when probing a shell", async () => {
    const f = await fixture(true);
    const which = join(f.bin, "which");
    await writeFile(which, `#!/bin/sh\nprintf invoked > '${f.marker}'\nprintf '/usr/bin/sh\\n'\n`);
    await chmod(which, 0o755);
    vi.stubEnv("PATH", `${f.bin}:/usr/bin:/bin`);
    await shellAnalyzer.detect({ cwd: f.root });
    expect(await access(f.marker).then(() => true, () => false)).toBe(false);
  });

  it("does not accept fabricated Git blob output from a repository-provided git", async () => {
    const f = await fixture(true);
    const git = join(f.bin, "git");
    await writeFile(git, `#!/bin/sh\nprintf invoked > '${f.marker}'\nprintf '{}\\n'\n`);
    await chmod(git, 0o755);
    vi.stubEnv("PATH", `${f.bin}:/usr/bin:/bin`);
    const result = await jsonAnalyzer.run({ cwd: f.root, revision: f.revision, files: ["not-committed.json"] });
    expect(result.exitCode).not.toBe(0);
    expect(await access(f.marker).then(() => true, () => false)).toBe(false);
  });
  it("never executes a repository-provided xmllint from PATH", async () => {
    const f = await fixture(true);
    vi.stubEnv("PATH", `${f.bin}:/usr/bin:/bin`);
    await xmlAnalyzer.run({ cwd: f.root, revision: f.revision, files: ["input.xml"] });
    expect(await access(f.marker).then(() => true, () => false)).toBe(false);
  });

  it("runs a trusted external XML tool without access to host files", async test => {
    const f = await fixture(false);
    if ((await probeBehavioralSandbox(f.root)).status !== "ready") { test.skip(); return; }
    const secret = join(f.parent, "host-only-fixture");
    await writeFile(secret, "fixture\n");
    await writeFile(f.tool, `#!/bin/sh\nif [ -e '${secret}' ]; then echo exposed; exit 11; else echo isolated; fi\n`);
    vi.stubEnv("PATH", `${f.bin}:/usr/bin:/bin`);
    const result = await xmlAnalyzer.run({ cwd: f.root, revision: f.revision, files: ["input.xml"] });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("isolated");
    expect(result.output).not.toContain("exposed");
  });
});
