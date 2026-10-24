import { testPython } from "../../../tests/helpers/python-runtime.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const engine = resolve(import.meta.dirname, "../isolation/bin/ai-isolator");
const sandboxes: string[] = [];

function sandbox() {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "bflow-iso-agy-")));
  sandboxes.push(root);
  const bin = resolve(root, "bin");
  mkdirSync(bin);
  const fake = resolve(bin, "agy");
  writeFileSync(fake, `#!/usr/bin/env bash
: > "$FAKE_AGY_LOG.argv"
if (($#)); then printf '%s\\0' "$@" > "$FAKE_AGY_LOG.argv"; fi
printf 'call\\n' >> "$FAKE_AGY_LOG.calls"
printf 'HOME=%s\\nPWD=%s\\nXDG_CONFIG_HOME=%s\\nXDG_CACHE_HOME=%s\\nXDG_DATA_HOME=%s\\nXDG_STATE_HOME=%s\\nTMPDIR=%s\\n' "$HOME" "$PWD" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$TMPDIR" > "$FAKE_AGY_LOG.env"
for key in AGY_CONFIG_DIR AGY_HOME AGY_API_KEY AGY_AUTH_TOKEN GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_APPLICATION_CREDENTIALS ANTIGRAVITY_API_KEY ANTIGRAVITY_AUTH_TOKEN; do
  if printenv "$key" >/dev/null; then printf '%s=present\\n' "$key" >> "$FAKE_AGY_LOG.env"; else printf '%s=unset\\n' "$key" >> "$FAKE_AGY_LOG.env"; fi
done
printf 'fake agy stdout\\n'
printf 'fake agy stderr\\n' >&2
exit "\${FAKE_AGY_EXIT:-0}"
`);
  chmodSync(fake, 0o755);
  for (const name of ["curl", "wget", "docker", "pgrep"]) {
    writeFileSync(resolve(bin, name), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(resolve(bin, name), 0o755);
  }
  return {
    root,
    bin,
    state: resolve(root, "state"),
    log: resolve(root, "agy-log"),
    profile: resolve(root, "state/profiles/agy--work"),
    env: {
      ...process.env,
      HOME: root,
      AI_ISOLATOR_HOME: resolve(root, "state"),
      FAKE_AGY_LOG: resolve(root, "agy-log"),
      FAKE_AGY_EXIT: "0",
      AGY_CONFIG_DIR: "/real/config",
      AGY_HOME: "/real/agy-home",
      AGY_API_KEY: "account-agy-key",
      AGY_AUTH_TOKEN: "account-agy-token",
      GEMINI_API_KEY: "account-gemini-key",
      GOOGLE_API_KEY: "account-google-key",
      GOOGLE_APPLICATION_CREDENTIALS: "/real/credentials.json",
      ANTIGRAVITY_API_KEY: "account-antigravity-key",
      ANTIGRAVITY_AUTH_TOKEN: "account-antigravity-token",
      AI_ISOLATOR_PY: testPython,
        PATH: `${bin}:/usr/bin:/bin`,
    },
  };
}

function invoke(s: ReturnType<typeof sandbox>, ...args: string[]) {
  return spawnSync("bash", [engine, ...args], { cwd: s.root, env: s.env, encoding: "utf8" });
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Agy isolation profiles", () => {
  it("creates isolated HOME/XDG/TMP, launches literal args in cwd, scrubs inherited auth, and propagates exit", () => {
    const s = sandbox();
    const args = ["--", "--json", "-j", "--help", "two words", "$(touch injected)"];
    s.env.FAKE_AGY_EXIT = "23";
    const result = invoke(s, "run", "agy", "--name", "work", ...args);
    expect(result.status).toBe(23);
    expect(result.stdout).toContain("fake agy stdout");
    expect(result.stderr).toContain("fake agy stderr");
    const recordedArgs = readFileSync(`${s.log}.argv`).toString().split("\0").filter(Boolean);
    expect(recordedArgs).toEqual(args.slice(1));
    const record = readFileSync(`${s.log}.env`, "utf8");
    expect(record).toContain(`HOME=${s.profile}/home`);
    expect(record).toContain(`XDG_CONFIG_HOME=${s.profile}/config`);
    expect(record).toContain(`XDG_CACHE_HOME=${s.profile}/cache`);
    expect(record).toContain(`XDG_DATA_HOME=${s.profile}/data`);
    expect(record).toContain(`XDG_STATE_HOME=${s.profile}/state`);
    expect(record).toContain(`TMPDIR=${s.profile}/tmp`);
    expect(record).toContain(`PWD=${s.root}`);
    for (const key of ["AGY_CONFIG_DIR", "AGY_HOME", "AGY_API_KEY", "AGY_AUTH_TOKEN", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "ANTIGRAVITY_API_KEY", "ANTIGRAVITY_AUTH_TOKEN"]) {
      expect(record).toContain(`${key}=unset`);
    }
    expect(existsSync(resolve(s.profile, "home/.gemini/antigravity-cli"))).toBe(true);
    expect(readFileSync(resolve(s.profile, "profile.env"), "utf8")).toContain("AI_ISOLATOR_TOOL=agy");
  });

  it("opens native Agy onboarding on login and does not issue unsupported auth probes", () => {
    const s = sandbox();
    const login = invoke(s, "login", "agy", "--name", "work");
    expect(login.status).toBe(0);
    expect(readFileSync(`${s.log}.argv`).toString()).toBe("");
    expect(readFileSync(`${s.log}.calls`, "utf8").trim().split("\n")).toHaveLength(1);

    writeFileSync(`${s.log}.argv`, "cleared");
    const status = invoke(s, "status");
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("agy");
    expect(status.stdout).toContain("unverified");
    expect(readFileSync(`${s.log}.argv`, "utf8")).toBe("cleared");
    expect(readFileSync(`${s.log}.calls`, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("supports the direct Agy command and no-login profile setup without launching Agy", () => {
    const s = sandbox();
    const noLogin = invoke(s, "agy", "--name", "work", "--no-login");
    expect(noLogin.status).toBe(0);
    expect(existsSync(`${s.log}.argv`)).toBe(false);
    expect(existsSync(`${s.log}.calls`)).toBe(false);
    expect(existsSync(resolve(s.profile, "home/.gemini/antigravity-cli"))).toBe(true);

    const launch = invoke(s, "agy", "--name", "work", "--", "--version");
    expect(launch.status).toBe(0);
    expect(readFileSync(`${s.log}.argv`).toString().split("\0").filter(Boolean)).toEqual(["--version"]);
    expect(readFileSync(`${s.log}.calls`, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("rejects Codex LB options for Agy and removes Agy profiles idempotently", () => {
    const s = sandbox();
    const badLink = invoke(s, "run", "agy", "--lb", "http://127.0.0.1:9");
    const badNoLink = invoke(s, "run", "agy", "--no-lb");
    expect(badLink.status).toBe(2);
    expect(badNoLink.status).toBe(2);

    expect(invoke(s, "login", "agy", "--name", "work").status).toBe(0);
    expect(readFileSync(`${s.log}.calls`, "utf8").trim().split("\n")).toHaveLength(1);
    expect(invoke(s, "remove", "agy", "--name", "work").status).toBe(0);
    expect(invoke(s, "remove", "agy", "--name", "work").status).toBe(0);
    expect(existsSync(s.profile)).toBe(false);
  });
});
