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
mặc định startup là 60000. `required: false` trên role permanent chỉ làm readiness
thành tuỳ chọn; nếu có role `developer` trong config thì entry đó là template cho
Runtime cấp phát theo task/worktree, không tạo một pane permanent khi `up` chạy.

`HERDR_SESSION` được đặt theo identity repository. Caller socket/pane/remote
overrides được loại khỏi môi trường lệnh Herdr; `HERDR_CONFIG_PATH` được giữ lại.
Đây là phân tách session, không phải sandbox của hệ điều hành.

Khi đã có manifest hợp lệ và session sống, up tái sử dụng role. Nó từ chối nhận
một named session đang sống mà không có bằng chứng ownership của repo. Nếu startup
thất bại sau khi đã bắt đầu thay đổi session, up chủ động thử `down` với barrier
và checkpoint hiện hành. Khi cleanup không hoàn tất hoặc không chứng minh được an
toàn, operation receipt và recovery state được giữ lại; thông báo ghi rõ kết quả
cleanup. Xem `status`/`doctor`, xử lý nguyên nhân rồi reconcile bằng `bflow down
--yes`; đừng xoá state để ép tạo thêm agent.

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

Ctrl+C huỷ việc đợi/startup của lệnh và sau khi startup đã bắt đầu sẽ kích hoạt
safe cleanup. Nếu delivery chưa rõ hoặc cleanup bị chặn, Bflow giữ operation receipt,
partial manifest và launch receipts để reconcile. Lock lifecycle do kernel giữ
nên tự nhả khi process chết, kể cả SIGKILL. Chạy `status`/`doctor`, rồi `bflow down
--yes` để hoàn tất việc dọn; không xoá `.bflow`. Với lock thư mục từ phiên bản cũ:
dừng lệnh cũ rồi `bflow recover --yes`.
Nếu UI provider bị chặn, lỗi chỉ rõ pane/session và lệnh mở đúng session để xử lý.

Chat/Coordinator nạp prompt gốc ngay từ startup. Pane được đặt tên theo role;
Coordination mới dùng lưới 2x2. Pane cũ được resize tại chỗ, không reset process.
