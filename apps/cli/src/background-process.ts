import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { redactString } from "@bflow/runtime";

/** Buffer whole lines so stream chunk boundaries cannot split a secret matcher. */
export function createBackgroundLogRedactor(write: (line: string) => void, maxLineLength = 16 * 1024) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let oversized = false;
  let privateKey = false;
  const emit = (line: string) => {
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) {
      privateKey = !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line);
      write("[REDACTED PRIVATE KEY]\n");
    } else if (privateKey) {
      if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) privateKey = false;
    } else write(redactString(line) + "\n");
  };
  const consume = (text: string) => {
    for (const segment of text.split(/(?<=\n)/)) {
      const newline = segment.endsWith("\n");
      if (!oversized) {
        pending += newline ? segment.slice(0, -1) : segment;
        if (pending.length > maxLineLength) { pending = ""; oversized = true; }
      }
      if (newline) {
        if (oversized) write("[REDACTED OVERSIZED LOG LINE]\n");
        else emit(pending);
        pending = ""; oversized = false;
      }
    }
  };
  return {
    append(chunk: Buffer) { consume(decoder.write(chunk)); },
    end() {
      consume(decoder.end());
      if (oversized) write("[REDACTED OVERSIZED LOG LINE]\n");
      else if (pending) emit(pending);
      pending = "";
    }
  };
}

// A detached relay must own the pipes for the server's entire lifetime; the
// invoking CLI can exit immediately without closing its stdout/stderr readers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = process.argv[2];
  if (!executable) process.exitCode = 1;
  else {
    const child = spawn(executable, process.argv.slice(3), { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const write = (line: string) => { try { writeSync(3, line); } catch { /* Logging failure must never print raw output. */ } };
    const stdout = createBackgroundLogRedactor(write), stderr = createBackgroundLogRedactor(write);
    child.stdout.on("data", chunk => stdout.append(chunk));
    child.stderr.on("data", chunk => stderr.append(chunk));
    child.once("error", () => { write("Background process could not start\n"); process.exitCode = 1; });
    child.once("close", code => { stdout.end(); stderr.end(); process.exitCode = code ?? 1; });
  }
}
