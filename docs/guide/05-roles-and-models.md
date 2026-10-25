# 5. Cấu hình vai trò và mô hình AI

> **Legacy P00–P10:** hướng dẫn API/demo của Runtime cũ. Các giới hạn tích hợp trong trang phản ánh giai đoạn đó; luồng hiện tại dùng [installation](installation.md), [getting started](getting-started.md) và [implementation status](../implementation-status.md).

> **Phạm vi legacy P00–P10.** Trang này giữ API/demo và đánh giá integration ở thời điểm trước P19.
> Dùng [hướng dẫn hiện tại](README.md) cho onboarding, lifecycle/config.yaml và P19.
> Không áp dụng các nhận định integration cũ hoặc thao tác Core trực tiếp để bypass policy P19.

Vai trò và cấu hình agent nằm trong `@bflow/agent-registry`. Registry lưu `AgentConfiguration` vào một file JSON trên máy cục bộ (`createAgentRegistry({ stateFile })`).

## Bốn vai trò MVP

| Role | Nhiệm vụ | Workspace | Output bắt buộc (khi dùng `validateRoleOutput`) |
| --- | --- | --- | --- |
| `planner` | Phân rã yêu cầu thành task DAG có tiêu chí chấp nhận | read-only | `PlannerOutput` |
| `developer` | Sửa mã trong worktree được giao | ghi, giới hạn trong worktree | `DeveloperOutput` (commit, file thay đổi, test tự báo) |
| `reviewer` | Review mã/bảo mật, không sửa file | read-only | `ReviewerOutput` (`approved` / `changes_requested`) |
| `qa` | Kiểm chứng độc lập, không tin lời agent | read-only | `QaOutput` |

Workflow chỉ được dùng 4 role này (`validateMvpWorkflowConventions`). Mọi cấu hình đều bị ép `allowTaskDelegation: false` và `requiresIndependentTestVerification: true`; planner/reviewer/qa bắt buộc `readOnlyWorkspace: true`.

## Cấu hình mặc định và ghi đè mô hình

`createDefaultMvpConfigurations()` / `seedMvpAgentRegistry(registry)` tạo một agent cho mỗi role:

| Role | `agentId` | provider | kind | model mặc định |
| --- | --- | --- | --- | --- |
| planner | `planner-default` | `anthropic` | `claude-code` | `claude-3-7-sonnet` |
| developer | `developer-default` | `openai` | `codex` | `gpt-4.1` |
| reviewer | `reviewer-default` | `anthropic` | `claude-code` | `claude-3-7-sonnet` |
| qa | `qa-default` | `google` | `gemini-cli` | `gemini-2.5-pro` |

Giá trị mặc định khác: `transport: "herdr"`, `enabled: true`, `priority: 10`, `maxConcurrentTasks: 1`, capability theo role.

Ghi đè theo role:

```ts
import { createAgentRegistry, seedMvpAgentRegistry } from "@bflow/agent-registry";

const registry = createAgentRegistry({ stateFile: "/srv/bflow/registry.json" });
const seeded = await seedMvpAgentRegistry(registry, {
  developer: { provider: "anthropic", kind: "claude-code", model: "claude-sonnet-5-5", maxConcurrentTasks: 2 },
  reviewer: { model: "claude-opus-5-5", temperature: 0 },
  qa: { provider: "google", kind: "gemini-cli", model: "gemini-2.5-pro", priority: 5 }
});
if (!seeded.ok) throw new Error(seeded.error.message);
```

Thêm một agent riêng (ví dụ agent developer thứ hai, ưu tiên cao hơn):

```ts
import { createMvpRoleConfiguration } from "@bflow/agent-registry";

const config = createMvpRoleConfiguration({
  agentId: "developer-codex",
  role: "developer",
  provider: "openai",
  kind: "codex",
  model: "gpt-4.1",
  priority: 20,
  maxConcurrentTasks: 1,
  execution: { paneId: "pane-developer" }
});
if (!config.ok) throw new Error(config.error.message);
const saved = await registry.upsert(config.value);
if (!saved.ok) throw new Error(saved.error.message);
```

Ràng buộc được kiểm tra: `provider`/`kind` không rỗng, `temperature` trong `[0, 2]`, `maxTokens` nguyên dương, `execution` chỉ gồm `paneId`, `workspaceId`, `tabId`, `terminalId`, `args`.

### Ý nghĩa thực tế của `provider` / `kind` / `model`

Các trường này là **dữ liệu cấu hình**, được lưu và validate. Hiện tại không có mã nào dùng chúng để chọn hay gọi mô hình: Runtime không đọc `settings`, và Herdr adapter chỉ nhận `kind` khi bạn gọi `startAgent({ name, kind, paneId })` trực tiếp. Mô hình thực sự chạy là do công cụ agent bạn khởi động trong pane Herdr quyết định.

## Chọn agent cho một task

`registry.resolve(role, context)` lọc agent `enabled`, đúng `role`, có đủ `requiredCapabilities`, rồi chọn `priority` cao nhất (hòa thì theo `agentId`). Resolve không giữ chỗ. Dispatcher của Runtime sau đó gọi `acquireLease` — lease tôn trọng `maxConcurrentTasks` và cấp fencing token tăng dần; agent hết chỗ trả về `conflict` ("Agent concurrency limit reached").

Kiểm tra workflow có đủ agent trước khi chạy:

```ts
import { verifyWorkflowRolesRegistered } from "@bflow/agent-registry";
const check = await verifyWorkflowRolesRegistered(definition, registry, "run-123");
// check.ok === false với code "not_found" nếu thiếu role
```

Xem registry hiện tại: `await registry.list()` hoặc `await registry.list("developer")`. Không thể sửa/xóa cấu hình của agent đang giữ lease.

## Prompt và kiểm tra output

Đây là các hàm thư viện; Runtime **không** tự gọi chúng khi dispatch (Runtime gửi `task.instruction` nguyên văn).

- `renderRolePrompt(role, params)` — tạo system/task prompt có quy tắc an toàn nội dung không tin cậy.
- `wrapUntrustedRepositoryContent`, `detectDangerousInstructions`, `validateUntrustedContentPolicy` — rào chắn prompt injection.
- `validateRoleOutput(role, rawOutput)` — kiểm tra JSON output theo role; `toContractAgentResult`, `toContractApprovalDecision`, `toContractQualityGateResult` ánh xạ sang hợp đồng.
- `buildCompleteFeatureWorkflowExample()` — ví dụ thư viện đi qua 4 role.

Chi tiết: [packages/agent-registry/README.md](../../packages/agent-registry/README.md).
