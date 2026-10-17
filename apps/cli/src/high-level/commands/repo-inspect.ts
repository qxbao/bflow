import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@bflow/contracts";
import { readOnlyGit } from "../git.js";
import type { CommandSpec } from "../args.js";
import { HIGH_LEVEL_EXIT_CODES } from "../envelope.js";
import { guarded, requireRepository, StepLog, type HighLevelHandler } from "../context.js";

export const REPO_INSPECT_SPEC: CommandSpec = { name: "repo.inspect",
  behavior: { summary: "Inspect repository, Git, worktrees, project structure and context", mutates: "none", retry: "read_only", permissionFlags: [], outcomes: ["inspected", "failed"] }, words: ["repo", "inspect"], positionals: [], flags: {} };

const git = readOnlyGit;

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

const MARKERS: readonly [string, string][] = [
  ["package.json", "node"], ["pnpm-workspace.yaml", "pnpm-workspace"], ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"], ["yarn.lock", "yarn"], ["tsconfig.json", "typescript"], ["Cargo.toml", "rust"],
  ["go.mod", "go"], ["pyproject.toml", "python"], ["requirements.txt", "python"], ["pom.xml", "java-maven"],
  ["build.gradle", "java-gradle"], ["Gemfile", "ruby"], ["composer.json", "php"]
];
const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md", ".bflow/config.yaml", ".bflow/environment.yaml"];

function parseStatus(z: string) {
  const entries: { status: string; path: string }[] = [];
  const parts = z.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const code = part.slice(0, 2);
    entries.push({ status: code, path: part.slice(3) });
    if (code.startsWith("R") || code.startsWith("C")) i++;
  }
  return entries;
}

function parseWorktrees(text: string) {
  return text.split("\n\n").filter(block => block.trim()).map(block => {
    const fields = new Map(block.split("\n").map(line => [line.split(" ")[0]!, line.slice(line.indexOf(" ") + 1)]));
    return {
      path: fields.get("worktree") ?? "",
      head: fields.get("HEAD") ?? null,
      branch: fields.get("branch")?.replace(/^refs\/heads\//, "") ?? null,
      detached: fields.has("detached"),
      locked: fields.has("locked"),
      bflowManaged: (fields.get("worktree") ?? "").includes("/bflow-git/trees/")
    };
  });
}

async function workspacePackages(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const parent of ["packages", "apps"]) {
    let names: string[];
    try { names = await readdir(join(root, parent)); } catch { continue; }
    for (const name of names.sort())
      if (await exists(join(root, parent, name, "package.json"))) out.push(`${parent}/${name}`);
  }
  return out;
}

/** Read-only repository, Git and project context inspection. */
export const repoInspect: HighLevelHandler = async (_args, ctx) => {
  const log = new StepLog(undefined, ctx.onProgress);
  return guarded("repo.inspect", log, {}, async () => {
    const repository = await log.check("identify-repository", () => requireRepository(ctx.cwd),
      value => ({ root: value.root, repositoryId: value.id }));
    const root = repository.root;

    const gitState = await log.check("inspect-git", async () => {
      const [branch, head, status, worktrees, remotes, upstream] = await Promise.all([
        git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
        git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]),
        git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
        git(root, ["worktree", "list", "--porcelain"]),
        git(root, ["remote", "-v"]),
        git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
      ]);
      const entries = status.ok ? parseStatus(status.stdout) : [];
      const remoteNames = [...new Set(remotes.stdout.split("\n").filter(Boolean).map(line => line.split(/\s+/)[0]!))];
      let operation: string | null = null;
      for (const [file, name] of [["MERGE_HEAD", "merge"], ["REBASE_HEAD", "rebase"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]] as const)
        if (await exists(join(repository.gitDir, file))) operation = name;
      return {
        branch: branch.ok ? branch.stdout.trim() : null,
        detached: !branch.ok,
        head: head.ok ? head.stdout.trim() : null,
        hasCommits: head.ok,
        upstream: upstream.ok ? upstream.stdout.trim() : null,
        dirty: entries.length > 0,
        changes: entries.slice(0, 200),
        changeCount: entries.length,
        inProgressOperation: operation,
        worktrees: worktrees.ok ? parseWorktrees(worktrees.stdout) : [],
        remotes: remoteNames
      };
    }, value => ({ branch: value.branch, head: value.head, dirty: value.dirty }));

    const project = await log.check("inspect-project", async () => {
      const markers: string[] = [];
      for (const [file, label] of MARKERS) if (await exists(join(root, file))) markers.push(label);
      const contextFiles: string[] = [];
      for (const file of CONTEXT_FILES) if (await exists(join(root, file))) contextFiles.push(file);
      let packageManager: string | null = null;
      let scripts: string[] = [];
      try {
        const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { packageManager?: unknown; scripts?: unknown };
        if (typeof manifest.packageManager === "string") packageManager = manifest.packageManager;
        if (manifest.scripts !== null && typeof manifest.scripts === "object") scripts = Object.keys(manifest.scripts).sort();
      } catch { /* Not a Node project. */ }
      const plans: string[] = [];
      try { for (const name of (await readdir(join(root, ".bflow/plans"))).sort()) if (name.endsWith(".json")) plans.push(`.bflow/plans/${name}`); } catch { /* none */ }
      return {
        markers: [...new Set(markers)],
        packageManager,
        scripts,
        workspacePackages: await workspacePackages(root),
        contextFiles,
        bflow: { initialized: contextFiles.includes(".bflow/config.yaml"), plans }
      };
    }, value => ({ markers: value.markers, bflowInitialized: value.bflow.initialized }));

    const data: JsonValue = {
      repository: { root, gitDir: repository.gitDir, repositoryId: repository.id, sessionName: repository.sessionName },
      git: gitState,
      project
    };
    return { command: "repo.inspect", outcome: "inspected", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS, steps: log.steps, data };
  });
};
