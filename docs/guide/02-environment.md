# 2. Yêu cầu môi trường

| Thành phần | Yêu cầu |
| --- | --- |
| Node.js | **>= 22.13** (cần `node:sqlite` không cờ). Đã kiểm chứng trên 22.23.2. `engines` ở root ghi `>=22`, rộng hơn yêu cầu thực tế. `node:sqlite` vẫn là experimental trên Node 22 và in `ExperimentalWarning` |
| pnpm | **12.5.1** (được ghim trong `package.json` qua `packageManager`) |
| Hệ điều hành | Đã kiểm chứng: Linux, filesystem cục bộ. Test storage/security dùng fixture POSIX (`mkfifo`, Unix socket, symlink, hardlink) |
| Herdr | **Không cần** để build/test hoặc chạy `examples/runtime-demo`. Chỉ cần khi dùng `createHerdrAdapter` với agent thật — xem [Herdr](03-herdr-setup.md) |
| API key mô hình AI | Không cần cho test hay demo. Repository không đọc API key; việc xác thực với nhà cung cấp mô hình thuộc về công cụ agent chạy trong Herdr |

Kiểm tra nhanh:

```bash
node --version    # v22.13.0 trở lên
pnpm --version    # 12.5.1
```

## Không được kiểm chứng

Mất điện, network filesystem, lưu trữ nhiều máy, và tiến trình cùng user cố tình tráo đường dẫn liên tục đều **NOT VERIFIED**. Registry và store chỉ dành cho một máy, một filesystem cục bộ.

## macOS

macOS không phải nền tảng đã kiểm chứng. Hai khác biệt đã quan sát (Node 22.19.0, Darwin 25.6.0):

1. `os.tmpdir()` trả về `/var/folders/...`, trong đó `/var` là symlink tới `/private/var`. `openFilesystemArtifactStore` từ chối root có ancestor không canonical (`Artifact root ancestor is not canonical`). Khi chạy test, đặt `TMPDIR` về đường dẫn canonical:

   ```bash
   export TMPDIR="$(node -p 'require("fs").realpathSync(require("os").tmpdir())')"
   pnpm test
   ```

   Ứng dụng của bạn cũng nên truyền `realpath` của thư mục artifact. `examples/runtime-demo` đã làm việc này.
2. Kể cả với `TMPDIR` canonical, test `quality-gates` "rejects sensitive system paths (/etc, /proc, /root)" vẫn fail trên macOS vì `/etc` là symlink tới `/private/etc`.
