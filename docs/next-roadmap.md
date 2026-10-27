# Công việc tiếp theo

Roadmap theo [source hiện tại](implementation-status.md), cập nhật 2026-10-27 (`c1caccb`). P25–P30, D-TOOLS-01, runner detection, regression scope, fast-path, `host-test-integrity`, repository survey, rework-causality dossiers (kèm per-finding verdict enforcement), browser MCP resource transactions (`BrowserResourceTransactions`), task handovers, read-only workflow telemetry, Conversation cards/aliases và NFR/risk references đã có source và local tests; không giao lại chúng như bootstrap mới. Thứ tự dưới đây ưu tiên khoảng trống bằng chứng live và đường tích hợp còn thiếu.

| Ưu tiên | Công việc | Owner / điều kiện nghiệm thu |
| --- | --- | --- |
| P1 | Full live SDLC qua Conversation với provider thật | Runtime + QA: feature/bugfix required TDD, docs alternative verification, task/workflow evidence và human delivery approval |
| P1 | Platform-v3 conformance/fault campaign (P31) | QA sở hữu test mới; root CI/discovery cần integration review. Tái sử dụng e11–e16 và package tests đã có |
| P1 | Active provider crash/restart/cancellation | Lifecycle + QA: dirty worktree, waiting approval, delivery uncertain; không double dispatch, không mất authority |
| P1 | Tool invocation và consumption thật | Runtime/Gateway/CLI: exact grant, trigger, scope, trusted artifact; chứng minh dataflow vào output được chấp nhận; unavailable/degraded/restart cases |
| P1 | Live browser task lease & Chrome SDLC acceptance | Runtime + MCP services: kiểm chứng live Chrome/provider với `BrowserResourceTransactions` (acquire/renew/release, URL/profile scope, fencing/quarantine và race/crash probes); source + local tests đã có |
| P2 | macOS integration acceptance rộng hơn | Có helper/Seatbelt và phép đo thật; bổ sung full provider SDLC, platform matrix; polyglot mounts/warming cần thiết kế riêng nếu mở hỗ trợ |
| P1 | Live rework verdict & test-integrity acceptance | Runtime + QA: kiểm chứng trên provider/Herdr thật cho per-finding `findingVerdicts` và `host-test-integrity` adjudication/exception; guard cấu trúc và local tests đã có ([rework reference](rework-causality.md)) |
| P2 | Conversation/NFR live acceptance | Validate plaintext cards, exact alias decisions, detail/Log delivery and genuine NFR measurement/independent confirmation with authorized providers/tools; existing instruction/render tests do not close these |
| P2 | Repository survey consumption | Giữ observed/inferred/unknown, source citations, bounded scope và drift; đo provider delivery/utility mà không suy approval từ source hoặc memory |
| P2 | Provider support | Giữ Agy specialist constraints; Conversation cần trusted human-input provenance và acceptance riêng; không waive unattended isolation |
| P2 | Standalone CLI diagnostics closure | CLI owner: connect live Gateway status port, reconcile skills-list/parser surface and config-selected provider diagnostics; do not infer this wiring from Runtime platform integration |
| P2 | Resource budgets, dependency reproducibility, observability | CPU/RAM/I/O, transitive installer dependencies, structured traces; giữ secret redaction và audit boundaries |
| P2 | `P02-RA01` / `P03-RA01` | Giữ owner Herdr adapter / ArtifactStore và fixture tái hiện; không chuyển sang Runtime hoặc đóng bằng docs |
| Release gate | Governance, third-party licensing, packaging | Local checks không thay remote protected-branch/release evidence; publication cần quyền riêng |

Không sửa journal, xóa uncertain intent hoặc hạ gate để làm acceptance pass. Một đợt probe chỉ đóng phạm vi đã đo; báo rõ source revision, môi trường, commands, pass/fail/skip và chi phí provider. [Known limitations](known-limitations-v3.md) mô tả điều kiện kỹ thuật còn mở.
