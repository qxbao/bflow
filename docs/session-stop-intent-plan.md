# Kế hoạch: dừng phiên là ý định của người dùng, không phải sự cố cần khôi phục

- Trạng thái: **đã được chủ dự án yêu cầu thực hiện** (2026-11-09). Chủ dự án cho phép sửa `apps/cli/**` (P29) và `agents/director/**` cho phạm vi này.
- Phạm vi: `apps/cli/src/**`, `apps/cli/test/**`, `agents/director/system-prompt.md`, tài liệu này.
- Không đổi: `packages/contracts/**`, `packages/runtime/**`, lockfile, cấu hình gốc.
- Mức bằng chứng hiện tại: kế hoạch. Chưa có mã nguồn, chưa có test, chưa có xác nhận live.

## 1. Sự cố

1. Người dùng bấm "Dừng phiên" trên Web. `stopSession` (`apps/cli/src/web-workspace-services.ts:226`) gọi `EnvironmentLifecycle.down(true, undefined, force)`.
2. Một wake đã được watcher Codex xếp vào thread của Director trước hoặc trong lúc dừng. Director xử lý wake, gọi `director_wait`, nhưng socket Runtime đã mất nên nhận `connect ENOENT`.
3. Director tự chạy `bflow director start`. `runStart` (`apps/cli/src/director-commands.ts:210-214`) luôn gọi `deps.ensureUp`, tức là `bflow up`. Phiên người dùng vừa dừng bị khởi động lại.
4. Lần khởi động lại bị timeout. Bước dọn dẹp của `up` gặp workflow đã lưu nhưng chưa đối soát, nên từ chối dừng và giữ trạng thái phục hồi. Director tiếp tục gọi tool và nhận `Bflow host awaits an up SessionManifest` (`packages/runtime/src/agentic/host.ts:869`).
5. Trạng thái lưu cuối cùng là `session.json` có `status: down`, nhưng `operation.json` vẫn ở `phase: stopping`.

## 2. Nguyên nhân đã xác minh trong mã (HEAD `25d64867`)

| # | Chỗ | Hành vi hiện tại |
|---|---|---|
| C1 | `environment.ts:994` (`down`), `web-workspace-services.ts:226` | Dừng phiên (CLI hoặc Web) không hủy watcher Codex. `cancelCodexDirectorWatch` (`director-wake.ts:129`) chỉ được gọi từ `director-commands.ts:217,325,329`. |
| C2 | `director-wake.ts:173-186` (`runCodexDirectorWatch`) | Lỗi `wait` nào cũng thử lại với backoff, trừ `Director token rejected`. Watcher không biết người dùng đã dừng phiên. |
| C3 | `director-commands.ts:210-214` (`runStart`) | `director start` luôn gọi `ensureUp`, không kiểm tra ý định dừng. Lệnh con `up` (`commands.ts:369-372`) cũng vậy. |
| C4 | `director-commands.ts:278-296` (`runMcp`), `runCall` | Lỗi kết nối tới Runtime được trả nguyên văn (`connect ENOENT …`). Model không phân biệt được "người dùng đã dừng" với "Runtime gặp sự cố". |
| C5 | `agents/director/system-prompt.md`, `apps/cli/src/director-skill.ts` | Không có luật "mất kết nối thì kiểm tra trạng thái phiên trước, không tự `director start` hay `bflow up`". |
| C6 | `environment.ts` `downLocked`: nhánh `!running` (khoảng dòng 1110-1140) và nhánh chính (khoảng 1257) | `writeIntent("stopping")` được ghi trước `quiesce`. Nếu `quiesce` từ chối (ví dụ `requires activation/reconciliation before safe shutdown`, tức chưa có gì thay đổi), `operation.json` vẫn kẹt ở `stopping`. |

Phân biệt quan trọng: hàm public `EnvironmentLifecycle.down()` chỉ được gọi khi người dùng dừng (`commands.ts:376` cho CLI, `web-workspace-services.ts:233` cho Web). Bước dọn dẹp sau khi `up` thất bại gọi thẳng `downLocked` (`environment.ts:921,941`). Vì vậy ghi ý định dừng trong `down()` thì không bị nhầm với dọn dẹp tự động.

## 3. Bất biến

- **I1.** Sau khi người dùng dừng phiên, không có đường tự động nào được đưa phiên lên lại: watcher, wake cũ, Director gọi `director start` hay `bflow up` từ ngữ cảnh agent.
- **I2.** Chỉ người dùng mở lại được phiên: "Bắt đầu phiên" trên Web, `bflow up` trong terminal thường, hoặc `--restart` tường minh.
- **I3.** Ý định dừng là trạng thái bền vững trên đĩa. Nó tồn tại qua việc Runtime mất, máy chủ Web khởi động lại, hoặc watcher là tiến trình tách rời.
- **I4.** Nếu `down` bị từ chối mà không có gì thay đổi (`refuseUnchangedStop`), ý định dừng bị xóa, vì phiên vẫn chạy.
- **I5.** Từ chối an toàn không được để lại `operation.json` sai pha.
- **I6.** Giữ nguyên các bất biến lifecycle hiện có: không gửi lại stop chưa xác định, không xóa checkpoint, không buộc dừng khi chưa được phép.

## 4. Thiết kế

### 4.1 Tệp ý định dừng

Module mới `apps/cli/src/user-stop-intent.ts`. Tệp lưu ở `.bflow/state/user-stop.json`, trong cùng thư mục với `operation.json` (`environment.ts:241`, `statePath`):

```ts
const UserStopIntentSchema = z.object({
  version: z.literal(1),
  repositoryId: z.string().min(1),
  sessionName: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  source: z.enum(["cli", "web"]),
  operationId: z.string().min(1).max(200).optional(),
  requestedAt: z.string().datetime()
}).strict();

export async function readUserStopIntent(root: string, repositoryId: string, sessionName: string): Promise<UserStopIntent | undefined>;
export async function writeUserStopIntent(root: string, intent: UserStopIntent): Promise<void>;   // temp + rename, mode 0600
export async function clearUserStopIntent(root: string): Promise<void>;                          // rm force
```

- Đọc phải chặt: `lstat` là tệp thường, kích thước tối đa 4096 byte, parse bằng schema.
- Tệp hỏng không được coi là vắng. Hàm đọc ném lỗi; nơi gọi chọn hướng an toàn (watcher thì dừng, `director start` thì từ chối, kèm hướng dẫn).
- Tệp thuộc repository hoặc phiên khác thì coi là vắng.

### 4.2 Ghi ý định và hủy watcher khi dừng (C1)

- `EnvironmentLifecycle.down(confirmed, timeoutMs, force, origin?: { source: "cli" | "web"; operationId?: string })`. Tham số thứ tư là tùy chọn, mặc định `{ source: "cli" }`, nên caller cũ không đổi.
- Trong `down()`, sau `identifyRepository` và **trước** `downLocked`:
  1. `writeUserStopIntent(...)`.
  2. `cancelCodexDirectorWatch(repository.root, repository.sessionName)`. Lỗi ở bước này không làm hỏng `down`: ghi progress rồi tiếp tục, vì watcher còn tự kiểm tra ý định ở bước 4.3.
- Nếu `down` ném lỗi do `refuseUnchangedStop` (dùng predicate đang có cho `unchangedLifecycleFailures`), gọi `clearUserStopIntent` rồi ném lại (I4). Mọi lỗi khác giữ nguyên ý định, vì phiên có thể đã dừng một phần.
- `web-workspace-services.ts` `stopSession` truyền `{ source: "web", operationId }`.

### 4.3 Watcher tôn trọng ý định dừng (C2)

- `runCodexDirectorWatch` nhận thêm dependency `stopped: () => Promise<boolean>`. Hàm này trả `true` khi có ý định dừng, và cả khi tệp ý định hỏng (hướng an toàn).
- Kiểm tra `stopped()`:
  - đầu mỗi vòng, trước `wait`;
  - sau mỗi lỗi `wait`, trước khi backoff;
  - trong khóa admission, ngay trước `input.queue(...)`.

  Gặp `true` ở bất kỳ chỗ nào: dưới khóa, nếu generation khớp và trạng thái là `armed` hoặc `queueing`, đặt `status: "cancelled"`, rồi `return`. Tuyệt đối không xếp wake.
- `defaultDirectorDeps().watch` nối `stopped` với `readUserStopIntent`.
- `armCodexDirectorWatch` (gọi qua `director_suspend` hoặc `director suspend`) từ chối arm khi có ý định dừng, với lỗi `session_stopped_by_user` như ở 4.5.

### 4.4 `director start` và `up` không tự đưa phiên lên lại (C3)

- Parser: `bflow director start` thêm cờ `--restart`, `bflow up` thêm cờ `--restart`. Cập nhật `help.ts` và `parser.ts`.
- `runStart`, trước `ensureUp`:
  - Có ý định dừng và không có `--restart`: in ra `{ ok: false, code: "session_stopped_by_user", message, fix }` rồi trả `CLI_EXIT_CODES.RUNTIME_ERROR`.
    - `message`: "Người dùng đã dừng phiên Bflow lúc <requestedAt> (<source>). Director không tự khởi động lại."
    - `fix`: "Báo cho người dùng và kết thúc lượt. Chỉ chạy `bflow director start --restart` khi người dùng yêu cầu khởi động lại trong tin nhắn mới nhất của họ."
  - Có `--restart`: `clearUserStopIntent`, rồi `ensureUp`. Đường `machineEnvironment` (chạy tiến trình con `bin.js up --json`) phải truyền thêm `--restart`.
- Lệnh `bflow up` (`commands.ts:369-372`):
  - Gọi là **ngữ cảnh agent** khi env có `BFLOW_DIRECTOR_TOKEN`, `BFLOW_DIRECTOR_PROVIDER` hoặc `CODEX_THREAD_ID`.
  - Có ý định dừng, đang ở ngữ cảnh agent và không có `--restart`: từ chối với cùng mã `session_stopped_by_user`.
  - Ngoài ngữ cảnh agent (terminal thường), hoặc có `--restart`: xóa ý định rồi `up`.
  - Chọn cách này để người dùng gõ `bflow up` trong terminal vẫn chạy như cũ.
- Web `startSession` (`web-workspace-services.ts:211`): xóa ý định ngay trước `lifecycle.up()`, vì đây là thao tác của người dùng.
- `bflow status`: khi có ý định dừng, thêm một dòng vào `issues`: "Phiên đã được người dùng dừng lúc … (<source>)". Không đổi schema `EnvironmentStatus`.

### 4.5 Tool của Director báo rõ phiên đã dừng (C4)

- Hàm mới trong `director-commands.ts`:

  ```ts
  async function hostCall<T>(repository, call: () => Promise<T>): Promise<T>
  ```

  Bắt lỗi kết nối: code hoặc thông điệp chứa `ENOENT`, `ECONNREFUSED`, `ENOTDIR`, hoặc `Host unavailable`. Khi bắt được và có ý định dừng, ném `Error` với thông điệp bắt đầu bằng `session_stopped_by_user:`, sau đó là cùng nội dung `message` và `fix` ở 4.4. Không có ý định dừng thì ném lại lỗi gốc, không đổi hành vi hiện tại.
- Dùng `hostCall` trong `runMcp` (mọi tool, kể cả nhánh `director_suspend`), `runCall` và `runSuspend`.
- Wake cũ đến sau khi dừng (C2 không thu hồi được tin đã gửi) vẫn bị chặn: lần `director_wait` kế tiếp nhận thông điệp `session_stopped_by_user` thay cho `connect ENOENT`.

### 4.6 Luật cho Director (C5)

Thêm vào `agents/director/system-prompt.md` và nội dung skill khởi động do `apps/cli/src/director-skill.ts` sinh ra. Giữ giọng văn và cấu trúc đánh số hiện có:

- Lỗi bắt đầu bằng `session_stopped_by_user` nghĩa là người dùng đã dừng phiên. Báo cho người dùng một câu, không gọi `director start`, `bflow up` hay `director_suspend`, rồi kết thúc lượt.
- Mất kết nối Runtime vì lý do khác (`ENOENT`, `ECONNREFUSED`, `Host unavailable`): chạy `bflow status` để đọc trạng thái, báo cho người dùng, và hỏi trước khi khởi động lại. Không tự phục hồi bằng `director start`.
- Chỉ dùng `--restart` khi tin nhắn mới nhất của người dùng yêu cầu khởi động hoặc mở lại phiên.
- Lưu ý chung cho nội dung skill: chỉ đặt lệnh trong backtick, không đặt đường dẫn tệp trong backtick. Nếu skill có số phiên bản thì nâng phiên bản.

### 4.7 Không để `operation.json` sai pha khi từ chối an toàn (C6)

- Trong `downLocked`, tại mọi chỗ `writeIntent(repository, "stopping")` đứng ngay trước `quiesce`:
  - Đọc `prior = await this.intent(repository)` trước khi ghi.
  - Bọc riêng lời gọi `quiesce`. Nếu nó ném lỗi (chưa có gì thay đổi), khôi phục `operation.json` về `prior` (giữ cả `serverPid`), hoặc xóa tệp nếu `prior` là `null`, rồi ném lại.
- Chỉ áp dụng cho lỗi của `quiesce`. Lỗi sau khi rào chắn đã đứng (checkpoint, manager down, Herdr stop) giữ nguyên `stopping`, vì khi đó đã có thay đổi thật và lần `down` sau phải đối soát.

## 5. Các bước

Mọi đường dẫn tương đối tính từ gốc worktree. Viết test trước cho từng bước.

| Bước | Nội dung | Test |
|---|---|---|
| S1 | `user-stop-intent.ts` (4.1) | `apps/cli/test/user-stop-intent.test.ts`: ghi/đọc/xóa; tệp hỏng ném lỗi; tệp của repo khác coi là vắng; symlink bị từ chối |
| S2 | Ghi ý định và hủy watcher trong `down` (4.2) | `environment.test.ts`: `down` thành công ghi ý định và đặt watcher `cancelled`; `refuseUnchangedStop` xóa ý định; lỗi sau rào chắn giữ ý định. `web-lifecycle.test.ts`: stop từ Web ghi `source: "web"` và `operationId` |
| S3 | Watcher (4.3) | `director-wake.test.ts`: `wait` ném ENOENT khi đã có ý định dừng thì watcher `cancelled`, không gọi `queue`; có ý định trước vòng đầu thì không gọi `wait`; ý định xuất hiện giữa admission thì không `queue`; arm khi đã dừng bị từ chối |
| S4 | `director start` và `up` (4.4) | `director-commands.test.ts`: có ý định thì `ensureUp` không được gọi và JSON có `code: "session_stopped_by_user"`; `--restart` thì xóa ý định rồi gọi `ensureUp`. Test parser cho cờ mới. Test lệnh `up` trong ngữ cảnh agent và ngoài ngữ cảnh agent. Web `startSession` xóa ý định |
| S5 | `hostCall` (4.5) | `director-commands.test.ts`: `runMcp` hoặc `runCall` với `toolCall` ném `connect ENOENT` trả thông điệp `session_stopped_by_user:` khi có ý định, và lỗi gốc khi không có |
| S6 | Luật Director (4.6) | `director-skill.test.ts` và test prompt hiện có: nội dung chứa luật mới |
| S7 | `operation.json` khi từ chối (4.7) | `environment.test.ts`: `quiesce` ném lỗi thì `operation.json` trở về pha trước |
| S8 | Kịch bản đầu-cuối có giả lập | Test mới: watcher armed → `down` từ Web → wake cũ → `director_wait` qua `runMcp` nhận `session_stopped_by_user` → `director start` không có `--restart` bị từ chối, `ensureUp` chưa từng được gọi |

## 6. Kiểm tra trước bàn giao

```bash
pnpm --filter @bflow/cli build      # hoặc pnpm run build nếu test cần dist của gói khác
pnpm exec vitest run apps/cli/test/user-stop-intent.test.ts apps/cli/test/director-wake.test.ts apps/cli/test/director-commands.test.ts apps/cli/test/environment.test.ts apps/cli/test/web-lifecycle.test.ts apps/cli/test/director-skill.test.ts
pnpm check:deps
pnpm typecheck
pnpm test:affected --base main --run   # integrator chạy, không chạy song song với agent khác
git diff --check
```

Tiêu chí xong:
- Mỗi nguyên nhân C1–C6 có ít nhất một test mới chứng minh đã sửa.
- Test hiện có trong các tệp trên vẫn xanh.
- Không có thay đổi ngoài phạm vi ở đầu tài liệu.

## 7. Chưa làm và rủi ro

- Wake đã nằm trong hàng đợi Codex không thu hồi được. Bảo vệ dựa vào 4.5 và 4.6: lượt đó kết thúc mà không khởi động lại.
- "Ngữ cảnh agent" được nhận diện qua biến môi trường. Người dùng gõ `!bflow up` bên trong phiên Codex sẽ phải thêm `--restart`; thông điệp lỗi nói rõ điều này.
- Provider Claude và Agy không dùng watcher Codex, nhưng vẫn được bảo vệ qua 4.4–4.6.
- Live: cần chạy lại kịch bản trên Web (dừng phiên khi Director Codex đang ngủ) để xác nhận. Hiện mới ở mức kế hoạch.
