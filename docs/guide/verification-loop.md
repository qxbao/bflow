# Verification Loop

P17/P19 xác minh task trên GitChangeSet và spec/strategy đã freeze, sau đó P18
tích hợp theo dependency và P17 xác minh **workflow** trên revision tích hợp thật.
Task pass không thay cho post-integration verification hoặc approval giao kết quả.

Host cấu hình `taskChecks`, `workflowChecks`, deterministic `QualityGate` runners,
Reviewer/QA và authentication. Các checks này là inputs được project owner tin
cậy, không lấy tùy ý từ JSON agent. Trong example TypeScript, các lệnh có thật là
`pnpm typecheck`, `pnpm build`, `pnpm test`; manual docs review cần người/role độc
lập kiểm tra rendered document và command example. Khai báo tên check không tự
thực thi command hoặc chứng minh isolation.

| Outcome | Hành động |
| --- | --- |
| passed | Cần đủ criteria, exact revision và evidence độc lập trước khi tiến tiếp |
| failed | Known failed checks có thể yêu cầu Developer sửa trong giới hạn còn lại |
| inconclusive | Thiếu bằng chứng kết luận; escalate, không đoán là pass |
| blocked | Không thể xác minh vì điều kiện bên ngoài; escalate |

Seed dùng retry `maxAttempts: 2`, fixed delay 1000 ms, rework `maxReworks: 2`,
`onExhausted: require_human`, execution timeout 300000 ms với `onTimeout: fail`.
Các con số thuộc những cơ chế khác nhau:

| Cơ chế | Nguồn cấu hình | Ý nghĩa |
| --- | --- | --- |
| Execution retry | `task.retry` | Attempt budget cho implementation failure/retry |
| Rework generation | `task.rework` | Thay đổi sau quyết định changes_requested |
| Verification cycle | P19 `propose_workflow.maxIterations` | Default 3, cho phép 1–10, giới hạn P17 |
| Lifecycle timeout | `environment.*TimeoutMs`, `--timeout` | Deadline khởi động/tắt môi trường |

P12 validate `environment.verification.maxIterations` tới 100 nhưng chưa truyền
giá trị đó vào P19. Host phải chọn giới hạn 1–10 tường minh. P19 tăng attempt budget
cho repairs thêm `maxIterations - 1` và dùng gate metadata `boundedVerificationRetry`
cho required independent before_completion checks. Implementation retries và repairs
chia sẻ finite attempt budget; không nhân các budget để suy ra số lần thử vô hạn.

Khi hết vòng, Runtime escalate qua Conversation cho con người. Không giảm criteria,
đổi spec/strategy để test xanh hoặc tự tăng limit. Workflow verification fail sau
integration cần kế hoạch repair/delegation được chấp nhận mới; không tự sửa DAG đã
duyệt. Conflict giữ worktree/branch để giải quyết có kiểm soát.

Core replay giữ approval/retry/gate/cancellation state. Nếu crash trong verification,
host reconcile receipt P17 đã lưu trước khi chạy check mới; không dùng terminal
snapshot để suy ra kết quả. Xem [Session Recovery](session-recovery.md) và
[Security & Approval](security-approval.md).
