# Next roadmap sau P22 (cập nhật P25–P29)

Follow-up lỗi Ctrl+C/readiness/layout/original prompts đã được sửa; kết quả và
giới hạn riêng ở [lifecycle startup UX](acceptance/2026-10-16-lifecycle-startup-ux.md).
Các số liệu/baseline bên dưới giữ đúng phạm vi nghiệm thu P22 trước follow-up.

**Đã có source sau P24 (không làm lại từ scaffolding):** P25 provider adapters, P26 machine
setup + tool installer, P27 MCP Gateway + services, P28 skills, P29 CLI high-level commands
và unified lifecycle validation, cùng agent system prompt/behavior policy. Mức bằng chứng
là source + local test; xem [hồ sơ P25–P29](acceptance/2026-10-17-p25-p29.md). Bảng dưới chỉ giữ phần còn mở:
**tích hợp (P30)**, **nghiệm thu (P31)**, live evidence và các mục P22 chưa đóng.

Đã có default Claude host/lifecycle, owner-configured Node TAP/Vitest runner,
independent RGR, sandbox, durable approval/native/evidence receipts và exact
lease/phase-outcome crash recovery. Không làm lại các phần đó từ scaffolding.
Readiness hiện tại và source kiểm thử ở [release-readiness](release-readiness.md).

Mục tiêu kế tiếp là **Limited pilot có full AI acceptance evidence**; không tự
đổi thành production-ready.

| Ưu tiên | Owner / công việc còn lại | Bằng chứng đóng |
| --- | --- | --- |
| P1 — P30 hardening (source đã có 2026-10-18) | Runtime/Pane Manager/Conversation owner + P31: hardening local đã xong (2026-10-18: reachability trong process cho mọi role kể cả Developer, phát hiện registration mất, thu hồi khi daemon restart, đường trả lời quyết định end-to-end). Còn xác minh live: Herdr chuyển env vào provider, hook SessionStart thừa kế env, Claude `${VAR}` header, Codex `bearer_token_env_var` | Readiness `ready` kèm activated health trước `up` success; interrupted-startup receipt giữ lại; không bypass SDD/TDD/gate/lease/fence/human approval; test boundary (không phải fake-runner) |
| P1 — P31 acceptance | QA: tạo `tests/platform-v3/**`, `tests/acceptance/platform-v3/**` — conformance 3 provider (unsupported báo thật), auth/trust/binary/MCP/skills failure trước up, denied escalation, unattended cần cách ly full-process, hai repo song song, stdio crash/unknown call, external worker survival, Chrome lease/fence race, config drift | Báo cáo nghiệm thu tách mức source/local/live/full SDLC; phát hiện quay về production owner; chỉ sau P29/P30 tích hợp |
| P1 — P29 closure | CLI owner: `up` đã dựa readiness của Runtime host (P30); chờ compatibility evidence P31; quyết định có thêm `feature/bugfix/refactor/review` hay không (hiện chưa có) | Compatibility verified với facade; command acceptance không bị coi là workflow acceptance |
| P2 — live provider/platform probes | Provider/Setup/MCP owner: login/permission/MCP/skills probe thật cho Claude, Codex, Agy theo từng version; live install/rollback RTK/GitNexus/Chrome DevTools MCP/Superpowers; live Chrome profile + OS service (systemd/launchd); audited npm dependency tree hoặc offline bundle; review license GitNexus | Evidence riêng từng probe (command, version, exit, receipt); Agy chỉ nâng khỏi `unsupported` khi enforcement được chứng minh; Windows vẫn `designed_unverified` đến khi có host thật |
| P1 — local platform | Operator: dùng POSIX worktree/repository; checkout gốc fuseblk không giữ private file permissions | stat/chmod 0700/0600 đúng owner, host activation/receipts được test ở vị trí đó; external-state migration cần design riêng nếu giữ source trên mount gốc |
| P1 — live happy path | QA + Runtime: disposable repository, Claude đã login, owner command config có exact tests; một feature/required-TDD bugfix và một docs alternative workflow | Chat-only user request tạo spec/task thật; model Developer commits; independent Red/Green/Refactor, Reviewer và QA exact-revision gates; Git integration; human delivery approval. Giữ run/session/native IDs, receipts, artifacts và provider cost |
| P1 — active recovery | Lifecycle/QA: down khi task dirty/ignored, SIGKILL host quanh approval/send/phase/release, restart đúng session | Không mất data/approval, không duplicate prompt/worktree, unknown delivery reconcile trước resend; compare HEAD/sentinels/checkpoints/receipts |
| P1 — adversarial live flow | Security + QA: Chat direct-dispatch, Coordinator selfapprove, Developer spec/test rewrite, repair self-review, rejection và exhaustion | Actual tools/hooks fail-closed; không chỉ schema assertions. Sandbox file/socket/network canaries giữ nguyên, scope/approval không bị vượt |
| P2 — broader runner support | Runtime: reproducible dependency preparation, workspace symlinks/build inputs, mixed methods/coverage/reporters có explicit authority | Exact prepared inputs/hash/protocol; generated artifacts và isolation được review. Không mở arbitrary model-selected shell hoặc fallback unsandboxed |
| P2 — provider/process separation | Security/platform: principal/container isolation cho toàn provider, resource quotas, credential boundaries | Test same-user compromise và CPU/memory/disk/network limits; giữ trust exclusions rõ ràng đến khi có bằng chứng |
| P2 — operational composition | Runtime: context/logger/metrics sinks xuyên tuyến, backup/restore và log canaries | Redacted operational evidence, provider-reported costs, bounded context, actual restore drill; không chỉ exported helper PASS |
| Release gate | Release owner: protected branch/tag/environment settings, verified tag-source archive, controlled draft release review | Hosted settings và Actions evidence thật trước publish; không push/deploy/merge tự động từ audit này |
| Existing follow-ups | Herdr Adapter P02-RA01, ArtifactStore P03-RA01 | Reproducer/fix/evidence đúng owner, full validation lại; không đóng bằng documentation |

Pilot gate đòi ít nhất live happy-path + active recovery và explicit residual-risk
acceptance phù hợp phạm vi. Ready for personal use chỉ được xác nhận khi onboarding,
auth, attach, complete workflow, human approval, down và restart dùng đường mặc
định đạt. Production cần review riêng về threat model, availability, restore và
operations; không tự suy ra từ local test count.

Các model smoke sau giới hạn ngân sách hiện có mức dự phòng 0.1225011 USD theo cap (gồm một
lần response bị mất được tính nguyên cap), dưới 1 USD. User cho phép vượt nhẹ khi
cần; vẫn nên dùng cap từng print smoke và giới hạn tổng campaign/time/roles rõ ràng.
Không chạy workflow AI dài không theo dõi chi phí. Không hứa ngày đóng khi chưa có
full live evidence và hosted governance access.
