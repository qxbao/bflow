# ADR 0002: Đóng các khoảng trống contract về recovery và rework của P01

- Trạng thái: Đã chấp nhận cho việc khắc phục P01 theo yêu cầu của project owner, 2026-10-14; cần review độc lập trước khi tích hợp
- Baseline: `93147ec` (P00 hardening cộng P01 ban đầu)
- Owner phê duyệt: project owner cho phép khắc phục P01
- Các owner bị ảnh hưởng: contracts/integration, P01 Core, P03 persistence, P06 Runtime

## Bối cảnh

Đợt audit độc lập P01 đã tái hiện việc mất approval, gate, cancellation và idempotency sau khi recovery chỉ từ snapshot checkpoint. Lịch sử event đầy đủ cũng thiếu command fingerprint và ranh giới kết quả cần thiết để trả về kết quả gốc cho một command trùng lặp. Task definition có RetryPolicy nhưng không có giới hạn rework được duyệt. Việc lập lịch retry cần một thời điểm eligibility bền vững để replay có tính xác định.

## Quyết định

1. Giữ event đầy đủ là nguồn có thẩm quyền. Một mutation Core thành công phát ra các domain effect của nó và một receipt `command.completed` có version ở cuối trong cùng một batch. Receipt lưu identity, fingerprint SHA-256 của command đã parse, event-group start và các runnable task ID, không bao giờ lưu command thô. Replay dựng lại snapshot/event/result gốc tại ranh giới receipt. Cùng key và cùng fingerprint trả về outcome gốc; cùng key nhưng khác fingerprint là conflict.
2. Thêm codec `bflow.workflow-aggregate+json`. `WorkflowEngine.createCheckpoint` xuất snapshot cùng toàn bộ trạng thái phụ trợ, command result receipt, retry schedule và attempt baseline của generation. Replay checkpoint-cộng-tail yêu cầu codec này. Codec snapshot cũ chỉ được chấp nhận như một tối ưu hóa khi cung cấp đầy đủ event từ `run.created`; nếu không Core từ chối nó. Trạng thái không hợp lệ, không được hỗ trợ hoặc không nhất quán bị từ chối, không được lặng lẽ điền bằng map rỗng.
3. Thêm `TaskDefinition.rework` tùy chọn. Việc bỏ qua là mặc định migration có chủ đích: không có rework với `onExhausted: fail`. `maxReworks` đếm số lần tăng generation, không phải tổng số generation. Số lần retry bị giới hạn theo từng generation trong khi `TaskState.attempt` vẫn tăng đơn điệu toàn cục. Khi cạn, `fail` kết thúc run mà không tạo generation mới; `require_human` chặn run để chờ quyết định có revision cao hơn về sau.
4. Thêm `task.retry_scheduled` với `eligibleAt` suy ra từ policy. Backoff là fixed, linear hoặc exponential, bị chặn bởi `maxDelayMs`; jitter tùy chọn là giá trị full-jitter xác định suy ra từ identity ổn định. Core so sánh thời gian của command với eligibility và không bao giờ chạy timer.
5. Một cancellation toàn run có thể nhận nhiều hơn một event `cancellation.stop_confirmed`, mỗi event cho một execution đã bind. Aggregate checkpoint lưu danh sách confirmation thay vì một confirmation đơn lẻ; xác nhận execution trùng lặp là conflict, và việc một execution đã dừng không hàm ý tất cả đã dừng.

## Tương thích và migration

Field `rework` mới là tùy chọn nên các definition cũ vẫn parse được. Hành vi fail-closed với không rework của nó khác có chủ đích so với triển khai không giới hạn trước đây. `WorkflowEngine` công khai có thêm `createCheckpoint`, nên các triển khai phải bổ sung method này. Event schema version 1 hiện có vẫn parse được, nhưng các lịch sử không có command receipt không thể thiết lập idempotency chính xác sau restart và bị từ chối cho mutable recovery cho đến khi các receipt có thẩm quyền được migrate. Codec snapshot checkpoint cũ vẫn parse được và có thể bị bỏ qua khi full replay. Aggregate checkpoint mới dùng tên/version codec riêng biệt; không có upcast ngầm nào bịa ra trạng thái còn thiếu. `task.retry_scheduled` và `command.completed` là các loại event mới; event envelope chung và batch contract của RunStore giữ nguyên.

## Quyền sở hữu và hệ quả

P01 thực thi state transition, replay, retry/rework và tính đúng đắn của checkpoint. P03 sẽ cung cấp lưu trữ event/checkpoint bền vững nguyên tử và mọi migration từ dữ liệu prototype. P06 sẽ persist toàn bộ event batch trước khi dispatch hoặc các external effect khác và đánh thức retry tại thời điểm eligibility của nó. ADR này không khẳng định exactly-once execution phân tán, không triển khai SQLite, không cấp phát agent và không gọi Herdr.
