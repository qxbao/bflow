import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAndVerifyExecutable } from "../src/attestation.js";
import { createProviderProcessRunner } from "../src/runner.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-path-")));
  roots.push(root);
  const shadow = join(root, "shadow-dir");
  const bin = join(root, "bin");
  await mkdir(shadow, { mode: 0o700 });
  await mkdir(bin, { mode: 0o700 });
  const binary = join(bin, "codex");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { root, shadow, binary, searchPath: [shadow, bin].join(delimiter) };
}

describe("executable PATH resolution", () => {
  it.each(["directory", "non-executable", "dangling symlink"])("skips a %s named codex before the real binary", async kind => {
    const { shadow, binary, searchPath } = await fixture();
    const candidate = join(shadow, "codex");
    if (kind === "directory") await mkdir(candidate, { mode: 0o700 });
    else if (kind === "non-executable") await writeFile(candidate, "data", { mode: 0o600 });
    else await symlink(join(shadow, "missing"), candidate);
    expect((await resolveAndVerifyExecutable("codex", { searchPath })).canonicalPath).toBe(binary);
  });

  it("does not skip an executable with unsafe permissions to accept a later trusted binary", async () => {
    const { shadow, searchPath } = await fixture();
    const unsafe = join(shadow, "codex");
    await writeFile(unsafe, "#!/bin/sh\nexit 0\n", { mode: 0o777 });
    await chmod(unsafe, 0o777);
    await expect(resolveAndVerifyExecutable("codex", { searchPath })).rejects.toMatchObject({ code: "binary_untrusted" });
  });

  it("keeps explicit non-executable paths strict", async () => {
    const { shadow, searchPath } = await fixture();
    const candidate = join(shadow, "codex");
    await mkdir(candidate, { mode: 0o700 });
    await expect(resolveAndVerifyExecutable(candidate, { searchPath })).rejects.toMatchObject({ code: "binary_not_executable" });
  });

  it.each(["PATH", "relative explicit path"])("preserves symlink/.. traversal in a %s lookup", async kind => {
    const { root } = await fixture();
    const actualDirectory = join(root, "actual");
    await mkdir(join(actualDirectory, "child"), { recursive: true, mode: 0o700 });
    await symlink(join(actualDirectory, "child"), join(root, "link"));
    const actual = join(actualDirectory, "codex");
    await writeFile(actual, "#!/bin/sh\nprintf actual\n", { mode: 0o700 });
    await writeFile(join(root, "codex"), "#!/bin/sh\nprintf lexical\n", { mode: 0o700 });
    const searchPath = `${root}/link/..`;
    const requested = kind === "PATH" ? "codex" : `${relative(process.cwd(), root)}/link/../codex`;
    expect(execFileSync(requested, [], { env: { PATH: searchPath }, encoding: "utf8" })).toBe("actual");
    expect((await resolveAndVerifyExecutable(requested, { searchPath })).canonicalPath).toBe(actual);
  });

  it("resolves an empty PATH entry as the current directory, matching process spawning", async () => {
    const { root, binary } = await fixture();
    const local = join(root, "codex");
    await writeFile(local, "#!/bin/sh\nprintf local\n", { mode: 0o700 });
    const searchPath = `${delimiter}${dirname(binary)}`;
    expect(execFileSync("codex", [], { cwd: root, env: { PATH: searchPath }, encoding: "utf8" })).toBe("local");
    const moduleUrl = new URL("../dist/attestation.js", import.meta.url).href;
    const code = `import { resolveAndVerifyExecutable } from ${JSON.stringify(moduleUrl)}; console.log((await resolveAndVerifyExecutable('codex')).canonicalPath);`;
    const selected = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: root, env: { PATH: searchPath }, encoding: "utf8"
    }).trim();
    expect(selected).toBe(local);
  });

  it("resolves promptly when a command exits while a background grandchild holds stdout open", async () => {
    const runner = createProviderProcessRunner({ defaultTimeoutMs: 5_000 });
    const outcome = await runner.run({
      executable: process.execPath,
      args: [
        "-e",
        "import('node:child_process').then(({ spawn }) => { spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'inherit' }).unref(); process.stdout.write('models-ready\\n'); process.exit(0); });"
      ],
      timeoutMs: 3_000
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("models-ready\n");
    expect(outcome.failure).toBeUndefined();
  });
});
