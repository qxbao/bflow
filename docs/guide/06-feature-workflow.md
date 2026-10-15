# 6. Chạy workflow feature

## Template

`loadWorkflowDefinition("feature", options?)` (hoặc `createFeatureWorkflowDefinition`) tạo DAG tuần tự:

```text
plan (planner) → implement (developer) → review (reviewer) → qa (qa)
```

| Task | Đặc điểm |
| --- | --- |
| `plan` | — |
| `implement` | `rework: { maxReworks: 2, onExhausted: "require_human" }` |
| `review` | `requiresApproval: true` — sau khi review xong, Runtime mở một approval cho con người |
| `qa` | gate `qa-gate` (`phase: "after_result"`, `required: true`) |

Mặc định: `maxConcurrency: 1`, `failurePolicy: "fail-fast"`, retry `{ maxAttempts: 2, exponential, 1000–5000 ms, jitter }`, timeout `{ executionTimeoutMs: 300000, onTimeout: "fail" }`. `options` có thể ghi đè `id`, `name`, `version`, `description`, `maxConcurrency`, `failurePolicy`, `maxReworks`, `retry`, `timeout`, `recovery`, `metadata`. Có thể nạp definition JSON tùy chỉnh bằng `loadWorkflowDefinition(jsonString)`; nó phải tuân thủ quy ước MVP (chỉ 4 role, có acceptance criteria, reviewer có `requiresApproval`, QA có gate bắt buộc).

## Chạy thử ngay

```bash
pnpm build
node examples/runtime-demo/run-demo.mjs --workflow feature
```

Demo chạy FEATURE-001 trên bản sao của `examples/sample-repo`; trạng thái cuối mong đợi là run `succeeded` và `qa-gate` `passed`. Demo không dùng AI agent — xem [runtime-demo](../../examples/runtime-demo/README.md).

## Các bước khi tự tích hợp

Giả sử đã có `service` như ở [mục 4](04-install-and-init.md).

### 1. Start

```ts
const started = await service.startRun(definition.value, {
  runId: "feat-001",
  input: { issue: "FEATURE-001" }
});
// started.value.status === "running"; task "plan" đã được dispatch (status "running")
```

Runtime ghi run + event vào SQLite, `advance`, resolve agent cho role `planner`, lấy lease, gọi `transport.send`, bind execution, rồi trả về snapshot. `startRun` **không chờ** agent làm xong.

### 2. Báo kết quả từng task

Agent làm việc ngoài Runtime. Khi có kết quả đã được xác minh, báo về:

```ts
import { createHash } from "node:crypto";
import type { ArtifactProposal } from "@ai-flow/contracts";

const content = "# Plan\n...";
const bytes = Buffer.from(content, "utf8");
const proposal: ArtifactProposal = {
  proposalId: "plan-doc-1",          // trở thành artifactId; chỉ [A-Za-z0-9._-]
  runId: "feat-001",
  taskId: "plan",
  kind: "document",                  // agent-output | document | log | report | patch | test-result | other
  logicalName: "plan.md",
  mediaType: "text/markdown",
  expectedIntegrity: {
    sizeBytes: bytes.byteLength,
    checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }
  }
};

const done = await service.orchestrator.completeTaskExecution("feat-001", "plan", {
  status: "succeeded",                // "succeeded" | "failed" | "blocked"
  summary: "Plan written",
  proposals: [proposal],
  contentByProposalId: { "plan-doc-1": content }
});
```

Runtime kiểm tra size/SHA-256 của nội dung rồi `put` vào ArtifactStore (sai checksum → `validation`, không ghi gì), ghi `AgentResult`, giải phóng lease, chạy các gate `after_result` của task.

Rồi dispatch task kế tiếp:

```ts
await service.orchestrator.driveRun("feat-001");   // dispatch "implement"
```

Lặp lại cho `implement`.

### 3. Review và rework

Task review báo quyết định qua `reviewDecision`:

```ts
await service.orchestrator.completeTaskExecution("feat-001", "review", {
  status: "succeeded",
  reviewDecision: "approved",          // hoặc "changes_requested"
  reviewReason: "Criteria met"
});
```

- `changes_requested`: task phụ thuộc trực tiếp (`implement`) chuyển `succeeded → ready` với `generation + 1`, và task review cũng được rework để chạy lại. Gọi `driveRun` để dispatch lại. (Kiểm chứng bởi `packages/runtime/test/scenarios/02-reviewer-rework.test.ts`.)
- Khi `generation` của task đích đã đạt `maxReworks`, một `changes_requested` nữa làm task review `blocked` với `manual_intervention` thay vì rework tiếp.

### 4. Phê duyệt của con người

Vì `review` có `requiresApproval: true`, sau khi review xong Runtime ghi `approval.requested`. Khi approval còn mở, `driveRun` không dispatch `qa`. Người duyệt quyết định:

```ts
const approved = await service.approve("feat-001", {
  taskId: "review",
  decidedBy: "alice",                 // định danh con người; tiền tố agent/ai/bot/system/qa/... bị từ chối
  decision: "approved",               // "approved" | "rejected" | "changes_requested"
  reason: "Looks good"
});
// approve gọi driveRun: "qa" được dispatch
```

`decision: "rejected"` hoặc `"changes_requested"` cần `reason`.

### 5. QA và quality gate

```ts
await service.orchestrator.completeTaskExecution("feat-001", "qa", { status: "succeeded", summary: "QA done" });
```

Gate `qa-gate` chạy lệnh đã cấu hình (ví dụ `pnpm test`) trong workspace. Gate `passed` → `qa` `succeeded` → run `succeeded`. Gate `failed` → `qa` `blocked` (code `quality_gate`) dù agent báo thành công. Xem [mục 9](09-blocked-timeout-retry-resume.md).

## Theo dõi

`service.getRun("feat-001")` và `service.watch("feat-001")` — xem [mục 8](08-status-and-artifacts.md).
