# bflow

[![CI](https://github.com/qxbao/bflow/actions/workflows/ci.yml/badge.svg)](https://github.com/qxbao/bflow/actions/workflows/ci.yml)
[![CD — Build & Release](https://github.com/qxbao/bflow/actions/workflows/cd.yml/badge.svg)](https://github.com/qxbao/bflow/actions/workflows/cd.yml)
[![Node.js >= 22.13](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm 12.5.1](https://img.shields.io/badge/pnpm-12.5.1-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript 5.7](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**bflow** là một nền tảng TypeScript dạng module và CLI để điều phối các AI coding agent trong quy trình phát triển phần mềm (SDLC). Nền tảng điều phối các tác vụ kỹ thuật nhiều bước (`plan` → `implement` → `qa` → `review`) với chuyển trạng thái tất định, bản ghi thực thi SQLite bền vững, artifact định địa chỉ theo nội dung, quality gate tự động và các điểm kiểm tra phê duyệt của con người.

---

## Tính năng

- **Deterministic Workflow Engine (`@bflow/core`)** — Đánh giá DAG tác vụ, thực thi các chuyển trạng thái hợp lệ, quản lý vòng retry và rework có giới hạn, và hỗ trợ khôi phục đầy đủ từ event log và aggregate checkpoint.
- **Durable Local Persistence (`@bflow/persistence` & `@bflow/artifact-store`)** — Lưu workflow event, execution receipt và run projection trong SQLite (`node:sqlite`), cùng với các artifact bất biến được xác minh checksum trên đĩa.
- **Role & Lease Registry (`@bflow/agent-registry`)** — Ánh xạ các role SDLC đã cấu hình tới agent, kèm lấy lease, fencing token và xác thực đầu ra có cấu trúc.
- **Independent Quality Gates (`@bflow/quality-gates`)** — Chạy các lệnh xác minh (`typecheck`, `lint`, `unit_test`, `build` hoặc kiểm tra tùy chỉnh) trong workspace đích, độc lập với báo cáo tự đánh giá của agent.
- **Human-in-the-Loop Governance** — Bắt buộc xác minh tác nhân là con người tại các approval gate (`approved`, `changes_requested`, `rejected`) trước khi cho các tác vụ bị chặn tiến tiếp.
- **Platform v3 building blocks (P25–P29)** — Provider adapter (Claude Code, Codex, Agy), machine setup và trình cài đặt tool được pin phiên bản, MCP Gateway dùng chung và các dịch vụ OS, skill chỉ chứa hướng dẫn được pin phiên bản, cùng các lệnh CLI cấp cao. Tích hợp Runtime (P30) đã được triển khai trong source với test cục bộ; nghiệm thu platform-v3 (P31) chưa được triển khai.
- **CLI & Programmatic Runtime (`@bflow/cli` & `@bflow/runtime`)** — Quản lý workflow từ terminal qua `bflow` (đầu ra dễ đọc hoặc `--json`) hoặc nhúng trực tiếp `createRuntimeService` vào ứng dụng Node.js.

---

## Yêu cầu

- **Node.js `>= 22.13`** (cần cho `node:sqlite` tích hợp sẵn không cần cờ)
- **pnpm `12.5.1`** (được pin qua `packageManager` trong `package.json`)
- Persistent Claude host mặc định: Linux/filesystem cục bộ, Unix socket và `flock`; các nền tảng khác chưa được xác minh.

---

## Cài đặt & Bắt đầu nhanh

```bash
git clone https://github.com/qxbao/bflow.git
cd bflow
pnpm install --frozen-lockfile
pnpm build
```

Xác minh bản build của workspace và chạy workflow demo:

```bash
node examples/runtime-demo/run-demo.mjs
```

---

## Sử dụng CLI

Build từ source, đặt `BFLOW_HOME` là đường dẫn tuyệt đối của checkout này, rồi chạy
từ Git repository đích (kể cả một dự án Node.js/TypeScript khác):

```bash
node "$BFLOW_HOME/apps/cli/dist/bin.js" init --name my-project --provider claude
node "$BFLOW_HOME/templates/node-typescript/apply.mjs" . bugfix
node "$BFLOW_HOME/apps/cli/dist/bin.js" doctor --json
node "$BFLOW_HOME/apps/cli/dist/bin.js" status --json
# Yêu cầu tích hợp agent Herdr đã được cài đặt/xác thực:
node "$BFLOW_HOME/apps/cli/dist/bin.js" up --timeout 60000
node "$BFLOW_HOME/apps/cli/dist/bin.js" attach
```

Init ghi YAML truyền thống có chú thích vào **`.bflow/config.yml`** với
định danh riêng cho từng checkout. `bflow config-migrate` chuyển đổi một
`.bflow/config.yaml` hoặc `.bflow/config.json` cũ, giữ nguyên giá trị và lưu
bản gốc thành file `.bak`. Chạy init riêng trong từng repository/worktree.
Chạy init lặp lại thông thường sẽ giữ nguyên file; `--force`/`--yes` tường minh sẽ ghi đè.
Hãy theo dõi các template portable thay vì sao chép config đã gắn định danh giữa các bản clone.
Với repository được tạo bởi phiên bản Bflow cũ hơn, chạy
`node "$BFLOW_HOME/apps/cli/dist/bin.js" config-migrate` trước khi dùng file YAML.

Nếu `bflow up` thất bại sau khi đã thay đổi trạng thái session, nó sẽ cố gắng thực hiện `down` an toàn.
Khi không thể chứng minh việc dọn dẹp là an toàn, lỗi sẽ báo kết quả đó và giữ lại
operation receipt cùng trạng thái khôi phục cho `status`, `doctor` hoặc lần đối soát
`bflow down --yes` sau đó. Một lần khởi động thất bại không phải bằng chứng rằng mọi pane
đã được dừng.

`up` hiện khởi động một persistent P19 host, đăng ký các công cụ Claude MCP có phạm vi
và các hook native session/user-input cục bộ theo lần launch, rồi yêu cầu host được kích hoạt trước khi
báo sẵn sàng. Host mặc định hỗ trợ tài liệu Claude/review thủ công
và xác minh hành vi bằng Node TAP hoặc Vitest 2.1 do owner cấu hình, bao gồm
Red–Green–Refactor độc lập. Cấu hình [.bflow/verification.json](docs/verification-runners.md)
trước khi khởi động; các kiểm tra tự động yêu cầu sandbox Linux Bubblewrap. Các codex launch helper vẫn còn, nhưng host
mặc định từ chối các provider hook chưa được xác minh. Dùng `init --provider claude` cho đường này.
Các chính sách SDD/conditional-TDD/verification/concurrency được chuyển tiếp tới host.
`down` drain host, lưu các checkpoint có thẩm quyền và chỉ đóng pane/server
của repository; `--yes` không bao giờ bỏ qua barrier. Live smoke đã
xác minh `up → down → up → down` mà không có lượt workflow/model nào. Nghiệm thu AI SDLC
đầy đủ vẫn chưa được xác minh; xem [release readiness](docs/release-readiness.md).

Các lệnh nền tảng cấp cao (P29), đều hỗ trợ `--json`: `bflow setup` (`--check`, `--dry-run`/`--plan`, `--apply`, `--repair`, `--yes`), `bflow repo inspect`, `bflow task plan`, `bflow task implement`, `bflow verify`, `bflow git prepare`, `bflow mcp status`, `bflow tool status`, `bflow skills sync` and `bflow agent check`; `bflow recover --yes` xóa lifecycle lock cũ. Các lệnh này tái sử dụng engine hiện có và tự chúng không dispatch agent; `bflow up` chặn theo preflight provider theo từng role của Runtime host (P30, source + test cục bộ), và việc lệnh thành công vẫn không phải là nghiệm thu workflow. Xem `bflow --help`.

Các lệnh workflow cũ (`run`, `status <run-id>`, `approve`, `resume`, `cancel`)
vẫn dùng được thông qua workspace Runtime cũ. Chúng không khởi chạy P19.
Dùng `--help` để xem cú pháp, và [hướng dẫn hiện hành](docs/guide/README.md) để biết hành vi
và giới hạn tích hợp. Bắt đầu với [Getting Started](docs/guide/getting-started.md),
[portable template](templates/node-typescript/README.md) và
[ví dụ TypeScript độc lập](examples/portable-node/README.md).

---

## Các package trong workspace

| Package | Mô tả |
| --- | --- |
| [`@bflow/cli`](apps/cli) | Giao diện dòng lệnh (`bflow`) cho vòng đời môi trường (`init`/`up`/`down`/`attach`/`status`/`doctor`), machine setup và kiểm tra provider/skills/tool, các lệnh SDLC cấp cao và quản lý workflow run |
| [`@bflow/runtime`](packages/runtime) | Dịch vụ điều phối cấp cao kết hợp engine, storage, registry, transport và gate |
| [`@bflow/core`](packages/core) | Workflow engine tất định thuần (lập lịch DAG, chuyển trạng thái, retry/rework, replay) |
| [`@bflow/contracts`](packages/contracts) | Zod schema dùng chung, public port interface và các validator transition/event |
| [`@bflow/agent-registry`](packages/agent-registry) | Registry role-to-agent lưu trên file, lease, fencing token và workflow template |
| [`@bflow/herdr-adapter`](packages/herdr-adapter) | `AgentTransport` dựa trên CLI; thương lượng protocol/schema không dùng allowlist phiên bản CLI |
| [`@bflow/persistence`](packages/persistence) | `RunStore` SQLite cho event batch nguyên tử, execution receipt và checkpoint |
| [`@bflow/artifact-store`](packages/artifact-store) | `ArtifactStore` trên filesystem với catalog SQLite và xác minh stream SHA-256 |
| [`@bflow/conversation`](packages/conversation) | Gateway của Conversation Agent (`chat`), phân loại intent, bộ dựng `DelegationRequest` có cấu trúc và cầu nối Herdr tới Coordinator (P14); việc kết hợp P19 host và ingress native-message đã xác thực có sẵn qua `@bflow/runtime`; việc chuyển giao AI thực tế cần được xác minh riêng |
| [`@bflow/specification`](packages/specification) | Phân loại specification thích ứng, xác thực, versioning, truy vết và chính sách phê duyệt (P15); việc kết hợp P19 host và ingress native-message đã xác thực có sẵn qua `@bflow/runtime`; việc chuyển giao AI thực tế cần được xác minh riêng |
| [`@bflow/test-strategy`](packages/test-strategy) | Chính sách TDD có điều kiện, ánh xạ criterion và kiểm tra bằng chứng Red/Green/refactor (P16); được thực thi bởi phần kết hợp P19 host đã triển khai |
| [`@bflow/verification`](packages/verification) | Xác minh task/workflow độc lập, bằng chứng criterion, kiểm tra Reviewer/QA, rework có giới hạn và escalation (P17); được P19 kết hợp với các host gate tin cậy và bằng chứng đã xác thực |
| [`@bflow/git-orchestrator`](packages/git-orchestrator) | Worktree tác vụ song song, kiểm tra quyền sở hữu, patch đã lưu, tích hợp theo thứ tự phụ thuộc có thể khôi phục, bàn giao xung đột, xác minh workflow và hỗ trợ PR của provider (P18); được P19 kết hợp; yêu cầu Linux/Git cục bộ |
| [`@bflow/pane-manager`](packages/pane-manager) | Quản lý workspace/tab/pane/agent của Herdr, ánh xạ role-to-pane, pane worktree Developer động và khôi phục sau khi restart (P13) |
| [`@bflow/agent-providers`](packages/agent-providers) | Khám phá Claude Code, Codex và Agy, quan sát health preflight/đã kích hoạt, biên dịch permission profile, launch profile và startup attestation có chữ ký (P25); được Runtime host kết hợp cho preflight/launch/activation (P30) |
| [`@bflow/machine-setup`](packages/machine-setup) | Backend machine setup: observe, plan, approve, apply và repair với private state, journal, receipt và doctor (P26); được `bflow setup` sử dụng |
| [`@bflow/tool-installer`](packages/tool-installer) | Cài đặt tool được pin phiên bản và xác minh checksum (RTK, GitNexus, MemPalace, provider plugin) cùng kiểm kê capability theo phạm vi (P26) |
| [`@bflow/mcp-gateway`](packages/mcp-gateway) | Registry dịch vụ MCP dùng chung, server Streamable HTTP loopback, bridge stdio-to-HTTP, thực thi chính sách chia sẻ/cô lập, exclusive resource lease với fencing token và các metric process/bộ nhớ/độ trễ (P27); Runtime đăng ký role client qua control endpoint đã xác thực (P30) |
| [`@bflow/mcp-services`](packages/mcp-services) | Trình quản lý dịch vụ OS theo user-session (`systemd --user`, `launchd`, Windows startup), pooling tài nguyên backend lazy/eager, giới hạn RSS bộ nhớ & process, và browser runtime Chrome riêng biệt, cô lập với page ownership gate (P27) |
| [`@bflow/skills`](packages/skills) | Catalog skill chỉ chứa hướng dẫn được pin phiên bản, role manifest, private storage và tham chiếu trung lập với provider (P28); setup synchronizer, CLI `skills sync` và manifest theo từng session của Runtime (P30) sử dụng nó |
| [`@bflow/quality-gates`](packages/quality-gates) | Bộ đánh giá lệnh preset, chính sách bảo mật workspace và quản trị RBAC |

---

## Phát triển & Kiểm thử

| Lệnh | Mô tả |
| --- | --- |
| `pnpm build` | Biên dịch mọi package trong workspace và CLI (`tsc -b`) |
| `pnpm lint` | Xác thực ranh giới dependency (`check:deps`) và kiểu TypeScript trên workspace & các suite E2E |
| `pnpm test` | Build các package và chạy mọi unit & integration test (Vitest) |
| `pnpm test:e2e` | Build các package và chạy test kịch bản end-to-end (`tests/e2e`) |
| `pnpm check` | Chạy kiểm tra dependency, typecheck và bộ test |

### Chạy test theo shard hoặc có mục tiêu

Các test subprocess và worker nạp module đã biên dịch từ `dist/`, nên hãy chạy `pnpm build` trước khi gọi trực tiếp `vitest`:

```bash
pnpm build

# Chạy unit test theo shard (ví dụ shard 1 trên 4)
pnpm exec vitest run --shard=1/4

# Chạy E2E test theo shard (ví dụ shard 1 trên 2)
pnpm exec vitest run --config tests/e2e/vitest.config.ts --shard=1/2

# Chạy test cho một package
pnpm exec vitest run packages/runtime/test

# Build và test Verification Engine P17 độc lập
pnpm --filter @bflow/verification test

# Chạy test Conversation Gateway
pnpm --filter @bflow/conversation test

# Chạy test Specification Engine
pnpm --filter @bflow/specification test

# Chạy test Conditional TDD Policy Engine
pnpm --filter @bflow/test-strategy test

# Chạy test Git Integration Engine (repository tạm thật và khôi phục SIGKILL)
pnpm --filter @bflow/git-orchestrator test

# Chạy test Provider Adapter, Machine Setup, Tool Installer và Skills
pnpm --filter @bflow/agent-providers test
pnpm --filter @bflow/machine-setup test
pnpm --filter @bflow/tool-installer test
pnpm --filter @bflow/skills test

# Chạy test Shared MCP Gateway
pnpm --filter @bflow/mcp-gateway test

# Chạy test OS Services & Dedicated Browser Runtime
pnpm --filter @bflow/mcp-services test
```

---

## Hạn chế đã biết

- P31 (nghiệm thu platform-v3) chưa được triển khai; bằng chứng cho P25–P30 chỉ là triển khai source cùng test cục bộ/fake-runner (không có lần chạy provider, Herdr hay Gateway backend thực tế).
- Nghiệm thu provider thực tế (Claude Code/Codex/Agy) và Agentic SDLC end-to-end đầy đủ chưa được xác minh; xem [release readiness](docs/release-readiness.md) và [known limitations](docs/known-limitations.md).

---

## Pipeline CI/CD

Các workflow GitHub Actions được cấu hình trong [`.github/workflows/`](.github/workflows):

- **CI ([`ci.yml`](.github/workflows/ci.yml))** — Chạy trên mọi push và pull request:
  1. **Lint & Build**: Xác thực ranh giới dependency giữa các package (`pnpm lint`), biên dịch mọi package (`pnpm build`) và tải lên các artifact `dist/` đã biên dịch.
  2. **Sharded Unit & Package Tests**: Chạy bộ unit/package test song song trên **4 shard** (`--shard=1/4` .. `4/4`).
  3. **Sharded E2E Scenarios**: Chạy bộ test end-to-end song song trên **2 shard** (`--shard=1/2` .. `2/2`).
- **CD ([`cd.yml`](.github/workflows/cd.yml))** — Kích hoạt khi có version tag (`v*`) hoặc dispatch thủ công:
  - Chạy xác minh lint và build, đóng gói mọi package workspace `@bflow/*` (`.tgz`), gộp archive phân phối đã biên dịch (`bflow-<tag>-dist.tar.gz`) cùng `SHA256SUMS.txt`, và xuất bản lên **GitHub Releases**.

---

## Tài liệu

- [Hướng dẫn người dùng (tiếng Việt)](docs/guide/README.md)
- [Tổng quan kiến trúc](docs/architecture.md)
- [Public Contract](docs/contracts.md)
- [Architecture Decision Record (ADR)](docs/adr)
- [Ví dụ & Runtime Demo](examples/README.md)
