# Vòng đời môi trường của Bflow CLI (P12)

Khi session đang offline, `up` chuẩn bị và kiểm tra provider trước khi tạo Herdr
server mới. Nếu preflight từ chối, CLI giữ manifest/run cũ và trả lỗi provider;
không gọi shutdown barrier trên công việc chưa được activate. Các trường hợp
startup cũ chưa rõ delivery và session đang chạy vẫn phải reconciliation theo
receipt hiện có. Agy specialist đã có native hook/shim/binding trong source và local tests;
Conversation thiếu trusted human-input provenance và unattended vẫn unsupported.
Xem [trạng thái triển khai](../../docs/implementation-status.md).

Build từ root bằng `pnpm build`, gọi **`node apps/cli/dist/bin.js setup` một lần**,
rồi reload shell/mở terminal mới và dùng **`bflow <command>`**. Setup tạo managed
launcher/PATH; không cần tự thêm shell alias. [Installation](../../docs/guide/installation.md).
Cần Node >=22.13 và pnpm được pin ở root cho storage runtime hiện có.
Lifecycle cần `flock` trên PATH: Linux util-linux hoặc bản macOS có inherited-fd support.

Các subprocess trong vòng đời phiên nhận `DISABLE_AUTOUPDATER=1` ngay từ dependency/auth
checks, để Claude không tự đổi binary khi `up` đang chuẩn bị và activate các role.

`bflow up` kiểm tra native auth, cấu hình/quyền, MCP, startup receipt và activated health
mà không gửi ping/pong tới model. `bflow doctor` mặc định cũng không chạy model.
Dùng `bflow doctor --deep` khi muốn thử model thật: mỗi bộ provider/profile/model/effort
của các role bắt buộc được thử một lần; lệnh có thể tiêu hao usage. Deep diagnostics
không tạo pane/workflow và không thay thế các cổng readiness/verification của Runtime.
Không chạy kiểm tra sâu đồng nghĩa lỗi quota hoặc model không khả dụng có thể chỉ xuất hiện
ở tác vụ thật. Linked Codex cần endpoint catalog `GET /models` hoạt động để xác minh
quyền truy cập backend mà không inference; không tự quay lại probe tính phí khi endpoint lỗi.


## Thiết lập lần đầu

Từ một source checkout, chạy `pnpm build`, sau đó `node apps/cli/dist/bin.js setup`.
Setup xem trước machine plan và hỏi một lần trước khi áp dụng trong một terminal
tương tác. Dùng `setup --yes` để chấp thuận plan đó mà không cần prompt. `--check` và
`--dry-run` chỉ quan sát, không tạo thư mục, không đổi file shell và không cài
phần mềm. Một lần gọi không tương tác mà thiếu `--yes` sẽ báo thiếu phê duyệt
và thoát với trạng thái 1.

Việc cài đặt trên machine thuộc về tài khoản hiện tại và dùng chung giữa các repository;
`--dir` chọn ngữ cảnh repository mà không đặt các bản cài đặt machine vào thư mục
`.bflow` của nó. CLI cài một launcher `bflow` do Bflow sở hữu và quản lý mục PATH
của nó. Cấu hình shell sẵn có được giữ nguyên. Một shell cha đã mở không thể nhận
thay đổi môi trường từ process con; đầu ra giải thích cách nạp PATH được quản lý khi cần.

Setup mặc định dùng catalog tool đã được review, với phiên bản chính xác, cho nền tảng
được hỗ trợ: Herdr, Claude Code, Codex, Agy, RTK, GitNexus, Chrome DevTools MCP,
MemPalace, Superpowers. MemPalace được cài từ một PyPI wheel được pin checksum vào một
virtualenv do Bflow sở hữu (uv, hoặc python3 >= 3.9 làm phương án dự phòng) và được đăng ký với Gateway;
vị trí và cấu hình palace của bạn được giữ nguyên.
Các machine pin tường minh được bảo toàn. Đăng nhập provider vẫn là thao tác
tương tác của chủ tài khoản; cài một CLI không thiết lập xác thực. Các điều kiện
license của upstream được hiển thị trong chẩn đoán cài đặt.

Setup cấu hình MCP Gateway dùng chung như một service của người dùng hiện tại và xác minh
việc thương lượng MCP upstream cùng khám phá tool. Việc index GitNexus được giới hạn trong
Git repository đã chọn; ngoài một repository, việc cài đặt vẫn tiếp tục và index
bị hoãn đến khi chạy `bflow setup --dir <repository>`. Chrome dùng một profile Bflow
riêng. Các workflow role kết nối tới Gateway chạy nền qua bộ định vị riêng
`gateway-control.json` trong thư mục state của Gateway. `bflow up` truyền bộ định vị đó
cho host khi nó tồn tại; setup không thiết lập các kết nối role này.

Context7 hosted do setup tạo dùng chung giữa các repository/worktree trên cùng máy:
chuyển worktree rồi chạy `down`/`up` không cần rebind Gateway. Control endpoint chỉ
chia sẻ đúng dịch vụ Context7 đã được setup duyệt, vẫn kiểm tra machine, workspace
canonical, token và quyền từng role/session. GitNexus, Chrome và các backend cục bộ
vẫn giới hạn trong workspace đã setup; một repo khác cần setup riêng để sử dụng chúng.
Gateway đang chạy từ bản CLI cũ cần khởi động lại service do Bflow sở hữu sau khi build
bản sửa; `up` không tự sửa cấu hình machine hoặc khởi động lại Gateway dùng chung.

Chạy lại setup có thể thêm hoặc cập nhật cấu hình Gateway trong khi GitNexus reader của nó
đang hoạt động, khi `status --json` xác nhận index hiện hành. Việc rebuild một index cũ
vẫn yêu cầu quyền truy cập storage độc quyền; setup giữ nguyên lock reader hoặc writer đang bận.
Nếu việc rebuild đó bị chặn, receipt chỉ rõ lock được giữ lại và bước khởi động
Gateway bị chặn bởi phụ thuộc cấu hình MCP của nó. Doctor cuối cùng vẫn
báo setup chưa hoàn tất. Hãy nhả reader hoặc writer trong lúc bảo trì trước khi
chạy lại setup; setup không dừng một Gateway đang có và không thu hồi các lock được giữ.

Kết quả bao gồm receipt của mọi bước và báo cáo machine doctor cuối cùng.
Các bước đã áp dụng hiển thị trạng thái receipt thay vì nhãn chờ phê duyệt.
Áp dụng một phần, health check thất bại và thiếu phê duyệt đều trả về
exit status khác 0. Một dry run có thay đổi được lên kế hoạch vẫn là một bản xem trước thành công.

Các Codex global hook có luồng review riêng và không được `setup --yes` thông thường phê duyệt.
Dùng `bflow setup --codex-hooks --plan` hoặc `--check` để kiểm tra các hook,
lệnh, digest của file phụ thuộc và digest của snapshot hiện tại mà không
ghi trạng thái phê duyệt. `bflow setup --codex-hooks --apply` hiển thị bản kiểm kê đó
và hỏi phê duyệt tương tác. Phê duyệt không tương tác phải truyền cả
`--yes` và đúng `--hook-digest <sha256>` được in ra từ lần review hiện tại.
Phê duyệt snapshot gắn với Codex home và hook snapshot đã kiểm tra; mọi hook
hoặc phụ thuộc thay đổi đều cần review lại. Việc này chỉ cấp phê duyệt cho
các Codex hook đã kiểm tra; nó không mở rộng quyền của Bflow và không cung cấp OS sandbox. Bản
kiểm kê pin các script cục bộ trực tiếp và interpreter đã resolve, không pin các package
transitive tùy ý hay dữ liệu runtime; các dạng shell động không được hỗ trợ vẫn bị chặn.
Các nguồn plugin hook được bật tường minh được bao gồm khi bản cài đặt cục bộ của chúng
có thể resolve không mơ hồ. Review của setup và các lần launch của Runtime dùng cùng một
môi trường, với các selector pane Orca bên ngoài chỉ bị xóa cho các process con của Bflow.

Để tin cậy **mọi global hook hiện tại và tương lai** của Codex home đã chọn, kể cả
các hook/plugin mà Bflow không thể kiểm tra tĩnh, chạy:

```bash
bflow setup --codex-hooks --apply --trust-all --yes
```

Lệnh này lưu một chính sách operator riêng tư bên cạnh file snapshot receipt
(`codex-hook-approvals.policy.json`). Bản kiểm kê hook không còn chặn khởi động;
`--check` báo `approvalMode: trust_all` và nói rằng việc kiểm tra source bị bỏ qua.
Nó không sửa file hook/plugin hay cài đặt provider. Các kiểm tra hook, permission,
sandbox, auth và MCP bắt buộc của Bflow vẫn hoạt động. Chính sách được giới hạn trong
Codex home chuẩn tắc đã chọn và private approval store. Thu hồi bằng
`bflow setup --codex-hooks --apply --revoke-trust-all` để khôi phục việc review snapshot.
`--check`/`--plan` in cảnh báo, không chặn, khi Codex home, `hooks.json`
hoặc `config.toml` có quyền ghi cho group/world hoặc không thuộc sở hữu của người dùng hiện tại.

Sau khi publish manifest thành công, `up` có thể khởi động tối đa ba lần kiểm tra role của host
ở bước chuẩn bị trong khi các pane sau đó vẫn đang launch. Chỉ những binding khớp với launch ID và
fingerprint đã chuẩn bị hiện tại mới vào các kiểm tra này; binding đã lưu từ thế hệ trước phải chờ thay thế.
Nó chờ mọi role bắt buộc và lặp lại toàn bộ cổng health/attestation mới tại bước kích hoạt cuối cùng.
Chỉ model execution probe tương đương của Codex mới có thể tái dùng một quan sát thành công, tối đa 30 giây; các bằng chứng
native/tool/permission/skill và health của role được kiểm tra mới. Việc hủy và thất bại khi khởi động sẽ drain các kiểm tra đã bắt đầu
và các lần ghi daemon proof trước khi dọn dẹp, kể cả khi một role RPC bị ngắt kết nối. Các
kiểm tra cục bộ bổ sung làm tăng overhead, nên sự chồng lấp này không có đảm bảo độ trễ thực tế đã đo.

`up --timeout <ms>` điều khiển toàn bộ ngân sách khởi động, bao gồm cả bước chuẩn bị provider
của host. Lệnh gọi điều khiển host dùng phần deadline vòng đời còn lại thay vì
giới hạn 30 giây riêng. Việc hủy hoặc hết deadline ngăn việc tạo pane; việc dọn dẹp
drain phần chuẩn bị đang chờ trước khi thu hồi tài nguyên session.
Bước chuẩn bị hoàn tất trước khi CLI ghi nhận ý định dispatch pane. Một timeout
ở giai đoạn đó do đó có thể dùng host shutdown barrier mà không cần pane receipt.
Mỗi lần chờ khởi động agent native của Herdr bị giới hạn ở 300000ms và bị chặn bởi
deadline vòng đời còn lại, kể cả khi cấu hình repository cho phép session startup 600000ms.
Ngân sách launch không đủ sẽ fail tại chỗ trước khi dispatch. Lỗi khởi động
và kết quả tự động dọn dẹp được in ở các dòng riêng.
`down` mở lại host hiện có với platform và policy đã lưu của nó, ngay cả khi
cấu hình mong muốn đã thay đổi kể từ lúc khởi động.
Các lỗi sẵn sàng khi khởi động dành cho người dùng gom các nguyên nhân giống nhau theo provider, liệt kê các role bị ảnh hưởng
và các kiểm tra bị chặn một lần, đồng thời vẫn hiển thị các nguyên nhân khác nhau, role tùy chọn và kết quả dọn dẹp.
Lỗi hook trỏ tới lệnh hook plan chỉ đọc. Các bố cục báo cáo không nhận diện được giữ
nguyên chẩn đoán gốc. Việc làm sạch terminal, che credential và giới hạn đầu ra
(256 dòng / 64.000 ký tự) áp dụng trước và sau khi gom nhóm; JSON giữ nguyên toàn bộ báo cáo gốc.
Việc che credential cũng bao gồm các cờ command-line opaque, phép gán biến môi trường và các trường credential JSON,
kể cả giá trị có dấu nháy mà dấu nháy đóng bị thiếu trong đầu ra subprocess bị cắt ngắn.

| Lệnh | Hành vi |
| --- | --- |
| `bflow init [--provider claude\|codex\|agy]` | Tạo `.bflow/config.yml` và `.bflow/.gitignore` tại Git root chuẩn tắc. Provider mặc định là Codex. Chạy init lặp lại giữ nguyên cấu hình; `--force`/`--yes` tường minh sẽ thay thế. Không gọi Herdr. |
| `bflow config-migrate` | Xác thực một `.bflow/config.yaml` hoặc `.bflow/config.json` cũ, ghi `.bflow/config.yml`, lưu các byte gốc thành `<legacy-path>.bak`, rồi xóa file cũ đang hoạt động. Nguồn hoặc đích xung đột sẽ fail mà không ghi đè. |
| `bflow setup --codex-hooks --plan\|--check\|--apply` | Kiểm tra Codex home đã chọn và chỉ review các global hook. Plan/check chỉ đọc; apply yêu cầu một quyết định tương tác hoặc `--yes --hook-digest <sha256>`. Không bao giờ cài tool hay service. |
| `bflow up [--timeout <ms>]` | Kiểm tra executable, xác thực provider và protocol Herdr; khởi động một server có tên, chuẩn bị persistent P19 host cùng platform readiness (từ chối khởi động pane khi một role bắt buộc bị chặn), rồi gọi P13. Chờ mọi role bắt buộc và xác nhận kích hoạt host trước khi ghi nhận ready. Lưu các binding đã xác thực và tái dùng các role đang sống. |
| `bflow attach` | Yêu cầu một manifest sẵn có và một session khớp đang chạy. Gọi P13 để focus/xác thực Conversation, rồi chạy `herdr session attach <name>` với terminal I/O được kế thừa. |
| `bflow down [--yes] [--force] [--timeout <ms>]` | Kiểm tra các run đang hoạt động và file dirty. Quiesce intake/dispatch của Runtime, thu thập lại các run và yêu cầu aggregate checkpoint bền vững. Shutdown thông thường gọi dọn dẹp graceful của P13. `--force` bao gồm xác nhận và chỉ dừng trực tiếp session có tên do repository sở hữu, cho phép khôi phục khi tra cứu pane/workspace bị kẹt. Không xóa worktree, database, artifact, commit hay source file nào. |
| `bflow status` | Báo cáo cấu hình, server có tên, pane/agent và executable bị thiếu. Gắn nhãn các quan sát đã lưu là có thể đã cũ. Không mở workflow Runtime cũ. |
| `bflow recover --yes` | Sau khi dừng các lệnh CLI cũ, chỉ migrate một lifecycle lock cũ rỗng. Giữ nguyên state, pane, source và worktree. |
| `bflow doctor` | Báo cáo các phụ thuộc Node/Git/pnpm/Herdr/agent, cấu hình/định danh, quyền, lifecycle lock và các phát hiện doctor của P13. Trả về exit 1 khi có check thất bại. |

Nếu một lần shutdown bị gián đoạn chặn cả `down` thông thường và `up`, chạy
`bflow down --force`, rồi `bflow up`. Force dùng ownership manifest đã lưu và được xác thực,
bỏ qua việc tra cứu/đóng pane trực tiếp và xác minh rằng server Herdr có tên
đã dừng trước khi hoàn tất `down`. Runtime barrier hoặc ghi checkpoint thất bại
vẫn là lỗi. Timeout giữ lại trạng thái `stopping` để đối soát; force không bao giờ
có nghĩa là xóa `.bflow` hay tuyên bố các workflow task đang hoạt động là thành công.

Mọi lệnh đều hỗ trợ `--json`. Timeout tính bằng mili giây, 1–600000. `doctor` trả về
báo cáo chẩn đoán ngay cả khi không khỏe; `ok: true` của JSON envelope nghĩa là
báo cáo đã được tạo, còn `data.healthy` và exit code cho biết sức khỏe môi trường.
Khi manifest đã ở trạng thái `down`, doctor báo session đã dừng và không coi các bản ghi
pane `cancelled` do cleanup là lỗi readiness hiện tại. Pane lỗi trong session đang hoạt động
và các trạng thái lỗi khác vẫn được báo; session đã dừng không chứng minh workflow thành công.
`status` tương tự trả về exit 1 khi cấu hình không hợp lệ. `status <run-id>` hoặc
các bộ lọc status giữ nguyên các lệnh workflow-run hiện có. Các
`.bflow/config.yaml` và `.bflow/config.json` tường minh hiện có vẫn đọc được để tương thích khi
`.bflow/config.yml` không tồn tại. Chạy `bflow config-migrate` để chuyển một config cũ
sang đường dẫn chuẩn tắc. `bflow init` sẽ giữ nguyên và từ chối một file cũ cho đến khi
nó được migrate.

Cấu hình dùng YAML 1.2 block style thông thường kèm chú thích. Các agent role nằm
ở đầu file; đặt `cli`, `model` tùy chọn và `effort` tùy chọn của từng role tại đó.
Bỏ `model` thì dùng mặc định của provider. `effort` chấp nhận `minimal`, `low`,
`medium`, `high`, `xhigh` hoặc `max`, tùy theo hỗ trợ của provider đã chọn;
Agy mã hóa effort trong tên model và do đó từ chối `effort` riêng.
Các giá trị mặc định bao phủ workflow hiện có, phê duyệt SDD, conditional TDD, bounded
verification và concurrency. Phần composition mặc định truyền các policy này cho
persistent P19 host; P12 không triển khai logic Coordinator hay workflow policy.
Khóa trùng lặp, nhiều document, khóa mapping không phải chuỗi, tag tường minh,
merge key và alias vòng hoặc quá mức đều bị từ chối. Một config được sao chép/di chuyển sang
checkout khác sẽ fail xác thực định danh thay vì gắn vào repository gốc. Một
Config mặc định có entry `developer` với provider đã chọn khi init và `required: false`.
Entry này là mẫu khởi chạy động trong worktree của task, không tạo pane thường trực khi
`bflow up`. Có thể đặt CLI/model/effort/profile riêng cho Developer. Nếu bỏ entry này,
Developer kế thừa provider, model, effort và profile của Coordinator.

Định danh session là `bf-` cộng 20 ký tự hex của SHA-256 trên
checkout root chuẩn tắc và thư mục Git tuyệt đối. Do đó các repository có basename giống nhau
vẫn được cô lập; các linked worktree có định danh riêng. Các lệnh Herdr
nhận `HERDR_SESSION` một cách tường minh. `HERDR_SOCKET`, pane, remote
và các ngữ cảnh caller khác được kế thừa sẽ bị loại bỏ. Bflow không dựng hay
quản lý đường dẫn socket nào. `HERDR_CONFIG_PATH` tường minh được giữ lại.

## Trình bày đầu ra CLI, tiến trình và xử lý lỗi

### Thứ tự ưu tiên màu và phân giải stream
Bflow CLI định dạng đầu ra terminal cho người dùng bằng một presentation engine riêng, không phụ thuộc bên ngoài. Khả năng hiển thị màu được phân giải độc lập cho `stdout` và `stderr`:
1. **Tùy chọn tường minh**: Được tôn trọng khi được cung cấp qua `CliContext.presentation` hoặc các tùy chọn formatter.
2. **`NO_COLOR`**: Khi không có tùy chọn tường minh, `NO_COLOR` không rỗng sẽ tắt màu, ghi đè `FORCE_COLOR`.
3. **`FORCE_COLOR="0"`**: Tắt màu.
4. **`FORCE_COLOR` (khác 0)**: Các giá trị khác 0 tường minh bật màu, kể cả qua các stream piped (`isTTY: false`).
5. **Phát hiện terminal**: Nếu không, màu được bật khi stream đích có `isTTY: true` và `TERM !== "dumb"`.
6. **JSON có cấu trúc**: Khi truyền `--json` hoặc `-j`, đầu ra được đảm bảo là JSON tất định thuần túy với không có mã ANSI escape nào.
7. **Custom I/O Collector**: Các `io` collector do caller cung cấp (ví dụ trong bộ test hoặc nhúng theo chương trình) mặc định dùng đầu ra thuần, không tương tác trừ khi chủ động chọn qua `context.presentation`.

### Tiến trình quan sát theo thời gian thực
- Các lệnh vòng đời và chạy lâu (bao gồm `status`, `doctor`, yêu cầu tài liệu và review hook) stream tiến trình theo thời gian thực chỉ tới `stderr` tương tác của người dùng.
- Các bước tiến trình dùng marker tuần tự `[1]`, `[2]`, … (cyan đậm khi màu đang bật). Tóm tắt plan của setup và cả hai formatter lệnh cấp cao dùng cùng bố cục đánh số và nhãn thành phần dễ đọc.
- Bản xem trước phê duyệt và dry-run của setup gom các skill bundle định địa chỉ theo nội dung theo thư mục store và số lượng. Các đích khác giữ tên thư mục và file của chúng, kể cả các thay đổi repository; phê duyệt, nâng quyền, cờ nền tảng bị chặn, hành động thủ công và bản xem trước lệnh vẫn hiển thị. `bflow setup --plan --json` bao gồm toàn bộ bản kiểm kê `data.preview` với mọi bundle digest và đường dẫn đích chính xác.
- `skills sync` dùng cùng cách gom đích. Các lệnh cấp cao hiển thị định danh có nhãn và kết luận dễ đọc; các check tool/provider/backend đặt chẩn đoán và hướng dẫn khắc phục ở các dòng riêng. Kiểm kê rỗng được nêu tường minh. Định dạng cho người dùng không đổi kết luận JSON, exit code hay yêu cầu phê duyệt.
- Các quan sát process thông thường cập nhật một dòng tạm thời thay vì tích lũy log vĩnh viễn. Lỗi, cảnh báo, bước bị chặn và chẩn đoán quan trọng vẫn hiển thị; tham số lệnh và đầu ra thô của provider bị loại khỏi các quan sát process.
- Việc kiểm tra các tool pin, MCP backend và Git worktree được liệt kê hiển thị thanh theo số lượng (ví dụ `[##----] 1/3`). Số lượng nghĩa là số đơn vị đã kiểm tra, bao gồm cả quan sát âm tính; chúng không bao giờ chứng minh readiness hay thành công. Các lần chờ provider/network/verification dùng hoạt ảnh không xác định, không có phần trăm ước lượng.
- Trước mọi bước xác nhận, hoạt ảnh dừng trong khi caller hiển thị đúng bản xem trước phê duyệt hiện có và đọc input. Các quan sát thông thường đến muộn bị giới hạn ở 50 cái mới nhất; chẩn đoán quan trọng được giữ riêng. Bộ đếm thời gian và các dòng có thể thay đổi được xóa trước đầu ra cuối cùng hoặc lỗi, và hoạt ảnh vẫn bị tắt trong lúc Herdr attach.
- Pipe, JSON, help/version và các custom collector mặc định vẫn tĩnh. Embedder có thể cung cấp `CliIo.progress` cho các dòng tạm thời và `CliIo.stderrRaw` cho các chunk hoạt ảnh thô khi chủ động chọn trình bày tương tác.
- Báo cáo tiến trình hoàn toàn mang tính thông tin (chỉ phát các chuyển giai đoạn đang diễn ra) và không bao giờ phát các tuyên bố thành công kết luận quá sớm (ví dụ `Environment ready` hoặc `Environment stopped`). Thành công kết luận chỉ được báo bởi các formatter của lệnh sau khi các thao tác nền, lưu trạng thái và dọn dẹp tài nguyên thành công.
- `FORCE_COLOR` không bao giờ bật stream tiến trình; tiến trình đòi hỏi nghiêm ngặt một stream `stderr` tương tác (`isTTY: true && TERM !== "dumb"`).
- Lệnh help và version không bao giờ phát tiến trình.
- Đầu ra cuối cùng cho người dùng mở đầu bằng kết quả nghiệp vụ và hành động tiếp theo. Command ID thông thường, exit code dạng số, các bước nội bộ thành công, tọa độ pane/process, các doctor check lặp lại và chi tiết kiểm kê khỏe mạnh được giữ trong JSON. Run/task ID, khóa uncertain-delivery, phạm vi phê duyệt, tiêu chí/bằng chứng verification thất bại và hướng dẫn khắc phục cảnh báo/lỗi vẫn hiển thị.
- Doctor hiển thị một báo cáo gom nhóm với số lượng healthy/skipped và các check có thể hành động; status báo cáo quan sát live so với đã lưu mà không tuyên bố readiness từ tính hợp lệ của cấu hình. Verification escalation kêu gọi human review thay vì một vòng tự động khác. Lỗi tài liệu đưa ra hướng dẫn riêng cho credential, phiên bản, thư viện, quyền truy cập, mạng và rate limit.

### Định dạng lỗi có thể hành động
Đầu ra lỗi cho người dùng theo một định dạng có giới hạn, có thể hành động:
```text
Error [<code>]: <concise bounded explanation>
Details: <safe scalar details: stage, role, provider, paneId, sessionId, workspaceRoot, taskId, runId>
Next: <specific actionable next step>
```
- **Làm sạch & che thông tin (Sanitization & Redaction)**: Mọi trường động cho người dùng đều được loại bỏ ANSI escape, ký tự điều khiển C0 (kể cả carriage return `\r`) và chuỗi điều khiển C1 (`\u0080`–`\u009F`). Văn bản động bị giới hạn để chống tràn terminal/subprocess dump, và được tự động che các token nhạy cảm (`ghp_*`, `gho_*`, `ghu_*`, `ghs_*`, `ghr_*`, `sk-*`, `sk-ant-*`, Bearer token, JWT, khóa riêng PEM PKCS#8 / theo thuật toán chung, mật khẩu và API key).
- **JSON được xử lý giữ nguyên**: Các JSON envelope đọc được bằng máy (`--json`) giữ chính xác chi tiết lỗi và cấu trúc dữ liệu chưa bị che để tích hợp với công cụ.
- **Quyền sở hữu envelope duy nhất**: Các lỗi runtime bất ngờ và lỗi đóng vòng đời được xác thực theo `ContractErrorSchema` và phát trong một envelope có thẩm quyền duy nhất, tránh đầu ra mâu thuẫn.

### Tính trung thực của status và shutdown
- `formatDownOutput` thực thi nghiêm ngặt rằng trạng thái môi trường chỉ cho phép tuyên bố `[OK] Environment stopped` khi process server Herdr được xác nhận đã dừng (`server: "stopped"`). Một server đang chạy với manifest thiếu hoặc `down` không bao giờ được báo là đã dừng. Với session manifest, yêu cầu `status: "down"`.

### Hạn chế của Interactive Attach
`bflow attach` focus pane Conversation và gọi interactive terminal attach của Herdr (`herdr session attach <name>`).
- **Hạn chế**: Trong khi `attach --json` trả về error envelope khi thất bại không tương tác, một phiên interactive attach kế thừa các stream I/O chuẩn của TUI tương tác Herdr và không thể cung cấp một stream JSON thuần headless, an toàn với pipe trong lúc đang attach.
- Khi thoát session, CLI cho người dùng báo trung thực `[OK] Returned from Conversation attach.`.

## Kết hợp host mặc định và topology vật lý

P13 is composed automatically through `PaneManagerLifecycleAdapter`. It adapts
`initializeTopology` / `reconcileTopology` to lifecycle `up`,
`focusConversationPane` to `attach`, and `inspectTopologyHealth` followed by
schema-validated manifest reads to `getManifest` / `doctorSession`.
Before P13 starts roles, the default integration prepares the persistent Runtime
host and obtains trusted role prompts, MCP configuration and provider lifecycle
hooks. Readiness is not keyed to a provider name: the host's provider preflight
reports `ready`, `blocked` or `unsupported` per role with the adapter's reason, and
`up` returns that report before any pane is created when a required role is not
ready. Roles prepared with a v3 launch profile start with their provider's launch
arguments; hosts without one fall back to the legacy Claude/Codex prompt injection.
`bflow up` sends the machine-scoped platform options (machine, repository, role
providers, permission modes, skill pins, the builtin skill store and the Gateway
locator when present) to the host, and it never reads or prints launch environment
values. The host
survives CLI process exit and owns scheduling, authenticated message ingress, run
queries and shutdown checkpoints. `doctor` and environment `status` inspect
topology without starting a daemon. `up` and `doctor` check `codex login status`,
Claude's structured `auth status`, or Agy's read-only `models` command. Agy has no
`auth status` or `auth login` subcommand; complete its login flow by running `agy`
interactively. A successful Agy check requires a returned model list, while network,
policy and authentication failures remain distinct. The host still verifies actual
execution readiness before launching roles; model access alone is not readiness.
The CLI does not print provider account diagnostics or infer authentication from an idle pane. First-use provider trust prompts can still block
startup and require operator action in that named session. An interactive startup
conflict keeps the owned session, exact pane and launch receipt available: resolve
the reported dialog, then rerun `bflow up` to reconcile the same agent. It does not
report readiness or answer the dialog automatically. Use `bflow down --yes` to
stop that pending startup explicitly.

P13 nhận một argv runner chọn tường minh session có tên của repository này. Không có
môi trường process toàn cục nào bị thay đổi. Tên CLI của role phải là các loại Herdr
agent được hỗ trợ có trong PATH; đường dẫn executable tùy chỉnh và các Developer role động
không thể được cấu hình thành permanent role.

Adapter dùng `FileSessionManifestStore` dưới `.bflow/state/panes/` thay vì
store in-memory mặc định của P13. Nó xác thực định danh repository ở cả lần đọc
và ghi. P13 sở hữu toàn bộ logic tạo workspace/tab/pane, khởi động agent và khôi phục.
CLI không bao giờ bịa ID vật lý. Cả CLI và P13 được build qua project reference
TypeScript của CLI; không cần module composition thủ công cho
`up`, `attach`, `status` hay `doctor`.

Shutdown dùng intake/dispatch barrier thật của host, các truy vấn có thẩm quyền `findRuns`
và `getRun` cùng aggregate checkpoint đã lưu. `shutdownTopology` của P13
chỉ đóng các pane đã ghi nhận sau khi các barrier đó thành công, rồi CLI chỉ dừng
session Herdr có tên của repository và dừng host một cách tường minh. Không dùng
barrier no-op hay checkpoint giả. Lifecycle seam cục bộ dùng các contract
`CreateCheckpointCommand` và `RecoveryCheckpoint` hiện có.

Embedder truyền `CliContext.environment.integration` hoặc `openIntegration(input)`.
Để ghi đè composition P13 mặc định trong executable, operator có thể đặt `BFLOW_ENVIRONMENT_MODULE` là đường dẫn tuyệt đối tới một
module ESM export:

```ts
export async function openBflowEnvironment({ repository, config, env }) {
  // Compose real P13 and Runtime implementations here.
  return {
    manager, // SessionLifecycleManager, configured for repository.sessionName/root
    runtime, // Pick<RuntimeService, "findRuns" | "getRun">; authoritative repository run queries
    quiesce, // (OperationOptions) => OperationResult<void>
    checkpoint, // (CreateCheckpointCommand, OperationOptions) => OperationResult<RecoveryCheckpoint>
    activate, // optional; acknowledge host startup after the role manifest is up
    shutdownHost, // optional; stop host after checkpoints/panes/session are preserved
    close // optional; closes composition handles, never stops the live session
  };
}
```

`quiesce` phải dừng intake/dispatch và drain các lần ghi state đang chạy cho **mọi**
run của repository. `checkpoint` phải lưu aggregate có thẩm quyền, bao gồm
trạng thái phê duyệt, hủy và khôi phục, trước khi trả về receipt. Trả về
một snapshot chưa được lưu là không đủ. Các kiểm tra schema/định danh/phiên bản/sequence
chạy tại ingress. Factory chỉ được chọn qua môi trường của operator,
không bao giờ qua cấu hình repository.

Doctor report của physical adapter chỉ mô tả topology; một pane khỏe không
chứng minh một SDLC run đã passed. Một tích hợp tùy chỉnh thiếu các thao tác shutdown
Runtime có thẩm quyền vẫn bị bảo vệ, kể cả với `--yes`. Provider hook,
role tool và bằng chứng workflow cần được xác minh live riêng. Không có tuyên bố SDLC
end-to-end đầy đủ nào suy ra từ các kiểm tra vòng đời.

## Khôi phục và xác minh

Runtime state nằm dưới `.bflow/state/`, với `session.json`
và `operation.json` được thay thế nguyên tử. Manifest có thẩm quyền của P13 là
`.bflow/state/panes/<session>.manifest.json`; `session.json` của CLI là quan sát
đã xác thực gần nhất của nó. Manifest của một session đang hoạt động được làm mới qua kiểm tra health
của P13 trước các quyết định status/readiness. Một kernel `flock` bền vững
trên `lifecycle.guard` tuần tự hóa up/down/recover và được nhả khi Ctrl+C, SIGKILL hoặc
crash. Không bao giờ xóa inode guard này. Một thư mục `lifecycle.lock` cũ rỗng
yêu cầu `bflow recover --yes` tường minh sau khi dừng các lệnh CLI cũ; nội dung không liên quan
không bao giờ bị xóa đệ quy. Việc chuyển giao khởi động hoặc shutdown role/server
chưa được giải quyết được giữ lại. Một lần khởi động đang chờ có thể tiếp tục qua
P13 chỉ khi topology receipt vật lý đã xác thực của nó tồn tại; thiếu receipt
vẫn cấm gửi lại. Một lần khởi động đầu tiên dở dang có thể được shutdown bằng
chính receipt đó, với các Runtime barrier thông thường. Một role bị chặn vẫn khả dụng để
kiểm tra và được ghi nhận là degraded. Không dùng kill cưỡng bức tự động khi
shutdown timeout. Các đảm bảo này nhắm tới filesystem cục bộ và các process cùng người dùng
hợp tác; khôi phục sau mất điện và vận hành đa host chưa được xác minh.

Log relay tách rời của headless server ghi một log riêng tư mode-0600. Nó
đệm các dòng hoàn chỉnh qua các chunk trước khi che, chặn các khóa riêng PEM nhiều dòng
và loại bỏ các dòng log quá lớn. Các log cục bộ này là chẩn đoán,
không phải bằng chứng task thành công đáng tin cậy.

Từ thư mục gốc của repository:

```sh
pnpm build
pnpm --filter @bflow/cli test
BFLOW_TEST_LIVE_HERDR=1 pnpm exec vitest run apps/cli/test/environment-live.test.ts
pnpm check:deps
pnpm typecheck
pnpm test
git diff --check
git status --short
```

Các fake-runner test bao phủ tên repository giống nhau, định danh canonical/symlink,
init/up lặp lại, attach-before-up, role bị chặn/thiếu, launch thất bại, mơ hồ khi
chuyển giao do timeout, tranh chấp lock, manifest/attach target lạ,
xác nhận/checkpoint/graceful shutdown và selective stop. Các test bổ sung
thực thi class và file store P13 thật qua một Herdr process runner giả có trạng thái:
topology bảy role, lưu trữ xuyên các lần gọi CLI, ngăn trùng lặp,
thay đổi health live, focus Conversation, manifest lạ, session env có phạm vi,
khởi động bị chặn, chẩn đoán unresolved-delivery, hủy và thiếu Runtime shutdown API. Live
test opt-in tạo hai headless session có tên được cô lập với một thư mục gốc cấu hình XDG tạm thời ngắn,
xác minh protocol 22, dừng một session trong khi session kia tiếp tục chạy,
và dừng cả hai trước khi xóa dữ liệu test. Nó không bao giờ khởi động agent hay mở TUI.

Herdr 0.9.0 được quan sát là hỗ trợ `HERDR_SESSION`, `herdr server`,
`status server --json`, protocol 22/schema 1 và `session stop <name> --json`.
Các đường dẫn XDG/profile dài có thể vượt giới hạn đường dẫn Unix-socket của Linux. Bflow đưa ra
lỗi của Herdr; operator có thể chọn `XDG_CONFIG_HOME` ngắn hơn một cách nhất quán
cho môi trường của mình. Bflow không đoán hay chuyển hướng đường dẫn socket.

Runtime tự phát hiện các adapter JS/TS, Python, Go, Rust, JVM, .NET, Ruby, PHP và CTest
cho tiêu chí `unit_test`, `integration_test` và `e2e_test`, với label và quy tắc tên test
trong `planning_reference`. Thiếu runner/reporter của hệ sinh thái đã nhận diện được trả
về Coordinator để tạo setup task có review; phát hiện được làm mới khi revision thay đổi.
Owner vẫn có thể dùng `.bflow/verification.json` làm ghi đè Node TAP/Vitest tùy chọn.
Executable và argv do Runtime quyết định, kết quả từng test có cấu trúc là bắt buộc.
Phép đo yêu cầu sandbox: Linux Bubblewrap hoặc macOS Seatbelt cho các runner JS/owner
được hỗ trợ. Mount/cache/report của adapter native và làm ấm dependency còn giới hạn Linux.
Không có fallback chạy ngoài sandbox. Xem [ma trận và giới hạn verification](../../docs/verification-runners.md).

Chat/Coordinator nạp đầy đủ các prompt gốc đã cài trước lượt đầu tiên.
Claude dùng một prompt file cục bộ theo launch; các file launch của Codex dùng
`model_instructions_file` native. Asset thiếu hoặc không an toàn sẽ fail rõ ràng. Các pane hiện có
được giữ nguyên cho đến khi có một lần restart có kiểm tra tường minh; không reset hội thoại ngầm.
Khởi động native chờ các SessionStart receipt đã xác thực trong deadline của lệnh.
Một provider bị chặn báo role, provider, pane/session chính xác và
hướng dẫn khắc phục thủ công mà không trả về đầu ra terminal thô hay chấp nhận dialog.

## Các lệnh Agentic SDLC cấp cao (P29)

Đường binary dùng parser/handler trong `src/high-level/index.ts`; cú pháp được đối chiếu tại
[CLI reference](COMMAND_REFERENCE.md) và [parser-backed reference](docs/command-reference.md).
`HighLevelCliFacade` là đường API/programmatic kế thừa: không dùng các flag của facade hoặc
static help cũ để suy ra binary nhận cùng cú pháp. Các lệnh chuẩn bị dữ liệu/request;
Runtime vẫn sở hữu dispatch, lease/fence, scheduler, quality gates và human approvals.

Với `--json`, high-level commands xuất `{ok, command, exitCode, result}`; `result` là
`CommandExecutionResult` v3, `result.output` có outcome/steps riêng. Exit code 0–7 có nghĩa
đã ghi trong reference, không áp đồng loạt cho lifecycle/iso/docs. Command `succeeded`
không chứng minh task/run thành công. Repo mutation receipts ở `.bflow/state/cli/commands/`;
`skills sync` giữ receipt machine-scoped. Interrupted mutation cần reconcile/`--resume`
ở những lệnh parser hỗ trợ, không blindly resend.

| Lệnh | Hành vi và cú pháp chính |
| --- | --- |
| `bflow repo inspect` | Đọc Git/project context từ cwd; không có `--dir`/`--include-files`/`--max-files` |
| `bflow task plan --spec <file>` | Preview task graph; `--workflow` kiểm tra traceability; `--write [--out <file>] [--force]` lưu plan |
| `bflow task implement <task-id> --run <id> --spec <file>` | Validate spec/artifact/TDD, chuẩn bị worktree và assignment request; không start agent |
| `bflow verify <task-id> --run <id> --plan <file>` | Independent gates; `--change-set`, `--repair`, `--integration`; thiếu runner là blocked |
| `bflow git prepare <run-id> [--task <id>] [--yes] [--resume]` | Preview rồi dedicated integration branch + workflow-verification request; không merge main/push/PR |
| `bflow mcp status [--service <id>]` | Đọc MCP config/pins; live health cần `HighLevelServices.mcpGateway` được inject, binary mặc định chưa nối port này |
| `bflow tool status [--tool <id>]` | Probe catalog tool versions/digests; không cài tool. `tools status` là alias ở parser kế thừa, nên ưu tiên cú pháp singular này |
| `bflow skills sync [--provider <kind>] [--dry-run] [--allow-machine-scope]` | Default pinned synchronizer; CLI chưa nhận `skills list` hoặc `sync --list` |
| `bflow agent check <claude|codex|agy> [--role <role>] [--mode restricted|workspace_auto]` | Standalone preflight; có thể chạy model probe/tiêu hao usage; không chọn role/profile/model từ repo config |

`mcp status` có thể báo `configured: false`/`not_ready` dù machine Gateway đã được setup:
đó là thiếu live port ở command composition, không phải bằng chứng daemon chưa chạy.
Dùng `doctor` và machine service status cho platform diagnostics; `docs status` probe Context7.
Không lặp setup chỉ để làm command này xanh. Verification gate runner cũng cần port tin cậy;
thiếu runner không được pass. Git locking cần `flock` phù hợp cho Linux/macOS.

Standalone `agent check` khác preflight của host trong `up`/`doctor`: nó không mở Herdr pane,
nhưng adapter mặc định có thể tạo model request và temporary probe state. `up`/`doctor`
mặc định chọn native auth/catalog và không inference ping; `doctor --deep` là opt-in.
`skills sync --dry-run` không áp dụng bundle mới nhưng default synchronizer có thể tạo/chmod
thư mục kho riêng khi khởi tạo. Các diagnostic này không phải full SDLC acceptance.

### Repository tool policy

`bflow up` resolves tool access from the repository's optional `environment.toolPolicy`,
the machine's approved setup inventory and a fresh Gateway observation. A tool pin or
installed executable alone never creates repository access. When no explicit policy is supplied, CLI composition derives optional Context7/RTK/GitNexus/
MemPalace/Chrome requirements unless their toggles are disabled. Provider roles retain
approved workflow skills; tool-backed skills are included only after independent grants
resolve. Missing optional grants are skipped/degraded with a reason. Explicit `role.skills: []` removes only that role's defaults; repository
`environment.skills.requiredSkills` remain required.

The policy distinguishes the catalog `toolId`, an MCP `serviceId`, and exact upstream
`operations`. Its repository scope must match the current machine, repository and canonical
workspace root. `digest` is the SHA-256 of canonical JSON for the policy object with the
`digest` field omitted. Recompute it whenever any requirement changes.

```yaml
environment:
  toolPolicy:
    schemaVersion: 3
    repositoryId: <repository-id>
    scope:
      kind: repository
      machineId: <machine-id>
      repositoryId: <repository-id>
      workspaceRoot: <canonical-workspace-path>
    digest: <canonical-policy-sha256>
    requirements:
      - toolId: context7
        kind: native_remote_mcp
        serviceId: context7
        operations: [resolve-library-id, query-docs]
        requiredness: optional
        roles: [specifier, architect, planner, developer, reviewer, qa]
        triggers: [external_documentation]
```

MCP operation names must match the reviewed machine service definition and its current
Gateway negotiation. CLI-only grants require the exact managed executable receipt, version
and digest. Optional unavailable tools are skipped with a degraded reason; required
unavailable tools stop startup before panes launch. A skill dependency never adds a grant.
Legacy `environment.context7` remains supported and resolves to the same explicit Context7
service and operation set. Legacy `requiredTools` and `requiredMcpServices` fail with a
migration message because they do not identify a role and exact operation allowlist.

The private Gateway control registers per-role, per-service Runtime grants separately from
the public MCP registration schema. Calls use the exact upstream operation through the
authenticated control endpoint. Memory calls require a repository-scoped read-only grant;
the Gateway validates the requested wing against that grant. `bflow doctor` shows
installation, repository allowance, resolved Runtime grant and readiness as separate checks.
None of those checks claims that a tool has been invoked or its result consumed.

```bash
pnpm --filter @bflow/cli build
pnpm exec vitest run apps/cli/test/high-level
```

### Repository trên filesystem không có quyền riêng tư

`bflow up` tự động đặt state riêng tư của host/provider/runtime vào một thư mục riêng tư,
do Bflow sở hữu, theo từng repository dưới `$XDG_STATE_HOME/bflow/repositories` (mặc định
`~/.local/state/bflow/repositories`) khi filesystem của repository không thể áp dụng
quyền file/thư mục riêng tư. Source repository vẫn giữ nguyên tại chỗ; không cần sao chép,
chmod thủ công hay symlink. `bflow doctor` báo vị trí hiệu lực.
Một bộ định vị không bí mật gắn với repository pin vị trí đó qua các thay đổi môi trường;
recovery và `down` mở lại cùng một authority. Storage được pin mà thiếu hoặc không hợp lệ
sẽ chặn khởi động thay vì thay thế nó. Các lifecycle receipt và pane manifest hiện có
vẫn nằm trong repository. Một host config cũ từ một lần fail kiểm tra quyền riêng tư
khi chưa khởi động được giữ lại mà không tái dùng token của nó; thẩm quyền host/run/platform
trước đó cần được đối soát trước khi di dời. Các đường dẫn storage cũ tường minh
và các store được cấu hình độc lập của các lệnh khác không bị ghi lại.

## Profile nhà cung cấp cô lập

`bflow iso <command> [arguments]` chạy engine ai-isolator được đóng gói kèm. Dùng
`bflow help iso` để xem ví dụ. Các đối số khởi chạy provider sau lệnh engine
được truyền trực tiếp tới Bash dưới dạng từng đối số riêng, vì vậy các cờ provider như
`--json` và `--help` không bị Bflow sử dụng. Executable giữ nguyên thư mục hiện tại,
môi trường, đầu vào/đầu ra terminal và exit status của provider.

Các lệnh gồm khởi chạy profile `codex`, `claude` và `agy`; `run <provider>`;
`login <provider>`; `status` (liệt kê profile, trạng thái xác thực Agy chưa được xác minh);
`remove <provider>`; `help`; và `version`. Lệnh riêng cho Codex `sync-skills` nhận
`--name NAME` hoặc `--all`, cùng với `--source PATH` tùy chọn.

Package cung cấp `isolation/bin/ai-isolator` bên cạnh cả `src` và `dist`; CLI
phân giải đường dẫn này tương đối với module của chính nó, không phụ thuộc thư mục
làm việc của caller. Cần Bash trong PATH; engine dùng Python 3.11 trở lên và
curl hoặc wget để đồng bộ MCP và kiểm tra provider được liên kết. POSIX `ps` được
sử dụng để dừng các process con của provider khi Bflow nhận SIGTERM. Trên Windows,
cần môi trường Bash như Git Bash; chạy Windows native không được hỗ trợ và việc dọn
process tree bằng tín hiệu qua Git Bash chưa được xác minh.

Profile dùng bố cục state của ai-isolator tại
`${AI_ISOLATOR_HOME:-$HOME/.local/share/ai-isolator}` và có thể được lệnh độc lập
`ai-isolator` sử dụng lại khi trỏ tới cùng state root. ai-isolator v0.4.4 gốc hỗ trợ
tương thích profile hai chiều với Codex và Claude. Hỗ trợ Agy là phần bổ sung của
Bflow và phiên bản gốc đó không hỗ trợ Agy. `bflow iso login agy --name personal`
mở giao diện onboarding native của Agy trong profile cô lập. `bflow iso status`
liệt kê profile và đánh dấu xác thực Agy chưa được xác minh vì engine không dò xác thực
Agy hoặc model. Engine isolation chỉ quản lý shell alias do nó đánh dấu và state thuộc
profile; nó không cô lập workflow Bflow hoặc xác nhận provider/runtime đã sẵn sàng.
Hãy kiểm tra cấu hình profile và shell trước khi dùng. CLI không đóng gói hoặc sao chép
thông tin đăng nhập tài khoản provider.

Khi đã có thư mục `profiles/` của ai-isolator, `bflow setup` thông thường thêm bước
`isolator-profiles` cần được phê duyệt riêng sau khi cài native tool và cấu hình Gateway.
Bước này chỉ kiểm tra và đồng bộ định nghĩa MCP, hướng dẫn skill đã duyệt cùng đăng ký/tài
nguyên plugin do Bflow quản lý; xác thực profile, tùy chọn account/model, quyền và các mục
cục bộ không liên quan vẫn được giữ riêng. `--check` và `--dry-run` chỉ kiểm tra. Bước này
báo lỗi rõ ràng nếu Python/helper được pin, cấu hình nguồn native hoặc profile đích không
hợp lệ, và xác minh kết quả sau khi áp dụng. Đích profile luôn dùng chung ai-isolator root:
`AI_ISOLATOR_HOME` tường minh, hoặc home thật đáng tin cậy (hay `AI_ISOLATOR_REAL_HOME`
khi đang ở trong profile) cộng với `.local/share/ai-isolator`. `BFLOW_HOME` chỉ thay đổi
native source home; nó không di chuyển hoặc migrate profile hiện có. Để giữ profile đích
trong sandbox, hãy đặt tường minh `AI_ISOLATOR_HOME=$BFLOW_HOME/ai-isolator` nhất quán
cho `bflow setup`, `bflow iso` và `bflow up`. Với `BFLOW_HOME`, native provider source
dùng các đường dẫn `providers/home`, `providers/codex` và `providers/claude` bên dưới nó,
bất kể override của account bên ngoài. Ngoài chế độ isolated source này,
`CODEX_HOME`, `CLAUDE_CONFIG_DIR` và `AI_ISOLATOR_CODEX_SKILLS_SOURCE` được tôn trọng
khi được đặt tường minh. Đồng bộ này không xác thực profile hoặc chứng minh provider đang
sẵn sàng trực tiếp.

Để gắn role với profile đã tạo bằng `bflow iso`, hãy gộp YAML này vào phần
`environment:` được tạo trong `.bflow/config.yml`. `profile-name` ở cấp role được ưu tiên
hơn mặc định của provider đó:

```yaml
environment:
  defaults:
    codex:
      profile-name: work
    claude:
      profile-name: personal
    agy:
      profile-name: work
  roles:
    - role: conversation
      cli: claude
    - role: coordinator
      cli: codex
      profile-name: lead
```

Giữ lại các trường policy và role entry khác được tạo khi gộp ví dụ này. Tên profile là
bộ chọn, không phải hướng dẫn setup: `bflow up` không tạo profile, sao chép thông tin
đăng nhập hoặc fallback về account HOME của provider. Profile không tồn tại, không hợp lệ
hoặc sai provider sẽ chặn khởi chạy trước khi thực thi provider; hãy tạo và xác thực
profile cô lập một cách tường minh trước khi chọn. Developer được khởi chạy động mà không
có role đã cấu hình chỉ kế thừa profile được chọn của Coordinator khi dùng cùng provider
với Coordinator.
