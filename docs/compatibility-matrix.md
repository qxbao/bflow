# Bflow Platform v3 — Compatibility Matrix

Tài liệu này quy định ma trận tương thích chính thức của Bflow Platform v3 đối với Hệ điều hành, Hệ tệp, Agent Providers (`claude`, `codex`, `agy`), MCP Transports, Công cụ phụ trợ và Test Runners, kèm phân biệt rõ ràng giữa **Đã xác minh thực tế (Live Verified)**, **Đã xác minh qua Harness/Contract (Harness Verified)** và **Thiết kế / Chưa hỗ trợ (Designed / Unsupported)**.

---

## 1. Tương thích Hệ điều hành & Hệ tệp (OS & Filesystem Matrix)

| Hệ điều hành / Nền tảng | Quản lý dịch vụ nền (OS Service) | Behavioral Test Sandbox | Trạng thái hỗ trợ | Mức bằng chứng |
| :--- | :--- | :--- | :--- | :--- |
| **Linux `x86_64` (POSIX `ext4` / `xfs` / `tmpfs`)** | `systemd --user` (`bflow-mcp-gateway.service`, đã kiểm tra bằng `systemd-analyze verify`) | `/usr/bin/bwrap` (Bubblewrap filesystem + PID + network namespaces) | **Supported (Chính thức)** | **Live Verified** (Full unit, integration, E2E & live binary probes) |
| **Linux trên phân vùng `fuseblk` / NTFS / exFAT** | Không áp dụng cho thư mục state | Không hỗ trợ lưu khóa/state do `chmod 0600` trả `0777` (`RR-26`) | **Unsupported cho Runtime State** (Phải dùng worktree/state trên POSIX FS) | **Live Verified (Fail-Closed)** |
| **macOS (`darwin` `arm64` / `x86_64`, APFS)** | `launchd` (`~/Library/LaunchAgents/dev.bflow.mcp-gateway.plist`) | Chưa có tương đương Bubblewrap (cần cấu hình runner phù hợp) | **Supported (Setup / CLI / MCP Adapter)** | **Harness Verified** (Unit tests với mock runner; chưa chạy trên máy Mac vật lý trong đợt này) |
| **Windows (`win32`)** | Thiết kế cho Task Scheduler / Registry PATH | Không hỗ trợ Bubblewrap | **`designed_unverified` (Blocked)** | **Harness Verified** (Mọi bước ghi thay đổi hệ thống tự động trả `status: "blocked"`) |

---

## 2. Tương thích Agent Providers (`claude`, `codex`, `agy`)

| Khía cạnh kỹ thuật | `claude` (Claude Code) | `codex` (OpenAI Codex CLI) | `agy` (Google Antigravity CLI) |
| :--- | :--- | :--- | :--- |
| **Phiên bản tối thiểu (`minVersion`)** | `>= 2.0.0` | `>= 0.150.0` | `>= 1.0.0` |
| **Phiên bản đã xác minh thực tế** | `2.1.301`, `2.1.302` | `0.162.0`, `0.163.0` | `1.4.0` |
| **Giới hạn kích thước binary tối đa** | `<= 512 MiB` (`225,0 MiB` thực tế) | `<= 512 MiB` (`280,8 MiB` thực tế — `QA-P34-03`) | `<= 512 MiB` (wrapper script + runtime) |
| **Lệnh kiểm tra đăng nhập (`getAuthCommand`)** | `claude auth status --json` | `codex login status` | `agy models` |
| **Lệnh thăm dò thực thi (`getProbeCommand`)** | `claude --print [--model <m>] ping` | `codex exec [--model <m>] ping` | `agy [--model <m>] --print ping` (`QA-P34-04`) |
| **Chế độ quyền `restricted`** | `--permission-mode dontAsk --tools Read,Glob,Grep` | `--no-daemon --sandbox read-only --ask-for-approval never` | `--sandbox --mode plan --disable-slash-commands` |
| **Chế độ quyền `workspace_auto`** | `--permission-mode dontAsk --tools Read,Glob,Grep,Edit,Write --add-dir <cwd>` | `--no-daemon --sandbox workspace-write --ask-for-approval never --add-dir <cwd>` | `--sandbox --mode accept-edits --disable-slash-commands` |
| **Chế độ quyền `unattended_isolated`** | **Supported** (Bắt buộc có OS sandbox `/usr/bin/bwrap` + `--dangerously-skip-permissions`) | **Supported** (Bắt buộc có OS sandbox `/usr/bin/bwrap` + `--dangerously-bypass-approvals-and-sandbox`) | **Unsupported (`agy_unattended_unsupported`)** — Fail-closed theo thiết kế |
| **Cấu hình Trusted Workspace** | `--add-dir <cwd>` + `<role>.settings.json` (`0o600`) | `--add-dir <cwd>` | Tạo `<stateDir>/agy-home/.gemini/antigravity-cli/settings.json` (`0o600`) với `trustedWorkspaces` (`QA-P34-06`) |
| **Kết nối MCP (`stdio` & `streamable_http`)** | `--mcp-config <file> --strict-mcp-config`; HTTP header `Authorization: Bearer ${BFLOW_MCP_TOKEN_*}` | `-c mcp_servers.<id>=...`; HTTP `bearer_token_env_var = "BFLOW_MCP_TOKEN_*"` | `--mcp-config <file>` (`stdio` & `streamable_http`) |
| **Cô lập cấu hình toàn cục (Global Config Isolation)** | `--setting-sources project,local --settings <file> --strict-mcp-config` | Tự động tắt `[mcp_servers.<name>]` trong `~/.codex/config.toml`; **Fail-closed** nếu có `~/.codex/hooks.json` (`6d1e819`, `1bcecad`) | Dùng `HOME=<stateDir>/agy-home` cô lập kèm symlink thông tin đăng nhập |
| **Bằng chứng khởi động & Reachability (`P30`)** | Hook `SessionStart` + MCP bootstrap (`provider_bootstrap`) | MCP bootstrap (`provider_bootstrap`, do hook `SessionStart` của Codex không nổ lúc startup — `9595d02`) | Preflight & Launch Profile ready; `activated` native session binding báo `unsupported` (`native_binding_unsupported`) |

---

## 3. Tương thích Orchestrator, MCP Services & Công cụ phụ trợ

| Công cụ / Dịch vụ | Phiên bản đã xác minh | Giao thức / Cơ chế tích hợp | Trạng thái & Lưu ý tương thích |
| :--- | :--- | :--- | :--- |
| **Herdr Orchestrator** | `herdr 0.9.5` | Protocol `22` / Schema `1` (CLI + Unix Domain Socket API) | **Live Verified**: Kiểm tra theo hành vi giao thức (`protocol === 22`), không khóa cứng theo chuỗi phiên bản. Truyền biến môi trường lúc tạo pane qua socket (`workspace.create`, `tab.create`, `pane.split`). |
| **Bflow Shared MCP Gateway** | `0.1.0` (`@bflow/mcp-gateway`) | Streamable HTTP (`127.0.0.1:<port>/mcp`, JSON-RPC `2.0`, MCP `2024-11-05` / `2025-11-25`) + `StdioBridge` | **Live Verified**: Phục vụ đồng thời nhiều providers, trả đầy đủ `inputSchema` chuẩn MCP trong `tools/list` (`3a9f461`). |
| **RTK (Rust Token Killer)** | `0.42.4` / `0.50.0` | CLI wrapper & `rtk proxy` | **Live Verified**: Hỗ trợ lọc token cho `claude`, `codex`, `agy` và chạy lệnh thô qua `rtk proxy`. |
| **GitNexus** | `1.6.12` | `gitnexus status --json`, `gitnexus analyze`, `gitnexus mcp` (stdio MCP) | **Live Verified**: Chấp nhận các trạng thái `up-to-date`, `registered`, `stale` (`QA-P34-08`); tự động hoãn đánh chỉ mục trên repository Git chưa có commit đầu tiên (`a022edf`). |
| **Claude-Mem** | `12.1.3` | Loopback HTTP (`127.0.0.1:37777`) + `worker-service.cjs --mcp` / `memory-mcp.js` | **Live Verified**: Nhận diện worker sẵn có (`adopted`) hoặc khởi chạy qua stdio MCP; lọc nghiêm ngặt theo `project` (`ClaudeMemProjectReader`); hoãn cài native plugin nếu provider chưa login (`a022edf`). |
| **Google Chrome / DevTools MCP** | `146.0.7680.80` | `--user-data-dir=<stateRoot>/chrome/<repoId>/<taskId>` (`0o700`) + Loopback CDP | **Live Verified (Binary + Runtime)**: Cô lập profile theo từng task, chặn `SingletonLock` và chặn điều hướng chéo task (`page_ownership_conflict`). |
| **Superpowers & Role Skills** | Catalog v3 (`32` skills) | `skills/**` + `@bflow/skills` (`SkillManifest` v3) | **Live Verified**: Đồng bộ nhất quán cho toàn bộ 10 roles $\times$ 3 providers với kiểm tra SHA-256 digest. |

---

## 4. Tương thích Behavioral Test Runners (`@bflow/runtime` & `@bflow/verification`)

| Test Runner | Phiên bản / Định dạng | Yêu cầu môi trường | Trạng thái hỗ trợ |
| :--- | :--- | :--- | :--- |
| **Node.js Built-in Test Runner (`node_tap`)** | Node.js `>= 22` flat TAP output | Linux + `/usr/bin/bwrap` + canonical `node_modules` | **Live Verified** (Đo độc lập Red/Green/Refactor trên detached commit) |
| **Vitest JSON Runner (`vitest_json`)** | Vitest `2.1.x` JSON reporter + trusted runtime-error companion | Linux + `/usr/bin/bwrap` + canonical `node_modules` | **Live Verified** (Đo độc lập Red/Green/Refactor trên detached commit) |
| **Custom / Mixed Manual-Automated Runners** | Coverage thresholds, symlinks ra ngoài workspace, tự động `npm install`/build trong runner | — | **Unsupported (`RR-22`, `RR-23`)** — Bị từ chối trước khi chạy workflow để bảo toàn tính tất định của sandbox |
