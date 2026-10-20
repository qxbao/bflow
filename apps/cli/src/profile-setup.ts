import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { ComponentDesiredState, ComponentObservation, SetupComponent, SetupContext } from "@bflow/machine-setup";

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const ProfileSyncReportSchema = z.object({
  schemaVersion: z.literal(1),
  valid: z.boolean(),
  desiredDigest: DigestSchema,
  stateDigest: DigestSchema.nullable(),
  profileCount: z.number().int().nonnegative(),
  targets: z.array(z.string().min(1)),
  ownedPaths: z.array(z.string()),
  diagnostics: z.array(z.string())
}).strict();
export type ProfileSyncReport = z.infer<typeof ProfileSyncReportSchema>;

export interface ProfileSetupOptions {
  readonly helperPath: string;
  readonly sourceHome: string;
  readonly stateRoot: string;
  readonly sourceCodexHome?: string;
  readonly sourceClaudeConfigDir?: string;
  readonly sourceCodexSkills?: string;
  readonly expectedIdentity: string;
  readonly pythonCandidates?: readonly string[];
}

export function resolveProfileSetupOptions(input: {
  readonly helperPath: string;
  readonly homeDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly isolatedRoot?: string;
  readonly expectedIdentity: string;
  readonly pythonCandidates?: readonly string[];
}): ProfileSetupOptions {
  const isolatedRoot = input.isolatedRoot ? resolve(input.isolatedRoot) : undefined;
  const sourceHome = isolatedRoot
    ? join(isolatedRoot, "providers", "home")
    : resolve(input.environment.AI_ISOLATOR_REAL_HOME || input.homeDirectory);
  const stateRoot = isolatedRoot
    ? join(isolatedRoot, "ai-isolator")
    : input.environment.AI_ISOLATOR_HOME
      ? resolve(input.environment.AI_ISOLATOR_HOME)
      : join(sourceHome, ".local", "share", "ai-isolator");
  const sourceCodexHome = isolatedRoot
    ? join(isolatedRoot, "providers", "codex")
    : input.environment.CODEX_HOME ? resolve(input.environment.CODEX_HOME) : undefined;
  const sourceClaudeConfigDir = isolatedRoot
    ? join(isolatedRoot, "providers", "claude")
    : input.environment.CLAUDE_CONFIG_DIR ? resolve(input.environment.CLAUDE_CONFIG_DIR) : undefined;
  const sourceCodexSkills = !isolatedRoot && input.environment.AI_ISOLATOR_CODEX_SKILLS_SOURCE
    ? resolve(input.environment.AI_ISOLATOR_CODEX_SKILLS_SOURCE) : undefined;
  const sourceIdentity = {
    configuredIdentity: input.expectedIdentity,
    sourceHome,
    stateRoot,
    codexHome: sourceCodexHome ?? join(sourceHome, ".codex"),
    claudeConfigDir: sourceClaudeConfigDir ?? join(sourceHome, ".claude"),
    codexSkills: sourceCodexSkills ?? join(sourceCodexHome ?? join(sourceHome, ".codex"), "skills")
  };
  return {
    helperPath: input.helperPath,
    sourceHome,
    stateRoot,
    ...(sourceCodexHome ? { sourceCodexHome } : {}),
    ...(sourceClaudeConfigDir ? { sourceClaudeConfigDir } : {}),
    ...(sourceCodexSkills ? { sourceCodexSkills } : {}),
    expectedIdentity: JSON.stringify(sourceIdentity),
    ...(input.pythonCandidates ? { pythonCandidates: input.pythonCandidates } : {})
  };
}

export class ProfileSetupComponent implements SetupComponent {
  readonly componentId = "isolator-profiles";
  readonly action = "configure" as const;
  readonly rollback = "manual" as const;
  private python: Promise<string> | undefined;
  constructor(private readonly options: ProfileSetupOptions) {
    for (const path of [options.helperPath, options.sourceHome, options.stateRoot,
      options.sourceCodexHome, options.sourceClaudeConfigDir, options.sourceCodexSkills].filter(Boolean) as string[]) {
      if (!isAbsolute(path)) throw new Error("Profile setup paths must be absolute trusted machine paths");
    }
  }

  private async interpreter(ctx: SetupContext): Promise<string> {
    return this.python ??= (async () => {
      const candidates = this.options.pythonCandidates ?? ["python3", "python"];
      for (const executable of candidates) {
        const result = await ctx.runner.run([executable, "-c", "import sys,tomllib; assert sys.version_info >= (3,11)"], {
          timeoutMs: 5_000, ...(ctx.signal ? { signal: ctx.signal } : {})
        }).catch(() => null);
        if (result?.exitCode === 0 && !result.timedOut) return executable;
      }
      throw new Error("Python 3.11+ with tomllib is required for native/isolated profile synchronization");
    })();
  }

  private async invoke(ctx: SetupContext, action: "inspect" | "apply"): Promise<ProfileSyncReport> {
    const executable = await this.interpreter(ctx);
    const argv = [executable, this.options.helperPath, action,
      "--source-home", this.options.sourceHome, "--state-root", this.options.stateRoot];
    if (this.options.sourceCodexHome) argv.push("--source-codex-home", this.options.sourceCodexHome);
    if (this.options.sourceClaudeConfigDir) argv.push("--source-claude-config-dir", this.options.sourceClaudeConfigDir);
    if (this.options.sourceCodexSkills) argv.push("--source-codex-skills", this.options.sourceCodexSkills);
    const result = await ctx.runner.run(argv, { timeoutMs: 120_000, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    let parsed: ProfileSyncReport;
    try { parsed = ProfileSyncReportSchema.parse(JSON.parse(result.stdout)); }
    catch { throw new Error(`Profile synchronizer returned an invalid ${action} report (exit ${result.exitCode ?? "unknown"})`); }
    const profilesRoot = resolve(this.options.stateRoot, "profiles");
    const isProfilePath = (path: string) => {
      if (!isAbsolute(path) || resolve(path) !== path) return false;
      const fromProfiles = relative(profilesRoot, path);
      return fromProfiles !== "" && fromProfiles !== ".." && !fromProfiles.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
    };
    if (parsed.targets.some(path => !isProfilePath(path)) ||
        parsed.ownedPaths.some(path => !isAbsolute(path) || resolve(path) !== path ||
          !parsed.targets.some(target => {
            const fromHome = relative(target, path);
            return fromHome === "" || (fromHome !== ".." && !fromHome.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
          }))) {
      throw new Error(`Profile synchronizer returned an out-of-scope ${action} path`);
    }
    if (result.exitCode !== 0 && parsed.valid) throw new Error("Profile synchronizer reported success with a failing exit status");
    return parsed;
  }

  private planDigest(targets: readonly string[]): string {
    return createHash("sha256").update(JSON.stringify({
      schemaVersion: 1,
      component: "profile-sync",
      expectedIdentity: this.options.expectedIdentity,
      sourceHome: this.options.sourceHome,
      stateRoot: this.options.stateRoot,
      sourceCodexHome: this.options.sourceCodexHome ?? null,
      sourceClaudeConfigDir: this.options.sourceClaudeConfigDir ?? null,
      sourceCodexSkills: this.options.sourceCodexSkills ?? null,
      targets: [...targets].sort()
    })).digest("hex");
  }

  private isSatisfied(report: ProfileSyncReport): boolean {
    return report.valid && (report.profileCount === 0
      ? report.targets.length === 0
      : report.stateDigest === report.desiredDigest);
  }

  async observe(ctx: SetupContext): Promise<ComponentObservation> {
    try {
      const report = await this.invoke(ctx, "inspect");
      const digest = this.planDigest(report.targets);
      return {
        stateDigest: this.isSatisfied(report) ? digest : null,
        valid: report.valid,
        diagnostics: report.diagnostics
      };
    } catch (error) {
      return { stateDigest: null, valid: false, diagnostics: [error instanceof Error ? error.message : "Profile synchronization inspection failed"] };
    }
  }

  async desired(ctx: SetupContext): Promise<ComponentDesiredState> {
    let targets: string[] = [resolve(this.options.stateRoot, "profiles")];
    let diagnostics: string[] = [];
    try {
      const report = await this.invoke(ctx, "inspect");
      targets = report.targets;
      diagnostics = report.diagnostics;
    } catch (error) {
      diagnostics = [error instanceof Error ? error.message : "Profile synchronization target discovery failed"];
    }
    return {
      digest: this.planDigest(targets),
      summary: diagnostics.length ? `Synchronize native and isolated profiles (${diagnostics.join("; ")})` :
        targets.length === 0 ? "No existing provider profiles; no profile synchronization applies" :
          "Synchronize approved MCP tools, skills and Bflow plugin assets into existing provider profiles",
      targets,
      machineWide: true,
      repairNeeded: false
    };
  }

  async apply(ctx: SetupContext): Promise<{ ownedPaths: string[]; diagnostics: string[] }> {
    if (ctx.mode === "check" || ctx.mode === "dry_run")
      return { ownedPaths: [], diagnostics: [`Profile synchronization skipped in ${ctx.mode}; no files changed`] };
    try {
      const applied = await this.invoke(ctx, "apply");
      if (!this.isSatisfied(applied))
        return { ownedPaths: applied.ownedPaths, diagnostics: [...applied.diagnostics, "Profile synchronization apply did not reach its desired state"] };
      const verified = await this.invoke(ctx, "inspect");
      if (!this.isSatisfied(verified))
        return { ownedPaths: applied.ownedPaths, diagnostics: [...verified.diagnostics, "Profile synchronization read-back failed"] };
      return { ownedPaths: applied.ownedPaths, diagnostics: verified.diagnostics };
    } catch (error) {
      return { ownedPaths: [], diagnostics: [error instanceof Error ? error.message : "Profile synchronization failed"] };
    }
  }
}
