# bflow init

```sh
bflow init --name my-project
bflow init --dir /absolute/path/to/my-project --json
```

Thư mục đích phải ở trong Git checkout. Init xác định Git root canonical, kể cả
khi gọi từ thư mục con, rồi tạo `.bflow/config.yaml` và `.bflow/.gitignore`.
Nó không gọi Herdr, tạo pane hoặc chạy agent. `--config` chỉ chấp nhận đường dẫn
trỏ đúng `.bflow/config.yaml` của checkout; không phải một tùy chọn đổi nơi lưu
environment config.

Định dạng file là **JSON hợp lệ**, thuộc tập con YAML 1.2. Không dùng YAML thụt
lề, comment, alias, tag hoặc interpolation biến môi trường trong file này.

Init thường giữ nguyên file đã có. **Ở implementation hiện tại, `--force`, `-f`,
`--yes`, `-y` ghi đè cấu hình bằng defaults**, dù help text và một số tài liệu P12
cũ nói luôn giữ nguyên. Hành vi ghi đè đã được thử trong repository tạm. Không dùng
các cờ đó để resume hoặc sửa lỗi session; sao lưu và xem diff nếu cần tái tạo cấu hình.

Các trường `environment.repositoryId`, `workspaceRoot`, `sessionName` được sinh
từ canonical checkout root và Git directory. Hai repo cùng tên, hoặc hai linked
worktree, có identity riêng. Không copy config đã bind giữa các clone/máy/worktree.
Track [template portable](../../templates/node-typescript/README.md) thay cho config
chứa identity cục bộ; chọn ignore config theo quy ước dự án. Ví dụ mới đã ignore nó.

Áp dụng mẫu trước lần `up` đầu:

```sh
node "$BFLOW_HOME/templates/node-typescript/apply.mjs" . feature
```

Helper giữ runtime/storage/identity từ init, thay defaultWorkflow và các policy
trong fragment, lưu backup dưới `.bflow/data/`. Nó từ chối nếu đã có `.bflow/state`.
Đây là helper template được chạy tường minh; CLI không tự nạp template hay policy file.
