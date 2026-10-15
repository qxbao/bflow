# 9. Xử lý blocked, timeout, retry và resume

Nguyên tắc chung:

- Mọi lỗi là `OperationResult` có `error.code`: `validation`, `conflict`, `not_found`, `timeout`, `transport_unavailable`, `unknown_delivery`, `cancelled`, `corruption`, `unsupported_version`. `conflict`/`timeout`/`transport_unavailable` chỉ được thử lại sau điều kiện tiên quyết (ví dụ đọc lại trạng thái). `unknown_delivery` **không bao giờ** được gửi lại mù quáng.
- Runtime **không có bộ hẹn giờ**. Không có gì tự chạy lại sau một khoảng thời gian; ứng dụng phải gọi `driveRun`/`resume`.

## Blocked

Xác định nguyên nhân qua `task.blockage.code` (`getRun`) hoặc event `task.status_changed`.

| Nguyên nhân | Dấu hiệu | Xử lý được hỗ trợ hiện nay |
| --- | --- | --- |
| Quality gate bắt buộc fail | `qa` `blocked`, `quality_gate`; event `quality_gate.evaluated` có `status: "failed"` | Đọc `findings`/`metadata` (lệnh, exit code). Runtime chưa có API chạy lại gate hay gỡ blocked. Lựa chọn đã kiểm chứng: `service.cancel(...)` rồi sửa mã và bắt đầu run mới |
| Agent báo bị chặn | `completeTaskExecution(..., { status: "blocked", blockage })` → task `blocked`, không tốn lượt retry | Xem [Gỡ blocked thủ công](#gỡ-blocked-thủ-công-mức-thấp) hoặc hủy |
| Hết lượt rework | review `blocked`, `manual_intervention` ("Rework limit exhausted…") | Con người quyết định; hủy hoặc gỡ thủ công |
| Giao prompt không chắc chắn, reconcile vẫn không chắc | Dispatch trả `error.code: "unknown_delivery"`, `manualInterventionRequired: true`; lease được giải phóng; event reconcile được ghi | Kiểm tra agent/pane bằng tay. **Không** gửi lại cho tới khi chứng minh được `not_delivered` |
| Hết retry với `failurePolicy: "block"` | task `failed`, run `blocked` | Chẩn đoán; hủy hoặc chạy run mới |
| Timeout với `onTimeout: "block"` | task `blocked` | Xem [Timeout](#timeout) |

Ví dụ chạy được:

```bash
node examples/runtime-demo/run-demo.mjs --workflow bugfix --skip-fix                       # → run blocked (quality_gate)
node examples/runtime-demo/run-demo.mjs --workflow bugfix --skip-fix --cancel-if-blocked   # → qa cancelled, run failed
```

### Hủy

```ts
await service.cancel({ runId: "feat-001", reason: "Abandon", requestedBy: "alice" });                   // cả run
await service.cancel({ runId: "feat-001", taskId: "implement", reason: "Abandon", requestedBy: "alice" }); // một task
```

Hành vi quan sát được trong demo: hủy một run đang `blocked` ở `qa` cho kết quả task `qa` `cancelled` và run `failed`.

### Gỡ blocked thủ công (mức thấp)

Runtime chưa có API `unblock`. Test `packages/runtime/test/scenarios/04-blocked-agent.test.ts` (4.2) gỡ blocked bằng port mức thấp: gọi `engine.transitionTask` (`from: "blocked"`, `to: "running"`, đúng `generation` và `expectedVersion`) trên **cùng instance engine** mà Runtime dùng, rồi ghi `emittedEvents` bằng `runStore.appendEvents` với `expectedVersion`/`expectedLastSequence` hiện tại. Đây là thao tác nâng cao, bỏ qua lớp Runtime; chỉ dùng khi đã hiểu [hợp đồng](../contracts.md) và có lý do rõ ràng.

## Timeout

Có ba loại timeout khác nhau:

1. **Timeout thao tác** (`OperationOptions`: `timeoutMs`, `deadline`, `signal`) cho từng lời gọi port. Hết hạn trước khi thao tác bắt đầu → `timeout` với `retrySafety: "not_started"`. Một `send` có thể đã vượt qua ranh giới transport thì trả `unknown_delivery`, không phải `timeout`. Hủy việc chờ cục bộ **không** chứng minh agent đã dừng.
2. **Timeout thực thi task** (`task.timeout`: `executionTimeoutMs`, `onTimeout: "fail" | "retry" | "block"`). Core áp dụng chính sách khi nhận một `AgentResult` có `status: "timed_out"`. Runtime **không** tự phát hiện quá hạn, và `completeTaskExecution` chỉ nhận `succeeded`/`failed`/`blocked`. Test 5.5 ghi kết quả `timed_out` bằng `engine.recordAgentResult` trực tiếp. Vì vậy phát hiện và ghi nhận timeout thực thi **chưa được hỗ trợ ở mức Runtime**.
3. **TTL của lease**: `max(executionTimeoutMs, 300000)` ms. Lease hết hạn giải phóng chỗ trong registry; nó không dừng agent.

## Retry

Báo một lần thử thất bại có thể thử lại:

```ts
await service.orchestrator.completeTaskExecution("feat-001", "qa", {
  status: "failed",
  retryable: true,
  error: { code: "flaky_test", message: "Integration test timed out" },
  summary: "Attempt failed"
});
```

Core chuyển task sang `retrying` và ghi `task.retry_scheduled` với `eligibleAt` nếu:
- `retryable: true`, và
- số lần thử trong generation hiện tại `< retry.maxAttempts`, và
- `retry.retryableErrorCodes` (nếu có) chứa `error.code`.

Sau `eligibleAt`, gọi `service.orchestrator.driveRun(runId)` (hoặc `service.resume(runId)`) để dispatch lần thử mới (`attempt` + 1). Gọi trước `eligibleAt` thì task vẫn ở `retrying`. Độ trễ có jitter tất định theo run/task/generation/attempt.

Khi hết lượt: `failurePolicy: "fail-fast"` → run `failed`; `"block"` → run `blocked`. (Kiểm chứng bởi `03-qa-failure.test.ts`.)

Lỗi khi dispatch (`driveRun` trả `ok: false`):

| `error.code` | Ý nghĩa | Hành động |
| --- | --- | --- |
| `not_found` | Không có agent `enabled` cho role | Đăng ký agent ([mục 5](05-roles-and-models.md)) rồi `driveRun` |
| `conflict` ("Agent concurrency limit reached") | Agent đã dùng hết `maxConcurrentTasks` | Chờ lease được giải phóng/hết hạn rồi `driveRun` |
| `conflict` ("Agent rejected prompt…") | Transport từ chối (ví dụ agent Herdr đang `blocked`) | Kiểm tra agent rồi `driveRun` |
| `unknown_delivery` | Không chứng minh được prompt đã/không đến | Can thiệp thủ công; không gửi lại |

## Resume sau khi khởi động lại

```ts
// tiến trình mới: mở lại store, tạo engine mới có definition, tạo service, init
const resumed = await service.resume("feat-001");
```

`resume` làm như sau khi engine chưa có run trong bộ nhớ:

1. Đọc run và definition từ RunStore.
2. Nạp checkpoint mới nhất. Chỉ chấp nhận codec `bflow.workflow-aggregate+json` v1; codec khác → `validation` (fail closed). Không có checkpoint → phát lại toàn bộ event từ `run.created`.
3. Phát lại event sau checkpoint qua `engine.recover`.
4. Với mỗi task `running`/`cancelling` đã bind, gọi `transport.reconcile` và ghi kết quả `bound`.
5. Gọi `driveRun`.

Ví dụ chạy được: `run-demo.mjs` đóng toàn bộ store giữa chừng, mở lại, tạo engine mới và gọi `service.resume(runId)` khi task review đang chạy.

Yêu cầu: engine mới phải được cấp definition (`new DeterministicWorkflowEngine({ definitions: [definition] })`), nếu không sẽ lỗi `Workflow definition … is unavailable for recovery`.

## Giới hạn đã biết

Các điểm sau là hành vi của mã hiện tại (đã quan sát hoặc đọc từ mã nguồn), cần quyết định tích hợp để thay đổi:

1. **Runtime + Herdr chưa chạy end-to-end.** Core chỉ chấp nhận kết quả khi handle đã bind có `correlation.verified: true`; Herdr adapter luôn trả `provenance: "orchestrator", verified: false`. Ngoài ra dispatcher luôn dùng `paneId: "pane-<role>"` và không đọc `settings.execution` của agent.
2. **Runtime không tự thu kết quả.** Không gọi `transport.wait`/`read`; người gọi dùng `completeTaskExecution`, và Runtime đánh dấu kết quả đó là `verified`. Người gọi chịu trách nhiệm chỉ báo kết quả đã được xác minh.
3. **Lease sau khi khởi động lại.** Lease của task được dispatch trước khi restart không được giải phóng khi task đó hoàn tất (Runtime chỉ theo dõi lease trong bộ nhớ). Lease giữ chỗ tới khi hết TTL (mặc định 5 phút) — đã quan sát trong `registry.json` của demo.
4. **Xác nhận dừng khi hủy.** `service.cancel` ghi `cancellation.stop_confirmed` ngay sau khi transport chấp nhận yêu cầu hủy, không quan sát việc agent thực sự dừng.
5. **Không có API Runtime** cho: gỡ blocked, chạy lại gate, ghi kết quả `timed_out`, hẹn giờ retry.
6. **Một QualityGate** cho mọi gate binding của một Runtime.
7. **Báo cáo handoff** giữ nội dung của lần sinh đầu tiên ([mục 8](08-status-and-artifacts.md#artifact)).
8. Các mục mở từ audit trước: P02-RA01 (timer của Herdr runner tràn khi > 2 147 483 647 ms) và P03-RA01 (`ArtifactStore.get` có thể trả trễ một chunk cuối sau deadline) — xem [README](../../README.md#reliability-boundaries-and-known-follow-ups).
