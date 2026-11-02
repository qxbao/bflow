import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Resolves exact `-c safe.directory=<canonicalDir>` flags for `cwd`, its enclosing working tree,
 * and any linked `.git` / common repository directories (never wildcard `*`), and appends
 * `-c core.fileMode=false` when `.git/HEAD` or a linked `.git` pointer file carries executable
 * permission bits (as on FUSE/NTFS `fuseblk` or WSL DrvFs mounts).
 */
export function gitSafeDirectoryFlags(cwd: string): string[] {
  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync(cwd);
  } catch {
    canonicalCwd = resolve(cwd);
  }
  const safeDirs = new Set<string>([canonicalCwd]);
  let forceFileModeFalse = false;
  let current = canonicalCwd;
  for (;;) {
    const dotGit = join(current, ".git");
    let dotGitStat;
    try {
      dotGitStat = lstatSync(dotGit);
    } catch {
      dotGitStat = undefined;
    }
    if (dotGitStat) {
      safeDirs.add(current);
      if (dotGitStat.isDirectory()) {
        let gitDir = dotGit;
        try {
          gitDir = realpathSync(dotGit);
        } catch {
          gitDir = dotGit;
        }
        safeDirs.add(gitDir);
        try {
          const headStat = lstatSync(join(gitDir, "HEAD"));
          forceFileModeFalse = headStat.isFile() && (headStat.mode & 0o111) !== 0;
        } catch {
          forceFileModeFalse = false;
        }
      } else if (dotGitStat.isFile()) {
        forceFileModeFalse = (dotGitStat.mode & 0o111) !== 0;
        let raw = "";
        try {
          raw = readFileSync(dotGit, "utf8");
        } catch {
          raw = "";
        }
        const match = /^gitdir:\s*([^\r\n]+)/.exec(raw);
        if (match) {
          const rawGitDir = resolve(current, match[1]!.trim());
          let gitDir = rawGitDir;
          try {
            gitDir = realpathSync(rawGitDir);
          } catch {
            gitDir = rawGitDir;
          }
          safeDirs.add(gitDir);
          let commonRel = "";
          try {
            commonRel = readFileSync(join(gitDir, "commondir"), "utf8").trim();
          } catch {
            commonRel = "";
          }
          let commonDir = gitDir;
          if (commonRel) {
            const resolvedCommon = resolve(gitDir, commonRel);
            try {
              commonDir = realpathSync(resolvedCommon);
            } catch {
              commonDir = resolvedCommon;
            }
          }
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

  const flags: string[] = [];
  for (const dir of safeDirs) {
    flags.push("-c", `safe.directory=${dir}`);
  }
  if (forceFileModeFalse) {
    flags.push("-c", "core.fileMode=false");
  }
  return flags;
}

export function sanitizedGitEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}
