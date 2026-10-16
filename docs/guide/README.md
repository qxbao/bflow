# Hướng dẫn sử dụng Bflow

Bộ hướng dẫn cho repository mới dựa trên source implementation hiện tại. CLI
lifecycle và P19 host là hai luồng riêng; tính năng chưa tự tích hợp được ghi rõ
là **planned/chưa triển khai**. Public contracts và ADR vẫn là nguồn authoritative.

| Chủ đề | Nội dung |
| --- | --- |
| [Getting Started](getting-started.md) | Thử trên repository Node.js/TypeScript riêng |
| [Installation](installation.md) | Source install/build, Node/pnpm/Herdr |
| [bflow init](bflow-init.md) | JSON config.yaml, Git identity, idempotency và cờ overwrite |
| [bflow up](bflow-up.md) | Named session, permanent roles, readiness, giới hạn host boot |
| [bflow attach](bflow-attach.md) | Chỉ attach Conversation |
| [bflow down](bflow-down.md) | Barrier/checkpoint và giới hạn shutdown mặc định |
| [Configuration Reference](configuration-reference.md) | Fields thực tế, config CLI/host/Herdr |
| [Agent Roles](agent-roles.md) | Đủ tám role và ánh xạ contract names |
| [SDD & TDD Policies](sdd-tdd-policies.md) | Risk assessment, levels, required/recommended/not_applicable |
| [Verification Loop](verification-loop.md) | Independent checks, retry/rework/iteration bounds |
| [Session Recovery](session-recovery.md) | Restart, uncertain delivery, receipt và aggregate replay |
| [Herdr Communication](herdr-communication.md) | RoleMessage, authenticated native receipts, transport limits |
| [Troubleshooting](troubleshooting.md) | Chẩn đoán theo implementation |
| [Security & Approval](security-approval.md) | Secrets, trusted host và approval boundaries |
| [Architecture Overview](architecture-overview.md) | Năm thành phần và bốn state domains |

Mẫu portable: [templates/node-typescript](../../templates/node-typescript/README.md).
Repository thử nghiệm: [examples/portable-node](../../examples/portable-node/README.md).
[Báo cáo kiểm chứng](../../templates/node-typescript/VALIDATION.md) ghi commands,
exit codes, baseline và phạm vi live Herdr thật.

## Trạng thái sử dụng

| Khả năng | Trạng thái |
| --- | --- |
| Init config và repository identity/isolation | Có implementation, kiểm chứng CLI thật trong repo tạm |
| Up/attach/status/doctor qua P12 + P13 | Có implementation; môi trường agent/provider phải cài và đăng nhập riêng |
| Down của default CLI adapter | Có command, nhưng thiếu safety integration cho session đang chạy; --yes không bypass |
| P14–P19 SDLC composition | Có API `openAgenticWorkspace`, cần trusted host/provider tool registration/check/auth |
| Conditional TDD/SDD/verification | Có engine và P19 enforcement; environment policy không tự wire vào P19 |
| CLI tự boot/shutdown host P19 | **Planned/chưa triển khai** |
| Signed Herdr native message transport | Có smoke kiểm chứng thật; không thay AI delivery hoặc independent measurement evidence |
| Live model thực hiện SDLC end-to-end | **Chưa kiểm chứng trong đợt này** |
| Automatic protected merge/push/deploy | Không có execution tool trong Runtime này |

## Tài liệu legacy P00–P10

Các trang đánh số dưới đây giữ lại để tham khảo API/demo legacy. Những đánh giá
integration trước P19 không áp dụng cho host P19 hiện tại; dùng các trang mới bên
trên cho onboarding. Không dùng ví dụ gọi Core trực tiếp để bypass policy P19.

- [01 Architecture](01-architecture-overview.md), [02 Environment](02-environment.md), [03 Herdr](03-herdr-setup.md)
- [04 Install/init](04-install-and-init.md), [05 Registry roles](05-roles-and-models.md)
- [06 Feature](06-feature-workflow.md), [07 Bugfix](07-bugfix-workflow.md)
- [08 Status/artifacts](08-status-and-artifacts.md), [09 Recovery](09-blocked-timeout-retry-resume.md), [10 Pre-merge](10-pre-merge-verification.md)

[Legacy runtime-demo](../../examples/runtime-demo/README.md) dùng outbox transport
và predefined patches, không phải model hoặc Herdr E2E.
