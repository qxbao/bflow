# Known limitations sau P22

Phân loại hiện tại là **Not ready cho Agentic SDLC MVP v2**. Bảng dưới
đây phân biệt giới hạn còn mở và lỗi đã sửa bằng follow-up; xem
[release-readiness](release-readiness.md) để biết baseline và bằng chứng.

| ID / ưu tiên | Giới hạn | Ảnh hưởng, owner và điều kiện đóng |
| --- | --- | --- |
| RR-01 / bootstrap FIXED; functional scope P1 | Default CLI đã boot persistent host, role MCP/hooks, scheduler và authenticated native ingress cho Claude | Live idle lifecycle đạt. Default host chỉ nhận documentation/manual-review specs; feature/bugfix behavioral runners vẫn cần triển khai/cấu hình, không có fallback success |
| RR-02 / idle lifecycle FIXED (QA-01) | Default down đã compose quiesce/checkpoint/P13 shutdown và host shutdown | Live up/down/up/down exit 0. Chưa live crash/drain workflow AI đang hoạt động hoặc pending human approval; local Core/host tests không thay bằng chứng đó |
| RR-12 / policy decision | Chủ dự án cho phép tự accept spec rủi ro thấp trong phản hồi sau audit ngày 2026-10-16 | Không còn là blocker theo tiêu chí đã điều chỉnh. Human-required complex/project/task/delivery approvals vẫn phải xác thực human và giữ revision/generation/evidence binding; không mở rộng quyền autoaccept sang delivery |
| RR-13 / isolation scope | Claude Conversation/Coordinator native tools bị tắt, specialist read tools và role MCP được giới hạn; Developer vẫn có tools cần để sửa/commit | Đây là provider tool policy, không phải OS sandbox chống hostile process cùng UID. Không chứng nhận network/credential separation hoặc arbitrary native shell |
| RR-14 / FIXED auth diagnostic (QA-03) | CLI kiểm provider login riêng trước up; activation đòi exact native launch receipt | Idle không còn là bằng chứng auth duy nhất; up/down smoke dùng Claude đã login. Provider khác cần native hook integration đã verify |
| RR-15 / FIXED partial startup (QA-04) | P13 persist startup intent/partial manifest trước launch; CLI reconcile pane cũ sau trust prompt | Live probe: lần đầu blocked, giải trust chỉ repo disposable, retry up thành công. Không auto-adopt session không ownership, không resend unknown delivery |
| RR-16 / residual observability P2 | Background stdout/stderr qua detached redaction relay; host diagnostics scrub trước log. Context/logger/metrics helpers chưa compose đầy đủ toàn tuyến | Không hứa mọi unlabeled/encoded secret được che hoặc telemetry operational hoàn chỉnh. Provider prompt/args vẫn cần giữ sạch credentials |
| RR-17 / FIXED local | Documentation/role prompt/ADR/file analysis và drift reads đã dùng chung confined regular-file reader | Commit 648efe7 chặn cached file/parent symlink escape; 38/38 context tests PASS. Không mở rộng thành hostile same-user race guarantee hoặc trạng thái đã compose host |
| RR-18 / FIXED output budget | maxTotalBytes được enforce trên toàn formatted prompt, gồm role instructions/spec/ADR/task details | Commit ab91e37 fail-closed khi prompt quá budget, không cắt governance/criteria âm thầm; 39/39 context tests PASS. Analysis/read memory bound vẫn chưa chứng nhận |
| RR-19 / P2 | Registry/lifecycle/journal lock sau crash có thể cần operator reconcile; host-issued review/evidence/human-decision ledgers hiện ở memory | Không hứa seamless recovery mọi crash. Sau host restart, pending authenticated decisions/evidence có thể cần reconciliation trước khi nhận lại; chưa live fault-inject workflow AI đang chờ approval. Không reset DB hoặc fabricate receipts |
| RR-20 / release gate | GitHub Actions mới chỉ kiểm tra YAML/bash/local archive; GitHub environment approval, protected-branch settings và hosted PR chưa được xác minh | Release owner phải xác minh repo settings và thử draft release từ tag approved. Archive smoke local dùng dependency cache, không phải fresh network install |
| RR-21 / evidence gate | E2E scenario suite dùng fake transport; P19 fixture inject auth/gate callbacks; native smoke không model | Chưa có live accepted spec, required TDD, independent review/QA, bounded repair, workflow verification và human delivery approval trong một run |
| P02-RA01 / P2 | Herdr Adapter large runner timeout overflow | Vẫn OPEN, owner Herdr Adapter; không đóng bằng sửa timeout helper Runtime |
| P03-RA01 / P2 | ArtifactStore late final get chunk sau deadline/abort | Vẫn OPEN, owner ArtifactStore; không chuyển sang Runtime hoặc đóng bằng kết quả test khác |

Runtime bảo vệ human-required gates bằng callback `authorizeHuman` của trusted
host; callback luôn trả true trong test không phải xác thực human thật. Tương tự,
khác executor ID không chứng minh khác principal/credential; host phải loại alias.
Red evidence được kiểm tra trước `authorize_implementation`, nhưng permission OS
để ngăn viết source trước Red không tự xuất hiện từ policy đó.

Legacy `run/status <run-id>/approve/resume/cancel` dùng workspace Runtime cũ,
không tự mở P19. Vì vậy Conversation-only hiện là boundary của gateway/tool
flow; không phải mọi user operation trong binary đều buộc đi qua Conversation.
Không dùng legacy resume để khẳng định phục hồi run ở storage P19 khác.

Đợt này sửa false-clean inspection, shutdown false-success, parallel approval,
repair Developer self-review, timeout contract, structured log redaction, context
selection và release packaging/source gates. Đợt follow-up đã lấp CLI bootstrap/shutdown và Claude tool wiring; các giới
hạn behavioral runners và full AI workflow evidence ở bảng trên vẫn còn. CLI README và guide đã được cập nhật cho provider selection, host bootstrap
và shutdown; không lấy help text làm bằng chứng dữ liệu được giữ.

Phạm vi đã thử là Linux với Git/SQLite/filesystem cục bộ; default host cần Unix
sockets và `flock`. Chưa xác minh default host trên macOS/Windows. Không chứng nhận
power-loss/kernel crash, NFS, multi-host/distributed leases, hostile same-user
continuous path swaps, sandbox isolation, hosted provider publication hay deploy.
Heuristic redaction không che mọi unlabeled/encoded/binary secret. SHA trong
selected-file metadata là checksum file đầy đủ thực đọc; content có thể bị cắt
theo budget và được đánh dấu truncated, nên checksum không mô tả riêng snippet.

Raw logs/artifacts dưới `/tmp` cần được bảo toàn riêng trước cleanup/reboot.
Không xem việc log/archive còn tồn tại là bằng chứng một task đã thành công.
