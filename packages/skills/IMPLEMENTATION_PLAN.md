# Phạm vi đã duyệt và kế hoạch nghiệm thu P28

Yêu cầu của owner cho phép triển khai thiết kế skills của P24. Baseline a39374d
giữ P24 8dbb056; các schema công khai không đổi. Chỉ packages/skills và skills
bị thay đổi. Không bao gồm database migration, thay đổi provider-home, thay đổi CLI parser hay
thay đổi build/lock gốc.

1. Triển khai validate nghiêm ngặt SKILL.md / skill.json, băm nội dung đầy đủ có giới hạn,
   kiểm tra tham chiếu cục bộ, từ chối lệnh không được hỗ trợ, và lưu trữ riêng tư bất biến.
2. Triển khai install/update/list catalog theo exact-pin, kiểm tra approval đáng tin cậy, phân giải
   dependency, ủy quyền role/provider/capability/tool và các manifest mang tính xác định.
3. Render các manifest provider chỉ chứa metadata/tham chiếu cùng các bundle on-demand được chọn;
   giữ nguyên role prompt và thứ tự ưu tiên chính sách. Xuất setup synchronizer và các helper cấu hình
   repository cho các integration owner; không bao giờ ngụ ý rằng các CLI handler không tồn tại sẽ chạy.
4. Phát hành mọi skill dùng chung và skill theo role với các ví dụ cục bộ thực tế và metadata đầy đủ.
5. Thực thi các trường hợp metadata/tham chiếu/lệnh sai định dạng, tên trùng lặp, tương đương giữa provider,
   ủy quyền/approval lỗi thời, cập nhật bất biến, config được bảo toàn và phục hồi.
6. Chạy các kiểm tra package cùng các kiểm tra repository bắt buộc và commit các thay đổi thuộc sở hữu.

Nghiệm thu: cả 20 ID dùng chung và mọi role binding được yêu cầu đều tồn tại; các bundle trung lập
với model dùng frontmatter name/description chuẩn. Không skill nào thực thi hook, cấp
quyền, miễn Conditional TDD hay cho phép specialist hỏi trực tiếp người dùng.
Machine catalog bytes và session manifest là bất biến. Nội dung bắt buộc nhưng không khả dụng
sẽ chặn việc phân giải. Các live session tiếp tục dùng pin cũ sau khi cập nhật. Đầu ra provider
chỉ chứa name/description/entrypoint được chọn và danh tính manifest, không bao giờ chứa
toàn bộ thư viện instruction. Runtime giữ các gate độc lập và các quyết định đã xác thực.

Chính sách triển khai: các test thất bại bắt buộc phải có trước cho hành vi resolver/storage;
các ví dụ chỉ có nội dung dùng validate cấu trúc. Việc kích hoạt Runtime/CLI đầy đủ thuộc về
P29/P30 và được ghi tài liệu tường minh là một dependency tích hợp.
