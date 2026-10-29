import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { ensureCodexWorkspaceTrust } from "../src/codex-trust.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function home() { const root = await mkdtemp(join(tmpdir(), "codex trust ")); roots.push(root); return root; }
const workspace = '/tmp/repo "quoted" và dấu';

describe("Codex workspace trust", () => {
  it("appends only the trust table, preserving the user's text, comments and mode", async () => {
    const dir = await home(), file = join(dir, "config.toml");
    const original = '# my comment\nmodel = "m"\n\n[projects."/other"]\ntrust_level = "trusted"\n';
    await writeFile(file, original, { mode: 0o640 });
    expect(await ensureCodexWorkspaceTrust(workspace, file)).toBe("trusted");
    const text = await readFile(file, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect((parse(text) as any).projects[workspace].trust_level).toBe("trusted");
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect(await ensureCodexWorkspaceTrust(workspace, file)).toBe("already_trusted");
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("never overrides an explicit decision, an unparsable file or a missing Codex home", async () => {
    const dir = await home(), file = join(dir, "config.toml");
    const untrusted = `[projects.${JSON.stringify(workspace)}]\ntrust_level = "untrusted"\n`;
    await writeFile(file, untrusted);
    expect(await ensureCodexWorkspaceTrust(workspace, file)).toBe("skipped");
    expect(await readFile(file, "utf8")).toBe(untrusted);
    await writeFile(file, "not = = toml");
    expect(await ensureCodexWorkspaceTrust(workspace, file)).toBe("skipped");
    expect(await readFile(file, "utf8")).toBe("not = = toml");
    expect(await ensureCodexWorkspaceTrust(workspace, join(dir, "missing", "config.toml"))).toBe("skipped");
  });

  it("creates a private config when the Codex home exists without one", async () => {
    const dir = await home(), file = join(dir, "config.toml");
    expect(await ensureCodexWorkspaceTrust(workspace, file)).toBe("trusted");
    expect((parse(await readFile(file, "utf8")) as any).projects[workspace].trust_level).toBe("trusted");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
