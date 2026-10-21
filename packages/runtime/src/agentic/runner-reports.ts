import { lstat, readdir, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Only fresh regular files within the disposable checkout/private report tree can supply evidence. */
export async function collectRunnerReports(patterns: string[], checkout: string, reports: string): Promise<string[]> {
  const output: string[] = [], seen = new Set<string>(); let bytes = 0, visits = 0;
  for (const pattern of patterns) {
    const absolute = resolve(checkout, pattern);
    const base = [reports, checkout].find(root => absolute.startsWith(root + "/"));
    if (!base || pattern.includes("\\") || pattern.includes("\0") || pattern.split("/").includes("..")) throw new Error("Unsafe behavioral report path");
    const segments = relative(base, absolute).split("/");
    const walk = async (directory: string, index: number): Promise<void> => {
      if (++visits > 5000) throw new Error("Behavioral report inventory exceeds bounds");
      const segment = segments[index]!;
      const names = segment.includes("*") ? (await readdir(directory).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; })).filter(name => {
        const regex = new RegExp("^" + segment.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$"); return regex.test(name);
      }) : [segment];
      for (const name of names) {
        if (!name || name === "." || name === "..") throw new Error("Unsafe behavioral report segment");
        const path = join(directory, name);
        const info = await lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
        if (!info) continue;
        if (info.isSymbolicLink() || await realpath(path) !== path) throw new Error("Behavioral reports cannot traverse symlinks");
        if (index + 1 < segments.length) { if (!info.isDirectory()) throw new Error("Invalid report directory"); await walk(path, index + 1); }
        else {
          if (!info.isFile() || info.size > 4_194_304) throw new Error("Invalid or oversized behavioral report");
          if (seen.has(path)) continue; seen.add(path);
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let content: string;
          try {
            const actual = await handle.stat();
            if (!actual.isFile() || actual.size > 4_194_304 || actual.ino !== info.ino || actual.dev !== info.dev) throw new Error("Behavioral report changed during collection");
            const buffer = await handle.readFile(); if (buffer.length > 4_194_304) throw new Error("Behavioral report grew beyond bounds");
            content = buffer.toString("utf8");
          } finally { await handle.close(); }
          bytes += Buffer.byteLength(content);
          if (bytes > 4_194_304 || output.length >= 500) throw new Error("Behavioral report output exceeds bounds");
          output.push(content);
        }
      }
    };
    await walk(base, 0);
  }
  return output;
}
