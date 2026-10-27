# Bổ sung tài liệu từ các commit mới trên main

Đợt đối chiếu ban đầu lấy mốc soạn docs **`355a998c97aa301c39f7f5f08791a0bf2f3e3a7a`**, xét các commit trên upstream tại **`a7686be06e68458aa9cc93381584752ea68e250c`** và **`2357669`** ngày 2026-10-25 (`5dfceac`), sau đó được cập nhật tiếp tới **`c1caccb41167e37c59128919292b08a63ce17377`** ngày 2026-10-27. Đây là các mốc cố định của đợt audit; không là cam kết rằng nhánh `main` sẽ luôn trỏ tới commit đó.

Source ban đầu được đọc tại `duc` baseline `eaa9c2a5802d4312f3b835c36da2257cfa026aaf`, sau đó đồng bộ qua `cc61ab39582b9edbdd3394f2c6b6f37a8d84eee4` (`5dfceac`) và tiếp tục tích hợp các thay đổi đến `c1caccb`.

## Phạm vi thay đổi đã đối chiếu (355a998..5dfceac)

| Commit | Hành vi/source đã thêm | Tài liệu bổ sung |
| --- | --- | --- |
| [56096b8](https://github.com/qxbao/bflow/commit/56096b809a8470d3a154005da913adddb0f787c1) | Rework root-cause context/dossier, per-finding resolutions và verdict độc lập; giữ revision/generation/evidence khi phục hồi | [Rework causality](rework-causality.md), [verification loop](guide/verification-loop.md) |
| [861acf6](https://github.com/qxbao/bflow/commit/861acf6fb0e78162c46e63a3bc25084b3db3cb97) | NFR clarification, criterion mẫu có oracle/điều kiện, mapping vào flow Specification/TestStrategy hiện có | [NFR và test design](nfr-and-test-design.md), [SDD/TDD](guide/sdd-tdd-policies.md) |
| [1a44b54](https://github.com/qxbao/bflow/commit/1a44b54a997cacce43aa310269c248b76e8484e9) | Ghi validation/handoff NFR với phạm vi local, bao gồm cả kết quả chưa hoàn tất/không đạt | Giữ [hồ sơ gốc](../packages/skills/NFR_GUIDANCE_HANDOFF.md); không nâng thành live acceptance |
| [0ad057d](https://github.com/qxbao/bflow/commit/0ad057d29d7c9cf0c861c58aeec357df53045210) | Risk-based references cho planning, review, security và UI; exact bundle pins/resources và compatibility fixtures | [Reference map](nfr-and-test-design.md#reference-đã-được-phân-phối) |
| [2b4d29a](https://github.com/qxbao/bflow/commit/2b4d29ad60476c140c2cf546288ab4a2953f5795) | Hook không đẩy danh sách raw notice JSON; Conversation lấy bounded updates qua `read_updates` | [Conversation updates](guide/conversation-updates.md), [Runtime reference](../packages/runtime/README.md) |
| [9247e59](https://github.com/qxbao/bflow/commit/9247e5947313c80b1b681acabd2e7923467e10a4) | Thẻ tiếng Việt, mã `#n`, nhãn `Việc #k`, mapping vào decision/status/cancellation/revision hiện có | [Cách đọc và trả lời](guide/conversation-updates.md) |
| [de5342c](https://github.com/qxbao/bflow/commit/de5342c65a23eae01e0016f6a4b34cd33796d0b4) | Prompt/behavior policy yêu cầu lời giải thích tiếng Việt thông thường, giữ numbered choices và hành động tiếp theo | [User guide](guide/README.md), [Conversation reference](../packages/conversation/README.md) |
| [50580bf](https://github.com/qxbao/bflow/commit/50580bf4006a1d965116634da018b5d6585c7558) | Technical notice detail vào Log và truy vấn theo yêu cầu; giảm raw notice/wake noise trong context mặc định | [Runbook](operations-runbook.md), [Conversation updates](guide/conversation-updates.md) |
| [9e6fdfa](https://github.com/qxbao/bflow/commit/9e6fdfa8bdbec8e0bb0f596c03bca0bbaaf9dbfd) | Nhận display acknowledgement khi câu trả lời tiếng Việt nêu đúng nhãn công việc | [Display semantics](guide/conversation-updates.md#chi-tiết-kỹ-thuật-và-giới-hạn-hiển-thị) |
| [b76adcb](https://github.com/qxbao/bflow/commit/b76adcbd348016c930f2ec9a36853241026fea2e) | Alias whole-token, không đoán mã legacy, serialize append; expiry theo thời điểm render, Stop mang card plaintext, detail không bị lặp trong reply | [Approval](guide/security-approval.md), [recovery](guide/session-recovery.md), [Runtime reference](../packages/runtime/README.md) |
| [2357669](https://github.com/qxbao/bflow/commit/235766979a002a2b0e6b16457f528e1506a9e566) | Machine setup doctor dùng native login status trong môi trường tài khoản thông thường, tránh Agy first-run chưa onboarding; check dùng diagnostic của exact-pin destination và apply giải quyết stale native intent khi đủ bằng chứng | [Setup native checks](setup-guide.md#kiểm-tra-native-login-và-intent-superpowers), [installer recovery](../packages/tool-installer/README.md) |

## Phạm vi thay đổi bổ sung sau 5dfceac (5dfceac..c1caccb)

| Commit | Hành vi/source đã thêm | Tài liệu bổ sung |
| --- | --- | --- |
| `3162119` | Tích hợp giao dịch lease độc quyền `BrowserResourceTransactions` (`gen-N/browser-resource-transactions.json`, TTL 5 phút, tối đa một lease cho mỗi attempt, `browser_lease_busy`, giữ `quarantined`/`release_uncertain` khi lỗi/restart) | [Runtime README](../packages/runtime/README.md), [Known limitations](known-limitations-v3.md), [Tools integration](tools-sdlc-integration.md) |
| `9f21268` · `75075bc` | Tách `bflow setup` cấp máy (dùng chung Context7 và MemPalace giữa các repo/worktree; không dùng chung Chrome profile của setup) khỏi `bflow init` cấp kho mã (lập chỉ mục GitNexus và đăng ký `gitnexus-<repo>` vào Gateway đang chạy; `--check`, `--remove`, `--no-gitnexus`) | [Setup guide](setup-guide.md), [bflow init guide](guide/bflow-init.md), [CLI reference](../apps/cli/COMMAND_REFERENCE.md) |
| `078b49b` · `b8ad878` | Bỏ bằng chứng tự sinh cho `integration_test`/`manual_review`; `auto:static` chỉ chạy `git diff --check` + kiểm tra cú pháp JS/JSON thật; từ chối đề xuất có policy không thể đo tự động | [Runtime README](../packages/runtime/README.md), [Verification runners](verification-runners.md) |
| `5f2c503` | Dịch đầu ra CLI hướng người dùng sang tiếng Việt ngắn gọn và thêm cờ toàn cục `--debug` | [CLI reference](../apps/cli/COMMAND_REFERENCE.md), [CLI README](../apps/cli/README.md) |
| `4b432f6`..`ea15b4d` | Thêm `environment.verification.regressionScope` (`affected` mặc định \| `full` \| `mapped_only`) và cổng `host-regression-<profile.id>` cho JS/TS runner tự phát hiện dùng GitNexus `IMPORTS` closure | [Verification runners](verification-runners.md), [Config reference](guide/configuration-reference.md) |
| `8aef063`..`4f4020d` | Thêm `environment.fastPath.mode` (`auto` mặc định \| `off`) và cơ chế `reviewWaiver` ([ADR 0004](adr/0004-fast-path-review-waiver.md)) cho thay đổi `trivial` đơn tác vụ | [ADR 0004](adr/0004-fast-path-review-waiver.md), [SDLC policies](sdlc-policies.md), [Config reference](guide/configuration-reference.md) |
| `fbc3fa9` · `9d64684` · `0a5ecc3` · `d266a3a` | Cô lập instruction home của Codex (`codexHomeDirectory` / `codexProcessHomeDirectory`), nạp sẵn hướng dẫn vào system prompt và cố định prefix hook Conversation để tối ưu prompt cache | [Agent providers](../packages/agent-providers/README.md), [Runtime README](../packages/runtime/README.md) |
| `92fcd92` · `1ee736a` | Hỗ trợ chế độ rút gọn opt-in (`compact: true`), phân trang MCP (`read_mcp_output_page`) và công cụ `read_project_policy` | [Runtime README](../packages/runtime/README.md), [Implementation status](implementation-status.md) |
| `91f1ee2` · `682cbcd` · `62b4e6c` | Bắt buộc verdict độc lập phủ đủ mọi rework finding của generation hiện hành; thêm cổng bắt buộc `host-test-integrity` (AST JS/TS + Reviewer adjudication + owner exception) và hạ cấp fast-path dưới bộ cổng mặc định | [Rework causality](rework-causality.md), [Test integrity](../packages/runtime/TEST-INTEGRITY-VALIDATION.md), [Known limitations](known-limitations-v3.md) |
| `9140695` · `901caa6` | Bàn giao tác vụ có xác thực (`propose_task_handover` / `read_task_handover`, `resumeContext`) ghim theo generation, `HEAD` và SHA-256 của file | [Runtime README](../packages/runtime/README.md), [Contracts](contracts.md) |
| `482975c` | Báo cáo telemetry chỉ đọc cho lượt chạy qua host đang hoạt động (`bflow status <run-id> --telemetry [--json]`) | [Telemetry spec](../packages/runtime/TELEMETRY-SPEC.md), [CLI reference](../apps/cli/COMMAND_REFERENCE.md) |
| `c1caccb` | Phát hiện hạn chế AppArmor user namespace đối với Bubblewrap trên Ubuntu/Debian (lỗi `verification_sandbox_unavailable` kèm lý do AppArmor; doctor check `runtime-verification-sandbox`) và cung cấp profile `packages/runtime/support/bflow-bwrap.apparmor` | [Runtime README](../packages/runtime/README.md), [Troubleshooting](guide/troubleshooting.md) |

Merge commits chỉ hợp nhất các thay đổi trên, không được tính thành tính năng mới hoặc một mức bằng chứng riêng. Các liên kết source trong từng guide là căn cứ cho hành vi, không chỉ dựa vào commit message.

## Những gì không được suy ra

- Card, alias, surfaced/display receipt hoặc tab Logs không cấp approval, không thay provenance của human turn và không chứng minh task thành công.
- Dossier hợp lệ và artifact có checksum không tự chứng minh giải thích nguyên nhân gốc đúng; verification độc lập vẫn phải kiểm tra code/evidence và các criterion.
- Skill/reference mới không tạo capability, không thay TddDecision và không mở browser/live tooling thiếu grant/lease.
- Source và local tests mới không đóng full provider/Herdr SDLC acceptance, active-fault campaign hoặc các cam kết same-UID/multi-host/power-loss còn mở.

Xem [implementation status](implementation-status.md) để đọc trạng thái tổng thể và [roadmap](next-roadmap.md) cho các khoảng trống nghiệm thu còn lại.
