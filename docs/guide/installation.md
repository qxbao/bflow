# Installation

Nền tảng kiểm chứng là Linux với Git và filesystem cục bộ. Dùng Node >=22.13
(cần cho `node:sqlite`) và pnpm đúng `packageManager` trong package.json, hiện là
12.5.1. Root `engines >=22` rộng hơn yêu cầu SQLite thực tế. Windows native,
network filesystem, multi-host và power-loss recovery chưa được chứng minh.

Bflow và `@bflow/cli` đang là package `private`; hướng dẫn này dùng source checkout,
không giả định có gói public để `npm install -g bflow`.

```sh
git clone https://github.com/qxbao/bflow.git
cd bflow
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/bin.js --help
node templates/node-typescript/verify.mjs
```

Mọi ví dụ `bflow ...` trong hướng dẫn có thể thay bằng
`node "$BFLOW_HOME/apps/cli/dist/bin.js" ...`, với `BFLOW_HOME` là đường dẫn tuyệt
đối tới checkout đã build. Có thể link executable bằng
`pnpm --filter @bflow/cli link --global` nếu môi trường pnpm đã có global bin path;
cách gọi Node trực tiếp không cần bước đó.

Herdr là dependency riêng, không được pnpm install của Bflow cài đặt. Dùng nguồn
cài đặt của [Herdr](https://herdr.dev), sau đó kiểm tra binary tại máy:

```sh
herdr --version
herdr --help
```

Hai lệnh này đã được chạy trên binary 0.9.5 trong đợt kiểm chứng. Nhãn version
chỉ dùng chẩn đoán; Bflow kiểm tra protocol 22/schema 1 và response từng operation,
không giới hạn danh sách release. Cài/đăng nhập agent CLI được chọn bằng quy trình
của provider; không thêm API key vào JSON, prompt hay command được lưu trong repo.

Build trước khi chạy ví dụ hoặc targeted test vì chúng import `dist/`.
[Getting Started](getting-started.md) dùng một repository khác để kiểm tra khả năng
khởi tạo ngoài monorepo. Không copy `node_modules` của Bflow sang dự án đó.
