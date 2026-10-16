# Provider Compatibility Matrix (Platform v3)

This document records the audited capabilities, observed CLI behavior, and integration guarantees for external agent providers evaluated under Bflow Platform v3 (P24/P25).

---

## 1. Observed Provider Versions & Status

| Provider | Observed Version | Packaging / Binary | Status in Bflow v3 | Minimum Tested |
| --- | --- | --- | --- | --- |
| **Claude Code** | `2.1.301` | npm global / native binary (`claude`) | **Supported** (Preflight, Activated, Unattended w/ OS Sandbox) | `>= 2.0.0` |
| **Codex CLI** | `0.162.0` | native binary (`codex`) | **Supported** (Preflight, Activated, Unattended w/ OS Sandbox) | `>= 0.150.0` |
| **Antigravity CLI** | `1.4.0` | native binary (`agy`) | **Partial** (Preflight only; Unattended & Activated Uncertified) | `>= 1.0.0` |
| **Herdr Orchestrator** | `0.9.5` | native binary (`herdr`) | **Supported Transport Host** (Protocol 22) | `>= 0.9.0` |

---

## 2. Capability Matrix

| Capability | Claude Code (`2.1.301`) | Codex CLI (`0.162.0`) | Antigravity CLI (`1.4.0`) |
| --- | --- | --- | --- |
| **Preflight Health Probe** | `--version`, `--help`, `auth status --json`, `--print` | `--version`, `--help`, `login status`, `exec` | `--version`, `--help`, `models`, `--print` |
| **Restricted Mode (Read-Only)** | `--restricted`, `--tools Read,Glob,Grep`, `--permission-mode dontAsk` | `--no-daemon`, `--sandbox read-only`, `--ask-for-approval never` | `--sandbox`, `--mode plan`, `--disable-slash-commands` |
| **Workspace Auto Mode** | `--restricted`, `--tools Read,Glob,Grep,Edit,Write`, `--permission-mode dontAsk` | `--no-daemon`, `--sandbox workspace-write`, `--ask-for-approval never` | `--sandbox`, `--mode accept-edits`, `--disable-slash-commands` |
| **Unattended Mode** | Supported with OS sandbox (`/usr/bin/bwrap`) | Supported with OS sandbox (`/usr/bin/bwrap`) | **Unsupported** (`agy_unattended_unsupported`) |
| **Additional Roots (`--add-dir`)** | Supported via `--add-dir` | Supported via `--add-dir` | Supported via `--add-dir` |
| **MCP Transports** | `stdio`, `streamable_http` via `--mcp-config` | `stdio`, `streamable_http` via `-c mcp_servers=...` | `stdio`, `streamable_http` via `AGY_CONFIG_DIR` / `settings.json` |
| **Native Session Hooks** | Supported via `--settings` (`SessionStart` hook) | Supported via `--enable hooks -c hooks=...` | **Uncertified** in Bflow host |
| **Startup Attestation** | Ed25519 signed attestation (`AgentLaunchAttestation`) | Ed25519 signed attestation (`AgentLaunchAttestation`) | **Uncertified** in Bflow host |
| **Permission Bypass Flag Policy** | Detected in `--help`; **Forced disabled / forbidden** | Refuses `danger-full-access` and bypass flags | Detected in `--help`; **Forced disabled / forbidden** |

---

## 3. Provider Details & Integration Analysis

### 3.1. Claude Code (`claude`)

- **Authentication & Readiness**:
  - `claude auth status --json` returns structured JSON with `{ authenticated: boolean, status: string, email: string }`.
  - Non-interactive probe: `claude --print --permission-mode dontAsk "ping"`.
- **Permission Enforcement**:
  - `dontAsk` permission mode ensures unauthorized operations fail deterministically instead of presenting blocking interactive terminal prompts.
  - Granular file protection: `--disallowedTools` explicitly protects `./.bflow/**`, `./.git/**`, and host credential directories (`~/.ssh`, `~/.aws`, `~/.claude`).
  - Native user questions: `AskUserQuestion` is blocked for all non-Conversation roles.

### 3.2. Codex CLI (`codex`)

- **Approval Policy vs. Sandbox Separation**:
  - Codex strictly distinguishes between approval prompts (`--ask-for-approval never`) and the OS filesystem sandbox (`--sandbox read-only` or `--sandbox workspace-write`).
  - Bflow never selects `danger-full-access` or `--dangerously-bypass-approvals-and-sandbox`.
- **Instruction Loading**:
  - Instructions are loaded from a launch-local file via `-c model_instructions_file="..."` to avoid shell command-line size limits.
- **Network Egress**:
  - When `network.mode === "deny"`, web search is disabled via `-c web_search="disabled"`.

### 3.3. Antigravity CLI (`agy`)

- **Discovery & Permissions**:
  - `--sandbox`, `--mode plan|accept-edits`, and `--disable-slash-commands` provide local workspace scoping.
  - Launch-local `<role>.settings.json` writes `permissions.allow`, `permissions.deny`, and `workspaceTrust.trustedFolders`.
  - Does not pass unverified `--mcp-config` CLI flags unless detected via `--help`; MCP config is written to `<role>.mcp-config.json` and referenced in `AGY_CONFIG_DIR` / `settings.json`.
  - Auth check runs `agy models`, followed by `agy --print "ping"`.
- **Limitations & Uncertified Capabilities**:
  - Full-process unattended container isolation is not yet verified. Requesting `unattended_isolated` returns health `status: "unsupported"` (`code: "agy_unattended_unsupported"`).
  - Native startup session binding is uncertified for automated Attestation. Activated stage reports `native_binding_unsupported`.

### 3.4. Herdr Process Host (`herdr`)

- **Invocation Protocol**:
  ```bash
  herdr agent start <name> --kind <provider> --pane <paneId> [--timeout <ms>] -- <argv...>
  ```
- **Guarantees**:
  - Uses `--` to safely separate Herdr flags from provider flags.
  - Multiline arguments, NUL bytes, and raw secret tokens are strictly validated and rejected before execution.
  - Process lifecycle and pane attachment remain owned by Herdr.
