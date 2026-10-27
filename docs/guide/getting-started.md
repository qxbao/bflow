# Chạy phiên Bflow đầu tiên

Sau [setup một lần](installation.md), dùng lệnh tắt `bflow` cho mọi thao tác bên dưới. Hướng dẫn này tạo một Git repository Node/TypeScript độc lập; nó không tuyên bố đã nghiệm thu một workflow provider thật trên máy của bạn.

## 1. Chuẩn bị repository mẫu

Chọn thư mục `/tmp/my-bflow-calculator` chưa tồn tại và đặt `BFLOW_SOURCE` tới source checkout đã build:

```bash
export BFLOW_SOURCE=/absolute/path/to/bflow
mkdir /tmp/my-bflow-calculator
git -C "$BFLOW_SOURCE" archive HEAD:examples/portable-node | tar -x -C /tmp/my-bflow-calculator
cd /tmp/my-bflow-calculator
git init
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
git add .gitignore README.md package.json pnpm-lock.yaml tsconfig.json src test requests
git commit -m "chore: initialize calculator example"

bflow init --name calculator --provider codex
node "$BFLOW_SOURCE/templates/node-typescript/apply.mjs" . bugfix
```

Git cần `user.name`/`user.email` để commit. `git archive` chỉ lấy nội dung đã commit, không lấy state, artifact hoặc `node_modules` của Bflow. `BFLOW_SOURCE` là biến ví dụ; `BFLOW_HOME` có ý nghĩa isolation riêng và không dùng làm đường dẫn source.

## 2. Chuẩn bị provider và kiểm tra môi trường

Đăng nhập CLI của provider bạn chọn. Dùng `--provider claude` ở bước init nếu muốn dùng Claude; mặc định init là Codex. Với profile đã tạo qua `bflow iso`, chọn `profile-name` trong config. Không đặt toàn bộ role sang Agy vì Conversation cần trusted human-input hook mà Agy chưa cung cấp.

```bash
bflow init --check
bflow doctor
bflow tool status
```

`doctor` kiểm tra role/profile/model trong config mà không model ping mặc định. Standalone `agent check` có thể tiêu hao usage và không thay kiểm tra profile của host. `mcp status` hiện chỉ có inventory mặc định; live Gateway port chưa được nối vào đường CLI đó.

`bflow init` ở bước trên đã chuẩn bị chỉ mục GitNexus và đăng ký dịch vụ `gitnexus-<repo>` của kho mã trên Gateway cấp máy (hỏi xác nhận giấy phép PolyForm-Noncommercial lần đầu, hoặc truyền `--yes`; dùng `--no-gitnexus` nếu muốn bỏ qua); công cụ cấp máy từ `bflow setup` được tái sử dụng. Thiếu thành phần bắt buộc làm doctor/preflight fail. Công cụ tích hợp optional có thể degraded; xem reason và không suy installed là usable.

Xem lại `.bflow/config.yml`, rồi commit cấu hình trước khi triển khai:

```bash
git add .bflow/.gitignore .bflow/config.yml
git commit -m "chore: add bflow config"
git status --short
```

Runtime yêu cầu working tree sạch trước khi tạo worktree cho Developer. Không sao chép config có identity từ checkout khác. Repository lớn hoặc dự án lồng cần kiểm tra [runner detection](../verification-runners.md); `.bflow/verification.json` là owner override tùy chọn.

## 3. Khởi động và gửi yêu cầu

```bash
bflow up --timeout 300000
bflow attach
```

`up` chuẩn bị persistent Runtime host, kiểm tra platform, launch từng role qua Herdr và đợi attestation/activated health. Config mới mặc định 300.000 ms, nhưng fragment template vừa áp dụng đặt 60.000 ms; lệnh trên ghi đè thành 300.000 ms cho phiên đầu. `--timeout` bao gồm toàn bộ startup budget. `attach` cần TTY và đưa bạn vào Conversation Agent.

Dùng nội dung trong `requests/bugfix.md`, `feature.md`, `refactor.md` hoặc `docs.md` làm yêu cầu. Ví dụ:

> Hãy sửa lỗi tràn số nguyên an toàn của `sum` theo `requests/bugfix.md`. Giữ API hiện tại, xác định tiêu chí nghiệm thu và bổ sung kiểm thử trước khi sửa nếu TDD bắt buộc.

Conversation nhận yêu cầu, Coordinator khảo sát và đề xuất đặc tả/kế hoạch qua Runtime. Các seed trong template không phải đặc tả đã duyệt: host vẫn liên kết run, đóng băng tiêu chí, giải quyết TDD, yêu cầu approval và kiểm chứng độc lập. Khi Conversation trình quyết định, trả lời đúng lựa chọn và phạm vi. Không có shortcut `bflow run --kind bugfix` cho luồng P19.

Conversation dùng nhãn như `Việc #2` và mã thẻ như `#3`. Trả lời theo đúng lựa chọn/hạn của thẻ, hoặc hỏi “xem chi tiết #3”; bạn không cần tự chép run/approval ID nội bộ. NFR liên quan phải có oracle và điều kiện được chấp nhận trước khi đo; số mẫu trong skill không là SLA. [Conversation updates](conversation-updates.md) · [NFR/test design](../nfr-and-test-design.md).

## 4. Theo dõi, xử lý blocker và kết thúc

Trong terminal khác:

```bash
bflow status --json
bflow doctor --json
```

Conversation báo tiến độ, blocker và bước tiếp theo. Nếu cần sửa yêu cầu, gửi revision qua cùng cuộc hội thoại. Chỉ dùng `tiếp tục việc #2` theo nhãn của phiên (hoặc `tiếp tục` nếu chỉ có một việc rõ ràng) khi pending action cho phép; resume không thay thế approval đang chờ. Legacy `bflow resume <run-id>` dùng store khác, không dùng để phục hồi run P19.

Khi kết thúc:

```bash
bflow down
# Nếu đã quyết định dừng dù còn run active:
bflow down --yes
```

`--yes` xác nhận dừng có checkpoint; shutdown barrier vẫn phải đạt. Giữ nguyên receipt và worktree khi delivery chưa rõ. Xem [recovery](session-recovery.md), [troubleshooting](troubleshooting.md) và [trạng thái nghiệm thu](../implementation-status.md).
