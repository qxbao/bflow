# Director lát B2 — Director thay hẳn Conversation + Coordinator trong phiên mới

> Kế hoạch tổng: [2026-11-03-director-agent.md](2026-11-03-director-agent.md). ADR: [0009](../../adr/0009-director-agent.md). Lát B1 (đã merge, `17310e9d`) cung cấp `bflow director start|call|mcp|hook`, `DirectorEndpoint`/`DirectorTools` trong `packages/runtime/src/director/`, `start_work` qua bridge của Conversation, `bflow progress`/`bflow queue`, tệp Director do `bflow init` ghi.

**Mục tiêu:** sau B2, phiên mới không còn pane `conversation`/`coordinator` và không có LLM nào trong Herdr ngoài các vai chuyên trách. Herdr có thêm một tab `progress` không LLM chạy `bflow progress --follow`. Mọi tin trước đây đi tới pane Coordinator (kết quả vai chuyên trách, `task.status`, kết quả verification, wake-up, delegation) được đưa vào **hộp thư Director** và đọc qua `director_wait`. Director tự phân rã việc (`assess`, `propose_workflow`, `request_specialist`, `tick`…). Mọi tin trước đây hiển thị trong pane Conversation (notice, thẻ phê duyệt, câu hỏi `request_user_decision`, tiến độ) đi vào hộp thư Director với `audience: "user"` và vẫn có trong projection Web. Phê duyệt của người **chỉ** qua Web hoặc `bflow approve <#n>` do người tự gõ (D-DIR-02). Ngoài ra, Runtime có hàng đợi lỗi thật: task `parked`, các task độc lập vẫn chạy, run kết thúc `completed_with_parked`, và host tự park một cách tất định.

## Chia lát và thứ tự thực hiện

B2 quá lớn cho một nhánh, nên chia thành hai lát con, mỗi lát merge riêng:

- **B2a — Phiên Director (Task 1–11).** Thực hiện **trước**. Gồm manifest v3, bố cục Herdr không có pane LLM thường trực, tab `progress`, hộp thư Director, Director tự tạo run, gateway Conversation không cần pane, `bflow approve <#n>`, CLI và E2E. Sau B2a, người dùng đã làm được toàn bộ luồng SDLC chỉ với Director. Lỗi kẹt vẫn escalate cả run như hiện nay.
- **B2b — Hàng đợi lỗi (Task 12–14).** Thực hiện **sau**, trên nền B2a. Gồm `TaskStatus` `parked`, chuyển trạng thái trong Core, `completed_with_parked`, park/unpark, và auto-park tất định.

Lý do thứ tự: B2a là yêu cầu cốt lõi (thay vai LLM) và đụng nhiều package. B2b chủ yếu nằm trong Core/Runtime, và auto-park cần ngữ nghĩa resume của chế độ Director (R-B2-12) mà B2a tạo ra.

## Ngoài phạm vi

- **B3:** xoá mã Conversation/Coordinator của host (`host-conversation.ts`, `conversation-inbox*.ts`, display-ack, Stop receipt của Coordinator, prompt `agents/chat`, `agents/coordinator`). B2 chỉ **không khởi động** chúng trong phiên v3 (R-B2-13). Cũng thuộc B3: `skip_task`, Director sửa yêu cầu của run đang chạy (`revise_work`), và các quyền khôi phục thủ công trước đây chỉ gõ được trong pane Conversation (`retire policy phase`, thay review workflow, rào chẩn đoán native, `BFLOWSOS`).
- **Lát C (Web/3D):** chat Web với Director, nút "Khởi động phiên", trang hàng đợi lỗi, ghế Director trong 3D. B2 chỉ bảo đảm `apps/local-server` và `apps/web` vẫn biên dịch và không sập khi không có pane Conversation (R-B2-7).
- Prompt `agents/director/system-prompt.md` và test hành vi prompt (Phase 5): B2 chỉ cập nhật skill và thêm tool `read_coordinator_guide` (Task 5).

## Giới hạn đã biết sau B2 (ghi vào README runtime/cli)

- Phiên v2 đang chạy phải `bflow down` trước khi `bflow up`. Run tạo trong phiên v2 (kể cả run do `start_work` của B1 tạo) chỉ đọc được trong phiên Director. Director chỉ được `inspect`, `cancel`, `reconcile_cancellation` và `reconcile_delivery` trên các run đó (R-B2-12).
- Host vẫn giữ đường mã v2 cho test cũ và để đọc dữ liệu cũ. CLI không bao giờ tạo hay khởi động lại phiên v2.
- Chat Web trong phiên Director báo `chat_adapter_unavailable`. Các thao tác có cấu trúc (phê duyệt, resume, cancel) vẫn dùng được. Web `create_request`/`revise_request`/`answer_clarification` bị từ chối kèm hướng dẫn tiếng Việt.
- `bflow approve <#n>` chạy trong shell cùng UID với Director. Host không phân biệt được người gõ hay model chạy lệnh. Đây là rủi ro đã chấp nhận ở D-DIR-02.
- Khi Director vắng mặt, Runtime vẫn chạy phần tất định (dispatch, gate, verification). Bước cần phán đoán (phân rã, xử lý wake) chờ trong hộp thư.
- Bậc bằng chứng: nguồn cộng test cục bộ (fake runner). Chưa có live Herdr/provider cho chế độ Director.

## Global Constraints

- Node >=22.13, TypeScript strict, ESM (`.js` trong import), Zod 3. Không thêm dependency (không có `fast-check`; property test tự sinh bằng PRNG có seed).
- Dữ liệu qua ranh giới package parse bằng schema `@bflow/contracts`. Không dùng type assertion thay validate.
- Import package khác chỉ qua `@bflow/<pkg>`; trong cùng package dùng đường dẫn tương đối.
- Tệp trạng thái: thư mục `0o700`, tệp `0o600`.
- Token Director (`<tokenId>.<secret>`) không bao giờ xuất hiện trong thông báo lỗi, log, argv hay activity log. Hook không bao giờ chặn, luôn thoát 0 và không in gì ra stdout.
- Không có tool hay method nào cho Director phê duyệt hoặc ghi evidence.
- Không no-op, không implementation luôn-thành-công.
- Subagent **không chạy git**; controller review và commit.
- Build: `./node_modules/.bin/tsc -b <pkg-dir> --pretty false` (KHÔNG dùng `pnpm exec tsc`). Test có mục tiêu: `pnpm exec vitest run <tệp>` từ gốc worktree. Không chạy cả bộ test. Test subprocess import `dist/`, nên phải build trước.
- Chuỗi hiển thị cho người dùng bằng tiếng Việt có dấu.
- **Bổ sung cho B2:**
  - Mỗi task phải để build xanh: `./node_modules/.bin/tsc -b packages/contracts packages/core packages/pane-manager packages/runtime apps/cli apps/local-server apps/web --pretty false` (bỏ package chưa đụng tới nếu chắc chắn không ảnh hưởng).
  - Thay đổi hợp đồng chỉ cộng thêm hoặc có version mới. Không xoá enum `conversation`/`coordinator` (cần để đọc dữ liệu cũ).
  - Không bao giờ gửi lại một delivery `unknown_delivery`.
  - Không coi Herdr `done` hay việc ghi vào hộp thư là bằng chứng task thành công.

---

## Vị trí mã hiện tại (đã đọc tại `17310e9d`)

| Hạng mục | Vị trí |
| --- | --- |
| Manifest bắt buộc pane conversation/coordinator | `packages/contracts/src/session.ts:150` (`SessionManifestSchema`, `schemaVersion: z.literal(2)`), `:165` (`attachTarget.role: z.literal("conversation")`), `:206-221` (status `up` phải có pane conversation và coordinator), `:223-229` (attachTarget phải là pane conversation) |
| Hồ sơ vai, quy tắc người nhận | `session.ts:44-112` (`AgentRoleProfileSchema`), `:427-545` (`RoleMessageSchema.superRefine`: vai chuyên trách chỉ gửi tới `coordinator`/`runtime`; `user` chỉ gửi/nhận với `conversation`) |
| Delegation | `session.ts:370-419` (`requestedBy: z.enum(["conversation","coordinator"])` ở `:378`; conversation chỉ được giao cho coordinator ở `:398-404`) |
| Port lifecycle | `packages/contracts/src/ports.ts:227-234` (`SessionLifecycleManager.attach` trả `PaneBinding`) |
| Danh sách vai thường trực | `packages/pane-manager/src/types.ts:15` (`PERMANENT_TOPOLOGY_ROLES` có `chat`, `coordinator`), `:78-99` (spec tab conversation/coordination) |
| Tạo bố cục pane | `packages/pane-manager/src/role-pane-manager.ts:602-621` (root pane của workspace dùng env của chat), `:647-680` (tab Conversation), `:688-702` (tab Coordination), `:720-740` (`persistProgress` ghi manifest v2), `:1026-1048` (focus pane Conversation, thiếu pane chat thì lỗi), `:1050-1078` (manifest cuối, status `up` cần chat và coordinator), `:2347` (`focusConversationPane`) |
| Pane không LLM có sẵn (mẫu) | `packages/runtime/src/agentic/task-log-pane.ts` (receipt theo phase, `tab create` → `pane rename` → `pane run`, kiểm tiến trình bằng `pane process-info`, không bao giờ chạy lại `pane run` khi chưa chắc) |
| CLI dựng pane-manager | `apps/cli/src/pane-manager-integration.ts:56-99` (vai thường trực lấy từ config), `:145-152` (`attach` bắt buộc pane conversation) |
| Outbox: giao trong tiến trình | `packages/runtime/src/agentic/journal.ts:299` (`isConversationDelivery`), `outbox.ts:55-56` (yêu cầu capability `repository.read` cho người nhận `coordinator`), `:328` (failover hold trừ conversation), `:335` (`sending` → `unknown_delivery` trừ conversation), `:386-404` (giải phóng phía coordinator), `:414` (Conversation: `queued` → `sending`), `runtime.ts:1154-1170` (`flushOutbound`), `:1176-1203` (`deliverConversationInbox` giao ngoài khoá journal) |
| Outbox tới Coordinator | `runtime.ts:606-614` (`wakeCoordinator`), `:576-585` (`emit`, mặc định gửi conversation, sender coordinator), `:616-695` (`recoverMissingCoordinatorWakeups`, gồm áp dụng approval đã giao ở `:638-660`) |
| Áp dụng tin tới coordinator | `runtime.ts:1704-1711` (`receiveHerdr`, chỉ nhận recipient `coordinator`/`runtime`), `:1756+` (`applyAuthenticatedHerdrMessage`), `host.ts:2757-2774` (`applyInboundPrompt`: tin `sender: runtime` không có ngữ nghĩa khi tới; tin khác cần pane người gửi) |
| Định tuyến notice | `packages/runtime/src/agentic/workspace.ts:430-433` (`deliverToConversation` → `conversation.receiveRuntime` + `onConversationNotice`), `host.ts:1289` (`onConversationNotice` → `receipts.appendConversationNotice`), `host.ts:2932` (`ConversationInboxNotifier`), `host.ts:2916` (`chatPump`), `conversation-notice-render.ts:526` (`renderConversationNotice`), `:544` (`notificationBody`) |
| Gateway Conversation trong tiến trình | `packages/runtime/src/agentic/conversation.ts:48-59` (bắt buộc pane conversation và coordinator), `:72-145` (`prepareDecisionEnvelope` gắn pane id), `:150-160` (`DurableBridge.handOffToCoordinator`), `:457` (`delegateDirectorWork` của B1) |
| `request_user_decision` | `runtime.ts:3436` (`requestUserDecision`, cần binding pane), `:3465-3467` (enqueue `buildDecisionRequestMessage` tới `conversation`), `decision-routing.ts:255` (`buildDecisionRequestMessage`), `runtime.ts:3598` (`resumeUserDecisionAsker`) |
| Kiểm người gửi trong `admitDelegation` | `runtime.ts:281-290` (`isConversationHandoff`/`isCancellationHandoff`: sender `conversation` → recipient `coordinator`), `:971-1016` (`queueHerdr`), `:1020-1039` (`admitDelegation`), `:1103-1114` (`cancellationTarget`: `requestedBy === "conversation"`, so với `manifest.conversationSessionId`), `:1781-1811` (nhánh nhận `delegation.request`: kiểm sender/requestedBy, chống chéo phiên, emit `delegation.accepted`) |
| Đường start_work của B1 | `host.ts:1722-1745` (`DirectorEndpoint.work.start` → `conversation.delegateDirectorWork`) |
| Cổng resume cần pane Coordinator | `runtime.ts:2356` (`resumeRecoverableRuns`), `:2402-2406` (bỏ qua nếu pane coordinator không sẵn sàng) |
| defaultAgentKind lấy từ pane coordinator | `workspace.ts:283`, `:289` |
| Config bắt buộc conversation/coordinator | `apps/cli/src/environment-config.ts:211` (vai mặc định), `:431-432` (kiểm bắt buộc), `apps/cli/src/config-migration.ts:33-35`, `apps/cli/src/platform-options.ts:208-209` (bắt buộc coordinator), `packages/runtime/src/platform/host-options.ts:87-88` (platform roles phải có conversation/coordinator) |
| Danh sách vai của host | `host.ts:371` (`roles` có conversation, coordinator) |
| Chuyển trạng thái task trong Core | `packages/contracts/src/transitions.ts:3-16` (`TaskTransitionIntent`, `normalTaskTransitions`), `:41-70` (`validateTaskTransition`), `orchestration.ts:49-56` (`intent: z.enum(["normal","retry","rework","cancel"])`), `packages/contracts/src/execution.ts:10-21` (`TaskStatusSchema`), `packages/core/src/graph.ts:29-30` (`completedStatuses`, `capacityStatuses`), `:113-133` (`dependencyPermanentlyUnsatisfied`), `:135+` (`selectRunnableTasks`), `workflow-engine.ts:335-417` (`advance`), `:419-490` (`transitionTask`), `:1810-1878` (`#recomputeRunStatus`), `:1880` (`#hasFailFastFailure`), `packages/contracts/src/versioning.ts:108-122` (codec aggregate 1/2, `requiresAuthenticatedBindingCodec`) |
| Trạng thái run Runtime | `packages/contracts/src/sdlc.ts:6-20` (`SdlcWorkStatusSchema`), `runtime.ts:94-96` (`TERMINAL_RUN_STATUSES`, `ENDED_RUN_STATUSES`), `journal.ts:89-107` (`pendingAction`), `journal.ts:291` (version 1–7), `:305` (parser), `:697-699` (nâng version khi lưu) |
| Tín hiệu dùng cho auto-park | Watchdog: `host.ts:144` (`executeHostWatchdogPass`), `run-watchdog.ts:79` (`evaluateWatchdog`), `:140` (`evaluateIdleCheck`). Stall: `runtime.ts:1602` (`reportRunStalled`: holder có `taskId`, nhắc một lần rồi escalate `auto_resume`). Blocked: `:1585` (`reportWorkflowBlocked`). Ngân sách resume: `:139` (`AUTO_RESUME_LIMIT = 3`), `:2356`. Verification: `:197` (`VERIFICATION_ATTEMPT_LIMIT = 3`), `:5259`. Tin không hợp lệ: `:733` (`escalateInvalidMessages`). Lỗi giao cấu trúc: `:219` (`STRUCTURAL_DELIVERY_BLOCKERS`). Failover: `provider-failover.ts:57` (`hold`), `:128` (`switch_budget_exhausted`), `:133` (`old_execution_stop_budget_exhausted`). Rework cạn: `workflow-engine.ts:1847-1854` (`onExhausted: require_human` → task `blocked`). Hồ sơ nguyên nhân rework: `rework-causality.ts` |

---

## Quyết định thiết kế (kiến trúc sư đã chốt)

**R-B2-1 — Giữ RoleMessage v2 và vai logic `coordinator`.** Host/Runtime định tuyến `recipient.role === "coordinator"` vào hộp thư Director thay vì Herdr. Vai chuyên trách vẫn gửi tới `coordinator`. `AgentAssignment.assignedBy` vẫn là `"coordinator"`. `emit` vẫn dùng `sender: coordinator`.
- *Lý do:* `RoleMessageSchema` (vai chuyên trách chỉ nói với `coordinator`/`runtime`), `AgentAssignmentSchema.assignedBy: z.literal("coordinator")`, các role profile, journal/receipt cũ và plugin `bflow.receipts` (không dùng pane của người nhận, `native-plugin.ts:60`) đều giữ nguyên. Đổi người nhận thành `director`/`runtime` sẽ kéo theo RoleMessage v3, các upcaster và prompt của mọi vai, mà không thêm bảo đảm nào. Trong phiên v3, "coordinator" là **thẩm quyền lập kế hoạch logic** mà principal Director nắm giữ.
- *Activity log:* mọi tool Director ghi thêm `principal: "director"` (đã có tiền tố `director:` ở B1).
- *Giá nếu sai:* nếu sau này cần tách Director khỏi coordinator trong audit/hợp đồng, phải ra RoleMessage v3. Dấu vết `principal` giúp việc chuyển không mất lịch sử.

**R-B2-2 — Chế độ phiên do `SessionManifest.schemaVersion` quyết định.** `3` là chế độ Director, `2` là chế độ cũ. Runtime nhận chế độ qua cổng tùy chọn `ports.director` (Task 3); có cổng nghĩa là chế độ Director. Host chỉ truyền cổng khi manifest đã kích hoạt là v3. Không có cờ ẩn nào khác.
- *Lý do:* chế độ đi theo dữ liệu đã kiểm (manifest), nên khởi động lại vẫn ổn định. Test v2 cũ giữ nguyên.
- *Giá nếu sai:* hai chế độ làm tăng bề mặt. B3 xoá chế độ v2 sau khi có bằng chứng E2E.

**R-B2-3 — Hình dạng SessionManifest v3.**
- `SessionManifestSchema` thành union của `SessionManifestV2Schema` (giữ nguyên hiện nay) và `SessionManifestV3Schema`, phân biệt bằng `schemaVersion`.
- v3 giữ `conversationSessionId`, với nghĩa mới là **id phiên tương tác** của cổng người (Web, `bflow approve`, alias `#n`). Lý do: mọi kiểm chống chéo phiên (`runtime.ts:1108`, `:1785`), receipt người và Web đều dựa vào trường này.
- v3 thêm `progressPane` (không phải `PaneBinding`, vì không có vai `progress`).
- `attachTarget` của v3 là `{ role: "progress", tabId, paneId, terminalId? }`.
- v3 **cấm** pane có `role` `conversation` hoặc `coordinator`.
- `PaneBinding` lồng bên trong vẫn là v2. Đây là ngoại lệ có chủ đích với quy tắc "giá trị lồng thừa hưởng version": `PaneBinding` là record có version riêng và dùng lại trong outbound, receipt, lease. Nâng version của nó kéo theo cả chuỗi.
- *Giá nếu sai:* reviewer tích hợp có thể yêu cầu PaneBinding v3. Ghi rõ trong Task 1 như một quyết định tích hợp cần duyệt.

**R-B2-4 — Director tự tạo run, không mạo danh Conversation.**
- `DelegationRequest.requestedBy` thêm `"director"` (cộng thêm), với ràng buộc: `targetRole === "coordinator"`, `runId` bắt buộc, không có `roleProfile`.
- Runtime thêm `admitDirectorWork(input)`. Hàm này dùng **đúng** `admitDelegation` (new/duplicate/rejected) và kiểm `sessionId === manifest.conversationSessionId` cùng manifest v3. Nó tạo `RunRecord` ở `intake` và `emit` `delegation.accepted` như nhánh `:1810`.
- Không có RoleMessage, không có outbox tới coordinator: Director chính là bên nhận việc.
- Khoá idempotent vẫn như B1 (`director:<messageId của tin người>`), nên `runId` không đổi.
- Trong phiên v3, `start_work` dùng đường mới. `delegateDirectorWork` (bridge Conversation) chỉ còn cho phiên v2.
- Director sửa yêu cầu của run đang chạy thuộc B3. Ở B2 thì hủy rồi `start_work` lại.
- *Giá nếu sai:* nếu có code chỉ chấp nhận `requestedBy: "conversation"` (ví dụ `cancellationTarget`), run Director không hủy được qua Web. Task 4 phải rà và test việc hủy qua tool `cancel` lẫn Web.

**R-B2-5 — Hộp thư Director dùng cơ chế inbox trong tiến trình.**
- Trong chế độ Director, `HerdrOutbox.enqueue` gắn `delivery: "director_mailbox"` cho mọi outbound không có `parentAssignmentId` và có `recipient.role === "coordinator"`. Trường được lưu bền, nên khởi động lại vẫn ổn định.
- Vòng đời giống Conversation: `queued` → `sending` (trong khoá) → giao **ngoài khoá journal** qua `ports.director.deliver(message)` → `delivered`. Lỗi được retry có giới hạn như `CONVERSATION_DELIVERY_MAX_ATTEMPTS`, hết lượt thì `failed`.
- Không Herdr, không lease, không kiểm capability, không `unknown_delivery`.
- Sau khi giao, nếu tin là `approval.decision` từ cổng người (`sender.role === "conversation"`), Runtime **áp dụng tại chỗ**. Đây là đúng đường `recoverMissingCoordinatorWakeups` đang dùng cho approval đã giao (`runtime.ts:638-660`): `authorizeHuman` → `withRecoveredHerdrReceipt` → `applyAuthenticatedHerdrMessage(message, false)`.
- Tin `sender: runtime` chỉ để thông báo (như `host.ts:2766`), không có ngữ nghĩa.
- Journal lên **v8** khi có `delivery`, `requestedBy: "director"`, task `parked` hoặc `completed_with_parked`. Parser từ chối các trường này nếu `version < 8`.
- *Giá nếu sai:* nếu một kiểu tin tới coordinator khác (ngoài approval) cần áp dụng khi nhận, nó sẽ nằm im. Test bảng ở Task 3 liệt kê mọi kiểu tin tới coordinator và hành vi mong đợi; kiểu nào chưa xếp loại thì đánh dấu `failed` kèm lý do, không được lặng lẽ bỏ qua.

**R-B2-6 — Notice cho người.**
- Tin tới `conversation` vẫn đi vào gateway Conversation trong tiến trình (tất định, không LLM), nơi giữ thẻ, alias `#n`, receipt notice và projection Web.
- Trong chế độ Director, `onConversationNotice` của host còn ghi **bản sao** vào hộp thư Director với `audience: "user"` và `text` do `renderConversationNotice` + `notificationBody(…, 1200)` dựng.
- Notifier/nudge của pane, `chatPump` và nhánh display-ack của watchdog không chạy.
- *Lý do:* Web và mã thẻ giữ nguyên ở B2; lát C hợp nhất kho. *Giá nếu sai:* hai kho notice có thể lệch. Bản sao gắn `messageId` gốc nên đối chiếu được.

**R-B2-7 — Gateway Conversation không cần pane.**
- `createAgenticConversationHost` chấp nhận manifest v3. Envelope của nó bỏ `agent_id`/`pane_id`.
- Trong phiên v3:
  - Web `create_request`, `revise_request`, `answer_clarification` → `validation` với thông điệp `"Phiên Director: hãy gửi yêu cầu cho Director trong CLI (chạy /bflow-start)."`.
  - `answer_decision`, `resume`, `cancel` giữ nguyên.
  - `webChat.supported()` trả `false`, sinh blocker `chat_adapter_unavailable` đã có sẵn (`host.ts:611`).
- Không có đường nào dereference pane conversation trong v3.

**R-B2-8 — Phê duyệt bằng CLI: `bflow approve <#n>`.**
- Dạng mới: đối số vị trí khớp `/^#[1-9]\d*$/`, kèm cờ `--reject`, `--changes "<lý do>"` hoặc `--choice <số>` (cho user decision). Dạng cũ `bflow approve <task-id>` giữ nguyên.
- CLI gọi method chủ `human_decision_cli` với `{ code, outcome, reason?, choice? }`. Host tra alias (`receipts.noticeAliases()`) ra thẻ đang chờ.
- Host dựng `ApprovalDecision` khớp đúng request (revision, generation, target), rồi ghi receipt người với provenance mới `{ kind: "cli_owner", pid, tty: boolean, at }`. `receipts.authenticateHuman` nhận receipt này.
- Sau đó quyết định đi đúng đường của Web `answer_decision` trong gateway.
- Director **không** có tool tương ứng. Method chỉ mở cho token chủ, và token Director (có dấu `.`) bị từ chối.
- *Rủi ro đã chấp nhận (D-DIR-02):* cùng UID nên Director chạy lệnh shell được. Không kiểm TTY, vì `!` của Claude Code không bảo đảm có TTY [S]. Trường `tty` chỉ để audit.

**R-B2-9 — Pane tiến trình do Pane Manager sở hữu.**
- Trong bố cục Director, `RolePaneManager` tạo tab `progress` từ root pane của workspace, đổi tên pane thành `progress`, rồi `pane run` lệnh trong `config.progressCommand`. CLI truyền `[...await resolveBflowCommand(), "progress", "--follow"]`.
- Manifest lưu `progressPane: { tabId, paneId, terminalId, command, phase, restarts }`.
- `ensureProgressPane()` theo đúng kỷ luật receipt của `TaskLogPane`: không chạy lại `pane run` khi chưa chắc. Nếu tiến trình đã thoát và pane về shell, nó chạy lại, tối đa **5 lần trong 10 phút**; quá giới hạn thì `phase: "failed"` và manifest `degraded`.
- `ensureProgressPane()` được gọi từ `inspectTopologyHealth` và từ watchdog của host (60 s).
- Không preflight provider, không attestation, không MCP.
- *Giá nếu sai:* nếu Herdr không có `pane process-info` trên một bản nào đó, pane tiến trình bị coi là chưa chắc và không chạy lại. Manifest `degraded` chứ không sập phiên.

**R-B2-10 — `bflow up` là bring-up hạ tầng của chế độ Director.**
- Lệnh dựng daemon, Herdr, vai chuyên trách và tab `progress`, rồi in: `"Hạ tầng Bflow đã sẵn sàng. Phiên làm việc bắt đầu khi bạn mở CLI (Claude Code/Codex/Agy) trong kho này và chạy /bflow-start."`
- Help của `up` ghi rõ: dựng hạ tầng/chẩn đoán, không tạo phiên làm việc.
- `bflow director start` của B1 vẫn gọi lại `up`.
- Nếu manifest đã lưu là v2 và status khác `down`, `up` từ chối với `"Phiên v2 (có pane Conversation/Coordinator) đang chạy. Chạy \`bflow down\` rồi \`bflow up\` để nâng cấp lên phiên Director."`. Nếu v2 đã `down` thì khởi tạo v3 mới (`initializeTopology`).
- `bflow attach` mặc định focus tab `progress`.

**R-B2-11 — Cấu hình không còn vai conversation/coordinator (D-DIR-06).**
- `readEnvironmentConfig` và `platform-options` không còn bắt buộc hai vai này. Mục cũ được **bỏ qua** kèm chẩn đoán cảnh báo `"Đã bỏ qua vai conversation/coordinator (Director thay thế). Chạy \`bflow config-migrate\` để gỡ khỏi cấu hình."` (theo mục tiêu zero-config, không làm hỏng `up`).
- `bflow config-migrate` và `bflow init --update` gỡ hai mục khỏi `.bflow/config.yml`, có bản `.bak`.
- Vai mặc định khi init không còn chứa chúng. Không thêm vai `director`.
- `AgenticHostPlatformOptionsSchema` bỏ yêu cầu `conversation`/`coordinator`, và **từ chối** chúng khi kèm `layout: "director"`.

**R-B2-12 — Run cũ trong phiên Director, và resume.**
- Run có `delegation.requestedBy !== "director"` là **run cũ**. Tool Director trên run cũ chỉ cho `inspect`, `cancel`, `reconcile_cancellation`, `reconcile_delivery`. Tool khác lỗi `"Run v2 chỉ đọc trong phiên Director; hủy rồi tạo lại bằng start_work"`.
- `resumeRecoverableRuns` trong chế độ Director bỏ qua run cũ.
- Với run Director, `resume_coordinator` chỉ tự resume khi `ports.director.present()` khác `absent`, vì gửi wake vào hộp thư khi Director vắng chỉ phí ngân sách. Điều kiện này thay cho kiểm pane coordinator (`runtime.ts:2402-2406`).
- `capability_repair`/`verificationRetry` giữ nguyên.

**R-B2-13 — Gỡ mã cũ để sang B3.** B2 không xoá `host-conversation.ts`, `conversation-inbox*.ts`, display-ack hay Stop receipt của Coordinator. Phiên v3 không có pane để chúng chạy, và host không khởi động notifier/pump. B3 xoá sau khi E2E chế độ Director (Task 10) và B2b đã qua.

**R-B2-14 — `TaskStatus` `parked` (B2b).**
- Thêm giá trị `parked`, intent mới `"park"` và `"unpark"`.
- Chuyển hợp lệ:
  - `pending | ready | blocked | waiting → parked` (park).
  - `running → parked` (park), chỉ khi không có `agentExecution` hoặc đã có xác nhận dừng của đúng execution đó (cùng luật với cancel, `workflow-engine.ts:470-476`).
  - `parked → ready` (unpark): phụ thuộc phải thỏa; reducer xoá `agentExecution`/`blockage`; attempt tiếp tục tăng ở `ready → running`.
  - `parked → cancelled` (cancel).
- `parked` không chiếm capacity, không phải trạng thái kết thúc, không phải thành công. Task phụ thuộc (cả `succeeded` lẫn `completed`) **đứng yên `pending`**, không bị `cancelled`.
- Core không thêm `RunStatus`: khi không còn gì chạy được mà có task `parked`, Core trả `blocked`.
- Checkpoint aggregate cần **codec 3** khi có `parked`, theo mẫu `requiresAuthenticatedBindingCodec`.
- *Giá nếu sai:* `blocked` của Core vừa là "chờ người" vừa là "chỉ còn mục park". Runtime phân biệt bằng tập task (R-B2-15).

**R-B2-15 — `completed_with_parked` (B2b).**
- Đây là giá trị mới của `SdlcWorkStatusSchema`. Runtime đặt nó khi snapshot Core là `blocked` và mọi task chưa thành công đều `parked` hoặc đứng sau một task `parked`. Nghĩa là: không có task đang chạy hay chạy được, không có gate người đang chờ, và có ít nhất một task `parked`.
- Khi đó: không integration, không workflow verification, giữ worktree.
- Trạng thái này thuộc `TERMINAL_RUN_STATUSES` (không tạo việc mới, watchdog bỏ qua) nhưng **không** thuộc `ENDED_RUN_STATUSES`.
- Chỉ mở lại bằng unpark (`unpark_task`, `bflow queue retry`, `set_issue_status retrying`), sau đó run về `implementing`. `dismiss` chỉ đổi trạng thái issue, task vẫn `parked`.
- Không bao giờ hiển thị như `completed`: nhãn tiếng Việt là `"Xong một phần — còn N mục treo"`.
- *Giá nếu sai:* chủ dự án có thể muốn integration từng phần. Thêm sau là tương thích, vì không có dữ liệu nào bị gộp sai.

**R-B2-16 — Auto-park tất định (B2b).**
- Chỉ áp dụng **sau khi ngân sách hiện có đã cạn**, cho nguyên nhân gắn với **đúng một** task Core (khác `workflow-verification`). Các nguồn kích hoạt:
  1. Stall có holder mang `taskId`, sau lần nhắc và sau `maxAutoResumesBeforePark` lần auto-resume.
  2. Failover `hold` có `blocked = true` (`switch_budget_exhausted`, `old_execution_stop_budget_exhausted`).
  3. Rework cạn với `onExhausted: require_human` (task `blocked`, chỉ một task).
  4. `escalateInvalidMessages` cho một assignment.
  5. Lỗi giao cấu trúc của `task.assignment`/`verification.requested` bị escalate sau giới hạn.
- Điều kiện chặn, không bao giờ park khi:
  - task còn `unknown_delivery`/`sending`/`nativeDeliveries`;
  - task có gate người hoặc user decision đang chờ;
  - còn execution đang chạy mà chưa có xác nhận dừng;
  - run đã bị hủy.
- Cấu hình `environment.issueQueue: { autoPark?: boolean (mặc định true), maxAutoResumesBeforePark?: 0..3 (mặc định 3 = AUTO_RESUME_LIMIT) }`. Chỉ được **giảm**, không tăng số lần thử.
- Mỗi lần park sẽ upsert `ParkedIssue` qua `ports.director.upsertIssue` với khoá `park:<runId>:<taskId>:<episode>`. Episode là số lần park của task đó.
- Ánh xạ `kind`: stall/lỗi giao → `transport_failure`; failover → `provider_failure`; rework → `rework_exhausted`; verification → `verification_exhausted`; tin không hợp lệ → `other`.

---

## B2a — Phiên Director

### Task 1: Hợp đồng v3 (`packages/contracts`)

**Mô hình:** Sonnet. Đây là thay đổi hợp đồng công khai, đã có trong phạm vi ADR 0009 "Lát B trở đi". Integrator ghi phụ lục ADR ở Task 11.

**Tệp:** sửa `packages/contracts/src/session.ts`, `packages/contracts/src/director.ts`, `packages/contracts/src/ports.ts`, `packages/contracts/src/index.ts` (nếu cần export). Test: sửa `packages/contracts/test/v2-contracts.test.ts`, tạo `packages/contracts/test/session-manifest-v3.test.ts` và `packages/contracts/test/director-mailbox.test.ts`. Fixture: `packages/contracts/test/fixtures/session-manifest-v2-real.json` và `session-manifest-v3.json`.

```ts
export const ProgressPaneSchema = z.object({
  tabId: IdentifierSchema, paneId: IdentifierSchema, terminalId: IdentifierSchema.optional(),
  command: z.array(z.string().min(1).max(4096)).min(1).max(16),
  phase: z.enum(["created", "launch_intent", "launch_unknown", "running", "failed"]),
  restarts: z.array(IsoDateTimeSchema).max(20),
  launchedAt: IsoDateTimeSchema.optional()
}).strict();
export const SessionManifestV2Schema = /* the current SessionManifestSchema, unchanged */;
export const SessionManifestV3Schema = z.object({
  schemaVersion: z.literal(3), sessionId, projectName, workspaceRoot, herdrWorkspaceId,
  herdrTabId /* = progress tab id */, status: SessionManifestStatusSchema,
  conversationSessionId: IdentifierSchema /* interaction session id */, activeRunIds, roleProfiles?,
  panes: z.array(PaneBindingSchema) /* may be empty */, progressPane: ProgressPaneSchema.optional(),
  attachTarget: z.object({ role: z.literal("progress"), tabId, paneId, terminalId? }).strict(),
  createdAt, updatedAt, stoppedAt?, metadata?
}).strict().superRefine(/* see below */);
export const SessionManifestSchema = z.union([SessionManifestV2Schema, SessionManifestV3Schema]);
export type SessionManifestV2 = z.infer<typeof SessionManifestV2Schema>;
export type SessionManifestV3 = z.infer<typeof SessionManifestV3Schema>;
export type SessionManifest = SessionManifestV2 | SessionManifestV3;
export function isDirectorSessionManifest(manifest: SessionManifest): manifest is SessionManifestV3;
```

1. **Union có kiểm version.** Zod `union` trả lỗi gộp khó đọc, nên `SessionManifestSchema` dùng `z.custom`/`preprocess`: đọc `schemaVersion` trước. Giá trị `2` parse bằng V2, `3` bằng V3. Giá trị khác cho lỗi `"unsupported session manifest schemaVersion: <n>"`. Mọi `SessionManifestSchema.parse(...)` hiện có phải vẫn chạy (`safeParse` cũng vậy). Nếu `z.union` cho thông báo lỗi chấp nhận được thì dùng `z.union`, miễn test lỗi version lạ khớp chuỗi trên.
2. **Ràng buộc V3** (superRefine):
   - không pane nào có `role` `conversation`/`coordinator`;
   - `paneId` không trùng (gồm cả `progressPane.paneId`);
   - `pane.sessionId === sessionId`;
   - profile pin khớp snapshot (copy luật V2);
   - nếu có `progressPane` thì `attachTarget.paneId === progressPane.paneId` và `attachTarget.tabId === progressPane.tabId`;
   - status `up` bắt buộc có `progressPane` với `phase === "running"`.
3. **DelegationRequest.**
   - `requestedBy` thêm `"director"`.
   - superRefine mới: director ⇒ `targetRole === "coordinator"`, `runId !== undefined`, không có `roleProfile`.
   - Luật roleProfile hiện có (`only Coordinator may select…`) vẫn đúng.
4. **Hộp thư Director** (`director.ts`, schema version giữ `1`, chỉ cộng thêm):
   ```ts
   export const DirectorMailboxItemSchema = z.object({
     schemaVersion: version, seq: z.number().int().min(1), messageId: id, at: time,
     audience: z.enum(["director", "user"]), runId: id.optional(), taskId: id.optional(),
     type: id /* RoleMessage type */, kind: id.optional() /* payload.kind */,
     fromRole: z.union([AgentRoleSchema, z.literal("runtime")]),
     summary: issueText, text: nonblank(4000).optional() /* rendered Vietnamese for audience user */,
     code: z.string().regex(/^#[1-9]\d*$/).optional() /* approval alias when known */
   }).strict();
   ```
   `DirectorWaitResultSchema` thêm `mailbox: z.array(DirectorMailboxItemSchema).max(200).optional()`. `DIRECTOR_LIMITS` thêm `mailboxPage: 200`, `mailboxMax: 5000`.
5. **Port.** `SessionLifecycleManager` thêm phương thức tùy chọn `attachProgress?(sessionId, options?): Promise<OperationResult<{ tabId: string; paneId: string; terminalId?: string }>>`. `attach` giữ nguyên.
6. **Fixture thật.** `session-manifest-v2-real.json` lấy từ một manifest v2 thật do `RolePaneManager` ghi. Dựng bằng test fixture hiện có, hoặc chép từ `.bflow/state/panes/*.manifest.json` của máy dev, rồi thay đường dẫn và id bằng chuỗi giả nhưng **giữ nguyên các trường và kiểu**. `session-manifest-v3.json` dựng tay theo schema.
7. **Test** (`session-manifest-v3.test.ts`):
   - v2 thật parse được và `isDirectorSessionManifest === false`;
   - v3 hợp lệ parse được;
   - v3 có pane `coordinator` bị từ chối;
   - v3 `up` thiếu `progressPane` bị từ chối;
   - `attachTarget` lệch bị từ chối;
   - `schemaVersion: 4` → lỗi đúng chuỗi;
   - v3 có `panes: []` và status `initializing` hợp lệ.
8. **Test delegation:**
   - `requestedBy: "director"` với `targetRole: "developer"` bị từ chối;
   - thiếu `runId` bị từ chối;
   - hợp lệ thì parse được;
   - mọi test v2 cũ vẫn qua.
9. **Test hộp thư** (`director-mailbox.test.ts`): item hợp lệ; `code` sai định dạng; `DirectorWaitResult` không có `mailbox` vẫn parse được (tương thích B1).
10. Build `packages/contracts`, rồi build các package dùng `SessionManifest`. Sửa lỗi kiểu do union bằng narrowing `isDirectorSessionManifest`, **không** cast. Nơi nào đọc `attachTarget.role === "conversation"` thì để nguyên ngữ nghĩa cho nhánh v2.

---

### Task 2: Bố cục Director và pane tiến trình (`packages/pane-manager`)

**Mô hình:** Opus. Tệp 160K và có kỷ luật receipt Herdr.

**Tệp:** sửa `packages/pane-manager/src/types.ts`, `packages/pane-manager/src/role-pane-manager.ts`, `packages/pane-manager/src/index.ts`; tạo `packages/pane-manager/src/progress-pane.ts`. Test: tạo `packages/pane-manager/test/director-layout.test.ts` và `packages/pane-manager/test/progress-pane.test.ts`. Dùng runner Herdr giả có sẵn trong test pane-manager.

```ts
// types.ts — RolePaneManager config
readonly layout?: "legacy_v2" | "director";      // default "legacy_v2" (existing tests unchanged)
readonly progressCommand?: readonly string[];    // required when layout === "director"
export const DIRECTOR_PERMANENT_TOPOLOGY_ROLES = ["planner", "analyst", "architect", "reviewer", "qa-verifier"] as const;
// progress-pane.ts
export interface ProgressPaneDeps { herdr(args: string[]): Promise<string>; clock(): Date; workspaceRoot: string }
export async function launchProgressPane(deps, input: { workspaceId: string; tabId: string; paneId: string; terminalId: string; command: readonly string[] }): Promise<ProgressPane>;
export async function ensureProgressPane(deps, current: ProgressPane): Promise<ProgressPane>;   // never replays uncertain pane.run
export function progressRestartAllowed(restarts: readonly string[], now: Date): boolean;     // ≤ 5 within 10 min
```

1. **Bố cục `director`** (`initializeTopology`/`reconcileTopology` rẽ nhánh theo `config.layout`):
   - Không tạo tab Conversation/Coordination cho `chat`/`coordinator`.
   - Root pane của `workspace create` được đặt tên tab `progress` (`tab rename <tabId> progress`) và pane `progress` (`pane rename <paneId> progress`). Lệnh create không dùng env của chat.
   - Nếu `permanentRoles` có `chat` hoặc `coordinator` trong bố cục `director` thì trả `validationError("Director layout cannot start conversation/coordinator panes")`.
   - Vai chuyên trách thường trực vẫn vào tab `coordination`/`verification` như cũ (nhãn tab giữ nguyên để không phá Web).
   - Manifest ghi bằng `SessionManifestV3Schema` với `schemaVersion: 3`, `herdrTabId` là tab progress, `attachTarget: { role: "progress", tabId, paneId, terminalId }`.
2. **Chạy lệnh** (`launchProgressPane`), theo đúng `task-log-pane.ts`:
   - Ghi `progressPane.phase = "launch_intent"` vào manifest **trước** `pane run`.
   - Lệnh shell là các phần tử của `progressCommand` được quote bằng hàm `quote` giống `task-log-pane.ts:35`, nối bằng khoảng trắng. `pane run` phải trả stdout rỗng.
   - Sau đó xác nhận bằng `pane process-info`: tiến trình foreground có `argv` **bằng đúng** `progressCommand` (so `resolve(argv[0])` với `resolve(command[0])` khi là đường dẫn tuyệt đối). Đúng thì `phase = "running"`, `launchedAt = now`.
   - Lỗi hoặc không xác nhận được thì `phase = "launch_unknown"` và **không** chạy lại.
3. **`ensureProgressPane`** (gọi từ `inspectTopologyHealth` và method công khai mới `RolePaneManager.ensureProgressPane(options)`):

   | Quan sát | Hành động |
   | --- | --- |
   | `running` + viewer | giữ nguyên |
   | `running` + shell trống (tiến trình đã thoát) | nếu `progressRestartAllowed` thì thêm `now` vào `restarts` và chạy lại như bước 2; không thì `phase = "failed"` |
   | `launch_unknown` + viewer | `running` |
   | `launch_unknown` + shell | `failed` (không chạy lại khi chưa chắc) |
   | pane missing/replaced (terminal id khác) | tạo lại tab `progress` (một lần trong mỗi lần ensure) |
   | foreign | `failed`, không đụng pane |

   Manifest `status = "degraded"` khi `progressPane.phase !== "running"`, và quay về `up` khi `running` lại (nếu các điều kiện khác của `up` đều đạt).
4. **`focusProgressPane(options)`**: `workspace focus` → `tab focus <progressPane.tabId>`. Bỏ `agent focus` vì pane này không có agent. Trả `{ tabId, paneId, terminalId }`. Manifest v2 thì trả `validationError("Session is a v2 session; run bflow down then bflow up")`.
5. **Manifest v2 đang lưu và bố cục `director`:**
   - `reconcileTopology` trả `conflictError("Phiên v2 (có pane Conversation/Coordinator) đang chạy. Chạy \`bflow down\` rồi \`bflow up\` để nâng cấp lên phiên Director.")` nếu status khác `down`.
   - Nếu status là `down` thì gọi `initializeTopology` (manifest v3 mới, giữ `conversationSessionId` cũ để Web và receipt người tiếp tục khớp).
6. `shutdownTopology` đóng cả pane progress, theo cách đóng pane do mình sở hữu như `task-log-pane.ts:closeLocked`.
7. **Test** (runner giả, có ghi lại argv):
   - `director` không gọi tạo tab conversation và không tạo agent chat/coordinator;
   - manifest v3 parse được;
   - `attachTarget` là progress;
   - `pane run` nhận chuỗi lệnh đúng quote;
   - `ensure` chạy lại sau khi viewer thoát, và lần thứ 6 trong 10 phút thì `failed` + `degraded`;
   - `launch_unknown` không bao giờ chạy lại;
   - v2 `up` cộng bố cục `director` thì lỗi đúng chuỗi;
   - v2 `down` cộng bố cục `director` thì ra manifest v3 với `conversationSessionId` cũ;
   - `focusProgressPane` gọi `tab focus` với tab đúng;
   - bố cục `legacy_v2` không đổi: chạy lại các test pane-manager hiện có liên quan đến `initializeTopology`.

---

### Task 3: Hộp thư Director trong Runtime (journal v8, outbox)

**Mô hình:** Opus. Đây là lõi định tuyến, đụng bất biến delivery.

**Tệp:** sửa `packages/runtime/src/agentic/ports.ts`, `journal.ts`, `outbox.ts`, `runtime.ts`. Test: tạo `packages/runtime/test/agentic/director-mailbox-routing.test.ts`; mở rộng `packages/runtime/test/helpers/agentic-integration-fixture.ts` với tùy chọn `director: true`.

```ts
// ports.ts
export interface DirectorRuntimePort {
  /** Idempotent per message_id; durable before resolve. Never Herdr. */
  deliver(message: RoleMessage): Promise<void>;
  present(): Promise<boolean>;                       // presence !== "absent"
  upsertIssue?(input: DirectorIssueInput): Promise<void>;   // used in B2b
}
// AgenticRuntimePorts
director?: DirectorRuntimePort;
// journal.ts — Outbound
delivery?: "director_mailbox";
export function isInProcessDelivery(out: Outbound): boolean;   // isConversationDelivery(out) || out.delivery === "director_mailbox"
```

1. **Journal v8.**
   - `JournalState.version` thêm `8`; parser nhận `[1..8]`.
   - Hàm lưu (`journal.ts:697`) đặt `version = 8` khi có ít nhất một: `out.delivery`; `run.delegation.requestedBy === "director"`; task Core `parked` trong `run.tasks` (B2b); `run.status === "completed_with_parked"` (B2b).
   - Parser: `state.version < 8` mà có các trường trên thì throw `"Director journal fields require private journal v8"`. `out.delivery` chỉ được có khi `recipient.role === "coordinator"` và không có `parentAssignmentId`/`handle`/`lease`/`request`.
2. **Gắn delivery.** `HerdrOutbox` nhận tùy chọn `directorMailbox: boolean` (do Runtime truyền khi `ports.director` có mặt). Trong `enqueue`, nếu `directorMailbox && !parentAssignmentId && recipient.role === "coordinator"` thì:
   - đặt `delivery = "director_mailbox"`, `capabilities = []`;
   - không tính `repositoryReaders` (`outbox.ts:55`);
   - không kiểm profile pin.
3. Mọi chỗ đang dùng `isConversationDelivery` cho ngữ nghĩa "inbox trong tiến trình" chuyển sang `isInProcessDelivery`: `outbox.ts:328`, `:335`, `:414`, `:477`, nhánh guard continuation trong `outbox.ts`, `runtime.ts:1176` và các chỗ khác do `grep -n isConversationDelivery` tìm ra. Chỗ chỉ dành cho Conversation (ví dụ `failedConversationDeliveries`) giữ tên cũ và lọc thêm `out.delivery === undefined`. Liệt kê từng chỗ đã đổi trong báo cáo task.
4. **Giao ngoài khoá.** `deliverConversationInbox` đổi tên thành `deliverInProcessInbox`. Với item có `delivery === "director_mailbox"`, nó gọi `this.ports.director!.deliver(message)`. Backoff, giới hạn lượt và chuyển `failed` giữ nguyên. Thiếu `ports.director` mà có item `director_mailbox` (journal v8 mở bằng host v2) thì `failed` với lý do `"Director mailbox unavailable in this session"`; không bao giờ rơi về Herdr.
5. **Áp dụng tại chỗ.** Sau khi chuyển `delivered`, ngoài khoá journal:
   - `approval.decision` có `sender.role === "conversation"`: `if (await this.ports.authorizeHuman(ApprovalDecisionSchema.parse(message.payload))) await withRecoveredHerdrReceipt(message, () => this.applyAuthenticatedHerdrMessage(message, false))`. Lỗi gọi `reportInboundFailure` (như `runtime.ts:654-659`). `authorizeHuman` sai thì `reportInboundFailure(message, "Human approval is not authenticated")`.
   - `delegation.request` cancel từ conversation: đã được rút cục bộ ở `drainCancellationControls`, không làm thêm. Kiểm bằng test.
   - `sender.role === "runtime"`: không làm gì thêm.
   - Kiểu khác tới coordinator từ `conversation` (ví dụ `conversation.clarification`, `task.status` ngữ cảnh): không có trong phiên v3 vì gateway không còn lượt hội thoại. Nếu gặp thì `reportInboundFailure(message, "Unsupported Conversation→Coordinator message in Director session")`, không áp dụng.
6. **Resume** (`resumeRecoverableRuns`, `runtime.ts:2402-2406`). Có `ports.director` thì:
   - bỏ qua run có `delegation.requestedBy !== "director"`;
   - thay kiểm pane coordinator bằng `await this.ports.director.present()`.
   Không có `ports.director` thì giữ nguyên.
7. **Rà trong chế độ Director.** Mọi chỗ đọc pane coordinator (`getRoleBinding("coordinator")`, `inspectRoleHealth("coordinator")`, `outbox.ts:386-404`, `runtime.ts:1616` holder coordinator, `runtime.ts:2830`) phải:
   - không throw khi không có pane;
   - không coi outbound `director_mailbox` là holder đang nợ kết quả (`reportRunStalled`, `runFacts.activeHandoff`). Wake trong hộp thư không phải việc dở của vai.
   Ghi test cho `runFacts`/`reportRunStalled` với wake `delivered`.
8. **Test** (`director-mailbox-routing.test.ts`, fixture `director: true`: manifest v3 không có pane conversation/coordinator, `ports.director` giả lưu mảng và đếm lời gọi):
   - Kết quả vai chuyên trách (`task.status` từ planner) → `wakeCoordinator` → outbound có `delivery`, sau `flushOutbound` là `delivered`; `director.deliver` nhận đúng `message_id`; transport Herdr **không** được gọi cho tin này.
   - Gọi `flushOutbound` hai lần không giao trùng (idempotent theo trạng thái).
   - `deliver` throw → retry có backoff → đủ lượt thì `failed`, và không bao giờ `unknown_delivery`.
   - `approval.decision` từ gateway → giao rồi áp dụng; run rời `awaiting_approval`. `authorizeHuman` sai → không áp dụng và có inbound failure.
   - `resumeRecoverableRuns`: `present() === false` thì không resume; `true` thì resume.
   - Run cũ (`requestedBy: "conversation"`) không auto-resume.
   - Journal v7 thật (fixture `packages/runtime/test/fixtures/journal-v7-real.json`, dựng bằng cách chạy fixture tích hợp tới khi có run completed, rồi serialize và redact đường dẫn) vẫn parse được. Lưu lại không có trường mới thì version giữ `7`.
   - JSON v7 có `delivery` bị từ chối.
   - Chế độ v2 (fixture mặc định): các test `auto-resume.test.ts`, `conversation-host-rpc.test.ts` vẫn qua (chạy có mục tiêu).

---

### Task 4: Director tạo run và chặn run cũ (`admitDirectorWork`)

**Mô hình:** Sonnet. Đặc biệt cẩn thận ở phần hủy.

**Tệp:** sửa `packages/runtime/src/agentic/runtime.ts`, `packages/runtime/src/agentic/tools.ts`. Test: tạo `packages/runtime/test/agentic/director-admission.test.ts`.

```ts
// runtime.ts
async admitDirectorWork(input: unknown): Promise<{ runId: string; correlationId: string; admission: "new" | "duplicate" }>;
// tools.ts — CoordinatorTools.invoke(name, params, { role, principal?: "director" })
export const DIRECTOR_LEGACY_RUN_TOOLS: readonly string[] = ["inspect", "cancel", "reconcile_cancellation", "reconcile_delivery", "tick", "tick_status", "read_role_profiles"];
```

1. **`admitDirectorWork`:**
   - Nếu quiesced thì throw `"Runtime is quiesced"`.
   - Parse `DelegationRequestSchema`; `requestedBy` phải là `"director"`, `targetRole` là `"coordinator"`.
   - Đọc manifest: phải là v3, và `delegation.sessionId === manifest.conversationSessionId`, nếu không thì `"Director work requires an active Director session"` / `"Cross-session delegation"`.
   - Trong transaction:
     - `admission = this.admitDelegation(state, delegation, [])`;
     - `rejected` → `AdmissionRejectedError(reason)` (không `notifyRejection`, vì Director nhận lỗi trực tiếp);
     - `revision` → `AdmissionRejectedError("Director requirement revisions are not supported in slice B2; cancel the run and call start_work again")`;
     - `new` → `state.runs.push({ runId, delegation, status: "intake", tasks: [], coreCreated: false, cancelled: false, maxIterations: 3 })` và `this.emit(state, outbox, run, "delegation.accepted", { delegationId, revision: 1, sdlcStatus: "intake", headline: "Director đã nhận việc" }, "accepted")`;
     - `duplicate` → trả dữ liệu cũ.
   - Không có outbound nào tới `coordinator`.
2. **Hủy.**
   - Tool `cancel` của Coordinator dùng `cancelRun` qua `CoordinatorTools`. Kiểm nó không đòi `requestedBy: "conversation"`.
   - Web `cancel` đi qua gateway thành `isCancellationHandoff` → `cancellationTarget` (`runtime.ts:1103`), vốn đòi `delegation.requestedBy === "conversation"`. Đó là delegation **của lệnh hủy**, do gateway dựng, nên đúng. Tiếp theo nó so `run.delegation.sessionId === delegation.sessionId`: run Director dùng `manifest.conversationSessionId` nên khớp.
   - Viết test chứng minh cả hai đường hủy được run Director. Nếu đường nào hỏng, sửa tối thiểu trong `cancellationTarget` (không nới kiểm sessionId).
3. **Chặn run cũ.** `CoordinatorTools.invoke` nhận `principal?: "director"`. Khi có principal Director, tool có `runId` trong tham số mà run có `delegation.requestedBy !== "director"`, và tên tool không thuộc `DIRECTOR_LEGACY_RUN_TOOLS`, thì throw `"Run v2 chỉ đọc trong phiên Director; hủy rồi tạo lại bằng start_work"`. Coordinator v2 (không có principal) không đổi.
4. **Test:**
   - Run mới: run ở `intake`, có outbound `delegation.accepted` tới conversation, không outbound tới coordinator.
   - Gọi lại cùng delegation → `duplicate`, cùng `runId`.
   - Cùng `runId` nhưng nội dung khác → `rejected` (thông điệp của `admitDelegation`).
   - Manifest v2 → lỗi.
   - `sessionId` khác → lỗi.
   - Sau đó `propose_workflow` với `principal: "director"` hoạt động như Coordinator (dùng fixture spec hiện có).
   - Hủy bằng tool `cancel` và bằng Web `cancel` (gateway, Task 6, hoặc dựng envelope như fixture) đều hủy được.
   - Run cũ + `propose_workflow` + principal Director → lỗi đúng chuỗi; `inspect` trên run cũ vẫn được.
   - Journal sau khi admit có `version === 8`.

---

### Task 5: Kho hộp thư và tool Director (`packages/runtime/src/director`)

**Mô hình:** Sonnet.

**Tệp:** sửa `packages/runtime/src/director/store.ts`, `tools.ts`, `endpoint.ts`, `host-methods.ts`, `index.ts`. Test: mở rộng `packages/runtime/test/director/store.test.ts`, `tools.test.ts`, `endpoint.test.ts`, `mcp.test.ts`.

```ts
// store.ts
async appendMailbox(input: Omit<DirectorMailboxItem, "schemaVersion" | "seq">): Promise<{ item: DirectorMailboxItem; duplicate: boolean }>; // dedupe by messageId+audience
async readMailbox(query: { afterSeq: number; limit?: number; audience?: "director" | "user" }): Promise<DirectorMailboxItem[]>;
async mailboxItem(messageId: string): Promise<DirectorMailboxItem | undefined>;
// DirectorVersion gains mailboxSeq; waitForChange wakes on mailbox append
// endpoint.ts
async deliverRuntimeMessage(message: RoleMessage): Promise<void>;          // audience director (Task 3 port)
async mirrorUserNotice(message: RoleMessage, rendered: { text: string; code?: string }): Promise<void>; // audience user (R-B2-6)
// tools.ts — new DIRECTOR_OWN_TOOLS entries
read_mailbox, read_coordinator_guide
```

1. **Lưu trữ.**
   - Tệp `mailbox.jsonl` trong thư mục Director (`0o600`), append-only, cùng cách đọc chịu lỗi dòng cuối hỏng như transcript (`loadTranscript`).
   - Chỉ mục dedupe theo `${audience}:${messageId}`: gọi lại trả `duplicate: true`, không tăng `seq`.
   - Giữ tối đa `DIRECTOR_LIMITS.mailboxMax` item. Khi vượt, compact bằng cách ghi tệp mới qua rename nguyên tử, giữ `seq` tăng đơn điệu.
2. **`deliverRuntimeMessage(message)`** dựng item `audience: "director"`:
   - `fromRole`: `message.sender.role` nếu là vai hoặc runtime; với `user`/`conversation` thì `"runtime"`;
   - `kind`: `payload.kind` nếu là chuỗi;
   - `taskId`: `payload.taskId` nếu có;
   - `summary`: `"<type>[/<kind>] từ <fromRole>: <headline|summary|reason|status>"`, cắt còn `issueTextMax` và redact bằng `redactString`;
   - không lưu payload thô. Director đọc chi tiết bằng `inspect`.
3. **`mirrorUserNotice(message, rendered)`** dựng item `audience: "user"`, `text` (≤ 4000), `code`. Dedupe như trên.
4. **`director_wait`:**
   - Cursor mới là `m<seq>.i<rev>.b<mailboxSeq>.r<base64url>`. Cursor B1 `m.i.r` vẫn nhận được, với `b` lấy bằng `mailboxSeq` hiện tại (không đổ ngược lịch sử). Cursor `""` vẫn nghĩa là "từ bây giờ".
   - Kết quả có `mailbox` (tối đa `mailboxPage`). Một item mới là lý do trả về ngay, giống tin người.
5. **Tool mới:**
   - `read_mailbox { afterSeq?, audience?, limit? }`: đọc trang, tối đa 200.
   - `read_coordinator_guide { }`: trả `{ source, prompt }` từ `readBuiltinRolePrompt("coordinator")` của `@bflow/pane-manager`, giống `host.ts:719`. Endpoint nhận nó qua option `coordinatorGuide: () => Promise<{ source: string; prompt: string }>` do host truyền, nên `tools.ts` không import pane-manager. Chuỗi trả về tối đa 64 KiB, thêm tiền tố `"Hướng dẫn lập kế hoạch của Coordinator (Director dùng thay). Bỏ qua các phần nói về pane, Herdr và Conversation."`.
   Mô tả tool bằng tiếng Anh như các tool khác.
6. **Sửa mô tả `start_work`.** Bỏ câu về pane Coordinator của B1, thay bằng: `"In a Director session you decompose the work yourself: after start_work call planning_reference and read_coordinator_guide, then assess, propose_workflow and request_specialist; specialist results arrive in director_wait mailbox items."`
7. **Method chủ trong `host-methods.ts`:** `director_mailbox` `{ afterSeq?, audience?, limit? }` (để `bflow progress --json` và Web sau này đọc được). Parse strict.
8. **Test:**
   - Append dedupe;
   - compact giữ `seq` đơn điệu;
   - dòng cuối hỏng bị bỏ qua;
   - `director_wait` thức dậy khi có item;
   - cursor B1 cũ vẫn chạy;
   - `read_mailbox` lọc theo audience;
   - `read_coordinator_guide` trả tiền tố và cắt còn 64 KiB;
   - `mcp.test.ts`: `tools/list` có `read_mailbox`, `read_coordinator_guide`;
   - summary không chứa chuỗi giống token (`redactString`).

---

### Task 6: Gateway Conversation không cần pane (`agentic/conversation.ts`)

**Mô hình:** Sonnet.

**Tệp:** sửa `packages/runtime/src/agentic/conversation.ts`, và `packages/runtime/src/interaction/chat.ts` nếu `supported()` cần biết chế độ. Test: tạo `packages/runtime/test/agentic/conversation-director-session.test.ts`.

1. `createAgenticConversationHost`:
   - Với manifest v3, không đòi pane (bỏ throw ở `:59`).
   - Envelope do gateway dựng (`prepareDecisionEnvelope`, `DurableBridge.handOffToCoordinator`, cancellation) dùng `sender: { role: "conversation" }`, `recipient: { role: "coordinator" }`, không có `agent_id`/`pane_id`.
   - Với v2 thì giữ nguyên.
2. Trong v3:
   - `handleStructuredInteraction` cho `create_request`, `revise_request`, `answer_clarification` trả `{ ok: false, error: { code: "validation", retryable: false, message: "Phiên Director: hãy gửi yêu cầu cho Director trong CLI (chạy /bflow-start)." } }`, không gọi bridge.
   - `handleUserTurn` (đường hook pane) throw `"Director session has no Conversation pane"`.
   - `delegateDirectorWork` throw `"Use admitDirectorWork in a Director session"`.
3. Kiểm đường `recoverMissingCoordinatorWakeups` (`runtime.ts:639-648`) với v3: `sender` không tìm thấy pane conversation thì giữ nguyên message. Nhánh này đã chịu được `undefined`, chỉ cần test.
4. **Test:**
   - Manifest v3 tạo host được;
   - `answer_decision` qua structured interaction tạo outbound `approval.decision` không có pane id, và (cùng Task 3) được áp dụng sau khi giao;
   - `resume` và `cancel` chạy được;
   - ba lệnh Web bị từ chối đúng chuỗi;
   - v2 vẫn đòi pane (test cũ `conversation-host-rpc.test.ts` qua).

---

### Task 7: Host chế độ Director (`workspace.ts`, `host.ts`, `platform/host-options.ts`)

**Mô hình:** Opus. Đây là chỗ ghép, nhiều vòng đời.

**Tệp:** sửa `packages/runtime/src/agentic/workspace.ts`, `packages/runtime/src/agentic/host.ts`, `packages/runtime/src/agentic/host-controller.ts` (option `layout`, `progressCommand`), `packages/runtime/src/platform/host-options.ts`. Test: tạo `packages/runtime/test/agentic/host-director-mode.test.ts` cho các hàm đã tách; mở rộng `packages/runtime/test/director/host-wiring.test.ts`.

1. **Cấu hình host.**
   - `AgenticHostOptions`/`HostConfiguration` thêm `layout?: "legacy_v2" | "director"` và `progressCommand?: string[]`. Thiếu `layout` nghĩa là `legacy_v2`.
   - `AgenticHostPlatformOptionsSchema` thêm `layout`. Khi `director`, bỏ yêu cầu `conversation`/`coordinator` (`host-options.ts:87`) và thêm issue nếu có hai vai đó.
   - Khi `legacy_v2`, giữ nguyên.
2. **Vai của host.** Khi `layout === "director"`, vòng `for (const role of roles)` (`host.ts:680`) bỏ qua `conversation` và `coordinator`: không tạo token vai, hook hay launch descriptor, và không đòi prompt gốc của hai vai này (`:718`).
3. **Workspace.**
   - `openAgenticWorkspace`: `defaultAgentKind` không còn lấy từ pane coordinator (`workspace.ts:283`, `:289`). Lấy từ option mới `defaultAgentKind` do host truyền (provider của vai chuyên trách đầu tiên trong `platformRoles`, nếu không có thì `"claude"`). Với manifest v2 giữ cách cũ.
   - `RolePaneManager` trong workspace nhận `layout` và `progressCommand` lấy từ `manifest.progressPane.command`.
   - Khi manifest v3, truyền `ports.director = { deliver: m => directorEndpoint.deliverRuntimeMessage(m), present: async () => (await directorEndpoint.presence()) !== "absent" }` qua option mới `director` của `openAgenticWorkspace`.
   - `DirectorEndpoint` được dựng **trước** `activate`. Hiện nó đã dựng ở `host.ts:1722`; dời lên trước hoặc dùng closure lười, không tạo hai instance. Thêm method `presence()` nếu endpoint chưa có.
4. **Notice.** `onConversationNotice` (`host.ts:1289`) vẫn gọi `receipts.appendConversationNotice(message)`. Khi v3, nó còn gọi `directorEndpoint.mirrorUserNotice(message, { text: notificationBody(renderConversationNotice(<notice từ receipt>), 1200), code })`. Lấy notice và `shortId` từ kết quả `appendConversationNotice`; nếu hàm đó chưa trả thì sửa để trả. Lỗi mirror chỉ ghi activity log, không làm hỏng việc giao.
5. **Tắt đường pane khi v3:**
   - không khởi động `chatPump` (`host.ts:2916`) và `ConversationInboxNotifier` (`:2932`);
   - `executeHostWatchdogPass` nhận `directorSession: boolean`. Khi `true`, truyền `notices: []` cho `evaluateWatchdog`, nên không có `reconcile_notice`/`resurface`/`blocked` do display-ack; vẫn chạy `resumeRecoverableRuns` và báo stall;
   - `recordCoordinatorStop`/`settleCoordinatorStop` không có nguồn vì không có pane coordinator. Kiểm chúng không chạy định kỳ khi v3.
   - `webChat.supported()` trả `false` khi v3.
6. **Pane tiến trình.** Mỗi vòng watchdog (và trong `activate`, ngay sau `taskLogPane.ensure`) gọi `workspace.runtime.ports.panes` → `RolePaneManager.ensureProgressPane()`. Đi qua một hàm port mới `ensureProgressPane?()` trên `PanePolicy`, có `try/catch` và ghi activity log `progress_pane_unavailable`.
7. **`start_work`.** Trong `DirectorEndpoint.work.start` (`host.ts:1727`), khi v3:
   - dựng `DelegationRequest` bằng `buildDelegationRequest` của `@bflow/conversation` (giữ id tất định từ `key`), rồi ghi đè `requestedBy: "director"`, `targetRole: "coordinator"`, `sessionId: manifest.conversationSessionId`, `runId: run-<correlationId>`;
   - parse lại bằng `DelegationRequestSchema`;
   - gọi `runtime.admitDirectorWork`;
   - `AdmissionRejectedError` thì throw `start_work refused: <redacted>`;
   - activity log giữ tên `director:start_work:*`.
   Nếu việc ghi đè `requestedBy` làm `buildDelegationRequest` không dùng được nữa, viết hàm thuần `buildDirectorDelegation(input)` trong `packages/runtime/src/director/delegation.ts`, có test chứng minh kết quả khớp cấu trúc của builder (cùng các trường bắt buộc).
8. **`activate` với v3.**
   - `verifyStartupBindings`/`platformSession.verifyActivation` chạy trên danh sách pane (chỉ vai chuyên trách).
   - Plugin `bflow.receipts` vẫn được link (vai chuyên trách cần).
   - Thêm kiểm: `layout === "director"` mà manifest v2, hoặc ngược lại, thì throw `"Session manifest layout does not match host configuration"`.
9. **Test** (dùng các hàm đã tách, không dựng Herdr thật):
   - `executeHostWatchdogPass` với `directorSession: true` không gọi `appendConversationNotice`/`resurfaceConversationNotice` mà vẫn gọi `resumeRecoverableRuns`;
   - host-options `director` có `coordinator` bị từ chối; `director` không có conversation/coordinator thì hợp lệ; `legacy_v2` thiếu coordinator vẫn bị từ chối như cũ;
   - `start_work` trong v3 gọi `admitDirectorWork` với `requestedBy: "director"` và không gọi `delegateDirectorWork`;
   - notice mirror ghi item `audience: "user"` có `code`;
   - hàm chọn `defaultAgentKind`.

---

### Task 8: CLI — cấu hình, `up`, `attach`, `status`, `doctor`

**Mô hình:** Sonnet.

**Tệp:** sửa `apps/cli/src/environment-config.ts`, `apps/cli/src/config-migration.ts`, `apps/cli/src/platform-options.ts`, `apps/cli/src/pane-manager-integration.ts`, `apps/cli/src/environment.ts`, `apps/cli/src/agentic-host.ts` (truyền `layout`/`progressCommand`), `apps/cli/src/formatters.ts`, `apps/cli/src/help.ts`, `apps/cli/src/init-director.ts` (nếu `resolveBflowCommand` cần export). Test: tạo `apps/cli/test/director-session-cli.test.ts`; sửa test config hiện có cho khớp.

1. **Cấu hình** (R-B2-11):
   - Bỏ yêu cầu `conversation`/`coordinator` ở `environment-config.ts:431` và `config-migration.ts:34`.
   - Vai mặc định (`:211`) bỏ `conversation`, `coordinator`.
   - Khi đọc config, mục `conversation`/`coordinator` bị lọc khỏi `roles` kèm chẩn đoán cảnh báo (chuỗi ở R-B2-11). `savedCoordinator` (`:518`) lấy provider từ vai chuyên trách đầu tiên.
   - `platform-options.ts:208` bỏ `throw` khi thiếu coordinator. Provider mặc định của vai chuyên trách lấy từ `environment.defaults` như hiện có.
   - `buildHostPlatformOptions` đặt `layout: "director"`.
2. **`config-migrate` và `init --update`:**
   - Nếu `.bflow/config.yml` còn mục conversation/coordinator, ghi lại tệp không có chúng: bản sao `.bak` trước, rename nguyên tử, dùng lại helper ghi hiện có của `config-migration.ts`.
   - Kết quả có `removedRoles: ["conversation", "coordinator"]`; formatter in `"Đã gỡ vai conversation/coordinator khỏi cấu hình (Director thay thế)."`.
3. **Pane-manager.**
   - `PaneManagerLifecycleAdapter` truyền `layout: "director"` và `progressCommand: [...await resolveBflowCommand(), "progress", "--follow"]`. Hàm khởi tạo là sync, nên tính lệnh trước ở nơi tạo adapter và truyền vào.
   - Bỏ vai `conversation`/`coordinator` khỏi `permanentRoles` (đã lọc ở bước 1).
   - Vì `attach` của port phải trả `PaneBinding` mà pane tiến trình không phải `PaneBinding`, adapter cài `attachProgress` (Task 1, bước 5) bằng `panes.focusProgressPane`. Với manifest v3, `attach` trả `failure("Director session: use attachProgress")`.
4. **`EnvironmentLifecycle`:**
   - `up` trước khi gọi integration: đọc manifest đã lưu; nếu v2 và status khác `down` thì `fail` với chuỗi ở R-B2-10, remediation `"bflow down"`.
   - Sau `up` thành công in dòng hướng dẫn ở R-B2-10.
   - `attach()` (`environment.ts:914`): v3 thì dùng `attachProgress`, kiểm `tabId`/`paneId` khớp `manifest.attachTarget`, rồi `herdr session attach`. Progress đổi thành `"Đang mở tab tiến trình Bflow..."`. v2 giữ nguyên.
   - `validateManifest` chấp nhận v3.
5. **Formatter.** `formatters.ts:858-860`: v3 in `Tab tiến trình: pane <id> (<phase>)`; nếu `phase !== running` thêm `"— chạy \`bflow up\` để mở lại"`. `:970-979` dùng `attachTarget.role` thật.
6. **`doctor`.** Thêm check `director-progress-pane`: `passed` khi `running`; `warn` khi khác, kèm hướng dẫn.
7. **Help.** `up`: `"Dựng hạ tầng Bflow (daemon, Herdr, vai chuyên trách, tab tiến trình). Không tạo phiên làm việc: mở CLI và chạy /bflow-start."` `attach`: `"Mở tab tiến trình của phiên Bflow."`
8. **Test:**
   - Config có conversation/coordinator → đọc được, có cảnh báo, roles đã lọc;
   - `config-migrate` gỡ mục và tạo `.bak`;
   - `up` khi manifest v2 `up` → lỗi đúng chuỗi, không gọi integration;
   - `attach` v3 gọi `attachProgress` rồi `session attach`;
   - formatter v3;
   - `progressCommand` là đường dẫn tuyệt đối và kết thúc bằng `["progress", "--follow"]`;
   - các test `init-director` cũ vẫn qua.

---

### Task 9: `bflow approve <#n>` — phê duyệt của người từ CLI

**Mô hình:** Opus (thẩm quyền của người).

**Tệp:** sửa `apps/cli/src/parser.ts` (nhánh `approve`), `apps/cli/src/commands.ts`, `apps/cli/src/help.ts`, `packages/runtime/src/agentic/host-controller.ts` (`callDirectorOwnerHost` nhận method mới hoặc thêm `callHumanDecisionHost`), `packages/runtime/src/agentic/host.ts` (method chủ), `packages/runtime/src/agentic/host-receipts.ts` (provenance `cli_owner`). Test: tạo `apps/cli/test/approve-code.test.ts` và `packages/runtime/test/agentic/human-decision-cli.test.ts`.

```ts
// host method (owner token only)
human_decision_cli: { code: "#<n>", outcome: "approved" | "rejected" | "changes_requested" | "answer", reason?: string (≤2000), choice?: number (1..6), tty: boolean, pid: number }
→ { approvalId, runId, kind: "approval" | "user_decision", queued: true }
```

1. **Parser.** Nếu đối số vị trí đầu khớp `/^#[1-9]\d*$/` thì đi nhánh mới, với cờ `--reject`, `--changes <lý do>`, `--choice <n>`, `--json`. Mặc định là `approved`.
   - `--choice` chỉ dùng cho user decision và tạo `outcome: "answer"`.
   - Kết hợp cờ mâu thuẫn bị từ chối `"Chỉ chọn một: --reject, --changes hoặc --choice"`.
   - Đối số khác giữ nhánh cũ `approve <task-id>`.
   - Lưu ý zsh/bash: `#` đầu từ có thể bị coi là comment khi không quote. Help ghi `bflow approve '#3'` và CLI cũng nhận `3` hoặc `n3` (chuẩn hoá thành `#3`).
2. **Host.**
   - Token Director bị từ chối như các method chủ khác (R-B1-1).
   - Tra `receipts.noticeAliases().approvalShortIds[code]`; không có thì `not_found` `"Không tìm thấy thẻ <code> đang chờ"`.
   - Đọc run và tìm `approval` (thiết kế/bàn giao/task), `userDecisions[approvalId]` hoặc prototype approval (`prototypeApproval`), rồi dựng `ApprovalDecision` khớp đúng `revision`, `generation`, `target`, `sessionId`, `decidedBy: "human_operator"`, `decidedAt: now`, `idempotencyKey: cli-<digest([code, approvalId, outcome, choice])>`. Với user decision thì dùng `validateUserDecisionAnswer`.
   - Ghi receipt người: `receipts.recordHuman(decision, { kind: "cli_owner", pid, tty, at })`. Mở rộng `HumanHookProvenance` thành union có kiểm. `authenticateHuman` nhận receipt `cli_owner` như receipt hook.
   - Đưa quyết định vào gateway bằng đúng đường structured `answer_decision` (`enqueueDecision`) để kiểm superseded/expired giống Web.
3. **Từ chối:**
   - thẻ không còn pending → `conflict` kèm lý do của gateway;
   - run kết thúc → `conflict`;
   - phiên v2 → vẫn được, vì gateway v2 cũng dùng `enqueueDecision`.
4. **Đầu ra CLI tiếng Việt:** `"Đã ghi quyết định cho thẻ #3 (việc #2): duyệt."`, có `--json`.
5. **Test:**
   - Parser: `#3`, `3`, `--reject`, `--changes "x"`, cờ mâu thuẫn, `approve task-1` vẫn đi nhánh cũ.
   - Host: alias đúng → `ApprovalDecision` khớp request; outbound `approval.decision` được tạo; `authenticateHuman` nhận receipt `cli_owner`.
   - Token Director gọi `human_decision_cli` → `"Director credentials can only call director tools"`.
   - Thẻ hết hạn → conflict.
   - Idempotent: gọi hai lần → một outbound.
   - Không có tool Director nào tên chứa `approve`/`decision` (test danh sách `DIRECTOR_TOOLS`).

---

### Task 10: E2E chế độ Director (fake runner)

**Mô hình:** Sonnet.

**Tệp:** tạo `tests/e2e/scenarios/e17-director-session.e2e.test.ts`. Mở rộng `tests/e2e/helpers/harness.ts`/`fixtures.ts` hoặc `packages/runtime/test/helpers/agentic-integration-fixture.ts` (tùy chọn `director: true` từ Task 3).

1. **Kịch bản chính:**
   - Manifest v3 (không pane conversation/coordinator, có `progressPane` running).
   - Director `start_work` (gọi qua `DirectorTools` thật với store tạm và token thật).
   - `propose_workflow` bằng `principal: "director"`.
   - Phê duyệt thiết kế: dựng `ApprovalDecision` và đưa vào gateway structured `answer_decision`, `authorizeHuman` giả nhận đúng quyết định đó.
   - Developer fake nộp kết quả → Reviewer fake verdict → wake vào hộp thư → `director_wait` trả `mailbox` có `specialist_result_ready`.
   - Run tới `completed`.
2. **Khẳng định:**
   - Transport Herdr không nhận tin nào có `recipient.role` `coordinator`/`conversation`.
   - Hộp thư có item `audience: "user"` cho thẻ phê duyệt, có `code`.
   - Journal version 8.
3. **Kịch bản vắng mặt:** Director `present() === false` → run có `resume_coordinator` không bị auto-resume. Sau `present() === true` thì có resume.
4. **Kịch bản nâng cấp:** journal v7 thật (fixture Task 3) với run v2 `implementing` mở trong phiên v3 → `inspect` được, `propose_workflow` bị chặn, `cancel` được.
5. Chạy `pnpm exec vitest run --config tests/e2e/vitest.config.ts tests/e2e/scenarios/e17-director-session.e2e.test.ts`, sau khi build các package liên quan.

---

### Task 11: Skill Director, README và phụ lục ADR

**Mô hình:** Haiku cho phần văn bản. Phần skill có test đi kèm.

**Tệp:** `apps/cli/src/director-skill.ts` và test skill hiện có; `packages/runtime/README.md`, `apps/cli/README.md`, `packages/pane-manager/README.md`; `docs/adr/0009-director-agent.md` (phụ lục, **chỉ integrator**, vì là tài liệu chung cần review).

1. **Skill.** `BFLOW_START_SKILL_VERSION` → `"1.3.0"`. Mục "Work loop" viết lại:
   - Việc mới: làm rõ tiêu chí → `start_work` → `planning_reference` + `read_coordinator_guide` (một lần mỗi phiên) → `assess` → `propose_workflow` → `tick` → `director_wait`.
   - Với item hộp thư `audience: "director"`: gọi `inspect` cho run đó rồi làm bước kế tiếp (`request_specialist`, `propose_workflow` lại, `retry_verification`…).
   - Với item `audience: "user"`: chuyển `text` cho người bằng `director_say`, giữ nguyên mã thẻ.
   - Không tự phê duyệt; nói cho người hai cách phê duyệt: nút trên Web, hoặc tự gõ `! bflow approve '#n'`.
   - Viết dạng văn xuôi, không có đường dẫn tệp trong backtick (bộ nhớ dự án: đường dẫn trong backtick thành reference bắt buộc).
   - Test skill kiểm có `read_coordinator_guide`, `read_mailbox`, `bflow approve`.
2. **README runtime/cli/pane-manager.** Mục mới "Director (thử nghiệm, lát B2a)", thay mục B1 ở phần giới hạn:
   - manifest v3, tab `progress`, hộp thư, `admitDirectorWork`, `bflow approve <#n>`, `config-migrate`;
   - các giới hạn đã biết ở đầu kế hoạch;
   - bậc bằng chứng "nguồn + test cục bộ".
3. **Phụ lục ADR 0009** (integrator, sau review): liệt kê R-B2-1…R-B2-11 dạng ngắn; các hợp đồng đổi (`SessionManifestV3Schema`, `DelegationRequest.requestedBy: "director"`, `DirectorMailboxItemSchema`, `SessionLifecycleManager.attachProgress`); quyết định PaneBinding v2 lồng trong v3; journal v8.

---

## B2b — Hàng đợi lỗi (`parked`)

### Task 12: Hợp đồng và Core cho `parked`

**Mô hình:** Opus. Bất biến DAG/aggregate.

**Tệp:** sửa `packages/contracts/src/execution.ts`, `transitions.ts`, `orchestration.ts`, `sdlc.ts`, `versioning.ts`; `packages/core/src/graph.ts`, `workflow-engine.ts`, `reducer.ts`. Tất cả nơi có map đầy đủ theo trạng thái task/SDLC (`tsc` sẽ chỉ ra, ví dụ `apps/web/src/components/StatusBadge.tsx`, `apps/web/src/features/runs.tsx`, `packages/runtime/src/director/progress.ts`, `packages/runtime/src/observability/metrics.ts`, `apps/cli/src/director-progress.ts`). Test: tạo `packages/core/test/parked-tasks.test.ts` và `packages/core/test/parked-property.test.ts`; sửa test contracts cho transitions.

1. **Hợp đồng:**
   - `TaskStatusSchema` thêm `"parked"`; `TaskTransitionIntent` và enum `intent` của command thêm `"park"`, `"unpark"`; `normalTaskTransitions` thêm `parked: []` (mọi chuyển ra khỏi `parked` đi qua intent).
   - `validateTaskTransition`:
     - `park` chỉ hợp lệ với `from ∈ {pending, ready, blocked, waiting, running}` và `to === "parked"`;
     - `unpark` chỉ cho `parked → ready`;
     - `cancel` thêm `parked → cancelled`;
     - intent `normal` không bao giờ vào hoặc ra `parked`.
   - `SdlcWorkStatusSchema` thêm `"completed_with_parked"`.
   - `versioning.ts`: `decodeWorkflowAggregateCheckpointState` nhận codec `[1,2,3]`; thêm `requiresParkedTaskCodec(state)` (có task `parked` trong snapshot, trong kết quả command hoặc event `task.status_changed` với `to === "parked"`); codec `< 3` mà cần thì `validationFailure("Parked tasks require aggregate codec 3")`. Bên ghi checkpoint (`workflow-engine.ts:createCheckpoint`) chọn codec 3 khi cần, 2 khi có binding xác thực, 1 khi không có gì.
2. **Core:**
   - `graph.ts`: `parked` không thuộc `completedStatuses`, `capacityStatuses` hay thành công. `dependencyPermanentlyUnsatisfied` trả `false` khi prerequisite `parked` (dependent đứng `pending`). `dependenciesSatisfied` trả `false`.
   - `transitionTask`:
     - `park` từ `running`/`waiting`/`blocked` có `agentExecution` cần xác nhận dừng của đúng execution đó. Dùng lại đúng luật của `to === "cancelled"` (`:470-476`), kèm thông điệp `"Parking a bound execution requires confirmed stop"`.
     - `unpark` cần `dependenciesSatisfied`. Reducer khi `parked → ready` xoá `agentExecution`, `blockage`, `bindingVerification` của lần thử cũ. Attempt giữ nguyên, tăng ở `ready → running` như hiện nay (`reducer.ts:101`).
   - `#recomputeRunStatus`: `parked` không tính vào `hasNonTerminalQueueOrRunning`. Nếu không có gì progressable, không có `waiting`/approval chờ, và có ít nhất một `parked`, thì target `blocked`. `allBusinessSucceeded` sai khi có `parked`. `hasFailure` không tính `parked`.
   - `advance`: không đụng task `parked`. Fail-fast không cancel task `parked`.
   - `recover`/replay event chấp nhận chuyển `parked` (kiểm `:1361` và các nhánh replay).
3. **Test đơn vị** (`parked-tasks.test.ts`):
   - DAG A→B, C độc lập: park A (đang `ready`) → C vẫn được chạy và `succeeded`; B đứng `pending`; run `blocked`.
   - Unpark A → A `ready` → chạy → `succeeded` → B `ready`.
   - Park `running` có execution mà chưa xác nhận dừng → lỗi; có xác nhận dừng → được.
   - Intent `normal` vào `parked` → lỗi.
   - `parked → cancelled` → B `cancelled` (vì `required dependency did not succeed`, như hiện nay).
   - Checkpoint có `parked` chọn codec 3; decode codec 2 có `parked` → lỗi đúng chuỗi.
4. **Property test** (`parked-property.test.ts`, PRNG `mulberry32` có seed cố định, 300 DAG ngẫu nhiên 3–12 task, cạnh chỉ từ thấp tới cao):
   - Chọn ngẫu nhiên một tập task để park khi chúng `ready`. Mọi task khác cho `succeeded` (dùng helper ghi kết quả đã xác thực mà test Core hiện có đang dùng).
   - Khẳng định: (a) mọi task **không** có đường phụ thuộc tới một task park đều `succeeded`; (b) mọi task có đường phụ thuộc thì `pending`; (c) run `blocked`; (d) unpark tất cả và cho thành công thì run `succeeded`.
   - In seed khi fail.
5. Sửa các map đầy đủ: nhãn tiếng Việt `parked` = `"Treo (hàng đợi lỗi)"`, `completed_with_parked` = `"Xong một phần — còn mục treo"`. Không đổi nhãn khác.

---

### Task 13: Runtime park/unpark và `completed_with_parked`

**Mô hình:** Opus.

**Tệp:** sửa `packages/runtime/src/agentic/runtime.ts`, `journal.ts`, `tools.ts` (CoordinatorTools); `packages/runtime/src/director/tools.ts`, `endpoint.ts` (tool `park_task`, `unpark_task`; `set_issue_status retrying` gọi unpark); `packages/runtime/src/director/snapshot.ts`, `progress.ts` (hiển thị). Test: tạo `packages/runtime/test/agentic/park-unpark.test.ts`; mở rộng `packages/runtime/test/director/tools.test.ts`.

```ts
// runtime.ts
async parkTask(input: { runId: string; taskId: string; reason: string; kind: ParkedIssueKind; source: "director" | "auto"; episodeKey?: string }): Promise<{ parked: boolean; runStatus: SdlcWorkStatus }>;
async unparkTask(input: { runId: string; taskId: string; source: "director" | "user" }): Promise<{ unparked: boolean; runStatus: SdlcWorkStatus }>;
```

1. **Trước khi viết:** đọc đường retry/redispatch của một task Developer trong `runtime.ts` (tìm `retrying`, `writerReleased`, `releaseDeveloper`, `resumeBlockedRun`) và **bắt chước** cách nó đặt lại `TaskRecord` cho lần thử mới (worktree giữ, lease cũ đã release, cycle mới). Ghi tóm tắt vào báo cáo task.
2. **`parkTask`:**
   - Từ chối khi: run bị hủy hoặc `ENDED_RUN_STATUSES`; `taskId === "workflow-verification"`; task có `unknown_delivery`/`sending`/`nativeDeliveries`; có approval/user decision pending của task; execution còn sống.
   - Nếu execution còn sống: gọi đường dừng có sẵn (`stopDeveloperExecutionScope`/interrupt như cancellation, có giới hạn quan sát `CANCEL_STOP_OBSERVATION_LIMIT`). Chưa có xác nhận dừng thì trả `{ parked: false }` kèm lý do, **không** park.
   - Release lease bằng `leaseRelease` như cancellation. Outbound chưa gửi của task chuyển `cancelled` với lý do `"Task parked"`.
   - Gọi Core `transitionTask(intent: "park")`.
   - Nếu run đang `escalated` vì đúng task này (pendingAction trỏ outbound của task), khôi phục `previousStatus` và xoá `pendingAction`, vì issue đã thay chỗ của nó.
   - Ghi `run.tasks[i].parked = { at, reason, kind, source, episode }` (journal v8).
3. **Tính `completed_with_parked`** sau mỗi lần Core thay đổi (nơi Runtime đọc snapshot và cập nhật `run.status`): snapshot `blocked` + điều kiện R-B2-15 → `run.status = "completed_with_parked"`, rồi `emit` `conversation.progress` `{ kind: "run_completed_with_parked", parkedTaskIds, headline: "Xong một phần: còn N mục trong hàng đợi lỗi" }`. Thêm `completed_with_parked` vào `TERMINAL_RUN_STATUSES`. Rà mọi literal `["completed", "failed", "cancelled"]` trong `runtime.ts`, `outbox.ts`, `watchdog`; với mỗi chỗ ghi quyết định có xếp `completed_with_parked` vào hay không. Mặc định là **có** khi chỗ đó chặn việc mới hoặc báo stall, **không** khi chỗ đó chỉ dùng cho integration/cleanup cuối.
4. **`unparkTask`:**
   - Chỉ khi task `parked`. Core `unpark`, đặt lại `TaskRecord` theo bước 1, xoá `parked` (giữ lịch sử ở `parkHistory`, tối đa 20).
   - Nếu `run.status === "completed_with_parked"` thì `run.status = "implementing"`.
   - Gọi `tick` một lần qua scheduler, không chờ.
5. **Tool Director:**
   - `park_task { runId, taskId, reason }`: chỉ run Director, `kind: "other"`, source `director`. Sau đó upsert issue.
   - `unpark_task { runId, taskId }`.
   - `set_issue_status` với `retrying` trên issue có `taskKey` gọi `unparkTask` trước, rồi mới đổi trạng thái issue. Unpark lỗi thì giữ `open` và trả lỗi.
   - `dismiss` chỉ đổi issue.
   - `bflow queue retry` dùng `director_issue_status` → cùng đường.
6. **Progress/snapshot:** task `parked` hiện trong nhóm "HÀNG ĐỢI LỖI"; run `completed_with_parked` hiện nhãn ở R-B2-15.
7. **Test:**
   - Park task Developer đang `running` với stop giả xác nhận → task `parked`, lease released, task độc lập vẫn được dispatch ở tick sau.
   - Stop không xác nhận → `parked: false`, không đổi gì.
   - Park có `unknown_delivery` → từ chối.
   - Hết việc → `completed_with_parked` và notice; watchdog `watchdogSnapshot` không báo stall run này.
   - `set_issue_status retrying` → unpark → run `implementing` → task chạy lại với attempt mới.
   - Journal v8 sau park.
   - `park_task` trên run cũ bị chặn (R-B2-12).

---

### Task 14: Auto-park tất định và cấu hình

**Mô hình:** Sonnet, với Opus review phần điều kiện chặn.

**Tệp:** sửa `packages/runtime/src/agentic/runtime.ts` (`autoParkPass`), `provider-failover.ts` (báo hold cho pass), `host.ts` (gọi pass trong watchdog, truyền `upsertIssue`), `ports.ts` (`DirectorRuntimePort.upsertIssue`), `apps/cli/src/environment-config.ts` (`environment.issueQueue`), `packages/runtime/src/agentic/host-controller.ts` (policy). Test: tạo `packages/runtime/test/agentic/auto-park.test.ts`; thêm kịch bản vào `tests/e2e/scenarios/e17-director-session.e2e.test.ts`.

```ts
// runtime.ts
async autoParkPass(policy: { enabled: boolean; maxAutoResumesBeforePark: number }): Promise<{ parked: { runId: string; taskId: string; kind: ParkedIssueKind }[] }>;
```

1. **Phát hiện ứng viên** (thuần, tách thành `selectAutoParkCandidates(state, policy, now)` trong `packages/runtime/src/agentic/auto-park.ts` để test được), cho từng run Director **không** bị hủy:
   - `escalated` với `pendingAction.recovery === "manual"` (hoặc `auto_resume` đã có `resumeAttempts >= maxAutoResumesBeforePark`) **và** `sourceMessageId` trỏ tới outbound có `taskId` thuộc `run.definition.tasks`. Nguồn là stall, tin không hợp lệ hoặc lỗi giao cấu trúc; `kind` lấy theo R-B2-16 từ `pendingAction.reason` (khớp `STRUCTURAL_DELIVERY_BLOCKERS` → `transport_failure`; chứa `refused messages` → `other`; còn lại `transport_failure`).
   - Task có `failovers` với hold `blocked` (`switch_budget_exhausted`, `old_execution_stop_budget_exhausted`) → `provider_failure`.
   - Task Core `blocked` với `blockage.code` của rework cạn (`require_human`) → `rework_exhausted`.
   - Verification task-level cạn `VERIFICATION_ATTEMPT_LIMIT` gắn với một task → `verification_exhausted`. Verification workflow-level **không** park.
   - Loại theo điều kiện chặn R-B2-16.
   - `episodeKey` = `${runId}:${taskId}:${parkHistory.length + 1}`.
2. **`autoParkPass`:** với mỗi ứng viên gọi `parkTask({ source: "auto", … })`, rồi `ports.director?.upsertIssue({ key: "park:" + episodeKey, runId, taskKey: taskId, kind, summary: <reason tiếng Việt ≤ 2000>, attempts: resumeAttempts, evidence: <artifact:// của dossier rework nếu có>, suggestedAction })`. `suggestedAction` theo kind:
   - transport: `"Kiểm tra pane vai trong Herdr rồi bflow queue retry <id>"`;
   - provider: `"Kiểm tra hạn mức/đăng nhập provider rồi retry"`;
   - rework: `"Xem dossier rework; tách task hoặc làm rõ tiêu chí rồi retry"`;
   - verification: `"Chạy lại verification sau khi sửa môi trường"`.
   `parkTask` trả `parked: false` thì không upsert; lần pass sau thử lại.
3. **Host:**
   - Gọi `autoParkPass` trong `executeHostWatchdogPass`, ngay sau `resumeRecoverableRuns`, chỉ khi phiên Director và policy `enabled`.
   - `upsertIssue` của port ghi qua `DirectorStore.upsertIssue`, idempotent theo khoá. Kiểm `IssueInput` có `key`; nếu chưa thì thêm.
   - Activity log `auto_park:<kind>`, không ghi lý do thô.
4. **Cấu hình:** `environment.issueQueue` parse strict:
   - `autoPark` là boolean, mặc định `true`;
   - `maxAutoResumesBeforePark` là số nguyên `0..3`, mặc định `3`; giá trị ngoài khoảng → lỗi config tiếng Việt `"issueQueue.maxAutoResumesBeforePark phải trong khoảng 0–3"`.
   Truyền qua `HostConfiguration.policy`.
5. **Test** (`auto-park.test.ts`, bảng cho `selectAutoParkCandidates` và tích hợp với fixture `director: true`):
   - Mỗi nguồn kích hoạt tạo đúng `kind`.
   - Mỗi điều kiện chặn loại ứng viên (`unknown_delivery`, user decision pending, execution chưa dừng, run hủy, `workflow-verification`).
   - `autoPark: false` thì không park.
   - `maxAutoResumesBeforePark: 0` park ngay khi escalate manual.
   - Upsert idempotent: chạy pass hai lần → một issue.
   - Phiên v2 → không bao giờ park.
6. **E2E bổ sung** (e17): DAG ba task A→B, C độc lập. Developer của A im lặng (fake) → nhắc → stall → hết ngân sách → auto-park A → C `succeeded`, B `pending` → run `completed_with_parked` → hộp thư có notice. `bflow queue retry` (gọi `director_issue_status retrying`) → A chạy lại, Developer fake trả kết quả → B → run `completed`.

---

## Kiểm chứng trước khi bàn giao mỗi lát con

```bash
pnpm check:deps
pnpm typecheck
pnpm test:affected --base main --run   # hợp đồng đổi nên selection lên full; khi đó integrator chạy pnpm test và pnpm test:e2e một lần
git diff --check
git status --short
```

Báo cáo: lệnh, mã thoát, số pass/fail/skip, HEAD đã test, diff theo ownership, migration (journal v8, codec aggregate 3, manifest v3), các giả định còn mở và các quyết định hợp đồng cần integrator duyệt (R-B2-3 PaneBinding v2 lồng trong v3; `DelegationRequest.requestedBy: "director"`; `TaskStatus` `parked` và intent `park`/`unpark`; `SdlcWorkStatus` `completed_with_parked`; `SessionLifecycleManager.attachProgress`).

## Rủi ro chính

| Rủi ro | Mức | Giảm thiểu |
| --- | --- | --- |
| Union `SessionManifest` lan kiểu ra nhiều package (pane-manager, runtime, cli, local-server) | Cao | Task 1 build toàn bộ; dùng narrowing `isDirectorSessionManifest`, không cast; giữ V2 nguyên vẹn |
| Một kiểu tin tới coordinator cần áp dụng khi nhận mà bị bỏ sót trong hộp thư | Cao | Bảng kiểu tin ở Task 3; kiểu chưa xếp loại → `failed` có lý do, không im lặng; E2E e17 |
| Park một task có execution chưa dừng chắc, hoặc delivery chưa chắc | Cao | Luật dừng như cancel ở cả Core lẫn Runtime; điều kiện chặn R-B2-16; test âm cho từng điều kiện |
| Pane tiến trình chạy lại vô hạn hoặc chạy lại khi chưa chắc | Trung bình | Kỷ luật receipt của `TaskLogPane`; giới hạn 5/10 phút; `launch_unknown` không chạy lại |
| `bflow approve` bị Director tự chạy | Trung bình (đã chấp nhận) | D-DIR-02; provenance `cli_owner` có `pid`/`tty` để audit; skill cấm |
| `completed_with_parked` bị coi như `completed` ở Web/CLI | Trung bình | Nhãn riêng; thuộc `TERMINAL_RUN_STATUSES` nhưng không thuộc `ENDED_RUN_STATUSES`; test |
