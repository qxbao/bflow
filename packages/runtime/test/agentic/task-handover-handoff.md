# Bàn giao task handover nội bộ

Worktree: `/mnt/01DCE9A4D6522BD0/Project/AI/AI-flow-SDLC/.worktrees/task-handover`.
Branch: `agent/runtime/task-handover`.
Baseline/tested HEAD: `bc29647917b0f8a32b6172cb4b277ab81d393361`, cùng các thay đổi chưa commit của worktree này.
Baseline ban đầu sạch, chứa P24 `8dbb056` theo ancestry; local main có ba commit chưa có ở origin/main (đã kiểm tra cherry equivalence), giữ nguyên các sửa rework/test-integrity.
Node `v24.16.0`, pnpm `12.5.1`, Linux/local filesystem.

Tại lần bàn giao ban đầu chưa commit, push, PR hoặc merge. Chỉ thay đổi `packages/runtime/**`; không đổi public contracts, shared docs, root config hay lockfile. Không cần contract decision mới.

## Schema và lifecycle

Specification/Conditional TDD: [task-handover.spec.md](task-handover.spec.md), dựa trên tám tiêu chí owner đã giao; TDD required. RED trước implementation cho store/schema, Runtime/host integration, context authority, canonical byte limit và transport pagination; các lỗi review đã có regression tests.

Schema strict private v1 ở `src/agentic/task-handover.ts`: `binding` + `content`.
Binding gồm run/task/assignment ID, attempt number/ID, Core generation, rework generation, worktree path/HEAD, spec ID/version/fingerprint và requirement fingerprint. Không đổi RoleMessage v2; provenance nằm trong JSON payload của assignment do host tạo.
Content gồm nextAction, decisions, disprovedHypotheses, untestedAngles và source/evidence hints. Trần 16 KiB UTF-8 trước/sau chuẩn hóa, 768 ký tự/chuỗi nội dung, 8 mục/danh sách, 16 references; dùng lại source-location schema của rework. Evidence IDs không phải trusted ArtifactReference và không được tự dereference.

Developer chỉ đề xuất qua `propose_task_handover`. Runtime xác thực current assignment/session/worktree, đối chiếu Core attempt và hai generation, gia hạn lease/fence, validate rồi ghi một bản mới nhất vào `<journalDirectory>/task-handover/<hash(runId,taskId)>.json`. Tái dùng khóa AgenticJournal; exclusive temp + fsync/rename + directory fsync. Canonical context độc lập với checkpoint; đọc bounded regular files, từ chối symlink/hardlink/special file.

`assignment_context`, `workspace_status`, `read_task_handover` chọn lại context từ file và durable assignment provenance. Chỉ dùng cùng generation/rework-generation, cùng revision/specification/requirement, từ current hoặc earlier attempt có provenance. Không gắn nhãn attempt mới cho lịch sử cũ. Sai binding, dữ liệu hỏng/quá cỡ, stale revision/specification/requirement/generation có diagnostic `handover_*`, không sử dụng âm thầm.

Authority được dựng riêng từ host: yêu cầu, task definition/ownership, accepted specification/strategy, approval/decision, pending user decisions/blocker, current rework assignment và verification cycle. Pane đã nghỉ đọc authority hiện hành nhưng không được ghi hay chọn handover như current assignment. Compact context giữ task specification/criteria và các nghĩa vụ đó. Handover luôn là dữ liệu chưa đáng tin; không cấp approval, task success, quyền đổi spec/policy hoặc thay thế checkpoint/rework evidence.

Agy tự động nhận deferred reader. Reader chia JSON đầy đủ thành UTF-8 pages, dưới ngân sách 8.500 byte/reply; ghép page theo offset và parse đầy đủ trước khi tiếp tục. Cursor fingerprint ngăn ghép snapshot khác nhau; stale cursor phải đọc lại. ACK không echo body. Reader giữ cả host authority và tool actions. Đây là presentation riêng, không phải checkpoint codec mới.

## Compatibility và giới hạn

- Không đổi journal version/checkpoint codecs, không migration hoặc giả lập historical state. File handover không có trả absent; file lỗi không phá Core recovery.
- Assignment legacy không có provenance marker vẫn dùng cơ chế recovery hiện có, nhưng không được bịa marker/generation để nhận proposal (`handover_unknown_assignment`).
- Không đổi memory Gateway/provenance/grants; không dùng ArtifactStore làm kênh polling. Không chuyển provider.
- Handover dành cho Developer của Core task; conflict resolver/specialist ngoài Core task không dùng cơ chế này.
- Revision là HEAD, không chứng nhận uncommitted contents hay tính đúng hiện tại của source/evidence hints. Agent chết trước khi đề xuất/lưu thì không có handover mới để khôi phục.
- Source và local tests, chưa phải live provider/Herdr/full SDLC acceptance. Live Agy pagination và hostile same-UID isolation chưa được xác minh.

## Kiểm chứng

Targeted (bản cuối):

```sh
TMPDIR=/tmp pnpm exec vitest run --maxWorkers=3 --minWorkers=1 packages/runtime/test/agentic/task-handover.test.ts packages/runtime/test/agentic/task-handover-view.test.ts packages/runtime/test/agentic/rework-causality.test.ts packages/runtime/test/agentic/core-checkpoint-restore.test.ts packages/runtime/test/agentic/conversation-context-budget.test.ts packages/runtime/test/agentic/mcp-output-trim.test.ts packages/runtime/test/agentic/tool-action-policy.test.ts
```

Exit 0: 7 files, 81 passed, 0 failed, 0 skipped. Bao gồm retry/restart thật qua local Runtime, stale spec/revision, wrong generation, malformed/oversized, pending decisions, legacy state, policy injection, canonical normalization, paged round-trip/cursor freshness.

`pnpm check:deps`: exit 0, acyclic 22 packages/40 internal edges.
`pnpm typecheck`: exit 0.

Full validation cuối:

```sh
TMPDIR=/tmp pnpm test --maxWorkers=3 --minWorkers=1
```

Exit 1: 291 files (280 passed / 4 failed / 7 skipped); 5.482 tests (5.395 passed / 7 failed / 80 skipped). Bản cuối chạy từ 2026-10-26 16:46:39 UTC, 764,67 giây. **Full suite chưa xanh.**

Phân tích 7 lỗi:
- 6 lỗi ở CLI: iso-engine (1), host-recovery (1), iso-agy (4). Các test spread process.env và bị AI_ISOLATOR_* của phiên cha ảnh hưởng. Không có thay đổi CLI trong diff. Đã chạy lại với `env -u AI_ISOLATOR -u AI_ISOLATOR_REAL_HOME -u AI_ISOLATOR_HOME -u AI_ISOLATOR_PROFILE -u AI_ISOLATOR_TOOL TMPDIR=/tmp pnpm exec vitest run --maxWorkers=1 --minWorkers=1`: hai file đầu exit 0, 24 passed; iso-agy exit 0, 4 passed. Tổng 28 passed, không sửa source để né lỗi.
- 1 lỗi ở runner-detection: test “detects the real repository runner” yêu cầu pinned runner definitions khớp HEAD. `runner-provenance.ts` bảo vệ cả `test/**`; file `rework-causality.test.ts` đang được sửa có Git blob `8c0b150bbed6d69186987a47e5ea2062fe2d516f`, khác HEAD `5ab6ceedfb7fed30cf748fa1b8bf7fd316bf0dab`. Các file runner-detection/runner-provenance/test đó không đổi. Giữ nguyên gate và yêu cầu không commit của owner; không giả commit, sửa HEAD hoặc làm yếu validation. Cần integration owner chạy lại full suite sau commit được phép, trong subprocess không kế thừa AI_ISOLATOR_*.

`git diff --check`: exit 0. `git status --short`: exit 0, 6 tracked files modified và 6 new files, tất cả trong packages/runtime. Không có migration, generated output hoặc lockfile trong diff. Build tạo dist/tsbuildinfo được ignore; không stage/commit chúng.

Các lượt full chạy trước đã được dừng/thay thế khi source còn được review. Không dùng chúng làm bằng chứng PASS: TMPDIR kế thừa dưới ancestor `775` làm Codex security fixtures từ chối; đường dẫn dài làm Unix socket fixture lỗi; các lượt chạy chồng nhau có timeout. Không đổi quyền thư mục global hay production code ngoài Runtime để né lỗi. `TMPDIR=/tmp pnpm exec vitest run packages/agent-providers/test/agent-providers.test.ts` xác nhận riêng 145 passed, exit 0.

Review độc lập chỉ đọc tìm được và đã xác nhận sửa: authority khi assignment inactive, canonical size sau chuẩn hóa, Agy output budget. Không còn finding material sau review cuối. Không coi nhận xét reviewer là thay thế kết quả test.

Fingerprint của 9 file TypeScript source/test đã đổi (SHA-256 trên danh sách path + content hash đã sort): `363f5a28a9efc7cd734f1b0a6559637ab6727a5100fde82edc61a2a909a094f7`. Các file bàn giao/README/spec không tham gia fingerprint để tránh self-reference.

## Tích hợp được owner cho phép — 2026-10-27

Owner đã yêu cầu merge main và dọn worktree sau bản bàn giao trên, cho phép tạo commit và merge local. Main trước tích hợp là `62b4e6cdb1a7a0890feb67b18591c18620544e9a`; nhánh handover giữ nguyên sửa rework/test-integrity mới này. Kết quả dirty-HEAD và environment ở trên là lịch sử kiểm chứng trước authorization, không phải kết quả sau commit. Không push/PR; worktree workflow-telemetry của tác vụ khác nằm ngoài phạm vi cleanup.
