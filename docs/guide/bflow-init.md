# Khởi tạo dự án (`bflow init`)

```bash
bflow init --name my-project
bflow init --dir /absolute/path/to/my-project --json
```

Lệnh `bflow init` bắt buộc phải được thực thi trong một checkout Git hợp lệ. Lệnh sẽ tự động phát hiện đường dẫn gốc chuẩn (canonical Git root) ngay cả khi được gọi từ một thư mục con, sau đó sinh tệp cấu hình `.bflow/config.yml` cùng tệp `.bflow/.gitignore`. Lệnh này chỉ thực hiện tạo cấu hình cục bộ; không tương tác với Herdr, không tạo pane và không khởi chạy bất kỳ tiến trình agent nào. Tham số tùy chọn `--config` chỉ chấp nhận đường dẫn trỏ chính xác tới tệp `.bflow/config.yml` của checkout hiện tại, không hỗ trợ chuyển hướng lưu trữ cấu hình môi trường sang vị trí khác.

---

## 1. Cấu trúc và định dạng tệp cấu hình

Tệp cấu hình được định dạng theo chuẩn YAML 1.2 có kèm các dòng chú thích chi tiết. Các trường cấu hình về vai trò (`role`), nhà cung cấp (`provider`), mô hình (`model`) và mức độ tính toán (`effort`) được đặt ở phần đầu tệp nhằm thuận tiện cho việc chỉnh sửa, đứng trước các trường định danh và lưu trữ vốn ít khi thay đổi. 

Bflow phân tích tệp YAML với quy chuẩn an toàn nghiêm ngặt: chỉ chấp nhận một tài liệu đơn lẻ và các khóa ánh xạ phải ở dạng chuỗi ký tự; hệ thống không hỗ trợ explicit tags, merge keys hoặc alias vòng lặp (circular aliases). 

Các trường `model` và `effort` là tùy chọn cho từng vai trò:
- **Claude**: Hỗ trợ các mức effort: `low | medium | high | xhigh | max`.
- **Codex**: Hỗ trợ các mức effort: `minimal | low | medium | high | xhigh`.
- **Agy**: Mã hoá trực tiếp mức độ effort vào tên mô hình, do đó không sử dụng trường `effort` riêng.

---

## 2. Di chuyển từ các phiên bản cấu hình cũ (`config-migrate`)

Các repository được khởi tạo từ các bản phát hành trước đó có thể vẫn đang sử dụng `.bflow/config.yaml` hoặc `.bflow/config.json`. Để chuyển đổi sang tệp cấu hình chuẩn hóa mới, hãy thực hiện lệnh:

```bash
bflow config-migrate
```

Quy trình di chuyển cấu hình:
1. Kiểm tra tính hợp lệ của tệp cấu hình hiện hữu.
2. Ghi nội dung nguyên bản sang tệp chuẩn `.bflow/config.yml`.
3. Sao lưu tệp gốc thành `.bflow/config.yaml.bak` hoặc `.bflow/config.json.bak`.
4. Gỡ bỏ tệp cấu hình cũ.

*Lưu ý*: Nếu phát hiện nhiều tệp cấu hình cũ cùng lúc, đã tồn tại sẵn tệp sao lưu `.bak`, hoặc đồng thời tồn tại cả tệp chuẩn lẫn tệp cũ, lệnh sẽ dừng lại và yêu cầu người vận hành xử lý xung đột thủ công để đảm bảo an toàn tuyệt đối.

---

## 3. Tính lũy thừa và cờ ghi đè cấu hình

Theo cơ chế mặc định, lệnh `init` sẽ bảo lưu nguyên vẹn tệp cấu hình nếu đã tồn tại từ trước. **Tuy nhiên trong phiên bản hiện tại, khi truyền các cờ `--force`, `-f`, `--yes` hoặc `-y`, hệ thống sẽ ghi đè toàn bộ cấu hình về các giá trị mặc định ban đầu** (dù nội dung trợ giúp ở một số tài liệu cũ ghi là luôn bảo lưu). Hành vi ghi đè này đã được kiểm chứng thực tế trong môi trường tạm thời. Tuyệt đối không dùng các cờ này để khôi phục hoặc khắc phục lỗi phiên; hãy chủ động sao lưu và so sánh diff nếu muốn tái tạo lại cấu hình.

Các trường như `environment.repositoryId`, `workspaceRoot`, `sessionName` được sinh tự động dựa trên thư mục gốc canonical và đường dẫn Git nội bộ. Do đó, hai repository có cùng tên gọi hoặc hai linked worktree khác nhau vẫn sở hữu định danh hoàn toàn tách biệt. Tuyệt đối không sao chép tệp cấu hình đã gắn kết định danh giữa các bản clone, máy ảo hoặc worktree khác nhau. Khuyến nghị theo dõi [mẫu dự án chuẩn (portable template)](../../templates/node-typescript/README.md) thay vì lưu vết cấu hình mang định danh cục bộ vào kho mã nguồn.

---

## 4. Áp dụng mẫu cấu hình quy trình

Trước khi thực hiện lệnh `bflow up` lần đầu tiên, bạn có thể áp dụng các mẫu quy trình công việc có sẵn:

```bash
node "$BFLOW_HOME/templates/node-typescript/apply.mjs" . feature
```

Kịch bản hỗ trợ này sẽ giữ nguyên các thông tin môi trường, định danh và lưu trữ từ bước `init`, đồng thời cập nhật `defaultWorkflow` cùng các chính sách liên quan từ fragment. Kịch bản luôn xác thực tính hợp lệ của cấu hình mới bằng trình nạp thực tế trước khi ghi tệp và tự động tạo bản sao lưu trong thư mục `.bflow/data/`. Kịch bản sẽ từ chối thực thi nếu phát hiện thư mục `.bflow/state` đã tồn tại (kể cả liên kết mềm dangling symlink). Nếu checkout của bạn vẫn còn tệp cấu hình cũ, hãy chạy `bflow config-migrate` trước khi áp dụng mẫu.
