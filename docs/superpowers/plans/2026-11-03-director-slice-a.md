# Director lát A — nền tảng cộng thêm

> Kế hoạch tổng: [2026-11-03-director-agent.md](2026-11-03-director-agent.md). ADR: [0009](../../adr/0009-director-agent.md). Lát A **chỉ thêm mới**, không đổi hành vi luồng đang chạy. Wiring vào host, pane, Web thuộc lát B trở đi.

**Mục tiêu:** hợp đồng Director, kho trạng thái Director (phiên, token, transcript, hàng đợi lỗi), facade tool Director, bộ vẽ pane tiến trình, nội dung skill `bflow-start`, và bộ lập kế hoạch tệp repo cho `bflow init`. Tất cả có test cục bộ.

**Spec:** ADR 0009 và mục 3 của kế hoạch tổng (D-DIR-01…05 đã chốt).

## Global Constraints

- Node >=22.13, TypeScript strict, ESM (`.js` trong import), Zod 3. Không thêm dependency mới.
- Dữ liệu qua ranh giới package phải parse bằng schema xuất từ `@bflow/contracts`; không dùng type assertion thay validate.
- `packages/runtime` chỉ import package khác qua specifier `@bflow/<pkg>`; trong cùng package dùng đường dẫn tương đối.
- Tệp trạng thái riêng: thư mục mode `0o700`, tệp mode `0o600`, chủ sở hữu là UID hiện tại. Ghi JSON theo kiểu tmp + `rename`.
- Không no-op, không implementation luôn-thành-công chỉ để test qua.
- Subagent **không chạy git**. Controller review và commit.
- Lệnh test có mục tiêu: `pnpm exec vitest run <tệp test>` từ gốc worktree; sau khi sửa source, chạy `pnpm exec tsc -b packages/<pkg> --pretty false` (hoặc `apps/cli`). Không chạy cả bộ test.
- Nhãn hiển thị cho người dùng bằng tiếng Việt có dấu đúng như chép trong brief.

---

### Task 1: Hợp đồng Director (`packages/contracts`)

**Mô hình:** Haiku (chép mã).

**Tệp:** tạo `packages/contracts/src/director.ts`; sửa `packages/contracts/src/index.ts` (thêm một dòng export); tạo `packages/contracts/test/director.test.ts`.

Nội dung đầy đủ của `packages/contracts/src/director.ts`:

```ts
/** Director agent (ADR 0009). Director is a host principal, not an AgentRole or Herdr pane. */
import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";
import { AgentProviderIdSchema } from "./platform.js";
import { AgentRoleSchema } from "./agent-roles.js";
import { TaskStatusSchema } from "./execution.js";
import { SdlcWorkStatusSchema } from "./sdlc.js";

export const DIRECTOR_SCHEMA_VERSION = 1 as const;
export const DIRECTOR_LIMITS = {
  messageBytes: 16384,
  transcriptPage: 200,
  issuesMax: 500,
  issueTextMax: 2000,
  waitDefaultMs: 45000,
  waitMinMs: 1000,
  waitMaxMs: 300000,
  heartbeatStaleMs: 120000
} as const;

const version = z.literal(DIRECTOR_SCHEMA_VERSION);
const id = IdentifierSchema;
const time = IsoDateTimeSchema;
const nonblank = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, "must not be blank");
const issueText = nonblank(DIRECTOR_LIMITS.issueTextMax);

export const DirectorChannelSchema = z.enum(["cli", "web"]);
export type DirectorChannel = z.infer<typeof DirectorChannelSchema>;
export const DirectorPresenceSchema = z.enum(["active", "waiting", "absent"]);
export type DirectorPresence = z.infer<typeof DirectorPresenceSchema>;

export const DirectorSessionSchema = z.object({
  schemaVersion: version,
  directorId: id,
  provider: AgentProviderIdSchema,
  repositoryRoot: z.string().min(1).max(4096),
  tokenId: id,
  startedAt: time,
  heartbeatAt: time,
  waitingSince: time.nullable()
}).strict();
export type DirectorSession = z.infer<typeof DirectorSessionSchema>;

export const DirectorMessageSchema = z.object({
  schemaVersion: version,
  seq: z.number().int().min(1),
  messageId: id,
  author: z.enum(["user", "director"]),
  channel: DirectorChannelSchema,
  text: nonblank(DIRECTOR_LIMITS.messageBytes).refine(value => Buffer.byteLength(value, "utf8") <= DIRECTOR_LIMITS.messageBytes,
    `must be at most ${DIRECTOR_LIMITS.messageBytes} UTF-8 bytes`),
  at: time,
  runId: id.optional()
}).strict();
export type DirectorMessage = z.infer<typeof DirectorMessageSchema>;

export const ParkedIssueKindSchema = z.enum([
  "transport_failure",
  "provider_failure",
  "verification_exhausted",
  "rework_exhausted",
  "user_decision_pending",
  "environment",
  "other"
]);
export type ParkedIssueKind = z.infer<typeof ParkedIssueKindSchema>;
export const ParkedIssueStatusSchema = z.enum(["open", "retrying", "resolved", "dismissed"]);
export type ParkedIssueStatus = z.infer<typeof ParkedIssueStatusSchema>;

export const ParkedIssueSchema = z.object({
  schemaVersion: version,
  issueId: id,
  runId: id,
  taskKey: id.optional(),
  kind: ParkedIssueKindSchema,
  status: ParkedIssueStatusSchema,
  summary: issueText,
  attempts: z.number().int().min(0),
  evidence: z.array(z.string().regex(/^artifact:\/\/\S+$/)).max(50),
  suggestedAction: issueText.optional(),
  createdAt: time,
  updatedAt: time
}).strict();
export type ParkedIssue = z.infer<typeof ParkedIssueSchema>;

export const DirectorRuntimeEventSchema = z.object({
  type: id,
  runId: id.optional(),
  summary: issueText
}).strict();
export type DirectorRuntimeEvent = z.infer<typeof DirectorRuntimeEventSchema>;

export const DirectorWaitResultSchema = z.object({
  cursor: z.string().min(1).max(512),
  timedOut: z.boolean(),
  messages: z.array(DirectorMessageSchema).max(DIRECTOR_LIMITS.transcriptPage),
  issues: z.array(ParkedIssueSchema).max(DIRECTOR_LIMITS.issuesMax),
  runtimeEvents: z.array(DirectorRuntimeEventSchema).max(200)
}).strict();
export type DirectorWaitResult = z.infer<typeof DirectorWaitResultSchema>;

export const DirectorProgressTaskSchema = z.object({
  taskKey: id,
  title: nonblank(200),
  status: TaskStatusSchema,
  role: AgentRoleSchema.optional(),
  startedAt: time.optional()
}).strict();
export type DirectorProgressTask = z.infer<typeof DirectorProgressTaskSchema>;

export const DirectorProgressRunSchema = z.object({
  runId: id,
  title: nonblank(200),
  sdlcStatus: SdlcWorkStatusSchema,
  tasks: z.array(DirectorProgressTaskSchema).max(1000)
}).strict();
export type DirectorProgressRun = z.infer<typeof DirectorProgressRunSchema>;

export const DirectorProgressSnapshotSchema = z.object({
  schemaVersion: version,
  generatedAt: time,
  director: z.object({
    presence: DirectorPresenceSchema,
    provider: AgentProviderIdSchema.optional(),
    heartbeatAt: time.optional()
  }).strict(),
  runs: z.array(DirectorProgressRunSchema).max(100),
  pendingApprovals: z.number().int().min(0),
  pendingQuestions: z.number().int().min(0),
  issues: z.array(ParkedIssueSchema).max(DIRECTOR_LIMITS.issuesMax)
}).strict();
export type DirectorProgressSnapshot = z.infer<typeof DirectorProgressSnapshotSchema>;
```

Thêm vào cuối `packages/contracts/src/index.ts`: `export * from "./director.js";`

Test `packages/contracts/test/director.test.ts` (vitest, `import * as contracts from "../src/index.js";`) phải có các ca sau, mỗi ca một `it`:
1. `DirectorSessionSchema` chấp nhận phiên hợp lệ (`provider: "claude"`, `waitingSince: null`) và từ chối `provider: "gemini"`.
2. `DirectorSessionSchema` từ chối khóa lạ (strict), ví dụ thêm `token: "x"`.
3. `DirectorMessageSchema` từ chối `text: "   "` và từ chối text 16385 byte (dùng `"a".repeat(16385)`), chấp nhận text tiếng Việt `"Làm trang todo"`.
4. `DirectorMessageSchema` từ chối `seq: 0` và `author: "coordinator"`.
5. `ParkedIssueSchema` chấp nhận evidence `["artifact://sha256/abc"]`, từ chối `["https://x"]`, từ chối `attempts: -1`.
6. `DirectorWaitResultSchema` chấp nhận kết quả rỗng `{cursor: "m0.i0.r", timedOut: true, messages: [], issues: [], runtimeEvents: []}`.
7. `DirectorProgressSnapshotSchema` chấp nhận snapshot có một run với một task `status: "running", role: "developer"`, và từ chối `director.presence: "online"`.
8. `DIRECTOR_LIMITS.waitDefaultMs === 45000` và `DIRECTOR_LIMITS.waitMaxMs === 300000`.

Kiểm: `pnpm exec tsc -b packages/contracts --pretty false` và `pnpm exec vitest run packages/contracts/test/director.test.ts`.

---

### Task 2: Kho trạng thái Director (`packages/runtime/src/director/store.ts`)

**Mô hình:** Sonnet.

**Tệp:** tạo `packages/runtime/src/director/store.ts`, `packages/runtime/test/director/store.test.ts`. Chưa export ra `packages/runtime/src/index.ts` (Task 3 làm).

Lớp `DirectorStore`, mọi dữ liệu parse bằng schema từ `@bflow/contracts` (Task 1) khi đọc và trước khi ghi:

```ts
export class DirectorAuthError extends Error {}
export interface DirectorStoreOptions { readonly directory: string; readonly now?: () => Date }
export interface DirectorVersion { readonly messageSeq: number; readonly issuesRevision: number }
export interface IssueInput {
  readonly issueId?: string; readonly runId: string; readonly taskKey?: string; readonly kind: ParkedIssueKind;
  readonly summary: string; readonly attempts?: number; readonly evidence?: readonly string[]; readonly suggestedAction?: string;
}
export class DirectorStore {
  constructor(options: DirectorStoreOptions);
  register(input: { provider: AgentProviderId; repositoryRoot: string }): Promise<{ session: DirectorSession; token: string }>;
  authenticate(token: string): Promise<DirectorSession>;
  heartbeat(token: string, waiting: boolean): Promise<DirectorSession>;
  presence(): Promise<{ presence: DirectorPresence; session: DirectorSession | null }>;
  revoke(): Promise<void>;
  appendMessage(input: { author: "user" | "director"; channel: DirectorChannel; text: string; runId?: string }): Promise<DirectorMessage>;
  readMessages(query: { afterSeq: number; limit?: number }): Promise<DirectorMessage[]>;
  upsertIssue(input: IssueInput): Promise<ParkedIssue>;
  setIssueStatus(issueId: string, status: ParkedIssueStatus): Promise<ParkedIssue>;
  listIssues(query?: { status?: readonly ParkedIssueStatus[] }): Promise<ParkedIssue[]>;
  version(): Promise<DirectorVersion>;
  waitForChange(since: DirectorVersion, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
}
```

Quy tắc:
- **Thư mục:** lần đầu cần thì tạo `directory` (recursive, mode `0o700`). Thư mục đã có mà mode có bit nhóm/khác (`mode & 0o077 !== 0`), là symlink, hoặc chủ khác UID ⇒ ném `Error("Unsafe director state directory")`.
- **Tệp:** `session.json` (DirectorSession), `token.json` (`{ tokenId, secretSha256 }`), `transcript.jsonl`, `issues.json` (`{ revision: number, issues: ParkedIssue[] }`). Tất cả mode `0o600`. JSON ghi tmp + rename. Transcript ghi bằng append một dòng JSON mỗi tin.
- **register:** `tokenId = randomUUID()`, secret `randomBytes(32).toString("hex")`, token trả về `"<tokenId>.<secret>"`. Chỉ lưu `sha256(secret)` dạng hex. `directorId = randomUUID()`. `startedAt = heartbeatAt = now`, `waitingSince = null`. Mỗi lần gọi thay token cũ, nên token cũ bị từ chối.
- **authenticate:** tách theo dấu `.` đầu tiên. Sai định dạng, không có phiên, sai `tokenId`, hoặc sha256 lệch (so bằng `timingSafeEqual` trên hai buffer cùng độ dài) ⇒ `DirectorAuthError("Director token rejected")`. Thông báo lỗi không bao giờ chứa token.
- **heartbeat:** sau khi authenticate, đặt `heartbeatAt = now`. `waiting=true` thì giữ `waitingSince` cũ hoặc đặt `now` nếu đang `null`; `waiting=false` thì đặt `null`.
- **presence:** không có phiên ⇒ `absent`. `now - heartbeatAt > DIRECTOR_LIMITS.heartbeatStaleMs` ⇒ `absent`. `waitingSince !== null` ⇒ `waiting`. Còn lại `active`.
- **revoke:** xóa `session.json` và `token.json` nếu có. Không báo lỗi khi đã không có.
- **appendMessage:** gán `seq = seq cuối + 1` (seq đầu tiên là 1), `messageId = randomUUID()`, `at = now`, `schemaVersion: 1`; parse bằng `DirectorMessageSchema` (vượt giới hạn byte thì ném lỗi Zod) rồi append. Các thao tác ghi trong một instance được tuần tự hóa bằng chuỗi promise nội bộ, để 20 lời gọi đồng thời cho ra seq 1..20 không trùng.
- **readMessages:** trả các tin có `seq > afterSeq` theo thứ tự tăng dần, tối đa `limit` (mặc định và trần `DIRECTOR_LIMITS.transcriptPage`). Dòng cuối dang dở (không có `\n` hoặc JSON hỏng ở dòng cuối) bị bỏ qua. Dòng hỏng ở giữa tệp ⇒ ném `Error("Corrupt director transcript at line N")`.
- **upsertIssue:** có `issueId` trùng ⇒ cập nhật `summary/attempts/evidence/suggestedAction/kind/taskKey`, giữ `createdAt` và `status`, đặt `updatedAt = now`. Không có ⇒ tạo mới với `issueId` đã cho hoặc `randomUUID()`, `status: "open"`, `attempts` mặc định 0, `evidence` mặc định `[]`. Mọi thay đổi tăng `revision` thêm 1. Sau khi thêm mà vượt `DIRECTOR_LIMITS.issuesMax` ⇒ bỏ các issue `resolved`/`dismissed` có `updatedAt` cũ nhất cho tới khi vừa; vẫn vượt ⇒ ném `Error("Director issue queue is full")` và không ghi gì.
- **setIssueStatus:** không tìm thấy ⇒ `Error("Unknown director issue <id>")`. Có ⇒ đổi trạng thái, `updatedAt = now`, `revision + 1`.
- **listIssues:** lọc theo `status` nếu có. Thứ tự: `createdAt` tăng dần, cùng mốc thì theo `issueId`.
- **version:** `{ messageSeq: seq cuối hoặc 0, issuesRevision: revision hoặc 0 }`.
- **waitForChange:** nếu `version()` khác `since` thì trả `true` ngay. Nếu không, chờ sự kiện thay đổi trong tiến trình (EventEmitter do `appendMessage`, `upsertIssue`, `setIssueStatus` phát), hết `timeoutMs` thì `false`, `signal` abort thì `false`. Phải gỡ listener và timer khi xong. Chỉ đảm bảo trong cùng tiến trình; ghi rõ điều này trong JSDoc.

Test (dùng `mkdtemp` trong `os.tmpdir()`, `now` giả lập được) cho từng ca:
1. register → authenticate với token đúng; register lần hai ⇒ token cũ ném `DirectorAuthError`, token mới qua.
2. authenticate từ chối `"garbage"`, `"<tokenId>."`, secret sai; thông báo lỗi không chứa secret.
3. Mode: thư mục `0o700`, mọi tệp `0o600` (kiểm `stat().mode & 0o777`). Thư mục có sẵn mode `0o755` ⇒ constructor hoặc thao tác đầu ném lỗi "Unsafe director state directory".
4. presence: chưa register ⇒ `absent`; vừa register ⇒ `active`; heartbeat waiting ⇒ `waiting`; tiến đồng hồ 120001 ms ⇒ `absent`; revoke ⇒ `absent`.
5. 20 `appendMessage` đồng thời ⇒ seq đúng 1..20, `readMessages({afterSeq: 15})` trả 16..20.
6. Transcript có dòng cuối dang dở ⇒ `readMessages` bỏ qua dòng đó; dòng hỏng ở giữa ⇒ ném lỗi có số dòng.
7. upsertIssue tạo mới rồi cập nhật cùng `issueId` ⇒ giữ `createdAt` và `status`, `revision` tăng 2; `setIssueStatus` id lạ ném lỗi.
8. Trần 500 issue: 500 issue `open` rồi thêm một ⇒ ném "Director issue queue is full" và `listIssues().length === 500`; nếu một issue đã `resolved` thì thêm được và issue resolved cũ nhất bị bỏ.
9. waitForChange: trả `true` khi có `appendMessage` trong lúc chờ; trả `false` khi hết 50 ms; trả `false` khi abort; trả `true` ngay khi `since` đã cũ.

Kiểm: `pnpm exec tsc -b packages/runtime --pretty false` và `pnpm exec vitest run packages/runtime/test/director/store.test.ts`.

---

### Task 3: Facade tool Director (`packages/runtime/src/director/tools.ts`)

**Mô hình:** Sonnet.

**Tệp:** tạo `packages/runtime/src/director/tools.ts`, `packages/runtime/src/director/index.ts`, `packages/runtime/test/director/tools.test.ts`; sửa `packages/runtime/src/index.ts` thêm `export * from "./director/index.js";`.

`director/index.ts` export `DirectorStore`, `DirectorAuthError`, kiểu của Task 2, và mọi export của `tools.ts`.

```ts
export interface DirectorCoordinatorPort { invoke(name: string, input: unknown): Promise<JsonValue> }
export interface DirectorRuntimeEventsPort {
  /** Returns events after `cursor` ("" = from now). Waits at most timeoutMs when none are available; resolves early on abort. */
  wait(cursor: string, timeoutMs: number, signal: AbortSignal): Promise<{ cursor: string; events: DirectorRuntimeEvent[] }>;
}
export interface DirectorToolsOptions {
  readonly store: DirectorStore;
  readonly coordinator: DirectorCoordinatorPort;
  readonly runtimeEvents?: DirectorRuntimeEventsPort;
  /** Provider-specific upper bound; clamped to [DIRECTOR_LIMITS.waitMinMs, DIRECTOR_LIMITS.waitMaxMs]. Default DIRECTOR_LIMITS.waitDefaultMs. */
  readonly maxWaitMs?: number;
  readonly now?: () => Date;
}
export const DIRECTOR_OWN_TOOLS: readonly { name: string; description: string }[];
export const DIRECTOR_TOOLS: readonly { name: string; description: string }[];
export class DirectorTools {
  constructor(options: DirectorToolsOptions);
  invoke(name: string, input: unknown, token: string): Promise<JsonValue>;
}
```

- `DIRECTOR_TOOLS` = các tool trong `COORDINATOR_TOOLS` (import từ `../agentic/tools.js`) **trừ** `report_progress`, nối thêm `DIRECTOR_OWN_TOOLS`. Tên không trùng nhau (test kiểm).
- `DIRECTOR_OWN_TOOLS`, đúng tên và mô tả tiếng Anh sau:
  - `director_wait`: "Wait for new user messages (CLI or Web), issue-queue changes or Runtime events. Arguments: cursor (from the previous result; omit on first call), timeoutMs (optional). Returns immediately when something is pending; call it again with the returned cursor."
  - `director_say`: "Send a message to the user. It is shown in the Web chat and stored in the shared transcript. Arguments: text, runId (optional)."
  - `director_note_user_message`: "Record a message the user typed in this CLI when no hook recorded it. Arguments: text."
  - `list_issues`: "List the issue queue. Arguments: status (optional array of open|retrying|resolved|dismissed; default open and retrying)."
  - `inspect_issue`: "Read one queued issue with its evidence references. Arguments: issueId."
  - `set_issue_status`: "Mark a queued issue retrying, resolved or dismissed after you acted on it. Arguments: issueId, status."
- `invoke` luôn `store.authenticate(token)` trước (lỗi ⇒ để `DirectorAuthError` lan ra), rồi `store.heartbeat(token, false)` cho mọi tool trừ `director_wait`. Đối số parse bằng schema Zod strict riêng cho từng tool của Director; đối số sai ⇒ ném lỗi Zod. Kết quả trả về là JSON thuần (parse bằng `JsonValueSchema` hoặc schema contract tương ứng).
- **Coordinator pass-through:** tên nằm trong `DIRECTOR_TOOLS` và thuộc `COORDINATOR_TOOLS` ⇒ `coordinator.invoke(name, input)`, trả nguyên kết quả. `report_progress` hoặc tên lạ ⇒ `Error("Unknown Director tool: <name>")`.
- **director_wait** (`{ cursor?: string; timeoutMs?: number }`):
  - Cursor có dạng `m<messageSeq>.i<issuesRevision>.r<runtimeCursor base64url>`. Không có cursor ⇒ dùng `m0.i<revision hiện tại>.r` (tin cũ của người dùng được trả về một lần; issue chỉ trả khi đổi). Sai định dạng ⇒ `Error("Invalid director cursor")`.
  - `timeoutMs` mặc định là `maxWaitMs`; kẹp vào `[DIRECTOR_LIMITS.waitMinMs, maxWaitMs]`.
  - Đặt heartbeat `waiting=true` khi bắt đầu chờ và `waiting=false` khi trả về, kể cả khi có lỗi (`finally`).
  - Thu thập: tin `author: "user"` có `seq` lớn hơn con trỏ (tin của Director bỏ qua nhưng vẫn đẩy con trỏ seq); nếu `issuesRevision` khác thì trả mọi issue `open` và `retrying`, ngược lại `[]`; sự kiện runtime từ port (nếu có).
  - Đã có gì đang chờ ⇒ trả ngay `timedOut: false`. Nếu không thì chạy song song `store.waitForChange` và `runtimeEvents.wait` với cùng một `AbortController`; bên nào xong trước thì abort bên kia, thu thập lại và trả kết quả. Hết giờ mà không có gì ⇒ `timedOut: true` với mảng rỗng.
  - Kết quả parse bằng `DirectorWaitResultSchema`; cursor mới phản ánh seq/revision/runtime cursor mới nhất.
- **director_say** `{ text, runId? }` ⇒ `appendMessage({author:"director", channel:"cli", ...})`, trả `{ seq, messageId }`.
- **director_note_user_message** `{ text }` ⇒ nếu tin người dùng cuối cùng có `channel: "cli"`, text giống hệt (sau `trim()`) và `at` cách `now` không quá 10 000 ms thì không ghi, trả `{ recorded: false, duplicate: true }`; ngược lại ghi `author:"user", channel:"cli"`, trả `{ recorded: true, seq }`.
- **list_issues / inspect_issue / set_issue_status** gọi store tương ứng; `inspect_issue` id lạ ⇒ `Error("Unknown director issue <id>")`; `set_issue_status` chỉ nhận `retrying | resolved | dismissed`.

Test dùng `DirectorStore` thật trên thư mục tạm và port giả (ghi lại lời gọi):
1. `DIRECTOR_TOOLS` không có `report_progress`, có đủ 6 tool riêng, không trùng tên, có `propose_workflow`.
2. Token sai ⇒ `DirectorAuthError`, coordinator không được gọi.
3. `propose_workflow` chuyển nguyên input sang coordinator và trả nguyên kết quả; `report_progress` ⇒ "Unknown Director tool".
4. `director_wait` không cursor sau khi có hai tin user và một tin director ⇒ trả đúng hai tin user, `timedOut:false`; gọi lại với cursor trả về và `timeoutMs: 1000` ⇒ `timedOut:true`, mảng rỗng.
5. `director_wait` đang chờ được đánh thức bởi `appendMessage` của user (không phải director) trước khi hết giờ; trong lúc chờ `store.presence()` là `waiting`, xong thì về `active`.
6. `director_wait` trả issue `open` khi revision đổi, không trả lại khi revision không đổi.
7. `director_wait` với port runtime giả trả một sự kiện ⇒ có trong `runtimeEvents`, và runtime cursor được mã hóa trong cursor mới.
8. Cursor sai ⇒ "Invalid director cursor"; `timeoutMs` 999999 bị kẹp về `maxWaitMs` (kiểm bằng `maxWaitMs: 1000` và đo thời gian chờ ≤ 1500 ms).
9. `director_note_user_message` khử trùng lặp trong 10 s, sau 10 s thì ghi.
10. `set_issue_status` với `"open"` bị từ chối.

Kiểm: `pnpm exec tsc -b packages/runtime --pretty false` và `pnpm exec vitest run packages/runtime/test/director/tools.test.ts packages/runtime/test/director/store.test.ts`.

---

### Task 4: Bộ vẽ pane tiến trình (`packages/runtime/src/director/progress.ts`)

**Mô hình:** Sonnet.

**Tệp:** tạo `packages/runtime/src/director/progress.ts`, `packages/runtime/test/director/progress.test.ts`; thêm `export * from "./progress.js";` vào `packages/runtime/src/director/index.ts`.

Hàm thuần, không IO:

```ts
export interface ProgressRenderOptions { readonly width: number; readonly height: number; readonly now: Date }
export function renderDirectorProgress(snapshot: DirectorProgressSnapshot, options: ProgressRenderOptions): string[];
```

- Parse `snapshot` bằng `DirectorProgressSnapshotSchema` trước. `width < 20` coi như 20; `height < 3` coi như 3.
- Dòng theo thứ tự, kèm độ ưu tiên (số nhỏ = quan trọng hơn):
  1. (p0) Tiêu đề: `BFLOW · Director <nhãn>`, nhãn: `active` → `đang hoạt động`, `waiting` → `đang chờ sự kiện`, `absent` → `vắng mặt — mở CLI và chạy /bflow-start`.
  2. (p0) `CẦN BẠN: <a> phê duyệt · <q> câu hỏi · <i> lỗi chờ xử lý`, với `i` = số issue `open`. Cả ba bằng 0 ⇒ `CẦN BẠN: không có — máy đang làm`.
  3. Mỗi run (giữ thứ tự đầu vào): (p1) `▸ <title> [<bar>] <done>/<total> · <nhãn sdlcStatus>`. `done` = số task `succeeded`, `total` = số task. Bar dài 10 ô, `█` đã xong, `░` còn lại, làm tròn xuống; `total = 0` ⇒ 10 ô `░`. Nhãn sdlcStatus: intake `tiếp nhận`, clarifying `làm rõ`, specifying `đặc tả`, planning `lập kế hoạch`, tdd_deciding `chọn TDD`, implementing `thực hiện`, verifying `kiểm chứng`, reviewing `review`, awaiting_approval `chờ duyệt`, completed `hoàn tất`, escalated `cần người`, failed `thất bại`, cancelled `đã hủy`.
  4. Dưới mỗi run, mỗi task `running`, `retrying` hoặc `waiting` (p2): `  · <role hoặc "—"> <title> · <nhãn> <thời gian>`. Nhãn: running `đang chạy`, retrying `thử lại`, waiting `chờ`. Thời gian từ `startedAt` tới `now`: `<1 phút` khi dưới 60 s, `N phút` khi dưới 60 phút, `Nh MMp` khi từ 60 phút trở lên (ví dụ `1h 05p`); không có `startedAt` thì bỏ phần thời gian.
  5. Mỗi task `blocked` hoặc `failed` (p2): `  ! <title> · <bị chặn|thất bại>`.
  6. Nếu có issue `open`/`retrying`: (p1) `HÀNG ĐỢI LỖI (<n>)`, rồi mỗi issue (p3) `  #<8 ký tự đầu issueId> <summary>`, theo thứ tự `createdAt` tăng dần.
- **Vừa khung:** nếu số dòng lớn hơn `height`, bỏ dòng p3 từ cuối lên, rồi p2, rồi p1, cho tới khi vừa; không bao giờ bỏ p0. Khi đã bỏ ít nhất một dòng, dòng cuối cùng còn lại (không phải p0) được thay bằng `… còn <k> dòng` (k = tổng số dòng đã bỏ, cộng 1 cho chính dòng bị thay). Nếu chỉ còn dòng p0 thì không thêm.
- **Cắt chiều ngang:** mọi dòng dài hơn `width` (đếm theo code point, `Array.from`) được cắt còn `width - 1` code point cộng `…`.

Test (snapshot tự dựng, `now` cố định):
1. Director vắng, không run ⇒ đúng 2 dòng: tiêu đề với nhãn vắng mặt, `CẦN BẠN: không có — máy đang làm`.
2. Một run 3/9 task xong ⇒ bar `███░░░░░░░` và `3/9`; nhãn `thực hiện`.
3. Task `running` bắt đầu 65 phút trước ⇒ chứa `1h 05p`; 30 s trước ⇒ `<1 phút`; 5 phút ⇒ `5 phút`.
4. Issue: 2 `open` + 1 `resolved` ⇒ `HÀNG ĐỢI LỖI (2)` và đúng 2 dòng `#`; dòng CẦN BẠN có `2 lỗi chờ xử lý`.
5. `height: 4` với nhiều dòng ⇒ đúng 4 dòng, hai dòng đầu là p0, dòng cuối bắt đầu bằng `… còn`, các dòng p3 bị bỏ trước p2.
6. `width: 20` ⇒ mọi dòng có tối đa 20 code point, dòng bị cắt kết thúc bằng `…`.
7. Snapshot sai schema ⇒ ném lỗi Zod.

Kiểm: `pnpm exec tsc -b packages/runtime --pretty false` và `pnpm exec vitest run packages/runtime/test/director/progress.test.ts`.

---

### Task 5: Nội dung skill `bflow-start` (`apps/cli/src/director-skill.ts`)

**Mô hình:** Haiku (chép mã).

**Tệp:** tạo `apps/cli/src/director-skill.ts`, `apps/cli/test/director-skill.test.ts`.

```ts
export const BFLOW_START_SKILL_VERSION = "1.0.0";
export interface BflowStartSkillInput { readonly bflowCommand: readonly string[] }
export function renderBflowStartSkill(input: BflowStartSkillInput): string;
```

`bflowCommand` là argv tuyệt đối (ví dụ `["/usr/bin/node", "/opt/bflow/apps/cli/dist/bin.js"]`). Hàm nối argv bằng shell quoting POSIX (mỗi phần tử bọc `'…'`, dấu `'` bên trong thay bằng `'\''`) thành chuỗi `CMD`, rồi trả nguyên văn mẫu dưới đây với `{{CMD}}` thay bằng `CMD` và `{{VERSION}}` thay bằng `BFLOW_START_SKILL_VERSION`. Rỗng hoặc có phần tử không tuyệt đối ở vị trí 0 ⇒ ném `Error("bflowCommand must start with an absolute executable path")`.

Mẫu (giữ nguyên từng dòng, kể cả frontmatter):

````markdown
---
name: bflow-start
description: Start or resume the Bflow Director for this repository. Use when the user types /bflow-start or $bflow-start, asks to start Bflow, open a Bflow session, or run the SDLC workflow for this repository.
---

<!-- bflow-start {{VERSION}} — generated by `bflow init`; edit through `bflow init --update`. -->

# Bflow Director

You are the Bflow Director for this repository: the single agent the user talks to. You plan the work, delegate it to the Bflow specialist roles running in Herdr, keep the workflow moving, and report back. The Bflow Runtime enforces specifications, quality gates, leases and human approvals; you drive it through its tools.

## 1. Start

1. Run this shell command and read its JSON output:

   {{CMD}} director start --json

2. If `ok` is false, tell the user the exact `message` and the `fix` it gives, then stop.
3. Remember `token` and `cursor` from the output. Pass the token as the `token` argument of every Bflow tool call. Never show the token to the user.
4. Tools: use the MCP tools of the `bflow` server when they are available. Otherwise call the same tool through the shell:

   {{CMD}} director call <tool> --token <token> --json '<arguments as JSON>'

## 2. Work loop

Repeat until the user tells you to stop:

1. Call `director_wait` with the latest `cursor`. It returns user messages from the Web chat, issue-queue changes and Runtime events.
2. For each user message, from this CLI or from the Web: clarify only what is ambiguous, then use `assess`, `propose_workflow`, `request_specialist`, `tick` and the other tools to get the work done.
3. Send every answer meant for the user through `director_say` as well as writing it here, so the Web chat shows the same conversation.
4. When the user types a message in this CLI, call `director_note_user_message` with it before acting, unless a hook already recorded it (a duplicate is ignored safely).
5. Keep the latest `cursor` from each result.

## 3. Keep the flow moving

- A stuck task must not stop unrelated work. Use `inspect`, `reconcile_delivery`, `retry_verification`, `resume_run` and `request_specialist` to unblock it.
- When you cannot unblock a task in reasonable time, leave it in the issue queue (`list_issues`, `inspect_issue`, `set_issue_status`), tell the user in one line, and continue with the rest of the workflow.
- Never resend a message whose delivery is uncertain until `reconcile_delivery` proves it was not delivered.

## 4. Rules

- Do not edit source code, tests or documentation yourself. Give implementation and fixes to a Developer through the workflow, even for a one-line change. Independent verification only works when the author is not the reviewer.
- Do not write evidence or mark a quality gate as passed.
- You cannot approve on the user's behalf. When the Runtime needs a human approval, show the user the approval card and tell them to approve it in Bflow Web or by typing `! bflow approve <code>` in this CLI.
- Answer in the user's language. Keep updates short and concrete.
````

Test:
1. Kết quả bắt đầu bằng `---\nname: bflow-start\n`.
2. Với `["/usr/bin/node", "/opt/b flow/bin.js"]`, kết quả chứa `'/usr/bin/node' '/opt/b flow/bin.js' director start --json` và không còn chuỗi `{{`.
3. Phần tử có `'` được quote đúng: `["/x/it's"]` ⇒ chứa `'/x/it'\''s'`.
4. `[]` và `["node"]` ⇒ ném lỗi đã nêu.
5. Chứa `1.0.0`.

Kiểm: `pnpm exec tsc -b apps/cli --pretty false` và `pnpm exec vitest run apps/cli/test/director-skill.test.ts`.

---

### Task 6: Bộ lập kế hoạch tệp repo cho `bflow init` (`apps/cli/src/director-repo-files.ts`)

**Mô hình:** Sonnet.

**Tệp:** tạo `apps/cli/src/director-repo-files.ts`, `apps/cli/test/director-repo-files.test.ts`. Dùng `renderBflowStartSkill` (Task 5). Chưa nối vào lệnh `init` (lát B).

```ts
export type DirectorProvider = "claude" | "codex" | "agy";
export interface DirectorRepoFilesInput { readonly repositoryRoot: string; readonly bflowCommand: readonly string[]; readonly providers: readonly DirectorProvider[] }
export type DirectorRepoFileStatus = "missing" | "current" | "modified";
export interface DirectorRepoFileCheck { readonly path: string; readonly status: DirectorRepoFileStatus }
export function directorRepoFilePaths(providers: readonly DirectorProvider[]): string[];
export async function applyDirectorRepoFiles(input: DirectorRepoFilesInput): Promise<{ written: string[] }>;
export async function checkDirectorRepoFiles(input: DirectorRepoFilesInput): Promise<DirectorRepoFileCheck[]>;
export async function removeDirectorRepoFiles(repositoryRoot: string): Promise<{ removed: string[]; kept: string[] }>;
```

Gọi `B = bflowCommand`. Đơn vị Bflow quản lý cho từng provider (đường dẫn tương đối repo, dùng `/`):

- **claude:**
  - `.claude/skills/bflow-start/SKILL.md`: toàn bộ tệp là nội dung skill.
  - `.mcp.json`: khóa JSON `mcpServers.bflow = { "command": B[0], "args": [...B.slice(1), "director", "mcp"] }`.
  - `.claude/settings.local.json`: phần tử `"bflow"` trong mảng `enabledMcpjsonServers`, và một mục trong `hooks.UserPromptSubmit`: `{ "hooks": [{ "type": "command", "command": "<CMD> director hook claude" }] }`, với `<CMD>` là argv B đã quote POSIX như Task 5 (tách hàm quote thành export dùng chung `shellQuoteArgv` trong `director-skill.ts`).
- **codex:**
  - `.agents/skills/bflow-start/SKILL.md`: toàn tệp.
  - `.codex/config.toml`: một khối có marker:
    ```
    # >>> bflow director >>>
    [mcp_servers.bflow]
    command = <B[0] dạng chuỗi TOML basic, escape \ và ">
    args = [<các phần tử còn lại>, "director", "mcp"]
    default_tools_approval_mode = "approve"
    tool_timeout_sec = 330
    # <<< bflow director <<<
    ```
  - `.codex/hooks.json`: một mục trong `hooks.UserPromptSubmit` giống Claude nhưng lệnh là `<CMD> director hook codex`.
- **agy:** `.agents/skills/bflow-start/SKILL.md` (dùng chung với codex). Chưa ghi MCP hay hook cho agy: theo spike, agy không có MCP repo scope, còn định dạng hook chưa kiểm live.
- **luôn có:** `.gitignore`: khối `# >>> bflow director >>>` … `# <<< bflow director <<<` liệt kê từng đường dẫn tệp được ghi (một dòng mỗi tệp, sắp xếp), kèm `.bflow/director-files.json`.

Quy tắc:
- **Đường dẫn an toàn:** mọi tệp đích phải nằm trong `repositoryRoot` sau `realpath` của thư mục cha; thư mục cha hay tệp đích là symlink ⇒ ném `Error("Refusing to write through a symlink: <path>")`.
- **Gộp, không đè:** JSON đang có được parse và chỉ đổi đúng các đơn vị Bflow ở trên; mọi khóa khác giữ nguyên, ghi lại với thụt lề 2 và `\n` cuối. JSON không parse được ⇒ ném `Error("Cannot merge <path>: invalid JSON")` và không ghi tệp nào (kiểm hết trước khi ghi). Mục hook của Bflow được nhận diện bằng chuỗi lệnh kết thúc bằng ` director hook claude` / ` director hook codex`; ghi lại thì thay mục cũ chứ không nhân đôi. Mảng `enabledMcpjsonServers` không bị nhân đôi `"bflow"`. Khối TOML/gitignore có marker thì thay nội dung giữa marker; chưa có thì nối vào cuối (thêm `\n` phân cách nếu tệp không kết thúc bằng `\n`).
- **Receipt** `.bflow/director-files.json` (mode `0o644`): `{ "schemaVersion": 1, "skillVersion": BFLOW_START_SKILL_VERSION, "providers": [...], "units": [{ "path", "kind": "file" | "json-key" | "toml-block" | "gitignore-block", "sha256" }] }`. `sha256` là hash của **phần Bflow sở hữu**: toàn tệp với `file`, `JSON.stringify` (không thụt lề) của giá trị đơn vị với `json-key`, nội dung giữa marker với khối. Một tệp có nhiều đơn vị JSON thì mỗi đơn vị là một mục (`.claude/settings.local.json` có 2 mục).
- **apply** ghi mọi đơn vị cho `providers`, ghi receipt, trả `written` là danh sách tệp đã đổi nội dung (sắp xếp). Chạy lại với cùng input ⇒ `written` rỗng (idempotent, không đổi byte nào).
- **check** trả trạng thái cho từng tệp trong `directorRepoFilePaths(providers)` cộng `.gitignore`: `missing` khi đơn vị không có, `modified` khi hash phần Bflow khác giá trị mong đợi của input hiện tại, ngược lại `current`.
- **remove** đọc receipt: với mỗi đơn vị mà hash hiện tại trùng hash trong receipt thì gỡ (xóa tệp `file`; xóa khóa/mục JSON và xóa tệp nếu thành `{}`; xóa khối marker); khác hash thì giữ và ghi vào `kept`. Sau đó xóa receipt. Không có receipt ⇒ `{ removed: [], kept: [] }`. Thư mục rỗng do gỡ tệp (`.claude/skills/bflow-start`, `.agents/skills/bflow-start`) thì xóa.

Test trên repo tạm (`mkdtemp`, không cần git):
1. `providers: ["claude","codex","agy"]` ⇒ tạo đủ tệp; `.mcp.json` có `mcpServers.bflow.args` kết thúc bằng `["director","mcp"]`; `.codex/config.toml` có đúng một khối marker với `tool_timeout_sec = 330`; chỉ một `SKILL.md` dưới `.agents/skills/bflow-start`; `.gitignore` có khối liệt kê đường dẫn.
2. `.mcp.json` có sẵn server `other` và `.claude/settings.local.json` có sẵn `permissions` ⇒ giữ nguyên sau apply.
3. Apply hai lần ⇒ lần hai `written: []`, nội dung byte giống hệt, không có hook trùng và không có `"bflow"` trùng.
4. `.codex/config.toml` có sẵn nội dung người dùng ⇒ giữ nguyên phần ngoài marker; đổi `bflowCommand` rồi apply ⇒ khối được thay, không nhân đôi.
5. `.mcp.json` hỏng ⇒ ném lỗi và không tệp nào được tạo.
6. check: trước apply toàn `missing`; sau apply toàn `current`; sửa tay `SKILL.md` của claude ⇒ tệp đó `modified`.
7. remove sau khi sửa tay `SKILL.md` của claude ⇒ tệp đó nằm trong `kept`, các tệp khác bị gỡ, `.mcp.json` có server `other` vẫn còn với `other`, `.gitignore` không còn khối marker, receipt bị xóa.
8. Symlink: `.claude` là symlink ra ngoài repo ⇒ ném "Refusing to write through a symlink".

Kiểm: `pnpm exec tsc -b apps/cli --pretty false` và `pnpm exec vitest run apps/cli/test/director-repo-files.test.ts apps/cli/test/director-skill.test.ts`.
