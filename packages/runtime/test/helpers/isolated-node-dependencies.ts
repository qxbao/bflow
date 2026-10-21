import { mkdir, readdir, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
/** Stage installed test tools without importing this workspace's packages or running install hooks. */
export async function copyIsolatedNodeDependencies(source: string, target: string): Promise<void> {
  source = await realpath(source);
  const inside = (path: string) => path === source || path.startsWith(source + "/");
  await mkdir(target, { recursive: true });
  // OS recursive copy preserves links and avoids thousands of serial JS copyFile/chmod operations.
  await promisify(execFile)("/bin/cp", ["-R", "-P", source + "/.", target + "/"], { timeout: 30000 });
  const pending = [target];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isSymbolicLink()) {
        const link = await readlink(path);
        const original = join(source, relative(target, path));
        const resolved = await realpath(original);
        // pnpm workspace links must never import packages outside the selected dependency tree.
        if (!inside(resolved)) { await unlink(path); continue; }
        if (isAbsolute(link)) {
          const destination = resolve(target, relative(source, link));
          await unlink(path); await symlink(relative(dirname(path), destination), path);
        }
      }
    }
  }
}
