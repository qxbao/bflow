# Không gian làm việc Bflow dễ sử dụng

Thiết kế được chủ dự án duyệt trong hội thoại ngày 2026-11-05. Phạm vi triển khai: apps/web; không đổi hợp đồng công khai hay cơ chế cấp quyền/gửi lệnh.

## Mục tiêu và tiêu chí chấp nhận

1. Tổng quan ưu tiên bắt đầu phiên, công việc và câu hỏi cần trả lời. Thông tin vận hành, khôi phục và cấu hình dự kiến mở theo nhu cầu. Biểu mẫu vẫn giữ bản nháp khi đóng/mở.
2. Web có điều hướng nhất quán, nền trung tính, điểm nhấn vàng, khoảng cách 16/24/32px, chữ dễ đọc. Trường bắt buộc và quyền xác nhận giữ nguyên.
3. Chat ưu tiên hội thoại. Danh sách lịch sử có nút đóng/mở; trong bảng 3D hẹp không ép thành hai cột. Khung nhập có ít nhất hai dòng; không tự gửi bản nháp hay gửi lại tin chưa rõ kết quả.
4. 3D trên màn hình từ 1100px: cảnh và bảng chi tiết là hai vùng không chồng lên nhau. Canvas, HUD và camera cùng dùng kích thước vùng cảnh thực tế. Dưới 1100px: bảng chi tiết phủ màn hình, có nút về văn phòng và Escape, không che nút đóng.
5. Các lưới bên trong bảng dùng chiều rộng nội dung, không dùng chiều rộng cửa sổ để quyết định số cột. Không tràn ngang ở 375/768/1024/1440/1920px, kể cả văn bản dài.
6. Lỗi đọc dữ liệu có một thông báo ngắn, nút thử lại và chi tiết mở thêm. Không giấu tình trạng dữ liệu cũ, quyền xác nhận, cảnh báo kết quả chưa rõ hoặc nguyên nhân chặn thực thi.
7. Nhãn hiển thị dùng tiếng Việt phổ thông; tên công cụ và các khái niệm cần giữ có giải thích. Trạng thái chưa khởi động không trình bày như sự cố nghiêm trọng.
8. Bàn phím, focus khi mở/đóng, reduced motion, deep link và các bản nháp qua chuyển chế độ tiếp tục hoạt động.

## Kế hoạch triển khai

- [x] Sửa khung ứng dụng, token, khoảng cách và lưới theo chiều rộng vùng nội dung.
- [x] Rút gọn Tổng quan, thông báo lỗi, thao tác phiên; sửa câu chữ trên các trang.
- [x] Cho lịch sử Chat đóng/mở, tăng vùng tin nhắn và ô soạn.
- [x] Chia vùng cảnh/bảng 3D và cập nhật camera/HUD theo vùng cảnh thật.
- [x] Kiểm tra Web package, build/typecheck, browser responsive, bản nháp, phê duyệt và gửi tin; reviewer độc lập rà toàn bộ diff.
- [x] Viết kế hoạch 3D tương tác như game, tách khỏi phạm vi đã triển khai.

## Chiến lược kiểm tra

TDD: recommended cho thay đổi tương tác; not_applicable cho thuần CSS/câu chữ, thay bằng kiểm tra trực quan và các bài kiểm tra có sẵn. Thêm kiểm tra trình duyệt đo vùng cảnh/bảng không giao nhau, mở/đóng lịch sử, không tràn ngang, focus, bản nháp và reduced motion. Không dùng kiểm tra chuỗi CSS làm bằng chứng responsive.

Baseline bc2b89f2 = origin/main; chứa P24 8dbb056. Baseline Web: 51 files, 542 tests passed. Build baseline thành công; cảnh báo chunk >500kB đã có trước.

## Ghi nhận khảo sát

Đã mở ứng dụng thật bằng trình duyệt riêng. Khi phiên dừng, Tổng quan vẫn hiện biểu mẫu chi tiết bị vô hiệu; thông tin phiên và Director lặp nhau; cảnh hiện trải dưới bảng fixed 720px/70vw; lưới Chat dùng breakpoint cửa sổ nên vẫn chia hai cột bên trong bảng hẹp. Graphify CLI hỏng import; đọc graph JSON chỉ cung cấp gợi ý AppShell, kết luận sửa dựa trên source và trình duyệt.

## Quyết định khi triển khai

- Bảng desktop rộng clamp(420px, 40vw, 680px); tại 1100px cảnh còn 660px. Dưới 1100px bảng toàn màn hình; HUD cảnh ẩn, thao tác đang chờ vẫn mở được ở đáy. Mở bảng không hủy cảnh hay bản nháp.
- Camera chỉ dự phòng diện tích HUD. Chọn nhân viên rồi resize sẽ tính lại tâm theo vùng cảnh mới; kéo/zoom bằng tay hủy việc tự căn theo đối tượng.
- Reviewer độc lập tìm ra hai điểm đã sửa: nút Gửi bị cắt trên điện thoại, và cảnh báo dừng phiên bị đặt trong phần thu gọn. Đã có kiểm tra hình học của nút/ô nhập và kiểm tra cảnh báo phải nằm ngoài details.
- Nhãn tên nhân viên dùng toàn bộ hình chữ nhật để tránh bị thanh công cụ che; danh sách văn bản vẫn chứa mọi nhân viên kể cả nhãn bị rút gọn khỏi cảnh.
- Các kiểm tra an toàn gửi tin, phê duyệt đúng phiên bản, khôi phục và nội dung không tin cậy được giữ nguyên; thay tên truy vấn kiểm thử khi nhãn người dùng đổi. Không sửa cấu hình test hoặc loại bỏ kiểm tra để làm xanh.

## Kết quả xác minh cuối

- Build/typecheck ứng dụng Web: đạt. Dependency graph: đạt, không đổi root config/lockfile/contracts.
- Unit/component: 51 tệp, **543/543** bài đạt.
- Browser E2E trên Chrome thật, assets production + Local Server: **37 đạt, 1 bỏ qua**. Bài bỏ qua yêu cầu môi trường provider/Herdr live; không chạy trong đợt sửa giao diện này. Không coi backend kịch bản là bằng chứng SDLC thật.
- Đã kiểm tra các trang Projects, Tổng quan, Công việc, Trò chuyện, Nhân viên, Cần bạn quyết định, Sự cố và Cài đặt; trạng thái có dữ liệu dùng backend kiểm thử, trạng thái dự án dừng được xem trực tiếp trên ứng dụng thật.
- Responsive: 375, 768, 1024, 1099, 1100, 1280, 1440, 1920px; thêm 812×375. Kiểm tra không tràn ngang, cảnh/bảng không giao nhau, camera giữ đối tượng, ô nhập/nút Gửi không bị cắt, bản nháp qua đổi bố cục, keyboard focus và reduced motion.
- Chat giữ diện tích ngay cả khi đã có nhiều thao tác: lịch sử kết quả thu gọn theo nhu cầu; cảnh báo kết quả chưa rõ nằm ngoài phần thu gọn. Reviewer độc lập xác nhận không đổi xử lý lệnh.
- Kiểm tra mất ACK/khởi động lại, quyết định xung đột giữa hai tab, hết hạn phiên, mất WebGL, CSP, nội dung HTML/SVG độc hại và rò rỉ context đều đạt trong bộ browser cục bộ.
- Ảnh và log cục bộ nằm trong apps/web/dist (không commit). Preview tại http://127.0.0.1:4320 phục vụ build từ worktree này.
