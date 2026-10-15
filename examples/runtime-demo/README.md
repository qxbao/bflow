# Runtime demo

Script Node chạy workflow `feature` hoặc `bugfix` trên **bản sao** của [`../sample-repo`](../sample-repo/README.md) bằng các package đã triển khai:

- `DeterministicWorkflowEngine` (`@bflow/core`)
- SQLite `RunStore` (`@bflow/persistence`)
- Filesystem `ArtifactStore` (`@bflow/artifact-store`)
- File-backed `AgentRegistry`, MVP roles và workflow templates (`@bflow/agent-registry`)
- `CommandQualityGate` chạy `pnpm test` thật (`@bflow/quality-gates`)
- `createRuntimeService` (`@bflow/runtime`)

> **Không có AI agent nào chạy trong demo này và không dùng Herdr.** `OutboxTransport` (`outbox-transport.mjs`) chỉ ghi mỗi `AgentRequest` ra file `outbox/<requestId>.json`. Script đóng vai người vận hành: chép file có sẵn trong `solutions/` vào workspace và báo kết quả task cho Runtime. Chỉ quality gate của QA là thực thi lệnh thật. Xem lý do transport này đánh dấu correlation là `verified` trong chú thích đầu file `outbox-transport.mjs`.

## Chạy

Từ thư mục gốc repository (Node >= 22.13, pnpm 12.5.1):

```bash
pnpm install --frozen-lockfile
pnpm build

node examples/runtime-demo/run-demo.mjs --workflow bugfix
node examples/runtime-demo/run-demo.mjs --workflow feature
node examples/runtime-demo/run-demo.mjs --workflow bugfix --skip-fix
node examples/runtime-demo/run-demo.mjs --workflow bugfix --skip-fix --cancel-if-blocked
```

| Tùy chọn | Ý nghĩa |
| --- | --- |
| `--workflow bugfix\|feature` | Template từ `loadWorkflowDefinition` (mặc định `bugfix`) |
| `--state-dir DIR` | Thư mục trạng thái; phải mới/trống. Mặc định: thư mục tạm `bflow-demo-*` |
| `--skip-fix` | Bước developer chỉ thêm test mới, không sửa `src/` — mô phỏng agent báo thành công sai |
| `--cancel-if-blocked` | Nếu run kết thúc ở `blocked`, gọi `service.cancel(...)` |

Node 22 in `ExperimentalWarning` cho `node:sqlite`; đây là cảnh báo bình thường.

## Kết quả đã kiểm chứng

| Lệnh | Trạng thái cuối |
| --- | --- |
| `--workflow bugfix` | run `succeeded`; gate `regression-qa-gate` `passed` |
| `--workflow feature` | run `succeeded`; gate `qa-gate` `passed` |
| `--workflow bugfix --skip-fix` | run `blocked`; task `qa` bị chặn với `quality_gate`, finding `NON_ZERO_EXIT_CODE` |
| `--workflow bugfix --skip-fix --cancel-if-blocked` | task `qa` `cancelled`; run `failed` |

Các bước script thực hiện: start → hoàn tất planner → developer → **đóng và mở lại toàn bộ store, tạo engine mới, `service.resume(runId)`** (khôi phục từ checkpoint + event, reconcile outbox) → reviewer approve → `driveRun` không dispatch QA khi còn approval mở → người vận hành `service.approve(...)` → QA → gate chạy `pnpm test` trong workspace.

## Đọc trạng thái sau khi chạy

```bash
node examples/runtime-demo/inspect-run.mjs --state-dir <DIR>                         # liệt kê run
node examples/runtime-demo/inspect-run.mjs --state-dir <DIR> --run-id <RUN_ID>       # task, checkpoint, event, approval, gate, artifact
node examples/runtime-demo/inspect-run.mjs --state-dir <DIR> --run-id <RUN_ID> --show <ARTIFACT_ID>
```

`run-demo.mjs` in sẵn lệnh `inspect-run.mjs` đúng ở cuối output.

## Bố cục thư mục trạng thái

```text
<DIR>/
  workspace/      bản sao sample-repo mà developer/gate làm việc
  runs.sqlite     SQLite RunStore (event, receipt, projection, checkpoint)
  artifacts/      Filesystem ArtifactStore (catalog.sqlite + blob)
  registry.json   AgentRegistry (cấu hình, lease, fencing)
  outbox/         AgentRequest do OutboxTransport ghi
```

Hướng dẫn đầy đủ: [docs/guide](../../docs/guide/README.md).
