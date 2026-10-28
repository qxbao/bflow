import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("local-server W00 build entry", () => {
  it("loads the built package without a listener or required host side effect", () => {
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const output = execFileSync(process.execPath, ["--input-type=module", "-e",
      'await import("@bflow/local-server"); console.log("imported")'], { cwd, encoding: "utf8", timeout: 5000 });
    expect(output.trim()).toBe("imported");
  });
});
