# Lifecycle, readiness, layout và prompt startup — 2026-10-16

Baseline: `8991f22ddd218c81f6ac052e87a1025a033ded9b`.
Runtime source kiểm thử: `4273bc96f33c65f592efcfda02ada259b49500cd`.
Full validation HEAD: `c2e47b3c640bf143cc46e54420adba9168cb4376`; khác runtime
source chỉ ở integration test đồng bộ handoff Reviewer, không đổi production code.
Đây là sửa lỗi vận hành sau nghiệm thu P22, không nâng kết luận thành full Agentic
SDLC MVP v2 hoặc production-ready.

## Kết quả theo lỗi người dùng

| Lỗi | Nguyên nhân xác nhận | Hành vi sau sửa |
| --- | --- | --- |
| Ctrl+C khi up rồi up/down kẹt | mkdir lifecycle.lock sống lâu hơn process; guards từ chối mọi phase chưa hoàn tất | Kernel flock tự nhả khi process chết; SIGINT/SIGTERM đi qua AbortSignal và cleanup; partial manifest/launch intent được giữ để up reconcile hoặc down shutdown có kiểm tra |
| Lock cũ từ bản trước | Thư mục lock cũ không có process owner đáng tin cậy | `bflow recover --yes` sau khi dừng lệnh cũ chỉ bỏ lock rỗng; không recursively delete, không reset DB/config/pane/worktree |
| Down bị ngắt không chạy tiếp | Phase stopping bị từ chối dù P13 có thể reconcile từng pane đã đóng | Retry down vẫn drain/checkpoint, list pane hiện tại và chỉ đóng phần còn lại; server đã dừng vẫn phải drain/checkpoint retained host trước khi đóng host |
| Codex update/trust/login báo agent_not_ready chung chung | Trả nguyên JSON stderr của Herdr, không phân loại UI hoặc nêu hướng xử lý | Lỗi có role, provider, pane/session, reason và lệnh mở đúng session; snapshot chỉ dùng phân loại, không echo raw output/secret và không tự chấp nhận dialog |
| Chat/tab tên 1, pane khó nhận diện | Tab mặc định được tái sử dụng mà không rename; pane chưa có label vai trò | Rename conversation tab và mọi role pane; Conversation vẫn là attach target |
| Agent bị ép thành cột hẹp | Liên tục split cùng pane theo một hướng | Topology mới split cân bằng 2x2; topology cũ resize boundary theo số leaf, giữ pane IDs và PID; không đụng layout nếu có pane do operator thêm |
| Chat/Coordinator thiếu personality gốc | Chat chỉ dùng prompt rút gọn; Coordinator có fallback im lặng; bare P13 launch không inject role prompt | Nạp nguyên assets system-prompt.md trước turn đầu, dùng native prompt-file cho Claude/Codex; thiếu/symlink/oversize prompt thì fail rõ ràng; giữ thêm host policy instructions |
| Native startup receipt đến trễ | Herdr có thể báo ready trước SessionStart hook và native binding receipt ghi xong | P13 chỉ enrich session chưa có của launch đã ghi intent; không rewrite bound session. CLI đợi authenticated startup receipts có deadline và giữ context role/pane nếu timeout |
| Shell snapshot chưa đủ dữ liệu khi restart | Protocol 22 cho phép process_info chỉ có pane_id trong lúc shell khởi tạo; parser cũ coi foreground_processes thiếu là malformed | Phân biệt pending snapshot với foreground rỗng; poll tối đa 40 lần × 50 ms, không coi pending là ready và vẫn chặn foreground đang bận |

## Bằng chứng thực

- SIGINT/SIGKILL thực trên process giữ lifecycle lock: lệnh khác bị chặn khi owner
  sống, chạy được sau owner chết, guard inode giữ nguyên, sentinel giữ nguyên.
  Test có forced GC để FileHandle không mất authority khi callback đang await.
- Native CLI/Herdr probe: interrupted up exit **130**, startup receipt và config
  còn nguyên; resume đủ **7 role/7 pane riêng**, mọi pane có nhãn, Coordination
  **2x2**. Up/status/down/restart-up/restart-down exit 0, đúng named server dừng,
  Git HEAD giữ nguyên và private copied credentials được xóa. Không gửi model task.
- Native reflow probe: sửa layout 4 cột bị lệch thành diện tích đều; cả 4 shell PID
  và pane ID giữ nguyên. Không dùng `layout.apply`: phép thử riêng xác nhận operation
  đó tạo terminal thay thế trên Herdr đã cài.
- Chat/Coordinator native launch files chứa nguyên prompt gốc. Hai print-mode
  Claude persona probes nhận diện đúng Conversation/Technical Lead và giới hạn
  quyền; caps **0.08 USD/lượt**, provider báo tổng **0.0600528 USD**. Đây là standalone
  persona smoke, không phải Bflow multi-model workflow hay human delivery approval.
- Codex file configuration dùng `model_instructions_file`, theo
  [OpenAI configuration reference](https://developers.openai.com/codex/config-reference).
  Local CLI xác nhận file thiếu bị từ chối. `debug prompt-input` không phải dump base
  instructions nên không dùng việc không thấy base text trong output đó làm PASS/FAIL
  cho model behavior. Không chạy Codex generation trong đợt này.

## Validation

Linux, Node `24.16.0`, pnpm `12.5.1`, Git `2.43.0`, installed Herdr `0.9.5`
(protocol 22). Fixtures đặt trên POSIX `/tmp`, `TMPDIR=/tmp`, tối đa 4 Vitest forks.
Herdr compatibility dựa vào protocol/schema và operation thực, không allowlist
release label.

| Kiểm tra | Kết quả / exit code |
| --- | --- |
| `pnpm build` | PASS / 0 |
| `pnpm check:deps` | PASS / 0 |
| `pnpm typecheck` | PASS / 0 |
| `pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit` | PASS / 0 |
| `pnpm test` — unit + integration | **1403 PASS / 3 SKIP**, 67 files PASS / 0 |
| `pnpm run test:e2e --reporter=json …` | **63 PASS**, không skip / 0 |
| Native Herdr selected tests, `BFLOW_TEST_LIVE_HERDR=1 BFLOW_LIVE_HERDR=1` | **2 PASS**, không skip / 0 |
| `git diff --check` | PASS / 0 |
| Distribution probe trên `c2e47b3` — offline install, CLI, imports, packaged prompts | PASS / 0 |
| Native interrupt/resume/restart probe trên `4273bc9` | **15/15 checks PASS** / 0 |

Ba skips trong full suite là ba live suites opt-in: CLI native lifecycle, native
receipt transport và provider launch. Hai native suites đầu được chạy riêng với
cờ opt-in ở trên; provider persona probes có bằng chứng riêng, không suy ra rằng
provider-live suite đã chạy.

Targeted regression ở vòng trước: 7 files / 116 tests PASS. Sau sửa pending-shell
snapshot: 5 files / 101 tests PASS. Vòng native cuối trước sửa từng thất bại tại
restart-up vì snapshot thiếu; giữ kết quả đó riêng trong `before-4273bc9/`, không
tính làm bằng chứng PASS cho source cuối. Raw command/HEAD/exit/time/env và probe
results được lưu tại
`/home/baodq/.local/share/bflow/release-evidence/2026-10-16-lifecycle-startup-ux/`.
Lượt full suite đầu trên source cuối gặp ENOSPC ở /tmp cùng các lỗi deadline/
assertion thời gian: 1393 PASS / 10 FAIL / 3 SKIP; giữ nguyên log trong
`4273bc9-enospc-round/`. Chỉ dọn các bản CLI/provider tạm của chính các probe,
không đổi source để che lỗi. Lượt kế tiếp trên cùng source: 1402 PASS / 1 FAIL /
3 SKIP; lỗi còn lại là polling deadline 2.5 giây ở test Reviewer, qua khi chạy
riêng. Giữ log trong `4273bc9-reviewer-poll-round/`. Sửa test để chờ transport
receipt, rồi inspect durable accepted state khi background tick vẫn đang chờ
Reviewer và gửi verdict qua inbound. Giữ nguyên timeout/runtime production;
không thay assertion kết quả và không tăng polling timeout. Kết quả full suite
sau sửa test được ghi trong bảng Validation.
Full suite gồm integration cases; E2E fixture suite không được tính là live AI SDLC.

CLI `EnvironmentLifecycle.down()` có thể trả `EnvironmentStatus` khi startup chưa
từng có manifest; embedded consumers cần narrow kết quả. Không đổi lifecycle
contract đã freeze trong `@bflow/contracts`.

Không đổi `@bflow/contracts`, root manifest/lockfile, schema migration hoặc business
approval policy. Không push/publish/deploy hoặc autoapprove update/trust dialogs.
State/project của người dùng chỉ được đọc để triage, không reset hay stop các pane
đang có. Project người dùng lưu config Codex; người dùng xác nhận chạy bằng
`node .../bin.js`. Vì vậy sau local integration cần build lại checkout main; không
tự thay executable/alias hoặc tự đổi provider.

## Hướng xử lý trên bản mới

Người dùng gọi CLI bằng `node /đường/dẫn/Bflow/apps/cli/dist/bin.js`; thay `bflow`
bên dưới bằng lệnh đó.

```sh
bflow status
bflow doctor
bflow up
# Muốn dừng hoặc reconcile startup chưa đủ receipt:
bflow down --yes
# Chỉ dành cho lock thư mục từ phiên bản cũ, sau khi dừng lệnh cũ:
bflow recover --yes
```

Đối với dialog update/trust/login, dùng đúng lệnh `herdr --session ... session
attach ...` và pane được error nêu ra, xử lý thủ công rồi `bflow up`. Không xóa
`.bflow`, không sửa JSON/SQLite để giả readiness, không force-kill session khác.
Giữ nguyên file lifecycle.guard; kernel lock, không phải sự tồn tại của file,
quyết định một command có đang chạy hay không.

Các phiên đang sống từ bản cũ không bị reset để thay prompt và làm mất memory.
Để tạo phiên mới nhận bootstrap đầy đủ, dùng down/up qua các barrier bình thường.
Default P19 host vẫn chỉ có native Claude integration đã xác minh; P13 có native
Codex prompt-file support nhưng không được suy ra rằng full Codex P19/tool isolation
đã nghiệm thu. Không tự đổi config Codex của user sang Claude. POSIX/private-file
requirements và các giới hạn trong known-limitations vẫn giữ nguyên.
