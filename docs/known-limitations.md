# Known limitations sau P22

Phân loại hiện tại là **Not ready cho Agentic SDLC MVP v2**. Các giới hạn dưới
đây còn mở sau các bản sửa của đợt audit; xem
[release-readiness](release-readiness.md) để biết baseline và bằng chứng.

| ID / ưu tiên | Giới hạn | Ảnh hưởng, owner và điều kiện đóng |
| --- | --- | --- |
| RR-01 / P1 (QA-02) | Default CLI `up` chỉ khởi động topology; không boot P19, đăng ký Conversation/Coordinator tools hay scheduler/authenticated host | Không thể hoàn thành user → delivery qua CLI. Runtime/CLI/provider host phải compose thực và chạy feature/bugfix AI E2E |
| RR-02 / P1 (QA-01) | Default `down` thiếu Runtime quiesce/checkpoint provider; adapter down chưa compose shutdownTopology | Exit 1 giữ session, kể cả --yes. Runtime/CLI phải drain intake/dispatch/writes, persist authoritative checkpoints rồi shutdown có receipt; không thêm no-op barrier |
| RR-12 / P1 | Policy low-risk cho Coordinator tự accept spec | Không đạt tiêu chí tuyệt đối không tự phê duyệt. Cần project-owner/integration quyết định separation of duties, policy mặc định và migration nếu cần; projectApprovalRequired là hook, chưa được CLI wire |
| RR-13 / P1 cho yêu cầu security isolation | Dedicated panes, worktrees và `readOnlyWorkspace` không áp quyền filesystem/process riêng | Conversation/Coordinator vẫn cùng UID/cwd và native shell tools. Trusted host phải giới hạn tool/sandbox/credentials; không chứng nhận chống agent cố ý vượt quyền |
| RR-14 / P2 (QA-03) | Herdr idle/doctor healthy không chứng minh provider đã login hoặc có native agent-session | Probe mới thấy login screen với up exit 0. CLI/P13/Herdr owner cần diagnostic auth dựa bằng chứng; không suy luận từ version label |
| RR-15 / P2 (QA-04) | Startup blocked/manager_pending có thể không có manifest để retry an toàn | Guard chống duplicate là cần thiết; thiếu reconciliation/operator recovery hoàn chỉnh. Không xóa intent hoặc tự start agent thứ hai |
| RR-16 / P2 | Logger/context/observability/recovery helper có API nhưng chưa compose toàn tuyến vào CLI/P19; stdout/stderr background Herdr ghi raw; prompt qua argv | Helper tests không chứng minh operational logs sạch. Runtime/CLI/provider owner phải wire sinks và xác thực metrics; không ghi secrets vào requirements |
| RR-17 / P2 | Cached documentation/role-instruction reads trong ProjectContextService còn dùng readFile riêng, ngoài selection đã harden | Probe synthetic mới xác nhận thay README bằng escaping symlink sau analysis đưa bytes ngoài repo vào context (`context-documentation-results.json`). Cần dùng cùng confined-reader cho mọi ingress rồi chạy regression tương ứng; context service hiện optional, chưa tự wire vào CLI |
| RR-18 / P2 | maxTotalBytes/maxFiles chỉ bao repository-file selection; role instructions/spec/ADR thêm sau đó | Không có global prompt byte budget hoặc đảm bảo memory bound cho mọi file read. Context owner cần budget tổng và kích thước read độc lập |
| RR-19 / P2 | Registry/lifecycle/journal lock sau crash có thể cần operator reconcile | Không hứa seamless recovery mọi crash. Kiểm tra đúng process/session trước gỡ stale lock; không reset DB hoặc xóa receipt |
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
selection và release packaging/source gates. Các bản sửa này không lấp các
composition gap ở bảng trên. Package CLI README cũ vẫn có mô tả lệch về
init force/yes và shutdown API (QA-05); behavior source/root guide và báo cáo
này là căn cứ quan sát, không lấy help text làm bằng chứng dữ liệu được giữ.

Phạm vi đã thử là Linux với Git/SQLite/filesystem cục bộ. Không chứng nhận
power-loss/kernel crash, NFS, multi-host/distributed leases, hostile same-user
continuous path swaps, sandbox isolation, hosted provider publication hay deploy.
Heuristic redaction không che mọi unlabeled/encoded/binary secret. SHA trong
selected-file metadata là checksum file đầy đủ thực đọc; content có thể bị cắt
theo budget và được đánh dấu truncated, nên checksum không mô tả riêng snippet.

Raw logs/artifacts dưới `/tmp` cần được bảo toàn riêng trước cleanup/reboot.
Không xem việc log/archive còn tồn tại là bằng chứng một task đã thành công.
