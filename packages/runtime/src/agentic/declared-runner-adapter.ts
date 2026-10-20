import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { RunnerAdapter, AdapterRunner } from "./runner-adapter.js";
const execute = promisify(execFile);
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
        const found = await execute("/bin/sh", ["-c", `command -v ${kind}`], { cwd: "/", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: 5000, maxBuffer: 16384 });
        const executable = await realpath(found.stdout.trim());
        if (executable === context.root || executable.startsWith(context.root + "/")) continue;
        const checked = await execute(executable, ["--version"], { cwd: "/", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }, timeout: 5000, maxBuffer: 16384 });
        if (!/\d+\.\d+/.test(checked.stdout)) continue;
        runners.push({ adapterId: `declared-${kind}`, version: /\d+\.\d+(?:\.\d+)?/.exec(checked.stdout)![0], executable, projectDirectory: project,
          format: "junit", nameRule: "JUnit classname.name; target must honor BFLOW_TEST_NAMES JSON and BFLOW_TEST_FILES JSON", mounts: [], environment: {}, protectedPaths: [file],
          bind(identities, reports) {
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
