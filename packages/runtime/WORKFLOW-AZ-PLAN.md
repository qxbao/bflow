# Kế hoạch: luồng workflow chạy trơn tru từ A–Z

Baseline: `5c6716d` (nhánh `dele`). Phạm vi: `packages/runtime/**`, `agents/coordinator/**` (chỉ khi cần cập nhật hướng dẫn tool). Không đổi `packages/contracts/**`, root config, lockfile.

## Vấn đề

Run thường dừng giữa chừng và chỉ chạy tiếp khi người dùng nói "tiếp tục". Nguyên nhân chung: phần lớn sự cố có thể tự phục hồi lại được ghi là `pendingAction.recovery: "manual"`. Cơ chế tự resume duy nhất (`resumeRecoverableRuns`) chỉ chạy khi host khởi động lại và chỉ nhận `capability_repair`. Thêm vào đó, quyền native của các role đọc quá hẹp nên agent (nhất là Codex, vốn đọc repo bằng shell) tự bị chặn.

## Blocker đã xác định (theo mức ảnh hưởng)

| ID | Điểm gãy | Vị trí | Hiện tại | Sửa |
| --- | --- | --- | --- | --- |
| B1 | Coordinator kết thúc turn mà không ghi next action | `runtime.ts` `recordCoordinatorNoNextAction` (~1276) | `escalated`, `recovery: "manual"` | Tự resume Coordinator có giới hạn (xem B0) kèm lý do cụ thể |
| B2 | Agent gửi RoleMessage sai schema | `runtime.ts` `reportRoleToolFailure` (~387), `refuseInbound` (~845), `reportInboundFailure` (~364) | Cả run bị escalate manual vì một lỗi định dạng | Trả lỗi validation (đường dẫn field + thông điệp zod) cho chính agent gửi để gửi lại; chỉ escalate sau 3 lần sai cho cùng assignment |
| B3 | Role đọc không chạy được lệnh đọc | `host.ts` tool_guard (~853–856), `read-only-git.ts` | Non-Developer chỉ có Read/Glob/Grep + 5 lệnh `git`; Coordinator không có lệnh git; Codex (không có tool Read) bị từ chối mọi `Bash`/`exec_command` | Allowlist lệnh shell chỉ-đọc cho mọi role trừ Conversation (xem mục Quyền) |
| B4 | Coordinator gọi `request_specialist` tới role chưa có pane (`security`, `tester`, hoặc role không cấu hình) | `runtime.ts` `requestSpecialist` (~1308) | `no bound role pane` → escalate manual | Từ chối đồng bộ ngay trong tool call, trả danh sách role đang có pane; ánh xạ `security`→`reviewer`, `tester`→`qa` khi role gốc không có pane |
| B5 | Specialist dừng mà không gửi kết quả / run im lặng 180 s | `runtime.ts` `reportRunStalled` (~781), `run-watchdog.ts` | Escalate manual | Nhắc lại holder một lần (wake kèm yêu cầu gửi kết quả), rồi tự resume Coordinator; chỉ escalate người dùng khi hết budget |
| B6 | Coordinator báo `blocked` không thuộc capability | `runtime.ts` ~1033–1050 | Manual | Tự resume có giới hạn, trừ khi lý do cần quyết định của người (Coordinator dùng `request_user_decision` cho trường hợp đó) |
| B7 | Conflict khi tích hợp Git | `runtime.ts` ~2278 | Escalate manual "requires an assigned resolver" | Tự giao một Developer resolver (worktree giữ nguyên) rồi đi qua `accept_conflict_resolution`; tối đa 2 lần |
| B8 | Verification bị escalate vì lỗi giao/lưu (`VERIFICATION_RETRY_PREFIX`) | `runtime.ts` `escalateForRetry` (~2058) | Manual | Tự `retry_verification` với backoff, giới hạn 3 |

B0 (nền tảng chung cho B1, B2, B5, B6, B8): thêm `recovery: "auto_resume"` và một vòng lặp tự resume chạy theo watchdog (không chỉ lúc restart). Mỗi episode có budget `resumeAttempts < 3`, backoff 30 s / 60 s / 120 s, dùng lại `actionId` xác định để idempotent. Khi hết budget mới chuyển `manual` và báo Conversation một lần (giữ thông điệp "Automatic resume stopped after 3 attempts").

## Quyền được nới (người dùng đã cho phép)

- Mọi role trừ Conversation được chạy `Bash`/`exec_command` cho một lệnh chỉ-đọc, mỗi đoạn trong pipe `|` đều phải thuộc allowlist: `rg`, `grep`, `ls`, `cat`, `head`, `tail`, `wc`, `tree`, `stat`, `file`, `find` (cấm `-exec`, `-execdir`, `-delete`, `-fprint*`, `-ok*`), `sed -n` (cấm `-i`), `git` với `log/show/diff/status/branch/ls-files/ls-tree/grep/rev-parse/blame/cat-file -p/describe`. Vẫn cấm `;`, `&`, `$`, backtick, `(`, `)`, `<`, `>`, `\`, xuống dòng; vẫn giữ các option git bị cấm hiện có.
- Developer được thêm, trong worktree của task: lệnh build/test của project (`npm|pnpm|yarn` với `test`/`run test`/`run build`/`exec vitest`, `npx vitest|tsc|jest|mocha`, `node --test`, `tsc`, `go test`, `cargo test`, `pytest`, `python -m pytest`), ngoài các lệnh đọc ở trên. Không có `install`, network hay git ghi (commit vẫn qua MCP `commit`).
- Không đổi: Conversation không có tool native; không bypass approval, lease, fence, quality gate; `unknown_delivery` không bao giờ tự gửi lại; quyết định của người (approval, user decision, cancel) không tự trả lời.

## Bất biến phải giữ

- Mọi bất biến trong `AGENTS.md` (Herdr `done` không phải success, reconcile trước retry, event/checkpoint, human gate).
- Tự resume không được tạo AgentResult, phép đo hay approval giả; chỉ đánh thức Coordinator hoặc gọi lại đúng thao tác Runtime đã có.
- Bounded: mọi vòng tự động đều có budget và trạng thái cuối rõ ràng.

## Chia việc (Luna, worktree riêng từ baseline)

1. **W1 – B0 + B1 + B6 + B8**: cơ chế `auto_resume`, vòng lặp watchdog, chuyển các site manual tương ứng. Test: mỗi site tự resume, budget hết thì manual, restart giữ budget, không resume khi có approval/user decision/cancel.
2. **W2 – B2 + B5**: lỗi schema trả về sender, đếm lần sai theo assignment; nhắc holder trước khi escalate. Test: một lần sai rồi gửi đúng → run tiếp tục không cần người.
3. **W3 – B3 + quyền Developer**: allowlist mới trong `read-only-git.ts` (đổi tên phù hợp) và tool_guard; hỗ trợ tên tool của Codex. Test đối kháng cho từng metachar/option bị cấm.
4. **W4 – B4 + B7**: từ chối đồng bộ role không có pane + ánh xạ fallback; tự giao resolver conflict.

## Nghiệm thu (người lập plan chạy lại)

- Test kịch bản A–Z mới trong `integration.test.ts`: fake agent lần lượt (a) gửi message sai schema một lần, (b) Coordinator kết thúc turn không có action một lần, (c) specialist dừng không trả kết quả một lần, (d) Coordinator xin `security`, (e) role Codex đọc repo bằng `rg`/`cat`. Run vẫn đi tới `awaiting_approval` cuối cùng mà không có lệnh resume nào từ người.
- Test hết budget: cùng lỗi lặp 4 lần → `manual` và đúng một thông báo Conversation.
- `pnpm check:deps`, `pnpm typecheck`, toàn bộ `vitest` (so với baseline: không có fail mới), `git diff --check`.
- Review diff: không đổi contracts/root config; không nới quyền ngoài danh sách trên.
