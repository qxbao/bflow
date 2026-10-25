# Điều tra Conversation MCP Gateway

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

Nguồn được kiểm toán: `d82ff21fa8037f4bbcfbafc785b022b3e60fb0df`.
Bằng chứng: mã nguồn và cấu hình khởi chạy cục bộ cho session
`conv-bf-c1695ccd3f2b994f91bd`. Không thực hiện bài kiểm thử conformance Gateway/provider thực (live) nào.

## Vì sao GitNexus vắng mặt

Cấu hình repository không chọn `environment.requiredMcpServices`
hay `environment.requiredTools`. `apps/cli/src/platform-options.ts` suy ra yêu cầu service/tool của mọi
role từ các danh sách áp dụng toàn môi trường này, mặc định là danh sách rỗng.
`packages/runtime/src/platform/service.ts` không tạo đăng ký Gateway client
khi một role không có MCP service bắt buộc.

Cấu hình host cục bộ xác nhận yêu cầu service/tool rỗng cho mọi role. Các cấu hình MCP được sinh ra
cho Conversation và Coordinator chỉ chứa server `bflow` nội bộ,
do Runtime host cung cấp độc lập. Việc cài đặt một tool qua machine setup không chọn tool đó cho
repository và không cấp quyền truy cập cho các pane của nó.

Việc chọn repository tường minh và đăng ký Gateway có phạm vi là chủ ý thiết kế.
Không có quy định cấm riêng việc Conversation nhận các MCP tool của Gateway. Việc thiếu hiện tại là
một khoảng trống về cấu hình repository và command-UX, tách biệt với việc thiếu quyền Claude
cấp cho server `bflow` nội bộ đã được cấu hình.

## Khuyến nghị

Cấp cho Conversation quyền đọc theo phạm vi repository đối với các thao tác GitNexus như
`query`, `context` và `impact` để hỗ trợ trả lời câu hỏi và đánh giá phạm vi. Giữ
việc dispatch workflow, thông điệp giữa các role và thẩm quyền phê duyệt của người dùng trong
đường Runtime/Herdr hiện có. Launcher GitNexus được quản lý đã đặt
`GITNEXUS_MCP_READ_ONLY=1` và giới hạn các repository được phép; Gateway vẫn phải
thực thi đúng allowlist service/tool cho đăng ký client.

Các mục role YAML hiện tại không có trường ghi đè service/tool. Các danh sách áp dụng toàn môi trường
hiện có áp dụng cho mọi role. Vì vậy, một quyền chỉ dành cho Conversation cần
một cải tiến cấu hình được review riêng, thay vì bật tool trên toàn môi trường
hoặc kế thừa cài đặt MCP toàn cục của provider.

Báo cáo này không bật các Gateway service, không thay đổi cài đặt machine/provider,
và không cho phép thay đổi code của MCP Gateway. Chủ dự án quyết định có triển khai
quyền truy cập Conversation được đề xuất hay không.
