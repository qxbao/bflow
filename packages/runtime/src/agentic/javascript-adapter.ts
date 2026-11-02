import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildRunnerNamePattern } from "./node-tap.js";
import { parseNodeTestFlags, type AdapterContext, type AdapterDetection, type AdapterRunner, type RunnerAdapter } from "./runner-adapter.js";
/** Installed runner metadata is read only; runner code executes only inside measurement. */
export const javascriptAdapter: RunnerAdapter = {
  id: "javascript",
  async detect(context: AdapterContext): Promise<AdapterDetection> {
    const runners: AdapterRunner[] = [], notes: string[] = [];
    let rootDeps: Record<string, string> | undefined;
    try {
      const rootPkg = JSON.parse(await readFile(join(context.root, "package.json"), "utf8"));
      rootDeps = { ...rootPkg?.dependencies, ...rootPkg?.devDependencies };
    } catch {}
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
      const nodeFlags = typeof pkg.scripts?.test === "string" ? parseNodeTestFlags(pkg.scripts.test) : [];
      if (nodeFlags !== undefined) {
        runners.push({ ...base, adapterId: "node", version: process.version, format: "node_tap", nameRule: "node --test test title only",
          bind(identities) { return { args: [...nodeFlags, "--test", "--test-reporter=tap", "--test-name-pattern=" + buildRunnerNamePattern(identities.testNames, "node"), ...selectedFiles(identities.testPaths)] }; } });
      }
      for (const [id, entry, format] of [["vitest", "vitest/vitest.mjs", "vitest_json"], ["jest", "jest/bin/jest.js", "jest_json"], ["mocha", "mocha/bin/mocha.js", "mocha_json"]] as const) {
        if (!deps[id] && !rootDeps?.[id]) continue;
        try {
          let dependencyRoot = directory === "." ? context.dependencySource ?? absolute : absolute;
          let modules = join(dependencyRoot, "node_modules");
          let entryFile = join(modules, entry);
          let foundEntry = false;
          try {
            if ((await stat(entryFile)).isFile()) foundEntry = true;
          } catch {}
          if (!foundEntry && directory !== ".") {
            const rootModules = join(context.dependencySource ?? context.root, "node_modules");
            try {
              if ((await stat(join(rootModules, entry))).isFile()) {
                dependencyRoot = context.dependencySource ?? context.root;
                modules = rootModules;
                entryFile = join(modules, entry);
                foundEntry = true;
              }
            } catch {}
          }
          if (!foundEntry) continue;
          const installed = JSON.parse(await readFile(join(modules, id, "package.json"), "utf8")) as { version?: string };
          if (!installed.version || !/^\d+\.\d+\.\d+/.test(installed.version)) throw new Error("missing installed runner version");
          if (id === "vitest" && ![1, 2, 3].includes(Number(installed.version.split(".")[0]))) throw new Error("unsupported Vitest major version");
          runners.push({ ...base, adapterId: id, version: installed.version, format,
            nameRule: `${id} full test title: suite titles and test name joined by one space`,
            bind(identities, reports) {
              const files = selectedFiles(identities.testPaths);
              const pattern = buildRunnerNamePattern(identities.testNames, id === "vitest" ? "vitest" : "suite_full");
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
