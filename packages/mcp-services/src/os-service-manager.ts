import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BFLOW_SERVICE_MARKER,
  err,
  ok,
  OSServiceConfigSchema,
  SecretReferenceSchema,
  type OSCommandResult,
  type OSCommandRunner,
  type OSServiceBackendKind,
  type OSServiceConfig,
  type OSServiceHealthReport,
  type OSServiceLifecycleState,
  type OSServiceLogOptions,
  type OSServiceLogResult,
  type OSServiceManagerPort,
  type OSServiceRepairResult,
  type OSServiceStatus,
  type OperationResult,
  type SupportedOSPlatform
} from "./types.js";
import { resolveBflowOSPaths, type BflowOSPaths } from "./os-paths.js";

export const DENYLISTED_PRIVILEGE_COMMANDS = [
  "sudo",
  "su",
  "doas",
  "pkexec",
  "runas"
] as const;

export function validateNoRootCommand(argv: readonly string[]): OperationResult<void> {
  if (!Array.isArray(argv) || argv.length === 0) {
    return err({
      code: "validation",
      retryable: false,
      message: "Command argv must be non-empty",
      details: { diagnosticCode: "empty_command_argv" }
    });
  }

  for (const arg of argv) {
    if (typeof arg !== "string") {
      return err({
        code: "validation",
        retryable: false,
        message: "Command argv elements must be strings",
        details: { diagnosticCode: "invalid_command_argv" }
      });
    }
    if (arg.includes("\0") || arg.includes("\r") || arg.includes("\n")) {
      return err({
        code: "validation",
        retryable: false,
        message: `Command argv contains forbidden control characters: ${JSON.stringify(arg)}`,
        details: { diagnosticCode: "control_characters_forbidden" }
      });
    }
    const base = path.basename(arg).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
    if ((DENYLISTED_PRIVILEGE_COMMANDS as readonly string[]).includes(base)) {
      return err({
        code: "validation",
        retryable: false,
        message: `Privilege escalation command is strictly forbidden: ${arg}`,
        details: { diagnosticCode: "privilege_escalation_forbidden", binary: base }
      });
    }
  }

  return ok(undefined);
}

export class SafeOSCommandRunner implements OSCommandRunner {
  run(
    argv: readonly string[],
    options?: {
      readonly cwd?: string | undefined;
      readonly env?: Readonly<Record<string, string>> | undefined;
      readonly timeoutMs?: number | undefined;
    }
  ): Promise<OSCommandResult> {
    const validation = validateNoRootCommand(argv);
    if (!validation.ok) {
      return Promise.reject(new Error(validation.error.message));
    }

    return new Promise<OSCommandResult>((resolve) => {
      let timedOut = false;
      let settled = false;
      let stdout = "";
      let stderr = "";
      let spawnError = "";
      let timer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        resolve({
          exitCode,
          stdout,
          stderr: stderr === "" ? spawnError : stderr,
          timedOut
        });
      };

      const [file, ...args] = argv as [string, ...string[]];
      const child = spawn(file, args, {
        shell: false,
        cwd: options?.cwd,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: options?.env ? { ...process.env, ...options.env } : process.env
      });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < 2 * 1024 * 1024) stdout += chunk;
      });

      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 2 * 1024 * 1024) stderr += chunk;
      });

      child.on("error", (e: NodeJS.ErrnoException) => {
        spawnError = `${e.code ?? "ERROR"}: ${e.message}`;
        finish(127);
      });

      child.on("close", (code) => {
        finish(code ?? (timedOut ? 124 : 1));
      });

      if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          if (process.platform !== "win32" && child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          } else {
            child.kill("SIGKILL");
          }
          graceTimer = setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            finish(124);
          }, 300);
        }, options.timeoutMs);
      }
    });
  }
}

export function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatSystemdArg(arg: string): string {
  if (/[\s"]/.test(arg)) {
    const escaped = arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return arg;
}

export async function writeFileAtomic(
  filePath: string,
  content: string,
  mode = 0o644
): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmpPath, content, { mode, encoding: "utf8" });
    await rename(tmpPath, filePath);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore
    }
    throw error;
  }
}

export async function defaultHealthProbe(url: string, timeoutMs: number): Promise<boolean> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname !== "127.0.0.1" &&
    hostname !== "localhost" &&
    hostname !== "[::1]" &&
    hostname !== "::1"
  ) {
    throw new Error(`Non-loopback health endpoint rejected: ${url}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface BflowOSServiceManagerOptions {
  readonly platform?: SupportedOSPlatform | undefined;
  readonly homeDir?: string | undefined;
  readonly uid?: number | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly runner?: OSCommandRunner | undefined;
  readonly windowsVerified?: boolean | undefined;
  readonly healthProbe?: ((url: string, timeoutMs: number) => Promise<boolean>) | undefined;
  readonly now?: (() => Date) | undefined;
}

export class BflowOSServiceManager implements OSServiceManagerPort {
  readonly platform: SupportedOSPlatform;
  readonly backendKind: OSServiceBackendKind;
  readonly homeDir: string;
  readonly uid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runner: OSCommandRunner;
  readonly windowsVerified: boolean;
  readonly healthProbe: (url: string, timeoutMs: number) => Promise<boolean>;
  readonly now: () => Date;
  readonly paths: BflowOSPaths;

  private readonly restartCounts = new Map<string, number>();
  private readonly configs = new Map<string, OSServiceConfig>();

  constructor(options?: BflowOSServiceManagerOptions) {
    const rawPlatform = options?.platform ?? process.platform;
    this.platform =
      rawPlatform === "darwin" ? "darwin" : rawPlatform === "win32" ? "win32" : "linux";
    this.backendKind =
      this.platform === "darwin"
        ? "launchd"
        : this.platform === "win32"
          ? "windows-startup"
          : "systemd-user";
    this.homeDir =
      options?.homeDir ??
      (process.env.HOME ??
        process.env.USERPROFILE ??
        (this.platform === "win32" ? "C:\\Users\\Default" : "/tmp/bflow-user"));
    this.uid =
      options?.uid ??
      (typeof process.getuid === "function" ? process.getuid() : 1000);
    this.env = options?.env ?? process.env;
    this.runner = options?.runner ?? new SafeOSCommandRunner();
    this.windowsVerified = options?.windowsVerified ?? false;
    this.healthProbe = options?.healthProbe ?? defaultHealthProbe;
    this.now = options?.now ?? (() => new Date());
    this.paths = resolveBflowOSPaths({
      platform: this.platform,
      homeDir: this.homeDir,
      env: this.env
    });
  }

  getRestartCount(serviceId: string): number {
    return this.restartCounts.get(serviceId) ?? 0;
  }

  private checkWindowsVerified(): OperationResult<void> {
    if (this.platform === "win32" && !this.windowsVerified) {
      return err({
        code: "validation",
        retryable: false,
        message: "Windows user-level startup is not verified",
        details: { diagnosticCode: "windows_unverified" }
      });
    }
    return ok(undefined);
  }

  unitPath(serviceId: string): string {
    if (this.platform === "darwin") {
      return path.join(this.paths.serviceUnitDir, `dev.bflow.${serviceId}.plist`);
    }
    if (this.platform === "win32") {
      return path.join(this.paths.serviceUnitDir, `bflow-${serviceId}.xml`);
    }
    return path.join(this.paths.serviceUnitDir, `bflow-${serviceId}.service`);
  }

  renderDefinition(config: OSServiceConfig): OperationResult<string> {
    const parsed = OSServiceConfigSchema.safeParse(config);
    if (!parsed.success) {
      return err({
        code: "validation",
        retryable: false,
        message: `Invalid OSServiceConfig: ${parsed.error.message}`,
        details: { diagnosticCode: "invalid_service_config", issues: parsed.error.issues.map((i) => i.message) }
      });
    }

    const validCmd = validateNoRootCommand([parsed.data.program, ...parsed.data.args]);
    if (!validCmd.ok) {
      return validCmd;
    }

    const cfg = parsed.data;

    if (this.platform === "linux") {
      return ok(this.renderSystemdUnit(cfg));
    }
    if (this.platform === "darwin") {
      return ok(this.renderLaunchdPlist(cfg));
    }
    return ok(this.renderWindowsTaskXml(cfg));
  }

  private renderSystemdUnit(cfg: OSServiceConfig): string {
    const lines: string[] = [
      `# ${BFLOW_SERVICE_MARKER}`,
      "[Unit]",
      `Description=${cfg.description}`,
      "StartLimitIntervalSec=60",
      `StartLimitBurst=${cfg.maxRestartBurst}`,
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${[cfg.program, ...cfg.args].map(formatSystemdArg).join(" ")}`
    ];

    if (cfg.workingDirectory) {
      lines.push(`WorkingDirectory=${cfg.workingDirectory}`);
    }

    lines.push(`Restart=${cfg.keepAliveOnCrash ? "on-failure" : "no"}`);
    lines.push(`RestartSec=${cfg.restartSec}`);

    for (const [key, val] of Object.entries(cfg.env)) {
      const isSecret =
        SecretReferenceSchema.safeParse(val).success ||
        (typeof val === "string" && val.startsWith("secret://"));
      const envKey = isSecret ? `BFLOW_SECRET_REF_${key}` : key;
      lines.push(`Environment="${envKey}=${val}"`);
    }

    lines.push("NoNewPrivileges=true");
    lines.push("");
    lines.push("[Install]");
    lines.push("WantedBy=default.target");
    lines.push("");

    return lines.join("\n");
  }

  private renderLaunchdPlist(cfg: OSServiceConfig): string {
    const xmlLines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      `<!-- ${BFLOW_SERVICE_MARKER} -->`,
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key>",
      `  <string>dev.bflow.${escapeXml(cfg.serviceId)}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      `    <string>${escapeXml(cfg.program)}</string>`
    ];

    for (const arg of cfg.args) {
      xmlLines.push(`    <string>${escapeXml(arg)}</string>`);
    }
    xmlLines.push("  </array>");

    if (cfg.workingDirectory) {
      xmlLines.push("  <key>WorkingDirectory</key>");
      xmlLines.push(`  <string>${escapeXml(cfg.workingDirectory)}</string>`);
    }

    if (Object.keys(cfg.env).length > 0) {
      xmlLines.push("  <key>EnvironmentVariables</key>");
      xmlLines.push("  <dict>");
      for (const [key, val] of Object.entries(cfg.env)) {
        const isSecret =
          SecretReferenceSchema.safeParse(val).success ||
          (typeof val === "string" && val.startsWith("secret://"));
        const envKey = isSecret ? `BFLOW_SECRET_REF_${key}` : key;
        xmlLines.push(`    <key>${escapeXml(envKey)}</key>`);
        xmlLines.push(`    <string>${escapeXml(val)}</string>`);
      }
      xmlLines.push("  </dict>");
    }

    xmlLines.push("  <key>RunAtLoad</key>");
    xmlLines.push(`  <${cfg.enableOnLogin ? "true" : "false"}/>`);

    if (cfg.keepAliveOnCrash) {
      xmlLines.push("  <key>KeepAlive</key>");
      xmlLines.push("  <dict>");
      xmlLines.push("    <key>SuccessfulExit</key>");
      xmlLines.push("    <false/>");
      xmlLines.push("  </dict>");
    } else {
      xmlLines.push("  <key>KeepAlive</key>");
      xmlLines.push("  <false/>");
    }

    xmlLines.push("  <key>ThrottleInterval</key>");
    xmlLines.push(`  <integer>${cfg.restartSec}</integer>`);

    const outLog = path.join(this.paths.logDir, `${cfg.serviceId}.out.log`);
    const errLog = path.join(this.paths.logDir, `${cfg.serviceId}.err.log`);
    xmlLines.push("  <key>StandardOutPath</key>");
    xmlLines.push(`  <string>${escapeXml(outLog)}</string>`);
    xmlLines.push("  <key>StandardErrorPath</key>");
    xmlLines.push(`  <string>${escapeXml(errLog)}</string>`);

    xmlLines.push("</dict>");
    xmlLines.push("</plist>");
    xmlLines.push("");

    return xmlLines.join("\n");
  }

  private renderWindowsTaskXml(cfg: OSServiceConfig): string {
    const xmlLines: string[] = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      `<!-- ${BFLOW_SERVICE_MARKER} -->`,
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      "  <RegistrationInfo>",
      `    <Description>${escapeXml(cfg.description)}</Description>`,
      "  </RegistrationInfo>",
      "  <Triggers>",
      "    <LogonTrigger>",
      `      <Enabled>${cfg.enableOnLogin ? "true" : "false"}</Enabled>`,
      "    </LogonTrigger>",
      "  </Triggers>",
      "  <Principals>",
      '    <Principal id="Author">',
      "      <LogonType>InteractiveToken</LogonType>",
      "      <RunLevel>LeastPrivilege</RunLevel>",
      "    </Principal>",
      "  </Principals>",
      "  <Settings>",
      "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "    <RestartOnFailure>",
      `      <Interval>PT${cfg.restartSec}S</Interval>`,
      `      <Count>${cfg.maxRestartBurst}</Count>`,
      "    </RestartOnFailure>",
      "  </Settings>",
      '  <Actions Context="Author">',
      "    <Exec>",
      `      <Command>${escapeXml(cfg.program)}</Command>`
    ];

    if (cfg.args.length > 0) {
      xmlLines.push(`      <Arguments>${escapeXml(cfg.args.join(" "))}</Arguments>`);
    }
    if (cfg.workingDirectory) {
      xmlLines.push(`      <WorkingDirectory>${escapeXml(cfg.workingDirectory)}</WorkingDirectory>`);
    }

    xmlLines.push("    </Exec>");
    xmlLines.push("  </Actions>");
    xmlLines.push("</Task>");
    xmlLines.push("");

    return xmlLines.join("\n");
  }

  async install(config: OSServiceConfig): Promise<OperationResult<OSServiceStatus>> {
    const winCheck = this.checkWindowsVerified();
    if (!winCheck.ok) return err(winCheck.error);

    const rendered = this.renderDefinition(config);
    if (!rendered.ok) return err(rendered.error);

    this.configs.set(config.serviceId, config);

    const unitFilePath = this.unitPath(config.serviceId);
    let existingContent: string | null = null;
    try {
      existingContent = await readFile(unitFilePath, "utf8");
    } catch {
      existingContent = null;
    }

    if (existingContent !== null && !existingContent.includes(BFLOW_SERVICE_MARKER)) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Refusing to overwrite unowned unit file",
        details: { diagnosticCode: "unowned_unit_file", unitPath: unitFilePath }
      });
    }

    await mkdir(path.dirname(unitFilePath), { recursive: true });
    await mkdir(this.paths.logDir, { recursive: true });
    await mkdir(this.paths.stateDir, { recursive: true });

    await writeFileAtomic(unitFilePath, rendered.value, 0o644);

    if (this.platform === "linux") {
      await this.runner.run(["systemctl", "--user", "daemon-reload"]);
      if (config.enableOnLogin) {
        await this.runner.run(["systemctl", "--user", "enable", `bflow-${config.serviceId}.service`]);
      } else {
        await this.runner.run(["systemctl", "--user", "disable", `bflow-${config.serviceId}.service`]);
      }
    } else if (this.platform === "darwin") {
      await this.runner.run(["launchctl", "bootout", `gui/${this.uid}/dev.bflow.${config.serviceId}`]);
      await this.runner.run(["launchctl", "bootstrap", `gui/${this.uid}`, unitFilePath]);
      if (config.enableOnLogin) {
        await this.runner.run(["launchctl", "enable", `gui/${this.uid}/dev.bflow.${config.serviceId}`]);
      } else {
        await this.runner.run(["launchctl", "disable", `gui/${this.uid}/dev.bflow.${config.serviceId}`]);
      }
    } else if (this.platform === "win32") {
      await this.runner.run([
        "schtasks",
        "/Create",
        "/TN",
        `\\Bflow\\bflow-${config.serviceId}`,
        "/XML",
        unitFilePath,
        "/F"
      ]);
      const cmdPath = path.join(this.paths.serviceUnitDir, `bflow-${config.serviceId}.cmd`);
      if (config.enableOnLogin) {
        await writeFileAtomic(
          cmdPath,
          `@rem ${BFLOW_SERVICE_MARKER}\r\nschtasks /Run /TN "\\Bflow\\bflow-${config.serviceId}"\r\n`,
          0o644
        );
        await this.runner.run(["schtasks", "/Change", "/TN", `\\Bflow\\bflow-${config.serviceId}`, "/ENABLE"]);
      } else {
        try {
          await unlink(cmdPath);
        } catch {
          // ignore
        }
        await this.runner.run(["schtasks", "/Change", "/TN", `\\Bflow\\bflow-${config.serviceId}`, "/DISABLE"]);
      }
    }

    return this.status(config.serviceId);
  }

  async start(serviceId: string): Promise<OperationResult<OSServiceStatus>> {
    const winCheck = this.checkWindowsVerified();
    if (!winCheck.ok) return err(winCheck.error);

    if (this.platform === "linux") {
      await this.runner.run(["systemctl", "--user", "start", `bflow-${serviceId}.service`]);
    } else if (this.platform === "darwin") {
      await this.runner.run(["launchctl", "kickstart", `gui/${this.uid}/dev.bflow.${serviceId}`]);
    } else if (this.platform === "win32") {
      await this.runner.run(["schtasks", "/Run", "/TN", `\\Bflow\\bflow-${serviceId}`]);
    }

    return this.status(serviceId);
  }

  async stop(serviceId: string): Promise<OperationResult<OSServiceStatus>> {
    const winCheck = this.checkWindowsVerified();
    if (!winCheck.ok) return err(winCheck.error);

    if (this.platform === "linux") {
      await this.runner.run(["systemctl", "--user", "stop", `bflow-${serviceId}.service`]);
    } else if (this.platform === "darwin") {
      await this.runner.run(["launchctl", "bootout", `gui/${this.uid}/dev.bflow.${serviceId}`]);
    } else if (this.platform === "win32") {
      await this.runner.run(["schtasks", "/End", "/TN", `\\Bflow\\bflow-${serviceId}`]);
    }

    return this.status(serviceId);
  }

  async restart(serviceId: string): Promise<OperationResult<OSServiceStatus>> {
    const winCheck = this.checkWindowsVerified();
    if (!winCheck.ok) return err(winCheck.error);

    this.restartCounts.set(serviceId, (this.restartCounts.get(serviceId) ?? 0) + 1);

    if (this.platform === "linux") {
      await this.runner.run(["systemctl", "--user", "restart", `bflow-${serviceId}.service`]);
    } else if (this.platform === "darwin") {
      await this.runner.run(["launchctl", "kickstart", "-k", `gui/${this.uid}/dev.bflow.${serviceId}`]);
    } else if (this.platform === "win32") {
      await this.runner.run(["schtasks", "/End", "/TN", `\\Bflow\\bflow-${serviceId}`]);
      await this.runner.run(["schtasks", "/Run", "/TN", `\\Bflow\\bflow-${serviceId}`]);
    }

    return this.status(serviceId);
  }

  async enableOnLogin(serviceId: string): Promise<OperationResult<OSServiceStatus>> {
    const winCheck = this.checkWindowsVerified();
    if (!winCheck.ok) return err(winCheck.error);

    if (this.platform === "linux") {
      await this.runner.run(["systemctl", "--user", "enable", `bflow-${serviceId}.service`]);
    } else if (this.platform === "darwin") {
      await this.runner.run(["launchctl", "enable", `gui/${this.uid}/dev.bflow.${serviceId}`]);
    } else if (this.platform === "win32") {
      await this.runner.run(["schtasks", "/Change", "/TN", `\\Bflow\\bflow-${serviceId}`, "/ENABLE"]);
      const cmdPath = path.join(this.paths.serviceUnitDir, `bflow-${serviceId}.cmd`);
      await writeFileAtomic(
        cmdPath,
        `@rem ${BFLOW_SERVICE_MARKER}\r\nschtasks /Run /TN "\\Bflow\\bflow-${serviceId}"\r\n`,
        0o644
      );
    }

    return this.status(serviceId);
  }

  async disableOnLogin(serviceId: string): Promise<OperationResult<OSServiceStatus>> {
    const winCheck = this.checkWindowsVerified();
    if (!winCheck.ok) return err(winCheck.error);

    if (this.platform === "linux") {
      await this.runner.run(["systemctl", "--user", "disable", `bflow-${serviceId}.service`]);
    } else if (this.platform === "darwin") {
      await this.runner.run(["launchctl", "disable", `gui/${this.uid}/dev.bflow.${serviceId}`]);
    } else if (this.platform === "win32") {
      await this.runner.run(["schtasks", "/Change", "/TN", `\\Bflow\\bflow-${serviceId}`, "/DISABLE"]);
      const cmdPath = path.join(this.paths.serviceUnitDir, `bflow-${serviceId}.cmd`);
      try {
        await unlink(cmdPath);
      } catch {
        // ignore
      }
    }

    return this.status(serviceId);
  }

  async status(serviceId: string): Promise<OperationResult<OSServiceStatus>> {
    const unitFilePath = this.unitPath(serviceId);
    let fileContent: string | null = null;
    try {
      fileContent = await readFile(unitFilePath, "utf8");
    } catch {
      fileContent = null;
    }

    if (fileContent === null) {
      return ok({
        schemaVersion: 3,
        serviceId,
        backendKind: this.backendKind,
        installed: false,
        enabledOnLogin: false,
        state: "not_installed",
        unitPath: unitFilePath,
        unitDigest: null,
        restartCount: this.restartCounts.get(serviceId) ?? 0,
        observedAt: this.now().toISOString(),
        diagnosticCode: "service_not_installed",
        diagnostics: ["Unit file not found on filesystem"]
      });
    }

    const unitDigest = createHash("sha256").update(fileContent, "utf8").digest("hex");
    let state: OSServiceLifecycleState = "unknown";
    let enabledOnLogin = false;
    let pid: number | undefined;
    let restartCount = this.restartCounts.get(serviceId) ?? 0;

    if (this.platform === "linux") {
      const activeRes = await this.runner.run(["systemctl", "--user", "is-active", `bflow-${serviceId}.service`]);
      const enabledRes = await this.runner.run(["systemctl", "--user", "is-enabled", `bflow-${serviceId}.service`]);
      const showRes = await this.runner.run([
        "systemctl",
        "--user",
        "show",
        "--property=MainPID,NRestarts",
        `bflow-${serviceId}.service`
      ]);

      const activeText = activeRes.stdout.trim().toLowerCase();
      if (activeText === "active") state = "running";
      else if (activeText === "activating") state = "activating";
      else if (activeText === "deactivating") state = "deactivating";
      else if (activeText === "failed") state = "failed";
      else if (activeText === "inactive" || activeRes.exitCode === 3 || activeRes.exitCode === 4) state = "stopped";
      else state = "unknown";

      enabledOnLogin = enabledRes.stdout.trim().toLowerCase() === "enabled";

      let systemdRestarts = 0;
      for (const line of showRes.stdout.split("\n")) {
        const [k, v] = line.trim().split("=");
        if (k === "MainPID" && v) {
          const parsedPid = parseInt(v, 10);
          if (!isNaN(parsedPid) && parsedPid > 0 && state === "running") {
            pid = parsedPid;
          }
        }
        if (k === "NRestarts" && v) {
          const parsedRestarts = parseInt(v, 10);
          if (!isNaN(parsedRestarts) && parsedRestarts >= 0) {
            systemdRestarts = parsedRestarts;
          }
        }
      }
      restartCount = Math.max(restartCount, systemdRestarts);
    } else if (this.platform === "darwin") {
      const printRes = await this.runner.run(["launchctl", "print", `gui/${this.uid}/dev.bflow.${serviceId}`]);
      if (printRes.exitCode === 0) {
        const pidMatch = printRes.stdout.match(/pid\s*=\s*(\d+)/i);
        if (pidMatch && pidMatch[1]) {
          const parsedPid = parseInt(pidMatch[1], 10);
          if (!isNaN(parsedPid) && parsedPid > 0) {
            pid = parsedPid;
            state = "running";
          }
        } else if (/state\s*=\s*running/i.test(printRes.stdout)) {
          state = "running";
        } else {
          state = "stopped";
        }
        const disabled = /disabled\s*=\s*true/i.test(printRes.stdout);
        enabledOnLogin = !disabled;
      } else {
        state = "stopped";
        enabledOnLogin =
          fileContent.includes("<key>RunAtLoad</key>\n  <true/>") ||
          fileContent.includes("<key>RunAtLoad</key><true/>");
      }
    } else if (this.platform === "win32") {
      const queryRes = await this.runner.run([
        "schtasks",
        "/Query",
        "/TN",
        `\\Bflow\\bflow-${serviceId}`,
        "/FO",
        "LIST",
        "/V"
      ]);
      if (queryRes.exitCode === 0) {
        const statusMatch = queryRes.stdout.match(/Status:\s*([^\r\n]+)/i);
        const statusText = (statusMatch?.[1] ?? "").trim().toLowerCase();
        if (statusText === "running") state = "running";
        else if (statusText === "ready") state = "stopped";
        else if (statusText.includes("disabled")) state = "stopped";
        else state = "stopped";

        const schedMatch = queryRes.stdout.match(/Scheduled Task State:\s*([^\r\n]+)/i);
        const schedText = (schedMatch?.[1] ?? "").trim().toLowerCase();
        enabledOnLogin =
          schedText === "enabled" || (!statusText.includes("disabled") && !schedText.includes("disabled"));
      } else {
        state = "stopped";
      }
    }

    return ok({
      schemaVersion: 3,
      serviceId,
      backendKind: this.backendKind,
      installed: true,
      enabledOnLogin,
      state,
      ...(pid !== undefined ? { pid } : {}),
      unitPath: unitFilePath,
      unitDigest,
      restartCount,
      observedAt: this.now().toISOString(),
      diagnosticCode: `service_${state}`,
      diagnostics: [`Service is ${state}`]
    });
  }

  async logs(serviceId: string, options?: OSServiceLogOptions): Promise<OperationResult<OSServiceLogResult>> {
    const linesCount = options?.lines ?? 50;

    if (this.platform === "linux") {
      const argv = ["journalctl", "--user", "-u", `bflow-${serviceId}.service`, "--no-pager", "-n", String(linesCount)];
      if (options?.since) {
        argv.push("--since", options.since);
      }
      const res = await this.runner.run(argv);
      if (res.exitCode === 0 && res.stdout.trim().length > 0) {
        const lines = res.stdout.split("\n").filter((l, i, arr) => i < arr.length - 1 || l.length > 0);
        return ok({
          serviceId,
          lines,
          source: "journalctl",
          observedAt: this.now().toISOString()
        });
      }
      const logFile = path.join(this.paths.logDir, `${serviceId}.log`);
      try {
        const content = await readFile(logFile, "utf8");
        const lines = content.split("\n").slice(-linesCount);
        return ok({
          serviceId,
          lines,
          source: "logfile",
          observedAt: this.now().toISOString()
        });
      } catch {
        return ok({
          serviceId,
          lines: [],
          source: "journalctl",
          observedAt: this.now().toISOString()
        });
      }
    }

    if (this.platform === "darwin") {
      const outLog = path.join(this.paths.logDir, `${serviceId}.out.log`);
      const errLog = path.join(this.paths.logDir, `${serviceId}.err.log`);
      const combined: string[] = [];
      try {
        const outContent = await readFile(outLog, "utf8");
        combined.push(...outContent.split("\n"));
      } catch {
        // ignore
      }
      try {
        const errContent = await readFile(errLog, "utf8");
        combined.push(...errContent.split("\n"));
      } catch {
        // ignore
      }
      const lines = combined.filter((l) => l.length > 0).slice(-linesCount);
      return ok({
        serviceId,
        lines,
        source: "logfile",
        observedAt: this.now().toISOString()
      });
    }

    // win32
    const winLog = path.join(this.paths.logDir, `${serviceId}.log`);
    try {
      const content = await readFile(winLog, "utf8");
      const lines = content.split("\n").filter((l) => l.length > 0).slice(-linesCount);
      return ok({
        serviceId,
        lines,
        source: "logfile",
        observedAt: this.now().toISOString()
      });
    } catch {
      return ok({
        serviceId,
        lines: [],
        source: "windows-event",
        observedAt: this.now().toISOString()
      });
    }
  }

  async healthCheck(serviceId: string): Promise<OperationResult<OSServiceHealthReport>> {
    const statusRes = await this.status(serviceId);
    if (!statusRes.ok) return err(statusRes.error);

    const statusVal = statusRes.value;
    const processAlive = statusVal.state === "running";

    const cfg = this.configs.get(serviceId);
    const rawUrl = cfg?.healthEndpointUrl ?? "http://127.0.0.1:43110/health";
    const timeoutMs = cfg?.healthTimeoutMs ?? 5_000;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return err({
        code: "validation",
        retryable: false,
        message: `Invalid health endpoint URL: ${rawUrl}`,
        details: { diagnosticCode: "invalid_health_url", url: rawUrl }
      });
    }

    const host = parsedUrl.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1") {
      return err({
        code: "validation",
        retryable: false,
        message: `Health endpoint must be strictly loopback (got '${parsedUrl.hostname}')`,
        details: { diagnosticCode: "non_loopback_health_url", url: rawUrl, host: parsedUrl.hostname }
      });
    }

    let endpointReachable = false;
    let latencyMs = 0;

    if (processAlive) {
      const start = Date.now();
      try {
        endpointReachable = await this.healthProbe(rawUrl, timeoutMs);
      } catch {
        endpointReachable = false;
      }
      latencyMs = Date.now() - start;
    }

    const healthy = processAlive && endpointReachable;

    return ok({
      schemaVersion: 3,
      serviceId,
      healthy,
      processAlive,
      endpointReachable,
      status: statusVal,
      latencyMs,
      diagnosticCode: healthy
        ? "healthy"
        : !processAlive
          ? "process_not_running"
          : "endpoint_unreachable",
      message: healthy
        ? `Service ${serviceId} is healthy`
        : `Service ${serviceId} is unhealthy: processAlive=${processAlive}, endpointReachable=${endpointReachable}`,
      observedAt: this.now().toISOString()
    });
  }

  async repair(serviceId: string, config: OSServiceConfig): Promise<OperationResult<OSServiceRepairResult>> {
    const winCheck = this.checkWindowsVerified();
    if (!winCheck.ok) return err(winCheck.error);

    const rendered = this.renderDefinition(config);
    if (!rendered.ok) return err(rendered.error);

    const canonicalDigest = createHash("sha256").update(rendered.value, "utf8").digest("hex");
    const unitFilePath = this.unitPath(serviceId);
    const actionsTaken: string[] = [];

    let existingContent: string | null = null;
    try {
      existingContent = await readFile(unitFilePath, "utf8");
    } catch {
      existingContent = null;
    }

    if (existingContent !== null) {
      if (!existingContent.includes(BFLOW_SERVICE_MARKER)) {
        return err({
          code: "conflict",
          retryable: true,
          message: "Refusing to overwrite unowned unit file",
          details: { diagnosticCode: "unowned_unit_file", unitPath: unitFilePath }
        });
      }

      const currentDigest = createHash("sha256").update(existingContent, "utf8").digest("hex");
      if (currentDigest !== canonicalDigest) {
        const backupDir = path.join(this.paths.stateDir, "backups");
        await mkdir(backupDir, { recursive: true });
        const backupFile = path.join(
          backupDir,
          `${path.basename(unitFilePath)}.${Date.now()}.bak`
        );
        await writeFile(backupFile, existingContent, "utf8");
        actionsTaken.push(`backed_up_unit:${backupFile}`);

        await writeFileAtomic(unitFilePath, rendered.value, 0o644);
        actionsTaken.push("restored_canonical_unit");
      } else {
        actionsTaken.push("unit_file_verified");
      }
    } else {
      await mkdir(path.dirname(unitFilePath), { recursive: true });
      await writeFileAtomic(unitFilePath, rendered.value, 0o644);
      actionsTaken.push("installed_missing_unit");
    }

    this.configs.set(serviceId, config);

    if (this.platform === "linux") {
      await this.runner.run(["systemctl", "--user", "daemon-reload"]);
      actionsTaken.push("reloaded_daemon");
      if (config.enableOnLogin) {
        await this.enableOnLogin(serviceId);
        actionsTaken.push("enabled_on_login");
      }
    } else if (this.platform === "darwin") {
      await this.runner.run(["launchctl", "bootout", `gui/${this.uid}/dev.bflow.${serviceId}`]);
      await this.runner.run(["launchctl", "bootstrap", `gui/${this.uid}`, unitFilePath]);
      actionsTaken.push("reloaded_daemon");
      if (config.enableOnLogin) {
        await this.enableOnLogin(serviceId);
        actionsTaken.push("enabled_on_login");
      }
    } else if (this.platform === "win32") {
      await this.runner.run([
        "schtasks",
        "/Create",
        "/TN",
        `\\Bflow\\bflow-${serviceId}`,
        "/XML",
        unitFilePath,
        "/F"
      ]);
      actionsTaken.push("reloaded_daemon");
      if (config.enableOnLogin) {
        await this.enableOnLogin(serviceId);
        actionsTaken.push("enabled_on_login");
      }
    }

    const restartRes = await this.restart(serviceId);
    if (!restartRes.ok) return err(restartRes.error);
    actionsTaken.push("restarted_service");

    const healthRes = await this.healthCheck(serviceId);
    if (!healthRes.ok) return err(healthRes.error);

    return ok({
      serviceId,
      repaired: true,
      actionsTaken,
      status: healthRes.value.status,
      health: healthRes.value
    });
  }

  async recoverIfDead(
    serviceId: string,
    config?: OSServiceConfig
  ): Promise<OperationResult<OSServiceHealthReport>> {
    const healthCheckRes = await this.healthCheck(serviceId);
    if (healthCheckRes.ok && healthCheckRes.value.healthy) {
      return ok({
        ...healthCheckRes.value,
        diagnosticCode: "already_healthy",
        message: `Service ${serviceId} is already healthy`
      });
    }

    const maxBurst = config?.maxRestartBurst ?? this.configs.get(serviceId)?.maxRestartBurst ?? 5;
    const currentRestarts = this.restartCounts.get(serviceId) ?? 0;

    if (currentRestarts >= maxBurst) {
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: `Service restart burst limit exceeded (${currentRestarts}/${maxBurst})`,
        details: {
          diagnosticCode: "restart_limit_exceeded",
          restartCount: currentRestarts,
          maxRestartBurst: maxBurst
        }
      });
    }

    let unitMissing = false;
    try {
      await access(this.unitPath(serviceId));
    } catch {
      unitMissing = true;
    }

    if (unitMissing && config) {
      const repairRes = await this.repair(serviceId, config);
      if (!repairRes.ok) return err(repairRes.error);
      return ok(repairRes.value.health);
    }

    const restartRes = await this.restart(serviceId);
    if (!restartRes.ok) return err(restartRes.error);

    return this.healthCheck(serviceId);
  }

  async simulateUserLogin(): Promise<OperationResult<readonly OSServiceStatus[]>> {
    const winCheck = this.checkWindowsVerified();
    if (!winCheck.ok) return err(winCheck.error);

    let entries: string[] = [];
    try {
      entries = await readdir(this.paths.serviceUnitDir);
    } catch {
      return ok([]);
    }

    const results: OSServiceStatus[] = [];

    for (const file of entries) {
      let serviceId: string | null = null;
      if (this.platform === "linux") {
        const m = file.match(/^bflow-(.+)\.service$/);
        if (m) serviceId = m[1] ?? null;
      } else if (this.platform === "darwin") {
        const m = file.match(/^dev\.bflow\.(.+)\.plist$/);
        if (m) serviceId = m[1] ?? null;
      } else if (this.platform === "win32") {
        const m = file.match(/^bflow-(.+)\.xml$/);
        if (m) serviceId = m[1] ?? null;
      }

      if (!serviceId) continue;

      const fullPath = path.join(this.paths.serviceUnitDir, file);
      try {
        const content = await readFile(fullPath, "utf8");
        if (!content.includes(BFLOW_SERVICE_MARKER)) {
          continue;
        }
      } catch {
        continue;
      }

      const st = await this.status(serviceId);
      if (!st.ok) continue;

      if (st.value.enabledOnLogin) {
        if (st.value.state !== "running") {
          const started = await this.start(serviceId);
          results.push(started.ok ? started.value : st.value);
        } else {
          results.push(st.value);
        }
      } else {
        results.push(st.value);
      }
    }

    return ok(results);
  }
}
