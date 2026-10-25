# Trạng thái triển khai hiện tại

Đối chiếu tài liệu ngày **2026-10-25** với source baseline **`355a998c97aa301c39f7f5f08791a0bf2f3e3a7a`**. Đây là bản đồ source và bằng chứng đã lưu trong repo, không phải một lần nghiệm thu provider mới. Khi source thay đổi, kiểm tra lại các liên kết triển khai trước khi nâng mức hỗ trợ.

## Cách đọc bằng chứng

| Mức | Chứng minh điều gì? |
| --- | --- |
| Source | Có implementation, schema và đường gọi production |
| Local test | Hành vi trong fixture, fake runner hoặc integration cục bộ; có thể dùng Git/SQLite/sandbox thật |
| Live probe | Binary, provider, daemon hoặc dịch vụ thật đã được thử trong môi trường ghi trong báo cáo |
| Full SDLC acceptance | Đầu vào người dùng qua Conversation, thực thi bằng provider thật, tiêu chí/bằng chứng/approval đầy đủ tới bàn giao |

Không suy mức cuối từ `tools/list`, Herdr `idle`/`done`, setup receipt, model ping hoặc test transport có kiểm soát. Các hồ sơ live cũ chỉ có giá trị trong phạm vi chúng đã đo.

## Hành vi đang có

| Phạm vi | Hiện trạng và nguồn |
| --- | --- |
| Bootstrap CLI | `node apps/cli/dist/bin.js setup` tạo launcher `bflow`, managed PATH, setup receipts và Gateway. Xem [path-manager](../packages/machine-setup/src/path-manager.ts), [setup integration](../apps/cli/src/setup-integration.ts). `BFLOW_HOME` chọn isolated state/provider source, không phải đường dẫn source checkout. |
| Repository config | `.bflow/config.yml`, provider mặc định Codex, `workspace_auto`, `trustedWorkspace: true`, concurrency 2, verification 3 vòng, startup 300.000 ms. `init --update` bổ sung defaults/comment và giữ giá trị cũ; [schema/defaults](../apps/cli/src/environment-config.ts) là nguồn chuẩn. |
| Lifecycle và P30 | `up` mở persistent host, chuẩn bị platform trước launch, xác minh native binding, startup attestation và activated health. SDD/TDD/verification/concurrency được truyền vào host; `down` mở policy đã lưu để quiesce/checkpoint/revoke. [Host wiring](../apps/cli/src/agentic-host.ts), [platform](../packages/runtime/src/platform), [host platform](../packages/runtime/src/agentic/host-platform.ts). |
| Providers | Claude/Codex có đường Conversation và specialist. Agy có native launch/hook/shim/binding ở source và local tests; Conversation thiếu trusted human-input provenance, unattended vẫn unsupported. [Provider README](../packages/agent-providers/README.md), [compatibility](compatibility-matrix.md). |
| Tool policy D-TOOLS-01 | CLI phân biệt catalog tool, service và upstream operation; resolve grant theo role/scope/readiness. Các tích hợp mặc định được yêu cầu ở mức optional; công cụ chưa sẵn sàng hiển thị degraded. Explicit `toolPolicy` có scope/digest riêng. [Resolver](../apps/cli/src/platform-options.ts), [integration guide](tools-sdlc-integration.md). |
| Skills | Approved role bindings, exact pins và immutable manifest theo generation; không khai `role.skills` dùng defaults, `[]` bỏ defaults nhưng giữ `requiredSkills`. Tool skill chỉ active khi đủ grant. Không sửa bundle đã pin mà giữ digest cũ. [Skills](../packages/skills/README.md), [CLI composition](../apps/cli/src/skill-catalog.ts). |
| Standalone CLI diagnostics | Đường binary cấp cao chưa inject live Gateway port cho `mcp status`; `skills list`/`sync --list` chưa được parser nhận. `agent check` có thể chạy model probe và không chọn role/profile từ config. Phân biệt với platform host đã nối Gateway. [CLI limits](../apps/cli/docs/command-reference.md#tích-hợp-và-giới-hạn-hiện-tại). |
| Shared Gateway | Registration tách theo service/operation; Context7 hosted được chia sẻ giữa worktrees, backend local vẫn gắn workspace. Ledger giữ intent/unknown, schema pin và structured MCP output. [Gateway README](../packages/mcp-gateway/README.md), [control endpoint](../apps/cli/src/gateway-control.ts). |
| Exclusive resources | Runtime acquire/renew/release lease cho GitNexus theo registration/generation, bảo toàn unknown/quarantine. Browser task actions vẫn bị chặn/degraded với `exclusive_resource_lease_unsupported`; không suy browser usable từ lease API cấp Gateway. [Host implementation](../packages/runtime/src/agentic/host.ts). |
| Context khảo sát | `assignment_context` cung cấp source/test/docs/dependency tĩnh có giới hạn cho Coordinator/specifier/architect/planner, gắn HEAD/fingerprint/line evidence, mức observed/inferred/unknown và drift. Không tự thay spec, approval hoặc trạng thái task. [Assignment survey](../packages/runtime/src/agentic/assignment-survey.ts), [ProjectContextService](../packages/runtime/src/context/project-context-service.ts). |
| Verification | Tự phát hiện runner, `.bflow/verification.json` là owner override tùy chọn. Polyglot adapters và parser có phạm vi riêng; JS/TS có Linux Bubblewrap và macOS Seatbelt. Native polyglot mounts và dependency warming vẫn Linux-only. [Runner matrix](verification-runners.md). |
| Workspace file tools | Developer đọc/ghi UTF-8 theo ownership, lease/fence và TDD; Linux/macOS helper chống traversal/symlink/hardlink/special file, giới hạn 128 KiB. Không có arbitrary shell/file permission từ skill. [Runtime README](../packages/runtime/README.md). |
| Recovery và Conversation | Durable inbox/outbox, approval, cancellation và bounded resume; notice nêu blocker, pending action, cách trả lời cho đúng run. Yêu cầu revision chờ quyết định qua Conversation; resume không thay approval. [Recovery guide](guide/session-recovery.md), [Runtime reference](../packages/runtime/README.md). |

## Nghiệm thu còn mở

- P31 chưa có cây `tests/platform-v3/**` hoặc `tests/acceptance/platform-v3/**`. Đã có coverage platform trong [E2E scenarios](../tests/e2e/scenarios) và test của package; không gọi toàn bộ platform là chưa có test.
- Chưa có hồ sơ đóng đầy đủ live SDLC đa provider, từ input Conversation đến human delivery approval, hoặc chiến dịch active provider fault/restart. Các báo cáo [v3](release-readiness-v3.md), [tools design](superpowers/specs/2026-10-24-tools-sdlc-design.md) và [macOS](acceptance/2026-10-24-macos-portability.md) ghi rõ giới hạn riêng.
- macOS có source fix, local tests và phép đo sandbox/workspace thật được ghi lại; không đồng nghĩa đã nghiệm thu full SDLC. Windows vẫn `designed_unverified` cho machine mutation.
- Chưa nâng cam kết hostile same-UID, network filesystem, multi-host hay power-loss durability. `P02-RA01` và `P03-RA01` vẫn thuộc owner ban đầu, xem [limitations](known-limitations-v3.md).
- Thành công một lệnh high-level không phải thành công workflow. Legacy `run`/`approve`/`resume`/`cancel` dùng Runtime store riêng; vận hành P19 qua Conversation và host status.

## Bản đồ package

| Package | Trách nhiệm |
| --- | --- |
| [CLI](../apps/cli/README.md) | Setup, lifecycle, diagnostics, high-level commands, docs và iso |
| [Contracts](contracts.md) | Zod schemas, public ports, event/checkpoint/transition validators |
| [Core](../packages/core) | Deterministic DAG, scheduler, retry/rework, aggregate recovery |
| [Runtime](../packages/runtime/README.md) | Ghép các port, host, coordinator tools, dispatch và policy enforcement |
| [Herdr adapter](../packages/herdr-adapter/README.md) · [Pane manager](../packages/pane-manager/README.md) | Transport receipts, protocol, process/pane/session lifecycle |
| [Registry](../packages/agent-registry/README.md) | Role resolution, leases, fencing và workflow templates |
| [Persistence](../packages/persistence/README.md) · [Artifact store](../packages/artifact-store/README.md) | SQLite events/receipts/checkpoints, immutable content-addressed artifacts |
| [Conversation](../packages/conversation/README.md) | Intake, clarification, delegation và human decisions |
| [Specification](../packages/specification/README.md) · [Test strategy](../packages/test-strategy/README.md) | Accepted specs, traceability và Conditional TDD |
| [Verification](../packages/verification/README.md) · [Quality gates](../packages/quality-gates/README.md) | Independent evidence, criteria và bounded verification |
| [Git orchestrator](../packages/git-orchestrator/README.md) | Task worktrees, ownership, ordered integration và safe cleanup |
| [Agent providers](../packages/agent-providers/README.md) | Discovery/auth/capability, permission compilation và attestation |
| [Machine setup](../packages/machine-setup/README.md) · [Tool installer](../packages/tool-installer/README.md) | Plans, approvals, pins, owned config và receipts |
| [MCP Gateway](../packages/mcp-gateway/README.md) · [MCP services](../packages/mcp-services/README.md) | Shared tool connections, scoped grants và exclusive resources |
| [Skills](../packages/skills/README.md) · [Catalog](../skills/README.md) | Instruction bundles, dependencies và role manifests |
| [Docs retrieval](../packages/docs-retrieval/README.md) | Version-aware library documentation qua caller được inject |
