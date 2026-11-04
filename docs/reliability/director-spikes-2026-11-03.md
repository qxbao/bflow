# Director Agent — Spike Phase 0 (2026-11-03)

Kế hoạch: [Director Agent](../superpowers/plans/2026-11-03-director-agent.md). Spike chạy trong repo git tạm, ngoài cây dự án. Không sửa cấu hình provider thật của người dùng: Codex dùng `CODEX_HOME` riêng, Claude dùng `CLAUDE_CONFIG_DIR` riêng (chép credential), khi cần trust.

Phiên bản: Claude Code `2.1.317`, codex-cli `0.166.0`, agy `1.4.12`, Herdr `0.9.5`, Node `v24.16.0`, Linux.

**Giới hạn:** Codex hết hạn mức tài khoản (reset 2026-11-17) và Agy hết hạn mức (429, reset sau khoảng 116 giờ). Mọi ô "live" của hai provider này sau thời điểm đó là **CHƯA KIỂM**. Kết quả của Agy chỉ là bằng chứng tĩnh (chuỗi trong binary), không phải hành vi đo.

## Kết quả

| ID | Claude Code | Codex | Agy |
| --- | --- | --- | --- |
| S1 skill repo scope | **QUA** `.claude/skills/<n>/SKILL.md`, gọi `/spike-probe` ở `-p` [đo 2026-11-03: `claude -p "/spike-probe"` in đúng dòng của skill] | **QUA** `.agents/skills/<n>/SKILL.md` và cả `.codex/skills/<n>/` [đo 2026-11-03: `codex exec '$spike-probe'`, xoá lần lượt từng thư mục] | Tĩnh: `{workspace}/.agents/skills/{skill_name}/SKILL.md`. Live CHƯA KIỂM |
| S2 MCP repo scope | **QUA** `.mcp.json`; ở `-p` không hỏi phê duyệt. Bản tương tác cần `enabledMcpjsonServers` hoặc người bấm duyệt | **Chỉ khi repo đã trust**: `.codex/config.toml` bị bỏ qua khi chưa trust, nạp khi `projects."<repo>".trust_level="trusted"` [đo 2026-11-03: `codex mcp list` với `CODEX_HOME` riêng] | Tĩnh: `mcp_config.json` chỉ ở HOME/plugin; không thấy dạng repo scope (khớp nhận định trong `packages/agent-providers/src/agy-adapter.ts:61`) |
| S2 long-poll 300 s | **QUA** tool chặn 300,1 s trả về bình thường [đo 2026-11-03] | CHƯA KIỂM (hết hạn mức) | CHƯA KIỂM |
| S3 daemon tách rời từ tool shell | **QUA** `setsid nohup` từ tool Bash, daemon sống sau khi `claude -p` thoát, trả lời qua Unix socket [đo 2026-11-03]. Sandbox tùy chọn của Claude CHƯA KIỂM | CHƯA KIỂM (sandbox mặc định của `exec` có thể chặn socket) | CHƯA KIỂM |
| S4 xác thực principal không dựa vào pane | Thiết kế: dùng lại mẫu sẵn có, gồm tệp cấu hình vai 0600 chứa token + socket trong thư mục 0700 theo UID (`host.ts:376-386`, `host-controller.ts:254-259`). Kiểm bằng test Phase 2 | như trái | như trái |
| S5 chi phí ngữ cảnh | Hoãn sang Phase 8: đo bằng telemetry khi có run thật | | |
| S6 mở CLI tương tác với prompt khởi đầu | **QUA** `claude "/bflow-start"` vào thẳng skill khi repo đã trust. Repo chưa trust: hộp thoại trust hiện trước, người phải bấm một lần [đo 2026-11-03: pty] | CHƯA KIỂM | Tĩnh: `agy -i "<prompt>"` (`--prompt-interactive`) |
| S7 hook ghi tin người | **QUA** `UserPromptSubmit` trong `.claude/settings.json` của repo nhận `prompt` nguyên văn và `transcript_path` [đo 2026-11-03] | Có sự kiện `UserPromptSubmit` (thấy trong `hooks.json` cấp người dùng). Bản `.codex/hooks.json` của repo CHƯA KIỂM | Tĩnh: hook repo scope `<workspace>/.agents/hooks.json` (nạp sau khi trust folder), sự kiện `PreInvocation` có `transcriptPath` |

Phát hiện phụ: đường dẫn Unix socket dài hơn 108 byte trả `EINVAL`. Socket Director phải dùng thư mục ngắn đã có (`bflow-host-<uid>`), không đặt trong repo.

## Hệ quả cho thiết kế

1. **Kênh CLI là kênh chung, MCP là kênh tối ưu.** Agy không có MCP repo scope, còn Codex chỉ nạp MCP khi repo đã trust. Mọi tool Director phải có cả hai dạng: MCP `bflow` và lệnh `bflow director <tool> --json`. Skill dùng MCP khi có, nếu không thì gọi lệnh shell. Không ghi vào `~/.gemini` hay `~/.codex` để vá chỗ thiếu (bất biến V3).
2. **`director_wait` mặc định ngắn, cho phép dài.** Chỉ Claude được đo giữ 300 s. Mặc định `timeoutMs = 45_000` cho mọi provider, tối đa 300 s khi adapter khai báo hỗ trợ. Codex ghi `tool_timeout_sec` trong `.codex/config.toml` của repo. Agy (`timeoutSeconds`) khai khi S2 live qua.
3. **Trust là việc của người, một lần.** `bflow init` không ghi trust vào cấu hình người dùng. `bflow doctor` và `bflow start --json` báo `trust_required` kèm hướng dẫn cho từng provider. Hướng dẫn dùng `.claude/settings.local.json` với `enabledMcpjsonServers: ["bflow"]` (repo scope, gitignored) để bỏ bước duyệt MCP của Claude.
4. **Hook ghi tin:** Claude `.claude/settings.json` `UserPromptSubmit`; Codex `.codex/hooks.json` `UserPromptSubmit` (chờ kiểm live); Agy `.agents/hooks.json` `PreInvocation` (đọc tin cuối từ `transcriptPath`, chờ kiểm live). Hook luôn trả mã 0 và không bao giờ chặn.
5. **Đường dẫn skill:** Claude `.claude/skills/`; Codex và Agy dùng chung `.agents/skills/` (một bản cho hai provider).
6. **Bậc bằng chứng:** Claude là provider Director duy nhất có số đo. Bản phát hành đầu khai Codex/Agy Director là "nguồn + test cục bộ, chưa kiểm live" cho tới khi chạy lại S1–S7 sau ngày reset hạn mức.
