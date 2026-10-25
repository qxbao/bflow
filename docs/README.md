# Tài liệu Bflow

Bắt đầu từ [README](../README.md), [cài đặt](guide/installation.md) và [repository mẫu](guide/getting-started.md). Các trang vận hành hiện tại được đối chiếu với source; báo cáo nghiệm thu ghi lại kết quả tại baseline và môi trường của riêng chúng.

## Sử dụng và vận hành

| Nhu cầu | Tài liệu |
| --- | --- |
| Build, bootstrap `bin.js setup`, dùng lệnh tắt `bflow` | [Installation](guide/installation.md) |
| Setup máy, Gateway, đăng nhập và profile | [Setup guide](setup-guide.md) |
| Cập nhật, mã thẻ/việc và câu trả lời | [Conversation updates](guide/conversation-updates.md) |
| Chạy phiên đầu tiên trong repo độc lập | [Getting started](guide/getting-started.md) |
| Init, up, attach, down, config và recovery | [User guide](guide/README.md) |
| Cú pháp và phạm vi các lệnh | [CLI reference](../apps/cli/COMMAND_REFERENCE.md) · [High-level commands](../apps/cli/docs/command-reference.md) |
| Runner được phát hiện, owner override, sandbox | [Verification runners](verification-runners.md) |
| Điều hành, lỗi, trạng thái và phục hồi | [Runbook](operations-runbook.md) · [Troubleshooting](guide/troubleshooting.md) |
| Hỗ trợ hiện tại và phần còn mở | [Implementation status](implementation-status.md) · [Compatibility](compatibility-matrix.md) · [Limitations](known-limitations-v3.md) · [Roadmap](next-roadmap.md) |

## Kiến trúc và đặc tả

Đọc theo thứ tự: exported schema/source → quyết định tương thích đã duyệt → đặc tả → hướng dẫn. Nếu có khác biệt, báo mismatch; tài liệu không cấp quyền thay contract hoặc bỏ gate.

| Phạm vi | Nguồn tham chiếu |
| --- | --- |
| Năm thành phần, bốn miền trạng thái | [Overview](guide/architecture-overview.md) · [Architecture v2](architecture-v2.md) |
| Platform v3, ownership, tương thích D24-01 | [Runtime v3](runtime-architecture-v3.md) · [Provider contracts](provider-contracts.md) |
| RoleMessage, native receipts, correlation | [Communication protocol](communication-protocol.md) · [ADR 0003](adr/0003-authenticated-herdr-receipts.md) |
| SDD, Conditional TDD, bounded verification và approval | [SDLC policies](sdlc-policies.md) |
| Public ports, recovery và event/checkpoint | [Contracts](contracts.md) · [ADR 0001](adr/0001-p00-contract-hardening.md) · [ADR 0002](adr/0002-p01-recovery-rework.md) |
| Tool policy D-TOOLS-01, invocation và consumption | [Integration guide](tools-sdlc-integration.md) · [Accepted design](superpowers/specs/2026-10-24-tools-sdlc-design.md) |
| Nguyên nhân gốc và evidence trong rework | [Rework causality](rework-causality.md) |
| NFR và kiểm thử tương xứng rủi ro | [NFR/test design](nfr-and-test-design.md) |
| Commit mới so với mốc docs ban đầu | [Main updates audit](main-updates-2026-10-25.md) |
| Shared MCP và skills được pin | [Gateway architecture](shared-mcp-architecture.md) · [Skills architecture](skills-architecture.md) · [Canonical catalog](../skills/README.md) |

## Bằng chứng và báo cáo lịch sử

Các báo cáo bên dưới **không phải ma trận hỗ trợ của HEAD**. Giữ nguyên baseline, số lượng test và quan sát gốc; những hạn chế đã có source fix được cập nhật tại [implementation status](implementation-status.md). Một probe thật không thay thế nghiệm thu workflow đầy đủ.

- [P11–P21 acceptance](acceptance/2026-10-16-p11-p21.md), [startup UX](acceptance/2026-10-16-lifecycle-startup-ux.md), [P25–P29 audit](acceptance/2026-10-17-p25-p29.md).
- [P22 release report](release-readiness.md), [v3 release report](release-readiness-v3.md), [E2E report](e2e-report.md), [provider probes](provider-compatibility.md).
- [macOS portability](acceptance/2026-10-24-macos-portability.md) và [follow-up review](acceptance/2026-10-24-macos-portability-review.md).
- [NFR guidance handoff](../packages/skills/NFR_GUIDANCE_HANDOFF.md): hồ sơ lịch sử về catalog/schema/local integration, giữ cả các timeout và full run chưa hoàn tất; digest trong hồ sơ không thay catalog hiện hành.

- [Security review](security-review.md), [v3 security audit](security-audit-v3.md), [MCP memory benchmark](mcp-memory-benchmark.md).

Hướng dẫn API P00–P10 có đánh số nằm trong [mục legacy của user guide](guide/README.md). Chúng mô tả Runtime/demo cũ; luồng sử dụng hiện tại bắt đầu bằng `bflow up` và `bflow attach`.

## Đóng góp

Đọc [AGENTS.md](../AGENTS.md), package README và script trong `package.json` trước khi sửa. Chạy dependency check, typecheck, test và `git diff --check` trước handoff; test live chỉ chạy khi được cấp phạm vi phù hợp. Giấy phép của Bflow: [AGPL-3.0-only](../LICENSE).
