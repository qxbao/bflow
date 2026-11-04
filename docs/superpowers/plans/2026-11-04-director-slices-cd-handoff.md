# Director C/D — bàn giao tiến độ

Plan: `docs/superpowers/plans/2026-11-04-director-slices-cd.md`.
Baseline: local main `80c123fc` (B2 đã merge cục bộ theo yêu cầu owner; chưa push). Worktree `.worktrees/director-slice-cd`, branch `agent/director/slice-cd`.

## Trạng thái

C/D chưa hoàn tất, chưa merge/push. **Task 8: complete** (commits `a8fa2f91..1f4c6a04`; source `1fd89b68`, fix `1f4c6a04`). Independent Opus review Spec PASS/Quality needs fix → original implementer sửa double-unpark guidance → independent scoped Sonnet review Spec PASS/Quality PASS, không Critical/Important mở. Task 1–7 chờ owner duyệt D-CD-01 trong plan. Task 9–10 chưa bắt đầu.

Đã chạy baseline install frozen và tsc -b thành công. Task 8 có source/local tests: Vitest 197 + 70 + 50 = 317 pass, 22 file, không skip/fail. Worker chạy lại với exit code trực tiếp; controller xác nhận build tsc -b exit0 và git diff --check exit0. Log đầy đủ `.superpowers/sdd/2026-11-04-director-slices-cd/task-8-logs/`. Sau fix: tsc -b exit0, check:deps exit0, 6 file/111 test liên quan pass (log `task-8-fix-1-*.log`). Controller smoke import bản build `@bflow/runtime.readDirectorGuide` exit0, guide 9989 byte, logical source/framing đúng; chỉ checkout build, không distribution evidence. Chưa chạy bộ test cuối C/D, chưa có live Herdr/provider evidence cho C/D.

## Quyết định và phần chờ

D-CD-01 bổ sung DTO/routes/operation kinds Web, sửa UTF-8 validator browser bằng TextEncoder, giữ schema/role/interface cũ. Phạm vi, consumer và downgrade receipt compatibility ghi trong plan. Chưa có explicit owner approval; chưa sửa contracts hoặc triển khai phần phụ thuộc. AGENTS yêu cầu public contract change có integration decision và approving owner.

Ruling: issue retry/dismiss qua signed WebCommand và durable receipt; optional Director port riêng, không đổi UserInteractionClient cũ. Nếu sai, backend chưa hỗ trợ phải trả operation_not_allowed rõ.

Ruling: chỉ host ghi transcript; host ready + Director absent vẫn nhận queued chat, infrastructure stopped thì giữ draft và yêu cầu khởi động. Presence giữ enum/120s, read error là unknown. Nếu sai, chat không khả dụng khi host dừng, nhưng không ghi song song làm hỏng seq/token.

Ruling: durable message/mailbox ack chỉ tiến từ authenticated explicit wait input, không Web GET hoặc trước delivery; bootstrap legacy anchor một lần trước first Web send/register. Nếu sai, at-least-once replay có thể lặp hiển thị, nên giữ startedWork idempotence và không lặp side effect.

## Quy trình

Ledger `.superpowers/sdd/2026-11-04-director-slices-cd/progress.md`; dòng đầu phải theo plan trên. Artifact brief/report/review/audit giữ tại thư mục này. Không làm lại B2. Source writer Task 8 Sonnet high `ctx_c64ac33b69ea`, fix cùng terminal `ctx_7d10fd8ae402`; reviewer Opus high `ctx_6617f3a03866`, scoped re-review Sonnet high `ctx_9fa3c139b1c9`; tất cả đã release; Orca run `run_ebb84495ebdb`. Subagent không được chạy Git. Task8 worker đã chạy read-only git status/diff, ghi nhận vi phạm; controller tự commit, không có Git mutation từ worker.

Không sửa contracts/root config/lock/shared docs nếu chưa được duyệt. Không setup/e11 HOME thật, không sửa provider global. Build bằng ./node_modules/.bin/tsc -b. Vitest workers1..3, CLI theo đợt; build Web trước server integration; xóa file rỗng 3 trước commit. Không force-push, không xóa worktree --force. Giữ file plan Web visualization chưa commit của owner ở main.

## Nhận xét nhỏ còn lại để final review xét

- Guide khuyên omit cursor có thể replay toàn lịch sử; khi register lại cần nối durable ack Task2, dùng start cursor.
- Loader lỗi fs còn chứa absolute path trong thông báo cho model; success source chỉ tên logic.
- Thư mục backup có sẵn chưa chmod; backup giữ lại sau remove có thể hiện untracked.
- Duplication hướng dẫn giữa guide/start; wording token; output noisy từ test cũ.
- Worker vi phạm no-Git chỉ đọc ở lượt đầu (đã ghi, không lặp ở fix).
- SuggestedAction cũ của park_task vẫn nhắc unpark_task; guide/skill mới quy định retry issue chỉ set_issue_status.
- Wording helper giả định issue có taskKey; issue không có taskKey chỉ đổi trạng thái.

Host-level guide integration và distribution packaging smoke dành Task9; đã xác minh source wiring và endpoint/loader unit, không tuyên bố full host/live. Package README follow-up ngoài scope Task8.
