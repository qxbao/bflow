# bflow down

```sh
bflow down --timeout 30000 --json
```

Default CLI hiện đã compose Runtime barrier và P13 shutdown thật. Quy trình là
kiểm tra dirty/busy/active runs → xác nhận nếu cần → chặn intake/dispatch và drain
state writes → đọc lại active runs → lưu aggregate checkpoint → xác nhận role
shutdown → dừng named server của repo → dừng host. Smoke thực đã xác nhận hai
vòng up/down liên tiếp, Git HEAD giữ nguyên, không gửi model task.

Custom `BFLOW_ENVIRONMENT_MODULE` vẫn phải cung cấp các operation thật; `--yes`
không được thay thế barrier/checkpoint hoặc force-stop khi outcome chưa rõ.

```sh
bflow down --yes --timeout 30000 --json
```

Chỉ dùng `--yes` sau khi đã xem active runs, dirty files, các agent busy/unresolved
và host đã được tích hợp. Cờ này xác nhận tình trạng đang có công việc; không cấp
phép bỏ checkpoint, force-stop, xóa source/worktree/DB/artifact hay deploy.

Nếu custom composition báo thiếu barrier hoặc drain chưa xong, giữ session/state để operator của host
xử lý. Hướng dẫn này không đưa lệnh stop Herdr toàn cục vì có thể ảnh hưởng session
khác. [Session Recovery](session-recovery.md) mô tả cách giữ bằng chứng sau gián đoạn.

Sau Ctrl+C/timeout trong down, có thể chạy lại `bflow down --yes`: checkpoint/barrier
vẫn bắt buộc, manager quan sát pane còn tồn tại trước khi tiếp tục close. Nếu Herdr
đã dừng, Bflow vẫn drain/checkpoint host còn giữ lại trước khi đóng host đó. Startup
bị ngắt trước manifest chỉ được stop khi có ownership intent và runtime xác nhận
không có active workflow; không tạo manifest/pane giả để báo success.
