import { createHash } from "node:crypto";
import { z } from "zod";
import { constants, openSync, closeSync, readFileSync, fstatSync } from "node:fs";
import { chmod, lstat, mkdir, open, readlink, realpath, stat, symlink, unlink } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import {
  type AgentEnvironment,
  type AgentRole,
  AgentEnvironmentSchema,
  type AgentHealthCheck,
  type AgentHealthRequest,
  AgentHealthRequestSchema,
  type AgentHealthResult,
  AgentHealthResultSchema,
  type AgentLaunchProfile,
  AgentLaunchProfileSchema,
  type AgentProviderAdapter,
  type AgentProviderDescriptor,
  MCPClientRegistrationSchema,
  MCPServiceObservationSchema,
  type OperationOptions,
  type OperationResult,
  PlatformSchemaVersionSchema,
  canonicalReceiptJson,
  SkillManifestSchema
} from "@bflow/contracts";
import {
  computeFileSha256,
  computeLaunchConfigDigest,
  computeLaunchFingerprint,
  resolveAndVerifyExecutable,
  verifyLaunchAttestation
} from "./attestation.js";
import { createHealthCheck, executionProbeFailureDiagnostic } from "./diagnostics.js";
import { providerSessionEnvironment, validateProviderEnvironment } from "./environment.js";
import { type LaunchMaterialFailure, resolveLaunchMaterial, type ResolvedLaunchMaterial } from "./launch-material.js";
import { compileProviderPermissions, hostLaunchPermissionOptions } from "./permissions.js";
import { createProviderProcessRunner } from "./runner.js";
import type {
  DetectedProviderCapabilities,
  ProviderAdapterOptions,
  ProviderCommandInvocation,
  ProviderCommandRunner
} from "./types.js";

const DEFAULT_MIN_VERSIONS: Record<"claude" | "codex" | "agy", string> = {
  claude: "2.0.0",
  codex: "0.150.0",
  agy: "1.0.0"
};

const DEFAULT_ROLE_PROMPTS: Record<string, string> = {
  conversation:
    "You are the Bflow Conversation Agent. You serve as the sole user interface, handling clarification dialogues and delegation to the Coordinator.",
  coordinator:
    "You are the Bflow Coordinator Agent. You analyze requirements, decompose tasks into a DAG, and orchestrate workflow execution via Workflow Runtime.",
  developer:
    "You are the Bflow Developer Agent. You implement tasks following Spec-Driven Development and Conditional TDD policies.",
  reviewer:
    "You are the Bflow Reviewer Agent. You review code changes and verification evidence against specifications and acceptance criteria.",
  qa:
    "You are the Bflow QA Verifier Agent. You run automated verification suites, evaluate test results, and produce verification evidence.",
  architect:
    "You are the Bflow Architect Agent. You design system architecture and technical specifications.",
  specifier:
    "You are the Bflow Analyst/Specifier Agent. You elicit requirements and formalize specifications.",
  planner:
    "You are the Bflow Planner Agent. You create milestone plans and track task breakdown."
};
export function defaultRolePrompt(role: AgentRole): string {
  return DEFAULT_ROLE_PROMPTS[role] ?? `You are the Bflow ${role} Agent.`;
}
/** Installed adapter/permission policy identity, independent of provider release labels. */
export function providerRolePolicyDigest(): string {
  const digest = createHash("sha256");
  for (const name of ["base-adapter.js", "permissions.js"]) {
    const fd = openSync(new URL(`../dist/${name}`, import.meta.url), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Installed provider policy is unavailable");
      const bytes = readFileSync(fd);
      if (bytes.length > 2 * 1024 * 1024) throw new Error("Installed provider policy exceeds limit");
      digest.update(name).update("\0").update(bytes).update("\0");
    } finally { closeSync(fd); }
  }
  return digest.digest("hex");
}
const AGY_SECRET_ENV_NAME_PATTERN = /(?:TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i;
const AGY_RUNTIME_ENVIRONMENT_NAMES = [
  "TERM", "COLORTERM", "NO_COLOR", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ",
  "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "GNOME_KEYRING_CONTROL", "GPG_TTY",
  "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_SESSION", "BFLOW_LAUNCH_ID", "BFLOW_ENVIRONMENT_ID"
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function parseSemver(raw: string): { major: number; minor: number; patch: number } | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10)
  };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

export interface InheritedIsolationFailure {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
}

/**
 * Per-invocation isolation from state the provider CLI would otherwise inherit from the user's global
 * configuration (for example global MCP servers or hooks). Adapters without such inheritance return the
 * empty default. `argv` is placed before the provider subcommand in probes and after Bflow MCP overrides in
 * launches. A failure fails closed for the corresponding health check and prepareLaunch.
 */
export interface InheritedIsolation {
  readonly argv: readonly string[];
  readonly mcpFailure?: InheritedIsolationFailure;
  readonly hookFailure?: InheritedIsolationFailure;
  /** Private, non-provider-executed metadata included in the settings-file launch digest. */
  readonly settingsMetadata?: Readonly<Record<string, string>>;
  /** Private observation of all known provider configuration/account inputs. Undefined disables sharing. */
  readonly executionProbeSnapshot?: () => Promise<string | undefined>;
}

export abstract class BaseProviderAdapter implements AgentProviderAdapter {
  abstract readonly descriptor: AgentProviderDescriptor;

  protected readonly options: ProviderAdapterOptions;
  protected readonly runner: ProviderCommandRunner;

  constructor(options?: ProviderAdapterOptions) {
    this.options = options ?? {};
    this.runner = options?.runner ?? createProviderProcessRunner();
  }

  private effortConfigurationError(provider: AgentEnvironment["provider"]): string | undefined {
    if (this.options.effort === undefined) return undefined;
    const supported: Readonly<Record<AgentEnvironment["provider"], readonly string[]>> = {
      claude: ["low", "medium", "high", "xhigh", "max"],
      codex: ["minimal", "low", "medium", "high", "xhigh"],
      agy: []
    };
    if (supported[provider].includes(this.options.effort)) return undefined;
    return provider === "agy"
      ? "Agy effort must be encoded in the configured model name"
      : `Effort '${this.options.effort}' is not supported by ${provider}`;
  }

  protected getExecutablePath(): string {
    return this.options.executablePath ?? this.descriptor.executableName;
  }

  protected getProviderCommandEnvironment(environment?: AgentEnvironment): Readonly<Record<string, string>> {
    const agyHome = this.descriptor.provider === "agy" && environment !== undefined
      ? this.options.isolatorEnvironment?.["HOME"] ?? join(environment.stateDirectory, "agy-home", environment.role)
      : undefined;
    const agyXdgConfig = this.descriptor.provider === "agy" && environment !== undefined
      ? this.options.isolatorEnvironment?.["XDG_CONFIG_HOME"] ?? join(agyHome!, ".config")
      : undefined;
    return {
      ...(this.options.isolatorEnvironment ?? {}),
      ...providerSessionEnvironment(this.descriptor.provider),
      ...(agyHome !== undefined ? { HOME: agyHome, XDG_CONFIG_HOME: agyXdgConfig! } : {}),
      BFLOW_PROVIDER: this.descriptor.provider
    };
  }

  protected getProviderExecutionEnvironment(environment?: AgentEnvironment): Readonly<Record<string, string>> {
    return this.getProviderCommandEnvironment(environment);
  }

  protected commandEnvironmentOptions(): { readonly inheritEnvironment?: false } {
    return this.options.isolatorEnvironment === undefined ? {} : { inheritEnvironment: false };
  }

  protected shouldCheckNativeAuthentication(): boolean {
    return true;
  }

  protected async nativeAuthenticationOutcome(executable: string, _options?: OperationOptions, environment?: AgentEnvironment) {
    // Agy initializes first-run state even for `models`. Adopt an existing
    // completed receipt before that first command creates an incomplete one.
    if (this.descriptor.provider === "agy" && environment !== undefined) {
      if (this.options.isolatorEnvironment?.HOME === undefined) {
        await this.prepareAgyLaunchHome(environment);
      } else if (this.options.isolatorEnvironment["AI_ISOLATOR_REAL_HOME"] !== undefined) {
        await this.adoptNativeAgyKeychains(this.options.isolatorEnvironment.HOME);
      }
    }
    return this.runner.run({
      executable, args: this.getAuthCommand(), env: this.getProviderCommandEnvironment(environment),
      ...this.commandEnvironmentOptions(), timeoutMs: 45_000
    });
  }

  /**
   * Read-only login check for machine setup: the provider's own status command, with no launch
   * environment and no model execution. It never establishes launch readiness.
   */
  async checkNativeLogin(options?: OperationOptions): Promise<{ verified: boolean; detail: string }> {
    try {
      const executable = (await resolveAndVerifyExecutable(this.getExecutablePath(), this.executableVerificationOptions())).canonicalPath;
      // Agy's `models` initializes first-run state; never let a check create it in a home that was never onboarded.
      if (this.descriptor.provider === "agy" && this.options.isolatorEnvironment?.HOME === undefined) {
        const home = process.env.HOME;
        const onboarded = home !== undefined &&
          await lstat(join(home, ".gemini", "antigravity-cli", "cache", "onboarding.json")).then(info => info.isFile(), () => false);
        if (!onboarded) return { verified: false, detail: "agy onboarding is not complete" };
      }
      const outcome = await this.nativeAuthenticationOutcome(executable, options);
      const output = `${outcome.stdout}\n${outcome.stderr}`;
      if (outcome.failure === "timeout") return { verified: false, detail: "login status check timed out" };
      if (!outcome.started || outcome.failure !== undefined || outcome.exitCode !== 0 || /expired/i.test(output) ||
          !this.nativeAuthenticationConfirmed(outcome.stdout, outcome.stderr))
        return { verified: false, detail: "provider reports no active login" };
      return { verified: true, detail: "provider reports an active login" };
    } catch (err) {
      return { verified: false, detail: `login status check failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * The catalog ids when the native authentication output is a model catalog that omits the configured model.
   * Agy starts its default model for an unknown --model id instead of failing, so its catalog is checked here.
   */
  protected nativeCatalogRejectsModel(stdout: string): readonly string[] | undefined {
    if (this.descriptor.provider !== "agy" || this.options.model === undefined) return undefined;
    const ids = stdout.split(/\r?\n/).map(line => /^([A-Za-z0-9][A-Za-z0-9._:/-]*)\t+\S/.exec(line)?.[1])
      .filter((id): id is string => id !== undefined);
    return ids.length > 0 && !ids.includes(this.options.model) ? ids : undefined;
  }

  protected nativeAuthenticationConfirmed(stdout: string, stderr: string): boolean {
    if (/\b(?:unauthori[sz]ed|unauthenticated|not logged in|auth(?:entication)? required)\b/i.test(stdout + "\n" + stderr)) return false;
    if (this.descriptor.provider === "claude") {
      try {
        const parsed = z.object({ loggedIn: z.boolean().optional(), authenticated: z.boolean().optional(),
          status: z.string().optional() }).passthrough().safeParse(JSON.parse(stdout));
        return parsed.success && parsed.data.loggedIn !== false && parsed.data.authenticated !== false &&
          (parsed.data.loggedIn === true || parsed.data.authenticated === true) &&
          (parsed.data.status === undefined || ["active", "authenticated"].includes(parsed.data.status));
      } catch { return false; }
    }
    if (this.descriptor.provider === "codex") return /^[ \t]*logged in\b/im.test(stdout + "\n" + stderr);
    // Native Agy success is a tab-separated id/description list, not an arbitrary zero-exit response.
    return stdout.split(/\r?\n/).some(line => /^[A-Za-z0-9][A-Za-z0-9._:/-]*\t+\S/.test(line)) &&
      !/^\s*(?:error|fatal)\s*:/im.test(stderr);
  }

  private executableVerificationOptions() {
    const searchPath = this.getProviderCommandEnvironment()["PATH"];
    return {
      ...(searchPath !== undefined ? { searchPath } : {}),
      ...(this.options.allowTestFilesystemOwnership !== undefined
        ? { allowTestFilesystemOwnership: this.options.allowTestFilesystemOwnership } : {})
    };
  }

  /**
   * Renders a streamable_http MCP entry that references the bearer token by environment variable name.
   * Adapters without a verified header/env-reference form keep the default and fail closed.
   */
  protected renderStreamableHttpMcpServer(_endpoint: string, _tokenEnvironmentName: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /** Whether the provider CLI can load the written MCP config file. */
  protected supportsMcpConfigFile(_capabilities: DetectedProviderCapabilities): boolean {
    return true;
  }

  /** Provider-specific per-invocation isolation from inherited global MCP servers and hooks. */
  protected async resolveInheritedIsolation(
    _environment: AgentEnvironment,
    _capabilities: DetectedProviderCapabilities,
    _bflowMcpServerNames: readonly string[],
    _launchProfile?: AgentLaunchProfile
  ): Promise<InheritedIsolation> {
    return { argv: [] };
  }

  protected resolveHostLaunchMaterial(capabilities: DetectedProviderCapabilities): ResolvedLaunchMaterial {
    return resolveLaunchMaterial({
      options: this.options,
      supportsNativeHooks: capabilities.supportsNativeHooks,
      supportsMcpConfigFile: this.supportsMcpConfigFile(capabilities),
      ...(this.descriptor.provider === "agy" ? { supportedHostHookEvents: ["SessionStart", "Stop", "PreToolUse", "PreInvocation"] as const } : {}),
      renderStreamableHttpServer: (endpoint, tokenEnvironmentName) =>
        this.renderStreamableHttpMcpServer(endpoint, tokenEnvironmentName)
    });
  }

  protected abstract getAuthCommand(): readonly string[];
  protected abstract getProbeCommand(environment: AgentEnvironment): readonly string[];
  protected abstract compileArgv(
    environment: AgentEnvironment,
    configFiles: { promptFile: string; mcpConfigFile: string; settingsFile: string },
    capabilities: DetectedProviderCapabilities,
    inherited: InheritedIsolation
  ): Promise<{ readonly argv: readonly string[]; readonly unsupportedCode?: string; readonly unsupportedMessage?: string }>;

  public async detectCapabilities(): Promise<DetectedProviderCapabilities> {
    const executable = this.getExecutablePath();
    const versionOutcome = await this.runner.run({
      executable,
      args: ["--version"],
      env: this.getProviderCommandEnvironment(),
      ...this.commandEnvironmentOptions()
    });

    const rawVersion = versionOutcome.stdout.trim() || versionOutcome.stderr.trim();
    const parsed = parseSemver(rawVersion);
    const version = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : "0.0.0";

    const helpOutcome = await this.runner.run({
      executable,
      args: ["--help"],
      env: this.getProviderCommandEnvironment(),
      ...this.commandEnvironmentOptions()
    });
    const helpText = `${helpOutcome.stdout}\n${helpOutcome.stderr}`;

    const supportedFlags = new Set<string>();
    const flagMatches = helpText.matchAll(/--[A-Za-z0-9_-]+/g);
    for (const match of flagMatches) {
      if (match[0]) supportedFlags.add(match[0]);
    }
    const bracketedFlagMatches = helpText.matchAll(/--([A-Za-z0-9_-]+)\[([A-Za-z0-9_-]+)\]/g);
    for (const match of bracketedFlagMatches) {
      if (match[1] && match[2]) {
        supportedFlags.add(`--${match[1]}`);
        supportedFlags.add(`--${match[1]}${match[2]}`);
      }
    }

    const supportedSubcommands = new Set<string>();
    const subMatches = helpText.matchAll(/^[ \t]+([a-z][a-z0-9_-]+)[ \t]+/gm);
    for (const match of subMatches) {
      if (match[1]) supportedSubcommands.add(match[1]);
    }

    const providerId = this.descriptor.provider;
    const supportsMcpStdio = this.descriptor.mcpTransports.includes("stdio");
    const supportsMcpHttp = this.descriptor.mcpTransports.includes("streamable_http");
    const supportsSkills = true;
    const supportsWorkspaceTrust =
      supportedFlags.has("--restricted") ||
      supportedFlags.has("--permission-mode") ||
      supportedFlags.has("--sandbox");
    const supportsDangerouslySkipPermissions = supportedFlags.has("--dangerously-skip-permissions");
    const supportsSandboxFlag = supportedFlags.has("--sandbox");
    const supportsApprovalPolicyFlag = supportedFlags.has("--ask-for-approval");
    const supportsAddDirFlag = supportedFlags.has("--add-dir");
    // Agy 1.4.5 has verified SessionStart, PreToolUse and Stop hooks, but lacks physical UserPromptSubmit.
    const supportsNativeHooks = true;
    const supportsUnattendedMode = providerId !== "agy";

    return {
      version,
      rawVersionOutput: rawVersion,
      supportedFlags,
      supportedSubcommands,
      supportsMcpStdio,
      supportsMcpHttp,
      supportsSkills,
      supportsWorkspaceTrust,
      supportsDangerouslySkipPermissions,
      supportsSandboxFlag,
      supportsApprovalPolicyFlag,
      supportsAddDirFlag,
      supportsNativeHooks,
      supportsUnattendedMode
    };
  }

  async checkHealth(
    request: AgentHealthRequest,
    options?: OperationOptions
  ): Promise<OperationResult<AgentHealthResult>> {
    // 1. Ingress schema version check
    const rawVersion = (request as unknown as { schemaVersion?: unknown }).schemaVersion;
    if (rawVersion !== 3) {
      return {
        ok: false,
        error: {
          code: "unsupported_version",
          retryable: false,
          supportedVersions: [3],
          receivedVersion: typeof rawVersion === "number" ? rawVersion : 0,
          message: `Unsupported schema version: ${String(rawVersion)}`
        }
      };
    }

    // 2. Validate request with Zod
    const parsedRequest = AgentHealthRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Health request failed schema validation: ${parsedRequest.error.message}`
        }
      };
    }

    // 3. Check AbortSignal and deadline
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: {
          code: "cancelled",
          retryable: false,
          message: "Operation cancelled by AbortSignal"
        }
      };
    }

    if (options?.deadline !== undefined && Date.parse(options.deadline) <= Date.now()) {
      return {
        ok: false,
        error: {
          code: "timeout",
          retryable: true,
          retrySafety: "observation_only",
          message: "Operation deadline expired before execution"
        }
      };
    }

    const environment = request.environment;
    const checks: AgentHealthCheck[] = [];
    let hasUnsupported = false;
    let hasFailed = false;

    if (this.options.effort !== undefined) {
      const effortError = this.effortConfigurationError(environment.provider);
      if (effortError !== undefined) {
        const checkedAt = (this.options.now?.() ?? new Date()).toISOString();
        const validUntil = new Date(Date.parse(checkedAt) + 1).toISOString();
        return {
          ok: true,
          value: AgentHealthResultSchema.parse({
            schemaVersion: PlatformSchemaVersionSchema.parse(3),
            environmentId: environment.environmentId,
            provider: environment.provider,
            role: environment.role,
            configFingerprint: environment.configFingerprint,
            stage: request.stage,
            status: "unsupported",
            checkedAt,
            validUntil,
            checks: [createHealthCheck("launch_arguments", "failed", "unsupported_effort", effortError,
              "Select an effort level supported by the configured provider, or encode Agy effort in its model name.")]
          })
        };
      }
    }

    // A. Check: binary
    let executable = this.getExecutablePath();
    let binaryPassed = false;
    let actualBinaryDigest = "0".repeat(64);

    try {
      const resolvedExec = await resolveAndVerifyExecutable(executable, this.executableVerificationOptions());
      actualBinaryDigest = resolvedExec.digest;
      // The execution probe changes cwd; a relative path or PATH lookup there
      // can otherwise run a different binary from the one just verified.
      executable = resolvedExec.canonicalPath;
      if (this.options.pinnedExecutableDigest !== undefined) {
        if (actualBinaryDigest !== this.options.pinnedExecutableDigest) {
          checks.push(
            createHealthCheck(
              "binary",
              "failed",
              "binary_digest_mismatch",
              `Executable digest mismatch: expected ${this.options.pinnedExecutableDigest}, got ${actualBinaryDigest}`,
              "Reinstall or verify the trusted binary distribution."
            )
          );
        } else {
          binaryPassed = true;
          checks.push(
            createHealthCheck(
              "binary",
              "passed",
              "binary_ok",
              `Binary verified at '${resolvedExec.canonicalPath}' with matching digest.`
            )
          );
        }
      } else {
        binaryPassed = true;
        checks.push(
          createHealthCheck(
            "binary",
            "passed",
            "binary_ok",
            `Binary verified at '${resolvedExec.canonicalPath}'.`
          )
        );
      }
    } catch (err) {
      const causeCode = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      const code = causeCode === "binary_missing" || causeCode === "binary_not_executable" || causeCode === "binary_untrusted"
        ? causeCode : causeCode === "EACCES" || causeCode === "EPERM" ? "binary_inaccessible" : "binary_verification_failed";
      checks.push(
        createHealthCheck(
          "binary",
          "failed",
          code,
          `Executable verification failed: ${err instanceof Error ? err.message : String(err)} (requested '${executable}').`,
          code === "binary_missing" ? `Install '${this.descriptor.executableName}' or verify the host PATH configuration.`
            : "Review the reported executable path, ownership, permissions and verification cause."
        )
      );
    }

    if (!binaryPassed) hasFailed = true;

    // B. Check: version & capabilities
    let capabilities: DetectedProviderCapabilities;
    let versionPassed = false;
    try {
      capabilities = await this.detectCapabilities();
      const minVersion =
        this.options.minimumVersion ?? DEFAULT_MIN_VERSIONS[this.descriptor.provider];
      if (capabilities.version === "0.0.0" || compareSemver(capabilities.version, minVersion) < 0) {
        checks.push(
          createHealthCheck(
            "version",
            "failed",
            "outdated_version",
            `Detected version '${capabilities.version}' is below minimum required version '${minVersion}'`,
            `Upgrade '${this.descriptor.executableName}' to at least ${minVersion}.`
          )
        );
      } else {
        versionPassed = true;
        checks.push(
          createHealthCheck(
            "version",
            "passed",
            "version_ok",
            `Version '${capabilities.version}' verified (minimum '${minVersion}').`
          )
        );
      }
    } catch (err) {
      capabilities = {
        version: "0.0.0",
        rawVersionOutput: "",
        supportedFlags: new Set(),
        supportedSubcommands: new Set(),
        supportsMcpStdio: false,
        supportsMcpHttp: false,
        supportsSkills: false,
        supportsWorkspaceTrust: false,
        supportsDangerouslySkipPermissions: false,
        supportsSandboxFlag: false,
        supportsApprovalPolicyFlag: false,
        supportsAddDirFlag: false,
        supportsNativeHooks: false,
        supportsUnattendedMode: false
      };
      checks.push(
        createHealthCheck(
          "version",
          "failed",
          "version_check_failed",
          `Failed to determine provider version: ${err instanceof Error ? err.message : String(err)}`,
          `Verify '${this.descriptor.executableName}' is executable and responds to --version.`
        )
      );
    }

    if (!versionPassed) hasFailed = true;

    // B2. Inherited global MCP/hook isolation (read-only inspection; no launch side effects)
    const inherited = await this.resolveInheritedIsolation(
      environment,
      capabilities,
      Object.keys(this.resolveHostLaunchMaterial(capabilities).mcpServers),
      request.launchProfile
    );

    // C. Check: authentication & execution probe. Never invoke the provider while
    // inherited global hooks/MCP state is not approved or isolated.
    let authPassed = false;
    const agyBindingUnsupported = this.descriptor.provider === "agy" && request.stage === "preflight" &&
      !this.descriptor.supportsNativeBinding;
    if (agyBindingUnsupported) {
      hasUnsupported = true;
      checks.push(createHealthCheck("native_binding", "failed", "native_binding_unsupported",
        "Agy native session binding has not passed the isolated Herdr identity acceptance probe.",
        "Use Claude or Codex for active roles until Agy's native conversationId is verified against the current Herdr pane."));
    }
    if (inherited.hookFailure !== undefined || inherited.mcpFailure !== undefined) {
      hasFailed = true;
      const failure = inherited.hookFailure ?? inherited.mcpFailure!;
      checks.push(createHealthCheck("authentication", "failed", failure.code,
        `Provider execution probe was skipped because inherited state is blocked: ${failure.message}`, failure.remediation));
    } else try {
      const nativeOnly = this.options.executionProbe === "disabled" || agyBindingUnsupported;
      const authOutcome = this.shouldCheckNativeAuthentication() || nativeOnly
        ? await this.nativeAuthenticationOutcome(executable, options, environment)
        : { exitCode: 0, stdout: "", stderr: "", started: true };

      const combinedAuthOutput = `${authOutcome.stdout}\n${authOutcome.stderr}`;
      const isExpired =
        combinedAuthOutput.toLowerCase().includes("expired") ||
        (authOutcome.stdout.includes('"status":"expired"') || authOutcome.stdout.includes('"status": "expired"'));

      if (authOutcome.exitCode !== 0 || !authOutcome.started || authOutcome.failure !== undefined || isExpired ||
          (nativeOnly && !this.nativeAuthenticationConfirmed(authOutcome.stdout, authOutcome.stderr))) {
        const timedOut = authOutcome.failure === "timeout";
        const code = timedOut ? "timeout" : isExpired ? "auth_expired" : "auth_missing";
        checks.push(
          createHealthCheck(
            "authentication",
            "failed",
            code,
            timedOut ? "Native authentication catalog check timed out; authentication could not be established." : `Authentication check failed: ${combinedAuthOutput}`,
            timedOut ? "Verify provider connectivity and retry the native authentication check." : `Authenticate '${this.descriptor.executableName}' using your provider login or credentials.`
          )
        );
      } else if (this.nativeCatalogRejectsModel(authOutcome.stdout) !== undefined) {
        hasFailed = true;
        checks.push(createHealthCheck("authentication", "failed", "incompatible_model",
          `Model '${this.options.model}' is not in the native ${this.descriptor.executableName} model catalog (${this.nativeCatalogRejectsModel(authOutcome.stdout)!.join(", ")})`,
          `Configure a model id listed by '${this.descriptor.executableName} ${this.getAuthCommand().join(" ")}' for this account.`));
      } else if (nativeOnly) {
        authPassed = true;
        checks.push(createHealthCheck("authentication", "passed", "auth_native_ok",
          "Native authentication verified without model execution; model availability and quota are checked by real work or bflow doctor --deep."));
      } else {
        // Run minimal non-interactive execution probe
        const probeArgs = this.getProbeCommand(environment);
        const agyProbeHome =
          this.descriptor.provider === "agy"
            ? await this.prepareAgySessionHome(environment)
            : undefined;
        const probeInvocation: ProviderCommandInvocation = {
          executable,
          args: [...inherited.argv, ...probeArgs],
          cwd: environment.cwd,
          env: {
            ...this.getProviderExecutionEnvironment(environment),
            ...(agyProbeHome ? { HOME: agyProbeHome } : {})
          },
          ...this.commandEnvironmentOptions(),
          timeoutMs: 75_000
        };
        const snapshot = this.options.executionProbeCoalescer && binaryPassed && versionPassed
          ? await inherited.executionProbeSnapshot?.() : undefined;
        const probeOutcome = snapshot !== undefined && this.options.executionProbeCoalescer !== undefined
          ? await this.options.executionProbeCoalescer.probe({
              identity: createHash("sha256").update(canonicalReceiptJson({ scope: environment.scope, binaryDigest: actualBinaryDigest,
                provider: environment.provider, snapshot, auth: [authOutcome.stdout, authOutcome.stderr],
                environmentVariables: environment.environmentVariables, secretBindings: environment.secretBindings })).digest("hex"),
              invocation: probeInvocation,
              isCurrent: async () => {
                const currentExecutable = await resolveAndVerifyExecutable(executable, this.executableVerificationOptions());
                return currentExecutable.digest === actualBinaryDigest && await inherited.executionProbeSnapshot?.() === snapshot;
              }
            }, options)
          : await this.runner.run(probeInvocation);

        if (probeOutcome.exitCode !== 0 || probeOutcome.failure !== undefined || !probeOutcome.started) {
          const diagnostic = executionProbeFailureDiagnostic(probeOutcome);
          const lower = diagnostic.toLowerCase();
          const missingEnvironmentVariable = /\bmissing environment variable\s*:/i.test(diagnostic);
          let probeCode = "probe_failed";
          let probeRemediation = "Verify account quotas, network connectivity, and provider permissions.";

          if (probeOutcome.failure === "timeout" || (!missingEnvironmentVariable && (lower.includes("timed out") || lower.includes("timeout")))) {
            probeCode = "timeout";
            probeRemediation = "Increase startupTimeoutMs in .bflow/config.yml or verify provider network latency.";
          } else if (missingEnvironmentVariable) {
            probeCode = "environment_variable_missing";
            probeRemediation = "Export the named variable in the same terminal that runs bflow up, then restart the session.";
          } else if (/\b(?:permission denied|untrusted|insufficient permissions)\b/.test(lower)) {
            probeCode = "permission_denied";
            probeRemediation = "Grant workspace trust or adjust permission profile.";
          } else if (/\b(?:model(?:\s+[`'\"][^`'\"\n]+[`'\"])?\s+(?:is\s+)?(?:incompatible|unsupported|unavailable|not\s+(?:found|supported|available)|does\s+not\s+exist)|(?:incompatible|unsupported|invalid|unknown)\s+model|model_not_found)\b/.test(lower)) {
            probeCode = "incompatible_model";
            probeRemediation = "Select a model supported by your provider account tier.";
          } else if (/\b(?:blocked|approval (?:is )?required|requires? (?:interactive )?approval|(?:approval|confirmation) dialog)\b/.test(lower)) {
            probeCode = "agent_blocked";
            probeRemediation = "Complete interactive approvals outside automated flow.";
          } else if (/\b(?:auth(?:entication)?|credentials?|api[ _-]?key|(?:access|refresh|oauth)\s+token|token|session)[ _:-]*(?:(?:has|have|is|are)\s+)?expired\b|\bexpired[ _:-]+(?:token|credentials?|api[ _-]?key|session)\b/.test(lower)) {
            probeCode = "auth_expired";
            probeRemediation = "Re-authenticate provider credentials.";
          } else if (/\b(?:unauthori[sz]ed|unauthenticated|invalid[ _-]+(?:api[ _-]?key|credentials?|token)|(?:auth(?:entication)?|authorization)[ _:-]+(?:failed|failure|required)|not (?:authenticated|logged in))\b|\bhttp(?:\/\S+)?\s+401\b/.test(lower)) {
            probeCode = "auth_missing";
            probeRemediation = "Verify the selected provider credentials and authenticate if required.";
          }

          checks.push(
            createHealthCheck(
              "authentication",
              "failed",
              probeCode,
              `Readiness probe failed: ${diagnostic}`,
              probeRemediation
            )
          );
        } else {
          authPassed = true;
          checks.push(
            createHealthCheck(
              "authentication",
              "passed",
              "auth_ok",
              "Authentication and execution probe verified."
            )
          );
        }
      }
    } catch (err) {
      checks.push(
        createHealthCheck(
          "authentication",
          "failed",
          "auth_check_error",
          `Authentication check encountered an error: ${err instanceof Error ? err.message : String(err)}`,
          "Verify provider CLI installation and credentials."
        )
      );
    }

    if (!authPassed) hasFailed = true;

    // D. Check: environment
    const envValidation = await validateProviderEnvironment(environment, {
      ...(this.options.allowTestFilesystemOwnership !== undefined
        ? { allowTestFilesystemOwnership: this.options.allowTestFilesystemOwnership }
        : {})
    });

    if (!envValidation.valid) {
      hasFailed = true;
      checks.push(
        createHealthCheck(
          "environment",
          "failed",
          envValidation.code ?? "environment_invalid",
          envValidation.message ?? "Environment validation failed",
          "Ensure cwd and stateDirectory exist with private 0o700 permissions and valid scope."
        )
      );
    } else {
      checks.push(
        createHealthCheck(
          "environment",
          "passed",
          "environment_ok",
          "Environment directory structure, permissions, and variables verified."
        )
      );
    }

    // E. Check: mcp
    const nowDate = this.options.now ? this.options.now() : new Date();
    const registrations = this.options.mcpRegistrations ?? [];
    const observations = this.options.mcpObservations ?? [];
    let mcpCheckHandled = false;

    for (const reg of registrations) {
      const parsedReg = MCPClientRegistrationSchema.safeParse(reg);
      if (!parsedReg.success) {
        hasFailed = true;
        mcpCheckHandled = true;
        checks.push(
          createHealthCheck(
            "mcp",
            "failed",
            "mcp_invalid_registration",
            `Invalid MCPClientRegistration '${reg.registrationId}': ${parsedReg.error.message}`,
            "Ensure all MCP client registrations conform to MCPClientRegistrationSchema."
          )
        );
        break;
      }
      if (reg.provider !== environment.provider || reg.role !== environment.role) {
        hasFailed = true;
        mcpCheckHandled = true;
        checks.push(
          createHealthCheck(
            "mcp",
            "failed",
            "mcp_registration_scope_mismatch",
            `MCP registration '${reg.registrationId}' targets ${reg.provider}/${reg.role} instead of ${environment.provider}/${environment.role}`,
            "Bind MCP client registration to the exact provider and role."
          )
        );
        break;
      }
      if (reg.scope.kind === "session" && reg.scope.sessionId !== environment.scope.sessionId) {
        hasFailed = true;
        mcpCheckHandled = true;
        checks.push(
          createHealthCheck(
            "mcp",
            "failed",
            "mcp_registration_scope_mismatch",
            `MCP registration '${reg.registrationId}' session '${reg.scope.sessionId}' does not match environment session '${environment.scope.sessionId}'`,
            "Re-issue session-scoped MCP registration for the active session."
          )
        );
        break;
      }
      if (Date.parse(reg.expiresAt) <= nowDate.getTime()) {
        hasFailed = true;
        mcpCheckHandled = true;
        checks.push(
          createHealthCheck(
            "mcp",
            "failed",
            "mcp_registration_expired",
            `MCP registration '${reg.registrationId}' expired at ${reg.expiresAt}`,
            "Refresh MCP client registration before launching the agent."
          )
        );
        break;
      }
      if (!this.descriptor.mcpTransports.includes(reg.connection.transport)) {
        hasUnsupported = true;
        mcpCheckHandled = true;
        checks.push(
          createHealthCheck(
            "mcp",
            "failed",
            "mcp_transport_unsupported",
            `Provider '${this.descriptor.provider}' does not support MCP transport '${reg.connection.transport}'`,
            "Configure a stdio bridge or supported MCP transport."
          )
        );
        break;
      }
    }

    if (!mcpCheckHandled) {
      for (const obs of observations) {
        const parsedObs = MCPServiceObservationSchema.safeParse(obs);
        if (!parsedObs.success) {
          hasFailed = true;
          mcpCheckHandled = true;
          checks.push(
            createHealthCheck(
              "mcp",
              "failed",
              "mcp_invalid_observation",
              `Invalid MCPServiceObservation for '${obs.serviceId}': ${parsedObs.error.message}`,
              "Ensure MCP service observations conform to MCPServiceObservationSchema."
            )
          );
          break;
        }
        if (
          environment.requiredMcpServiceIds.includes(obs.serviceId) &&
          (obs.status !== "ready" || !obs.protocolVersion)
        ) {
          hasFailed = true;
          mcpCheckHandled = true;
          checks.push(
            createHealthCheck(
              "mcp",
              "failed",
              "mcp_service_unhealthy",
              `Required MCP service '${obs.serviceId}' is in status '${obs.status}'`,
              "Wait for SharedMCPGateway service readiness or inspect MCP server logs."
            )
          );
          break;
        }
      }
    }

    if (!mcpCheckHandled && inherited.mcpFailure !== undefined) {
      hasFailed = true;
      mcpCheckHandled = true;
      checks.push(
        createHealthCheck(
          "mcp",
          "failed",
          inherited.mcpFailure.code,
          inherited.mcpFailure.message,
          inherited.mcpFailure.remediation
        )
      );
    }

    if (!mcpCheckHandled) {
      if (environment.requiredMcpServiceIds.length > 0) {
        const regServiceIds = new Set(registrations.flatMap((r) => r.serviceIds));
        const obsServiceIds = new Set(observations.map((o) => o.serviceId));
        const missingServices = environment.requiredMcpServiceIds.filter(
          (id) => !regServiceIds.has(id) && !obsServiceIds.has(id)
        );

        if (missingServices.length > 0) {
          hasFailed = true;
          checks.push(
            createHealthCheck(
              "mcp",
              "failed",
              "mcp_missing_service",
              `Required MCP services are not registered or observed: ${missingServices.join(", ")}`,
              "Register required MCP services via SharedMCPGateway before agent launch."
            )
          );
        } else {
          checks.push(
            createHealthCheck(
              "mcp",
              "passed",
              "mcp_ok",
              `All ${environment.requiredMcpServiceIds.length} required MCP service(s) verified.`
            )
          );
        }
      } else {
        checks.push(
          createHealthCheck(
            "mcp",
            "passed",
            "mcp_ok",
            "No MCP services required."
          )
        );
      }
    }

    // F. Check: launch_arguments & permissions
    const permResult = await compileProviderPermissions(
      this.descriptor.provider,
      environment.permissionProfile,
      environment.role,
      capabilities,
      {
        cwd: environment.cwd,
        ...hostLaunchPermissionOptions(this.resolveHostLaunchMaterial(capabilities)),
        ...(this.options.osSandboxPath !== undefined ? { osSandboxPath: this.options.osSandboxPath } : {})
      }
    );

    const modelIncompatible =
      this.options.model !== undefined &&
      this.options.supportedModels !== undefined &&
      !this.options.supportedModels.includes(this.options.model);
    const modelFlagMissing =
      this.options.model !== undefined && !capabilities.supportedFlags.has("--model");
    const materialFailure: LaunchMaterialFailure | undefined = mcpCheckHandled
      ? undefined
      : this.resolveHostLaunchMaterial(capabilities).failure;

    if (!permResult.supported) {
      if (
        permResult.code === "unattended_isolation_unsupported" ||
        permResult.code === "agy_unattended_unsupported" ||
        permResult.code === "agy_human_ingress_unsupported"
      ) {
        hasUnsupported = true;
      } else {
        hasFailed = true;
      }
      checks.push(
        createHealthCheck(
          "permissions",
          "failed",
          permResult.code,
          permResult.message,
          permResult.remediation ?? "Adjust permission profile or configure supported isolation."
        )
      );
      checks.push(
        createHealthCheck(
          "launch_arguments",
          "failed",
          permResult.code === "invalid_flag" ? "invalid_flag" : "launch_arguments_invalid",
          `Cannot compile launch arguments: ${permResult.message}`,
          permResult.remediation ?? "Review permission configuration."
        )
      );
    } else if (inherited.hookFailure !== undefined) {
      hasFailed = true;
      checks.push(
        createHealthCheck(
          "permissions",
          "failed",
          inherited.hookFailure.code,
          inherited.hookFailure.message,
          inherited.hookFailure.remediation
        )
      );
      checks.push(
        createHealthCheck(
          "launch_arguments",
          "failed",
          inherited.hookFailure.code,
          inherited.hookFailure.message,
          inherited.hookFailure.remediation
        )
      );
    } else if (modelIncompatible) {
      hasFailed = true;
      checks.push(
        createHealthCheck(
          "permissions",
          "passed",
          "permissions_ok",
          "Permission profile and sandbox boundaries verified."
        )
      );
      checks.push(
        createHealthCheck(
          "launch_arguments",
          "failed",
          "incompatible_model",
          `Model '${this.options.model}' is not in supportedModels (${this.options.supportedModels?.join(", ")})`,
          "Configure a model supported by the provider and account tier."
        )
      );
    } else if (modelFlagMissing) {
      hasFailed = true;
      checks.push(
        createHealthCheck(
          "permissions",
          "passed",
          "permissions_ok",
          "Permission profile and sandbox boundaries verified."
        )
      );
      checks.push(
        createHealthCheck(
          "launch_arguments",
          "failed",
          "invalid_flag",
          `Provider '${this.descriptor.provider}' does not support the --model flag`,
          "Remove model override or upgrade the provider CLI."
        )
      );
    } else if (materialFailure !== undefined) {
      if (materialFailure.kind === "unsupported") {
        hasUnsupported = true;
      } else {
        hasFailed = true;
      }
      checks.push(
        createHealthCheck(
          "permissions",
          "passed",
          "permissions_ok",
          "Permission profile and sandbox boundaries verified."
        )
      );
      checks.push(
        createHealthCheck(
          "launch_arguments",
          "failed",
          materialFailure.code,
          materialFailure.message,
          "Adjust host MCP servers, Gateway registrations or hooks to what this provider can launch."
        )
      );
    } else {
      checks.push(
        createHealthCheck(
          "permissions",
          "passed",
          "permissions_ok",
          "Permission profile and sandbox boundaries verified."
        )
      );
      checks.push(
        createHealthCheck(
          "launch_arguments",
          "passed",
          "launch_arguments_ok",
          "Launch argument template compiled and validated."
        )
      );
    }

    // G. Check: skills
    if (this.options.skillManifest !== undefined) {
      const parsedManifest = SkillManifestSchema.safeParse(this.options.skillManifest);
      if (!parsedManifest.success) {
        hasFailed = true;
        checks.push(
          createHealthCheck(
            "skills",
            "failed",
            "skill_manifest_invalid",
            `SkillManifest failed schema validation: ${parsedManifest.error.message}`,
            "Re-resolve the role skill manifest with schemaVersion 3."
          )
        );
      } else if (this.options.skillManifest.role !== environment.role) {
        hasFailed = true;
        checks.push(
          createHealthCheck(
            "skills",
            "failed",
            "skill_manifest_role_mismatch",
            `Skill manifest role '${this.options.skillManifest.role}' does not match environment role '${environment.role}'`,
            "Resolve the skill manifest for the target role."
          )
        );
      } else if (this.options.skillManifest.digest !== environment.skillManifestDigest) {
        hasFailed = true;
        checks.push(
          createHealthCheck(
            "skills",
            "failed",
            "skill_manifest_mismatch",
            `Skill manifest digest '${this.options.skillManifest.digest}' does not match environment '${environment.skillManifestDigest}'`,
            "Ensure resolved skill manifest corresponds to the environment definition."
          )
        );
      } else {
        checks.push(
          createHealthCheck(
            "skills",
            "passed",
            "skills_ok",
            `Skill manifest verified with ${this.options.skillManifest.skills.length} skill(s).`
          )
        );
      }
    } else if (
      environment.skillManifestDigest &&
      environment.skillManifestDigest !== "0".repeat(64) &&
      environment.skillManifestDigest !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    ) {
      hasFailed = true;
      checks.push(
        createHealthCheck(
          "skills",
          "failed",
          "skill_manifest_mismatch",
          "Skill manifest digest specified in environment but no skill manifest was provided",
          "Provide skill manifest matching the environment digest."
        )
      );
    } else {
      checks.push(
        createHealthCheck(
          "skills",
          "passed",
          "skills_ok",
          "No custom skill manifest required."
        )
      );
    }

    // H. Check: native_binding (activated stage only)
    if (request.stage === "activated") {
      if (!this.descriptor.supportsNativeBinding) {
        hasUnsupported = true;
        checks.push(
          createHealthCheck(
            "native_binding",
            "failed",
            "native_binding_unsupported",
            `Provider '${this.descriptor.provider}' does not support authenticated native binding receipts`,
            "Native startup attestation is not certified for this provider."
          )
        );
      } else if (!request.launchProfile || !request.launchAttestation) {
        hasFailed = true;
        checks.push(
          createHealthCheck(
            "native_binding",
            "failed",
            "native_binding_missing",
            "Activated stage requires launch profile and signed launch attestation",
            "Attach valid launch profile and attestation to activated health request."
          )
        );
      } else {
        let bindingOk = true;

        // 0. Check launchProfile expiration and environment match
        if (Date.parse(request.launchProfile.expiresAt) <= nowDate.getTime()) {
          bindingOk = false;
          hasFailed = true;
          checks.push(
            createHealthCheck(
              "native_binding",
              "failed",
              "native_binding_profile_expired",
              `Launch profile '${request.launchProfile.launchId}' expired at ${request.launchProfile.expiresAt}`,
              "Prepare a fresh launch profile and restart the agent."
            )
          );
        } else if (
          request.launchProfile.environment.environmentId !== environment.environmentId ||
          request.launchProfile.environment.configFingerprint !== environment.configFingerprint
        ) {
          bindingOk = false;
          hasFailed = true;
          checks.push(
            createHealthCheck(
              "native_binding",
              "failed",
              "native_binding_environment_mismatch",
              "Launch profile environmentId or configFingerprint does not match health request environment",
              "Ensure activated check uses the exact launch profile for this environment."
            )
          );
        }

        // SessionStart and Herdr idle may precede Agy's onboarding UI. Re-read
        // the mutable native state after startup; an adopted source receipt is
        // not proof that this launch accepted it.
        if (this.descriptor.provider === "agy" && !await this.hasCompletedAgyOnboarding(environment)) {
          bindingOk = false;
          hasFailed = true;
          checks.push(createHealthCheck("native_binding", "failed", "agy_onboarding_incomplete",
            "The private Agy launch has no valid completed native onboarding receipt; interactive readiness is unproven.",
            "Complete native onboarding in the intended provider environment, then prepare a fresh launch. Bflow never accepts terms or data-use consent automatically."));
        }
        // 1. Verify attestation signature
        if (bindingOk) {
          const attestationVerification = verifyLaunchAttestation(
            request.launchAttestation,
            this.options.trustedIssuerKeys ?? {},
            {
              launchProfile: request.launchProfile,
              sessionId: environment.scope.sessionId,
              provider: environment.provider,
              now: nowDate
            }
          );

          if (!attestationVerification.valid) {
            bindingOk = false;
            hasFailed = true;
            checks.push(
              createHealthCheck(
                "native_binding",
                "failed",
                attestationVerification.code,
                attestationVerification.message,
                "Ensure attestation was signed by a configured trusted host key."
              )
            );
          }
        }

        // 2. Verify executable digest on disk still matches
        if (bindingOk && actualBinaryDigest !== request.launchProfile.executableDigest) {
          bindingOk = false;
          hasFailed = true;
          checks.push(
            createHealthCheck(
              "native_binding",
              "failed",
              "native_binding_executable_mismatch",
              `Executable digest changed after launch: expected ${request.launchProfile.executableDigest}, current ${actualBinaryDigest}`,
              "Restart session with updated launch profile."
            )
          );
        }

        // 3. Verify config files on disk still match and retain private 0o600 permissions
        if (bindingOk) {
          for (const cf of request.launchProfile.configFiles) {
            try {
              const cfStat = await stat(cf.path);
              if ((cfStat.mode & 0o077) !== 0) {
                bindingOk = false;
                hasFailed = true;
                checks.push(
                  createHealthCheck(
                    "native_binding",
                    "failed",
                    "native_binding_config_permissions",
                    `Config file '${cf.path}' has group/world permissions (${(cfStat.mode & 0o777).toString(8)})`,
                    "Restrict launch config files to 0o600."
                  )
                );
                break;
              }
              const currentDigest = await computeLaunchConfigDigest(cf.path, this.descriptor.provider);
              if (currentDigest !== cf.digest) {
                bindingOk = false;
                hasFailed = true;
                checks.push(
                  createHealthCheck(
                    "native_binding",
                    "failed",
                    "native_binding_config_mismatch",
                    `Config file '${cf.path}' digest changed after launch`,
                    "Do not mutate launch config files after launch."
                  )
                );
                break;
              }
            } catch (err) {
              bindingOk = false;
              hasFailed = true;
              checks.push(
                createHealthCheck(
                  "native_binding",
                  "failed",
                  "native_binding_config_missing",
                  `Config file '${cf.path}' missing: ${err instanceof Error ? err.message : String(err)}`,
                  "Ensure launch config files are preserved."
                )
              );
              break;
            }
          }
        }

        // 4. Verify live observation if provided
        if (bindingOk && this.options.liveObservation !== undefined) {
          const obs = this.options.liveObservation;
          if (obs.paneId !== request.launchAttestation.paneId) {
            bindingOk = false;
            hasFailed = true;
            checks.push(
              createHealthCheck(
                "native_binding",
                "failed",
                "native_binding_pane_mismatch",
                `Live observation pane '${obs.paneId}' does not match attestation pane '${request.launchAttestation.paneId}'`,
                "Verify pane binding in SessionManifest."
              )
            );
          } else if (
            obs.nativeSession !== undefined &&
            (obs.nativeSession.value !== request.launchAttestation.nativeSession.value ||
              obs.nativeSession.kind !== request.launchAttestation.nativeSession.kind)
          ) {
            bindingOk = false;
            hasFailed = true;
            checks.push(
              createHealthCheck(
                "native_binding",
                "failed",
                "native_binding_session_mismatch",
                "Live observation nativeSession does not match launch attestation nativeSession",
                "Re-verify native session hook receipt."
              )
            );
          } else if (obs.permissionDenied === true) {
            bindingOk = false;
            hasFailed = true;
            checks.push(
              createHealthCheck(
                "native_binding",
                "failed",
                "permission_denied",
                "Live observation reported permission denial in agent pane",
                "Review pane logs and adjust permission profile."
              )
            );
          } else if (obs.launchPending === true) {
            bindingOk = false;
            hasFailed = true;
            checks.push(
              createHealthCheck(
                "native_binding",
                "failed",
                "native_binding_launch_pending",
                "Agent launch is still pending in Herdr pane",
                "Wait for agent startup to finish before declaring activated readiness."
              )
            );
          } else if (!obs.interactiveReady) {
            bindingOk = false;
            hasFailed = true;
            checks.push(
              createHealthCheck(
                "native_binding",
                "failed",
                "native_binding_not_interactive_ready",
                "Agent process has not reached interactive ready state",
                "Wait for interactive prompt readiness."
              )
            );
          } else if (
            ["starting", "blocked", "unknown", "disconnected", "cancelled"].includes(
              obs.transportState
            )
          ) {
            bindingOk = false;
            hasFailed = true;
            checks.push(
              createHealthCheck(
                "native_binding",
                "failed",
                "native_binding_transport_blocked",
                `Agent transport state is '${obs.transportState}'`,
                "Wait for agent transport to reach idle or working."
              )
            );
          }
        }

        if (bindingOk) {
          checks.push(
            createHealthCheck(
              "native_binding",
              "passed",
              "native_binding_ok",
              "Native session binding, startup attestation, and live pane observation verified."
            )
          );
        }
      }
    }

    // Determine final status
    let finalStatus: AgentHealthResult["status"];
    if (!hasFailed && !hasUnsupported) {
      finalStatus = "ready";
    } else if (hasUnsupported && !hasFailed) {
      finalStatus = "unsupported";
    } else {
      finalStatus = "blocked";
    }

    const checkedAtIso = nowDate.toISOString();
    const ttlMs = Math.min(Math.max(this.options.healthTtlMs ?? 300_000, 1), 300_000);
    const validUntilIso = new Date(nowDate.getTime() + ttlMs).toISOString();

    const healthResult: AgentHealthResult = {
      schemaVersion: PlatformSchemaVersionSchema.parse(3),
      environmentId: environment.environmentId,
      provider: environment.provider,
      role: environment.role,
      configFingerprint: environment.configFingerprint,
      stage: request.stage,
      status: finalStatus,
      checkedAt: checkedAtIso,
      validUntil: validUntilIso,
      checks,
      ...(finalStatus === "ready" && request.stage === "activated" && request.launchAttestation !== undefined
        ? { launchAttestation: request.launchAttestation }
        : {})
    };

    const parsedResult = AgentHealthResultSchema.safeParse(healthResult);
    if (!parsedResult.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Health result failed schema validation: ${parsedResult.error.message}`
        }
      };
    }

    return {
      ok: true,
      value: parsedResult.data
    };
  }

  async prepareLaunch(
    environment: AgentEnvironment,
    options?: OperationOptions
  ): Promise<OperationResult<AgentLaunchProfile>> {
    // 1. Ingress schema version check
    const rawVersion = (environment as unknown as { schemaVersion?: unknown }).schemaVersion;
    if (rawVersion !== 3) {
      return {
        ok: false,
        error: {
          code: "unsupported_version",
          retryable: false,
          supportedVersions: [3],
          receivedVersion: typeof rawVersion === "number" ? rawVersion : 0,
          message: `Unsupported schema version: ${String(rawVersion)}`
        }
      };
    }

    // 2. Validate environment with Zod
    const parsedEnv = AgentEnvironmentSchema.safeParse(environment);
    if (!parsedEnv.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `AgentEnvironment validation failed: ${parsedEnv.error.message}`
        }
      };
    }

    const effortError = this.effortConfigurationError(environment.provider);
    if (effortError !== undefined) {
      return {
        ok: false,
        error: { code: "validation", retryable: false, message: effortError }
      };
    }

    // 3. Check AbortSignal and deadline
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: {
          code: "cancelled",
          retryable: false,
          message: "Operation cancelled by AbortSignal"
        }
      };
    }

    if (options?.deadline !== undefined && Date.parse(options.deadline) <= Date.now()) {
      return {
        ok: false,
        error: {
          code: "timeout",
          retryable: true,
          retrySafety: "observation_only",
          message: "Operation deadline expired before execution"
        }
      };
    }

    // 4. Validate environment structure & directories
    const envValidation = await validateProviderEnvironment(environment, {
      ...(this.options.allowTestFilesystemOwnership !== undefined
        ? { allowTestFilesystemOwnership: this.options.allowTestFilesystemOwnership }
        : {})
    });
    if (!envValidation.valid) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: envValidation.message ?? "Environment validation failed"
        }
      };
    }

    const executable = this.getExecutablePath();
    let canonicalExecutable: string;
    let executableDigest: string;
    try {
      const resolvedExec = await resolveAndVerifyExecutable(executable, this.executableVerificationOptions());
      canonicalExecutable = resolvedExec.canonicalPath;
      executableDigest = resolvedExec.digest;
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "not_found",
          retryable: false,
          message: `Executable at '${executable}' not found or inaccessible: ${err instanceof Error ? err.message : String(err)}`
        }
      };
    }

    const capabilities = await this.detectCapabilities();
    const minVersion =
      this.options.minimumVersion ?? DEFAULT_MIN_VERSIONS[this.descriptor.provider];
    if (capabilities.version === "0.0.0" || compareSemver(capabilities.version, minVersion) < 0) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Provider '${this.descriptor.provider}' version '${capabilities.version}' is below minimum '${minVersion}'`
        }
      };
    }

    const permResult = await compileProviderPermissions(
      this.descriptor.provider,
      environment.permissionProfile,
      environment.role,
      capabilities,
      {
        cwd: environment.cwd,
        ...hostLaunchPermissionOptions(this.resolveHostLaunchMaterial(capabilities)),
        ...(this.options.osSandboxPath !== undefined ? { osSandboxPath: this.options.osSandboxPath } : {})
      }
    );

    if (!permResult.supported) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: permResult.message
        }
      };
    }

    // 5. Resolve host MCP/hook material before any side effect, then build the private config files
    const material = this.resolveHostLaunchMaterial(capabilities);
    if (material.failure) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: material.failure.message
        }
      };
    }

    const inherited = await this.resolveInheritedIsolation(
      environment,
      capabilities,
      Object.keys(material.mcpServers)
    );
    const inheritedFailure = inherited.mcpFailure ?? inherited.hookFailure;
    if (inheritedFailure !== undefined) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `${inheritedFailure.code}: ${inheritedFailure.message}`
        }
      };
    }

    const rolePrompt =
      this.options.rolePrompt ??
      defaultRolePrompt(environment.role);

    const fullPrompt = this.options.renderedSkillsContent
      ? `${rolePrompt}\n\n# Active Skills\n${this.options.renderedSkillsContent}`
      : rolePrompt;

    const agyHome = this.descriptor.provider === "agy"
      ? await this.prepareAgyLaunchHome(environment)
      : undefined;
    const promptPath = join(environment.stateDirectory, `${environment.role}.system-prompt.txt`);
    const mcpConfigPath = agyHome
      ? join(agyHome, ".gemini", "config", "mcp_config.json")
      : join(environment.stateDirectory, `${environment.role}.mcp-config.json`);
    const settingsPath = agyHome
      ? join(agyHome, ".gemini", "antigravity-cli", "settings.json")
      : join(environment.stateDirectory, `${environment.role}.settings.json`);
    const agyHooksPath = agyHome ? join(agyHome, ".gemini", "config", "hooks.json") : undefined;
    const agySessionHookPath = agyHome ? join(agyHome, ".gemini", "config", "bflow-session-start.mjs") : undefined;

    // Write system prompt file
    const promptFile = await open(
      promptPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await promptFile.writeFile(fullPrompt, "utf8");
    } finally {
      await promptFile.close();
    }
    if (agyHome) await chmod(promptPath, 0o600);

    // Write MCP config file (host servers, stdio and streamable_http registrations; env names only, never token values)
    const mcpServersMap: Record<string, unknown> = { ...material.mcpServers };
    if (agyHome) {
      for (const [serverName, rawServer] of Object.entries(mcpServersMap)) {
        if (typeof rawServer !== "object" || rawServer === null || Array.isArray(rawServer)) continue;
        const server = rawServer as Record<string, unknown>;
        const registration = this.options.mcpRegistrations?.find(item => item.registrationId === serverName);
        const tokenName = registration === undefined ? undefined : this.options.mcpTokenEnvironmentNames?.[registration.registrationId];
        const allowed = new Set([
          "HOME", "XDG_CONFIG_HOME", "PATH", "TMPDIR", "TEMP", "TMP", ...AGY_RUNTIME_ENVIRONMENT_NAMES, "BFLOW_PROVIDER",
          ...(tokenName === undefined ? [] : [tokenName])
        ]);
        const inheritedNames = new Set([
          ...Object.keys(process.env),
          ...Object.keys(this.options.isolatorEnvironment ?? {}),
          ...Object.keys(environment.environmentVariables),
          ...Object.values(this.options.mcpTokenEnvironmentNames ?? {})
        ]);
        const childEnvironment = Object.fromEntries(Array.from(inheritedNames)
          .filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !allowed.has(name))
          .map(name => [name, ""]));
        mcpServersMap[serverName] = { ...server, env: { ...(typeof server.env === "object" && server.env !== null ? server.env as Record<string, unknown> : {}), ...childEnvironment } };
      }
    }
    const mcpFile = await open(
      mcpConfigPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await mcpFile.writeFile(JSON.stringify({ mcpServers: mcpServersMap }, null, 2), "utf8");
    } finally {
      await mcpFile.close();
    }
    if (agyHome) await chmod(mcpConfigPath, 0o600);

    // Write settings file (with native session hooks and provider-specific permissions/trust)
    const settingsObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inherited.settingsMetadata ?? {})) settingsObj[key] = value;
    if (Object.keys(material.hooks).length > 0 && this.descriptor.provider !== "agy") {
      settingsObj["hooks"] = material.hooks;
    }
    if (this.descriptor.provider === "agy") {
      const trustedFolders = Array.from(
        new Set([
          environment.cwd,
          ...environment.permissionProfile.readableRoots,
          ...environment.permissionProfile.writableRoots
        ])
      );
      settingsObj["permissions"] = {
        allow: permResult.settingsPermissionsAllow ?? [],
        deny: permResult.settingsPermissionsDeny ?? []
      };
      settingsObj["trustedWorkspaces"] = trustedFolders;
    } else if (this.descriptor.provider === "claude") {
      settingsObj["permissions"] = {
        allow: permResult.allowedTools ?? [],
        deny: permResult.disallowedTools ?? []
      };
    }

    const settingsFile = await open(
      settingsPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await settingsFile.writeFile(JSON.stringify(settingsObj, null, 2) + (agyHome ? "\n" : ""), "utf8");
    } finally {
      await settingsFile.close();
    }
    if (agyHome) await chmod(settingsPath, 0o600);

    if (agyHooksPath && agySessionHookPath) {
      const promptScript = [
        'import { readFileSync } from "node:fs";',
        'let raw = ""; for await (const chunk of process.stdin) raw += chunk;',
        'let event; try { event = JSON.parse(raw); } catch { process.exit(2); }',
        'if (!event || typeof event.conversationId !== "string" || !Array.isArray(event.workspacePaths)) process.exit(2);',
        `const systemMessage = readFileSync(${JSON.stringify(promptPath)}, "utf8");`,
        'process.stdout.write(JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage } }] }) + "\\n");',
        ""
      ].join("\n");
      const hookScriptFile = await open(
        agySessionHookPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600
      );
      try { await hookScriptFile.writeFile(promptScript, "utf8"); } finally { await hookScriptFile.close(); }
      await chmod(agySessionHookPath, 0o600);

      const sessionStartHandlers = [...(material.hooks.SessionStart ?? [])];
      sessionStartHandlers.push({ type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(agySessionHookPath)}`, timeout: 30 });
      const nativeHookGroup: Record<string, unknown> = { SessionStart: sessionStartHandlers };
      if (material.hooks.PreToolUse !== undefined) nativeHookGroup["PreToolUse"] = material.hooks.PreToolUse;
      if (material.hooks.Stop !== undefined) nativeHookGroup["Stop"] = material.hooks.Stop;
      if (material.hooks.PreInvocation !== undefined) nativeHookGroup["PreInvocation"] = material.hooks.PreInvocation;
      const hooksFile = await open(
        agyHooksPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600
      );
      try { await hooksFile.writeFile(JSON.stringify({ bflow: nativeHookGroup }, null, 2), "utf8"); } finally { await hooksFile.close(); }
      await chmod(agyHooksPath, 0o600);
    }

    const agyWrapperPath = agyHome ? join(agyHome, "bin", "agy") : undefined;
    if (agyWrapperPath && this.descriptor.provider === "agy") {
      const shell = await this.buildAgyEnvironmentWrapper({ environment, home: agyHome!, executable: canonicalExecutable });
      const wrapper = await open(agyWrapperPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o700);
      try { await wrapper.writeFile(shell, "utf8"); } finally { await wrapper.close(); }
      await chmod(agyWrapperPath, 0o700);
    }

    // Compute digests of written files
    const promptDigest = await computeFileSha256(promptPath);
    const mcpDigest = await computeFileSha256(mcpConfigPath);
    const settingsDigest = await computeFileSha256(settingsPath);

    const configFiles = [
      { path: promptPath, digest: promptDigest },
      { path: mcpConfigPath, digest: mcpDigest },
      { path: settingsPath, digest: settingsDigest }
    ];
    if (agyHooksPath && agySessionHookPath) {
      configFiles.push({ path: agyHooksPath, digest: await computeFileSha256(agyHooksPath) });
      configFiles.push({ path: agySessionHookPath, digest: await computeFileSha256(agySessionHookPath) });
    }
    if (agyWrapperPath) configFiles.push({ path: agyWrapperPath, digest: await computeFileSha256(agyWrapperPath) });
    if (this.descriptor.provider === "codex") {
      for (const fileName of ["config.toml", "auth.json"]) {
        const candidatePath = join(environment.stateDirectory, "codex-home", fileName);
        try {
          const info = await lstat(candidatePath);
          if (info.isFile()) {
            configFiles.push({ path: candidatePath, digest: await computeLaunchConfigDigest(candidatePath, this.descriptor.provider) });
          }
        } catch {
          // Private codex-home is absent when native_auth_compatible or isolator is used
        }
      }
    }

    // Compile provider argv
    const compiled = await this.compileArgv(
      environment,
      { promptFile: promptPath, mcpConfigFile: mcpConfigPath, settingsFile: settingsPath },
      capabilities,
      inherited
    );

    if (compiled.unsupportedCode) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: compiled.unsupportedMessage ?? "Unsupported launch configuration"
        }
      };
    }

    if (inherited.settingsMetadata !== undefined) {
      const current = await this.resolveInheritedIsolation(environment, capabilities, Object.keys(material.mcpServers));
      const failure = current.hookFailure ?? current.mcpFailure;
      if (failure !== undefined) return {
        ok: false,
        error: { code: "validation", retryable: false, message: `${failure.code}: ${failure.message}` }
      };
      if (canonicalReceiptJson(current.settingsMetadata ?? {}) !== canonicalReceiptJson(inherited.settingsMetadata) ||
          canonicalReceiptJson(current.argv) !== canonicalReceiptJson(inherited.argv)) return {
        ok: false,
        error: { code: "conflict", retryable: true,
          message: "Provider inherited configuration changed during launch preparation; review the current snapshot and prepare again." }
      };
    }

    const interaction: "conversation" | "no_direct_user_input" =
      environment.role === "conversation" ? "conversation" : "no_direct_user_input";

    const launchFingerprint = computeLaunchFingerprint({
      environment,
      executableDigest,
      providerVersion: capabilities.version,
      argv: compiled.argv,
      configFiles,
      interaction
    });

    const launchId = `launch-${environment.provider}-${environment.role}-${launchFingerprint.slice(0, 12)}`;
    const nowDate = this.options.now ? this.options.now() : new Date();
    const expiresAt = new Date(nowDate.getTime() + 3_600_000).toISOString();

    const profile: AgentLaunchProfile = {
      schemaVersion: PlatformSchemaVersionSchema.parse(3),
      launchId,
      environment,
      providerVersion: capabilities.version,
      executable: canonicalExecutable,
      executableDigest,
      argv: [...compiled.argv],
      configFiles,
      launchFingerprint,
      interaction,
      expiresAt
    };

    const parsedProfile = AgentLaunchProfileSchema.safeParse(profile);
    if (!parsedProfile.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Launch profile validation failed: ${parsedProfile.error.message}`
        }
      };
    }

    return {
      ok: true,
      value: parsedProfile.data
    };
  }

  private async prepareAgySessionHome(environment: AgentEnvironment): Promise<string | undefined> {
    if (this.options.isolatorEnvironment?.["HOME"] !== undefined) return this.options.isolatorEnvironment["HOME"];
    return this.prepareAgyLaunchHome(environment);
  }

  private async buildAgyEnvironmentWrapper(input: {
    readonly environment: AgentEnvironment;
    readonly home: string;
    readonly executable: string;
  }): Promise<string> {
    // Herdr inherits the pane environment. Rebuild Agy's environment from an explicit allowlist so
    // arbitrary secrets and Node runtime overrides cannot leak into Agy or its MCP children.
    const names = new Set<string>([
      "PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR", "TEMP", "TMP", "TERM", "COLORTERM", "NO_COLOR",
      "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR",
      "GNOME_KEYRING_CONTROL", "GPG_TTY", "HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_SESSION",
      "BFLOW_LAUNCH_ID", "BFLOW_ENVIRONMENT_ID", "BFLOW_PROVIDER"
    ]);
    for (const name of Object.keys(input.environment.environmentVariables)) {
      if (!AGY_SECRET_ENV_NAME_PATTERN.test(name)) names.add(name);
    }
    for (const name of Object.keys(input.environment.secretBindings)) names.add(name);
    for (const name of Object.values(this.options.mcpTokenEnvironmentNames ?? {})) names.add(name);
    const validNames = [...names].filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).sort();
    const assignments = validNames.map(name => {
      if (name === "HOME") return `HOME=${shellQuote(input.home)}`;
      if (name === "XDG_CONFIG_HOME") return `XDG_CONFIG_HOME=${shellQuote(join(input.home, ".config"))}`;
      if (name === "XDG_DATA_HOME") return `XDG_DATA_HOME=${shellQuote(join(input.home, ".local", "share"))}`;
      if (name === "XDG_STATE_HOME") return `XDG_STATE_HOME=${shellQuote(join(input.home, ".local", "state"))}`;
      if (name === "XDG_CACHE_HOME") return `XDG_CACHE_HOME=${shellQuote(join(input.home, ".cache"))}`;
      return `${name}="\${${name}-}"`;
    }).join(" \\\n  ");
    return [
      "#!/bin/sh",
      "set -eu",
      `exec /usr/bin/env -i ${assignments} ${shellQuote(input.executable)} "$@"`,
      ""
    ].join("\n");
  }

  private async prepareAgyLaunchHome(environment: AgentEnvironment): Promise<string | undefined> {
    try {
      const stateStat = await stat(environment.stateDirectory);
      if (!stateStat.isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    const agyHome = join(environment.stateDirectory, "agy-home", environment.role);
    const configDir = join(agyHome, ".gemini", "config");
    const targetCliDir = join(agyHome, ".gemini", "antigravity-cli");
    const xdgConfigDir = join(agyHome, ".config");
    const wrapperBinDir = join(agyHome, "bin");
    const cacheDir = join(targetCliDir, "cache");
    for (const directory of [join(environment.stateDirectory, "agy-home"), agyHome, join(agyHome, ".gemini"), configDir, targetCliDir, cacheDir, xdgConfigDir, wrapperBinDir]) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory ||
          typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new Error("Unsafe Agy private configuration directory");
      await chmod(directory, 0o700);
    }
    await this.adoptCompletedAgyOnboarding(agyHome);
    await this.adoptNativeAgyKeychains(agyHome);
    const trustedWorkspaces = Array.from(
      new Set([
        environment.cwd,
        ...environment.permissionProfile.readableRoots,
        ...environment.permissionProfile.writableRoots
      ])
    );

    // A readiness probe must never erase the compiled permissions/config of an already prepared launch.
    const settingsPath = join(targetCliDir, "settings.json");
    try {
      const settingsFile = await open(settingsPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await settingsFile.writeFile(JSON.stringify({ trustedWorkspaces }, null, 2), "utf8"); }
      finally { await settingsFile.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await lstat(settingsPath);
      if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0 ||
          typeof process.getuid === "function" && existing.uid !== process.getuid()) throw new Error("Unsafe existing Agy native settings");
    }

    // Prevent interactive zsh in Herdr panes from blocking on zsh-newuser-install or global compinit when HOME is isolated.
    for (const [rcName, rcContent] of [[".zshenv", "skip_global_compinit=1\n"], [".zshrc", "# Bflow isolated Agy shell home\n"]] as const) {
      const rcPath = join(agyHome, rcName);
      try {
        const rcFile = await open(rcPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await rcFile.writeFile(rcContent, "utf8"); }
        finally { await rcFile.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await lstat(rcPath);
        if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0 ||
            typeof process.getuid === "function" && existing.uid !== process.getuid()) throw new Error(`Unsafe existing Agy shell file ${rcName}`);
      }
    }
    return agyHome;
  }

  private async hasCompletedAgyOnboarding(environment: AgentEnvironment): Promise<boolean> {
    const home = join(environment.stateDirectory, "agy-home", environment.role);
    const path = join(home, ".gemini", "antigravity-cli", "cache", "onboarding.json");
    try {
      let cursor = parse(path).root;
      for (const component of path.slice(cursor.length).split(sep).filter(Boolean)) {
        cursor = join(cursor, component);
        const info = await lstat(cursor);
        if (info.isSymbolicLink() || cursor !== path && !info.isDirectory()) return false;
        if (cursor === home || cursor.startsWith(home + sep)) {
          if (typeof process.getuid === "function" && info.uid !== process.getuid() || (info.mode & 0o022) !== 0) return false;
        }
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 64 * 1024 || (info.mode & 0o022) !== 0 ||
            typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
        const bytes = await handle.readFile();
        if (bytes.length > 64 * 1024) return false;
        const receipt: unknown = JSON.parse(bytes.toString("utf8"));
        return typeof receipt === "object" && receipt !== null && !Array.isArray(receipt) &&
          (receipt as Record<string, unknown>).onboardingComplete === true;
      } finally { await handle.close(); }
    } catch { return false; }
  }

  private async adoptCompletedAgyOnboarding(privateHome: string): Promise<void> {
    const nativeHome = this.options.isolatorEnvironment?.HOME ?? process.env.HOME;
    if (!nativeHome) return;
    const resolvedNativeHome = resolve(nativeHome);
    let homeCursor = parse(resolvedNativeHome).root;
    let protectedNativeHome = false;
    for (const component of resolvedNativeHome.slice(homeCursor.length).split(sep).filter(Boolean)) {
      homeCursor = join(homeCursor, component);
      let nativeHomeInfo;
      try { nativeHomeInfo = await lstat(homeCursor); } catch { return; }
      if (nativeHomeInfo.isSymbolicLink() || !nativeHomeInfo.isDirectory()) return;
      if (homeCursor === resolvedNativeHome) {
        if ((typeof process.getuid === "function" && nativeHomeInfo.uid !== process.getuid()) || (nativeHomeInfo.mode & 0o022) !== 0) return;
        protectedNativeHome = (nativeHomeInfo.mode & 0o007) === 0;
      }
    }
    const sourceHome = join(resolvedNativeHome, ".gemini", "antigravity-cli", "cache");
    const source = join(sourceHome, "onboarding.json");
    let cursor = nativeHome;
    for (const component of [".gemini", "antigravity-cli", "cache", "onboarding.json"]) {
      cursor = join(cursor, component);
      let info;
      try { info = await lstat(cursor); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const isFile = component === "onboarding.json";
      if (info.isSymbolicLink()) return;
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) return;
      if (isFile) {
        if (!info.isFile() || (info.mode & 0o022) !== 0 || info.size > 64 * 1024) return;
      } else {
        const allowPrivateGroupDir =
          protectedNativeHome &&
          (info.mode & 0o002) === 0 &&
          (typeof process.getgid !== "function" || (info.gid === process.getgid() && info.uid === info.gid));
        if (!info.isDirectory() || ((info.mode & 0o022) !== 0 && !allowPrivateGroupDir)) return;
      }
    }
    let sourceHandle;
    try { sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { return; }
    let bytes: Buffer;
    try {
      const info = await sourceHandle.stat();
      if (!info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o022) !== 0 || info.size > 64 * 1024)
        throw new Error("Agy onboarding receipt failed protected-file validation");
      bytes = await sourceHandle.readFile();
      if (bytes.length > 64 * 1024) throw new Error("Agy onboarding receipt exceeds the size limit");
    } finally { await sourceHandle.close(); }
    let receipt: unknown;
    try { receipt = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("Agy onboarding receipt is malformed JSON"); }
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt) || (receipt as Record<string, unknown>).onboardingComplete !== true) return;

    const destination = join(privateHome, ".gemini", "antigravity-cli", "cache", "onboarding.json");
    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink() || !existing.isFile() || (typeof process.getuid === "function" && existing.uid !== process.getuid()) || (existing.mode & 0o077) !== 0)
        throw new Error("Unsafe existing private Agy onboarding receipt");
      const existingHandle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const existingBytes = await existingHandle.readFile();
        const existingReceipt: unknown = JSON.parse(existingBytes.toString("utf8"));
        if (typeof existingReceipt === "object" && existingReceipt !== null && !Array.isArray(existingReceipt) &&
            (existingReceipt as Record<string, unknown>).onboardingComplete === true) {
          return;
        }
      } catch {
        // Replace malformed or incomplete private receipt with the verified completed receipt.
      } finally {
        await existingHandle.close();
      }
      await unlink(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const target = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await target.writeFile(bytes); } finally { await target.close(); }
    await chmod(destination, 0o600);
  }

  private async resolveVerifiedNativeAgyKeychains(): Promise<string | undefined> {
    const isolatorHome = this.options.isolatorEnvironment?.HOME;
    const isolatorRealHome = this.options.isolatorEnvironment?.["AI_ISOLATOR_REAL_HOME"];
    const candidates = isolatorHome !== undefined
      ? [isolatorHome, ...(isolatorRealHome !== undefined && isolatorRealHome !== isolatorHome ? [isolatorRealHome] : [])]
      : [process.env.HOME];
    const expectedRealKeychains = isolatorRealHome ? join(resolve(isolatorRealHome), "Library", "Keychains") : undefined;

    for (const candidate of candidates) {
      if (!candidate) return undefined;
      const resolvedNativeHome = resolve(candidate);
      let homeCursor = parse(resolvedNativeHome).root;
      let homeValid = true;
      for (const component of resolvedNativeHome.slice(homeCursor.length).split(sep).filter(Boolean)) {
        homeCursor = join(homeCursor, component);
        let nativeHomeInfo;
        try { nativeHomeInfo = await lstat(homeCursor); } catch { homeValid = false; break; }
        if (nativeHomeInfo.isSymbolicLink() || !nativeHomeInfo.isDirectory()) { homeValid = false; break; }
        if (homeCursor === resolvedNativeHome && ((typeof process.getuid === "function" && nativeHomeInfo.uid !== process.getuid()) || (nativeHomeInfo.mode & 0o022) !== 0)) {
          homeValid = false;
          break;
        }
      }
      if (!homeValid) return undefined;

      let cursor = resolvedNativeHome;
      let missingInCandidate = false;
      for (const component of ["Library", "Keychains"]) {
        cursor = join(cursor, component);
        let info;
        try { info = await lstat(cursor); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            missingInCandidate = true;
            break;
          }
          throw error;
        }
        if (info.isSymbolicLink()) {
          if (candidate === isolatorHome && component === "Keychains" && expectedRealKeychains !== undefined &&
              (typeof process.getuid !== "function" || info.uid === process.getuid()) &&
              await readlink(cursor).catch(() => "") === expectedRealKeychains) {
            missingInCandidate = true;
            break;
          }
          return undefined;
        }
        if (!info.isDirectory()) return undefined;
        if ((typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o022) !== 0) return undefined;
      }
      if (missingInCandidate) continue;
      return join(resolvedNativeHome, "Library", "Keychains");
    }
    return undefined;
  }

  private async adoptNativeAgyKeychains(privateHome: string): Promise<void> {
    const sourceKeychains = await this.resolveVerifiedNativeAgyKeychains();
    const privateLibraryDir = join(privateHome, "Library");
    const destinationKeychains = join(privateLibraryDir, "Keychains");
    if (sourceKeychains === undefined) {
      try {
        const existing = await lstat(destinationKeychains);
        if (!existing.isSymbolicLink() || (typeof process.getuid === "function" && existing.uid !== process.getuid()))
          throw new Error("Unsafe existing private Agy Keychains link");
        await unlink(destinationKeychains);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    try { await mkdir(privateLibraryDir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const libraryInfo = await lstat(privateLibraryDir);
    if (!libraryInfo.isDirectory() || libraryInfo.isSymbolicLink() || await realpath(privateLibraryDir) !== privateLibraryDir ||
        (typeof process.getuid === "function" && libraryInfo.uid !== process.getuid()))
      throw new Error("Unsafe Agy private Library directory");
    await chmod(privateLibraryDir, 0o700);

    try {
      const existing = await lstat(destinationKeychains);
      if (!existing.isSymbolicLink() || (typeof process.getuid === "function" && existing.uid !== process.getuid()))
        throw new Error("Unsafe existing private Agy Keychains link");
      if (await readlink(destinationKeychains) === sourceKeychains) return;
      await unlink(destinationKeychains);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await symlink(sourceKeychains, destinationKeychains, "dir");
  }
}
