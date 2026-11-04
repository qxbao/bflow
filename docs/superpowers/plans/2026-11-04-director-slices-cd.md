# Director slices C/D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Mỗi task một implementer mới, review Spec/Quality, tối đa5 vòng; vòng1–3 quay lại implementer. **Subagent không chạy Git; controller commit.**

**Goal:** Web Classic và office3D dùng Director bên ngoài Herdr, chat chung CLI/Web, mở CLI qua thao tác Web, xử lý issue queue, hoàn thiện hướng dẫn Director và kiểm chứng đúng bậc.

**Architecture:** Runtime giữ quyền execution/gate/lease. Web gọi cầu Web-auth có phạm vi, không mượn Director token/owner mutation. SSE chỉ báo invalidation; transcript có cursor bền riêng. Director là principal/UI entity, không thêm AgentRole/config role. Giữ adapter v2 còn cần cho dữ liệu/thư viện cũ.

**Tech Stack:** Node>=22.13, TypeScript strict/ESM, pnpm12.5.1, Zod3, React19/react-router/three hiện có. Không dependency mới.

**Spec:** `docs/superpowers/plans/2026-11-03-director-agent.md` D-DIR-01..06/Phase5..8, ADR0009, và các ruling B2 trong `2026-11-03-director-slice-b2.md` (ưu tiên hơn đề xuất cũ của master plan về role director).

**Baseline:** local main `80c123fc`; worktree `.worktrees/director-slice-cd`, branch `agent/director/slice-cd`. C là Classic/local-server; D là3D/prompt/tương thích/evidence. Owner đã yêu cầu thực thi; không mở lại vòng brainstorming sản phẩm.

## Global Constraints

- Director không sửa code; ép bằng prompt/skill, không hook cấm sửa. Không thêm tool approve/evidence cho Director.
- Phê duyệt chỉ Web authenticated decision hoặc CLI người tự gõ; chat "duyệt" không phải approval. Không auto-duyệt real run trong campaign.
- Không role director trong `.bflow/config.yml`; chọn provider chỉ lúc Web mở phiên, tùy chọn UI không thành repo role.
- Data package boundary dùng exported schemas `@bflow/contracts`. Public contracts/root/lock/shared docs không được feature worker sửa; Task1 chỉ mở sau D-CD-01 được owner duyệt.
- Không thay module đã có bằng scaffold/no-op. Không resend unknown_delivery/uncertain launch; reconcile chỉ quan sát.
- File state0600, thư mục0700, không token/secret/đường dẫn metadata máy ở Web. Render text, không HTML từ LLM.
- Giữ token/style hiện có, focus/keyboard/aria labels, không color-only, không fake token streaming; update nền không CLS.
- `./node_modules/.bin/tsc -b` trước subprocess tests, không pnpm exec tsc. Vitest `--minWorkers=1 --maxWorkers=3`; CLI theo đợt<=15 tệp. Build Web trước web-server-integration.
- HOME/BFLOW_HOME/XDG/TMPDIR cô lập, ngắn dưới/tmp; lọc ambient AI_ISOLATOR/ORCA/provider-home hints trong tests. Không sửa provider-global config hay chạy setup/e11 HOME thật.
- Không xóa compatibility v2 trước release chuyển tiếp và đủ evidence; không xóa enum conversation/coordinator. Chưa có quyền push/merge nhánh C/D.
- Mức source/local/fake, OS/provider probe và full live SDLC phải báo riêng; thiếu auth/desktop/human gate là blocked/unverified, không giả pass.

## Review Focus

1. Token Web/Director/owner không gọi chéo; CSRF/Origin/cookie hết hạn phải chặn trong hàng đợi trước effect (Task2/4).
2. Tin Web queued lúc Director absent phải còn sau register/restart; timeout send không tạo seq trùng; Web GET không ack inbox (Task2).
3. Launch terminal là effect không chắc; operation replay/restart không mở cửa sổ lần2; không coi process exit0 là Director-ready (Task3/4).
4. Retry issue stale/lặp không mở nhầm episode hay reset issue retrying→open; gate task khác giữ nguyên (Task2/4/6).
5. Scene3D không API ghi, Director không giả pane/agent; unknown read khác confirmed absent; keyboard/reduced-motion parity (Task7).

## D-CD-01 — Quyết định integration public contracts (ĐÃ DUYỆT)

**Động cơ/evidence:** router Local Server chỉ dùng WebHttpContracts; Web chỉ import browser-safe subpath. Hiện không có route/operation Director. DirectorMessageSchema dùng Buffer.byteLength, đã tái hiện valid parse không Buffer ném ReferenceError. Không thể đóng giả sender conversation hay clone schema/cast trong Web.

**Agent/consumer ảnh hưởng:** contracts/integration, Runtime host/client, CLI local services/launcher, Local Server, Web. **Không đổi** AgentRole, RoleMessage, SessionManifest, WebRunView, WebChatMessage, WebEvent hay field/method cũ của UserInteractionClient.

**Thay đổi được đề nghị, chỉ cộng thêm:**

1. `packages/contracts/src/director.ts`: UTF-8 count bằng `new TextEncoder().encode(text).byteLength`, giữ limit16384 và text/schemaVersion1/shape cũ.
2. `packages/contracts/src/web.ts`: re-export browser-safe DirectorMessage/Presence/ProgressSnapshot/ParkedIssue và types/limits từ director.js; không import root contracts trong Web.
3. `WebDirectorViewSchema`: `{apiVersion:1,projectId,layout:'director'|'legacy_v2'|'not_started',sessionId?,snapshot:DirectorProgressSnapshot,waitingSince?,transcriptSeq:int>=0,cliCaptureMayBeIncomplete:boolean,observedAt}` strict. Không DirectorSession/tokenId/directorId/repositoryRoot.
4. `WebIssueQueueViewSchema` là alias `WebPageSchema(ParkedIssueSchema)`; transcript page là `WebPageSchema(DirectorMessageSchema)` (max100). Không đổi message shape; channel là nguồn ghi, director_say luôncli vì Director chạyCLI.
5. `WebDirectorLaunchOptionSchema`: `{provider:AgentProviderId,state:'available'|'unavailable'|'unverified',reason?,manualCommand:string<=4096}`; không label installed làready.
6. `WebDirectorLaunchOptionsSchema`: `{apiVersion:1,projectId,terminal:{available:boolean,reason?},providers:array<=3,observedAt}` strict.
7. `WebDirectorLaunchRequestSchema`: `{apiVersion:1,operationId:uuid,provider:AgentProviderId,replaceActive:boolean=false}` strict. Server tự tạoargv/cwd, không nhận command/env/path từ browser.
8. Thêm WebCommand literal `issue_retry`/`issue_dismiss`: `{apiVersion:1,commandId:uuid,projectId,kind,runId,issueId,expectedUpdatedAt:ISO}` strict; ký principal/receipt như command hiện có. Result union thêm `{kind:'issue',issueId,status:ParkedIssueStatus}`.
9. Operation kind thêm `director_launch` (owner local_lifecycle); result thêm `{kind:'director_launch',provider,mode:'terminal_opened'|'manual_command',manualCommand:string<=4096,launchedAt:ISO}`. Refine ownership/result theo từngkind, giữ rule cũ. `web-host.ts` index/receipt validators tương ứng.
10. WebHttpContracts thêm6routes: GET `/projects/:id/director`→view; GET `/director/messages?cursor`→messagepage; POST `/director/messages` bodyWebChatSend→DirectorMessage(202); GET `/director/issues?cursor`→issuepage; GET `/director/launch-options`→options; POST `/director/launch` bodyLaunchRequest→WebOperation(202). Prefix `/api/v1`. Issue actions dùng command route sẵn. SSE giữ typechat/invalidate/reset, không thêm enum.

**Tương thích/migration:** existing shapes/versions và routes giữ nguyên; new parser đọc receipt cũ. Client cũ không bị đưa kind mới qua old snapshot/action lists. Older binaries không đọc được receipt có kind mới: downgrade sau khi dùng C yêu cầu operator xử lý/backup owned operation state, tuyệt đối không bỏ receipt uncertain để thử lại effect. Không claim downgrade transparent; không silent cast/upcast proof. Fixtures cũ phải round-trip.

**Phạm vi protected file:** director.ts, web.ts, web-host.ts và tests contracts/browser import. Không root configuration/package exports/lockfile/README/AGENTS/ADR edits; quyết định lưu chính plan này và handoff. **Approving owner:** chủ dự án đã trả lời “Duyệt” trong phiên làm việc ngày 2026-11-04, ngay sau yêu cầu duyệt D-CD-01. Phê duyệt áp dụng đúng phạm vi public contracts và tương thích ở trên; không bao gồm root config/lockfile hay push/merge C/D.

---

### Task 1: Contract integration + browser portability

**Files:** modify `packages/contracts/src/{director,web,web-host}.ts`; create `packages/contracts/test/director-web.test.ts`; modify `apps/web/test/browser-contract.test.tsx`.
**Interfaces:** produces D-CD-01 schemas/routes/kinds, unchanged existing contracts. Minimal nonprotected build ripple authorized: fail-closed issue guard in runtime interaction/commands.ts + focused test; add Vietnamese operation labels in Web OperationStatus.tsx. Task2 owns replacing the temporary guard with actual issue admission. Keep legacy WebAction kind lists unchanged; new issue kinds are a separate command union.
- [x] Chỉ bắt đầu sau owner approvalD-CD-01; controller/integration sở hữu task, implementer được giao scope cụ thể.
- [x] Test Buffer absent, tiếng Việt/emoji/lone surrogate tại16384byte boundary; invalid shape/version/provider; strict extra fields rejected; old receipt round-trip; ownership resultkind cross-call rejected.
- [x] Add approved shapes only; browser import qua/web không Node globals.
- [x] Build contracts/runtime/CLI/local-server/Web; tests contracts/browser. Controller commit sau report + review.

**Status:** complete source/local `afdfb797`, independent Spec/Quality review approved; deferred minors in ledger/handoff.

### Task 2: Runtime Director Web bridge, durable transcript và issue admission

**Files:** modify `packages/runtime/src/director/{store,tools,endpoint,host-methods}.ts`, `packages/runtime/src/agentic/{host,host-controller,host-director-mode}.ts`; create `packages/runtime/src/director/web.ts`; tests `packages/runtime/test/director/{web-bridge,transcript-recovery}.test.ts`.
**Interfaces:** consumes Task1; produces trusted host methods `interaction_director_send/history`, query director/issue views, issue command admission. Private LocalDirectorServices adapter dùng exported DTOs; không UserInteractionClient change.
- [ ] Web credential chỉ send userWeb/history; Director token chỉ director_call; owner queries riêng. Chattext không gọi decision API.
- [ ] Store append nhận optional caller messageId: cùngid+cùngpayload→same seq; khácpayload→conflict. Web sender bắt buộc authoruser/channelweb; say giữauthorDirector/channelcli.
- [ ] Durable delivered/ack cursor: next wait input cursor xác nhận trang đã nhận; startCursor từ durable ack để Web messages lúc absent không bị latest-seq bỏ qua. Ack.json được bootstrap dưới serial trước tin Web đầu tiên/register từ last-Director-seq của transcript cũ; fallback này chỉ dùng một lần, không được trượt theo director_say sau khi đã có Web pending. Ack gồm messageSeq/mailboxSeq, đơn điệu và không vượt dữ liệu đã tồn tại. Web transcript GET không làm heartbeat/ack/consume. Keep startedWork idempotence khi replay.
- [ ] Host là single writer; không LocalServer tự ghi DirectorStore offline (serial chỉ nội bộ). Hạ tầng stopped khácDirector absent: unavailable rõ; host còn sống/Director absent vẫn queue.
- [ ] Redact Web text/issue fields/token-shape, UTF8 cap; không lộ rawsession/token/path metadata. `cliCaptureMayBeIncomplete` conservative khi hook binding mất/chưaverified.
- [ ] Feed refresh không phụ thuộc browserpoll để director_wait có runtime events. Store change publishchat/invalidate; fingerprint không dùng timestamp heartbeat thayđổi liên tục; stale presence được read/poll với clock.
- [ ] Issue retry/status idempotent; expectedUpdatedAt+run/issue/current parked episode được validate trước effect; duplicates không unpark lần2 hay resetopen; uncertain→observe/reconcile, không gửi lại effect. Giữ gate/action/error của task khác.
- [ ] Tests real producer→Web send→wait→say→SSE/read, queued-before-register/restart, id collision, redaction, cross credentials, no approval fromchat, repeated/stale issue, host absent. Build/test mục tiêu.

### Task 3: Safe terminal launcher, provider options và bflow open

**Files:** create `apps/cli/src/director-open.ts`, `apps/cli/src/director-terminal.ts`; modify `apps/cli/src/{parser,bin,help,director-commands}.ts` theo exact exports hiện có; tests `apps/cli/test/director-open.test.ts`.
**Interfaces:** `inspectDirectorLaunchOptions(repository): WebDirectorLaunchOptions`; `buildDirectorLaunchPlan(repository,provider)` trả private `{provider,cwd,argv,manualCommand,terminal?}`; `launchDirectorPlan(plan)` trả `{mode,manualCommand,launchedAt}`. Task4 bọc result bằng WebOperation/receipt; Task3 không phụ thuộc Task4. CLI bflowopen reuse launcher, không tự cấp token.
- [ ] Provider enumclaude/codex/agy; exact fixed prompt `/bflow-start` (Codex `$bflow-start` được quote), cwd canonical ownedrepo, shellfalse. Không callercommand/env.
- [ ] Linux terminal selection bằng executable availability; macOS/WSL plan/fallback có test theo runner, không claimlive. SSH/noDesktop→manual_command với argv quote đúng. Không auto install/login/globaltrust/permission bypass.
- [ ] Sanitize Herdr/Orca/nested-provider context; providerhint CLI scoped cho detectProvider, không config role. Không token argv/log.
- [ ] Discovery chỉ binary/version bounded+cache/skill-files check; không model probe. active/waiting cần replaceActive confirmation từWeb; absentstale không chứng minh process đã chết. Không auto-open nhiều cửa sổ.
- [ ] Result terminal_opened chỉ chứng minh spawn; UI chờ actualDirector heartbeat để xác nhận session. Spawnunknown không retry.
- [ ] Tests injection paths/spaces/dollar, noDisplay, versiontimeout, missingbinary, duplicate/cancelled operation và earlyexit. BuildCLI và test tập trung.

### Task 4: Local-server routes, Web credential composition và durable operations

**Files:** create `apps/local-server/src/director.ts`; modify `apps/local-server/src/{routes,server}.ts`, `apps/cli/src/{web-interaction,web-workspace-services}.ts`, operation helper hiện có; tests `apps/local-server/test/director.test.ts`, `apps/cli/test/director-web-services.test.ts`.
**Interfaces:** optional `LocalWebServices.director` methods readView/messages/send/issues/launchOptions/launch dùng contracts Task1; thiếuport→operation_not_allowed. Old routes không đổi.
- [ ] Register6routes qua registry chung, schema parse request/response; authenticate cookie/CSRF/Origin và kiểm lại sau hàng đợi trướceffect.
- [ ] Issue commands đi signed WebPrincipal + existing host receipt path; launch operation local_lifecycle intent persisted trước spawn, fingerprint provider/replace/canonicalproject; replay observeonly, restart in-flight→reconciliation_required, không launch lại.
- [ ] Hostdown/sessions v2/DirectoryUnavailable trả actionableVN; không steal Owner/Director tokens choWeb. Read views scope project/session canonical; deadlines bounded.
- [ ] Tests noCSRF/badOrigin/expiredCookie, crossproject, staleversion, unknownreceipt crashboundary afterspawn, same operationId conflicting provider, legacybackend missingport, response redaction.
- [ ] BuildWeb trước serverintegration; run targettests. No unrelated routerrefactor.

### Task 5: Classic Web — Director chat/presence và mở phiên

**Files:** modify `apps/web/src/api/{client,commands,events}.ts`, `app.tsx`, chat/components/session/overview modules; create `apps/web/src/features/director/{status,launch}.tsx`; tests `apps/web/test/director-chat.test.tsx`, `director-launch.test.tsx`, operation-recovery cases.
**Interfaces:** consumes1/4; produces shared Director read state/actioncontroller for Classic and3D; no AgentRole change.
- [ ] Common transcript projectscope, sequencecursor/dedup; no rootcontracts import. Unknown-delivery recovery uses originalid/observe; no blind resend. Keep text visible/label focus and background refresh stable.
- [ ] Presenceactive/waiting/absent text; readfailure=unknown, không đổi thànhabsent. Queued message remains sendable khiDirector absent vàhostalive. No fake typing/streaming; simple message-levelupdates.
- [ ] Startsession opensprovider picker ataction; remember UI preferenceonly. Separate diagnostic infrastructurestart label. Showmanualcommand/copy with confirmation; never equate terminal-opened withDirector-ready. Retrying launch never reruns unknown effect.
- [ ] Hide/direct obsolete create_request form inDirector layout; legacy mode/history remains explicitreadonly where required. Approval cards keep existing ownerWeb flow.
- [ ] Tests hooks/focus/keyboard/reduced-motion/statusregions, busy/loadingnoCLS, Director absent/reappears, Cursorreset/restart, no approval fromchat, cross-tab duplicateops, API failures.

### Task 6: Classic issue queue và partial completion

**Files:** create `apps/web/src/features/issues/{index,detail}.tsx`; modify app routes/navigation, shared reasons andrunstatuslabels; tests `apps/web/test/issue-queue.test.tsx`.
**Interfaces:** shared IssueQueue panel/controller exported foroffice inspector; all writes onlyinClassic/sharedcontroller.
- [ ] List/detail kind/status/attempts/evidence/suggestedaction; retry/dismiss with expectedUpdatedAt and commandId, disabled stale/non-current episodes. Dismiss doesnotunpark.
- [ ] completed_with_parked always distinct Vietnamese label/count, no verified-completed marker; showparked tasks even when issue dismissed. Artifactlinks use existing authenticatedartifact API.
- [ ] Preserve recoveryrecords/kind validation in both lists; unknown effect observeonly. Tests retry→runimplementing, duplicate/staleissue, gatePending, dismissstillparked, Store/transporterror.

### Task 7: Office3D Director entity, queueboard và accessible parity

**Files:** modify `apps/web/src/features/office/model/{types,derive,seats,labels}.ts`, scene/ui modules; tests office-derive/seats/parity/boundaries andnew `director-office.test.tsx`.
**Interfaces:** `OfficeDirector` is separateUIentity from `OfficeAgent[]`; local seatkind extendsdirector only; reads Task5/6 via projection props.
- [ ] One Director desk incontrolroom (existingconversation cell), no fakeagent/pane/instanceId. Presence fromhostheartbeat, notHerdr done; unknown distinctconfirmedabsent.
- [ ] V3 placeholders removechat/coord; legacyv2 viewsretainhistory/labels. Logicalhandoffs tocoordinator endatDirector desk visually, notnewwire role.
- [ ] Queueboard openssharedClassic panel; scene/model noAPI writes/import commandcontroller. DOM AccessibleOffice hasDirector andqueue actions, coherent announcements/focus andcamera fallback.
- [ ] Keepexistingstyletokens/geometry/assets; no newdeps/assets fromnetwork. Test puremodels, scene boundaries, no falsecompletions, keyboard/mobile/reducedmotion, readonly network architecture.

### Task 8: Director guide, repo skills và compatibility cleanup

**Files:** create `agents/director/system-prompt.md`; modify runtime Director guide loader, `apps/cli/src/{director-skill,director-repo-files}.ts` và tests; create generated templates bflow-status/bflow-queue using current repo-file receipt system.
**Interfaces:** privateguide loader (khôngAgentRoleprofile); legacyread_coordinator_guide delegatesDirector guide inDirectorlayout, oldguide forv2. Onecanonical source rendered3providers.
- [x] Guide<=16384UTF8bytes, status/queue helpers<=4096each. No codeediting/approve/evidence; fast1-line edit stillDevelopertask. Explicit errorqueue/absence/SSE/message-level loop; wait whenidle forWeb, boundedcontext/cursor.
- [x] Repo init/update/remove receipts exacthash ownership, backups/conflicts forcustomfiles. Keep currentbflowdirectorstart canonical; bflowopen onlyTask3 implemented. No providerglobalHook edits or hookcode prohibition.
- [x] Keep neededv2 adapters/prompts/contracts untilrelease transition/live evidence. Remove only provenunreferencedv3 startup code withtests, never deletewholeconversation modulejustbecause no pane.
- [x] Tests prompt/skill instruction coverage andrender consistency, not claimedrealLLM behavioralproof. Testfixture request "sửa nhanh1dòng" expectsdelegation guidance, no approve tool. Source/providerlive eval separateTask10.

**Status:** complete source/local, commits `1fd89b68`, `1f4c6a04`; independent Opus Spec review PASS, Quality needs fix → scoped Sonnet re-review PASS after round1. Deferred minors recorded in handoff/SDD ledger; no live LLM acceptance claim.

### Task 9: Cross-slice fake acceptance, migration và fault/recovery matrix

**Files:** add `tests/e2e/scenarios/e18-director-web-office.e2e.test.ts`, helpers; focusedproperty/model tests underownedpackages.
- [ ] RealRuntime/Core/Store/Registry/Git withfakeprovider/Herdr: POSTWeb message→wait→say→transcript/SSE→start_work→humanWebapproval→task/faultpark→independentsfinish→Webretry→completed.
- [ ] ActiveDirector run on same actualmanifest throughup/down barrier/checkpoint/restart/resume; no v2CLI creation, legacyv2readonly. Close priorE16coupling coveragegap withoutfalse acceptance.
- [ ] Stateful sequences send/timeout/replay, SSEepochreset/duplicates, CLIclosedreopenqueued input, popupunknown/noDesktop, staleissueepisode, expiredCSRF+queued effect. SeededPRNG no newdeps; preserve every fence/quality/human gate.
- [ ] Browser visual checks inprivatecontext localfixtureAPI, capture artifact/report aslocalUIevidence (notliveProvider).

### Task 10: Scoped live/probe campaign và final validation

**Files:** evidence inplan/handoff only; no shared README/ADR changes without approval.
- [ ] Inspect actualHerdr/provider protocol/readiness inisolatednamedtestsession; no releaseallowlist. No setup/globalconfig edit. Record exactversions/provider/permissionmode/scope.
- [ ] Try supportedClaude Director/specialist, Codex, Agy, IDE path independently; unavailableauth/quota/desktop/capability recordedblocked/unverified. No claimmatrixclosure fromfake tests orinstalledCLIs.
- [ ] Prepare tinythrowaway repo/spec andhumanapproval cards; only ownerWebbutton/ownCLIinput mayapprove realrun. If awaitinghuman, keep concreteaction pending, do not forge receipt or runapprove asmodel. Faults developerpane kill, MCPtimeout/E2BIG, Directorclose/reopen; reconcileuncertain, no autosendresend.
- [ ] Final independentwhole-branchreview. Run check:deps, typecheck, E2Etsc, affected --basemain --run; iffull thenroot+Web+E2Eallconfiguredfiles counted, CLIbatches andworkers1..3. Rerun knownloadtimeoutsalone; retain originalexitcodes.
- [ ] Handoff exactHEAD/counts/commands/ownership/migrations/rulings/residuals andsource/local/probe/live tiers. No push/merge untilowner asks.
