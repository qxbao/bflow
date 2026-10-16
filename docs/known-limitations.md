# Known limitations sau P22

Follow-up lỗi Ctrl+C/readiness/layout/original prompts đã được sửa; kết quả và
giới hạn riêng ở [lifecycle startup UX](acceptance/2026-10-16-lifecycle-startup-ux.md).
Các số liệu/baseline bên dưới giữ đúng phạm vi nghiệm thu P22 trước follow-up.

Phân loại toàn sản phẩm: **Not ready cho Agentic SDLC MVP v2**, do chưa có full
multi-model SDLC acceptance thực. [Release readiness](release-readiness.md) phân
biệt source đã sửa, kiểm thử local, provider smoke và điều kiện phát hành.

| ID / ưu tiên | Trạng thái và giới hạn | Owner / điều kiện đóng |
| --- | --- | --- |
| RR-01 / code FIXED, evidence P1 | CLI boot host, Node TAP/Vitest runner, RGR và QA-resume task notice đã nối; không còn docs-only implementation. Chưa full AI feature/bugfix completion | Runtime + QA: một run thật từ Chat đến approved delivery, giữ correlated receipts/artifacts |
| RR-02 / idle FIXED, active P1 | up/down/up/down thật đạt; chưa live drain/crash/restart workflow AI đang chạy với dirty/ignored files và pending approval | Lifecycle + QA: active fault campaign, không duplicate hoặc mất worktree/approval |
| RR-12 / owner decision | Owner cho phép autoaccept spec rủi ro thấp; human-required/project/design/task/delivery vẫn bắt buộc | Giữ phạm vi ngoại lệ; không mở rộng sang delivery hoặc tự approve protected action |
| RR-13 / security scope | Behavioral commands có Bubblewrap filesystem/PID/network sandbox. Các provider role vẫn cùng UID; native hooks/tool policies chưa là sandbox cho toàn bộ provider process | Host/Security: threat model và OS principal/container separation nếu cần chống compromised same-user process |
| RR-14/15 / FIXED local+idle live | Login/native launch receipts, partial startup recovery và exact session/socket realm đã sửa | Không suy ra mọi provider/version đều được hỗ trợ; default host hiện chỉ Claude |
| RR-16 / P2 observability | Background relay/host diagnostics có scrub; structured context/logger/metrics services chưa compose toàn tuyến. Raw evidence/provider logs có thể chứa dữ liệu nhạy cảm | Runtime/operations: operational sink + canary campaign; redaction không bảo đảm encoded/unlabeled/binary secrets |
| RR-17/18 / FIXED local | Confined regular-file reads và total context budget đã enforce | Không hostile same-user path-swap hoặc mọi memory-allocation bound |
| RR-19 / local FIXED, live pending | Human/review/evidence/native ledgers đã durable. Exact lease renew/release và failed-phase outcome phục hồi qua crash | QA: active model run fault injection; uncertainty cần reconcile, không reset journal để phục hồi |
| RR-20 / release gate | Local compiled archive đã smoke; hosted GitHub environment approvals/branch protections/PR publication chưa thử | Release owner xác minh settings và tag/source/publication riêng; chưa deploy/merge/publish |
| RR-21 / evidence P1 | Local E2E dùng fake transport; native actor và Claude hook tests không chứng minh full AI SDLC | QA/integration: feature, required TDD, docs alternative, repair/exhaustion, parallel/conflict và human delivery evidence |
| RR-22 / runner scope | Linux + /usr/bin/bwrap + namespaces; Node flat TAP, Vitest 2.1 JSON với trusted companion. Dependency roots chỉ canonical node_modules; không install/build tự động | Runtime: framework/dependency preparation được owner cấu hình và review; không chạy fallback bỏ sandbox |
| RR-23 / runner scope | Mixed manual/automated criteria, coverage threshold, workspace links ra ngoài mounts, build-generated dist/snapshots chưa hỗ trợ | Mixed criteria/coverage bị reject trước workflow; missing dependency/build inputs bị chặn khi đo. Mở rộng bằng evidence/protocol cụ thể |
| RR-24 / resource scope | Wall timeout/output/loop bounds có; sandbox dùng chung kernel và không có cgroup quota CPU/memory/disk | Security/operations: resource controls trước multi-tenant hoặc untrusted workload use |
| RR-25 / environment | Host socket tự fallback đường dẫn ngắn; một số Herdr/POSIX socket paths vẫn phụ thuộc môi trường. Nghiệm thu dùng TMPDIR=/tmp và XDG realm ngắn, riêng session | Linux operator: dùng short temp/socket realm; không nhận diện EINVAL là provider auth hay protocol incompatibility |
| RR-26 / verified target environment | Checkout gốc /mnt/... trên fuseblk: chmod 0700/0600 vẫn ra 0777, owner root trong khi caller UID 1000. Không đáp ứng private host-file permissions; lifecycle nghiệm thu chạy trên POSIX /tmp | Operator: dùng worktree/repository trên POSIX filesystem, hoặc review external-state migration riêng; không bỏ permission checks. Bằng chứng target-filesystem-permissions.json, probe đã xóa |
| P02-RA01 / P2 OPEN | Herdr Adapter large runner timeout overflow | Owner Herdr Adapter; không đóng bằng timeout fix Runtime |
| P03-RA01 / P2 OPEN | ArtifactStore late final get chunk sau deadline/abort | Owner ArtifactStore; không đóng bằng test khác |

Human trust dựa vào trusted physical input hook và immutable receipt. Một process
compromised cùng UID đọc được role tokens/inject terminal vẫn nằm ngoài guarantee.
Reviewer phải xem exact diff/commit và criteria; command PASS không tự chứng minh
một test có ý nghĩa hoặc chống người viết test gian lận. Independent review gates
vẫn bắt buộc cho behavioral work.

Legacy `run/status <id>/approve/resume/cancel` dùng Runtime cũ và storage riêng;
không tự mở P19. Conversation-only được enforce trên Agentic path, chưa là độc
quyền mọi API trong binary. Không dùng legacy resume để chứng minh P19 recovery.

Không chứng nhận macOS/Windows behavioral runner, NFS/network filesystems,
multi-host/distributed leases, power-loss/kernel crash, hostile kernel/root,
provider credential separation hoặc hosted branch protection. `/tmp` evidence
phải được lưu riêng trước reboot; artifact tồn tại không chứng minh task success.
