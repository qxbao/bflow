#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./commands.js";
import type { CliContext, CliExecutionResult } from "./types.js";

export async function main(
  argv?: readonly string[] | undefined,
  context?: CliContext | undefined
): Promise<CliExecutionResult> {
  const args = argv ?? process.argv.slice(2);
  const result = await runCli(args, {
    ...context,
    io: context?.io ?? {
      stdout: (msg) => process.stdout.write(msg + "\n"),
      stderr: (msg) => process.stderr.write(msg + "\n")
    }
  });

  process.exitCode = result.exitCode;
  return result;
}

if (process.argv[1] !== undefined) {
  try {
    const scriptPath = fileURLToPath(import.meta.url);
    let isEntry = false;
    try {
      isEntry = realpathSync(process.argv[1]) === realpathSync(scriptPath);
    } catch {
      isEntry = process.argv[1] === scriptPath || resolve(process.argv[1]) === resolve(scriptPath);
    }
    if (isEntry) {
      void main().catch((err) => {
        process.stderr.write(`Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exitCode = 1;
      });
    }
  } catch {
    // Ignore resolution errors in test environments
  }
}
