# bflow

[![CI](https://github.com/qxbao/bflow/actions/workflows/ci.yml/badge.svg)](https://github.com/qxbao/bflow/actions/workflows/ci.yml)
[![CD — Build & Release](https://github.com/qxbao/bflow/actions/workflows/cd.yml/badge.svg)](https://github.com/qxbao/bflow/actions/workflows/cd.yml)
[![Node.js >= 22.13](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm 12.5.1](https://img.shields.io/badge/pnpm-12.5.1-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript 5.7](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**bflow** là nền tảng TypeScript module hoá và công cụ dòng lệnh (CLI) phục vụ điều phối các AI coding agent trong toàn bộ vòng đời phát triển phần mềm (SDLC). Bflow điều phối các tác vụ kỹ thuật qua quy trình nhiều bước (`plan` → `implement` → `qa` → `review`) với cơ chế chuyển trạng thái tất định (deterministic), lưu trữ lịch sử thực thi bền vững trên SQLite, quản lý artifact định danh theo hash nội dung (content-addressed), tự động kiểm soát chất lượng bằng các cổng kiểm tra (quality gates) độc lập và yêu cầu phê duyệt bắt buộc từ con người.

---

## Tính năng nổi bật

- **Deterministic Workflow Engine (`@bflow/core`)** — Đánh giá đồ thị tác vụ có hướng (DAG), thực thi nghiêm ngặt các chuyển trạng thái hợp lệ, quản lý vòng lặp thử lại (retry) và sửa lại (rework) có giới hạn, đồng thời hỗ trợ khôi phục toàn diện trạng thái từ event log và aggregate checkpoint.
- **Durable Local Persistence (`@bflow/persistence` & `@bflow/artifact-store`)** — Lưu trữ sự kiện quy trình (workflow events), biên nhận thực thi (execution receipts) và bản chiếu trạng thái (run projections) trong SQLite (`node:sqlite`), kết hợp kho lưu trữ artifact bất biến được xác minh mã băm (checksum) trên đĩa.
- **Role & Lease Registry (`@bflow/agent-registry`)** — Ánh xạ cấu hình các vai trò SDLC tới các agent tương ứng, hỗ trợ cơ chế cấp phát lease kèm fencing token chống xung đột và xác thực cấu trúc đầu ra.
- **Independent Quality Gates (`@bflow/quality-gates`)** — Thực thi các lệnh kiểm tra độc lập (`typecheck`, `lint`, `unit_test`, `build` hoặc kịch bản tuỳ chỉnh) trực tiếp trong workspace mục tiêu, không phụ thuộc vào kết quả tự báo cáo của agent.
- **Human-in-the-Loop Governance** — Bắt buộc xác nhận từ người vận hành tại các cổng phê duyệt (`approved`, `changes_requested`, `rejected`) trước khi cho phép các tác vụ bị chặn tiếp tục tiến trình.
- **Platform v3 Building Blocks (P25–P29)** — Bộ điều hợp nhà cung cấp (Claude Code, Codex, Agy), hệ thống thiết lập môi trường máy và bộ cài đặt công cụ cố định phiên bản (pinned), MCP Gateway dùng chung kết hợp dịch vụ hệ điều hành, thư viện kỹ năng chỉ dẫn (instruction-only skills) cố định phiên bản, cùng bộ lệnh CLI cấp cao. Tích hợp Runtime (P30) đã hoàn tất mã nguồn và kiểm thử cục bộ; giai đoạn nghiệm thu platform-v3 (P31) đang trong lộ trình triển khai.
- **CLI & Programmatic Runtime (`@bflow/cli` & `@bflow/runtime`)** — Quản lý quy trình linh hoạt qua giao diện dòng lệnh `bflow` (hỗ trợ hiển thị trực quan hoặc định dạng `--json`), hoặc nhúng trực tiếp `createRuntimeService` vào ứng dụng Node.js.

---

## Yêu cầu hệ thống

- **Node.js `>= 22.13`** (bắt buộc để sử dụng `node:sqlite` tích hợp sẵn mà không cần cờ thử nghiệm)
- **pnpm `12.5.1`** (được cố định qua trường `packageManager` trong `package.json`)
- Môi trường máy chủ Claude host bền vững mặc định: Hệ thống tệp cục bộ Linux/POSIX, Unix domain socket và tiện ích `flock`; các nền tảng khác hiện chưa được kiểm chứng đầy đủ.

---

## Cài đặt & Bắt đầu nhanh

```bash
git clone https://github.com/qxbao/bflow.git
cd bflow
pnpm install --frozen-lockfile
pnpm build
```

Kiểm tra bản dựng của workspace và chạy thử nghiệm quy trình mẫu:

```bash
node examples/runtime-demo/run-demo.mjs
```

---

## Hướng dẫn sử dụng CLI

Biên dịch từ mã nguồn, thiết lập biến môi trường `BFLOW_HOME` trỏ tới đường dẫn tuyệt đối của thư mục dự án, sau đó thực thi lệnh từ repository Git đích (áp dụng cho cả các dự án Node.js/TypeScript độc lập):

```bash
node "$BFLOW_HOME/apps/cli/dist/bin.js" init --name my-project --provider claude
node "$BFLOW_HOME/templates/node-typescript/apply.mjs" . bugfix
node "$BFLOW_HOME/apps/cli/dist/bin.js" doctor --json
node "$BFLOW_HOME/apps/cli/dist/bin.js" status --json
# Yêu cầu môi trường tích hợp Herdr agent đã được cài đặt và xác thực hợp lệ:
node "$BFLOW_HOME/apps/cli/dist/bin.js" up --timeout 60000
node "$BFLOW_HOME/apps/cli/dist/bin.js" attach
```

Lệnh `init` sẽ tạo tệp cấu hình chuẩn YAML có kèm chú thích tại **`.bflow/config.yml`** với định danh riêng biệt cho từng checkout. Lệnh `bflow config-migrate` hỗ trợ chuyển đổi các tệp `.bflow/config.yaml` hoặc `.bflow/config.json` cũ, bảo lưu nguyên vẹn giá trị và sao lưu tệp gốc sang phần mở rộng `.bak`. Bạn cần thực thi `init` riêng biệt trong từng repository hoặc worktree. Thông thường, việc chạy lại lệnh `init` sẽ giữ nguyên tệp cấu hình hiện hữu; chỉ khi truyền cờ `--force` hoặc `--yes` thì hệ thống mới ghi đè. Khuyến nghị theo dõi các template portable thay vì sao chép tệp cấu hình chứa định danh cục bộ giữa các bản clone. Đối với repository khởi tạo từ các phiên bản Bflow cũ hơn, hãy chạy lệnh sau trước khi thao tác với tệp YAML:
```bash
node "$BFLOW_HOME/apps/cli/dist/bin.js" config-migrate
```

Nếu lệnh `bflow up` thất bại sau khi đã làm thay đổi trạng thái session, hệ thống sẽ chủ động kích hoạt quy trình hạ dịch vụ an toàn (`safe down`). Trong trường hợp việc dọn dẹp không thể chứng minh là an toàn tuyệt đối, lỗi sẽ thông báo chi tiết và bảo lưu biên nhận thao tác (operation receipt) cùng trạng thái phục hồi để phục vụ kiểm tra qua `status`, `doctor` hoặc thực hiện đối soát thủ công bằng `bflow down --yes`. Lưu ý rằng một lần khởi động thất bại không đồng nghĩa với việc toàn bộ các pane đã được dừng hẳn.

Lệnh `up` sẽ khởi tạo một persistent P19 host, đăng ký các công cụ Claude MCP có giới hạn phạm vi cùng các hook phiên làm việc/tiếp nhận dữ liệu người dùng cục bộ cho từng lượt khởi chạy, sau đó yêu cầu host gửi tín hiệu xác nhận kích hoạt trước khi công bố trạng thái sẵn sàng (`ready`). Host mặc định hỗ trợ xem tài liệu Claude, đánh giá thủ công và xác minh hành vi bằng bộ kiểm thử Node TAP hoặc Vitest 2.1 do quản trị viên cấu hình, bao gồm cả quy trình kiểm thử độc lập Red–Green–Refactor. Vui lòng cấu hình [.bflow/verification.json](docs/verification-runners.md) trước khi khởi động; các bài kiểm tra tự động đòi hỏi môi trường sandbox Linux Bubblewrap. Các helper khởi chạy Codex vẫn được giữ lại, tuy nhiên host mặc định sẽ từ chối các provider hook chưa qua kiểm chứng. Khuyến nghị sử dụng `init --provider claude` cho luồng hoạt động này. Các chính sách về SDD, TDD có điều kiện, kiểm thử xác minh và mức độ song song đều được chuyển tiếp đầy đủ đến host.

Khi hạ dịch vụ, lệnh `down` sẽ rút cạn tác vụ (drain) trên host, lưu lại các aggregate checkpoint có giá trị pháp lý và chỉ đóng các pane cũng như server thuộc về repository tương ứng; cờ `--yes` không bao giờ bỏ qua rào chắn an toàn (shutdown barrier). Các bài kiểm thử smoke thực tế đã xác minh chu trình `up → down → up → down` mà không phát sinh lỗi workflow. Việc nghiệm thu đầy đủ quy trình AI SDLC vẫn đang trong quá trình kiểm chứng; xem thêm tại [báo cáo sẵn sàng phát hành](docs/release-readiness.md).

Các lệnh nền tảng cấp cao thuộc giai đoạn P29 (đều hỗ trợ định dạng `--json`) gồm có: `bflow setup` (`--check`, `--dry-run`/`--plan`, `--apply`, `--repair`, `--yes`), `bflow repo inspect`, `bflow task plan`, `bflow task implement`, `bflow verify`, `bflow git prepare`, `bflow mcp status`, `bflow tool status`, `bflow skills sync` và `bflow agent check`; lệnh `bflow recover --yes` dùng để dọn dẹp khóa vòng đời (lifecycle lock) cũ còn sót lại. Các lệnh này tái sử dụng bộ máy hiện tại và không tự động điều phối agent độc lập; lệnh `bflow up` sẽ chặn nếu báo cáo tiền kiểm tra (preflight) của provider theo từng vai trò trong Runtime host (P30) không đạt, và việc lệnh chạy thành công không đồng nghĩa với việc toàn bộ workflow đã được nghiệm thu. Vui lòng tham khảo thêm qua `bflow --help`.

Các lệnh quản lý workflow phiên bản cũ (`run`, `status <run-id>`, `approve`, `resume`, `cancel`) vẫn có thể sử dụng thông qua Runtime workspace cũ, nhưng sẽ không kích hoạt host P19. Tham khảo `--help` để biết cú pháp chi tiết và đọc [tài liệu hướng dẫn](docs/guide/README.md) để nắm rõ hành vi cũng như các giới hạn tích hợp. Bắt đầu với [Hướng dẫn nhập môn](docs/guide/getting-started.md), [mẫu template portable](templates/node-typescript/README.md) và [ví dụ TypeScript độc lập](examples/portable-node/README.md).

---

## Các package trong workspace

| Package | Mô tả |
| --- | --- |
| [`@bflow/cli`](apps/cli) | Giao diện dòng lệnh (`bflow`) quản lý vòng đời môi trường (`init`/`up`/`down`/`attach`/`status`/`doctor`), thiết lập môi trường máy, kiểm tra tính sẵn sàng của provider/skills/tool, cung cấp bộ lệnh SDLC cấp cao và quản lý các lượt chạy workflow |
| [`@bflow/runtime`](packages/runtime) | Dịch vụ điều phối cấp cao kết hợp chặt chẽ workflow engine, tầng lưu trữ, registry, tầng truyền tải transport và các cổng kiểm soát chất lượng |
| [`@bflow/core`](packages/core) | Bộ máy thực thi quy trình tất định thuần tuý (lập lịch đồ thị DAG, kiểm soát chuyển trạng thái, cơ chế retry/rework và khôi phục trạng thái) |
| [`@bflow/contracts`](packages/contracts) | Hệ thống Zod schema dùng chung, giao diện port công khai và các bộ xác thực tính hợp lệ của sự kiện/chuyển trạng thái |
| [`@bflow/agent-registry`](packages/agent-registry) | Registry quản lý vai trò và ánh xạ agent lưu trên tệp tin, cấp phát lease, quản lý fencing token và lưu trữ mẫu workflow |
| [`@bflow/herdr-adapter`](packages/herdr-adapter) | Tầng truyền tải `AgentTransport` dựa trên CLI; thương lượng giao thức và schema linh hoạt, không phụ thuộc vào danh sách cho phép (allowlist) phiên bản cố định |
| [`@bflow/persistence`](packages/persistence) | Tầng lưu trữ `RunStore` trên nền SQLite hỗ trợ xử lý theo lô sự kiện (event batch) nguyên tử, lưu biên nhận thực thi và checkpoint |
| [`@bflow/artifact-store`](packages/artifact-store) | Kho lưu trữ `ArtifactStore` trên hệ thống tệp tin tích hợp danh mục SQLite và cơ chế xác thực toàn vẹn luồng dữ liệu qua SHA-256 |
| [`@bflow/conversation`](packages/conversation) | Cổng giao tiếp của Conversation Agent (`chat`), phân loại ý định người dùng, kiến tạo yêu cầu ủy quyền `DelegationRequest` có cấu trúc và kết nối Herdr tới Coordinator (P14); việc tích hợp host P19 và xác thực thông điệp bản địa đã có sẵn trong `@bflow/runtime`; quy trình bàn giao AI thực tế cần kiểm chứng riêng |
| [`@bflow/specification`](packages/specification) | Phân loại đặc tả yêu cầu thích ứng, thẩm định tính hợp lệ, quản lý phiên bản, truy vết yêu cầu và thực thi chính sách phê duyệt (P15); đã tích hợp sẵn trong `@bflow/runtime`; quy trình bàn giao AI thực tế cần kiểm chứng riêng |
| [`@bflow/test-strategy`](packages/test-strategy) | Động cơ chính sách TDD có điều kiện, ánh xạ tiêu chí nghiệm thu và xác thực bằng chứng Red/Green/Refactor (P16); được thực thi thông qua tích hợp host P19 |
| [`@bflow/verification`](packages/verification) | Động cơ thẩm định tác vụ và quy trình độc lập, kiểm tra bằng chứng tiêu chí, hỗ trợ vai trò Reviewer/QA, quản lý vòng lặp sửa đổi có giới hạn và báo cáo leo thang (P17); được P19 tích hợp cùng các cổng kiểm soát tin cậy |
| [`@bflow/git-orchestrator`](packages/git-orchestrator) | Quản lý Git worktree song song cho từng tác vụ, kiểm soát phạm vi thay đổi tệp, lưu trữ patch, tích hợp nhánh theo thứ tự phụ thuộc có khả năng phục hồi, xử lý xung đột, thẩm định workflow và hỗ trợ tạo PR (P18); được tích hợp bởi P19; yêu cầu môi trường Linux/Git cục bộ |
| [`@bflow/pane-manager`](packages/pane-manager) | Quản lý không gian làm việc, tab, pane và tiến trình agent của Herdr, ánh xạ vai trò sang pane, tự động cấp phát pane worktree cho Developer và phục hồi sau sự cố (P13) |
| [`@bflow/agent-providers`](packages/agent-providers) | Tự động phát hiện Claude Code, Codex và Agy, theo dõi trạng thái sức khỏe tiền kiểm tra/kích hoạt, tổng hợp profile phân quyền, cấu hình khởi chạy và cấp chứng thư khởi động có chữ ký số (P25); được Runtime host tích hợp cho chu trình kiểm tra/khởi chạy/kích hoạt (P30) |
| [`@bflow/machine-setup`](packages/machine-setup) | Tầng backend quản lý thiết lập máy: quan sát, lập kế hoạch, phê duyệt, áp dụng và tự động sửa chữa đi kèm trạng thái riêng tư, nhật ký journal, biên nhận và công cụ chẩn đoán doctor (P26); phục vụ trực tiếp cho lệnh `bflow setup` |
| [`@bflow/tool-installer`](packages/tool-installer) | Cài đặt các công cụ cố định phiên bản kèm xác minh mã băm checksum (RTK, GitNexus, MemPalace, provider plugin) và kiểm kê năng lực theo từng phạm vi (P26) |
| [`@bflow/mcp-gateway`](packages/mcp-gateway) | Registry quản lý dịch vụ MCP dùng chung, máy chủ Streamable HTTP loopback, cầu nối chuyển đổi stdio sang HTTP, thực thi chính sách chia sẻ/cô lập tài nguyên, cấp phát lease tài nguyên độc quyền kèm fencing token cùng hệ thống giám sát tiến trình/bộ nhớ/độ trễ (P27); Runtime đăng ký role client thông qua điểm cuối kiểm soát đã xác thực (P30) |
| [`@bflow/mcp-services`](packages/mcp-services) | Trình quản lý dịch vụ hệ điều hành theo phiên người dùng (`systemd --user`, `launchd`, Windows startup), điều phối hồ tài nguyên (resource pooling) linh hoạt (lazy/eager), giới hạn ngưỡng tiêu thụ bộ nhớ RSS & tiến trình, đồng thời cung cấp môi trường chạy trình duyệt Chrome riêng biệt được cô lập qua cổng kiểm soát quyền sở hữu trang (P27) |
| [`@bflow/skills`](packages/skills) | Danh mục kỹ năng chỉ dẫn được cố định phiên bản, manifest theo từng vai trò, kho lưu trữ cục bộ bảo mật và tham chiếu trung lập không phụ thuộc nhà cung cấp (P28); được sử dụng bởi bộ đồng bộ thiết lập, lệnh CLI `skills sync` và manifest theo từng phiên của Runtime (P30) |
| [`@bflow/quality-gates`](packages/quality-gates) | Bộ đánh giá lệnh kiểm tra thiết lập sẵn, thực thi chính sách bảo mật workspace và kiểm soát phân quyền dựa trên vai trò (RBAC) |

---

## Phát triển & Kiểm thử

| Lệnh | Mô tả |
| --- | --- |
| `pnpm build` | Biên dịch toàn bộ các package trong workspace và ứng dụng CLI (`tsc -b`) |
| `pnpm lint` | Kiểm tra ranh giới phụ thuộc giữa các package (`check:deps`) và kiểm tra kiểu TypeScript trên toàn bộ workspace cùng các suite kiểm thử E2E |
| `pnpm test` | Biên dịch các package và chạy toàn bộ bài kiểm thử đơn vị & tích hợp (sử dụng Vitest) |
| `pnpm test:e2e` | Biên dịch các package và thực thi các kịch bản kiểm thử đầu-cuối end-to-end (`tests/e2e`) |
| `pnpm check` | Thực thi tổng hợp: kiểm tra phụ thuộc, kiểm tra kiểu tĩnh và chạy toàn bộ bộ test |

### Chạy kiểm thử có định hướng hoặc phân mảnh (shard)

Do các tiến trình con và worker nạp các module đã biên dịch từ thư mục `dist/`, hãy luôn chạy `pnpm build` trước khi gọi trực tiếp `vitest`:

```bash
pnpm build

# Chạy bài kiểm thử đơn vị theo phân mảnh (ví dụ: mảnh 1 trên tổng số 4)
pnpm exec vitest run --shard=1/4

# Chạy kịch bản kiểm thử E2E theo phân mảnh (ví dụ: mảnh 1 trên tổng số 2)
pnpm exec vitest run --config tests/e2e/vitest.config.ts --shard=1/2

# Chạy bộ kiểm thử cho một package cụ thể
pnpm exec vitest run packages/runtime/test

# Biên dịch và kiểm thử riêng động cơ Verification Engine P17
pnpm --filter @bflow/verification test

# Chạy kiểm thử cho Conversation Gateway
pnpm --filter @bflow/conversation test

# Chạy kiểm thử cho Specification Engine
pnpm --filter @bflow/specification test

# Chạy kiểm thử cho Conditional TDD Policy Engine
pnpm --filter @bflow/test-strategy test

# Chạy kiểm thử Git Integration Engine (với repository tạm thời và kiểm tra khôi phục khi gặp SIGKILL)
pnpm --filter @bflow/git-orchestrator test

# Chạy kiểm thử Provider Adapter, Machine Setup, Tool Installer và Skills
pnpm --filter @bflow/agent-providers test
pnpm --filter @bflow/machine-setup test
pnpm --filter @bflow/tool-installer test
pnpm --filter @bflow/skills test

# Chạy kiểm thử Shared MCP Gateway
pnpm --filter @bflow/mcp-gateway test

# Chạy kiểm thử OS Services & Môi trường chạy trình duyệt chuyên dụng
pnpm --filter @bflow/mcp-services test
```

---

## Hạn chế đã biết

- Giai đoạn P31 (nghiệm thu toàn diện platform-v3) hiện chưa được triển khai; bằng chứng kỹ thuật cho các giai đoạn P25–P30 mới dừng ở mức mã nguồn và các bài test cục bộ/fake-runner (chưa có dữ liệu vận hành thực tế trên môi trường live provider, Herdr hoặc Gateway backend).
- Quá trình nghiệm thu thực tế với các nhà cung cấp mô hình (Claude Code, Codex, Agy) và toàn bộ chu trình Agentic SDLC end-to-end đang tiếp tục được hoàn thiện; xem thêm tại [báo cáo sẵn sàng phát hành](docs/release-readiness.md) và [danh mục hạn chế đã biết](docs/known-limitations.md).

---

## Đường ống CI/CD

Các workflow GitHub Actions được thiết lập trong [`.github/workflows/`](.github/workflows):

- **CI ([`ci.yml`](.github/workflows/ci.yml))** — Tự động kích hoạt trên mọi sự kiện push và pull request:
  1. **Lint & Build**: Kiểm tra ranh giới phụ thuộc (`pnpm lint`), biên dịch toàn bộ workspace (`pnpm build`) và lưu trữ các artifact `dist/`.
  2. **Sharded Unit & Package Tests**: Chạy song song bộ kiểm thử đơn vị và kiểm thử package trên **4 phân mảnh** (`--shard=1/4` .. `4/4`).
  3. **Sharded E2E Scenarios**: Chạy song song bộ kịch bản kiểm thử E2E trên **2 phân mảnh** (`--shard=1/2` .. `2/2`).
- **CD ([`cd.yml`](.github/workflows/cd.yml))** — Kích hoạt khi gắn tag phiên bản (`v*`) hoặc chạy thủ công:
  - Kiểm tra tính hợp lệ của mã nguồn qua lint và build, đóng gói toàn bộ các package workspace `@bflow/*` (`.tgz`), tạo tệp nén phân phối hoàn chỉnh (`bflow-<tag>-dist.tar.gz`) kèm mã băm `SHA256SUMS.txt`, và tự động xuất bản lên **GitHub Releases**.

---

## Tài liệu tham khảo

- [Hướng dẫn sử dụng chi tiết](docs/guide/README.md)
- [Tổng quan kiến trúc hệ thống](docs/architecture.md)
- [Hợp đồng giao tiếp công khai (Public Contracts)](docs/contracts.md)
- [Hồ sơ quyết định kiến trúc (ADR)](docs/adr)
- [Dự án mẫu & Minh họa Runtime](examples/README.md)
