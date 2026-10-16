# Getting Started

Bflow có thể khởi tạo cấu hình riêng cho mỗi Git checkout và quản lý các pane
Herdr theo repository. Workflow SDLC v2 đã có API tích hợp P19; CLI hiện chưa tự
khởi động host/provider, đăng ký tool Coordinator hay xác thực evidence/approval.
Vì vậy `init → up → attach` kiểm tra môi trường; chưa phải một chuỗi giao tính năng
bằng AI hoàn chỉnh. Xem [Architecture Overview](architecture-overview.md).

Sau [Installation](installation.md), đặt đường dẫn tuyệt đối tới checkout Bflow
đã build, rồi tạo repository TypeScript độc lập:

```sh
export BFLOW_HOME=/absolute/path/to/bflow
mkdir /tmp/my-bflow-calculator
git -C "$BFLOW_HOME" archive HEAD:examples/portable-node | tar -x -C /tmp/my-bflow-calculator
cd /tmp/my-bflow-calculator
git init
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
git add .gitignore README.md package.json pnpm-lock.yaml tsconfig.json src test requests
git commit -m "chore: initialize calculator example"
node "$BFLOW_HOME/apps/cli/dist/bin.js" init --name calculator
node "$BFLOW_HOME/templates/node-typescript/apply.mjs" . bugfix
node "$BFLOW_HOME/apps/cli/dist/bin.js" doctor --json
node "$BFLOW_HOME/apps/cli/dist/bin.js" status --json
```

Dùng một thư mục đích chưa tồn tại. Git cần user identity đã cấu hình để commit.
Lệnh archive chỉ export example đã commit, không mang theo `node_modules/`,
`dist/` hoặc `.bflow` cục bộ trong source checkout. Lệnh doctor có thể
trả exit 1 khi thiếu Herdr/agent CLI hoặc môi trường chưa sẵn sàng; đọc từng check.

Nếu Herdr và agent CLI đã được cài, đăng nhập và hỗ trợ wire contract:

```sh
node "$BFLOW_HOME/apps/cli/dist/bin.js" up --timeout 60000
node "$BFLOW_HOME/apps/cli/dist/bin.js" attach
```

`attach` cần terminal tương tác. Dùng `init --provider claude` cho default persistent host hiện đã kiểm chứng;
init không truyền provider vẫn giữ default Codex legacy. Herdr quản lý provider/model; Bflow CLI chưa có trường model trong role config.
Đọc [up](bflow-up.md), [attach](bflow-attach.md) và [down](bflow-down.md), đặc biệt
giới hạn shutdown trước khi tạo môi trường lâu dài.

Chọn một bài tập trong `requests/`: feature, bugfix, refactor hoặc docs. Các JSON
trong [templates](../../templates/node-typescript/README.md) là draft/seed cho host
P19. Host phải bind run/session thật, giữ tiêu chí intake, đánh giá tác động thực,
cấu hình check độc lập và nhận approval trước khi cho Developer thực thi.
Không có lệnh `bflow run --kind bugfix` hay tự nạp thư mục template.

Ví dụ chạy được ngay là install/typecheck/build/test và init/config validation.
[Báo cáo kiểm chứng](../../templates/node-typescript/VALIDATION.md) phân biệt rõ
kiểm tra này, live Herdr transport smoke và những bước AI chưa kiểm chứng.
