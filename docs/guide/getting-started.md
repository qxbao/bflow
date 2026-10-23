# Hướng dẫn khởi đầu nhanh (Getting Started)

Bflow cho phép khởi tạo cấu hình độc lập cho từng checkout Git và quản trị các pane Herdr theo từng repository riêng biệt. Quy trình SDLC v2 đã cung cấp đầy đủ API tích hợp ở giai đoạn P19; tuy nhiên phiên bản CLI hiện tại chưa tự động hóa việc khởi động đồng thời host/provider, đăng ký công cụ cho Coordinator hoặc tự động xác thực toàn bộ bằng chứng/phê duyệt. Do đó, chuỗi lệnh `init → up → attach` chủ yếu đóng vai trò kiểm tra tính sẵn sàng của môi trường, thay vì một chu trình bàn giao tính năng AI hoàn chỉnh tự động. Xem thêm tại [Tổng quan kiến trúc](architecture-overview.md).

---

## 1. Chuẩn bị môi trường thử nghiệm

Sau khi hoàn tất bước [Cài đặt (Installation)](installation.md), hãy thiết lập biến môi trường `BFLOW_HOME` trỏ tới đường dẫn tuyệt đối của thư mục mã nguồn Bflow đã biên dịch, sau đó tạo một repository TypeScript độc lập để thử nghiệm:

```bash
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
git add .bflow/.gitignore .bflow/config.yml
git commit -m "chore: add bflow config"
node "$BFLOW_HOME/apps/cli/dist/bin.js" doctor --json
node "$BFLOW_HOME/apps/cli/dist/bin.js" status --json
```

> [!NOTE]
> - Hãy chọn một thư mục đích hoàn toàn mới chưa tồn tại trước đó.
> - Git yêu cầu phải có thông tin danh tính người dùng (`user.name` và `user.email`) được cấu hình để thực hiện lệnh commit.
> - Commit `.bflow/.gitignore` và `.bflow/config.yml` trước `bflow up`: Runtime chỉ cấp worktree cho Developer khi working tree sạch, nên hai tệp chưa commit này sẽ chặn bước triển khai.
> - Lệnh `git archive` chỉ trích xuất các tệp mẫu đã được commit, hoàn toàn không sao chép các thư mục tạm như `node_modules/`, `dist/` hoặc `.bflow` cục bộ từ mã nguồn gốc.
> - Lệnh `doctor` có thể trả về mã lỗi `exit 1` nếu môi trường của bạn chưa cài đặt Herdr, chưa có CLI của agent hoặc còn thiếu cấu hình; vui lòng kiểm tra kỹ chi tiết từng hạng mục kiểm tra trong kết quả trả về.

---

## 2. Khởi động môi trường và kết nối phiên

Khi hệ thống đã cài đặt Herdr, có CLI agent tương ứng, đã hoàn tất đăng nhập và đảm bảo tính tương thích với wire contract, bạn có thể khởi chạy và gắn kết phiên làm việc:

```bash
node "$BFLOW_HOME/apps/cli/dist/bin.js" up --timeout 60000
node "$BFLOW_HOME/apps/cli/dist/bin.js" attach
```

- **Yêu cầu tương tác**: Lệnh `attach` đòi hỏi môi trường terminal tương tác trực tiếp (TTY).
- **Lựa chọn nhà cung cấp**: Khuyến nghị dùng `init --provider claude` đối với persistent host mặc định đã được kiểm chứng; nếu không chỉ định cờ `--provider`, hệ thống sẽ sử dụng cấu hình mặc định kế thừa của Codex.
- **Quản lý mô hình**: Herdr trực tiếp quản lý provider và model được giao; cấu hình role của Bflow CLI không quy định cứng model tại tầng CLI.
- **An toàn hạ dịch vụ**: Vui lòng tham khảo kỹ các tài liệu hướng dẫn về [bflow up](bflow-up.md), [bflow attach](bflow-attach.md) và [bflow down](bflow-down.md), đặc biệt là các rào chắn kiểm soát khi shutdown trước khi triển khai môi trường dài hạn.

---

## 3. Lựa chọn kịch bản mẫu

Bạn có thể thử nghiệm với một trong các bài tập có sẵn trong thư mục `requests/`: tính năng mới (`feature`), sửa lỗi (`bugfix`), tái cấu trúc mã (`refactor`) hoặc tài liệu (`docs`). Các tệp cấu hình JSON trong [thư mục mẫu templates](../../templates/node-typescript/README.md) đóng vai trò là bản thảo sơ bộ (draft/seed) cho host P19. Host có nhiệm vụ liên kết với phiên chạy thực tế, bảo lưu tiêu chí tiếp nhận ban đầu, đánh giá phạm vi tác động thực tế, thiết lập các lệnh kiểm tra độc lập và tiếp nhận phê duyệt từ con người trước khi cho phép Developer bắt đầu lập trình.

Hiện tại hệ thống không cung cấp lệnh chạy tắt dạng `bflow run --kind bugfix` hay cơ chế tự động nạp thư mục template. Quy trình có thể chạy ngay lập tức là các bước cài đặt, kiểm tra kiểu tĩnh, biên dịch mã, chạy bộ kiểm thử và kiểm tra tính hợp lệ của cấu hình init. Vui lòng tham khảo [Báo cáo xác thực](../../templates/node-typescript/VALIDATION.md) để phân biệt rõ ràng giữa các bài kiểm tra này, bài kiểm tra smoke Herdr transport thực tế và các bước tích hợp AI đang được phát triển.
