# Hướng dẫn sử dụng Bflow

Hướng dẫn sử dụng hiện tại: build và gọi `node apps/cli/dist/bin.js setup` một lần, nạp lại shell rồi dùng lệnh tắt `bflow`. CLI lifecycle đã ghép persistent P19 host/platform; legacy workflow commands dùng Runtime store riêng. [Trạng thái source và bằng chứng](../implementation-status.md), [mục lục toàn bộ tài liệu](../README.md) và exported contracts là các điểm tham chiếu khi đối chiếu hành vi.

| Chủ đề | Nội dung tóm tắt |
| --- | --- |
| [Khởi đầu nhanh (Getting Started)](getting-started.md) | Hướng dẫn trải nghiệm trên một repository Node.js/TypeScript độc lập |
| [Cài đặt (Installation)](installation.md) | Cài đặt và biên dịch từ mã nguồn; yêu cầu Node, pnpm và Herdr |
| [Khởi tạo dự án (`bflow init`)](bflow-init.md) | Cấu trúc tệp config.yml có chú thích, định danh Git, chuyển đổi phiên bản, tính lũy thừa và cờ ghi đè |
| [Khởi động dịch vụ (`bflow up`)](bflow-up.md) | Quản lý phiên có tên (named session), các vai trò thường trực, điều kiện sẵn sàng và các giới hạn khi khởi động host |
| [Gắn kết phiên (`bflow attach`)](bflow-attach.md) | Cơ chế gắn kết trực tiếp vào pane của Conversation Agent |
| [Khôi phục sự cố sau Ctrl+C](troubleshooting.md) | Cơ chế khoá kernel (kernel lock), lệnh `recover --yes`, hộp thoại khởi động native và nhãn định danh pane |
| [Hạ dịch vụ (`bflow down`)](bflow-down.md) | Rào chắn an toàn (barrier), điểm kiểm tra (checkpoint) và các giới hạn khi dừng hệ thống |
| [Tham chiếu cấu hình (Configuration Reference)](configuration-reference.md) | Chi tiết các trường cấu hình thực tế cho CLI, Runtime host và Herdr |
| [Các vai trò Agent (Agent Roles)](agent-roles.md) | Danh mục 8 vai trò chính thức và ánh xạ định danh theo hợp đồng (contracts) |
| [Chính sách SDD & TDD](sdd-tdd-policies.md) | Phân loại rủi ro, xác định mức độ đặc tả, các chế độ kiểm thử required/recommended/not_applicable |
| [Vòng lặp kiểm tra (Verification Loop)](verification-loop.md) | Cơ chế kiểm thử độc lập, kiểm soát giới hạn số lần thử lại (retry), sửa lỗi (rework) và vòng lặp |
| [Khôi phục phiên làm việc (Session Recovery)](session-recovery.md) | Xử lý khởi động lại, tình trạng truyền tin bất định (uncertain delivery), biên nhận và phát lại điểm kiểm tra |
| [Giao tiếp qua Herdr (Herdr Communication)](herdr-communication.md) | Cấu trúc RoleMessage, biên nhận native đã xác thực và các giới hạn của tầng truyền tải |
| [Xử lý sự cố (Troubleshooting)](troubleshooting.md) | Cẩm nang chẩn đoán và khắc phục lỗi thực tế theo từng thành phần |
| [Bảo mật & Phê duyệt (Security & Approval)](security-approval.md) | Quản lý bí mật (secrets), ranh giới tin cậy của host và thẩm quyền phê duyệt |
| [Tổng quan kiến trúc (Architecture Overview)](architecture-overview.md) | Mô hình 5 thành phần cốt lõi và 4 miền trạng thái trực giao |

- Mẫu dự án chuẩn (Portable template): [templates/node-typescript](../../templates/node-typescript/README.md)
- Repository thử nghiệm mẫu: [examples/portable-node](../../examples/portable-node/README.md)
- Báo cáo kiểm chứng thực tế: [Báo cáo xác thực](../../templates/node-typescript/VALIDATION.md) ghi nhận chi tiết các lệnh, mã thoát (exit code), baseline và phạm vi kiểm thử với Herdr thực tế.

---

## Trạng thái triển khai tính năng

| Năng lực hệ thống | Trạng thái triển khai |
| --- | --- |
| Khởi tạo cấu hình và phân tách định danh repository | Đã triển khai đầy đủ; đã kiểm chứng lệnh CLI thực tế trong repository tạm thời |
| Quản lý vòng đời (Up / Attach / Status / Doctor) qua P12 + P13 | Đã triển khai; môi trường nhà cung cấp (provider) và agent cần được cài đặt, đăng nhập độc lập |
| Hạ dịch vụ (`bflow down`) của CLI adapter mặc định | Đã tích hợp cơ chế rút cạn/điểm kiểm tra của host cùng quy trình tắt P13; vượt qua kiểm thử smoke; `--yes` không bỏ qua barrier an toàn |
| Tổ hợp quy trình SDLC (P14–P19) | Đã cung cấp API `openAgenticWorkspace`; đòi hỏi host tin cậy và cơ chế đăng ký/xác thực công cụ của provider |
| Thực thi chính sách SDD / Conditional TDD / Verification | Policy được chuyển tới host; tự phát hiện runner theo [ma trận](../verification-runners.md), JS/TS có Linux Bubblewrap và macOS Seatbelt |
| CLI tự động khởi động và tắt host P19 | Đã triển khai provider-aware prepare/activate và native hooks/MCP; probe/lifecycle reports có phạm vi riêng |
| Tầng truyền tải thông điệp Herdr có chữ ký số | Đã kiểm chứng thực tế; việc truyền tải thông điệp không thay thế cho bằng chứng nghiệm thu kết quả của AI |
| Nghiệm thu Agentic SDLC đầu-cuối với mô hình trực tiếp | **Chưa kiểm chứng đầy đủ trong đợt phát hành này** |
| Tự động tích hợp, merge và triển khai nhánh được bảo vệ | Runtime hiện tại không cấp quyền thực thi tự động các thao tác đẩy nhánh/triển khai lên remote |

---

## Tài liệu lưu trữ kế thừa (Legacy P00–P10)

Các tài liệu được đánh số dưới đây được lưu giữ nhằm mục đích tham chiếu API và các bài demo thuộc giai đoạn kiến trúc cũ. Những đánh giá tích hợp trước giai đoạn P19 không còn áp dụng cho mô hình P19 host hiện tại; khuyến nghị người dùng mới sử dụng các tài liệu hướng dẫn ở phần trên. Tuyệt đối không áp dụng các ví dụ thao tác trực tiếp vào Core để vượt qua các chính sách của P19.

- [01. Tổng quan kiến trúc](01-architecture-overview.md), [02. Thiết lập môi trường](02-environment.md), [03. Cấu hình Herdr](03-herdr-setup.md)
- [04. Cài đặt và khởi tạo](04-install-and-init.md), [05. Vai trò và mô hình trong Registry](05-roles-and-models.md)
- [06. Quy trình phát triển tính năng](06-feature-workflow.md), [07. Quy trình sửa lỗi](07-bugfix-workflow.md)
- [08. Trạng thái và Artifact](08-status-and-artifacts.md), [09. Xử lý tắc nghẽn và khôi phục](09-blocked-timeout-retry-resume.md), [10. Xác minh trước khi merge](10-pre-merge-verification.md)

*Lưu ý: Dự án mẫu kế thừa [runtime-demo](../../examples/runtime-demo/README.md) sử dụng cơ chế outbox transport và các bản vá (patch) định sẵn, không phản ánh việc tương tác trực tiếp với mô hình hoặc môi trường Herdr đầu-cuối.*
