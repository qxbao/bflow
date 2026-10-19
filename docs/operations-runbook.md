# Bflow Platform v3 — Operations Runbook

Sổ tay vận hành này cung cấp quy trình chuẩn để khởi chạy, giám sát, xử lý sự cố và khôi phục hệ thống Bflow Platform v3 trong quá trình vận hành thực tế.

---

## 1. Kiến trúc vận hành và Các tiến trình thành phần

Một phiên làm việc Bflow v3 đang hoạt động bao gồm 4 lớp tiến trình độc lập:
1. **Herdr Session Daemon (`herdr --session <session-name> server`)**: Quản lý workspace, 3 tabs (`Conversation`, `Coordination`, `Verification`), 7 permanent role panes (`conversation`, `coordinator`, `specifier`, `architect`, `planner`, `reviewer`, `qa`) và các pane `developer` sinh động theo task.
2. **Bflow Persistent Agentic Host (`packages/runtime/src/agentic/host.ts`)**: Tiến trình điều phối trung tâm giữ `SqliteRunStore`, `FilesystemArtifactStore`, `FileAgentRegistry`, `HostPlatformSession`, đối soát MCP Gateway mỗi 30 giây và xác thực chữ ký Ed25519.
3. **Bflow Shared MCP Gateway (`@bflow/mcp-gateway`)**: Chạy dưới dạng dịch vụ người dùng (`systemd --user` `bflow-mcp-gateway.service` hoặc daemon cục bộ) lắng nghe duy nhất trên `127.0.0.1:<port>/mcp`, chia sẻ một tiến trình backend duy nhất cho mỗi dịch vụ (`gitnexus`, `chrome-devtools-mcp`, v.v.) across nhiều agents.
4. **Dedicated Browser Runtime (`@bflow/mcp-services`)**: Quản lý các phiên Chrome cô lập theo từng task (`<stateRoot>/chrome/<repoId>/<taskId>`) với lease độc quyền.

---

## 2. Quy trình Vòng đời Phiên (Session Lifecycle Operations)

### 2.1 Khởi động phiên (`bflow up`)

```bash
TMPDIR=/tmp bflow up
```

**Trình tự kiểm tra nghiêm ngặt khi `bflow up` chạy**:
1. Đọc `.bflow/config.yml` (hoặc tương thích ngược `.bflow/config.yaml` / `.json`) và xác minh quyền riêng tư (`0700`/`0600`) của `.bflow/state`.
2. Thực thi `PlatformReadinessService.preflight()` cho toàn bộ các role được cấu hình:
   - Kiểm tra binary SHA-256, phiên bản, đăng nhập (`auth status` / `login status` / `models` + non-interactive `ping`).
   - Đồng bộ `SkillManifest` gắn với `(sessionId, generation)`.
   - Cấp phát registration và Bearer token ngắn hạn (`<= 1h`) trên Shared MCP Gateway.
   - Tạo `AgentLaunchProfile` và ký chứng thực `Ed25519` (`AgentLaunchAttestation`).
3. Nếu **bất kỳ role bắt buộc nào (`required: true`) không đạt `ready`**, `bflow up` dừng ngay lập tức (fail-closed), thu hồi các registration vừa cấp và tắt session Herdr nếu vừa mới khởi tạo (không để lại daemon mồ côi).
4. Khởi tạo 3 tabs và các pane trên Herdr thông qua Herdr Unix socket API (`workspace.create`, `tab.create`, `pane.split`) để truyền trực tiếp biến môi trường (`BFLOW_LAUNCH_ID`, `BFLOW_MCP_TOKEN_*`) vào tiến trình pane ngay từ lúc fork.
5. Chờ bằng chứng khởi động và kết nối MCP thực tế (`toolReachability`) từ bên trong tiến trình provider (qua hook `SessionStart` hoặc `provider_bootstrap` từ MCP child) trước khi báo `status: "up"`.

### 2.2 Tương tác với hệ thống (`bflow attach`)

```bash
bflow attach
```

- Lệnh `bflow attach` **chỉ gắn terminal của người dùng vào pane `conversation`** (Conversation Agent).
- Người dùng **không bao giờ** chat trực tiếp vào pane của `coordinator`, `developer`, `reviewer` hay `qa`. Mọi yêu cầu làm rõ (`clarification_question`) và phê duyệt (`approval.request`) đều được định tuyến về pane `conversation`.

### 2.3 Kiểm tra trạng thái (`bflow status`, `mcp status`, `tool status`)

```bash
# Trạng thái session Herdr, các role panes và các workflow runs đang chạy:
bflow status --json

# Trạng thái kết nối Shared MCP Gateway và các dịch vụ backend:
bflow mcp status --json

# Trạng thái các công cụ đã cài đặt (rtk, gitnexus, mempalace, chrome):
bflow tool status --json
```

### 2.4 Dừng phiên an toàn (`bflow down`)

```bash
# Dừng an toàn (từ chối nếu còn workflow run đang chạy dở):
bflow down

# Cưỡng bức dừng sau khi đã ghi aggregate checkpoint xuống SQLite:
bflow down --yes
```

**Bảo đảm khi chạy `bflow down`**:
- Nếu có run đang ở trạng thái active và không truyền `--yes`, lệnh trả lỗi `Unsafe shutdown: N active runs` và không tắt bất kỳ thành phần nào.
- Khi dừng hợp lệ, host thực hiện: `quiesce` $\to$ ghi `bflow.workflow-aggregate+json` checkpoint xuống SQLite $\to$ thu hồi toàn bộ MCP Gateway registrations của session $\to$ đóng các role panes $\to$ dừng Herdr session server (`herdr session stop`) $\to$ bảo toàn các Git worktree có thay đổi chưa commit (`dirty`/`ignored`).
- Không bao giờ tự ý tắt worker bên ngoài không do Bflow sở hữu (ví dụ một worker do host cung cấp được nhận diện ở chế độ `adopted`).

---

## 3. Các lệnh điều hành cấp cao (Unified Commands & Exit Codes)

| Lệnh | Mục đích vận hành | Lưu ý quan trọng |
| :--- | :--- | :--- |
| `bflow repo inspect` | Thu thập cấu trúc repository, nhánh Git, trạng thái chỉ mục | Chỉ đọc |
| `bflow task plan --objective "<mô tả>"` | Sinh `Specification` (SDD) và quyết định `TddDecision` | Ghi nhận qua `SpecificationEngine` & `TestStrategyResolver` |
| `bflow task implement --task-id <id>` | Chuẩn bị worktree và môi trường thực thi cho task | Tuân thủ chặt chẽ Red-Green-Refactor nếu `required` |
| `bflow verify --task-id <id>` | Chạy vòng lặp kiểm chứng độc lập (Quality Gates + Reviewer/QA) | Tối đa `maxIterations` (mặc định 3) |
| `bflow git prepare --task-id <id>` | Kiểm tra phạm vi file thay đổi (`ownedPaths`) và chuẩn bị tích hợp nhánh | Dừng ở cổng phê duyệt nếu yêu cầu human approval |
| `bflow skills sync` | Đồng bộ lại `skills-store` và kiểm tra digest của 32 skills | Idempotent |
| `bflow agent check [provider]` | Kiểm tra preflight health của `claude`, `codex`, `agy` | Không khởi chạy Herdr |

### Bảng mã thoát chuẩn (Standard CLI Exit Codes)

| Exit Code | Ý nghĩa | Hành động khuyến nghị cho Operator |
| :---: | :--- | :--- |
| `0` | Thành công (`ok: true`) | Tiếp tục quy trình |
| `1` | Lỗi thực thi chung / Check thất bại | Xem chi tiết trong trường `error` hoặc `diagnostics` (`--json`) |
| `2` | Sai cú pháp lệnh / Tham số không hợp lệ (`usage`) | Chạy `bflow --help` |
| `3` | Thành phần chưa sẵn sàng (`not_ready`) | Chạy `bflow doctor` và `bflow agent check` |
| `4` | Không tìm thấy tài nguyên (`not_found`) | Kiểm tra `runId`, `taskId` hoặc chạy `bflow init` |
| `5` | Cần quyền phê duyệt của con người (`permission_required`) | Phê duyệt qua `bflow attach` (Conversation) hoặc truyền `--yes` cho `setup`/`down` |
| `6` | Xung đột trạng thái / Lease bận (`conflict`) | Chờ tác vụ đang giữ lease hoàn tất hoặc chạy `bflow recover` |
| `7` | Trạng thái không xác định cần đối soát (`unknown_state`) | **Không** tự động chạy lại tác vụ gây biến đổi; chạy `bflow recover` để đối soát |

---

## 4. Quy trình xử lý sự cố và Khôi phục (Incident Response & Recovery)

### 4.1 Sự cố: Host hoặc Herdr bị crash đột ngột (`SIGKILL` / mất điện)

1. **Tuyệt đối không xóa `.bflow/state/runs.db` hoặc thư mục `journal`**.
2. Khởi động lại môi trường và chạy đối soát:
   ```bash
   TMPDIR=/tmp bflow up
   bflow recover
   ```
3. **Cơ chế tự phục hồi**:
   - Khi daemon `AgenticHost` mới khởi động, nó tự động thu hồi (`retire`) các `launchId` và MCP registrations cũ của daemon trước (vốn giữ khóa/token trong bộ nhớ của tiến trình đã chết) và ghi nhận vào `platform_status.restartRecovery`.
   - `DeterministicWorkflowEngine.recover()` nạp lại aggregate checkpoint và replay phần đuôi sự kiện từ SQLite.
   - Các lệnh gửi đi đang ở trạng thái `unknown_delivery` sẽ được đối soát với sổ cái Herdr (`reconcile`): nếu đã gắn với tiến trình thực (`bound`) thì tiếp tục theo dõi mà **không gửi trùng**; chỉ khi chứng minh được `not_delivered` mới cho phép gửi lại.
   - Các phê duyệt của con người (`human_approval`) và kết quả kiểm chứng đã fsync vào sổ cái riêng được khôi phục chính xác mà không cần chạy lại test.

### 4.2 Sự cố: Shared MCP Gateway hoặc Stdio Backend bị treo / khởi động lại

- **Hiện tượng**: Tiến trình backend (ví dụ `gitnexus mcp`) bị crash, hoặc dịch vụ `bflow-mcp-gateway.service` bị `systemd` khởi động lại.
- **Cơ chế tự động của Bflow**:
  - Nếu một child backend stdio chết (`SIGKILL`), `BflowMcpGateway` tự động khởi chạy lại tiến trình mới ở lệnh `tools/call` kế tiếp và tăng `revision` của dịch vụ mà không làm đứt các registration của agent.
  - Nếu toàn bộ `GatewayHttpServer` khởi động lại (làm mất bảng registration trong RAM), vòng lặp đối soát 30 giây của `AgenticHost` (`reconcileGatewayRegistrations`) sẽ phát hiện các `lost` registrations, chuyển trạng thái launch của role đó sang `degraded` (`reason: "gateway_registration_lost"`), và **giữ các thông điệp mới trong outbox** thay vì giao việc cho một agent đã mất kết nối MCP.
- **Cách khắc phục của Operator**:
  ```bash
  systemctl --user status bflow-mcp-gateway.service
  TMPDIR=/tmp bflow up
  ```
  Lệnh `bflow up` sẽ cấp lại registration mới và khôi phục trạng thái `activated` cho các role.

### 4.3 Sự cố: Chrome Profile bị khóa (`profile_locked`) hoặc xung đột trang (`page_ownership_conflict`)

- **Nguyên nhân**: Tiến trình Chrome của một task trước chưa thoát hẳn và vẫn giữ `SingletonLock` trong `<stateRoot>/chrome/<repoId>/<taskId>`.
- **Cách xử lý**:
  1. Kiểm tra xem còn tiến trình Chrome nào đang chạy với `--user-data-dir` của task đó không:
     ```bash
     ps aux | grep "chrome/<repoId>/<taskId>"
     ```
  2. Nếu tiến trình đã treo và task đã kết thúc, kết thúc tiến trình Chrome đó (`kill -TERM <pid>`) rồi xóa file `SingletonLock` trong thư mục profile của task. **Không bao giờ** trỏ cấu hình trình duyệt của Bflow vào `~/.config/google-chrome` cá nhân.

### 4.4 Sự cố: Lỗi `codex_global_hooks_not_isolated` khi khởi chạy role dùng Codex

- **Nguyên nhân**: Máy host có file `~/.codex/hooks.json` chưa được phê duyệt theo SHA-256 hoặc có cấu hình `[[hooks.*]]` trong `~/.codex/config.toml`.
- **Cách xử lý**:
  1. Xem chi tiết các hook toàn cục và phê duyệt tường minh bằng lệnh:
     ```bash
     bflow setup --codex-hooks --plan
     bflow setup --codex-hooks --apply
     ```
  2. Hoặc di chuyển `~/.codex/hooks.json` / cấu hình `CODEX_HOME` riêng cho Codex trước khi chạy `bflow up`.
