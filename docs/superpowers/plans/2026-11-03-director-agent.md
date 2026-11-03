# Bflow Director Agent — Khảo sát khả thi và kế hoạch triển khai

> **Trạng thái:** chưa triển khai. Chủ dự án đã chốt D-DIR-01…D-DIR-05 ngày 2026-11-03 (xem mục 3). Còn chờ kết quả spike Phase 0 và ADR 0009 trước khi mở nhánh. Mọi thay đổi `packages/contracts/**`, `AGENTS.md`, `docs/**` cần ADR và phê duyệt của chủ dự án theo `AGENTS.md`.

**Mục tiêu:** Gộp Conversation + Coordinator thành một agent **Director** chạy trong CLI của người dùng (Claude Code / Codex / Agy, terminal hoặc IDE extension), được gọi bằng skill `bflow-start`. Director tự khởi động host Runtime + Herdr, điều khiển toàn bộ luồng, gom lỗi vào hàng đợi để người dùng xử lý sau, trong khi các nhánh việc không liên quan tiếp tục chạy. Herdr chỉ còn các pane chuyên trách và một pane tiến trình (không LLM). Thay đổi đồng bộ trên CLI, Web và Web 3D.

**Mốc khảo sát:** `main` tại `7ab17117`, ngày 2026-11-03. Tham chiếu ngoài: kit `ai-sdlc` tại `/mnt/01DCE9A4D6522BD0/Project/AI/skill_ai/speckit/runmethod/ai-sdlc`.

| Ký hiệu | Nghĩa |
| --- | --- |
| **[V]** | Đã xác minh từ mã nguồn |
| **[S]** | Suy luận kỹ thuật, chưa đo |
| **[P]** | Đề xuất cần phê duyệt |
| **[K]** | Phải spike/đo trước khi cam kết |

---

## 1. Kết luận khả thi

**Khả thi, với một điều chỉnh quan trọng về mô hình:** Director là *bộ não phán đoán*, không phải *tiến trình điều phối*. Host Runtime (daemon Node, tất định) vẫn phải là thứ sở hữu Herdr, scheduler, lease/fencing, cổng chất lượng và journal. Lý do:

1. **Phiên CLI của LLM theo lượt và có thể bị đóng.** Khi người dùng đang gõ, khi Director hết lượt, khi đóng terminal hay IDE, không có gì "thông luồng" nếu cơ chế thông luồng nằm trong LLM. **[S]**
2. **Herdr không được là tiến trình con của CLI agent.** Đóng CLI hay sandbox của provider sẽ giết Herdr và mọi pane. `bflow up` hiện đã tách daemon nền (`apps/cli/src/environment.ts:722`, `mode: "background"`). **[V]**
3. **Bất biến của dự án vẫn áp dụng:** gate độc lập, quyền phê duyệt của người, `done` của Herdr không phải thành công. "Full quyền" chỉ có nghĩa là toàn quyền trên **mặt phẳng điều khiển** của Runtime, không phải quyền vượt cổng. **[V]** `AGENTS.md` (V3 invariants)

Vì vậy kiến trúc đích là:

```
CLI người dùng (Claude Code | Codex | Agy, terminal hoặc IDE)
  └─ skill bflow-start  ──►  Director (LLM, nằm NGOÀI Herdr)
         │  MCP stdio "bflow" (principal = director, token phiên)
         ▼
  bflow host daemon (tất định, nền, tự khởi động nếu chưa chạy)
    ├─ Runtime: DAG, lease/fence, gate, journal, hàng đợi lỗi, auto-park
    └─ Herdr session
         ├─ tab "progress": pane bflow progress --follow (KHÔNG LLM)
         └─ pane chuyên trách: planner/architect/specifier/developer-N/reviewer/qa…
  Web / Web 3D: đọc cùng projection, thao tác qua lệnh có cấu trúc
```

**Lợi ích kỳ vọng [S]:** bỏ hai pane LLM thường trực và một chặng LLM→LLM (`DelegationRequest` qua Herdr). Phần lớn lỗi vặt gần đây nằm đúng ở chặng này: hiển thị notice cho Conversation (display-ack, watchdog), Conversation bỏ qua tool quyết định (Stop-hook), `read_updates`, khởi động lạnh MCP của hai vai thường trực, hộp thoại trust, watchdog dereference `manifest!.conversationSessionId` (`docs/reliability/systemic-fault-model.md:79`).

**Chi phí:** thay đổi hợp đồng công khai (vai, manifest, profile), thay luồng xác thực vai dựa trên pane, viết lại tầng Conversation của Web. Ước lượng: lớn, khoảng 8 phase, có thể giao song song từ phase 3.

---

## 2. Hiện trạng đã xác minh

| Hạng mục | Hiện trạng | Dẫn chứng |
| --- | --- | --- |
| Vai | `AGENT_ROLES` gồm `conversation`, `coordinator` và 8 vai chuyên trách | `packages/contracts/src/agent-roles.ts:3` **[V]** |
| Ràng buộc hợp đồng | `requiresDedicatedPane: z.literal(true)`; chỉ `conversation` được `userFacing` và gửi tới `user`; vai chuyên trách chỉ gửi tới `coordinator`/`runtime` | `packages/contracts/src/session.ts:44-100` **[V]** |
| Tool Coordinator | 20 tool (`inspect`, `assess`, `propose_workflow`, `request_specialist`, `tick`, `reconcile_delivery`, `retry_verification`, `resume_run`, `cancel`, `repository_setup`…) qua `CoordinatorTools.invoke` | `packages/runtime/src/agentic/tools.ts:20-42` **[V]** |
| Xác thực tool | MCP stdio `host.js mcp` bắt buộc `HERDR_PANE_ID`, gửi `role_call` kèm `launchId` và token vai qua socket host | `packages/runtime/src/agentic/host.ts:3266` **[V]** |
| Quyết định người | Vai chuyên trách → `request_user_decision` → Runtime → Conversation | `AGENTS.md` (P30) **[V]** |
| Skill | Render vào thư mục state phiên, không vào repo; `bflow init` không ghi `.claude/skills` hay `.agents/skills` | `packages/runtime/src/platform/skills-session.ts:146` **[V]** |
| Web | Chat, decisions, office 3D đều giả định vai `conversation`/`coordinator` | `apps/web/src/features/office/model/derive.ts:7`, `seats.ts:9` **[V]** |
| Quy mô ảnh hưởng | Số tệp nguồn nhắc literal `conversation`/`coordinator`: contracts 8, runtime 31, conversation 7, pane-manager 4, agent-providers 5, cli 14, web 8 | `grep` tại `7ab17117` **[V]** |

**Tham chiếu `ai-sdlc` [V]:**
- `status-panel --follow`: lõi thuần `runtime/dispatch/core/status_panel.py` vẽ STATUS · NEXT FOR YOU · TO REVIEW · REPLIES vừa khung pane, bỏ dòng ưu tiên thấp khi pane thấp; vỏ IO chỉ đọc đĩa. Đây là mẫu cho pane tiến trình.
- `progress --follow`: "đang ở đâu" theo task · vai · trạng thái · % wave · task kẹt lâu nhất, không cần Herdr.
- DLQ xả cuối run; người chỉ bị ngắt ở hai chỗ (nghiệp vụ chưa rõ → `Q-NNNN`; hành động không hoàn tác được); còn lại là `Ruling` trong ledger append-only. Đây là mẫu cho hàng đợi lỗi.
- Skill người dùng ở `.claude/skills/` và bản sao y hệt ở `.codex/skills/`, có test canh hai bản khớp.

---

## 3. Quyết định cần duyệt

### D-DIR-01 — Ranh giới quyền của Director — **ĐÃ CHỐT**

Director có toàn quyền **mặt phẳng điều khiển** và **không** tự sửa mã. Quy tắc "không sửa mã" chỉ nằm trong **system prompt và skill**. Không thêm hook, sandbox, permission mode hay chặn tool ở tầng provider cho Director. Director chạy với quyền mà người dùng đã cấp cho CLI của họ.

| Được làm | Prompt yêu cầu không làm |
| --- | --- |
| Lập spec/DAG, giao việc, đổi vai/provider (theo chuỗi failover đã duyệt), retry, reconcile, park/unpark task, bỏ qua task không chặn, cắt nhánh DAG, hủy, mở task sửa lỗi cho Developer, chạy lệnh chẩn đoán | Tự sửa `src/**` (giao Developer), ghi evidence, tự coi gate là xanh, phê duyệt thay người, gửi lại khi `unknown_delivery` chưa được chứng minh `not_delivered` |

Hệ quả cần ghi rõ:
- Các ràng buộc **của Runtime** vẫn giữ nguyên vì chúng là logic host, không phải hook của Director: tool Director không có thao tác ghi evidence/approve, gate do host chạy, lease/fencing kiểm trước dispatch. Đây không phải giới hạn mới mà là cách Runtime đang hoạt động.
- Nếu Director vẫn sửa file trong repo gốc, Runtime phát hiện như mọi thay đổi ngoài luồng hiện nay (plan drift → `reresolve_execution_plan`). Không có cơ chế chặn trước.
- Test hành vi prompt (Phase 5) phải có ca "người bảo Director sửa nhanh một dòng" ⇒ Director mở task cho Developer.

### D-DIR-02 — Phê duyệt của người khi Director là LLM — **ĐÃ CHỐT** **[K]**

Hiện tại phê duyệt chỉ hợp lệ khi đến từ input người đã xác thực (pane vật lý hoặc Web). Trong CLI ngoài, host **không phân biệt được** người gõ hay LLM tự gọi tool. Chốt:

- Director chỉ **trình** thẻ phê duyệt (tool `present_approval`), không có tool `approve`.
- Người phê duyệt bằng một trong hai kênh ngoài LLM: nút trên Web, hoặc `! bflow approve <mã-thẻ>` gõ trong CLI (lệnh chạy trong shell của người, không qua model). Mã thẻ một lần, ghim revision.
- Claude `AskUserQuestion` chỉ dùng để *hỏi làm rõ*, không làm bằng chứng phê duyệt.

### D-DIR-03 — Hàng đợi lỗi (Issue Queue) và tự thông luồng — **ĐÃ CHỐT (theo yêu cầu gốc)**

Thêm khái niệm **park** vào Runtime: một task kẹt được chuyển sang trạng thái `parked` kèm hồ sơ (root-cause dossier đã có, finding, log, bước tái hiện). Task phụ thuộc nó bị khóa; task độc lập chạy tiếp. Run kết thúc ở trạng thái mới `completed_with_parked` thay vì treo.

Thông luồng chia hai tầng:
1. **Tầng tất định trong host (luôn chạy, kể cả khi Director vắng mặt):** watchdog đã có phát hiện vai im lặng/`E2BIG`/MCP rớt/lease hết hạn → áp chính sách: retry có giới hạn → failover provider đã duyệt → park. Không cần LLM.
2. **Tầng phán đoán của Director (khi phiên CLI đang mở):** đọc hàng đợi, chọn tách task, đổi cách tiếp cận, mở task sửa lỗi, hoặc để lại cho người.

Người xem/xử lý hàng đợi bằng `bflow queue list|show|retry|dismiss`, trang Web "Hàng đợi lỗi", bảng trong văn phòng 3D.

### D-DIR-04 — Chat trên Web và khởi tạo phiên — **ĐÃ CHỐT** **[K]**

**Phiên = Director.** Khởi tạo phiên nghĩa là mở một CLI provider và chạy skill `bflow-start`. Không còn khái niệm "dựng phiên rồi mới gắn chat" như `bflow up` hiện nay.

- **Từ CLI/IDE:** người tự mở Claude Code / Codex / Agy trong repo rồi gõ `/bflow-start`. Skill gọi `bflow start --json`. Lệnh này dựng hoặc nối lại daemon + Herdr + pane chuyên trách, rồi đăng ký Director.
- **Từ Web:** nút "Khởi động phiên" mở một cửa sổ terminal chạy CLI provider đã chọn với prompt khởi đầu là skill (ví dụ `claude "/bflow-start"`, `codex "$bflow-start"`, cú pháp Agy **[K]**), theo cùng cách `ai-sdlc open` mở terminal theo hệ điều hành. Không mở được terminal (SSH, không có màn hình) thì Web hiện đúng lệnh để người tự chạy. Web không tự chạy Director headless ở bản đầu.
- **`bflow up`** chỉ còn là lệnh nội bộ/chẩn đoán (dựng daemon không có Director) và được ghi rõ là không tạo phiên làm việc. `bflow attach` mở tab `progress`.
- **Chat Web = chat với Director.** Một cuộc hội thoại chung cho CLI và Web:
  - Tin người gửi từ Web vào inbox Director. `director_wait` trả tin này ngay (đánh thức long-poll), Director trả lời ở lượt đó.
  - Director gửi mọi câu trả lời cho người qua tool `director_say`. Host lưu transcript và đẩy qua SSE tới Web. Trong CLI người vẫn thấy văn bản như bình thường.
  - Tin người gõ trực tiếp trong CLI được chép sang transcript bằng hook `UserPromptSubmit` (Claude) hoặc hook tương đương của Codex/Agy **[K]**. Hook ở đây chỉ để **ghi lại**, không chặn gì (khớp D-DIR-01). Provider không có hook thì skill yêu cầu Director gọi `director_note_user_message`, và Web ghi chú "tin từ CLI có thể thiếu".
  - Web luôn hiện trạng thái Director: hoạt động / đang chờ sự kiện / vắng (heartbeat quá hạn, ví dụ CLI đã đóng). Khi vắng, ô chat vẫn gửi được nhưng hiện "Director sẽ đọc khi phiên được mở lại", kèm nút "Khởi động phiên".
- Thao tác có cấu trúc (phê duyệt, trả lời câu hỏi làm rõ, hủy, hàng đợi lỗi) vẫn đi thẳng vào Runtime, không qua model.

### D-DIR-05 — Tệp inject vào repo khi `bflow init` — **ĐÃ CHỐT** **[K]**

Ghi các tệp sau, kèm receipt để `bflow init --remove` gỡ đúng:

Đã cập nhật theo [spike 2026-11-03](../../reliability/director-spikes-2026-11-03.md):

| Provider | Skill | MCP repo scope | Hook ghi tin |
| --- | --- | --- | --- |
| Claude Code | `.claude/skills/bflow-start/SKILL.md` **[V đo]** | `.mcp.json` **[V đo]** + `.claude/settings.local.json` `enabledMcpjsonServers` | `.claude/settings.json` `UserPromptSubmit` **[V đo]** |
| Codex | `.agents/skills/bflow-start/SKILL.md` **[V đo]** | `.codex/config.toml`, chỉ nạp khi repo đã trust **[V đo]**; `default_tools_approval_mode="approve"`, `tool_timeout_sec` | `.codex/hooks.json` `UserPromptSubmit` **[K]** |
| Agy | `.agents/skills/` (chung với Codex) **[tĩnh]** | Không có repo scope **[tĩnh]** ⇒ dùng kênh `bflow director … --json` | `.agents/hooks.json` `PreInvocation` **[tĩnh]** |

**Kênh chung:** mọi tool Director có cả MCP lẫn lệnh `bflow director <tool> --json`, nên provider thiếu MCP repo scope vẫn chạy được.

Mặc định thêm các tệp này vào `.gitignore` (nội dung chứa đường dẫn máy). Tùy chọn `--commit-skills` cho nhóm muốn chia sẻ. Không đụng cấu hình provider cấp người dùng (bất biến V3).

---

## 4. Spike bắt buộc trước khi cam kết (Phase 0)

> **Đã chạy 2026-11-03**, xem [báo cáo](../../reliability/director-spikes-2026-11-03.md). Claude qua S1, S2, S3, S6, S7. Codex qua S1 và phần cấu hình của S2. Phần live của Codex và Agy bị chặn vì hết hạn mức tài khoản; chạy lại sau 2026-11-17. Không có spike nào đỏ đến mức phải đổi kiến trúc. Hai điều chỉnh đã đưa vào plan: kênh CLI chung và `director_wait` mặc định 45 s.

Mỗi spike tạo báo cáo ngắn trong `docs/reliability/` kèm `[đo YYYY-MM-DD: cách đo]`. Một spike đỏ có thể đổi thiết kế.

| ID | Câu hỏi | Tiêu chí qua |
| --- | --- | --- |
| S1 | Mỗi CLI (Claude Code, Codex, Agy) có tự nạp skill repo scope ở đâu, cả bản terminal và IDE extension? | Gõ `/bflow-start` (hoặc tương đương) chạy được ở cả 3, trong repo vừa init, không sửa cấu hình người dùng |
| S2 | MCP repo scope có được nạp và tin cậy tự động không? Một tool call chặn lâu (long-poll 5 phút) có bị cắt không? | Gọi `director_wait` 300 s thành công ở cả 3; ghi lại timeout thực đo |
| S3 | Từ trong sandbox mặc định của mỗi CLI, Director có khởi động được daemon tách rời + Herdr và kết nối Unix socket không? | `bflow start` từ tool Bash/shell của từng CLI tạo được daemon sống sót sau khi đóng CLI |
| S4 | Xác thực principal `director` không dựa vào pane: token phiên 0600 + kiểm UID + ràng buộc PID cha MCP? | Hai repo song song không gọi nhầm host; token cũ bị từ chối sau `stop` |
| S5 | Chi phí ngữ cảnh: một run trung bình đọc bao nhiêu token qua tool Director? | Có số đo, và chế độ compact/cursor giữ dưới ngân sách đề ra |
| S6 | Mở terminal chạy CLI + skill từ Web: cú pháp prompt khởi đầu của từng CLI (`claude "/bflow-start"`, Codex, Agy) và trình mở terminal theo hệ điều hành | Cả 3 CLI vào thẳng skill trên Linux; macOS/WSL ghi CHƯA KIỂM nếu chưa đo |
| S7 | Hook chép tin người gõ trong CLI (`UserPromptSubmit` của Claude, tương đương ở Codex/Agy) có chạy được ở cấu hình repo scope không | Tin gõ trong CLI xuất hiện trong transcript Web; ghi rõ provider nào không có |

---

## 5. Kế hoạch theo phase

Thứ tự bắt buộc: Phase 0 → 1 (khóa hợp đồng) → 2 (Runtime) → 3–6 song song → 7 → 8. Mỗi phase dùng một worktree riêng, theo quy tắc ownership trong `AGENTS.md`.

### Phase 1 — ADR 0009 và hợp đồng (owner: integration, cần chủ dự án duyệt)

- [ ] ADR `docs/adr/0009-director-agent.md`: động cơ, vai bị ảnh hưởng, kế hoạch tương thích, người duyệt.
- [ ] `AGENT_ROLES`: thêm `director`. **Giữ** `conversation`/`coordinator` trong enum để đọc journal/receipt cũ; cấm tạo phiên mới với hai vai này.
- [ ] `AgentRoleProfileSchema` v3: `requiresDedicatedPane` thành `boolean` (Director `false`); `director` là vai duy nhất `userFacing` ở phiên v3; vai chuyên trách gửi tới `director`/`runtime`.
- [ ] `SessionManifest` v3: không có pane `conversation`/`coordination`; thêm `progressPane` (không LLM) và `directorBinding` (token id, provider, pid, heartbeat).
- [ ] Mô hình hàng đợi: `TaskStatus` thêm `parked`; `ParkedIssue` (id, taskKey, phân loại, dossier `artifact://`, số lần thử, đề xuất); `RunStatus`/`SdlcWorkStatus` thêm kết thúc `completed_with_parked`.
- [ ] DTO web cộng thêm: `WebDirectorView`, `WebIssueQueueView` (không sửa `WebRunView`/`WebEvent`).
- [ ] Codec journal/checkpoint: phiên bản mới, upcaster đọc phiên cũ; từ chối tạo mới ở version cũ. Test fixture từ journal thật.

### Phase 2 — Runtime: Director facade và hàng đợi (owner: `packages/runtime/**`, `packages/core/**`)

- [ ] `DirectorTools` = hợp nhất `CoordinatorTools` + tool phía Conversation (`read_updates`, trình bày tiến độ, câu hỏi làm rõ). Bỏ `report_progress` sang Conversation (Director nói trực tiếp với người).
- [ ] Tool mới: `director_wait(cursor, timeoutMs)` long-poll trả lô sự kiện đã nén, gồm cả tin người gửi từ Web (đánh thức ngay); `director_say` (câu trả lời cho người, lưu transcript + SSE); `director_note_user_message` (fallback khi provider không có hook); `list_issues`, `inspect_issue`, `park_task`, `unpark_task`, `retry_issue`, `skip_task` (chỉ khi không có hạ nguồn bắt buộc), `present_approval`. Không có tool approve, không có tool ghi evidence.
- [ ] Transcript hội thoại Director thống nhất (CLI + Web), có cursor, giới hạn kích thước, redact như transcript hiện có.
- [ ] Ingress hook ghi tin người gõ trong CLI (chỉ ghi, không bao giờ chặn).
- [ ] Principal `director`: MCP stdio không cần `HERDR_PANE_ID`; xác thực bằng token phiên do `bflow start` cấp (tệp 0600 trong thư mục state riêng), kiểm UID, ràng buộc repo root. Một Director hoạt động tại một thời điểm (lease Director, có heartbeat; phiên thứ hai bị từ chối hoặc nhận quyền chỉ đọc).
- [ ] Định tuyến `request_user_decision`: Runtime → hàng đợi quyết định → Director (khi có mặt) + Web. Vắng Director thì chỉ task đó đứng chờ; task khác chạy tiếp.
- [ ] Chính sách auto-park tất định trong host: tái dùng watchdog, rework-causality, failover. Giới hạn retry có cấu hình, mặc định bảo thủ.
- [ ] Core: chuyển trạng thái hợp lệ cho `parked`, tính lại khả năng chạy của DAG, điều kiện kết thúc `completed_with_parked`. Property test cho "task độc lập không bị chặn bởi task park".
- [ ] Gỡ đường Conversation↔Coordinator khỏi host (`host-conversation.ts`, `conversation-*`, notice display-ack) sau khi Director facade qua test. Giữ code đọc journal cũ.

### Phase 3 — Pane Manager và pane tiến trình (owner: `packages/pane-manager/**`)

- [ ] Bố cục phiên v3: tab `progress` (một pane shell chạy `bflow progress --follow`), các tab chuyên trách giữ nguyên.
- [ ] Pane tiến trình không cần preflight provider, attestation hay MCP; restart tự động nếu chết.
- [ ] `bflow attach` mặc định vào tab `progress`.

### Phase 4 — CLI (owner: `apps/cli/**`)

- [ ] `bflow start [--provider <p>]`: lệnh do skill gọi, idempotent; nếu daemon chưa chạy thì dựng (preflight, Herdr, pane chuyên trách); cấp/đổi token Director; in JSON máy đọc được cho skill. `bflow stop` = `down` có xác nhận.
- [ ] `bflow open [--provider <p>]`: mở cửa sổ terminal chạy CLI provider với prompt `/bflow-start` (dùng chung với nút Web); không mở được thì in lệnh. `bflow up` đổi help thành "dựng daemon không có Director (chẩn đoán)".
- [ ] Hook ghi tin người (Claude `UserPromptSubmit`, tương đương Codex/Agy nếu S7 xác nhận) được `bflow init` cài ở repo scope cùng skill và MCP.
- [ ] `bflow progress [--follow] [--json]`: lõi thuần render (theo mẫu `status_panel.py`): RUN · ĐANG LÀM (vai, task, phút) · CẦN BẠN (phê duyệt > câu hỏi > hàng đợi lỗi) · HÀNG ĐỢI LỖI · DIRECTOR (có mặt/vắng, heartbeat). Co dãn theo kích thước pane, bỏ dòng ưu tiên thấp trước.
- [ ] `bflow queue list|show|retry|dismiss`, `bflow approve <mã>` (kênh phê duyệt ngoài LLM, D-DIR-02).
- [ ] `bflow init`: inject skill + MCP repo scope cho 3 provider (D-DIR-05), receipt, `--check`, `--remove`, `--update`; `doctor` có check `director-skill-installed` và `director-mcp-reachable`.
- [ ] Gỡ lệnh/tùy chọn phụ thuộc pane chat (`attach` vào Conversation, cấu hình provider cho `conversation`/`coordinator`); `config migration` đổi hai vai này thành `director`.

### Phase 5 — Skill và prompt (owner: `skills/**`, `packages/skills/**`, `agents/**`)

- [ ] `skills/core/bflow-start/SKILL.md`: kiểm `bflow` có trên PATH → `bflow start --json` → vòng lặp Director: nhận yêu cầu (CLI hoặc Web) → làm rõ → `assess`/`propose_workflow` → `director_wait` → xử lý sự kiện/hàng đợi/tin Web → trả lời người qua `director_say`. Dừng vòng khi người ngắt; khi không còn run chạy thì vẫn chờ tin Web với timeout dài để Web chat dùng được. Lưu ý quy ước: đường dẫn trong backtick bị coi là reference bắt buộc của bundle, nên viết dạng văn xuôi.
- [ ] Skill phụ: `bflow-status` (chỉ đọc), `bflow-queue` (xử lý hàng đợi lỗi).
- [ ] `agents/director/system-prompt.md`: hợp nhất `agents/chat` + `agents/coordinator`, bỏ phần chuyển tiếp lẫn nhau, thêm chính sách thông luồng và D-DIR-01. Quy tắc "không sửa mã, giao Developer" là ràng buộc **duy nhất** ở tầng prompt và phải viết rõ, có lý do. Giữ dưới ngân sách token. Test hành vi chuyển sang Director, có ca người yêu cầu sửa nhanh.
- [ ] Render provider-neutral: một nguồn, ba đích; test canh các bản sinh ra khớp nhau.

### Phase 6 — Web và Web 3D (owner: `apps/web/**`, `apps/local-server/**`)

- [ ] Local-server: route chỉ đọc `director` và `issues`; lệnh có cấu trúc `issue/retry`, `issue/dismiss`, `approval/decide` (đã có) không đi qua model.
- [ ] Local-server: route `director/messages` (gửi/đọc transcript, SSE), lệnh `session/open-director` gọi cùng logic với `bflow open`.
- [ ] Classic: nút "Khởi động phiên" mở CLI + skill (D-DIR-04), fallback hiện lệnh; thẻ trạng thái Director (hoạt động / đang chờ / vắng, lần cuối hoạt động); chat đổi thành chat với Director trên transcript thống nhất; trang "Hàng đợi lỗi"; bỏ phụ thuộc `conversationStatus`.
- [ ] 3D: thay ghế `conversation`/`coordinator` bằng bàn Director (đặt ở "phòng điều hành", trạng thái lấy từ heartbeat), thêm bảng hàng đợi lỗi tương tác mở panel Classic tương ứng. Cập nhật `PLACEHOLDER_ROLES`, `seats.ts`, `labels.ts`.
- [ ] Test kiến trúc: cảnh 3D vẫn không gọi API ghi.

### Phase 7 — Dọn dẹp và tương thích

- [ ] `packages/conversation/**`, `agents/chat/**`, `agents/coordinator/**`: chuyển phần còn dùng (phân loại intent, render tiếng Việt) vào Director hoặc runtime; xóa phần còn lại sau một bản phát hành chuyển tiếp.
- [ ] Nâng cấp: phiên v2 đang chạy phải `bflow down` trước; `bflow up` trên repo cũ in hướng dẫn `bflow init --update`. Run cũ đang dở được đọc (status/history), không tiếp tục bằng Director trừ khi upcaster chứng minh được trạng thái.
- [ ] Cập nhật `README.md`, `AGENTS.md`, `docs/architecture-v2.md` (thành v4), `docs/communication-protocol.md`, `docs/known-limitations-v3.md` (review-gated).

### Phase 8 — Kiểm chứng

- [ ] Unit/property: Core `parked`, Runtime Director facade, auth principal, render progress, init inject/remove.
- [ ] E2E fake-runner: run có một task bị park, các task độc lập vẫn `completed`, run kết thúc `completed_with_parked`; Director vắng mặt giữa run rồi quay lại.
- [ ] Live, tách bậc bằng chứng: (a) Director Claude Code + specialist Claude; (b) Director Codex; (c) Director Agy; (d) chạy từ IDE extension. Mỗi lần ghi run-id, phiên bản Herdr/provider. Fault campaign: kill pane Developer giữa lượt, `E2BIG`, MCP timeout, đóng CLI Director giữa run.
- [ ] Chạy đủ `pnpm check:deps`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` trước khi tích hợp (thay đổi hợp đồng nên selection sẽ lên `full`).

---

## 6. Rủi ro

| Rủi ro | Mức | Giảm thiểu |
| --- | --- | --- |
| CLI không nạp skill/MCP repo scope (nhất là Agy, IDE extension) | Cao | S1/S2; fallback: `bflow start` in sẵn lệnh MCP/skill để người thêm tay; khai "chưa hỗ trợ" thay vì giả vờ chạy |
| Director tự phê duyệt hoặc lách cổng | Cao | D-DIR-02: không có tool approve; phê duyệt chỉ qua Web hoặc lệnh shell của người |
| Director tự sửa mã dù prompt cấm (chủ ý không chặn ở hook, D-DIR-01) | Trung bình | Prompt rõ ràng + test hành vi; Runtime vẫn phát hiện drift ở repo gốc như hiện nay; thay đổi ngoài task không đi qua gate nên không được tính là kết quả task |
| Web chat không có trả lời khi CLI Director đóng hoặc đang bận lượt dài | Trung bình | Trạng thái Director hiện rõ trên Web; tin vào inbox, không mất; nút mở lại phiên |
| Transcript CLI thiếu tin người gõ ở provider không có hook | Thấp | S7; fallback `director_note_user_message`; Web ghi chú thiếu |
| Daemon/Herdr chết theo CLI hoặc bị sandbox chặn | Cao | S3; daemon tách phiên (setsid), Director chỉ là client |
| Hai Director cùng lúc (2 terminal, terminal + IDE) | Trung bình | Lease Director, phiên sau chỉ đọc |
| Ngữ cảnh Director phình do long-poll nhiều giờ | Trung bình | Sự kiện nén, cursor, `read_project_policy` dạng compact; skill hướng dẫn tóm tắt định kỳ |
| Park che giấu lỗi thật, run "xanh giả" | Trung bình | Trạng thái riêng `completed_with_parked`, không bao giờ hiển thị như `completed`; Web/progress luôn nêu số mục park |
| Phạm vi thay đổi hợp đồng lớn, journal cũ | Trung bình | Giữ enum cũ để đọc, upcaster có fixture thật, không tiếp tục run cũ khi chưa chứng minh |

---

## 7. Ngoài phạm vi

Đổi runtime chuyên trách sang headless ngoài Herdr; hosted/multi-host; chạy nhiều Director trên một repo; Director tự sửa mã; thay đổi chính sách SDD/TDD/verification.
