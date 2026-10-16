# Next roadmap sau P22

Mục tiêu kế tiếp là **Limited pilot có bằng chứng AI SDLC thực**, không phải gắn
nhãn production-ready. Điểm xuất phát, implementation đã test và kết luận hiện
tại ở [release-readiness](release-readiness.md); rủi ro ở
[security-review](security-review.md).

| Thứ tự | Owner đề xuất / công việc | Điều kiện nghiệm thu |
| --- | --- | --- |
| 1 — Integration decision | Project owner + Architecture/Security: chốt policy separation of duties cho low-risk spec và tool/OS trust model | Tài liệu quyết định rõ scope tự động accept, người phê duyệt độc lập, affected owners và compatibility/migration nếu contract đổi; không tự đổi schema để vượt audit |
| 2 — Real host composition | Runtime + CLI + provider host: boot P19 cùng session P13, đăng ký Conversation/Coordinator tools, prompts, authenticated native ingress/result/evidence, real human channel, deterministic runners và scheduler | `bflow up` rồi chỉ `attach` Chat: user request tạo DelegationRequest/run/spec/assignment thật; Chat không gọi Developer trực tiếp; config SDD/TDD/concurrency/maxIterations đi vào Runtime thật |
| 3 — Lifecycle closure | Runtime + CLI + Pane Manager: wire quiesce/checkpoint/shutdown receipts, startup reconciliation và auth diagnostics | Có active workflow, dirty/ignored worktree: down không mất dữ liệu; timeout/partial close không báo down giả; restart giữ approval/unknown_delivery; hai repo đồng thời và attach chọn đúng session |
| 4 — Security completion | Provider/host + Runtime/Context: enforce read-only/tool principals, credentials, independent verifier identities; confined reads cho documentation, total prompt budget, operational redacted sinks | Adversarial probes Chat direct dispatch, Coordinator selfapprove, Developer spec rewrite, repair self-review, symlink/FIFO/log secret canaries đều fail-closed; không chỉ test schema booleans |
| 5 — Live acceptance campaign | QA + integration owner: chạy feature, required-TDD bugfix, docs-only alternative verification, parallel tasks, reject/repair/exhaustion/conflict/missing artifact | Một run giữ accepted spec/artifact checksums, Red-Green-Refactor thực, Reviewer/QA độc lập, Git exact revision, post-integration verification, human delivery decision và correlated AgentResult. Herdr done không tính success |
| 6 — Fault campaign | Reliability + storage/transport owners: SIGKILL host/agent ở intent/send/binding/verification/approval, restart Herdr, retry/cancel, delayed responses | Không duplicate prompt/worktree/PR; reconcile uncertainty trước resend; monotonic fencing; checkpoint+tail replay và durable human rejection; không giả power-loss bằng process kill |
| 7 — Release engineering | Release owner: kiểm protected branches/tags, credentials và human release governance; chạy workflow sửa trên tag approved và archive trong môi trường sạch | Tag/source/checksum đồng nhất; mọi gate PASS; dependency install + CLI smoke ngoài source tree; draft release được review trước publish; không dùng test giả làm live SDLC evidence |
| 8 — Follow-ups P2 | Herdr Adapter P02-RA01; ArtifactStore P03-RA01; CLI QA-05 docs; test stability | Owner cung cấp reproducer/fix đúng module và targeted evidence; full checks lại, không đóng từ báo cáo hoặc chuyển trách nhiệm sang Runtime |

Pilot gate chỉ mở khi bước 1–7 có bằng chứng hoặc owner chấp nhận giới hạn cụ
thể bằng văn bản mà không mâu thuẫn tiêu chí MVP. Bắt đầu với repository
disposable không remote/protected permissions, rồi mới dùng provider sandbox.
Giữ command/exit/time/commit/session/pane/run/approval IDs, artifact checksums và
redacted logs; công bố FAIL/BLOCKED/SKIP riêng.

Chỉ xét **Ready for personal use** sau khi onboarding, auth, attach, complete
workflow, graceful down và restart có đường mặc định chạy được mà không cần tự
viết host. Chỉ xét production ở một review riêng với threat model, availability,
backup/restore, security isolation và operational evidence phù hợp. Không đặt
lịch hay hứa ngày hoàn thành khi các integration decisions còn mở.
