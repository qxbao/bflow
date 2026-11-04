import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  applyDirectorRepoFiles,
  checkDirectorRepoFiles,
  removeDirectorRepoFiles,
  type DirectorProvider
} from "./director-repo-files.js";

export const DIRECTOR_PROVIDERS: readonly DirectorProvider[] = ["claude", "codex", "agy"];

export interface InitDirectorFile {
  readonly path: string;
  readonly action: string;
}

export interface InitDirectorReport {
  readonly status: "ready" | "installed" | "missing" | "modified" | "removed" | "skipped" | "failed";
  readonly files: readonly InitDirectorFile[];
}

export interface ResolveBflowCommandDeps {
  readonly execPath?: string | undefined;
  readonly argv1?: string | undefined;
  readonly realpath?: ((path: string) => Promise<string>) | undefined;
}

/**
 * Absolute argv prefix used by the generated Director skill, MCP and hook files.
 * There is no deterministic helper for the managed shell launcher path, so the running
 * entrypoint is pinned: [node, realpath(bin.js)].
 */
export async function resolveBflowCommand(deps: ResolveBflowCommandDeps = {}): Promise<string[]> {
  const execPath = deps.execPath ?? process.execPath;
  const argv1 = deps.argv1 ?? process.argv[1];
  if (!argv1) throw new Error("Cannot determine the bflow entrypoint (process.argv[1] is empty).");
  const resolveReal = deps.realpath ?? realpath;
  const entry = await resolveReal(resolve(argv1));
  if (!isAbsolute(execPath) || !isAbsolute(entry)) throw new Error("bflow command must resolve to absolute paths.");
  return [execPath, entry];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DirectorFilesOptions {
  readonly commitSkills?: boolean | undefined;
  readonly deps?: ResolveBflowCommandDeps | undefined;
}

export const DIRECTOR_NOT_INSTALLED_NOTICE =
  "Director chưa được cài trong kho này; chạy `bflow init --update` nếu muốn dùng /bflow-start";

/** Reads the install receipt: whether it exists and whether it was written with --commit-skills (no git exclude unit). */
async function readDirectorReceipt(repositoryRoot: string): Promise<{ installed: boolean; commitSkills: boolean }> {
  let text: string;
  try {
    text = await readFile(join(repositoryRoot, ".bflow", "director-files.json"), "utf8");
  } catch {
    return { installed: false, commitSkills: false };
  }
  try {
    const units = (JSON.parse(text) as { units?: { path?: unknown }[] }).units;
    const hasIgnore = Array.isArray(units) && units.some(u => u?.path === ".git/info/exclude" || u?.path === ".gitignore");
    return { installed: true, commitSkills: Array.isArray(units) && !hasIgnore };
  } catch {
    return { installed: true, commitSkills: false };
  }
}

export async function installDirectorFiles(
  repositoryRoot: string,
  options: DirectorFilesOptions = {}
): Promise<{ report: InitDirectorReport; diagnostics: string[] }> {
  try {
    const bflowCommand = await resolveBflowCommand(options.deps);
    const { written, backedUp } = await applyDirectorRepoFiles({
      repositoryRoot, bflowCommand, providers: DIRECTOR_PROVIDERS, ...(options.commitSkills ? { commitSkills: true } : {})
    });
    const report: InitDirectorReport = { status: "installed", files: written.map(path => ({ path, action: "written" })) };
    const diagnostics = backedUp.length > 0
      ? [`Đã sao lưu tệp tuỳ chỉnh trước khi thay bằng skill Director: ${backedUp.join(", ")}.`]
      : [];
    return { report, diagnostics };
  } catch (error) {
    return {
      report: { status: "failed", files: [] },
      diagnostics: [`Không thể cài tệp Director: ${errorMessage(error)}. Sửa hoặc xoá khối/tệp bị lỗi rồi chạy 'bflow init --update'.`]
    };
  }
}

export async function checkDirectorFiles(
  repositoryRoot: string,
  options: DirectorFilesOptions = {}
): Promise<{ report: InitDirectorReport; healthy: boolean; installed: boolean; diagnostics: string[] }> {
  const receipt = await readDirectorReceipt(repositoryRoot);
  const installed = receipt.installed;
  const commitSkills = options.commitSkills ?? receipt.commitSkills;
  try {
    const bflowCommand = await resolveBflowCommand(options.deps);
    const checks = await checkDirectorRepoFiles({
      repositoryRoot, bflowCommand, providers: DIRECTOR_PROVIDERS, ...(commitSkills ? { commitSkills: true } : {})
    });
    const files = checks.map(c => ({ path: c.path, action: c.status }));
    const status = checks.some(c => c.status === "modified") ? "modified"
      : checks.some(c => c.status === "missing") ? "missing" : "ready";
    if (!installed) {
      return { report: { status, files }, healthy: true, installed, diagnostics: [DIRECTOR_NOT_INSTALLED_NOTICE] };
    }
    return {
      report: { status, files },
      healthy: status === "ready",
      installed,
      diagnostics: status === "ready" ? [] : ["Chạy `bflow init --update` để cài lại skill Director."]
    };
  } catch (error) {
    return {
      report: { status: "failed", files: [] },
      healthy: !installed,
      installed,
      diagnostics: [`Không kiểm tra được tệp Director: ${errorMessage(error)}. Chạy \`bflow init --update\` để cài lại skill Director.`]
    };
  }
}

export async function removeDirectorFiles(repositoryRoot: string): Promise<{ report: InitDirectorReport; diagnostics: string[] }> {
  try {
    const { removed, kept } = await removeDirectorRepoFiles(repositoryRoot);
    return {
      report: {
        status: "removed",
        files: [...removed.map(path => ({ path, action: "removed" })), ...kept.map(path => ({ path, action: "kept" }))]
      },
      diagnostics: kept.length > 0 ? [`Giữ lại tệp Director đã bị chỉnh sửa: ${kept.join(", ")}.`] : []
    };
  } catch (error) {
    return {
      report: { status: "failed", files: [] },
      diagnostics: [`Không gỡ được tệp Director: ${errorMessage(error)}.`]
    };
  }
}
