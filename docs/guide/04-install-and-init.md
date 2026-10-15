# 4. Cài đặt và khởi tạo AI Flow SDLC

## Cài đặt và kiểm tra repository

```bash
git clone https://github.com/Leekiri1234/AI-flow-SDLC.git
cd AI-flow-SDLC
pnpm install --frozen-lockfile
pnpm check        # check:deps + typecheck + build + toàn bộ test
```

| Lệnh | Mục đích |
| --- | --- |
| `pnpm build` | Biên dịch các package ra `dist/` (bị ignore) |
| `pnpm typecheck` | `tsc -b` |
| `pnpm test` | Build rồi chạy toàn bộ Vitest |
| `pnpm check:deps` | Kiểm tra ranh giới và chu trình phụ thuộc |
| `pnpm check` | Ba kiểm tra trên |

Test dùng storage tạm và transport giả; không cần Herdr hay API key. Trên macOS xem [ghi chú TMPDIR](02-environment.md#macos).

## Khởi tạo một Runtime

Không có lệnh `init`. "Khởi tạo" nghĩa là ứng dụng tạo các port cụ thể, ghép chúng bằng `createRuntimeService` rồi gọi `service.init()`. Các package `@ai-flow/*` là private (không phát hành lên npm); đoạn dưới dùng được trong một package của workspace có khai báo các dependency này. Phiên bản chạy được ngay (import qua `packages/*/dist`) là [`examples/runtime-demo/run-demo.mjs`](../../examples/runtime-demo/run-demo.mjs).

```ts
import { DeterministicWorkflowEngine } from "@ai-flow/core";
import { openSqliteRunStore } from "@ai-flow/persistence";
import { openFilesystemArtifactStore } from "@ai-flow/artifact-store";
import { createAgentRegistry, loadWorkflowDefinition, seedMvpAgentRegistry } from "@ai-flow/agent-registry";
import { createDefaultSecurityPolicy, createPresetQualityGate } from "@ai-flow/quality-gates";
import { createRuntimeService } from "@ai-flow/runtime";

const stateDir = "/srv/ai-flow";          // thư mục do người vận hành cấu hình, đường dẫn canonical
const workspace = "/srv/repos/my-app";     // repository mà gate sẽ kiểm tra

const definition = loadWorkflowDefinition("feature");
if (!definition.ok) throw new Error(definition.error.message);

const runStore = openSqliteRunStore({ filename: `${stateDir}/runs.sqlite` }); // thư mục cha phải tồn tại
if (!runStore.ok) throw new Error(runStore.error.message);

const artifactStore = await openFilesystemArtifactStore({ root: `${stateDir}/artifacts`, storeId: "local" });
if (!artifactStore.ok) throw new Error(artifactStore.error.message);

const agentRegistry = createAgentRegistry({ stateFile: `${stateDir}/registry.json` });
const seeded = await seedMvpAgentRegistry(agentRegistry);
if (!seeded.ok) throw new Error(seeded.error.message);

const policy = createDefaultSecurityPolicy({ allowedRootDirs: [workspace] });
if (!policy.ok) throw new Error(policy.error.message);
const qualityGate = createPresetQualityGate({
  gateId: definition.value.qualityGates[0].id, // phải trùng gate trong workflow ("qa-gate")
  checkKind: "unit_test",                        // chạy `pnpm test` trong workspace
  workingDirectory: workspace,
  securityPolicy: policy.value
});
if (!qualityGate.ok) throw new Error(qualityGate.error.message);

const service = createRuntimeService({
  engine: new DeterministicWorkflowEngine({ definitions: [definition.value] }),
  runStore: runStore.value,
  artifactStore: artifactStore.value,
  agentRegistry,
  transport,            // một AgentTransport — xem bên dưới
  qualityGate: qualityGate.value
});

const ready = await service.init({ runtimeId: "my-runtime" }); // gọi transport.initialize
if (!ready.ok) throw new Error(ready.error.message);
```

Khi tắt tiến trình: `artifactStore.value.close()` và `runStore.value.close()`.

### Lưu ý khi ghép

- **Definition cho engine:** truyền `definitions: [...]` (hoặc `resolveDefinition`) cho `DeterministicWorkflowEngine`. Thiếu nó, `resume` sau khi khởi động lại thất bại với `Workflow definition <id>@<version> is unavailable for recovery`.
- **Một quality gate cho cả Runtime:** `RuntimePorts.qualityGate` là một instance duy nhất, được gọi cho mọi gate binding. `gateId` của nó phải trùng ID gate trong workflow, nếu không Core từ chối kết quả.
- **Transport:** Runtime cần một `AgentTransport` trả về handle có correlation `verified: true` để có thể ghi nhận kết quả. Herdr adapter hiện không đáp ứng điều này — xem [Herdr](03-herdr-setup.md#giới-hạn-khi-ghép-với-runtime). Demo dùng `OutboxTransport` chỉ dành cho minh họa.
- **Lease TTL:** dispatcher lấy lease với TTL = `max(timeout.executionTimeoutMs, 300000)` ms.

## Các thao tác của `ConcreteRuntimeService`

| Phương thức | Mô tả |
| --- | --- |
| `init(options?)` | Khởi tạo transport (chỉ một lần) |
| `startRun(definition, { runId?, input?, metadata?, idempotencyKey? })` | Validate definition, tạo run, dispatch các task sẵn sàng |
| `start(StartRunInput)` | Dạng theo hợp đồng của `startRun` |
| `orchestrator.completeTaskExecution(runId, taskId, result)` | Báo kết quả một task (xem [feature workflow](06-feature-workflow.md)) |
| `orchestrator.driveRun(runId)` | Dispatch các task sẵn sàng tiếp theo |
| `getRun(runId)` / `getRunStatus(runId)` / `findRuns(query)` | Đọc trạng thái |
| `watch(runId, { afterSequence?, signal? })` | Async stream `DomainEvent` |
| `approve(runId, { taskId?, decision?, decidedBy, reason? })` / `decide(ApprovalDecision)` | Quyết định của con người |
| `cancel({ runId, taskId?, reason?, requestedBy? })` | Hủy run hoặc một task |
| `resume(runId)` | Khôi phục từ checkpoint/event nếu cần, rồi `driveRun` |

Tất cả trả về `OperationResult<T>` (`{ ok: true, value }` hoặc `{ ok: false, error }`); luôn kiểm tra `ok`.
