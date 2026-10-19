# Bflow Platform v3 — Setup & Onboarding Guide

Tài liệu này hướng dẫn cài đặt, thiết lập cấp máy (`bflow setup`), khởi tạo dự án (`bflow init`) và kiểm tra tính sẵn sàng (`bflow doctor`, `bflow agent check`) cho Bflow Platform v3.

---

## 1. Yêu cầu hệ thống (Prerequisites)

### 1.1 Hệ điều hành và Hệ tệp (Filesystem)

- **Hệ điều hành đã xác minh đầy đủ**: **Linux `x86_64`** với `systemd --user` và Linux namespaces (`/usr/bin/bwrap` — Bubblewrap).
- **Hệ điều hành hỗ trợ mức thiết kế/adapter**:
  - **macOS (`darwin`)**: Hỗ trợ quản lý dịch vụ qua `launchd` (`~/Library/LaunchAgents`), chưa hỗ trợ Bubblewrap behavioral test sandbox (chỉ khả dụng trên Linux).
  - **Windows (`win32`)**: Ở trạng thái `designed_unverified` — các bước ghi thay đổi hệ thống sẽ bị chặn an toàn (`blocked`) cho tới khi được chứng nhận trên host Windows thực.
- **Yêu cầu bắt buộc về Hệ tệp POSIX**:
  - Repository làm việc và các thư mục trạng thái (`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `TMPDIR`) **phải nằm trên hệ tệp POSIX thực** (`ext4`, `xfs`, `btrfs`, `apfs`, `tmpfs`) hỗ trợ phân quyền `chmod 0700` / `0600` và đúng UID của người dùng hiện tại.
  - **Không đặt trạng thái runtime trên phân vùng `fuseblk` / NTFS / exFAT mount qua FUSE** (nơi mọi file luôn mang mode `0777` hoặc `root:root`), vì Bflow sẽ từ chối khởi chạy để bảo vệ khóa ký Ed25519 và Bearer token.
  - **Giới hạn độ dài đường dẫn Unix Domain Socket**: Đặt `TMPDIR=/tmp` và `XDG_RUNTIME_DIR` ngắn gọn để tổng độ dài đường dẫn socket không vượt quá giới hạn `sockaddr_un.sun_path` (`108` bytes trên Linux).

### 1.2 Công cụ nền tảng cần có

| Thành phần | Phiên bản tối thiểu | Phiên bản đã xác minh thực tế | Lệnh kiểm tra |
| :--- | :--- | :--- | :--- |
| **Node.js** | `>= 22.0.0` | `v24.16.0` | `node --version` |
| **pnpm** | `>= 9.0.0` | `12.5.1` | `pnpm --version` |
| **Git** | `>= 2.38.0` | `2.43.0` | `git --version` |
| **Herdr CLI** | Protocol `22` / Schema `1` | `herdr 0.9.5` | `herdr --version` |
| **Bubblewrap** *(Linux)* | `>= 0.8.0` | `0.9.0` | `bwrap --version` |

### 1.3 Agent Provider CLIs (cần ít nhất 1 provider đã đăng nhập)

| Provider ID | Tên CLI | Phiên bản tối thiểu | Phiên bản đã xác minh | Lệnh đăng nhập / kiểm tra |
| :--- | :--- | :--- | :--- | :--- |
| `claude` | Claude Code | `>= 2.0.0` | `2.1.301` / `2.1.302` | `claude auth login` / `claude auth status` |
| `codex` | OpenAI Codex CLI | `>= 0.150.0` | `0.162.0` / `0.163.0` | `codex login` / `codex login status` |
| `agy` | Google Antigravity CLI | `>= 1.0.0` | `1.4.0` | `agy models` |

> **Lưu ý quan trọng cho người dùng `codex`**: Bflow tự động vô hiệu hóa các MCP server toàn cục khai báo theo bảng `[mcp_servers.<name>]` trong `~/.codex/config.toml` khi khởi chạy từng role (`-c mcp_servers.<name>.enabled=false`). Nếu máy của bạn có cấu hình **Codex hooks toàn cục** (`~/.codex/hooks.json`), `CodexProviderAdapter` mặc định sẽ **fail-closed** (`codex_global_hooks_not_isolated`) cho tới khi bạn rà soát và phê duyệt tường minh bản chụp SHA-256 của các hook đó bằng lệnh:
> ```bash
> bflow setup --codex-hooks --plan
> bflow setup --codex-hooks --apply
> ```

---

## 2. Build từ mã nguồn (Source Build)

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm check:deps
pnpm typecheck
```

---

## 3. Thiết lập cấp máy (`bflow setup`)

Bflow tách biệt rõ ràng **thiết lập cấp máy (`bflow setup`)** với **khởi chạy phiên dự án (`bflow up`)**. Lệnh `bflow up` **không bao giờ** tự ý tải công cụ hay sửa cấu hình toàn cục của người dùng.

### 3.1 Kiểm tra trạng thái hiện tại (Read-only Check)

```bash
bflow setup --check
# Hoặc xuất JSON:
bflow setup --check --json
```

Chế độ `--check` và `--dry-run` hoàn toàn không ghi xuống đĩa.

### 3.2 Thực thi thiết lập (`apply`)

```bash
# Chạy tương tác (hiển thị kế hoạch và xin xác nhận):
bflow setup

# Hoặc tự động xác nhận cho môi trường CI / tự động hóa:
bflow setup --yes
```

Khi chạy `bflow setup`, hệ thống thực hiện theo đúng thứ tự phụ thuộc (idempotent):
1. Tạo các thư mục trạng thái, cấu hình, dữ liệu và `skills-store` với quyền riêng tư `0700`.
2. Cài đặt và kiểm tra SHA-256 cho **32 builtin skills** vào kho lưu trữ bất biến (`skills-store`).
3. Khởi tạo cấu hình Shared MCP Gateway (`mcp-config`) và đăng ký dịch vụ nền cấp người dùng (`bflow-mcp-gateway.service` trên `systemd --user` hoặc `launchd` agent trên macOS) kèm dấu sở hữu `.bflow-owner`.
4. Cập nhật khối `PATH` có đánh dấu quản lý trong file cấu hình shell (`~/.bashrc` / `~/.zshrc`) và cài đặt script khởi chạy `bflow` vào thư mục `managedBin`.
5. Cấu hình các tích hợp công cụ (`rtk`, `gitnexus`, `superpowers`; `mempalace` chỉ được liệt kê là yêu cầu thủ công) nếu có mặt và đủ điều kiện (ví dụ: hoãn đánh chỉ mục GitNexus trên repo chưa có commit đầu tiên).

Chạy lại `bflow setup --yes` lần thứ hai trên môi trường đã hội tụ sẽ trả về `outcome: "noop"` (`already_satisfied`) mà không ghi thừa.

### 3.3 Sửa chữa thiết lập bị hỏng (`--repair`)

Nếu file `state.json`, `skills-store` hoặc cấu hình dịch vụ bị hỏng/thiếu:

```bash
bflow setup --repair --yes
```

---

## 4. Khởi tạo Repository (`bflow init`) & Di trú cấu hình (`bflow config-migrate`)

Tại thư mục gốc của Git repository (trên hệ tệp POSIX):

```bash
bflow init
```

Lệnh `bflow init` tạo:
- `.bflow/config.yml`: Cấu hình dự án chuẩn, tên session Herdr, ánh xạ role $\to$ provider (`claude`, `codex`, `agy`), tham số `model` / `effort` theo từng role, chế độ quyền (`restricted`, `workspace_auto`, `unattended_isolated`) và giới hạn tài nguyên.
- `.bflow/.gitignore`: Tự động loại trừ `state/`, `logs/`, `secrets/`, `worktrees/` và `*.db` để không bao giờ commit trạng thái nhạy cảm vào Git.

Lệnh `bflow init` có tính idempotent: chạy lại lần 2 sẽ giữ nguyên cấu hình hiện có (`overwritten: false`). Nếu repository đang dùng định dạng cũ (`.bflow/config.yaml` hoặc `.bflow/config.json`), chạy `bflow config-migrate` để chuyển sang `.bflow/config.yml`.

---

## 5. Chẩn đoán và Kiểm tra Sẵn sàng (`doctor`, `agent check`, `skills sync`)

Trước khi chạy `bflow up`, hãy xác minh toàn bộ chuỗi cung ứng:

```bash
# 1. Chẩn đoán tổng thể 6 nhóm (environment, herdr, providers, mcp, tools, skills):
bflow doctor --json

# 2. Kiểm tra sâu từng provider (binary SHA-256, auth, capabilities, permissions, workspace trust):
bflow agent check claude
bflow agent check codex
bflow agent check agy

# 3. Kiểm tra trạng thái các công cụ phụ trợ và MCP Gateway:
bflow tool status
bflow mcp status

# 4. Đồng bộ và kiểm tra 32 role skills:
bflow skills sync
```

Chỉ khi các role bắt buộc (`required: true`) đạt trạng thái `ready`, lệnh `bflow up` mới cho phép khởi tạo các pane tác tử trên Herdr.
