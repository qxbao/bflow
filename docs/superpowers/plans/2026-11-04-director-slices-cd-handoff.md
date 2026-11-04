# Director C/D — bàn giao do quota

Plan: `docs/superpowers/plans/2026-11-04-director-slices-cd.md`. Spec gốc: `2026-11-03-director-agent.md`, ADR0009 và các ruling B2 (ưu tiên hơn đề xuất cũ thêm role director).

## Mốc bàn giao

B2 đã merge local main `80c123fc` trước C/D. C/D bắt đầu từ mốc này, worktree `.worktrees/director-slice-cd`, branch `agent/director/slice-cd`. Source checkpoint: **`ed63d99f`**. Đợt này bàn giao phần đã review; **C/D chưa hoàn tất**. Task tiếp theo: **Task 3**, rồi 4–7, 9–10. Không làm lại Task 1, 2, 8 hoặc B2.

Chủ dự án đã duyệt **D-CD-01** bằng tin “Duyệt” ngày 2026-11-04 (commit `466f009b`): đúng phạm vi additive contracts/migration trong plan. Sau đó chủ dự án báo Codex còn25%, Claude20%, yêu cầu khi quota nguy hiểm **merge main, push remote và soạn prompt cho máy khác**. Chọn mốc sau Task2; không mở task nặng mới. Chủ dự án tiếp tục nói **“Test có thể bỏ qua”**; đã dừng phần verification còn lại theo chỉ đạo. Không được suy ra quyền xóa test, làm yếu Runtime/quality gates hay tự duyệt real run.

## Ledger để dựng lại ở máy khác

Các artifact `.superpowers/sdd/**` bị Git ignore và không có sau pull. Dựng lại `progress.md` từ phần này; dòng đầu phải đúng như block sau:

```text
# SDD ledger — plan: docs/superpowers/plans/2026-11-04-director-slices-cd.md
Task 1: complete (466f009b..afdfb797, independent Spec PASS / Quality Approved; 0C/0I/7M)
Task 2: complete (86a69e61..ed63d99f, independent Spec PASS / Quality Approved; 0C/0I/7M)
Task 8: complete (a8fa2f91..1f4c6a04, Spec PASS / Quality PASS after fix round1; no open Critical/Important)
Task 3–7, 9–10: pending.
```

Task8 source `1fd89b68`, fix `1f4c6a04`: guide Director, private loader, start/status/queue templates + receipt/backup ownership. Sửa lỗi chỉ dẫn retry: chỉ `set_issue_status retrying`, không gọi `unpark_task` trước (Runtime tự unpark). Giữ guide v2.

Task1 `afdfb797`: TextEncoder UTF8 validator, browser-safe Director exports, WebDirectorView/transcript/issue/launch DTOs, issue command union, director_launch operation/index/result và6routes. Legacy WebAction kind list và WebEvent enum giữ nguyên. Runtime reject issue tạm để build; Task2 đã thay guard bằng admission thật.

Task2 `ed63d99f`: caller messageId idempotence, ack bền, Web chat/history bridge, redaction/presence/feed, signed issue command receipts + episode validation/observe-only reconciliation, actual nonactivated-host socket auth test. Reviewer so fake fixture với `runtime.inspect` thật và cả hai park issue-ID producers: khớp. Không sửa Conversation; issue đi port riêng, không rơi vào catch-all resume.

## Bằng chứng kiểm chứng — không gọi là full acceptance

- Baseline install frozen + `./node_modules/.bin/tsc -b` exit0.
- Task8:317 test local trước fix; sau fix111 test liên quan pass; build/deps pass. Built-checkout guide smoke9989byte. Không phải LLM behavioral proof.
- Task1: contracts278, Runtime interaction175, Director98, Conversation301, Local Server72 (sau build Web), Web442, CLI web47 pass =1413 theo các đợt này (không cộng thêm browser subset3). Build/typecheck/deps pass.
- Task2 **final code**: Director+interaction33files303pass; related host28files745pass; CLI14files150pass; tsc/deps pass. One real built-host socket test, fake Herdr, **not activated**, verifies Web/Director/owner credential switch; mutation removing actual host route fails then restored/rebuilt passes. Other mutation checks cover self-wake and duplicate unpark.
- Full Runtime suite **trước hai chỉnh sửa cuối** (mailbox bootstrap0 + v2 publisher start guard):268files pass/3files skip;3771pass/80skip; exit0;1260.63s. Không được gán con số này cho full final-code verification.
- Controller handoff verification: `pnpm check:deps`, `pnpm typecheck`, `./node_modules/.bin/tsc -p tests/e2e/tsconfig.json --noEmit` đều exit0. `pnpm test:affected --base main --run` đã bắt đầu, scope package vì GitNexus index commit_mismatch, chạy qua operational pnpm/Vitest dispatcher **chỉ trong SDD/PATH**, không sửa root config/scripts. CLI chia<=15files, workers1..3; ba batch45files669pass6skip. **Đã hủy có chủ đích theo lời chủ dự án bỏ test**, không có kết quả full affected/root/Web/E2E hoàn chỉnh. Không coi mã thoát do hủy là lỗi source; cũng không coi là full pass.
- `git diff --check` trước source commits đạt; sẽ kiểm lại trước bàn giao.
- Bậc bằng chứng chỉ source/local/fake runner; **chưa có live Herdr/provider/OS terminal acceptance cho C/D**. Task9 cần activated-host socket send/issue/feed và Local Server SSE; Task10 cần whole-branch review và kiểm chứng/probe đúng bậc.

## Interface đã có cho task sau

Contracts `/web`: `WebDirectorViewSchema`, `WebDirectorTranscriptPageSchema`, `WebIssueQueueViewSchema`, `WebIssueCommand`, launch option/options/request schemas. Issue command có `runId, issueId, expectedUpdatedAt`, không có expectedVersion; không nằm trong legacy WebAction kinds. Sáu route là `/api/v1/projects/:id/director{,/messages,/issues,/launch-options,/launch}`. Downgrade sau receipt kind mới không transparent; không xóa uncertain receipts để thử lại effect.

Runtime export `openLocalDirectorServices({repositoryPath, sessionId, interaction?:{credential}})` và `LocalDirectorServices` qua `@bflow/runtime`:

```ts
readDirector(projectId) // owner readonly query, redacted WebDirectorView
listDirectorMessages(projectId,cursor?) // Web credential
sendDirectorMessage(input:WebChatSend) // Web credential, idempotent messageId
listDirectorIssues(projectId,cursor?) // owner readonly query, all statuses
```

Methods private host: Web `interaction_director_send/history`; Director token chỉ `director_call`; owner `interaction_query` kinds director/director_issues. Issue mutations dùng **existing UserInteractionClient.execute** + signed WebPrincipal + durable receipt, không owner/Director mutation token. Không sửa UserInteractionClient cũ. Host là single writer; adapter chỉ IPC, không offline store write.

Transcript query: latest<=100 dùng `a<last-seq>` để poll mới; `b<first-seq>` để đọc cũ (private convention cần shared client/UI xử lý); issue pages `o<offset>`, all statuses, UI lọc. Read failure phải unknown/unavailable, không biến thành absent. Channel là nguồn ghi: Director trả lời Web vẫn author director/channel cli.

Legacy chat_adapter_unavailable blocker giữ cho v2 endpoint; `session.state` độc lập và vẫn ready nếu host ready. Task5 chỉ chọn chat Director khi view xác nhận Director layout, không để legacy-only blocker vô hiệu hóa chat mới hoặc hiển thị banner sai.

## Nhận xét nhỏ chưa xử lý — final review phải triage

**Task2 (7 Minor):** (1) reconcile ghi retrying ngoài issue serial/không guard, có thể đè dismiss đồng thời; (2) issue run check chỉ existence, cần bind session hoặc ghi rõ host scope; (3) latest transcript page không trả backward cursor, convention nêu trên; (4) future director_wait cursor hard-fail, guide/recovery cần xét; (5) Web retry audit source còn director giống CLI owner path; (6) polling2s/1s + đọc toàn transcript có chi phí; (7) report log mode0600 không đúng trên NTFS (stat777) và noise retry có sẵn. Xem `packages/runtime/src/director/{web,tools,store,endpoint}.ts`. Ưu tiên xét race/scope trước khi Task4/6 mở UI mutation.

**Task1 (7 Minor):** duplicated lifecycle-kind sets giữa web.ts/web-host.ts; Conversation catch-all mới đã được Task2 làm unreachable cho issue (reviewed); applied old-kind receipt coverage còn mỏng; allowedResultKinds typed string[]; test pin số route; tên query schema reuse cho issue; Vite chunk warning có sẵn. Không mở lại contracts để polish nếu không cần.

**Task8:** omitted-cursor full replay advice vs bounded context; loader fs-error còn absolute path; existing backup dir chưa chmod; backups giữ sau remove có thể hiện untracked; duplication guide/start; wording token; noise tests cũ; worker lượt đầu vi phạm no-Git chỉ đọc (không mutation; controller commit). Park_task suggestedAction nhắc unpark đã được Task2 sửa. Wording retry giả định taskKey cần xét issue không gắn task. Các mục này chưa phải live behavioral proof.

## Ruling đầy đủ và chi phí nếu sai

Ruling: Web issueretry/dismiss dùng signed WebCommand + durable receipt; Director port riêng optional trong LocalWebServices, không sửa UserInteractionClient cũ. SSE giữ chat/invalidate/reset. Cost if wrong: optional-backend support phải trả operation_not_allowed rõ, không silently pretend enabled.

Ruling: Keep presence enum active/waiting/absent and threshold120s authoritative, distinguish readerror unknown and host/infrastructure stopped; only host writes transcript. No offline LocalServer write because DirectorStore serial is perinstance. Cost if wrong: chat unavailable until infrastructure exists, but avoids concurrent seq/token corruption; Director absent with hostready remains queueable.

Ruling: Durable ack covers message/mailbox cursor and advances only from authenticated explicit wait input, never Web GET/response-before-delivery. Bootstrap legacy anchor once before first Web send/register; do not derive fresh ack from later director_say or messages can be lost. Cost if wrong: at-least-once replay may show old work again, so startedWork/idempotence and replay guidance must preserve no duplicate sideeffects.

Ruling: Task1 may make minimal build-ripple changes in runtime/interaction/commands.ts (reject new issue commands before legacy expectedVersion/action path) and web/components/OperationStatus.tsx (Vietnamese labels for new kinds), plus focused tests. These are nonprotected integration consumers of the approved additive schema; no feature implementation hidden here. Task2 replaces fail-closed issue guard with real admission. Cost if wrong: temporary issue operations unavailable until Task2, never unintended mutation. Keep legacy WebCommandKind/WebAction lists unchanged; new issue command union/kind separate to honor D-CD-01 old action-list compatibility.

Ruling: one-time ack bootstrap must not mark pre-registration mailbox items delivered without proof. Set initial mailboxSeq to0 (or an equivalent conservative anchor with proven delivery), not latest mailbox seq. Current store bootstrap initially copied latest items seq, which can skip mailbox arriving before first Web send/register. Explicit wait input remains the only ongoing ack authority. This supersedes backend-audit section9 proposal to skip legacy mailbox once; plan no-loss takes priority. Cost if wrong: replay at most retained5000 old mailbox items, bounded pages and idempotent Runtime processing; safer than silently dropping pending work. Add pre-first-register mailbox replay test.

Ruling: keep legacy chat_adapter_unavailable blocker for the legacy v2 chat API even in Director layout; Task5 selects the separate Director chat using a confirmed Director view and host-ready state, and must not show the legacy blocker as a Director-chat failure. views.ts533 computes state from host readiness independently of this appended blocker (host.ts648), so Director absent can queue as designed. Cost if wrong: UI could show misleading disabled/banner state; Task5/9 tests must pin it. This preserves old clients rather than falsely enabling the unavailable Conversation adapter.

## Ràng buộc cho agent tiếp tục

Luôn tiếng Việt có dấu. SDD: trích brief scripts/task-brief, fresh implementer từng task, controller Git, review-package và independent Spec/Quality, tối đa5vòng, vòng1–3 implementer cũ. Prompt chỉ paths brief/interface/rulings/report, không dán lịch sử. Runtime/host/security dùng Opus, CLI/test Sonnet; Sol đã được chấp nhận khi model/quota không có; không sửa auth/provider-global settings để chạy model.

Không director AgentRole/config role/pane. Director không sửa code (prompt, không hook), không tool approve/evidence; human approval chỉ Web hoặc người tự gõ CLI, không chat. Giữ v2 compatibility tới release/evidence gate. Không sửa contracts ngoài D-CD-01/root config/lock/docs ngoài plan/handoff nếu chưa có quyết định phù hợp.

HOME/BFLOW_HOME/XDG/TMPDIR test phải cô lập; không setup/e11 HOME thật. Build direct `./node_modules/.bin/tsc -b`, không pnpm exec tsc. Vitest workers1..3, CLI batch<=15. Build Web trước server integration. Timeout load-heavy integration-p19/lifecycle-fault-matrix/round2/round4/flow08 chạy lại riêng trước kết luận fail. Xóa file rỗng3 trước commit. Không force-push/worktree remove --force; không đụng worktree/user plan khác. Main đang có user-untracked `docs/superpowers/plans/2026-11-02-web-visualization-mode.md`, phải giữ nguyên.

Không dùng lại Orca Run/Task/Dispatch IDs của máy này trên máy khác. Hai terminal Task2 đã settled; release trả retained/user_takeover nên không force-close. Raw SDD logs/reports còn trên máy gốc, không có trong Git; các kết luận cần tiếp tục đã chép vào đây.

## Prompt tiếp tục trên máy khác

```text
Tiếp tục Director slices C/D của repo bflow. Luôn trả lời tiếng Việt có dấu.

Đọc trước:
- docs/superpowers/plans/2026-11-04-director-slices-cd-handoff.md
- docs/superpowers/plans/2026-11-04-director-slices-cd.md
Sau đó đọc spec/rulings được hai file dẫn tới khi cần, không làm lại phần hoàn tất.

Kiểm tra Git status/refs/worktrees/ancestry và patch equivalence, giữ nguyên thay đổi của người dùng. Pull main bằng fast-forward. Tạo worktree mới từ origin/main, ví dụ .worktrees/director-slice-cd-cont, nhánh agent/director/slice-cd-cont; không reset hoặc xóa worktree cũ bằng --force. Xác minh source checkpoint ed63d99f là ancestor của baseline.

Dựng lại ledger .superpowers/sdd/2026-11-04-director-slices-cd/progress.md từ handoff; dòng đầu đúng:
# SDD ledger — plan: docs/superpowers/plans/2026-11-04-director-slices-cd.md
Task1, Task2, Task8 complete; không chạy lại implementation/review đã xong. Bắt đầu Task3, rồi Task4–7,9–10. D-CD-01 đã được chủ dự án duyệt; không hỏi duyệt lại phạm vi đó.

pnpm install --frozen-lockfile, build ./node_modules/.bin/tsc -b. Dùng superpowers:subagent-driven-development: trích brief bằng task-brief, fresh implementer/task, independent Spec+Quality review qua review-package, tối đa5vòng, vòng1–3 cùng implementer. Subagent không chạy Git/không tự spawn; controller commit. Prompt dispatch ngắn, chỉ paths brief/interface/ruling/report.

Director không sửa code, không tự approve/evidence, không AgentRole/config role/pane. Human approval chỉ Web hoặc người tự gõ bflow approve. Giữ v2 compatibility. Không sửa contracts ngoài D-CD-01/root config/lock/docs ngoài plan/handoff nếu chưa có quyết định phù hợp. HOME/BFLOW_HOME test cô lập, không setup/e11 HOME thật, không sửa provider-global settings.

Đọc các Minor/ruling trong handoff trước khi nối UI; nhất là race reconcile/dismiss, session scope, paging, legacy chat blocker. Task9 cần activated-host ingress và Local Server SSE; Task10 còn whole-branch review/probe, chưa có live acceptance C/D.

Đợt bàn giao trước đã dừng test theo câu “Test có thể bỏ qua” của chủ dự án; không nói full test pass. Khi chạy: workers1..3, CLI batch<=15, build Web trước server integration, rerun riêng các timeout đã biết. Không làm yếu test/config/Runtime gates để chạy xanh. Nếu quota nguy hiểm, chốt mốc an toàn, cập nhật handoff, merge/push theo ủy quyền và gửi lại prompt; không force-push.
```

---

## Bàn giao đợt 2 (2026-11-04, máy macOS, quota thấp)

Nhánh `agent/director/slice-cd-cont` (worktree `.worktrees/director-slice-cd`) từ `origin/main` `0ccca472`, đã merge `origin/dele` (`34c388c1`, cùng nội dung tới `1202f805`) và push lên `origin/dele`. PR `dele → main` mở theo yêu cầu chủ dự án; **chưa merge main**.

**Trạng thái task:** Task 1–9 complete (independent Spec/Quality review từng task, fix loop ≤2 vòng). Task 10 **chưa xong**: final whole-branch review (Opus) đã chạy → 0 Critical / 2 Important / 6 Minor; một đợt fix duy nhất `0bdbbe34` + hoàn tất item1 `2a56fa7e`. Scoped re-review: item 2–7 ADDRESSED; item1 (transcript gap) được sửa tiếp bằng `fetchedThrough` (chỉ server page mới đẩy cursor), có test RED→GREEN, director-chat 29/29 pass, tsc -b exit0 — **commit `2a56fa7e` chưa có re-review độc lập** (implementer bị dừng do quota; controller chỉ đọc diff + chạy test). Việc đầu tiên ở máy mới: scoped re-review `0bdbbe34..2a56fa7e` cho item1.

Commit chính: T3 `66b200fe`; T4 `518bc93f`,`18a33e19`; T5 `40b7c41f`,`f385b9ec`; T6 `fb820e5c`,`1202f805`; T7 `21c61e34`; T9 `60713c72`,`80a60fff`,`b887b31c`; final fix `0bdbbe34`,`2a56fa7e`; merge `5e545ee0`.

**Bằng chứng (source/local/fake; không phải live):**
- Tại `b887b31c`: `tsc -b`, `pnpm check:deps`, `pnpm typecheck`, E2E tsc, `git diff --check 0ccca472..HEAD` đều exit0. Không đổi contracts/root config/lockfile/docs ngoài handoff này.
- `pnpm test:affected --base main` → scope **full** (76 file, GitNexus index commit_mismatch). Full suite **chưa chạy**. Đợt validation cô lập bị dừng giữa chừng: build0, Web build0, local-server 218 pass/5 skip, CLI batch1 85/85, CLI batch2 1 fail `director-web-host.test.ts` dưới tải song song → chạy lại riêng (workers1) **pass 1/1**. CLI còn lại, Web, E2E, Runtime full chưa chạy ở HEAD.
- Implementer báo: Web 532/532 (sau fix wave), E2E 88 pass/12 skip/0 fail (T9), Playwright visual 2/2 (SwiftShader, local UI evidence tại SDD workspace máy này — không có trong Git).
- **E16 refactor + E16-D (Director up/down)** chỉ chạy Linux → **chưa từng thực thi**; phải có Linux CI xanh trước merge main.
- Không có live Herdr/provider/terminal probe cho C/D; Task10 live campaign chưa bắt đầu.

**Phải làm trước merge main (theo final review):** re-review item1; Linux run E16/E16-D; full `pnpm test` + `pnpm test:e2e` + Runtime full + Web build/Playwright tại HEAD (workers1..3, CLI batch≤15, TMPDIR realpath, rerun riêng các timeout tải nặng); sau đó Task10 live/probe đúng bậc.

**Ledger SDD dựng lại** (`.superpowers/sdd/2026-11-04-director-slices-cd/progress.md`, dòng đầu giữ nguyên như phần trên), thêm:

```text
Task 3: complete (0ccca472..66b200fe, review clean)
Task 4: complete (66b200fe..18a33e19, review clean after fix round 1)
Task 5: complete (18a33e19..f385b9ec, review clean after fix round 1)
Task 6: complete (f385b9ec..1202f805, review clean after fix round 1)
Task 7: complete (1202f805..21c61e34, review clean)
Task 9: complete (21c61e34..b887b31c, review clean after fix round 2)
Task 10: final review done; fix wave 0bdbbe34 (items 2–7 ADDRESSED); item1 completion 2a56fa7e awaiting scoped re-review; full/Linux/live validation pending
```

**Rulings đợt 2 (chi phí nếu sai ghi kèm):**

- Ruling: Task2 Minor (1) reconcile-vs-dismiss race and (2) issue run session-scope are addressed in Task4 (host admission path for Web issue commands, scoped to canonical project/session) before Task6 UI enables mutation — they are load-bearing for UI mutation per handoff priority — cost if wrong: one extra Runtime-touching scope in Task4.
- Ruling: ⚠️(a) cross-restart launch dedupe is Task4's obligation (persist intent before launchDirectorPlan; launch_uncertain/restart-in-flight → reconciliation_required, never re-spawn) — cost if wrong: double Director window.
- Ruling: ⚠️(b) Task4 must pass realpath canonical project path to buildDirectorLaunchPlan — cost if wrong: all Web launches fail repository_invalid (visible, not unsafe).
- Ruling: ⚠️(c) manualCommand may include the canonical project path (`cd '<repo>'`) because the approved D-CD-01 field must be a usable command and the loopback owner already opened that project; no BFLOW_HOME/state/token/provider-home paths may appear — cost if wrong: project path visible in Web UI, a privacy-only exposure on loopback.
- Ruling: exclude director_launch from unresolved() unregister guard rather than inventing a settled 'failed' state — launch holds no project resource and keeping reconciliation_required preserves the no-respawn audit — cost if wrong: a stale uncertain receipt may outlive project unregister and confuse a later re-register replay.
- Ruling: host-stopped layout uses a client-only per-project last-confirmed-layout hint (localStorage) for labels/form/panel visibility, never authority; no server/contract change — cost if wrong: first-ever visit with host stopped shows legacy UX; stale hint after a project switches layout shows wrong labels until next live read.
- Ruling: Task5 ⚠️ resolved — Runtime messageId dedup is per host session store (host.ts:1805); Web must bind pending messageId to view sessionId and refuse same-id resend across session change (explicit user dismissal) — cost if wrong: user must manually discard a pending item after host session change.
- Ruling: queue board on Verification-room whiteboard (not control room) accepted — brief does not fix location and the plan forbids new geometry/assets — cost if wrong: one decor reposition later.
- Ruling: E16 gap closed by a Linux-gated variant written + typechecked, recorded "not executed locally (Linux-only)" — macOS host cannot run it and the plan forbids false acceptance — cost if wrong: the variant may fail on first Linux CI run.
- Ruling: final fix wave = I1 + launch confirm during wait window + stale launch panel + Director-layout HUD labels/zone title/Coordinator shortcut + bflow open stderr/unverified reason + stale helper header + AccessibleOffice ISO heartbeat + Director backup dir chmod 0700; T2(5) audit source and other minors stay deferred — cost if wrong: deferred audit attribution remains misleading for Web retries until next slice.
- Ruling: I2 cannot be resolved on this macOS host; merge evidence requires a Linux CI run of E16/E16-D, recorded as residual — cost if wrong: E16 regression detected only in CI.
- Ruling: finish item 1 with the same fixer as a completion of the single fix wave (not a new wave) — a hidden Director message is a correctness defect in the one Important finding — cost if wrong: one extra narrow dispatch outside the skill's single-wave rule.

**Minor còn hoãn (final review đã triage, không chặn merge):** T2(5) audit source Web retry ghi `director` (nên làm kế tiếp); T3 `CODEX_HOME`/`CLAUDE_CONFIG_DIR` pass-through khi `bflow web` chạy trong pane cô lập; T3 negative-cache `--version`, test spawn để lại `sleep 5`; T4 reader manifest session chưa test, bước pre-effect ngoài presence không bound riêng; T5 `sawAbsent` mất khi reload, thiếu `navigator.locks`; T6 `settledState` lặp 3 nơi, lọc theo trang `o<offset>`, detail quét ≤20 trang; T7 renderer loop 8fps khi có Director, click bàn trống mở chat, inspector sống quá layout, thiếu test reduced-motion/phone rail; T8 backup sau remove, guide/start trùng lặp; T9 HUD card che biển DIRECTOR, rail điện thoại chồng status strip, whiteboard close-up khó nhận; final: launch tab khác vẫn thấy `absent` (cần tín hiệu server), `sawAbsent` cho launch thay thế trong lúc chờ; macOS osascript TCC prompt có thể bị báo `terminal_opened`.

**Model policy chủ dự án (2026-11-04):** task khó dùng Opus, task dễ (re-review diff nhỏ, sửa cơ học) dùng Haiku.

### Prompt tiếp tục (đợt 3)

```text
Tiếp tục Director slices C/D của repo bflow. Luôn trả lời tiếng Việt có dấu.

Đọc trước docs/superpowers/plans/2026-11-04-director-slices-cd-handoff.md (đặc biệt "Bàn giao đợt 2") và docs/superpowers/plans/2026-11-04-director-slices-cd.md.

Kiểm tra Git status/refs/worktrees, giữ nguyên thay đổi người dùng. Fetch; tạo worktree mới từ origin/dele (chứa 2a56fa7e và merge 5e545ee0), nhánh agent/director/slice-cd-cont2. Không reset/xóa worktree bằng --force, không force-push.

Dựng lại ledger SDD từ handoff (Task1–9 complete; Task10 đang dở). Dùng superpowers:subagent-driven-development: subagent không chạy Git/không spawn; controller commit; task khó Opus, dễ Haiku.

Bước tiếp: (1) scoped re-review độc lập 0bdbbe34..2a56fa7e cho item1 transcript gap; (2) pnpm install --frozen-lockfile, ./node_modules/.bin/tsc -b, rồi full validation tại HEAD: pnpm check:deps, pnpm typecheck, E2E tsc, Runtime/CLI(batch≤15)/local-server/Web/E2E, workers1..3, HOME/BFLOW_HOME/TMPDIR cô lập (TMPDIR realpath trên macOS), rerun riêng timeout tải nặng; (3) Linux: chạy E16 và E16-D thật; (4) Task10 live/probe đúng bậc trong session Herdr cô lập, không sửa provider-global settings, không tự duyệt real run, ghi blocked/unverified khi thiếu auth/desktop.

Không sửa contracts/root config/lockfile/docs ngoài plan/handoff. Không tuyên bố full test pass hay live acceptance khi chưa có bằng chứng. Không merge main khi chủ dự án chưa yêu cầu. Nếu quota nguy hiểm: chốt mốc an toàn, cập nhật handoff, push lên dele (không force), soạn prompt mới.
```
