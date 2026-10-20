# Bàn giao P28 Skills Framework — 2026-10-17

Nguồn triển khai: **03701f0d37bcc34360306feb363b7e0af9905841** trên
`agent/skills/p28-framework`, worktree `/tmp/bflow-p28-skills`.
Baseline: `a39374d0f06144a25e01691feeb696a1defed211`, đã xác minh là hậu duệ của P24 `8dbb056`
đã được duyệt. `main`/`origin/main` khớp nhau lúc kiểm tra; P24 không có patch nào không khớp
trong `git cherry main agent/architecture/p24-runtime-v3`. Không publish remote hay merge.

## Đã bàn giao và đã review

32 skill canonical hoàn chỉnh, 32 ví dụ thực hành cục bộ, 49 lượt chọn cho cả 10 role trong contract.
Mọi shared skill và binding được yêu cầu đều có mặt. Frontmatter name/description chuẩn
và metadata nghiêm ngặt liền kề giữ trung lập với provider/model. Một manifest đã phân giải chỉ
lộ các name/description/đường dẫn pin được chọn; instruction được nạp theo yêu cầu.

SkillManager triển khai list, validate, install, sync, link, verify, update và phục hồi
manifest bất biến. Bao gồm pin dependency chính xác, thứ tự ổn định, digest kiểm kê nội dung đầy đủ,
kiểm tra role/provider/tool/capability, callback approval đã xác thực, lưu trữ nguyên tử
riêng tư, writer lock độc quyền, lập kế hoạch setup chỉ đọc và dữ liệu repository desired
bảo toàn cấu hình. Xem README để biết ví dụ API package chạy được và các hạn chế.

Review độc lập đã tìm ra và các regression test nay bao phủ: byte install có thể thay đổi do
caller sở hữu; tham chiếu resource dạng ngoặc nhọn bị thiếu/từ xa; lệnh lồng nhau option-first/không
xác định; xung đột pin dependency tùy chọn; và ghi catalog trong lúc dry-run. Xác minh nội dung
được tách biệt tường minh khỏi sức khỏe provider/tool live, vốn P25/P30 phải thăm dò độc lập.
Không skill nào cấp quyền hay vượt qua chính sách/thẩm quyền con người của Bflow.

## Bằng chứng xác thực

Linux, Node `v24.16.0`, pnpm `12.5.1`; dependency của worktree cô lập được cài từ
lock/cache workspace hiện có. `TMPDIR=/tmp` tránh vấn đề độ dài đường dẫn của fixture Unix-socket hiện có.
Cây source package cuối cùng tương ứng với implementation commit ở trên.

| Lệnh từ gốc worktree | Exit | Kết quả thực tế |
| --- | --- | --- |
| `pnpm --filter @bflow/skills typecheck` | 0 | project của package và contracts biên dịch được |
| `TMPDIR=/tmp pnpm --filter @bflow/skills test` | 0 | 6 file, 35 đạt, 0 thất bại/bỏ qua; lần chạy cuối 12.53s |
| `pnpm check:deps` | 0 | 20 package / 27 cạnh; đã xác minh ranh giới và đồ thị không chu trình |
| `pnpm typecheck` | 0 | các project reference gốc hiện có biên dịch được; package được kiểm tra riêng |
| `TMPDIR=/tmp pnpm test` | 1 | 92 file đạt, 2 thất bại, 3 bỏ qua; 1791 test đạt, 2 thất bại, 4 bỏ qua; 304.20s |
| `git diff --check` và kiểm tra ownership diff so với baseline | 0 | không có lỗi whitespace |

Lần chạy đầy đủ bắt đầu trên working tree P28 trước implementation commit và
kết thúc sau nó. Phần hardening P28 cuối cùng được bao phủ thêm bởi lệnh package
ở trên. Đây là bằng chứng source/rendering cục bộ, không phải remote closure hay kích hoạt live.

Các thất bại của lần chạy đầy đủ nằm ngoài quyền sở hữu của P28:

- `packages/machine-setup/test/executor.test.ts:310`: timed abort kỳ vọng `unknown`,
  quan sát được `blocked` trong lần chạy đầy đủ đồng thời. Helper owner của baseline cũng tái hiện
  lỗi timing; lần chạy lại baseline cô lập thì đạt, nên đừng khẳng định nó mang tính xác định.
- `packages/tool-installer/test/services-and-config.test.ts:92`: RTK apply hiện có từ chối
  `.codex/hooks.json` của operator vì không phải là file thường có giới hạn. Tái hiện trên baseline
  `a39374d` chưa thay đổi. Không hook/config nào của operator bị sửa để làm test đạt.

Ba file live test opt-in đã bị bỏ qua. Không tuyên bố gọi model, native skill discovery,
provider readiness, thành công task Herdr live hay nghiệm thu SDLC đầy đủ. Lần chạy ban đầu
với symlink node_modules gốc đã bị loại bỏ sau khi cơ chế bảo vệ đường dẫn task không an toàn của pnpm
chặn; bằng chứng cuối cùng dùng node_modules thật độc lập. Không commit dependency, output
hay log được sinh ra.

## Quyết định tích hợp và quyền sở hữu

Các đường dẫn thay đổi chỉ là `packages/skills/**` và `skills/**`. Không có thay đổi contract
công khai, config gốc, lockfile, tài liệu dùng chung, migration hay output được sinh ra. Việc cài đặt đã sinh một
importer lockfile cục bộ để kiểm thử; nó đã được khôi phục trước khi bàn giao. Các TypeScript reference gốc
chưa bao gồm package mới.

Integrator nên thêm importer/reference của package; P26 tiêm SkillsSetupSynchronizer;
P29 dùng repositoryConfig cho config skills do init sở hữu và cung cấp command UX; P30
lưu trữ session manifest chính xác và ghép các instruction đã render qua P25.
Cách dùng port chi tiết nằm trong README. CLI `skills`/`setup` và việc kích hoạt init tự động vẫn
chưa được nối trên baseline này; bàn giao này không đại diện cho nghiệm thu lệnh.

Không yêu cầu sửa contract. Các ID yêu cầu tool (`gitnexus`, `rtk`, `mempalace`,
`browser`) cần được ánh xạ tới inventory thực tế đã duyệt/đã thăm dò. Host phải cung cấp các pin digest builtin
đáng tin cậy và xác thực các approval về source/dependency/scope/role/provider/expiry.
Các role prompt gốc vẫn bắt buộc. Storage là POSIX cục bộ, không đảm bảo mất điện,
network-filesystem, đa host hay same-UID thù địch. Các lock sau crash cần operator reconciliation
tường minh; không mutation không chắc chắn nào được tự động thử lại. P02-RA01,
P03-RA01 hiện có và các khoảng trống nghiệm thu release giữ nguyên với owner ban đầu của chúng.
