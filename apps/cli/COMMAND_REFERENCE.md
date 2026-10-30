# Tham chiếu Bflow CLI

Sau [bootstrap một lần](../../docs/guide/installation.md) bằng `node apps/cli/dist/bin.js setup`, dùng lệnh tắt **`bflow`**. Cú pháp bên dưới được đối chiếu với parser/help hiện tại. `bflow <command> --help` là tham chiếu exact flags; [high-level reference](docs/command-reference.md) và [parser JSON](docs/command-reference.json) mô tả command contracts cấp cao.

## Setup và lifecycle

| Lệnh | Hành vi / tùy chọn chính |
| --- | --- |
| `bflow --help`, `bflow help <command>` | Trợ giúp; `--version`/`-v` xem phiên bản; `--debug` hiển thị chẩn đoán kỹ thuật đầy đủ |
| `bflow setup` | Review/apply machine plan cấp máy; tạo launcher/PATH, cài pins, skills và Gateway; login là thao tác riêng |
| `bflow setup --check` | Quan sát prerequisite/drift cấp máy (kết quả như nhau từ mọi thư mục), không ghi |
| `bflow setup --dry-run` hoặc `--plan` | Preview plan, không áp dụng |
| `bflow setup --apply --yes` | Chấp thuận machine plan không tương tác; không tự duyệt global hooks |
| `bflow setup --repair --yes` | Plan/repair owned state/config theo receipt |
| `bflow setup --dir <repo>` | Cờ tương thích ngược (`setup` áp dụng toàn máy; dùng `bflow init --dir <repo>` cho từng kho mã) |
| `bflow setup --codex-hooks --plan` | Review hook inventory riêng, không cài tool/service |
| `bflow setup --codex-hooks --apply` | Human snapshot approval; không tương tác cần `--yes --hook-digest <sha256>` |
| `bflow init [--name <name>] [--provider codex\|claude\|agy] [--no-gitnexus]` | Tạo `.bflow/config.yml`, ignore file, index GitNexus và đăng ký service trên Gateway của máy; mặc định Codex, giữ config đã có |
| `bflow init --update` | Bổ sung defaults/comment, giữ giá trị cũ; `--provider` tường minh đổi role providers |
| `bflow init --check` hoặc `--remove` | `--check` chỉ đọc trạng thái repo/GitNexus; `--remove` gỡ đăng ký repo (kể cả repo đã xoá khỏi đĩa) |
| `bflow init --force` hoặc `--yes` | Thay toàn bộ config bằng defaults mới; lần index GitNexus không tương tác cần `--yes`; khác nghĩa `setup --yes` |
| `bflow init --accept-gitnexus-license` | Chỉ chấp nhận license và index GitNexus không tương tác, không ghi đè config; không kết hợp với `--no-gitnexus` hoặc `--check`/`--remove` |
| `bflow config-migrate` | Chuyển `.yaml`/`.json` cũ sang `.yml`, giữ byte gốc trong `.bak` |
| `bflow up [--timeout <ms>]` | Prepare persistent host/platform, preflight, launch qua Herdr, verify activated health |
| `bflow attach` | TTY trực tiếp vào Conversation pane |
| `bflow status` | Environment/host status; truyền `<run-id>` không kèm `--telemetry` hoặc dùng filters chuyển sang legacy Runtime query |
| `bflow status <run-id> --telemetry [--json]` | Báo cáo metric chỉ đọc cho `<run-id>` qua agentic host đang chạy ([TELEMETRY-SPEC.md](../../packages/runtime/TELEMETRY-SPEC.md)) |
| `bflow doctor [--deep]` | Diagnostic report; mặc định không model ping, deep có thể tiêu hao usage. Check `runtime-verification-sandbox` chạy probe Bubblewrap/Seatbelt thật (chỉ đọc, không cài đặt); `bflow up` chỉ bị chặn bởi lỗi này khi repo có runner được phát hiện hoặc cấu hình |
| `bflow down [--yes] [--force] [--timeout <ms>]` | Quiesce/checkpoint/revoke, rồi dừng owned panes/server; confirmation/force không bỏ Runtime barrier |
| `bflow recover --yes` | Recover empty legacy directory lifecycle lock sau khi owner process đã chết; không reconstruct workflow |

Setup có `--no-deepwiki`; DeepWiki không cần API key (cờ `--context7-api-key-stdin` và biến `CONTEXT7_API_KEY` là legacy của Context7, đã được replaced và bị bỏ qua); không đưa secret vào argv/config. Hook operator policy có `--trust-all` và `--revoke-trust-all` trong hook-only apply flow. [Setup guide](../../docs/setup-guide.md) · [Security](../../docs/guide/security-approval.md).

## Lệnh cấp cao

Các lệnh này kết hợp engine/ports hiện có. Chúng không tự launch agent hoặc thay quyền dispatch/approval của Runtime; command `succeeded` không chứng minh task/run đã thành công.

| Mục tiêu | Cú pháp hiện tại | Quyền / kết quả |
| --- | --- | --- |
| Khảo sát repository | `bflow repo inspect` | Chỉ đọc source/Git context |
| Preview/check task graph | `bflow task plan --spec <file> [--workflow <file>]` | Traceability; không sinh spec từ natural-language objective |
| Ghi task graph | `bflow task plan --spec <file> --write [--out <file>] [--force]` | Khác nội dung cần quyền thay thế |
| Chuẩn bị implementation | `bflow task implement <task-id> --run <run-id> --spec <file>` | Approved spec/artifact, TDD, worktree và assignment request; không start agent |
| Kiểm chứng | `bflow verify <task-id> --run <run-id> --plan <file>` | Independent gates/evidence; thiếu runner trả blocked |
| Tích hợp có kiểm soát | `bflow git prepare <run-id> [--task <id>] [--yes] [--resume]` | Preview trước; yes cho dedicated integration branch và workflow-verification request; không merge main/push/PR |
| Inventory MCP | `bflow mcp status [--service <id>]` | Đọc config/pins; live health cần Gateway port được inject, CLI mặc định chưa nối port này |
| Tool inventory | `bflow tool status [--tool <id>]` | Probe catalog/version/digest; `tools status` dùng parser kế thừa, ưu tiên cú pháp singular cho contract bên dưới |
| Skill sync | `bflow skills sync [--provider <kind>] [--dry-run] [--allow-machine-scope]` | Owned machine target cần quyền tường minh; preview bằng `--dry-run`; CLI hiện chưa nhận `skills list`/`--list` |
| Custom skills | `bflow skills scan\|import\|approve\|disable\|revoke\|status` | Scan/import chỉ đọc nguồn được chọn và stage bundle chưa duyệt; `approve --approve` ghi receipt chính xác vào machine state; revoke/status báo session cần đối soát |
| Provider preflight | `bflow agent check <claude\|codex\|agy> [--role <role>] [--mode restricted\|workspace_auto]` | Standalone preflight; có thể chạy model probe và dùng account mặc định, không là readiness của role/profile trong config |

Lệnh `repo inspect` dùng Git root của thư mục hiện tại, không có `--dir`/`--include-files`/`--max-files`; hãy `cd` vào repo trước. `agent check` không tạo Herdr pane nhưng adapter mặc định có thể chạy execution probe và tiêu hao usage; dùng `doctor`/`up` cho kiểm tra role/profile/model đã cấu hình.

Dùng `--json` cho agent/scripts. Common high-level flags: `--correlation-id`, `--idempotency-key`, `--help`; `--resume` chỉ nơi parser hỗ trợ. Không dùng các cờ suy đoán từ tên field: ví dụ `task plan --objective`, `task implement --task-id`, `git prepare --task-id` không phải cú pháp trên.

## Docs và profile

```bash
bflow docs search react
bflow docs lookup react --query "cleanup function trong useEffect" --json
bflow docs status --json
bflow iso help
bflow iso status
```

Docs qua DeepWiki/Gateway (`ask`, `structure`, `contents`, `status`, `probe`), repository công khai gửi ra ngoài; flags gồm `--repo owner/repo`, `--public`, `--question`, `--live` (probe), `--role`, `--timeout`. Không cần API key. [Docs package](../../packages/docs-retrieval/README.md).

`iso` chạy ai-isolator đi kèm để tạo/login/chọn profile; provider args giữ riêng. Đây là profile isolation, không tự chứng minh sandbox/readiness của workflow. [CLI README](README.md) và `bflow iso help` có exact subcommands.

## Legacy workflow commands

```bash
bflow run "Add password reset" --idempotency-key request-1
bflow status run-123 --json
bflow approve review --run run-123 --decision approved --by alice
bflow resume run-123 --idempotency-key resume-1
bflow cancel run-123 --reason "Requirements changed"
```

Chúng dùng legacy Runtime store/config, không tạo hoặc điều khiển P19 host. Với run được nhận qua Conversation, trả lời approval/revision/cancellation và operational resume trong **Conversation**; dùng `bflow status <run-id> --telemetry [--json]` khi cần đọc báo cáo metric từ agentic host đang chạy, còn `status <run-id>` không kèm `--telemetry` không thay host status. Không có `run --kind bugfix`. `--by` là actor label, không là auth/SSO.

## JSON, mã thoát và retry

High-level commands xuất `{ok, command, exitCode, result}`; `result` là `CommandExecutionResult` v3, `result.output` có schema v1 và outcome/steps riêng. Receipt giữ idempotency key/fingerprint; interrupted mutation cần reconcile, không blindly resend.

| High-level exit code | Ý nghĩa |
| --- | --- |
| 0 | Command thành công/ready/passed trong phạm vi riêng |
| 1 | Execution/validation failure |
| 2 | Invalid usage |
| 3 | Not ready hoặc verification not passed |
| 4 | Not found |
| 5 | Permission/approval required |
| 6 | Conflict/busy/idempotency mismatch |
| 7 | Unknown state; inspect receipt và reconcile trước retry |

Lifecycle/docs/iso có envelope và mã thoát riêng; không áp bảng 0–7 đồng loạt. Doctor có thể `ok: true` vì tạo report thành công nhưng exit 1 khi `data.healthy: false`. `iso` chuyển tiếp exit của provider. [High-level contract](docs/command-reference.md) mô tả chi tiết retry/resume và scope receipts.
