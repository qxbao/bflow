import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openFilesystemArtifactStore } from "./test-artifact-store.js";
import { GitIntegrationEngine } from "../src/index.js";
const execute = promisify(execFile);
const temporaryDirectories: string[] = [];
const command = async (cwd: string, ...args: string[]) => (await execute("git", args, { cwd })).stdout.trim();
afterEach(async () => { for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("SIGKILL at persisted merge boundaries", () => {
  for (const point of ["before", "after", "during"] as const) {
    it(`reconciles a process killed ${point} the Git merge without duplicate commits or lost evidence`, async () => {
      const temporary = await mkdtemp(join(tmpdir(), "bflow-p18-crash-")); temporaryDirectories.push(temporary);
      const repository = join(temporary, "repo"), artifacts = join(temporary, "artifacts");
      await mkdir(repository); await command(repository, "init", "-b", "main");
      await command(repository, "config", "user.name", "Bflow crash tests");
      await command(repository, "config", "user.email", "crash@example.invalid");
      await writeFile(join(repository, "initial.txt"), "initial\n"); await command(repository, "add", ".");
      await command(repository, "-c", "commit.gpgSign=false", "commit", "-m", "initial");
      const base = await command(repository, "rev-parse", "HEAD");
      const storeResult = await openFilesystemArtifactStore({ root: artifacts, storeId: "crash-tests" });
      if (!storeResult.ok) throw new Error(storeResult.error.message);
      const store = storeResult.value;
      try {
        const engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store });
        const task = await engine.prepareTask({ runId: "crash-run", taskId: "task", attemptId: "attempt", developerId: "developer",
          ownedPaths: ["new.txt"], baseRevision: base });
        await writeFile(join(task.worktreePath, "new.txt"), "implementation\n");
        await command(task.worktreePath, "add", "."); await command(task.worktreePath, "-c", "commit.gpgSign=false", "commit", "-m", "implementation");
        const changes = await engine.collectTask(task.key);
        const realGit = (await execute("which", ["git"])).stdout.trim();
        const binaries = join(temporary, "bin"); await mkdir(binaries);
        const marker = join(temporary, "crashed"), release = join(temporary, "release");
        // Kill only the isolated engine child. The wrapper then exits so no Git remains in flight.
        const wrapper = `#!${process.execPath}\nimport {execFileSync} from 'node:child_process';\nimport {writeFileSync,existsSync} from 'node:fs';\nconst args=process.argv.slice(2);\nif(args.includes('merge') && args.includes('--no-ff')) {\n if(${JSON.stringify(point)}==='after') execFileSync(${JSON.stringify(realGit)},args,{stdio:'pipe'});\n writeFileSync(${JSON.stringify(marker)},'reached'); process.kill(process.ppid,'SIGKILL');\n if(${JSON.stringify(point)}==='during') { const limit=Date.now()+10000; while(!existsSync(${JSON.stringify(release)}) && Date.now()<limit) await new Promise(r=>setTimeout(r,20)); execFileSync(${JSON.stringify(realGit)},args,{stdio:'pipe'}); } process.exit(0);\n}\ntry { process.stdout.write(execFileSync(${JSON.stringify(realGit)},args,{stdio:['ignore','pipe','pipe']})); } catch(e) { process.stderr.write(e.stderr??''); process.exit(e.status??1); }\n`;
        await writeFile(join(binaries, "git"), wrapper); await chmod(join(binaries, "git"), 0o700);
        const plan = { runId: "crash-run", integrationId: "integration", baseRevision: base, tasks: [{ taskKey: task.key }] };
        const script = join(temporary, "engine.mjs");
        const storePath = fileURLToPath(new URL("./test-artifact-store.ts", import.meta.url));
        await writeFile(script, `import {GitIntegrationEngine} from ${JSON.stringify(fileURLToPath(new URL("../dist/index.js", import.meta.url)))};\nimport {openFilesystemArtifactStore} from ${JSON.stringify(storePath)};\nconst s=await openFilesystemArtifactStore({root:${JSON.stringify(artifacts)},storeId:'crash-tests'});if(!s.ok)throw Error('store');\nconst e=await GitIntegrationEngine.open({repositoryPath:${JSON.stringify(repository)},artifactStore:s.value});\nawait e.beginIntegration(${JSON.stringify(plan)});s.value.close();\n`);
        const child = spawn(process.execPath, [script], { env: { ...process.env, PATH: `${binaries}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
        let diagnostic = ""; child.stderr.on("data", bytes => { diagnostic += bytes; });
        const closed = new Promise<void>(accept => child.once("close", () => accept()));
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
          child.once("error", reject); child.once("exit", (code, signal) => accept({ code, signal }));
        });
        expect(exit, diagnostic).toEqual({ code: null, signal: "SIGKILL" });
        expect(await readFile(marker, "utf8")).toBe("reached");
        if (point === "during") {
          // The inherited kernel lock outlives the dead engine until its Git child finishes.
          await expect(GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store })).rejects.toThrow(/busy|lock/i);
          await writeFile(release, "continue orphan Git");
        }
        await closed;
        // Engine streams close before its orphan Git necessarily exits; wait for the kernel lock.
        await execute("flock", ["--wait", "10", join(engine.stateDirectory, "lock"), "true"]);
        const journal = JSON.parse(await readFile(join(engine.stateDirectory, "state.json"), "utf8"));
        const interrupted = Object.values(journal.integrations)[0] as { key: string; status: string; merged: string[]; worktreePath: string };
        expect(interrupted.status).toBe("merging"); expect(interrupted.merged).toEqual([]);
        const recovered = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store });
        const result = await recovered.resumeIntegration(interrupted.key);
        expect(result.status).toBe("awaiting_verification"); expect(result.merged).toEqual([task.key]);
        expect(result.requests.filter(message => message.type === "verification.requested")).toHaveLength(1);
        expect((await recovered.resumeIntegration(result.key)).requests).toEqual(result.requests);
        expect(await command(repository, "rev-parse", "main")).toBe(base);
        expect(await command(result.worktreePath, "rev-list", "--count", "--merges", `${base}..HEAD`)).toBe("1");
        expect(await command(result.worktreePath, "merge-base", "--is-ancestor", changes.headCommitHash, "HEAD")).toBe("");
        expect(await readFile(join(result.worktreePath, "new.txt"), "utf8")).toBe("implementation\n");
      } finally { store.close(); }
    });
  }
});
