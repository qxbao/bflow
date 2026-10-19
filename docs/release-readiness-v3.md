# Bflow Platform v3 — Release Readiness & Audit Report (P24–P34)

> **Ghi chú (lịch sử):** Tài liệu này ghi lại bằng chứng đo tại thời điểm đó, trong đó có Claude-Mem. Bflow không còn hỗ trợ Claude-Mem (thay bằng MemPalace cài thủ công); các số liệu và đường dẫn liên quan đến `claude-mem` chỉ còn giá trị lịch sử và không thể tái tạo từ mã hiện tại.

- **Ngày kiểm toán**: `2026-10-18`
- **Baseline commit (`main`)**: `da9e166d136b199c62f4b862141357180268567c` (gồm cả `ee4ff7c`..`da9e166`)
- **Worktree kiểm toán**: `/tmp/bflow-v3-release-review` (branch `integration/v3-release-review` trên hệ tệp POSIX `ext4`)
- **Môi trường kiểm thử**:
  - OS: Linux `x86_64` (`systemd --user` khả dụng, Bubblewrap `/usr/bin/bwrap 0.9.0`)
  - Runtime: Node.js `v24.16.0`, `pnpm 12.5.1`, TypeScript `5.9.3`, Vitest `2.1.9`
  - Binaries thực tế trên host:
    - `herdr`: `/home/baodq/.local/bin/herdr` (`herdr 0.9.5`, protocol `22`, schema `1`)
    - `claude`: `/home/baodq/.local/bin/claude` (`2.1.301` / `2.1.302`)
    - `codex`: `/home/baodq/.local/bin/codex` (`codex-cli 0.162.0` / `0.163.0`)
    - `agy`: `/home/baodq/.local/bin/agy` (`Antigravity CLI 1.4.0`)
    - `rtk`: `/home/baodq/.local/bin/rtk` (`rtk 0.42.4`)
    - `gitnexus`: `/home/baodq/.local/bin/gitnexus` (`1.6.12`)
    - `google-chrome`: `/usr/bin/google-chrome` (`Google Chrome 146.0.7680.80`)
    - `claude-mem`: `12.1.3` (`worker-service.cjs` loopback HTTP `127.0.0.1:37777` & `--mcp` stdio)

---

## 1. Quyết định phát hành (Release Decision)

> **Phân loại toàn sản phẩm**: **NOT PRODUCTION-READY** (Đạt **Platform v3 Architecture, Integration & Local/Live-Binary Verification Baseline**; **chưa đạt** nghiệm thu Full Live Multi-Model AI SDLC End-to-End và Cross-OS/Active-Fault Campaigns).

Hệ thống Bflow sau chuỗi phát triển **P24–P34** (cùng các bản vá P30 Hardening 1, Hardening 2, Live Probe và cấu hình `.bflow/config.yml` / Codex hook trust `33ca7ab`..`da9e166`) đã hoàn thiện toàn bộ kiến trúc Platform v3 trong mã nguồn, vượt qua **100% kiểm thử tĩnh, unit/integration và E2E/live-binary**.

Tuy nhiên, tuân thủ nguyên tắc nghiêm ngặt **"Không tuyên bố production-ready nếu các kiểm thử thực tế chưa đạt"**:
1. **Chưa có một lượt chạy SDLC hoàn chỉnh bằng model AI thực** (từ prompt người dùng ở `Conversation` $\to$ `Coordinator` $\to$ `Specifier`/`Planner` $\to$ `Developer` viết code & test trên Git worktree $\to$ `Reviewer`/`QA` $\to$ `GitOrchestrator` merge $\to$ `Human Delivery Approval`) trên daemon phiên thực. Các luồng SDLC đầy đủ hiện tại (`e01`, `e16`, `packages/runtime/test/agentic/integration.test.ts`) kiểm chứng bằng SQLite thực, ArtifactStore thực, Git worktrees thực, Bubblewrap runner thực và transport/actor có kiểm soát.
2. **Agy (`1.4.0`)** mới đạt mức `preflight: ready` và `prepareLaunch: ok`; chế độ `unattended_isolated` và `activated` native session binding (`supportsNativeBinding: false`) vẫn trả `unsupported` theo thiết kế fail-closed.
3. **macOS (`launchd`) và Windows (`Task Scheduler` / `designed_unverified`)** chỉ mới được kiểm chứng qua contract/adapter test trên Linux, chưa chạy trên máy macOS/Windows vật lý.
4. **Cơ chế cô lập cùng UID (`RR-13`, `PV3-09`)**: các tiến trình provider chạy dưới cùng tài khoản OS của operator; chưa có container/VM tách biệt từng role.

| Cấp độ phát hành | Trạng thái | Điều kiện để nâng cấp mức độ |
| :--- | :--- | :--- |
| **Platform v3 Engineering & QA Baseline (Linux)** | **PASS (Đã xác minh)** | Build, dependency graph, typecheck, 2.589 unit/integration tests, 84 E2E tests, live Herdr/RTK/GitNexus/Claude-Mem probes đều đạt `0` lỗi. |
| **Limited Pilot / Dogfooding (Linux POSIX FS)** | **CONDITIONAL (Sẵn sàng có điều kiện)** | Chạy trên hệ tệp POSIX (`ext4`/`xfs`, không chạy state trên `fuseblk`/NTFS), chấp nhận rủi ro cùng UID (`PV3-09`), và chạy thêm 1 lượt live multi-model happy-path + active recovery. |
| **Production-Ready** | **NOT READY** | Đòi hỏi: (1) Full live multi-model SDLC E2E run có human delivery approval, (2) Active fault/SIGKILL campaign trên model đang chạy, (3) Xác minh thực tế trên macOS/Windows nếu công bố hỗ trợ, (4) Cô lập tiến trình cấp OS/container cho các role, và (5) Đóng `P02-RA01`, `P03-RA01`. |

---

## 2. Kết quả chạy kiểm thử thực tế (Fresh Verification Evidence)

Mọi lệnh kiểm thử được chạy trực tiếp trên worktree cô lập `/tmp/bflow-v3-release-review` (POSIX `ext4`):

| Bộ kiểm thử | Lệnh thực thi | Exit Code | Kết quả chi tiết | Mức bằng chứng |
| :--- | :--- | :---: | :--- | :--- |
| **Build** | `pnpm build` | `0` | 22 workspace packages biên dịch sạch (`tsc -b`) | Biên dịch thực |
| **Dependency Graph** | `pnpm check:deps` | `0` | `21 packages, 39 internal edges` acyclic; không vi phạm ranh giới package lá | Kiểm tra tĩnh |
| **Typecheck (Workspace)** | `pnpm typecheck` | `0` | `tsc -b --pretty false` — `0` lỗi kiểu | Kiểm tra tĩnh |
| **Typecheck (E2E)** | `pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit` | `0` | `0` lỗi kiểu trên toàn bộ 16 kịch bản E2E | Kiểm tra tĩnh |
| **Unit & Package Integration** | `TMPDIR=/tmp pnpm exec vitest run --maxWorkers=2 --minWorkers=1` | `0` | **600/600 test suites PASS** (`2.589 PASS`, `0 FAIL`, `5 skipped` opt-in) | Thực thi thực (SQLite, Git, Bubblewrap, HTTP/stdio MCP, Ed25519) |
| **E2E Suite (`e01`–`e16`)** | `TMPDIR=/tmp pnpm exec vitest run --config tests/e2e/vitest.config.ts --maxWorkers=2 --minWorkers=1` | `0` | **39/39 test suites PASS** (`84 PASS`, `0 FAIL`, `7 skipped` opt-in) | Thực thi E2E tích hợp đa package |
| **Live Herdr E2E (`e11`, `e12`, `e16`)** | `BFLOW_TEST_LIVE_HERDR=1 BFLOW_LIVE_HERDR=1 TMPDIR=/tmp pnpm exec vitest run --config tests/e2e/vitest.config.ts ...` | `0` | **11/11 test suites PASS** (`14 PASS`, `0 FAIL`, `1 skipped` live-provider opt-in) | Daemon `herdr 0.9.5` thực (protocol `22`) |
| **Live Herdr Unit (`cli` & `runtime`)** | `BFLOW_TEST_LIVE_HERDR=1 BFLOW_LIVE_HERDR=1 TMPDIR=/tmp pnpm exec vitest run apps/cli/test/environment-live.test.ts packages/runtime/test/agentic/live-herdr.test.ts` | `0` | **3/3 test suites PASS** (`2 PASS`, `0 FAIL`) | Daemon `herdr 0.9.5` thực + plugin/socket |
| **Live Tool Integrations (`e15`)** | `BFLOW_TEST_LIVE_PLATFORM=1 BFLOW_TEST_RTK_BIN=/home/baodq/.local/bin/rtk BFLOW_TEST_GITNEXUS_BIN=/home/baodq/.local/bin/gitnexus TMPDIR=/tmp pnpm exec vitest run ... e15-group-e-tool-integrations.e2e.test.ts` | `0` | **2/2 test suites PASS** (`7 PASS`, `0 FAIL`) | Binary thực: `rtk 0.42.4`, `gitnexus 1.6.12`, `claude-mem`, `google-chrome` |
| **Local Fault Probe** | `node tests/acceptance/local-fault-probe.mjs` | `0` | `{"status":"passed"}` — SIGKILL crash/reopen/recovery invariants | Tiêm lỗi tiến trình thực (`SIGKILL`) |

---

## 3. Kiểm toán 18 hạng mục (18-Point Technical & Security Audit)

### 3.1 Ma trận tổng hợp 18 hạng mục

| # | Hạng mục kiểm toán | Package / Module chính | Bằng chứng xác minh | Kết luận & Giới hạn |
| :---: | :--- | :--- | :--- | :--- |
| **1** | **Claude, Codex, Agy integration** | `packages/agent-providers` (`ClaudeProviderAdapter`, `CodexProviderAdapter`, `AgyProviderAdapter`) | `agent-providers.test.ts`, `e12`, `docs/provider-compatibility.md`, P30 live probe | **PASS (với giới hạn Agy)**: Cả 3 provider qua kiểm tra SHA-256 binary, version, auth probe, capability flags, MCP config và skills. Agy hỗ trợ `preflight`/`prepareLaunch` nhưng báo `unsupported` cho `activated` native binding và `unattended_isolated`. |
| **2** | **Provider-specific permissions** | `packages/agent-providers/src/permissions.ts` | `agent-providers.test.ts`, `e12` | **PASS**: Enforce 3 chế độ `restricted`, `workspace_auto`, `unattended_isolated`. Cấm hoàn toàn `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`. `unattended_isolated` fail-closed nếu thiếu OS sandbox (`bwrap`/container). |
| **3** | **Trusted workspace configuration** | `packages/agent-providers/src/base-adapter.ts`, `codex-adapter.ts` | `agent-providers.test.ts`, `codex-hook-setup.test.ts`, `e12` (`QA-P34-06`, `L3`) | **PASS**: Claude/Codex nhận `--add-dir <workspaceRoot>` và file cấu hình `0o600` theo session; Agy dùng `prepareAgySessionHome` tạo `<stateDir>/agy-home/.gemini/antigravity-cli/settings.json` (`0o600`) chứa `trustedWorkspaces` mà **không** sửa `$HOME` thật. Codex cô lập MCP global (`-c mcp_servers.<name>.enabled=false`) và yêu cầu phê duyệt tường minh theo SHA-256 (`bflow setup --codex-hooks --apply`) nếu có `~/.codex/hooks.json`. |
| **4** | **Environment propagation** | `packages/agent-providers/src/environment.ts`, `packages/pane-manager/src/herdr-socket.ts` | `env-at-creation.test.ts`, `herdr-socket.test.ts`, `e12` (`L1`) | **PASS**: Env được lọc qua allowlist (`scrubEnvironment`), loại bỏ `LD_PRELOAD`, `NODE_OPTIONS`, `BFLOW_INTERNAL_*` và API key ngoại lai. Phát hiện thực tế `herdr agent start` không chuyển env đã được sửa triệt để bằng việc truyền `env` ngay lúc tạo pane qua Herdr Unix socket API (`workspace.create`, `tab.create`, `pane.split`). |
| **5** | **Global setup idempotency** | `packages/machine-setup`, `packages/skills/src/setup.ts`, `apps/cli/src/setup-integration.ts` | `e11-group-a-setup.e2e.test.ts`, `setup-outcomes.test.ts` (`QA-P34-01`, `QA-P34-02`, `E1`, `E2`, `N1`) | **PASS**: `bflow setup` lần 1 tạo thư mục `0o700`, cài 32 builtin skills và ghi receipt `applied`; lần 2 trả `noop`/`already_satisfied`; `--check` chỉ đọc; `--repair` khôi phục state hỏng. Chế độ `isolatedRoot` cô lập hoàn toàn PATH, native plugins và tên unit OS service. |
| **6** | **Doctor completeness** | `packages/machine-setup/src/doctor.ts`, `apps/cli/src/commands.ts` | `doctor.test.ts`, `e11` | **PASS**: Kiểm tra đầy đủ 6 nhóm (`environment`, `herdr`, `providers`, `mcp`, `tools`, `skills`), phát hiện chính xác binary thiếu, daemon Herdr tắt, Gateway lỗi hoặc skill store lệch digest; trả `healthy: false` và exit code khác `0` khi thiếu thành phần bắt buộc. |
| **7** | **Strict startup readiness** | `packages/runtime/src/platform/service.ts`, `packages/runtime/src/agentic/host-platform.ts`, `tool-reachability.ts` | `host.test.ts`, `tool-reachability.test.ts`, `e12` (`L2`) | **PASS**: `--version` hoặc Herdr `idle`/`done` không bao giờ được coi là `ready`. `bflow up` yêu cầu: (1) preflight pass cho mọi required role, (2) Ed25519 `AgentLaunchAttestation`, và (3) bằng chứng in-process `toolReachability` từ chính tiến trình provider (qua hook `SessionStart` hoặc MCP bootstrap `provider_bootstrap`) gọi thực tế tới Gateway `initialize` + `tools/list`. Khi `up` thất bại giữa chừng, CLI tự dọn dẹp session Herdr mồ côi. |
| **8** | **Shared MCP service lifecycle** | `packages/mcp-gateway`, `packages/mcp-services`, `packages/runtime/src/agentic/host.ts` | `mcp-gateway.test.ts`, `e14-group-d-mcp-sharing.e2e.test.ts`, `host.test.ts` | **PASS**: `BflowMcpGateway` quản lý vòng đời shared backend, đối soát registration mỗi 30 giây (`reconcileGatewayRegistrations`), đánh dấu launch `degraded` và giữ message trong outbox nếu mất registration, thu hồi toàn bộ registration của daemon cũ khi host khởi động lại, và tự động respawn backend khi crash (`SIGKILL`) kèm tăng `revision`. |
| **9** | **Memory and process efficiency** | `packages/mcp-gateway`, `docs/mcp-memory-benchmark.md` | `e14-group-d-mcp-sharing.e2e.test.ts` (đo `/proc/<pid>/status` & `smaps_rollup` thực) | **PASS**: Với 6 agents đồng thời (`1 Claude + 1 Codex + 1 Agy + 3 Developers`), kiến trúc Shared Gateway giảm số tiến trình backend từ `12` xuống `2` (**giảm 83,33%**) và tiết kiệm **938,44 MiB RSS (`83,10%`) / 453,14 MiB PSS (`78,74%`)** trên stack thực `claude-mem 12.1.3` + `gitnexus 1.6.12`. |
| **10** | **Chrome browser isolation** | `packages/mcp-services/src/browser.ts`, `packages/tool-installer/src/integrations.ts` | `e15-group-e-tool-integrations.e2e.test.ts`, `mcp-services` tests | **PASS**: `planChromeSession` và `DedicatedBrowserRuntime` bắt buộc dùng thư mục profile `0o700` riêng theo `<root>/chrome/<repoId>/<taskId>`, chặn hoàn toàn profile cá nhân của user, phát hiện `SingletonLock` (`profile_locked`), chỉ bind debugging port trên loopback `127.0.0.1`, và chặn điều hướng chéo giữa các task (`page_ownership_conflict`). |
| **11** | **OS service startup and recovery** | `packages/machine-setup/src/service-manager.ts`, `packages/mcp-services` | `service-namespace.test.ts`, `e11` (`systemd-analyze verify`) | **PASS (Linux `systemd-user`), PARTIAL (macOS/Windows)**: Trên Linux, sinh unit `bflow-mcp-gateway.service` kèm `PATH`, `Restart=on-failure`, file `.bflow-owner` SHA-256 và vượt qua `systemd-analyze verify`. Hỗ trợ namespace riêng khi chạy `isolatedRoot`. macOS `launchd` chỉ mới test qua mock; Windows ở trạng thái `designed_unverified` (block mutating steps). |
| **12** | **Role-specific skills** | `packages/skills`, `skills/**` (32 builtin skills) | `catalog.test.ts`, `e15` (`QA-P34-02`) | **PASS**: 32 skills định nghĩa trong `skills/**` được kiểm tra SHA-256 digest, dependency DAG, cấm symlink thoát ra ngoài bundle, phân phối đúng 10 roles $\times$ 3 providers theo `roles/bindings.json`, và gắn `sessionId` + `generation` vào `SkillManifest`. |
| **13** | **Non-chat agent behavior** | `agents/**`, `packages/agent-registry`, `packages/runtime/src/agentic/host.ts` | `e13-group-c-non-chat-agent-behavior.e2e.test.ts`, `host.test.ts` | **PASS**: Chỉ `conversation` có `userFacing: true`. Toàn bộ các role khác nhúng `NON_USER_FACING_AUTONOMOUS_POLICY`, tắt native `AskUserQuestion`/elicitation, bị `validateHerdrRoleHandoff` chặn gửi trực tiếp tới `user`/`conversation`, và định tuyến mọi quyết định cần người dùng qua MCP tool `request_user_decision` $\to$ `Runtime` $\to$ `Conversation`. |
| **14** | **Coordinator escalation** | `packages/runtime/src/agentic/coordinator-runtime.ts`, `packages/conversation` | `e13`, `integration.test.ts`, `host.test.ts` (`F4b`) | **PASS**: Khi gặp lỗi build, thiếu thông tin nghiêm trọng, chạm giới hạn vòng lặp verification (`maxIterations`) hoặc cần phê duyệt thiết kế/release, specialist trả `{ status: "blocked", next_role: "coordinator" }`. Coordinator chuyển yêu cầu sang `ConversationGateway`; các quyết định hết hạn hoặc thuộc run đã kết thúc bị đóng tự động (`51db621`, `baea512`). |
| **15** | **Unified Bflow commands** | `apps/cli/src/high-level/**`, `apps/cli/src/config-migration.ts` | `commands.integration.test.ts`, `config-migration.test.ts`, `e15` (`QA-P34-07`) | **PASS**: 9 lệnh cấp cao (`repo inspect`, `task plan`, `task implement`, `verify`, `git prepare`, `mcp status`, `tool status`, `skills sync`, `agent check`) cùng các lệnh vòng đời (`init`, `config-migrate`, `setup`, `up`, `down`, `attach`, `status`, `doctor`, `recover`) hoạt động đúng hợp đồng schema v3, ghi journal/receipt idempotent, và trả bảng mã thoát chuẩn (`0`–`7`). |
| **16** | **SDD, Conditional TDD, Verification Loop compatibility** | `packages/specification`, `packages/test-strategy`, `packages/verification`, `packages/runtime` | `integration.test.ts` (`36/36 PASS`), `e01`–`e06`, `e16` | **PASS**: SDD bắt buộc `Specification` được duyệt trước khi implement; Conditional TDD (`required` / `recommended` / `not_applicable`) khóa test blobs ở pha Red và chạy Node TAP / Vitest 2.1 JSON thực trong Bubblewrap sandbox ở pha Green/Refactor; Verification Loop giới hạn số vòng lặp (`maxIterations = 3`) và chống tự duyệt (anti-self-review) ngay cả khi đổi Developer sửa lỗi. |
| **17** | **Multi-repository isolation** | `apps/cli`, `packages/mcp-gateway`, `packages/tool-installer` | `e14` (Case D3), `e15` (Case E2), `environment-live.test.ts` | **PASS**: Mỗi repository có `repositoryId` và tên session Herdr riêng (`bflow-<slug>-<hash>`), SQLite/ArtifactStore riêng trong `.bflow/state`, worktree riêng, `McpGateway` chặn gọi chéo giữa `repo-alpha` và `repo-beta` (`permission_denied` / `scope_mismatch`), và `ClaudeMemProjectReader` từ chối mọi bản ghi rò rỉ khác project. |
| **18** | **Security and secret handling** | `packages/agent-providers`, `packages/mcp-gateway`, `packages/runtime`, `packages/quality-gates` | `agent-providers.test.ts`, `mcp-gateway.test.ts`, `e08`, `e12`, `e13` | **PASS (trong phạm vi threat model)**: Không lưu secret trong mã nguồn hay CLI argv (`secret://` bindings); scrub token/API key/email khỏi diagnostic & log; Gateway chỉ nghe trên loopback `127.0.0.1` với kiểm tra `Host`/`Origin` và Bearer token ngắn hạn; Bubblewrap cô lập filesystem/PID/network cho test runner; Ed25519 ký chứng thực startup và human prompt provenance. |

---

## 4. Đánh giá tiêu chí chấp nhận phát hành (Release Criteria Evaluation)

| Tiêu chí chấp nhận | Trạng thái | Bằng chứng thực tế |
| :--- | :---: | :--- |
| **1. Setup thành công trên các OS được tuyên bố hỗ trợ** | **PASS (Linux) / DESIGNED (macOS, Windows)** | Linux `x86_64` được xác minh thực tế (`e11`, `setup-outcomes.test.ts`). macOS (`launchd`) có adapter + unit test; Windows được đánh dấu rõ là `designed_unverified` trong [`docs/compatibility-matrix.md`](./compatibility-matrix.md). |
| **2. Doctor phát hiện những thành phần thiếu** | **PASS** | `e11` (Case A5, A6) và `doctor.test.ts`: phát hiện thiếu binary trên `PATH`, Herdr server dừng, MCP config lỗi, skill digest lệch. |
| **3. `up` fail chính xác khi required agent không sẵn sàng** | **PASS** | `packages/runtime/test/agentic/host.test.ts` & `apps/cli/test/environment.test.ts`: `bflow up` chặn trước khi phóng pane nếu preflight fail, hoặc hủy kích hoạt và dừng session nếu provider không gửi bằng chứng `toolReachability` hợp lệ. |
| **4. Các agent chạy đúng provider và permission profile** | **PASS** | `e12` & `agent-providers.test.ts`: `restricted`, `workspace_auto`, `unattended_isolated` biên dịch chính xác sang cờ CLI của Claude, Codex, Agy; từ chối chạy nếu thiếu cờ bảo mật hoặc thiếu OS sandbox. |
| **5. MCP backend nặng không bị nhân bản theo số agent nếu đang dùng cấu hình shared** | **PASS** | `e14` & [`docs/mcp-memory-benchmark.md`](./mcp-memory-benchmark.md): 6 agents dùng chung đúng 1 tiến trình `claude-mem` và 1 tiến trình `gitnexus` qua `BflowMcpGateway`, tiết kiệm 83,10% RSS. |
| **6. Browser không dùng profile cá nhân** | **PASS** | `e15` (Case E4): Chrome luôn khởi chạy với `--user-data-dir=<stateRoot>/chrome/<repoId>/<taskId>` (`0o700`), chặn `SingletonLock` và chặn truy cập tab chéo task. |
| **7. Non-chat agents không hỏi trực tiếp người dùng** | **PASS** | `e13` (Case C1–C4) & `host.test.ts`: tắt công cụ hỏi trực tiếp, bắt buộc dùng `request_user_decision` qua `Runtime` $\to$ `Conversation`. |
| **8. Skills được phân phối đúng role** | **PASS** | `packages/skills/test/catalog.test.ts` & `e15` (Case E5): 32 builtin skills được bind chính xác cho 10 roles $\times$ 3 providers; chặn gắn skill trái phép (ví dụ `conversation` không được nhận `implement-task`). |
| **9. Unified commands hoạt động theo hợp đồng** | **PASS** | `apps/cli/test/high-level/commands.integration.test.ts` & `e15` (Case E6): toàn bộ 9 lệnh unified hoạt động theo đúng schema v3 và journal idempotent. |
| **10. SDLC workflow thực tế hoàn thành và có bằng chứng xác minh** | **PARTIAL (Engine/Storage/Git/Runner thực PASS; thiếu Full Multi-Model Live Run)** | Kịch bản `e16` (Case F3, F4) và `packages/runtime/test/agentic/integration.test.ts` hoàn thành trọn vẹn chu trình SDLC trên SQLite, ArtifactStore, Git worktree và Bubblewrap runner thực, nhưng bước suy luận của agent sử dụng actor/transport có kiểm soát. Chưa có bản ghi chạy toàn bộ 7 role bằng LLM thương mại thực trong một phiên duy nhất. |

---

## 5. Lỗi phát hiện và đã sửa trong đợt kiểm toán Release này

Bên cạnh 8 lỗi tích hợp `QA-P34-01`..`QA-P34-08` và chuỗi bản vá P30 Live Probe (`33ca7ab`..`ee4ff7c`) đã có trong baseline, đợt kiểm toán release trên worktree sạch này đã phát hiện và sửa **2 lỗi cô lập môi trường kiểm thử E2E**:

1. **`REL-V3-01` — Rò rỉ cấu hình `~/.codex/hooks.json` của máy host vào bài kiểm thử Harness E12 (`tests/e2e/scenarios/e12-group-b-agent-providers.e2e.test.ts`)**:
   - **Hiện tượng**: Khi máy host thật có file `~/.codex/hooks.json` (do công cụ bên ngoài tạo), `CodexProviderAdapter.resolveInheritedIsolation()` (được bổ sung ở commit `6d1e819`) phát hiện hook toàn cục và fail-closed (`codex_global_hooks_not_isolated`), làm bài test mock/harness của `codex` trong `e12` trả `launchRes.ok === false`.
   - **Cách sửa**: Cấp thư mục cô lập `codexHomeDirectory: join(root, "codex-home")` (`0o700`) cho `createDefaultProviderRegistry` trong bài test harness của `e12`, đồng bộ với chuẩn cô lập của `packages/agent-providers/test/agent-providers.test.ts`.
2. **`REL-V3-02` — Tràn độ dài đường dẫn Unix Domain Socket (`sun_path` > 108 bytes) khi chạy Live Herdr Daemon trong E16 (`tests/e2e/scenarios/e16-group-f-lifecycle.e2e.test.ts`)**:
   - **Hiện tượng**: Khi chạy với `BFLOW_TEST_LIVE_HERDR=1`, bài test `[LIVE HERDR DAEMON]` đặt `XDG_RUNTIME_DIR` thành `/tmp/bflow-e2e-group-f-XXXXXX/live-herdr-repo` và tên session `bflow-e2e-f-<pid>`, khiến đường dẫn socket của `herdr 0.9.5` vượt quá giới hạn `sockaddr_un.sun_path` trên Linux (`Error: local socket name length exceeds capacity of sun_path of sockaddr_un`).
   - **Cách sửa**: Rút gọn tiền tố thư mục tạm trong `e16` thành `/tmp/bf16-XXXXXX/r` và tên session `bf16-<pid>`, giúp `e16` vượt qua toàn bộ kiểm thử Live Herdr Daemon (`14/14 PASS`).

---

## 6. Tài liệu bàn giao (Deliverables Index)

1. [`docs/release-readiness-v3.md`](./release-readiness-v3.md) — Báo cáo kiểm toán 18 hạng mục, kết quả kiểm thử và quyết định phát hành v3 (tài liệu này).
2. [`docs/setup-guide.md`](./setup-guide.md) — Hướng dẫn cài đặt, chuẩn bị hệ tệp POSIX, cấu hình `bflow setup`, `bflow init`, `bflow doctor` và xác thực 3 providers.
3. [`docs/operations-runbook.md`](./operations-runbook.md) — Sổ tay vận hành: khởi chạy `bflow up`, giám sát `status`/`mcp status`/`tool status`, xử lý sự cố Gateway/Chrome/locks, quy trình `down` và `recover`.
4. [`docs/security-audit-v3.md`](./security-audit-v3.md) — Báo cáo kiểm toán bảo mật v3: mô hình đe dọa, kiểm tra 6 tiêu chí bảo mật cốt lõi, bằng chứng kiểm thử và rủi ro tồn đọng.
5. [`docs/compatibility-matrix.md`](./compatibility-matrix.md) — Ma trận tương thích chi tiết theo Hệ điều hành, Hệ tệp, Agent Providers (`claude`, `codex`, `agy`), MCP Transports và Công cụ phụ trợ.
6. [`docs/known-limitations-v3.md`](./known-limitations-v3.md) — Danh mục đầy đủ các giới hạn kỹ thuật đã biết (`RR-*`, `PV3-*`, `P02-RA01`, `P03-RA01`) và điều kiện đóng.
