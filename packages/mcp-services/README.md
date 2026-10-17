# @bflow/mcp-services

OS-level service orchestration, backend resource pooling, and isolated browser runtime management for the Model Context Protocol (MCP) in the Bflow Agentic SDLC platform.

## Package Status

- **Platform Version**: Version 3 (`CURRENT_PLATFORM_SCHEMA_VERSION = 3`)
- **Protocol Baseline**: Model Context Protocol Specification `2025-11-25`
- **Package Type**: ESM (`type: module`)
- **Verification Status**: 4 unit and integration test suites covering OS service lifecycle, resource management, dedicated browser runtime, and all 11 mandatory end-to-end scenarios.

---

## Architectural Purpose & Boundary Invariants

`@bflow/mcp-services` provides the host-level operating system abstraction layer for Bflow's shared MCP ecosystem. It manages background OS daemon lifecycles, throttles and balances process memory and concurrency across MCP backends, and provisions dedicated, secure Chrome/Chromium browser runtimes for agent automation.

```
+-----------------------------------------------------------------------------------+
|                              Bflow MCP Gateway (P27)                              |
+-----------------------------------------------------------------------------------+
                                       |
    +----------------------------------+----------------------------------+
    |                                  |                                  |
    v                                  v                                  v
+-----------------------+  +-----------------------+  +-----------------------+
| BflowOSServiceManager |  | BackendResourceManager|  |DedicatedBrowserRuntime|
| - systemd --user      |  | - Lazy / Eager startup|  | - Dedicated profiles  |
| - launchd gui/<uid>   |  | - Idle sweep & timers |  | - Loopback debugging  |
| - Windows schtasks    |  | - Memory RSS tracking |  | - Page ownership gate |
| - Non-root execution  |  | - Process pooling     |  | - Crash auto-recovery |
| - Self-healing repair |  | - Multi-client sharing|  | - Multi-agent context |
+-----------------------+  +-----------------------+  +-----------------------+
    |                                  |                                  |
    +----------------------------------+----------------------------------+
                                       |
                                       v
                    +-------------------------------------+
                    |            os-paths.ts              |
                    | - XDG / AppSupport / LocalAppData   |
                    | - Strict repo isolation guard       |
                    | - Personal browser profile firewall |
                    +-------------------------------------+
```

### Boundary Invariants

> [!IMPORTANT]
> **No Root / Administrator Privileges Required**:
> All background services, processes, and units operate strictly within the unprivileged user session:
> - Linux: `systemd --user`
> - macOS: `launchd` in user domain `gui/<uid>`
> - Windows: Scheduled Tasks (`schtasks`) running with `LogonType: InteractiveToken` and `RunLevel: LeastPrivilege`.
>
> Privilege escalation binaries (`sudo`, `su`, `doas`, `pkexec`, `runas`) are strictly denylisted and rejected by input validation.

> [!IMPORTANT]
> **Loopback-Only Network Bindings**:
> All service health probes, gateway listeners, and Chrome DevTools remote debugging endpoints bind exclusively to loopback addresses (`127.0.0.1`, `localhost`, `[::1]`). Binding to external interfaces (`0.0.0.0`, LAN, or public IP addresses) is rejected with `non_loopback_forbidden`.

> [!IMPORTANT]
> **OS-Standard Paths Outside Repositories**:
> Service configuration units, persistent logs, state files, and browser user data directories are resolved exclusively in standard OS user locations:
> - Linux: `$XDG_CONFIG_HOME/bflow`, `$XDG_DATA_HOME/bflow`, `$XDG_STATE_HOME/bflow`
> - macOS: `~/Library/Application Support/bflow`, `~/Library/Logs/bflow`
> - Windows: `%LOCALAPPDATA%\bflow`, `%APPDATA%\bflow`
>
> Placing browser profiles or service units inside any Git repository or workspace root is rejected with `repository_profile_forbidden`. Collision with personal browser directories is prevented by a strict path firewall (`personal_profile_forbidden`).

> [!NOTE]
> **Contract Stability**:
> `@bflow/mcp-services` adheres strictly to `@bflow/contracts` version 3 without modifying shared contract signatures.

---

## Core Modules

### 1. OS Service Manager (`BflowOSServiceManager`)
Handles native background service registration, lifecycle control, logging, and self-healing:
- **Multi-OS Native Units**: Generates and installs unit files with the immutable ownership marker `# Managed by bflow`:
  - Linux: `systemd` user service units (`~/.config/systemd/user/bflow-<serviceId>.service`)
  - macOS: `launchd` user agents (`~/Library/LaunchAgents/dev.bflow.<serviceId>.plist`)
  - Windows: Scheduled Tasks (`\Bflow\bflow-<serviceId>`) with Logon Trigger and Startup folder `.cmd` hook.
- **Self-Healing & Auto-Recovery (`recoverIfDead`)**: Continuously monitors service liveness and loopback HTTP `/health` endpoints. Restarts dead services and bounds restart bursts (`maxRestartBurst`) to prevent crash loops.
- **Tamper Protection & Repair (`repair`)**: Validates unit file digest against canonical configuration. Protects unowned units (`unowned_unit_file`) and automatically creates timestamped backups before updating modified bflow units.
- **Logon Simulation (`simulateUserLogin`)**: Discovers installed services enabled for user login and launches them on startup.

### 2. Backend Resource Manager (`BackendResourceManager`)
Implements `MCPServiceManager` to supervise backend tool drivers:
- **Lazy vs Eager Startup**: Eager backends start upon session initialization, while heavy lazy backends (such as `chrome-devtools-mcp` or `gitnexus`) consume zero RAM and zero process handles until first agent tool demand.
- **Multi-Client Connection Multiplexing**: Concurrent agents (`claude`, `codex`, `agy`) connect to a shared backend partition without duplicating OS processes.
- **Active Client Protection**: Backend release and idle sweep mechanisms reject stopping backends while active client connections, in-flight calls, or uncertain mutations awaiting reconciliation exist (`retained_active_clients`, `retained_active_calls`, `retained_for_reconciliation`).
- **Idle Sweep Grace Windows (`idleTimeoutMs`)**: Keeps backends warm during short task intervals, reconnecting returning agents instantly, and stops backends once idle timeouts expire (`stopped_idle`).
- **Process & Memory Quotas**: Enforces maximum process counts (`maxProcessCount`) and total memory RSS limits (`maxTotalMemoryBytes`), automatically evicting unallocated idle backends under system pressure.

### 3. Dedicated Browser Runtime (`DedicatedBrowserRuntime`)
Orchestrates isolated headless Chrome/Chromium sessions for agents:
- **OS-Standard Profile Trees**: Generates deterministic, filesystem-safe user data directories outside repositories and separate from personal Chrome profiles.
- **Exclusive Profile Locking**: Manages atomic `.bflow-profile.lock` and detects Chrome native `SingletonLock` / `SingletonSocket`. Automatically identifies dead PIDs and cleans up stale locks.
- **Multi-Agent Page & Context Isolation**:
  - In `browser_context` mode, shares a single Chrome process across agents while creating isolated browser contexts and separate cookie stores per agent task.
  - In `separate_process` mode (or when Chrome does not support browser contexts), provisions dedicated Chrome instances with independent user profiles.
- **Page Ownership Gate**: Every navigation, content access, cookie mutation, or page closure operation is gated by `BrowserCallerIdentity` (`registrationId`, `runId`, `taskId`, `scope`). Unauthorized cross-agent access is blocked with `page_ownership_conflict`.
- **Crash Recovery (`reconnectAfterCrash`)**: Detects process termination (`browser_crashed`), purges stale PID lock files, re-launches Chrome on loopback, and restores the debugging session up to `maxReconnectAttempts`.
- **Immediate Task Cleanup (`cleanupTask`)**: Cleans up all open pages, browser contexts, and dedicated instances immediately upon task completion, freeing memory instantly.

---

## API Reference

### Exported Classes

| Class | Source | Purpose |
| --- | --- | --- |
| `BflowOSServiceManager` | `src/os-service-manager.ts` | Installs, starts, monitors, and repairs native OS user-level services. |
| `SafeOSCommandRunner` | `src/os-service-manager.ts` | Executes non-root shell-less subprocess commands with timeout protection. |
| `BackendResourceManager` | `src/resource-manager.ts` | Supervises MCP driver partitions, memory sampling, process quotas, and sweeps. |
| `DedicatedBrowserRuntime` | `src/browser-runtime.ts` | Manages dedicated Chrome profiles, page ownership, cookie stores, and crash recovery. |
| `DefaultBrowserLauncher` | `src/browser-runtime.ts` | Probes and spawns local Chrome/Chromium binaries with loopback debugging. |

### Exported Utility Functions

| Function | Source | Description |
| --- | --- | --- |
| `resolveBflowOSPaths(options)` | `src/os-paths.ts` | Returns standard config, data, log, and profile paths for Linux, macOS, and Windows. |
| `validateBrowserProfileDirectory(options)` | `src/os-paths.ts` | Ensures profile path is absolute, outside repos, and not in personal Chrome dirs. |
| `resolveDedicatedProfileDir(root, scope)` | `src/os-paths.ts` | Computes deterministic directory path for a given `TrustScope`. |
| `validateLoopbackDebuggingHost(host)` | `src/os-paths.ts` | Ensures host is strictly `127.0.0.1`, `localhost`, or `[::1]`. |
| `validateNoRootCommand(argv)` | `src/os-service-manager.ts` | Guards command arguments against privilege escalation binaries and control characters. |
| `defaultIsPidAlive(pid)` | `src/browser-runtime.ts` | Checks if a given process ID is actively running on the OS. |
| `scopeToKey(scope)` | `src/browser-runtime.ts` | Generates a canonical string key for a `TrustScope`. |
| `isSameScope(a, b)` | `src/browser-runtime.ts` | Compares whether two `TrustScope` instances represent the identical boundary. |

---

## Runnable Test Commands

From repository root:

```bash
# Run all tests in @bflow/mcp-services
pnpm --filter @bflow/mcp-services test

# Run TypeScript compilation and type checking
pnpm --filter @bflow/mcp-services run build
pnpm --filter @bflow/mcp-services run typecheck

# Run specific test suites
pnpm --filter @bflow/mcp-services test packages/mcp-services/test/os-service-manager.test.ts
pnpm --filter @bflow/mcp-services test packages/mcp-services/test/resource-manager.test.ts
pnpm --filter @bflow/mcp-services test packages/mcp-services/test/browser-runtime.test.ts
pnpm --filter @bflow/mcp-services test packages/mcp-services/test/integration-scenarios.test.ts
```

For complete deployment, configuration, troubleshooting, and tuning instructions, refer to [OPERATIONS.md](OPERATIONS.md).
