# Bằng chứng triển khai receipt đã duyệt và tương thích — 2026-10-16

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

Source commit được kiểm thử: `728f706ca92c5ee9dfab7cc67eb0daed99ce24ad`.
Baseline: P19 `973a943` (bao gồm implementation `a44d2a1`).
Branch/worktree: `agent/runtime/p19-authenticated-receipts`, `/tmp/bflow-p19-receipts`.
Phê duyệt: “Proposal: duyệt” của chủ dự án; quyết định integration/migration: ADR 0003.

## Regression tương thích release

Allowlist CLI 0.9.1 chính xác đã bị gỡ bỏ. Phiên bản CLI chỉ là metadata chẩn đoán;
protocol/schema thực tế và phản hồi thao tác quyết định tính tương thích. Không có
cờ bypass. AGENTS.md của dự án hiện cấm tường minh việc đưa lại allowlist release CLI
hoặc yêu cầu nâng cấp chỉ vì một phiên bản chưa được kiểm thử.

Ma trận kiểm thử chấp nhận các label 0.9.0, 0.9.1, 0.9.5, 0.10.0, 1.0.0 và
99.0.0-dev với protocol 22/schema 1. Ngay cả label 0.9.1 quen thuộc cũng bị từ chối
khi protocol/schema thực tế không tương thích hoặc sai định dạng. Đây là các fixture runner,
không phải tuyên bố rằng mọi binary đó đã được cài đặt và kiểm thử live.

Binary đã cài đặt thay đổi giữa task trước và task này: hiện nó
báo cáo `herdr 0.9.5`. Triển khai này không nâng cấp hay thay thế nó. Không có
binary 0.9.0 live trong lần chạy này. Khởi tạo Adapter thực tế trên 0.9.5
vượt qua negotiation protocol/schema mà không làm yếu việc xác minh outcome.

## Kết quả validation

Linux/filesystem cục bộ, Node 24.16.0, pnpm pinned 12.5.1.

| Command | Exit | Actual result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Dependency trong worktree cô lập |
| `pnpm build` | 0 | Tất cả package đã build trước các test worker/native plugin |
| `pnpm check:deps` | 0 | 15 package, 22 cạnh nội bộ; ranh giới/chu trình pass |
| `pnpm typecheck` | 0 | Toàn monorepo |
| `TMPDIR=/tmp pnpm exec vitest run packages/herdr-adapter/test --maxWorkers=2 --minWorkers=1` | 0 | 68 passed, bao gồm ma trận regression độc lập với release |
| `TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/integration.test.ts -t 'binding proof\|binding receipts' --maxWorkers=1 --minWorkers=1` | 0 | 5 case receipt passed, 21 case không liên quan bị lọc ra |
| `TMPDIR=/tmp pnpm test --maxWorkers=2 --minWorkers=1` | 0 | 1,209 passed, 2 skipped; 52 file passed, 2 skipped |
| `BFLOW_LIVE_HERDR=1 TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/live-herdr.test.ts --maxWorkers=1 --minWorkers=1` | 0 | 1 smoke test native Herdr transport thực tế passed |
| `TMPDIR=/tmp pnpm test:e2e --maxWorkers=2 --minWorkers=1` | 1 | 61 passed, cùng 2 lỗi E09 CLI đã có từ trước |
| `git diff --check`, kiểm tra staged diff, `git status --short` | 0 | Không có lỗi whitespace; worktree của source commit sạch |

Các lỗi E09 vẫn là kỳ vọng legacy của baseline: `init` trong thư mục rỗng không phải Git
tạo `.bflow/config.json`, và hành vi lỗi `status` legacy khi chưa khởi tạo. Cách tái hiện baseline
của chúng được ghi trong P19-VALIDATION.md.
Không fixture nào bị viết lại để che giấu các điểm không nhất quán CLI đó.

## Những gì đã triển khai và những gì thực sự được thực thi

- Capability bổ sung `AuthenticatedWorkflowEngine.verifyAgentBinding`;
  xác minh issuer Ed25519 trên các byte receipt canonical; raw handle bất biến;
  kiểm tra chính xác request/execution/attempt/target/session; tham chiếu ArtifactStore
  ràng buộc với proof; từ chối khi hủy và khi có proof xung đột.
- Các envelope event v2 riêng cho `agent.binding_verified` và proof command-receipt.
  Aggregate codec v2 giữ lại lịch sử proof/command, trong khi dữ liệu v0/v1 không có receipt
  vẫn đọc được. Không có SQL migration. Không upcaster nào tạo ra proof còn thiếu.
- Validation và replay live của Core, chấp nhận signed-result, SQLite projection,
  khôi phục checkpoint/tail và từ chối khi thiếu khóa issuer được cấu hình.
  Các test dương tính giữ `agentExecution.correlation.verified: false` trong khi lưu
  binding proof độc lập. Các case âm tính bao gồm chữ ký sai,
  issuer không xác định, execution sai và receipt đến sau khi hủy.
- Runtime ingress xác thực sender, causation, binding gốc và lease Registry
  hiện tại, ingest các byte receipt bất biến thực tế, và lưu proof
  trước khi chấp nhận một authenticated result. Các gate độc lập hiện có vẫn giữ nguyên.
- Một action của native Herdr plugin ký các thông điệp có cấu trúc, kiểm tra role manifest của host,
  và kiểm tra định danh pane/session Herdr thực tế trước khi attestation binding.
  Ingress cục bộ của nó xác minh toàn bộ chữ ký thông điệp trước khi cài đặt ngữ cảnh
  xác thực có phạm vi. `openAgenticWorkspace` có thể sở hữu endpoint ingress đó.

Smoke test live khởi động một session Herdr headless có tên, workspace và native
custom process riêng, khởi tạo Adapter thực tế, và gọi API
`plugin.action.invoke` thực tế của Herdr. Herdr khởi chạy entrypoint plugin thực tế, nó
chuyển tiếp một RoleMessage đã ký tới ingress của host. Chữ ký và xác thực có phạm vi
được kiểm tra; không có text snapshot nào được coi là message hay proof.
Chỉ dùng các session do test sở hữu, đường dẫn XDG/socket ngắn và ZDOTDIR riêng tư;
không có session người dùng thông thường, cấu hình shell trong home hay binary đã cài đặt nào bị thay đổi.
Mọi khóa ký của test đều tạm thời (ephemeral) và bị xóa cùng thư mục test.

Custom process cố ý không phải một AI provider. Trên phiên bản đã cài đặt này
nó không expose `agent_session` gốc nào, và việc gửi prompt thông thường được quan sát là
`unknown_delivery`/not ready. Thao tác đó không bị gửi lại một cách mù quáng hay được nâng cấp
thành business output đã chấp nhận. Test xác minh việc giao RoleMessage đã ký, không phải
live binding attestation cho một actor không có session. Source đã cài đặt ghi lại
sự phân biệt này trong `session_ref_from_report`, hàm chỉ chấp nhận native session ref
từ các nguồn tích hợp chính thức:
https://github.com/herdrdev/herdr/blob/v0.9.5/src/agent_resume.rs

Các hook provider chính thức phải expose native session thực tế của chúng trước khi attestation receipt.
Việc triển khai/review do AI sinh ra đầu-cuối, đăng ký tool gốc của provider,
và tự động boot/shutdown host CLI không được tuyên bố là đã xác minh live.
Khóa riêng phải nằm trong native host đáng tin cậy, ngoài prompt/agent tool;
giữ lại các khóa công khai lịch sử để replay. Không bổ sung cô lập same-user thù địch, multi-host,
network filesystem và đảm bảo power-loss.

## Phạm vi và file được sinh ra

Các thay đổi trải rộng qua ranh giới Adapter/Contracts/Core/Persistence/Runtime do owner phê duyệt,
chỉ dẫn tương thích của dự án, native Coordinator host plugin và tài liệu.
Chữ ký phương thức WorkflowEngine legacy và hành vi event/checkpoint không có receipt
giữ nguyên không đổi. Cần reader mới trước khi bật receipt cho một RunStore;
các reader nghiêm ngặt cũ từ chối proof/event/codec mới, theo yêu cầu của ADR 0003.
Không commit dist, coverage, database, artifact, khóa riêng hay process log được sinh ra.
Các follow-up P02-RA01/P03-RA01 hiện có giữ nguyên với owner ban đầu của chúng.
