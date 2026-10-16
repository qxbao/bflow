# Security review sau P22

**Kết luận: chưa đủ bảo đảm để nghiệm thu Agentic SDLC MVP v2.** Có các policy
fail-closed và durable boundaries đã kiểm thử, nhưng host composition, separation
of duties, OS isolation và live workflow evidence còn thiếu. Review này không
là pentest toàn diện hoặc chứng nhận production. Baseline, tested revision và
các lệnh nằm ở [release-readiness](release-readiness.md).

## Trust model và ingress

Runtime, host authentication callbacks, configured issuer keys, filesystem và
operator cùng UID hiện là trusted computing base. Model-supplied `verified`,
`independentExecution`, executor ID hoặc transport `done` không tự tạo trust.
Herdr protocol/schema compatibility khác với authenticated task-result evidence.
Native receipt ingress kiểm Ed25519 trên canonical RoleMessage, plugin đối chiếu
pane/agent/role/workspace trong manifest và native session của execution receipt;
Core giữ nguyên raw handle, kiểm signed binding rồi mới ghi binding_verified.

`packages/runtime/src/agentic/runtime.ts` parse RoleMessage/Specification/workflow/
decision/result ở ingress; `outbox.ts` ghi request trước send và kiểm lease/fencing.
`herdr-ingress.ts` có private socket, signature check và per-invocation auth context.
`tools.ts` nhận principal do host inject, không cho model chọn vai trò trong args.
`packages/specification/src/engine.ts` bind approved identity/bytes/request digest;
Verification Engine kiểm current spec fingerprint, exact revision/attempt/method/
criterion và objective artifacts. Đây là các boundary đã đọc và test, không có
khẳng định rằng mọi file/callback tùy chỉnh của external host đã được audit.

## Lỗi đã sửa trong đợt này

| ID / mức | Lỗi xác nhận và tác động | Sửa, bằng chứng và giới hạn |
| --- | --- | --- |
| RR-03 / P1 | Hai verification song song ghi đè slot approval; approval đầu mồ côi. Late result có thể đổi business phase sau rejection | Commits `5d3130a`/`58a70a0`: persist/defer outcome sau active task approval; giữ terminal decision kể cả verifier đồng thời ném exception. Regression restart, duyệt từng task, human rejection; Core schema không đổi |
| RR-04 / P1 | Frozen P17 plan thiếu Developer ID mới ở repair; evidence từ chính repair implementer có thể được nhận làm Reviewer | `5d3130a`: Runtime kiểm executor của gate outcome với mọi task.assignment handle thực trước acceptance. Regression FAIL trước/PASS sau. Host vẫn phải xác thực principal và aliases |
| RR-05 / P1 | P13 inspector coi sạch khi edit bị assume-unchanged/skip-worktree, ignored files hoặc GIT_* trỏ repo khác | `05a54aa`: bỏ inherited overrides, tắt fsmonitor, kiểm index flags, NUL-safe status gồm ignored/untracked. Test Git thật giữ nguyên bytes/flags, không auto-clear hoặc delete |
| RR-06 / P1 | shutdownTopology bỏ qua pane-close failure/timeout rồi lưu down/cancelled | `05a54aa`: bắt command failure và parse response trước persist final shutdown; tests failure/timeout không lưu success. Partial close cần reconciliation, không rollback giả |
| RR-07 / P2 | Timeout helper cast retrySafety=after_reconciliation ngoài exported enum, trả retryable error cho operation có thể vẫn chạy | `5b57f88`: trả contract-valid unknown_delivery/nonretryable/manualInterventionRequired; deprecated onTimeoutCode giữ source signature nhưng không hạ uncertainty. Schema và nested retry test xác nhận đúng một invocation |
| RR-08 / P2 | StructuredLogger chỉ redact message/details; envelope event/component/IDs raw. Spaced CLI flags và JSON escapes có khoảng trống | `5b57f88`: scrub trước buffer/sink và sửa textual matcher; tests dùng synthetic secrets. Không biến raw Herdr stdout/stderr hay prompt argv thành sanitized logging |
| RR-09 / P2 | Cached file selection đọc symlink replacement ngoài root/special file; hash cũ không mô tả bytes mới | `5b57f88`: canonical containment cả parent links, no-follow/nonblocking descriptor, regular-file/dev/inode checks, hash/size từ bytes đọc. Regression file/parent symlink, FIFO trong bounded child, normal edit. Các documentation readers khác còn RR-17 |
| RR-10 / P1 release | Compiled archive thiếu package v2; CLI --help lỗi thiếu pane-manager dù install exit 0 | `6bb17e7`: thêm manifests/dist của mọi package v2 và prompts/templates/docs; real archive extract/install/CLI smoke đổi từ exit 1 sang 0 |
| RR-11 / P1 release integrity | Manual tag input không chọn source checkout; release job chỉ lint/build trước publish | `6bb17e7`: checkout requested ref, validate tag/HEAD identity, unit/integration/E2E gates và compiled distribution smoke. YAML/bash đã check, chưa chứng minh GitHub environment approval |

Source implementation được commit theo ownership; không thay contracts, root
manifest/lockfile, schema migration hoặc upcaster. Test/build artifacts không
được đưa vào Git. CI workflow thay đổi là integration/release remediation được
chủ dự án cho phép; không kích hoạt workflow, tag hay external write trong audit.

## Các kiểm tra đặc biệt bắt buộc

| Kiểm tra | Kết quả trung thực |
| --- | --- |
| Conversation không vượt quyền Coordinator | Gateway chỉ tạo delegation, tools reject Conversation orchestration. PARTIAL: default live host chưa đăng ký; native process có shell/quyền filesystem cùng UID |
| Coordinator không tự approve | Human-required decisions phải được host authenticate và match revision/target. Chủ dự án đã cho phép low-risk design autoaccept trong phản hồi sau audit 2026-10-16; không được dùng ngoại lệ này cho human-required gates hoặc delivery |
| Developer không đổi spec để hợp thức hóa | LOCAL PASS immutable stored approved bytes, criteria anti-weakening, fingerprint recheck và Git commit scope. PARTIAL ở OS: cùng UID không bị ngăn sửa mọi path ngoài API |
| Reviewer không chỉ tin Developer giải thích | LOCAL PASS exact gate observations, trusted artifact bytes, current revision và executor checks; repair identity gap đã sửa. Chưa có independent Reviewer/QA AI live; host identity/runner phải được bảo đảm |
| Verification không chạy vô hạn | LOCAL PASS maxIterations/default 3, refuse extra cycle và exhaustion escalation. Infrastructure uncertainty không được repair loop vô hạn |
| Retry không tạo việc trùng | LOCAL PASS write-ahead request/lease, durable unknown_delivery, chỉ resend request gốc sau proven not_delivered; SIGKILL/restart fixture coverage. Native smoke vẫn uncertain; chưa khẳng định exactly-once cho arbitrary remote side effects |
| down không mất dữ liệu | CLI LIVE PASS safety refusal giữ sentinels/HEAD; P13 close-error regression. BLOCKED cho graceful default shutdown của active workflow |
| attach đúng session | LOCAL PASS canonical repository identity, named env, live probe, manifest và Conversation target checks; PTY live evidence kế thừa từ QA trước, chưa chạy lại PTY trong audit này |
| Git không phá hủy mặc định | LOCAL PASS real repositories: scope từng commit, giữ conflict/dirty/ignored data, không reset/clean/force cleanup mặc định, chỉ push integration ref đã verify. Không chứng nhận chống external same-user process |
| Không deploy/merge protected branch thiếu approval | Không có tool deploy/protected-merge trong Coordinator Runtime; integration tạo branch riêng, delivery cần human. Chưa kiểm hosted branch settings/provider credentials; CD tag publish không có environment approval gate được khai báo trong YAML, nên chưa chứng nhận governance bên ngoài |

## Rủi ro còn mở và phát hành

Các RR-01/02/12/13 ngăn full acceptance. RR-14–21, P02-RA01 và P03-RA01 còn mở
với owner/điều kiện đóng trong [known-limitations](known-limitations.md).
Đặc biệt, OS read-only isolation không được tạo bởi `readOnlyWorkspace: true`,
và Conversation-only là gateway behavior chứ chưa là độc quyền của mọi CLI/API.

Release packaging mới không thay cho phê duyệt phát hành. GitHub environment
reviewers, token scope, protected branches/tags và repository rules phải được
owner kiểm tra trước external closure. Không tự deploy hoặc merge protected
branch để chứng minh test. Thử nghiệm tiếp theo cần repo/session riêng, least
privilege credentials, immutable evidence và người phê duyệt độc lập.
