import { AGY_LOGIN_REMEDIATION, probeAgyAccess } from "./agy-access.js";
import { access, readFile } from "node:fs/promises";
import { constants, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { diagnoseVerificationSandbox, resolvePrivateRuntimeStateDirectory } from "@bflow/runtime";
import {
  detectPlatform,
  defaultHostEnvironment,
  loadMachineConfig,
  MACHINE_CONFIG_FILE
} from "@bflow/machine-setup";
import {
  EnvironmentDoctorReportSchema,
  EnvironmentDoctorCheckSchema,
  type EnvironmentDoctorCheck,
  type EnvironmentDoctorReport
} from "@bflow/contracts";
import type { EnvironmentConfig } from "./environment-config.js";
import { namedSessionEnvironment, type EnvironmentProcessRunner } from "./environment-process.js";
import type { RepositoryIdentity } from "./repository.js";
import type { EnvironmentDependencies, EnvironmentIntegration } from "./environment.js";
import { lifecycleLockStatus } from "./lifecycle-lock.js";
import { probeDoctorModels } from "./provider-model-diagnostics.js";
import { RolePreflightSummarySchema } from "@bflow/runtime";
import { scrubDiagnosticText } from "@bflow/agent-providers";
import { resolveIsolatorStateRoot } from "./platform-options.js";
import { homedir } from "node:os";

export type DoctorCheckStatus = "pass" | "warning" | "fail" | "skipped";
export type DoctorGroupName = "runtime" | "agent_providers" | "mcp" | "tools" | "skills";

export interface DoctorDetailedCheck {
  readonly checkId: string;
  readonly group: DoctorGroupName;
  readonly component: string;
  readonly status: DoctorCheckStatus;
  readonly detected_version: string | null;
  readonly reason: string;
  readonly remediation: string;
  readonly repair_command?: string;
}

export interface DoctorGroupedMetadata {
  readonly groups: {
    readonly runtime: readonly DoctorDetailedCheck[];
    readonly agent_providers: readonly DoctorDetailedCheck[];
    readonly mcp: readonly DoctorDetailedCheck[];
    readonly tools: readonly DoctorDetailedCheck[];
    readonly skills: readonly DoctorDetailedCheck[];
  };
  readonly results: readonly DoctorDetailedCheck[];
}

export interface DoctorDiagnosticsOptions {
  readonly deep?: boolean;
  readonly repository: RepositoryIdentity;
  readonly config: EnvironmentConfig | null;
  readonly runner: EnvironmentProcessRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly dependencies?: EnvironmentDependencies;
  readonly probeSession?: (config: EnvironmentConfig) => Promise<boolean>;
  readonly integration?: (config: EnvironmentConfig) => Promise<EnvironmentIntegration | undefined>;
  readonly intent?: () => Promise<{ phase: string } | null>;
  readonly statePath?: (name: string) => string;
}

/** Dynamic package loaders avoiding direct dependencies in apps/cli/package.json */
export async function loadToolInstallerModule(): Promise<any> {
  try {
    return await import(new URL("../../../packages/tool-installer/dist/index.js", import.meta.url).href);
  } catch {
    return null;
  }
}

export async function loadSkillsModule(): Promise<any> {
  try {
    return await import(new URL("../../../packages/skills/dist/index.js", import.meta.url).href);
  } catch {
    return null;
  }
}

export async function loadMcpGatewayModule(): Promise<any> {
  try {
    return await import(new URL("../../../packages/mcp-gateway/dist/index.js", import.meta.url).href);
  } catch {
    return null;
  }
}

/** Check the selected Codex profile that Runtime will use. Linked backends use their
 * authenticated model catalog endpoint, which verifies access without inference.
 * Return only status evidence: native auth output can contain account information. */
async function probeSelectedCodexProfile(profileName: string, environment: NodeJS.ProcessEnv,
  cwd: string, runner: EnvironmentProcessRunner): Promise<{ authenticated: boolean; modelCatalogVerified: boolean }> {
  const runtimeProfiles = await import(new URL("../../../packages/runtime/dist/platform/isolator-profile.js", import.meta.url).href);
  const stateRoot = resolveIsolatorStateRoot(environment, environment.HOME ?? homedir());
  const result = await new runtimeProfiles.IsolatorProfileResolver({ stateRoot, environment }).resolve("codex", profileName, { timeoutMs: 8000 });
  if (!result.ok) return { authenticated: false, modelCatalogVerified: false };
  const profile = result.value;
  if (profile.identity.codexBackendMode === "linked" && profile.backendUrl) {
    const backendAuth = await import(new URL("../../../packages/agent-providers/dist/backend-authentication.js", import.meta.url).href);
    const checked = await backendAuth.checkCodexBackendAuthentication(profile.backendUrl, profile.environment.CODEX_LB_API_KEY,
      { timeoutMs: 8000 });
    return { authenticated: checked.exitCode === 0, modelCatalogVerified: checked.exitCode === 0 };
  }
  const checked = await runner.run({ executable: "codex", args: ["login", "status"], cwd,
    env: { ...namedSessionEnvironment("doctor", environment), ...profile.environment }, timeoutMs: 5000 });
  return { authenticated: checked.exitCode === 0, modelCatalogVerified: false };
}

function cleanDetailedCheck(check: DoctorDetailedCheck): DoctorDetailedCheck {
  const result: any = {
    checkId: check.checkId,
    group: check.group,
    component: check.component,
    status: check.status,
    detected_version: check.detected_version ?? null,
    reason: check.reason,
    remediation: check.remediation
  };
  if (check.repair_command) {
    result.repair_command = check.repair_command;
  }
  return result;
}

export async function runDoctorDiagnostics(
  options: DoctorDiagnosticsOptions
): Promise<EnvironmentDoctorReport> {
  const { repository, config, runner, dependencies } = options;
  const progress = (phase: string) => { try { dependencies?.onProgress?.(phase); } catch { /* observational only */ } };
  const env = namedSessionEnvironment(repository.sessionName, options.env);
  progress("Đang kiểm tra sức khỏe Runtime và vòng đời phiên...");
  const runtimeChecks: DoctorDetailedCheck[] = [];
  const agentProviderChecks: DoctorDetailedCheck[] = [];
  const mcpChecks: DoctorDetailedCheck[] = [];
  const toolChecks: DoctorDetailedCheck[] = [];
  const skillChecks: DoctorDetailedCheck[] = [];
  const legacyChecks: EnvironmentDoctorCheck[] = [];

  // ==========================================
  // Group 1: runtime
  // ==========================================

  // runtime-os
  const platform = process.platform;
  const arch = process.arch;
  const osVersion = `${platform}-${arch}`;
  if (platform === "linux" || platform === "darwin") {
    runtimeChecks.push({
      checkId: "runtime-os",
      group: "runtime",
      component: "os",
      status: "pass",
      detected_version: osVersion,
      reason: `Operating system '${platform}' (${arch}) is supported.`,
      remediation: ""
    });
  } else if (platform === "win32") {
    runtimeChecks.push({
      checkId: "runtime-os",
      group: "runtime",
      component: "os",
      status: "warning",
      detected_version: osVersion,
      reason: "Windows (win32) has partial support; WSL2 is recommended for Unix socket and Herdr process isolation.",
      remediation: "Run Bflow inside WSL2 on Windows."
    });
  } else {
    runtimeChecks.push({
      checkId: "runtime-os",
      group: "runtime",
      component: "os",
      status: "fail",
      detected_version: osVersion,
      reason: `Operating system '${platform}' is not supported.`,
      remediation: "Run Bflow on Linux or macOS."
    });
  }

  // runtime-verification-sandbox
  const sandbox = EnvironmentDoctorCheckSchema.parse(await diagnoseVerificationSandbox(repository.root));
  runtimeChecks.push({
    checkId: sandbox.checkId, group: "runtime", component: "verification-sandbox",
    status: sandbox.status === "passed" ? "pass" : sandbox.status === "warn" ? "warning" : "fail",
    detected_version: null, reason: sandbox.message, remediation: sandbox.remediation ?? ""
  });

  // runtime-node
  const nodeVersion = process.versions.node;
  const [major = 0, minor = 0] = nodeVersion.split(".").map(Number);
  const nodePass = major > 22 || (major === 22 && minor >= 13);
  runtimeChecks.push({
    checkId: "runtime-node",
    group: "runtime",
    component: "node",
    status: nodePass ? "pass" : "fail",
    detected_version: nodeVersion,
    reason: nodePass
      ? `Node.js ${nodeVersion} satisfies requirement (>= 22.13.0).`
      : `Node.js ${nodeVersion} does not satisfy requirement (>= 22.13.0).`,
    remediation: nodePass ? "" : "Upgrade Node.js to >= 22.13.0."
  });
  legacyChecks.push({
    checkId: "node",
    name: "Node.js >=22.13",
    status: nodePass ? "passed" : "failed",
    message: process.version
  });

  // runtime-pnpm
  let pnpmVersion: string | null = null;
  let pnpmStatus: DoctorCheckStatus = "pass";
  let pnpmReason = "";
  let pnpmRemediation = "";
  try {
    const res = await runner.run({
      executable: "pnpm",
      args: ["--version"],
      cwd: repository.root,
      env,
      timeoutMs: 5000
    });
    if (res.exitCode === 0) {
      let v = res.stdout.trim();
      if (!v || v === "{}") {
        v = "detected";
      }
      pnpmVersion = v;
      pnpmStatus = "pass";
      pnpmReason = `pnpm binary available (${v}).`;
    } else {
      pnpmStatus = "fail";
      pnpmReason = `pnpm failed with exit code ${res.exitCode}: ${res.stderr.trim()}`;
      pnpmRemediation = "Install pnpm (https://pnpm.io).";
    }
  } catch (error) {
    pnpmStatus = "fail";
    pnpmReason = `pnpm binary is unavailable: ${String(error)}`;
    pnpmRemediation = "Install pnpm (https://pnpm.io).";
  }
  runtimeChecks.push({
    checkId: "runtime-pnpm",
    group: "runtime",
    component: "pnpm",
    status: pnpmStatus,
    detected_version: pnpmVersion,
    reason: pnpmReason,
    remediation: pnpmRemediation
  });
  legacyChecks.push({
    checkId: "pnpm",
    name: "pnpm",
    status: pnpmStatus === "pass" ? "passed" : "failed",
    message: pnpmReason,
    ...(pnpmRemediation ? { remediation: pnpmRemediation } : {})
  });

  // git
  let gitVersion: string | null = null;
  let gitStatus: DoctorCheckStatus = "pass";
  let gitReason = "";
  let gitRemediation = "";
  try {
    const gitRes = await runner.run({
      executable: "git",
      args: ["--version"],
      cwd: repository.root,
      env,
      timeoutMs: 5000
    });
    if (gitRes.exitCode === 0) {
      gitVersion = gitRes.stdout.trim();
      gitReason = `Git binary available (${gitVersion}).`;
    } else {
      gitStatus = "fail";
      gitReason = `git --version failed: ${gitRes.stderr.trim()}`;
      gitRemediation = "Install Git and ensure it is on PATH.";
    }
  } catch (error) {
    gitStatus = "fail";
    gitReason = `Git binary is unavailable: ${String(error)}`;
    gitRemediation = "Install Git and ensure it is on PATH.";
  }
  runtimeChecks.push({
    checkId: "git",
    group: "runtime",
    component: "git",
    status: gitStatus,
    detected_version: gitVersion,
    reason: gitReason,
    remediation: gitRemediation
  });

  // herdr binary & compatibility
  const herdrBinary = config?.environment?.herdrBinary ?? "herdr";
  let herdrStatus: DoctorCheckStatus = "pass";
  let herdrReason = "";
  let herdrRemediation = "";
  try {
    const helpRes = await runner.run({
      executable: herdrBinary,
      args: ["--help"],
      cwd: repository.root,
      env,
      timeoutMs: 5000
    });
    if (helpRes.exitCode === 0 && helpRes.stdout.includes("--session") && helpRes.stdout.includes("headless")) {
      herdrReason = "Named-session/headless CLI and protocol 22/schema 1 available";
    } else {
      herdrStatus = "fail";
      herdrReason = "Installed Herdr does not advertise named sessions/headless server";
      herdrRemediation = "Upgrade or reinstall Herdr CLI.";
    }
  } catch (error) {
    herdrStatus = "fail";
    herdrReason = `Herdr CLI is unavailable: ${String(error)}`;
    herdrRemediation = "Install Herdr CLI and ensure it is on PATH.";
  }
  runtimeChecks.push({
    checkId: "herdr",
    group: "runtime",
    component: "herdr",
    status: herdrStatus,
    detected_version: null,
    reason: herdrReason,
    remediation: herdrRemediation
  });

  // herdr-protocol
  let protocolStatus: DoctorCheckStatus = "pass";
  let protocolVersion: string | null = null;
  let protocolReason = "";
  let protocolRemediation = "";
  try {
    const schemaRes = await runner.run({
      executable: herdrBinary,
      args: ["api", "schema", "--json"],
      cwd: repository.root,
      env,
      timeoutMs: 5000
    });
    if (schemaRes.exitCode === 0) {
      try {
        const schema = JSON.parse(schemaRes.stdout);
        if (schema["protocol"] === 22 && schema["schema_version"] === 1) {
          protocolVersion = "protocol:22,schema:1";
          protocolReason = "Herdr protocol 22 and schema 1 supported.";
        } else {
          protocolStatus = "fail";
          protocolReason = "Unsupported Herdr API: expected protocol 22/schema 1";
          protocolRemediation = "Upgrade Herdr CLI to a version supporting protocol 22/schema 1.";
        }
      } catch {
        protocolStatus = "fail";
        protocolReason = "Malformed Herdr API schema output.";
        protocolRemediation = "Check Herdr CLI installation.";
      }
    } else {
      protocolStatus = "fail";
      protocolReason = `Herdr API schema query failed: ${schemaRes.stderr.trim()}`;
      protocolRemediation = "Ensure Herdr CLI is functioning properly.";
    }
  } catch (error) {
    protocolStatus = "fail";
    protocolReason = `Failed to query Herdr API schema: ${String(error)}`;
    protocolRemediation = "Ensure Herdr CLI is functioning properly.";
  }
  runtimeChecks.push({
    checkId: "herdr-protocol",
    group: "runtime",
    component: "herdr",
    status: protocolStatus,
    detected_version: protocolVersion,
    reason: protocolReason,
    remediation: protocolRemediation
  });

  // herdr-session
  let sessionStatus: DoctorCheckStatus = "pass";
  let sessionVersion: string | null = null;
  let sessionReason = "";
  try {
    const sRes = await runner.run({
      executable: herdrBinary,
      args: ["status", "server", "--json"],
      cwd: repository.root,
      env,
      timeoutMs: 5000
    });
    if (sRes.exitCode === 0) {
      try {
        const parsed = JSON.parse(sRes.stdout);
        if (parsed["session"] === repository.sessionName && typeof parsed["running"] === "boolean") {
          const isRunning = parsed["running"] === true;
          sessionVersion = isRunning ? "running" : "stopped";
          sessionReason = isRunning
            ? "Repository named session is running"
            : "Repository named session is stopped (run bflow up)";
        } else {
          sessionStatus = "fail";
          sessionReason = "Herdr returned an uncorrelated session status";
        }
      } catch {
        sessionStatus = "fail";
        sessionReason = "Malformed JSON from Herdr server status";
      }
    } else {
      sessionStatus = "fail";
      sessionReason = `Herdr status server check failed: ${sRes.stderr.trim()}`;
    }
  } catch (error) {
    sessionStatus = "fail";
    sessionReason = `Failed to probe Herdr server status: ${String(error)}`;
  }
  runtimeChecks.push({
    checkId: "herdr-session",
    group: "runtime",
    component: "herdr",
    status: sessionStatus,
    detected_version: sessionVersion,
    reason: sessionReason,
    remediation: sessionStatus === "fail" ? "Verify Herdr installation and permissions." : ""
  });
  legacyChecks.push({
    checkId: "session",
    name: "session",
    status: sessionStatus === "pass" ? "passed" : "failed",
    message: sessionReason
  });

  // config / configuration
  const configValid = config !== null;
  runtimeChecks.push({
    checkId: "config",
    group: "runtime",
    component: "config",
    status: configValid ? "pass" : "fail",
    detected_version: config ? (config.schemaVersion ?? "1") : null,
    reason: configValid
      ? "Valid .bflow/config.yml and repository identity"
      : "Invalid or missing .bflow/config.yml or mismatched repository identity",
    remediation: configValid ? "" : "Run 'bflow init' to initialize repository configuration."
  });
  legacyChecks.push({
    checkId: "configuration",
    name: "configuration",
    status: configValid ? "passed" : "failed",
    message: configValid
      ? "Valid .bflow/config.yml and repository identity"
      : "Invalid .bflow/config.yml"
  });

  // legacy flock & permissions
  try {
    const flockRes = await runner.run({ executable: "flock", args: ["--version"], cwd: repository.root, env, timeoutMs: 5000 });
    legacyChecks.push({
      checkId: "flock",
      name: "flock",
      status: flockRes.exitCode === 0 ? "passed" : "failed",
      message: flockRes.exitCode === 0 ? "flock available" : "flock failed"
    });
  } catch (error) {
    legacyChecks.push({
      checkId: "flock",
      name: "flock",
      status: "failed",
      message: `flock unavailable: ${String(error)}`
    });
  }

  try {
    await access(repository.root, constants.R_OK | constants.W_OK);
    legacyChecks.push({
      checkId: "permissions",
      name: "permissions",
      status: "passed",
      message: "Repository is readable/writable"
    });
  } catch (error) {
    legacyChecks.push({
      checkId: "permissions",
      name: "permissions",
      status: "failed",
      message: `Repository permissions check failed: ${String(error)}`
    });
  }

  // Resolve exactly the same private authority used by host startup and recovery.
  try {
    const privateState = resolvePrivateRuntimeStateDirectory(repository.root);
    runtimeChecks.push({ checkId: "private-runtime-state", group: "runtime", component: "storage", status: "pass",
      detected_version: null, reason: `Private Runtime state: ${privateState}`, remediation: "" });
  } catch (error) {
    runtimeChecks.push({ checkId: "private-runtime-state", group: "runtime", component: "storage", status: "fail",
      detected_version: null, reason: `Private Runtime state unavailable: ${String(error)}`,
      remediation: "Preserve existing state and reconcile the reported authority or storage permissions before startup." });
  }

  // lifecycle-lock
  const stateRoot = options.statePath ? options.statePath(".") : resolve(repository.root, ".bflow/state");
  try {
    const lockStatus = await lifecycleLockStatus(stateRoot);
    if (lockStatus.startsWith("Legacy")) {
      legacyChecks.push({
        checkId: "lifecycle-lock",
        name: "lifecycle-lock",
        status: "failed",
        message: lockStatus,
        remediation: "Run 'bflow recover --yes' to migrate legacy lock."
      });
    } else {
      legacyChecks.push({
        checkId: "lifecycle-lock",
        name: "lifecycle-lock",
        status: "passed",
        message: lockStatus
      });
    }
  } catch (error) {
    legacyChecks.push({
      checkId: "lifecycle-lock",
      name: "lifecycle-lock",
      status: "failed",
      message: String(error)
    });
  }

  // operation-recovery
  try {
    let intentPhase: string | null = null;
    if (options.intent) {
      const intentObj = await options.intent();
      intentPhase = intentObj?.phase ?? null;
    } else {
      const opPath = resolve(stateRoot, "operation.json");
      if (existsSync(opPath)) {
        try {
          const raw = JSON.parse(await readFile(opPath, "utf8"));
          intentPhase = raw?.phase ?? null;
        } catch {}
      }
    }
    if (intentPhase && ["server_starting", "manager_pending", "stopping"].includes(intentPhase)) {
      legacyChecks.push({
        checkId: "operation-recovery",
        name: "operation-recovery",
        status: "failed",
        message: `Environment operation '${intentPhase}' is unresolved. ${intentPhase === "stopping" ? "Run bflow down --yes to resume checked shutdown." : "Run bflow up to reconcile existing panes; resolve interactive dialogs in the named session, or bflow down --yes to stop safely."} Do not delete .bflow.`,
        remediation: intentPhase === "stopping" ? "Run bflow down --yes" : "Run bflow up or bflow down --yes"
      });
    } else {
      legacyChecks.push({
        checkId: "operation-recovery",
        name: "operation-recovery",
        status: "passed",
        message: "No unresolved lifecycle delivery"
      });
    }
  } catch (error) {
    legacyChecks.push({
      checkId: "operation-recovery",
      name: "operation-recovery",
      status: "failed",
      message: String(error)
    });
  }

  // bflow-global-config
  let globalConfigStatus: DoctorCheckStatus = "pass";
  let globalConfigVersion: string | null = "3";
  let globalConfigReason = "Global machine configuration is valid or unconfigured defaults applied.";
  let globalConfigRemediation = "";
  let globalConfigRepair: string | undefined;

  try {
    const platformProfile = detectPlatform(defaultHostEnvironment());
    const bflowHome = options.env?.BFLOW_HOME ?? process.env.BFLOW_HOME;
    const configDir = bflowHome ? resolve(bflowHome, "config") : platformProfile.paths.config;
    const machineConfigFile = resolve(configDir, MACHINE_CONFIG_FILE);
    const res = await loadMachineConfig(machineConfigFile);
    if (res.status === "absent" || res.status === "valid") {
      globalConfigStatus = "pass";
      globalConfigVersion = "3";
      globalConfigReason = res.status === "valid"
        ? "Global machine configuration is valid (schemaVersion 3)."
        : "Global machine configuration is unconfigured; default settings apply.";
    } else {
      globalConfigStatus = "fail";
      globalConfigVersion = null;
      globalConfigReason = res.error?.message ?? `Global machine configuration is ${res.status}.`;
      globalConfigRemediation = "Run 'bflow setup --repair' to fix global machine configuration.";
      globalConfigRepair = "bflow setup --repair";
    }
  } catch (error) {
    globalConfigStatus = "fail";
    globalConfigVersion = null;
    globalConfigReason = `Global machine configuration check failed: ${String(error)}`;
    globalConfigRemediation = "Run 'bflow setup --repair' to fix global machine configuration.";
    globalConfigRepair = "bflow setup --repair";
  }

  runtimeChecks.push({
    checkId: "bflow-global-config",
    group: "runtime",
    component: "global-config",
    status: globalConfigStatus,
    detected_version: globalConfigVersion,
    reason: globalConfigReason,
    remediation: globalConfigRemediation,
    ...(globalConfigRepair ? { repair_command: globalConfigRepair } : {})
  });

  // ==========================================
  progress("Đang kiểm tra các agent provider và trạng thái xác thực...");
  // Group 2: agent_providers
  // ==========================================

  const configuredRoles = config?.environment?.roles ?? [];
  const providers: readonly ["claude", "codex", "agy"] = ["claude", "codex", "agy"];

  for (const provider of providers) {
    const isRequired = configuredRoles.length > 0
      ? configuredRoles.some((r) => r.cli === provider && (r.required ?? true))
      : provider === "codex";

    const override = dependencies?.providerOverrides?.[provider];

    // Binary check: agent-<provider>
    let binaryStatus: DoctorCheckStatus = "pass";
    let detectedVersion: string | null = null;
    let binaryReason = "";
    let binaryRemediation = "";

    if (override?.available !== undefined) {
      if (override.available) {
        binaryStatus = "pass";
        detectedVersion = override.version ?? "detected";
        binaryReason = `Provider '${provider}' binary is available${override.version ? ` (${override.version})` : ""}.`;
      } else {
        if (isRequired) {
          binaryStatus = "fail";
          binaryReason = `Missing required agent provider executable '${provider}'.`;
          binaryRemediation = `Install ${provider === "codex" ? "OpenAI Codex CLI ('codex')" : provider === "claude" ? "Claude Code CLI ('claude')" : "Antigravity CLI ('agy')"} and ensure it is on PATH, then run 'bflow doctor'.`;
        } else {
          binaryStatus = "skipped";
          binaryReason = `Provider '${provider}' is not configured for any active role.`;
        }
      }
    } else {
      try {
        const binRes = await runner.run({
          executable: provider,
          args: ["--version"],
          cwd: repository.root,
          env,
          timeoutMs: 5000
        });
        if (binRes.exitCode === 0) {
          binaryStatus = "pass";
          detectedVersion = binRes.stdout.trim() || "detected";
          binaryReason = `Provider '${provider}' binary is available (${detectedVersion}).`;
        } else {
          if (isRequired) {
            binaryStatus = "fail";
            binaryReason = `Missing required agent provider executable '${provider}': exit code ${binRes.exitCode}.`;
            binaryRemediation = `Install ${provider === "codex" ? "OpenAI Codex CLI ('codex')" : provider === "claude" ? "Claude Code CLI ('claude')" : "Antigravity CLI ('agy')"} and ensure it is on PATH, then run 'bflow doctor'.`;
          } else {
            binaryStatus = "skipped";
            binaryReason = `Provider '${provider}' is not configured for any active role.`;
          }
        }
      } catch (error) {
        if (isRequired) {
          binaryStatus = "fail";
          binaryReason = `Missing required agent provider executable '${provider}': ${String(error)}`;
          binaryRemediation = `Install ${provider === "codex" ? "OpenAI Codex CLI ('codex')" : provider === "claude" ? "Claude Code CLI ('claude')" : "Antigravity CLI ('agy')"} and ensure it is on PATH, then run 'bflow doctor'.`;
        } else {
          binaryStatus = "skipped";
          binaryReason = `Provider '${provider}' is not configured for any active role.`;
        }
      }
    }

    agentProviderChecks.push({
      checkId: `agent-${provider}`,
      group: "agent_providers",
      component: provider,
      status: binaryStatus,
      detected_version: detectedVersion,
      reason: binaryReason,
      remediation: binaryRemediation
    });

    // Auth check: auth-<provider>
    let authStatus: DoctorCheckStatus = "pass";
    let authReason = "";
    let authRemediation = "";

    if (!isRequired) {
      authStatus = "skipped";
      authReason = `Provider '${provider}' is not configured for any active role.`;
    } else if (override?.authenticated !== undefined) {
      if (override.authenticated) {
        authStatus = "pass";
        authReason = `Provider '${provider}' reports authenticated; transport idle alone is not authentication evidence`;
      } else {
        authStatus = "fail";
        authRemediation = provider === "agy" ? AGY_LOGIN_REMEDIATION
          : `Run '${provider === "codex" ? "codex login" : "claude auth login"}' and verify with 'bflow doctor'.`;
        authReason = `Agent provider '${provider}' is not authenticated. ${authRemediation}`;
      }
    } else {
      if (provider === "codex") {
        try {
          const requiredCodexRoles = configuredRoles.filter(role => role.cli === "codex" && (role.required ?? true));
          const defaultProfileName = config?.environment.defaults?.codex?.["profile-name"];
          const selectedProfileNames = [...new Set(requiredCodexRoles
            .map(role => role["profile-name"] ?? defaultProfileName).filter((name): name is string => name !== undefined))];
          const profileResults = await Promise.all(selectedProfileNames.map(name =>
            probeSelectedCodexProfile(name, options.env ?? process.env, repository.root, runner)));
          const needsAmbientLogin = requiredCodexRoles.length === 0 || requiredCodexRoles.some(role =>
            role["profile-name"] === undefined && defaultProfileName === undefined);
          if (needsAmbientLogin) {
            const ambient = await runner.run({ executable: "codex", args: ["login", "status"], cwd: repository.root, env, timeoutMs: 5000 });
            profileResults.push({ authenticated: ambient.exitCode === 0, modelCatalogVerified: false });
          }
          if (profileResults.every(result => result.authenticated)) {
            authStatus = "pass";
            authReason = profileResults.some(result => result.modelCatalogVerified)
              ? "Provider 'codex' reports authenticated; linked backend model catalog access verified without inference."
              : "Provider 'codex' reports authenticated; transport idle alone is not authentication evidence";
          } else {
            authStatus = "fail";
            authReason = "Provider 'codex' is not authenticated. Run codex login in the selected profile before bflow up.";
            authRemediation = selectedProfileNames.length
              ? "Repair authentication or linked backend access in the selected Codex profile, then rerun 'bflow doctor'."
              : "Run 'codex login' and verify with 'bflow doctor'.";
          }
        } catch {
          authStatus = "fail";
          authReason = "Selected Codex profile is not ready or authenticated. Check its profile and linked backend before bflow up.";
          authRemediation = "Run 'codex login' and verify with 'bflow doctor'.";
        }
      } else if (provider === "claude") {
        try {
          const authRes = await runner.run({
            executable: "claude",
            args: ["auth", "status", "--json"],
            cwd: repository.root,
            env,
            timeoutMs: 5000
          });
          if (authRes.exitCode === 0) {
            try {
              const parsed = JSON.parse(authRes.stdout);
              if (parsed && typeof parsed === "object" && parsed.loggedIn === true) {
                authStatus = "pass";
                authReason = "Provider 'claude' reports authenticated; transport idle alone is not authentication evidence";
              } else {
                authStatus = "fail";
                authReason = "Provider 'claude' is not authenticated. Run claude auth login before bflow up.";
                authRemediation = "Run 'claude auth login' and verify with 'bflow doctor'.";
              }
            } catch {
              authStatus = "fail";
              authReason = "Claude authentication status is malformed; cannot establish readiness.";
              authRemediation = "Run 'claude auth login' and verify with 'bflow doctor'.";
            }
          } else {
            authStatus = "fail";
            authReason = "Provider 'claude' is not authenticated. Run claude auth login before bflow up.";
            authRemediation = "Run 'claude auth login' and verify with 'bflow doctor'.";
          }
        } catch {
          authStatus = "fail";
          authReason = "Provider 'claude' is not authenticated. Run claude auth login before bflow up.";
          authRemediation = "Run 'claude auth login' and verify with 'bflow doctor'.";
        }
      } else if (provider === "agy") {
        const access = await probeAgyAccess(runner, { cwd: repository.root, env, timeoutMs: 45_000 });
        authStatus = access.status === "available" ? "pass" : "fail";
        authReason = access.message;
        authRemediation = access.remediation;
      }
    }

    agentProviderChecks.push({
      checkId: `auth-${provider}`,
      group: "agent_providers",
      component: provider,
      status: authStatus,
      detected_version: null,
      reason: authReason,
      remediation: authRemediation
    });
  }

  if (options.deep) {
    progress("Đang kiểm tra các model đã cấu hình (--deep; có thể phát sinh phí sử dụng model)...");
    try {
      if (config === null) throw new Error("A valid repository configuration is required for model diagnostics.");
      const results = dependencies?.probeProviderModels
        ? await dependencies.probeProviderModels()
        : await probeDoctorModels({ repository, config, env: options.env ?? process.env },
          { timeoutMs: 75_000, ...(dependencies?.signal === undefined ? {} : { signal: dependencies.signal }) });
      if (results.length === 0) throw new Error("No required provider models were selected for diagnostics.");
      for (const value of results) {
        const result = RolePreflightSummarySchema.parse(value);
        const failed = result.checks.filter(check => check.status !== "passed");
        agentProviderChecks.push({
          checkId: `model-${result.provider}-${result.role}`, group: "agent_providers", component: result.provider,
          status: result.status === "ready" ? "pass" : "fail", detected_version: null,
          reason: scrubDiagnosticText([result.message, ...failed.map(check => check.message)].filter(Boolean).join(" ")),
          remediation: result.status === "ready" ? "" : "Check provider authentication, selected model, quota and network access."
        });
      }
    } catch (error) {
      agentProviderChecks.push({ checkId: "provider-models", group: "agent_providers", component: "models",
        status: "fail", detected_version: null, reason: scrubDiagnosticText(String(error)),
        remediation: "Resolve repository/provider configuration and rerun bflow doctor --deep." });
    }
  }

  // provider-permissions
  let permStatus: DoctorCheckStatus = "pass";
  let permReason = "Provider permissions configuration is valid.";
  let permRemediation = "";

  const permConfig = config?.environment?.permissions;
  const isUnattended =
    permConfig?.mode === "unattended_isolated" ||
    configuredRoles.some((r) => r.permissionMode === "unattended_isolated");

  if (isUnattended && permConfig?.isolation !== "os_sandbox" && permConfig?.isolation !== "container") {
    permStatus = "fail";
    permReason = "Permission configuration invalid: 'unattended_isolated' requires 'os_sandbox' or 'container' isolation.";
    permRemediation = "Configure environment.permissions.isolation as 'os_sandbox' or 'container', or switch permissionMode to 'workspace_auto'.";
  } else {
    const unsupportedFlags: string[] = [];
    if (permConfig?.unsupportedFlags) {
      unsupportedFlags.push(...permConfig.unsupportedFlags);
    }
    for (const r of configuredRoles) {
      if (r.unsupportedFlags) {
        unsupportedFlags.push(...r.unsupportedFlags);
      }
    }
    for (const p of providers) {
      const oFlags = dependencies?.providerOverrides?.[p]?.unsupportedFlags;
      if (oFlags) {
        unsupportedFlags.push(...oFlags);
      }
    }
    if (unsupportedFlags.length > 0) {
      permStatus = "fail";
      permReason = `Unsupported permission flags configured (${unsupportedFlags.join(", ")}).`;
      permRemediation = "Remove unsupported permission flags from .bflow/config.yml or upgrade the provider CLI.";
    }
  }

  agentProviderChecks.push({
    checkId: "provider-permissions",
    group: "agent_providers",
    component: "permissions",
    status: permStatus,
    detected_version: permConfig?.mode ?? "workspace_auto",
    reason: permReason,
    remediation: permRemediation
  });

  // provider-trusted-workspace
  let trustStatus: DoctorCheckStatus = "pass";
  let trustReason = "Repository workspace is trusted.";
  let trustRemediation = "";
  if (permConfig?.trustedWorkspace === false) {
    trustStatus = "fail";
    trustReason = "Workspace trust check failed: repository workspace is not trusted.";
    trustRemediation = "Set environment.permissions.trustedWorkspace to true in .bflow/config.yml or trust the workspace.";
  }
  agentProviderChecks.push({
    checkId: "provider-trusted-workspace",
    group: "agent_providers",
    component: "workspace",
    status: trustStatus,
    detected_version: null,
    reason: trustReason,
    remediation: trustRemediation
  });

  // provider-required-env
  let reqEnvStatus: DoctorCheckStatus = "pass";
  let reqEnvReason = "All required role environment variables are defined.";
  let reqEnvRemediation = "";
  for (const role of configuredRoles) {
    for (const envKey of role.requiredEnv ?? []) {
      const val = env[envKey] ?? process.env[envKey];
      if (!val || !val.trim()) {
        reqEnvStatus = "fail";
        reqEnvReason = `Missing required environment variable '${envKey}' for role '${role.role}'.`;
        reqEnvRemediation = `Export ${envKey} before running 'bflow up'.`;
        break;
      }
    }
    if (reqEnvStatus === "fail") break;
  }
  agentProviderChecks.push({
    checkId: "provider-required-env",
    group: "agent_providers",
    component: "environment",
    status: reqEnvStatus,
    detected_version: null,
    reason: reqEnvReason,
    remediation: reqEnvRemediation
  });

  // provider-readiness-probe
  let readinessStatus: DoctorCheckStatus = "pass";
  let readinessReason = "All required providers are unblocked and ready.";
  let readinessRemediation = "";
  for (const p of providers) {
    const isRequired = configuredRoles.some((r) => r.cli === p && (r.required ?? true));
    if (!isRequired) continue;
    const override = dependencies?.providerOverrides?.[p];
    if (override?.blocked === true || override?.readiness === "blocked" || override?.readiness === "degraded") {
      readinessStatus = "fail";
      readinessReason = `Agent provider '${p}' is ${override.readiness ?? "blocked"}${override.blockedReason ? `: ${override.blockedReason}` : ""}.`;
      readinessRemediation = `Resolve the provider policy/workspace block and verify with 'bflow agent check ${p}' or 'bflow doctor'.`;
      break;
    }
  }
  agentProviderChecks.push({
    checkId: "provider-readiness-probe",
    group: "agent_providers",
    component: "readiness",
    status: readinessStatus,
    detected_version: null,
    reason: readinessReason,
    remediation: readinessRemediation
  });

  // ==========================================
  progress("Đang kiểm tra các dịch vụ MCP dùng chung...");
  // Group 3: mcp
  // ==========================================

  const mcpState = dependencies?.mcpState;
  const requiredMcp = config?.environment?.requiredMcpServices ?? [];

  // mcp-gateway-service
  let gwStatus: DoctorCheckStatus = "pass";
  let gwReason = "MCP Gateway service is nominal.";
  let gwRemediation = "";
  let gwRepair: string | undefined;

  if (requiredMcp.length > 0) {
    if (mcpState?.gatewayAvailable === false) {
      gwStatus = "fail";
      gwReason = "MCP Gateway service is unavailable.";
      gwRemediation = "Run 'bflow setup --apply' or 'bflow mcp status' to start and verify the MCP Gateway.";
      gwRepair = "bflow setup --apply";
    } else {
      gwStatus = "pass";
      gwReason = "MCP Gateway service is active.";
    }
  } else {
    if (mcpState?.gatewayAvailable === true) {
      gwStatus = "pass";
      gwReason = "MCP Gateway service is available.";
    } else {
      gwStatus = "skipped";
      gwReason = "No required MCP services configured.";
    }
  }
  mcpChecks.push({
    checkId: "mcp-gateway-service",
    group: "mcp",
    component: "gateway",
    status: gwStatus,
    detected_version: null,
    reason: gwReason,
    remediation: gwRemediation,
    ...(gwRepair ? { repair_command: gwRepair } : {})
  });

  // mcp-shared-backends
  const configuredServices = Object.keys(mcpState?.services ?? {});
  let backendsStatus: DoctorCheckStatus = "pass";
  let backendsReason = configuredServices.length > 0
    ? `${configuredServices.length} shared MCP backend service(s) configured.`
    : "No shared MCP backends registered.";
  let backendsRemediation = "";
  let backendsRepair: string | undefined;

  let healthStatus: DoctorCheckStatus = "pass";
  let healthReason = "MCP health endpoints are responsive.";
  let healthRemediation = "";
  let healthRepair: string | undefined;

  if (requiredMcp.length > 0) {
    for (const sId of requiredMcp) {
      const s = mcpState?.services?.[sId];
      if (!s || s.status !== "ready") {
        backendsStatus = "fail";
        backendsReason = `Required MCP service '${sId}' is unavailable or unhealthy.`;
        backendsRemediation = "Run 'bflow mcp status' or 'bflow setup --apply' to configure and start required MCP services.";
        backendsRepair = "bflow setup --apply";

        healthStatus = "fail";
        healthReason = `Required MCP service '${sId}' is unavailable or unhealthy.`;
        healthRemediation = "Run 'bflow mcp status' or 'bflow setup --apply' to configure and start required MCP services.";
        healthRepair = "bflow setup --apply";
        break;
      }
    }
  }

  mcpChecks.push({
    checkId: "mcp-shared-backends",
    group: "mcp",
    component: "backends",
    status: backendsStatus,
    detected_version: configuredServices.length > 0 ? `${configuredServices.length}` : null,
    reason: backendsReason,
    remediation: backendsRemediation,
    ...(backendsRepair ? { repair_command: backendsRepair } : {})
  });

  // mcp-client-registrations
  const regCount = mcpState?.sessionRegistrations?.size ?? 0;
  mcpChecks.push({
    checkId: "mcp-client-registrations",
    group: "mcp",
    component: "registrations",
    status: "pass",
    detected_version: regCount > 0 ? `${regCount}` : null,
    reason: regCount > 0
      ? `${regCount} session registration(s) active.`
      : "No active MCP client registrations.",
    remediation: ""
  });

  // mcp-tool-discovery
  const totalDiscoveredTools = Object.values((mcpState?.services ?? {}) as Record<string, any>).reduce(
    (acc: number, s: any) => acc + (s.discoveredTools?.length ?? 0),
    0
  );
  mcpChecks.push({
    checkId: "mcp-tool-discovery",
    group: "mcp",
    component: "discovery",
    status: "pass",
    detected_version: totalDiscoveredTools > 0 ? `${totalDiscoveredTools}` : null,
    reason: `${totalDiscoveredTools} tool(s) discovered across MCP services.`,
    remediation: ""
  });

  // mcp-health-endpoints
  mcpChecks.push({
    checkId: "mcp-health-endpoints",
    group: "mcp",
    component: "health",
    status: healthStatus,
    detected_version: null,
    reason: healthReason,
    remediation: healthRemediation,
    ...(healthRepair ? { repair_command: healthRepair } : {})
  });

  // mcp-memory-processes
  const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  const activeProcesses = Object.values((mcpState?.services ?? {}) as Record<string, any>).filter(
    (s: any) => s.pid !== undefined && s.status === "ready"
  ).length;
  mcpChecks.push({
    checkId: "mcp-memory-processes",
    group: "mcp",
    component: "memory",
    status: "pass",
    detected_version: `${rssMb}MB`,
    reason: `Memory RSS: ${rssMb}MB, active MCP processes: ${activeProcesses}.`,
    remediation: ""
  });

  // context7: the shared documentation service. Required: failures fail the doctor. Optional: failures are warnings (degraded).
  if ((config?.environment && config.environment.context7?.enabled !== false) || dependencies?.context7Health !== undefined) {
    const required = config?.environment?.context7?.required === true;
    try {
      const { collectContext7Health } = await import("./docs-command.js");
      const health = await (dependencies?.context7Health?.() ?? collectContext7Health({ repository, config: config ?? undefined, env: options.env ?? process.env, probe: true, timeoutMs: 8000 }));
      for (const check of health.checks) {
        mcpChecks.push({
          checkId: `context7-${check.id}`,
          group: "mcp",
          component: "context7",
          status: check.status === "pass" ? "pass" : check.status === "skipped" ? "skipped" : check.status === "warn" ? "warning" : required ? "fail" : "warning",
          detected_version: null,
          reason: check.message,
          remediation: check.remediation ?? "",
          ...(check.status === "fail" && (check.id === "gateway" || check.id === "service") ? { repair_command: "bflow setup --apply" } : {})
        });
      }
      if (health.state === "degraded") {
        mcpChecks.push({ checkId: "context7-degraded", group: "mcp", component: "context7", status: "warning", detected_version: null,
          reason: "Context7 is optional and not healthy: roles run without documentation lookup (degraded mode).",
          remediation: "Fix the failing Context7 checks above, or set environment.context7.required to refuse to start without it." });
      }
    } catch (error) {
      mcpChecks.push({ checkId: "context7-evaluation", group: "mcp", component: "context7", status: required ? "fail" : "warning", detected_version: null,
        reason: `Context7 health could not be evaluated: ${error instanceof Error ? error.message : String(error)}`, remediation: "Run 'bflow docs status' for details." });
    }
  }

  // ==========================================
  progress("Đang kiểm tra các công cụ đã cài đặt...");
  // Group 4: tools
  // ==========================================

  const toolsList = ["rtk", "mempalace", "gitnexus", "chrome-devtools-mcp", "superpowers"] as const;
  const requiredTools = config?.environment?.requiredTools ?? [];
  // `bflow setup --apply` can only fix a tool that the reviewed catalog pins for this OS/architecture.
  // When the catalog cannot be loaded, keep the setup hint rather than guessing.
  const catalog = (await loadToolInstallerModule())?.defaultToolCatalog?.(process.platform, process.arch) as
    { pins: { toolId: string }[]; manual: { toolId: string; diagnostic: string; documentation: string }[] } | undefined;

  for (const tool of toolsList) {
    const isRequired = requiredTools.includes(tool);
    const manualGuidance = catalog && !catalog.pins.some(pin => pin.toolId === tool)
      ? catalog.manual.find(item => item.toolId === tool) : undefined;
    const setupRepair = manualGuidance ? undefined : "bflow setup --apply";
    const installHint = manualGuidance
      ? `Bflow setup cannot install '${tool}' on ${process.platform}/${process.arch}: ${manualGuidance.diagnostic} ${manualGuidance.documentation}`
      : `Run 'bflow setup --apply' to install '${tool}'.`;
    const override = dependencies?.toolOverrides?.[tool];

    let tStatus: DoctorCheckStatus = "pass";
    let tVersion: string | null = null;
    let tReason = "";
    let tRemediation = "";
    let tRepair: string | undefined;

    if (override !== undefined) {
      if (override.installed) {
        tStatus = "pass";
        tVersion = override.version ?? "detected";
        tReason = `Tool '${tool}' is installed (${tVersion}).`;
      } else {
        if (isRequired) {
          tStatus = "fail";
          tReason = `Required tool '${tool}' is missing or unavailable.`;
          tRemediation = installHint;
          tRepair = setupRepair;
        } else {
          tStatus = "skipped";
          tReason = `Tool '${tool}' is optional and not installed.`;
        }
      }
    } else {
      try {
        const tRes = await runner.run({
          executable: tool,
          args: ["--version"],
          cwd: repository.root,
          env,
          timeoutMs: 3000
        });
        if (tRes.exitCode === 0) {
          tStatus = "pass";
          tVersion = tRes.stdout.trim() || "detected";
          tReason = `Tool '${tool}' is installed (${tVersion}).`;
        } else {
          if (isRequired) {
            tStatus = "fail";
            tReason = `Required tool '${tool}' failed with exit code ${tRes.exitCode}.`;
            tRemediation = installHint;
            tRepair = setupRepair;
          } else {
            tStatus = "skipped";
            tReason = `Tool '${tool}' is optional and not installed.`;
          }
        }
      } catch {
        if (isRequired) {
          tStatus = "fail";
          tReason = `Required tool '${tool}' is missing or unavailable.`;
          tRemediation = installHint;
          tRepair = setupRepair;
        } else {
          tStatus = "skipped";
          tReason = `Tool '${tool}' is optional and not installed.`;
        }
      }
    }

    toolChecks.push({
      checkId: `tool-${tool}`,
      group: "tools",
      component: tool,
      status: tStatus,
      detected_version: tVersion,
      reason: tReason,
      remediation: tRemediation,
      ...(tRepair ? { repair_command: tRepair } : {})
    });
  }

  if (config?.environment?.toolPolicy) {
    progress("Đang đối chiếu chính sách công cụ của kho mã nguồn với danh mục trên máy...");
    try {
      const { loadHostPlatformContext, resolveRepositoryToolPolicy, resolveToolGrants } = await import("./platform-options.js");
      const input = { repository, config, env: options.env ?? process.env };
      const context = await loadHostPlatformContext(input);
      const policy = resolveRepositoryToolPolicy(input, context.machineId);
      resolveToolGrants(policy, context, input, undefined, undefined, observed => {
        const missingReason = observed.reason ?? "No matching machine evidence was observed.";
        const add = (stage: "installed" | "allowed" | "granted" | "ready", pass: boolean | null, reason: string, remediation: string) => {
          toolChecks.push({ checkId: `tool-policy-${observed.toolId}-${observed.role}-${stage}`, group: "tools",
            component: `${observed.toolId}:${observed.role}:${stage}`,
            status: pass ? "pass" : pass === null ? "warning" : observed.requiredness === "required" ? "fail" : "warning",
            detected_version: observed.version ?? null, reason, remediation: pass ? "" : remediation });
        };
        add("installed", observed.installed, observed.installed === null ? `Service configuration for '${observed.toolId}' is known; local installation evidence is separate and remains unverified.` : observed.installed ? `Machine inventory verifies '${observed.toolId}' (${observed.version ?? "version unavailable"}).` :
          `Machine inventory does not verify '${observed.toolId}': ${missingReason}`, "Review the pinned tool and its setup receipt with 'bflow tool status'.");
        add("allowed", observed.allowed, `Repository policy explicitly allows '${observed.toolId}' for role '${observed.role}'.`,
          "Add an explicit role and operation requirement to environment.toolPolicy.");
        add("granted", observed.granted, observed.granted ? `Runtime grant for '${observed.toolId}' is resolved for role '${observed.role}'.` :
          `No Runtime grant is resolved for '${observed.toolId}' and role '${observed.role}': ${missingReason}`,
          "Resolve the policy, machine inventory and Gateway operation allowlist, then retry 'bflow up'.");
        add("ready", observed.ready, observed.ready ? `'${observed.toolId}' is ready for role '${observed.role}'.` :
          `'${observed.toolId}' is not ready for role '${observed.role}': ${missingReason}`,
          "Run 'bflow doctor' or 'bflow mcp status' to inspect the approved service readiness.");
      }, false);
    } catch (error) {
      toolChecks.push({ checkId: "tool-policy-resolution", group: "tools", component: "repository-policy",
        status: "fail", detected_version: null,
        reason: `Repository tool policy could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        remediation: "Correct the strict environment.toolPolicy schema, digest and repository scope before startup." });
    }
  } else {
    const hasLegacyWithoutPolicy =
      (config?.environment?.requiredTools?.length ?? 0) > 0 ||
      (config?.environment?.requiredMcpServices?.length ?? 0) > 0;
    for (const toolId of ["rtk", "gitnexus", "chrome-devtools-mcp", "mempalace"] as const) {
      const visible = toolChecks.find(check => check.checkId === `tool-${toolId}`);
      const foundOnPath = visible?.status === "pass";
      const explicitlyDisabled = config?.environment?.tools?.[toolId]?.enabled === false;
      const allowedByDefault = Boolean(config?.environment) && !hasLegacyWithoutPolicy && !explicitlyDisabled;
      const addPolicyState = (stage: "installed" | "allowed" | "granted" | "ready", status: DoctorCheckStatus, reason: string, remediation: string) =>
        toolChecks.push({ checkId: `tool-policy-${toolId}-repository-${stage}`, group: "tools",
          component: `${toolId}:repository:${stage}`, status, detected_version: visible?.detected_version ?? null, reason, remediation });
      addPolicyState("installed", foundOnPath ? "warning" : "skipped",
        foundOnPath ? `'${toolId}' is visible on PATH, but this probe does not verify its approved managed executable identity.` :
          `No installation of '${toolId}' was observed by the CLI probe.`,
        "Use 'bflow tool status' and the approved machine setup receipt to inspect installation identity.");
      addPolicyState("allowed", allowedByDefault ? "pass" : "warning",
        allowedByDefault
          ? `Repository tool policy allows '${toolId}' by default.`
          : explicitlyDisabled
            ? `Repository configuration explicitly disables '${toolId}' (environment.tools.${toolId}.enabled: false).`
            : `Repository tool policy does not allow '${toolId}'.`,
        allowedByDefault
          ? ""
          : "Enable the tool under environment.tools or add an explicit role and operation requirement under environment.toolPolicy.");
      if (toolId === "gitnexus" && allowedByDefault) {
        try {
          const { checkRepositoryGitNexus, resolveSetupPlatform } = await import("./gateway-repositories.js");
          const setup = await import("@bflow/machine-setup");
          const host = setup.defaultHostEnvironment();
          const bflowHome = options.env?.BFLOW_HOME ?? host.env.BFLOW_HOME ?? process.env.BFLOW_HOME;
          const platform = bflowHome
            ? setup.isolatedPlatformProfile(setup.detectPlatform(host), resolve(bflowHome))
            : resolveSetupPlatform();
          const gn = await checkRepositoryGitNexus({ repository, platform });
          const isRequired = config?.environment?.tools?.gitnexus?.required === true || requiredTools.includes("gitnexus");
          const readyStatus: DoctorCheckStatus = gn.status === "ready"
            ? "pass"
            : isRequired
              ? "fail"
              : "warning";
          addPolicyState("granted", gn.registered ? "pass" : "skipped",
            gn.registered
              ? `Repository GitNexus service '${gn.serviceId}' is registered for this repository.`
              : `Repository GitNexus service '${gn.serviceId}' is not registered yet (${gn.status}).`,
            gn.registered ? "" : "Run 'bflow init' in this repository to index and register its GitNexus service.");
          addPolicyState("ready", readyStatus,
            gn.status === "ready"
              ? `Repository GitNexus service '${gn.serviceId}' is indexed, registered, and ready on the shared Gateway.`
              : `Repository GitNexus service '${gn.serviceId}' is ${gn.status}: ${gn.diagnostics.join(" ")}`,
            gn.status === "ready" ? "" : "Run 'bflow init' in this repository to index and register its GitNexus service.");
          continue;
        } catch {
          // Fall back to default policy state below if inspection fails
        }
      }
      addPolicyState("granted", "skipped", `No explicit Runtime grant overrides exist for '${toolId}'; default optional grants are resolved at startup when machine inventory is ready.`,
        "Verify the machine tool or Gateway service with 'bflow setup --check' or 'bflow tool status'.");
      addPolicyState("ready", "skipped", `'${toolId}' readiness is evaluated against verified machine inventory and Gateway services during startup.`,
        "Verify the machine tool or Gateway service before use.");
    }
  }

  // ==========================================
  progress("Đang kiểm tra các kỹ năng (skills) được phê duyệt...");
  // Group 5: skills
  // ==========================================

  const skillsOverride = dependencies?.skillsOverride;
  const skillsConfig = config?.environment?.skills;
  const isSkillsRequired = skillsConfig?.required === true;

  // skills-shared-installed
  let sharedInstalledStatus: DoctorCheckStatus = "pass";
  let sharedInstalledReason = "Shared skills catalog verified.";
  let sharedInstalledRemediation = "";
  let sharedInstalledRepair: string | undefined;

  if (skillsOverride?.missingSkills && skillsOverride.missingSkills.length > 0) {
    sharedInstalledStatus = "fail";
    sharedInstalledReason = `Required skills are missing: ${skillsOverride.missingSkills.join(", ")}.`;
    sharedInstalledRemediation = "Run 'bflow skills sync' or 'bflow setup --apply' to install missing skills.";
    sharedInstalledRepair = "bflow skills sync";
  } else {
    const hasRequestedSkills =
      Boolean(skillsConfig?.requiredSkills && skillsConfig.requiredSkills.length > 0) ||
      configuredRoles.some((r) => r.skills && r.skills.length > 0);

    if ((isSkillsRequired || hasRequestedSkills) && !skillsOverride?.catalogDir && !skillsConfig?.catalogDir) {
      try {
        const { loadHostPlatformContext } = await import("./platform-options.js");
        const { validateBundledStartupSkills } = await import("./skill-catalog.js");
        const context = await loadHostPlatformContext({ repository, config: config!, env: options.env ?? process.env });
        await validateBundledStartupSkills(config!.environment, resolve(context.dataDirectory, "skills-store"));
        sharedInstalledReason = "Required bundled workflow skills match the verified machine skill store; Runtime validates session manifests before launch.";
      } catch (error) {
        sharedInstalledStatus = "fail";
        sharedInstalledReason = error instanceof Error ? error.message : String(error);
        sharedInstalledRemediation = "Review and apply the pinned skills setup plan.";
        sharedInstalledRepair = "bflow skills sync";
      }
    } else if (isSkillsRequired || hasRequestedSkills) {
      const catalogDir = resolve(
        repository.root,
        skillsOverride?.catalogDir ?? skillsConfig?.catalogDir ?? ".bflow/skills"
      );
      if (!existsSync(catalogDir)) {
        sharedInstalledStatus = "fail";
        sharedInstalledReason = `Skill catalog directory '${catalogDir}' does not exist.`;
        sharedInstalledRemediation = "Run 'bflow skills sync' or 'bflow setup --apply' to install missing skills.";
        sharedInstalledRepair = "bflow skills sync";
      } else if (hasRequestedSkills) {
        const allNeeded = Array.from(
          new Set([
            ...(skillsConfig?.requiredSkills ?? []),
            ...configuredRoles.flatMap((r) => r.skills ?? [])
          ])
        );
        const missingOnDisk: string[] = [];
        for (const s of allNeeded) {
          let found = existsSync(resolve(catalogDir, s, "SKILL.md"));
          if (!found) {
            try {
              const entries = readdirSync(catalogDir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isDirectory() && existsSync(resolve(catalogDir, entry.name, s, "SKILL.md"))) {
                  found = true;
                  break;
                }
              }
            } catch {}
          }
          if (!found) {
            missingOnDisk.push(s);
          }
        }
        if (missingOnDisk.length > 0) {
          sharedInstalledStatus = "fail";
          sharedInstalledReason = `Required skills are missing: ${missingOnDisk.join(", ")}.`;
          sharedInstalledRemediation = "Run 'bflow skills sync' or 'bflow setup --apply' to install missing skills.";
          sharedInstalledRepair = "bflow skills sync";
        }
      }
    }
  }

  skillChecks.push({
    checkId: "skills-shared-installed",
    group: "skills",
    component: "catalog",
    status: sharedInstalledStatus,
    detected_version: null,
    reason: sharedInstalledReason,
    remediation: sharedInstalledRemediation,
    ...(sharedInstalledRepair ? { repair_command: sharedInstalledRepair } : {})
  });

  // skills-role-bindings
  let bindingsStatus: DoctorCheckStatus = "pass";
  let bindingsReason = "Role-specific skill bindings are valid.";
  let bindingsRemediation = "";
  let bindingsRepair: string | undefined;

  if (skillsOverride?.invalidReferences && skillsOverride.invalidReferences.length > 0) {
    bindingsStatus = "fail";
    bindingsReason = `Invalid skill references detected: ${skillsOverride.invalidReferences.join(", ")}.`;
    bindingsRemediation = "Fix role skill bindings in .bflow/config.yml or skills/roles/bindings.json and run 'bflow skills sync'.";
    bindingsRepair = "bflow skills sync";
  }

  skillChecks.push({
    checkId: "skills-role-bindings",
    group: "skills",
    component: "bindings",
    status: bindingsStatus,
    detected_version: null,
    reason: bindingsReason,
    remediation: bindingsRemediation,
    ...(bindingsRepair ? { repair_command: bindingsRepair } : {})
  });

  // skills-version-compatibility
  let compatStatus: DoctorCheckStatus = "pass";
  let compatReason = "Skill bundles compatible with Platform v3 (schemaVersion 3).";
  let compatRemediation = "";
  let compatRepair: string | undefined;

  if (skillsOverride?.versionIncompatible) {
    compatStatus = "fail";
    compatReason = "Skill catalog version is incompatible with Platform v3.";
    compatRemediation = "Update skill bundles to schemaVersion 3 and run 'bflow skills sync'.";
    compatRepair = "bflow skills sync";
  }

  skillChecks.push({
    checkId: "skills-version-compatibility",
    group: "skills",
    component: "compatibility",
    status: compatStatus,
    detected_version: compatStatus === "pass" ? "3" : null,
    reason: compatReason,
    remediation: compatRemediation,
    ...(compatRepair ? { repair_command: compatRepair } : {})
  });

  // skills-invalid-references
  let refStatus: DoctorCheckStatus = "pass";
  let refReason = "No invalid skill references detected.";
  let refRemediation = "";
  let refRepair: string | undefined;

  if (skillsOverride?.invalidReferences && skillsOverride.invalidReferences.length > 0) {
    refStatus = "fail";
    refReason = `Invalid skill references: ${skillsOverride.invalidReferences.join(", ")}.`;
    refRemediation = "Fix skill references in .bflow/config.yml or bindings.json and run 'bflow skills sync'.";
    refRepair = "bflow skills sync";
  }

  skillChecks.push({
    checkId: "skills-invalid-references",
    group: "skills",
    component: "references",
    status: refStatus,
    detected_version: null,
    reason: refReason,
    remediation: refRemediation,
    ...(refRepair ? { repair_command: refRepair } : {})
  });

  // ==========================================
  // Role Manager integration doctorSession
  // ==========================================

  let roleManagerPassed = true;
  if (options.integration && config) {
    try {
      const integration = await options.integration(config);
      if (integration) {
        try {
          const report = EnvironmentDoctorReportSchema.parse(
            await integration.manager.doctorSession({ workspaceRoot: repository.root })
          );
          if (
            report.workspaceRoot === repository.root &&
            (report.sessionId === undefined || report.sessionId === repository.sessionName)
          ) {
            legacyChecks.push(...report.checks);
            if (!report.healthy) {
              roleManagerPassed = false;
            }
          }
        } finally {
          await integration.close?.();
        }
      }
    } catch (error) {
      legacyChecks.push({
        checkId: "role-manager",
        name: "role-manager",
        status: "failed",
        message: String(error),
        remediation: "Inspect role manager session."
      });
      roleManagerPassed = false;
    }
  }

  // ==========================================
  // Map detailed checks to EnvironmentDoctorCheck
  // ==========================================

  const allDetailedChecks: DoctorDetailedCheck[] = [
    ...runtimeChecks,
    ...agentProviderChecks,
    ...mcpChecks,
    ...toolChecks,
    ...skillChecks
  ].map(cleanDetailedCheck);

  const checks: EnvironmentDoctorCheck[] = [];
  const seenCheckIds = new Set<string>();

  for (const detailed of allDetailedChecks) {
    if (detailed.status === "skipped") continue;
    seenCheckIds.add(detailed.checkId);
    checks.push({
      checkId: detailed.checkId,
      name: detailed.checkId,
      status: detailed.status === "pass" ? "passed" : detailed.status === "warning" ? "warn" : "failed",
      message: detailed.reason,
      ...(detailed.remediation ? { remediation: detailed.remediation } : {})
    });
  }

  // Append legacy checks that are not already present
  for (const legacy of legacyChecks) {
    if (!seenCheckIds.has(legacy.checkId)) {
      seenCheckIds.add(legacy.checkId);
      checks.push(legacy);
    }
  }

  const hasFailedCheck = checks.some((c) => c.status === "failed");
  const hasFailedResult = allDetailedChecks.some((r) => r.status === "fail");
  const healthy = !hasFailedCheck && !hasFailedResult && roleManagerPassed;

  const metadataGroups: DoctorGroupedMetadata["groups"] = {
    runtime: runtimeChecks.map(cleanDetailedCheck),
    agent_providers: agentProviderChecks.map(cleanDetailedCheck),
    mcp: mcpChecks.map(cleanDetailedCheck),
    tools: toolChecks.map(cleanDetailedCheck),
    skills: skillChecks.map(cleanDetailedCheck)
  };

  const metadata: Record<string, unknown> = JSON.parse(
    JSON.stringify({
      groups: metadataGroups,
      results: allDetailedChecks
    })
  );

  return EnvironmentDoctorReportSchema.parse({
    schemaVersion: 2,
    workspaceRoot: repository.root,
    sessionId: repository.sessionName,
    healthy,
    checks,
    checkedAt: new Date().toISOString(),
    metadata
  });
}
