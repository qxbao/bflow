# bflow init

```sh
bflow init --name my-project
bflow init --dir /absolute/path/to/my-project --json
```

Thư mục đích phải ở trong Git checkout. Init xác định Git root canonical, kể cả
khi gọi từ thư mục con, rồi tạo `.bflow/config.yml` và `.bflow/.gitignore`.
Nó không gọi Herdr, tạo pane hoặc chạy agent. `--config` chỉ chấp nhận đường dẫn
trỏ đúng `.bflow/config.yml` của checkout; không phải một tùy chọn đổi nơi lưu
environment config.

File dùng YAML thụt lề có comment hướng dẫn. Các role, provider, model và effort
nằm trước những trường identity/storage thường ít thay đổi. Bflow đọc YAML 1.2 an
toàn với đúng một document và mapping key dạng chuỗi; explicit tag, merge key và
alias vòng không được hỗ trợ. `model` và `effort` là tuỳ chọn theo role. Claude
nhận `low|medium|high|xhigh|max`; Codex nhận `minimal|low|medium|high|xhigh`; Agy
mã hoá effort trong tên model nên không có trường `effort` riêng.

Repository cũ có thể tiếp tục đọc từ `.bflow/config.yaml` hoặc
`.bflow/config.json`. Chuyển sang file canonical bằng lệnh:

```sh
bflow config-migrate
```

Lệnh kiểm tra config trước, ghi `.bflow/config.yml` với nguyên giá trị, sao lưu
file gốc thành `.bflow/config.yaml.bak` hoặc `.bflow/config.json.bak`, rồi gỡ
file cũ. Nếu có nhiều file cũ, backup sẵn, hoặc canonical và legacy cùng tồn tại,
lệnh dừng để người vận hành giải quyết xung đột; nó không tự chọn file.

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
trong fragment, validate candidate bằng loader thật trước khi thay file và lưu
backup dưới `.bflow/data/`. Fragment không được đặt identity của checkout.
Nó từ chối nếu đã có `.bflow/state`, kể cả dangling symlink. Nếu checkout còn
config legacy, chạy `bflow config-migrate` trước khi helper dùng canonical
`.bflow/config.yml`. Đây là helper template được chạy tường minh; CLI không tự
nạp template hay policy file.
