# bflow down

```sh
bflow down --timeout 30000 --json
```

Command đã có nhưng **default CLI composition hiện chưa thể shutdown thành công
một session đang chạy**: thiếu Runtime quiesce/checkpoint barrier và lifecycle
shutdown provider trong adapter P12. `--yes` cũng không vượt qua giới hạn này.
Nó có thể trả thành công khi đã có manifest hợp lệ và session vốn đã dừng. Nếu
chưa từng up và chưa có manifest, down trả lỗi, không dừng gì. Không diễn giải
việc gọi command là đã có graceful shutdown.

Với host tích hợp đầy đủ qua `BFLOW_ENVIRONMENT_MODULE` (đường dẫn ESM tuyệt đối,
do operator đặt), quy trình command là kiểm tra dirty/busy/active runs → xác nhận
nếu cần → chặn intake/dispatch và drain state writes → đọc lại active runs → lưu
aggregate checkpoint → xác nhận role shutdown → chỉ dừng named server của repo.
Module phải cung cấp manager/runtime/quiesce/checkpoint thật; xem
[CLI composition contract](../../apps/cli/README.md#composition-boundary-and-current-integration-limits).
API P13 `shutdownTopology` riêng không tự thỏa mọi yêu cầu của barrier P12.

```sh
bflow down --yes --timeout 30000 --json
```

Chỉ dùng `--yes` sau khi đã xem active runs, dirty files, các agent busy/unresolved
và host đã được tích hợp. Cờ này xác nhận tình trạng đang có công việc; không cấp
phép bỏ checkpoint, force-stop, xóa source/worktree/DB/artifact hay deploy.

Nếu default composition báo thiếu barrier, giữ session/state để operator của host
xử lý. Hướng dẫn này không đưa lệnh stop Herdr toàn cục vì có thể ảnh hưởng session
khác. [Session Recovery](session-recovery.md) mô tả cách giữ bằng chứng sau gián đoạn.
