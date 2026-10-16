# Next roadmap sau P22

Đã có default Claude host/lifecycle, owner-configured Node TAP/Vitest runner,
independent RGR, sandbox, durable approval/native/evidence receipts và exact
lease/phase-outcome crash recovery. Không làm lại các phần đó từ scaffolding.
Readiness hiện tại và source kiểm thử ở [release-readiness](release-readiness.md).

Mục tiêu kế tiếp là **Limited pilot có full AI acceptance evidence**; không tự
đổi thành production-ready.

| Ưu tiên | Owner / công việc còn lại | Bằng chứng đóng |
| --- | --- | --- |
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
