# Gắn kết phiên (`bflow attach`)

```bash
bflow up
bflow attach
```

Lệnh `bflow attach` kiểm tra tính hợp lệ của manifest và session tương ứng, yêu cầu Pane Manager (P13) tập trung tiêu điểm (focus) vào pane của Conversation Agent (`chat`), sau đó chạy lệnh `herdr attach` kế thừa toàn bộ luồng vào/ra (terminal I/O) của giao diện điều khiển. Lệnh này không tạo môi trường mới và tuyệt đối không gắn kết trực tiếp vào các pane của Coordinator hay Developer. Tùy chọn `--json` không thể thay thế cho nhu cầu thao tác trên một terminal tương tác (interactive terminal) thực sự của giao diện Herdr.

---

## 1. Kiểm tra trạng thái và ranh giới kết nối

- Nếu hệ thống chưa có manifest hợp lệ hoặc máy chủ đã dừng, hãy sử dụng các lệnh `status`, `doctor` và thực hiện quy trình khôi phục trước khi thử `attach`.
- Việc thoát khỏi cửa sổ terminal client (ví dụ qua phím tắt detach) không đồng nghĩa với việc máy chủ, các agent hay quy trình công việc nền đã dừng hoạt động.
- Host P19 có trách nhiệm kết nối Conversation Gateway với từng lượt tương tác của người dùng kèm nguồn gốc dữ liệu (provenance); việc nhìn thấy giao diện prompt chat trong pane chưa phải là bằng chứng khẳng định toàn bộ các kết nối chính sách (policy) và bằng chứng kiểm thử (evidence) đã được thiết lập thành công.

---

## 2. Giám sát độc lập từ terminal khác

Để kiểm tra trạng thái hoạt động một cách an toàn mà không làm gián đoạn phiên tương tác hiện tại, bạn có thể thực thi lệnh sau từ một cửa sổ terminal khác:

```bash
bflow status --json
```

Lưu ý rằng các dữ liệu quan sát được lưu trên đĩa có thể có độ trễ nhất định. Trạng thái tầng truyền tải ghi nhận `transportState: done` chỉ phản ánh việc agent đã hoàn thành lượt phản hồi hiện tại, hoàn toàn không tương đương với việc lượt chạy đạt trạng thái thành công (`run: succeeded`) hay toàn bộ quy trình SDLC đã hoàn tất (`completed`).
