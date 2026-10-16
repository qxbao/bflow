# bflow attach

```sh
bflow up
bflow attach
```

Attach kiểm tra manifest/session matching, yêu cầu P13 focus pane Conversation
(`chat`), rồi chạy Herdr attach với terminal I/O kế thừa. Nó không tạo môi trường
mới và không attach vào Coordinator hoặc Developer. `--json` không thay thế nhu
cầu terminal tương tác của giao diện Herdr.

Nếu chưa có manifest hoặc server đã dừng, dùng status/doctor và recovery trước.
Thoát client terminal không chứng minh server, agent hoặc workflow đã dừng.
Host P19 phải nối Conversation Gateway với user turn có provenance; thấy prompt
chat trong pane không chứng minh đã có kết nối policy/evidence đó.

Để kiểm tra thủ công, dùng `bflow status --json` từ terminal khác. Các quan sát
được lưu trên đĩa có thể cũ; `transportState: done` chỉ là kết thúc lượt agent,
không phải run `succeeded` hoặc SDLC `completed`.
