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
   GĐ0–GĐ3 xong ──► GĐ5  Kiểm chứng live (tuần tự)
```

Ký hiệu: **[TT]** = tuần tự, nằm trên đường găng. **[∥]** = làm song song được.

## 5. Chi tiết từng giai đoạn

### GĐ0: Phân loại lỗi chặn [TT], khoảng 1,5–2 ngày

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
- Test: chạy lại test hành vi của `agents/**`; tìm bằng `command grep -rln "system-prompt.md" packages/*/test agents`.

#### T1.8 Telemetry [∥ với T1.7, sau T1.5]

- `packages/runtime/src/telemetry/report.ts` (`readWorkflowTelemetry`, được `runtime.ts:1721` dùng trong `telemetryReport`): thêm `blockers: { code, fixableBy, count, lastAt, resumeSkipped }[]`, tổng hợp từ `phaseFailure.blocker` trong outbound của run.
- Cập nhật formatter của `bflow status --telemetry` trong `apps/cli/src/formatters.ts`.
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

1. Contracts: thêm schema input/output cho `amend_task_scope` (D3), kèm ghi chú compatibility và migration. `plan_mismatch` (D2) đã có từ GĐ1.
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
| 0 | `blockers.ts` (mới), `behavioral-runner.ts:401`, `task-commands.ts` (chỗ ném lỗi), `host-verification.ts` (chỉ T0.4: `automaticGate` và `catch` của `gate()`), `host-development.ts` (tách `blockedReply`) | `fix/runtime/blocker-taxonomy` |
| 1 | `contracts/src/director.ts`, `no-progress.ts` (mới), `runtime.ts` (phase failure, resume), `auto-park.ts`, `journal.ts` (v9), `host.ts:2494`, `blockedReply`, telemetry, `agents/director/**`, `agents/coordinator/**` | `fix/runtime/no-progress-breaker` |
| 2 | `task-commands.ts`, `behavioral-runner.ts`, `host-verification.ts`, runner-results, `commandsFor` | `fix/runtime/observed-test-identity` |
| 3 | contracts, `runtime.ts` (tool mới), `tools.ts`, `agents/coordinator/**` | `fix/runtime/in-run-scope-amend` |
| 4a/4b | Tài liệu kiểm kê, test registry, lint | `fix/runtime/blocker-audit` |

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
