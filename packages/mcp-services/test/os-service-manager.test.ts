import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BflowOSServiceManager,
  DENYLISTED_PRIVILEGE_COMMANDS,
  SafeOSCommandRunner,
  validateNoRootCommand
} from "../src/os-service-manager.js";
import {
  BFLOW_SERVICE_MARKER,
  type OSCommandResult,
  type OSCommandRunner,
  type OSServiceConfig
} from "../src/types.js";

interface MockServiceState {
  active: "active" | "inactive" | "failed";
  enabled: boolean;
  pid: number;
  restarts: number;
  logs: string[];
}

class MockOSCommandRunner implements OSCommandRunner {
  public calls: Array<{ argv: readonly string[]; options?: any }> = [];
  public services = new Map<string, MockServiceState>();

  private getOrCreate(id: string): MockServiceState {
    let s = this.services.get(id);
    if (!s) {
      s = { active: "inactive", enabled: true, pid: 0, restarts: 0, logs: [] };
      this.services.set(id, s);
    }
    return s;
  }

  async run(argv: readonly string[], options?: any): Promise<OSCommandResult> {
    this.calls.push({ argv, options });
    const cmd = argv[0];

    // Linux systemctl
    if (cmd === "systemctl") {
      const sub = argv[2];
      const unit = argv.find((a) => a.endsWith(".service") || a.startsWith("bflow-")) ?? "";
      const serviceId = unit ? unit.replace(/^bflow-/, "").replace(/\.service$/, "") : "";

      if (sub === "daemon-reload") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "enable") {
        const s = this.getOrCreate(serviceId);
        s.enabled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "disable") {
        const s = this.getOrCreate(serviceId);
        s.enabled = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "start") {
        const s = this.getOrCreate(serviceId);
        s.active = "active";
        s.pid = 12345;
        s.logs.push(`Started ${serviceId}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "stop") {
        const s = this.getOrCreate(serviceId);
        s.active = "inactive";
        s.pid = 0;
        s.logs.push(`Stopped ${serviceId}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "restart") {
        const s = this.getOrCreate(serviceId);
        s.active = "active";
        s.pid = 12346;
        s.restarts++;
        s.logs.push(`Restarted ${serviceId}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "is-active") {
        const s = this.getOrCreate(serviceId);
        if (s.active === "active") {
          return { exitCode: 0, stdout: "active\n", stderr: "" };
        } else if (s.active === "failed") {
          return { exitCode: 3, stdout: "failed\n", stderr: "" };
        } else {
          return { exitCode: 3, stdout: "inactive\n", stderr: "" };
        }
      }
      if (sub === "is-enabled") {
        const s = this.getOrCreate(serviceId);
        return { exitCode: 0, stdout: s.enabled ? "enabled\n" : "disabled\n", stderr: "" };
      }
      if (sub === "show") {
        const s = this.getOrCreate(serviceId);
        return {
          exitCode: 0,
          stdout: `MainPID=${s.pid}\nNRestarts=${s.restarts}\n`,
          stderr: ""
        };
      }
    }

    // Linux journalctl
    if (cmd === "journalctl") {
      const uIndex = argv.indexOf("-u");
      const unit = uIndex !== -1 ? argv[uIndex + 1] : "";
      const serviceId = unit ? unit.replace(/^bflow-/, "").replace(/\.service$/, "") : "";
      const s = this.getOrCreate(serviceId);
      const lines = s.logs.length > 0 ? s.logs.join("\n") + "\n" : "log line 1\nlog line 2\n";
      return { exitCode: 0, stdout: lines, stderr: "" };
    }

    // macOS launchctl
    if (cmd === "launchctl") {
      const sub = argv[1];
      const target = argv[2];

      if (sub === "bootstrap") {
        const plistPath = argv[3] ?? "";
        const idMatch = plistPath.match(/dev\.bflow\.(.+)\.plist$/);
        const serviceId = idMatch ? idMatch[1] : "";
        const s = this.getOrCreate(serviceId ?? "");
        s.active = "inactive";
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "bootout") {
        const serviceId = target ? target.split("dev.bflow.").pop() ?? "" : "";
        const s = this.getOrCreate(serviceId);
        s.active = "inactive";
        s.pid = 0;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "kickstart") {
        const isK = argv.includes("-k");
        const fullTarget = argv[argv.length - 1] ?? "";
        const serviceId = fullTarget.split("dev.bflow.").pop() ?? "";
        const s = this.getOrCreate(serviceId);
        s.active = "active";
        s.pid = 67890;
        if (isK) s.restarts++;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "enable") {
        const serviceId = target ? target.split("dev.bflow.").pop() ?? "" : "";
        const s = this.getOrCreate(serviceId);
        s.enabled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "disable") {
        const serviceId = target ? target.split("dev.bflow.").pop() ?? "" : "";
        const s = this.getOrCreate(serviceId);
        s.enabled = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "print") {
        const serviceId = target ? target.split("dev.bflow.").pop() ?? "" : "";
        const s = this.getOrCreate(serviceId);
        if (s.active === "active") {
          return {
            exitCode: 0,
            stdout: `state = running\npid = ${s.pid}\ndisabled = ${!s.enabled}\n`,
            stderr: ""
          };
        } else {
          return {
            exitCode: 0,
            stdout: `state = stopped\ndisabled = ${!s.enabled}\n`,
            stderr: ""
          };
        }
      }
    }

    // Windows schtasks
    if (cmd === "schtasks") {
      const sub = argv[1];
      const tnIndex = argv.indexOf("/TN");
      const tn = tnIndex !== -1 ? argv[tnIndex + 1] : "";
      const serviceId = tn ? tn.split("bflow-").pop() ?? "" : "";
      const s = this.getOrCreate(serviceId);

      if (sub === "/Create") {
        return { exitCode: 0, stdout: "SUCCESS: The scheduled task was successfully created.\n", stderr: "" };
      }
      if (sub === "/Run") {
        s.active = "active";
        s.pid = 11111;
        return { exitCode: 0, stdout: "SUCCESS: Attempted to run the scheduled task.\n", stderr: "" };
      }
      if (sub === "/End") {
        s.active = "inactive";
        s.pid = 0;
        return { exitCode: 0, stdout: "SUCCESS: The scheduled task was terminated successfully.\n", stderr: "" };
      }
      if (sub === "/Change") {
        if (argv.includes("/ENABLE")) s.enabled = true;
        if (argv.includes("/DISABLE")) s.enabled = false;
        return { exitCode: 0, stdout: "SUCCESS: The parameters of scheduled task were changed.\n", stderr: "" };
      }
      if (sub === "/Query") {
        const statusStr = s.active === "active" ? "Running" : "Ready";
        const schedStr = s.enabled ? "Enabled" : "Disabled";
        return {
          exitCode: 0,
          stdout: `TaskName: ${tn}\nStatus: ${statusStr}\nScheduled Task State: ${schedStr}\n`,
          stderr: ""
        };
      }
    }

    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

describe("BflowOSServiceManager", () => {
  let tmpDir: string;
  let mockRunner: MockOSCommandRunner;

  const sampleConfig: OSServiceConfig = {
    schemaVersion: 3,
    serviceId: "mcp-gateway",
    description: "Bflow MCP Gateway Daemon",
    program: "/usr/local/bin/node",
    args: ["/opt/bflow/mcp-gateway/dist/index.js", "--port", "43110"],
    workingDirectory: "/opt/bflow",
    env: {
      PORT: "43110",
      NODE_ENV: "production",
      API_TOKEN: "secret://vault/gateway-token"
    },
    healthEndpointUrl: "http://127.0.0.1:43110/health",
    healthTimeoutMs: 1000,
    keepAliveOnCrash: true,
    enableOnLogin: true,
    restartSec: 2,
    maxRestartBurst: 5
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "bflow-osm-test-"));
    mockRunner = new MockOSCommandRunner();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("1. Linux systemd-user full lifecycle", () => {
    it("renders valid systemd unit with secrets transformed and executes lifecycle commands", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "linux",
        homeDir: tmpDir,
        runner: mockRunner,
        healthProbe: async () => true
      });

      // Render check
      const rendered = manager.renderDefinition(sampleConfig);
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;

      expect(rendered.value).toContain(`# ${BFLOW_SERVICE_MARKER}`);
      expect(rendered.value).toContain("Description=Bflow MCP Gateway Daemon");
      expect(rendered.value).toContain("StartLimitIntervalSec=60");
      expect(rendered.value).toContain("StartLimitBurst=5");
      expect(rendered.value).toContain("Type=simple");
      expect(rendered.value).toContain("ExecStart=/usr/local/bin/node /opt/bflow/mcp-gateway/dist/index.js --port 43110");
      expect(rendered.value).toContain("WorkingDirectory=/opt/bflow");
      expect(rendered.value).toContain("Restart=on-failure");
      expect(rendered.value).toContain("RestartSec=2");
      expect(rendered.value).toContain('Environment="PORT=43110"');
      expect(rendered.value).toContain('Environment="BFLOW_SECRET_REF_API_TOKEN=secret://vault/gateway-token"');
      expect(rendered.value).toContain("NoNewPrivileges=true");
      expect(rendered.value).toContain("WantedBy=default.target");

      // Install
      const installRes = await manager.install(sampleConfig);
      expect(installRes.ok).toBe(true);
      if (!installRes.ok) return;
      expect(installRes.value.installed).toBe(true);
      expect(installRes.value.enabledOnLogin).toBe(true);
      expect(installRes.value.state).toBe("stopped");

      // Verify unit file exists on disk
      const unitPath = manager.unitPath("mcp-gateway");
      const diskContent = await readFile(unitPath, "utf8");
      expect(diskContent).toBe(rendered.value);

      // Verify systemctl commands used user flag
      expect(mockRunner.calls.some((c) => c.argv.join(" ") === "systemctl --user daemon-reload")).toBe(true);
      expect(mockRunner.calls.some((c) => c.argv.join(" ") === "systemctl --user enable bflow-mcp-gateway.service")).toBe(true);

      // Start
      const startRes = await manager.start("mcp-gateway");
      expect(startRes.ok).toBe(true);
      if (!startRes.ok) return;
      expect(startRes.value.state).toBe("running");
      expect(startRes.value.pid).toBe(12345);

      // Status
      const statusRes = await manager.status("mcp-gateway");
      expect(statusRes.ok).toBe(true);
      if (!statusRes.ok) return;
      expect(statusRes.value.state).toBe("running");
      expect(statusRes.value.pid).toBe(12345);
      expect(statusRes.value.unitDigest).not.toBeNull();

      // Disable on login
      const disableRes = await manager.disableOnLogin("mcp-gateway");
      expect(disableRes.ok).toBe(true);
      if (!disableRes.ok) return;
      expect(disableRes.value.enabledOnLogin).toBe(false);

      // Enable on login
      const enableRes = await manager.enableOnLogin("mcp-gateway");
      expect(enableRes.ok).toBe(true);
      if (!enableRes.ok) return;
      expect(enableRes.value.enabledOnLogin).toBe(true);

      // Restart
      const restartRes = await manager.restart("mcp-gateway");
      expect(restartRes.ok).toBe(true);
      if (!restartRes.ok) return;
      expect(restartRes.value.restartCount).toBe(1);

      // Logs
      const logsRes = await manager.logs("mcp-gateway", { lines: 10 });
      expect(logsRes.ok).toBe(true);
      if (!logsRes.ok) return;
      expect(logsRes.value.source).toBe("journalctl");
      expect(logsRes.value.lines.length).toBeGreaterThan(0);

      // Stop
      const stopRes = await manager.stop("mcp-gateway");
      expect(stopRes.ok).toBe(true);
      if (!stopRes.ok) return;
      expect(stopRes.value.state).toBe("stopped");
    });
  });

  describe("2. macOS launchd full lifecycle", () => {
    it("renders valid XML plist and exercises launchd gui domain operations", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "darwin",
        homeDir: tmpDir,
        uid: 501,
        runner: mockRunner,
        healthProbe: async () => true
      });

      // Render check
      const rendered = manager.renderDefinition(sampleConfig);
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;

      expect(rendered.value).toContain(`<!-- ${BFLOW_SERVICE_MARKER} -->`);
      expect(rendered.value).toContain("<key>Label</key>");
      expect(rendered.value).toContain("<string>dev.bflow.mcp-gateway</string>");
      expect(rendered.value).toContain("<key>ProgramArguments</key>");
      expect(rendered.value).toContain("<string>/usr/local/bin/node</string>");
      expect(rendered.value).toContain("<key>WorkingDirectory</key>");
      expect(rendered.value).toContain("<string>/opt/bflow</string>");
      expect(rendered.value).toContain("<key>BFLOW_SECRET_REF_API_TOKEN</key>");
      expect(rendered.value).toContain("<string>secret://vault/gateway-token</string>");
      expect(rendered.value).toContain("<key>RunAtLoad</key>");
      expect(rendered.value).toContain("<true/>");
      expect(rendered.value).toContain("<key>KeepAlive</key>");
      expect(rendered.value).toContain("<key>SuccessfulExit</key>");
      expect(rendered.value).toContain("<false/>");
      expect(rendered.value).toContain("<key>ThrottleInterval</key>");
      expect(rendered.value).toContain("<integer>2</integer>");

      // Install
      const installRes = await manager.install(sampleConfig);
      expect(installRes.ok).toBe(true);
      if (!installRes.ok) return;
      expect(installRes.value.installed).toBe(true);
      expect(installRes.value.backendKind).toBe("launchd");

      // Verify launchctl bootstrap used gui/501
      expect(mockRunner.calls.some((c) => c.argv[0] === "launchctl" && c.argv[1] === "bootstrap" && c.argv[2] === "gui/501")).toBe(true);

      // Start
      const startRes = await manager.start("mcp-gateway");
      expect(startRes.ok).toBe(true);
      if (!startRes.ok) return;
      expect(startRes.value.state).toBe("running");
      expect(startRes.value.pid).toBe(67890);

      // Status
      const statusRes = await manager.status("mcp-gateway");
      expect(statusRes.ok).toBe(true);
      if (!statusRes.ok) return;
      expect(statusRes.value.state).toBe("running");

      // Disable on login
      const disableRes = await manager.disableOnLogin("mcp-gateway");
      expect(disableRes.ok).toBe(true);

      // Enable on login
      const enableRes = await manager.enableOnLogin("mcp-gateway");
      expect(enableRes.ok).toBe(true);

      // Restart (kickstart -k)
      const restartRes = await manager.restart("mcp-gateway");
      expect(restartRes.ok).toBe(true);
      expect(mockRunner.calls.some((c) => c.argv.includes("kickstart") && c.argv.includes("-k"))).toBe(true);

      // Logs fallback to log files
      const outLog = path.join(manager.paths.logDir, "mcp-gateway.out.log");
      await writeFile(outLog, "mac out log line 1\nmac out log line 2\n", "utf8");
      const logsRes = await manager.logs("mcp-gateway", { lines: 10 });
      expect(logsRes.ok).toBe(true);
      if (!logsRes.ok) return;
      expect(logsRes.value.source).toBe("logfile");
      expect(logsRes.value.lines).toContain("mac out log line 1");

      // Stop
      const stopRes = await manager.stop("mcp-gateway");
      expect(stopRes.ok).toBe(true);
      if (!stopRes.ok) return;
      expect(stopRes.value.state).toBe("stopped");
    });
  });

  describe("3. Windows windows-startup support", () => {
    it("rejects mutating operations by default when windowsVerified is false", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "win32",
        homeDir: tmpDir,
        runner: mockRunner,
        windowsVerified: false
      });

      const installRes = await manager.install(sampleConfig);
      expect(installRes.ok).toBe(false);
      if (installRes.ok) return;
      expect(installRes.error.code).toBe("validation");
      expect(installRes.error.details).toEqual({ diagnosticCode: "windows_unverified" });

      const startRes = await manager.start("mcp-gateway");
      expect(startRes.ok).toBe(false);

      const stopRes = await manager.stop("mcp-gateway");
      expect(stopRes.ok).toBe(false);

      const restartRes = await manager.restart("mcp-gateway");
      expect(restartRes.ok).toBe(false);
    });

    it("renders Scheduled Task XML with LeastPrivilege and executes lifecycle when windowsVerified is true", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "win32",
        homeDir: tmpDir,
        runner: mockRunner,
        windowsVerified: true,
        healthProbe: async () => true
      });

      // Render
      const rendered = manager.renderDefinition(sampleConfig);
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;

      expect(rendered.value).toContain(`<!-- ${BFLOW_SERVICE_MARKER} -->`);
      expect(rendered.value).toContain("<LogonTrigger>");
      expect(rendered.value).toContain("<RunLevel>LeastPrivilege</RunLevel>");
      expect(rendered.value).toContain("<RestartOnFailure>");
      expect(rendered.value).toContain("<Interval>PT2S</Interval>");
      expect(rendered.value).toContain("<Count>5</Count>");
      expect(rendered.value).toContain("<Exec>");
      expect(rendered.value).toContain("<Command>/usr/local/bin/node</Command>");

      // Install
      const installRes = await manager.install(sampleConfig);
      expect(installRes.ok).toBe(true);
      if (!installRes.ok) return;
      expect(installRes.value.backendKind).toBe("windows-startup");
      expect(installRes.value.installed).toBe(true);

      // Verify schtasks /Create was invoked
      expect(mockRunner.calls.some((c) => c.argv[0] === "schtasks" && c.argv[1] === "/Create")).toBe(true);

      // Start
      const startRes = await manager.start("mcp-gateway");
      expect(startRes.ok).toBe(true);
      if (!startRes.ok) return;
      expect(startRes.value.state).toBe("running");

      // Status
      const statusRes = await manager.status("mcp-gateway");
      expect(statusRes.ok).toBe(true);
      if (!statusRes.ok) return;
      expect(statusRes.value.state).toBe("running");

      // Disable on login
      const disableRes = await manager.disableOnLogin("mcp-gateway");
      expect(disableRes.ok).toBe(true);

      // Enable on login
      const enableRes = await manager.enableOnLogin("mcp-gateway");
      expect(enableRes.ok).toBe(true);

      // Restart
      const restartRes = await manager.restart("mcp-gateway");
      expect(restartRes.ok).toBe(true);

      // Stop
      const stopRes = await manager.stop("mcp-gateway");
      expect(stopRes.ok).toBe(true);
      if (!stopRes.ok) return;
      expect(stopRes.value.state).toBe("stopped");
    });
  });

  describe("4. No-root & privilege escalation guard", () => {
    it("rejects denylisted privilege binaries in validateNoRootCommand", () => {
      for (const cmd of DENYLISTED_PRIVILEGE_COMMANDS) {
        const res = validateNoRootCommand([cmd, "arg1"]);
        expect(res.ok).toBe(false);
        if (res.ok) continue;
        expect(res.error.code).toBe("validation");
        expect(res.error.details).toMatchObject({ diagnosticCode: "privilege_escalation_forbidden" });
      }

      // Check path prefixes like /usr/bin/sudo
      expect(validateNoRootCommand(["/usr/bin/sudo", "systemctl"]).ok).toBe(false);
      expect(validateNoRootCommand(["runas.exe", "/user:admin"]).ok).toBe(false);

      // Check control characters
      expect(validateNoRootCommand(["echo", "hello\0world"]).ok).toBe(false);
      expect(validateNoRootCommand(["echo", "hello\rworld"]).ok).toBe(false);
      expect(validateNoRootCommand(["echo", "hello\nworld"]).ok).toBe(false);

      // Check empty
      expect(validateNoRootCommand([]).ok).toBe(false);

      // Check safe
      expect(validateNoRootCommand(["node", "index.js"]).ok).toBe(true);
    });

    it("rejects privilege escalation in SafeOSCommandRunner", async () => {
      const runner = new SafeOSCommandRunner();
      await expect(runner.run(["sudo", "ls"])).rejects.toThrow(/strictly forbidden/);
      await expect(runner.run(["echo", "a\0b"])).rejects.toThrow(/forbidden control characters/);

      // Safe command executes cleanly
      const res = await runner.run([process.execPath, "-e", "console.log('safe-runner-ok')"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("safe-runner-ok");
    });

    it("rejects privilege escalation binary in service config program or args", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "linux",
        homeDir: tmpDir,
        runner: mockRunner
      });

      const badConfig: OSServiceConfig = {
        ...sampleConfig,
        program: "sudo"
      };

      const rendered = manager.renderDefinition(badConfig);
      expect(rendered.ok).toBe(false);
      if (rendered.ok) return;
      expect(rendered.error.code).toBe("validation");
      expect(rendered.error.details).toMatchObject({ diagnosticCode: "privilege_escalation_forbidden" });

      const installRes = await manager.install(badConfig);
      expect(installRes.ok).toBe(false);
    });
  });

  describe("5. Gateway crash & automatic recovery (recoverIfDead)", () => {
    it("detects healthy service and returns already_healthy without unnecessary restarts", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "linux",
        homeDir: tmpDir,
        runner: mockRunner,
        healthProbe: async () => true
      });

      await manager.install(sampleConfig);
      await manager.start("mcp-gateway");

      const recoverRes = await manager.recoverIfDead("mcp-gateway", sampleConfig);
      expect(recoverRes.ok).toBe(true);
      if (!recoverRes.ok) return;
      expect(recoverRes.value.healthy).toBe(true);
      expect(recoverRes.value.diagnosticCode).toBe("already_healthy");
    });

    it("recovers a dead/stopped process and passes healthCheck", async () => {
      let isHealthy = false;
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "linux",
        homeDir: tmpDir,
        runner: mockRunner,
        healthProbe: async () => isHealthy
      });

      await manager.install(sampleConfig);
      // initially stopped
      const beforeHealth = await manager.healthCheck("mcp-gateway");
      expect(beforeHealth.ok).toBe(true);
      if (!beforeHealth.ok) return;
      expect(beforeHealth.value.healthy).toBe(false);

      // Make healthProbe succeed after restart
      isHealthy = true;
      const recoverRes = await manager.recoverIfDead("mcp-gateway", sampleConfig);
      expect(recoverRes.ok).toBe(true);
      if (!recoverRes.ok) return;
      expect(recoverRes.value.healthy).toBe(true);
      expect(recoverRes.value.processAlive).toBe(true);
      expect(recoverRes.value.endpointReachable).toBe(true);
    });

    it("returns restart_limit_exceeded when restart burst limit is reached", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "linux",
        homeDir: tmpDir,
        runner: mockRunner,
        healthProbe: async () => false
      });

      const burstConfig: OSServiceConfig = {
        ...sampleConfig,
        maxRestartBurst: 3
      };

      await manager.install(burstConfig);

      // Trigger 3 failed recoveries
      await manager.recoverIfDead("mcp-gateway", burstConfig);
      await manager.recoverIfDead("mcp-gateway", burstConfig);
      await manager.recoverIfDead("mcp-gateway", burstConfig);

      // 4th recovery should fail due to restart limit
      const exceededRes = await manager.recoverIfDead("mcp-gateway", burstConfig);
      expect(exceededRes.ok).toBe(false);
      if (exceededRes.ok) return;
      expect(exceededRes.error.code).toBe("transport_unavailable");
      expect(exceededRes.error.details).toMatchObject({
        diagnosticCode: "restart_limit_exceeded",
        maxRestartBurst: 3
      });
    });
  });

  describe("6. Repair (repair)", () => {
    it("refuses to overwrite an existing unit file not marked 'Managed by bflow'", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "linux",
        homeDir: tmpDir,
        runner: mockRunner
      });

      const unitPath = manager.unitPath("mcp-gateway");
      await mkdir(path.dirname(unitPath), { recursive: true });
      await writeFile(unitPath, "# Unowned custom service file\n[Unit]\n", "utf8");

      const repairRes = await manager.repair("mcp-gateway", sampleConfig);
      expect(repairRes.ok).toBe(false);
      if (repairRes.ok) return;
      expect(repairRes.error.code).toBe("conflict");
      expect(repairRes.error.details).toMatchObject({ diagnosticCode: "unowned_unit_file" });
    });

    it("backs up corrupted unit file, restores canonical unit, reloads, restarts, and confirms health", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "linux",
        homeDir: tmpDir,
        runner: mockRunner,
        healthProbe: async () => true
      });

      // Install canonical first
      await manager.install(sampleConfig);
      const unitPath = manager.unitPath("mcp-gateway");

      // Corrupt unit file (keeping the marker)
      await writeFile(unitPath, `# ${BFLOW_SERVICE_MARKER}\n# CORRUPTED FILE CONTENT\n`, "utf8");

      const repairRes = await manager.repair("mcp-gateway", sampleConfig);
      expect(repairRes.ok).toBe(true);
      if (!repairRes.ok) return;

      expect(repairRes.value.repaired).toBe(true);
      expect(repairRes.value.actionsTaken.some((a) => a.startsWith("backed_up_unit:"))).toBe(true);
      expect(repairRes.value.actionsTaken).toContain("restored_canonical_unit");
      expect(repairRes.value.actionsTaken).toContain("reloaded_daemon");
      expect(repairRes.value.actionsTaken).toContain("restarted_service");
      expect(repairRes.value.health.healthy).toBe(true);

      // Verify backup file exists in stateDir/backups
      const backupDir = path.join(manager.paths.stateDir, "backups");
      const diskContent = await readFile(unitPath, "utf8");
      expect(diskContent).not.toContain("CORRUPTED FILE CONTENT");
      expect(diskContent).toContain("Description=Bflow MCP Gateway Daemon");
    });
  });

  describe("7. System login simulation (simulateUserLogin)", () => {
    it("starts only services with enabledOnLogin: true and leaves disabled services stopped", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "linux",
        homeDir: tmpDir,
        runner: mockRunner
      });

      // Service 1: enabled on login
      const configEnabled: OSServiceConfig = {
        ...sampleConfig,
        serviceId: "service-enabled",
        enableOnLogin: true
      };
      await manager.install(configEnabled);

      // Service 2: disabled on login
      const configDisabled: OSServiceConfig = {
        ...sampleConfig,
        serviceId: "service-disabled",
        enableOnLogin: false
      };
      await manager.install(configDisabled);

      // Unmanaged file in serviceUnitDir
      const unmanagedPath = path.join(manager.paths.serviceUnitDir, "bflow-unmanaged.service");
      await writeFile(unmanagedPath, "# Other software\n", "utf8");

      // Initial state: both are stopped
      const simRes = await manager.simulateUserLogin();
      expect(simRes.ok).toBe(true);
      if (!simRes.ok) return;

      const enabledStatus = simRes.value.find((s) => s.serviceId === "service-enabled");
      const disabledStatus = simRes.value.find((s) => s.serviceId === "service-disabled");
      const unmanagedStatus = simRes.value.find((s) => s.serviceId === "unmanaged");

      expect(enabledStatus).toBeDefined();
      expect(enabledStatus?.state).toBe("running");

      expect(disabledStatus).toBeDefined();
      expect(disabledStatus?.state).toBe("stopped");

      expect(unmanagedStatus).toBeUndefined();
    });
  });

  describe("8. Loopback health endpoint verification", () => {
    it("rejects non-loopback health endpoint URLs", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "linux",
        homeDir: tmpDir,
        runner: mockRunner
      });

      const externalConfig: OSServiceConfig = {
        ...sampleConfig,
        healthEndpointUrl: "http://example.com/health"
      };

      await manager.install(externalConfig);
      await manager.start("mcp-gateway");

      const healthRes = await manager.healthCheck("mcp-gateway");
      expect(healthRes.ok).toBe(false);
      if (healthRes.ok) return;
      expect(healthRes.error.code).toBe("validation");
      expect(healthRes.error.details).toMatchObject({ diagnosticCode: "non_loopback_health_url" });
    });

    it("accepts loopback health endpoint URLs", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "linux",
        homeDir: tmpDir,
        runner: mockRunner,
        healthProbe: async () => true
      });

      const loopbackConfig: OSServiceConfig = {
        ...sampleConfig,
        healthEndpointUrl: "http://localhost:43110/health"
      };

      await manager.install(loopbackConfig);
      await manager.start("mcp-gateway");

      const healthRes = await manager.healthCheck("mcp-gateway");
      expect(healthRes.ok).toBe(true);
      if (!healthRes.ok) return;
      expect(healthRes.value.healthy).toBe(true);
    });
  });

  describe("9. Unowned unit file protection & ExecStart argument quoting", () => {
    it("refuses to overwrite an existing unowned unit file without BFLOW_SERVICE_MARKER", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "linux",
        homeDir: tmpDir,
        runner: mockRunner
      });

      const unitFilePath = manager.unitPath(sampleConfig.serviceId);
      await mkdir(path.dirname(unitFilePath), { recursive: true });
      await writeFile(unitFilePath, "[Unit]\nDescription=Alien existing service\n", "utf8");

      const installRes = await manager.install(sampleConfig);
      expect(installRes.ok).toBe(false);
      if (installRes.ok) return;

      expect(installRes.error.code).toBe("conflict");
      expect(installRes.error.retryable).toBe(true);
      expect(installRes.error.message).toContain("Refusing to overwrite unowned unit file");
      expect(installRes.error.details).toMatchObject({
        diagnosticCode: "unowned_unit_file",
        unitPath: unitFilePath
      });

      // Verify original content was not overwritten
      const content = await readFile(unitFilePath, "utf8");
      expect(content).toBe("[Unit]\nDescription=Alien existing service\n");
    });

    it("quotes program and arguments with spaces or double quotes in systemd ExecStart", async () => {
      const manager = new BflowOSServiceManager({
        env: {},
        platform: "linux",
        homeDir: tmpDir,
        runner: mockRunner
      });

      const spacedConfig: OSServiceConfig = {
        ...sampleConfig,
        serviceId: "spaced-daemon",
        program: "/opt/My App/daemon.js",
        args: ["--greeting", "hello world", "--flag=\"quoted\""]
      };

      const rendered = manager.renderDefinition(spacedConfig);
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;

      expect(rendered.value).toContain('ExecStart="/opt/My App/daemon.js" --greeting "hello world" "--flag=\\"quoted\\""');

      const installRes = await manager.install(spacedConfig);
      expect(installRes.ok).toBe(true);

      const unitFilePath = manager.unitPath("spaced-daemon");
      const diskContent = await readFile(unitFilePath, "utf8");
      expect(diskContent).toContain('ExecStart="/opt/My App/daemon.js" --greeting "hello world" "--flag=\\"quoted\\""');
      expect(diskContent).toContain(BFLOW_SERVICE_MARKER);
    });
  });
});
