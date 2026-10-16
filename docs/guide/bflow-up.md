# bflow up

```sh
bflow doctor --json
bflow up --timeout 60000 --json
bflow status --json
```

Up đọc config checkout, kiểm tra binary/Herdr API, khởi động server headless với
tên session riêng, gọi P13 tạo hoặc reconcile topology và đợi mọi role `required`
ở trạng thái `idle`/`done`. Mặc định có bảy permanent roles; Developer được cấp
phát theo task/worktree bởi Runtime. Timeout là millisecond, từ 1 đến 600000;
mặc định startup là 60000. `required: false` chỉ bỏ yêu cầu readiness, không có
nghĩa là bỏ tạo role hay bỏ dependency executable.

`HERDR_SESSION` được đặt theo identity repository. Caller socket/pane/remote
overrides được loại khỏi môi trường lệnh Herdr; `HERDR_CONFIG_PATH` được giữ lại.
Đây là phân tách session, không phải sandbox của hệ điều hành.

Khi đã có manifest hợp lệ và session sống, up tái sử dụng role. Nó từ chối nhận
một named session đang sống mà không có bằng chứng ownership của repo. Sau lỗi
startup/timeout, đọc status/doctor và [Session Recovery](session-recovery.md);
đừng xóa state để ép tạo thêm agent.

Thành công của up chỉ xác nhận topology/readiness. Nó chưa cài tool cho model,
khởi chạy P19 daemon, nạp system prompt/profile từ `agents/`, hoặc nối user turn
tới Runtime tự động. Cần host tích hợp `openAgenticWorkspace`, xác thực ingress,
độc lập chạy checks, đăng ký Coordinator tools và scheduler. Đây là API đã có;
automatic CLI host bootstrap vẫn **planned/chưa triển khai**.
