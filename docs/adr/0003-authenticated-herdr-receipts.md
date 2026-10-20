# ADR 0003 — Tương thích Herdr độc lập với release và authenticated binding receipt

Trạng thái: được project owner chấp nhận trong cuộc hội thoại này vào 2026-10-16:
“Bỏ cái chặn cứng mọi phiên bản ngoài 0.9.1 đi. Đừng để lần sau tái diễn. Proposal: duyệt”.
Đây là quyết định tích hợp mà AGENTS.md yêu cầu; nó phê duyệt đề xuất receipt trong
packages/runtime/P19-RECEIPT-DECISION-PROPOSAL.md.

Chuỗi release của CLI chỉ dùng để chẩn đoán. Protocol/schema và các thao tác thực tế quyết định
tính tương thích. Độ phủ regression phải bao gồm các release label cũ hơn và mới hơn nhưng tương thích
cũng như các wire schema thực sự không tương thích. Binary đã cài được kiểm thử mà không
yêu cầu nâng cấp chỉ vì release label của nó khác với một label đã kiểm thử trước đó.

Khả năng authenticated binding mở rộng WorkflowEngine thông qua một port riêng
AuthenticatedWorkflowEngine.verifyAgentBinding. Nó giữ nguyên handle bất biến ban đầu,
chỉ chấp nhận các receipt Ed25519 từ các issuer tin cậy do host cấu hình,
kiểm tra chính xác identity/target/session gốc và một receipt reference của ArtifactStore
gắn với nội dung, và persist một event agent.binding_verified riêng. Cả
Herdr done lẫn văn bản do agent viết đều không thể tạo ra bằng chứng này. Khóa ký nằm trong
native host tin cậy, bên ngoài prompt và các tham số tool hướng tới agent.

Các owner bị ảnh hưởng: Contracts/integration, Herdr Adapter/native host, Core/Runtime,
Conversation agent host và CLI lifecycle. Native ingress vẫn dùng Herdr; không có model API trực tiếp,
mailbox polling artifact hay đường vòng approval không liên quan nào được đưa vào.

Tương thích/migration: các command hiện có, event v0/v1 và aggregate checkpoint codec-v1
giữ nguyên hình dạng và hành vi. Event bằng chứng mới dùng envelope
schema version 2; các event không có receipt giữ v1. Command receipt của thao tác mới
cũng dùng event envelope v2 để các reader cũ từ chối nó. Các aggregate chứa bằng chứng
hoặc lịch sử command bằng chứng dùng aggregate codec v2. Schema envelope/checkpoint và
schema lưu trữ SQLite không đổi; không cần SQL migration hay upcaster bịa ra. Reader mới chấp nhận codec v1 không có bằng chứng và codec v2 với bằng chứng đã validate;
reader cũ fail closed với event/codec version mới. Query projection được duy trì
cũng giữ bindingVerification tùy chọn; các reader snapshot strict cũ từ chối field
mới này. Chỉ bật receipt sau khi nâng cấp tất cả reader của RunStore bị ảnh hưởng. Các binding lịch sử chưa được xác minh
vẫn chưa xác minh trừ khi có bằng chứng hợp lệ tường minh. Khóa phải tiếp tục được cấu hình
để xác minh receipt lịch sử; khi xoay khóa phải giữ lại các khóa xác minh cũ.

Các receipt đến muộn, không khớp, cũ, xung đột hoặc không có chữ ký bị từ chối. Bằng chứng không thể
mở lại cancellation hoặc execution đã terminal, cũng không thể thay thế binding hiện có. Runtime
kiểm tra thẩm quyền lease, ingest receipt bất biến, rồi ghi
event Core trước khi chấp nhận một kết quả conclusive. Các quality/verification gate độc lập vẫn
bắt buộc. Quyết định này không cho phép protected merge, triển khai production,
dọn dẹp phá hủy, thay đổi secret/quyền truy cập hay xuất bản từ xa.
