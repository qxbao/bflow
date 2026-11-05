# bflow web: lần chạy mới thay Web owner cũ

Chủ dự án yêu cầu ngày 2026-11-05: dừng các Web process cũ, sửa luôn lệnh để lần chạy mới thay bản đang chạy. Đã dừng PID 495948 (Web 4317) và 343018 (Vite 5199); không dừng Runtime/Gateway/provider.

Phạm vi: apps/cli. Không thay public contracts. Dùng cơ chế /verify → /retire đã có, receipt HMAC và kernel state lock; không quét PID hoặc pkill theo tên trong lệnh sản phẩm.

## Tiêu chí

- Mỗi lần chạy mới trong cùng machine state tiếp quản Web owner đã xác minh, cả khi build không đổi; owner cũ đóng listener, dọn locator/snapshot và thoát.
- Lần chạy mới có thể chọn cổng khác. Nếu cổng đích bị tiến trình khác chiếm hoặc assets chưa sẵn sàng, báo lỗi trước khi dừng owner cũ.
- Giữ registry/lịch sử trên đĩa; phiên cookie cũ hết hiệu lực và trình duyệt được mở bằng mã mới. Không khởi động/dừng Runtime, không gửi lại lệnh đang chưa rõ kết quả.
- Nếu còn lifecycle effect chưa xong, từ chối thay thế và giữ owner cũ; lệnh nêu rõ cách thử lại. Owner không xác minh được hoặc phiên bản cũ không hỗ trợ retirement: từ chối an toàn, không kill PID đoán.
- BFLOW_HOME/stateDirectory khác nhau vẫn độc lập. Không dừng worker/provider/Gateway hoặc dịch vụ không phải owner đã xác thực.

## Các bước

- [x] Viết/rerun kiểm tra HTTP cùng build, cookie/registry, đổi cổng, cổng bị chiếm, pending effect; quan sát lỗi trước sửa.
- [x] Bỏ đường reuse cùng build; kiểm tra cổng đích trước retirement; cập nhật help và package README.
- [x] Build CLI/Web; kiểm tra vòng đời bằng child process thật: latest PID nhận HTTP, old PID thoát, SIGTERM old không dừng latest.
- [x] Rà độc lập và chạy các kiểm tra CLI/Local Server liên quan.
- [ ] Đưa mã đã xác minh vào checkout mà launcher bflow đang trỏ tới, build và khởi động một Web owner mới; kiểm tra cổng/PID cuối.

TDD required cho thay đổi lifecycle; pure docs dùng review. Không chỉnh root config/lockfile hay shared docs.

## Bằng chứng

- Baseline: 20/20 kiểm tra web-command/server-integration đạt. Kiểm tra mới thất bại trước sửa: cùng build bị reuse, đổi cổng bị từ chối, pending effect cùng build không chặn thay thế.
- Sau sửa: 23/23 kiểm tra HTTP/lifecycle đạt, gồm cookie cũ 401, registry giữ nguyên, cùng build thay control identity, owner cũ đóng không ảnh hưởng owner mới, cổng bị chiếm giữ owner cũ, pending lifecycle không gửi lại.
- Child process CLI thật: 3 lần chạy liên tiếp trong cùng BFLOW_HOME, lần hai cùng build/cùng port và lần ba đổi port; hai PID trước thoát exit 0, chỉ PID mới còn trả HTTP. Kiểm tra đạt, không sử dụng Herdr/provider.
- Build CLI, dependency graph, typecheck workspace đạt. Reviewer độc lập không tìm thấy blocker/important regression.
- Giới hạn đã có của cơ chế thay Web owner: cổng vẫn có thể bị một process khác chiếm sau preflight và trước bind thực tế; lệnh báo EADDRINUSE, giữ dữ liệu trên đĩa và không dừng listener ngoài. Không tuyên bố chuyển socket nguyên tử.
