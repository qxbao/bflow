# ADR 0009 — Director Agent thay Conversation + Coordinator

- **Trạng thái:** Chấp nhận (chủ dự án duyệt D-DIR-01…05 ngày 2026-11-03; lệnh "cứ chạy đi" cùng ngày)
- **Người duyệt:** chủ dự án (dquanbao@gmail.com)
- **Liên quan:** [kế hoạch](../superpowers/plans/2026-11-03-director-agent.md), [spike](../reliability/director-spikes-2026-11-03.md), ADR 0003, ADR 0006/0007

## Bối cảnh

Luồng SDLC đầy đủ hay hỏng ở chặng giữa hai vai LLM thường trực: Conversation và Coordinator, nối nhau qua Herdr. Các lỗi gồm hiển thị notice, model bỏ qua tool quyết định, khởi động lạnh MCP, hộp thoại trust, và watchdog khi manifest chưa đủ.

## Quyết định

1. Một agent **Director** chạy trong CLI của người dùng (Claude Code, Codex, Agy; terminal hoặc IDE), mở bằng skill `bflow-start`. Director không phải pane Herdr. Phiên làm việc bắt đầu khi Director được mở.
2. Host Runtime tất định vẫn sở hữu Herdr, scheduler, lease/fencing, gate, journal. Director là client của host qua principal `director`, xác thực bằng token phiên. Director không phải một `AgentRole`.
3. Director có toàn quyền mặt phẳng điều khiển. "Không tự sửa mã" chỉ là quy tắc của prompt, không có hook chặn (D-DIR-01). Runtime không có tool phê duyệt hay ghi evidence cho Director. Phê duyệt chỉ đến từ Web hoặc lệnh `bflow approve` người tự gõ (D-DIR-02).
4. Lỗi kẹt được đưa vào **hàng đợi lỗi** (`ParkedIssue`). Task độc lập vẫn chạy tiếp (D-DIR-03).
5. Chat Web là chat với Director trên một transcript thống nhất CLI + Web (D-DIR-04).
6. `bflow init` ghi skill, MCP và hook vào repo, đưa vào `.gitignore`, có receipt để gỡ (D-DIR-05).

## Hợp đồng và tương thích

- **Lát A (cộng thêm):** `packages/contracts/src/director.ts` thêm `DirectorSession`, `DirectorMessage`, `ParkedIssue`, `DirectorWaitResult`, `DirectorProgressSnapshot` (schema version 1). Không đổi schema nào đang có. `AGENT_ROLES` giữ nguyên.
- **Lát B trở đi:** `SessionManifest` v3 không có pane `conversation`/`coordination`; vai chuyên trách gửi tới `runtime`; `TaskStatus` `parked`; kết thúc `completed_with_parked`. Mỗi thay đổi này cần upcaster và fixture từ journal thật. Phiên v2 phải `bflow down` trước khi nâng cấp. Run v2 đang dở chỉ đọc được, không tiếp tục được trừ khi upcaster chứng minh trạng thái.
- Enum `conversation`/`coordinator` được giữ để đọc dữ liệu cũ, không tạo phiên mới bằng chúng.

## Agent bị ảnh hưởng

Runtime/Core (P19/P30), Pane Manager (P13), Conversation (P14, bị thay), CLI (P29), Web/Local Server, Skills (P28), `agents/**`.

## Hệ quả

Tích cực: bớt 2 pane LLM và một chặng LLM→LLM; luồng không treo vì một task. Tiêu cực: Web không còn trả lời tức thời khi Director vắng mặt; bằng chứng live mới có ở Claude, Codex và Agy còn chờ hạn mức.
