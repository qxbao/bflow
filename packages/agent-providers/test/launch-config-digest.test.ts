import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeFileSha256, computeLaunchConfigDigest } from "../src/attestation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function codexConfig(text: string) {
  const root = await mkdtemp(join(tmpdir(), "launch-digest-"));
  roots.push(root);
  await mkdir(join(root, "codex-home"), { mode: 0o700 });
  const path = join(root, "codex-home", "config.toml");
  await writeFile(path, text, { mode: 0o600 });
  return path;
}
const base = 'model = "m"\n\n[projects."/repo"]\ntrust_level = "trusted"\n';

describe("launch config digest", () => {
  it("ignores Codex's own [tui] state but detects governed changes", async () => {
    const path = await codexConfig(base);
    const launched = await computeLaunchConfigDigest(path, "codex");
    await writeFile(path, base + '\n[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\n"m2" = 1\n');
    expect(await computeLaunchConfigDigest(path, "codex")).toBe(launched);
    await writeFile(path, base.replace('"m"', '"other"'));
    expect(await computeLaunchConfigDigest(path, "codex")).not.toBe(launched);
    await writeFile(path, 'model = "m"\n\n[projects."/elsewhere"]\ntrust_level = "trusted"\n');
    expect(await computeLaunchConfigDigest(path, "codex")).not.toBe(launched);
  });

  it("keeps exact byte digests for other files and providers, and for unparsable Codex config", async () => {
    const path = await codexConfig(base);
    expect(await computeLaunchConfigDigest(path, "claude")).toBe(await computeFileSha256(path));
    const prompt = join(path, "..", "prompt.txt");
    await writeFile(prompt, "x", { mode: 0o600 });
    expect(await computeLaunchConfigDigest(prompt, "codex")).toBe(await computeFileSha256(prompt));
    await writeFile(path, "not = = toml");
    expect(await computeLaunchConfigDigest(path, "codex")).toBe(await computeFileSha256(path));
  });
});
