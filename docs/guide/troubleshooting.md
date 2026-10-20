# Troubleshooting

Bắt đầu bằng `bflow status --json`, `bflow doctor --json` và Git status/worktrees.
Doctor có thể trả envelope `ok: true` nhưng exit 1 và `data.healthy: false`: report
đã tạo thành công nhưng có check lỗi. Status không có run ID báo environment;
`status <run-id>` hoặc filters truy vấn legacy workflow Runtime.

| Triệu chứng | Nguyên nhân / hướng xử lý |
| --- | --- |
| `Not a Git working repository` | Chọn checkout thật hoặc `git init` repo mới trước init |
| Invalid YAML trong config.yml | Kiểm tra indentation, duplicate key và đúng một document. Tags, merge keys và alias vòng bị từ chối. Với file cũ, chạy `bflow config-migrate`; giữ `.bak` nếu cần rollback |
| Config belongs to another repository | Không copy identity; xem recovery cho clone/moved checkout |
| Role không phải permanent P13 role | Dùng contract names đúng; Developer phải được Runtime allocate |
| Model/effort bị preflight chặn | Chọn model phù hợp account/provider; Claude dùng `low|medium|high|xhigh|max`, Codex dùng `minimal|low|medium|high|xhigh`. Agy đặt mức effort trong tên model và không có trường `effort` |
| Agent missing/blocked lúc up | Lỗi chứa role, provider, pane/session và hướng xử lý. `pane read` nếu cần xem UI nhưng tránh chia sẻ raw output có secret; resolve dialog trước retry, không gửi lại assignment |
| `bflow up` thất bại sau khi bắt đầu startup | Up thử cleanup bằng safe down. Nếu cleanup không an toàn hoặc không hoàn tất, thông báo giữ operation receipt/recovery state; đọc `status`/`doctor`, xử lý nguyên nhân rồi chạy `bflow down --yes` để reconcile. Không xoá `.bflow` |
| Ctrl+C trong lúc up / startup timeout | Up thử safe cleanup nếu startup đã đổi session. Nếu delivery còn uncertain hoặc barrier chặn cleanup, state/receipt được giữ. Đọc `status`/`doctor`, rồi `bflow down --yes` để reconcile. Không xóa `.bflow` |
| Named session exists without ownership evidence | Không adopt/xóa session đó; kiểm tra đúng checkout và manifest |
| Legacy lifecycle lock từ phiên bản cũ | Dừng lệnh up/down cũ trước, rồi `bflow recover --yes`. Chỉ thư mục lock cũ rỗng được loại bỏ; state, worktree và agent không bị xóa |
| Another up/down is still running | Kernel lock vẫn có owner thật. Đợi hoặc Ctrl+C lệnh đó; không xóa file `lifecycle.guard` vì có thể phá serialisation |
| `spawn flock ENOENT` | Cài util-linux và bảo đảm `flock` có trên PATH; lifecycle lock cần executable này trên Linux |
| Codex hỏi Update CLI / trust / login | Lỗi mới nêu role, pane và session. Mở đúng session bằng lệnh được gợi ý, giải quyết dialog thủ công rồi `bflow up`. Bflow không tự accept update/trust/permission |
| Interrupted shutdown | Chạy lại `bflow down --yes`; nó quan sát pane nào còn sống, drain/checkpoint lại và chỉ đóng phần còn lại |
| Down thiếu shutdown barrier | Kiểm tra custom host/module; default Claude host có barrier thật, --yes không bypass drain/checkpoint |
| Up pass nhưng không nhận workflow qua chat | Kiểm tra host log, native session, MCP/hooks, manifest đúng phiên bản; kiểm tra owner-configured verification runner nếu là behavioral work |
| Đổi policy sau khi host tồn tại | Host từ chối đổi policy âm thầm; down/quiesce và reconcile persistent host config trước thay đổi |
| Role `done` nhưng run chưa thành công | Đợi correlated authenticated result, verification và approval; done chỉ là turn end |
| Test command fail trước Red | Cài dependencies/kiểm tra command tồn tại; infrastructure failure không phải target-behavior Red |
| ArtifactStore Unix socket test lỗi path dài | Trên Linux dùng `TMPDIR=/tmp` cho fixture/test; không đổi contract hoặc bỏ kiểm tra |
| Herdr báo `local socket name length exceeds capacity of sun_path` | Kiểm tra độ dài XDG runtime/config paths. Một test riêng đã pass với XDG directories ngắn, private dưới `/tmp`; giữ nguyên lựa chọn đó cho mọi command của cùng session. Đừng đổi routing directory khi session đang sống |
| Package subprocess test import dist cũ | Chạy `pnpm build` lại trước targeted tests |
| pnpm install trong example không cài dependency example | Ví dụ không thuộc root workspace; copy ra repo riêng hoặc dùng `pnpm install --ignore-workspace --frozen-lockfile` |

Herdr release label khác không tự chứng minh incompatibility. Up/adapter kiểm tra
wire contract và từng operation; chỉ báo incompatibility khi có response/operation
không tương thích thật. Không thêm version bypass hoặc allowlist release vào config.

`unknown_delivery`, pending verification hay conflict cần host/operator reconcile;
không đổi status trực tiếp trong SQLite/JSON, tự ký receipt hoặc force-delete worktree.
Giữ run/message/task IDs, exit code và evidence đã sanitize khi báo lỗi. Không gửi
private key, toàn bộ env, credential hoặc raw prompt có bí mật.

P02-RA01 (large runner timeout overflow) và P03-RA01 (late ArtifactStore get chunk
sau deadline/abort) vẫn là follow-up P2 đã biết, không được đợt tài liệu này sửa.

## Prompt và bố cục

Chat và Coordinator được nạp nguyên prompt gốc từ assets của Bflow trước turn đầu.
Không chỉ gửi một yêu cầu để agent tự đi đọc prompt. Claude dùng prompt-file native;
Codex dùng `model_instructions_file` ([OpenAI configuration reference](https://developers.openai.com/codex/config-reference)).
File bắt buộc thiếu, quá lớn hoặc symlink sẽ chặn khởi tạo với đường dẫn lỗi.
Native host bổ sung tool/policy instructions sau prompt gốc; không có fallback
im lặng cho Chat/Coordinator. Những pane đang sống từ bản cũ không bị reset mất
memory. Dùng shutdown/restart an toàn khi muốn tạo phiên mới với prompt mới.

Pane có nhãn vai trò rõ ràng; tab đầu được đặt tên conversation thay vì 1.
Phiên mới dùng Coordination 2x2 và Verification hai pane. Reconcile phiên cũ chỉ
resize các boundary để chia diện tích đều, giữ nguyên pane ID và process; không
dùng layout.apply vì operation đó tạo terminal mới trên Herdr đã thử. Nếu có
pane do operator thêm vào tab thì Bflow giữ layout đó.

## Lỗi thường gặp khi khởi động

- **`The machine Gateway is bound to workspace ...`**: Gateway của máy đang gắn với repository khác. Chạy
  `bflow setup --apply --yes --dir <repo hiện tại>`.
- **`Repository trust confirmation is waiting for your choice`**: Claude đang hỏi tin cậy repository ở pane.
  Chọn trong pane (`bflow attach` hoặc lệnh `herdr` được in kèm), hoặc đặt `environment.permissions.trustedWorkspace: true`.
- **`No supported test runner detected`**: Runtime không nhận ra runner. `node --test` được nhận cả khi có cờ
  `--experimental-strip-types` / `--disable-warning=<tên>` đứng trước `--test`; vitest cần là 2.x và đã cài ở root.
  Việc đo hành vi cần Linux với `bwrap` hoặc macOS với `sandbox-exec`.
- **Gateway lặp lại crash khi khởi động (macOS/Linux)**: chạy
  `node apps/cli/dist/setup-gateway.js --serve ~/.config/bflow/setup-gateway.json <digest>` ở foreground để thấy lỗi.
