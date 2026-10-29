# Bflow Web: đề xuất cải thiện UX

Trạng thái: chủ dự án đã duyệt thiết kế và ngoại lệ lockfile trong hội thoại ngày 2026-10-29.

## Mục tiêu và phạm vi

Giữ bảng màu ivory/ink/amber, góc vuông, đường kẻ 1px, bề mặt phẳng và bốn vai trò font hiện tại. Chuyển styling giao diện sang Tailwind biên dịch tại build; giảm kích thước thừa và cải thiện việc tìm, đọc, xử lý công việc. Áp dụng toàn bộ `apps/web`: quản lý dự án, tổng quan, danh sách/chi tiết công việc, hộp xem xét, cài đặt và trò chuyện.

Các quyết định dưới đây là đề xuất của người triển khai, chưa phải lựa chọn đã được chủ dự án duyệt.

## Thiết kế đề xuất

### 1. Tailwind và hệ thống kích thước

- Tích hợp Tailwind qua Vite, dùng utility trong JSX và semantic theme tokens dùng chung. Không dùng CDN hoặc nạp CSS lúc chạy.
- Chuyển layout, spacing, typography, trạng thái tương tác và responsive khỏi các stylesheet raw hiện tại. CSS còn lại chỉ dành cho font cục bộ, theme và các quy tắc nền tảng thực sự dùng chung; không giữ một lớp CSS raw song song điều khiển layout.
- Body 16px, dữ liệu/nhãn 14px, metadata 12px; tiêu đề trang 28–32px, tiêu đề khối 18–20px. Bỏ kích thước tiêu đề kiểu hero khỏi các màn hình vận hành.
- Sidebar desktop khoảng 224px; lề nội dung 16px trên mobile, 24–32px trên desktop; padding panel 16–20px, khoảng cách khối 20–24px.
- Control desktop cao khoảng 36px; mobile ít nhất 44px, chữ input/select/textarea tối thiểu 16px để tránh auto-zoom khi nhập trên iOS. Focus ring rõ, không thu nhỏ chữ bằng zoom hoặc transform, vẫn hỗ trợ phóng to trình duyệt.

### 2. Điều hướng và bố cục

- Header gọn, tên dự án và vị trí hiện tại rõ ràng. Desktop giữ sidebar; mobile dùng disclosure inline có nút mở/đóng với aria-controls/aria-expanded, đóng sau khi chọn route. Nội dung menu đã đóng không còn focusable; nếu đóng khi focus ở trong menu, trả focus về nút mở. Không để toàn bộ menu chiếm màn hình trước nội dung.
- Bỏ mục “Trò chuyện” giả trạng thái disabled khỏi điều hướng chính; tiếp tục đặt trò chuyện trong chi tiết công việc và giải thích tại đó.
- Tổng quan ưu tiên trạng thái phiên, điểm chặn và hành động phù hợp; đưa công việc gần đây và quyết định chờ lên trước các chẩn đoán phụ. Form yêu cầu và thông tin chuẩn bị dùng progressive disclosure khi phù hợp, với nhãn rõ ràng.
- Chi tiết công việc nhóm trạng thái, nhiệm vụ, điểm cần xử lý, quyết định và thao tác; metadata kỹ thuật nằm trong phần mở rộng. Dùng cột phụ trên màn hình đủ rộng, xếp một cột trên mobile.
- Cài đặt có nhóm điều hướng nội bộ: điều kiện, cấu hình, khởi tạo và vùng hủy đăng ký; giảm fieldset lồng nhau. Giữ bản nháp khi chuyển nhóm; không tự lưu, khởi tạo hoặc commit.

### 3. Danh sách, tìm kiếm và phân trang

- Công việc: giữ phân trang cursor 25 mục từ API, bổ sung trang trước/trang sau, trang đầu và chỉ báo trang đang xem. Giữ search/phase/cursor trong URL; Back/Forward phục hồi đúng bộ lọc. Đồng bộ ô tìm kiếm với URL khi điều hướng. Nút thử lại giữ nguyên bộ lọc thay vì xóa truy vấn.
- Cursor không cung cấp tổng số trang: không hiển thị tổng trang hoặc tổng công việc suy đoán. Lưu stack cursor theo project và bộ lọc; reset stack khi đổi bộ lọc. Deep link có cursor nhưng không có lịch sử hiển thị “Trang hiện tại”, có đường về trang đầu, không tự dựng cursor trước hoặc gán số trang. Số trang khi có stack chỉ phản ánh lần duyệt hiện tại.
- Dự án: thêm tìm theo tên/đường dẫn và phân trang phía trình duyệt khi vượt 12 mục; trạng thái không có dự án khác với không có kết quả tìm kiếm.
- Hộp xem xét: lọc theo trạng thái, phân trang phía trình duyệt 10 mục trên snapshot API đã trả. Chỉ mount/tải chi tiết cho các mục trang hiện hành; gộp đọc cùng một run nếu có nhiều quyết định của run đó. Thông báo rõ đây là tập dữ liệu hiện có, không khẳng định bao phủ lịch sử ngoài giới hạn API.
- Trò chuyện: điều khiển cursor trước/sau và về đầu lịch sử rõ ràng, giữ draft composer khi chuyển trang. Không tự nhảy cuộn khi người dùng đang đọc.
- Khi đổi lọc hoặc tập dữ liệu giảm, đưa trang local về trang hợp lệ. Không làm mất lý do/phương án quyết định đang nhập khi lật trang: cảnh báo trước khi rời form chưa gửi hoặc giữ draft gắn với decision/revision và hủy quyền submit khi revision đổi.

### 4. Tải, lỗi và phản hồi

- Skeleton mô phỏng hàng dữ liệu/panel cho lần tải đầu ở dự án, tổng quan, công việc, xem xét, cấu hình và chat; một nhãn status dễ đọc cho screen reader, skeleton trang trí ẩn khỏi accessibility tree.
- Refresh nền giữ nội dung hiện có; chỉ báo cập nhật nhỏ và aria-busy, không thay toàn màn hình bằng skeleton. Dữ liệu cũ khi lỗi/mất mạng tiếp tục được đánh dấu rõ; quyền thao tác vẫn dựa trên bản đọc hiện hành.
- Loading/error/empty không chồng chéo. Lỗi có retry tại khu vực liên quan, giữ các bộ lọc và bản nháp. Nút async có pending/disabled phù hợp.
- Trạng thái kết nối bình thường hiển thị gọn; mất kết nối/kết nối lại là cảnh báo rõ, không chiếm thêm khối lớn khi bình thường.
- Form có label, lỗi liên kết field, giữ dữ liệu nhập và phản hồi thành công; thao tác nguy hiểm có xác nhận và lối quay lại.

## Tiêu chí nghiệm thu

1. Styling layout/component trong phạm vi trên dùng Tailwind build-time; xóa CSS raw đã được thay thế. Màu, font cục bộ, góc vuông và đường kẻ thương hiệu được giữ.
2. Kiểm tra trình duyệt ở 375, 768, 1280 và 1440px cùng mobile landscape: không tràn ngang toàn trang, control không chồng lấn, nhãn/trạng thái dài vẫn đọc được. Kiểm tra zoom 200%, keyboard và reduced motion.
3. Bộ lọc, phân trang trước/sau, deep link và Back/Forward hoạt động với dữ liệu nhiều trang; retry không xóa truy vấn. Không hiển thị tổng số không có trong API.
4. Mỗi màn hình dữ liệu phân biệt được lần tải đầu, refresh nền, không có dữ liệu, không có kết quả lọc và lỗi. Skeleton không làm mất focus hoặc thay thế nội dung đang đọc khi refresh.
5. Phân trang review không mất bản nháp đang nhập; thay revision không tái sử dụng quyền duyệt. Chat giữ draft, không tự gửi lại tin nhắn hoặc thao tác chưa rõ kết quả.
6. Giữ các kiểm tra session, CSRF, expectedVersion, stale/expiry, xác nhận, operation recovery, exact-action và quyền Runtime đang có. Không sửa API/contracts hoặc backend.
7. Build/typecheck và bộ test web hiện có đạt; bổ sung test hành vi cho phân trang/filter/history, skeleton/background refresh và navigation mobile. Chạy browser regression với production bundle và fixture hiện có, xem ảnh desktop/mobile. Đây là bằng chứng local/browser, không phải live Herdr/provider acceptance.

## Kế hoạch triển khai sau duyệt

1. Tạo branch/worktree riêng từ baseline `2aa02d6` đã kiểm tra sạch, trùng `origin/main` tại lúc khảo sát; kiểm tra lại trạng thái trước khi tạo.
2. Tích hợp Tailwind/theme, chuyển AppShell và component chung; build để phát hiện tương tác Preflight.
3. Chuyển từng màn hình sang utility và bố cục gọn; thêm loading primitives, search/pagination và progressive disclosure theo tiêu chí trên.
4. Kiểm thử hành vi bị ảnh hưởng, build/typecheck, browser regression, kiểm tra ảnh và sửa lỗi trước bàn giao.

Test strategy: recommended, tập trung test hành vi người dùng và hồi quy hiện có; không viết test chỉ chép lại class Tailwind. Các thay đổi async/filter/pagination phải có kiểm tra hành vi.

Owned scope là `apps/web/**`. Thêm dependency Tailwind cần cập nhật `pnpm-lock.yaml` là đường dẫn integration-owned: đề nghị chủ dự án duyệt ngoại lệ hẹp cho lockfile phục vụ dependency này. Không sửa root manifests, tài liệu chung, contracts hoặc chính sách để đơn giản hóa triển khai.

## Bằng chứng khảo sát

Khảo sát source tại `2aa02d6`: body 18px, h1 clamp 40–72px, gutter 64px, sidebar 260px; CSS tập trung ở `styles/tokens.css` cùng CSS chat/request. Runs đã có cursor next/first, thiếu previous; retry hiện xóa query. Projects chưa có tìm kiếm/phân trang. Review mount mọi item và tải run riêng cho mỗi item. Các loading screen chủ yếu dùng đoạn chữ. Đây là phát hiện từ source, chưa phải đánh giá ảnh trên trình duyệt.

Đã tra `ui-ux-pro-max` với domain UX về progressive loading và stack html-tailwind về layout compact/responsive; áp dụng skeleton ổn định, aria-busy, responsive gutters và xử lý nhãn dài. `docs/DESIGN.md` vẫn là nguồn màu/style; yêu cầu của chủ dự án thay thế thang kích thước lớn hiện tại cho lần cải thiện này.

Lượt review thiết kế độc lập đã kiểm tra tính khả thi và phạm vi; bổ sung font form mobile, quy tắc cursor stack/deep link và semantics menu mobile như trên. Baseline `pnpm --filter @bflow/web test` đạt 12 file / 61 test ngày 2026-10-29. Tại thời điểm đề xuất chưa sửa code giao diện hoặc kiểm tra ảnh trình duyệt. Kết quả triển khai được ghi riêng trong UX-VALIDATION.md.
