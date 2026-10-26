import { HIGH_LEVEL_SUMMARY } from "./high-level/help.js";
import type { CliCommandName } from "./types.js";

const GLOBAL_HELP = `Cách dùng: bflow <command> [options] (Usage: bflow <command> [options])

CLI điều phối quy trình SDLC tự hành (Autonomous SDLC workflow orchestration CLI).

Lệnh / Commands:
  init            Khởi tạo cấu hình kho mã bflow và quy trình mặc định
  config-migrate  Chuyển đổi tệp cấu hình cũ sang .bflow/config.yml
  setup           Lập kế hoạch và cài đặt môi trường máy cùng các thành phần nền tảng
  up              Khởi động/đồng bộ môi trường làm việc của kho mã
  down            Tạo checkpoint và dừng môi trường làm việc của kho mã
  attach          Kết nối vào khung trò chuyện (Conversation pane) của kho mã
  doctor          Chẩn đoán môi trường, công cụ phụ thuộc và phiên làm việc
  recover         Khôi phục khóa vòng đời cũ mà không xóa trạng thái dự án
  run             Bắt đầu một lượt chạy quy trình mới từ yêu cầu đầu vào
  status          Hiển thị trạng thái môi trường; truyền mã lượt chạy hoặc bộ lọc để tra cứu lượt chạy
  approve         Ghi nhận quyết định phê duyệt, từ chối hoặc yêu cầu làm lại của con người cho một tác vụ
  resume          Tiếp tục một lượt chạy quy trình đang hoạt động hoặc đang chờ
  cancel          Hủy một lượt chạy quy trình hoặc tác vụ đang hoạt động
  iso             Chạy hồ sơ nhà cung cấp cô lập thông qua ai-isolator đi kèm
  docs            Look up current library documentation — Tra cứu tài liệu thư viện qua dịch vụ Context7 dùng chung
  help            Hiển thị trợ giúp cho một lệnh

${HIGH_LEVEL_SUMMARY}

Tùy chọn chung (Global Options):
  -h, --help     Hiển thị trợ giúp
  -v, --version  Hiển thị phiên bản
  -j, --json     Xuất kết quả theo định dạng phong bì JSON
      --debug    Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật

Các tác nhân (agents) và kịch bản tự động nên truyền --json và dựa vào mã thoát tiến trình; đầu ra văn bản dành cho người dùng đọc trên thiết bị đầu cuối.

Ví dụ / Examples:
  bflow init
  bflow iso help
  bflow setup --check
  bflow run "Add user authentication feature"
  bflow repo inspect
  bflow task plan --spec ./specs/auth.json
  bflow task implement task-1 --run run-101 --spec ./specs/auth.json
  bflow verify task-1 --run run-101 --plan ./verification.json
  bflow git prepare run-101 --task task-a
  bflow mcp status
  bflow tool status
  bflow skills sync
  bflow agent check codex
  bflow status
  bflow status run-123
  bflow approve qa --decision approved
  bflow resume run-123
  bflow cancel run-123 --reason "Requirements changed"

Chạy 'bflow help <command>' hoặc 'bflow <command> --help' để xem các tùy chọn chi tiết của từng lệnh.`;

const INIT_HELP = `Cách dùng: bflow init [options] (Usage: bflow init [options])

Khởi tạo .bflow/config.yml tại thư mục gốc chuẩn của kho Git và đăng ký dịch vụ GitNexus của kho mã trên Gateway dùng chung. An toàn khi chạy lặp lại.

Tùy chọn (Options):
  --dir <path>          Thư mục đích để khởi tạo (mặc định: thư mục hiện tại)
  --config <path>       Đường dẫn tệp cấu hình tùy chỉnh (mặc định: .bflow/config.yml)
  --name <name>         Tên dự án
  --provider <kind>     Nhà cung cấp vai trò: claude, codex hoặc agy (mặc định: codex)
  --check               Kiểm tra chỉ đọc đối với .bflow/config.yml và mức sẵn sàng GitNexus của kho mã
  --remove              Gỡ đăng ký dịch vụ GitNexus của kho mã này khỏi Gateway dùng chung
  --no-gitnexus         Bỏ qua lập chỉ mục GitNexus và đăng ký dịch vụ trên Gateway
  -f, --force           Ghi đè cấu hình hiện có bằng các giá trị mặc định mới
  -y, --yes             Tương đương --force, đồng thời chấp nhận giấy phép GitNexus PolyForm-Noncommercial không cần hỏi lại
  -u, --update          Tạo lại .bflow/config.yml với chú thích mới và các trường mặc định mới nhưng vẫn giữ nguyên giá trị hiện có
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh init

Ví dụ / Examples:
  bflow init
  bflow init --check
  bflow init --remove
  bflow init --no-gitnexus
  bflow init --update
  bflow init --name my-project
  bflow init --provider claude
  bflow init --dir ./subproject --force`;

const CONFIG_MIGRATE_HELP = `Cách dùng: bflow config-migrate [--json] [--debug] (Usage: bflow config-migrate [--json])

Chuyển đổi an toàn tệp cấu hình cũ .bflow/config.yaml hoặc .bflow/config.json sang .bflow/config.yml.
Kiểm tra tính hợp lệ trước khi ghi, lưu bản gốc thành <legacy-path>.bak và xóa tệp cấu hình cũ sau khi tệp mới đã được ghi an toàn. Chạy lặp lại lệnh sẽ báo không có thay đổi; các tệp đích đã chỉnh sửa được giữ nguyên.

Tùy chọn (Options):
  -j, --json   Xuất kết quả theo định dạng phong bì JSON
      --debug  Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help   Hiển thị trợ giúp cho lệnh config-migrate`;

const SETUP_HELP = `Cách dùng: bflow setup [options] (Usage: bflow setup [options])

Lập kế hoạch và áp dụng các điều kiện tiên quyết cấp máy và cục bộ, công cụ tác nhân cùng bộ kỹ năng theo vai trò.
Tùy chọn --codex-hooks chọn luồng rà soát riêng chỉ dành cho hook; không bao giờ cài đặt công cụ hoặc dịch vụ.

Chế độ (Modes):
  --check               Kiểm tra điều kiện tiên quyết và chẩn đoán sai lệch mà không sửa đổi trạng thái
  --dry-run, --plan     Tạo và xem trước kế hoạch thiết lập mà không áp dụng thay đổi
  --apply               Áp dụng các thay đổi đã lập kế hoạch (chế độ mặc định)
  --repair              Sửa chữa cấu hình máy không hợp lệ và khôi phục trạng thái
  --codex-hooks         Chỉ rà soát các hook toàn cục của Codex; kết hợp với --check, --plan hoặc --apply
  --hook-digest <sha256> Mã băm bản chụp hook đã rà soát chính xác để phê duyệt không tương tác (yêu cầu --yes)
  --trust-all           Khi dùng cùng --codex-hooks --apply, tin cậy mọi hook toàn cục hiện tại/tương lai; dùng --yes hoặc xác nhận
  --revoke-trust-all    Khi dùng cùng --codex-hooks --apply, thu hồi quyền tin cậy rộng và khôi phục chế độ rà soát theo bản chụp

Tùy chọn (Options):
  -y, --yes             Xác nhận thiết lập, phê duyệt bản chụp chính xác (--hook-digest), hoặc xác nhận tường minh --trust-all
  --dir <path>          Cờ tương thích ngược (setup áp dụng toàn máy; dùng 'bflow init --dir <path>' cho từng kho mã)
  --catalog-dir <path>  Thư mục danh mục kỹ năng tùy chỉnh
  --context7-api-key-stdin  Đọc khóa API Context7 từ đầu vào chuẩn (stdin) và lưu trữ riêng tư (--apply/--repair).
                        Biến môi trường CONTEXT7_API_KEY cũng được sử dụng theo cách tương tự. Nếu không có khóa, Context7 chạy ở chế độ ẩn danh.
  --no-context7         Không đưa Context7 vào MCP Gateway dùng chung
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh setup

Ví dụ / Examples:
  bflow setup
  bflow setup --check
  bflow setup --dry-run
  bflow setup --codex-hooks --plan
  printf %s "$KEY" | bflow setup --apply --context7-api-key-stdin
  bflow setup --codex-hooks --apply --trust-all --yes
  bflow setup --codex-hooks --apply --revoke-trust-all
  bflow setup --apply --yes
  bflow setup --repair --yes`;

const RUN_HELP = `Cách dùng: bflow run <requirement> [options] (Usage: bflow run <requirement> [options])

Bắt đầu một lượt chạy quy trình mới từ yêu cầu đầu vào.

Tham số (Arguments):
  <requirement>         Yêu cầu bằng ngôn ngữ tự nhiên hoặc user story (bắt buộc)

Tùy chọn (Options):
  --run-id <id>         Định danh lượt chạy tường minh
  -w, --workflow <path> Đường dẫn tới tệp JSON định nghĩa quy trình tùy chỉnh
  --config <path>       Đường dẫn tới tệp cấu hình (mặc định: .bflow/config.yml)
  --idempotency-key <key> Khóa chống trùng lặp (idempotency key) khi tạo lượt chạy
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh run

Ví dụ / Examples:
  bflow run "Implement password reset flow"
  bflow run "Add billing webhook" --run-id run-42
  bflow run "Add caching" --workflow ./custom-workflow.json`;

const STATUS_HELP = `Cách dùng: bflow status [run-id] [options] (Usage: bflow status [run-id] [options])

Hiển thị trạng thái môi trường. Truyền mã lượt chạy hoặc các bộ lọc để tra cứu các lượt chạy quy trình.

Tham số (Arguments):
  [run-id]              Định danh lượt chạy tùy chọn để kiểm tra chi tiết một lượt chạy cụ thể

Tùy chọn (Options):
  --telemetry          Báo cáo metric chỉ đọc cho <run-id>; dùng --json để xuất dữ liệu có cấu trúc
  --status <statuses>   Lọc lượt chạy theo trạng thái (phân tách bằng dấu phẩy: queued, running, waiting, blocked, succeeded, failed, cancelling, cancelled)
  --workflow-id <id>    Lọc lượt chạy theo định danh định nghĩa quy trình
  --limit <n>           Số lượng lượt chạy tối đa trả về (1-500)
  --cursor <cursor>     Con trỏ phân trang
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh status

Ví dụ / Examples:
  bflow status
  bflow status run-123
  bflow status run-123 --telemetry --json
  bflow status --status waiting,blocked
  bflow status --limit 10`;

const APPROVE_HELP = `Cách dùng: bflow approve <task-id> [options] (Usage: bflow approve <task-id> [options])

Ghi nhận quyết định phê duyệt, từ chối hoặc yêu cầu sửa đổi của con người cho một tác vụ.

Tham số (Arguments):
  <task-id>             Định danh của tác vụ cần phê duyệt, từ chối hoặc yêu cầu sửa đổi (bắt buộc)

Tùy chọn (Options):
  --run, --run-id <id>  Định danh lượt chạy quy trình (bắt buộc nếu có nhiều lượt chạy đang hoạt động)
  --by, --decided-by, --actor <actor>
                        Danh tính người phê duyệt (mặc định: "human_operator", bắt buộc phải là tác nhân con người)
  --decision <decision> Quyết định: approved | rejected | changes_requested (mặc định: approved)
  --reason <text>       Lý do cho quyết định (bắt buộc đối với rejected và changes_requested)
  --approval-id <id>    Định danh quyết định phê duyệt tùy chỉnh
  --revision <n>        Số phiên bản sửa đổi của tác vụ (>= 1)
  --generation <n>      Thế hệ làm lại (rework generation) của tác vụ (>= 0)
  --idempotency-key <key> Khóa chống trùng lặp cho quyết định
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh approve

Ví dụ / Examples:
  bflow approve qa
  bflow approve qa --run run-123 --decision approved
  bflow approve review --decision changes_requested --reason "Fix lint issues"
  bflow approve implement --decision rejected --reason "Feature cancelled"`;

const RESUME_HELP = `Cách dùng: bflow resume <run-id> [options] (Usage: bflow resume <run-id> [options])

Tiếp tục một lượt chạy quy trình đang hoạt động hoặc đang chờ.

Tham số (Arguments):
  <run-id>              Định danh lượt chạy quy trình cần tiếp tục (bắt buộc)

Tùy chọn (Options):
  --idempotency-key <key> Khóa chống trùng lặp cho thao tác tiếp tục
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh resume

Ví dụ / Examples:
  bflow resume run-123
  bflow resume run-123 --idempotency-key resume-key-1`;

const CANCEL_HELP = `Cách dùng: bflow cancel <run-id> [options] (Usage: bflow cancel <run-id> [options])

Hủy một lượt chạy quy trình hoặc tác vụ đang hoạt động.

Tham số (Arguments):
  <run-id>              Định danh lượt chạy quy trình cần hủy (bắt buộc)

Tùy chọn (Options):
  --reason <text>       Lý do hủy (mặc định: "Cancelled by operator via CLI")
  --by, --requested-by <actor>
                        Danh tính người yêu cầu hủy (mặc định: "human_operator")
  --task, --task-id <task-id>
                        Chỉ định một tác vụ cụ thể cần hủy
  --expected-version <n> Phiên bản tổng hợp dự kiến của lượt chạy để kiểm soát đồng thời lạc quan
  --idempotency-key <key> Khóa chống trùng lặp cho thao tác hủy
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh cancel

Ví dụ / Examples:
  bflow cancel run-123
  bflow cancel run-123 --reason "Requirements changed"
  bflow cancel run-123 --task implement`;

const REPO_INSPECT_HELP = `Cách dùng: bflow repo inspect [options] (Usage: bflow repo inspect [options])

Kiểm tra cấu trúc kho mã, quy ước và danh sách tệp.

Tùy chọn (Options):
  --dir <path>          Thư mục gốc của kho mã cần kiểm tra (mặc định: thư mục hiện tại)
  --include-files       Bao gồm danh sách cây thư mục tệp trong kết quả
  --max-files <n>       Số lượng tệp tối đa cần kiểm tra (1-10000)
  --correlation-id <id> Định danh tương quan để truy vết
  --idempotency-key <key> Khóa chống trùng lặp cho sổ cái thao tác
  --resume              Tiếp tục từ bước đã ghi nhận trước đó nếu có
  --actor <id>          Danh tính tác nhân kích hoạt kiểm tra
  --role <role>         Ngữ cảnh vai trò tác nhân (ví dụ: coordinator, planner)
  --permission-mode <m> Chế độ quyền hạn: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Định danh phiên làm việc
  --isolation <kind>    Cô lập: provider_policy | os_sandbox | container
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh repo inspect

Ví dụ / Examples:
  bflow repo inspect
  bflow repo inspect --dir ./my-project --include-files --max-files 500
  bflow repo inspect --json`;

const TASK_PLAN_HELP = `Cách dùng: bflow task plan [spec-path] [options] (Usage: bflow task plan [spec-path] [options])

Phân rã bản đặc tả thành đồ thị tác vụ quy trình (DAG) có thể thực thi.

Tham số (Arguments):
  [spec-path]           Đường dẫn tới tệp JSON đặc tả (hoặc dùng --spec)

Tùy chọn (Options):
  --spec <path>         Đường dẫn tới tệp JSON đặc tả
  -w, --workflow <path> Đường dẫn tùy chọn tới định nghĩa quy trình cơ sở
  --run-id <id>         Định danh lượt chạy quy trình tùy chọn
  --correlation-id <id> Định danh tương quan để truy vết
  --idempotency-key <key> Khóa chống trùng lặp cho sổ cái thao tác
  --resume              Tiếp tục từ bước đã ghi nhận trước đó nếu có
  --actor <id>          Danh tính tác nhân kích hoạt lập kế hoạch
  --role <role>         Ngữ cảnh vai trò tác nhân (mặc định: planner)
  --permission-mode <m> Chế độ quyền hạn: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Định danh phiên làm việc
  --isolation <kind>    Cô lập: provider_policy | os_sandbox | container
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh task plan

Ví dụ / Examples:
  bflow task plan ./specs/auth-spec.json
  bflow task plan --spec ./specs/feature.json --workflow ./workflow.json`;

const TASK_IMPLEMENT_HELP = `Cách dùng: bflow task implement <task-id> [options] (Usage: bflow task implement <task-id> [options])

Thực thi triển khai cho một tác vụ với chính sách TDD có điều kiện.

Tham số (Arguments):
  <task-id>             Định danh của tác vụ cần triển khai (bắt buộc)

Tùy chọn (Options):
  --run-id, --run <id>  Định danh lượt chạy quy trình (bắt buộc)
  --spec <path>         Đường dẫn tới tệp JSON đặc tả
  -w, --workflow <path> Đường dẫn tới tệp JSON định nghĩa quy trình
  --attempt-id <id>     Định danh lần thử cho các chu kỳ làm lại
  --base-revision <sha> Phiên bản Git cơ sở để triển khai
  --owned-path <path>   Đường dẫn thuộc quyền sở hữu của tác vụ này (có thể lặp lại hoặc phân tách bằng dấu phẩy)
  --forbidden-path <p>  Đường dẫn bị cấm sửa đổi (có thể lặp lại hoặc phân tách bằng dấu phẩy)
  --developer-id <id>   Định danh tác nhân lập trình viên được phân công
  --require-red-evidence Bắt buộc có bằng chứng kiểm thử thất bại trước khi triển khai (pha Red trong TDD)
  --target-branch <b>   Nhánh Git đích để tích hợp
  --environment <env>   Tên môi trường thực thi
  --auto-approve        Tự động phê duyệt rà soát trước khi thực thi nếu được phép
  --approved-by <actor> Danh tính người phê duyệt
  --correlation-id <id> Định danh tương quan để truy vết
  --idempotency-key <k> Khóa chống trùng lặp cho sổ cái thao tác
  --resume              Tiếp tục từ bước đã ghi nhận trước đó nếu có
  --actor <id>          Danh tính tác nhân kích hoạt triển khai
  --role <role>         Ngữ cảnh vai trò tác nhân (mặc định: developer)
  --permission-mode <m> Chế độ quyền hạn: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Định danh phiên làm việc
  --isolation <kind>    Cô lập: provider_policy | os_sandbox | container
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh task implement

Ví dụ / Examples:
  bflow task implement task-1 --run run-101 --spec ./specs/auth.json
  bflow task implement task-2 --run-id run-101 --owned-path src/auth --require-red-evidence`;

const VERIFY_HELP = `Cách dùng: bflow verify [task-id] [options] (Usage: bflow verify [task-id] [options])

Thực thi kiểm chứng tác vụ hoặc toàn quy trình đối chiếu với các tiêu chí nghiệm thu.

Tham số (Arguments):
  [task-id]             Định danh tác vụ cần kiểm chứng (đối với phạm vi task)

Tùy chọn (Options):
  --run-id, --run <id>  Định danh lượt chạy quy trình
  --task-id, --task <id> Định danh tác vụ cần kiểm chứng
  --scope <scope>       Phạm vi kiểm chứng: task | workflow (mặc định: task)
  --spec <path>         Đường dẫn tới tệp JSON đặc tả
  --plan <path>         Đường dẫn tới tệp JSON kế hoạch kiểm chứng
  --change-set <path>   Đường dẫn tới tệp JSON tập thay đổi Git
  --cycle <path>        Đường dẫn tới tệp JSON chu kỳ kiểm chứng
  --max-iterations <n>  Số vòng lặp kiểm chứng tối đa (1-10, mặc định: 3)
  --correlation-id <id> Định danh tương quan để truy vết
  --idempotency-key <k> Khóa chống trùng lặp cho sổ cái thao tác
  --resume              Tiếp tục từ bước đã ghi nhận trước đó nếu có
  --actor <id>          Danh tính tác nhân kích hoạt kiểm chứng
  --role <role>         Ngữ cảnh vai trò tác nhân (mặc định: tester)
  --permission-mode <m> Chế độ quyền hạn: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Định danh phiên làm việc
  --isolation <kind>    Cô lập: provider_policy | os_sandbox | container
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh verify

Ví dụ / Examples:
  bflow verify task-1 --run run-101 --plan ./verification.json
  bflow verify --scope workflow --run-id run-101`;

const GIT_PREPARE_HELP = `Cách dùng: bflow git prepare [options] (Usage: bflow git prepare [options])

Đồng bộ các nhánh Git, chuẩn bị nhánh tích hợp và các cây làm việc (worktrees).

Tùy chọn (Options):
  --run-id, --run <id>  Định danh lượt chạy quy trình (bắt buộc)
  --integration-id <id> Định danh đợt tích hợp
  --base-revision <sha> Phiên bản Git cơ sở để tích hợp
  --task <key[:deps]>   Khóa tác vụ và các phụ thuộc (ví dụ: task-b:task-a, có thể lặp lại)
  --target-branch <b>   Nhánh Git đích
  --environment <env>   Tên môi trường thực thi
  --auto-approve        Tự động phê duyệt tích hợp nếu được phép
  --approved-by <actor> Danh tính người phê duyệt
  --correlation-id <id> Định danh tương quan để truy vết
  --idempotency-key <k> Khóa chống trùng lặp cho sổ cái thao tác
  --resume              Tiếp tục từ bước đã ghi nhận trước đó nếu có
  --actor <id>          Danh tính tác nhân kích hoạt git prepare
  --role <role>         Ngữ cảnh vai trò tác nhân (mặc định: coordinator)
  --permission-mode <m> Chế độ quyền hạn: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Định danh phiên làm việc
  --isolation <kind>    Cô lập: provider_policy | os_sandbox | container
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh git prepare

Ví dụ / Examples:
  bflow git prepare --run-id run-101 --task task-a --task task-b:task-a
  bflow git prepare --run-id run-101 --target-branch main --auto-approve`;

const MCP_STATUS_HELP = `Cách dùng: bflow mcp status [options] (Usage: bflow mcp status [options])

Kiểm tra trạng thái của các dịch vụ MCP đã đăng ký.

Tùy chọn (Options):
  --service <id>        Lọc theo định danh dịch vụ MCP (có thể lặp lại hoặc phân tách bằng dấu phẩy)
  --correlation-id <id> Định danh tương quan để truy vết
  --idempotency-key <k> Khóa chống trùng lặp cho sổ cái thao tác
  --resume              Tiếp tục từ bước đã ghi nhận trước đó nếu có
  --actor <id>          Danh tính tác nhân
  --role <role>         Ngữ cảnh vai trò tác nhân
  --permission-mode <m> Chế độ quyền hạn: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Định danh phiên làm việc
  --isolation <kind>    Cô lập: provider_policy | os_sandbox | container
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh mcp status

Ví dụ / Examples:
  bflow mcp status
  bflow mcp status --service gitnexus,rtk`;

const TOOL_STATUS_HELP = `Cách dùng: bflow tool status [options] (Usage: bflow tool status [options])

Kiểm tra trạng thái của các công cụ cấp máy và cấp kho mã đã ghim phiên bản.

Tùy chọn (Options):
  --tool <id>           Lọc theo định danh công cụ (có thể lặp lại hoặc phân tách bằng dấu phẩy)
  --correlation-id <id> Định danh tương quan để truy vết
  --idempotency-key <k> Khóa chống trùng lặp cho sổ cái thao tác
  --resume              Tiếp tục từ bước đã ghi nhận trước đó nếu có
  --actor <id>          Danh tính tác nhân
  --role <role>         Ngữ cảnh vai trò tác nhân
  --permission-mode <m> Chế độ quyền hạn: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Định danh phiên làm việc
  --isolation <kind>    Cô lập: provider_policy | os_sandbox | container
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh tool status

Ví dụ / Examples:
  bflow tool status
  bflow tools status --tool rtk`;

const SKILLS_SYNC_HELP = `Cách dùng: bflow skills sync [options] (Usage: bflow skills sync [options])
     hoặc: bflow skills list [options]

Đồng bộ hoặc liệt kê các kỹ năng tác nhân trên các nhà cung cấp.

Tùy chọn (Options):
  --list                Liệt kê các kỹ năng hiện có mà không đồng bộ
  --provider <kind>     Nhà cung cấp đích: claude | codex | agy
  --manifest-id <id>    Lọc theo định danh bản kê kỹ năng (skill manifest)
  --environment-id <id> Lọc theo định danh môi trường
  --catalog-dir <path>  Thư mục danh mục kỹ năng tùy chỉnh
  --store-dir <path>    Thư mục lưu trữ kỹ năng tùy chỉnh
  --correlation-id <id> Định danh tương quan để truy vết
  --idempotency-key <k> Khóa chống trùng lặp cho sổ cái thao tác
  --resume              Tiếp tục từ bước đã ghi nhận trước đó nếu có
  --actor <id>          Danh tính tác nhân
  --role <role>         Ngữ cảnh vai trò tác nhân
  --permission-mode <m> Chế độ quyền hạn: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Định danh phiên làm việc
  --isolation <kind>    Cô lập: provider_policy | os_sandbox | container
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh skills sync

Ví dụ / Examples:
  bflow skills sync
  bflow skills list
  bflow skills sync --provider claude --list`;

const AGENT_CHECK_HELP = `Cách dùng: bflow agent check [provider] [options] (Usage: bflow agent check [provider] [options])

Kiểm tra mức sẵn sàng và sức khỏe hoạt động của nhà cung cấp tác nhân.

Tham số (Arguments):
  [provider]            Nhà cung cấp tác nhân đích: claude | codex | agy (hoặc dùng --provider)

Tùy chọn (Options):
  --provider <kind>     Nhà cung cấp tác nhân đích: claude | codex | agy
  --stage <stage>       Giai đoạn kiểm tra sức khỏe: preflight | activated (mặc định: preflight)
  --environment-id <id> Định danh môi trường
  --correlation-id <id> Định danh tương quan để truy vết
  --idempotency-key <k> Khóa chống trùng lặp cho sổ cái thao tác
  --resume              Tiếp tục từ bước đã ghi nhận trước đó nếu có
  --actor <id>          Danh tính tác nhân
  --role <role>         Ngữ cảnh vai trò tác nhân
  --permission-mode <m> Chế độ quyền hạn: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Định danh phiên làm việc
  --isolation <kind>    Cô lập: provider_policy | os_sandbox | container
  -j, --json            Xuất kết quả theo định dạng phong bì JSON
      --debug           Hiển thị đầy đủ thông tin chi tiết và chẩn đoán kỹ thuật
  -h, --help            Hiển thị trợ giúp cho lệnh agent check

Ví dụ / Examples:
  bflow agent check codex
  bflow agent check claude
  bflow agent check --provider codex --stage activated`;

const DOCS_HELP = `Usage: bflow docs <search|lookup|status> [options]

Look up current, version-specific documentation of an external library through Context7, a hosted
documentation service reached through the shared MCP Gateway. Commands are read-only. They use your own
Gateway registration when run inside an agent pane, and never start a documentation server of their own.
Queries (library names and documentation questions) leave the machine: never put source code or secrets in them.

Subcommands:
  search <library>             Resolve a library and show candidates, ids and the version choice for this project
  lookup [<library>] --query   Return documentation for a question, with the version used and any warnings
  status                       Report whether Context7 is enabled, reachable, authenticated and usable

Options:
  --query <text>        Search: optional phrasing for ranking. Lookup: the specific question (required)
  --library-id <id>     Lookup: a Context7 id such as /org/project or /org/project/v1.2.3 instead of a name
  --version <version>   Override the version detected from package.json, lockfiles or other dependency metadata
  --language <name>     Lookup: language hint for libraries with several
  --no-cache            Lookup: bypass the local documentation cache
  --role <role>         When run by an operator outside an agent pane, act under this role's grant (default developer)
  --timeout <ms>        Per-request timeout, 1000-120000 (default 30000)
  -j, --json            Output a JSON envelope
  -h, --help            Show help for docs

Exit codes: 0 succeeded, 1 the lookup failed or Context7 is not healthy, 2 invalid usage.
Failures are classified (network, timeout, auth_invalid, rate_limited, library_not_found, version_not_found, no_documentation, permission_denied, ...).

Examples:
  bflow docs search react
  bflow docs lookup react --query "how do I clean up a subscription in useEffect" --json
  bflow docs lookup --library-id /vercel/next.js --version v15.1.8 --query "route handlers"
  bflow docs status --json`;

const HELP_MAP: Record<CliCommandName, string> = {
  docs: DOCS_HELP,
  up: "Cách dùng: bflow up [--timeout <milliseconds>] [--json] [--debug] (Usage: bflow up [--timeout <milliseconds>] [--json])\nKhởi động hoặc đồng bộ phiên làm việc chạy nền của kho mã này và chờ các vai trò bắt buộc sẵn sàng.",
  down: "Cách dùng: bflow down [--yes] [--force] [--timeout <milliseconds>] [--json] [--debug] (Usage: bflow down [--yes] [--force] [--timeout <milliseconds>] [--json])\nTạo checkpoint cho công việc đang chạy và dừng an toàn chỉ phiên làm việc của kho mã này. --yes xác nhận dừng khi có công việc chưa an toàn. --force bao gồm xác nhận và dừng trực tiếp phiên làm việc thuộc sở hữu khi việc dọn dẹp pane bị kẹt. Cả hai chế độ đều yêu cầu rào chắn tắt Runtime và các checkpoint hợp lệ; trạng thái dự án và các worktree được giữ nguyên.",
  attach: "Cách dùng: bflow attach [--json] [--debug] (Usage: bflow attach [--json])\nChuyển tiêu điểm vào khung Trò chuyện (Conversation) và kết nối vào phiên làm việc hiện có của kho mã. Hãy chạy bflow up trước.",
  recover: "Cách dùng: bflow recover --yes [--json] [--debug] (Usage: bflow recover --yes [--json])\nHãy dừng các lệnh Bflow cũ trước. Chỉ chuyển đổi khóa vòng đời cũ đang trống; giữ nguyên trạng thái dự án, các tác nhân và worktree. Sau đó chạy bflow up hoặc bflow down --yes.",
  doctor: "Cách dùng: bflow doctor [--deep] [--json] [--debug] (Usage: bflow doctor [--deep] [--json])\nKiểm tra cấu hình, công cụ phụ thuộc, mức sẵn sàng của nhà cung cấp và phiên tác nhân của kho mã này. Chẩn đoán mặc định không gọi thực thi mô hình. --deep kiểm tra thêm từng nhà cung cấp/hồ sơ/mô hình riêng biệt đã cấu hình; tùy chọn này có thể tiêu tốn hạn mức sử dụng mô hình.",
  init: INIT_HELP,
  "config-migrate": CONFIG_MIGRATE_HELP,
  setup: SETUP_HELP,
  run: RUN_HELP,
  status: STATUS_HELP,
  approve: APPROVE_HELP,
  resume: RESUME_HELP,
  cancel: CANCEL_HELP,
  help: GLOBAL_HELP,
  version: GLOBAL_HELP,
  "repo inspect": REPO_INSPECT_HELP,
  "task plan": TASK_PLAN_HELP,
  "task implement": TASK_IMPLEMENT_HELP,
  verify: VERIFY_HELP,
  "git prepare": GIT_PREPARE_HELP,
  "mcp status": MCP_STATUS_HELP,
  "tool status": TOOL_STATUS_HELP,
  "skills sync": SKILLS_SYNC_HELP,
  "agent check": AGENT_CHECK_HELP
};

export function getHelpText(topic?: CliCommandName): string {
  if (!topic || topic === "help") {
    return GLOBAL_HELP;
  }
  return HELP_MAP[topic] ?? GLOBAL_HELP;
}
