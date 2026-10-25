# Hạ dịch vụ (`bflow down`)

```bash
bflow down --timeout 30000 --json
```

Giao diện dòng lệnh mặc định của Bflow tích hợp chặt chẽ cơ chế rào chắn an toàn (Runtime barrier) và quy trình dừng dịch vụ chuẩn xác của Pane Manager (P13). Trình tự thực thi khi hạ dịch vụ:
1. Kiểm tra các thay đổi chưa commit (`dirty`), trạng thái bận (`busy`) của agent và các lượt chạy đang kích hoạt (`active runs`).
2. Yêu cầu xác nhận từ người vận hành nếu phát hiện công việc đang dở dang.
3. Chặn tiếp nhận tác vụ mới (`intake`) và ngừng điều phối (`dispatch`), đồng thời rút cạn (drain) các tác vụ ghi trạng thái còn tồn đọng.
4. Đọc lại danh sách các lượt chạy đang kích hoạt.
5. Lưu trữ điểm kiểm tra tổng hợp đáng tin cậy (`aggregate checkpoint`).
6. Xác nhận việc dừng toàn bộ các tiến trình role.
7. Đóng máy chủ Herdr mang định danh riêng của repository.
8. Dừng hoàn toàn tiến trình host.

Các bài kiểm thử smoke thực tế đã xác nhận chu trình hạ và nâng dịch vụ (`up → down → up → down`) liên tiếp diễn ra trơn tru, bảo lưu nguyên vẹn trạng thái Git HEAD và không làm rò rỉ tác vụ thừa tới mô hình.

---

## 1. Sử dụng cờ xác nhận `--yes`

```bash
bflow down --yes --timeout 30000 --json
```

Chỉ nên sử dụng cờ `--yes` sau khi bạn đã kiểm tra kỹ lưỡng các lượt chạy đang hoạt động, các tệp tin chưa được commit, trạng thái của các agent bận và đảm bảo host đã được kết nối đầy đủ. Cờ này đóng vai trò xác nhận người vận hành đã nhận thức được tình trạng công việc đang diễn ra; **cờ `--yes` tuyệt đối không cho phép bỏ qua aggregate checkpoint, không hỗ trợ cưỡng chế dừng đột ngột (force-stop), không xoá mã nguồn, worktree, cơ sở dữ liệu hay artifact**.

Mọi bộ điều hợp môi trường tùy biến (`BFLOW_ENVIRONMENT_MODULE`) đều bắt buộc phải cung cấp đầy đủ các thao tác xử lý thực tế này; không được dùng cờ `--yes` để thay thế rào chắn an toàn hoặc cưỡng chế dừng khi kết quả chưa rõ ràng.

---

`bflow down --force` là tùy chọn riêng để xử lý stuck pane cleanup **sau Runtime barrier**, vẫn cần checkpoint và quan sát server đã dừng mới. ACK dừng bị mất phải đối soát; force không biến unknown delivery thành not-delivered. Gateway dùng chung của machine và external workers không bị repo down dừng.

## 2. Xử lý sự cố gián đoạn khi hạ dịch vụ

- Nếu cấu hình tùy biến báo cáo thiếu rào chắn an toàn hoặc quá trình rút cạn tác vụ chưa hoàn tất, hệ thống sẽ bảo lưu nguyên vẹn session và trạng thái để người vận hành kiểm tra xử lý. Hướng dẫn này không khuyến nghị lệnh dừng Herdr toàn cục vì có thể gây ảnh hưởng xấu tới các phiên làm việc của các dự án khác trên cùng máy. Xem thêm tại [Khôi phục phiên làm việc (Session Recovery)](session-recovery.md).
- Nếu lệnh `down` bị gián đoạn bởi `Ctrl+C` hoặc vượt quá thời gian chờ (timeout), bạn có thể chạy lại `bflow down --yes`: hệ thống vẫn bắt buộc tuân thủ rào chắn an toàn và lưu checkpoint; Pane Manager sẽ kiểm tra lại các pane còn sót để tiếp tục đóng tuần tự.
- Nếu Herdr đã dừng từ trước, Bflow vẫn thực hiện đầy đủ quy trình rút cạn và ghi checkpoint trước khi đóng host.
- Trong trường hợp quá trình khởi động bị ngắt trước khi kịp tạo manifest, hệ thống chỉ cho phép dừng khi xác nhận được ý định sở hữu từ phía người dùng và Runtime xác nhận không có bất kỳ quy trình công việc nào đang hoạt động; tuyệt đối không tạo manifest hoặc pane giả lập để báo cáo thành công sai lệch.
