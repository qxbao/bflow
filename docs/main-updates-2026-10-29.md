# Bổ sung tài liệu từ các commit mới trên main (901caa6..8d86553)

Tiếp nối [đợt đối chiếu 2026-10-25/27](main-updates-2026-10-25.md). Đợt này xét các commit không phải merge từ `main` **`901caa6`** đến merge **`8d86553`** (PR #67/#69, ngày 2026-10-29). Đây là các mốc cố định của đợt audit, không là cam kết rằng `main` luôn trỏ tới commit đó.

Mức bằng chứng của mọi dòng bên dưới là **source + local tests** trừ khi ghi rõ khác. Các probe live được nêu đều có phạm vi riêng và không đóng full SDLC acceptance.

## Giao diện web cục bộ (W00–W09)

| Commit | Hành vi/source đã thêm | Tài liệu |
| --- | --- | --- |
| `2bd99d8` · `de36c73` | W00: đóng băng interface local web trong `@bflow/contracts/web` / `web-host` và skeleton build; owner duyệt [ADR 0006](adr/0006-local-web-interaction.md) | [ADR 0006](adr/0006-local-web-interaction.md), [design](superpowers/specs/2026-10-28-local-web-design.md), [plan](superpowers/plans/2026-10-28-local-web.md) |
| `db1d8af` · `6da552d` · `3748f2d` · `3aa2943` | W01–W02 Runtime: read facade có phạm vi (`openUserInteractionClient`), authority web cô lập (issuer Ed25519, `principalId: local-user-<uid>`), operation bền vững, đối soát effect qua cửa sổ ACK | [Runtime README](../packages/runtime/README.md#local-web-interaction-port-w01w05) |
| `930cbca` · `b2d424a` · `34d3de9` · `6817570` | W02 Conversation: admit structured action (create/revise/clarification/decision/resume/cancel) không cần lượt model; giữ quyền hủy, giữ chỗ approval chưa chắc chắn | [W02 handoff](../packages/conversation/test/W02-HANDOFF.md) |
| `f2e18cb` · `e5f45fd` | W03/W05 Local Server: HTTP loopback (`127.0.0.1`), bootstrap qua URL fragment 60 giây, cookie HttpOnly SameSite=Strict, CSRF, SSE có giới hạn, artifact inline dạng text/plain ≤ 1 MiB | [Local Server README](../apps/local-server/README.md) |
| `c7d8148` · `e945dad` | W04: lệnh `bflow web [--port N] [--no-open]` (mặc định `127.0.0.1:4317`), ghép host/lifecycle; Ctrl-C chỉ đóng web, không dừng phiên dự án | [ADR 0007](adr/0007-local-web-composition.md), [CLI README](../apps/cli/README.md) |
| `6ac7e92` · `0481789` | W05: projection feed, artifact có phạm vi dự án, display acknowledgement chính xác | [W05 handoff](../packages/runtime/test/interaction/W05-HANDOFF.md) |
| `8c67190` · `0d0d622` · `4d3b18d` | W06–W07: UI tiếng Việt chỉ đọc (Tổng quan, Công việc, Cần bạn quyết định) và hành động trực tiếp có recovery, giải thích lỗi kèm hướng xử lý an toàn | [Web README](../apps/web/README.md), [W07 handoff](../apps/web/W07-HANDOFF.md) |
| `7ec4287` · `44efada` · `fa4153c` | W08: lịch sử và chat có tương quan với cùng phiên Conversation; chỉ bật chat khi transcript đã chuẩn hóa được xác thực | [W08 handoff](../apps/web/W08-HANDOFF.md) |
| `2287c28` · `ef2e6d9` | Quản lý dự án end-to-end trên web (đăng ký Git root, init/update, sửa chữa GitNexus, form role/provider/model, YAML đầy đủ, gỡ đăng ký có xác nhận); chuyển sang Tailwind và UX gọn | [Web README](../apps/web/README.md), [PROJECT-MANAGEMENT](../apps/web/PROJECT-MANAGEMENT.md), [UX validation](../apps/web/UX-VALIDATION.md) |
| `ad30d5c` · `cf9a327` · `5fa7a2e` · `96dd1bb` · `fc242c7` | W09: acceptance HTTP/browser security/recovery và probe live opt-in; sửa F01–F05 (settle lifecycle, khôi phục web owner đã chết bằng `flock`, doctor kiểm tra skill pin) và vòng refresh của event feed | [W09 handoff](../tests/acceptance/local-web/W09-HANDOFF.md), [acceptance README](../tests/acceptance/local-web/README.md) |

Live probe W09 (Herdr 0.9.5 + Codex 0.165.0, repo dùng một lần) đạt tới: web start phiên → `applied`, môi trường UP 7/7, form `create_request` được admit và delegate tới Coordinator. Các dòng AC03–AC07/AC11 live và full SDLC qua web vẫn **not_run**.

## Workflow, Runtime và Conversation

| Commit | Hành vi/source đã thêm | Tài liệu |
| --- | --- | --- |
| `3bd627e` · `be43196` | Execution preview không side effect (EP-01): `bflow task preview [--run <id>] [--compare <file>] [--json]`, provenance của gate/TDD/approval, `--expect-plan` cho `up`/`task implement`; Runtime revalidate input đã bind trước mọi side effect và trả `PlanDiff` khi drift. Preview không phải readiness, approval hay bằng chứng thành công | [ADR 0005](adr/0005-execution-preview.md), [Runtime README](../packages/runtime/README.md#execution-preview-and-drift-boundary), [high-level reference](../apps/cli/docs/command-reference.md) |
| `f467c43` | Prototype review tùy chọn trước thiết kế chi tiết (`propose_prototype` / `submit_prototype`), approval prototype tách khỏi design và delivery | [SDLC policies](sdlc-policies.md#38-nhánh-duyệt-prototype-tùy-chọn-trước-thiết-kế-chi-tiết) |
| `39e4fa2` · `8067060` | Custom specialist role profiles (RP-01): `environment.specialistProfiles` (path + pin `profileId@version`), Coordinator đọc catalog bằng `read_role_profiles` và ghim `roleProfile` trên task/`request_specialist`; run có profile dùng journal agentic **v7**; nhãn profile không thay kiểm tra Reviewer độc lập; run có profile không failover | [Runtime README](../packages/runtime/README.md#custom-specialist-profiles-rp-01), [design](../packages/runtime/custom-role-profiles-design.md) |
| `91589c9` · `a316fcf` | Provider failover được duyệt: `failover` theo role (ứng viên exact provider/model/profile, `maxSwitches`, `maxRetries`, `cooldownMs`), chỉ nhận failure có cấu trúc từ adapter tin cậy, continuation bền vững qua crash, notice có hành động trong Conversation; không có chain thì không failover | [Decision](provider-failover-decision.md), [plan](provider-failover-plan.md), [contract](../packages/contracts/src/provider-failover.ts) |
| `7c9a9fc` | Nhập skill/rule của IDE (`SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor rules) thành custom skill chỉ chứa hướng dẫn, qua `bflow skills scan\|import\|approve\|disable\|revoke\|status`; approval kiểm tra lại digest/pin/scope/expiry | [Skills README](../packages/skills/README.md), [CLI reference](../apps/cli/COMMAND_REFERENCE.md) |
| `5f19efd` · `ce1d7a9` | Workflow chỉ phân tích nghiệp vụ (BA-only, `AnalysisWorkflowRuntime`): khảo sát → elicitation → spec → review độc lập → publish; không implementation/Git. **Chưa nối host/Herdr/Conversation/CLI** | [ANALYSIS-ONLY-WORKFLOW](../packages/runtime/ANALYSIS-ONLY-WORKFLOW.md) |
| `be71168` | Workflow chỉ kiểm thử (QA-only, `QaWorkflowRuntime`) cho hệ thống có sẵn, không sửa target; phân loại `passed`/`product_failure`/`test_defect`/`environment_failure`/`blocked`/`inconclusive`. **Chưa nối host/Herdr/Conversation/CLI** | [QA-ONLY-WORKFLOW](../packages/runtime/QA-ONLY-WORKFLOW.md) |
| `24f974b` | Gói bàn giao offline (HX-01): `bflow handover inspect\|export\|verify`, ma trận criterion → task → revision → check → evidence; không đổi run status/approval | [high-level reference](../apps/cli/docs/command-reference.md), [design](../packages/runtime/handover-export-design.md) |
| `f468830` | Data contract drift và dbt/DuckDB snapshot checks (DC-01) qua entry point thư viện `DataVerificationHost`; skill `data/data-contract`, `data/data-pipeline`, `data/dbt-verification`. **Chưa có cấu hình daemon/CLI** | [DATA-VERIFICATION](../packages/runtime/DATA-VERIFICATION.md), [skills catalog](../skills/README.md) |
| `067dbfd` | Agent cứu hộ `BFLOWSOS`: lượt Conversation đúng chuỗi `BFLOWSOS` được host xử lý như lệnh vật lý, spawn agent trong tab Herdr "SOS" với ngữ cảnh hiện trường dưới `<host dir>/sos/`; role tùy chọn `sos` trong `.bflow/config.yml` (`required: false`, không là pane cố định, không `specialistProfile`/`failover`) | [Config reference](guide/configuration-reference.md#agent-cứu-hộ-bflowsos), [Troubleshooting](guide/troubleshooting.md) |
| `e5353a1` | `manual_review` do policy yêu cầu trong các phase hành vi: QA gọi `inspect_alternative_verification` rồi nộp judgment cho từng criterion | [Runtime README](../packages/runtime/README.md#policy-required-manual-review-in-behavioral-phases) |
| `a5224c2` | Owner `mutationChecks` trong `.bflow/verification.json`: commit mutation treo, gate `host-mutation-<id>` fail `non_discriminating_test` khi test kỳ vọng vẫn pass | [Verification runners](verification-runners.md#mutation-checks-mutationchecks) |
| `c599e69` · `541c5dc` | Thời gian chờ gate Reviewer/QA do host đo (`gateExecution` trong telemetry); timeout mặc định 900 s, cấu hình qua `environment.verification.reviewTimeoutMs` (60 000–3 600 000) | [Telemetry spec](../packages/runtime/TELEMETRY-SPEC.md), [Config reference](guide/configuration-reference.md) |
| `75413fa` · `98cb85b` | Task phụ thuộc khởi tạo worktree từ head đã verify của dependency (nhiều dependency được merge thành base tổng hợp) | [Runtime README](../packages/runtime/README.md) |
| `4139183` · `220738e` · `3aa2943` | Tự hồi phục ingress bị từ chối của specialist có delivery/lease hợp lệ; debounce delivery uncertainty tới hết ACK grace | [Runtime README](../packages/runtime/README.md) |
| `e7d1a7a` · `6168b27` · `f367037` | Sửa các chặn tìm thấy trong live run Claude-only ngày 2026-10-29: Conversation delegate yêu cầu prototype, card có “cần sửa”, pump inbound tiếp tục sau quiesce timeout, giải phóng specialist bị kẹt khi run bị hủy, pane Runtime-owned cũ không chặn công việc mới, lỗi phân loại spec nêu rõ giá trị kỳ vọng | Commit messages; [Pane Manager README](../packages/pane-manager/README.md) |

## Provider và setup

| Commit | Hành vi/source đã thêm | Tài liệu |
| --- | --- | --- |
| `74b3c5d` · `5969043` · `ea3bde9` · `a84dcdd` | Private Codex home: ghi trust workspace vào config riêng, digest config bỏ qua `[tui]`, auth helper chạy với HOME nguồn, tạo `.zshrc` rỗng | [Agent providers](../packages/agent-providers/README.md) |
| `986a34d` · `eb6c9bb` | Với `trustedWorkspace: true`, `up` nối bảng `[projects."<root>"]` vào Codex home của role bắt buộc (kể cả role chọn profile ai-isolator), không ghi đè quyết định có sẵn; chỉ ghi trong composition Runtime mặc định | [Config reference](guide/configuration-reference.md#policy-và-ngân-sách) |
| `3dc80fa` · `80d70dc` · `b4c7114` | `pnpm test:affected` (GitNexus) và quy tắc nạp package qua package specifier | [AGENTS.md](../AGENTS.md#affected-test-selection-with-gitnexus) |

Merge commit không được tính là tính năng mới hoặc mức bằng chứng riêng.

## Những gì không được suy ra

- `bflow web`, form/action có cấu trúc hay trạng thái `applied` không chứng minh workflow hoàn tất; web không thay human approval hay Runtime gate.
- Execution preview, `--expect-plan` và gói bàn giao `eligible` không cấp approval, readiness hay delivery acceptance.
- Profile specialist, skill được import và failover chain không cấp quyền tool/permission mới, không thay Reviewer độc lập.
- `BFLOWSOS` chạy agent với quyền provider đầy đủ, không có PreToolUse guard; đây là công cụ cứu hộ cho người vận hành, không phải đường thực thi workflow.
- BA-only, QA-only và data verification mới là library/extension với role giả lập; chưa dùng được qua `bflow up`/Conversation.
