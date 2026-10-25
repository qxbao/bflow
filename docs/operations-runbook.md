# Sổ tay vận hành Bflow

Dùng sau [setup ban đầu](setup-guide.md). Các lệnh hiện tại đi qua persistent host/platform; [implementation status](implementation-status.md) phân biệt source, local test, probe thật và nghiệm thu đầy đủ.

## Khởi động và tương tác

```bash
cd /path/to/your-project
bflow doctor
bflow up
bflow attach
```

`up` đọc identity/policy, chuẩn bị host/platform, resolve skill/tool grants, preflight provider trước pane launch, rồi đợi native binding/attestation/activated health. Không dùng Herdr `idle`/`done` để kết luận ready. Startup mặc định 300.000 ms trong config mới; `--timeout` ghi đè tổng ngân sách, kể cả prepare. `up` và doctor mặc định không chạy model ping; `doctor --deep` có thể tiêu hao usage.

Herdr quản lý process/panes; persistent host giữ workflow/storage/authority; machine Gateway giữ kết nối tool. Browser runtime là capability riêng, không phải process bắt buộc cho mỗi session. Runtime browser task actions vẫn chưa có task lease usable.

Conversation là đầu mối duy nhất với người dùng: nhận yêu cầu, clarification, approval, revision và cancellation. Các role khác gửi `request_user_decision` qua Runtime → Herdr → Conversation, không hỏi native trực tiếp.

## Theo dõi

```bash
bflow status --json
bflow doctor --json
bflow mcp status --json   # Inventory; live port mặc định còn thiếu
bflow tool status --json
bflow docs status
```

`status` không tham số đọc environment/host; `status <run-id>` và filters thuộc legacy Runtime. Với P19, hỏi tiến độ/run trong Conversation và dùng host status/receipts để chẩn đoán. Delivery receipt không chứng minh model đã dùng tool, display receipt không phải approval.

`mcp status` trên đường CLI hiện chưa inject live Gateway port; `configured: false` không chứng minh machine daemon chưa chạy. Dùng `doctor`, machine service status và `docs status` (chỉ Context7) để chẩn đoán; không lặp setup chỉ để làm lệnh này xanh.

Tool installation, repo allowance, resolved grant, readiness, invocation và consumption là các quan sát riêng. Context7 hosted dùng chung giữa worktrees; backend local vẫn gắn workspace đã setup. GitNexus cần fresh index và lease/fence; không rebuild index dưới reader đang active. [Tool integration](tools-sdlc-integration.md).

## Dừng phiên

```bash
bflow down
# Chỉ khi đã quyết định dừng cùng checkpoint dù còn run active:
bflow down --yes
```

Runtime quiesce/drain, ghi aggregate checkpoint, revoke session grants rồi mới cho đóng owned panes/server. `--yes` không bỏ barrier; `--force` chỉ xử lý stuck pane cleanup sau Runtime barrier theo `bflow down --help`. Dirty worktrees và unknown delivery phải được giữ để kiểm tra. Repo down không dừng worker external hoặc machine Gateway dùng chung.

Nếu startup đã có side effect rồi thất bại/Ctrl+C, CLI thử safe down. Đọc riêng kết quả startup và cleanup; giữ receipt/manifest khi chưa chứng minh dừng an toàn. Không xóa `.bflow`, lock đang sống hoặc database để làm lại.

## Phục hồi theo tình huống

| Hiện tượng | Bước xử lý |
| --- | --- |
| Terminal bị ngắt, session còn sống | Chạy `bflow attach` |
| Host/Herdr chết | `status`/`doctor`, giữ state/worktrees, chạy `up` để đối soát binding; unknown vẫn chặn resend |
| Startup/shutdown còn uncertain | Đối chiếu operation receipt và server/pane hiện tại; `down --yes` chỉ khi barrier cho phép |
| Legacy directory lifecycle lock | Xác minh owner process đã chết rồi `bflow recover --yes`; lệnh này không reconstruct workflow receipt |
| Gateway backend crash | Kiểm tra machine service và `doctor` (lệnh `mcp status` có giới hạn live port nêu trên); Runtime phát hiện registration lost/degraded, giữ outbox. Reconcile generation trước khi up lại |
| Gateway version cũ sau build | Bảo trì/restart service do Bflow sở hữu theo setup plan; `up` không tự sửa machine config |
| Local backend workspace mismatch | `bflow setup --dir <repo>` theo plan; không rebind Context7 chỉ vì đổi worktree |
| `codex_global_hooks_not_isolated` | `bflow setup --codex-hooks --plan`, review rồi `--apply`; setup thường không duyệt hook |
| `agy_onboarding_incomplete` | Kiểm tra đúng profile/HOME launch và onboarding; không copy receipt để giả readiness |
| Browser `exclusive_resource_lease_unsupported` | Capability task chưa được Runtime hỗ trợ; không bỏ lease hoặc dùng profile cá nhân |
| Profile Chrome bị khóa | Xác minh đúng process/profile/task và ownership; giữ quarantine/unknown, không xóa lock của process còn sống |
| Conflict lightweight/full SDD | Trả lời revision được notice đề xuất trong Conversation; không resume lặp để bỏ project policy |

Trên Linux kiểm tra `systemctl --user status bflow-mcp-gateway.service`; macOS kiểm tra đúng `launchd` label/namespace trong setup receipt. Tên service có thể được namespace khi dùng isolated root. Không dừng process chỉ vì PID hoặc tên binary khớp.

## Tiếp tục và hủy workflow

Với P19, gửi `tiếp tục` hoặc `resume <run-id>` trong Conversation khi đã xử lý đúng pending action. Runtime xác thực human turn, capability, approval, lease/fence và delivery state. Blocker cần revision chờ người dùng sửa yêu cầu; nếu notice báo Runtime tự resume thì không cần gửi thêm lệnh tiếp tục.

Cancellation qua Conversation lưu control bền vững; `cancelled` nghĩa là intent hủy đã áp dụng, chưa tự chứng minh mọi native process dừng hẳn. Chờ reconciliation report `fully stopped` hoặc blocker. Giữ worktree cho tới khi xác minh writer đã dừng.

Legacy `bflow resume`/`cancel`/`approve` thao tác store khác; không dùng cho P19. [Session recovery](guide/session-recovery.md) giải thích recovery/backup và giới hạn durability.

## Lệnh cấp cao cho operator/automation

Các command kết hợp engine hiện có, không khởi động agent workflow thay Conversation:

```bash
bflow repo inspect --json
bflow task plan --spec ./spec.json --json
bflow task implement task-1 --run run-1 --spec ./spec.json --json
bflow verify task-1 --run run-1 --plan ./verification.json --json
bflow git prepare run-1 --task task-1 --json
bflow agent check codex --json
```

`agent check` là standalone adapter diagnostic, có thể chạy model probe và tiêu hao usage; nó không đọc role/profile/model của host config. Input spec/plan phải đúng schema và authority. Dùng `--help` cho exact flags; không có `task plan --objective` hoặc `git prepare --task-id`.

High-level commands có JSON envelope `{ok, command, exitCode, result}` và outcome riêng trong `result.output`. Exit codes: 0 success, 1 execution failure, 2 usage, 3 not ready, 4 not found, 5 permission required, 6 conflict, 7 unknown/reconciliation. Đây là contract **của high-level commands**, không áp đồng loạt cho lifecycle/iso/docs. Doctor có thể tạo report thành công nhưng exit 1 vì `healthy: false`. Đọc exit code cùng payload, không suy workflow success từ command `succeeded`. [CLI reference](../apps/cli/COMMAND_REFERENCE.md).
