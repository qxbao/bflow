# Kế hoạch văn phòng 3D tương tác như game

Trạng thái: phase1–4 source đã triển khai phía sau feature flag opt-in, có kiểm thử package-local. Phase5 có bằng chứng browser cục bộ cho các đường tương tác được nêu trong [báo cáo Task5](2026-11-05-immersive-office-task-5-report.md); đây chưa phải chấp nhận live/provider hoặc nghiên cứu người dùng. Bản UI 3D ổn định vẫn mặc định.

## Trải nghiệm hướng tới

Người dùng bước vào văn phòng, chạm vào Director để trao đổi, đến bảng công việc để xem tiến độ và mở hộp thư để trả lời yêu cầu. Mỗi lần chỉ hiện một tương tác ngắn, gắn với đúng người hoặc đồ vật. Không cần hiểu Runtime, pane, lease hay quy trình kỹ thuật để giao việc.

Không ép người dùng di chuyển nhân vật chỉ để thực hiện thao tác cơ bản. Luôn có nút nhảy tới khu vực, điều khiển bàn phím và chế độ danh sách tương đương. Di chuyển và hoạt ảnh chỉ diễn giải dữ liệu; nhân vật chạy xong không có nghĩa là công việc hoàn tất.

## Giới hạn phải giữ

- Dữ liệu, quyền xác nhận, phiên bản công việc và kết quả thao tác vẫn do các API/Runtime hiện có quyết định. Tương tác 3D chỉ thay cách trình bày.
- Trò chuyện không thay thế phê duyệt. Chọn “Duyệt” luôn phải hiện đúng câu hỏi, tài liệu và phiên bản trước khi gửi.
- Không tự thử lại lệnh chưa rõ kết quả; giữ mã thao tác, bản nháp và khả năng đối chiếu qua tải lại/mất kết nối.
- Nội dung terminal của nhân viên luôn được đánh dấu có thể thiếu, chưa xác minh; không trình bày thành bằng chứng hoàn thành.
- Không đổi public contracts, quyền provider hay giới hạn sandbox trong phạm vi Web. Nhu cầu API mới phải được chủ sở hữu tích hợp duyệt riêng.

## Giai đoạn 1 — Đi lại và chọn đối tượng

**Đường dẫn:** features/office/scene/{renderer,camera,world}.ts, features/office/ui/{OfficeStage,AccessibleOffice,OfficeHud}.tsx.

- [ ] Dựng nguyên mẫu tương tác trên cảnh hiện có: hover/focus có viền chọn; click/tap chọn; Escape bỏ chọn; Tab/Enter làm được cùng việc.
- [ ] Tách các trạng thái nhìn toàn cảnh, đi đến khu vực, đang chọn và đang tương tác. Chuyển trạng thái không làm mất bản nháp hoặc chọn nhầm đối tượng phía sau.
- [ ] Click để di chuyển, kéo để xoay/di chuyển camera có ngưỡng rõ ràng; có nút thay thế thao tác kéo. Không chiếm phím khi người dùng đang nhập chữ.
- [ ] Kiểm tra resize/zoom 200%, đổi hướng màn hình, cảm ứng và reduced motion giữa lúc camera đang chạy.

**Đạt khi:** người mới chọn được Director, bảng công việc và hộp thư bằng chuột, cảm ứng hoặc bàn phím; không cần mở bảng Web bên phải.

## Giai đoạn 2 — Hội thoại tại bàn Director

**Đường dẫn:** thêm ui/interaction/DirectorDialogue.tsx; tái sử dụng features/director/{status,transcript,chat}.tsx qua phần điều khiển gửi tin được tách dùng chung.

- [ ] Hội thoại hiện ở lớp giao diện trong cảnh, neo theo bàn Director; khung đọc có chiều rộng phù hợp, ô nhập ở vị trí ổn định.
- [ ] Hiện câu chào và một số gợi ý có thể sửa trước khi gửi: giao việc, hỏi tiến độ, giải thích việc đang chờ. Không tự gửi khi chọn gợi ý.
- [ ] Tách điều khiển gửi/đối chiếu khỏi giao diện hiện tại trước khi thay UI; giữ nguyên kiểm tra phiên, khóa trình duyệt, mã tin và giới hạn nội dung.
- [ ] Kiểm tra nhập tiếng Việt, Shift+Enter, chậm phản hồi, mất ACK, đổi phiên, gửi hai lần nhanh, chuyển chế độ khi còn bản nháp.

**Đạt khi:** toàn bộ kiểm thử chống gửi trùng vẫn đạt; bản nháp không mất khi rời bàn; tin nhắn dài và bàn phím ảo không che ô nhập.

## Giai đoạn 3 — Công việc và quyết định trong cảnh

**Đường dẫn:** thêm ui/interaction/{TaskBoard,DecisionInbox,TaskDetail}.tsx; dùng lại features/{runs,decisions,review} và API commands hiện có.

- [ ] Bảng công việc có ba lớp: nhìn tổng quan, chọn thẻ, xem chi tiết. Mỗi thẻ ưu tiên tên việc, tiến độ và bước tiếp theo.
- [ ] Hộp thư có số yêu cầu đang chờ, mở từng yêu cầu để đọc, xem bằng chứng và đưa quyết định.
- [ ] Quyết định quan trọng mở khung tập trung đủ lớn, che tương tác phía sau, có nút quay lại và focus đúng; không dùng chữ nhỏ trên texture 3D cho văn bản dài.
- [ ] Giữ liên kết trực tiếp tới công việc/yêu cầu, Back/Forward, bản nháp lý do quyết định và kiểm tra phiên bản mới trước khi gửi.

**Đạt khi:** chủ dự án theo dõi một công việc và xử lý một yêu cầu duyệt hoàn toàn trong trải nghiệm 3D; quyết định cũ bị từ chối an toàn và có hướng cập nhật.

## Giai đoạn 4 — Nhân viên, thông báo và hướng dẫn

**Đường dẫn:** ui/interaction/{AgentDialogue,OfficeNotifications,FirstVisit}.tsx; model/{derive,timeline,labels}.ts.

- [ ] Chọn nhân viên để thấy “đang làm gì / chờ ai / xem công việc”; nội dung kỹ thuật chỉ mở theo nhu cầu.
- [ ] Thông báo gọn ở một vị trí ổn định; yêu cầu cần trả lời có lối tới hộp thư; không treo bảng lỗi lớn giữa cảnh.
- [ ] Lần đầu chỉ hướng dẫn ba thao tác, từng bước, có Bỏ qua và Xem lại.
- [ ] Cập nhật cảnh từ model hiện tại, không polling thêm cho từng nhân vật; chuyển trạng thái có ý nghĩa, giảm hiệu ứng khi máy chậm.

**Đạt khi:** người mới hoàn thành hành trình bắt đầu phiên → giao việc → tìm việc đang chạy → trả lời yêu cầu mà không cần người hướng dẫn giải thích thuật ngữ.

## Giai đoạn 5 — Kiểm tra và phát hành từng phần

- [ ] Feature flag riêng, mặc định giữ trải nghiệm ổn định; thử từng tương tác trước khi thay toàn bộ bảng chi tiết.
- [ ] Browser E2E với backend kịch bản: ready/stopped/offline/stale/session changed, thao tác chưa rõ kết quả, lỗi assets và mất WebGL context.
- [ ] Đo trên máy tham chiếu được ghi cấu hình: mục tiêu tối thiểu 30fps khi thao tác, phản hồi nút trong 100ms, một WebGL context hoạt động, không tăng bộ nhớ liên tục sau 20 vòng vào/ra.
- [ ] Kiểm tra 375×812, 812×375, 768×900, 1099×900, 1100×900, 1440×900 và 1920×1080; zoom 200%, bàn phím, reduced motion và tương phản.
- [ ] Thử với ít nhất 5 người chưa dùng Bflow: ít nhất 4 người hoàn tất các bước cốt lõi mà không cần trợ giúp; ghi thời gian và điểm hiểu sai trước khi quyết định mở mặc định.
- [ ] Chạy một workflow thật có provider/Herdr sau khi các kiểm tra cục bộ đạt, rồi chiến dịch lỗi kết nối. Phân biệt rõ kết quả UI giả lập với bằng chứng workflow thật.

**Điểm duyệt tiếp theo:** duyệt nguyên mẫu tương tác ở giai đoạn 1 và 2 trước khi đầu tư vào nhân vật điều khiển được, âm thanh, hoặc thay đổi mô hình camera lớn hơn. Chưa ước lượng lịch cố định trước nguyên mẫu vì phần xử lý cảm ứng, văn bản dài và hỗ trợ bàn phím có thể quyết định lại cách bố trí cảnh.

### Evidence log — Task5, 2026-11-05

- Feature flag kiểm tra bằng build `VITE_BFLOW_IMMERSIVE_OFFICE=true`; không thay đổi cấu hình máy hoặc provider. Build mặc định không bật interaction layer.
- Chrome thật và Local Server scripted backend kiểm tra Director dialogue, lost ACK sau commit, một hiệu ứng duy nhất, đối chiếu bằng ID gốc, nội dung trạng thái, gợi ý dạng disclosure và khả năng thao tác các nút đóng/đọc/khởi động/đối chiếu.
- Ma trận viewport 375×812, 812×375, 768×900, 1099×900, 1100×900, 1440×900 và 1920×1080: không tràn ngang; hit-test các nút cốt lõi. Touch dùng Chrome DevTools Protocol emulation; reduced motion dùng Playwright media emulation.
- Mục zoom 200% dùng `document.documentElement.style.zoom = '2'` như mô phỏng CSS; không phải browser zoom phần cứng hay kiểm tra bàn phím di động thật. Ảnh landscape: `dist/test-results/task9/14-office3d-landscape-lost-ack.png` (ignored).
- Đo trên build trước HUD-fix (`23e23d1a`) bằng headless SwiftShader: 5.44 fps toàn cửa sổ khi di chuyển (mục tiêu30 fps: chưa đạt), phản hồi TaskBoard207 ms (mục tiêu100 ms: chưa đạt), 1 WebGL context đang mở/0 sau đóng; heap sau GC `8.33/8.96/9.34/9.44/9.47 MiB` ở 0/5/10/15/20 lần vào/ra (đoạn cuối tăng nhẹ, không chứng minh không rò rỉ). Chi tiết máy và lệnh ở [báo cáo Task5](2026-11-05-immersive-office-task-5-report.md); HUD-fix chưa được đo lại, cổng performance và mở mặc định vẫn đóng.
- Kiểm tra sau HUD-fix: `office-a11y`6/6, `office-csp`3/3, lost-ACK landscape2/2, unknown-delivery/lost-WebGL2/2. Browser workflow/mod/modal helper changes chưa được chạy toàn bộ; affected selector và Web package suite đang thuộc parent.
- Còn pending: browser fault matrix cuối cùng cho stopped/offline/stale/session-changed/unknown operation và asset failure; kiểm tra thủ công bằng browser zoom/keyboard/AT/độ tương phản; 5 người mới dùng; live provider/Herdr và chiến dịch lỗi kết nối. Không suy diễn các bằng chứng này từ fixture hoặc lịch sử nhánh khác.
