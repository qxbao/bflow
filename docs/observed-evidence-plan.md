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

**Cơ chế vòng lặp, đã xác minh trong mã (2026-11-09):**

1. Tester/QA gọi đo phase (`HostVerification.behavioralEvidence`, `host-verification.ts:1120`). Lỗi `Behavioral test identity...` là `Error` thường, không phải `HostBehavioralFailure`.
2. `host.ts:2494` gọi `recordPhaseFailure(..., repairable = error instanceof HostBehavioralFailure)`, nên lỗi này thành `repairable: false`.
3. `recoverPhaseFailures` (`runtime.ts:5467-5476`) đưa run vào `escalated` với `Policy measurement blocked: …` và `pendingAction` `resume_coordinator`, `recovery: "manual"`. Thông điệp này nói đây là lỗi hạ tầng và "sửa xong thì resume để đo lại cùng revision".
4. Khi resume thủ công (`runtime.ts:3058-3066`), mọi `phaseFailure` có `repairable === false` của run được gắn `retryAuthorized = true`. Resume cũng cấp lại ngân sách tự động mới (`action.resumeAttempts = 0`, `recovery = "auto_resume"`).
5. Hệ quả: đo lại **cùng revision, cùng spec**, ra lại đúng lỗi cũ. Không có gì so sánh "lần này có khác lần trước không". Chỉ `MANUAL_RESUME_LIMIT = 3` (`runtime.ts:149`) chặn được, và đó là trần tính trên số lần người dùng resume.
6. Auto-park không cứu được: `selectAutoParkCandidates` (`auto-park.ts:119-121`) chỉ nhận nguồn `verification.requested` khi `source.phaseFailure === undefined`. Task kẹt vì phase failure nên **không bao giờ được auto-park**.

Kết luận: chỉ sửa cách chọn test (GĐ2) vẫn chưa đủ. Mọi lỗi đo "không sửa được bằng resume" đều có thể lặp theo đúng cơ chế trên. Vì vậy GĐ0 và GĐ1 xử lý chính cơ chế này.

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
| **D2** | Thêm `ParkedIssueKind = "plan_mismatch"` vào contracts. Làm trong **GĐ1**, vì cầu dao cần kind này để park. | `packages/contracts/src/director.ts:60`. Phải đi kèm compatibility plan: reader cũ gặp kind lạ thì từ chối, không ép kiểu. |
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
   GĐ0 xong ──► GĐ6  Cổng nhận theo task + analyzer cho mọi loại tệp
               (∥ với GĐ4c; nhánh cổng nhận merge trước nhánh analyzer)
   GĐ0–GĐ3 và GĐ6 xong ──► GĐ5  Kiểm chứng live (tuần tự)
```

Ký hiệu: **[TT]** = tuần tự, nằm trên đường găng. **[∥]** = làm song song được.

## 5. Chi tiết từng giai đoạn

### GĐ0: Phân loại lỗi chặn [TT], khoảng 1,5–2 ngày

- Trạng thái: **đã cài đặt T0.1–T0.5 trên nhánh `fix/runtime/blocker-taxonomy`; T0.6 chưa đạt** vì `test:affected` báo một test cũ đỏ khi chạy đồng thời và đã dừng theo quy tắc bàn giao. Mức bằng chứng: mã nguồn + test cục bộ mục tiêu; chưa kiểm chứng live.

Mục tiêu: lỗi chặn trên đường đo test có mã định danh, có bên sửa được và có hành động kế tiếp. Giai đoạn này **không đổi trạng thái run hay luồng resume**. Chỉ đổi kiểu lỗi, thông điệp và phản hồi `check_work`. Không đụng journal hay contract.

Tương thích ngược: chỉ lỗi thuộc kiểu `TaskBlocker` mới mang phân loại mới. Mọi `Error` thường giữ nguyên hành vi, nên các test hạ tầng hiện có vẫn đúng, ví dụ `integration-connected-phases.test.ts:158` kỳ vọng `classification: "infrastructure"` cho lỗi môi trường.

Ghi chú về công cụ trong repo: `grep` và `rg` trong shell có thể bị hook bọc lại; dùng `command grep` khi cần cú pháp gốc.

#### T0.1 Tạo `blockers.ts` (viết test trước)

Test mới `packages/runtime/test/agentic/blockers.test.ts`:
- Mọi mã trong `BLOCKERS` có `fixableBy` hợp lệ và `nextAction` không rỗng.
- `new TaskBlocker(code, msg, details)` có `instanceof Error`; `code`, `fixableBy` và `nextAction` lấy từ registry.
- `blockerOf(error)` trả về blocker với `TaskBlocker`, trả `undefined` với `Error` thường.
- `isResumable(blocker)` chỉ trả `true` khi `fixableBy` là `environment` hoặc `runtime`.

Mã tệp `packages/runtime/src/agentic/blockers.ts`:

```ts
import type { JsonValue } from "@bflow/contracts";

export type BlockerFixableBy = "developer" | "director" | "user" | "environment" | "runtime";

export const BLOCKERS = {
  declared_test_missing: { fixableBy: "director",
    nextAction: "Kế hoạch khai tệp test chưa có trong commit. Resume không sửa được: hoặc giao Developer viết đúng các tệp đó, hoặc thu hẹp phạm vi test." },
  runner_identity_unselectable: { fixableBy: "director",
    nextAction: "Không gắn được tên test của tiêu chí vào đúng một runner. Sửa criterionMappings hoặc tách tiêu chí." },
  no_test_identities: { fixableBy: "director",
    nextAction: "Task không có danh tính test nào khớp runner. Kiểm criterionMappings, đường dẫn test và ownership." },
} as const satisfies Record<string, { fixableBy: BlockerFixableBy; nextAction: string }>;

export type BlockerCode = keyof typeof BLOCKERS;

export class TaskBlocker extends Error {
  readonly fixableBy: BlockerFixableBy;
  readonly nextAction: string;
  constructor(readonly code: BlockerCode, message: string, readonly details: Readonly<Record<string, JsonValue>> = {}) {
    super(message);
    this.name = `TaskBlocker[${code}]`;
    this.fixableBy = BLOCKERS[code].fixableBy;
    this.nextAction = BLOCKERS[code].nextAction;
  }
}
export function blockerOf(error: unknown): TaskBlocker | undefined { return error instanceof TaskBlocker ? error : undefined; }
export function isResumable(blocker: { fixableBy: BlockerFixableBy }): boolean {
  return blocker.fixableBy === "environment" || blocker.fixableBy === "runtime";
}
```

Lưu ý:
- Giữ `message` cũ làm phần đầu của thông điệp. Lý do: `host-verification.ts:600` nhận dạng lỗi bằng `message.includes("runner_identity_unselectable")`.

#### T0.2 Gom đủ tệp thiếu trong `runMeasurementCommand`

Sửa `behavioral-runner.ts:398-402`. Hiện tại vòng lặp ném lỗi ngay ở tệp thiếu đầu tiên. Sửa thành: gom mọi tệp không phải blob `100644` hoặc `100755` vào mảng `missing`. Sau vòng lặp, nếu `missing` không rỗng thì ném:

```ts
throw new TaskBlocker("declared_test_missing",
  `Behavioral test identity must be a committed regular file: ${missing.join(", ")}`,
  { paths: missing, revision });
```

Phần thông điệp giữ nguyên tiền tố cũ để log và tài liệu cũ vẫn tìm được.

Test mới trong `packages/runtime/test/agentic/blocker-classification.test.ts`:
- Dựng repo git tạm, commit 2 trong 4 tệp test.
- Gọi `measureBehavior` với lệnh đã bind 4 `testPaths`.
- Kỳ vọng `TaskBlocker` có `code = declared_test_missing` và `details.paths` đúng 2 tệp còn thiếu.
- Lấy khuôn dựng repo từ `behavioral-runner-output.test.ts`.

#### T0.3 `task-commands.ts`

Đổi hai chỗ `throw new Error("runner_identity_unselectable: …")` (quanh dòng 184 và 198) thành `throw new TaskBlocker("runner_identity_unselectable", <cùng thông điệp>)`.

Nhánh `catch` ở dòng 189 (`if (input.ownedPaths !== undefined) continue; throw error;`) giữ nguyên.

Test: test hiện có của `resolveTaskCommands` phải vẫn xanh. Thêm một assert `instanceof TaskBlocker` cho ca mơ hồ.

#### T0.4 `host-verification.ts`

- `automaticGate` (khoảng dòng 611): đổi `throw new Error("… has no test identities for this task …")` thành `TaskBlocker("no_test_identities", <cùng thông điệp>)`.
- Nhánh `catch` của `gate()` (khoảng dòng 1110): nếu `blockerOf(error)` có giá trị thì thêm `details.blocker = { code, fixableBy, nextAction, details }` vào lỗi trả về. `code: "validation"` và `retryable: false` giữ nguyên.

#### T0.5 `check_work` trả đúng phân loại

Sửa trong `host-development.ts`, hàm `check`, khoảng dòng 457-493:

1. Tách hàm `private blockedReply(context, reason: string, blocker?: TaskBlocker)`, trả về đúng khuôn JSON hiện tại, với:
   - `classification`: không có blocker thì `"infrastructure"` như cũ. Có blocker thì ánh xạ theo `fixableBy`: `director` → `"plan_mismatch"`, `developer` → `"code"`, `environment` → `"infrastructure"`, `runtime` hoặc `user` → `"runtime"`.
   - `recovery`: `blocker.nextAction` nếu có, ngược lại dùng chuỗi cũ.
   - Thêm trường `blocker: { code, fixableBy, details }` khi có blocker.
2. Nhánh `catch` quanh `commandsFor` (dòng 471-472): trả về thêm `blocker: blockerOf(error)`.
3. Bọc vòng đo (dòng 487-493) bằng `try/catch`. Bắt được `TaskBlocker` thì `return this.blockedReply(...)`. Lỗi khác ném tiếp như cũ.

Hàm `blockedReply` là ranh giới giữa GĐ1 và GĐ2: GĐ1 chỉ sửa hàm này, còn GĐ2 chỉ sửa `commandsFor`.

Test:
- Thêm vào `integration-connected-phases.test.ts`, hoặc một tệp mới dùng `connectedPhaseFixture`.
- Spec khai 2 tệp test, chỉ commit 1. `check_work` phải trả `status: "blocked"`, `classification: "plan_mismatch"`, kèm `blocker.details.paths` liệt kê tệp thiếu.
- Test cũ ở dòng 158 không đổi.

#### T0.6 Kiểm tra và bàn giao

```bash
pnpm run build   # test runtime import dist/, build trước
pnpm exec vitest run packages/runtime/test/agentic/blockers.test.ts packages/runtime/test/agentic/blocker-classification.test.ts packages/runtime/test/agentic/integration-connected-phases.test.ts
pnpm check:deps && pnpm typecheck
pnpm test:affected --base main --run
```

`packages/runtime` không có script `test` riêng; test chạy bằng `vitest` ở thư mục gốc. Fixture `connectedPhaseFixture` nằm ở `packages/runtime/test/helpers/agentic-integration-fixture.ts:322`.

Tiêu chí xong:
- Toàn bộ test hiện có xanh.
- Bốn test mới xanh.
- Không có thay đổi trong `journal.ts` hay `packages/contracts`.

Nhánh: `fix/runtime/blocker-taxonomy`. Merge riêng được, rủi ro thấp.

### GĐ1: Cầu dao không tiến triển [TT, ∥ với GĐ2], khoảng 4–6 ngày

Mục tiêu: một phase failure mà resume không sửa được thì không còn bị đo lại trên cùng đầu vào. Run phải dừng có tên rõ ràng (park `plan_mismatch`), không lặp.

Quy tắc của cầu dao:
- **Cùng đầu vào:** cùng mã blocker, cùng task, cùng phase, cùng revision đo, cùng digest spec và cùng digest strategy. Với đầu vào giống hệt, đo lại chắc chắn ra lại kết quả cũ.
- **Blocker không resumable** (`fixableBy` khác `environment` và `runtime`): resume **không** cấp `retryAuthorized`. Phải đổi spec/strategy (GĐ3) hoặc có revision mới thì mới đo lại.
- **Blocker resumable, hoặc `Error` thường không mang blocker:** giữ nguyên hành vi hiện tại. Lỗi hạ tầng thật vẫn sửa bằng resume được.

Thứ tự task: T1.1 và T1.2 làm song song; T1.3 cần T1.2; T1.4 → T1.5 → T1.6 tuần tự; T1.7 và T1.8 làm song song sau T1.5; T1.9 cuối cùng.

#### T1.1 Contract D2: thêm `plan_mismatch` [∥ với T1.2]

Các chỗ phải sửa:
- `packages/contracts/src/director.ts:60`: thêm `"plan_mismatch"` vào `ParkedIssueKindSchema`.
- `packages/runtime/src/agentic/auto-park.ts:15-33`: hai map `summaries` và `autoParkSuggestedAction` có kiểu `Record<ParkedIssueKind, string>`, nên TypeScript sẽ bắt thêm khóa. Nội dung đề xuất:
  - Tóm tắt: "Kế hoạch lệch với commit (ví dụ khai tệp test chưa có); resume không sửa được."
  - Hành động: "Giao Developer viết đúng tệp đã khai, hoặc thu hẹp phạm vi test (amend_task_scope khi có), rồi retry."
- `apps/web/src/features/issues/index.tsx:18`: thêm nhãn "Kế hoạch lệch".
- Thêm ca `plan_mismatch` vào test schema của contracts.
- `docs/contracts.md`: ghi enum mới kèm compatibility note. Binary cũ gặp kind mới thì Zod từ chối; journal v9 (T1.2) cũng đã chặn binary cũ đọc state mới, nên không có đường ép kiểu.

Kiểm tra: `pnpm typecheck` báo thiếu khóa ở mọi `Record<ParkedIssueKind, …>` còn sót. Đó là cách tìm hết chỗ phải sửa.

#### T1.2 Journal v9 cho `phaseFailure.blocker` [∥ với T1.1]

Theo đúng khuôn đã dùng cho v7 và v8 trong `journal.ts`:

1. Dòng 326: thêm `9` vào union `version`. Dòng 350: thêm `9` vào danh sách version được chấp nhận.
2. Dòng 313: mở rộng kiểu `phaseFailure` thêm
   `blocker?: { code: BlockerCode; fixableBy: BlockerFixableBy; fingerprint: string; specDigest: string; strategyDigest: string; sourceRevision: string; details?: Record<string, JsonValue> }`.
3. Viết `requiresBlockerJournal(state)`: trả `true` khi có `out.phaseFailure?.blocker`, hoặc có task bị park với `kind === "plan_mismatch"` (trong `parked` hoặc `parkHistory`).
4. Khi save (khoảng dòng 863), thêm dòng `if (state.version < 9 && requiresBlockerJournal(state)) state.version = 9;`. Version chỉ được nâng lên, không bao giờ hạ.
5. Validation lúc đọc (dòng 637-643), khi có `blocker` thì kiểm:
   - `state.version >= 9`;
   - `code` có trong `BLOCKERS` và `fixableBy` khớp registry;
   - `fingerprint`, `specDigest`, `strategyDigest` khớp `/^[a-f0-9]{64}$/`;
   - `sourceRevision` khớp `/^[a-f0-9]{40}$/`;
   - `details` là JSON và kích thước có giới hạn: tối đa 50 path, mỗi path tối đa 1024 ký tự.

   Sai bất kỳ điều nào thì ném `Invalid private policy failure outcome` như hiện tại.
6. Không viết upcaster: state v8 không có `blocker` vẫn hợp lệ nguyên trạng. Không suy ngược `blocker` từ chuỗi `summary` cũ, vì như vậy là tự dựng trạng thái recovery.

Test (thêm vào test codec journal hiện có, tìm bằng `command grep -rln "parseAgenticJournalState" packages/runtime/test`):
- v8 có `blocker`: bị từ chối.
- v9 có `blocker`: đọc và ghi lại giữ nguyên.
- v8 không có `blocker`: save xong vẫn là v8.
- `fixableBy` không khớp registry: bị từ chối.

#### T1.3 `no-progress.ts` [sau T1.2]

Tệp mới `packages/runtime/src/agentic/no-progress.ts`:

```ts
import { digest } from "./journal.js";
export function blockerFingerprint(input: { code: string; runId: string; taskId: string; phase: string;
  sourceRevision: string; specDigest: string; strategyDigest: string; details: unknown }): string {
  return digest([input.code, input.runId, input.taskId, input.phase, input.sourceRevision, input.specDigest, input.strategyDigest, input.details]);
}
/** Số phase failure trước đó của cùng run/task mang cùng dấu vân tay. */
export function priorSameFingerprint(state: Pick<JournalState, "outbound">, runId: string, taskId: string, fingerprint: string, excludeMessageId: string): number;
/** Spec hoặc strategy hiện tại có khác lúc ghi blocker không. */
export function inputsChanged(blocker: { specDigest: string; strategyDigest: string }, task: TaskRecord): boolean; // so với digest(task.spec.specification), digest(task.spec.strategy)
```

Test unit `no-progress.test.ts`:
- Đổi một thành phần bất kỳ thì dấu vân tay đổi.
- Cùng đầu vào thì cùng dấu vân tay.
- `priorSameFingerprint` không đếm chính request đang xét.

#### T1.4 Ghi blocker vào phase failure [sau T1.3]

1. `host.ts:2494`: truyền thêm `blockerOf(error)` vào `recordPhaseFailure`.
2. `runtime.ts:5403`: `recordPhaseFailure(binding, requestId, summary, repairable, evidence?, blocker?: TaskBlocker)`.
   - Lấy `sourceRevision` từ `record(request.message.payload).sourceRevision`. Lấy `phase` và `taskId` từ payload.
   - Lấy `specDigest = digest(task.spec.specification)` và `strategyDigest = digest(task.spec.strategy)` từ `TaskRecord` của run.
   - Tính `fingerprint` bằng T1.3 rồi lưu vào `request.phaseFailure.blocker`.
   - Kiểm bất biến cũ (`Conflicting immutable policy failure outcome`) phải so cả `digest(blocker)`.
3. Theo trường hợp:
   - Blocker có `fixableBy` khác `environment`/`runtime`: luôn đặt `repairable = false`. Developer không nhận repair notice, vì không có gì trong code để Developer sửa đúng nghĩa.
   - Không có blocker: không đổi gì.

Test: phase failure do `declared_test_missing` được lưu kèm `blocker` đầy đủ, và journal tự nâng lên v9.

#### T1.5 Chặn đo lại trong `recoverPhaseFailures` và đường resume [sau T1.4]

1. Ở `recoverPhaseFailures` (`runtime.ts`, khoảng dòng 5467-5476), nhánh `!repairable`, khi `blocker && !isResumable(blocker)`:
   - `run.error = \`Plan mismatch (${blocker.code}): ${summary}\``.
   - `pendingAction.reason` = `run.error` + `\nNext: ${blocker.nextAction}`. Phải nói rõ "resume sẽ không đo lại cùng revision".
   - Giữ `recovery: "manual"` như cũ. `this.progress(...)` gửi Conversation một thông điệp dễ hiểu, kiểu "Kế hoạch khai các tệp test … chưa có trong commit; đang dừng để sửa kế hoạch".
2. Ở cùng hàm, bất kể `repairable`: nếu `priorSameFingerprint(...) >= 1` thì coi là không tiến triển. Không gửi `phaseNotice` cho Developer nữa; escalate với `run.error = \`No progress: same ${code} on same revision and plan\``.
3. Ở đường resume (`runtime.ts:3058-3066`), trước khi gắn `retryAuthorized = true` cho một `phaseFailure`:
   - `blocker` resumable, hoặc không có `blocker`: giữ hành vi cũ.
   - `blocker` không resumable và `!inputsChanged(blocker, task)`: **không** gắn `retryAuthorized`. Ghi phase failure đó vào danh sách `skipped`.
   - `blocker` không resumable nhưng spec/strategy đã đổi (sau này là GĐ3): cho đo lại.
   - Đưa `skipped` vào payload `resume_run` gửi Coordinator (`nonResumablePhaseFailures: [{ requestId, code, nextAction }]`) và vào JSON trả về của lệnh resume. Thêm một câu vào trường `next`: "Các phase failure sau là lệch kế hoạch; resume không đo lại chúng."
4. `retryVerification` (`runtime.ts:6279`): đường này phục vụ verification ở mức workflow (`VERIFICATION_RETRY_PREFIX`), không phải phase failure. **Không sửa**, chỉ thêm test khẳng định nó không cấp lại `retryAuthorized` cho phase failure mang blocker.

Test trong tệp mới `packages/runtime/test/agentic/no-progress-breaker.test.ts`, dùng `connectedPhaseFixture`:
- (a) Khai 2 tệp test, commit 1. Tester đo Red. Run thành `escalated`, có `Plan mismatch (declared_test_missing)`.
- (b) Người dùng resume. Không có `retryAuthorized`; trong outbound **không** có `verification.requested` mới. Payload `resume_run` có `nonResumablePhaseFailures`.
- (c) Resume 3 lần liên tiếp vẫn không có lần đo nào. Đây chính là kịch bản 06/11.
- (d) Lỗi hạ tầng không mang blocker vẫn được đo lại sau resume. Chạy lại `verification-retry.test.ts`, `stuck-states.test.ts`, `integration-recovery.test.ts` không sửa gì.
- (e) Mở lại journal (giả lập restart host) giữa (a) và (b): kết quả không đổi.

#### T1.6 Auto-park `plan_mismatch` [sau T1.5]

Hiện tại (`auto-park.ts:119-121`), nguồn `verification.requested` chỉ được nhận khi `phaseFailure === undefined`. Vì vậy task kẹt vì phase failure không bao giờ được park.

Sửa trong `select()`, trước nhánh `else` chung:
- Tìm phase failure mới nhất của task trong `related`, thỏa: `message.type === "verification.requested"`, `phaseFailure.applied`, có `phaseFailure.blocker` và `!isResumable(blocker)`, cùng `implementationAttemptId === current.attemptId`.
- Nếu `run.status === "escalated"` và `run.pendingAction?.state === "pending"` thì đặt `kind = "plan_mismatch"`.
- **Không** đợi `maxAutoResumesBeforePark`, vì resume đằng nào cũng không sửa được.
- Các fence hiện có (unknown delivery, approval đang chờ, execution chưa dừng) giữ nguyên và vẫn chạy trước.

Test (thêm vào `auto-park.test.ts`):
- Director mode, có phase failure mang blocker `director`: chọn được candidate `plan_mismatch`.
- Không có blocker: hành vi cũ, không chọn.
- Có approval đang chờ: không chọn.

Nối vào kịch bản (f) của `no-progress-breaker.test.ts`: Director mode với auto-park bật, task bị park `plan_mismatch` và run thành `completed_with_parked` khi không còn task nào khác.

#### T1.7 Hướng dẫn Director và Coordinator [∥ với T1.8, sau T1.5]

- `agents/director/system-prompt.md` và `agents/coordinator/system-prompt.md`: thêm quy tắc "Khi escalation có `Plan mismatch (…)` hoặc payload resume có `nonResumablePhaseFailures`: **không** gọi `resume_run` hay `retry_verification` cho lỗi đó. Chọn một trong hai: (1) nếu tệp test đã khai thuộc phạm vi hiện tại, giao Developer viết đúng các tệp đó và commit (revision mới thì được đo lại); (2) nếu không, gọi `park_task` với kind `plan_mismatch` và báo người dùng. Khi có `amend_task_scope` (GĐ3) thì dùng tool đó."
- Xem `host-director-mode.ts` và `mcp-output-views.ts`, nơi đã nhắc `resume_run` và `retry_verification`. Nếu có đoạn hướng dẫn trả cho model thì cập nhật cùng nội dung.
- Lưu ý quy tắc skill: đường dẫn trong backtick trở thành ref bắt buộc, nên viết tên tệp bằng văn xuôi. Nếu sửa nội dung skill thì phải bump version.
- **Còn phải xác minh khi làm:** sau khi run đã `escalated`, Director có giao rework cho Developer trên cùng task được không, và qua tool nào. Nếu không có đường hợp lệ thì phương án (1) bị loại; hướng dẫn chỉ còn `park_task` cho tới khi GĐ3 xong.

  **Kết quả xác minh GĐ1 (2026-11-09, mã nguồn):** Chưa có đường hợp lệ. `AgenticWorkflowRuntime.proposeWorkflow` từ chối đề xuất khác khi `run.definition` đã tồn tại (`Workflow already proposed; requirement changes need a newly approved delegation`); `authorizeImplementation` chỉ xác nhận điều kiện TDD, không tạo assignment; `requestSpecialist` là nhánh specialist, còn `retryVerification` là workflow verification. `resumeBlockedRun` có thể đánh thức Coordinator nhưng không cấp `retryAuthorized` cho blocker không resumable khi spec/strategy giữ nguyên, nên Developer không có đường đo lại phase trên cùng task. Vì vậy prompt GĐ1 chỉ hướng dẫn `park_task` với kind `plan_mismatch` và báo người dùng; giao rework/sửa scope chờ GĐ3.
- Test: chạy lại test hành vi của `agents/**`; tìm bằng `command grep -rln "system-prompt.md" packages/*/test agents`.

#### T1.8 Telemetry [∥ với T1.7, sau T1.5]

- `packages/runtime/src/telemetry/report.ts` (`readWorkflowTelemetry`, được `runtime.ts:1721` dùng trong `telemetryReport`): thêm `blockers: { code, fixableBy, count, lastAt, resumeSkipped }[]`, tổng hợp từ `phaseFailure.blocker` trong outbound của run.
- Cập nhật formatter của `bflow status --telemetry` trong `apps/cli/src/formatters.ts`.

  **Vị trí xác minh GĐ1:** `formatters.ts` chỉ import `formatTelemetryReport`; hàm dựng chuỗi thực tế nằm trong `apps/cli/src/telemetry.ts`, nên phần hiển thị blocker được sửa tại đó.
- Test: test có sẵn của telemetry report thêm ca có blocker.

#### T1.9 Kiểm tra và bàn giao [TT, cuối GĐ1]

```bash
pnpm run build
pnpm exec vitest run packages/runtime/test/agentic/no-progress-breaker.test.ts packages/runtime/test/agentic/no-progress.test.ts packages/runtime/test/agentic/auto-park.test.ts packages/runtime/test/agentic/verification-retry.test.ts packages/runtime/test/agentic/stuck-states.test.ts packages/runtime/test/agentic/integration-recovery.test.ts packages/runtime/test/agentic/park-unpark.test.ts
pnpm check:deps && pnpm typecheck
pnpm test:affected --base main --run   # sửa contracts ⇒ có thể bị nới rộng thành full
pnpm test:web
```

Tiêu chí xong:
- Kịch bản (a)–(f) xanh.
- Toàn bộ test cũ về resume, retry và park xanh mà không phải sửa kỳ vọng. Chỉ những ca có blocker mới đổi hành vi.
- Journal v9 có test chuyển đổi.
- Contract có compatibility note trong `docs/contracts.md`.

Rủi ro riêng của GĐ1:
- Sửa contract làm selection test nới rộng thành full suite. Theo memory của repo, chạy full suite đồng thời trên nhiều worktree dễ gây timeout giả, nên để integrator chạy full suite một lần.
- Thay đổi ở `recoverPhaseFailures` đụng tới luồng recovery phức tạp (writer lease, attempt bị thay thế). Chỉ thêm nhánh cho phase failure **có** blocker; không sửa nhánh cũ.

Tệp sở hữu:
- `packages/contracts/src/director.ts`
- `no-progress.ts` (mới)
- `runtime.ts` (`recordPhaseFailure`, `recoverPhaseFailures`, đường resume)
- `auto-park.ts`, `journal.ts`, `host.ts:2494`
- `blockedReply` trong `host-development.ts`
- `telemetry/report.ts`, formatter CLI, nhãn web, `agents/director/**`, `agents/coordinator/**`

Không chạm `task-commands.ts` hay `behavioral-runner.ts`. Nhánh: `fix/runtime/no-progress-breaker`.

### GĐ2: Lấy danh tính test từ diff [∥ với GĐ1], khoảng 1–1,5 tuần

**Bước 1 (plan, chưa code):** các điểm dưới đây đã đối chiếu với mã tại `origin/main` = `e7d55827` ngày 2026-11-09. Bước 2 chỉ bắt đầu sau khi chủ dự án duyệt phần chi tiết này. Tệp triển khai được phép: `packages/runtime/src/agentic/task-commands.ts`, `behavioral-runner.ts`, `host-verification.ts`, `runner-results.ts`, `vitest-json.ts`, `node-tap.ts`, **chỉ hàm `commandsFor`** trong `host-development.ts`, test package-local tương ứng, `docs/sdlc-policies.md`, `docs/verification-runners.md`. Không sửa `runtime.ts`, `journal.ts`, `auto-park.ts` hay package khác. Nhánh: `fix/runtime/observed-test-identity`.

#### T2.0 Bản đồ mã và bất biến đã xác minh [TT, trước T2.1]

- Baseline task có sẵn: `host-verification.ts:207-219` lấy `task.worktrees[0].baseCommitHash`, thiếu task worktree thì `run.baseRevision`; `behavioralEvidence` dùng lại thứ tự đó tại `:1156-1161`. `host-development.ts:108-110` đã dùng base của worktree đầu để chọn profile. `host-verification.ts:229-238` đã kiểm HEAD, worktree sạch và lấy diff; `:257` có mẫu `git diff --name-only --diff-filter=ACMR base revision`. Lệnh mới phải dùng `--no-ext-diff --no-textconv --name-only --diff-filter=ACMR -z <base> <head> --`, kiểm lại HEAD trước/sau, không dùng working tree hoặc `A..B` ngược chiều; rename chọn đường dẫn đích. Đối với workflow không có task, dùng `run.baseRevision`.
- Mọi caller sản phẩm của `resolveTaskCommands`: `host-development.ts:109`; `host-verification.ts:219` (mọi đường đo), `:412` (đóng băng gate plan), `:488` (thẩm định task), `:596` (thẩm định proposal); `host.ts:1384` (preflight). Các caller test nằm trong `auto-runner.test.ts`, `flow06-developer-tdd-loop.test.ts`, `polyglot-measure.test.ts`, `runner-proposal-remediation.test.ts`, `manual-review-policy.test.ts`. `automaticTestPaths` chỉ được gọi trong `task-commands.ts:182,187,194` và các test Rust `flow06-developer-tdd-loop.test.ts:541,557,561`. Giữ overload không có `changedPaths` để `host.ts` và thẩm định đề xuất không vỡ kiểu.
- `host-development.ts:211-249` kiểm edit theo `configuredTests`, definition blobs và supplemental tests; `:241-243` chặn test đã đo Red. `host-verification.ts:1230-1235` so digest `{commandId,testNames,testBlobs}` giữa Red và Green/Refactor; `:1237-1250` đòi assertion failure Red, bác lỗi không liên quan; `behavioral-runner.ts:395-408` ghim blob `100644/100755` từng test được chọn ở revision đã commit. T2.x không bỏ phép kiểm nào.
- `host-test-integrity.ts:30-61` tự diff base/candidate và đọc blob; `host-verification.ts:374-380` giữ base đầu tiên. `mutation-check.ts:38-75,88-109` dùng owner command cố định và commit đột biến, không nhận `testPaths` từ resolver. `review-candidate-evidence.ts:18-24,38-81` so `testNames` trong receipt với toàn bộ mapping; `rework-causality.ts` không đọc `testPaths`, giữ receipt/finding theo generation; `app-check-selection.ts:28-74` tách danh tính `app:` trước khi bind runner; `execution-binding.ts:83-125,322-350` chụp snapshot/approval, không lấy `testPaths`. Vì vậy không sửa các tệp này; test hồi quy phải chứng minh các consumer vẫn dùng đúng bằng chứng và thẩm quyền.
- `runner-results.ts:27-39,315-334`, `vitest-json.ts:87-118`, `node-tap.ts:440-478` đều trả `testNames`/`testResults` từ leaf có cấu trúc, nhưng hiện gọi `resolveExpectedIdentities` (`node-tap.ts:94-175`) với bijection **mọi** tên khai ↔ mọi leaf chạy. Để đạt D1 (mỗi tiêu chí cần *ít nhất một* tên đã chạy), chỉ nhánh automatic được nhận tập con có ánh xạ duy nhất; owner command vẫn bijection cũ. Zero test, skipped mapped test, output thiếu/truncated, lỗi runner và exit mâu thuẫn vẫn bị chặn.
- Test cũ cần xem lại: `auto-runner.test.ts:90-99` và `runner-proposal-remediation.test.ts:62-67` vẫn phải kỳ vọng `missing_test_paths` khi **không khai cả tệp lẫn thư mục test**; không được nới kỳ vọng này. Các test owner identity trong `behavioral-runner-output.test.ts:248-279`, Red freeze trong `behavioral-runner-phases.test.ts:120-147`, `integration-connected-tdd-cycle.test.ts:21-24`, Rust chọn tệp trong `flow06-developer-tdd-loop.test.ts:483-561`, integrity trong `test-integrity.test.ts:56` vẫn phải xanh không sửa kỳ vọng. Nếu test cũ đỏ vì đổi semantics, dừng và báo, không sửa cho xanh.

**Ranh giới phải quyết định trước Bước 2:** D1 cho phép `affectedPaths` chỉ khai thư mục test. Nhưng `host.ts:1384-1388` gọi `resolveTaskCommands` **không truyền diff** và chặn khi `commands.length === 0`; `host-verification.ts:412-424` cũng hiện chỉ đăng ký gate từ command đã bind lúc lập plan. Nếu thư mục chưa chứa test literal, việc đổi riêng `assertDetectedSupported` không đủ để run đi tới Red. Không tạo `BoundBehavioralCommand` rỗng/giả cho preflight. Cần chủ dự án cho phép chỉnh đúng preflight tại `host.ts:1384-1388` (và chỉ chỗ đó), hoặc thu hẹp tiêu chí GĐ2 thành "ít nhất một tệp dự kiến"; nếu giữ cả hai điều kiện hiện tại, Bước 2 dừng ở ranh giới này. Thêm nữa, `commandsFor` hiện đồng bộ (`host-development.ts:108`) nhưng diff Git qua `this.git` là bất đồng bộ (`:112-116`); hai caller ở `:218` và `:481` phải thêm `await`, nằm ngoài chính hàm mà phạm vi mới nhất cho phép. Không dùng lệnh Git đồng bộ riêng để lách giới hạn; cần cho phép đổi đúng hai caller. `review-candidate-evidence.ts:41-42` còn đòi **mọi** mapped name; với D1 tập con, nhánh no-change dispute sẽ không tái dùng receipt nếu không được phép sửa consumer này. Ghi rõ hạn chế đó, không lách qua việc đổi strategy đã duyệt.

#### T2.1 Chọn đường dẫn từ diff commit [TT, test trước]

Tệp: `task-commands.ts:117-159,161-207`, test mới `packages/runtime/test/agentic/observed-test-paths.test.ts`; đối chiếu Rust với `flow06-developer-tdd-loop.test.ts:483-561`.

1. Viết test cho `observedTestPaths(profile, changedPaths, ownedPaths, specification)`: chọn hai tệp trong bốn tệp dự kiến; chọn thêm tệp test mới **không khai** nhưng trong ownership; loại tệp ngoài ownership/project/ngôn ngữ; loại path không khớp `testFilePattern`, path xấu và bản sao; Rust integration `tests/*.rs` ưu tiên đúng method, dedicated unit `src/tests.rs` được chọn, `src/lib.rs` không bị đông cứng khi đã có dedicated unit test. Chạy test để thấy **đỏ**.
2. Tách bộ lọc path của `automaticTestPaths` để cả chế độ đề xuất và quan sát dùng cùng `testFilePattern`, `matchesRunnerFile`, project boundary và ownership literal. Chế độ quan sát lấy **chỉ** `changedPaths` đã xác thực từ Git, giữ thứ tự ổn định, không giao nhau với `affectedPaths`. Giữ luật Rust/Cargo hiện có tại `:132-157`, dùng tập quan sát thay cho `specification.affectedPaths` khi có diff.
3. Thêm overload không phá caller cũ:

```ts
resolveTaskCommands(input: TaskCommandInput & { changedPaths: readonly string[] }):
  { commands: BoundBehavioralCommand[]; coverageGaps: string[] };
resolveTaskCommands(input: TaskCommandInput): BoundBehavioralCommand[];
```

`coverageGaps` chỉ liệt kê tệp literal khai trong `affectedPaths` nhưng không thấy trong diff; thư mục dự kiến và test ngoài khai báo không tạo lỗi. Owner command luôn giữ `testPaths`/`testNames` owner cấu hình. Test riêng kiểm overload cũ và owner không đổi; chạy xanh rồi commit `test(runtime): cover observed test path selection` + `fix(runtime): select committed task test paths` theo đúng Red/Green thực tế.

Mẫu lọc (luật Rust/Cargo chạy sau bộ lọc này):

```ts
const observed = unique(changedPaths).filter(path =>
  testFilePattern.test(path) && matchesRunnerFile(profile, path) &&
  inProject(profile, path) && inOwnedScope(ownedPaths, path));
```

#### T2.2 Nối diff đã ghim vào Developer và Verification [sau T2.1]

Tệp: `host-development.ts:108-110` (chỉ `commandsFor`; đổi caller `:218,481` phụ thuộc duyệt ranh giới T2.0), `host-verification.ts:207-220,229-238,383-389,610-617,1136-1165,1452-1463`, `behavioral-runner.ts:395-408`; test mới `packages/runtime/test/agentic/observed-test-measurement.test.ts`.

1. Viết test tạo repo thật: `base`, Red commit chỉ hai trong bốn test khai, gọi `check_work`/Red và kiểm argv/testBlobs chỉ có hai blob tại HEAD; test thêm tệp ngoài kế hoạch nhưng trong ownership thì được đo; ngoài ownership không vào argv. Test bắt dirty HEAD, HEAD đổi giữa hai lần đọc diff, diff không hợp lệ và test được chọn nhưng không phải blob regular đều phải chặn. Chạy đỏ.
2. Thêm helper trong `host-verification.ts` lấy diff `base..revision` với `-z`, kiểm HEAD sạch và bất biến trước/sau; truyền `changedPaths` qua `resolve` cho `automaticGate`, `behavioralEvidence`, static-analysis exception và QA đo lại khi có task. Không truyền diff cho owner command. Sau khi ranh giới T2.0 được duyệt, đổi `commandsFor` thành async, nhận `cwd/head` từ hai caller hiện có, lấy base của `task.worktrees[0]`, kiểm HEAD sạch, đọc diff bằng `this.git`, truyền `changedPaths`. Sau Red, dùng receipt Red đã được policy ghi để giữ **chính tập test đã đo Red** trong command; test mới không thuộc tập đó vẫn là supplemental theo `authorizeTddPaths:236-245`. `behavioral-runner.ts:400-408` giữ kiểm blob và xác nhận **đúng path** của entry `ls-tree`, tránh nhận prefix path. Chạy test xanh.

   Mẫu lệnh/kiểm: `const before = await git(cwd, ["rev-parse", "HEAD"]); const paths = (await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=ACMR", "-z", base, revision, "--"])).split("\0").filter(Boolean); const after = await git(cwd, ["rev-parse", "HEAD"]);` yêu cầu `before.trim() === revision === after.trim()` và status sạch. Test chọn path sau khi xác nhận HEAD, rồi `measureBehavior` vẫn kiểm lại revision và blob.
3. Test Red→Green/Refactor kiểm sửa blob Red hoặc thêm test vào **tập đo mapped** sau Red bị từ chối bởi phép so `host-verification.ts:1233-1234`; test supplemental mới sau Red vẫn được phép viết như `flow06-developer-tdd-loop.test.ts:425-428` và không tham gia command mapped. Kiểm edit hook chặn chính các tệp trong receipt Red. Giữ gate `host-test-integrity`; commit sau khi test xanh.

#### T2.3 Đối chiếu tên test với tiêu chí [sau T2.2]

Tệp: `node-tap.ts:94-175,440-478`, `vitest-json.ts:87-118`, `runner-results.ts:27-39,315-334`, `behavioral-runner.ts:598-620`, `host-verification.ts:295-320,1096-1118,1192-1300`; test mới `packages/runtime/test/agentic/observed-criterion-coverage.test.ts` và bổ sung ca vào `node-tap-selection.test.ts`, `runner-results.test.ts`.

1. Viết test parser: automatic có hai tên dự kiến nhưng chỉ một leaf đúng tên → trả một tên/leaf quan sát; leaf trùng/không khai, selected skipped, zero leaf, exit sai vẫn bị bác; owner vẫn bijection chính xác. Mỗi format TAP, Vitest, JUnit (qua `runner-results`) có ca thiếu một tên và ca sai giao thức. Chạy đỏ.
2. Thêm chế độ `allowMissingExpected` chỉ cho automatic (`checkoutDependencyRoots !== undefined`), dựa trên matcher của `node-tap.ts` để ánh xạ **mỗi leaf đã chạy** vào đúng một tên dự kiến, loại trùng/nhập nhằng; không dùng exit code hoặc tên agent khai làm bằng chứng. Giữ `testResults.name` là tên chuẩn đã khớp. Không sửa chính sách owner; chạy xanh.

   Mẫu quyết định độ phủ: `const covered = mapping.testNames.some(name => measurement.testResults.some(test => includesTestIdentity([test.name], name)));` áp dụng trên measurement đã parse và được host thực thi; không dùng `command.testNames` vì đó chỉ là lời khai. Kiểm mọi tiêu chí required, chưa waived.
3. Viết test hai tiêu chí: C1 có ít nhất một tên trong `testResults`, C2 không có tên nào. C2 phải tạo finding `criterion_without_test` với `fixableBy=developer`, artifact của đo độc lập và đi đường `HostBehavioralFailure`/rework hiện có; không tạo receipt `passed` cho C2. Trường hợp không chọn được command hoặc runner báo zero leaf cũng phải đi đường finding có chẩn đoán, không biến thành passing evidence hay lỗi chọn runner không có hướng sửa. Không ném `Error` chọn runner cho thiếu tên. Ca bốn tệp khai, hai tệp commit và đủ tên cho **mọi** tiêu chí phải đạt. Với Red, chỉ assertion failure của tên đã khớp criterion mới được chấp nhận; Red không bao giờ đỏ vẫn bị bắt. Chạy đỏ → sửa `host-verification.ts` → chạy xanh. `coverageGaps` không phải finding và không tự động giảm yêu cầu criterion.
4. Chạy lại test `review-candidate-evidence`/rework hiện có như compatibility check: receipt tập con vẫn phải có tiêu chí thật trong `evaluatedCriteria`; nếu no-change dispute cần tái dùng receipt tập con, **dừng và xin mở phạm vi** cho `review-candidate-evidence.ts`, không sửa tệp ngoài GĐ2. Commit rõ scope.

#### T2.4 Proposal, docs và hồi quy chống gian lận [sau T2.1; docs có thể làm ∥ với T2.2/T2.3]

Tệp: `host-verification.ts:478-540,571-604,403-424`, `task-commands.ts:210-212`, `docs/sdlc-policies.md:86,344`, `docs/verification-runners.md:10-35,120-142`; test `auto-runner.test.ts`, `runner-proposal-remediation.test.ts`, `behavioral-runner-phases.test.ts`, `integration-connected-tdd-cycle.test.ts`, `host-test-integrity.test.ts`, `test-integrity.test.ts`.

1. Viết test proposal có thư mục test dự kiến hoặc tên tệp chưa tồn tại: runner hợp lệ + mapping bắt buộc → qua thẩm định; thiếu cả phạm vi test vẫn `missing_test_paths`; mapping thiếu/runner mơ hồ vẫn bị bác. Chạy đỏ. **Chưa coi thư mục-only đã chạy được** cho tới khi ranh giới `host.ts` ở T2.0 được giải quyết.
2. Sửa `assertDetectedSupported` và `assertTaskSupported` để chỉ xác nhận phạm vi dự kiến và khả năng runner tại proposal, không kiểm blob tồn tại. Đăng ký automatic gate theo runner được chọn ngay cả khi chưa có tệp được bind; lúc đo mới dùng diff thật. Cập nhật `TEST_PATH_RULE` và hai docs theo D1: `affectedPaths` dự kiến, test identity từ diff ∩ ownership ∩ runner project/ngôn ngữ, tên tiêu chí cần ít nhất một leaf chạy, owner override không đổi, Red blob/freeze và test-integrity vẫn bắt buộc.
3. Chạy bộ chống gian lận: edit test sau Red bị chặn; sửa/yếu đi test hoặc config có finding `host-test-integrity`; Red không có assertion failure bị chặn; test path không phải blob regular bị chặn; lease/fence và approval không đổi. Không nới test cũ để qua. Commit docs + code sau Red/Green.

#### T2.5 Kiểm tra và bàn giao [TT, cuối GĐ2, sau khi giải quyết ranh giới T2.0]

```bash
pnpm run build
pnpm exec vitest run packages/runtime/test/agentic/observed-test-paths.test.ts packages/runtime/test/agentic/observed-test-measurement.test.ts packages/runtime/test/agentic/observed-criterion-coverage.test.ts packages/runtime/test/agentic/auto-runner.test.ts packages/runtime/test/agentic/runner-proposal-remediation.test.ts packages/runtime/test/agentic/behavioral-runner-phases.test.ts packages/runtime/test/agentic/integration-connected-tdd-cycle.test.ts packages/runtime/test/agentic/host-test-integrity.test.ts packages/runtime/test/agentic/test-integrity.test.ts packages/runtime/test/agentic/flow06-developer-tdd-loop.test.ts packages/runtime/test/agentic/node-tap-selection.test.ts packages/runtime/test/agentic/runner-results.test.ts
pnpm check:deps
pnpm typecheck
pnpm test:affected --base origin/main --run
git diff --check
```

Tiêu chí xong: mọi test mới từng đỏ rồi xanh; bộ cũ xanh **nguyên kỳ vọng**; 4 tệp khai/2 tệp commit/đủ tên đạt; test thêm trong ownership được chọn; test ngoài ownership không chọn; thiếu tiêu chí thành finding; test đã chọn ghim blob và Red/Green giữ nguyên identity; chống gian lận, lease/fence, approval không suy yếu. Báo cáo HEAD đã test, selection `test:affected`, exit code và pass/fail/skip của từng lệnh. Mức bằng chứng chỉ là mã nguồn + test cục bộ, không gọi là live.

### GĐ3: Sửa phạm vi trong run [TT sau GĐ1], khoảng 1–1,5 tuần

- Trạng thái: **đã cài đặt (BƯỚC 2) trên nhánh `fix/runtime/in-run-scope-amend`, chờ review/merge.** Chủ dự án giao toàn quyền và chọn các đề xuất mặc định Q1–Q5. Mức bằng chứng: mã nguồn + test cục bộ; chưa kiểm chứng live.

**Kết quả cài đặt và khác biệt so với T3.1–T3.11 phía dưới (đọc mục này trước):**
- **Không đổi ownership.** Xác minh T3.5 cho thấy `CoreSession.create` ném `Persisted Core run definition conflicts with proposed workflow definition` khi digest `run.definition` khác bản Core đã lưu, và `ownedPaths` nằm trong `definition.tasks[].metadata`. Sửa ownership cần Core cập nhật definition hoặc lớp ownership hiệu lực ở `host-development.ts`/`host-verification.ts` (thuộc phạm vi GĐ2, ngoài danh sách tệp GĐ3). Vì vậy `narrow_owned_paths` và `expand_owned_paths` **bị bỏ khỏi schema**, không có thẻ duyệt mở rộng (T3.7 không làm). Mở rộng/thu hẹp ownership là thay đổi yêu cầu; Coordinator được hướng dẫn dùng revision yêu cầu mới. Việc này chặt hơn D3 (không có đường mở rộng), nên không vi phạm ràng buộc "mở rộng bắt buộc qua thẻ". Cần quyết định riêng nếu muốn hỗ trợ (xem "Giả định còn mở").
- Đã làm: T3.1 (`scope-amendment.ts`, schema Zod strict ở Runtime, Q4), T3.2 (bất biến: tiêu chí bằng digest, mapping, TDD, chỉ bỏ đường dẫn Runtime đã ghi nhận thiếu), T3.3 (`amendTaskScope`, admission theo phase failure không resumable hoặc task park `plan_mismatch`; Runtime tự duyệt spec mới với `decidedBy: "coordinator"` + `metadata.autoApproved: "scope-amend"`, Q5), T3.4 (journal v10 `TaskRecord.scopeAmendments`), T3.5 (xác nhận không cần gắn lại digest plan vì chỉ đổi spec/strategy của task; `run.definition` và `executionPlan.fingerprint` không đổi; có test), T3.6 (nối vào cầu dao qua `inputsChanged`; không xóa phase failure), T3.8 (đăng ký tool, `argumentsByName`, view `scopeAmendments`, README), T3.9 (prompt Coordinator và Director), T3.10 (kịch bản 06/11 đầu-cuối: cầu dao ngắt → amend → resume → Red/Green/Refactor → completed, cùng `run-1`, không có run mới; biến thể Director `completed_with_parked`).
- Q2: `park_task` của Director nhận `kind` tùy chọn (`other` | `plan_mismatch`), sửa lệch của GĐ1. Q3: amend không tự unpark/resume.
- Phát hiện khi cài đặt: nếu người dùng đã resume một lần trên đầu vào không đổi (action chuyển `queued`, run về `implementing`), `resume_run` lần hai bị từ chối. `amendTaskScope` khôi phục đúng action đó về `pending`/`escalated` (giữ `manualResumeAttempts`) để đường resume bình thường, vốn là nơi duy nhất cấp `retryAuthorized`, đo lại được.
- Không sửa `apps/cli/src/director-skill.ts` vì skill đã sát giới hạn 8192 byte của test; quy tắc nằm trong `agents/director/system-prompt.md`.
- `docs/sdlc-policies.md` và `docs/contracts.md` (tệp chung, cần review) chưa sửa; không có contract mới.

**Giả định còn mở:** (1) hỗ trợ đổi ownership trong run cần Core API cập nhật definition hoặc lớp ownership hiệu lực, chưa có; (2) chưa kiểm tra `plan_mismatch` có xuất hiện ở run không do Director tạo; (3) `validateTaskCommands` cho spec mới chạy với ownership cũ, đúng vì ownership không đổi; (4) chưa có test host đầu-cuối với Herdr thật.

Mục tiêu: một run bị cầu dao GĐ1 ngắt (`Plan mismatch`, hoặc task đã bị park `plan_mismatch`) sửa được phạm vi **ngay trong run đó**, đo lại, rồi hoàn tất. Không tạo run mới. Phase failure cũ không bị xóa tay: nó được đo lại vì `inputsChanged` (GĐ1) thấy digest spec/strategy đã đổi.

Thứ tự task: T3.1 và T3.2 làm song song; T3.3 cần T3.1 và T3.2; T3.4 song song T3.3; T3.5 sau T3.3 và T3.4; T3.6 sau T3.5; T3.7 sau T3.5, song song T3.6; T3.8 sau T3.5; T3.9 cuối.

#### T3.0 Bản đồ mã và kết quả xác minh (đã làm, 2026-11-09, đọc mã tại `a04ba51f`)

1. **Tool được khai báo ở đâu, schema nằm ở đâu.** Không có schema MCP nào trong `packages/contracts`. Mỗi tool Coordinator gồm ba phần, tất cả trong `packages/runtime`:
   - tên + mô tả: mảng `COORDINATOR_TOOLS` (`agentic/tools.ts:18-38`);
   - JSON schema cho provider native: bảng `argumentsByName` trong `host.ts:3556-3600` (ví dụ `reresolve_execution_plan`, `withdraw_workflow_proposal`);
   - Zod/xử lý: `case` trong `CoordinatorTools.invoke` (`tools.ts:105-139`) gọi `AgenticWorkflowRuntime`.

   Director nhận tool tự động: `DIRECTOR_TOOLS` và `isDirectorCoordinatorTool` đều lấy từ `COORDINATOR_TOOLS` (`director/tools.ts:110-118`, `director/host-methods.ts:35-37`). MCP của Director dùng một `INPUT_SCHEMA` chung (`director/mcp.ts:75`), nên Zod trong Runtime là nơi duy nhất kiểm đầu vào cho Director. `mcp-output-views.ts` chỉ định dạng đầu ra của `inspect`; không phải nơi đăng ký tool.
   **Kết luận: D3 không cần sửa `packages/contracts`.** Schema `amend_task_scope` là kiểu riêng của Runtime (`scope-amendment.ts`, mới). Điều này khác dòng "Contracts của MCP tool" trong D3; cần chủ dự án xác nhận (câu hỏi Q4).
2. **Phiên bản spec và truy vết.** Mỗi task giữ `TaskRecord.spec: SpecRecord { specification, request, decision, strategy }` (`journal.ts:54-56`), tạo bằng `reviewSpec` (`runtime.ts:4187`). `reviewSpec(input, true)` cho phép `version > 1` nhưng bắt `metadata.sdd.revisionReason` không rỗng. `SpecificationEngine.supersede(previous, next)` (`packages/specification/src/engine.ts:137-153`) đòi cả hai ở trạng thái `approved` và `next.version === previous.version + 1`. Truy vết spec → task nằm ở `traceabilityTaskIds` và `metadata.sdd.traceability`, do `projectTaskSpecificationInput` (`runtime.ts:272`) sinh; tiêu chí của task không đổi khi chỉ sửa phạm vi nên truy vết giữ nguyên.
   Strategy không sửa tay được: `policies.strategy.resolve(spec)` tính lại từ `spec.affectedPaths` + tiêu chí (`packages/test-strategy/src/resolver.ts:60-115`) và `validate()` tính lại chế độ TDD từ snapshot. Vì vậy **đổi `affectedPaths` có thể đổi `tddDecision.mode`**. Runtime phải so sánh và chặn nếu mode hoặc `requiresFailingTestFirst` đổi (xem T3.2). `criterionMappings.testNames` được giữ nguyên khi hợp lệ (`resolver.ts:70-90`), nên sửa mapping là sửa input spec rồi resolve lại.
3. **Digest execution plan và drift.** `acceptedExecutionPlanInput` (`execution-binding.ts:322-373`) băm: spec của **workflow** (`run.workflowSpec`, không phải spec từng task), toàn bộ `run.definition` (`acceptedWorkflow`, có cả `metadata.ownedPaths` của task) và strategy của workflow spec. Hệ quả:
   - sửa `task.spec` / `task.spec.strategy` **không** đổi digest plan, nên không gây drift;
   - sửa `ownedPaths` (nằm trong `definition.tasks[].metadata`) **có** đổi `acceptedWorkflow`, nên phải gắn lại bằng `bindAcceptedExecutionPlan(run, readExecutionResolution)` trong cùng giao dịch, và chỉ khi các nguồn private khác không đổi. `rebindRepositoryDrift` (`runtime.ts:3548-3571`) đã có đúng guard này (chỉ `REPOSITORY_SNAPSHOT_COMPONENT` được phép đổi). T3.5 tái dùng guard đó, không viết lại;
   - `workflowSpec.affectedPaths` và định nghĩa workflow nằm trong gói duyệt thiết kế của người dùng (`bundleFingerprint`). **GĐ3 không sửa chúng.** Chỉ thu hẹp ở mức task, nên ràng buộc `ownedPaths ⊆ workflowSpec.affectedPaths` (`runtime.ts:~3920`) luôn còn đúng.
   - **Còn phải xác minh khi làm T3.5:** Core aggregate (`core.create(run)`) có giữ bản sao `definition`/`ownedPaths` riêng không. Nếu có, sửa `run.definition` phải đi kèm cập nhật Core qua `core.mutate`. T3.5 mở đầu bằng một test thăm dò nêu rõ điều này.
4. **Đường unpark và guard `completed_with_parked`.** `unparkTask` (`runtime.ts:2243-2287`) cho `completed_with_parked → implementing`, đưa task Core `parked → ready` bằng `transitionTask(intent: "unpark")`, xóa `cycle`/`verificationPlan`/`result` của task, nên lần chạy sau lập kế hoạch mới. Guard chặn: `ENDED_RUN_STATUSES` (không gồm `completed_with_parked`, đúng ý), `assertDirectorWritable`, và `source: director` chỉ cho run do Director tạo. Ngược lại `assertCoordinatorCommunicable` (`runtime.ts:623-626`) **ném lỗi** khi run ở `completed_with_parked`, nên `amend_task_scope` không thể dùng nó mà cần guard riêng (T3.3). `parkTask` chỉ nhận task Core ở `pending|ready|blocked|waiting|running` (`runtime.ts:2063+`).
   **Không có `blockerHistory` trong mã.** Mục 5 cũ của GĐ3 ("xóa `blockerHistory`") dựa trên giả định sai. Cơ chế thật: blocker nằm ở `phaseFailure.blocker` của outbound, so với `digest(task.spec.specification)` và `digest(task.spec.strategy)` bằng `inputsChanged` (`no-progress.ts:18`). Khi spec hoặc strategy đổi thì cả `nonResumablePhaseFailures` (`runtime.ts:102-110`) lẫn nhánh resume đều coi phase failure đó là đã đổi đầu vào và cấp lại `retryAuthorized`. Dấu vân tay cũng đổi theo `specDigest`, nên `priorSameFingerprint` không đếm vòng cũ. **Không xóa gì cả**; phase failure cũ ở lại làm vết kiểm toán.
5. **Thẻ quyết định người dùng.** `requestUserDecision` (`runtime.ts:4229`) cần `PaneBinding` và ghi `UserDecisionRecord` có `agentId`/`paneId`; câu trả lời quay về đúng pane đó (`runtime.ts:~3275`). Tiền lệ cho "thẻ gắn một đề xuất cụ thể, áp dụng sau khi duyệt" là `requestTestIntegrityException` (`runtime.ts:4260-4310`): metadata của thẻ chứa ràng buộc, rồi `testIntegrityExceptions` xác thực lại bằng `authorizeHuman` + so khớp metadata. T3.7 theo đúng khuôn này. **Giới hạn quan trọng:** Director **không có pane** và không có `request_user_decision` (grep không thấy trong `host-director-mode.ts` hay `director/**`), nên thẻ gắn pane chỉ dùng được cho phiên Coordinator. Xem Q1.
6. **Kết quả xác minh T1.7 (GĐ1) và hai điểm lệch phát hiện.**
   - Xác nhận: trước GĐ3 không có đường hợp lệ để giao rework hoặc sửa phạm vi trên task đã escalated (đúng như ghi ở T1.7). Prompt GĐ1 (`agents/director/system-prompt.md` mục 7, `agents/coordinator/system-prompt.md:187-192`) đang nói "chờ release sau".
   - **Lệch 1 (lỗi GĐ1):** prompt bảo Director gọi `park_task` với `kind "plan_mismatch"`, nhưng `ParkArgs` (`director/tools.ts:136`) là `strict()` chỉ có `runId, taskId, reason`, và `CoordinatorTools.invoke` đóng cứng `kind: "other"` (`tools.ts:126`). Park tay của Director không bao giờ mang `plan_mismatch`; chỉ auto-park (`auto-park.ts:119`) mới đặt kind này. Cần quyết định ở Q2.
   - **Lệch 2:** `selectAutoParkCandidates` chạy trong host chỉ khi `issueQueue.autoPark` bật (`host.ts:201`); chưa xác minh nó có chạy cho run không do Director tạo hay không. T3.3 coi `plan_mismatch` park là đặc thù Director-run và kiểm bằng test; nếu sai thì mở lại phần admission.

#### T3.1 Kiểu đầu vào `amend_task_scope` (`scope-amendment.ts`, mới) [∥ với T3.2]

Zod `strict()`, không đụng contracts:

```ts
AmendTaskScopeInputSchema = z.object({
  runId, taskId,
  reason: z.string().trim().min(10).max(1000),
  changes: z.array(z.discriminatedUnion("kind", [
    { kind: "drop_planned_paths", paths: string[1..50] },        // bỏ tệp dự kiến chưa tồn tại khỏi task.spec.affectedPaths
    { kind: "add_paths_within_ownership", paths: string[1..50] }, // thêm tệp vào task.spec.affectedPaths, phải nằm trong ownedPaths hiện có
    { kind: "narrow_owned_paths", paths: string[1..50] },        // thu hẹp ownedPaths (bỏ khỏi ownership)
    { kind: "set_test_names", criterionId, testNames: string[1..20] }, // sửa mapping của MỘT tiêu chí
    { kind: "expand_owned_paths", paths: string[1..50] }          // chỉ qua thẻ (T3.7)
  ]).min(1).max(20),
  approvalId: z.string().optional()   // dùng ở lần gọi thứ hai sau khi thẻ mở rộng được duyệt
}).strict()
```

- Đường dẫn được chuẩn hóa bằng đúng hàm `normalizeLiteralRepoPrefix` hiện là closure trong `proposeWorkflow`; T3.1 trích nó thành hàm export cùng chỗ, **không đổi logic** (test hiện có của `proposeWorkflow` chạy lại không sửa).
- Kết quả trả về: `{ amended, specVersion, ownedPaths, affectedPaths, rebound, nextStep }` hoặc `{ pendingApproval: { approvalId } }` hoặc lỗi có mã.
- Test: schema từ chối trường lạ, mảng rỗng, `..`, đường dẫn tuyệt đối, kind lạ.

#### T3.2 Bộ kiểm bất biến thuần `validateScopeAmendment` [∥ với T3.1]

Hàm thuần (không I/O), nhận trạng thái trước và đề xuất sau. Runtime tự kiểm, không tin Coordinator. Từ chối khi:
- **Tiêu chí:** `digest(acceptanceCriteria)` của spec task khác (đổi mô tả, `required`, `verificationMethod`, thêm hoặc bớt tiêu chí). Không có chức năng waive: không có thao tác nào tác động lên `required`.
- **Mapping:** mọi tiêu chí `required` phải còn mapping với ít nhất một `testNames` khác rỗng sau khi sửa; `set_test_names` chỉ nhắm tiêu chí có trong task.
- **TDD:** `strategy.tddDecision.mode` và `requiresFailingTestFirst` sau khi resolve lại phải bằng trước đó; `requiredTestLevels` và `independentVerificationRequired` không yếu đi. Đây là chặn cửa sau "thu hẹp `affectedPaths` để TDD từ `required` thành `not_applicable`".
- **Ownership:** `narrow_owned_paths` chỉ bỏ, kết quả không rỗng; `ownedPaths` sau ⊆ `ownedPaths` trước (trừ `expand_owned_paths`, vốn phải qua T3.7); `add_paths_within_ownership` không được ra ngoài `ownedPaths` sau thay đổi.
- **Chỉ là tệp test:** `drop_planned_paths` chỉ nhận đường dẫn mà (a) không tồn tại trong commit/worktree của task và (b) được runner coi là test. Không cho bỏ tệp mã nguồn vì tiêu chí có thể dựa vào nó.
- **Không làm yếu bất biến mục 2:** không đụng blob test đã commit, không đụng tệp test đã đóng băng sau Red, không đụng `host-test-integrity`.
- Mọi đường dẫn đúng literal (không glob, không `..`, không tuyệt đối).

Test thuần: mỗi luật một ca đỏ + một ca xanh gần ranh giới, gồm ca đổi `affectedPaths` làm TDD đổi mode, ca đổi chữ tiêu chí, ca bỏ tiêu chí cuối của task.

#### T3.3 `amendTaskScope` trong Runtime: admission và áp dụng [sau T3.1, T3.2]

Phương thức mới `AgenticWorkflowRuntime.amendTaskScope(input, principal)` trong một `transaction`:
1. **Admission** (guard riêng, không dùng `assertCoordinatorCommunicable`):
   - run chưa kết thúc theo `ENDED_RUN_STATUSES`, không `cancelled`, không `supersededBy`; Director thì gọi `assertDirectorWritable` và chỉ cho run do Director tạo;
   - task phải ở một trong ba trạng thái: (i) run `escalated` và có phase failure mang blocker không resumable cho task đó mà `!priorInputsChanged`; (ii) task đang `parked` với kind `plan_mismatch` (run có thể là `completed_with_parked`); (iii) task `blocked` do chính phase failure đó. Mọi trạng thái khác bị từ chối kèm lý do, **kể cả task `succeeded` hay đang `running` có writer lease**;
   - không có delivery `sending`/`unknown_delivery`, không có `verificationPending`, không có approval hoặc user decision đang chờ cho task (cùng bộ guard với `parkTask`).
2. Dựng input spec mới = `projectTaskSpecificationInput`-compatible từ `task.spec.specification` + thay đổi, `version + 1`, `metadata.sdd.revisionReason = reason`, qua `reviewSpec(…, true)` (ghi lên ArtifactStore, tạo `ApprovalRequest`).
3. Chạy T3.2 trên (trước, sau). Chạy `validateTaskCommands(spec, strategy, ownedPaths)` như `proposeWorkflow` (`runtime.ts:~3935`).
4. Runtime tự duyệt spec mới bằng `specification.approve` với `ApprovalDecision` `decidedBy: "coordinator"` + `idempotencyKey: "scope-amend:<runId>:<taskId>:<version>"`, đúng tiền lệ duyệt tự động trong `settleDesignApproval` (`runtime.ts:4162-4165`). Việc này **chỉ áp dụng cho thu hẹp hoặc sửa trong ownership**; mở rộng không bao giờ đi đường này. Sau đó `supersede(previous, next)`. Gọi `assertImplementationReady` cho spec mới (cùng chiếu `projected` như `acceptDesign`).
5. Thay `task.spec`; nếu có `narrow_owned_paths` thì sửa `run.definition.tasks[].metadata.ownedPaths` rồi làm T3.5.
6. Ghi vết kiểm toán (T3.4), `activityLog.record({ kind: "recovery", action: "task_scope_amended" })` và một `progress` tiếng Việt thường cho Conversation, kiểu "Đã thu hẹp phạm vi test của <task>: bỏ <n> tệp chưa có; tiêu chí giữ nguyên".
7. **Không** tự gọi `resume_run`/`unpark_task` và **không** tự đo lại. Kết quả trả `nextStep`: task đang park → `set_issue_status retrying` (Director); run đang `escalated` → `resume_run`. Lý do: giữ hai đường hiện có làm nơi duy nhất cấp lại việc, và để `inputsChanged` là bằng chứng duy nhất cho phép đo lại. Q3 hỏi lại điểm này.
8. Idempotent: cùng `reason` + cùng `changes` + cùng `specDigest` gốc gọi lại thì trả kết quả cũ; spec gốc đã đổi (bản cũ) thì từ chối `stale_scope`.

Test trong `packages/runtime/test/agentic/scope-amend.test.ts` (dùng `connectedPhaseFixture`): thu hẹp thành công; run `completed_with_parked` + task park `plan_mismatch` được phép; task `succeeded`/đang chạy/đang chờ approval bị từ chối; waive/đổi tiêu chí bị từ chối; TDD đổi mode bị từ chối; gọi lại idempotent; hai lần gọi đua nhau chỉ một lần thắng (optimistic version).

#### T3.4 Journal v10: `scopeAmendments` [∥ với T3.3]

Theo đúng khuôn v9 (`journal.ts:350`, `:887`): thêm `10` vào union và danh sách version; `requiresScopeAmendmentJournal(state)`; nâng version khi save, không bao giờ hạ; validate lúc đọc; không upcaster; không suy ngược từ chuỗi cũ.
- `TaskRecord.scopeAmendments?: { amendmentId; at; source: "coordinator"|"director"; reason; fromSpecVersion; toSpecVersion; fromSpecDigest; toSpecDigest; fromStrategyDigest; toStrategyDigest; diff: { droppedAffectedPaths; addedAffectedPaths; ownedPathsBefore; ownedPathsAfter; testNamesChanged: { criterionId, before, after }[] }; ownerApprovalId?: string }[]` (tối đa 20 mục mỗi task; mỗi danh sách path ≤ 50 mục × 1024 ký tự).
- `amendmentId` = digest của (runId, taskId, fromSpecDigest, changes) để idempotent.
- Test: v9 mang `scopeAmendments` bị từ chối; v10 đọc/ghi lại nguyên; v9 không có trường vẫn là v9; digest sai định dạng bị từ chối; restart giữa lúc amend và lúc resume không đổi kết quả.

#### T3.5 Gắn lại digest execution plan [sau T3.3 và T3.4]

- Chỉ khi `run.definition` thật sự đổi (có `narrow_owned_paths` hoặc `expand_owned_paths`): tái dùng guard của `rebindRepositoryDrift` (nguồn private khác `REPOSITORY_SNAPSHOT_COMPONENT` đổi thì **từ chối** việc sửa, không âm thầm nhận drift khác), rồi `bindAcceptedExecutionPlan`. Rút phần guard ra hàm dùng chung; không đổi hành vi của `reresolve_execution_plan`.
- Nếu chỉ đổi `task.spec`/`strategy` thì không gắn lại gì (digest plan không phụ thuộc).
- Test thăm dò đầu task: đo xem sửa `ownedPaths` có làm `assertRunExecutionPlan` ném `ExecutionPlanDriftError` hay không, và Core có giữ bản sao `ownedPaths` không (mục T3.0.3).
- Test: sau amend, `assertRunExecutionPlan` không ném; đổi tệp cấu hình khác trước khi amend thì amend bị từ chối; không có thay đổi `definition` thì `executionPlan.fingerprint` giữ nguyên.

#### T3.6 Nối vào cầu dao GĐ1 [sau T3.5, ∥ với T3.7]

Không thêm cơ chế mới. Xác nhận bằng test rằng:
- sau amend, `nonResumablePhaseFailures` không còn liệt kê phase failure cũ (vì `inputsChanged`), `resume_run` cấp `retryAuthorized`, và có `verification.requested` mới;
- phase failure cũ **vẫn nằm** trong `state.outbound` (không bị xóa tay);
- `priorSameFingerprint` của lần đo mới là 0 (dấu vân tay mới vì `specDigest` đổi), còn nếu amend không đổi digest nào thì cầu dao vẫn ngắt;
- một amend rỗng hoặc chỉ đổi `reason` bị từ chối (không cho dùng amend như cách xả cầu dao).

#### T3.7 Mở rộng ownership qua thẻ duyệt [sau T3.5, ∥ với T3.6]

- `expand_owned_paths` không bao giờ áp dụng ngay. Lần gọi đầu tạo thẻ bằng `buildUserDecisionRequest` (khuôn `requestTestIntegrityException`), `metadata.scopeExpansion = { runId, taskId, fromSpecDigest, ownedPathsBefore, ownedPathsProposed, affectedPathsProposed }`, hai lựa chọn "Duyệt mở rộng" / "Từ chối", `evidence` chứa diff. Run vào trạng thái chờ quyết định như các thẻ khác; guard `pending userDecision` hiện có chặn mọi thay đổi khác trên task.
- Lần gọi thứ hai `amend_task_scope { approvalId }` sau khi thẻ `answered`: xác thực bằng `authorizeHuman`, `validateUserDecisionAnswer`, `selectedOption` đúng, so khớp `digest(metadata.scopeExpansion)` với đề xuất hiện tại và với `digest(task.spec)` hiện tại (hết hạn nếu spec đã đổi); mỗi thẻ chỉ dùng một lần (đánh dấu trong `scopeAmendments[].ownerApprovalId`). Sau đó đi cùng đường T3.3 (spec version mới, T3.5).
- Mở rộng **không** được vượt `workflowSpec.affectedPaths` (gói thiết kế đã duyệt). Cần vượt thì đó là thay đổi thiết kế: từ chối và hướng dẫn dùng revision yêu cầu mới.
- Thẻ gắn pane nên chỉ hoạt động cho phiên Coordinator, qua handler của host (nơi có `PaneBinding`, cùng chỗ xử lý `request_user_decision`). Phiên Director: xem Q1.
- Test: gọi `expand_owned_paths` không có thẻ thì không đổi gì và tạo thẻ; thẻ bị từ chối hoặc hết hạn thì không áp dụng; thẻ đã dùng không dùng lại; gọi lần hai với đề xuất khác thẻ bị từ chối; vượt `workflowSpec.affectedPaths` bị từ chối.

#### T3.8 Đăng ký tool, hiển thị, tài liệu [sau T3.5]

- `COORDINATOR_TOOLS` thêm `amend_task_scope` (mô tả nêu rõ: chỉ thu hẹp hoặc sửa trong ownership; mở rộng cần thẻ; không đổi/waive tiêu chí; không tự đo lại).
- `CoordinatorTools.invoke`: `case "amend_task_scope"`; `host.ts` `argumentsByName.amend_task_scope` (JSON schema tương ứng T3.1, `additionalProperties: false`); `isDirectorCoordinatorTool` đã bao phủ nhờ `COORDINATOR_TOOLS`. Cập nhật `role-tool-schema.test.ts` (chỉ Coordinator và Director có tool này; các role khác thì không).
- `inspect`: `view=blockers` / `tasks` thêm `scopeAmendments` (tóm tắt) để Director/Coordinator thấy lịch sử; cập nhật `mcp-output-views.ts` và test của nó.
- `packages/runtime/README.md` và `docs/sdlc-policies.md`: ghi cơ chế, bất biến và giới hạn. `docs/contracts.md` **không đổi** vì không có contract mới (nếu chủ dự án chọn đưa schema vào contracts ở Q4 thì mới cập nhật).

#### T3.9 Prompt Coordinator/Director và guide [sau T3.5; ∥ với T3.8]

- `agents/coordinator/system-prompt.md:187-192` và `agents/director/system-prompt.md` mục 7: thay đoạn "chưa có tool" bằng: khi gặp `Plan mismatch (...)` hoặc `nonResumablePhaseFailures` thì gọi `amend_task_scope` (thu hẹp tệp test chưa có, hoặc sửa mapping); sau đó Director dùng `set_issue_status retrying` nếu task đã park, còn nếu run đang `escalated` thì `resume_run`. Không dùng `retry_verification` cho lỗi này. Không đổi tiêu chí hay bỏ tiêu chí; muốn vậy thì đó là revision yêu cầu mới. Mở rộng ownership: Coordinator gọi tool và chờ thẻ.
- `packages/runtime/src/director/guide.ts` (nội dung `read_coordinator_guide`) và `apps/cli/src/director-skill.ts`: cập nhật cùng nội dung; sửa test `guide.test.ts`, `director-skill.test.ts`, test hành vi của `agents/**`.
- Quy tắc skill: tên tệp/đường dẫn viết bằng văn xuôi, không đặt trong backtick (xem memory "Skill backtick paths are references"); nếu sửa nội dung `skills/**` thì bump version. Tên tool và tên kind (`amend_task_scope`, `plan_mismatch`) là mã định danh, không phải đường dẫn tệp; vẫn phải chạy test skill-bundle sau khi sửa vì commit `a04ba51f`/`7a0d02c7` vừa phải gỡ backtick quanh `plan_mismatch`.
- Lệch 1 của T3.0.6 (Director `park_task` không mang `kind`): xử lý theo Q2.

#### T3.10 Kịch bản đầu-cuối 06/11 và bất biến [bắt buộc, sau T3.6–T3.9]

Tệp `packages/runtime/test/agentic/scope-amend-e2e.test.ts` (dùng `connectedPhaseFixture`, mô phỏng restart host giữa các bước):
- **(a)** Kế hoạch khai 4 tệp test; Developer chỉ commit 2; Tester đo Red; cầu dao ngắt (`Plan mismatch (declared_test_missing)`). **(b)** Resume 1 lần vẫn không đo lại (GĐ1). **(c)** Coordinator gọi `amend_task_scope` bỏ 2 tệp chưa có (và đánh giá lại mapping). **(d)** `resume_run`: có `verification.requested` mới, phase failure cũ vẫn còn trong outbound, dấu vân tay mới. **(e)** Đo xanh, run đi tới `completed`. **(f)** `state.runs.length` và `runId` không đổi, không có run mới.
- Biến thể Director: auto-park `plan_mismatch` → `completed_with_parked` → amend → `set_issue_status retrying` → unpark → đo lại → `completed`.
- Bất biến: đề xuất waive/đổi chữ tiêu chí bị từ chối; mở rộng ownership tạo thẻ và không áp dụng khi chưa duyệt; sau từ chối thẻ thì cầu dao vẫn ngắt; amend rỗng không xả cầu dao.
- Chạy lại không sửa kỳ vọng: `no-progress-breaker.test.ts`, `auto-park.test.ts`, `park-unpark.test.ts`, `verification-retry.test.ts`, `stuck-states.test.ts`, `integration-recovery.test.ts`, các test GĐ2 về danh tính test.

#### T3.11 Kiểm tra và bàn giao [TT, cuối GĐ3]

```bash
pnpm run build
pnpm exec vitest run packages/runtime/test/agentic/scope-amend.test.ts packages/runtime/test/agentic/scope-amend-e2e.test.ts packages/runtime/test/agentic/no-progress-breaker.test.ts packages/runtime/test/agentic/auto-park.test.ts packages/runtime/test/agentic/park-unpark.test.ts packages/runtime/test/agentic/role-tool-schema.test.ts packages/runtime/test/director
pnpm check:deps && pnpm typecheck
pnpm test:affected --base origin/main --run
git diff --check && git status --short
```

Tiêu chí xong: T3.10 xanh toàn bộ; test cũ không sửa kỳ vọng; journal v10 có test chuyển đổi và restart; không đổi `packages/contracts` (trừ khi Q4 đổi); prompt và guide khớp tool thật.

Rủi ro riêng của GĐ3:
- Sửa `run.definition.ownedPaths` có thể lệch với bản sao của Core hoặc các chỗ băm khác (T3.5 thăm dò trước khi làm tiếp). Nếu Core giữ bản sao riêng và không có API cập nhật hợp lệ, chỉ cho phép sửa ở mức `task.spec` (không đổi `ownedPaths`) và dừng báo.
- `amend_task_scope` là cửa vào mới tác động lên spec đã duyệt. Giảm rủi ro bằng: chỉ thu hẹp, so TDD mode, bất biến tiêu chí tính bằng digest, không áp dụng khi task đang chạy hoặc có lease, không xả cầu dao khi không đổi gì.
- Cùng sửa `runtime.ts` với GĐ1 (đã merge); không còn xung đột song song. Selection của `test:affected` có thể nới thành full vì `runtime.ts` và `journal.ts` rộng; khi đó để integrator chạy full một lần (theo memory "Parallel agent test load").

Tệp dự kiến chạm: `packages/runtime/src/agentic/{scope-amendment.ts (mới), runtime.ts, journal.ts, tools.ts, host.ts, mcp-output-views.ts, execution-binding.ts (chỉ nếu tách guard)}`, `packages/runtime/src/director/{guide.ts, tools.ts (chỉ nếu Q2)}`, `apps/cli/src/director-skill.ts`, `agents/coordinator/**`, `agents/director/**`, `packages/runtime/README.md`, `docs/sdlc-policies.md`, test tương ứng. **Không chạm** `task-commands.ts`, `behavioral-runner.ts`, `host-verification.ts`, `packages/contracts/**` (nếu Q4 giữ mặc định).

**Câu hỏi cần chủ dự án quyết trước khi cài đặt (mặc định đề xuất ở đầu mỗi dòng):**
- **Q1 – Mở rộng ownership trong phiên Director.** (Đề xuất: v1 từ chối kèm hướng dẫn, chỉ hỗ trợ thẻ trong phiên Coordinator.) Director không có pane nên thẻ gắn pane hiện không dùng được. Nếu cần hỗ trợ ngay, phải thêm loại thẻ do Runtime sở hữu không gắn pane, định tuyến câu trả lời vào mailbox Director; đó là việc lớn hơn GĐ3.
- **Q2 – `park_task` của Director không mang `kind`.** (Đề xuất: thêm `kind` tùy chọn, chỉ chấp nhận `other` hoặc `plan_mismatch`, vào `ParkArgs` và `invoke`; sửa lỗi GĐ1 trong GĐ3 vì prompt đang hứa điều này.) Ngược lại thì phải sửa prompt GĐ1 cho khớp mã.
- **Q3 – Amend có tự unpark/resume không.** (Đề xuất: không; giữ `set_issue_status retrying` và `resume_run` là đường duy nhất cấp lại việc.)
- **Q4 – Schema tool nằm ở Runtime hay contracts.** (Đề xuất: Runtime, vì mọi tool Coordinator hiện nằm ở đó và không có consumer ngoài Runtime; không phải thay đổi contract công khai.) D3 nói "Contracts của MCP tool"; chọn contracts thì thêm một vòng review contract.
- **Q5 – `decidedBy` của spec do Runtime tự duyệt.** (Đề xuất: `"coordinator"` theo tiền lệ duyệt tự động; thêm `metadata.autoApproved: "scope-amend"` để phân biệt khi kiểm toán.)

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

### GĐ6: Cổng nhận kế hoạch xét theo task, phân tích tĩnh phủ mọi loại tệp [sau GĐ0, ∥ với GĐ4c], khoảng 1,5–2 tuần

- Trạng thái: **kế hoạch, chờ duyệt D4–D8**. Chưa có mã nguồn, chưa có test.
- Nguồn: run `run-director-0c0c6957e5d223d9a30c1388`. Repo Maven, 5 tiêu chí: hai `static_analysis` (`ci-triggers` và tiêu chí báo lỗi CI), một `integration_test` (shard), một `unit_test`, một `manual_review` (hướng dẫn). Kế hoạch bị từ chối trước khi giao Developer, với lỗi `unsupported_method: Criterion ci-triggers needs a detected static_analysis capability and its matching auto:typecheck or auto:static target command.`
- Journal của run không có trên máy viết kế hoạch. Phần `assessment` của run (taskType, risk, `infrastructure.commands`) **chưa xác minh**. T6.0 phải lấy lại hoặc dựng fixture bao cả hai khả năng.

Khác với GĐ0–GĐ3: các giai đoạn đó xử lý lỗi ở bước đo và thực thi, còn GĐ6 xử lý **cổng nhận kế hoạch** và **phạm vi của `auto:static`**. GĐ1 chỉ giúp Director dừng sớm. Ở bước đề xuất vốn đã có chống lặp theo dấu vân tay (`recordProposalRejection`), nhưng không mở ra đường hợp lệ. Nếu không có GĐ6, mọi repo có CI, YAML, Java hay shell, kèm một tiêu chí rà soát thủ công, đều kẹt ở cùng chỗ.

#### 6.1 Chuỗi điểm chặn đã xác minh trong mã (HEAD `228b4d65`)

Sửa riêng một điểm thì run chỉ trượt sang điểm tiếp theo. Các điểm xếp theo thứ tự Director sẽ gặp:

| # | Chỗ | Hành vi hiện tại | Vì sao chặn |
|---|---|---|---|
| B1 | `host-verification.ts:497-503` (`assertSupported`) | Tiêu chí `static_analysis` phải có `auto:static` trong `targetCommands`, nếu không trả `unsupported_method` | Lỗi đã quan sát. Sửa được bằng cách khai `auto:static`, nhưng sau đó gặp B2. |
| B2 | `host.ts:1943` → `host-verification.ts:512` | Kiểm tra trộn thủ công/tự động trên **toàn bộ đặc tả**, ném `Error` thường | Tách DAG thành task riêng vẫn bị từ chối. `guardWorkflowProposal` biến lỗi thành `unsupported_verification` (`workflow-rejection.ts:86`), loại lỗi không nằm trong `AGENT_FIXABLE_REJECTIONS`. Bước xét theo task (`runtime.ts:4006-4010`, `projectTaskSpecificationInput` → `assertTaskSupported`) không bao giờ được gọi tới. `docs/blocker-inventory.md:188` đang xếp dòng này là GIỮ. |
| B3 | `runtime.ts:273` (`projectTaskSpecificationInput`) và `host-verification.ts:509` | Spec chiếu cho từng task lấy nguyên `draft.affectedPaths` | Task chỉ có tài liệu vẫn mang `.java`, `.yml` của task khác, nên chạm `Behavioral development requires configured independent behavioral acceptance checks`. Bị che sau B2. |
| B4 | `runtime.ts:4007`, `runtime.ts:4267` (`reviewSpec` → `strategy.resolve`), `test-strategy/src/policy.ts:32-45` | Chính sách TDD của task dùng `assessment` của toàn đặc tả nếu Coordinator không ghi đè | `infrastructure` thêm `integration_test` và `static_analysis`. `configuration` thêm `typecheck` và `static_analysis`. Rủi ro cao thêm `manual_review`. Các method này bị gán cho **mọi** task. `assertPolicyMethods` (`host-verification.ts:611-628`) từ chối task tài liệu vì không có runner hay tiêu chí cho `integration_test`, và có thể từ chối task code vì đòi `typecheck` khi repo không có TypeScript. Bị che sau B2. |
| B5 | `host-verification.ts:283-285` (`captureStaticAnalysis`) | `auto:static` chỉ đọc JS, TS, JSON | `.java`, `pom.xml`, `.yml`, `.sh` cho `exitCode: 1`. Lỗi xảy ra ở bước đo; Error thường, không có mã blocker. |
| B6 | `apps/cli/src/agentic-host.ts:58-61`, `behavioral-runner.ts:84-90`, `task-commands.ts:89` | `verification.json` chỉ nhận `behavioralCommands` (unit, integration, e2e; reporter `node_tap`/`vitest_json`). Có một lệnh là tắt toàn bộ tự phát hiện. | Chủ dự án không khai được analyzer, và cũng không khai được Maven ở owner mode vì không có reporter JUnit. |
| B7 | `repository-setup.ts:19-26`, `runner-adapters/managed.ts:304,314` | `repository_setup` chỉ có thao tác git và npm. Runner Maven chạy `--offline` với cache `~/.m2/repository`. | Thiếu dependency Maven thì Coordinator không tự tải được. |

Ngoài ra còn một vấn đề về ngữ nghĩa: YAML đúng cú pháp không chứng minh CI làm đúng yêu cầu. "Chạy đúng sự kiện, concurrency, báo lỗi khi một shard fail, lưu báo cáo khi lỗi" là **hành vi** và cần test chạy được. Phân tích tĩnh chỉ là phần bổ sung (giữ luật ở `host-verification.ts:507`).

#### 6.2 Bất biến của GĐ6

Các bất biến ở mục 2 vẫn giữ. Thêm:

- **Phủ toàn workflow:** mọi tiêu chí bắt buộc chưa waive phải thuộc ít nhất một task. Hợp `requiredVerificationMethods` của các task phải chứa mọi method mà chính sách của toàn đặc tả đòi. Task `workflow-verification` (`FINAL_TASK`, `runtime.ts:3992`) giữ nguyên chính sách toàn đặc tả.
- **Trong một task** vẫn cấm trộn `manual_review` với tiêu chí hành vi. Ý định gốc của dòng 512 được giữ, chỉ đổi phạm vi áp dụng.
- `static_analysis` và `typecheck` không thay được bằng chứng hành vi.
- `auto:static` không bao giờ cho qua một tệp mà nó không phân tích. Tệp chưa có analyzer vẫn làm check thất bại, nhưng lỗi có mã và có đường sửa.
- Cấu hình của chủ dự án chỉ **cộng thêm** analyzer, không làm yếu runner tự phát hiện.
- Coordinator được tự **tăng** độ chặt của method (ví dụ `static_analysis` → `integration_test`). **Giảm** độ chặt (sang `manual_review` hoặc waive) vẫn phải qua thẻ quyết định của người dùng.

#### 6.3 Quyết định cần duyệt

| Mã | Quyết định | Ảnh hưởng |
|---|---|---|
| **D4** | Cổng nhận kế hoạch xét theo task, kèm bất biến phủ ở mục 6.2. | Chỉ trong `packages/runtime`. Không đổi contract. |
| **D5** | Thêm các `WorkflowRejectionCode` mà Coordinator sửa được: `task_evidence_mixed`, `task_policy_gap`, `static_analyzer_missing`. | Enum ở `workflow-rejection.ts:8` được journal parse (`journal.ts:210`). Bản cũ đọc journal mới sẽ từ chối, không ép kiểu. Ghi vào known limitations; không cần upcaster vì chỉ thêm. |
| **D6** | Thêm khóa `staticAnalyzers` (cộng dồn) vào `.bflow/verification.json`. Khóa này không tính là lệnh hành vi của chủ dự án, nên `TestRunnerSource.automatic` không đổi. | `apps/cli/src/agentic-host.ts` (thuộc P29) và parser trong runtime. Cập nhật `docs/verification-runners.md`. |
| **D7** | Bộ analyzer có sẵn cho `auto:static`: YAML, GitHub Actions (kiểm cấu trúc), shell, biên dịch JVM qua runner Maven/Gradle đã phát hiện, XML qua `xmllint` khi có. | Thêm `yaml` vào dependency của `packages/runtime`. Gói đã có trong lockfile (`yaml@2.9.1`, do `apps/cli` dùng), nhưng importer đổi nên đây là thay đổi integration. |
| **D8** | Thêm `repository_setup` cho JVM: `maven_go_offline` và `gradle_dependencies`. Có mạng, chỉ ghi vào cache dependency, không bao giờ ghi `settings.xml`. | Mở rộng bề mặt tool của Coordinator. Phải ghi rõ đây là thao tác có mạng. |

Nếu D8 không được duyệt, B7 trở thành blocker `fixableBy: "user"` kèm đúng lệnh cần chạy. Không để Coordinator đoán.

#### 6.4 Thứ tự

```
T6.0 Tái hiện bằng fixture [TT]
  ├──► T6.1 → T6.2 → T6.3   Cổng nhận theo task (B2, B3, B4)        nhánh fix/runtime/task-scoped-admission
  ├──► T6.4 → T6.5          Bộ analyzer + dự báo ở cổng nhận (B1, B5)  nhánh fix/runtime/static-analyzers
  ├──► T6.6                 staticAnalyzers cộng dồn (B6)            ∥, sau khi duyệt D6
  └──► T6.7                 repository_setup cho JVM (B7)            ∥, sau khi duyệt D8
T6.1 và T6.4 xong ──► T6.8 Hướng dẫn Coordinator/Director
Tất cả xong ──► T6.9 Kiểm tra, bàn giao, rồi chạy lại live trong GĐ5
```

Hai nhánh cùng sửa `host-verification.ts` nhưng ở hai vùng khác nhau: `assertSupported`/`assertTaskSupported` và `captureStaticAnalysis`/`policyDeterministicGate`. Merge nhánh cổng nhận trước. Riêng T6.5 phải rebase sau nhánh này vì nó gọi vào bước kiểm tra theo task.

#### T6.0 Tái hiện bằng fixture [TT, viết test trước]

1. Tìm journal thật của run trong `.bflow/state` của repo Maven (hoặc state dir của Bflow cho repo đó). Lấy ra proposal cuối cùng, `assessment`, `infrastructure.commands`, DAG, và chuỗi `workflowRejected`. Ghi các giá trị đó vào fixture. Nếu không tìm được, dựng hai biến thể: `taskType: "infrastructure"` với rủi ro `medium`, và một biến thể rủi ro `high`.
2. Test mới `packages/runtime/test/agentic/mixed-evidence-admission.test.ts`:
   - Repo git tạm gồm `pom.xml`, `src/main/java/...`, `src/test/java/...`, `.github/workflows/ci.yml`, `scripts/shard.sh`, `docs/testing.md`.
   - Có 5 tiêu chí như run. DAG gồm `task-ci` (sở hữu `pom.xml`, `.github/workflows`, `scripts`, `src/test/java`; 4 tiêu chí tự động) và `task-docs` (sở hữu `docs/testing.md`; tiêu chí `manual_review`).
   - Máy dev không có `mvn`. Dùng host runner giả theo khuôn `managed.test.ts` và `polyglot-measure.test.ts`, trả về các profile `auto-unit-maven…` và `auto-integration-maven…`.
3. Assert trạng thái đích:
   - Proposal được nhận.
   - Mỗi task qua `validateTaskCommands`.
   - Lỗi nào trên đường đi cũng là `WorkflowProposalRejected` với mã thuộc `AGENT_FIXABLE_REJECTIONS`.

   Ở HEAD hiện tại, các assert này phải **đỏ** đúng theo chuỗi B1 → B2. Ghi lại thông điệp lỗi đỏ vào mô tả PR để đối chiếu.

#### T6.1 Tách cổng toàn đặc tả và cổng theo task (B2, B3)

Sửa `host-verification.ts:485-527` và lời gọi ở `host.ts:1943`:

1. Chuyển `projectTaskSpecificationInput` từ `runtime.ts:273` sang một module riêng, `agentic/task-projection.ts`, để `host-verification.ts` dùng được mà không tạo vòng import. `runtime.ts` re-export lại để caller cũ không đổi.
2. Hàm chiếu nhận thêm `ownedPaths`. `affectedPaths` của spec task = các phần tử của `draft.affectedPaths` nằm trong `ownedPaths` (dùng `inPlannedScope`). Đây là sửa B3.
   - Kiểm lại hai chỗ dùng `affectedPaths` của spec task mà GĐ2 đã chuyển sang "dự kiến": `automaticTestPaths` và `authorizeTddPaths`.
   - Lối sửa phạm vi trong run (`runtime.ts:3629-3636`) đang dùng `task.spec`, đã ở mức task. Thêm test cho lối này.
3. Thêm `assertWorkflowSupported(spec, strategy, definition)` và dùng nó ở `host.ts:1943` thay cho `assertSupported`. Thứ tự kiểm:
   1. Schema và tách tiêu chí real-app như hiện nay.
   2. Mọi tiêu chí bắt buộc chưa waive phải thuộc ít nhất một `definition.tasks[].acceptanceCriteria`. Không đạt thì trả `invalid_specification`, nêu id tiêu chí.
   3. Với mỗi task, phân loại tiêu chí thành ba nhóm: `manual` (`manual_review`), `behavioral` (unit, integration, e2e và real-app), `deterministic` (`static_analysis`, `typecheck`). Task có cả `manual` và `behavioral` thì trả `task_evidence_mixed`, nêu id task và id tiêu chí của từng nhóm.
   4. Với mỗi task, chạy phần kiểm tra hiện có (B1, `assertDetectedSupported`, `assertPolicyMethods`) trên spec đã chiếu và chiến lược của task đó. Dùng lại đúng hàm mà `runtime.ts:4010` gọi, không viết luật song song.
   5. Kiểm bất biến phủ (T6.2).
4. Khi không có `definition` (caller cũ, chẳng hạn `host-verification.ts:1219` ở owner mode): giữ kiểm tra toàn đặc tả, nhưng ném `WorkflowProposalRejected` với mã `task_evidence_mixed` thay cho `Error`.
5. Dòng 512 trong `assertSupported` chỉ còn chạy với spec của một task. Xóa mục `Mixed manual…` khỏi `test/agentic/fixtures/execution-throw-allowlist.json`. Ở `docs/blocker-inventory.md:188`, đổi GIỮ thành "có kênh".

Test:
- Đặc tả trộn, DAG đã tách: nhận.
- Đặc tả trộn, một task chứa cả hai nhóm: `task_evidence_mixed`, `reportsToUser` là `false`, lý do nêu đúng task.
- Tiêu chí không thuộc task nào: bị từ chối.
- Task tài liệu có `draft.affectedPaths` chứa `.java`: không còn chạm dòng 509.
- Mọi test hiện có trong `host-verification.test.ts` vẫn xanh.

#### T6.2 Chính sách TDD theo task và bất biến phủ (B4)

1. Ở `runtime.ts:4006-4007`: nếu task không có `metadata.conditionalTdd` riêng, Runtime vẫn dùng `assessment` của toàn đặc tả. Nhưng `evaluatePolicy` phải chạy trên **tiêu chí và đường dẫn của task** (đường dẫn đã chiếu từ T6.1). Như vậy `testOnly`, `mislabeledDocs` và method lấy từ tiêu chí đều tính theo task.
2. Method do bề mặt sinh ra (`policy.ts:37-45`) chỉ gán cho task có đường dẫn khớp bề mặt đó:
   - `infrastructure`, `configuration`: task sở hữu tệp không phải tài liệu.
   - `ui_layout`: task sở hữu tệp UI.
   - Task chỉ có tài liệu không nhận các method này.

   Viết thành một hàm thuần `taskPolicyAssessment(draftAssessment, taskPaths)` trong `test-strategy`, hoặc trong runtime nếu chủ sở hữu `test-strategy` không nhận. Có test riêng.
3. Bất biến phủ: gọi `W` là tập method của chính sách toàn đặc tả (task `FINAL_TASK`), `T_i` là tập method của task i. Phải có `W ⊆ ∪ T_i`; không đạt thì trả `task_policy_gap`, nêu các method thiếu. Ngoài ra `manual_review` nằm trong `W` thì phải có ít nhất một task chứa tiêu chí `manual_review`, hoặc chính sách task đó đòi `manual_review`.
4. Coordinator ghi đè `assessment` theo task: được phép, nhưng vẫn phải qua bất biến phủ. Rủi ro của một task không được thấp hơn rủi ro của toàn đặc tả, trừ khi task đó chỉ chứa tài liệu.
5. Kiểm `workflow-verification` với run trộn: `behavioralEvidence` với `taskId = FINAL_TASK` và `test-strategy/src/evidence.ts:112` phải chấp nhận khi bằng chứng `manual_review` đến từ task tài liệu và bằng chứng hành vi đến từ task code. Nếu không chấp nhận, sửa cách gom bằng chứng ở mức workflow. Không được bỏ method.

Test:
- Task tài liệu với assessment `infrastructure` không bị đòi `integration_test`.
- Bỏ task tài liệu khỏi DAG (để mất `manual_review`) thì trả `task_policy_gap`.
- Repo không có TypeScript và assessment `configuration`: trả `task_policy_gap` hoặc `unsupported_method`, kèm hướng sửa. Không phải `Error` thường.
- Run trộn qua `connectedPhaseFixture` (`test/helpers/agentic-integration-fixture.ts`) tới `workflow-verification` được chấp nhận.

#### T6.3 Mã từ chối và journal (D5)

- Thêm ba mã vào `WorkflowRejectionCodeSchema` và `AGENT_FIXABLE_REJECTIONS`. Mỗi mã có câu hướng sửa trong `reason` và trong `options`.
- `task_evidence_mixed`: "Tách tiêu chí `manual_review` sang task riêng sở hữu tệp tài liệu."
- `task_policy_gap`: liệt kê method thiếu và task nên nhận method đó.
- `static_analyzer_missing`: xem T6.5.
- Test round-trip journal có mã mới. Test `recordProposalRejection` (`runtime.ts:2286`) vẫn gom lặp theo dấu vân tay.
- Thêm vào `docs/known-limitations-v3.md`: binary cũ đọc journal mới sẽ dừng ở bản ghi lạ, không ép kiểu.

#### T6.4 Bộ analyzer cho `auto:static` (B5, D7)

Module mới `agentic/static-analyzers.ts`. Mỗi analyzer gồm:

```ts
interface StaticAnalyzer {
  id: string;
  matches(path: string): boolean;
  detect(context): Promise<{ status: "available" } | { status: "missing"; reason: string }>;
  run(input: { cwd: string; revision: string; files: string[]; deadlineAt?: number }): Promise<{ exitCode: number; output: string }>;
}
```

Các analyzer có sẵn. Tệp luôn được đọc từ blob đã commit (`git show <revision>:<path>`); kiểm `capture()` trước và sau như hiện nay.

| Analyzer | Tệp | Cách kiểm |
|---|---|---|
| `whitespace` | mọi tệp | `git diff --check` (giữ) |
| `javascript`, `json`, `typescript` | như hiện nay | Chuyển nguyên mã từ `captureStaticAnalysis` sang |
| `yaml` | `.yml`, `.yaml` | Parse bằng `yaml` (`uniqueKeys: true`). Coi mọi `errors` và `warnings` là lỗi. Giới hạn kích thước tệp. |
| `github-actions` | `.github/workflows/*.y{a,}ml` | Sau YAML: phải có `on` và `jobs`. Mỗi job có `runs-on` hoặc `uses`. Mỗi step có `run` hoặc `uses`. Biểu thức `${{ }}` cân bằng. Có `actionlint` trên PATH thì chạy thêm trong sandbox (tìm theo khuôn `resolveSystemTool`, `declared-runner-adapter.ts:9`). |
| `shell` | `.sh`, `.bash`, tệp có shebang `sh` hoặc `bash` | `bash -n` hoặc `sh -n` trong sandbox. Có `shellcheck` thì chạy thêm. |
| `jvm-compile` | `.java`, `.kt`, `pom.xml`, `build.gradle*` thuộc project có profile Maven/Gradle đã phát hiện | Maven: `--offline -B -q -Dmaven.repo.local=/bflow-cache/maven test-compile`. Gradle: `--offline testClasses`. Chạy trong cùng sandbox và mount như runner (`managed.ts:291-330`): thêm một hàm bind `compile` cạnh `bind` cho test. Cách này kiểm cả `pom.xml` lẫn cú pháp và kiểu của Java. |
| `xml` | `.xml` khác `pom.xml` | `xmllint --noout` nếu phát hiện được. Không có thì là `missing`. |

Luật:
- Mỗi tệp đã đổi (trừ tài liệu như hiện nay) phải được ít nhất một analyzer khả dụng xử lý. Còn sót tệp thì check thất bại bằng `TaskBlocker("static_analyzer_missing", …, { paths, missingAnalyzers })`, mã mới trong `BLOCKERS` (`blockers.ts`) với `fixableBy: "director"`. Nhờ vậy GĐ1 park được thay vì lặp.
- Evidence phải liệt kê từng analyzer và các tệp nó đã kiểm. Câu tóm tắt nói rõ: "Phân tích cú pháp và cấu trúc. Không chứng minh hành vi CI."
- `policyDeterministicGate` (`host-verification.ts:422`) giữ nguyên giao diện, chỉ gọi qua bộ analyzer.

Test `static-analyzers.test.ts`, trên repo git tạm:
- YAML hợp lệ và không hợp lệ; YAML có khóa trùng.
- Workflow thiếu `jobs`.
- Shell lỗi cú pháp.
- Tệp `.toml` cho `static_analyzer_missing`, `details.paths` đúng.
- `jvm-compile` dùng host giả: assert argv, mount, `--offline`; không cần `mvn` thật.

Cập nhật test `host-verification.test.ts:122`: `.yml` giờ được phân tích, đuôi lạ vẫn thất bại.

#### T6.5 Báo trước ở cổng nhận khi chưa có analyzer (B1)

Bước kiểm tra theo task ở T6.1, mục 4: nếu task có tiêu chí `static_analysis`, hoặc chính sách task đòi `static_analysis`:

1. Lấy mọi đường dẫn có phần mở rộng trong `affectedPaths ∩ ownedPaths` của task. Tệp nào không có analyzer `available` khớp thì trả `static_analyzer_missing`. `reason` liệt kê tệp, và `options` gồm:
   - Coordinator đổi tiêu chí sang test hành vi (tăng độ chặt, không cần người dùng).
   - Chủ dự án thêm `staticAnalyzers` (T6.6).
   - Người dùng duyệt đổi sang `manual_review`.
2. Đường dẫn là thư mục thì không dự báo được. Để T6.4 kiểm ở bước đo.
3. Kết quả `detect` được cache theo revision gốc, như `TestRunnerSource.profilesForRevision`.
4. Thông điệp của B1 (`host-verification.ts:502`) nói rõ `auto:static` hiện phủ những loại tệp nào, lấy từ danh mục. Không viết cứng.

#### T6.6 `staticAnalyzers` cộng dồn trong `verification.json` (B6, D6)

```json
{ "schemaVersion": 1, "behavioralCommands": [],
  "staticAnalyzers": [{ "id": "actionlint", "executable": "/usr/local/bin/actionlint", "args": [],
    "include": [".github/workflows/*.yml"], "timeoutMs": 60000 }] }
```

- `apps/cli/src/agentic-host.ts:58`: thêm khóa vào danh sách cho phép. Gọi `runtime.parseStaticAnalyzers`, theo khuôn của `parseAppChecks`. Truyền qua `host-controller.ts`, cạnh `appChecks`.
- `executable` phải là đường dẫn tuyệt đối, nằm ngoài repo. Tệp khớp `include` được nối vào cuối argv. Chạy trong cùng sandbox như lệnh của chủ dự án, không có mạng.
- `staticAnalyzers` không thuộc `owner`, nên `TestRunnerSource.automatic` giữ nguyên. Chủ dự án thêm analyzer mà **không mất** runner Maven tự phát hiện.
- Ở owner mode, analyzer của chủ dự án cũng bật được tiêu chí `static_analysis`. Hiện nhóm `deterministic` chỉ áp dụng ở automatic mode (`host-verification.ts:496`); đây là thay đổi có chủ đích, cần test riêng.
- Ngoài phạm vi: chế độ "mở rộng" cho `behavioralCommands` (vừa lệnh của chủ dự án vừa tự phát hiện). Ca này đã có runner Maven tự phát hiện cộng với `staticAnalyzers`, nên không cần. Nếu sau này cần, ghi thành quyết định riêng.

Test:
- Parser từ chối đường dẫn tương đối, khóa lạ, `include` rỗng.
- Có `staticAnalyzers` thì `automatic` vẫn là `true`.
- Tệp khớp được analyzer của chủ dự án nhận, và T6.5 không còn báo thiếu.

#### T6.7 `repository_setup` cho JVM (B7, D8)

- `repository-setup.ts`: thêm `maven_go_offline { project }`, chạy `mvn -B -Dmaven.repo.local=<cache> dependency:go-offline`, và `gradle_dependencies { project }`.
- Có mạng, nhưng chỉ ghi vào cache dependency mà runner đang mount. Không đọc, không ghi `settings.xml`. Không chạy plugin ngoài pha resolve.
- Khi thiếu `mvn` (`managed.ts:293`, `missing("maven")`), thông điệp phát hiện runner nêu thao tác setup tương ứng, hoặc lệnh cài cho người dùng nếu D8 không được duyệt.

Test: argv và vùng ghi của từng thao tác; schema từ chối `project` ngoài repo.

#### T6.8 Hướng dẫn Coordinator và Director

Sửa ở `agents/coordinator/system-prompt.md`, `packages/runtime/src/director/guide.ts` và `planning_reference`:

- Tách task theo loại bằng chứng: tiêu chí `manual_review` nằm trong task riêng, sở hữu tệp tài liệu.
- Tiêu chí về hành vi CI (sự kiện kích hoạt, phiên bản Java, cache, concurrency, báo lỗi khi shard fail, lưu báo cáo) phải là `integration_test` với test thật, ví dụ:
  - test đọc tệp workflow rồi assert cấu trúc;
  - test chạy script chia shard rồi đối chiếu hợp các shard bằng đúng tập test, không trùng.

  `static_analysis` chỉ bổ sung.
- Coordinator được tăng độ chặt của method. Giảm độ chặt phải qua quyết định của người dùng.
- Khi DAG trộn task tài liệu và task code, ghi `metadata.conditionalTdd` riêng cho từng task nếu assessment khác nhau.
- Nêu ba mã từ chối mới và cách sửa từng mã.
- Chép đúng khuôn câu hiện có. Không đặt đường dẫn tệp trong backtick ở `skills/**`. Chạy test hành vi của `agents/**`.

#### T6.9 Kiểm tra và bàn giao

```bash
pnpm run build
pnpm exec vitest run packages/runtime/test/agentic/mixed-evidence-admission.test.ts packages/runtime/test/agentic/static-analyzers.test.ts packages/runtime/test/agentic/host-verification.test.ts packages/runtime/test/agentic/execution-throw-guard.test.ts
pnpm check:deps && pnpm typecheck
pnpm test:affected --base main --run
```

Tiêu chí xong. Mỗi điểm chặn ở 6.1 có test chứng minh đã được gỡ:

| # | Test chứng minh |
|---|---|
| B1 | T6.5: tệp không có analyzer bị báo ở cổng nhận với mã Coordinator sửa được; tệp có analyzer thì qua |
| B2 | T6.1: đặc tả trộn với DAG đã tách được nhận; task trộn bị trả `task_evidence_mixed` |
| B3 | T6.1: task tài liệu không còn chạm dòng 509 |
| B4 | T6.2: task tài liệu không bị đòi method của bề mặt code; bất biến phủ bắt được trường hợp thiếu |
| B5 | T6.4: YAML, workflow, shell, JVM được phân tích; tệp lạ cho `TaskBlocker` có mã |
| B6 | T6.6: analyzer của chủ dự án không tắt runner tự phát hiện |
| B7 | T6.7: có thao tác setup hoặc blocker người dùng kèm đúng lệnh |

Thêm vào đó:
- Fixture T6.0 đi hết chuỗi: proposal được nhận, đo `auto:static` và runner Maven giả, `workflow-verification` được chấp nhận.
- Không còn `Error` thường nào trên đường nhận kế hoạch cho các ca này. `execution-throw-guard.test.ts` xanh.
- Bộ test chống gian lận hiện có (`host-test-integrity`, mutation, Red độc lập) xanh mà không cần sửa kỳ vọng.

Live, đưa vào GĐ5:
- Chạy lại đúng yêu cầu của run `run-director-0c0c6957e5d223d9a30c1388` trên repo Maven, với `mvn` đã cài.
- Ghi số lần đề xuất tới khi được nhận, thời gian, và kết quả đo `auto:static` và Maven.
- Mức bằng chứng tách riêng: mã nguồn, test cục bộ, live.

## 6. Chia tệp để chạy song song không xung đột

| GĐ | Tệp chính | Nhánh |
|---|---|---|
| 0 | `blockers.ts` (mới), `behavioral-runner.ts:401`, `task-commands.ts` (chỗ ném lỗi), `host-verification.ts` (chỉ T0.4: `automaticGate` và `catch` của `gate()`), `host-development.ts` (tách `blockedReply`) | `fix/runtime/blocker-taxonomy` |
| 1 | `contracts/src/director.ts`, `no-progress.ts` (mới), `runtime.ts` (phase failure, resume), `auto-park.ts`, `journal.ts` (v9), `host.ts:2494`, `blockedReply`, telemetry, `agents/director/**`, `agents/coordinator/**` | `fix/runtime/no-progress-breaker` |
| 2 | `task-commands.ts`, `behavioral-runner.ts`, `host-verification.ts`, runner-results, `commandsFor` | `fix/runtime/observed-test-identity` |
| 3 | contracts, `runtime.ts` (tool mới), `tools.ts`, `agents/coordinator/**` | `fix/runtime/in-run-scope-amend` |
| 4a/4b | Tài liệu kiểm kê, test registry, lint | `fix/runtime/blocker-audit` |
| 6 (T6.0–T6.3, T6.8) | `host-verification.ts` (`assertSupported`, `assertTaskSupported`, `assertWorkflowSupported` mới), `task-projection.ts` (mới), `runtime.ts:273,4006`, `host.ts:1943`, `workflow-rejection.ts`, `journal.ts` (enum), `test-strategy` (assessment theo task), `agents/coordinator/**`, `director/guide.ts` | `fix/runtime/task-scoped-admission` |
| 6 (T6.4–T6.7) | `static-analyzers.ts` (mới), `host-verification.ts` (`captureStaticAnalysis`), `runner-adapters/managed.ts` (bind `compile`), `blockers.ts`, `repository-setup.ts`, `apps/cli/src/agentic-host.ts` (cần chủ P29 cho phép), `packages/runtime/package.json` + lockfile (integration) | `fix/runtime/static-analyzers` |

- GĐ1 và GĐ3 cùng sửa `runtime.ts`, nên không làm song song.
- GĐ1 và GĐ2 cùng chạm `host-development.ts`, nhưng ở hai hàm khác nhau. Việc tách `blockedReply` ở GĐ0 là ranh giới giữa hai bên.
- GĐ0 và GĐ2 cùng sửa `task-commands.ts`, `behavioral-runner.ts` và `host-verification.ts`. Không xung đột, vì GĐ0 tuần tự và phải merge vào `main` trước khi GĐ2 tạo nhánh. Sau GĐ0, các tệp này thuộc GĐ2.
- Mỗi nhánh tạo từ baseline đã chứa GĐ0, dùng một worktree riêng (theo `AGENTS.md`).

## 7. Effort ước lượng

Ước lượng từ việc đọc mã, chưa phải cam kết.

| GĐ | Effort | Đường găng |
|---|---|---|
| 0 | 1,5–2 ngày | Có |
| 1 | 4–6 ngày (gồm contract D2 và journal v9) | Có |
| 2 | 1–1,5 tuần | Song song với 1 |
| 3 | 1–1,5 tuần | Có, sau 1 |
| 4a/4b | 2–3 ngày | Song song |
| 4c | Làm dần | Không |
| 5 | 1–2 ngày | Có |
| 6 | 1,5–2 tuần (nhánh cổng nhận khoảng 1 tuần; nhánh analyzer khoảng 1 tuần, chạy song song) | Có, trước lần live cho repo JVM/CI |

- Phần cốt lõi (GĐ0, 1, 2, 3, 5) mất khoảng **3–4 tuần** nếu chạy song song đúng sơ đồ.
- Riêng GĐ0 và GĐ1 (khoảng 1 tuần) đã đủ chặn kiểu vòng lặp không tiến triển cho mọi luồng.

## 8. Rủi ro và biện pháp

| Rủi ro | Biện pháp |
|---|---|
| GĐ2 nới lỏng làm mất khả năng chống gian lận | Giữ bất biến ở mục 2. Bộ test chống gian lận là điều kiện để merge. |
| Thêm field journal làm vỡ recovery | Đã xác minh: theo khuôn v7/v8 (version chỉ nâng, validation lúc đọc). Field mới nằm sau journal v9, không cần upcaster. Có test restart. |
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

### Trạng thái GĐ2 (2026-11-09)

Đã làm và merge vào `main` local: T2.1 (chọn test từ diff), T2.2 (Verification và Developer: `commandsFor` bất đồng bộ đo trên diff đã commit, `authorizeTddPaths` bảo vệ hợp của tệp khai báo và tệp đã commit, tệp test trong thư mục kế hoạch được viết trước Red, Green/Refactor chỉ đo đúng các đường dẫn đã đo ở Red), T2.3 (tập con tên quan sát, `criterion_without_test`), T2.4 (proposal chỉ khai thư mục, docs, `TEST_PATH_RULE`), preflight `plannedRunnerCommands` cho kế hoạch chỉ khai thư mục test, `review-candidate-evidence.ts` chấp nhận receipt tập con khi mỗi tiêu chí có ít nhất một tên đã chạy, và nới hẹp `packages/verification/src/engine.ts`. Chủ dự án đã cho phép sửa `host-development.ts` (các caller của `commandsFor`), `review-candidate-evidence.ts` và preflight `host.ts`.
Hạn chế còn lại: preflight chạy trong closure của host cần Herdr thật, nên chỉ hàm `plannedRunnerCommands` được test (đơn vị), chưa có test host đầu-cuối. Tệp dưới thư mục test mà không thuộc tập test được đo vẫn là định nghĩa runner theo `runner-provenance`, nên test supplemental đặt trong `test/` bị bác ở Green; test supplemental phải nằm ngoài thư mục đó. Mức bằng chứng: mã nguồn và test cục bộ.
