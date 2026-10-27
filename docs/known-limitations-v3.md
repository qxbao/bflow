# Giới hạn hiện tại và điều kiện đóng

Đối chiếu source ngày 2026-10-27 (`c1caccb`); [implementation status](implementation-status.md) ghi baseline và đường triển khai. Các báo cáo [release v3](release-readiness-v3.md), [provider](provider-compatibility.md) và [E2E](e2e-report.md) là bằng chứng lịch sử có phạm vi riêng, không phải chứng nhận mới cho HEAD.

## Nghiệm thu hệ thống

| Mục | Hiện trạng | Điều kiện đóng / owner |
| --- | --- | --- |
| `PV3-01` / `RR-01` / `RR-21` | Có host/platform integration, local regression và probe thật ở các báo cáo; chưa có hồ sơ đóng full SDLC đa provider từ Conversation đến human delivery approval | Runtime + QA: feature/bugfix required TDD và docs not_applicable, đúng source revision, artifacts/receipts/approval và usage |
| `PV3-02` | Chưa có cây `tests/platform-v3/**` và `tests/acceptance/platform-v3/**`; coverage hiện nằm trong package tests và E2E e11–e16 | QA/P31: conformance/security/fault/live campaign và integration review cho root wiring |
| `RR-02` / `RR-19` | Idle lifecycle và controlled recovery không chứng minh recovery giữa provider turn đang sửa code | Lifecycle + QA: active SIGKILL/restart, giữ approval/cancellation/unknown delivery, không prompt/writer trùng |
| Remote governance / release | Local integration và CLI acceptance không chứng minh protected branch, remote merge/deploy hoặc release closure | Integrator + owner: nghiệm thu riêng đúng quyền publication |

## Provider và phân quyền

- **Agy:** native specialist launch/hook/shim/binding có source/local tests. Conversation thiếu trusted human-input provenance; `unattended_isolated` vẫn unsupported. Không còn gọi mọi native binding của Agy là chưa triển khai; cũng không suy source fix thành Developer/full SDLC acceptance.
- **Codex hooks:** hooks chưa được duyệt chặn launch. Snapshot review dùng `bflow setup --codex-hooks --plan/--apply`; non-interactive cần đúng digest. Operator có chính sách trust-all riêng, xem [security guide](guide/security-approval.md); setup thông thường không tự duyệt hook.
- **Same UID (`RR-13` / `PV3-09`):** scoped tokens, native tool guard và private files không cô lập tiến trình thù địch chạy cùng UID. Toàn bộ provider OS sandbox/container là yêu cầu riêng của unattended; sandbox kiểm thử không thay thế được.
- **Claude workspace trust:** config mới đặt `trustedWorkspace: true`; `up` với required Claude có thể ghi project trust trong `$CLAUDE_CONFIG_DIR/.claude.json` hoặc `~/.claude.json` của môi trường gọi CLI. Không mô tả toàn bộ startup là không ghi provider config; xem [config reference](guide/configuration-reference.md#policy-và-ngân-sách).
- **Restart:** registration/generation mất authority phải bị retire/revoke và xác minh lại, không dùng receipt cũ để giả activated health. Unknown delivery vẫn cần reconciliation trước resend.

## Tools, skills và Gateway

| Mục | Hạn chế / cách sử dụng đúng |
| --- | --- |
| Setup login diagnostic | Native status trong setup thường có thể verified, nhưng không là role/profile/model readiness; isolated/injected setup không tự dùng auth ngoài scope. Cleanup stale native intent chỉ có ở apply với các điều kiện exact-pin/ownership/metadata đã mô tả, không phải quyền replay mọi mutation unknown. [Guide](setup-guide.md#kiểm-tra-native-login-và-intent-superpowers) |
| Standalone CLI diagnostics | `mcp status` chưa có live `mcpGateway` port mặc định và có thể báo not_ready dù daemon đã setup; `skills list`/`sync --list` chưa được parser binary nhận. `agent check` dùng môi trường standalone, có thể chạy model probe; không chứng minh role/profile trong config ready |
| Rework per-finding verdict coverage | Host/Runtime bắt buộc verdict độc lập đủ mọi finding của generation hiện hành, ghim vào revision/attempt/dossier; settlement chỉ đóng finding `confirmed`. Mức bằng chứng: source + local/fake-runner tests, chưa live provider/Herdr acceptance. Chất lượng phán đoán của model vẫn không được chứng minh bởi guard cấu trúc; [source/flow](rework-causality.md) |
| Test-integrity gate | `host-test-integrity` so sánh test/config giữa base được bảo vệ (base của worktree đầu tiên của task) và candidate bằng phân tích AST tĩnh JS/TS; Reviewer phải adjudicate mọi finding, `proven_violation`/`confirmed_violation` cần owner exception theo từng candidate. Nếu task được giao lại trên base mới hơn, diff có thể gồm thay đổi test của task khác (Reviewer adjudicate `equivalent` kèm anchor). Vượt giới hạn 256 file/1 MiB blob/8 MiB/2.000 findings cho `inconclusive` và cần chia candidate. Plan verification đã lưu trước khi có gate bị chặn, cần đối soát với owner. [Runtime README](../packages/runtime/TEST-INTEGRITY-VALIDATION.md) |
| Fast-path với host mặc định | Vì `host-test-integrity` có trong check mặc định và cần Reviewer độc lập, fast-path `active` bị hạ cấp (`test_integrity_requires_independent_review`); review waiver chỉ còn với custom policy không có gate này. Chi phí token cao hơn so với trước |
| Conversation cards/aliases | Plain Vietnamese/read_updates/Stop/Log có source/local tests; display ACK là heuristic trên assistant text, không chứng minh human attention hoặc provider adherence. No-alias legacy receipts giữ exact IDs, không suy alias mới. [Guide](guide/conversation-updates.md) |
| NFR và test-design references | Chỉ là instruction/schema/catalog compatibility; không có mặc định SLA, measurement result hoặc browser/live capability mới. Existing-version/digest conflict phải reconcile qua owner, không overwrite immutable store. [Guide](nfr-and-test-design.md) |
| Browser task actions | Runtime đã có giao dịch lease độc quyền `BrowserResourceTransactions` (`gen-N/browser-resource-transactions.json`, TTL tối đa 5 phút, tối đa một lease cho mỗi attempt được xác thực, từ chối gọi đồng thời với `browser_lease_busy`, giữ `quarantined`/`release_uncertain` khi lỗi/restart). Mức bằng chứng hiện tại là source + local tests; chưa có nghiệm thu SDLC live với Chrome và provider thật. Profile Chrome của `setup` không dùng chung với phiên repository |
| GitNexus & `bflow init` | Runtime có resource acquire/renew/release/fencing theo generation; `bflow init` lập chỉ mục GitNexus và đăng ký `gitnexus-<repo>` vào Gateway đang chạy (`--check`, `--remove`, `--no-gitnexus`). Index stale/missing/workspace sai không usable; cổng kiểm thử hồi quy không tự gọi `gitnexus analyze`. Context khảo sát vẫn fallback bounded source inspection khi index chưa được chứng minh |
| Task handover | `propose_task_handover` / `read_task_handover` chỉ lưu ngữ cảnh chẩn đoán không tin cậy (`untrusted_previous_attempt_handover`), ghim chặt với generation, `HEAD` và SHA-256 của file (`handover_stale` khi lệch). Không cấp quyền TDD/verification/approval và không tự động tạo handover nếu tiến trình agent dừng đột ngột trước khi gọi tool |
| Workflow telemetry | `bflow status <run-id> --telemetry [--json]` đọc báo cáo chỉ đọc từ agentic host đang chạy ([TELEMETRY-SPEC.md](../packages/runtime/TELEMETRY-SPEC.md)). Không tự ước lượng chi phí tiền tệ hoặc bịa số token khi provider/bridge không báo (`partial`/`unavailable`); store chỉ đọc thiếu host báo `legacy_readonly_source_unavailable` |
| MCP compact views & cursors | Chế độ rút gọn output MCP (`compact: true`) là opt-in để giữ tương thích schema mặc định; cursor phân trang (`mcp-page-v1-...`) nằm trong bộ nhớ của tiến trình host hiện tại (tối đa 64 trang, TTL 15 phút) và không tồn tại qua restart |
| Tool namespaces | D-TOOLS-01 đã tách catalog ID, service và operation trong source. Không còn coi overload `toolIds` là thiết kế hiện hành; vẫn cần live evidence cho grant → invocation → downstream consumption |
| MemPalace | Wheel pin checksum; Python dependencies chưa khóa offline toàn bộ. Read-only wing/provenance bắt buộc; wing mặc định repo ID có thể chưa có memory. Setup không ghi fixture hay mở rộng sang toàn palace |
| Context7 | Query ra dịch vụ ngoài, OAuth chưa hỗ trợ; quota-message chưa có quan sát đủ để chứng nhận mọi biến thể. `docs status` là config/service probe, không chứng minh provider consumption |
| RTK | Compression có thể passthrough hoặc degraded; raw status/output vẫn là evidence. Không hứa tỷ lệ giảm token từ test formatter hoặc chạy lại command để lấy output |
| Skills | Bundle pins là instruction, không là permission. Tool skill thiếu grant bị skip/block theo requiredness. Startup không hỗ trợ custom `catalogDir`/`bindingsPath`; không sửa bundle đã publish mà giữ version/digest |
| Legacy required lists | `requiredTools`/`requiredMcpServices` thiếu role/operation allowlist cần migration; không tự cấp mọi operation |

## Platform, workspace và runners

- **Linux Bubblewrap & AppArmor (`verification_sandbox_unavailable`):** Trên Ubuntu/Debian bật `kernel.apparmor_restrict_unprivileged_userns=1`, `bwrap` có thể thất bại với `setting up uid map: Permission denied` hoặc `RTM_NEWADDR: Operation not permitted` nếu thiếu quyền `userns` trong AppArmor. `bflow doctor` và `bflow up` phát hiện lỗi này và hướng dẫn cài profile `packages/runtime/support/bflow-bwrap.apparmor` (profile này cho phép mọi user tạo user namespace qua `/usr/bin/bwrap`, nên cần quản trị viên chấp nhận rủi ro đó); probe không bao giờ tự hạ cấp cô lập hay chạy test trực tiếp trên host.
- **macOS:** có workspace helper, Seatbelt, local tests và phép đo thật trong [portability report](acceptance/2026-10-24-macos-portability.md) cùng [review](acceptance/2026-10-24-macos-portability-review.md). Chưa full SDLC acceptance; native polyglot mounts và dependency warming vẫn Linux-only. Cần Apple Command Line Tools và `flock` thích hợp.
- **Kiểm thử context trên macOS:** fixture đặt trong temp path có alias `/var` → `/private/var` có thể không được bounded reader nhận diện. Dùng `TMPDIR=/private/tmp` khi chạy test để tạo path canonical; đây không phải thay đổi source hoặc chứng nhận mọi path alias. Runner-detection test còn yêu cầu manifest khớp commit, nên license/config metadata chưa commit có thể chặn test này.
- **Windows (`PV3-04`):** machine mutation `designed_unverified`/blocked; Git Bash không thay nghiệm thu native.
- **Private state (`RR-26`):** Runtime có thể chọn private POSIX state ngoài checkout không giữ mode; machine secrets vẫn cần private ownership/mode. Không coi cơ chế này là chứng nhận NFS/NTFS hoặc tự di chuyển authority đang tồn tại.
- **Socket (`RR-25`):** Unix socket path bị giới hạn theo OS; dùng runtime directory ngắn khi diagnostic báo `sun_path`.
- **Runner scope (`RR-22`/`RR-23`):** auto-detection và polyglot parser có source, mỗi runner còn exact-identity/offline/report constraints riêng. Cổng hồi quy tự động `host-regression-<profile.id>` chỉ áp dụng cho JS/TS runner tự phát hiện (`vitest_json`, `node_tap` không qua polyglot adapter). Xem [runner matrix](verification-runners.md); không giới hạn toàn hệ thống thành Node TAP/Vitest 2.1, cũng không tuyên bố mọi ecosystem đã có live measurement.
- **Resource quotas (`RR-24`):** timeout/output/iteration bounds không thay CPU/RAM/Disk I/O quotas cho từng subprocess. Không có cam kết multi-host, network-filesystem, hostile same-user hoặc power-loss durability mới.
- **Workspace file tools:** UTF-8 tối đa 128 KiB, parent phải có sẵn; không mkdir, binary write hoặc crash-atomic replacement. Host tool access không tạo quyền shell tùy ý.
- **Legacy CLI:** `run`, `status <run-id>` (khi không dùng `--telemetry` qua host đang chạy), `approve`, `resume`, `cancel` dùng store/Runtime cũ. Với P19, dùng Conversation, host status (`bflow status`, `bflow status <run-id> --telemetry`) và pending-action recovery; `recover --yes` chỉ xử lý legacy lifecycle lock.

## Theo dõi package còn mở

| Mục | Owner | Phạm vi |
| --- | --- | --- |
| `P02-RA01` | Herdr adapter | Large runner timeout overflow; vẫn open P2, không đóng từ tài liệu |
| `P03-RA01` | ArtifactStore | Late final `get()` chunk sau deadline/abort; vẫn open P2 |
| `RR-16` | Runtime / observability | Helpers/logging không chứng minh quan sát toàn tuyến trong full provider workflow |
| Third-party licenses | Setup / release owner | AGPL-3.0-only của Bflow không thay giấy phép tool/service được tích hợp; installer catalog và upstream terms vẫn áp dụng |
