# Đề xuất: xác minh receipt và binding Herdr có xác thực

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

Trạng thái: **APPROVED** bởi chủ dự án trong cuộc hội thoại này vào 2026-10-16
(“Proposal: duyệt”). Quyết định triển khai, kế hoạch tương thích và các owner bị ảnh hưởng
được ghi lại trong [ADR 0003](../../docs/adr/0003-authenticated-herdr-receipts.md).
Đề xuất gốc bên dưới được giữ lại như lịch sử quyết định; README của Runtime
và báo cáo validation hiện tại mô tả phạm vi đã triển khai so với phạm vi đã xác minh live.

## Ranh giới lỗi chính xác

`HerdrCliTransport.send()` hiện trả về một `AgentExecutionHandle` có
`correlation` là `{ provenance: "orchestrator", verified: false, token: ... }`.
`HerdrCliTransport.read()` phát ra `AgentMessage.kind: "status"` với
`data.source: "terminal_snapshot"`, `correlationVerified: false` và
`executionOutputVerified: false`.

`WorkflowEngine.recordAgentResult(RecordAgentResultCommand)` yêu cầu đúng đắn
cả binding đã lưu và result được gửi đều mang correlation khớp, đã xác minh.
`WorkflowEngine.bindAgentExecution(BindAgentExecutionCommand)` và
`recordDeliveryReconciliation(RecordDeliveryReconciliationCommand)` từ chối mọi
việc thay thế một binding hiện có. `AgentMessageSchema.kind` hiện không có
biến thể result/receipt có cấu trúc.

Fixture lỗi: `packages/runtime/test/agentic/integration.test.ts`, trường hợp
“refuses the actual Adapter-style unverified orchestrator handle as task success”.
Task vẫn ở trạng thái running và không bao giờ vượt qua completion gate. Gỡ bỏ kiểm tra đó
hoặc khẳng định `verified: true` sẽ là bịa ra bằng chứng.

## Hướng tương thích đề xuất để owner review

1. Định nghĩa ingress `RoleMessage`/receipt có cấu trúc và có xác thực trên một phiên bản Herdr
   thực sự được hỗ trợ. Chỉ rõ native host hook/channel, định danh process đã xác thực,
   binding pane/session, định danh delivery và việc thu thập output khách quan. Không
   scrape terminal snapshot hay tin JSON do agent viết.
   Xác minh các lệnh/sự kiện Herdr khả dụng trước khi chọn cách triển khai.
2. Giữ submission handle bất biến hiện tại và sự kiện `agent.execution_bound` đã được lưu của nó.
   Đưa vào một hành động xác minh riêng biệt, dựa trên receipt, thay vì thay thế
   handle qua một phương thức bind hiện có.
3. Capability bổ sung ứng viên (tên/signature tùy thuộc quyết định của owner):

   ```ts
   interface AuthenticatedWorkflowEngine extends WorkflowEngine {
     verifyAgentBinding(
       command: VerifyAgentBindingCommand,
       options?: OperationOptions
     ): Promise<OperationResult<WorkflowAdvanceResult>>;
   }
   ```

   Command nên chứa `runId`, `taskId`, `expectedVersion`, `requestId`,
   `executionId`, `attemptId`, target/session locator gốc chính xác, một
   `SubmissionCorrelation` remote/transport đã xác minh, một tham chiếu receipt bất biến
   xuất phát từ ArtifactStore, định danh verifier, `occurredAt` và `idempotencyKey`.
   Việc xác minh phải ràng buộc tất cả các định danh đó với một request đã được ghi nhận trước đó.
   Nó không được thay đổi target, task attempt, ý định hủy hay idempotency key.
4. Thêm một domain event tường minh cho bằng chứng đó và trạng thái aggregate checkpoint tương ứng.
   Runtime xác thực và ingest receipt trước khi gọi Core; Core thực thi định danh,
   vòng đời hợp lệ và replay tất định. Khẳng định của agent và correlation do orchestrator
   sinh ra bị từ chối. Bằng chứng đến muộn không thể mở lại một execution đã bị hủy hoặc đã kết thúc.
5. Giữ nguyên các consumer `WorkflowEngine` v1 thông qua capability negotiation hoặc
   một port mở rộng riêng. Các event/checkpoint hiện có vẫn đọc được. Mọi phiên bản mới
   của event/schema/aggregate codec đều cần một ma trận tương thích được tài liệu hóa
   và migration được duyệt. Upcaster không bao giờ được bịa ra bằng chứng receipt còn thiếu.
   Các run cũ với binding chưa xác minh vẫn ở trạng thái inconclusive cho đến khi có bằng chứng
   hợp lệ tường minh. Reader cũ fail closed trước bằng chứng mới không được hỗ trợ.

## Các owner bị ảnh hưởng và bằng chứng nghiệm thu

- Contracts/integration: quyết định tường minh, wire schema, event/checkpoint codec,
  version negotiation và review migration/upcaster.
- Herdr Adapter/native host: ingress có kiểu và có xác thực thực sự cùng việc xác minh receipt;
  bằng chứng về version/protocol và hành vi reconnect.
- Core/Runtime: xác minh binding độc lập, persistence, idempotency,
  fencing, hủy và khôi phục sau crash tại các ranh giới receipt.
- Conversation/agent host: đăng ký prompt/tool gốc và việc bơm (pump) inbound độc lập;
  nguồn gốc phê duyệt của người dùng; mọi lưu lượng AI-to-AI vẫn đi qua Herdr.
- CLI/lifecycle: ghép native host vào `up`/`down` và shutdown barrier của nó
  mà không tạo session khác hay bỏ qua các run P19 đang hoạt động.

Validation bắt buộc gồm từ chối receipt giả mạo/cũ/replay, từ chối sai pane/
session/attempt/execution, delivery đồng thời/đã hủy, SIGKILL trước
và sau khi ingest receipt/append event/checkpoint, fixture tương thích, kiểm tra
toàn monorepo đầy đủ, và một session Herdr cô lập thật với một lần xác minh
được thực thi độc lập và một lần phê duyệt người dùng có xác thực. Cho đến lúc đó, live delivery vẫn
**NO-GO**. Việc phê duyệt đề xuất này cho phép thiết kế/triển khai ranh giới đã được review đó;
nó không cho phép protected merge, production deploy, thay đổi secret,
dọn dẹp mang tính hủy hoại hay xuất bản từ xa.
