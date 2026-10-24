import { execFileSync } from "node:child_process";
/** Resolve the real prerequisite before a test intentionally narrows PATH to its fake tools.
 * Apple's /usr/bin/python3 is older than tomllib; never assume Linux's system Python version. */
export const testPython = execFileSync("python3", ["-c", "import sys,tomllib; assert sys.version_info >= (3,11); print(sys.executable)"],
  { encoding: "utf8", timeout: 5000 }).trim();
