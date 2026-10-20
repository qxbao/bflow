# Bằng chứng tích hợp P19 — 2026-10-16

Source implementation được kiểm thử: `a44d2a1c414842a77f652af767ac97323a6b85a1`.
Baseline Wave B đã được phê duyệt: `9de64924790bd4bfab7ee7fc6388e8463eb149f0`.
Branch: `agent/runtime/p19-coordinator`; worktree triển khai: `/tmp/bflow-p19-runtime`.
Node: 24.16.0; pnpm: pinned 12.5.1; Linux, filesystem cục bộ.

Đây là bằng chứng về source implementation và composition cục bộ. Việc đóng live
Herdr delivery và merge/xuất bản từ xa chưa được thiết lập.

## Lệnh và kết quả

| Command | Exit | Evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Cài đặt trong worktree cô lập sau khi sửa manifest của P14 |
| `pnpm build` | 0 | Tất cả package đã build; các test subprocess/worker dùng `dist` đã build |
| `pnpm check:deps` | 0 | 15 package, 22 cạnh nội bộ; không có chu trình/vi phạm ranh giới dependency |
| `pnpm typecheck` | 0 | Build TypeScript toàn monorepo |
| `TMPDIR=/tmp pnpm exec vitest run packages/runtime/test packages/core/test` | 0 | 213 passed ở cây trước đó; regression retry về sau thêm một test |
| `TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/integration.test.ts apps/cli/test/environment.test.ts --maxWorkers=2 --minWorkers=1` | 0 | 60 passed: 21 case tích hợp P19 và 39 case lifecycle CLI hiện có |
| `TMPDIR=/tmp pnpm test` | 1 | 1,194 passed, 1 skipped, 1 test shutdown CLI hiện có nhạy với deadline bị fail dưới tải song song mặc định |
| `TMPDIR=/tmp pnpm test --maxWorkers=2 --minWorkers=1` | 0 | Toàn monorepo: 52 file passed, 1 file skipped; 1,195 test passed, 1 skipped |
| `TMPDIR=/tmp pnpm test:e2e --maxWorkers=2 --minWorkers=1` | 1 | E2E bổ sung hiện có: 61 passed, 2 failed; cả hai lỗi nằm ở E09 CLI |
| Baseline: `TMPDIR=/tmp pnpm exec vitest run --config tests/e2e/vitest.config.ts tests/e2e/scenarios/e09-cli.e2e.test.ts --maxWorkers=2 --minWorkers=1` | 1 | Tại `9de6492` không đổi: cùng 2 case E09 fail, 5 passed |
| `git diff --check` và kiểm tra staged diff | 0 | Không có lỗi whitespace |
| `git status --short` sau source commit | 0 | Worktree sạch |

`pnpm check` baseline ban đầu fail một fixture Unix-socket của ArtifactStore do đường dẫn
temp mặc định của môi trường quá dài. `TMPDIR=/tmp pnpm check` đã pass baseline:
1,174 passed, 1 skipped. Platform/fixture filesystem không bị làm yếu đi.

Các lỗi E09 kỳ vọng `bflow init` trong một thư mục rỗng không phải Git sẽ tạo
`.bflow/config.json` legacy, và kỳ vọng các lỗi `status -j` legacy trong setup đó.
P12 hiện yêu cầu định danh repository và khởi tạo `.bflow/config.yaml`. Không fixture E09 nào
bị viết lại để che giấu các điểm không tương thích baseline này.

## Những gì đã được thực thi

Core thật, FileAgentRegistry, SQLite RunStore, filesystem ArtifactStore, P15
SpecificationEngine, P16 TestStrategyResolver, P17 VerificationEngine và P18
GitIntegrationEngine được ghép (compose) trên các Git repository tạm thời thật. Hành vi
pane vật lý và Herdr transport là giả lập (fake); kết quả runner độc lập được
host kiểm thử inject vào. Các test này không thiết lập được hành vi model live
cũng như định danh/cô lập Reviewer vật lý.

Các case gồm: hội thoại không có workflow, một route ngắn không có Architect,
phê duyệt/từ chối thiết kế phức tạp, hai Developer song song với pane/worktree được lease riêng biệt,
TDD bắt buộc và bằng chứng thay thế, sửa lỗi Reviewer có phạm vi, cạn kiệt verification,
xung đột merge thật, diff hoàn chỉnh sau tích hợp và workflow verification,
Conversation bận/khởi động lại outbox, composition hàng đợi inbound bận P14 thực tế,
các tool Coordinator không chặn và luồng phản hồi Reviewer từ xa,
unknown delivery và resend đúng request chỉ sau khi chứng minh không được giao,
phê duyệt task theo yêu cầu dự án, từ chối result giả mạo, hủy,
reconcile dừng writer trước khi retry, và khôi phục sau lỗi append SQLite mà không chạy lại
các verification check.

## Ownership, lưu trữ và tương thích

Triển khai: `packages/runtime/**`, phần mở rộng gate retry có giới hạn (opt-in) trong
`packages/core/src/workflow-engine.ts`, và `agents/coordinator/**`.

Sửa đóng gói tích hợp: P14 đã import Zod trực tiếp nhưng bỏ sót nó khỏi
package manifest. Chỉ `packages/conversation/package.json` và importer của nó trong
`pnpm-lock.yaml` được sửa. Không có hành vi source nào của P14 thay đổi.

Không có exported contract, cấu hình root dùng chung, README/AGENTS dùng chung hay file `docs/**`
nào thay đổi. Không thêm schema migration/upcaster nào. Journal riêng mới của P19 là
phiên bản 1; nó không thay thế Core aggregate codec hay lịch sử event SQLite.
Không commit `dist`, coverage, database, artifact hay agent log được sinh ra.
P02-RA01/P03-RA01 hiện có vẫn thuộc owner của chúng và không được tuyên bố là đã sửa.

Workspace API mới cần một native agent host đáng tin cậy để đăng ký prompt/tool,
cung cấp ingress Herdr có cấu trúc và có xác thực cùng định danh runner độc lập,
và quản lý các pump inbound/scheduler/lifecycle của nó. `bflow up` không tự động cài đặt
host đó. Việc thực thi P17 bị gián đoạn trước khi áp dụng outcome và các receipt mutation Registry/journal
mơ hồ đòi hỏi host reconcile, không bao giờ giả định thành công hay tự động redispatch.
Protected merge, production deployment, thay đổi secret/quyền truy cập và các thao tác dữ liệu
mang tính hủy hoại không được bật bởi các tool này.

## Preflight Herdr thực tế

Quan sát cục bộ chỉ đọc:

- `herdr --version`: `herdr 0.9.0`.
- `herdr api schema --json`: bundled protocol 22, schema 1.
- `herdr status server`: không có server đang chạy.
- `createHerdrAdapter().initialize(...)` thực tế: `ok: false`,
  `error.code: unsupported_version`, message `Herdr herdr 0.9.0 has not been verified`.

Ngoài ra, Adapter implementation chỉ phát ra các terminal snapshot chưa xác minh từ
`read()`, và submission handle có correlation do orchestrator sinh ra, chưa xác minh.
Core từ chối một result thành công trên binding đó. Fixture regression P19
cố ý cung cấp đúng hình dạng handle thực tế đó và chứng minh việc từ chối.

Không có Herdr binary nào bị nâng cấp, không có session người dùng nào được khởi động/thay đổi, và
không tuyên bố E2E Herdr live thành công. Đề xuất cụ thể cho ranh giới receipt còn thiếu
nằm ở [P19-RECEIPT-DECISION-PROPOSAL.md](P19-RECEIPT-DECISION-PROPOSAL.md).
