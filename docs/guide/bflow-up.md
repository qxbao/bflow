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

`up` chuẩn bị persistent P19 host trước startup, cấp launch-local MCP/hooks và
system prompts cho role, rồi đòi activation acknowledgement trước khi ghi ready.
Default host hiện yêu cầu Claude; dùng `bflow init --provider claude`. Native
session và provider login được kiểm tra riêng với transport idle.

Default verification hỗ trợ documentation/manual review và Node TAP/Vitest 2.1
được owner cấu hình trước startup; behavioral runner dùng sandbox Linux Bubblewrap.
Xem [cấu hình verification](../verification-runners.md) cho schema, dependencies
và các giới hạn hiện tại.
Up thành công không chứng minh một workflow đã hoàn tất. Smoke thực đã kiểm tra
lifecycle up/down/restart; xem [release-readiness](../release-readiness.md).
