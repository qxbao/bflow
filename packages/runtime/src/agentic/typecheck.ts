import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { runnerInventory } from "./runner-catalog.js";
import { measureCompiler, type RunnerProfile } from "./behavioral-runner.js";

export interface TypecheckProfile {
  version: string;
  projects: string[];
  runner: RunnerProfile;
}

/** A fixed compiler invocation, never a package script or an agent-supplied command. */
export async function detectTypecheck(root: string, profiles: readonly RunnerProfile[]): Promise<TypecheckProfile | undefined> {
  const base = profiles.find(profile => !profile.adapter && profile.dependencySource === root && profile.checkoutDependencyRoots?.includes("node_modules"));
  if (!base) return;
  const metadata = join(root, "node_modules/typescript/package.json"), compiler = join(root, "node_modules/typescript/bin/tsc");
  try {
    const dependencies = await realpath(join(root, "node_modules")), actual = await realpath(compiler);
    const child = relative(dependencies, actual);
    if (child.startsWith("..") || !(await lstat(actual)).isFile()) return;
    if ((await lstat(metadata)).size > 65536) return;
    const pkg = JSON.parse(await readFile(metadata, "utf8"));
    if (pkg.name !== "typescript" || typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(pkg.version)) return;
    const projects = (await runnerInventory(root)).filter(file => /(^|\/)tsconfig\.json$/.test(file)).map(file => dirname(file));
    if (!projects.length || projects.length > 128) return;
    const { prepare: _prepare, ...compilerBase } = base;
    return { version: pkg.version, projects, runner: { ...compilerBase, id: "auto-typecheck", command: "auto:typecheck",
      args: ["node_modules/typescript/bin/tsc", "-b", ...projects.map(project => project === "." ? "." : `./${project}`), "--pretty", "false", "--force"],
      timeoutMs: 300000 } };
  } catch { return; } // Optional compiler failure must not break behavioral runner discovery.
}

export async function captureTypecheck(profile: TypecheckProfile, cwd: string, revision: string, originalRevision?: string, testPaths: string[] = []) {
  return measureCompiler(profile.runner, cwd, revision, originalRevision, testPaths);
}

const syntaxScript = `const ts=require('typescript'),fs=require('fs');let failed=false;for(const file of process.argv.slice(1)){const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);for(const diagnostic of source.parseDiagnostics||[]){if(diagnostic.category===ts.DiagnosticCategory.Error){failed=true;console.log(file+': '+ts.flattenDiagnosticMessageText(diagnostic.messageText,'\\n'));}}}process.exitCode=failed?1:0;`;
/** Parse every changed TS/TSX file, including tests outside the compiler's project graph. Never executes emitted code. */
export async function captureTypeScriptSyntax(profile: TypecheckProfile, cwd: string, revision: string, files: string[], originalRevision?: string, testPaths: string[] = []) {
  if (files.some(file => file.startsWith("/") || file.includes("\\") || file.split("/").some(part => part === ".." || part === "." || !part) || !/\.[cm]?tsx?$/.test(file)))
    throw new Error("Unsafe TypeScript syntax input");
  return measureCompiler({ ...profile.runner, args: ["-e", syntaxScript, "--", ...files] }, cwd, revision, originalRevision, testPaths);
}
