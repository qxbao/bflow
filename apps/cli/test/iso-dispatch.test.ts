import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/bin.js";
import { runCli } from "../src/commands.js";
import { runIsolator } from "../src/iso.js";
import { testPython } from "../../../tests/helpers/python-runtime.js";

let previousExitCode: number | undefined;
beforeEach(() => { previousExitCode = process.exitCode; });
afterEach(() => { process.exitCode = previousExitCode; });

describe("bflow iso dispatch", () => {
  it("dispatches iso before the workflow parser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bflow-iso-main-"));
    const engine = join(dir, "ai-isolator");
    writeFileSync(engine, "exit 43\n");
    const result = await main(["iso", "codex", "--", "--json", "--help"], { isoEnginePath: engine });
    expect(result.command).toBe("iso");
    expect(result.exitCode).toBe(43);
    rmSync(dir, { recursive: true, force: true });
  });

  it("routes exported runCli calls too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bflow-iso-runcli-"));
    const engine = join(dir, "ai-isolator");
    writeFileSync(engine, "exit 42\n");
    const result = await runCli(["iso", "help"], { isoEnginePath: engine });
    expect(result.command).toBe("iso");
    expect(result.exitCode).toBe(42);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reserves help iso for the isolation command help", async () => {
    const stdout: string[] = [];
    const result = await main(["help", "iso"], { io: { stdout: value => stdout.push(value), stderr: () => {} } });
    expect(result.ok).toBe(true);
    const helpText = stdout.join("\n");
    expect(helpText).toContain("bflow iso");
    for (const command of ["codex", "claude", "agy", "run <provider>", "login", "status", "sync-skills", "--name NAME", "--all", "remove", "help", "version"]) {
      expect(helpText).toContain(command);
    }
    expect(helpText).toContain("two-way profile compatibility with Codex and Claude");
    expect(helpText).toContain("Agy authentication is unverified");
  });

  it("passes provider flags literally in argv with cwd and inherited environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bflow-iso-dispatch-"));
    const engine = join(dir, "ai-isolator");
    writeFileSync(engine, "#!/bin/sh\n");
    const child = new EventEmitter() as EventEmitter & { pid: number; stdout?: EventEmitter; stderr?: EventEmitter };
    child.pid = process.pid;
    const spawn = vi.fn((_bin: string, _args: readonly string[], _options: unknown) => child);
    try {
      const pending = runIsolator(["codex", "--", "--json", "--help", "a b"], { cwd: dir }, { enginePath: engine, spawn: spawn as never });
      expect(spawn).toHaveBeenCalledWith("bash", [engine, "codex", "--", "--json", "--help", "a b"], expect.objectContaining({ cwd: dir, env: process.env }));
      child.emit("close", 37, null);
      const result = await pending;
      expect(result.exitCode).toBe(37);
      expect(result.ok).toBe(false);
      expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: false, stdio: "inherit" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps child termination signals to conventional numeric statuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bflow-iso-signal-"));
    const engine = join(dir, "ai-isolator");
    writeFileSync(engine, "#!/bin/sh\n");
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = process.pid;
    const spawn = vi.fn(() => child);
    try {
      const pending = runIsolator([], undefined, { enginePath: engine, spawn: spawn as never });
      child.emit("close", null, "SIGQUIT");
      expect((await pending).exitCode).toBe(131);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32" || !existsSync("/usr/bin/script") || !existsSync(new URL("../dist/iso.js", import.meta.url)))(
    "keeps a real controlling TTY available to the Bash engine",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "bflow-iso-pty-"));
      const engine = join(dir, "ai-isolator");
      const harness = join(dir, "harness.mjs");
      const moduleUrl = pathToFileURL(fileURLToPath(new URL("../dist/iso.js", import.meta.url))).href;
      writeFileSync(engine, "python3 -c 'import os; fd=os.open(\"/dev/tty\", os.O_RDWR); os.close(fd); print(\"controlling-tty\")'\n");
      writeFileSync(harness, `import { runIsolator } from ${JSON.stringify(moduleUrl)};\nconst result = await runIsolator([], undefined, { enginePath: process.argv[2] });\nprocess.exitCode = result.exitCode;\n`);
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      try {
        const command = `${quote(process.execPath)} ${quote(harness)} ${quote(engine)}`;
        // BSD script requires its own stdin to be a terminal. Python's PTY supplies a real controlling
        // terminal without assuming util-linux script's incompatible -qec flags or an interactive test runner.
        const result = spawnSync(testPython, ["-c", "import os,pty,sys; status=pty.spawn(sys.argv[1:]); sys.exit(os.waitstatus_to_exitcode(status))",
          "/bin/sh", "-c", command], { encoding: "utf8", timeout: 15000 });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("controlling-tty");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  for (const [signal, expectedExit] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    it.skipIf(process.platform === "win32" || !existsSync("/proc/self/stat"))(
      `stops a provider tree when only built bflow receives ${signal}`,
      async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "bflow-iso-term-tree-"));
      const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
      const copiedDist = join(tempRoot, "dist");
      const binDir = join(tempRoot, "fake-bin");
      const home = join(tempRoot, "home");
      const state = join(tempRoot, "state");
      const pidFile = join(tempRoot, "provider.pid");
      const bashPidFile = join(tempRoot, "engine.pid");
      const engine = join(tempRoot, "isolation", "bin", "ai-isolator");
      const provider = join(binDir, "fake-provider");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(home, { recursive: true });
      mkdirSync(state, { recursive: true });
      cpSync(join(cliRoot, "dist"), copiedDist, { recursive: true });
      cpSync(join(cliRoot, "package.json"), join(tempRoot, "package.json"));
      symlinkSync(join(cliRoot, "node_modules"), join(tempRoot, "node_modules"), "dir");
      mkdirSync(dirname(engine), { recursive: true });
      writeFileSync(engine, "#!/usr/bin/env bash\nprintf '%s' \"$$\" > \"$FAKE_ENGINE_PID_FILE\"\nfake-provider\n");
      writeFileSync(provider, "#!/usr/bin/env python3\nimport os,time\nopen(os.environ['FAKE_PROVIDER_PID_FILE'],'w').write(str(os.getpid()))\ntime.sleep(60)\n");
      chmodSync(provider, 0o755);
      let providerPid: number | undefined;
      let enginePid: number | undefined;
      let child: ReturnType<typeof nodeSpawn> | undefined;
      let closeTimer: NodeJS.Timeout | undefined;
      let startupError: Error | undefined;
      let startupExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let childStderr = "";
      try {
        child = nodeSpawn(process.execPath, [join(copiedDist, "bin.js"), "iso", "codex"], {
          cwd: tempRoot,
          env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            TMPDIR: tempRoot,
            AI_ISOLATOR_HOME: state,
            FAKE_PROVIDER_PID_FILE: pidFile,
            FAKE_ENGINE_PID_FILE: bashPidFile,
            PATH: `${binDir}:${process.env.PATH ?? ""}`
          },
          stdio: ["ignore", "ignore", "pipe"]
        });
        child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { childStderr += chunk; });
        child.once("error", error => { startupError = error; });
        child.once("exit", (code, signal) => { startupExit = { code, signal }; });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
          child!.once("close", (code, signal) => resolve({ code, signal }));
        });
        const startupDeadline = Date.now() + 15000;
        while (!existsSync(pidFile) && Date.now() < startupDeadline) {
          if (startupError !== undefined) {
            throw new Error(`bflow failed to start: ${startupError.message}\nstderr: ${childStderr || "<empty>"}`);
          }
          if (startupExit !== undefined) {
            const exited = await closed;
            throw new Error(`bflow exited before the fake provider started (code=${exited.code}, signal=${exited.signal})\nstderr: ${childStderr || "<empty>"}`);
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!existsSync(pidFile)) {
          const exited = startupExit === undefined ? undefined : await closed;
          throw new Error(`fake provider was not ready within 15 seconds${exited ? ` (bflow code=${exited.code}, signal=${exited.signal})` : ""}\nstderr: ${childStderr || "<empty>"}`);
        }
        if (existsSync(bashPidFile)) enginePid = Number(readFileSync(bashPidFile, "utf8"));
        providerPid = Number(readFileSync(pidFile, "utf8"));
        expect(Number.isSafeInteger(providerPid)).toBe(true);
        child.kill(signal);
        const closeResult = await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error(`bflow did not exit after ${signal}`)), 5000);
            closeTimer.unref();
          })
        ]);
        if (closeTimer !== undefined) clearTimeout(closeTimer);
        expect(closeResult.code).toBe(expectedExit);
        let alive = true;
        for (let attempt = 0; attempt < 100 && alive; attempt++) {
          try { alive = !/\) Z /.test(readFileSync(`/proc/${providerPid}/stat`, "utf8")); }
          catch { alive = false; }
          if (alive) await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(alive).toBe(false);
      } finally {
        if (closeTimer !== undefined) clearTimeout(closeTimer);
        if (enginePid === undefined && existsSync(bashPidFile)) enginePid = Number(readFileSync(bashPidFile, "utf8"));
        if (providerPid !== undefined) {
          try { process.kill(providerPid, "SIGKILL"); } catch { /* already gone */ }
        }
        if (enginePid !== undefined) {
          try { process.kill(enginePid, "SIGKILL"); } catch { /* already gone */ }
        }
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        rmSync(tempRoot, { recursive: true, force: true });
      }
      },
      25000
    );
  }

  it("captures custom IO without dropping chunks from the returned result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bflow-iso-capture-"));
    const engine = join(dir, "ai-isolator");
    writeFileSync(engine, "printf '\\344'; sleep 0.05; printf '\\275\\240'; printf err >&2; exit 37\n");
    const output: string[] = [];
    const errors: string[] = [];
    try {
      const result = await runCli(["iso", "codex", "--", "--json", "--help"], {
        isoEnginePath: engine,
        io: { stdout: value => output.push(value), stderr: value => errors.push(value) }
      });
      expect(result.exitCode).toBe(37);
      expect(result.stdout).toBe("你");
      expect(result.stderr).toBe("err");
      expect(output.join("")).toBe("你");
      expect(errors.join("")).toBe("err");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing Bash executable with an actionable status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bflow-iso-dispatch-"));
    const engine = join(dir, "ai-isolator");
    writeFileSync(engine, "#!/bin/sh\n");
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = process.pid;
    const spawn = vi.fn(() => child);
    try {
      const pending = runIsolator([], undefined, { enginePath: engine, spawn: spawn as never });
      child.emit("error", new Error("spawn bash ENOENT"));
      const result = await pending;
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("could not start Bash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
