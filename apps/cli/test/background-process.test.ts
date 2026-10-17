import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBackgroundLogRedactor } from "../src/background-process.js";
import { environmentProcessRunner } from "../dist/environment-process.js";

describe("background log redaction", () => {
  it("redacts complete lines even when credentials and UTF-8 characters cross chunks", () => {
    let output = "";
    const redactor = createBackgroundLogRedactor(line => { output += line; });
    const bytes = Buffer.from("tiếng Việt Authorization: Bearer private-value\npassword=another-secret\n");
    for (const byte of bytes) redactor.append(Buffer.from([byte]));
    redactor.end();
    expect(output).toContain("tiếng Việt");
    expect(output).not.toContain("private-value");
    expect(output).not.toContain("another-secret");
  });
  it("discards multiline private keys and oversized lines without exposing fragments", () => {
    let output = "";
    const redactor = createBackgroundLogRedactor(line => { output += line; }, 128);
    redactor.append(Buffer.from("-----BEGIN PRIVATE KEY-----\nPRIVATEKEYBYTES\n-----END PRIVATE KEY-----\n"));
    redactor.append(Buffer.from("prefix" + "oversized-secret".repeat(100)));
    redactor.append(Buffer.from("suffix\nnormal message\n"));
    redactor.end();
    expect(output).not.toContain("PRIVATEKEYBYTES");
    expect(output).not.toContain("oversized-secret");
    expect(output).not.toContain("suffix");
    expect(output).toContain("normal message");
  });
  it("keeps a detached relay alive and writes only scrubbed private log bytes", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "bflow-background-log-")));
    const path = join(dir, "server.log");
    try {
      const result = await environmentProcessRunner.run({ executable: process.execPath,
        args: ["-e", "process.stdout.write('Authorization: Bea'); setTimeout(() => { process.stdout.write('rer process-secret\\n'); process.stderr.write('DONE\\n'); }, 50)"],
        cwd: dir, mode: "background", logPath: path });
      expect(result.exitCode).toBe(0);
      const deadline = Date.now() + 5000;
      let content = "";
      while (Date.now() < deadline) {
        content = await readFile(path, "utf8");
        if (content.includes("DONE")) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(content).toContain("DONE");
      expect(content).not.toContain("process-secret");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
