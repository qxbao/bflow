# Session Recovery

Khôi phục pane/session và khôi phục workflow là hai thao tác khác nhau. Giữ nguyên
checkout path, Git directory, `.bflow` và worktrees trong lúc chẩn đoán. Copy hoặc
di chuyển config đã bind sang máy khác không phải recovery được hỗ trợ.

```sh
bflow status --json
bflow doctor --json
git status --short
git worktree list
```

| Sự cố | Quy trình |
| --- | --- |
| Chỉ mất terminal client | Nếu named server và manifest vẫn hợp lệ, chạy `bflow attach` |
| Server/pane mất sau khi đã up thành công | Chạy status/doctor; `bflow up` reconcile bằng manifest P13, tái sử dụng/recover binding phù hợp |
| Startup bị gián đoạn, phase `server_starting`/`manager_pending` | Kiểm tra server/manager trước; CLI có thể từ chối retry để tránh duplicate side effect. Operator của host cần reconcile, không xóa intent |
| Shutdown còn phase `stopping` | Reconcile server/role/checkpoint; không chạy up để lách shutdown chưa rõ kết quả |
| Lifecycle lock còn lại | Xác minh process sở hữu đã exit; chỉ operator mới gỡ stale lock sau khi chứng minh không có operation đang chạy |
| Config báo khác repository | Quay về checkout đúng; với clone mới, init identity mới và chỉ áp dụng portable policy, không nhận state/receipt cũ |
| Runtime P19 restart | Mở lại host cùng repository/session/storage, initialize và kiểm tra journal/outbox/receipts trước khi tick |

P12 lưu intent/manifest/lock dưới `.bflow/state`; P13 giữ manifest trong
`.bflow/state/panes/`. P19 workspace mặc định lưu aggregate/event/receipt và journal
dưới `.bflow/state/agentic/`. Không sửa JSON/SQLite bằng tay để đổi approval hoặc
task status. Khi backup, quiesce writer và dùng quy trình SQLite-aware nhất quán
cho DB, sidecar, artifacts, journal và Git worktrees; copy một file DB đang ghi
không được tài liệu này chứng nhận là backup hoàn chỉnh.

P19 biến outbox `sending` chưa xác định sau crash thành `unknown_delivery`. Timeout,
mất kết nối hoặc cancel chờ không chứng minh agent chưa nhận prompt/đã dừng.
Host/Coordinator dùng tool `inspect` và `reconcile_delivery` với message ID gốc.
Chỉ kết quả xác thực `not_delivered` mới cho phép gửi lại **đúng request gốc**;
không thay pane, lease, idempotency fingerprint hoặc instruction rồi coi là retry.
Giữ lease/uncertain bindings để tránh writer thứ hai trên cùng task.

Nếu crash trong verification, reconcile P17 receipt trước khi chạy lại. Outcome đã
write-ahead có thể apply lại idempotently; pending receipt chưa được reconcile không
cho phép tự chạy check thứ hai. Authoritative Core checkpoint/event replay phải
khôi phục cả approval, gate, retry, cancellation và command outcomes; RunStore
projection hay artifact trên đĩa không thay thế aggregate đó.

Legacy CLI run có các lệnh riêng:

```sh
bflow status run-123 --json
bflow resume run-123 --idempotency-key operator-resume-123 --json
```

`resume` đi qua legacy workspace Runtime và recovery của nó, không mở lại host P19
hoặc tạo pane. Không dùng nó cho P19 run nằm ở storageDirectory khác. Các lệnh
`bflow session recover`/`bflow replay` chưa tồn tại. Cancel/interrupt chỉ lưu ý định
và yêu cầu dừng; phải xác nhận writer đã dừng trước cleanup/retry. Không force-delete
worktree, reset branch, xóa database hay sửa receipt để gỡ blocked.
