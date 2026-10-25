# 7. Chạy workflow bugfix

> **Legacy P00–P10:** hướng dẫn API/demo của Runtime cũ. Các giới hạn tích hợp trong trang phản ánh giai đoạn đó; luồng hiện tại dùng [installation](installation.md), [getting started](getting-started.md) và [implementation status](../implementation-status.md).

> **Phạm vi legacy P00–P10.** Trang này giữ API/demo và đánh giá integration ở thời điểm trước P19.
> Dùng [hướng dẫn hiện tại](README.md) cho onboarding, lifecycle/config.yaml và P19.
> Không áp dụng các nhận định integration cũ hoặc thao tác Core trực tiếp để bypass policy P19.

## Template

`loadWorkflowDefinition("bugfix", options?)` (hoặc `createBugfixWorkflowDefinition`):

```text
plan (planner: root cause) → fix (developer: sửa + regression test) → review (reviewer) → qa (qa: regression)
```

| Task | Đặc điểm |
| --- | --- |
| `plan` | Tiêu chí: "Root cause identified", "Reproduction steps documented" |
| `fix` | `rework: { maxReworks: 2, onExhausted: "require_human" }`; tiêu chí: "Bug resolved", "Regression test passes" |
| `review` | `requiresApproval: true` |
| `qa` | gate `regression-qa-gate` (`after_result`, bắt buộc) |

Mặc định và tùy chọn ghi đè giống [feature](06-feature-workflow.md#template). Lưu ý ID task developer là `fix`, gate là `regression-qa-gate`; `gateId` của quality gate trong Runtime phải là `regression-qa-gate`.

Ngoài ra còn template `refactor` (`createRefactorWorkflowDefinition`): `plan → refactor → review → qa`.

## Thử với lỗi BUG-001 trong repo mẫu

Tái hiện lỗi:

```bash
cd examples/sample-repo
pnpm repro:bug     # FAIL: expected 3600, actual 3990
pnpm test          # 4 test hiện có vẫn pass — test hiện tại không bắt được lỗi
cd ../..
```

Chạy workflow bugfix (cần `pnpm build` trước):

```bash
node examples/runtime-demo/run-demo.mjs --workflow bugfix
```

Bước "developer" của demo chép `solutions/bugfix/src/cart.ts` (sửa lỗi) và `solutions/bugfix/test/cart-discount.test.ts` (regression test) vào workspace tạm. Gate `regression-qa-gate` chạy `pnpm test` ở đó → `passed` → run `succeeded`.

### Khi agent báo "đã sửa" nhưng thực ra chưa

```bash
node examples/runtime-demo/run-demo.mjs --workflow bugfix --skip-fix
```

Với `--skip-fix`, bước developer chỉ thêm regression test mà không sửa `src/cart.ts`, nhưng vẫn báo `status: "succeeded"`; QA cũng báo thành công. Gate chạy test độc lập, test regression fail, và kết quả là:

```text
qa         blocked    ... blockage=quality_gate: Quality gate regression-qa-gate failed
Quality gate regression-qa-gate on qa: failed (findings: NON_ZERO_EXIT_CODE)
```

Run dừng ở `blocked`. Cách xử lý: [mục 9](09-blocked-timeout-retry-resume.md).

## Các bước khi tự tích hợp

Giống [feature](06-feature-workflow.md#các-bước-khi-tự-tích-hợp), thay `implement` bằng `fix`:

1. `service.startRun(bugfixDefinition, { runId, input })` → `plan` được dispatch.
2. `completeTaskExecution(runId, "plan", ...)` với tài liệu root cause (`kind: "document"`), rồi `driveRun`.
3. `completeTaskExecution(runId, "fix", ...)` với patch (`kind: "patch"`) và kết quả test (`kind: "test-result"`), rồi `driveRun`.
4. `completeTaskExecution(runId, "review", { status: "succeeded", reviewDecision })`.
5. `service.approve(runId, { taskId: "review", decidedBy: "<người duyệt>" })` → `qa` được dispatch.
6. `completeTaskExecution(runId, "qa", ...)` → `regression-qa-gate` chạy.

Nên đưa lệnh tái hiện lỗi vào bộ test mà gate chạy (như `test/cart-discount.test.ts` trong demo); gate chỉ chứng minh được những gì lệnh của nó kiểm tra.
