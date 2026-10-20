# Hướng dẫn sử dụng Bflow

Bộ hướng dẫn cho repository mới dựa trên source implementation hiện tại. CLI
lifecycle và P19 host là hai luồng riêng; tính năng chưa tự tích hợp được ghi rõ
là **planned/chưa triển khai**. Public contracts và ADR vẫn là nguồn authoritative.

| Chủ đề | Nội dung |
| --- | --- |
| [Getting Started](getting-started.md) | Thử trên repository Node.js/TypeScript riêng |
| [Installation](installation.md) | Cài đặt/build từ source, Node/pnpm/Herdr |
| [bflow init](bflow-init.md) | config.yml có chú thích, Git identity, migration, idempotency và cờ overwrite |
| [bflow up](bflow-up.md) | Named session, role thường trực, readiness, giới hạn khi khởi động host |
| [bflow attach](bflow-attach.md) | Chỉ attach Conversation |
| [Recovery sau Ctrl+C](troubleshooting.md) | Kernel lock, recover --yes, native startup dialogs và pane labels |
| [bflow down](bflow-down.md) | Barrier/checkpoint và giới hạn shutdown mặc định |
| [Configuration Reference](configuration-reference.md) | Fields thực tế, config CLI/host/Herdr |
| [Agent Roles](agent-roles.md) | Đủ tám role và ánh xạ contract names |
| [SDD & TDD Policies](sdd-tdd-policies.md) | Đánh giá rủi ro, các mức, required/recommended/not_applicable |
| [Verification Loop](verification-loop.md) | Kiểm tra độc lập, giới hạn retry/rework/iteration |
| [Session Recovery](session-recovery.md) | Restart, uncertain delivery, receipt và aggregate replay |
| [Herdr Communication](herdr-communication.md) | RoleMessage, native receipt đã xác thực, giới hạn transport |
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
| Down của default CLI adapter | Đã compose host quiesce/checkpoint + P13 shutdown; live lifecycle smoke đạt; --yes không bypass barrier |
| P14–P19 SDLC composition | Có API `openAgenticWorkspace`, cần trusted host/provider tool registration/check/auth |
| Conditional TDD/SDD/verification | Environment policies được truyền vào host; evidence hỗ trợ manual review và owner-configured Node TAP/Vitest trên Linux |
| CLI tự boot/shutdown host P19 | Đã triển khai cho native Claude hooks/MCP; live up/down/restart smoke đạt |
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
