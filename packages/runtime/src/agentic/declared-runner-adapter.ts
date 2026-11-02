import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { RunnerAdapter, AdapterRunner } from "./runner-adapter.js";
const execute = promisify(execFile);

async function resolveSystemTool(name: string, repositoryRoot: string): Promise<string | undefined> {
  const canonicalRepo = await realpath(repositoryRoot).catch(() => repositoryRoot);
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    if (!directory) continue;
    try {
      const candidate = await realpath(join(directory, name));
      if (!isAbsolute(candidate) || candidate === repositoryRoot || candidate.startsWith(repositoryRoot + "/") ||
          candidate === canonicalRepo || candidate.startsWith(canonicalRepo + "/")) {
        continue;
      }
      if (!(await lstat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* continue installed PATH discovery */
    }
  }
  return undefined;
}

/** Generic targets need a selection/report protocol; guessing arbitrary project CLI flags could run an unrelated suite. */
const protocol = ["BFLOW_TEST_NAMES", "BFLOW_TEST_FILES", "BFLOW_JUNIT_OUTPUT"];
export const declaredRunnerAdapter: RunnerAdapter = {
  id: "declared",
  async detect(context) {
    const runners: AdapterRunner[] = [], notes: string[] = [];
    for (const file of context.files.filter(file => /(^|\/)(Makefile|justfile|Taskfile\.ya?ml|tox\.ini|noxfile\.py)$/.test(file))) {
      const source = await readFile(join(context.root, file), "utf8"), project = dirname(file);
      if (!protocol.every(name => source.includes(name))) {
        if (/(?:^|\n)\s*test\s*:/.test(source) || /(?:tox\.ini|noxfile\.py)$/.test(file)) notes.push(`${file}: runner_reporter_required: Coordinator can add exact-name selection and a structured reporter in a reviewed setup task`);
        continue;
      }
      const kind = file.endsWith("Makefile") ? "make" : file.endsWith("justfile") ? "just" : /Taskfile\.ya?ml$/.test(file) ? "task" : undefined;
      if (!kind || !/(?:^|\n)\s*test\s*:/.test(source)) continue;
      try {
        const executable = await resolveSystemTool(kind, context.root);
        if (!executable) { notes.push(`${file}: runner_toolchain_unavailable: ${kind}`); continue; }
        const checked = await execute(executable, ["--version"], { cwd: "/", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }, timeout: 5000, maxBuffer: 16384 });
        if (!/\d+\.\d+/.test(checked.stdout)) continue;
        runners.push({ adapterId: `declared-${kind}`, version: /\d+\.\d+(?:\.\d+)?/.exec(checked.stdout)![0], executable, projectDirectory: project,
          format: "junit", nameRule: "JUnit classname.name; target must honor BFLOW_TEST_NAMES JSON and BFLOW_TEST_FILES JSON", mounts: [], environment: {}, protectedPaths: [file],
          bind(identities, reports) {
            // Recipe/task engines can re-expand assignment values. Reject executable syntax instead of passing it through.
            if (identities.testNames.some(name => !/^[A-Za-z0-9_.:#/ \[\]-]+$/.test(name)) || identities.testPaths.some(path => !/^[A-Za-z0-9_./-]+$/.test(path)))
              throw new Error("runner_identity_unselectable: declared target identities require a safe literal selection protocol");
            const output = join(reports, "declared.xml");
            if (identities.testPaths.some(path => project !== "." && !path.startsWith(project + "/"))) throw new Error("Declared test file outside project");
            const files = identities.testPaths.map(path => project === "." ? path : path.slice(project.length + 1));
            // Values remain distinct argv tokens; shell expansion never constructs Runtime's command.
            const assignments = [`BFLOW_TEST_NAMES=${JSON.stringify(identities.testNames)}`, `BFLOW_TEST_FILES=${JSON.stringify(files)}`, `BFLOW_JUNIT_OUTPUT=${output}`];
            return { args: kind === "make" ? ["--no-print-directory", "test", ...assignments] : kind === "just" ? [...assignments, "test"] : ["test", ...assignments], reportPaths: [output] };
          }
        });
      } catch { notes.push(`${file}: runner_toolchain_unavailable: ${kind}`); }
    }
    return { runners, notes };
  }
};
