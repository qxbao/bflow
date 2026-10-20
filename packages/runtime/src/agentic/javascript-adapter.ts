import { readFile, realpath, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AdapterContext, AdapterDetection, AdapterRunner, RunnerAdapter } from "./runner-adapter.js";
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** No package script is executed during detection. Installed runner code executes only inside measurement. */
export const javascriptAdapter: RunnerAdapter = {
  id: "javascript",
  async detect(context: AdapterContext): Promise<AdapterDetection> {
    const runners: AdapterRunner[] = [], notes: string[] = [];
    for (const manifest of context.files.filter(file => /(^|\/)package\.json$/.test(file))) {
      const directory = dirname(manifest), absolute = join(context.root, directory);
      const pkg = JSON.parse(await readFile(join(context.root, manifest), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [id, entry, format] of [["jest", "jest/bin/jest.js", "jest_json"], ["mocha", "mocha/bin/mocha.js", "mocha_json"]] as const) {
        if (!deps[id]) continue;
        try {
          const dependencyRoot = directory === "." ? context.dependencySource ?? absolute : absolute;
          const path = join(dependencyRoot, "node_modules", entry), info = await lstat(path);
          if (!info.isFile()) continue;
          const installed = JSON.parse(await readFile(join(dependencyRoot, "node_modules", id, "package.json"), "utf8")) as {version?: string};
          if (!installed.version || !/^\d+\.\d+\.\d+/.test(installed.version)) throw new Error("missing installed runner version");
          const executable = await realpath(process.execPath);
          runners.push({ adapterId: id, version: installed.version, executable, projectDirectory: directory, format,
            nameRule: `${id} full test title: suite titles and test name joined by one space`, mounts: [], environment: { NODE_ENV: "test" }, protectedPaths: [manifest],
            bind(identities, reportDirectory) {
              if (identities.testPaths.some(file => directory !== "." && !file.startsWith(directory + "/"))) throw new Error("Test file belongs to another JavaScript project");
              const files = identities.testPaths.map(file => directory === "." ? file : file.slice(directory.length + 1));
              const pattern = "^(?:" + identities.testNames.map(escape).join("|") + ")$";
              return id === "jest" ? { args: ["node_modules/" + entry, "--runInBand", "--no-cache", "--json", "--outputFile=" + join(reportDirectory, "jest.json"), "--testNamePattern=" + pattern, "--runTestsByPath", ...files], reportPaths: [join(reportDirectory, "jest.json")] }
                : { args: ["node_modules/" + entry, "--reporter=json", "--grep=" + pattern, ...files] };
            }
          });
        } catch (error) { notes.push(`${manifest}: ${id} reporter setup required: ${String(error)}`); }
      }
    }
    return { runners, notes };
  }
};
