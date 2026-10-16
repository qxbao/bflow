import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GitOrchestrationError, StateSchema, type State } from "./model.js";
import { repositoryLock } from "./lock-context.js";

/** Linux local-filesystem advisory lock. Kernel releases it on crash; never steal PID locks. */
export async function withRepositoryLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true });
  const handle = await open(join(directory, "lock"), "a+", 0o600);
  try {
    // flock locks the shared open-file-description; parent and all Git children retain it.
    await new Promise<void>((resolve, reject) => {
      const child = spawn("flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "pipe", handle.fd] });
      const timer = setTimeout(() => { child.kill(); reject(new GitOrchestrationError("lock_unavailable", "Repository lock timed out")); }, 5000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new GitOrchestrationError("busy", "Repository is busy or Linux flock is unavailable"));
      });
    });
    return await repositoryLock.run(handle.fd, action);
  } finally { await handle.close(); }

}

export async function readState(directory: string, repository: string): Promise<State> {
  let source: string;
  try { source = await readFile(join(directory, "state.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 1, repository, tasks: {}, integrations: {} };
  }
  const state = StateSchema.parse(JSON.parse(source));
  if (state.repository !== repository) throw new GitOrchestrationError("wrong_repository", "Journal belongs to another Git repository");
  return state;
}

export async function writeState(directory: string, state: State): Promise<void> {
  const temporary = join(directory, `state.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(StateSchema.parse(state), null, 2) + "\n");
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await rename(temporary, join(directory, "state.json"));
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally { await rm(temporary, { force: true }); }
}
