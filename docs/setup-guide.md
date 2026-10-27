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

### Kiểm tra native login và intent Superpowers

Từ mốc `2357669`, setup doctor có thể báo native login đã verified khi CLI chạy trong môi trường tài khoản thông thường. Nó dùng status command của provider (`codex login status`, Claude structured auth status, Agy model-list check khi đã onboarding), chạy các provider probe độc lập đồng thời và không thực hiện model inference hoặc tạo credential.

Installed binary vẫn là một quan sát riêng. Login chưa xác minh báo warning và hướng dẫn operator đăng nhập; login verified không chứng minh model quota, profile trong config, launch/activated readiness hoặc task success. Với `BFLOW_HOME`/isolated setup hay injected platform, mặc định giữ warning nếu không có login probe phù hợp, không lấy login của tài khoản ngoài để chứng nhận scope cô lập. Agy chưa có native onboarding file thì không gọi `agy models`, tránh tạo first-run state từ phép kiểm tra.

`setup --check` cũng không còn dùng stage Superpowers chưa từng ghi native metadata để che diagnostic của installed destination. Nếu owned destination chứng minh exact pin đã được kích hoạt, lần apply được duyệt có thể archive intent cũ và bỏ stage của chính nó. Check không làm thao tác cleanup này. Intent đã có native metadata, destination chưa đủ bằng chứng hoặc kết quả mutation vẫn uncertain phải tiếp tục reconciliation theo receipt; không xóa cache/intent thủ công. [Installer reference](../packages/tool-installer/README.md).

## 2. Chuẩn bị repository và Gateway

```bash
cd /path/to/your-project
bflow init --provider codex
bflow init --check
```

`init` tạo `.bflow/config.yml` và ignore file tại thư mục gốc Git chuẩn với identity riêng. Các defaults hiện tại: Codex, `workspace_auto`, `trustedWorkspace: true`, SDD lightweight có approval, Conditional TDD, verification 3 vòng, `regressionScope: affected`, `fastPath.mode: auto`, concurrency 2, startup 300.000 ms. `init --update` bổ sung default fields/comment và giữ giá trị cũ; `--force`/`--yes` thay toàn bộ config bằng defaults mới. Config `.yaml`/`.json` cũ cần `bflow config-migrate` trước.

`bflow setup` có phạm vi cấp máy (chạy một lần cho môi trường tài khoản; `bflow setup --check` cho cùng kết quả từ bất kỳ thư mục nào, và `--dir` chỉ còn là cờ tương thích ngược). Việc chuẩn bị GitNexus theo từng repository được chuyển sang `bflow init`: khi chạy `bflow init`, CLI hỏi xác nhận giấy phép GitNexus PolyForm-Noncommercial lần đầu (hoặc tự động chấp nhận khi truyền `--yes`), lập chỉ mục kho mã và đăng ký dịch vụ `gitnexus-<repo>` vào Gateway đang chạy (`bflow init --check` kiểm tra chỉ đọc, `bflow init --remove` gỡ đăng ký dịch vụ kể cả khi thư mục repo đã xóa, `--no-gitnexus` bỏ qua lập chỉ mục/đăng ký). **Context7 và MemPalace** (phân vùng theo `wing` mặc định là repository ID) được chia sẻ giữa các repository/worktree qua Gateway cấp máy; **GitNexus và Chrome profile** vẫn gắn riêng theo từng repository/session (profile Chrome của `setup` không dùng chung với phiên repository).

Index GitNexus fresh có thể được đọc khi `init` hoặc `setup` hội tụ cấu hình. Rebuild index stale cần quyền storage độc quyền: nếu reader/writer còn giữ lock, thao tác báo blocked và giữ lock, không tự dừng Gateway hoặc thu hồi quyền đang dùng. Thực hiện bảo trì rồi chạy lại.

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
