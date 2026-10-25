# Đọc cập nhật và trả lời trong Conversation

Sau `bflow up` → `bflow attach`, bạn làm việc với Conversation bằng tiếng Việt thông thường. Cập nhật cần nói rõ chuyện gì xảy ra, ảnh hưởng đến công việc và bước bạn cần làm. Chi tiết JSON, ID nội bộ, tên công cụ và URI artifact được giữ cho phần chẩn đoán khi cần.

## Nhận diện công việc và thẻ thông báo

| Nhãn | Ý nghĩa | Cách dùng |
| --- | --- | --- |
| `Việc #2: Sửa lỗi tính tổng` | Nhãn của một workflow trong phiên hiện tại | Hỏi tiến độ, sửa yêu cầu, tiếp tục hoặc hủy đúng việc |
| `#3` | Mã của thẻ cần quyết định hoặc đang báo vướng mắc | Trả lời theo hướng dẫn của thẻ; yêu cầu xem chi tiết đúng thẻ |
| `1`, `2`, … | Lựa chọn của câu hỏi hiện tại | Đọc nhãn lựa chọn trước khi trả lời; các số không có ý nghĩa chung cho mọi gate |

`#3` và `Việc #3` thuộc hai miền khác nhau. Nhắc tên một việc không có nghĩa là đã trả lời thẻ duyệt có cùng số. Alias được giữ trong receipt của phiên; không dùng mã của phiên khác hoặc tự đoán mã cho notice cũ chưa có alias.

## Trả lời quyết định

Ví dụ một thẻ phê duyệt có thể hiển thị:

```text
🔔 Cần bạn duyệt · #3
Việc #2: Sửa lỗi tính tổng
Cần bạn duyệt: đặc tả và phạm vi sửa lỗi
  1. Đồng ý
  2. Chưa đồng ý (ghi lý do)
```

Bạn có thể trả lời `#3: đồng ý`, `#3: 1` hoặc `#3: 2 cần làm rõ trường hợp tràn số`. Khi có nhiều câu hỏi chờ, dùng mã thẻ để chỉ rõ câu bạn đang trả lời. Với câu hỏi có các lựa chọn khác, làm theo đúng nội dung của thẻ; đừng mặc định số `1` luôn là phê duyệt.

Trong thẻ phê duyệt chuẩn, lựa chọn từ chối không tự sửa đặc tả hoặc tạo một vòng rework. Muốn đổi yêu cầu, mô tả revision cần áp dụng cho đúng việc. Hệ thống vẫn kiểm tra human turn, approval, revision/generation và hạn hiệu lực. Thẻ đã hết hạn, đã đóng hoặc mã không biết không được chuyển thành quyết định cho thẻ khác.

Thời hạn được hiển thị theo giờ địa phương của host và tính thời gian còn lại lúc render. Đây là cách trình bày; hạn thực thi vẫn lấy từ approval đã lưu, không được gia hạn bởi việc đọc lại thông báo.

## Tiến độ, vướng mắc và hủy việc

Các câu dưới đây được gửi **trong Conversation**, không phải lệnh shell:

```text
Tiến độ việc #2 thế nào?
Xem chi tiết #3
Xem chi tiết việc #2
Tiếp tục việc #2
Hủy việc #2
```

Chỉ dùng “tiếp tục” khi đã xử lý đúng bước đang chờ. Nếu thẻ nói hệ thống sẽ tự thử lại, bạn chưa cần gửi thêm lệnh. Nếu cần sửa yêu cầu hoặc phê duyệt, thao tác tiếp tục không thay thế quyết định đó. Thẻ vướng mắc có mã `#n` cũng không tự trở thành một approval chỉ vì bạn trả lời bằng số.

`Việc #k` khi xem chi tiết chọn notice liên quan gần nhất theo kho của phiên, không trả toàn bộ lịch sử. Muốn điều tra một thẻ cụ thể, dùng `#n`; muốn xem diễn biến kỹ thuật, mở tab **Logs**.

## Chi tiết kỹ thuật và giới hạn hiển thị

Tab Log hiển thị các dòng chẩn đoán có giới hạn: mã thẻ/việc, loại thông điệp, vai trò, lý do và artifact liên quan. Các trường được che bí mật, làm sạch ký tự terminal và cắt theo giới hạn. Log là chẩn đoán best-effort; không thay journal, receipt hay bằng chứng nghiệm thu có thẩm quyền.

Conversation lấy cập nhật qua công cụ host `read_updates`; đây **không phải** subcommand `bflow read_updates` để bạn tự chạy. Hook gửi lời nhắc gọn, model lấy các thẻ đã render rồi trình bày lại. Có thể vẫn thấy output riêng của provider; các thay đổi này không chứng nhận mọi layout/provider UI đều ẩn được log nội bộ.

Hệ thống phân biệt notice đã đến host, đã được đưa cho model và đã được trình bày trong câu trả lời. Nhận notice hoặc xác nhận hiển thị không phải phê duyệt, không chứng minh bạn đã đọc và không chứng minh task thành công. Nếu Conversation chưa trình bày một notice cần thiết, Stop hook có thể nhắc lại trong ngân sách hiện có. Alias được so khớp nguyên token: `#1` không khớp `#12` hoặc `Việc #1`.

Các hành vi mới có source và test cục bộ. Chưa có nghiệm thu provider thật đầy đủ cho luồng từ notice đến quyết định và bàn giao. Agy Conversation vẫn unsupported; native user-input provenance và các human gate không được thay thế bởi thẻ tiếng Việt.

Nguồn kỹ thuật: [host/read_updates](../../packages/runtime/src/agentic/host.ts), [notice receipts](../../packages/runtime/src/agentic/host-receipts.ts), [renderer/ACK](../../packages/runtime/src/agentic/conversation-notice-render.ts), [Conversation classifier](../../packages/conversation/src/intent-classifier.ts). Xem thêm [bảo mật và phê duyệt](security-approval.md), [khôi phục phiên](session-recovery.md) và [đối chiếu commit mới](../main-updates-2026-10-25.md).
