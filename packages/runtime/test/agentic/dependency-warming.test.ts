import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateNpmWarmManifests, npmWarmInvocation, warmNpmDependencies } from "../../src/agentic/dependency-warming.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });
const manifest = { name: "fixture", version: "1.0.0", dependencies: { example: "^1.0.0" }, scripts: { postinstall: "touch /tmp/MUST_NOT_RUN" } };
const entry = { version: "1.0.0", resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: "sha512-" + Buffer.alloc(64).toString("base64") };
const lock = () => ({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": manifest, "node_modules/example": entry } });
it("accepts exact integrity-pinned npm registry lockfiles while scripts stay data", () => {
  expect(() => validateNpmWarmManifests(manifest, lock())).not.toThrow();
});
it.each([
  { ...manifest, workspaces: ["packages/*"] }, { ...manifest, overrides: { example: "2.0.0" } },
  { ...manifest, dependencies: { example: "file:../secret" } }, { ...manifest, dependencies: { example: "git+https://example.test/a" } },
  { ...manifest, dependencies: { example: "https://example.test/a.tgz" } }, { ...manifest, dependencies: { example: "npm:other@1" } }
])("rejects dependency resolution outside frozen registry locks: %j", value => expect(() => validateNpmWarmManifests(value, lock())).toThrow());
it.each([
  { ...entry, resolved: "http://registry.npmjs.org/example/-/example-1.tgz" },
  { ...entry, resolved: "https://registry.npmjs.org@evil.test/example.tgz" },
  { ...entry, resolved: "https://evil.test/example.tgz" },
  { ...entry, resolved: "https://registry.npmjs.org/example.tgz?token=secret" },
  { ...entry, integrity: "sha1-weak" }, { ...entry, integrity: undefined }, { ...entry, link: true },
  { ...entry, resolved: undefined }, { ...entry, version: "https://evil.test/package" }
])("rejects unsafe lock entry: %j", value => expect(() => validateNpmWarmManifests(manifest, { ...lock(), packages: { "": manifest, "node_modules/example": value } })).toThrow());
it("validates nested lock entries and paths, including npm v2 legacy resolution records", () => {
  expect(() => validateNpmWarmManifests(manifest, { ...lock(), packages: { "": manifest, "../escape": entry } })).toThrow();
  expect(() => validateNpmWarmManifests(manifest, { ...lock(), lockfileVersion: 1 })).toThrow();
  expect(() => validateNpmWarmManifests(manifest, { ...lock(), lockfileVersion: 2, dependencies: { example: { ...entry, resolved: "file:/etc/passwd" } } })).toThrow();
});
it("network warming mounts only Runtime cache, public system files and narrow toolchain paths", () => {
  const invocation = npmWarmInvocation("/tmp/bflow-cache-owned", "/usr/bin/bwrap", "/opt/node/bin/node", "/opt/node/lib/node_modules/npm");
  expect(invocation.executable).toBe("/usr/bin/bwrap");
  expect(invocation.args).toContain("--share-net");
  expect(invocation.args).toContain("--unshare-all");
  expect(invocation.args.slice(-7)).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress", "--registry=https://registry.npmjs.org", "--cache=/cache/npm-cache"]);
  expect(invocation.env).toMatchObject({ HOME: "/tmp/home", NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_GLOBALCONFIG: "/dev/null", NPM_CONFIG_IGNORE_SCRIPTS: "true" });
  expect(Object.keys(invocation.env)).not.toContain("NPM_TOKEN");
  expect(invocation.args.join(" ")).not.toMatch(/\/home\/|\/run\/|\.npmrc|\.ssh|\.netrc/);
  const writes = invocation.args.flatMap((arg, index) => arg === "--bind" ? [invocation.args.slice(index + 1, index + 3)] : []);
  expect(writes).toEqual([["/tmp/bflow-cache-owned", "/cache"]]);
});
it("rejects a symlinked manifest instead of reading files outside the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-warm-test-")); cleanups.push(root);
  await writeFile(join(root, "actual.json"), JSON.stringify(manifest));
  await symlink("actual.json", join(root, "package.json"));
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock()));
  expect((await warmNpmDependencies(root)).status).toBe("unsupported");
});
it("fails unsupported before side effects when no supported frozen lockfile exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-warm-test-")); cleanups.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  expect((await warmNpmDependencies(root)).status).toBe("unsupported");
  expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual(manifest);
});
const readiness = await probeBehavioralSandbox();
it.skipIf(readiness.status !== "ready")("real isolated no-dependency npm ci leaves the checkout unchanged", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-warm-live-"))); cleanups.push(root);
  const noDependencies = { name: "fixture", version: "1.0.0", scripts: { postinstall: "node -e \"process.exit(99)\"" } };
  await writeFile(join(root, "package.json"), JSON.stringify(noDependencies));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ ...noDependencies, lockfileVersion: 3, packages: { "": noDependencies } }));
  const result = await warmNpmDependencies(root);
  expect(result.status).toBe("ready");
  if (result.status === "ready") { cleanups.push(result.dependencySource); expect(result.dependencySource).not.toBe(root); }
  expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual(noDependencies);
});

it("accepts nested npm v2 records without interpreting nested records as dependency ranges", () => {
  const nested = { ...lock(), lockfileVersion: 2, dependencies: { example: { ...entry, requires: { nested: "^1.0.0" }, dependencies: { nested: entry } } } };
  expect(() => validateNpmWarmManifests(manifest, nested)).not.toThrow();
});
it("rejects nested dependency source changes, weak/malformed SRI and embedded shrinkwrap", () => {
  for (const change of [ {dependencies:{nested:"file:/secret"}}, {hasShrinkwrap:true}, {inBundle:true}, {integrity:"sha512-AAAA"}, {resolved:"https://user:pass@registry.npmjs.org/example.tgz"} ]) expect(() => validateNpmWarmManifests(manifest, {...lock(), packages:{"":manifest,"node_modules/example":{...entry,...change}}})).toThrow();
});

it("rejects broad home/config directories as toolchain mount sources", () => {
  for (const npmRoot of ["/home/user", "/home/user/.config/npm", "/usr", "/"]) expect(() => npmWarmInvocation("/tmp/bflow-owned-cache", "/usr/bin/bwrap", "/opt/node/bin/node", npmRoot)).toThrow();
});
