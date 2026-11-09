# Kế hoạch: từ "khai trước rồi bắt khớp" sang "quan sát rồi chấm"

- Trạng thái: **đã duyệt** bởi chủ dự án ngày 2026-11-09 (D1–D3 bên dưới)
- Phạm vi: `packages/runtime/**`, `agents/coordinator/**`, `packages/contracts/**` (chỉ D2, D3), docs liên quan
- Mức bằng chứng hiện tại: kế hoạch. Chưa có mã nguồn, chưa có test, chưa có xác nhận live.

## 1. Bối cảnh

Run tối ưu chat ngày 06/11 mất khoảng 95 phút mà chưa tới bước triển khai. Trong đó khoảng 42 phút là chuỗi thử lại khi nguyên nhân không đổi:

- Kế hoạch khai 4 tệp test trong `specification.affectedPaths`, nhưng cả ba commit của Developer chỉ có 2 tệp. Hai tệp còn lại là test live dự kiến viết sau.
- `automaticTestPaths` (`packages/runtime/src/agentic/task-commands.ts:122`) lấy danh sách test từ lời khai đó.
- `runMeasurementCommand` (`packages/runtime/src/agentic/behavioral-runner.ts:398-402`) bắt từng đường dẫn phải là blob đã commit. Thiếu một tệp là ném `Behavioral test identity must be a committed regular file`.
- `check_work` gắn mọi lỗi chọn runner vào `classification: "infrastructure"` và bảo "sửa môi trường rồi gọi lại" (`host-development.ts:485`). Đây là phân loại sai cho lỗi lệch kế hoạch.
- Không có cơ chế nào phát hiện "cùng lỗi, kế hoạch không đổi" trong giai đoạn thực thi. Chống lặp theo dấu vân tay chỉ có ở giai đoạn đề xuất (`runtime.ts:2286`, `recordProposalRejection`). Ở thực thi chỉ có trần số lần thử (`VERIFICATION_ATTEMPT_LIMIT = 3` trong `auto-park.ts`).
- Khi run đã ở `completed_with_parked`, Director không có đường hợp lệ để sửa phạm vi. `reresolveExecutionPlan` chỉ tự gắn lại thay đổi thuần repository.

Bảng so sánh với ai-sdlc (`speckit/runmethod/ai-sdlc`):

| Khía cạnh | bflow hiện tại | ai-sdlc |
|---|---|---|
| Nguồn danh sách test | Lời khai kế hoạch (`affectedPaths`) | Diff thật của task (`{changed_tests}`, `runtime/gate/core/test_scope.py`; `split_changed` trong `tdd_red.py`) |
| Chứng minh TDD Red | Đo Red độc lập trên tệp đã khai | Ghép test của HEAD lên cây mã BASE rồi chạy (`runtime/gate/core/tdd_red.py`) |
| Tệp ngoài kế hoạch | Bị chặn (`ownedPaths` ⊆ `affectedPaths` literal) | Tệp mới được phép (`runtime/gate/core/task_scope.py`, luật 4) |
| Lặp không tiến triển | Thử tới trần rồi park | So khóa tiến triển giữa các vòng (`review_progress_keys`, `runtime/dispatch/core/feedback.py`) và bắt ghi nguyên nhân gốc (`root_cause.py`) |

Lỗi này không phải bug lẻ. bflow bắt kế hoạch khai chính xác từ đầu (`affectedPaths`, `criterionMappings.testNames`, `targetCommands`, `ownedPaths`), rồi chặn cứng khi thực tế không khớp, và nhiều chỗ chặn không có đường phục hồi. Kế hoạch này đổi nguyên tắc đó theo từng bước, không viết lại lõi verification.

## 2. Bất biến không được đổi

- Test dùng để chấm phải là blob đã commit và bị ghim theo revision.
- Đo Red độc lập vẫn giữ. Tệp test bị đóng băng sau Red (`host-development.ts:241`).
- Giữ nguyên `host-test-integrity`, mutation check, lease/fencing, approval của người dùng, giới hạn rework và verification.
- Không coi Herdr `done` hay output của agent là bằng chứng thành công.

## 3. Quyết định đã duyệt

| Mã | Quyết định | Ảnh hưởng |
|---|---|---|
| **D1** | Với tệp test, `Specification.affectedPaths` chỉ là **dự kiến**, không bắt buộc tồn tại. Danh tính test để chấm = diff `base..HEAD` của task ∩ ownership ∩ ngôn ngữ và project của runner. `criterionMappings` vẫn bắt buộc. | Schema không đổi. Cập nhật `docs/sdlc-policies.md`, `docs/verification-runners.md`. |
| **D2** | Thêm `ParkedIssueKind = "plan_mismatch"` vào contracts. | `packages/contracts`. Phải đi kèm compatibility plan: reader cũ gặp kind lạ thì từ chối, không ép kiểu. |
| **D3** | Tạo tool mới `amend_task_scope` cho Coordinator. Thu hẹp phạm vi (hoặc sửa bên trong ownership hiện có) thì Runtime tự duyệt. Mở rộng ownership thì phải qua thẻ quyết định của người dùng. | Contracts của MCP tool, prompt Coordinator, coordinator guide. |

## 4. Thứ tự và khả năng song song

```
GĐ0  Phân loại lỗi chặn ─────────────────────────┐ (tuần tự, chặn mọi bước sau)
   │
   ├──► GĐ1  Cầu dao không tiến triển   ┐
   ├──► GĐ2  Lấy test từ diff            ├─ [∥ SONG SONG]
   ├──► GĐ4a Kiểm kê guard (chỉ đọc)     │  (4a có thể bắt đầu ngay, trước cả GĐ0)
   └──► GĐ4b Test bất biến registry      ┘
              │
   GĐ1 xong ──► GĐ3  Sửa phạm vi trong run
               (thiết kế và contract của GĐ3 [∥] với GĐ1 và GĐ2; phần cài đặt chờ GĐ1)
   GĐ1 và GĐ2 xong ──► GĐ4c Chuyển các guard ưu tiên (làm dần)
   GĐ0–GĐ3 xong ──► GĐ5  Kiểm chứng live (tuần tự)
```

Ký hiệu: **[TT]** = tuần tự, nằm trên đường găng. **[∥]** = làm song song được.

## 5. Chi tiết từng giai đoạn

### GĐ0: Phân loại lỗi chặn [TT], khoảng 1–2 ngày

Mục tiêu: mọi lỗi chặn trên đường thực thi có mã định danh, có bên sửa được và có hành động kế tiếp. Giai đoạn này **không đổi hành vi chặn**, chỉ đổi phân loại và thông điệp.

1. Tạo tệp mới `packages/runtime/src/agentic/blockers.ts`, private trong runtime, không thuộc contract:
   - `type BlockerCode`: `declared_test_missing`, `runner_identity_unselectable`, `criterion_without_test`, `runner_unavailable`, `environment_blocked`, … (mở rộng dần).
   - `type BlockerFixableBy = "developer" | "director" | "user" | "environment" | "runtime"`.
   - `class TaskBlocker extends Error { code; fixableBy; nextAction; details }`.
   - Registry `BLOCKERS: Record<BlockerCode, { fixableBy; nextAction }>`, được kiểm tra đủ mọi mã lúc compile.
2. Thay các chỗ ném lỗi chuỗi:
   - `behavioral-runner.ts:401`: gom **mọi** tệp thiếu rồi mới ném `TaskBlocker("declared_test_missing", fixableBy: "director")`, thay vì dừng ở tệp đầu tiên.
   - `task-commands.ts`: các chỗ ném `runner_identity_unselectable`.
   - `host-verification.ts` (`automaticGate`): lỗi "has no test identities for this task".
3. Ở `host-development.ts` (`check_work`), tách phần dựng phản hồi `blocked` thành một hàm riêng (ví dụ `blockedReply(context, blocker)`). Hàm này đọc `fixableBy` để trả về `classification` và `recovery` cho đúng. Với nhóm `director`, thông điệp phải nói rõ: "kế hoạch khai X, Y nhưng commit không có; Developer không sửa được, hãy báo Coordinator".
   - Việc tách hàm này là ranh giới để GĐ1 và GĐ2 không cùng sửa một đoạn mã.
4. Test:
   - Unit test cho registry.
   - Fixture "khai 4 tệp, commit 2 tệp": kết quả phải là `declared_test_missing`, `fixableBy=director`, kèm đủ 2 tệp thiếu.

Bàn giao: merge riêng được, rủi ro thấp. Nhánh: `fix/runtime/blocker-taxonomy`.

### GĐ1: Cầu dao không tiến triển [TT, ∥ với GĐ2], khoảng 3–5 ngày

1. Tạo tệp mới `packages/runtime/src/agentic/no-progress.ts`:
   - `blockerFingerprint = digest(code, taskId, specDigest, strategyDigest, tree hash của ownedPaths tại HEAD)`.
   - Cùng dấu vân tay nghĩa là cả kế hoạch lẫn mã đều chưa đổi.
2. Thêm `TaskRecord.blockerHistory: { fingerprint, code, at, attemptId }[]` vào journal, giữ tối đa 10 mục.
   - **Phải xác minh trước khi cài:** field optional có cần nâng version journal (hiện là v7) và viết upcaster không. Không được tự dựng trạng thái recovery bị thiếu.
3. Chèn điểm kiểm tra vào các đường giao lại: rework dispatch, verification retry trong `runtime.ts`, và `auto-park.ts`. Khi gặp **cùng dấu vân tay lần thứ 2**, không giao lại cho Developer mà định tuyến theo `fixableBy`:
   - `director`: gửi Coordinator thông báo `plan_mismatch` kèm danh sách tệp và tiêu chí liên quan, cùng gợi ý gọi `amend_task_scope`. Trước khi GĐ3 xong, park task với kind `plan_mismatch`.
   - `environment`: park `environment` ngay, không đợi hết 3 lần.
   - `user`: tạo thẻ quyết định.
   - `developer`: vẫn rework, nhưng lần tiếp theo cùng dấu vân tay thì park `rework_exhausted`.
4. Dùng lại khuôn của `recordProposalRejection` (`runtime.ts:2286`) cho thống nhất. Nếu tách được thì gom hai chỗ vào một helper.
5. Telemetry trong `bflow status --telemetry`: số lần cầu dao ngắt, phân theo mã.
6. Test:
   - Kịch bản dựng lại lỗi 06/11 bằng fake runner: lần chặn thứ 2 không tạo assignment Developer thứ 3; Coordinator nhận `plan_mismatch`.
   - Commit mới làm đổi tree thì dấu vân tay đổi theo, và vẫn được thử lại.
   - Restart host giữa hai lần chặn: lịch sử dấu vân tay vẫn còn.

Tệp sở hữu: `no-progress.ts` (mới), `runtime.ts` (đường giao lại), `auto-park.ts`, journal, hàm `blockedReply`. Không chạm `task-commands.ts` hay `behavioral-runner.ts`. Nhánh: `fix/runtime/no-progress-breaker`.

### GĐ2: Lấy danh tính test từ diff [∥ với GĐ1], khoảng 1–1,5 tuần

1. Viết hàm `observedTestPaths(profile, changedPaths, ownedPaths)` trong `task-commands.ts`. Đầu vào là diff `baseCommit..HEAD` của task. Lọc giữ tệp đúng `testFilePattern`, đúng ngôn ngữ của runner (`matchesRunnerFile`), nằm trong project của runner và trong ownership. Giữ nguyên các quy tắc riêng cho Rust/Cargo.
2. `resolveTaskCommands` nhận thêm input optional `changedPaths`:
   - Có `changedPaths`: `testPaths` = tập quan sát được. Tệp khai mà thiếu được trả về `coverageGaps` (chỉ để thông tin), không ném lỗi.
   - Không có (giai đoạn đề xuất, chưa có commit): giữ hành vi cũ, chỉ dùng để thẩm định kế hoạch.
3. Truyền diff ở các bên gọi:
   - `host-development.ts` (`commandsFor` trong `check_work`).
   - `host-verification.ts` (`automaticGate`, phần đo Red độc lập).
4. Kiểm độ phủ tiêu chí sau khi chạy test:
   - Mỗi tiêu chí bắt buộc phải có ít nhất một tên trong `criterionMappings.testNames` xuất hiện trong báo cáo runner (`runner-results.ts`, `vitest-json.ts`, `node-tap.ts`).
   - Thiếu thì sinh finding `criterion_without_test` (`fixableBy=developer`) và đi theo rework thường.
5. Lúc đề xuất workflow (`host-verification.ts`, `assertDetectedSupported`, mã `missing_test_paths`):
   - Kế hoạch vẫn phải có `criterionMappings` và runner hợp lệ.
   - Đường dẫn test chỉ cần khai thư mục, hoặc khai tệp dự kiến. Không yêu cầu tệp đã tồn tại.
6. Rà nơi tiêu thụ `testPaths` để giữ nhất quán:
   - Đóng băng tệp test sau Red: tập bị đóng băng = tập đã đo Red.
   - `host-test-integrity.ts`, `mutation-check.ts`, `review-candidate-evidence.ts`, `rework-causality.ts`, `app-check-selection.ts`, `execution-binding.ts`.
7. Test:
   - Khai 4 tệp, commit 2 tệp đủ tên test: đạt.
   - Commit thêm một tệp test ngoài kế hoạch nhưng trong ownership: được chạy.
   - Tiêu chí không có test: ra finding, không ném exception.
   - Tệp test ngoài ownership: không được chọn.
   - **Chống gian lận vẫn giữ** (điều kiện để merge): sửa test sau Red bị chặn; test yếu đi bị `host-test-integrity` bắt; test không bao giờ đỏ bị bắt; blob vẫn bị ghim.
8. Cập nhật docs theo D1: `docs/sdlc-policies.md`, `docs/verification-runners.md`.

Tệp sở hữu: `task-commands.ts`, `behavioral-runner.ts`, `host-verification.ts`, các tệp runner-results. Trong `host-development.ts`, chỉ sửa `commandsFor` và chỗ truyền `changedPaths`. Nhánh: `fix/runtime/observed-test-identity`.

### GĐ3: Sửa phạm vi trong run [TT sau GĐ1], khoảng 1–1,5 tuần

Thiết kế, contract (D2, D3) và prompt có thể chuẩn bị song song với GĐ1 và GĐ2. Phần cài đặt chờ GĐ1, vì cùng sửa `runtime.ts` và cần đường định tuyến `director`.

1. Contracts:
   - Thêm `ParkedIssueKind = "plan_mismatch"` (D2).
   - Thêm schema input/output cho `amend_task_scope` (D3).
   - Kèm ghi chú compatibility và migration.
2. Tool `amend_task_scope(runId, taskId, changes)` cho Coordinator. Chỉ cho phép:
   - Bỏ tệp test chưa tồn tại khỏi `affectedPaths`.
   - Thêm hoặc bỏ tệp test **bên trong** ownership hiện có.
   - Sửa mapping `testNames` của một tiêu chí.
   - Mở rộng ownership: tạo thẻ quyết định cho người dùng. Chỉ áp dụng sau khi người dùng duyệt.
3. Runtime tự kiểm bất biến, không tin Coordinator:
   - Không đổi nội dung tiêu chí.
   - Không waive tiêu chí.
   - Mọi tiêu chí bắt buộc vẫn có mapping.
   - Đường dẫn mới đúng literal và nằm trong phạm vi đã duyệt.
4. Mỗi lần sửa nâng phiên bản spec. Ghi sự kiện journal kèm diff phạm vi để truy vết từ spec sang task. Cập nhật digest của execution plan để logic drift không coi đây là thay đổi lạ.
5. Cho phép khi run ở `completed_with_parked` nếu task bị park với kind `plan_mismatch`: sửa xong thì unpark (dùng lại nhánh `runtime.ts:2248`), xóa `blockerHistory` của task đó, rồi giao lại.
6. Prompt Coordinator (`agents/coordinator/**`) và coordinator guide: khi nhận `plan_mismatch` thì gọi `amend_task_scope`, không giao lại cho Developer. Lưu ý quy tắc skill: đường dẫn trong backtick trở thành ref bắt buộc, nên viết đường dẫn bằng văn xuôi và nhớ bump version.
7. Test:
   - Trọn vòng kịch bản 06/11: cầu dao ngắt, Coordinator sửa phạm vi, Developer chạy lại, run hoàn tất. Không tạo run mới.
   - Đề xuất waive tiêu chí bị từ chối.
   - Mở rộng ownership tạo thẻ duyệt.

Nhánh: `fix/runtime/in-run-scope-amend`.

### GĐ4: Chặn dứt điểm kiểu sửa theo từng lỗi

| Bước | Thời điểm | Nội dung |
|---|---|---|
| **4a** Kiểm kê [∥] | Bắt đầu ngay, chỉ đọc | Liệt kê mọi `throw` hoặc `reject` trên đường thực thi trong `packages/runtime/src/agentic`. Xếp mỗi chỗ vào một nhóm: **giữ chặn cứng** (bảo mật, chống gian lận, lease/fence, approval), **chuyển thành finding/cảnh báo**, hoặc **thiếu đường phục hồi**. Đối chiếu tần suất thật từ journal của các run đã chạy (`.bflow/state`). Kết quả là một bảng danh mục. |
| **4b** Test bất biến [∥ sau GĐ0] | Song song với GĐ1 và GĐ2 | Test quét registry: mã nào cũng phải có `fixableBy` và `nextAction` không rỗng. Thêm lint chặn `throw new Error(` mới trong các tệp đường thực thi đã đánh dấu, buộc dùng `TaskBlocker`. |
| **4c** Chuyển đổi | Sau GĐ1 và GĐ2, làm dần | Chuyển 5–10 guard có tần suất cao nhất theo danh mục 4a. Mỗi guard là một PR nhỏ kèm test. |

Nhánh: `fix/runtime/blocker-audit`.

### GĐ5: Kiểm chứng live [TT], khoảng 1–2 ngày

1. Chạy một run Web SDLC thật trên repo mẫu, cố tình để kế hoạch khai thừa tệp test. Ghi lại thời gian từ lỗi đầu tiên đến khi gỡ được (mốc trước là khoảng 42 phút).
2. Chạy lại các kịch bản chống gian lận đã có (e2e và acceptance).
3. Báo cáo theo mức bằng chứng tách riêng: mã nguồn, test cục bộ, live. Không gộp các mức.

## 6. Chia tệp để chạy song song không xung đột

| GĐ | Tệp chính | Nhánh |
|---|---|---|
| 0 | `blockers.ts` (mới), `behavioral-runner.ts:401`, `task-commands.ts` (chỗ ném lỗi), `host-development.ts` (tách `blockedReply`) | `fix/runtime/blocker-taxonomy` |
| 1 | `no-progress.ts` (mới), `runtime.ts`, `auto-park.ts`, journal, `blockedReply` | `fix/runtime/no-progress-breaker` |
| 2 | `task-commands.ts`, `behavioral-runner.ts`, `host-verification.ts`, runner-results, `commandsFor` | `fix/runtime/observed-test-identity` |
| 3 | contracts, `runtime.ts` (tool mới), `tools.ts`, `agents/coordinator/**` | `fix/runtime/in-run-scope-amend` |
| 4a/4b | Tài liệu kiểm kê, test registry, lint | `fix/runtime/blocker-audit` |

- GĐ1 và GĐ3 cùng sửa `runtime.ts`, nên không làm song song.
- GĐ1 và GĐ2 cùng chạm `host-development.ts`, nhưng ở hai hàm khác nhau. Việc tách `blockedReply` ở GĐ0 là ranh giới giữa hai bên.
- Mỗi nhánh tạo từ baseline đã chứa GĐ0, dùng một worktree riêng (theo `AGENTS.md`).

## 7. Effort ước lượng

Ước lượng từ việc đọc mã, chưa phải cam kết.

| GĐ | Effort | Đường găng |
|---|---|---|
| 0 | 1–2 ngày | Có |
| 1 | 3–5 ngày | Có |
| 2 | 1–1,5 tuần | Song song với 1 |
| 3 | 1–1,5 tuần | Có, sau 1 |
| 4a/4b | 2–3 ngày | Song song |
| 4c | Làm dần | Không |
| 5 | 1–2 ngày | Có |

- Phần cốt lõi (GĐ0, 1, 2, 3, 5) mất khoảng **3–4 tuần** nếu chạy song song đúng sơ đồ.
- Riêng GĐ0 và GĐ1 (khoảng 1 tuần) đã đủ chặn kiểu vòng lặp không tiến triển cho mọi luồng.

## 8. Rủi ro và biện pháp

| Rủi ro | Biện pháp |
|---|---|
| GĐ2 nới lỏng làm mất khả năng chống gian lận | Giữ bất biến ở mục 2. Bộ test chống gian lận là điều kiện để merge. |
| Thêm field journal làm vỡ recovery | Xác minh codec trước. Nâng version và viết upcaster nếu cần. Có test restart. |
| `amend_task_scope` thành cửa sau | Chỉ cho thu hẹp hoặc sửa bên trong ownership. Mở rộng bắt buộc qua thẻ duyệt. Runtime tự kiểm bất biến. |
| Dấu vân tay quá nhạy, ví dụ đổi tệp không liên quan cũng làm reset | Chỉ băm tree của `ownedPaths` cùng digest của spec và strategy. Test cả hai chiều. |
| Dấu vân tay quá thô, ngắt oan | Chỉ ngắt từ lần thứ 2 và có định tuyến rõ ràng. Telemetry đếm số lần ngắt để hiệu chỉnh. |

## 9. Kiểm tra trước khi bàn giao mỗi giai đoạn

```bash
pnpm check:deps
pnpm typecheck
pnpm test:affected --base <baseline> --run
git diff --check
git status --short
```

Báo cáo lệnh chính xác, exit code, số test đạt/lỗi/bỏ qua, HEAD đã test và mức bằng chứng.
