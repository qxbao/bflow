import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { workspaceFileDarwinSource } from "./workspace-file-darwin-source.js";

const execute = promisify(execFile);
const env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
interface Helper { directory: string; binary: string }
let compiled: Promise<Helper> | undefined;
const ownedDirectories = new Set<string>();
let exitCleanupInstalled = false;
function trackDirectory(directory: string): void {
  ownedDirectories.add(directory);
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once("exit", () => {
    for (const path of ownedDirectories) {
      try { rmSync(path, { recursive: true, force: true }); } catch { /* Never turn exit cleanup into a failed operation. */ }
    }
  });
}
async function discardDirectory(directory: string): Promise<void> {
  try { await rm(directory, { recursive: true, force: true }); ownedDirectories.delete(directory); }
  catch { /* Retain ownership for another cleanup attempt on exit. */ }
}
/** Build only owned, checked-in source in a fresh mode-0700 directory; never use PATH-selected compilers,
 * repository flags, downloaded binaries, shell expansion or a user-global provider configuration.
 * The process-local binary is removed on normal exit; interrupted temporary builds are harmless, never reused. */
async function buildHelper(): Promise<Helper> {
  let directory: string | undefined, stage: "storage" | "compiler" = "storage";
  try {
    directory = await mkdtemp(join(tmpdir(), "bflow-workspace-native-"));
    trackDirectory(directory);
    const canonical = await realpath(directory);
    const source = join(canonical, "workspace.c"), binary = join(canonical, "workspace");
    await writeFile(source, workspaceFileDarwinSource, { mode: 0o600, flag: "wx" });
    stage = "compiler";
    await execute("/usr/bin/clang", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Werror", "-Wall", "-Wextra", "-Wno-deprecated-declarations", "-O2", source, "-o", binary],
      { cwd: canonical, env, timeout: 30_000, maxBuffer: 16_384 });
    return { directory, binary };
  } catch (error) {
    if (directory) await discardDirectory(directory);
    if (stage === "storage") {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "filesystem error";
      throw new Error(`macOS workspace helper temporary storage failed (${code}). Ensure TMPDIR is private, writable and has free space before retrying`);
    }
    const diagnostic = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim().slice(-2048) : "system clang is unavailable";
    throw new Error(`macOS workspace helper build failed: ${diagnostic}. It requires Apple's Command Line Tools (/usr/bin/clang); install missing tools with xcode-select --install. If tools are installed, rebuild or reinstall Bflow before running bflow up again`);
  }
}

export async function prepareDarwinWorkspaceHelper(): Promise<string> {
  // A missing cache is repaired before launching any file operation. Never replay an operation
  // after helper failure/timeout: it may already have mutated its file.
  for (let attempt = 0; attempt < 2; attempt++) {
    const build = compiled ??= buildHelper();
    let helper: Helper;
    try { helper = await build; }
    catch (error) { if (compiled === build) compiled = undefined; throw error; }
    try {
      const info = await lstat(helper.binary);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o111) === 0)
        throw new Error("Private macOS workspace helper changed; inspect its temporary directory before retrying");
      return helper.binary;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      if (compiled === build) { compiled = undefined; await discardDirectory(helper.directory); }
    }
  }
  throw new Error("macOS workspace helper was removed repeatedly; inspect temporary storage before retrying");
}

export async function darwinWorkspaceFile(cwd: string, path: string, replacement?: { bytes: Buffer; expectedSha256: string | null }): Promise<Buffer | undefined> {
  const root = await realpath(cwd);
  if (root !== resolve(cwd)) throw new Error("Developer workspace may not traverse symlinks");
  const binary = await prepareDarwinWorkspaceHelper();
  return new Promise((accept, reject) => {
    const child = execFile(binary, [replacement ? "write" : "read", root, path, replacement?.expectedSha256 ?? "new"],
      { cwd: "/", env, encoding: "buffer", timeout: 10_000, maxBuffer: 131_073, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
        if (error) {
          if (!replacement && error.code === 3) accept(undefined);
          else reject(new Error(stderr.toString("utf8").trim() || "macOS workspace helper failed or timed out; inspect the file before retrying"));
        } else accept(stdout);
      });
    child.stdin?.on("error", () => { /* execFile reports early child exit. */ });
    child.stdin?.end(replacement?.bytes);
  });
}
