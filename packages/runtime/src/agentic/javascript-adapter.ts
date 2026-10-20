import { readFile, realpath, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AdapterContext, AdapterDetection, AdapterRunner, RunnerAdapter } from "./runner-adapter.js";
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Installed runner metadata is read only; runner code executes only inside measurement. */
export const javascriptAdapter: RunnerAdapter = {
  id: "javascript",
  async detect(context: AdapterContext): Promise<AdapterDetection> {
    const runners: AdapterRunner[] = [], notes: string[] = [];
    for (const manifest of context.files.filter(file => /(^|\/)package\.json$/.test(file))) {
      const directory = dirname(manifest), absolute = join(context.root, directory);
      let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
      try { pkg = JSON.parse(await readFile(join(context.root, manifest), "utf8")); if (!pkg || typeof pkg !== "object") continue; }
      catch { notes.push(`${manifest}: invalid package manifest`); continue; }
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const base = { executable: await realpath(process.execPath), projectDirectory: directory, mounts: [], environment: { NODE_ENV: "test" }, protectedPaths: [manifest] };
      const selectedFiles = (files: string[]) => files.map(file => {
        if (directory !== "." && !file.startsWith(directory + "/")) throw new Error("Test file belongs to another JavaScript project");
        return directory === "." ? file : file.slice(directory.length + 1);
      });
      if (typeof pkg.scripts?.test === "string" && pkg.scripts.test.includes("node --test")) {
        runners.push({ ...base, adapterId: "node", version: process.version, format: "node_tap", nameRule: "node --test test title only",
          bind(identities) { return { args: ["--test", "--test-reporter=tap", "--test-name-pattern=^(?:" + identities.testNames.map(escape).join("|") + ")$", ...selectedFiles(identities.testPaths)] }; } });
      }
      for (const [id, entry, format] of [["vitest", "vitest/vitest.mjs", "vitest_json"], ["jest", "jest/bin/jest.js", "jest_json"], ["mocha", "mocha/bin/mocha.js", "mocha_json"]] as const) {
        if (!deps[id]) continue;
        try {
          const dependencyRoot = directory === "." ? context.dependencySource ?? absolute : absolute;
          const modules = join(dependencyRoot, "node_modules");
          if (!(await lstat(modules)).isDirectory() || await realpath(modules) !== modules) throw new Error("dependency root is not a canonical directory");
          if (!(await lstat(join(modules, entry))).isFile()) continue;
          const installed = JSON.parse(await readFile(join(modules, id, "package.json"), "utf8")) as { version?: string };
          if (!installed.version || !/^\d+\.\d+\.\d+/.test(installed.version)) throw new Error("missing installed runner version");
          if (id === "vitest" && ![1, 2, 3].includes(Number(installed.version.split(".")[0]))) throw new Error("unsupported Vitest major version");
          runners.push({ ...base, adapterId: id, version: installed.version, format,
            nameRule: `${id} full test title: suite titles and test name joined by one space`,
            bind(identities, reports) {
              const files = selectedFiles(identities.testPaths), pattern = "^(?:" + identities.testNames.map(escape).join("|") + ")$";
              if (id === "vitest") return { args: ["node_modules/" + entry, "run", "--globals", "--reporter=json", "--no-cache", "--maxWorkers=1", "--minWorkers=1", "--testNamePattern=" + pattern, ...files] };
              if (id === "jest") return { args: ["node_modules/" + entry, "--runInBand", "--no-cache", "--json", "--outputFile=" + join(reports, "jest.json"), "--testNamePattern=" + pattern, "--runTestsByPath", ...files], reportPaths: [join(reports, "jest.json")] };
              return { args: ["node_modules/" + entry, "--reporter=json", "--grep=" + pattern, ...files] };
            }
          });
        } catch (error) { notes.push(`${manifest}: ${id} reporter setup required: ${String(error)}`); }
      }
    }
    return { runners, notes };
  }
};
