# Kiểm kê guard trên đường thực thi (GĐ4a)

Nhánh `fix/runtime/blocker-audit`, baseline `origin/main` `228b4d65`. Tài liệu chỉ đọc; không sửa mã nguồn hay state. Phục vụ GĐ4b (allowlist) và GĐ4c (chuyển guard). Xem [kế hoạch](observed-evidence-plan.md) mục GĐ4.

## 1. Phương pháp và mức bằng chứng

- **Mức bằng chứng: mã nguồn.** Không có kiểm chứng live, không chạy test, không chạy workflow.
- Quét tĩnh mọi dòng chứa `throw` trong `packages/runtime/src/agentic` (đếm toàn thư mục: xem mục 2). Với các tệp nằm trên đường dispatch, `check_work`, đo phase, verification, rework, integration (10 tệp ở mục 2) tôi trích từng chỗ: tệp:dòng, hàm bao ngoài, lớp lỗi, thông điệp rút gọn.
- Nhóm và nhánh hiện tại là **phân loại bán tự động**: nhánh suy từ tệp/hàm + đọc đường xử lý lỗi thực (mục 3); nhóm suy từ từ khóa thông điệp (bảo mật/lease/fence/approval → GIỮ; tham số do agent nộp, ngân sách, ánh xạ → FINDING; lỗi hạ tầng/nguồn đổi giữa chừng/thiếu cấu hình → THIẾU PHỤC HỒI). Có thể sai từng dòng; **top 10 ở mục 5 đã được đối chiếu tay với mã**. GĐ4c phải xác nhận lại từng guard trước khi chuyển.
- Số dòng theo `origin/main` `228b4d65`; sẽ lệch khi GĐ1/GĐ2 sửa `behavioral-runner.ts`, `task-commands.ts`, `host-verification.ts`. Allowlist GĐ4b nên khóa theo (tệp, hàm, thông điệp) thay vì chỉ số dòng.

## 2. Số lượng

Đếm `throw` trong toàn `packages/runtime/src/agentic` (tệp lớn nhất): `runtime.ts` 330, `host.ts` 263, `host-verification.ts` 128, `journal.ts` 107, `host-receipts.ts` 73, `host-controller.ts` 73, `behavioral-runner.ts` 66, `host-platform.ts` 59, `rework-causality.ts` 54, `extension-delivery.ts` 52, `host-development.ts` 48. `host.ts`, `journal.ts`, `host-receipts.ts`, `host-platform.ts`, `extension-*`, `outbox.ts` là hạ tầng nhận/giao/persist, không nằm trên đường đo test; chỉ đếm, không liệt kê từng dòng.

Tệp trên đường thực thi được liệt kê (cột nhóm: bán tự động):

| Tệp | Tổng `throw` | `throw new Error(` | GIỮ | FINDING | THIẾU PHỤC HỒI | Đã có kênh có cấu trúc |
|---|---|---|---|---|---|---|
| `behavioral-runner.ts` | 66 | 43 | 30 | 15 | 12 | 9 |
| `task-commands.ts` | 4 | 1 | 1 | 2 | 0 | 1 |
| `host-verification.ts` | 128 | 108 | 52 | 34 | 23 | 19 |
| `host-development.ts` | 48 | 39 | 27 | 6 | 6 | 9 |
| `host-test-integrity.ts` | 15 | 15 | 12 | 3 | 0 | 0 |
| `integration-change.ts` | 11 | 11 | 6 | 2 | 3 | 0 |
| `mutation-check.ts` | 18 | 18 | 4 | 14 | 0 | 0 |
| `regression-results.ts` | 19 | 0 | 0 | 0 | 0 | 19 |
| `rework-causality.ts` | 54 | 53 | 19 | 33 | 1 | 1 |
| `runtime.ts` | 330 | 287 | 258 | 26 | 31 | 15 |

`throw new Error(` đã có kênh có cấu trúc là `TaskBlocker` (3 chỗ: `behavioral-runner.ts:406`, `task-commands.ts:213,225`, `host-verification.ts:686`), `WorkflowProposalRejected` (11), `HostBehavioralFailure` (5), `BehavioralIdentityRepair`, `RegressionInfrastructureFailure`, `VitestTestCodeFailure`, `NodeTapTestCodeFailure`, `BehavioralMeasurementError`, `RtkRequiredToolUnavailable` (12).

## 3. Các nhánh lỗi hiện nay (đọc từ mã)

| Đường | Cơ chế | Hậu quả |
|---|---|---|
| Đo phase của Tester/QA (`host.ts:2494`) | Lỗi bất kỳ từ `HostVerification.behavioralEvidence` → `recordPhaseFailure(..., repairable = error instanceof HostBehavioralFailure, ..., blockerOf(error))` (`runtime.ts:5501`) | `HostBehavioralFailure` → repairable (rework, tối đa `maxIterations`). `Error` thô → `repairable=false` → `recoverPhaseFailures`: run `escalated`, `pendingAction` `resume_coordinator` `recovery: manual`, thông điệp `Policy measurement blocked: …`. `TaskBlocker` không resume được (`fixableBy` ≠ environment/runtime) → `Plan mismatch (code)`; lặp cùng fingerprint → `No progress` |
| `check_work` (`host-development.ts:527`) | `blockerOf(error)`; có blocker → `blockedReply`, không có → `throw error` | Chỉ `TaskBlocker` được trả có cấu trúc. Mọi `Error` thô là lỗi tool, Developer không thấy mã/`nextAction` |
| `gate()` (`host-verification.ts:1204`) | `catch` → `{ok:false, error:{code:"validation", retryable:false, message, details?}}` | Mọi lỗi đo thành `validation` không retry; chỉ mang `blocker` nếu là `TaskBlocker` |
| Đề xuất workflow | `WorkflowProposalRejected` (có `code`) → `recordProposalRejection` | Coordinator sửa được (đường có cấu trúc, đã có chống lặp theo fingerprint) |
| Tool agent (`inspect_review`, `complete_review`, `record_alternative_verification`, Developer file tools, rework) | `Error` thô trả về MCP | Không đổi trạng thái run. Agent đọc thông điệp rồi thử lại hoặc kẹt; không có mã, `fixableBy`, `nextAction` |
| Transaction Runtime (`runtime.ts`) | `Error` thô/`AdmissionRejectedError` trong `this.transaction` | Từ chối lệnh; trạng thái giữ nguyên. Đây phần lớn là guard bảo mật/lease/approval nên giữ |

## 4. Tần suất thật từ journal và state

**Không có dữ liệu journal agentic của run đã chạy trong môi trường này; tôi không suy diễn tần suất theo mã lỗi.**

- `.bflow/state` (repo gốc) chỉ có `session.json` (`activeRunIds: []`), `panes/`, `cli/`, `private-runtime-state.json`. Không có `journal` agentic, không có `outbound`/`phaseFailure`. Không có `~/.bflow`, `BFLOW_HOME` không đặt. Đã tìm `*.journal`/`agentic-journal*` ngoài hệ thống: chỉ có journald của hệ điều hành, không liên quan.
- Dữ liệu run duy nhất còn lại là ba tệp `journal-observations.jsonl` (ảnh chụp trạng thái, không phải journal) trong `.superpowers/sdd/2026-11-02-web-visualization-mode/v9-live`, `v9-fixed-live`, `v9-golden-live` (49, 412, 481 dòng; run Web v9 ngày 02/11). Chúng chỉ có trạng thái run, không có `phaseFailure`, mã blocker hay thông điệp throw: v9-live `escalated`; v9-fixed-live hai run `cancelled` và một lần `escalated` trong lúc làm rõ; v9-golden-live `escalated` sau `verifying`. Tìm trong toàn bộ thư mục này các chuỗi `policy_phase_failed`, `Policy measurement blocked`, `No progress`, `declared_test_missing`, `runner_identity_unselectable`, `no_test_identities` cho **0 kết quả**. Không dùng được để đếm guard.
- Một sự cố có ghi nhận: run tối ưu chat 06/11 (kế hoạch mục 1): khoảng 95 phút, trong đó khoảng 42 phút lặp lại cùng một guard (`behavioral-runner.ts` `Behavioral test identity must be a committed regular file`, nay là `TaskBlocker declared_test_missing`). Đây là **một mẫu**, không phải tần suất.
- `docs/reliability/failure-analysis.md` cũng ghi rõ không có lịch sử run production để tính tần suất.

Hệ quả: danh sách ưu tiên (mục 5) dựa trên **mức độ nằm trên đường nóng + khả năng lặp theo cơ chế đã xác minh + hậu quả khi không có đường phục hồi**, không dựa trên đếm thật. Để có số thật, GĐ5 (live) hoặc GĐ1 telemetry phải ghi `code`/fingerprint mỗi phase failure; khi có journal thật, chạy lại đếm theo `outbound[].phaseFailure` và `error` bắt đầu `policy_phase_failed:`.

## 5. Top 10 guard nên chuyển trước

Tiêu chí: (a) `Error` thô trên đường đo phase nên thành `repairable=false` + escalated; (b) nguyên nhân thường nằm ở kế hoạch hoặc cấu hình, resume không sửa được nên lặp; (c) có thể gắn `TaskBlocker` với `fixableBy` và `nextAction` mà không nới bảo mật.

| # | Guard | Vị trí | Vì sao chuyển trước | Hướng chuyển |
|---|---|---|---|---|
| 1 | `Required criteria have no executed mapped test` | `host-verification.ts:1332` (`HostBehavioralFailure`) | Đã repairable nhưng chỉ có tóm tắt, thiếu mã. Tiêu chí không có test chạy do kế hoạch/ánh xạ sai thường không sửa được bằng code | `TaskBlocker` mới (`criterion_not_executed`, `fixableBy: director`) khi nguyên nhân là ánh xạ; giữ repairable khi Developer thiếu test |
| 2 | `No owner-configured behavior…` / `No owner-configured argv for …` / `Behavioral development requires configured independent behavioral…` | `host-verification.ts:509,518,524` (`assertSupported`) | Thiếu cấu hình owner là lỗi lập kế hoạch; hiện là `Error` thô → escalated `Policy measurement blocked`, resume không đổi gì | `TaskBlocker` (`owner_runner_unconfigured`, `fixableBy: user`) kèm `nextAction` nói rõ phải cấu hình gì |
| 3 | `Behavioral runner infrastructure failure (prepare / sandbox preparation)`, `Behavioral command invocation failed`, `Behavioral sandbox failed` | `behavioral-runner.ts:475,478,483,511,514,524` | Hạ tầng thật, nhưng là `Error` thô nên không có `fixableBy: environment`; resume tay được mà không biết sửa gì | `TaskBlocker` (`runner_infrastructure`, `environment`; resumable) kèm tail đầu ra |
| 4 | `Typecheck infrastructure failure` / `No detected TypeScript compiler…` / `Independent compiler/syntax phase budget exhausted` | `behavioral-runner.ts:583`; `host-verification.ts:277,279,293` | Lỗi môi trường/ngân sách trên đường static analysis; lặp khi môi trường thiếu compiler | `TaskBlocker` `environment`/`director` (budget: tách task) |
| 5 | `Behavioral test paths must be committed test files` / `Behavioral test identity…` còn ở `bind*` | `behavioral-runner.ts:115,147` | Cùng họ `declared_test_missing` nhưng ở `bind*`, chưa qua `TaskBlocker` (mới chuyển ở dòng 406) | Gắn `declared_test_missing`/`runner_identity_unselectable` |
| 6 | `Verification revision changed`, `Policy review source changed`, `… source changed during independent measurement`, `Test integrity source changed` | `host-verification.ts:257,265,381,1239,1283,1382,1559,1579` | Nguồn đổi giữa lúc đo là điều kiện nhất thời: nên cho phép đo lại cùng yêu cầu, không phải `escalated` + resume tay | `TaskBlocker` `runtime` (resumable, đo lại tự động trong ngân sách) |
| 7 | `Test integrity changed-file limit exceeded (256)`, `blob/aggregate size limit exceeded`, `capture deadline exceeded`, `cannot parse binary test/config` | `host-test-integrity.ts:39,42,47,50,55` | Giới hạn kích thước hiện chặn cả reviewer; thực chất là cảnh báo “cần chia nhỏ” | Chuyển thành finding `test_integrity_unmeasurable` (reviewer quyết định) nhưng **không** bỏ qua phán quyết bắt buộc (bất biến test-integrity) |
| 8 | Nộp rework: `Rework submission … lacks/has no new …`, `Rework worktree has uncommitted changes`, `Rework finding … evidence.* mismatch` | `rework-causality.ts:618-785` (≈ 33 chỗ) | 33/54 chỗ là kiểm tra cấu trúc dữ liệu agent nộp; mỗi lần trả một lỗi đơn, Developer tốn nhiều vòng để gom hết | Gom thành **danh sách finding** một lần (mã `rework_submission_invalid`, `fixableBy: developer`), vẫn từ chối nộp; không nới kiểm tra bằng chứng |
| 9 | `Mutation … find text occurs N times`, `target not found in the integrated revision`, `Mutation check does not match owner configuration` | `mutation-check.ts:91-96`; `host-verification.ts:702,711` | Lỗi cấu hình owner (mẫu không duy nhất/đích không còn) làm kẹt gate; Developer không sửa được | `TaskBlocker` `user`/`director` (`mutation_check_misconfigured`) |
| 10 | `Unknown task`, `Implementation assignment unavailable`, `Prior behavioral phase lacks a trusted host receipt`, `Expected X behavioral phase` | `host-verification.ts:225,1217,1226,1222,1274,1504,1975,1991,2001` | Trạng thái lệch giữa verifier và Runtime (trace chưa đồng bộ); hiện lỗi tool thô, verifier không biết phải làm gì | `TaskBlocker` `runtime` với `nextAction` “reconcile trước khi đo lại” (giữ nguyên fence/lease) |

**Giữ chặn cứng, KHÔNG chuyển** (bảo mật/chống gian lận/lease/fence/approval): kiểm tra symlink/hardlink/escape đường dẫn của Developer (`host-development.ts:152-348`), `Red test files are frozen…`, `Implementer cannot verify its own change`, `Independent … required`, mọi `authenticated`/`Cross-session`/`Stale web resume`/`Unknown delivery must be reconciled`/`quiesced`/lease hết hạn trong `runtime.ts`, `Conflicting immutable …`, digest/checksum/pin RTK (`behavioral-runner.ts:301-333`), `Proven test-integrity violation`, phán quyết test-integrity phải bao phủ đúng từng finding ID, và `Review … belongs to another pane`.

## 6. Tổng hợp theo hàm của `runtime.ts` (330 chỗ)

Gần như toàn bộ nằm trong `this.transaction` của Runtime và là guard bảo mật/lease/approval/trạng thái hợp lệ. Hàm có nhiều nhất: `applyAuthenticatedHerdrMessage` 26, `proposeWorkflow` 23, `taskHandover` 23, `resumeBlockedRun` 18 (`Explicit resume budget is exhausted`, `No matching recoverable blocker to resume` — cần `nextAction` hơn là chuyển), `validateProviderDelivery` 12, `requestUserDecision` 11, `requestPhaseVerification` 10, `replaceWorkflowReview` 10, `retirePolicyPhase` 9. Chỉ nên cân nhắc: `requestPhaseVerification` `This revision already failed the phase; commit a repair…` (`runtime.ts:5352`, đã có hướng dẫn), `resumeBlockedRun` `Explicit resume budget is exhausted` (đã park/cancel), `mutateRepository` `HEAD … does not descend from the run's base` (cần đường re-resolve). Tất cả nằm ngoài tệp GĐ4b đánh dấu.

## 7. Danh sách `throw new Error(` cho GĐ4b (allowlist)

**behavioral-runner.ts**: 43 chỗ. Dòng (origin/main `228b4d65`): 68, 73, 76, 81, 84, 86, 87, 89, 90, 93, 98, 101, 106, 107, 108, 110, 111, 115, 119, 137, 138, 139, 140, 142, 143, 147, 150, 152, 196, 219, 262, 440, 446, 475, 478, 483, 496, 511, 514, 524, 563, 578, 583

**task-commands.ts**: 1 chỗ. Dòng (origin/main `228b4d65`): 233

**host-verification.ts**: 108 chỗ. Dòng (origin/main `228b4d65`): 67, 174, 177, 182, 184, 187, 190, 225, 250, 251, 257, 265, 277, 279, 293, 318, 376, 381, 414, 498, 509, 512, 518, 522, 524, 525, 663, 702, 711, 799, 804, 902, 1171, 1187, 1213, 1215, 1217, 1220, 1222, 1226, 1228, 1235, 1236, 1239, 1264, 1269, 1270, 1274, 1277, 1279, 1281, 1283, 1299, 1320, 1340, 1348, 1349, 1364, 1382, 1406, 1419, 1421, 1438, 1492, 1495, 1504, 1524, 1529, 1530, 1533, 1537, 1559, 1579, 1755, 1759, 1762, 1764, 1792, 1797, 1803, 1804, 1809, 1818, 1819, 1830, 1835, 1837, 1838, 1854, 1864, 1869, 1928, 1932, 1935, 1968, 1969, 1973, 1974, 1975, 1988, 1991, 1998, 2001, 2003, 2007, 2009, 2011, 2015

Số lượng: `behavioral-runner.ts` 43, `task-commands.ts` 1, `host-verification.ts` 108 (tổng 152). Một số `throw new Error(` nằm trên cùng dòng với `throw` khác nên số dòng và số chỗ có thể chênh khi tệp được định dạng lại.

## 8. Trạng thái GĐ4c

Mức bằng chứng: mã nguồn và test cục bộ, không phải kiểm chứng live.

| # | Trạng thái | Ghi chú (đã xác minh trong mã) |
|---|---|---|
| 3 | **Đã chuyển** (nhánh `fix/runtime/guard-runner-infra`) | 6 chỗ trong `runMeasurementCommand` (prepare ×3, sandbox preparation, command invocation, sandbox `bwrap:`/`sandbox-exec:`) giờ là `TaskBlocker("runner_infrastructure")`, `fixableBy: environment`, resumable. Thông điệp không đổi, vì `measureRegression` dựa vào chuỗi `deadline exceeded` (`regression_budget_exceeded`). `details` = `{stage, commandId, revision}`, không chứa tail đầu ra, để lặp trên cùng đầu vào vẫn bị cầu dao GĐ1 nhận ra. Đường phục hồi: `check_work` trả `classification: "infrastructure"` kèm `nextAction`, thay vì lỗi tool thô. Phase failure cho run `escalated` (`Policy measurement blocked`). Resume tay vẫn đo lại cùng revision (`retryAuthorized`, `nonResumablePhaseFailures` rỗng). `runtime.ts` chỉ nối câu "Resume sẽ không đo lại cùng revision." khi blocker không resumable. Các guard bảo mật bên trong `sandboxBehavior` (credential, đường dẫn unsafe, special file) vẫn từ chối mỗi lần đo: đổi lớp lỗi không nới chặn. Guard "clean worktree"/prepare sửa tệp tracked vẫn là `Error` thô (chống gian lận, GIỮ). |
| 5 | **Không chuyển: danh mục xếp sai nhóm** | `bindRunnerProfile` (`behavioral-runner.ts:115`) chỉ nhận đường dẫn đã qua `selectTestPaths`, mà hàm này đã lọc `testFilePattern` (`task-commands.ts:136`). Các lần gọi ở `task-commands.ts:210,216` còn nuốt lỗi bằng `try/catch`, nên Runtime không chạm được guard này. Đây là bất biến lập trình nội bộ, không phải lệch kế hoạch. `declared_test_missing`/`runner_identity_unselectable` sẽ cho `nextAction` sai. `bindRegressionProfile` (`:147`) đã có kênh có cấu trúc: `handleInfraFailure` đổi lỗi thành finding `regression_infrastructure` (`host-verification.ts:1037`). Đề xuất: xếp lại #5 thành GIỮ (bất biến nội bộ). |

## Phụ lục A. Từng chỗ `throw` trên đường thực thi

Cột cuối: GIỮ = giữ chặn cứng; FINDING = chuyển thành finding/cảnh báo; THIẾU PHỤC HỒI; có kênh = đã dùng lớp lỗi có cấu trúc. Phân loại bán tự động (mục 1).

| Vị trí | Hàm | Lớp | Thông điệp (rút gọn) | Nhóm |
|---|---|---|---|---|
| behavioral-runner.ts:68 | `strings` | Error | Invalid behavioral ${name} | FINDING |
| behavioral-runner.ts:73 | `assertTestIdentities` | Error | Behavioral test identities/paths must be unique and safe | FINDING |
| behavioral-runner.ts:76 | `assertExecutionBounds` | Error | Invalid behavioral execution bounds | FINDING |
| behavioral-runner.ts:81 | `parseBehavioralCommands` | Error | behavioralCommands must be an array | FINDING |
| behavioral-runner.ts:84 | `parseBehavioralCommands` | Error | Unknown behavioral command configuration field | FINDING |
| behavioral-runner.ts:86 | `parseBehavioralCommands` | Error | Behavioral executable must be an absolute owner-configured path and id must be safe | GIỮ |
| behavioral-runner.ts:87 | `parseBehavioralCommands` | Error | Unsupported behavioral method | THIẾU PHỤC HỒI |
| behavioral-runner.ts:89 | `parseBehavioralCommands` | Error | Behavioral test levels do not match method | GIỮ |
| behavioral-runner.ts:90 | `parseBehavioralCommands` | Error | Unsupported behavioral reporter | THIẾU PHỤC HỒI |
| behavioral-runner.ts:93 | `parseBehavioralCommands` | Error | Behavioral dependency roots must be absolute node_modules directories | GIỮ |
| behavioral-runner.ts:98 | `parseBehavioralCommands` | Error | Duplicate behavioral command identity | GIỮ |
| behavioral-runner.ts:101 | `parseBehavioralCommands` | Error | Aggregate behavioral execution budget exceeds the host deadline | FINDING |
| behavioral-runner.ts:106 | `bindRunnerProfile` | Error | Runner profiles must be Runtime-detected | FINDING |
| behavioral-runner.ts:107 | `bindRunnerProfile` | Error | Runner profile executable must be absolute and id must be safe | GIỮ |
| behavioral-runner.ts:108 | `bindRunnerProfile` | Error | Unsupported behavioral method | THIẾU PHỤC HỒI |
| behavioral-runner.ts:110 | `bindRunnerProfile` | Error | Behavioral test levels do not match method | GIỮ |
| behavioral-runner.ts:111 | `bindRunnerProfile` | Error | Unsupported behavioral reporter | THIẾU PHỤC HỒI |
| behavioral-runner.ts:115 | `bindRunnerProfile` | Error | Behavioral test paths must be committed test files | FINDING |
| behavioral-runner.ts:119 | `bindRunnerProfile` | Error | Behavioral dependency source must be an absolute repository path | GIỮ |
| behavioral-runner.ts:137 | `bindRegressionProfile` | Error | Runner profiles must be Runtime-detected | FINDING |
| behavioral-runner.ts:138 | `bindRegressionProfile` | Error | Regression profile binding does not support adapter profiles | GIỮ |
| behavioral-runner.ts:139 | `bindRegressionProfile` | Error | Runner profile executable must be absolute and id must be safe | GIỮ |
| behavioral-runner.ts:140 | `bindRegressionProfile` | Error | Unsupported behavioral method | THIẾU PHỤC HỒI |
| behavioral-runner.ts:142 | `bindRegressionProfile` | Error | Behavioral test levels do not match method | GIỮ |
| behavioral-runner.ts:143 | `bindRegressionProfile` | Error | Unsupported behavioral reporter | THIẾU PHỤC HỒI |
| behavioral-runner.ts:147 | `bindRegressionProfile` | Error | Behavioral test paths must be committed test files | FINDING |
| behavioral-runner.ts:150 | `bindRegressionProfile` | Error | Behavioral dependency source must be an absolute repository path | GIỮ |
| behavioral-runner.ts:152 | `bindRegressionProfile` | Error | Invalid regression execution bounds | FINDING |
| behavioral-runner.ts:193 | `verificationGit` | rethrow | catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; } const filters | có kênh |
| behavioral-runner.ts:196 | `verificationGit` | Error | Invalid local Git filter definition | FINDING |
| behavioral-runner.ts:206 | `verificationGit` | rethrow | catch (error) { await verificationGit(cwd, [ | có kênh |
| behavioral-runner.ts:219 | `assertPinnedRevision` | Error | Verification needs a clean worktree at the pinned revision | GIỮ |
| behavioral-runner.ts:262 | `runSandboxedInput` | Error | RTK sandbox command is malformed | GIỮ |
| behavioral-runner.ts:301 | `prepareRtk` | RtkRequiredToolUnavailable | rtk_identity_invalid | GIỮ |
| behavioral-runner.ts:303 | `prepareRtk` | RtkRequiredToolUnavailable | rtk_binary_unavailable | GIỮ |
| behavioral-runner.ts:305 | `prepareRtk` | RtkRequiredToolUnavailable | rtk_binary_unavailable | GIỮ |
| behavioral-runner.ts:308 | `prepareRtk` | RtkRequiredToolUnavailable | rtk_binary_drift | GIỮ |
| behavioral-runner.ts:314 | `prepareRtk` | RtkRequiredToolUnavailable | rtk_binary_copy_drift | GIỮ |
| behavioral-runner.ts:325 | `prepareRtk` | RtkRequiredToolUnavailable | rtk_version_mismatch | GIỮ |
| behavioral-runner.ts:328 | `prepareRtk` | RtkRequiredToolUnavailable | rtk_stdin_filter_unsupported | GIỮ |
| behavioral-runner.ts:333 | `prepareRtk` | RtkRequiredToolUnavailable | rtk_filter_unavailable | GIỮ |
| behavioral-runner.ts:406 | `runMeasurementCommand` | TaskBlocker | declared_test_missing | FINDING |
| behavioral-runner.ts:424 | `runMeasurementCommand` | rethrow | rtk_probe_failed | có kênh |
| behavioral-runner.ts:425 | `runMeasurementCommand` | RtkRequiredToolUnavailable | rtk_probe_failed | GIỮ |
| behavioral-runner.ts:434 | `runMeasurementCommand` | RtkRequiredToolUnavailable | rtk_usage_intent_failed | GIỮ |
| behavioral-runner.ts:440 | `runMeasurementCommand` | Error | Invalid Runtime runner helper | FINDING |
| behavioral-runner.ts:446 | `runMeasurementCommand` | Error | Behavioral report must not exist before execution | GIỮ |
| behavioral-runner.ts:475 | `runMeasurementCommand` | Error | Behavioral runner infrastructure failure (prepare): ${String(error)} | THIẾU PHỤC HỒI |
| behavioral-runner.ts:478 | `runMeasurementCommand` | Error | Behavioral runner infrastructure failure (prepare): ${prepared.error.message} | THIẾU PHỤC HỒI |
| behavioral-runner.ts:483 | `runMeasurementCommand` | Error | Behavioral runner infrastructure failure (prepare): ${failure}${outputTail(prepareOutcome)} | THIẾU PHỤC HỒI |
| behavioral-runner.ts:496 | `runMeasurementCommand` | Error | Behavioral report must not exist before the test command | GIỮ |
| behavioral-runner.ts:511 | `runMeasurementCommand` | Error | Behavioral runner infrastructure failure (sandbox preparation): ${String(error)} | THIẾU PHỤC HỒI |
| behavioral-runner.ts:514 | `runMeasurementCommand` | Error | Behavioral command invocation failed: ${result.error.message} | GIỮ |
| behavioral-runner.ts:524 | `runMeasurementCommand` | Error | Behavioral sandbox failed: ${outcome.stderr.trim()} | THIẾU PHỤC HỒI |
| behavioral-runner.ts:543 | `runMeasurementCommand` | RtkRequiredToolUnavailable | throw new RtkRequiredToolUnavailable(resultRecorded ? reasonCode :  | GIỮ |
| behavioral-runner.ts:548 | `runMeasurementCommand` | RtkRequiredToolUnavailable | rtk_filter_failed | GIỮ |
| behavioral-runner.ts:563 | `runMeasurementCommand` | Error | Behavioral execution generated files outside the committed revision | GIỮ |
| behavioral-runner.ts:578 | `measureCompiler` | Error | Compiler test exceptions must be selected behavioral test paths | FINDING |
| behavioral-runner.ts:583 | `measureCompiler` | Error | Typecheck infrastructure failure: ${outcome.spawnError ?? outcome.signal ?? (outcome.timedOut ?  | THIẾU PHỤC HỒI |
| behavioral-runner.ts:610 | `measureBehavior` | VitestTestCodeFailure | if (error instanceof VitestTestCodeFailure) throw new VitestTestCodeFailure(error.outcome, | có kênh |
| behavioral-runner.ts:611 | `measureBehavior` | NodeTapTestCodeFailure | throw new NodeTapTestCodeFailure(error.outcome, error.failedTestNames, rtkResult); } | có kênh |
| behavioral-runner.ts:613 | `measureBehavior` | rethrow | throw error; } | có kênh |
| behavioral-runner.ts:616 | `measureBehavior` | BehavioralIdentityRepair | throw new BehavioralIdentityRepair(outcome, error.expectedNames, error.observedNames, comm | có kênh |
| behavioral-runner.ts:618 | `measureBehavior` | BehavioralMeasurementError | throw new BehavioralMeasurementError(error, measurementDiagnostics(command, outcome, error | GIỮ |
| behavioral-runner.ts:628 | `measureRegression` | rethrow | if (error instanceof RegressionInfrastructureFailure) throw error; const message = error i | có kênh |
| behavioral-runner.ts:630 | `measureRegression` | RegressionInfrastructureFailure | throw new RegressionInfrastructureFailure( message.includes( | có kênh |
| task-commands.ts:213 | `resolveTaskCommands` | TaskBlocker | runner_identity_unselectable | FINDING |
| task-commands.ts:217 | `resolveTaskCommands` | rethrow | catch (error) { if (input.ownedPaths !== undefined) continue; throw error; } namesByProfil | có kênh |
| task-commands.ts:225 | `resolveTaskCommands` | TaskBlocker | runner_identity_unselectable | FINDING |
| task-commands.ts:233 | `resolveTaskCommands` | Error | runner_identity_unselectable: split selected runners into tasks within the independent execution dea | GIỮ |
| host-verification.ts:67 | `boundQaReviewCommands` | Error | QA workflow aggregate measurement budget exceeds the remaining gate deadline; split checks before re | FINDING |
| host-verification.ts:174 | `inspectPolicyReview` | Error | No active independent policy review capability/assignment | GIỮ |
| host-verification.ts:177 | `inspectPolicyReview` | Error | Policy review requires the current ${expected} phase | FINDING |
| host-verification.ts:182 | `inspectPolicyReview` | Error | policy_review_source_changed: inspect the current committed revision again | GIỮ |
| host-verification.ts:184 | `inspectPolicyReview` | Error | Policy review assignment changed during paging | THIẾU PHỤC HỒI |
| host-verification.ts:187 | `inspectPolicyReview` | Error | policy_review_cursor_required | GIỮ |
| host-verification.ts:190 | `inspectPolicyReview` | Error | Policy review assignment changed during inspection | THIẾU PHỤC HỒI |
| host-verification.ts:225 | `dossierFor` | Error | Unknown task | THIẾU PHỤC HỒI |
| host-verification.ts:250 | `capture` | Error | Verification needs pinned Git revisions | GIỮ |
| host-verification.ts:251 | `capture` | Error | Verification worktree is dirty or revision changed | THIẾU PHỤC HỒI |
| host-verification.ts:255 | `capture` | rethrow | catch (error) { const failure = error as { code?: unknown; stdout?: string; stderr?: strin | có kênh |
| host-verification.ts:257 | `capture` | Error | Verification revision changed during capture | THIẾU PHỤC HỒI |
| host-verification.ts:265 | `observedChangedPaths` | Error | Verification revision changed while selecting committed test paths | THIẾU PHỤC HỒI |
| host-verification.ts:277 | `captureStaticAnalysis` | Error | No detected TypeScript compiler for the original revision; provision typecheck before proposing work | THIẾU PHỤC HỒI |
| host-verification.ts:279 | `captureStaticAnalysis` | Error | Independent compiler phase budget exhausted | THIẾU PHỤC HỒI |
| host-verification.ts:293 | `captureStaticAnalysis` | Error | Independent syntax phase budget exhausted | THIẾU PHỤC HỒI |
| host-verification.ts:318 | `parseCapture` | Error | Invalid stored host observation | FINDING |
| host-verification.ts:376 | `testIntegrityGate` | Error | Test integrity gate definition mismatch | GIỮ |
| host-verification.ts:381 | `testIntegrityGate` | Error | Test integrity source changed during capture | GIỮ |
| host-verification.ts:414 | `policyDeterministicGate` | Error | Policy deterministic check does not match host configuration | FINDING |
| host-verification.ts:498 | `assertSupported` | Error | Compiler/static criteria require an accepted strategy and host-selected command | FINDING |
| host-verification.ts:502 | `assertSupported` | WorkflowProposalRejected | throw new WorkflowProposalRejected({ code:  | có kênh |
| host-verification.ts:507 | `assertSupported` | WorkflowProposalRejected | if (deterministic.length) throw new WorkflowProposalRejected({ code:  | có kênh |
| host-verification.ts:509 | `assertSupported` | Error | Behavioral development requires configured independent behavioral acceptance checks | GIỮ |
| host-verification.ts:512 | `assertSupported` | Error | Mixed manual and behavioral TDD criteria require separate tasks with complete independent evidence | GIỮ |
| host-verification.ts:518 | `assertSupported` | Error | No owner-configured behavioral runner for ${criterion.verificationMethod} | THIẾU PHỤC HỒI |
| host-verification.ts:522 | `assertSupported` | Error | No complete owner-configured test mapping for ${criterion.id} | FINDING |
| host-verification.ts:524 | `assertSupported` | Error | No owner-configured argv for ${command} | THIẾU PHỤC HỒI |
| host-verification.ts:525 | `assertSupported` | Error | Configured behavioral reporters do not measure aggregate coverage | FINDING |
| host-verification.ts:544 | `assertTaskSupported` | WorkflowProposalRejected | if (!mapping?.testNames.length \|\| matched.length !== 1) throw new WorkflowProposalRejected | có kênh |
| host-verification.ts:559 | `assertTaskSupported` | rethrow | if (error instanceof WorkflowProposalRejected) throw error; const message = error instance | có kênh |
| host-verification.ts:562 | `assertTaskSupported` | WorkflowProposalRejected | throw new WorkflowProposalRejected({ code:  | có kênh |
| host-verification.ts:568 | `assertTaskSupported` | WorkflowProposalRejected | throw new WorkflowProposalRejected({ code:  | có kênh |
| host-verification.ts:578 | `assertTaskSupported` | WorkflowProposalRejected | throw new WorkflowProposalRejected({ code:  | có kênh |
| host-verification.ts:589 | `assertTaskSupported` | WorkflowProposalRejected | throw new WorkflowProposalRejected({ code:  | có kênh |
| host-verification.ts:597 | `assertTaskSupported` | WorkflowProposalRejected | throw new WorkflowProposalRejected({ code:  | có kênh |
| host-verification.ts:629 | `assertPolicyMethods` | WorkflowProposalRejected | if (missing.length) throw new WorkflowProposalRejected({ code:  | có kênh |
| host-verification.ts:638 | `assertDetectedSupported` | WorkflowProposalRejected | throw new WorkflowProposalRejected({ code: detection?.status ===  | có kênh |
| host-verification.ts:641 | `assertDetectedSupported` | WorkflowProposalRejected | const reject = (code: WorkflowRejectionCode, reason: string): never => { throw new Workflo | có kênh |
| host-verification.ts:663 | `assertDetectedSupported` | Error | Configured behavioral reporters do not measure aggregate coverage | FINDING |
| host-verification.ts:686 | `automaticGate` | TaskBlocker | no_test_identities | FINDING |
| host-verification.ts:702 | `mutationGate` | Error | Mutation check does not match owner configuration | FINDING |
| host-verification.ts:711 | `mutationGate` | Error | Mutation ${check.id} target not found in the integrated revision (${mutation.reason}); update .bflow | FINDING |
| host-verification.ts:799 | `appGate` | Error | Real-app check does not match owner configuration | FINDING |
| host-verification.ts:804 | `appGate` | Error | No accepted criterion selects real-app checks of ${suite.id} | FINDING |
| host-verification.ts:902 | `regressionGate` | Error | Regression check does not match host runner profile | GIỮ |
| host-verification.ts:1171 | `gate` | Error | Behavioral check does not match owner configuration | FINDING |
| host-verification.ts:1187 | `gate` | Error | Behavioral check does not match owner configuration | FINDING |
| host-verification.ts:1213 | `behavioralEvidence` | Error | Independent Tester or QA required | GIỮ |
| host-verification.ts:1215 | `behavioralEvidence` | Error | Behavioral tools accept only runId, taskId, phase and an assigned review judgment; measurements are  | FINDING |
| host-verification.ts:1217 | `behavioralEvidence` | Error | Unknown task | THIẾU PHỤC HỒI |
| host-verification.ts:1220 | `behavioralEvidence` | Error | Behavioral measurement requires an accepted matching task specification | FINDING |
| host-verification.ts:1222 | `behavioralEvidence` | Error | Prior behavioral phase lacks a trusted host receipt | GIỮ |
| host-verification.ts:1226 | `behavioralEvidence` | Error | Implementation assignment unavailable | THIẾU PHỤC HỒI |
| host-verification.ts:1228 | `behavioralEvidence` | Error | Implementer cannot verify its own change | GIỮ |
| host-verification.ts:1235 | `behavioralEvidence` | Error | This policy phase does not accept a manual review judgment | FINDING |
| host-verification.ts:1236 | `behavioralEvidence` | Error | Independent manual review required: inspect_alternative_verification with this phase, then submit it | GIỮ |
| host-verification.ts:1239 | `behavioralEvidence` | Error | Policy review source revision changed | THIẾU PHỤC HỒI |
| host-verification.ts:1264 | `behavioralEvidence` | Error | This strategy requires independent alternative evidence | GIỮ |
| host-verification.ts:1269 | `behavioralEvidence` | Error | Behavioral phase receipt belongs to another verifier binding | GIỮ |
| host-verification.ts:1270 | `behavioralEvidence` | Error | Conflicting immutable policy review judgment | GIỮ |
| host-verification.ts:1274 | `behavioralEvidence` | Error | Expected ${expected ??  | FINDING |
| host-verification.ts:1277 | `behavioralEvidence` | Error | Policy review assignment is no longer active | GIỮ |
| host-verification.ts:1279 | `behavioralEvidence` | Error | Policy review observation belongs to another verifier or is missing | GIỮ |
| host-verification.ts:1281 | `behavioralEvidence` | Error | Policy review observation has a stale assignment, attempt, phase or specification | GIỮ |
| host-verification.ts:1283 | `behavioralEvidence` | Error | Policy review source changed after inspection | THIẾU PHỤC HỒI |
| host-verification.ts:1288 | `behavioralEvidence` | HostBehavioralFailure | Independent manual review failed; request repairs | có kênh |
| host-verification.ts:1299 | `behavioralEvidence` | Error | Independent behavioral phase budget exhausted | THIẾU PHỤC HỒI |
| host-verification.ts:1303 | `behavioralEvidence` | rethrow | if (!(error instanceof NodeTapTestCodeFailure) && !(error instanceof RtkRequiredToolUnavai | có kênh |
| host-verification.ts:1315 | `behavioralEvidence` | HostBehavioralFailure | throw new HostBehavioralFailure(error.message, evidence, error instanceof NodeTapTestCodeF | có kênh |
| host-verification.ts:1320 | `behavioralEvidence` | Error | Committed diff integrity check failed | GIỮ |
| host-verification.ts:1332 | `behavioralEvidence` | HostBehavioralFailure | Required criteria have no executed mapped test: ${uncovered.map(item => item.id).join( | có kênh |
| host-verification.ts:1340 | `behavioralEvidence` | Error | Real-app prerequisite missing (${outcome.code}): ${outcome.message}; no behavioral evidence was reco | THIẾU PHỤC HỒI |
| host-verification.ts:1348 | `behavioralEvidence` | Error | Green/Refactor must preserve the exact committed Red test files and observed identities | FINDING |
| host-verification.ts:1349 | `behavioralEvidence` | Error | Green/Refactor require the implementation revision after Red | FINDING |
| host-verification.ts:1358 | `behavioralEvidence` | HostBehavioralFailure | throw new HostBehavioralFailure(phase ===  | có kênh |
| host-verification.ts:1364 | `behavioralEvidence` | Error | Red failure belongs to an unrelated test rather than an accepted target criterion | FINDING |
| host-verification.ts:1376 | `behavioralEvidence` | HostBehavioralFailure | Static analysis failed: ${staticAnalyses.filter(item => item.exitCode !== 0).map(item =>  | có kênh |
| host-verification.ts:1382 | `behavioralEvidence` | Error | Policy review assignment or source changed during independent measurement | GIỮ |
| host-verification.ts:1406 | `behavioralEvidence` | Error | No measured evidence for ${criterion.id} | FINDING |
| host-verification.ts:1419 | `judgments` | Error | Independent criterion judgments are required; submit criteria covering criterionId(s): ${ids.join( | GIỮ |
| host-verification.ts:1421 | `judgments` | Error | Criterion verdict must be boolean | FINDING |
| host-verification.ts:1438 | `judgments` | Error | Review must cover exactly the assigned criteria (${details}; expected: ${ids.join( | FINDING |
| host-verification.ts:1492 | `reworkDossierFor` | Error | Stale rework review attempt or generation | GIỮ |
| host-verification.ts:1495 | `reworkDossierFor` | Error | Missing rework dossier; historical state cannot supply independent finding evidence | GIỮ |
| host-verification.ts:1504 | `candidateEvidenceForDeveloper` | Error | Unknown candidate evidence task | GIỮ |
| host-verification.ts:1524 | `inspectReview` | Error | Independent verification role required | GIỮ |
| host-verification.ts:1529 | `inspectReview` | Error | No verification request assigned to this pane | GIỮ |
| host-verification.ts:1530 | `inspectReview` | Error | Replaced workflow review cannot create another observation | GIỮ |
| host-verification.ts:1533 | `inspectReview` | Error | Review role mismatch | GIỮ |
| host-verification.ts:1537 | `inspectReview` | Error | Rework dossier revision mismatch | GIỮ |
| host-verification.ts:1559 | `inspectReview` | Error | Review source changed during test integrity capture | GIỮ |
| host-verification.ts:1579 | `inspectReview` | Error | QA source changed during independent measurement | GIỮ |
| host-verification.ts:1755 | `requestTestIntegrityException` | Error | Independent Reviewer required for a test-integrity exception request | GIỮ |
| host-verification.ts:1759 | `requestTestIntegrityException` | Error | Review observation belongs to another pane or is missing | GIỮ |
| host-verification.ts:1762 | `requestTestIntegrityException` | Error | Unknown test-integrity finding ID | GIỮ |
| host-verification.ts:1764 | `requestTestIntegrityException` | Error | Test-integrity exception source changed | GIỮ |
| host-verification.ts:1792 | `completeReview` | Error | Review observation belongs to another pane or is missing | GIỮ |
| host-verification.ts:1797 | `completeReview` | Error | Review observation belongs to another verification request | GIỮ |
| host-verification.ts:1803 | `completeReview` | Error | Replaced workflow review cannot complete a stored observation | FINDING |
| host-verification.ts:1804 | `completeReview` | Error | Review role mismatch | GIỮ |
| host-verification.ts:1809 | `completeReview` | Error | Only Reviewer may submit test-integrity verdicts; omit testIntegrityVerdicts when completing a QA or | GIỮ |
| host-verification.ts:1818 | `completeReview` | Error | Test-integrity verdict requires a new inspect_review observation | GIỮ |
| host-verification.ts:1819 | `completeReview` | Error | Test-integrity report changed since review observation | GIỮ |
| host-verification.ts:1830 | `digest` | Error | Missing or stale rework observation binding | GIỮ |
| host-verification.ts:1835 | `digest` | Error | findingVerdicts must be an array | FINDING |
| host-verification.ts:1837 | `digest` | Error | Duplicate findingId in findingVerdicts | FINDING |
| host-verification.ts:1838 | `digest` | Error | findingVerdicts cannot be submitted for an initial non-rework review | FINDING |
| host-verification.ts:1854 | `digest` | Error | findings must be an array | FINDING |
| host-verification.ts:1864 | `digest` | Error | Finding at index ${idx} in complete_review findings requires a non-empty 'code' string | FINDING |
| host-verification.ts:1869 | `digest` | Error | Finding '${code}' at index ${idx} in complete_review findings requires a non-empty 'message' string | FINDING |
| host-verification.ts:1928 | `digest` | Error | Conflicting completion for an immutable review observation | GIỮ |
| host-verification.ts:1932 | `digest` | Error | Review source changed | THIẾU PHỤC HỒI |
| host-verification.ts:1935 | `digest` | Error | Workflow QA needs a new inspect_review observation with owner-run measurements; no old diff-only obs | GIỮ |
| host-verification.ts:1968 | `inspectAlternative` | Error | policy_review_paging_requires_phase | GIỮ |
| host-verification.ts:1969 | `inspectAlternative` | Error | Independent Tester or QA required | GIỮ |
| host-verification.ts:1973 | `inspectAlternative` | Error | Implementation assignment unavailable | THIẾU PHỤC HỒI |
| host-verification.ts:1974 | `inspectAlternative` | Error | Implementer cannot verify its own change | GIỮ |
| host-verification.ts:1975 | `inspectAlternative` | Error | Unknown task | THIẾU PHỤC HỒI |
| host-verification.ts:1988 | `alternativeEvidence` | Error | Independent Tester or QA required | GIỮ |
| host-verification.ts:1991 | `alternativeEvidence` | Error | Unknown task | THIẾU PHỤC HỒI |
| host-verification.ts:1998 | `alternativeEvidence` | Error | Configured behavioral measurement runner required for this strategy | FINDING |
| host-verification.ts:2001 | `alternativeEvidence` | Error | Implementation assignment unavailable | THIẾU PHỤC HỒI |
| host-verification.ts:2003 | `alternativeEvidence` | Error | Implementer cannot verify its own change | GIỮ |
| host-verification.ts:2007 | `alternativeEvidence` | Error | Inspect the assigned alternative evidence before submitting a judgment | FINDING |
| host-verification.ts:2009 | `alternativeEvidence` | Error | Alternative evidence source changed after inspection | THIẾU PHỤC HỒI |
| host-verification.ts:2011 | `alternativeEvidence` | Error | Alternative acceptance evidence failed; request repairs instead | GIỮ |
| host-verification.ts:2015 | `alternativeEvidence` | Error | Conflicting completion for an immutable alternative observation | GIỮ |
| host-development.ts:94 | `syncFileHandle` | rethrow | if (!code \|\| !BENIGN_FILE_SYNC_CODES.has(code)) throw error; } | có kênh |
| host-development.ts:130 | `identity` | Error | An assigned Developer worktree is required | GIỮ |
| host-development.ts:135 | `identity` | Error | Invalid Runtime assignment state | FINDING |
| host-development.ts:144 | `identity` | Error | No unique current task assignment for this Developer pane | THIẾU PHỤC HỒI |
| host-development.ts:152 | `relativePath` | Error | Developer path escapes its task workspace | GIỮ |
| host-development.ts:156 | `relativePath` | Error | Developer file tools may not traverse symlinks | GIỮ |
| host-development.ts:157 | `relativePath` | rethrow | catch (error) { if ((error as NodeJS.ErrnoException).code !==  | có kênh |
| host-development.ts:164 | `scope` | Error | Path '${path}' is outside the accepted task ownership | GIỮ |
| host-development.ts:176 | `isTestPath` | Error | Developer test aliases require a regular file with no hardlinks | GIỮ |
| host-development.ts:181 | `isTestPath` | rethrow | } catch (error) { if (!(error && typeof error ===  | có kênh |
| host-development.ts:186 | `isTestPath` | rethrow | throw error; } | có kênh |
| host-development.ts:213 | `refuseForResolver` | Error | ${tool} is not used for a conflict resolution assignment; edit only the conflicted files, commit the | GIỮ |
| host-development.ts:231 | `existedAtRevision` | rethrow | catch (error) { if (!this.runners.automatic \|\| !task.spec.specification.affectedPaths.some | có kênh |
| host-development.ts:263 | `existedAtRevision` | Error | Red test files are frozen after independent Red measurement | GIỮ |
| host-development.ts:274 | `authorizeFileEdit` | Error | Developer workspace is read-only | GIỮ |
| host-development.ts:275 | `authorizeFileEdit` | Error | Only scoped file-edit tools are supported | GIỮ |
| host-development.ts:280 | `authorizeFileEdit` | Error | Path '${path}' is not one of the conflicted files: ${resolution.conflictPaths.join( | GIỮ |
| host-development.ts:294 | `authorizeFileEdit` | Error | Developer workspace is read-only | GIỮ |
| host-development.ts:297 | `authorizeFileEdit` | Error | Unsafe Developer workspace file path | GIỮ |
| host-development.ts:299 | `authorizeFileEdit` | Error | Path '${path}' is not one of the conflicted files | GIỮ |
| host-development.ts:312 | `withFileParent` | Error | Host workspace file operations are unsupported without Linux descriptor-relative access | THIẾU PHỤC HỒI |
| host-development.ts:314 | `withFileParent` | Error | Developer workspace may not traverse symlinks | GIỮ |
| host-development.ts:318 | `withFileParent` | Error | Developer workspace moved during file access | GIỮ |
| host-development.ts:322 | `withFileParent` | rethrow | if (createParents) await mkdir(next, { mode: 0o755 }).catch((error: NodeJS.ErrnoException) | có kênh |
| host-development.ts:330 | `boundedFile` | Error | Developer file access requires a regular file with no hardlinks | GIỮ |
| host-development.ts:331 | `boundedFile` | Error | Developer file exceeds 128 KiB | FINDING |
| host-development.ts:340 | `boundedFile` | Error | Developer file exceeds 128 KiB | FINDING |
| host-development.ts:342 | `boundedFile` | Error | Developer file changed during read; inspect before retrying | THIẾU PHỤC HỒI |
| host-development.ts:348 | `assertRegularPath` | Error | Developer file access refuses symlinks, hardlinks and special files | GIỮ |
| host-development.ts:393 | `readWorkspaceFile` | rethrow | throw error; } | có kênh |
| host-development.ts:405 | `writeWorkspaceFile` | Error | Developer content must be valid UTF-8 within 128 KiB | FINDING |
| host-development.ts:418 | `writeWorkspaceFile` | Error | Prior file digest changed; read the file before retrying | GIỮ |
| host-development.ts:420 | `writeWorkspaceFile` | Error | Developer writes require a regular file with no hardlinks | GIỮ |
| host-development.ts:424 | `writeWorkspaceFile` | Error | Developer file write made no progress | GIỮ |
| host-development.ts:492 | `check` | Error | Profile-scoped Developer feedback subprocess is unsupported without whole-process write enforcement; | THIẾU PHỤC HỒI |
| host-development.ts:528 | `check` | rethrow | if (!blocker) throw error; return this.blockedReply(context, blocker.message, blocker); | có kênh |
| host-development.ts:537 | `check` | Error | check_work feedback artifact could not be stored (${stored.error.code}) | FINDING |
| host-development.ts:596 | `commitMergeResolution` | Error | Integration branch/revision changed; inspect before retrying a commit | THIẾU PHỤC HỒI |
| host-development.ts:598 | `commitMergeResolution` | Error | No merge is in progress in the integration worktree; the conflict cannot be concluded by this commit | GIỮ |
| host-development.ts:600 | `commitMergeResolution` | Error | Hidden Git index flags require reconciliation before committing | GIỮ |
| host-development.ts:607 | `commitMergeResolution` | Error | Path '${path}' is outside the conflicted files: ${resolution.conflictPaths.join( | GIỮ |
| host-development.ts:621 | `commitMergeResolution` | rethrow | else if (code !==  | có kênh |
| host-development.ts:623 | `commitMergeResolution` | Error | Conflict markers remain in '${path}' | GIỮ |
| host-development.ts:632 | `commitMergeResolution` | Error | Unmerged paths remain; resolve every conflicted file before committing | GIỮ |
| host-development.ts:640 | `commit` | Error | Invalid expected revision or commit message | FINDING |
| host-development.ts:647 | `commit` | Error | Task branch/revision changed; inspect before retrying a commit | THIẾU PHỤC HỒI |
| host-development.ts:649 | `commit` | Error | Hidden Git index flags require reconciliation before committing | GIỮ |
| host-development.ts:653 | `commit` | Error | Conflicts need explicit resolution | GIỮ |
| host-test-integrity.ts:32 | `measureTestIntegrity` | Error | Test integrity requires pinned Git revisions | GIỮ |
| host-test-integrity.ts:39 | `measureTestIntegrity` | Error | Test integrity changed-file limit exceeded (256); split the candidate for review | FINDING |
| host-test-integrity.ts:42 | `measureTestIntegrity` | Error | Test integrity capture deadline exceeded | GIỮ |
| host-test-integrity.ts:45 | `measureTestIntegrity` | Error | Test integrity needs a regular committed blob: ${revision}:${path} | GIỮ |
| host-test-integrity.ts:47 | `measureTestIntegrity` | Error | Test integrity blob/aggregate size limit exceeded | FINDING |
| host-test-integrity.ts:50 | `measureTestIntegrity` | Error | Test integrity cannot parse binary test/config: ${path} | GIỮ |
| host-test-integrity.ts:55 | `measureTestIntegrity` | Error | Test integrity cannot analyze a file type change: ${change.path} | GIỮ |
| host-test-integrity.ts:76 | `validateTestIntegrityEvidence` | Error | Test-integrity evidence revision '${anchor.revision}' for finding '${verdict.findingId}' differs fro | GIỮ |
| host-test-integrity.ts:83 | `validateTestIntegrityEvidence` | Error | Test-integrity evidence file limit exceeded | FINDING |
| host-test-integrity.ts:87 | `validateTestIntegrityEvidence` | Error | Test-integrity evidence for finding '${verdict.findingId}' requires an existing regular Git blob at  | GIỮ |
| host-test-integrity.ts:90 | `validateTestIntegrityEvidence` | Error | Test-integrity evidence blob bounds exceeded | GIỮ |
| host-test-integrity.ts:103 | `validateTestIntegrityEvidence` | Error | Test-integrity evidence excerpt does not match the exact committed line for finding '${verdict.findi | GIỮ |
| host-test-integrity.ts:113 | `adjudicateTestIntegrity` | Error | Duplicate test-integrity verdict ID | GIỮ |
| host-test-integrity.ts:124 | `adjudicateTestIntegrity` | Error | Test-integrity verdicts must cover exactly every observed finding ID (${details}) | GIỮ |
| host-test-integrity.ts:129 | `adjudicateTestIntegrity` | Error | Proven test-integrity violation '${verdict.findingId}' (${finding.ruleId}) requires owner exception  | GIỮ |
| integration-change.ts:99 | `restoreRejectedConflictMerge` | Error | Rejected merge restore requires pinned commit hashes | GIỮ |
| integration-change.ts:101 | `restoreRejectedConflictMerge` | Error | Integration HEAD no longer matches rejected merge commit | GIỮ |
| integration-change.ts:103 | `restoreRejectedConflictMerge` | Error | Integration worktree is no longer on the expected integration branch | FINDING |
| integration-change.ts:107 | `restoreRejectedConflictMerge` | Error | Rejected commit is not a two-parent integration merge | GIỮ |
| integration-change.ts:109 | `restoreRejectedConflictMerge` | Error | Rejected merge second parent does not match incoming task commit | GIỮ |
| integration-change.ts:115 | `restoreRejectedConflictMerge` | Error | Could not restore conflicted MERGE_HEAD after rejected resolution | GIỮ |
| integration-change.ts:123 | `captureIntegratedChange` | Error | Integration evidence needs pinned revisions | GIỮ |
| integration-change.ts:125 | `captureIntegratedChange` | Error | Integrated revision changed or worktree is dirty | THIẾU PHỤC HỒI |
| integration-change.ts:127 | `captureIntegratedChange` | Error | Unsupported index flags in integrated worktree | THIẾU PHỤC HỒI |
| integration-change.ts:133 | `captureIntegratedChange` | Error | Invalid integration numstat | FINDING |
| integration-change.ts:145 | `captureIntegratedChange` | Error | Integrated revision changed while capturing evidence | THIẾU PHỤC HỒI |
| mutation-check.ts:35 | `assertSafeFile` | Error | Mutation file must be a repository-relative path without traversal | GIỮ |
| mutation-check.ts:41 | `parseMutationChecks` | Error | mutationChecks must be an array | FINDING |
| mutation-check.ts:44 | `parseMutationChecks` | Error | Unknown mutation check configuration field | FINDING |
| mutation-check.ts:46 | `parseMutationChecks` | Error | Mutation check id must be safe | FINDING |
| mutation-check.ts:48 | `parseMutationChecks` | Error | Mutation find must be a nonempty string of at most 4096 characters | FINDING |
| mutation-check.ts:49 | `parseMutationChecks` | Error | Mutation replace must be a string of at most 4096 characters | FINDING |
| mutation-check.ts:50 | `parseMutationChecks` | Error | Mutation replace must differ from find | FINDING |
| mutation-check.ts:53 | `parseMutationChecks` | Error | Mutation expectFailingTests must be a nonempty list of unique test names | FINDING |
| mutation-check.ts:55 | `parseMutationChecks` | Error | Mutation check ${id} references an unknown behavioral command | FINDING |
| mutation-check.ts:57 | `parseMutationChecks` | Error | Mutation check ${id} expects tests that the behavioral command does not run | FINDING |
| mutation-check.ts:60 | `parseMutationChecks` | Error | Duplicate mutation check identity | GIỮ |
| mutation-check.ts:64 | `parseMutationChecks` | Error | Aggregate behavioral and mutation execution budget exceeds the host deadline | FINDING |
| mutation-check.ts:72 | `mutationChecks` | Error | Mutation check ${check.id} references an unknown behavioral command | FINDING |
| mutation-check.ts:86 | `createMutatedRevision` | Error | Mutation revision must be a full commit identity | GIỮ |
| mutation-check.ts:91 | `createMutatedRevision` | Error | Mutation ${check.id} target must be a committed regular file | FINDING |
| mutation-check.ts:93 | `createMutatedRevision` | Error | Mutation ${check.id} target is not UTF-8 text | FINDING |
| mutation-check.ts:96 | `createMutatedRevision` | Error | Mutation ${check.id} find text occurs ${count} times; make the owner pattern unique | FINDING |
| mutation-check.ts:108 | `createMutatedRevision` | Error | Mutated revision was not created | GIỮ |
| regression-results.ts:64 | `parseNodeTapRegression` | RegressionInfrastructureFailure | Regression runner requires complete Node TAP output | có kênh |
| regression-results.ts:67 | `parseNodeTapRegression` | RegressionInfrastructureFailure | Incomplete Node TAP plan | có kênh |
| regression-results.ts:72 | `parseNodeTapRegression` | RegressionInfrastructureFailure | Incomplete TAP counter: ${label} | có kênh |
| regression-results.ts:83 | `parseNodeTapRegression` | RegressionInfrastructureFailure | Regression TAP run reported cancelled tests | có kênh |
| regression-results.ts:86 | `parseNodeTapRegression` | RegressionInfrastructureFailure | Regression TAP run reported zero tests with non-zero exit code | có kênh |
| regression-results.ts:89 | `parseNodeTapRegression` | RegressionInfrastructureFailure | Regression TAP run exited non-zero without test failures | có kênh |
| regression-results.ts:192 | `parseVitestJsonRegression` | RegressionInfrastructureFailure | Missing Vitest trusted runtime error counter | có kênh |
| regression-results.ts:200 | `parseVitestJsonRegression` | RegressionInfrastructureFailure | Regression runner requires valid Vitest JSON output | có kênh |
| regression-results.ts:203 | `parseVitestJsonRegression` | RegressionInfrastructureFailure | Malformed Vitest JSON report | có kênh |
| regression-results.ts:209 | `parseVitestJsonRegression` | RegressionInfrastructureFailure | Invalid Vitest counter: ${key} | có kênh |
| regression-results.ts:220 | `parseVitestJsonRegression` | RegressionInfrastructureFailure | Missing Vitest testResults array | có kênh |
| regression-results.ts:227 | `parseVitestJsonRegression` | RegressionInfrastructureFailure | Vitest reported zero tests with non-zero exit code | có kênh |
| regression-results.ts:233 | `parseVitestJsonRegression` | RegressionInfrastructureFailure | Malformed Vitest file result | có kênh |
| regression-results.ts:237 | `parseVitestJsonRegression` | RegressionInfrastructureFailure | Malformed Vitest file result fields | có kênh |
| regression-results.ts:243 | `parseVitestJsonRegression` | RegressionInfrastructureFailure | Malformed Vitest assertion result | có kênh |
| regression-results.ts:268 | `parseVitestJsonRegression` | RegressionInfrastructureFailure | Vitest exited non-zero without test or runtime failures | có kênh |
| regression-results.ts:280 | `parseRegressionResult` | RegressionInfrastructureFailure | regression_budget_exceeded: regression test execution timed out | có kênh |
| regression-results.ts:289 | `parseRegressionResult` | RegressionInfrastructureFailure | Regression runner infrastructure failure (spawn, signal, aborted or truncated output) | có kênh |
| regression-results.ts:299 | `parseRegressionResult` | RegressionInfrastructureFailure | Unsupported regression reporter: ${String(reporter)} | có kênh |
| rework-causality.ts:30 | `textField` | Error | Expected nonempty string | FINDING |
| rework-causality.ts:363 | `buildReworkAssignmentContext` | Error | Task ${taskId} is not in rework_required state with a prior failed verification result | FINDING |
| rework-causality.ts:368 | `buildReworkAssignmentContext` | Error | Rework assignment for ${taskId} lacks a valid 40-char failedRevision | GIỮ |
| rework-causality.ts:538 | `verifyAndReadArtifact` | Error | Rework evidence artifact ${reference.artifactId} does not belong to run ${expectedRunId} / task ${ex | GIỮ |
| rework-causality.ts:542 | `verifyAndReadArtifact` | Error | Rework evidence artifact ${reference.artifactId} is not resolved in trusted ArtifactStore | GIỮ |
| rework-causality.ts:548 | `verifyAndReadArtifact` | Error | Rework evidence artifact ${reference.artifactId} could not be read from ArtifactStore | GIỮ |
| rework-causality.ts:556 | `verifyAndReadArtifact` | Error | Rework evidence artifact ${reference.artifactId} failed checksum or size verification | GIỮ |
| rework-causality.ts:585 | `storeJsonArtifact` | Error | ArtifactStore could not persist ${prefix} (${stored.error.code}: ${stored.error.message}) | GIỮ |
| rework-causality.ts:618 | `validateAndStoreReworkResolution` | Error | Rework submission for ${reworkContext.taskId} (reworkGeneration ${reworkContext.reworkGeneration}) i | FINDING |
| rework-causality.ts:626 | `validateAndStoreReworkResolution` | Error | Invalid rework findingResolution at index ${idx}: ${detail} | FINDING |
| rework-causality.ts:634 | `validateAndStoreReworkResolution` | Error | Duplicate findingId '${item.findingId}' in findingResolutions; each assigned finding must have exact | FINDING |
| rework-causality.ts:641 | `validateAndStoreReworkResolution` | Error | Rework submission is missing root-cause explanation for assigned finding(s). Missing findingId(s): $ | THIẾU PHỤC HỒI |
| rework-causality.ts:645 | `validateAndStoreReworkResolution` | Error | Rework submission references unknown or stale findingId(s) not in reworkGeneration ${reworkContext.r | GIỮ |
| rework-causality.ts:649 | `validateAndStoreReworkResolution` | Error | Rework finding with disposition 'blocked' cannot be submitted as 'succeeded'; submit with status 'bl | FINDING |
| rework-causality.ts:652 | `validateAndStoreReworkResolution` | Error | Blocked rework submission must include at least one finding with disposition 'blocked' or 'disputed' | FINDING |
| rework-causality.ts:657 | `validateAndStoreReworkResolution` | Error | Rework worktree has uncommitted changes; commit changes before submitting rework resolution | GIỮ |
| rework-causality.ts:665 | `validateAndStoreReworkResolution` | Error | Rework submission with status 'succeeded' has no new commit after failedRevision (${reworkContext.fa | FINDING |
| rework-causality.ts:676 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' evidence.runId (${ev.runId}) does not match run '${reworkCont | FINDING |
| rework-causality.ts:679 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' evidence.taskId (${ev.taskId}) does not match task '${reworkC | FINDING |
| rework-causality.ts:682 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' evidence.attemptId (${ev.attemptId}) does not match current a | FINDING |
| rework-causality.ts:685 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' evidence.reworkGeneration (${ev.reworkGeneration}) must match | FINDING |
| rework-causality.ts:690 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' evidence.coreGeneration (${ev.coreGeneration}) must match cur | FINDING |
| rework-causality.ts:696 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' has disposition 'disputed'; disputeReason is required with re | FINDING |
| rework-causality.ts:703 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' has disposition 'addressed' but worktree HEAD (${worktreeStat | FINDING |
| rework-causality.ts:708 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' evidence.sourceRevision (${ev.sourceRevision}) must match the | FINDING |
| rework-causality.ts:713 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' discriminatingCheck must distinguish beforeOutcome from after | FINDING |
| rework-causality.ts:718 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' has disposition 'addressed' but discriminatingCheck.exitCode  | FINDING |
| rework-causality.ts:725 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' (${input.disposition}) evidence.sourceRevision (${ev.sourceRe | FINDING |
| rework-causality.ts:734 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' sourceLocation '${loc.path}' is inside forbiddenPaths | FINDING |
| rework-causality.ts:737 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' sourceLocation '${loc.path}' is outside task ownedPaths (${ow | GIỮ |
| rework-causality.ts:743 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' sourceLocation '${loc.path}' is not a regular file | FINDING |
| rework-causality.ts:750 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' sourceLocation '${loc.path}' line ${maxLine} exceeds file lin | FINDING |
| rework-causality.ts:757 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' sourceLocation '${loc.path}' does not exist in worktree | FINDING |
| rework-causality.ts:760 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' sourceLocation '${loc.path}' is not a regular file | FINDING |
| rework-causality.ts:762 | `validateAndStoreReworkResolution` | rethrow | throw error; } | có kênh |
| rework-causality.ts:767 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' has disposition 'addressed', but none of its sourceLocations  | FINDING |
| rework-causality.ts:780 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' evidence references a check_work artifact recorded at revisio | FINDING |
| rework-causality.ts:785 | `validateAndStoreReworkResolution` | Error | Rework finding '${assigned.findingId}' evidence artifact ${ev.artifactRef.artifactId} was recorded f | FINDING |
| rework-causality.ts:938 | `digest` | Error | Rework resolution dossier identity, generation, or reworkContext mismatch | GIỮ |
| rework-causality.ts:942 | `digest` | Error | Rework resolution dossier submittedRevision (${dossier.submittedRevision}) does not match clean work | GIỮ |
| rework-causality.ts:946 | `digest` | Error | Rework resolution dossier with submissionStatus 'succeeded' has no new commit after failedRevision ( | GIỮ |
| rework-causality.ts:959 | `digest` | Error | Rework finding '${resolution.findingId}' addressed evidence sourceRevision mismatch | FINDING |
| rework-causality.ts:962 | `digest` | Error | Rework finding '${resolution.findingId}' sourceLocations violate task path ownership | FINDING |
| rework-causality.ts:965 | `digest` | Error | Rework finding '${resolution.findingId}' sourceLocations do not intersect changed files in ${worktre | FINDING |
| rework-causality.ts:998 | `reworkVerificationBinding` | Error | Rework dossier identity, generation or required finding set mismatch | GIỮ |
| rework-causality.ts:1056 | `parseRequiredFindingVerdicts` | Error | Missing required findingVerdicts for independent rework verification; required findingId(s): ${[...r | GIỮ |
| rework-causality.ts:1061 | `parseRequiredFindingVerdicts` | Error | Duplicate findingId in findingVerdicts | FINDING |
| rework-causality.ts:1064 | `parseRequiredFindingVerdicts` | Error | Unknown findingId '${verdict.findingId}' in rework findingVerdicts; valid findingId(s): ${[...allowe | FINDING |
| rework-causality.ts:1070 | `parseRequiredFindingVerdicts` | Error | Missing required findingVerdicts for independent rework verification; missing findingId(s): ${missin | GIỮ |
| rework-causality.ts:1109 | `digest` | Error | Missing or stale independent rework verification binding | GIỮ |
| rework-causality.ts:1113 | `digest` | Error | Passed gate contradicts rejected finding verdict | FINDING |
| rework-causality.ts:1121 | `reworkVerificationVerdicts` | Error | Rework result task, generation or revision mismatch | GIỮ |
| rework-causality.ts:1125 | `reworkVerificationVerdicts` | Error | Missing independent rework finding verdicts | GIỮ |
| rework-causality.ts:1137 | `reworkVerificationVerdicts` | Error | Missing independent rework finding verdicts for findingId '${f.findingId}' | GIỮ |
