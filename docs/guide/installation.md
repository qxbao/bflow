# Hướng dẫn cài đặt (Installation)

Nền tảng kiểm chứng chính thức của Bflow là môi trường Linux với Git và hệ thống tệp tin cục bộ. Hệ thống yêu cầu phiên bản **Node.js `>= 22.13`** (nhằm hỗ trợ mô-đun SQLite tích hợp sẵn `node:sqlite` mà không cần cờ thử nghiệm) và công cụ **pnpm** khớp chính xác với khai báo `packageManager` trong `package.json` (hiện tại là `12.5.1`). Lưu ý rằng khai báo `engines >= 22` ở cấp root rộng hơn so với yêu cầu phiên bản SQLite thực tế. Các kịch bản chạy native trên Windows, hệ thống tệp tin mạng (NFS/SMB), phân tán đa máy chủ hoặc khôi phục sau sự cố mất điện đột ngột (power-loss recovery) hiện chưa được kiểm chứng đầy đủ.

Hiện tại Bflow và gói `@bflow/cli` được cấu hình ở chế độ riêng tư (`private`); tài liệu này hướng dẫn thao tác trực tiếp trên mã nguồn được clone về, không giả định việc cài đặt toàn cục qua `npm install -g bflow`.

---

## 1. Biên dịch và kiểm tra mã nguồn

Thực hiện sao chép mã nguồn và biên dịch toàn bộ workspace:

```bash
git clone https://github.com/qxbao/bflow.git
cd bflow
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/bin.js --help
node templates/node-typescript/verify.mjs
```

Mọi câu lệnh mẫu bắt đầu bằng `bflow ...` trong các tài liệu hướng dẫn đều có thể thực thi tương đương thông qua:
```bash
node "$BFLOW_HOME/apps/cli/dist/bin.js" ...
```
Trong đó, `BFLOW_HOME` là biến môi trường lưu đường dẫn tuyệt đối tới thư mục mã nguồn Bflow đã được biên dịch thành công. Bạn cũng có thể liên kết tệp thực thi vào hệ thống bằng lệnh `pnpm --filter @bflow/cli link --global` nếu môi trường pnpm của bạn đã cấu hình sẵn đường dẫn biến môi trường toàn cục (global bin path). Tuy nhiên, cách gọi trực tiếp qua Node.js luôn đảm bảo tính ổn định và không đòi hỏi bước liên kết này.

---

## 2. Cài đặt và xác thực Herdr CLI

Herdr là một thành phần phụ thuộc độc lập bên ngoài, không nằm trong các gói cài đặt tự động của Bflow. Bạn cần cài đặt Herdr theo tài liệu chính thức tại [Herdr](https://herdr.dev), sau đó xác minh sự hiện diện của tệp thực thi trên máy:

```bash
herdr --version
herdr --help
```

Các lệnh trên đã được kiểm chứng trực tiếp trên bản phát hành Herdr `0.9.5`. Cần lưu ý rằng nhãn phiên bản chỉ mang tính chất tham chiếu và chẩn đoán; Bflow kiểm tra trực tiếp tính tương thích của giao thức (Protocol `22` / Schema `1`) và phản hồi thực tế của từng thao tác (operation), chứ không giới hạn theo một danh sách phiên bản phát hành cố định.

Đối với CLI của các agent (như Claude Code, Codex hay Agy), hãy cài đặt và hoàn tất đăng nhập theo quy trình chuẩn của từng nhà cung cấp. Tuyệt đối không lưu trữ khóa API (API key), thông tin xác thực hoặc bí mật vào các tệp cấu hình JSON, prompt mẫu hoặc các lệnh được commit vào repository.

---

## 3. Lưu ý khi phát triển

- Luôn chạy lệnh `pnpm build` trước khi thực thi các ví dụ mẫu hoặc chạy các bài kiểm thử có mục tiêu (targeted test), bởi các bài kiểm thử này sẽ nạp trực tiếp mã nguồn đã biên dịch từ thư mục `dist/`.
- Tài liệu [Khởi đầu nhanh (Getting Started)](getting-started.md) hướng dẫn thiết lập trên một repository độc lập bên ngoài monorepo để kiểm chứng tính năng. Tuyệt đối không sao chép thư mục `node_modules` của Bflow sang repository mục tiêu đó.
