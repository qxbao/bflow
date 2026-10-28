# Tham chiếu lệnh cấp cao của Bflow

Các lệnh ổn định, theo mục tiêu, dành cho các Agentic SDLC agent và các skill hướng dẫn chúng. Agent
nêu mục tiêu của mình bằng cách chọn một lệnh; lệnh đó kết hợp các engine hiện có thay vì
để agent tự nối các bước Git, specification, TDD, verification, tool và provider bằng tay.

Bản đọc được bằng máy của trang này là [`command-reference.json`](command-reference.json).
Nó được sinh từ cùng các spec mà parser áp dụng; một unit test sẽ fail khi chúng lệch nhau.
Tác giả skill (SkillManager / P28) nên render skill từ file JSON và liên kết tới trang này.

| Mục tiêu | Lệnh | Tái sử dụng |
| --- | --- | --- |
| Hiểu repository | `bflow repo inspect` | truy vấn Git chỉ đọc |
| Tạo/kiểm tra task graph | `bflow task plan --spec <file>` | Specification Engine (P15) traceability |
| Bắt đầu làm một task | `bflow task implement <task-id> --run <run-id> --spec <file>` | kiểm tra artifact P15, Conditional TDD Resolver (P16), Git Orchestrator (P18), Runtime run state |
| Xác minh một task | `bflow verify <task-id> --run <run-id> --plan <file>` | Verification Engine (P17), ArtifactStore, các gate độc lập được inject |
| Chuẩn bị integration | `bflow git prepare <run-id>` | Git Orchestrator (P18) integration |
| Inventory MCP | `bflow mcp status` | `mcp.json`/pins; live Gateway port cần được inject, binary mặc định chưa nối |
| Sức khỏe tool | `bflow tool status` | Machine setup (P26) catalog/probe tool |
| Đồng bộ skill | `bflow skills sync` | Machine setup (P26) `SkillsComponent` + skill manager port (P28) |
| Mức sẵn sàng của provider | `bflow agent check <provider>` | Agent Provider Registry (P25) |
| Xuất gói bàn giao offline | `bflow handover export --run <id> --revision <commit> --out <dir>` | AgenticJournal (chỉ đọc), ArtifactStore integrity reads |

## Hợp đồng gọi lệnh

Luôn truyền `--json`. Mọi lệnh được nhận diện đều ghi đúng một tài liệu JSON ra **stdout**,
dù thành công hay thất bại, và thoát với mã nằm trong tài liệu đó:

```json
{
  "ok": false,
  "command": "task.implement",
  "exitCode": 4,
  "result": {
    "schemaVersion": 3,
    "commandId": "cmd-…",
    "correlationId": "corr-…",
    "status": "failed",
    "runId": "run-1",
    "output": {
      "schemaVersion": 1,
      "command": "task.implement",
      "outcome": "failed",
      "ids": { "runId": "run-1", "taskId": "ghost" },
      "replayed": false,
      "steps": [{ "id": "load-specification", "status": "succeeded" }, { "id": "resolve-task", "status": "failed", "message": "…" }],
      "data": null
    },
    "artifacts": [],
    "error": { "code": "not_found", "retryable": false, "message": "…", "details": { "reason": "task_not_found" } },
    "observedAt": "2026-10-17T05:00:00.000Z"
  }
}
```

- `result` là một `CommandExecutionResult` từ `@bflow/contracts` (xác thực bằng
  `CommandExecutionResultSchema`); CLI export `HighLevelEnvelopeSchema` cho toàn bộ tài liệu.
- `result.status` là trạng thái của **lệnh** (`succeeded`, `failed`, `waiting_user`, `unknown`).
  `output.outcome` là **kết luận theo domain** (`ready`, `not_passed`, …). `succeeded` không bao giờ có nghĩa
  một task hay run đã thành công; chỉ Runtime/Quality Gates mới quyết định điều đó.
- `output.steps` liệt kê mọi bước theo thứ tự với `succeeded | failed | skipped | blocked | reused`,
  nên một lỗi ở giữa chừng cho thấy chính xác những bước nào đã hoàn tất.
- ID: `commandId` mới cho mỗi lần gọi; `correlationId` lấy từ `--correlation-id`,
  rồi `BFLOW_CORRELATION_ID`, nếu không thì được sinh; `runId`/`taskId`/`idempotencyKey` nằm trong `output.ids`.
- Một subcommand không xác định (không nhận diện được lệnh nào) ghi `{ "ok": false, "error": … }` ra
  stderr và thoát với mã 2. `--help` kèm `--json` in `{ "ok": true, "command": "help", "data": { "helpText" } }`.

### Exit code

| Mã | Tên | Ý nghĩa / hành động của agent |
| --- | --- | --- |
| 0 | SUCCESS | Hoàn tất; ready; passed |
| 1 | FAILED | Thao tác thất bại; đọc `error` và bước bị lỗi |
| 2 | USAGE | Tham số không hợp lệ; sửa lại lệnh gọi |
| 3 | NOT_READY | Chạy đúng nhưng kết luận âm tính (not ready, not passed, conflict, spec chưa được duyệt) |
| 4 | NOT_FOUND | Không tìm thấy task, run, file, tool, service hoặc repository |
| 5 | PERMISSION_REQUIRED | Bước rủi ro cần cờ tường minh hoặc phê duyệt (`error.details.permission` hoặc `status: waiting_user`) |
| 6 | CONFLICT | Gọi đồng thời (`details.reason: busy`) hoặc idempotency key bị dùng lại cho request khác; thử lại sau |
| 7 | UNKNOWN_STATE | Lần gọi trước bị gián đoạn; kiểm tra, rồi chạy lại với `--resume` |

### Idempotency, retry và resume

Các lệnh có thay đổi trạng thái ghi một receipt dưới `.bflow/state/cli/commands/` theo một
idempotency key tất định (ghi đè bằng `--idempotency-key`). Thư mục đó phải được Git-ignore
(`bflow init` cài `.bflow/.gitignore`); nếu không, lệnh fail trước khi ghi.
`skills sync` có phạm vi machine: không cần repository và giữ receipt trong
`$XDG_STATE_HOME/bflow/cli/commands/` (mặc định `~/.local/state/bflow/cli/commands/`).

- **Receipt đã hoàn tất**: cùng một request sẽ phát lại kết quả đã lưu (`replayed: true`, bước đầu
  là `idempotent-replay`) và không lặp lại side effect nào. `task implement` vẫn quan sát lại trạng thái.
- **Cùng key, request khác**: exit 6, `details.reason: idempotency_key_reuse`.
- **Gọi đồng thời cùng một key**: một lần chạy; các lần còn lại exit 6 với `reason: busy`.
  `verify` còn giữ thêm một lock cho mỗi run/task, nên các lần verify đồng thời của cùng một task
  với change set khác nhau cũng exit 6 thay vì ghi đè verification cycle của nhau.
- **Receipt thất bại**: chạy lại sẽ thực thi lại; các engine tự đối soát trạng thái dở dang của mình.
- **Receipt bị gián đoạn** (process chết giữa lệnh): các lệnh `read_only`/`retry_safe` chạy lại.
  Các lệnh `resume_required` exit 7 với `error.code: unknown_delivery` và bước cuối cùng; chúng
  không bao giờ lặp lại side effect một cách mù quáng. `--resume` đối soát qua đường idempotent của engine
  (đối soát request giống hệt của P18, quan sát lại skill trước khi ghi).

Các cờ điều khiển (`--json`, `--yes`, `--resume`, `--force`, `--allow-machine-scope`) không thuộc
request digest, nên việc cấp quyền khi retry vẫn dùng lại cùng key.

### Quy tắc quyền và an toàn

- Không lệnh nào dispatch agent, gửi message Herdr, phê duyệt gate, merge vào nhánh
  protected/main, push, mở pull request hay deploy. Các Runtime message do engine
  tạo ra được trả trong `data.pendingMessages` để Runtime chuyển giao.
- Các bước rủi ro dừng trước khi thực thi và exit 5 cho đến khi operator cấp quyền:
  `git prepare --yes`, `task plan --force` (thay thế một plan khác),
  `skills sync --allow-machine-scope` (đích phạm vi toàn machine).
- `repo inspect`, `mcp status`, `tool status` không cài tool hoặc start/stop worker.
  `agent check` không mở Herdr role pane nhưng adapter có thể chạy native auth/model execution probe,
  tiêu hao usage và tạo probe state; không gọi nó là phép kiểm tra không inference hoặc không ghi tuyệt đối.

## Các lệnh

### `bflow repo inspect`

Chỉ đọc: root/ID của repository, branch, HEAD, upstream, các mục dirty, merge/rebase đang diễn ra,
worktree (kèm cờ do Bflow quản lý), remote, project marker, package manager, script,
workspace package, context file (`AGENTS.md`, `CLAUDE.md`, …) và các plan `.bflow`.
Outcome `inspected`; exit 4 khi ở ngoài một Git repository.

### `bflow task plan --spec <file> [--workflow <file> | --write [--out <file>] [--force]]`

- Với `--workflow`: kiểm tra workflow theo traceability P15 của specification
  (`orphanCriterionIds`, `unmappedWorkflowTaskIds`, `unknownMappedTaskIds`). Outcome `checked`;
  exit 3 khi traceability không hợp lệ.
- Nếu không, suy ra một task graph: một task `developer` cho mỗi task ID được truy vết, criterion theo ID,
  **không suy ra dependency** (Coordinator khai báo thứ tự). Outcome `preview`; với
  `--write` lưu `.bflow/plans/<spec-id>.workflow.json` (outcome `planned`). Nội dung giống hệt
  là no-op (`unchanged: true`); nội dung khác cần `--force` (nếu không thì exit 5). Nội dung file
  hiện tại là một phần của request, nên một plan bị sửa sau khi ghi sẽ được đánh giá lại thay vì
  bị che sau một receipt được phát lại.
- `--out` phải resolve vào trong repository: `..`, file đích là symlink hoặc thư mục cha
  resolve ra ngoài root đều bị từ chối (exit 1, `reason: path_outside_repository`).
- Specification không hợp lệ: exit 1 (`reason: invalid_specification`); thiếu file: exit 4.

### `bflow task implement <task-id> --run <run-id> --spec <file>`

Options: `--workflow <file>`, `--base <rev>` (HEAD), `--attempt <id>` (attempt-1),
`--developer <id>` (developer-1), `--owned-path <path>`… (mặc định: `affectedPaths` của spec; glob
phải được thay bằng đường dẫn nguyên văn), `--forbidden-path <path>`…, `--artifact-root <dir>`,
`--artifact-store-id <id>`, `--resume`.

Các bước: `load-specification` → `check-approval` (đã duyệt + có artifact đã lưu, nếu không exit 3) →
`check-run-binding` → `resolve-task` (exit 4 khi không được truy vết) → `resolve-tdd-policy` →
`build-context` → `open-resources` → `verify-specification-artifact` (digest/kích thước/nội dung của
artifact đã lưu) → `prepare-worktree` (task worktree + branch của P18) → `prepare-assignment` →
`observe-execution`.

`data.assignment` là một `developer_assignment_request` với `status: awaiting_runtime_dispatch`:
worktree, branch, base commit, spec ID/version/digest, TDD (`mode`, `requiresFailingTestFirst`,
target command, test level), các acceptance criterion của task và các đường dẫn owned/forbidden. Việc
cấp `AgentAssignment` có lease (lease + fencing token) chỉ do Runtime thực hiện thông qua
Coordinator. Khi `tdd.requiresFailingTestFirst` là true, Developer phải tuân theo
Red-Green-Refactor. `observe-execution` báo cáo Git task record và trạng thái task của Runtime;
Herdr `done` không bao giờ được coi là thành công. Chạy lại cùng lệnh để làm mới quan sát.

### `bflow verify <task-id> --run <run-id> --plan <file>`

`--plan` là đầu vào `createVerificationPlan` của P17 (run, task, scope, specification đã duyệt,
strategy, check, implementer ID, `maxIterations`). Tùy chọn: `--change-set <file>` (một
`GitChangeSet`; mặc định thu thập worktree do `task implement` chuẩn bị), `--repair <file>`
(repair record cho một vòng rework), `--integration <file>` (`{ headCommitHash,
integratedTaskIds }` cho workflow scope, ví dụ từ `git prepare`), `--artifact-root`,
`--artifact-store-id`.

Trả về `data.verification` (`VerificationResult`), `data.cycle` (trạng thái cycle có giới hạn và
iteration) và `data.pendingMessages`. Các evidence reference nằm trong `result.artifacts`. Exit 0
chỉ với `passed`; `failed`, `inconclusive`, `blocked` và `escalated` exit 3. Một check không có
independent runner được cấu hình sẽ cho `blocked`, không bao giờ `passed`. Cùng một thay đổi sẽ phát lại
receipt; một thay đổi hoặc repair mới chạy một iteration mới cho đến `maxIterations`, rồi escalate.

### `bflow git prepare <run-id>`

Tùy chọn: `--task <task-id>`… (mặc định: mọi task đã chuẩn bị của run), `--workflow <file>`
(thứ tự dependency), `--integration-id <id>` (integration-1), `--base <rev>` (HEAD), `--yes`,
`--resume`, `--artifact-root`, `--artifact-store-id`.

Không có `--yes`: kiểm tra chỉ đọc từng task worktree (active, clean, có commit vượt base);
exit 5 với `status: waiting_user` và bản xem trước integration. Worktree chưa commit/rỗng exit 3
(`reason: worktree_not_ready`). Với `--yes` (sau khi mọi Developer đã nhả quyền ghi):
thu thập submission, tạo nhánh riêng `integration/bflow/<run>/<id>`, merge theo
thứ tự dependency và trả về `data.integration` cùng `data.workflowVerification` (required,
request ID, và đầu vào `integration` cho `bflow verify`). Merge conflict exit 3 với
outcome `conflict_detected` cùng các đường dẫn xung đột; việc giải quyết thuộc về Coordinator.

### `bflow mcp status [--service <id>]…`

Đọc `$XDG_CONFIG_HOME/bflow/mcp.json`, kiểm tra các stdio executable được pin (sự hiện diện + digest)
và, **khi caller inject `HighLevelServices.mcpGateway`**, hỏi Gateway về health backend. Binary mặc định chưa inject port này, nên báo `configured: false`/`not_ready` dù machine daemon có thể đang chạy. Dùng `doctor`, machine service status và `docs status` (Context7) để chẩn đoán; không lặp setup chỉ vì nhãn này. Exit 0 chỉ khi Gateway truy cập được
và mọi backend được chọn đều healthy; chưa cấu hình Gateway, config không hợp lệ hoặc backend
unhealthy thì exit 3; `--service` không xác định thì exit 4.

### `bflow tool status [--tool <id>]…`

Probe catalog gồm `node`, `pnpm`, `git`, `herdr`, `claude`, `codex`, `agy` và các integrated CLI tools (`rtk`, `gitnexus`, `chrome-devtools-mcp`, `mempalace`): trạng thái (`present`, `missing`,
`version_mismatch`, `path_missing`, …), phiên bản so với yêu cầu, đường dẫn, binary digest và hướng dẫn
khắc phục thủ công. Các tool bắt buộc là mặc định của catalog, hoặc mọi `--tool` được cung cấp. Exit 3 liệt kê
`data.blocking`; tool không xác định thì exit 4. Việc cài đặt là của `bflow setup`, không bao giờ của lệnh này.

### `bflow skills sync [--provider claude|codex|agy]… [--dry-run] [--allow-machine-scope] [--resume]`

Quan sát các skill đã cài, resolve trạng thái mong muốn được pin và chỉ ghi khi chúng khác nhau
(nếu không là `already_synced`). `--dry-run` xem trước, không publish bundle mới; default synchronizer vẫn có thể tạo/chmod thư mục kho riêng khi khởi tạo. Binary chưa nhận `skills list` hoặc `skills sync --list`. Đích phạm vi toàn machine cần
`--allow-machine-scope` (exit 5). Sau khi ghi, một post-check phải quan sát được digest mong muốn, nếu không
lệnh fail (`reason: sync_not_converged`). Khi chưa tích hợp skill manager, lệnh fail
với `reason: skills_synchronizer_not_configured` (exit 1).

### `bflow skills scan --source <path>… [--role <role>]… [--provider <id>]… [--version <v>] [--name <id>]`

Chỉ đọc đúng nguồn được chọn (thư mục skill/`SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`,
`*.mdc`, `.cursor/rules`) và trả về inventory (origin, kind, digest, resource, tham chiếu dependency/tool/MCP/hook,
cảnh báo, nhóm trùng lặp) cùng proposal role. Không ghi gì; exit 0 kể cả khi có nguồn bị chặn.

### `bflow skills import --source <path>… [--depends-on <id>]… [--dry-run]` (cùng các option của scan)

Chuyển đổi và validate bundle instruction-only, stage tại `.bflow/skills/imports/<id>/<version>/`
(`bundle/`, `original/`, `report.json`). Nguồn bị chặn (secret, symlink, traversal, quá cỡ, provenance giả)
→ exit 3, không ghi gì. Không cài/chạy hook hay MCP. Bundle staged chưa dùng được cho tới khi duyệt.

### `bflow skills approve <skill-id> --digest <sha256> [--version <v>] [--expires-in-days <n>] [--approve]`

Kiểm digest đã review, dependency pin, role/provider và scope repository/session. Thiếu `--approve` → exit 5,
chỉ in grant. Digest khác, dependency conflict hoặc provider không hỗ trợ → exit 6. Với `--approve`: ghi receipt
vào `state/skill-approvals.json` (0600), promote bundle vào catalog, bind pin trong `.bflow/config.yml`.

### `bflow skills disable <skill-id> [--dry-run]` · `bflow skills revoke <skill-id> [--version <v>] [--dry-run]`

`disable` bỏ binding cho manifest sau, giữ pin/receipt. `revoke` xoá receipt của repository session này và
bỏ binding; manifest session đã lưu chứa skill bị báo `reconciliation_required` (exit 3) — process đang chạy
vẫn giữ instruction đã nạp cho tới khi relaunch.

### `bflow skills status`

Chỉ đọc: pin, approval theo role/provider, cài đặt máy, import đang chờ duyệt và đối soát session manifest.

### `bflow agent check <claude|codex|agy> [--role <role>] [--mode restricted|workspace_auto] [--session <id>]`

Dựng một `AgentEnvironment` theo phạm vi session (mặc định `restricted`, chỉ đọc, chặn network) và
chạy preflight của provider adapter: binary, version, authentication, environment, MCP,
launch argument, permission, skill. Exit 0 chỉ với `ready`; `blocked`/`unsupported` exit 3
kèm mã và hướng dẫn khắc phục của từng check. Standalone command này không đọc role/profile/model từ repo config; default adapter có thể chạy model probe và tiêu hao usage. `doctor`/`up` là đường kiểm tra role/profile của host. Preflight không phải mức sẵn sàng đã kích hoạt: `bflow up` vẫn
yêu cầu một launch attestation đã xác thực từ pane đang chạy.

## Luồng agent điển hình

```sh
bflow repo inspect --json
bflow tool status --json && bflow agent check claude --json
bflow task plan --spec spec.json --write --json
bflow task implement implement --run run-1 --spec spec.json --json   # sau đó Runtime dispatch Developer
bflow verify implement --run run-1 --plan verify-plan.json --json     # 3 → đọc finding, rework
bflow git prepare run-1 --json                                         # 5 → con người/Coordinator cấp --yes
bflow git prepare run-1 --yes --json                                   # → request xác minh workflow
```

## Tích hợp và giới hạn hiện tại

- Dispatch, leases/fencing, Herdr và phê duyệt vẫn thuộc Runtime/Coordinator. Lệnh trả assignment/request/pending messages; thành công command không đóng workflow.
- Machine setup và Runtime platform đã nối Gateway/control, nhưng **standalone binary `mcp status` chưa có live Gateway port mặc định**. `skills sync` có default synchronizer thật; không đánh đồng tình trạng hai port này.
- Binary hiện chưa nhận `skills list`/`skills sync --list`; preview qua `skills sync --dry-run`. `agent check` dùng standalone environment, có thể chạy model probe; không chứng minh config-selected profile/model ready.
- `task implement` vẫn quan sát legacy RuntimeService store theo cấu hình repo; P19 host status và decisions đi qua lifecycle/Conversation, không dùng CLI run-ID query để giả kết quả của host.
- `verify` cần independent gate runner được host inject (`HighLevelServices.gates`); thiếu runner là blocked.
- Git/Runtime locking cần `flock` hỗ trợ inherited fd. Linux util-linux và bản macOS phù hợp được dùng; kiểm tra môi trường trước khi chạy. macOS workspace/JS verification có helper/Seatbelt riêng, không phải chứng nhận mọi polyglot adapter.
- Xem [implementation status](../../../docs/implementation-status.md), [compatibility](../../../docs/compatibility-matrix.md) và [runner matrix](../../../docs/verification-runners.md) cho source/evidence hiện tại.

### `bflow task preview [--run <id>] [--compare <file>] [--json]`

Read-only execution choices, field sources, existing observations, blockers and approval points. Intake has no accepted DAG. `--run` requires authoritative approved Runtime state. Save JSON outside source paths and pass it to `bflow up --expect-plan <file>` or `bflow task implement <task-id> --run <id> --spec <file> --expect-plan <file>` to stop before effects on drift. Legacy `bflow run` rejects this flag. Preview never probes, installs, reserves or approves work.

### `bflow handover inspect --run <id> [--json]` · `bflow handover export --run <id> (--revision <commit> | --snapshot <id>) --out <dir> [--format html|md] [--include-evidence] [--replace] [--json]` · `bflow handover verify --package <dir> [--json]`

`inspect` đọc một snapshot của Runtime journal (không lock, không kết nối host) và báo snapshot identity, integrated revision và mức đủ điều kiện bàn giao. `export` yêu cầu `--revision` và/hoặc `--snapshot` khớp đúng run; lệch thì không ghi gì (exit 6). Gói gồm `index.html`, `handover.md`, `handover.json` và `manifest.json` (SHA-256 từng file, content digest, source references, snapshot identity, `exportedAt`); được ghi vào staging rồi rename khi hoàn chỉnh; các lần export cùng `--out` được tuần tự hoá bằng flock và staging sót lại sau crash được dọn ở lần export sau. Gói `eligible` thoát 0; gói `draft`/`partial` vẫn được xuất, gắn nhãn rõ và thoát 3. Gói giống hệt đã có được tái sử dụng; thư mục khác là conflict có nêu rõ nó chứa gì (snapshot khác, run khác, exporter version khác); `--replace` chỉ thay gói bàn giao của cùng run và không có file lạ. `verify` kiểm tra offline manifest, hash, link nội bộ và trạng thái; chỉ gói nguyên vẹn và `eligible` thoát 0. Mặc định evidence chỉ là tham chiếu `artifact://`; `--include-evidence` chép evidence văn bản đã xác minh thuộc loại `test-result`, `report`, `patch`, `document` (1 MiB/file, tổng 16 MiB), đã redact, vào `evidence/<sha256>.txt`. Log và raw agent output không bao giờ được đóng gói; export không thay đổi run status, approval hay delivery acceptance. Chi tiết: [handover export design](../../../packages/runtime/handover-export-design.md).
