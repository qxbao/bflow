import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { environmentProcessRunner, namedSessionEnvironment } from "../dist/index.js";

// Explicit opt-in: creates only two isolated named test sessions, and stops both in finally.
it.skipIf(process.env["BFLOW_TEST_LIVE_HERDR"] !== "1")("live Herdr: headless named sessions, protocol 22 and selective stop", async () => {
  const dir = await mkdtemp(join(process.platform === "linux" ? "/tmp" : tmpdir(), "bf12-"));
  const baseEnv = { ...process.env, XDG_CONFIG_HOME: join(dir, "cfg"),
    HERDR_CONFIG_PATH: join(dir, "config.toml"), ZDOTDIR: dir };
  await mkdir(baseEnv.XDG_CONFIG_HOME, { recursive: true });
  await writeFile(baseEnv.HERDR_CONFIG_PATH, "# Isolated acceptance smoke configuration\n");
  await writeFile(join(dir, ".zshrc"), "# Do not load the operator's interactive shell configuration\n");
  const invoke = (name: string, args: string[]) => environmentProcessRunner.run({ executable: "herdr", args, cwd: dir,
    env: namedSessionEnvironment(name, baseEnv), timeoutMs: 3000 });
  const status = async (name: string) => {
    const result = await invoke(name, ["status", "server", "--json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const wait = async (name: string, running: boolean) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const observed = await status(name);
      if (observed.running === running) return observed;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`Herdr ${name}: timed out waiting for running=${running}`);
  };
  try {
    for (const name of ["p12a", "p12b"]) {
      expect((await status(name)).running).toBe(false);
      const result = await environmentProcessRunner.run({ executable: "herdr", args: ["server"], cwd: dir,
        env: namedSessionEnvironment(name, baseEnv), mode: "background", logPath: join(dir, `${name}.log`) });
      expect(result.exitCode).toBe(0);
      const started = await wait(name, true);
      expect(started.session).toBe(name); expect(started.protocol).toBe(22); expect(started.compatible).toBe(true);
      console.info(JSON.stringify({ evidence: "herdr-session-started", session: started.session,
        version: started.version, protocol: started.protocol, compatible: started.compatible }));
    }
    expect((await invoke("p12a", ["session", "stop", "p12a", "--json"])).exitCode).toBe(0);
    await wait("p12a", false);
    expect((await status("p12b")).running).toBe(true);
    console.info(JSON.stringify({ evidence: "herdr-selective-stop", stoppedSession: "p12a",
      survivingSession: "p12b", survivingSessionRunning: true, modelAgentsStarted: false }));
  } finally {
    for (const name of ["p12a", "p12b"]) {
      if ((await status(name)).running) {
        await invoke(name, ["session", "stop", name, "--json"]);
        await wait(name, false);
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
