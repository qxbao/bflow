import { execFile } from "node:child_process";
import { access, constants, accessSync, statSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseDocument } from "yaml";
import { z } from "zod";
import { WorkflowProposalRejected } from "./workflow-rejection.js";
import type { TestRunnerSource } from "./task-commands.js";
import { measureCompiler, type RunnerProfile } from "./behavioral-runner.js";
import { assertSafeRelativePath } from "./behavioral-sandbox.js";

const execute = promisify(execFile);
const MAX_FILE_SIZE = 1_048_576; // 1MB limit for static checks

export interface AnalyzerContext {
  readonly cwd: string;
  readonly base?: string | undefined;
  readonly revision?: string | undefined;
  readonly runners?: TestRunnerSource | undefined;
}

export interface AnalyzerRunInput {
  readonly cwd: string;
  readonly base?: string | undefined;
  readonly revision: string;
  readonly files: readonly string[];
  readonly deadlineAt?: number | undefined;
  readonly runners?: TestRunnerSource | undefined;
  /** Independently selected test exceptions; runner definitions outside this set remain pinned. */
  readonly testPaths?: readonly string[] | undefined;
}

export interface AnalyzerRunOutput {
  readonly exitCode: number;
  readonly output: string;
}

export interface StaticAnalyzer {
  readonly id: string;
  matches(path: string): boolean;
  detect(context: AnalyzerContext): Promise<{ status: "available" } | { status: "missing"; reason: string }>;
  run(input: AnalyzerRunInput): Promise<AnalyzerRunOutput>;
  readonly executable?: string;
}

export const RESERVED_BUILTIN_ANALYZER_IDS = new Set([
  "whitespace",
  "javascript",
  "json",
  "yaml",
  "github-actions",
  "shell",
  "jvm-compile",
  "xml",
  "typescript"
]);

export const OwnerStaticAnalyzerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  executable: z.string().min(1).max(1024),
  args: z.array(z.string().max(256)).max(32).default([]),
  include: z.array(z.string().min(1).max(256)).min(1).max(64),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000)
}).strict();
export type OwnerStaticAnalyzer = z.infer<typeof OwnerStaticAnalyzerSchema>;

export async function assertTrustedExecutable(executable: string, repoRoot?: string): Promise<string> {
  if (!isAbsolute(executable)) {
    throw new Error(`Executable path must be absolute: ${executable}`);
  }
  if (!/^\/[A-Za-z0-9._/-]+$/.test(executable) || executable.slice(1).split("/").some(p => p === "." || p === ".." || !p)) {
    throw new Error(`Unsafe executable path: ${executable}`);
  }
  let real: string;
  try {
    real = await realpath(executable);
  } catch {
    throw new Error(`Executable not found: ${executable}`);
  }
  const st = await lstat(real);
  if (!st.isFile()) {
    throw new Error(`Executable must be a regular file: ${real}`);
  }
  try {
    await promisify(access)(real, constants.X_OK);
  } catch {
    throw new Error(`File is not executable: ${real}`);
  }
  if (repoRoot !== undefined) {
    const canonicalRepo = await realpath(repoRoot).catch(() => resolve(repoRoot));
    if (
      real === canonicalRepo ||
      real.startsWith(canonicalRepo + "/") ||
      executable === canonicalRepo ||
      executable.startsWith(canonicalRepo + "/") ||
      canonicalRepo === real ||
      canonicalRepo.startsWith(real + "/")
    ) {
      throw new Error(`Executable must be outside repository: ${real}`);
    }
  }
  return real;
}

export function checkExecutableSync(nameOrPath: string, repoRoot?: string): boolean {
  if (isAbsolute(nameOrPath)) {
    try {
      const real = realpathSync(nameOrPath);
      const st = statSync(real);
      if (!st.isFile()) return false;
      accessSync(real, constants.X_OK);
      if (repoRoot !== undefined) {
        let canonicalRepo = repoRoot;
        try { canonicalRepo = realpathSync(repoRoot); } catch { canonicalRepo = resolve(repoRoot); }
        if (
          real === canonicalRepo ||
          real.startsWith(canonicalRepo + "/") ||
          nameOrPath === canonicalRepo ||
          nameOrPath.startsWith(canonicalRepo + "/") ||
          canonicalRepo === real ||
          canonicalRepo.startsWith(real + "/")
        ) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    try {
      const full = join(dir, nameOrPath);
      const st = statSync(full);
      if (st.isFile()) {
        accessSync(full, constants.X_OK);
        return true;
      }
    } catch {
      /* continue search */
    }
  }
  return false;
}

export function parseStaticAnalyzers(input: unknown, repoRoot?: string): OwnerStaticAnalyzer[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("staticAnalyzers must be an array");
  const seenIds = new Set<string>();
  return input.map(item => {
    const parsed = OwnerStaticAnalyzerSchema.parse(item);
    if (RESERVED_BUILTIN_ANALYZER_IDS.has(parsed.id)) {
      throw new Error(`Owner static analyzer ID '${parsed.id}' is reserved for built-in analyzer`);
    }
    if (seenIds.has(parsed.id)) {
      throw new Error(`Duplicate static analyzer id: ${parsed.id}`);
    }
    seenIds.add(parsed.id);
    if (!isAbsolute(parsed.executable)) {
      throw new Error(`Static analyzer ${parsed.id} executable must be an absolute path`);
    }
    for (const inc of parsed.include) {
      if (isAbsolute(inc) || inc.includes("..") || inc.includes("\0") || inc.startsWith("/")) {
        throw new Error(`Static analyzer ${parsed.id} include glob must be a safe repository-relative path: ${inc}`);
      }
    }
    for (const arg of parsed.args) {
      if (arg.includes("\0") || /[;&|`]/.test(arg)) {
        throw new Error(`Static analyzer ${parsed.id} argument contains unsafe characters: ${arg}`);
      }
    }
    if (repoRoot !== undefined) {
      const canonicalRepo = resolve(repoRoot);
      const canonicalExec = resolve(parsed.executable);
      if (canonicalExec === canonicalRepo || canonicalExec.startsWith(canonicalRepo + "/")) {
        throw new Error(`Static analyzer ${parsed.id} executable must be outside the repository`);
      }
    }
    return parsed;
  });
}

async function gitShowBlob(cwd: string, revision: string, file: string): Promise<string> {
  const { stdout } = await execute(await trustedTool("git", cwd), ["--no-pager", "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false", "show", "--no-textconv", `${revision}:${file}`], {
    cwd,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
    maxBuffer: MAX_FILE_SIZE + 1024,
    timeout: 10_000
  });
  return stdout;
}

async function trustedTool(name: string, cwd: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try { return await assertTrustedExecutable(join(directory, name), cwd); }
    catch { /* A repository-local or unusable executable is not an analyzer toolchain. */ }
  }
  throw new Error(`Static analyzer tool unavailable: ${name}`);
}

function scriptShell(file: string, content: string): "sh" | "bash" {
  const shebang = /^#!\s*(\S+)([^\r\n]*)/.exec(content);
  if (!shebang) return /\.bash$/i.test(file) ? "bash" : "sh";
  let name = basename(shebang[1]!);
  if (name === "env") {
    const args = shebang[2]!.trim().split(/\s+/);
    name = args[0] === "-S" ? args[1] ?? "" : args[0] ?? "";
  }
  if (name !== "sh" && name !== "bash") throw new Error(`Unsupported shell interpreter: ${name}`);
  return name;
}

export function checkBalancedExpressions(text: string): boolean {
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf("${{", pos);
    if (start === -1) break;
    const end = text.indexOf("}}", start + 3);
    if (end === -1) return false;
    const nextStart = text.indexOf("${{", start + 3);
    if (nextStart !== -1 && nextStart < end) return false;
    pos = end + 2;
  }
  return true;
}

export const whitespaceAnalyzer: StaticAnalyzer = {
  id: "whitespace",
  matches: () => true,
  detect: async () => ({ status: "available" }),
  run: async ({ cwd, base, revision }) => {
    try {
      const args = base ? ["diff", "--check", base, revision, "--"] : ["diff", "--check", `${revision}^!`, "--"];
      const { stdout } = await execute(await trustedTool("git", cwd), args, { cwd, encoding: "utf8", timeout: 15_000 });
      return { exitCode: 0, output: stdout.trim() || "Whitespace check passed" };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        output: ((failure.stdout ?? "") + (failure.stderr ?? "")).trim() || String(error)
      };
    }
  }
};

export const javascriptAnalyzer: StaticAnalyzer = {
  id: "javascript",
  matches: path => /\.[cm]?js$/i.test(path),
  detect: async () => ({ status: "available" }),
  run: async ({ cwd, revision, files }) => {
    const checked: string[] = [];
    for (const file of files) {
      try {
        const content = await gitShowBlob(cwd, revision, file);
        if (Buffer.byteLength(content) > MAX_FILE_SIZE) {
          return { exitCode: 1, output: `File ${file} exceeds maximum size limit (1MB)` };
        }
        const child = execute(process.execPath, ["--check", "-"], { timeout: 10_000 });
        child.child.stdin?.write(content);
        child.child.stdin?.end();
        await child;
        checked.push(file);
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          output: `JavaScript syntax error in ${file}: ${((failure.stdout ?? "") + (failure.stderr ?? "")).trim() || String(error)}`
        };
      }
    }
    return { exitCode: 0, output: `JavaScript syntax check passed for ${checked.join(", ")}` };
  }
};

export const jsonAnalyzer: StaticAnalyzer = {
  id: "json",
  matches: path => /\.json$/i.test(path),
  detect: async () => ({ status: "available" }),
  run: async ({ cwd, revision, files }) => {
    const checked: string[] = [];
    for (const file of files) {
      try {
        const content = await gitShowBlob(cwd, revision, file);
        if (Buffer.byteLength(content) > MAX_FILE_SIZE) {
          return { exitCode: 1, output: `File ${file} exceeds maximum size limit (1MB)` };
        }
        JSON.parse(content);
        checked.push(file);
      } catch (error) {
        return {
          exitCode: 1,
          output: `JSON syntax error in ${file}: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
    return { exitCode: 0, output: `JSON syntax check passed for ${checked.join(", ")}` };
  }
};

export const yamlAnalyzer: StaticAnalyzer = {
  id: "yaml",
  matches: path => /\.(ya?ml)$/i.test(path) && !/(^|\/)\.github\/workflows\//.test(path),
  detect: async () => ({ status: "available" }),
  run: async ({ cwd, revision, files }) => {
    const checked: string[] = [];
    for (const file of files) {
      try {
        const content = await gitShowBlob(cwd, revision, file);
        if (Buffer.byteLength(content) > MAX_FILE_SIZE) {
          return { exitCode: 1, output: `File ${file} exceeds maximum size limit (1MB)` };
        }
        const doc = parseDocument(content, { uniqueKeys: true });
        if (doc.errors.length > 0 || doc.warnings.length > 0) {
          const msgs = [...doc.errors, ...doc.warnings].map(e => e.message);
          return { exitCode: 1, output: `YAML parse error in ${file}:\n${msgs.join("\n")}` };
        }
        checked.push(file);
      } catch (error) {
        return {
          exitCode: 1,
          output: `YAML parse error in ${file}: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
    return { exitCode: 0, output: `YAML check passed for ${checked.join(", ")}` };
  }
};

export const githubActionsAnalyzer: StaticAnalyzer = {
  id: "github-actions",
  matches: path => /(^|\/)\.github\/workflows\/.*\.ya?ml$/i.test(path),
  detect: async () => ({ status: "available" }),
  run: async ({ cwd, revision, files }) => {
    const checked: string[] = [];
    for (const file of files) {
      try {
        const content = await gitShowBlob(cwd, revision, file);
        if (Buffer.byteLength(content) > MAX_FILE_SIZE) {
          return { exitCode: 1, output: `Workflow file ${file} exceeds maximum size limit (1MB)` };
        }
        const doc = parseDocument(content, { uniqueKeys: true });
        if (doc.errors.length > 0 || doc.warnings.length > 0) {
          const msgs = [...doc.errors, ...doc.warnings].map(e => e.message);
          return { exitCode: 1, output: `Workflow YAML error in ${file}:\n${msgs.join("\n")}` };
        }
        const obj = doc.toJSON();
        if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
          return { exitCode: 1, output: `Workflow ${file} root must be a YAML object` };
        }
        const hasTrigger = obj.on !== undefined || obj["true"] !== undefined;
        if (!hasTrigger) {
          return { exitCode: 1, output: `Workflow ${file} missing top-level 'on' trigger definition` };
        }
        const jobs = obj.jobs;
        if (jobs === null || typeof jobs !== "object" || Array.isArray(jobs) || Object.keys(jobs).length === 0) {
          return { exitCode: 1, output: `Workflow ${file} missing or empty 'jobs' definition` };
        }
        for (const [jobId, jobRaw] of Object.entries(jobs)) {
          if (jobRaw === null || typeof jobRaw !== "object" || Array.isArray(jobRaw)) {
            return { exitCode: 1, output: `Job '${jobId}' in ${file} must be an object` };
          }
          const job = jobRaw as Record<string, unknown>;
          const isReusableCall = typeof job.uses === "string";
          const hasRunsOn = typeof job["runs-on"] === "string" || Array.isArray(job["runs-on"]) ||
            (job["runs-on"] !== null && typeof job["runs-on"] === "object");

          if (isReusableCall) {
            if (job.steps !== undefined) {
              return { exitCode: 1, output: `Job '${jobId}' in ${file} calls reusable workflow (${job.uses}) and cannot specify 'steps'` };
            }
          } else {
            if (!hasRunsOn) {
              return { exitCode: 1, output: `Job '${jobId}' in ${file} must specify 'runs-on'` };
            }
            if (!Array.isArray(job.steps) || job.steps.length === 0) {
              return { exitCode: 1, output: `Ordinary job '${jobId}' in ${file} must specify a non-empty 'steps' array` };
            }
            for (let i = 0; i < job.steps.length; i++) {
              const step = job.steps[i];
              if (step === null || typeof step !== "object" || Array.isArray(step)) {
                return { exitCode: 1, output: `Step ${i} in job '${jobId}' of ${file} must be an object` };
              }
              const stepObj = step as Record<string, unknown>;
              const hasRun = typeof stepObj.run === "string";
              const hasUses = typeof stepObj.uses === "string";
              if (!hasRun && !hasUses) {
                return { exitCode: 1, output: `Step ${i} in job '${jobId}' of ${file} must specify 'run' or 'uses'` };
              }
              if (hasRun && hasUses) {
                return { exitCode: 1, output: `Step ${i} in job '${jobId}' of ${file} cannot specify both 'run' and 'uses'` };
              }
            }
          }
        }
        if (!checkBalancedExpressions(content)) {
          return { exitCode: 1, output: `Workflow ${file} contains unbalanced \${{ ... }} expression delimiters` };
        }
        checked.push(file);
      } catch (error) {
        return { exitCode: 1, output: `GitHub Actions workflow validation error in ${file}: ${String(error)}` };
      }
    }
    return {
      exitCode: 0,
      output: `Phân tích cú pháp và cấu trúc. Không chứng minh hành vi CI. Workflow check passed for ${checked.join(", ")}`
    };
  }
};

export const shellAnalyzer: StaticAnalyzer = {
  id: "shell",
  matches: path => /\.(sh|bash)$/i.test(path),
  detect: async ({ cwd }) => {
    for (const shell of ["sh", "bash"]) {
      try { await trustedTool(shell, cwd); return { status: "available" }; }
      catch { /* Probe only trusted system paths; never execute a PATH-provided which. */ }
    }
    return { status: "missing", reason: "Neither bash nor sh is installed on PATH" };
  },
  run: async ({ cwd, revision, files, deadlineAt }) => {
    const checked: string[] = [];
    for (const file of files) {
      try {
        const content = await gitShowBlob(cwd, revision, file);
        if (Buffer.byteLength(content) > MAX_FILE_SIZE) {
          return { exitCode: 1, output: `File ${file} exceeds maximum size limit (1MB)` };
        }
        assertSafeRelativePath(file, "shell analyzer input");
        const executable = await trustedTool(scriptShell(file, content), cwd);
        const timeoutMs = Math.min(10_000, deadlineAt === undefined ? 10_000 : deadlineAt - Date.now());
        if (timeoutMs <= 0) return { exitCode: 1, output: "Shell syntax analysis deadline expired" };
        const result = await measureCompiler({ id: "static-shell", command: "static:shell", executable,
          args: ["-n", `./${file}`], method: "integration_test", levels: ["integration"],
          reporter: "node_tap", timeoutMs }, cwd, revision);
        if (result.exitCode !== 0) return { exitCode: result.exitCode, output: `Shell syntax error in ${file}: ${result.output}` };
        checked.push(file);
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          output: `Shell syntax error in ${file}: ${((failure.stdout ?? "") + (failure.stderr ?? "")).trim() || String(error)}`
        };
      }
    }
    return { exitCode: 0, output: `Shell syntax check passed for ${checked.join(", ")}` };
  }
};

export type CompilerRunner = (profile: RunnerProfile, cwd: string, revision: string,
  originalRevision?: string, testPaths?: string[]) => Promise<{ exitCode: number; output: string }>;

export function createJvmCompileAnalyzer(compilerRunner: CompilerRunner = measureCompiler): StaticAnalyzer {
  return {
    id: "jvm-compile",
    matches: path => /\.(java|kt)$/i.test(path) || /(^|\/)pom\.xml$/i.test(path) || /(^|\/)build\.gradle(\.kts)?$/i.test(path),
    detect: async context => {
      const profiles = context.runners?.current?.status === "detected" ? context.runners.current.profiles : (context.runners?.profiles ?? []);
      const hasMaven = profiles.some(p => p.adapter?.adapterId === "maven" || p.id.includes("maven") || p.command.includes("maven"));
      const hasGradle = profiles.some(p => p.adapter?.adapterId === "gradle" || p.id.includes("gradle") || p.command.includes("gradle"));
      if (hasMaven || hasGradle) return { status: "available" };
      return { status: "missing", reason: "No detected Maven or Gradle runner available for JVM compilation check" };
    },
    run: async ({ cwd, base, revision, files, deadlineAt, runners, testPaths = [] }) => {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        return {
          exitCode: 1,
          output: "JVM compile check deadline expired (budget exhausted)"
        };
      }
      const remainingBudget = deadlineAt === undefined ? 300_000 : deadlineAt - Date.now() - 30_000;
      if (remainingBudget <= 0) {
        return {
          exitCode: 1,
          output: "JVM compile check deadline expired before execution"
        };
      }

      try {
        for (const file of files) {
          await gitShowBlob(cwd, revision, file);
        }
      } catch (error) {
        return {
          exitCode: 1,
          output: `JVM compile check cannot read committed file at revision ${revision}: ${String(error)}`
        };
      }

      const profiles = runners?.profilesForRevision(base ?? revision) ?? runners?.profiles ?? [];
      const jvmProfiles = profiles.filter(p => p.adapter?.adapterId === "maven" || p.adapter?.adapterId === "gradle" || p.id.includes("maven") || p.id.includes("gradle"));
      if (!jvmProfiles.length) {
        return {
          exitCode: 1,
          output: "No detected Maven or Gradle runner available for JVM compilation check"
        };
      }

      // Map each file to its corresponding JVM profile
      const fileToProfile = new Map<string, RunnerProfile>();
      const rootReactor = jvmProfiles.find(p => (p.adapter?.projectDirectory ?? ".") === ".");

      for (const file of files) {
        const matchingProfiles = jvmProfiles.filter(p => {
          const proj = p.adapter?.projectDirectory ?? ".";
          if (proj === ".") return true;
          return file === proj || file.startsWith(`${proj}/`);
        });
        if (matchingProfiles.length === 0) {
          return {
            exitCode: 1,
            output: `File ${file} does not belong to any detected JVM project`
          };
        }
        // Prefer specific project directory over root aggregator
        const specific = matchingProfiles.filter(p => (p.adapter?.projectDirectory ?? ".") !== ".")
          .sort((a, b) => b.adapter!.projectDirectory.length - a.adapter!.projectDirectory.length)[0];
        fileToProfile.set(file, specific ?? rootReactor ?? matchingProfiles[0]!);
      }

      // Group files by unique profile
      const profilesToRun = new Map<string, { profile: RunnerProfile; files: string[] }>();
      for (const [file, prof] of fileToProfile) {
        const key = prof.id;
        const entry = profilesToRun.get(key) ?? { profile: prof, files: [] };
        entry.files.push(file);
        profilesToRun.set(key, entry);
      }

      const outputs: string[] = [];
      for (const { profile: jvmProfile, files: projFiles } of profilesToRun.values()) {
        const projectBudget = deadlineAt === undefined ? remainingBudget : deadlineAt - Date.now() - 30_000;
        if (projectBudget <= 0) return { exitCode: 1, output: "JVM compile check deadline expired before execution" };
        const isMaven = jvmProfile.adapter?.adapterId === "maven" || jvmProfile.id.includes("maven");
        const compileArgs = isMaven
          ? ["--offline", "--batch-mode", "--no-transfer-progress", "-Dmaven.repo.local=/bflow-cache/maven", "test-compile"]
          : ["--offline", "--no-daemon", "--console=plain", "--no-build-cache", "testClasses"];

        const timeoutMs = Math.min(
          jvmProfile.timeoutMs ?? 300_000,
          projectBudget
        );

        const compileRunnerProfile: RunnerProfile = {
          ...jvmProfile,
          id: `${jvmProfile.id}-compile`,
          command: `${jvmProfile.command}:compile`,
          args: compileArgs,
          timeoutMs,
          ...(jvmProfile.adapter ? {
            adapter: {
              ...jvmProfile.adapter,
              bind: () => ({
                args: compileArgs,
                reportPaths: []
              })
            }
          } : {})
        };

        try {
          const result = await compilerRunner(compileRunnerProfile, cwd, revision, base, [...testPaths]);
          if (result.exitCode !== 0) {
            return {
              exitCode: result.exitCode,
              output: result.output || `JVM compilation structure check failed for ${jvmProfile.adapter?.projectDirectory ?? jvmProfile.id} with exit code ${result.exitCode}`
            };
          }
          outputs.push(result.output || `JVM compilation structure check passed for ${projFiles.join(", ")}`);
        } catch (error) {
          return {
            exitCode: 1,
            output: `JVM compilation infrastructure failure in ${jvmProfile.adapter?.projectDirectory ?? jvmProfile.id}: ${error instanceof Error ? error.message : String(error)}`
          };
        }
      }

      return {
        exitCode: 0,
        output: outputs.join("; ")
      };
    }
  };
}

export const jvmCompileAnalyzer: StaticAnalyzer = createJvmCompileAnalyzer();

export const xmlAnalyzer: StaticAnalyzer = {
  id: "xml",
  matches: path => /\.xml$/i.test(path) && !/(^|\/)pom\.xml$/i.test(path),
  detect: async ({ cwd }) => {
    try { await trustedTool("xmllint", cwd); return { status: "available" }; }
    catch { return { status: "missing", reason: "No trusted xmllint installed outside the repository" }; }
  },
  run: async ({ cwd, revision, files, deadlineAt }) => {
    const checked: string[] = [];
    const outputs: string[] = [];
    for (const file of files) {
      try {
        const content = await gitShowBlob(cwd, revision, file);
        if (Buffer.byteLength(content) > MAX_FILE_SIZE) return { exitCode: 1, output: `XML file ${file} exceeds maximum size limit (1MB)` };
        assertSafeRelativePath(file, "XML analyzer input");
        const executable = await trustedTool("xmllint", cwd);
        const timeoutMs = Math.min(10_000, deadlineAt === undefined ? 10_000 : deadlineAt - Date.now());
        if (timeoutMs <= 0) return { exitCode: 1, output: "XML analysis deadline expired" };
        const result = await measureCompiler({ id: "static-xml", command: "static:xml", executable,
          args: ["--nonet", "--noout", `./${file}`], method: "integration_test", levels: ["integration"],
          reporter: "node_tap", timeoutMs }, cwd, revision);
        if (result.exitCode !== 0) return { exitCode: result.exitCode, output: `XML validation error in ${file}: ${result.output}` };
        if (result.output) outputs.push(result.output);
        checked.push(file);
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          output: `XML validation error in ${file}: ${((failure.stdout ?? "") + (failure.stderr ?? "")).trim() || String(error)}`
        };
      }
    }
    return { exitCode: 0, output: `XML check passed for ${checked.join(", ")}${outputs.length ? `\n${outputs.join("\n").slice(0, 4096)}` : ""}` };
  }
};

export type OwnerAnalyzerRunner = (cfg: OwnerStaticAnalyzer, cwd: string, revision: string, files: readonly string[], deadlineAt?: number) => Promise<AnalyzerRunOutput>;

export function globToRegex(pattern: string): RegExp {
  let p = pattern;
  let prefix = "";
  if (p.startsWith("**/")) {
    prefix = "(?:.*\\/)?";
    p = p.slice(3);
  }
  const normalized = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\/\*\*\//g, "(?:/.*)?/")
    .replace(/\*\*/g, ".*")
    .replace(/(?<!\.)\*/g, "[^/]*");
  return new RegExp(`^${prefix}${normalized}$`);
}

export function createOwnerAnalyzer(cfg: OwnerStaticAnalyzer, repoRoot?: string, customRunner?: OwnerAnalyzerRunner): StaticAnalyzer {
  if (RESERVED_BUILTIN_ANALYZER_IDS.has(cfg.id)) {
    throw new Error(`Owner static analyzer ID '${cfg.id}' is reserved for built-in analyzer`);
  }
  const globs = cfg.include.map(globToRegex);

  return {
    id: cfg.id,
    executable: cfg.executable,
    matches: path => globs.some(g => g.test(path)),
    detect: async context => {
      try {
        await assertTrustedExecutable(cfg.executable, repoRoot ?? context?.cwd);
        return { status: "available" };
      } catch (error) {
        return { status: "missing", reason: `Owner analyzer ${cfg.id} executable invalid: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    run: async ({ cwd, revision, files, deadlineAt }) => {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt)
        return { exitCode: 1, output: `Owner analyzer ${cfg.id} deadline expired` };
      try {
        await assertTrustedExecutable(cfg.executable, repoRoot);
        if (cwd) {
          await assertTrustedExecutable(cfg.executable, cwd);
        }
      } catch (error) {
        return {
          exitCode: 1,
          output: `Owner analyzer ${cfg.id} executable invalid: ${error instanceof Error ? error.message : String(error)}`
        };
      }

      try {
        for (const file of files) {
          await gitShowBlob(cwd, revision, file);
        }
      } catch (error) {
        return {
          exitCode: 1,
          output: `Owner analyzer ${cfg.id} cannot read committed file at revision ${revision}: ${String(error)}`
        };
      }

      if (customRunner) {
        if (deadlineAt !== undefined && Date.now() >= deadlineAt)
          return { exitCode: 1, output: `Owner analyzer ${cfg.id} deadline expired` };
        return customRunner(cfg, cwd, revision, files, deadlineAt);
      }

      const timeoutMs = Math.min(
        cfg.timeoutMs,
        deadlineAt === undefined ? cfg.timeoutMs : deadlineAt - Date.now() - 5000
      );
      if (timeoutMs <= 0) return { exitCode: 1, output: `Owner analyzer ${cfg.id} deadline expired` };

      const profile = {
        id: `owner-static-${cfg.id}`,
        command: `owner:${cfg.id}`,
        method: "integration_test" as const,
        levels: ["integration" as const],
        reporter: "node_tap" as const,
        executable: cfg.executable,
        args: [...cfg.args, ...files.map(file => {
          assertSafeRelativePath(file, "owner analyzer input");
          return `./${file}`;
        })],
        timeoutMs,
        maxOutputBytes: 1_048_576,
        source: "owner"
      };

      try {
        const result = await measureCompiler(profile, cwd, revision);
        return {
          exitCode: result.exitCode,
          output: result.output || (result.exitCode === 0 ? `Owner analyzer ${cfg.id} passed for ${files.join(", ")}` : `Owner analyzer ${cfg.id} failed with exit code ${result.exitCode}`)
        };
      } catch (error) {
        return {
          exitCode: 1,
          output: `Owner analyzer ${cfg.id} sandbox execution failure: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
  };
}

export const DEFAULT_STATIC_ANALYZERS: readonly StaticAnalyzer[] = [
  whitespaceAnalyzer,
  javascriptAnalyzer,
  jsonAnalyzer,
  yamlAnalyzer,
  githubActionsAnalyzer,
  shellAnalyzer,
  jvmCompileAnalyzer,
  xmlAnalyzer
];

export function buildStaticAnalyzers(
  ownerConfigs: readonly OwnerStaticAnalyzer[] = [],
  repoRoot?: string,
  customOwnerRunner?: OwnerAnalyzerRunner,
  customJvmRunner?: CompilerRunner
): StaticAnalyzer[] {
  const ownerAnalyzers = ownerConfigs.map(cfg => createOwnerAnalyzer(cfg, repoRoot, customOwnerRunner));
  const jvmAnalyzer = customJvmRunner ? createJvmCompileAnalyzer(customJvmRunner) : jvmCompileAnalyzer;
  const defaults = DEFAULT_STATIC_ANALYZERS.map(a => a.id === "jvm-compile" ? jvmAnalyzer : a);
  return [...ownerAnalyzers, ...defaults];
}

export function assertStaticAnalyzersAvailableSync(
  paths: readonly string[],
  analyzers: readonly StaticAnalyzer[],
  runners?: TestRunnerSource,
  repoRoot?: string
): void {
  const syntaxAnalyzers = analyzers.filter(a => a.id !== "whitespace");
  const files = paths.filter(p => !/\.(md|txt|rst|adoc)$/i.test(p) && /\.[A-Za-z0-9_-]+$/.test(p));
  const missing: { path: string; reason: string }[] = [];
  const profiles = runners?.current?.status === "detected" ? runners.current.profiles : (runners?.profiles ?? []);
  const hasJvmRunner = profiles.some(p => p.adapter?.adapterId === "maven" || p.id.includes("maven") || p.command.includes("maven") || p.adapter?.adapterId === "gradle" || p.id.includes("gradle") || p.command.includes("gradle"));

  for (const file of files) {
    const matched = syntaxAnalyzers.filter(a => a.matches(file));
    if (!matched.length) {
      missing.push({ path: file, reason: `No static analyzer configured for ${file}` });
      continue;
    }

    const available = matched.filter(a => {
      if (a.id === "jvm-compile") return hasJvmRunner;
      if (a.id === "xml") return checkExecutableSync("xmllint");
      if (a.id === "shell") return checkExecutableSync("bash") || checkExecutableSync("sh");
      if (!RESERVED_BUILTIN_ANALYZER_IDS.has(a.id)) {
        const ownerExec = a.executable;
        if (typeof ownerExec === "string") {
          return checkExecutableSync(ownerExec, repoRoot);
        }
        return true;
      }
      return true;
    });

    if (available.length === 0) {
      const reasons = matched.map(a => {
        if (a.id === "jvm-compile") return "JVM compilation analyzer requires detected Maven or Gradle runner";
        if (a.id === "xml") return "XML analyzer requires xmllint installed on PATH";
        if (a.id === "shell") return "Shell analyzer requires bash or sh installed on PATH";
        return `Owner analyzer ${a.id} executable unavailable`;
      });
      missing.push({ path: file, reason: reasons.join("; ") });
    }
  }
  if (missing.length > 0) {
    const missingPaths = [...new Set(missing.map(m => m.path))];
    throw new WorkflowProposalRejected({
      code: "static_analyzer_missing",
      reason: `No static analyzer available for planned files: ${missingPaths.join(", ")}. ${missing.map(m => m.reason).join("; ")}`,
      options: [
        "Chuyển tiêu chí sang test hành vi (unit_test hoặc integration_test).",
        "Thêm staticAnalyzers vào .bflow/verification.json với đường dẫn executable hợp lệ.",
        "Người dùng duyệt chuyển tiêu chí sang manual_review."
      ]
    });
  }
}

export async function assertStaticAnalyzersAvailable(
  paths: readonly string[],
  analyzers: readonly StaticAnalyzer[],
  context: AnalyzerContext
): Promise<void> {
  const syntaxAnalyzers = analyzers.filter(a => a.id !== "whitespace");
  const files = paths.filter(p => !/\.(md|txt|rst|adoc)$/i.test(p) && /\.[A-Za-z0-9_-]+$/.test(p));
  const missing: { path: string; reason: string }[] = [];
  for (const file of files) {
    const matched = syntaxAnalyzers.filter(a => a.matches(file));
    if (!matched.length) {
      missing.push({ path: file, reason: `No static analyzer configured for ${file}` });
      continue;
    }
    let available = false;
    for (const a of matched) {
      const status = await a.detect(context);
      if (status.status === "available") {
        available = true;
        break;
      }
    }
    if (!available) {
      missing.push({ path: file, reason: `Matching analyzer not available for ${file}` });
    }
  }
  if (missing.length > 0) {
    const missingPaths = [...new Set(missing.map(m => m.path))];
    throw new WorkflowProposalRejected({
      code: "static_analyzer_missing",
      reason: `Static analyzers unavailable for: ${missingPaths.join(", ")}. ${missing.map(m => m.reason).join("; ")}`,
      options: [
        "Cài đặt công cụ phân tích tĩnh hoặc sửa đường dẫn cấu hình.",
        "Người dùng duyệt chuyển tiêu chí sang manual_review."
      ]
    });
  }
}
