# Review và khắc phục P17

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

Đã review bản triển khai tại `01eba53` đối chiếu với các contract v2, codec nội dung artifact
P15, ranh giới strategy P16, và các policy verification cấp task/workflow đã được chấp nhận.
Yêu cầu review cũng ủy quyền việc sửa lỗi và tích hợp vào main cục bộ.

Đã tái hiện tám lỗi trước khi thay đổi bản triển khai (49 test hiện có vẫn pass). Đã thêm các
case bổ sung cho change-set ID/revision bị dùng lại, provenance workflow đầy đủ và tái sử dụng
coverage dưới ngưỡng. Bộ regression nay bao phủ:

- Từ chối attempt, change-set ID hoặc Git revision đã dùng ở bất kỳ đâu trong cycle, kể cả các
  iteration trước đó không liền kề. Chỉ kiểm tra iteration liền trước từng cho phép dùng lại
  danh tính submission cũ hơn.
- Yêu cầu evidence pass hợp lệ từ mọi check đã lập kế hoạch của một criterion. Trước đây một
  primary test pass vẫn để criterion ở trạng thái passed dù một check bổ sung được ánh xạ trả
  về evidence sai định dạng/thiếu.
- Chỉ tái sử dụng các check thành công hoàn toàn. Một gate được gắn nhãn passed vẫn có thể có
  review exit thất bại hoặc coverage đo được không đủ; các check đó phải chạy lại.
- Từ chối kết quả gate mới có timestamp đánh giá trước dispatch hoặc sau collection theo đồng
  hồ của trusted host. Các receipt bất biến trước đó chỉ được tái sử dụng qua đường impact/receipt
  được xác thực riêng.
- Từ chối biểu thức glob `*`/`?` trong các đường dẫn scope/dependency literal của repository;
  coi glob là literal một cách âm thầm có thể bỏ qua một check bị ảnh hưởng.
- Yêu cầu provenance tích hợp workflow bao phủ mọi task ID được truy vết trong specification đã
  phê duyệt, từ chối ID trùng lặp, và chuyển tiếp ngữ cảnh tích hợp tới runner độc lập. Thành công
  cấp task vẫn không đủ.
- So sánh approved strategy policy tách biệt với metadata `tddEvidence` chỉ-append của P16. Xác
  thực hình dạng receipt/run/task và giữ nguyên mọi tiền tố receipt đã phê duyệt mà không thay đổi
  specification đã chấp nhận. P19 vẫn thực thi trình tự phase P16 và độ đầy đủ của dossier.
- Phát ra finding có phạm vi cho mỗi check/criterion thất bại quan sát được, kể cả khi gate khác
  đã phát ra lỗi. Kèm theo evidence artifact và task/role Developer chịu trách nhiệm, để một lỗi
  không che giấu nghĩa vụ sửa thứ hai.

Các ranh giới port hiện có vẫn giữ nguyên: tính độc lập thực sự của OS/process và trạng thái Git
do trusted host thiết lập; Runtime cung cấp cycle mới nhất và thực thi optimistic version, lease,
giới hạn rework của Core và dispatch an toàn. Package này không xác thực tiến trình, không triển
khai P19, không gửi thông điệp và không thực hiện Git merge. Không có thay đổi shared contract,
migration, bootstrap adapter hay direct shell runner nào được đưa vào. Việc đăng ký build/lockfile/
tài liệu gốc được xử lý riêng trên nhánh tích hợp theo ủy quyền merge của người dùng.

Xem [VALIDATION.md](VALIDATION.md) cho evidence triển khai ban đầu và evidence đóng tích hợp được
bổ sung trong quá trình xác thực merge cục bộ. Bản triển khai gốc và các bản sửa review được giữ
trong lịch sử Git.
