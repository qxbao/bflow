# Khởi động dịch vụ (`bflow up`)

```bash
bflow doctor --json
bflow up --json
bflow status --json
```

Lệnh `bflow up` thực hiện đọc cấu hình checkout, kiểm tra các tệp thực thi nhị phân và tính tương thích của Herdr API, sau đó khởi động một máy chủ headless với tên session độc lập. Tiếp theo, lệnh điều phối thành phần Pane Manager (P13) để kiến tạo hoặc đồng bộ lại (reconcile) cấu trúc topology và chờ toàn bộ role bắt buộc có native binding đúng launch cùng attestation và activated health. Quan sát transport `idle`/`done` chỉ là một đầu vào, không đủ để công bố ready.

Theo mặc định, hệ thống duy trì bảy vai trò thường trực (permanent roles); riêng vai trò Developer sẽ được Runtime cấp phát động theo từng tác vụ hoặc Git worktree. Giá trị thời gian chờ (`--timeout`) được tính theo mili-giây (cho phép từ 1 đến 600.000 ms, với giá trị cấu hình mới mặc định là 300.000 ms). Cờ `required: false` trên một vai trò thường trực chỉ có ý nghĩa biến trạng thái sẵn sàng thành tùy chọn; nếu cấu hình có khai báo vai trò `developer`, mục đó chỉ đóng vai trò là khuôn mẫu (template) để Runtime cấp phát động theo tác vụ chứ không tạo pane thường trực ngay khi chạy `up`.

---

## 1. Phân tách phiên làm việc và bảo mật

Biến môi trường `HERDR_SESSION` được thiết lập dựa trên định danh duy nhất của repository. Mọi biến môi trường ghi đè của bên gọi (socket, pane, remote overrides) đều bị loại bỏ khỏi môi trường thực thi của lệnh Herdr, ngoại trừ đường dẫn cấu hình `HERDR_CONFIG_PATH` được giữ lại. Cơ chế này đảm bảo sự phân tách phiên làm việc độc lập giữa các dự án, tuy nhiên đây là sự phân tách ở tầng phiên chứ không phải cơ chế sandbox hoàn toàn ở cấp hệ điều hành.

Khi đã tồn tại manifest hợp lệ và session đang hoạt động, lệnh `up` sẽ tái sử dụng các vai trò hiện hữu. Hệ thống sẽ từ chối nhận diện một named session đang chạy nếu thiếu bằng chứng về quyền sở hữu (ownership) từ repository hiện tại.

Nếu quá trình khởi động gặp sự cố sau khi đã bắt đầu thay đổi session, `up` sẽ chủ động kích hoạt quy trình hạ dịch vụ an toàn (`safe down`) tuân thủ rào chắn an toàn (barrier) và các checkpoint hiện thời. Trong trường hợp việc dọn dẹp không hoàn tất hoặc không thể chứng minh là an toàn tuyệt đối, biên nhận thao tác (operation receipt) cùng trạng thái phục hồi sẽ được bảo lưu và hiển thị chi tiết trong thông báo. Khi đó, người vận hành cần xem xét kết quả qua lệnh `status` hoặc `doctor`, khắc phục nguyên nhân gốc rễ rồi tiến hành đồng bộ lại bằng `bflow down --yes`; tuyệt đối không tự ý xóa thư mục trạng thái để ép buộc tạo thêm agent mới.

---

Với `trustedWorkspace: true` và required Claude, `up` có thể đặt project trust trong `$CLAUDE_CONFIG_DIR/.claude.json` hoặc `~/.claude.json` của môi trường gọi CLI. Xem [config reference](configuration-reference.md#policy-và-ngân-sách); không coi toàn bộ startup là chỉ ghi launch-local settings.

## 2. Kích hoạt P19 Host và xác minh điều kiện sẵn sàng

Lệnh `up` chuẩn bị persistent P19 host trước khi khởi động, cấp phát các công cụ MCP cục bộ, các hook hệ thống cùng system prompt cho từng vai trò, sau đó yêu cầu tín hiệu xác nhận kích hoạt (activation acknowledgement) trước khi ghi nhận trạng thái sẵn sàng (`ready`). Host dùng provider theo từng role và mặc định init là Codex. Claude/Codex có đường Conversation; Agy specialist có source/local native binding, nhưng Conversation và unattended vẫn unsupported. Phiên làm việc native và trạng thái đăng nhập của nhà cung cấp được kiểm tra độc lập với trạng thái rảnh rỗi (idle) của tầng truyền tải.

Runtime tự phát hiện runner theo repository; `.bflow/verification.json` là owner override tùy chọn. JS/TS/owner commands chạy trong Linux Bubblewrap hoặc macOS Seatbelt; các adapter polyglot và dependency warming còn giới hạn OS riêng. Tham khảo [cấu hình verification](../verification-runners.md) để biết chi tiết schema, danh sách phụ thuộc và các giới hạn kỹ thuật.

*Lưu ý*: Việc lệnh `up` chạy thành công không đồng nghĩa với việc toàn bộ quy trình công việc đã hoàn tất. Các bài kiểm thử smoke thực tế đã xác minh độ tin cậy của vòng đời up/down/restart; xem thêm tại [báo cáo sẵn sàng phát hành](../release-readiness.md).

---

## 3. Huỷ bỏ lệnh và dọn dẹp an toàn

Thao tác nhấn `Ctrl+C` sẽ hủy bỏ quá trình chờ đợi khởi động; nếu hệ thống đã bắt đầu thay đổi trạng thái phiên, lệnh sẽ tự động kích hoạt chu trình dọn dẹp an toàn. Trong trường hợp kết quả truyền tin chưa rõ ràng (`uncertain_delivery`) hoặc rào chắn an toàn bị chặn, Bflow sẽ bảo lưu biên nhận thao tác, manifest cục bộ và biên nhận khởi chạy để phục vụ việc đối soát phục hồi sau đó.

Khóa vòng đời (lifecycle lock) do kernel trực tiếp quản lý nên sẽ tự động được giải phóng khi tiến trình kết thúc (kể cả trong trường hợp nhận tín hiệu `SIGKILL`). Người vận hành nên kiểm tra trạng thái qua `status` hoặc `doctor`, sau đó chạy `bflow down --yes` để hoàn tất dọn dẹp, không nên xóa thủ công thư mục `.bflow`. Đối với các khóa thư mục sót lại từ phiên bản cũ, hãy dừng lệnh cũ rồi thực thi `bflow recover --yes`. Nếu giao diện của nhà cung cấp bị chặn, thông báo lỗi sẽ nêu rõ thông tin pane/session kèm câu lệnh cụ thể để mở đúng phiên và xử lý hộp thoại.

Tất cả các vai trò Chat và Coordinator đều được nạp nội dung prompt gốc ngay từ thời điểm khởi động. Mỗi pane được gán nhãn theo đúng tên vai trò tương ứng; không gian điều phối mới áp dụng bố cục lưới 2x2. Khi thay đổi kích thước, các pane cũ sẽ được điều chỉnh trực tiếp tại chỗ mà không cần phải thiết lập lại tiến trình.
