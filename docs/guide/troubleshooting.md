# Troubleshooting

Bắt đầu bằng `bflow status --json`, `bflow doctor --json` và Git status/worktrees.
Doctor có thể trả envelope `ok: true` nhưng exit 1 và `data.healthy: false`: report
đã tạo thành công nhưng có check lỗi. Status không có run ID báo environment;
`status <run-id>` hoặc filters truy vấn legacy workflow Runtime.

| Triệu chứng | Nguyên nhân / hướng xử lý |
| --- | --- |
| `Not a Git working repository` | Chọn checkout thật hoặc `git init` repo mới trước init |
| Invalid JSON trong config.yaml | Dùng JSON hợp lệ; parser không đọc YAML thụt lề/comment/tag |
| Config belongs to another repository | Không copy identity; xem recovery cho clone/moved checkout |
| Role không phải permanent P13 role | Dùng contract names đúng; Developer phải được Runtime allocate |
| Custom executable/model config không được nhận | P12 chỉ hỗ trợ `{role, cli, required}`; model/provider thuộc Herdr hoặc P13 host API |
| Agent missing/blocked lúc up | Kiểm tra cài đặt/login CLI và PATH; đọc role/pane lỗi, không gửi lại assignment |
| Startup timeout / unresolved intent | Timeout không chứng minh chưa có side effect; reconcile server/manager trước |
| Named session exists without ownership evidence | Không adopt/xóa session đó; kiểm tra đúng checkout và manifest |
| Lifecycle lock tồn tại | Chứng minh owner process đã exit trước khi xử lý stale lock |
| Down thiếu shutdown barrier | Default composition còn giới hạn; `--yes` không bypass được |
| Up pass nhưng không nhận workflow qua chat | Chưa có provider/host P19 bootstrap/tool/ingress; up chỉ quản lý môi trường |
| Đổi SDD/TDD/maxIterations trong config không đổi workflow | P12 chưa tự wire các policy đó vào P19; host phải truyền đúng API |
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
