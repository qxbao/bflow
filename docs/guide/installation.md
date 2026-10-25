# Cài đặt Bflow

Bflow hiện được build từ source; các package còn `private`. Cần **Node.js ≥22.13** cho `node:sqlite` và **pnpm 12.5.1**, đúng `packageManager` trong [package.json](../../package.json).

## Chuẩn bị máy

| Môi trường | Điều kiện |
| --- | --- |
| Linux | Git, filesystem cục bộ, `systemd --user`, `flock` của util-linux; `/usr/bin/bwrap` và user namespaces cho verification |
| macOS | Git, `launchd`, Apple Command Line Tools (`xcode-select --install`), `/usr/bin/sandbox-exec`, `flock` có hỗ trợ inherited file descriptor; Python ≥3.11 có `tomllib` cho profile sync |
| Windows native | Machine mutation vẫn `designed_unverified` và bị chặn; không coi Git Bash là nghiệm thu Windows |

Dùng filesystem có quyền POSIX cho machine state/secret. Runtime có cơ chế chọn private state ngoài repository khi checkout không áp dụng được quyền riêng tư; xem [configuration reference](configuration-reference.md). Source/worktree, sandbox và dependency vẫn phải thỏa điều kiện riêng. Không có cam kết network filesystem, multi-host hoặc hostile same-UID isolation. [Ma trận hỗ trợ](../compatibility-matrix.md) phân biệt source, local test và phép đo thật.

## Build và bootstrap một lần

```bash
git clone https://github.com/qxbao/bflow.git
cd bflow
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/bin.js setup
```

`setup` hiển thị machine plan và hỏi trước khi áp dụng trong TTY. Nó tạo launcher **`bflow`** và managed PATH trong cấu hình shell; mở terminal mới hoặc reload đúng file mà setup thông báo:

```bash
# Ví dụ với zsh, nếu setup thông báo ~/.zshrc:
source ~/.zshrc
bflow --help
bflow setup --check
```

Từ đó dùng alias/lệnh tắt **`bflow …`** ở repository bất kỳ. Về kỹ thuật đây là executable wrapper do setup quản lý, không cần khai báo shell alias thủ công hoặc `pnpm link --global`. Launcher trỏ đến Node và `apps/cli/dist/bin.js` đã setup: giữ checkout tại vị trí đó, rebuild sau cập nhật source, chạy lại setup khi cần cập nhật launcher/tool/Gateway.

Không tương tác: xem trước bằng `node apps/cli/dist/bin.js setup --dry-run`, rồi dùng `setup --yes` khi đã chấp thuận plan. `--check`/`--dry-run` chỉ đọc; `--yes` không thực hiện đăng nhập provider hoặc phê duyệt Codex global hooks. [Setup guide](../setup-guide.md) giải thích từng bước.

## Provider, Herdr và repository

Setup dùng [catalog đã review](../../packages/tool-installer/src) để chuẩn bị công cụ trên nền tảng được hỗ trợ. Cài binary chưa chứng minh auth/readiness: đăng nhập provider theo tài khoản của bạn, rồi kiểm tra trong repository đích:

```bash
cd /path/to/your-project
bflow init --provider codex
bflow setup --dir .
bflow doctor
```

Standalone `bflow agent check codex` là diagnostic riêng: adapter có thể chạy model probe và dùng account mặc định, không chọn role/profile/model từ `.bflow/config.yml`. `doctor`/`up` là đường kiểm tra cấu hình host thực tế.

`--dir` chuẩn bị index/backend cục bộ cho repository; installation vẫn thuộc machine. Context7 hosted dùng chung giữa worktrees, GitNexus/Chrome/local backend vẫn cần đúng workspace đã setup. Herdr phải đáp ứng protocol 22/schema 1 và hành vi thực tế; release label chỉ phục vụ chẩn đoán.

Với Agy specialist, cấu hình Conversation bằng Claude/Codex; Agy Conversation và unattended hiện unsupported. Profile riêng phải được tạo/đăng nhập trước qua `bflow iso`, rồi chọn `profile-name` trong config. [Cấu hình](configuration-reference.md) · [Provider adapters](../../packages/agent-providers/README.md).

## Biến môi trường và cập nhật source

Nếu cần chạy script trong source checkout từ dự án khác, tự đặt biến đường dẫn **`BFLOW_SOURCE`**:

```bash
export BFLOW_SOURCE=/absolute/path/to/bflow
node "$BFLOW_SOURCE/templates/node-typescript/verify.mjs"
```

`BFLOW_SOURCE` chỉ là biến tiện dụng trong ví dụ. **Không dùng `BFLOW_HOME` để trỏ source**: đó là selector riêng của Bflow cho machine state và provider source cô lập, làm thay đổi môi trường auth/config. Nếu chủ động dùng isolation, giữ cùng `BFLOW_HOME`/`AI_ISOLATOR_HOME` trong setup, iso và up; xem [CLI README](../../apps/cli/README.md).

Build trước khi chạy demo hoặc test subprocess vì chúng import `dist/`. Cài dependency của chính target repo; không copy `node_modules` của Bflow sang đó. Trên macOS, dependency warming và native polyglot mounts vẫn Linux-only; chuẩn bị dependency trước verification. Tiếp tục với [getting started](getting-started.md).
