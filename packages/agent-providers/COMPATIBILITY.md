# Ma trận tương thích Provider (Platform v3)

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

Tài liệu này ghi lại các capability đã được audit, hành vi CLI quan sát được và các đảm bảo tích hợp cho những agent provider bên ngoài được đánh giá theo Bflow Platform v3 (P24/P25).

---

## 1. Phiên bản Provider quan sát được và trạng thái

| Provider | Phiên bản quan sát được | Đóng gói / Binary | Trạng thái trong Bflow v3 | Phiên bản tối thiểu đã test |
| --- | --- | --- | --- | --- |
| **Claude Code** | `2.1.301` | npm global / native binary (`claude`) | **Supported** (Preflight, Activated, Unattended w/ OS Sandbox) | `>= 2.0.0` |
| **Codex CLI** | `0.162.0` | native binary (`codex`) | **Supported** (Preflight, Activated, Unattended w/ OS Sandbox) | `>= 0.150.0` |
| **Antigravity CLI** | `1.4.0` | native binary (`agy`) | **Partial** (chỉ Preflight; Unattended và Activated chưa được chứng nhận) | `>= 1.0.0` |
| **Herdr Orchestrator** | `0.9.5` | native binary (`herdr`) | **Supported Transport Host** (Protocol 22) | `>= 0.9.0` |

---

## 2. Ma trận capability

| Capability | Claude Code (`2.1.301`) | Codex CLI (`0.162.0`) | Antigravity CLI (`1.4.0`) |
| --- | --- | --- | --- |
| **Preflight Health Probe** | `--version`, `--help`, `auth status --json`, `--print` | `--version`, `--help`, `login status`, `exec` | `--version`, `--help`, `models`, `--print` |
| **Restricted Mode (Read-Only)** | `--restricted`, `--tools Read,Glob,Grep`, `--permission-mode dontAsk` | `--no-daemon`, `--sandbox read-only`, `--ask-for-approval never` | `--sandbox`, `--mode plan`, `--disable-slash-commands` |
| **Workspace Auto Mode** | `--restricted`, `--tools Read,Glob,Grep,Edit,Write`, `--permission-mode dontAsk` | `--no-daemon`, `--sandbox workspace-write`, `--ask-for-approval never` | `--sandbox`, `--mode accept-edits`, `--disable-slash-commands` |
| **Unattended Mode** | Hỗ trợ với OS sandbox (`/usr/bin/bwrap`) | Hỗ trợ với OS sandbox (`/usr/bin/bwrap`) | **Không hỗ trợ** (`agy_unattended_unsupported`) |
| **Additional Roots (`--add-dir`)** | Hỗ trợ qua `--add-dir` | Hỗ trợ qua `--add-dir` | Hỗ trợ qua `--add-dir` |
| **MCP Transports** | `stdio`, `streamable_http` qua `--mcp-config` | `stdio`, `streamable_http` qua `-c mcp_servers=...` | `stdio`, `streamable_http` qua `AGY_CONFIG_DIR` / `settings.json` |
| **Native Session Hooks** | Hỗ trợ qua `--settings` (hook `SessionStart`) | Hỗ trợ qua `--enable hooks -c hooks=...` | **Chưa chứng nhận** trong Bflow host |
| **Startup Attestation** | Attestation ký Ed25519 (`AgentLaunchAttestation`) | Attestation ký Ed25519 (`AgentLaunchAttestation`) | **Chưa chứng nhận** trong Bflow host |
| **Permission Bypass Flag Policy** | Được phát hiện trong `--help`; **bị buộc tắt / cấm** | Từ chối `danger-full-access` và các cờ bypass | Được phát hiện trong `--help`; **bị buộc tắt / cấm** |

---

## 3. Chi tiết Provider và phân tích tích hợp

### 3.1. Claude Code (`claude`)

- **Authentication và Readiness**:
  - `claude auth status --json` trả về JSON có cấu trúc `{ authenticated: boolean, status: string, email: string }`.
  - Probe không tương tác: `claude --print --permission-mode dontAsk "ping"`.
- **Thực thi permission**:
  - Permission mode `dontAsk` đảm bảo các thao tác không được phép thất bại một cách xác định thay vì hiện prompt terminal tương tác gây chặn.
  - Bảo vệ file chi tiết: `--disallowedTools` bảo vệ tường minh `./.bflow/**`, `./.git/**` và các thư mục credential của host (`~/.ssh`, `~/.aws`, `~/.claude`).
  - Câu hỏi native cho người dùng: `AskUserQuestion` bị chặn với mọi role không phải Conversation.

### 3.2. Codex CLI (`codex`)

- **Tách biệt Approval Policy và Sandbox**:
  - Codex phân biệt rõ approval prompt (`--ask-for-approval never`) với OS filesystem sandbox (`--sandbox read-only` hoặc `--sandbox workspace-write`).
  - Bflow không bao giờ chọn `danger-full-access` hay `--dangerously-bypass-approvals-and-sandbox`.
- **Nạp instruction**:
  - Instruction được nạp từ một file cục bộ theo launch qua `-c model_instructions_file="..."` để tránh giới hạn kích thước dòng lệnh của shell.
- **Network Egress**:
  - Khi `network.mode === "deny"`, web search bị tắt qua `-c web_search="disabled"`.

### 3.3. Antigravity CLI (`agy`)

- **Discovery và Permissions**:
  - `--sandbox`, `--mode plan|accept-edits` và `--disable-slash-commands` cung cấp phạm vi workspace cục bộ.
  - File `<role>.settings.json` cục bộ theo launch ghi `permissions.allow`, `permissions.deny` và `workspaceTrust.trustedFolders`.
  - Không truyền các cờ CLI `--mcp-config` chưa được xác minh trừ khi phát hiện được qua `--help`; cấu hình MCP được ghi vào `<role>.mcp-config.json` và tham chiếu trong `AGY_CONFIG_DIR` / `settings.json`.
  - Kiểm tra auth chạy `agy models`, sau đó `agy --print "ping"`.
- **Hạn chế và capability chưa chứng nhận**:
  - Cô lập container unattended toàn tiến trình chưa được xác minh. Yêu cầu `unattended_isolated` trả về health `status: "unsupported"` (`code: "agy_unattended_unsupported"`).
  - Native startup session binding chưa được chứng nhận cho Attestation tự động. Giai đoạn Activated báo `native_binding_unsupported`.

### 3.4. Herdr Process Host (`herdr`)

- **Giao thức gọi**:
  ```bash
  herdr agent start <name> --kind <provider> --pane <paneId> [--timeout <ms>] -- <argv...>
  ```
- **Đảm bảo**:
  - Dùng `--` để tách an toàn các cờ Herdr khỏi các cờ provider.
  - Argument nhiều dòng, byte NUL và token bí mật dạng thô bị validate nghiêm ngặt và bị từ chối trước khi thực thi.
  - Vòng đời tiến trình và việc gắn pane vẫn do Herdr sở hữu.
