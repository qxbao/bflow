import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const reference = join(testDir, "fixtures/iso/reference/ai-isolator-v0.4.4");
const engine = resolve(testDir, "../isolation/bin/ai-isolator");
const referenceHash = "81d9f3649768d3650c6477df8bafbcc222bccfcf8b53893753ab6ffbf20d8b7d";
const sandboxes: string[] = [];

type ProviderRecord = {
  provider: string;
  argv: string[];
  cwd: string;
  home: string;
  config: string;
  cache: string;
  data: string;
  state: string;
  tmp: string;
  isolator: string;
  tool: string;
  profile: string;
  secrets: Record<string, boolean>;
  lbApiKey?: string;
};

async function sandbox() {
  // The current test runner can itself live in an isolator profile. In that
  // case tmpdir() points inside the real profile, so fall back to the system
  // POSIX temp root. Windows runs skip this POSIX shell-fixture suite below.
  const candidateTmp = tmpdir();
  const realIsolatorRoot = process.env.HOME ? join(process.env.HOME, ".local", "share", "ai-isolator") : "";
  const isolatedTmp = realIsolatorRoot !== "" && candidateTmp.startsWith(realIsolatorRoot);
  const root = await realpath(await mkdtemp(join(isolatedTmp ? "/tmp" : candidateTmp, "bflow-iso-compat-")));
  sandboxes.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const cwd = join(root, "workspace");
  const state = join(root, "state");
  const log = join(root, "providers.jsonl");
  await Promise.all([home, bin, cwd, state, join(root, "tmp"), join(home, ".codex"), join(home, ".claude")].map(path => mkdir(path, { recursive: true })));
  const provider = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const p = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
const auth = path.join(process.env.HOME, '.fixture-auth');
const record = { provider:p, argv, cwd:process.cwd(), home:process.env.HOME,
  config:process.env.XDG_CONFIG_HOME, cache:process.env.XDG_CACHE_HOME,
  data:process.env.XDG_DATA_HOME, state:process.env.XDG_STATE_HOME, tmp:process.env.TMPDIR,
  isolator:process.env.AI_ISOLATOR, tool:process.env.AI_ISOLATOR_TOOL,
  profile:process.env.AI_ISOLATOR_PROFILE,
  secrets:Object.fromEntries(['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','CODEX_HOME',
    'ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL']
    .map(k => [k, Object.hasOwn(process.env, k)])),
  ...(process.env.CODEX_LB_API_KEY ? {lbApiKey:process.env.CODEX_LB_API_KEY} : {}) };
fs.appendFileSync(process.env.ISO_TEST_LOG, JSON.stringify(record)+'\\n');
if (p === 'codex' && argv[0] === 'login' && argv[1] === 'status') process.exit(fs.existsSync(auth) ? 0 : 1);
if (p === 'claude' && argv[0] === 'auth' && argv[1] === 'status') process.exit(fs.existsSync(auth) ? 0 : 1);
if (p === 'claude' && argv[0] === 'auth' && argv[1] === '--help') process.exit(0);
if ((p === 'codex' && argv[0] === 'login') || (p === 'claude' && argv[0] === 'auth' && argv[1] === 'login')) {
  fs.writeFileSync(auth, 'fake-auth-preserved');
}
process.exit(Number(process.env.ISO_PROVIDER_EXIT || 0));
`;
  for (const name of ["codex", "claude"]) {
    await writeFile(join(bin, name), provider, { mode: 0o755 });
  }
  // Deliberately fake all LB probing and container/process discovery. No test can
  // discover a daemon or make a network request on the developer's machine.
  await writeFile(join(bin, "curl"), "#!/bin/sh\n[ \"${ISO_TEST_LB_READY:-0}\" = 1 ]\n", { mode: 0o755 });
  await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(join(bin, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    AI_ISOLATOR_HOME: state,
    AI_ISOLATOR_CODEX_LB_URL: "",
    AI_ISOLATOR_DEFAULT_ALIAS: "",
    TMPDIR: join(root, "tmp"),
    CODEX_HOME: join(home, ".codex"),
    AI_ISOLATOR_CODEX_SKILLS_SOURCE: join(home, ".codex", "skills"),
    AI_ISOLATOR_SHELL: "bash",
    CODEX_LB_API_KEY: "synthetic-lb-key",
    OPENAI_API_KEY: "synthetic-openai-secret",
    CODEX_API_KEY: "synthetic-codex-secret",
    CODEX_ACCESS_TOKEN: "synthetic-codex-token",
    ANTHROPIC_API_KEY: "synthetic-anthropic-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-claude-token",
    ANTHROPIC_AUTH_TOKEN: "synthetic-auth-token",
    ANTHROPIC_BASE_URL: "https://synthetic.invalid",
    ISO_TEST_LOG: log,
    ISO_TEST_LB_READY: "0"
  };
  return { root, home, bin, cwd, state, log, env };
}

async function invoke(cli: "reference" | "engine", box: Awaited<ReturnType<typeof sandbox>>, args: string[], overrides: Record<string, string> = {}) {
  const executable = cli === "reference" ? reference : engine;
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn("bash", [executable, ...args], { cwd: box.cwd, env: { ...box.env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolveResult({ code: code ?? 128, stdout, stderr }));
  });
  return result;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function invokePty(cli: "reference" | "engine", box: Awaited<ReturnType<typeof sandbox>>, args: string[], input: string, overrides: Record<string, string> = {}) {
  const executable = cli === "reference" ? reference : engine;
  const command = ["bash", executable, ...args].map(shellQuote).join(" ");
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult, reject) => {
    // util-linux script provides the TTY needed by the original interactive
    // confirmation flow. This test is explicitly POSIX/Linux scoped below.
    const child = spawn("script", ["-q", "-e", "-c", command, "/dev/null"], {
      cwd: box.cwd,
      env: { ...box.env, TERM: "dumb", NO_COLOR: "1", ...overrides },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolveResult({ code: code ?? 128, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function records(box: Awaited<ReturnType<typeof sandbox>>): Promise<ProviderRecord[]> {
  try { return (await readFile(box.log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as ProviderRecord); }
  catch { return []; }
}

function profilePath(box: Awaited<ReturnType<typeof sandbox>>, tool: "codex" | "claude", name: string) {
  return join(box.state, "profiles", `${tool}--${name}`);
}

async function createAuth(cli: "reference" | "engine", box: Awaited<ReturnType<typeof sandbox>>, tool: "codex" | "claude", name: string) {
  const result = await invoke(cli, box, ["login", tool, "--name", name]);
  expect(result.code, result.stderr).toBe(0);
}

async function setupAlias(box: Awaited<ReturnType<typeof sandbox>>, tool: "codex" | "claude", name: string) {
  const rc = join(box.home, ".bashrc");
  const marker = `${tool}/${name}`;
  await writeFile(rc, `before\n# >>> ai-isolator profile ${marker} >>>\nalias ${tool}-${name}='run ${tool} --name ${name}'\n# <<< ai-isolator profile ${marker} <<<\nafter\n`);
  await writeFile(join(profilePath(box, tool, name), "shell-link.conf"), `shell=bash\nrc=${rc}\nalias=${tool}-${name}\ntarget=${reference}\n`);
  return { rc, marker };
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("ai-isolator v0.4.4 cross-CLI profile compatibility (POSIX Bash fixtures; skipped on Windows)", () => {
  it("pins the unmodified reference script and its provenance", async () => {
    const bytes = await readFile(reference);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(referenceHash);
    expect(await readFile(join(testDir, "fixtures/iso/reference/PROVENANCE.txt"), "utf8")).toContain(referenceHash);
  });

  for (const tool of ["codex", "claude"] as const) {
    it(`preserves ${tool} auth/config/profile layout and literal launch environment in both directions`, async () => {
      for (const [creator, runner] of [["reference", "engine"], ["engine", "reference"]] as const) {
        const box = await sandbox();
        const name = `${tool}-${creator}`;
        await createAuth(creator, box, tool, name);
        const profile = profilePath(box, tool, name);
        await mkdir(join(profile, "config"), { recursive: true });
        await writeFile(join(profile, "config", "private-config.toml"), "private-config-fixture\n");
        const beforeAuth = await readFile(join(profile, "home", ".fixture-auth"), "utf8");
        const beforeProfile = await readFile(join(profile, "profile.env"), "utf8");
        const args = tool === "codex"
          ? ["run", tool, "--name", name, "--no-lb", "--", "--json", "-j", "--help", "literal value"]
          : ["run", tool, "--name", name, "--", "--json", "-j", "--help", "literal value"];
        const result = await invoke(runner, box, args);
        expect(result.code, result.stderr).toBe(0);
        const launched = (await records(box)).filter(record => record.argv.includes("--json") || record.argv.includes("literal value")).at(-1);
        expect(launched).toMatchObject({
          provider: tool,
          argv: tool === "codex" ? ["--json", "-j", "--help", "literal value"] : ["--json", "-j", "--help", "literal value"],
          cwd: box.cwd,
          home: join(profile, "home"),
          config: join(profile, "config"),
          cache: join(profile, "cache"),
          data: join(profile, "data"),
          state: join(profile, "state"),
          tmp: join(profile, "tmp"),
          isolator: "1",
          tool,
          profile: name,
          secrets: Object.fromEntries(["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_HOME", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].map(key => [key, false]))
        });
        expect(await readFile(join(profile, "home", ".fixture-auth"), "utf8")).toBe(beforeAuth);
        expect(await readFile(join(profile, "config", "private-config.toml"), "utf8")).toBe("private-config-fixture\n");
        expect(await readFile(join(profile, "profile.env"), "utf8")).toBe(beforeProfile);
      }
    });
  }

  it("synchronizes Codex skills additively across either CLI", async () => {
    for (const [creator, synchronizer] of [["reference", "engine"], ["engine", "reference"]] as const) {
      const box = await sandbox();
      const name = `skills-${creator}`;
      await createAuth(creator, box, "codex", name);
      const profile = profilePath(box, "codex", name);
      const oldSkill = join(profile, "home", ".codex", "skills", "existing", "SKILL.md");
      const newSkill = join(box.home, ".codex", "skills", "incoming", "SKILL.md");
      await mkdir(dirname(oldSkill), { recursive: true });
      await mkdir(dirname(newSkill), { recursive: true });
      await writeFile(oldSkill, "existing profile skill\n");
      await writeFile(newSkill, "new shared skill\n");
      const result = await invoke(synchronizer, box, ["sync-skills", "--name", name, "--source", join(box.home, ".codex", "skills")]);
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(oldSkill, "utf8")).toBe("existing profile skill\n");
      expect(await readFile(join(profile, "home", ".codex", "skills", "incoming", "SKILL.md"), "utf8")).toBe("new shared skill\n");
    }
  });

  it.skipIf(process.platform !== "linux")("retains generated linked/direct Codex LB metadata across CLIs, forwards overrides, and fails closed when linked LB is down (Linux PTY)", async () => {
    const box = await sandbox();
    const referenceCreated = await invokePty("reference", box, ["codex", "--name", "lb-reference", "--no-login"], "y\nn\n", {
      AI_ISOLATOR_CODEX_LB_URL: "http://127.0.0.1:41234",
      ISO_TEST_LB_READY: "1"
    });
    expect(referenceCreated.code, referenceCreated.stderr).toBe(0);
    const referenceProfile = profilePath(box, "codex", "lb-reference");
    expect(await readFile(join(referenceProfile, "codex-lb.mode"), "utf8")).toBe("linked\n");
    expect(await readFile(join(referenceProfile, "codex-lb.url"), "utf8")).toBe("http://127.0.0.1:41234\n");
    const referenceReads = await invoke("engine", box, ["run", "codex", "--name", "lb-reference", "--", "prompt"], { ISO_TEST_LB_READY: "1" });
    expect(referenceReads.code, referenceReads.stderr).toBe(0);
    const referenceReadCall = (await records(box)).at(-1);
    expect(referenceReadCall?.argv).toContain('model_providers.codex-lb.base_url="http://127.0.0.1:41234/backend-api/codex"');

    const engineCreated = await invokePty("engine", box, ["codex", "--name", "lb-engine", "--no-login"], "y\nn\n", {
      AI_ISOLATOR_CODEX_LB_URL: "http://127.0.0.1:41234",
      ISO_TEST_LB_READY: "1"
    });
    expect(engineCreated.code, engineCreated.stderr).toBe(0);
    const engineProfile = profilePath(box, "codex", "lb-engine");
    expect(await readFile(join(engineProfile, "codex-lb.mode"), "utf8")).toBe("linked\n");
    expect(await readFile(join(engineProfile, "codex-lb.url"), "utf8")).toBe("http://127.0.0.1:41234\n");
    const engineReads = await invoke("reference", box, ["run", "codex", "--name", "lb-engine", "--", "prompt"], { ISO_TEST_LB_READY: "1" });
    expect(engineReads.code, engineReads.stderr).toBe(0);
    const engineReadCall = (await records(box)).at(-1);
    expect(engineReadCall?.argv).toContain('model_providers.codex-lb.base_url="http://127.0.0.1:41234/backend-api/codex"');

    const reverseBox = await sandbox();
    await invoke("reference", reverseBox, ["codex", "--name", "lb", "--no-login", "--no-lb"]);
    const profile = profilePath(reverseBox, "codex", "lb");
    await writeFile(join(profile, "codex-lb.mode"), "linked\n");
    await writeFile(join(profile, "codex-lb.url"), "http://127.0.0.1:41234\n");
    const linked = await invoke("engine", reverseBox, ["run", "codex", "--name", "lb", "--", "prompt"], { ISO_TEST_LB_READY: "1" });
    expect(linked.code, linked.stderr).toBe(0);
    expect(await readFile(join(profile, "codex-lb.mode"), "utf8")).toBe("linked\n");
    expect(await readFile(join(profile, "codex-lb.url"), "utf8")).toBe("http://127.0.0.1:41234\n");
    const linkedCall = (await records(reverseBox)).at(-1);
    expect(linkedCall?.argv).toContain("-c");
    expect(linkedCall?.argv).toContain('model_providers.codex-lb.base_url="http://127.0.0.1:41234/backend-api/codex"');
    expect(linkedCall?.argv).toContain('model_providers.codex-lb.env_key="CODEX_LB_API_KEY"');
    expect(linkedCall?.lbApiKey).toBe("synthetic-lb-key");
    const callCount = (await records(reverseBox)).length;
    const unavailable = await invoke("engine", reverseBox, ["run", "codex", "--name", "lb", "--", "must-not-run"], { ISO_TEST_LB_READY: "0" });
    expect(unavailable.code).toBe(69);
    expect((await records(reverseBox))).toHaveLength(callCount);

    const directBox = await sandbox();
    const directCreated = await invokePty("reference", directBox, ["codex", "--name", "direct", "--no-login"], "n\nn\n", {
      AI_ISOLATOR_CODEX_LB_URL: "http://127.0.0.1:41234",
      ISO_TEST_LB_READY: "1"
    });
    expect(directCreated.code, directCreated.stderr).toBe(0);
    const directProfile = profilePath(directBox, "codex", "direct");
    expect(await readFile(join(directProfile, "codex-lb.mode"), "utf8")).toBe("direct\n");
    const override = await invoke("engine", directBox, ["run", "codex", "--name", "direct", "--lb", "http://127.0.0.1:41234"], { ISO_TEST_LB_READY: "1" });
    expect(override.code, override.stderr).toBe(0);
    expect(await readFile(join(directProfile, "codex-lb.mode"), "utf8")).toBe("direct\n");
    expect((await records(directBox)).at(-1)?.argv).toContain('model_providers.codex-lb.base_url="http://127.0.0.1:41234/backend-api/codex"');
  });

  it.skipIf(process.platform !== "linux")("creates a runnable generated launcher through util-linux script(1) on Linux without the original checkout", async () => {
    const box = await sandbox();
    const name = "generated";
    const created = await invokePty("engine", box, ["claude", "--name", name, "--no-login"], "\n\n");
    expect(created.code, created.stderr).toBe(0);
    const profile = profilePath(box, "claude", name);
    const rc = await readFile(join(box.home, ".bashrc"), "utf8");
    expect(rc).toContain(`# >>> ai-isolator profile claude/${name} >>>`);
    const launcher = await readFile(join(profile, "shell-link.conf"), "utf8");
    const target = launcher.split("\n").find(line => line.startsWith("target="))?.slice("target=".length);
    expect(target).toBe(engine);

    await createAuth("engine", box, "claude", name);
    const alias = "claude-generated -- --launcher-probe";
    const command = `shopt -s expand_aliases; source -- ${shellQuote(join(box.home, ".bashrc"))}; eval ${shellQuote(alias)}`;
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn("bash", ["-c", command], { cwd: box.cwd, env: box.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", code => resolveResult({ code: code ?? 128, stdout, stderr }));
    });
    expect(result.code, result.stderr).toBe(0);
    expect((await records(box)).at(-1)?.argv).toEqual(["--launcher-probe"]);
  });

  it("removes managed shell aliases across both directions without touching surrounding RC content", async () => {
    for (const [creator, remover] of [["reference", "engine"], ["engine", "reference"]] as const) {
      const box = await sandbox();
      const name = `alias-${creator}`;
      await createAuth(creator, box, "claude", name);
      const { rc, marker } = await setupAlias(box, "claude", name);
      const result = await invoke(remover, box, ["remove", "claude", "--name", name]);
      expect(result.code, result.stderr).toBe(0);
      const content = await readFile(rc, "utf8");
      expect(content).toContain("before");
      expect(content).toContain("after");
      expect(content).not.toContain(marker);
      await expect(access(profilePath(box, "claude", name))).rejects.toThrow();
    }
  });

  it("propagates a provider's nonzero exit and does not serialize synthetic secret values", async () => {
    const box = await sandbox();
    await createAuth("reference", box, "claude", "failure");
    const result = await invoke("engine", box, ["run", "claude", "--name", "failure", "--", "--json"], { ISO_PROVIDER_EXIT: "37" });
    expect(result.code).toBe(37);
    const log = await readFile(box.log, "utf8");
    for (const value of ["synthetic-openai-secret", "synthetic-codex-secret", "synthetic-codex-token", "synthetic-anthropic-secret", "synthetic-claude-token", "synthetic-auth-token"]) {
      expect(log).not.toContain(value);
    }
  });

  const builtBin = resolve(testDir, "../dist/bin.js");
  it("requires a built bflow executable, creates profiles with it, and verifies cross-CLI reuse", async () => {
    expect(existsSync(builtBin), "Build the CLI first: pnpm --filter @bflow/cli build").toBe(true);
    const bin = builtBin;
    const box = await sandbox();
    const invokeBuilt = (args: string[], overrides: Record<string, string> = {}) => new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [bin, "iso", ...args], {
        cwd: box.cwd, env: { ...box.env, ...overrides }, stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", code => resolveResult({ code: code ?? 128, stdout, stderr }));
    });
    const login = await invokeBuilt(["login", "claude", "--name", "built"]);
    expect(login.code, login.stderr).toBe(0);
    expect(await readFile(join(profilePath(box, "claude", "built"), "home", ".fixture-auth"), "utf8")).toBe("fake-auth-preserved");
    const result = await invoke("reference", box, ["run", "claude", "--name", "built", "--", "--from-built-profile"]);
    expect(result.code, result.stderr).toBe(0);
    expect((await records(box)).at(-1)?.argv).toEqual(["--from-built-profile"]);
    const builtRun = (overrides: Record<string, string> = {}) => invokeBuilt(["run", "claude", "--name", "built", "--", "--json", "-j", "--help"], overrides);
    const builtResult = await builtRun();
    expect(builtResult.code, builtResult.stderr).toBe(0);
    expect((await records(box)).at(-1)?.argv).toEqual(["--json", "-j", "--help"]);
    const failure = await builtRun({ ISO_PROVIDER_EXIT: "37" });
    expect(failure.code).toBe(37);
  });
});
