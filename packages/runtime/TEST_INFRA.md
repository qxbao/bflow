# Đặc tả hạ tầng kiểm thử tích hợp (`TEST_INFRA.md`)

## 1. Tổng quan & Sứ mệnh

`@bflow/runtime` là engine composition của kiến trúc bflow, tích hợp `@bflow/contracts`, `@bflow/core`, `@bflow/persistence`, `@bflow/artifact-store`, `@bflow/agent-registry`, `@bflow/herdr-adapter` và `@bflow/quality-gates`.

Tài liệu này thiết lập kiến trúc kiểm thử toàn diện, triết lý, ánh xạ độ bao phủ theo tầng, quy trình thực thi và danh mục scenario cho Milestone 2 (`M2`).

---

## 2. Triết lý kiểm thử & Nguyên tắc thiết kế

### 2.1 Storage không mock & Tính chân thực của trạng thái
- **SQLite database thật (`SqliteRunStore`)**: Mỗi integration test chạy trên một SQLite database tạm thời thật trên đĩa (`run-store.db`) dùng `node:sqlite` gốc. Các test xác minh cô lập transaction thực tế, xử lý tranh chấp `SQLITE_BUSY`, commit batch nhiều event nguyên tử, và aggregate checkpointing có phiên bản.
- **Filesystem POSIX thật (`FilesystemArtifactStore`)**: Lưu trữ artifact hoạt động trên các thư mục filesystem thật với xác minh digest toàn vẹn SHA-256, đổi tên nguyên tử, và tuân thủ nghiêm ngặt quyền POSIX.
- **Agent Registry dựa trên file thật (`FileAgentRegistry`)**: Phân giải agent, lấy lease, ràng buộc capacity và fencing token đơn điệu chạy trên các file trạng thái JSON thật với ngữ nghĩa file-locking giữa các instance.
- **Workflow Engine tất định (`DeterministicWorkflowEngine`)**: Chuyển trạng thái, xác thực phụ thuộc DAG, theo dõi generation rework có giới hạn và các recovery codec được thực thi bởi Core engine thật.

### 2.2 Mô phỏng transport tất định (`FakeAgentTransport`)
- Các transport network/subprocess bên ngoài được mô phỏng bằng một `FakeAgentTransport` tất định, trong bộ nhớ, triển khai `AgentTransport` của `@bflow/contracts`.
- Hỗ trợ các handler cấu hình được cho:
  - Chấp nhận prompt ngay lập tức (`status: "accepted"`) với các giá trị `AgentExecutionHandle` duy nhất.
  - Giao nhận mơ hồ của transport (`status: "unknown_delivery"`).
  - Agent từ chối tường minh (`status: "rejected"`).
  - Reconcile execution đang chạy (`transport.reconcile(...)`).
  - Hủy 3 giai đoạn (`transport.cancel(...)`).

### 2.3 Bất biến Schema & Lỗi nghiêm ngặt
- Mọi dữ liệu đi vào các port của runtime phải qua các Zod schema được export tại ranh giới ingress.
- Lỗi storage, engine và transport phải được biểu hiện thành các giá trị `ContractError` có kiểu (`conflict`, `corruption`, `validation`, `timeout`, `cancelled`, `not_found`).
- Không chấp nhận exception không có kiểu hay lỗi âm thầm.

### 2.4 Cô lập tài nguyên & Dọn dẹp tất định
- Mỗi test chạy trong một thư mục tạm cô lập được tạo qua `mkdtemp(join(tmpdir(), "bflow-runtime-test-"))`.
- Teardown hoàn chỉnh trong các khối `finally`: SQLite database được đóng, artifact stream được đóng, thư mục tạm bị xóa đệ quy.

---

## 3. Kim tự tháp kiểm thử bốn tầng (Tier 1 đến Tier 4)

| Tier | Name | Target Scope | Key Invariants Verified |
|---|---|---|---|
| **Tier 1** | **Ingress Safety & Schemas** | `@bflow/contracts` | Zod validation của mọi input, command, event batch, option và hình dạng lỗi tại ingress. |
| **Tier 2** | **Unit & Engine Invariants** | `@bflow/core`, `service.ts`, `dispatcher.ts`, `recovery.ts` | Chuyển DAG tất định, tiến triển status hợp lệ, retry delay, lease ttl, optimistic version. |
| **Tier 3** | **Port Composition & Storage** | `test/unit/`, `test/helpers/test-harness.ts` | Contract liên module: tính nguyên tử của SQLite event append, băm artifact filesystem, lease fencing token. |
| **Tier 4** | **End-to-End SDLC Scenarios** | `test/scenarios/01` to `08` | Workflow vòng đời đầy đủ, rework loop, khôi phục lỗi, reconcile transport, đồng thời diamond DAG. |
| *(Tier 5)* | *(Adversarial Hardening)* | *Milestone 3 (Challengers)* | *Chaos injection, payload agent thù địch, race condition, edge timeout.* |

---

## 4. Chỉ mục chính của 8 Integration Scenario

Bộ test Tier 4 gồm 8 integration scenario đầu-cuối cốt lõi nằm trong `packages/runtime/test/scenarios/`:

| # | Scenario File | Primary Focus | Key Invariants & Capabilities Verified |
|---|---|---|---|
| **1** | `01-happy-path.test.ts` | Complete 11-Step SDLC Workflow | Luồng đầy đủ: Planner → Developer → Quality Gate → Reviewer → QA → Handoff report được lưu trong `ArtifactStore` (`report-<runId>-handoff`) → Giữ phê duyệt trước merge (`waiting_for_approval`) → Operator ký duyệt qua `approve()` → Terminal `succeeded`. |
| **2** | `02-reviewer-rework.test.ts` | Bounded Rework & Exhaustion | Reviewer trả về `changes_requested`. Định tuyến feedback về Developer; generation tăng (gen 0 → 1 → 2). Tối đa `maxReworks: 2`. Khi cạn rework, dừng ngay ở `blocked` (`manual_intervention`) mà không xoay vòng vô hạn. |
| **3** | `03-qa-failure.test.ts` | QA Failure & Retry Policy | Thực thi task QA thất bại (exitCode 1, failure summary). Xác minh retry policy tối đa `maxAttempts: 2`. Dưới `fail-fast`, run chuyển sang `failed` với bằng chứng lỗi được lưu; dưới `block`, chuyển sang `blocked` để operator chẩn đoán. |
| **4** | `04-blocked-agent.test.ts` | Blocked Agent Observation | Agent báo `status: "blocked"` qua quan sát transport (`missing_dependency` hoặc `manual_intervention`). Task và run chuyển sang `blocked` mà không tiêu tốn lần retry. Operator `resume()` gỡ chặn thực thi cho đến khi hoàn thành. |
| **5** | `05-timeout-reconciliation.test.ts` | Timeout & Ambiguous Delivery | Transport trả về `unknown_delivery` hoặc timeout. Bất biến: KHÔNG BAO GIỜ gửi lại prompt một cách mù quáng. Gọi `transport.reconcile`: nếu `not_delivered`, retry an toàn; nếu `delivered`, bind handle và chờ quan sát mà không tạo task trùng lặp. |
| **6** | `06-restart-recovery.test.ts` | Restart Recovery & Aggregate Replay | Mô phỏng crash process. Một instance `RuntimeService` hoàn toàn mới dựng lại trạng thái từ SQLite `RunStore` bằng aggregate checkpoint (codec `bflow.workflow-aggregate+json`) + replay event tail từ `eventTailCursor`. Reconcile các execution đã bind và tiếp tục đến khi hoàn thành. |
| **7** | `07-persistence-failure.test.ts` | Persistence Failure & Invariant Safety | Mô phỏng lỗi ghi persistence khi event append, checkpoint save hoặc artifact put. Xác minh lỗi được biểu hiện thành `ContractError` có kiểu (`conflict` hoặc `corruption`). Bất biến: không hỏng trạng thái run, không có tuyên bố task thành công sai. |
| **8** | `08-dag-concurrency.test.ts` | DAG Topological Ordering & Concurrency | Diamond DAG với các sibling đồng thời (`implement_frontend` và `implement_backend`) hợp vào `integrate`. Xác minh thứ tự topo, giới hạn `maxConcurrency` của workflow, và ràng buộc capacity của registry với fencing token đơn điệu. |

---

## 5. Kiến trúc chi tiết: Scenario 6, 7 và 8

### 5.1 Scenario 6 (`06-restart-recovery.test.ts`)
- **Mục tiêu**: Đảm bảo một instance `RuntimeService` mới có thể khôi phục trạng thái aggregate trong bộ nhớ sau khi shutdown đột ngột hoặc crash và tiếp tục thực thi workflow đến khi hoàn thành mà không thực thi task trùng lặp hay hỏng trạng thái.
- **Pipeline khôi phục**:
  ```
  1. ports.runStore.get(runId) -> validates stored run envelope
  2. ports.engine.validateDefinition(storedRun.definition)
  3. ports.runStore.loadLatestCheckpoint(runId)
     ├── If Checkpoint Exists:
     │   ├── Validate codec: name === "bflow.workflow-aggregate+json" && version === 1
     │   ├── Decode aggregate state
     │   ├── Read event tail: sequence > checkpoint.eventSequence via eventTailCursor()
     │   └── engine.recover({ runId, checkpoint, events: tailEvents, expectedVersion })
     └── If No Checkpoint:
         ├── Read complete event history from sequence 1 (run.created)
         └── engine.recover({ runId, events: allEvents, expectedVersion })
  4. Reconcile in-flight bound executions:
     For each task in ["running", "cancelling"] with agentExecution !== undefined:
     ├── ports.transport.reconcile(handle)
     ├── engine.recordDeliveryReconciliation(reconcileResult)
     └── ports.runStore.appendEvents(reconciliationEvents)
  5. orchestrator.driveRun(runId) resumes execution loop to completion
  ```
- **Test Case**:
  - `6.1`: Khôi phục chuẩn với aggregate checkpoint + event tail + reconcile execution đã bind + tiếp tục đến terminal `succeeded`.
  - `6.2`: Khôi phục dự phòng từ lịch sử event đầy đủ khi không có checkpoint.
  - `6.3`: Từ chối validation theo kiểu fail-closed với checkpoint codec không hợp lệ hoặc không thuộc hệ thống.

### 5.2 Scenario 7 (`07-persistence-failure.test.ts`)
- **Mục tiêu**: Đảm bảo tuyệt đối tính toàn vẹn và an toàn dữ liệu trong điều kiện storage thù địch (đầy đĩa, lock timeout, vi phạm ràng buộc, ghi chưa commit).
- **Hai bất biến an toàn không thể thay đổi**:
  - **Invariant 1 (Zero State Corruption)**: Mọi `appendEvents`, `saveCheckpoint` hoặc `put` thất bại phải hủy sạch sẽ, để durable store ở trạng thái nhất quán, không hỏng, khớp với phiên bản đã commit trước đó.
  - **Invariant 2 (Zero False Task Success Claims)**: Một agent hoặc task KHÔNG BAO GIỜ được ghi nhận là `succeeded` hoặc được phép tiến các task phụ thuộc nếu domain event hoặc artifact proposal của nó không lưu được.
- **Test Case**:
  - `7.1`: Lỗi SQLite writer busy được mô phỏng biểu hiện thành `{ code: "conflict", retryable: true }` có kiểu mà không làm hỏng durable state; khi đã giải quyết, retry thành công sạch sẽ.
  - `7.2`: Lỗi I/O `ArtifactStore.put` được mô phỏng biểu hiện thành `{ code: "corruption" }` và chặn hoàn thành task; task vẫn không ở trạng thái succeeded và không có event `task.succeeded` nào được append.
  - `7.3`: Xung đột checkpoint save biểu hiện thành lỗi có kiểu mà không làm mất hiệu lực lịch sử domain event.
  - `7.4`: Xung đột optimistic concurrency khi append event song song thực thi lịch sử tuyến tính.

### 5.3 Scenario 8 (`08-dag-concurrency.test.ts`)
- **Mục tiêu**: Xác minh ngữ nghĩa thực thi của các Directed Acyclic Graph phức tạp với nhánh đồng thời, tài nguyên agent dùng chung và join barrier.
- **Cấu trúc topo (Diamond DAG)**:
  ```
               ┌────────────────┐
               │      plan      │ (role: planner)
               └───────┬────────┘
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
    ┌─────────────────┐ ┌────────────────┐
    │implement_frontend│ │implement_backend│ (role: developer)
    └────────┬────────┘ └────────┬───────┘
             │                   │
             └─────────┬─────────┘
                       ▼
               ┌────────────────┐
               │   integrate    │ (role: qa)
               └────────────────┘
  ```
- **Test Case**:
  - `8.1`: Thứ tự phụ thuộc topo nghiêm ngặt: `integrate` vẫn `pending` khi mới một sibling hoàn thành; chỉ runnable khi CẢ HAI sibling succeeded.
  - `8.2`: Giới hạn đồng thời của workflow: `definition.maxConcurrency: 1` tuần tự hóa việc thực thi sibling; `maxConcurrency: 2` cho phép thực thi song song.
  - `8.3`: Giới hạn capacity của registry: agent được cấu hình `maxConcurrentTasks: 1` từ chối các yêu cầu lease đồng thời với `{ code: "conflict" }`. Khi lease đầu được giải phóng, lease thứ hai lấy được slot với `fencingToken` đơn điệu tăng (`fencingToken: 2 > 1`).
  - `8.4`: Lỗi sibling upstream dưới `fail-fast` dừng an toàn nhánh join downstream.

---

## 6. Hướng dẫn thực thi & Lệnh xác minh

### 6.1 Điều kiện tiên quyết
- **Node.js**: `>= 22.13.0` (cần cho `node:sqlite` gốc không cần cờ).
- **Package Manager**: `pnpm` (phiên bản workspace được pin).
- **Hệ điều hành**: Linux / POSIX có hỗ trợ thư mục tạm.

### 6.2 Chạy Integration Test
Để thực thi toàn bộ scenario integration test:
```bash
pnpm --filter @bflow/runtime test test/scenarios/
```

Để chạy từng file scenario test riêng lẻ:
```bash
# Scenario 6: Restart Recovery
pnpm --filter @bflow/runtime test test/scenarios/06-restart-recovery.test.ts

# Scenario 7: Persistence Failure
pnpm --filter @bflow/runtime test test/scenarios/07-persistence-failure.test.ts

# Scenario 8: DAG Concurrency
pnpm --filter @bflow/runtime test test/scenarios/08-dag-concurrency.test.ts
```

### 6.3 Xác minh toàn bộ Workspace
Trước khi chốt bất kỳ milestone hay bàn giao git nào, chạy bộ validation đầy đủ từ root của workspace:
```bash
pnpm check:deps     # Verify zero circular dependencies or illegal cross-package imports
pnpm typecheck      # TypeScript compiler check across all packages
pnpm test           # Full Vitest suite across all 6 packages
git diff --check    # Check for whitespace and formatting issues
git status --short  # Verify clean working tree (no untracked databases, logs, or artifacts)
```
