# Bflow Platform v3 — Hướng dẫn thiết lập & Onboarding

Tài liệu này hướng dẫn chi tiết quy trình cài đặt, thiết lập cấp độ máy chủ (`bflow setup`), khởi tạo cấu hình dự án (`bflow init`) và kiểm tra tính sẵn sàng của toàn bộ hệ thống (`bflow doctor`, `bflow agent check`) cho nền tảng Bflow Platform v3.

---

## 1. Yêu cầu hệ thống (Prerequisites)

### 1.1 Hệ điều hành và Hệ thống tệp tin (Filesystem)

- **Hệ điều hành được kiểm chứng đầy đủ**: **Linux `x86_64`** hỗ trợ `systemd --user` và Linux namespaces (`/usr/bin/bwrap` — Bubblewrap).
- **Hệ điều hành hỗ trợ theo thiết kế (Design / Adapter Level)**:
  - **macOS (`darwin`)**: Hỗ trợ quản lý dịch vụ nền qua `launchd` (`~/Library/LaunchAgents`); hiện chưa hỗ trợ sandbox kiểm tra hành vi Bubblewrap (chỉ khả dụng trên Linux).
  - **Windows (`win32`)**: Ở trạng thái thiết kế chưa kiểm chứng (`designed_unverified`) — mọi thao tác ghi thay đổi hệ thống sẽ được chặn an toàn (`blocked`) cho tới khi được chứng thực trên máy chủ Windows thực tế.
- **Yêu cầu bắt buộc về Hệ thống tệp POSIX**:
  - Thư mục làm việc của repository và các thư mục trạng thái (`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `TMPDIR`) **bắt buộc phải nằm trên hệ thống tệp POSIX thực sự** (`ext4`, `xfs`, `btrfs`, `apfs`, `tmpfs`) hỗ trợ phân quyền `chmod 0700` / `0600` và thuộc đúng UID của người dùng hiện hành.
  - **Tuyệt đối không đặt trạng thái runtime trên phân vùng `fuseblk` / NTFS / exFAT mount qua FUSE** (nơi mọi tệp tin luôn mang quyền `0777` hoặc `root:root`), vì Bflow sẽ từ chối khởi chạy nhằm bảo vệ tuyệt đối khóa ký Ed25519 và Bearer token.
  - **Giới hạn độ dài đường dẫn Unix Domain Socket**: Thiết lập `TMPDIR=/tmp` và sử dụng `XDG_RUNTIME_DIR` ngắn gọn để tổng độ dài đường dẫn socket không vượt quá giới hạn `sockaddr_un.sun_path` (tối đa `108` bytes trên Linux).

### 1.2 Công cụ nền tảng bắt buộc

| Thành phần | Phiên bản tối thiểu | Phiên bản đã kiểm chứng thực tế | Câu lệnh kiểm tra |
| :--- | :--- | :--- | :--- |
| **Node.js** | `>= 22.0.0` | `v24.16.0` | `node --version` |
| **pnpm** | `>= 9.0.0` | `12.5.1` | `pnpm --version` |
| **Git** | `>= 2.38.0` | `2.43.0` | `git --version` |
| **Herdr CLI** | Protocol `22` / Schema `1` | `herdr 0.9.5` | `herdr --version` |
| **Bubblewrap** *(Linux)* | `>= 0.8.0` | `0.9.0` | `bwrap --version` |

### 1.3 Công cụ CLI của Agent Provider (cần ít nhất 1 nhà cung cấp đã đăng nhập)

| Provider ID | Tên công cụ CLI | Phiên bản tối thiểu | Phiên bản đã kiểm chứng | Lệnh đăng nhập / kiểm tra trạng thái |
| :--- | :--- | :--- | :--- | :--- |
| `claude` | Claude Code | `>= 2.0.0` | `2.1.301` / `2.1.302` | `claude auth login` / `claude auth status` |
| `codex` | OpenAI Codex CLI | `>= 0.150.0` | `0.162.0` / `0.163.0` | `codex login` / `codex login status` |
| `agy` | Google Antigravity CLI | `>= 1.0.0` | `1.4.0` | `agy models` |

> [!IMPORTANT]
> **Lưu ý đặc biệt cho người dùng `codex`**: Bflow tự động vô hiệu hóa các máy chủ MCP toàn cục được khai báo trong bảng `[mcp_servers.<name>]` tại `~/.codex/config.toml` khi khởi chạy từng vai trò (`-c mcp_servers.<name>.enabled=false`). Nếu môi trường máy tính của bạn có cấu hình **Codex hooks toàn cục** (`~/.codex/hooks.json`), bộ điều hợp `CodexProviderAdapter` mặc định sẽ chuyển sang trạng thái **fail-closed** (`codex_global_hooks_not_isolated`) cho tới khi bạn chủ động rà soát và phê duyệt rõ ràng snapshot SHA-256 của các hook đó:
> ```bash
> bflow setup --codex-hooks --plan
> bflow setup --codex-hooks --apply
> ```

---

## 2. Biên dịch từ mã nguồn (Source Build)

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm check:deps
pnpm typecheck
```

---

## 3. Thiết lập cấp độ máy chủ (`bflow setup`)

Bflow phân tách rõ ràng giữa **thiết lập cấp độ máy chủ (`bflow setup`)** và **khởi chạy phiên làm việc của dự án (`bflow up`)**. Lệnh `bflow up` **tuyệt đối không bao giờ** tự ý tải công cụ từ internet hoặc can thiệp chỉnh sửa cấu hình toàn cục của người dùng.

### 3.1 Kiểm tra trạng thái hiện tại (Read-only Check)

```bash
bflow setup --check
# Hoặc xuất kết quả định dạng JSON:
bflow setup --check --json
```

Các chế độ `--check` và `--dry-run` vận hành hoàn toàn ở chế độ chỉ đọc và không thực hiện bất kỳ thao tác ghi nào xuống đĩa.

### 3.2 Thực thi thiết lập môi trường (`apply`)

```bash
# Chạy ở chế độ tương tác (hiển thị kế hoạch và chờ người dùng xác nhận):
bflow setup

# Chạy tự động xác nhận dành cho môi trường CI / tự động hóa:
bflow setup --yes
```

Khi thực thi `bflow setup`, hệ thống tuân thủ nghiêm ngặt thứ tự phụ thuộc và đảm bảo tính lũy thừa (idempotency):
1. Tạo lập các thư mục trạng thái, cấu hình, dữ liệu và `skills-store` với phân quyền bảo mật riêng tư `0700`.
2. Tải, cài đặt và kiểm tra mã băm SHA-256 cho **32 builtin skills** vào kho lưu trữ bất biến (`skills-store`).
3. Khởi tạo cấu hình Shared MCP Gateway (`mcp-config`) và đăng ký dịch vụ chạy nền cấp người dùng (`bflow-mcp-gateway.service` trên `systemd --user` hoặc `launchd` agent trên macOS) đi kèm nhãn sở hữu `.bflow-owner`.
4. Cập nhật khối `PATH` được quản lý trong tệp cấu hình shell (`~/.bashrc` hoặc `~/.zshrc`) và cài đặt kịch bản khởi chạy `bflow` vào thư mục `managedBin`.
5. Cấu hình tích hợp các công cụ chuyên dụng (`rtk`, `gitnexus`, `mempalace`, `superpowers`; trong đó MemPalace được cài đặt từ wheel cố định vào môi trường ảo virtualenv riêng của Bflow và đăng ký qua Gateway) khi có mặt và thỏa mãn điều kiện.

Việc chạy lại `bflow setup --yes` trên môi trường đã hội tụ trạng thái sẽ trả về kết quả `outcome: "noop"` (`already_satisfied`) mà không thực hiện ghi đè dư thừa.

### 3.2.1 Context7: Tra cứu tài liệu thư viện qua Gateway dùng chung

Lệnh `bflow setup` thiết lập **Context7** (dịch vụ MCP trực tuyến tại `https://mcp.context7.com/mcp`) như một dịch vụ *từ xa* (remote service) của Shared MCP Gateway. Không có tiến trình cục bộ nào được khởi chạy và không cần cài đặt thêm phần mềm: mọi agent dùng chung một kết nối thượng nguồn (upstream), và mỗi agent được Gateway phân quyền dựa trên bản đăng ký riêng biệt. Công cụ `ctx7` CLI hoàn toàn **không** được cài đặt do Bflow không có nhu cầu sử dụng công cụ này.

- **Khóa API (Tùy chọn)**: Nếu không cung cấp khóa, Context7 sẽ hoạt động ở chế độ ẩn danh với giới hạn tần suất truy vấn (rate limit) thấp hơn. Bạn có thể lấy khóa tại `https://context7.com/dashboard` (hoặc qua lệnh `npx ctx7 setup`), sau đó lưu trữ bằng một trong hai phương thức an toàn sau (tuyệt đối không truyền khóa qua đối số dòng lệnh):
  ```bash
  printf %s "$KEY" | bflow setup --apply --context7-api-key-stdin
  CONTEXT7_API_KEY="$KEY" bflow setup --apply
  ```
  Khóa bí mật được ghi nhận một cách nguyên tử vào `<state>/secrets/context7-api-key` (thư mục `0700`, tệp `0600`, tự động từ chối nếu là liên kết mềm symlink hoặc có quyền đọc từ người dùng khác) và chỉ được nạp trong bộ nhớ của Gateway. Các tệp cấu hình, nhật ký log, biên nhận và prompt chỉ lưu trữ tham chiếu an toàn `secret://bflow/context7/api-key` kèm dấu vân tay ngắn (fingerprint) để phát hiện sự thay đổi.
- **Hạn chế OAuth**: Giao thức OAuth (`/mcp/oauth`) hiện chưa được hỗ trợ do Gateway vận hành dưới dạng dịch vụ nền không có giao diện tương tác.
- **Rà soát cấu hình sẵn có**: Quá trình setup chỉ *đọc* `~/.claude.json`, `$CODEX_HOME/config.toml` và `agy mcp list` để cảnh báo nếu Context7 đã được đăng ký trực tiếp từ trước; hệ thống hoàn toàn không ghi đè cấu hình MCP của bạn. Các vai trò do Bflow khởi chạy chỉ nhận máy chủ MCP thông qua Gateway nên không bao giờ xảy ra xung đột đăng ký.
- **Tắt dịch vụ**: Thực hiện lệnh `bflow setup --apply --no-context7`.
- **Bảo mật dữ liệu ra bên ngoài**: Chỉ có tên thư viện và nội dung câu hỏi tra cứu tài liệu được gửi tới máy chủ `context7.com`. Tuyệt đối không gửi mã nguồn nội bộ hoặc thông tin bí mật vào nội dung truy vấn.

Kích hoạt theo từng repository trong tệp `.bflow/config.yml` (lệnh `bflow init` đã bật sẵn ở chế độ tùy chọn):

```yaml
environment:
  context7:
    enabled: true     # Bật/tắt dịch vụ cho repository
    required: false   # true: bflow up và doctor sẽ báo lỗi nếu dịch vụ chưa sẵn sàng; false: cảnh báo và chạy mà không có Context7
    cache:            # Tùy chọn bộ nhớ đệm
      enabled: true
      ttlSeconds: 3600
      allowAuthenticated: false   # Khi có khóa API, câu trả lời có thể từ thư viện riêng nên mặc định không cache
```

Chỉ các vai trò được cấp phép trong kỹ năng `use-context7` (gồm `specifier`, `architect`, `planner`, `developer`, `reviewer`, `qa`) mới được cấp quyền sử dụng dịch vụ. Vai trò Conversation Agent không bao giờ nhận công cụ Gateway, và Coordinator cũng không sử dụng Context7.

Tra cứu trực tiếp từ dòng lệnh:
```bash
bflow docs search react
bflow docs lookup react --query "cleanup function trong useEffect" --json
bflow docs status
```

Lệnh `lookup` sẽ tìm kiếm từ thư mục hiện tại ngược lên gốc repository để phát hiện phiên bản thư viện chính xác đang sử dụng từ các tệp khóa (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `poetry.lock`, `go.mod`, `Cargo.lock`). Hệ thống không bao giờ tự động nhảy sang tài liệu của phiên bản mới hơn nếu phiên bản hiện tại chưa có tài liệu tương ứng.

### 3.2.2 Liên kết Gateway của máy với Workspace

Shared MCP Gateway chạy nền là một dịch vụ cấp máy nhưng được gắn kết với duy nhất một repository tại một thời điểm (chính là workspace nơi thực thi lệnh `bflow setup --apply --dir <repo>` gần nhất). 

Khi bạn chạy `bflow up` tại một repository khác, các vai trò yêu cầu Gateway sẽ bị chặn với thông báo: `The machine Gateway is bound to workspace '<A>' but this operation targets '<B>'`. Để chuyển đổi liên kết, hãy thực thi:
```bash
bflow setup --apply --yes --dir <đường dẫn repo B>
```
Lệnh trên sẽ khởi động lại Gateway và liên kết an toàn với repository mới.

### 3.3 Khắc phục và sửa chữa thiết lập (`--repair`)

Nếu tệp `state.json`, kho lưu trữ `skills-store` hoặc cấu hình dịch vụ nền bị hỏng hoặc mất mát:

```bash
bflow setup --repair --yes
```

---

## 4. Khởi tạo Repository (`bflow init`) & Chuyển đổi cấu hình (`bflow config-migrate`)

Tại thư mục gốc của Git repository (trên hệ thống tệp tin POSIX):

```bash
bflow init
```

Lệnh `bflow init` tạo ra:
- `.bflow/config.yml`: Cấu hình dự án chuẩn mực, định danh phiên Herdr, ánh xạ vai trò sang nhà cung cấp (`claude`, `codex`, `agy`), tham số `model` / `effort` theo từng vai trò, chế độ phân quyền (`restricted`, `workspace_auto`, `unattended_isolated`) và giới hạn tài nguyên.
- `.bflow/.gitignore`: Tự động loại trừ các thư mục nhạy cảm `state/`, `logs/`, `secrets/`, `worktrees/` và các tệp `*.db` khỏi kho mã nguồn Git.

Theo mặc định, Claude Code sẽ hiển thị hộp thoại xác nhận tin cậy repository ở mỗi pane mới, và lệnh `bflow up` sẽ dừng ở trạng thái `blocked` chờ người dùng xác nhận. Để Bflow tự động ghi nhận sự tin cậy này, hãy khai báo trong `.bflow/config.yml`:

```yaml
environment:
  permissions:
    trustedWorkspace: true
```

Khi thiết lập `trustedWorkspace: true`, `bflow up` sẽ ghi nhận trạng thái `hasTrustDialogAccepted = true` vào `$CLAUDE_CONFIG_DIR/.claude.json`. Thao tác này được thực hiện nguyên tử và chỉ thay đổi duy nhất khóa cấu hình nói trên.

Lệnh `bflow init` có tính lũy thừa: chạy lại lần 2 sẽ bảo lưu nguyên vẹn cấu hình hiện tại (`overwritten: false`). Nếu dự án đang sử dụng định dạng cấu hình cũ, hãy chạy `bflow config-migrate` để nâng cấp an toàn sang `.bflow/config.yml`.

---

## 5. Chẩn đoán và Kiểm tra Sẵn sàng (`doctor`, `agent check`, `skills sync`)

Trước khi thực thi `bflow up`, hãy tiến hành kiểm tra toàn diện chuỗi cung ứng:

```bash
# 1. Chẩn đoán tổng thể 6 phân hệ (environment, herdr, providers, mcp, tools, skills):
bflow doctor --json

# 2. Kiểm tra chuyên sâu từng provider (mã băm nhị phân, xác thực, năng lực, phân quyền, tin cậy workspace):
bflow agent check claude
bflow agent check codex
bflow agent check agy

# 3. Kiểm tra trạng thái các công cụ tích hợp và MCP Gateway:
bflow tool status
bflow mcp status
bflow docs status

# 4. Đồng bộ và kiểm tra tính toàn vẹn của các role skills:
bflow skills sync
```

Chỉ khi toàn bộ các vai trò bắt buộc (`required: true`) đạt trạng thái sẵn sàng (`ready`), lệnh `bflow up` mới cho phép khởi tạo các pane tác tử trên Herdr.
