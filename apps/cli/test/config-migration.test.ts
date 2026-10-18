import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEnvironmentConfig, identifyRepository, parseConfigYaml, readEnvironmentConfig, runCli } from "../src/index.js";

const dirs: string[] = [];
async function repository(): Promise<{ root: string; subdir: string }> {
  const root = await mkdtemp(join(tmpdir(), "bflow-config-migrate-"));
  dirs.push(root);
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  const subdir = join(root, "nested", "module");
  await mkdir(subdir, { recursive: true });
  await mkdir(join(root, ".bflow"), { recursive: true });
  return { root, subdir };
}

afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("config-migrate", () => {
  it.each(["config.yaml", "config.json"])("migrates %s from a subdirectory, keeps a byte-exact backup, and is idempotent", async legacyName => {
    const { root, subdir } = await repository();
    const identity = await identifyRepository(root);
    const legacy = join(root, ".bflow", legacyName);
    const base = defaultEnvironmentConfig(identity, "kept-name");
    const originalConfig = {
      ...base,
      storage: { ...base.storage, runStorePath: ".bflow/data/custom-runs.db" },
      environment: {
        ...base.environment,
        roles: base.environment.roles.map((role, index) => index === 0 ? { ...role, model: "claude-test-model", effort: "high" as const } : role),
        verification: { maxIterations: 7, onExhausted: "require_human" as const }
      }
    };
    const original = JSON.stringify(originalConfig, null, 2) + "\n";
    await writeFile(legacy, original);
    await writeFile(join(root, ".bflow/state-marker"), "keep runtime state");

    const result = await runCli(["config-migrate"], { cwd: subdir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Migrated repository configuration");
    const target = join(root, ".bflow/config.yml");
    expect(await readFile(`${legacy}.bak`, "utf8")).toBe(original);
    expect(parseConfigYaml(await readFile(target, "utf8"))).toEqual(JSON.parse(original));
    const loaded = await readEnvironmentConfig(identity);
    expect(loaded.projectName).toBe("kept-name");
    expect(loaded.environment.roles[0]).toMatchObject({ model: "claude-test-model", effort: "high" });
    expect(loaded.environment.verification.maxIterations).toBe(7);
    await expect(readFile(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, ".bflow/state-marker"), "utf8")).toBe("keep runtime state");

    const repeat = await runCli(["config-migrate", "--json"], { cwd: subdir });
    expect(repeat.exitCode).toBe(0);
    expect(JSON.parse(repeat.stdout).data.migrated).toBe(false);
    await writeFile(target, "# user edit\n" + await readFile(target, "utf8"));
    const editedRepeat = await runCli(["config-migrate"], { cwd: root });
    expect(editedRepeat.exitCode).toBe(0);
    expect(await readFile(target, "utf8")).toContain("# user edit");
  });

  it("does not clobber an existing target or choose between two legacy sources", async () => {
    const { root } = await repository();
    const target = join(root, ".bflow/config.yml");
    await writeFile(target, "user: target\n");
    await writeFile(join(root, ".bflow/config.yaml"), "bad: legacy\n");
    const conflict = await runCli(["config-migrate"], { cwd: root });
    expect(conflict.exitCode).toBe(1);
    expect(await readFile(target, "utf8")).toBe("user: target\n");

    await rm(target);
    await writeFile(join(root, ".bflow/config.json"), "{}\n");
    const ambiguous = await runCli(["config-migrate"], { cwd: root });
    expect(ambiguous.exitCode).toBe(1);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });

    await rm(join(root, ".bflow/config.json"));
    await rm(join(root, ".bflow/config.yaml"));
    await symlink("missing-target", target);
    await writeFile(join(root, ".bflow/config.yaml"), "legacy: true\n");
    const symlinkConflict = await runCli(["config-migrate"], { cwd: root });
    expect(symlinkConflict.exitCode).toBe(1);
    expect(await readFile(join(root, ".bflow/config.yaml"), "utf8")).toBe("legacy: true\n");
  });

  it("does nothing when init already created the canonical config", async () => {
    const { root } = await repository();
    expect((await runCli(["init"], { cwd: root })).exitCode).toBe(0);
    const target = join(root, ".bflow/config.yml");
    const before = await readFile(target, "utf8");
    const result = await runCli(["config-migrate"], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Already migrated");
    expect(await readFile(target, "utf8")).toBe(before);
  });

  it("refuses init when a legacy config exists without replacing it", async () => {
    const { root } = await repository();
    const legacy = join(root, ".bflow/config.yaml");
    const original = "legacy config bytes\n";
    await writeFile(legacy, original);
    const result = await runCli(["init", "--force"], { cwd: root });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bflow config-migrate");
    expect(await readFile(legacy, "utf8")).toBe(original);
    await expect(readFile(join(root, ".bflow/config.yml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["foreign identity", "duplicate role"]) ("rejects %s before creating target or backup", async defect => {
    const { root } = await repository();
    const identity = await identifyRepository(root);
    const config = defaultEnvironmentConfig(identity, "invalid-migration");
    const invalid = defect === "foreign identity"
      ? { ...config, environment: { ...config.environment, repositoryId: "another-repository" } }
      : { ...config, environment: { ...config.environment, roles: [...config.environment.roles, config.environment.roles[0]!] } };
    const legacy = join(root, ".bflow/config.yaml");
    const original = JSON.stringify(invalid, null, 2) + "\n";
    await writeFile(legacy, original);

    const result = await runCli(["config-migrate"], { cwd: root });
    expect(result.exitCode).toBe(1);
    expect(await readFile(legacy, "utf8")).toBe(original);
    await expect(readFile(join(root, ".bflow/config.yml"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${legacy}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes command help and JSON formatting through the built executable", async () => {
    const { root } = await repository();
    const executable = resolve("apps/cli/dist/bin.js");
    const help = spawnSync(process.execPath, [executable, "config-migrate", "--help"], { cwd: root, encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: bflow config-migrate");
    const json = spawnSync(process.execPath, [executable, "config-migrate", "--json"], { cwd: root, encoding: "utf8" });
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stderr).command).toBe("config-migrate");
  });
});
