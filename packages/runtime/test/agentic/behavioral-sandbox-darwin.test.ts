import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { measureBehavior, parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import { sandboxBehavior } from "../../src/agentic/behavioral-sandbox.js";
import { tmpdir } from "node:os";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "bflow-sbx-")), cwd = join(root, "repo");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(cwd); await mkdir(join(root, ".bflow"));
  const sentinel = join(root, "host-sentinel.txt"), secret = join(root, ".bflow", "secret");
  await writeFile(sentinel, "host sentinel remains unchanged"); await writeFile(secret, "private host credential fixture", { mode: 0o600 });
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Sandbox Test"); git("config", "user.email", "sandbox@example.test");
  const command = parseBehavioralCommands([{ id: "sandbox-test", command: "owner:sandbox-test", executable: process.execPath,
    args: ["--test", "--test-reporter=tap", "behavior.test.cjs"], method: "unit_test", levels: ["unit"],
    testNames: ["sandbox acceptance"], testPaths: ["behavior.test.cjs"], timeoutMs: 10_000 }])[0]!;
  const commit = async (body: string) => {
    await writeFile(join(cwd, "behavior.test.cjs"), `const {test}=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs');\n` +
      `test('sandbox acceptance',async()=>{${body}\n});\n`);
    git("add", "."); git("commit", "-m", "sandbox acceptance fixture"); return git("rev-parse", "HEAD");
  };
  return { root, cwd, sentinel, secret, git, command, commit };
}
async function listen(pathOrPort: string | number) {
  let connections = 0;
  const server = createServer(socket => { connections += 1; socket.destroy(); });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(pathOrPort, "127.0.0.1", accept); });
  cleanup.push(() => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())));
  return { server, connections: () => connections };
}

// Seatbelt (sandbox-exec) counterpart of the Linux boundary tests. It denies contents rather than hiding paths.
describe.skipIf(process.platform !== "darwin")("macOS Seatbelt behavioral sandbox adversarial boundaries", () => {
  it("runs normal Node tests without inheriting host environment, and writes only inside the checkout", async () => {
    const f = await fixture(), revision = await f.commit(`
      assert.equal(2+2,4);
      assert.equal(process.env.BFLOW_SANDBOX_HOST_SECRET,undefined);
      assert.throws(()=>fs.readFileSync(${JSON.stringify(join(f.cwd, ".git", "config"))}));
      const gitFile=fs.readFileSync('.git','utf8').trim().replace(/^gitdir: /,'');
      assert.throws(()=>fs.readFileSync(require('node:path').join(gitFile,'commondir')));
      fs.writeFileSync(require('node:os').tmpdir()+'/scratch.txt','ok');
    `);
    const prior = process.env.BFLOW_SANDBOX_HOST_SECRET; process.env.BFLOW_SANDBOX_HOST_SECRET = "not inherited";
    try { expect((await measureBehavior(f.command, f.cwd, revision)).failed).toBe(0); }
    finally { if (prior === undefined) delete process.env.BFLOW_SANDBOX_HOST_SECRET; else process.env.BFLOW_SANDBOX_HOST_SECRET = prior; }
    expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });
  it("denies reads and writes to host sentinel, .bflow secrets, the home directory and paths outside the checkout", async () => {
    const f = await fixture(), revision = await f.commit(`
      for(const path of ${JSON.stringify([f.sentinel, f.secret, "/etc/passwd", join(homedir(), ".zshrc"), join(homedir(), ".ssh")])}) {
        assert.throws(()=>fs.readFileSync(path)); assert.throws(()=>fs.writeFileSync(path,'compromised'));
      }
      assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(f.root, "new-host-file"))},'compromised'));
      assert.throws(()=>fs.writeFileSync('/tmp/bflow-sbx-escape','compromised'));
      const gitDir=fs.readFileSync('.git','utf8').trim().replace(/^gitdir: /,'');
      assert.throws(()=>fs.writeFileSync(require('node:path').join(gitDir,'HEAD'),'compromised'));
    `);
    expect((await measureBehavior(f.command, f.cwd, revision)).failed).toBe(0);
    expect(await readFile(f.sentinel, "utf8")).toBe("host sentinel remains unchanged");
    expect(await readFile(f.secret, "utf8")).toBe("private host credential fixture");
    await expect(stat(join(f.root, "new-host-file"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat("/tmp/bflow-sbx-escape")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cannot reach host sockets, a host TCP listener or signal host processes", async () => {
    const f = await fixture(), socketPath = join(f.root, "host.sock");
    const unix = await listen(socketPath), tcp = await listen(0);
    const address = tcp.server.address(); if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const actor = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    cleanup.push(async () => { const closed = new Promise<void>(accept => actor.once("exit", () => accept())); actor.kill(); await closed; });
    const revision = await f.commit(`
      const net=require('node:net');
      const denied=options=>new Promise((accept,reject)=>{
        const socket=net.connect(options); socket.setTimeout(1500,()=>{socket.destroy();reject(Error('connect did not fail promptly'));});
        socket.once('connect',()=>{socket.destroy();reject(Error('reached host socket'));}); socket.once('error',()=>accept());
      });
      await denied({path:${JSON.stringify(socketPath)}});
      await denied({host:'127.0.0.1',port:${address.port}});
      assert.throws(()=>process.kill(${actor.pid},'SIGKILL'));
    `);
    expect((await measureBehavior(f.command, f.cwd, revision)).failed).toBe(0);
    expect(unix.connections()).toBe(0); expect(tcp.connections()).toBe(0);
    expect(actor.exitCode).toBeNull();
  });
  it("grants explicit dependencies and the exact executable read-only, including dependency symlink escapes", async () => {
    const f = await fixture(), dependencies = join(f.root, "node_modules"), packageDirectory = join(dependencies, "trusted-fixture");
    await mkdir(packageDirectory, { recursive: true });
    const modulePath = join(packageDirectory, "index.cjs"); await writeFile(modulePath, "module.exports=42;\n");
    await symlink(f.secret, join(packageDirectory, "host-secret-link"));
    // Use a disposable copy so this attack fixture never risks the host's real Node binary.
    const executable = join(f.root, "disposable-node"); await copyFile(await realpath(process.execPath), executable, constants.COPYFILE_FICLONE); await chmod(executable, 0o700);
    const before = await stat(executable);
    const revision = await f.commit(`
      assert.equal(require(${JSON.stringify(modulePath)}),42);
      assert.throws(()=>fs.writeFileSync(${JSON.stringify(modulePath)},'module.exports=0'));
      assert.throws(()=>fs.chmodSync(${JSON.stringify(modulePath)},0o777));
      assert.throws(()=>fs.unlinkSync(${JSON.stringify(modulePath)}));
      assert.throws(()=>fs.readFileSync(${JSON.stringify(join(packageDirectory, "host-secret-link"))}));
      assert.throws(()=>fs.writeFileSync(process.execPath,'compromised'));
      assert.throws(()=>fs.chmodSync(process.execPath,0o777));
      assert.throws(()=>fs.utimesSync(process.execPath,new Date(0),new Date(0)));
    `);
    expect((await measureBehavior({ ...f.command, executable, dependencyRoots: [dependencies] }, f.cwd, revision)).failed).toBe(0);
    expect(await readFile(modulePath, "utf8")).toBe("module.exports=42;\n");
    expect((await stat(executable)).size).toBe(before.size); expect((await stat(executable)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(f.secret, "utf8")).toBe("private host credential fixture");
  });
  it("clones checkout dependency roots read-only", async () => {
    const f = await fixture(), source = join(f.root, "deps"), nodeModules = join(source, "node_modules");
    await mkdir(join(nodeModules, "dep"), { recursive: true }); await writeFile(join(nodeModules, "dep", "index.js"), "module.exports=7;\n");
    await writeFile(join(f.cwd, ".gitignore"), "node_modules\n");
    const revision = await f.commit(`
      assert.equal(require('./node_modules/dep'),7);
      assert.throws(()=>fs.writeFileSync('node_modules/dep/index.js','module.exports=0'));
      assert.throws(()=>fs.writeFileSync('node_modules/dep/new.cjs','x'));
    `);
    const command = { ...f.command, dependencySource: source, checkoutDependencyRoots: ["node_modules"] };
    expect((await measureBehavior(command, f.cwd, revision)).failed).toBe(0);
    expect(await readFile(join(nodeModules, "dep", "index.js"), "utf8")).toBe("module.exports=7;\n");
  });
  it("rejects noncanonical or non-node_modules dependency roots and unavailable executables without fallback", async () => {
    const f = await fixture(); await mkdir(join(f.root, "dependencies"));
    await symlink(join(f.root, "dependencies"), join(f.root, "node_modules"));
    await expect(sandboxBehavior({ ...f.command, dependencyRoots: [join(f.root, "node_modules")] }, f.cwd, f.command.args)).rejects.toThrow("canonical node_modules");
    await expect(sandboxBehavior({ ...f.command, dependencyRoots: [f.root] }, f.cwd, f.command.args)).rejects.toThrow("canonical node_modules");
    const revision = await f.commit(`assert.fail('must not run without the configured executable');`);
    await expect(measureBehavior({ ...f.command, executable: join(f.root, "missing-node") }, f.cwd, revision)).rejects.toThrow();
    expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });
});
