# Director lát B1 — nối Director vào host và CLI

> Kế hoạch tổng: [2026-11-03-director-agent.md](2026-11-03-director-agent.md). ADR: [0009](../../adr/0009-director-agent.md). Lát A (đã merge, `194cc028`) cung cấp `@bflow/contracts` director, `DirectorStore`, `DirectorTools`, `renderDirectorProgress`, `renderBflowStartSkill`, `applyDirectorRepoFiles`.

**Mục tiêu:** sau lát này, người dùng chạy `bflow init` thì skill/MCP/hook Director được ghi vào repo. Trong CLI của provider, người dùng gõ `/bflow-start`; skill gọi `bflow director start --json`, rồi điều khiển Runtime qua MCP `bflow director mcp` hoặc `bflow director call`. Người dùng xem tiến độ bằng `bflow progress --follow` và xử lý hàng đợi lỗi bằng `bflow queue …`.

**Ngoài phạm vi (lát B2):** SessionManifest v3 bỏ pane `conversation`/`coordinator`; định tuyến tin của vai chuyên trách tới Director; tab Herdr `progress`; `TaskStatus` `parked` và auto-park trong Core; gỡ Conversation. Web/3D thuộc lát C.

**Giới hạn đã biết của B1 (ghi vào README của runtime/cli):** Director **cùng tồn tại** với các pane Conversation/Coordinator v2. Director gọi tool điều phối với đúng thẩm quyền của Coordinator, nhưng tin từ vai chuyên trách vẫn gửi tới pane Coordinator. Đây là chế độ chuyển tiếp, không phải thay thế hoàn chỉnh.

## Global Constraints

- Node >=22.13, TypeScript strict, ESM (`.js` trong import), Zod 3. Không thêm dependency.
- Dữ liệu qua ranh giới package parse bằng schema `@bflow/contracts`. Không dùng type assertion thay validate.
- Import package khác chỉ qua `@bflow/<pkg>`; trong cùng package dùng đường dẫn tương đối.
- Tệp trạng thái: thư mục `0o700`, tệp `0o600`.
- Token Director (`<tokenId>.<secret>`) không bao giờ xuất hiện trong thông báo lỗi, log, argv hay activity log. Hook không bao giờ chặn, luôn thoát 0 và không in gì ra stdout.
- Không có tool hay method nào cho Director phê duyệt hoặc ghi evidence.
- Không no-op, không implementation luôn-thành-công.
- Subagent **không chạy git**; controller review và commit.
- Build: `./node_modules/.bin/tsc -b <pkg-dir> --pretty false` (KHÔNG dùng `pnpm exec tsc`). Test có mục tiêu: `pnpm exec vitest run <tệp>` từ gốc worktree. Không chạy cả bộ test. Test subprocess import `dist/`, nên phải build trước.
- Chuỗi hiển thị cho người dùng bằng tiếng Việt có dấu.

## Quyết định thiết kế (controller đã chốt)

- **R-B1-1 Nhận diện token.** Token Director có dấu `.`; token chủ, token vai, credential web đều là hex. Trong `dispatch` của host, token khác token chủ mà có `.` thì đi nhánh Director. Nhánh này chỉ nhận method `director_call`.
- **R-B1-2 Thẩm quyền.** Tool điều phối (tên thuộc `COORDINATOR_TOOLS` trừ `report_progress`) gọi qua cùng đường với Coordinator, gồm cả guard `propose_workflow` và kiểm quiesce, với `role: "coordinator"`, nhưng không cần pane binding. Tool cần pane binding (`repository_read`, `send_role_message`, `read_project_policy`…) không mở cho Director ở B1.
- **R-B1-3 Hook xác thực bằng token chủ.** `bflow director hook <provider>` gọi method chủ `director_hook_note`. Host chỉ ghi khi presence khác `absent`. Hook bỏ qua khi biến môi trường `HERDR_PANE_ID` có giá trị, vì đó là pane vai của Bflow chứ không phải người dùng.
- **R-B1-4 Không cần token khi khởi động MCP.** Skill truyền `token` làm đối số của mọi tool MCP; `bflow director mcp` tách `token` khỏi đối số rồi chuyển tiếp. Lệnh shell dùng biến `BFLOW_DIRECTOR_TOKEN`.
- **R-B1-5 Phiên host.** `sessionId` là `repository.sessionName` (như `apps/cli/src/agentic-host.ts:160`). Thư mục kho Director là `<host directory>/director`.

---

### Task 1: Director endpoint thuần (`packages/runtime/src/director/endpoint.ts`)

**Mô hình:** Sonnet.

**Tệp:** tạo `packages/runtime/src/director/endpoint.ts` và `packages/runtime/src/director/snapshot.ts`; sửa `packages/runtime/src/director/index.ts` (export) và `packages/runtime/src/director/tools.ts` (xem dưới); tạo `packages/runtime/test/director/endpoint.test.ts` và `packages/runtime/test/director/snapshot.test.ts`.

Đây là phần ghép, không phụ thuộc host, để host chỉ cần nối khoảng 30 dòng.

```ts
export interface DirectorFeedPort {
  /** Same contract as ProjectionFeed.read (packages/runtime/src/interaction/events.ts): non-blocking page after cursor. */
  read(cursor?: string): { items: readonly { cursor: string; type: string; resourceIds: readonly string[] }[] };
}
export interface DirectorEndpointOptions {
  readonly directory: string;            // <host directory>/director
  readonly repositoryRoot: string;
  readonly coordinator: DirectorCoordinatorPort;
  readonly feed: DirectorFeedPort;
  readonly inspect: () => Promise<unknown>;   // AgenticWorkflowRuntime.inspect() raw state
  readonly maxWaitMs?: number;
  readonly pollMs?: number;                   // default 1000
  readonly now?: () => Date;
}
export class DirectorEndpoint {
  constructor(options: DirectorEndpointOptions);
  static isDirectorToken(token: string): boolean;               // /^[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{16,256}$/
  register(input: { provider: AgentProviderId }): Promise<{ token: string; session: DirectorSession }>;
  revoke(): Promise<void>;
  call(token: string, name: string, args: unknown): Promise<JsonValue>;          // DirectorTools.invoke
  noteHookPrompt(input: { provider: AgentProviderId; prompt: string }): Promise<{ recorded: boolean }>;
  listIssues(status?: readonly ParkedIssueStatus[]): Promise<ParkedIssue[]>;
  inspectIssue(issueId: string): Promise<ParkedIssue>;
  setIssueStatus(issueId: string, status: "retrying" | "resolved" | "dismissed"): Promise<ParkedIssue>;
  progress(): Promise<DirectorProgressSnapshot>;
}
```

Yêu cầu:
1. Kho dùng một `DirectorStore` duy nhất cho mỗi endpoint (R-B1-5). Đối số `repositoryRoot` của `register` lấy từ options.
2. **Cổng sự kiện Runtime** là một `DirectorRuntimeEventsPort` dựng trên `feed`:
   - Cursor `""` nghĩa là "từ bây giờ": đọc trang hiện tại, lấy cursor của mục cuối (hoặc giữ `""` nếu trống), và không trả sự kiện nào.
   - Nếu không, cứ mỗi `pollMs` lại gọi `feed.read(cursor)` cho tới khi có mục, hết `timeoutMs`, hoặc `signal` bị abort.
   - Map mỗi mục thành `{ type: "projection." + type, summary: <type>: <tối đa 5 resourceIds nối bằng ", ">, cắt còn DIRECTOR_LIMITS.issueTextMax }`. Mục loại `reset` cũng được map (Director cần biết để đọc lại).
   - Không bao giờ trả quá `limit` mục. Cursor trả về là cursor của mục cuối cùng đã trả.
   - Huỷ timer khi xong, kể cả khi bị abort.
3. `noteHookPrompt`: nếu `store.presence()` là `absent` thì trả `{ recorded: false }`. Ngược lại ghi như `director_note_user_message`, kênh `cli`, có dedupe 10 s. Để không lặp logic, tách phần thân dedupe trong `DirectorTools` thành một method public `noteUserMessage(text: string): Promise<{ recorded: boolean; seq?: number }>`. Tool `director_note_user_message` gọi lại method đó sau khi xác thực token. Không đổi hành vi tool, các test cũ phải qua.
4. `progress()` gọi `buildDirectorProgressSnapshot({ state: await inspect(), presence, issues, now })` trong `snapshot.ts`. Builder là hàm thuần, kết quả parse bằng `DirectorProgressSnapshotSchema`.
   - Đọc shape thật của state từ `AgenticWorkflowRuntime.inspect()` (`packages/runtime/src/agentic/runtime.ts`, tìm method `inspect`). Fixture test được dựng từ shape đó.
   - Run: mỗi run trong state thành một `DirectorProgressRun`. `title` lấy theo thứ tự: tiêu đề spec, rồi workflow id, rồi runId. `sdlcStatus` lấy giá trị hợp lệ của `SdlcWorkStatusSchema`; không xác định được thì dùng `"intake"`.
   - Task: mỗi task giữ thứ tự xuất hiện. `status` parse bằng `TaskStatusSchema`; không hợp lệ thì bỏ task đó.
   - `pendingApprovals` đếm approval đang `pending`. `pendingQuestions` đếm user decision đang chờ (tìm trong state). Không tìm thấy trường thì để 0, và ghi một dòng bình luận nêu trường đã tìm.
   - Giới hạn tối đa 100 run (lấy mới nhất) và 1000 task mỗi run.
5. `call` với token sai: lỗi `DirectorAuthError` từ store, thông báo không chứa token.
6. Test endpoint dùng thư mục tạm thật (`mkdtemp`), một feed giả có ring buffer, và một coordinator giả **ghi lại lời gọi** (không trả thành công cứng). Các ca:
   - register → call `director_say` → `readMessages` thấy tin.
   - `director_wait` trả runtimeEvents từ feed sau khi feed publish giữa chừng.
   - Cursor `""` không trả sự kiện cũ.
   - `noteHookPrompt` khi `absent` trả `recorded: false`; khi active thì ghi; gọi lại trong 10 s thì bỏ qua do dedupe.
   - `isDirectorToken` phân biệt token Director với chuỗi hex 64 ký tự.
   - `call` một tool điều phối được chuyển tới coordinator giả.
   - Lỗi xác thực không làm lộ token.
7. Test snapshot: fixture state có 2 run và các task ở nhiều trạng thái, 1 approval pending, 1 status không hợp lệ (bị bỏ). Kết quả parse qua schema.

---

### Task 2: Nối Director vào host daemon (`packages/runtime/src/agentic/host.ts`)

**Mô hình:** Sonnet.

**Tệp:** sửa `packages/runtime/src/agentic/host.ts`; thêm test vào tệp test host sẵn có phù hợp nhất dưới `packages/runtime/test/` (tìm test đang gọi `dispatch`/`callHost` tới host thật hoặc giả). Nếu không có harness gọn, tạo `packages/runtime/test/director/host-wiring.test.ts` kiểm hàm đã tách (xem bước 1).

1. **Tách guard Coordinator.** Trong `roleCall`, phần xử lý tool điều phối của Coordinator kết thúc bằng `return host.tools.invoke(name, parameters, { role })` (khoảng `host.ts:2110`). Phần này gồm guard `propose_workflow` và báo `recordWorkflowRejected`. Tách nó thành `const invokeCoordinatorTool = async (name: string, parameters: Record<string, JsonValue>) => …` trong cùng closure.
   - Hàm này gồm mọi kiểm tra không phụ thuộc pane binding, kể cả kiểm quiesce (`QUIESCED_RECEIPT_DRAIN_OPERATIONS`).
   - `roleCall` của Coordinator gọi lại hàm này. Hành vi của Coordinator **không đổi**; phần nào cần `binding` thì vẫn ở lại `roleCall`.
2. **Endpoint.** Dựng một `DirectorEndpoint` (Task 1) duy nhất trong `runAgenticHost`:
   - `directory: join(configuration.directory, "director")`, `repositoryRoot: configuration.repositoryPath`, `feed: webFeed`.
   - `inspect: () => requireWorkspace().runtime.inspect()`.
   - `coordinator.invoke(name, input)`: chỉ nhận tên thuộc `COORDINATOR_TOOLS` khác `report_progress`, còn lại throw `"Tool is unavailable to the Director"`. Parse input bằng `JsonValueSchema`, gọi `invokeCoordinatorTool`, rồi ghi activity log `{ kind: "tool", role: "coordinator", action: "director:<name>:completed" }` hoặc `failed` như nhánh `role_call`. Không ghi đối số.
3. **Dispatch.**
   - Nhánh Director (R-B1-1), đặt **trước** `roleTokens.get(token)`: nếu `DirectorEndpoint.isDirectorToken(token)` thì chỉ chấp nhận `director_call` với `{ name: string, arguments?: Record<string, JsonValue> }` (parse strict). Method khác throw `"Director credentials can only call director tools"`. Lỗi xác thực trả `"Director authentication failed"`, không kèm token.
   - Method chủ trong `switch (method)` (token chủ): `director_register` `{ provider }`, `director_revoke`, `director_progress`, `director_hook_note` `{ provider, prompt (≤ DIRECTOR_LIMITS.messageBytes byte) }`, `director_issues` `{ status?: ParkedIssueStatus[] }`, `director_issue` `{ issueId }`, `director_issue_status` `{ issueId, status: "retrying"|"resolved"|"dismissed" }`. Tất cả parse strict bằng Zod.
4. Timeout socket phía host cho `director_call` không được cắt ngang `director_wait`. Kiểm `callHost`/server trong `host-protocol.ts`; nếu server có deadline thì `director_call` phải dài hơn `DIRECTOR_LIMITS.waitMaxMs + 30_000`.
5. Test:
   - `invokeCoordinatorTool` vẫn chặn khi quiesced.
   - Nhánh Director từ chối method khác `director_call`.
   - Token hex không đi nhánh Director.
   - Owner method `director_register` trả token có dạng hợp lệ.
   - Dùng harness host sẵn có nếu có, không dựng Herdr thật.

---

### Task 3: Client và MCP stdio của Director (`packages/runtime/src/agentic/host-controller.ts`, `packages/runtime/src/director/mcp.ts`)

**Mô hình:** Sonnet.

**Tệp:** sửa `host-controller.ts`, `packages/runtime/src/index.ts`; tạo `packages/runtime/src/director/mcp.ts` và `packages/runtime/test/director/mcp.test.ts`.

1. Trong `host-controller.ts`, theo mẫu `queryAgenticHostInteraction` (kiểm session id an toàn, `findPrivateRuntimeStateDirectory`, đọc `host.json`, kiểm foreign config):
   - `callDirectorOwnerHost(options: { repositoryPath; sessionId }, method: "director_register" | "director_revoke" | "director_progress" | "director_hook_note" | "director_issues" | "director_issue" | "director_issue_status", input: unknown, timeoutMs = 10_000): Promise<unknown>`.
   - `callDirectorTool(options, token: string, name: string, args: Record<string, JsonValue>): Promise<unknown>`. Gọi `director_call` bằng token Director. Timeout là `DIRECTOR_LIMITS.waitMaxMs + 30_000` khi `name === "director_wait"`, còn lại `600_000`.
   - Host không chạy thì throw `"Host unavailable"`.
2. `mcp.ts`:
   ```ts
   export interface DirectorMcpOptions { call(name: string, token: string, args: Record<string, JsonValue>): Promise<unknown>; input: NodeJS.ReadableStream; output: NodeJS.WritableStream; }
   export async function runDirectorMcp(options: DirectorMcpOptions): Promise<void>;
   ```
   - JSON-RPC theo dòng như `runRoleMcp` (`host.ts`): `initialize` (protocolVersion `"2024-11-05"`, serverInfo `{ name: "bflow", version: "0.1.0" }`), `ping`, `tools/list`, `tools/call`. Method khác trả `-32601`. Dòng quá 4 MiB thì bỏ qua, ghi lỗi ra stderr, không thoát.
   - `tools/list` trả mọi tool trong `DIRECTOR_TOOLS`, mỗi tool có `inputSchema: { type: "object", properties: { token: { type: "string", description: "Director token from bflow director start" } }, required: ["token"], additionalProperties: true }`.
   - `tools/call`: tên ngoài `DIRECTOR_TOOLS` trả `isError`. Tách `token` khỏi `arguments`; thiếu token trả `isError` "token is required". Kết quả là `content: [{ type: "text", text: JSON.stringify(result) }]`; lỗi là `isError: true` với text đã redact (không chứa token).
   - Mỗi `tools/call` chạy độc lập, không tuần tự hoá: một `director_wait` dài không được chặn `director_say`. Thứ tự trả lời có thể khác thứ tự request, nhưng `id` phải khớp.
3. Export `runDirectorMcp`, `callDirectorOwnerHost`, `callDirectorTool` từ `packages/runtime/src/index.ts`.
4. Test `mcp.test.ts` dùng `PassThrough`:
   - `initialize`.
   - `tools/list` có `director_wait` và `propose_workflow`, không có `report_progress`.
   - `tools/call` chuyển đúng name/token/args còn lại.
   - Thiếu token.
   - Tool lạ.
   - Hai call song song: call thứ hai trả lời trước khi call thứ nhất (bị treo có chủ đích) xong.
   - Lỗi chứa token thì text trả về không chứa token.

---

### Task 4: Lệnh CLI `bflow director start|call|mcp|hook`

**Mô hình:** Sonnet.

**Tệp:** sửa `apps/cli/src/parser.ts`, `apps/cli/src/commands.ts`, `apps/cli/src/help.ts`, `apps/cli/src/command-reference.ts` (nếu có bảng lệnh), `apps/cli/src/types.ts` nếu cần; tạo `apps/cli/src/director-commands.ts` và `apps/cli/test/director-commands.test.ts`.

Thiết kế theo dependency injection để test không cần host thật: `director-commands.ts` nhận `{ identify, ensureUp, ownerCall, toolCall, runMcp, env, stdin, stdout }`, có mặc định thật.

1. `bflow director start [--provider claude|codex|agy] --json`:
   - `identifyRepository(cwd)`.
   - Nếu môi trường chưa `up` thì chạy `EnvironmentLifecycle.up()` như lệnh `up` (tái dùng, không tự dựng lại).
   - `callDirectorOwnerHost(director_register, { provider })`. Provider mặc định: `--provider`, rồi suy từ env (`CLAUDECODE=1` → `claude`, `CODEX_SANDBOX`/`CODEX_HOME` → `codex`, `ANTIGRAVITY_AGENT`/`AGY_*` → `agy`), cuối cùng là `claude`.
   - In JSON: `{ ok: true, token, cursor: "", sessionId, repositoryRoot, provider, presence }`.
   - Lỗi: `{ ok: false, message, fix }`, với `fix` tiếng Việt cụ thể (ví dụ: "Chạy `bflow init` trong kho này rồi thử lại"). Exit 1 khi lỗi.
   - `token` chỉ có trong JSON stdout; không ghi vào log.
2. `bflow director call <tool> [--json] [<argsJson>]`:
   - Đọc token từ `BFLOW_DIRECTOR_TOKEN`; thiếu thì lỗi "BFLOW_DIRECTOR_TOKEN chưa được đặt".
   - `argsJson` mặc định `{}`, phải parse ra object, và không được chứa khoá `token`.
   - Gọi `callDirectorTool`, in kết quả JSON. Exit 0/1.
3. `bflow director mcp`: `runDirectorMcp({ call: (name, token, args) => callDirectorTool(opts, token, name, args), input: stdin, output: stdout })`. Không in gì khác ra stdout.
4. `bflow director hook <claude|codex>`:
   - Nếu `HERDR_PANE_ID` có giá trị thì thoát 0 ngay (R-B1-3).
   - Đọc stdin (giới hạn 1 MiB), parse JSON, lấy `prompt` (string, khác rỗng).
   - Gọi `director_hook_note` với timeout 3000 ms.
   - **Mọi lỗi đều nuốt**, luôn exit 0 và không in gì ra stdout. Chỉ ghi stderr khi có biến `BFLOW_DEBUG`.
5. `help`: thêm nhóm "Director" tiếng Việt, một dòng mỗi lệnh.
6. Test các ca:
   - Parser nhận đủ 4 lệnh và từ chối lệnh con lạ.
   - `start` thành công (JSON có token và `ok`).
   - `start` khi `ensureUp` lỗi thì có `fix`.
   - `call` thiếu env.
   - `call` có khoá `token` trong args thì bị từ chối.
   - `hook` khi `HERDR_PANE_ID` có giá trị thì không gọi `ownerCall`.
   - `hook` gặp lỗi `ownerCall` thì vẫn exit 0 và stdout trống.
   - `hook` có stdin hỏng.

---

### Task 5: `bflow progress` và `bflow queue`

**Mô hình:** Sonnet.

**Tệp:** sửa `parser.ts`, `commands.ts`, `help.ts`; tạo `apps/cli/src/director-progress.ts` và `apps/cli/test/director-progress.test.ts`.

1. `bflow progress [--follow] [--json]`:
   - Gọi `director_progress` rồi parse bằng `DirectorProgressSnapshotSchema`. Có `--json` thì in snapshot; không thì in `renderDirectorProgress(snapshot, { width: stdout.columns ?? 80, height: stdout.rows ?? 24, now })` nối bằng `\n`.
   - `--follow`: xoá màn hình (`\x1b[H\x1b[2J`) và vẽ lại mỗi 2 s. Bắt `SIGINT`/`SIGTERM` để dừng sạch, exit 0.
   - Host không chạy: không thoát. Vẽ một dòng "BFLOW · Chưa có phiên — chạy /bflow-start trong CLI của bạn" rồi thử lại ở chu kỳ sau. Không có `--follow` thì exit 1 kèm thông báo đó.
   - Interval/clock/ownerCall inject được để test.
2. `bflow queue list [--status <s,...>] [--json]`, `bflow queue show <issueId> [--json]`, `bflow queue retry <issueId>`, `bflow queue dismiss <issueId>`:
   - Dùng `director_issues`, `director_issue`, `director_issue_status` (`retrying`/`dismissed`).
   - Bản không JSON in bảng tiếng Việt: mã, loại, trạng thái, task, tóm tắt.
3. Test:
   - Render một lần (có `--json` và không).
   - `follow` vẽ hai chu kỳ bằng interval giả rồi dừng khi abort.
   - Host không chạy.
   - `queue list` rỗng in "Hàng đợi lỗi trống".
   - `retry` gọi đúng method và status.
   - Parser từ chối `queue` thiếu id.

---

### Task 6: `bflow init` ghi tệp Director và `doctor`

**Mô hình:** Sonnet.

**Tệp:** sửa `apps/cli/src/commands.ts` (nhánh `init`), `apps/cli/src/parser.ts` (cờ `--commit-skills`, `--no-director`), `apps/cli/src/types.ts` (`InitCommandOutput.director?`), formatter của init trong `apps/cli/src/formatters.ts`, `apps/cli/src/doctor-integration.ts` (nếu cấu trúc check cho phép thêm gọn); tạo `apps/cli/test/init-director.test.ts`.

1. `bflowCommand` là `[process.execPath, realpath(process.argv[1])]` khi đang chạy `dist/bin.js`. Nếu tìm được `bflow` launcher của shell PATH được quản lý (xem cách `setup` cài launcher, `apps/cli/src/setup-*.ts`) và nó là đường dẫn tuyệt đối, ưu tiên `[<launcher>]`. Logic này nằm trong một hàm `resolveBflowCommand(deps)` có test.
2. `bflow init` (thường và `--update`): sau khi ghi config thành công, trừ khi có `--no-director`, gọi `applyDirectorRepoFiles({ repositoryRoot, bflowCommand, providers: ["claude", "codex", "agy"], commitSkills: parsed.commitSkills })`. Đọc chữ ký thật trong `apps/cli/src/director-repo-files.ts`; nếu tên tùy chọn khác thì dùng tên thật. Kết quả gắn vào `output.director` `{ status, files: [{ path, action }] }`.
   - Lỗi ghi tệp Director (ví dụ marker hỏng) không làm hỏng init. Init vẫn thành công và kèm `diagnostics` nêu tệp và cách sửa.
3. `init --check`: gọi `checkDirectorRepoFiles`; trạng thái khác `ready` thì `healthy=false`, kèm chẩn đoán "Chạy `bflow init --update` để cài lại skill Director".
4. `init --remove`: gọi thêm `removeDirectorRepoFiles`. Tệp người dùng đã sửa được giữ lại và liệt kê.
5. Formatter tiếng Việt: một dòng tóm tắt, ví dụ "Director: đã cài skill/MCP/hook cho Claude Code, Codex, Agy (5 tệp)".
6. `doctor`: thêm check `director-skill-installed` dùng `checkDirectorRepoFiles`, mức cảnh báo (không lỗi) khi thiếu. Nếu cấu trúc doctor quá rối để thêm gọn thì bỏ bước này, ghi DONE_WITH_CONCERNS.
7. Test trên repo git tạm (`git init` trong `mkdtemp`):
   - Init ghi `.claude/skills/bflow-start/SKILL.md` và `.mcp.json`.
   - `--no-director` không ghi.
   - `--check` sau khi xoá SKILL.md cho `healthy=false`.
   - `--remove` gỡ tệp.
   - Marker `.gitignore` hỏng: init vẫn ok, kèm diagnostics.
   - `resolveBflowCommand` luôn trả đường dẫn tuyệt đối.

---

### Task 7: Tài liệu package

**Mô hình:** Haiku.

**Tệp:** `packages/runtime/README.md` và `apps/cli/README.md`, nếu tồn tại. Đây là README thuộc package owner, không phải README gốc.

Thêm mục "Director (thử nghiệm, lát B1)" gồm: các lệnh mới, luồng `/bflow-start`, giới hạn đã biết (cùng tồn tại với Conversation/Coordinator v2, tin vai chuyên trách vẫn tới Coordinator, Codex/Agy chưa kiểm live), và bậc bằng chứng "nguồn + test cục bộ". Không sửa README gốc, AGENTS.md hay `docs/**`.
