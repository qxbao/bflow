# Bflow CLI Command Reference

Tài liệu tham chiếu lệnh điều phối workflow SDLC tự động dành cho agent, skill và operator là con người.

## Tổng quan các lệnh được hỗ trợ

Mọi lệnh liệt kê dưới đây tuân thủ `SupportedCommandsSchema` của `@bflow/skills` và cung cấp exit code có thể dự đoán, đầu ra JSON có cấu trúc (`--json`) cùng việc theo dõi operation ledger idempotent.

| Command | Syntax | Purpose | Reused Engines | Skills |
| --- | --- | --- | --- | --- |
| `config-migrate` | `bflow config-migrate [--json]` | Xác thực và migrate một config repository cũ sang file YAML chuẩn tắc, giữ lại bản sao lưu từng byte. | RepositoryIdentity, RepositoryConfigCodec | using-bflow |
| `help` | `bflow help [command] [options]` | Hiển thị cách dùng CLI toàn cục hoặc trợ giúp chi tiết cho một lệnh cụ thể. | HelpFormatter | using-bflow |
| `version` | `bflow version [options] / bflow --version / bflow -v` | Hiển thị phiên bản hiện tại và thông tin build của bflow CLI. | PackageMetadata | using-bflow |
| `init` | `bflow init [options]` | Khởi tạo cấu hình repository bflow và định nghĩa workflow mặc định tại thư mục gốc của repository. | RepositoryConfigService, DefaultWorkflowDefinition | using-bflow |
| `setup` | `bflow setup [options] | bflow setup --codex-hooks (--check|--plan|--apply)` | Review và phê duyệt tường minh các Codex global hook; chọn phê duyệt snapshot chính xác hoặc chính sách tin cậy mọi hook tường minh; không bao giờ chạy setup tool/service thông thường. | CodexHookInventory, CodexHookApprovalStore | using-bflow |
| `up` | `bflow up [options]` | Khởi động hoặc đối soát headless named session của repository và chờ các role pane bắt buộc. | PaneManager, EnvironmentDependencies, HerdrSessionAdapter | using-bflow |
| `down` | `bflow down [options]` | Checkpoint các workflow run đang hoạt động và dừng graceful named session của repository này. | PaneManager, RuntimeService, LifecycleLock | using-bflow |
| `attach` | `bflow attach [options]` | Attach terminal tương tác vào Conversation pane của session đang hoạt động. | PaneManager, HerdrSessionAdapter | using-bflow |
| `status` | `bflow status [run-id] [options]` | Truy vấn trạng thái môi trường hoặc kiểm tra trạng thái và lịch sử của các workflow run cụ thể. | EnvironmentService, RuntimeService | using-bflow |
| `doctor` | `bflow doctor [options]` | Chẩn đoán sức khỏe môi trường, tính toàn vẹn cấu hình, tích hợp Herdr và các phụ thuộc tool. | EnvironmentDoctor, ToolDependencyInspector, PaneManager | using-bflow |
| `recover` | `bflow recover --yes [options]` | Khôi phục từ các lifecycle lock cũ mà không sửa hay xóa state của dự án. | LifecycleLockRecovery, SessionManifestStore | using-bflow |
| `run` | `bflow run <requirement> [options]` | Bắt đầu một workflow run SDLC tự động mới cho một yêu cầu người dùng được chỉ định. | RuntimeService, WorkflowEngine, CoordinatorAgent | using-bflow |
| `approve` | `bflow approve <task-id> [options]` | Ghi lại quyết định approval, rejection hoặc changes_requested của con người cho một task gate đang chờ. | RuntimeService, QualityGates, HumanDecisionGate | using-bflow |
| `resume` | `bflow resume <run-id> [options]` | Tiếp tục một workflow run đang hoạt động hoặc đang chờ đã tạm dừng do chờ phê duyệt hoặc crash. | RuntimeService, WorkflowEngine | using-bflow |
| `cancel` | `bflow cancel <run-id> [options]` | Hủy một workflow run đang hoạt động hoặc một task cụ thể trong run. | RuntimeService, WorkflowEngine | using-bflow |
| `repo inspect` | `bflow repo inspect [options]` | Kiểm tra cấu trúc repository, quy ước, cấu hình và cây file để agent tiếp nhận. | RepositoryInspectionEngine, OperationLedger | inspect-repository, using-bflow |
| `task plan` | `bflow task plan [spec-path] [options]` | Phân rã một tài liệu specification thành task DAG workflow có thể thực thi, kèm acceptance criteria. | SpecificationEngine, PlannerAgent, OperationLedger | plan-tasks, using-bflow |
| `task implement` | `bflow task implement <task-id> [options]` | Thực thi việc triển khai một task trong worktree cô lập với việc thực thi conditional TDD. | DeveloperAgent, TestStrategyResolver, GitOrchestrator, OperationLedger | implement-task, conditional-tdd, using-bflow |
| `verify` | `bflow verify [task-id] [options]` | Thực thi verification cấp task hoặc cấp workflow theo acceptance criteria của specification. | VerificationEngine, QualityGates, OperationLedger | run-verification, conditional-tdd, using-bflow |
| `git prepare` | `bflow git prepare [options]` | Đối soát các nhánh Git, chuẩn bị tích hợp theo thứ tự phụ thuộc và xác thực worktree. | GitOrchestrator, OperationLedger | implement-task, using-bflow |
| `docs` | `bflow docs search <library> [options] | bflow docs lookup [<library>] --query <text> [options] | bflow docs status [options]` | Tra cứu tài liệu thư viện hiện hành, theo đúng phiên bản, qua dịch vụ Context7 của Gateway dùng chung; status báo liệu nó có truy cập được, đã xác thực và dùng được hay không. | DocsClient, McpGateway | use-context7, using-bflow |
| `mcp status` | `bflow mcp status [options]` | Kiểm tra trạng thái và health của các dịch vụ và bridge Model Context Protocol (MCP) đã đăng ký. | McpGateway, OperationLedger | use-gitnexus, use-mempalace, browser-inspection, using-bflow |
| `tool status` | `bflow tool status [options] / bflow tools status [options]` | Kiểm tra tính khả dụng, phiên bản và health của các tool machine và repo được pin (ví dụ RTK). | ToolInstaller, OperationLedger | use-rtk, using-bflow |
| `tools status` | `bflow tools status [options]` | Alias của 'bflow tool status'. Kiểm tra tính khả dụng và health của các tool được pin. | ToolInstaller, OperationLedger | use-rtk, using-bflow |
| `skills sync` | `bflow skills sync [options]` | Đồng bộ các skill đã duyệt từ catalog sang môi trường lưu trữ của agent provider. | SkillManager, OperationLedger | using-bflow |
| `skills list` | `bflow skills list [options]` | Liệt kê các skill khả dụng từ catalog mà không đồng bộ chúng. | SkillManager, OperationLedger | using-bflow |
| `agent check` | `bflow agent check [provider] [options]` | Kiểm tra provider readiness và activated health theo các platform contract. | AgentProviderRegistry, OperationLedger | using-bflow |

## Đặc tả chi tiết từng lệnh

### `bflow config-migrate`

- **Syntax**: `bflow config-migrate [--json]`
- **Purpose**: Xác thực và migrate một config repository cũ sang file YAML chuẩn tắc, giữ lại bản sao lưu từng byte.
- **Reused Engines**: `RepositoryIdentity`, `RepositoryConfigCodec`
- **Required Flags**: None
- **Optional Flags**: `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent khi đích chuẩn tắc khớp với bản sao lưu migration. Các config xung đột hoặc đã bị sửa được để nguyên.
- **Permission Requirements**: Yêu cầu quyền truy cập filesystem cục bộ vào thư mục .bflow của repository.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow help`

- **Syntax**: `bflow help [command] [options]`
- **Purpose**: Hiển thị cách dùng CLI toàn cục hoặc trợ giúp chi tiết cho một lệnh cụ thể.
- **Reused Engines**: `HelpFormatter`
- **Required Flags**: None
- **Optional Flags**: `-j, --json`
- **Idempotency & Retry**: Chỉ đọc, hoàn toàn tất định. An toàn khi gọi lặp lại mà không thay đổi state.
- **Permission Requirements**: Không có. Khả dụng cho mọi actor trong mọi môi trường.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow version`

- **Syntax**: `bflow version [options] / bflow --version / bflow -v`
- **Purpose**: Hiển thị phiên bản hiện tại và thông tin build của bflow CLI.
- **Reused Engines**: `PackageMetadata`
- **Required Flags**: None
- **Optional Flags**: `-j, --json`
- **Idempotency & Retry**: Chỉ đọc. An toàn khi gọi lặp lại mà không thay đổi state.
- **Permission Requirements**: Không có. Khả dụng cho mọi actor.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow init`

- **Syntax**: `bflow init [options]`
- **Purpose**: Khởi tạo cấu hình repository bflow và định nghĩa workflow mặc định tại thư mục gốc của repository, sau đó index repository bằng GitNexus và đăng ký service của nó trên Gateway của máy sau khi license được chấp thuận.
- **Reused Engines**: `RepositoryConfigService`, `DefaultWorkflowDefinition`
- **Required Flags**: None
- **Optional Flags**: `--dir <path>`, `--config <path>`, `--name <name>`, `--provider <claude|codex|agy>`, `-f, --force`, `-y, --yes`, `-u, --update`, `--check`, `--remove`, `--no-gitnexus`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent. Chạy lại không có --force hoặc --update sẽ xác minh cấu hình hiện có mà không sửa nó. Lần index GitNexus đầu tiên hỏi xác nhận; khi không tương tác cần --yes. --check chỉ đọc; --remove cũng gỡ được repository đã bị xoá khỏi đĩa.
- **Permission Requirements**: Yêu cầu quyền ghi filesystem vào thư mục repository.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow setup`

- **Syntax**: `bflow setup [options] | bflow setup --codex-hooks (--check|--plan|--apply)`
- **Purpose**: Review và phê duyệt tường minh các Codex global hook; chọn phê duyệt snapshot chính xác hoặc chính sách tin cậy mọi hook tường minh; không bao giờ chạy setup tool/service thông thường.
- **Reused Engines**: `CodexHookInventory`, `CodexHookApprovalStore`
- **Required Flags**: None
- **Optional Flags**: `--check`, `--dry-run, --plan`, `--apply`, `--yes`, `--codex-hooks`, `--hook-digest <sha256>`, `--trust-all`, `--revoke-trust-all`, `--dir <path>`, `--catalog-dir <path>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Việc kiểm tra chỉ đọc. Phê duyệt snapshot gắn với digest đã review. --trust-all tường minh tin cậy các hook hiện tại/tương lai của Codex home đã chọn cho đến khi --revoke-trust-all.
- **Permission Requirements**: Approval store là riêng tư và thuộc sở hữu người dùng. Chỉ đường apply Codex hook tường minh mới được ghi trạng thái phê duyệt hook.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow up`

- **Syntax**: `bflow up [options]`
- **Purpose**: Khởi động hoặc đối soát headless named session của repository và chờ các role pane bắt buộc.
- **Reused Engines**: `PaneManager`, `EnvironmentDependencies`, `HerdrSessionAdapter`
- **Required Flags**: None
- **Optional Flags**: `--timeout <ms>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent. Kết nối lại với session khỏe mạnh hiện có hoặc đối soát các pane bị thiếu.
- **Permission Requirements**: Yêu cầu quyền thực thi process cục bộ và quyền truy cập Herdr runtime.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow down`

- **Syntax**: `bflow down [options]`
- **Purpose**: Checkpoint các workflow run đang hoạt động và dừng graceful named session của repository này.
- **Reused Engines**: `PaneManager`, `RuntimeService`, `LifecycleLock`
- **Required Flags**: None
- **Optional Flags**: `-y, --yes`, `--timeout <ms>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent. Chỉ dừng an toàn named session do mình sở hữu; no-op nếu session đã dừng.
- **Permission Requirements**: Yêu cầu sở hữu lifecycle lock của repository.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow attach`

- **Syntax**: `bflow attach [options]`
- **Purpose**: Attach terminal tương tác vào Conversation pane của session đang hoạt động.
- **Reused Engines**: `PaneManager`, `HerdrSessionAdapter`
- **Required Flags**: None
- **Optional Flags**: `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Kết nối tương tác. Có thể attach lại bất cứ khi nào session đang chạy.
- **Permission Requirements**: Yêu cầu terminal TTY tương tác và session repository đang hoạt động.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow status`

- **Syntax**: `bflow status [run-id] [options]`
- **Purpose**: Truy vấn trạng thái môi trường hoặc kiểm tra trạng thái và lịch sử của các workflow run cụ thể.
- **Reused Engines**: `EnvironmentService`, `RuntimeService`
- **Required Flags**: None
- **Optional Flags**: `--status <filter>`, `--workflow-id <id>`, `--limit <n>`, `--cursor <c>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Truy vấn chỉ đọc. An toàn khi thực thi bất cứ lúc nào.
- **Permission Requirements**: Không có. Cho phép kiểm tra status công khai.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow doctor`

- **Syntax**: `bflow doctor [options]`
- **Purpose**: Chẩn đoán sức khỏe môi trường, tính toàn vẹn cấu hình, tích hợp Herdr và các phụ thuộc tool.
- **Reused Engines**: `EnvironmentDoctor`, `ToolDependencyInspector`, `PaneManager`
- **Required Flags**: None
- **Optional Flags**: `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Chẩn đoán chỉ đọc. An toàn khi chạy lặp lại.
- **Permission Requirements**: Quyền đọc cấu hình repository và các tool hệ thống.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow recover`

- **Syntax**: `bflow recover --yes [options]`
- **Purpose**: Khôi phục từ các lifecycle lock cũ mà không sửa hay xóa state của dự án.
- **Reused Engines**: `LifecycleLockRecovery`, `SessionManifestStore`
- **Required Flags**: `-y, --yes`
- **Optional Flags**: `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent. Thu hồi các lock file mồ côi sau khi xác minh process đã chết.
- **Permission Requirements**: Yêu cầu operator xác nhận tường minh (--yes) và quyền ghi lock của repository.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow run`

- **Syntax**: `bflow run <requirement> [options]`
- **Purpose**: Bắt đầu một workflow run SDLC tự động mới cho một yêu cầu người dùng được chỉ định.
- **Reused Engines**: `RuntimeService`, `WorkflowEngine`, `CoordinatorAgent`
- **Required Flags**: `<requirement>`
- **Optional Flags**: `--run-id <id>`, `-w, --workflow <path>`, `--config <path>`, `--idempotency-key <key>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent khi có --idempotency-key; trả về run record hiện có nếu key khớp.
- **Permission Requirements**: Quyền operator. Khởi tạo việc điều phối agent tự động chạy nền.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow approve`

- **Syntax**: `bflow approve <task-id> [options]`
- **Purpose**: Ghi lại quyết định approval, rejection hoặc changes_requested của con người cho một task gate đang chờ.
- **Reused Engines**: `RuntimeService`, `QualityGates`, `HumanDecisionGate`
- **Required Flags**: `<task-id>`
- **Optional Flags**: `--run, --run-id <id>`, `--by, --actor <actor>`, `--decision <decision>`, `--reason <text>`, `--approval-id <id>`, `--revision <n>`, `--generation <n>`, `--idempotency-key <key>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent theo idempotency key. Các quyết định đã bị thay thế bị từ chối với lỗi conflict.
- **Permission Requirements**: Chỉ operator là con người. Actor phải đủ điều kiện là người phê duyệt.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow resume`

- **Syntax**: `bflow resume <run-id> [options]`
- **Purpose**: Tiếp tục một workflow run đang hoạt động hoặc đang chờ đã tạm dừng do chờ phê duyệt hoặc crash.
- **Reused Engines**: `RuntimeService`, `WorkflowEngine`
- **Required Flags**: `<run-id>`
- **Optional Flags**: `--idempotency-key <key>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent. An toàn để retry nếu có lỗi tạm thời trong lúc resume.
- **Permission Requirements**: Quyền operator.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow cancel`

- **Syntax**: `bflow cancel <run-id> [options]`
- **Purpose**: Hủy một workflow run đang hoạt động hoặc một task cụ thể trong run.
- **Reused Engines**: `RuntimeService`, `WorkflowEngine`
- **Required Flags**: `<run-id>`
- **Optional Flags**: `--reason <text>`, `--by, --requested-by <actor>`, `--task, --task-id <id>`, `--expected-version <n>`, `--idempotency-key <key>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent. Hủy một run đã bị hủy vẫn thành công trọn vẹn.
- **Permission Requirements**: Quyền operator.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow repo inspect`

- **Syntax**: `bflow repo inspect [options]`
- **Purpose**: Kiểm tra cấu trúc repository, quy ước, cấu hình và cây file để agent tiếp nhận.
- **Reused Engines**: `RepositoryInspectionEngine`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--dir <path>`, `--include-files`, `--max-files <n>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Kiểm tra chỉ đọc được ghi vào OperationLedger. Hỗ trợ --resume từ bước trước.
- **Permission Requirements**: Yêu cầu quyền đọc repository đích.
- **Associated Skills**: `inspect-repository`, `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow task plan`

- **Syntax**: `bflow task plan [spec-path] [options]`
- **Purpose**: Phân rã một tài liệu specification thành task DAG workflow có thể thực thi, kèm acceptance criteria.
- **Reused Engines**: `SpecificationEngine`, `PlannerAgent`, `OperationLedger`
- **Required Flags**: `--spec <path> (or positional [spec-path])`
- **Optional Flags**: `-w, --workflow <path>`, `--run-id <id>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Tái dùng plan receipt đã cache khi có idempotency key khớp.
- **Permission Requirements**: Role Planner hoặc operator. Quyền đọc specification.
- **Associated Skills**: `plan-tasks`, `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow task implement`

- **Syntax**: `bflow task implement <task-id> [options]`
- **Purpose**: Thực thi việc triển khai một task trong worktree cô lập với việc thực thi conditional TDD.
- **Reused Engines**: `DeveloperAgent`, `TestStrategyResolver`, `GitOrchestrator`, `OperationLedger`
- **Required Flags**: `<task-id>`, `--run-id <id>`
- **Optional Flags**: `--spec <path>`, `-w, --workflow <path>`, `--attempt-id <id>`, `--base-revision <sha>`, `--owned-path <path>`, `--forbidden-path <path>`, `--developer-id <id>`, `--require-red-evidence`, `--target-branch <branch>`, `--environment <env>`, `--auto-approve`, `--approved-by <actor>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Hỗ trợ resume xuyên qua các vòng rework có giới hạn thông qua attemptId và các bước OperationLedger.
- **Permission Requirements**: Developer agent thực thi trong worktree được chỉ định. Quyền sửa đường dẫn có giới hạn.
- **Associated Skills**: `implement-task`, `conditional-tdd`, `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow verify`

- **Syntax**: `bflow verify [task-id] [options]`
- **Purpose**: Thực thi verification cấp task hoặc cấp workflow theo acceptance criteria của specification.
- **Reused Engines**: `VerificationEngine`, `QualityGates`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--run-id <id>`, `--task-id <id>`, `--scope <task|workflow>`, `--spec <path>`, `--plan <path>`, `--change-set <path>`, `--cycle <path>`, `--max-iterations <n>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Tạo các VerificationResult receipt có thể xác minh. Số vòng rework tối đa có giới hạn (mặc định: 3).
- **Permission Requirements**: Role Verifier/Tester. Các kiểm tra chỉ đọc trong sandbox thực thi test.
- **Associated Skills**: `run-verification`, `conditional-tdd`, `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow git prepare`

- **Syntax**: `bflow git prepare [options]`
- **Purpose**: Đối soát các nhánh Git, chuẩn bị tích hợp theo thứ tự phụ thuộc và xác thực worktree.
- **Reused Engines**: `GitOrchestrator`, `OperationLedger`
- **Required Flags**: `--run-id <id>`
- **Optional Flags**: `--integration-id <id>`, `--base-revision <sha>`, `--task <taskKey[:deps]>`, `--target-branch <branch>`, `--environment <env>`, `--auto-approve`, `--approved-by <actor>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Chuẩn bị nhánh nguyên tử và merge dry-run. Idempotent theo integration receipt.
- **Permission Requirements**: Quyền quản lý nhánh của Git repository.
- **Associated Skills**: `implement-task`, `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow docs`

- **Syntax**: `bflow docs search <library> [options] | bflow docs lookup [<library>] --query <text> [options] | bflow docs status [options]`
- **Purpose**: Tra cứu tài liệu thư viện hiện hành, theo đúng phiên bản, qua dịch vụ Context7 của Gateway dùng chung; status báo liệu nó có truy cập được, đã xác thực và dùng được hay không.
- **Reused Engines**: `DocsClient`, `McpGateway`
- **Required Flags**: `--query <text> (lookup)`
- **Optional Flags**: `--library-id <id>`, `--version <version>`, `--language <name>`, `--no-cache`, `--role <role>`, `--timeout <ms>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Chỉ đọc và an toàn khi lặp lại. Các lỗi tạm thời (network, timeout, rate limit) chỉ được Gateway retry cho các lệnh gọi chỉ đọc; kết quả có thể được phục vụ từ một cache cục bộ tùy chọn.
- **Permission Requirements**: Cần một Gateway registration cấp quyền cho dịch vụ context7. Bên trong một agent pane dùng registration của chính agent; operator bên ngoài pane hoạt động dưới role cho bởi --role. Các truy vấn được gửi tới dịch vụ Context7 được host.
- **Associated Skills**: `use-context7`, `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow mcp status`

- **Syntax**: `bflow mcp status [options]`
- **Purpose**: Kiểm tra trạng thái và health của các dịch vụ và bridge Model Context Protocol (MCP) đã đăng ký.
- **Reused Engines**: `McpGateway`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--service <id>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Probe chỉ đọc. An toàn khi thực thi định kỳ mà không có side effect.
- **Permission Requirements**: Quyền kiểm tra MCP gateway.
- **Associated Skills**: `use-gitnexus`, `use-mempalace`, `browser-inspection`, `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow tool status`

- **Syntax**: `bflow tool status [options] / bflow tools status [options]`
- **Purpose**: Kiểm tra tính khả dụng, phiên bản và health của các tool machine và repo được pin (ví dụ RTK).
- **Reused Engines**: `ToolInstaller`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--tool <id>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Probe status chỉ đọc. An toàn khi thực thi lặp lại.
- **Permission Requirements**: Quyền đọc tool registry.
- **Associated Skills**: `use-rtk`, `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow tools status`

- **Syntax**: `bflow tools status [options]`
- **Purpose**: Alias của 'bflow tool status'. Kiểm tra tính khả dụng và health của các tool được pin.
- **Reused Engines**: `ToolInstaller`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--tool <id>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Probe status chỉ đọc.
- **Permission Requirements**: Quyền đọc tool registry.
- **Associated Skills**: `use-rtk`, `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow skills sync`

- **Syntax**: `bflow skills sync [options]`
- **Purpose**: Đồng bộ các skill đã duyệt từ catalog sang môi trường lưu trữ của agent provider.
- **Reused Engines**: `SkillManager`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--list`, `--provider <claude|codex|agy>`, `--manifest-id <id>`, `--environment-id <id>`, `--catalog-dir <path>`, `--store-dir <path>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Đồng bộ idempotent dựa trên digest của skill manifest. Receipt được tái dùng tránh các lần ghi đĩa thừa.
- **Permission Requirements**: Quyền ghi thư mục skill.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow skills list`

- **Syntax**: `bflow skills list [options]`
- **Purpose**: Liệt kê các skill khả dụng từ catalog mà không đồng bộ chúng.
- **Reused Engines**: `SkillManager`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--provider <claude|codex|agy>`, `--manifest-id <id>`, `--environment-id <id>`, `--catalog-dir <path>`, `--store-dir <path>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Liệt kê chỉ đọc. An toàn khi gọi bất cứ lúc nào.
- **Permission Requirements**: Không có.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.

### `bflow agent check`

- **Syntax**: `bflow agent check [provider] [options]`
- **Purpose**: Kiểm tra provider readiness và activated health theo các platform contract.
- **Reused Engines**: `AgentProviderRegistry`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--provider <claude|codex|agy>`, `--stage <preflight|activated>`, `--environment-id <id>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Health probe. An toàn khi thực thi định kỳ mà không thay đổi state.
- **Permission Requirements**: Quyền thực thi probe provider.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Lệnh thành công, không có lỗi.
  - `1`: Lỗi runtime hoặc lỗi thực thi.
  - `2`: Lỗi xác thực tham số hoặc tùy chọn CLI.
