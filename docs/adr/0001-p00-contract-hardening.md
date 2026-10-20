# ADR 0001: Củng cố contract P00 trước khi triển khai

- Trạng thái: Đã chấp nhận trên `fix/p00-contract-hardening`
- Baseline: `8d960d02d4f39d555ddd509a7606cc7ff6e750f2`
- Phạm vi: chỉ gồm contract, pure validator, tài liệu và contract test

## Bối cảnh

Đợt audit độc lập P00 phát hiện các contract bootstrap không thể biểu diễn an toàn việc gửi prompt không chắc chắn, danh tính transport bền vững, việc tách vòng đời Herdr khỏi kết quả task, và tính tương thích của event/checkpoint. Audit cũng chỉ ra các điểm chặn tích hợp liên quan đến lỗi, quality gate, approval, transition, concurrency, độ tin cậy của artifact và cancellation.

Vì chưa có package triển khai nào chứa business logic, P00 là thời điểm ít tốn kém nhất để thực hiện các thay đổi phá vỡ có chủ đích và đóng băng một baseline nhất quán.

## Quyết định

1. Các port bất đồng bộ công khai dùng `OperationResult<T>` và các giá trị `ContractError` dạng discriminated.
2. Việc gửi agent (submission), quan sát transport và kết quả nghiệp vụ đã xác minh là các type riêng biệt. Một locator trung lập bền vững và nguồn gốc correlation nằm trong `AgentExecutionHandle`.
3. Unknown delivery không được retry cho đến khi reconciliation chứng minh rõ `not_delivered`; thiếu bằng chứng thì cần can thiệp thủ công.
4. Domain event và checkpoint dùng schema version độc lập. Các helper tương thích thuần túy hỗ trợ dạng gốc không có version như v0 và từ chối các version không biết.
5. Command/event của workflow bao phủ execution binding, delivery reconciliation, gate request/result, approval request/decision, và cancellation request/acknowledgement/stop.
6. Các validator thuần túy cho transition và event-batch định nghĩa các bất biến ngữ nghĩa dùng chung giữa core và persistence.
7. Registry lookup vẫn tách biệt với các capacity lease nguyên tử. Artifact proposal vẫn không đáng tin cho đến khi store xác minh.

## Ánh xạ finding sang thay đổi

| Finding | Cách contract giải quyết | Các file chính | Test chứng minh |
| --- | --- | --- | --- |
| P0-01 | Locator/handle bền vững, các event execution-bound và delivery, thao tác reconcile, cấm gửi lại | `agent.ts`, `events.ts`, `ports.ts`, `orchestration.ts` | `agent-transport.test.ts`, `versioning-events.test.ts` |
| P0-02 | Submission receipt và lifecycle observation được tách khỏi verified result | `agent.ts`, `ports.ts` | `agent-transport.test.ts` |
| P0-03 | Schema và codec version của event/checkpoint với các upcaster v0 | `events.ts`, `execution.ts`, `versioning.ts` | `versioning-events.test.ts` |
| P1-01 | Quy ước error/result có kiểu với retryability cố định | `errors.ts`, `ports.ts` | `safety-contracts.test.ts` |
| P1-02 | Định nghĩa/binding của workflow gate và command/event đánh giá | `workflow.ts`, `quality.ts`, `orchestration.ts`, `events.ts` | `workflow.test.ts` |
| P1-03 | Approval target bắt buộc, revision/generation/idempotency/evidence | `approval.ts`, `events.ts`, `orchestration.ts` | `safety-contracts.test.ts` |
| P1-04 | Bảng transition chuẩn tắc cho task/run và validation command/event | `transitions.ts`, `orchestration.ts`, `events.ts` | `workflow.test.ts` |
| P1-05 | Lease acquire/renew/release với expiry, fencing và version | `registry.ts`, `ports.ts` | `safety-contracts.test.ts` |
| P1-06 | Tách tin cậy proposal/reference, ID/URI/checksum có ràng buộc, integrity kỳ vọng | `artifact.ts`, `agent.ts`, `quality.ts` | `safety-contracts.test.ts` |
| P1-07 | Cancellation intent có version, chấp nhận/từ chối và xác nhận stop | `execution.ts`, `events.ts`, `ports.ts` | `safety-contracts.test.ts`, `workflow.test.ts` |
| P2 | Tinh chỉnh retry/thời gian và bất biến event-batch | `execution.ts`, `agent.ts`, `orchestration.ts` | tất cả các contract suite |

## Migration từ baseline P00 ban đầu

Đây là bản sửa đổi phá vỡ có chủ đích trước khi triển khai:

- `AgentTransport.send` trả về receipt; `wait` trả về transport observation; `reconcile` là mới.
- Mọi giá trị trả về Promise của port đều được bọc bằng `OperationResult`; các stream yield kết quả có kiểu.
- Request/result/event/checkpoint, workflow definition/task state, approval, artifact và bản ghi cancellation có thêm các field bắt buộc.
- Các giá trị event/checkpoint cũ không có version phải đi qua các helper tương thích; stream sequence và aggregate version được giữ nguyên khi upcast.
- Output của agent/gate trả về `ArtifactProposal`, không phải stored reference đáng tin cậy.
- Agent registry bổ sung các thao tác lease tường minh, còn workflow engine bổ sung các method binding/reconciliation/gate/approval/cancellation.

P00 không có triển khai migration dữ liệu. Các helper chỉ upcast metadata version/codec khi phần payload còn lại hợp lệ theo schema hiện tại; chúng không bịa ra bằng chứng về identity, target, correlation hay trust mới được yêu cầu. Nếu một prototype đã lưu các giá trị không tương thích từ `8d960d0`, phase sở hữu nó phải cung cấp migration từng event tường minh hoặc replay từ nguồn có thẩm quyền theo cơ chế migration mà phase đó chọn.

## Hệ quả và công việc hoãn lại

Các contract giờ có thể biểu diễn các workflow đã được audit mà không cần thêm thay đổi phá vỡ nào đã biết. Bản thân chúng không làm cho hành vi runtime trở nên nguyên tử hay đúng đắn. P01–P05 vẫn phải triển khai và kiểm thử scheduling, ánh xạ Herdr, transaction bền vững/upcasting, thực thi checksum/path, lease/fencing, chạy gate và thứ tự use-case. Live Herdr, migration SQLite, E2E recovery và production readiness được hoãn lại một cách tường minh.
