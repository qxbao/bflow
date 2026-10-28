import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("resolves real built assets through the Node package export without bundling Node secrets", () => {
  const cwd = fileURLToPath(new URL("../../web", import.meta.url));
  const output = execFileSync(process.execPath, ["--input-type=module", "-e",
    'import { getWebAssetDirectory } from "@bflow/web/assets"; console.log(getWebAssetDirectory())'], { cwd, encoding: "utf8", timeout: 5000 });
  const directory = output.trim();
  expect(resolve(directory)).toBe(join(cwd, "dist/client"));
  expect(statSync(join(directory, "index.html")).isFile()).toBe(true);
  const javascript = readdirSync(join(directory, "assets")).filter(path => path.endsWith(".js"));
  expect(javascript.length).toBeGreaterThan(0);
  for (const file of javascript) {
    const source = readFileSync(join(directory, "assets", file), "utf8");
    expect(source).not.toMatch(/node:crypto|node:fs|hostSessionId|privateKey|BFLOW_HOME/);
  }
});
