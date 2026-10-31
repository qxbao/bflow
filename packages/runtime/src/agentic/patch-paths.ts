import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

/**
 * Resolves exact `safe.directory` entries for `cwd`, its enclosing worktree root, and any linked `.git` / common
 * repository directories (never wildcard `*`), and disables `core.fileMode` when the filesystem forces executable
 * bits on non-executable Git metadata (e.g. FUSE/NTFS `fuseblk`).
 */
export async function runtimeGitDirectoryFlags(
  cwd: string,
  options: { readonly resetSafeDirectory?: boolean } = {}
): Promise<string[]> {
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const safeDirs = new Set<string>([canonicalCwd]);
  let forceFileModeFalse = false;
  let current = canonicalCwd;
  for (;;) {
    const dotGit = join(current, ".git");
    const dotGitStat = await lstat(dotGit).catch(() => undefined);
    if (dotGitStat) {
      safeDirs.add(current);
      if (dotGitStat.isDirectory()) {
        const gitDir = await realpath(dotGit).catch(() => dotGit);
        safeDirs.add(gitDir);
        const headStat = await lstat(join(gitDir, "HEAD")).catch(() => undefined);
        forceFileModeFalse = Boolean(headStat?.isFile() && (headStat.mode & 0o111) !== 0);
      } else if (dotGitStat.isFile()) {
        forceFileModeFalse = (dotGitStat.mode & 0o111) !== 0;
        const raw = await readFile(dotGit, "utf8").catch(() => "");
        const match = /^gitdir:\s*([^\r\n]+)/.exec(raw);
        if (match) {
          const rawGitDir = resolve(current, match[1]!.trim());
          const gitDir = await realpath(rawGitDir).catch(() => rawGitDir);
          safeDirs.add(gitDir);
          const commonRel = (await readFile(join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
          const commonDir = commonRel
            ? await realpath(resolve(gitDir, commonRel)).catch(() => resolve(gitDir, commonRel))
            : gitDir;
          safeDirs.add(commonDir);
          if (basename(commonDir) === ".git") {
            safeDirs.add(dirname(commonDir));
          }
        }
      }
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const flags: string[] = options.resetSafeDirectory ? ["-c", "safe.directory="] : [];
  for (const dir of safeDirs) flags.push("-c", `safe.directory=${dir}`);
  if (forceFileModeFalse) flags.push("-c", "core.fileMode=false");
  return flags;
}

const PatchInput = z.union([z.string(), z.object({ input: z.string() }).strict(), z.object({ patch: z.string() }).strict(),
  z.object({ command: z.string() }).strict()]);

/** Parse only the native apply_patch grammar, never shell/heredoc wrappers. Every mutation target needs authorization. */
export function patchFilePaths(input: unknown): string[] {
  const parsed = PatchInput.parse(input), patch = typeof parsed === "string" ? parsed : "input" in parsed ? parsed.input
    : "patch" in parsed ? parsed.patch : parsed.command;
  if (Buffer.byteLength(patch) > 1024 * 1024 || patch.includes("\0")) throw new Error("Native patch exceeds limits or contains NUL");
  const lines = patch.trim().replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch" || lines.some(line => line.includes("\r")))
    throw new Error("Native patch framing is invalid");
  const paths: string[] = [];
  const target = (path: string) => {
    if (!path || path.trim() !== path || paths.length >= 128) throw new Error("Native patch target is invalid or exceeds limits");
    paths.push(path);
  };
  let index = 1;
  while (index < lines.length - 1) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[index++]!);
    if (!header) throw new Error("Native patch operation is unsupported");
    target(header[2]!);
    if (header[1] === "Delete") continue;
    if (header[1] === "Update" && lines[index]?.startsWith("*** Move to: ")) target(lines[index++]!.slice("*** Move to: ".length));
    let hunk = false, content = false;
    while (index < lines.length - 1 && !lines[index]!.startsWith("*** ")) {
      const line = lines[index++]!;
      if (header[1] === "Add") {
        if (!line.startsWith("+")) throw new Error("Native patch addition is malformed");
      } else if (line === "@@" || line.startsWith("@@ ")) { hunk = true; continue; }
      else if (!hunk || line !== "" && !/^[ +\-]/.test(line)) throw new Error("Native patch hunk is malformed");
      content = true;
    }
    if (header[1] === "Update" && (!hunk || !content)) throw new Error("Native patch update has no hunk content");
    if (lines[index] === "*** End of File") {
      if (header[1] !== "Update") throw new Error("Native patch end-of-file marker is misplaced");
      index++;
    }
  }
  if (!paths.length) throw new Error("Native patch has no mutation targets");
  return [...new Set(paths)];
}
