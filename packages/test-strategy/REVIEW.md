# Review và tích hợp P16 — 2026-10-16

Đã review policy resolver, evidence ingress, tương thích contract, hướng dẫn prompt,
đăng ký package và bản bàn giao gốc trước khi tích hợp cục bộ.
Các commit triển khai/báo cáo gốc: `02e6ca5`, `c91a139`.

## Các finding đã sửa

| Finding | Khắc phục và evidence regression |
| --- | --- |
| Các automated check hiện có khiến formatting thuần túy phải có phase Red nhân tạo | Tách các check thực thi được khỏi evidence về hành vi thay đổi; giữ các regression check dưới alternative verification |
| Infrastructure `ready` chỉ với một số behavioral command vẫn có thể yêu cầu TDD | Yêu cầu command đã cấu hình cho mọi behavioral method được chọn; nếu không thì giữ các điều kiện provisioning tường minh |
| Red yêu cầu sai là mọi criterion được quan sát đều phải thất bại | Cho phép các regression criterion và baseline check hiện có đang pass, đồng thời yêu cầu ít nhất một behavioral observation mục tiêu thất bại; giữ mọi test qua Green/refactor |
| Các evidence phase có thể đến từ các verification cycle khác nhau | Ràng buộc các phase receipt kế tiếp vào cùng một `cycleNumber` |
| Observation thủ công/trực quan có thể khai báo thành công với exit code khác 0 | Từ chối exit code observation/evaluation mâu thuẫn |
| Nhiều target command dùng chung một verification method có thể bị bỏ qua một phần | Evidence thành công phải bao phủ mọi target command cũng như mọi method và criterion bắt buộc |

Lần chạy regression đầu tiên tái hiện năm lỗi (75 passed / 5 failed); guard Red toàn pass
đã hoạt động. Một regression multi-command riêng tái hiện thêm một lỗi (80 passed / 1
failed). Sau khi sửa, `pnpm --filter @bflow/test-strategy test` pass 81 test trong hai
file, không có lỗi/skip. Cả hai lần chạy tái hiện đều exit 1; lần chạy package cuối cùng
exit 0.

Không có shared contract hay source của chủ sở hữu triển khai khác bị thay đổi. Việc
xác thực evidence tiếp tục dựa vào P17 để xác minh nội dung artifact/revision và dựa
vào P19 cho ràng buộc spec có thẩm quyền, persistence và thực thi qua Runtime.
Review này không khẳng định các trách nhiệm đó đã hoàn tất.

## Xác thực tích hợp và đóng cục bộ

Bản sửa source: `4942b08`. Bản triển khai và các bản sửa được giữ qua merge commit
`b35f063`. Đăng ký workspace là commit `9a71765f9e79fdc26ea3c5a8a576f5d89e18cac5`,
chính là integration HEAD chính xác được kiểm thử bên dưới. Báo cáo review này là một
commit chỉ-tài-liệu tiếp theo.

Việc xác thực chạy từ `/tmp/bflow-p16-integration` trên Linux với Node `v24.16.0`
và pnpm `12.5.1`:

| Command | Exit | Kết quả |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Integration worktree mới; mọi workspace package được cài mà không đổi lockfile |
| `pnpm check:deps` | 0 | Không có chu trình: 13 package, 19 cạnh nội bộ |
| `pnpm typecheck` | 0 | Các reference gốc nay bao gồm P16 |
| `pnpm --filter @bflow/test-strategy test` | 0 | Build; 2 file, 81 passed / 0 failed / 0 skipped |
| `TMPDIR=/tmp pnpm test` | 0 | Build gốc; 42 file, 954 passed / 0 failed / 0 skipped |
| Smoke check export ESM/ví dụ của package đã cài | 0 | Tự import qua export `@bflow/test-strategy`; resolve và ràng buộc spec có thẩm quyền pass |
| `git diff --check` | 0 | Không có lỗi whitespace |

TMPDIR ngắn giữ nguyên yêu cầu độ dài đường dẫn của fixture Unix-socket ArtifactStore
gốc trong môi trường này. Không có storage test hay triển khai nào bị thay đổi.

Các thay đổi tích hợp chỉ giới hạn ở việc đăng ký P16 trong `tsconfig.json`, importer
lockfile đã pin của nó, tài liệu package/command gốc và các ghi chú tích hợp package đã
cập nhật. Contracts, Core, Runtime và các đường dẫn triển khai của chủ sở hữu khác không
có diff. Output sinh ra không được commit; không cần migration hay quyết định contract.
Việc thực thi qua Runtime vẫn thuộc P19 sau toàn bộ gate P12–P18.

Lịch sử tích hợp đã xác thực và commit kế nhiệm chỉ-báo-cáo của nó được merge vào
`main` cục bộ bằng fast-forward từ `4e818b4`; cây làm việc main sạch. Điều này chỉ
đóng tích hợp P16 cục bộ. Không khẳng định push, remote merge, xác minh Herdr thật hay
đồng bộ P12–P18 hoàn chỉnh.
