import { mkdir, readdir, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
/** Stage installed test tools without importing this workspace's packages or running install hooks. */
export async function copyIsolatedNodeDependencies(source: string, target: string, packages?: readonly string[]): Promise<void> {
  source = await realpath(source);
  const inside = (path: string) => path === source || path.startsWith(source + "/");
  await mkdir(target, { recursive: true });
  if (packages) {
    const containers = new Set<string>(), pending: string[] = [];
    const enqueue = (path: string) => {
      const parts = relative(source, path).split("/");
      if (parts[0] !== ".pnpm" || !parts[1] || parts[1] === "node_modules") throw new Error("Selected test tools must resolve into a pnpm package container");
      const container = join(source, ".pnpm", parts[1]);
      if (!containers.has(container)) { containers.add(container); pending.push(container); }
    };
    for (const name of packages) {
      if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) throw new Error("Invalid selected test package");
      const actual = await realpath(join(source, name));
      if (!inside(actual)) throw new Error("Selected test tool escapes the installed dependency tree");
      enqueue(actual);
      const staged = join(target, name);
      await mkdir(dirname(staged), { recursive: true });
      await symlink(relative(dirname(staged), join(target, relative(source, actual))), staged);
    }
    while (pending.length) {
      const container = pending.pop()!, destination = join(target, relative(source, container));
      await mkdir(destination, { recursive: true });
      await promisify(execFile)("/bin/cp", ["-R", "-P", container + "/.", destination + "/"], { timeout: 30000 });
      const directories = [destination];
      while (directories.length) {
        const directory = directories.pop()!;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) directories.push(path);
          else if (entry.isSymbolicLink()) {
            const resolved = await realpath(join(source, relative(target, path)));
            await unlink(path);
            if (!inside(resolved)) continue; // Workspace/external links confer no test-tool dependency authority.
            enqueue(resolved);
            await symlink(relative(dirname(path), join(target, relative(source, resolved))), path);
          }
        }
      }
    }
    return;
  }
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
