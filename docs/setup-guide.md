# Thiết lập máy và repository

Đây là hướng dẫn hiện hành cho `bflow setup`, `init`, provider và Gateway. [Installation](guide/installation.md) có lệnh build và bootstrap: gọi `node apps/cli/dist/bin.js setup` **một lần**, mở lại shell, rồi dùng lệnh tắt **`bflow`**. Setup tạo launcher và PATH; không cần tự khai báo shell alias.

## Yêu cầu môi trường

- Node.js **≥22.13**, pnpm **12.5.1**, Git và filesystem cục bộ. Root `engines >=22` rộng hơn yêu cầu của `node:sqlite`.
- Linux: `systemd --user`, `flock`, Bubblewrap/user namespaces cho verification. macOS: `launchd`, Apple Command Line Tools, Seatbelt và `flock` hỗ trợ inherited fd; Python ≥3.11 cho profile sync. [Compatibility matrix](compatibility-matrix.md).
- Machine state và secret cần POSIX ownership/mode `0700`/`0600`. Với repository không hỗ trợ private permissions, Runtime có thể chọn state ngoài checkout theo [configuration reference](guide/configuration-reference.md); không tự di chuyển state đã có authority.
- Dùng đường dẫn Unix socket ngắn. Khi gặp `sun_path`, chọn `TMPDIR=/tmp` và runtime directory ngắn; giới hạn phụ thuộc OS.
- CLI provider đã cài vẫn cần đăng nhập. Herdr được kiểm tra theo protocol 22/schema 1 và hành vi; release label không phải allowlist.

## 1. Xem và áp dụng machine plan

```bash
bflow setup --check          # Chỉ quan sát prerequisite và drift
bflow setup --dry-run        # Xem plan, không áp dụng
bflow setup                 # Hiển thị plan và hỏi trong TTY
# Với plan đã được chấp thuận, trong môi trường không tương tác:
bflow setup --apply --yes
```

Setup quản lý thư mục XDG riêng tư, catalog/pins đã review, immutable skill bundles, managed launcher/PATH, MCP configuration và service người dùng (`systemd --user` hoặc `launchd`). Receipt ghi rõ bước applied/noop/blocked/failed; partial apply hoặc doctor cuối không đạt trả mã lỗi. Cài đặt toàn máy ở đây là **phạm vi tài khoản người dùng**, không phải cấp quyền agent trên toàn máy.

Setup có thể cài Herdr, provider CLI và tools từ [catalog installer](../packages/tool-installer/README.md); không tự đăng nhập provider. Native plugin và các bước cần review riêng được trình bày trong plan. Các pin hiện có được giữ theo authority của machine config. `up` không cài dependency hoặc thực hiện machine setup. Riêng `trustedWorkspace: true` với required Claude cho phép CLI ghi per-project trust vào `$CLAUDE_CONFIG_DIR/.claude.json` hoặc `~/.claude.json`; xem [config reference](guide/configuration-reference.md#policy-và-ngân-sách) trước khi khởi động.

Chạy lại khi môi trường đã hội tụ trả `noop`/`already_satisfied`; chạy `bflow setup --repair --yes` khi cần sửa owned config/state theo plan. Giữ receipt không rõ kết quả để reconcile, không xóa state nhằm ép cài lại.

## 2. Chuẩn bị repository và Gateway

```bash
cd /path/to/your-project
bflow init --provider codex
bflow setup --dir .
```

`init` tạo `.bflow/config.yml` và ignore file với identity riêng. Các defaults hiện tại: Codex, `workspace_auto`, `trustedWorkspace: true`, SDD lightweight có approval, Conditional TDD, verification 3 vòng, concurrency 2, startup 300.000 ms. `init --update` bổ sung default fields/comment và giữ giá trị cũ; `--force`/`--yes` thay toàn bộ config bằng defaults mới. Config `.yaml`/`.json` cũ cần `bflow config-migrate` trước.

`setup --dir` chọn ngữ cảnh để chuẩn bị GitNexus index/backend của repo; installation vẫn dùng chung ở machine. **Context7 hosted được chia sẻ giữa repository/worktree** khi machine identity, canonical workspace và registration hợp lệ. **GitNexus, Chrome và backend local vẫn gắn workspace đã setup**. Khi bị lỗi workspace mismatch, chuẩn bị đúng repo bằng `bflow setup --dir <repo>`; không rebind Context7 chỉ vì đổi worktree.

Index GitNexus fresh có thể được đọc khi setup hội tụ cấu hình. Rebuild index stale cần quyền storage độc quyền: nếu reader/writer còn giữ lock, setup báo blocked và giữ lock, không tự dừng Gateway hoặc thu hồi quyền đang dùng. Thực hiện bảo trì rồi chạy lại plan.

Các tích hợp RTK/GitNexus/MemPalace/Chrome và Context7 được bật ở mức **optional** khi tạo config mới. Cấu hình không khai toggle cũng dùng optional defaults trong CLI composition. `enabled: false` tắt yêu cầu tương ứng; `required: true` chặn nếu chưa đủ inventory/grant/readiness. **Skill không cấp quyền tool.** Xem [tool policy](tools-sdlc-integration.md) và [config](guide/configuration-reference.md).

MemPalace dùng wheel PyPI pin checksum trong virtualenv do Bflow sở hữu, cần `uv` hoặc Python phù hợp. `wing` mặc định là repository ID, chỉ search read-only trong scope đó; setup không tạo memory fixture hoặc ghi memory. Có palace sẵn không chứng minh có dữ liệu đúng wing.

## 3. Provider, profile và Codex hooks

Đăng nhập CLI bằng account/profile bạn chọn. Chọn `profile-name` ở role hoặc provider defaults; Bflow không tự tạo profile, sao chép credential hoặc fallback account khi profile thiếu. Agy có native launch/binding cho specialist ở source/local tests, nhưng **Conversation và unattended vẫn unsupported**. Giữ Conversation trên Claude/Codex. [Provider README](../packages/agent-providers/README.md).

Nếu Codex global hooks chưa được duyệt:

```bash
bflow setup --codex-hooks --plan
bflow setup --codex-hooks --apply
```

Đây là luồng **chỉ review hooks**, không cài tool/service. Non-interactive snapshot approval cần `--yes --hook-digest <sha256>` đúng bản đã review. `setup --yes` thông thường không duyệt hooks. Chính sách `--trust-all`/`--revoke-trust-all` là lựa chọn operator riêng, xem [security and approval](guide/security-approval.md).

`BFLOW_HOME` chọn isolated machine/provider source. Để trỏ source checkout trong script, dùng biến ví dụ `BFLOW_SOURCE`; không đánh đồng hai biến. Khi dùng `AI_ISOLATOR_HOME`, giữ nhất quán trong setup, iso và up. [CLI profile reference](../apps/cli/README.md).

## 4. Context7

Setup đăng ký `https://mcp.context7.com/mcp` qua Shared Gateway, không cài `ctx7` CLI. Dùng anonymous hoặc API key tùy chọn:

```bash
# KEY được nhập từ nguồn bí mật của operator, không commit vào repository.
printf %s "$KEY" | bflow setup --apply --context7-api-key-stdin
# Hoặc cấp CONTEXT7_API_KEY trong environment của setup.
bflow docs search react
bflow docs lookup react --query "cleanup function trong useEffect" --json
bflow docs status
```

Secret lưu riêng dưới machine state, mode `0600`; config/log/receipt chỉ giữ reference/fingerprint. `--no-context7` bỏ dịch vụ trong setup; `environment.context7.enabled: false` tắt yêu cầu của repo. Cache mặc định tắt; authenticated cache cần opt-in riêng. OAuth chưa hỗ trợ. Truy vấn gửi ra Context7, vì vậy không đưa secret hoặc mã nội bộ vào query.

Version lookup dùng lockfile/manifest trong scope repository và không tự chọn tài liệu mới hơn phiên bản dự án. Kết quả `docs status` là probe dịch vụ/config, không chứng minh provider đang chạy đã dùng tài liệu. [Docs retrieval](../packages/docs-retrieval/README.md).

## 5. Chẩn đoán và khởi động

```bash
bflow doctor --json
bflow tool status
bflow mcp status   # Inventory; live Gateway port của CLI chưa được nối mặc định
bflow skills sync --dry-run
```

`skills sync --dry-run` preview catalog; CLI hiện chưa nhận `skills list` hoặc `skills sync --list`. Khi cần áp dụng skill vào machine scope, review preview rồi dùng `bflow skills sync --allow-machine-scope`. Standalone `agent check <provider>` có thể gọi model probe và không đọc role/profile/model từ config; nó không thay `doctor`/`up`.

`mcp status` đọc machine config và pin inventory; đường CLI mặc định chưa inject `mcpGateway`, nên `configured: false`/`not_ready` có thể là giới hạn composition dù daemon đang chạy. Dùng `doctor` cho platform diagnostics và `docs status` cho probe Context7; không lặp setup chỉ để xóa nhãn này.

`doctor`/`up` mặc định không gửi ping tới model. `bflow doctor --deep` chạy model probe theo từng bộ provider/profile/model/effort và có thể tiêu hao usage. Auth, native hooks, skills, permission, Gateway và activated health vẫn phải đạt riêng.

Xem lại/commit `.bflow/config.yml` và `.bflow/.gitignore`, bảo đảm working tree sạch, rồi chạy `bflow up` → `bflow attach`. Chỉ Conversation tương tác với người dùng; mọi role khác xin quyết định qua Runtime. Một lần `up` thành công không chứng minh workflow đã pass. [Getting started](guide/getting-started.md) · [Implementation status](implementation-status.md).
