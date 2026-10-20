# Bàn giao tích hợp P17

Chỉ `packages/verification/**` và `agents/verifier/**` thuộc quyền sở hữu ở đây. P17 không
bao gồm thay đổi nào đối với shared contract, migration, cấu hình build gốc hay lockfile.
Baseline tiền nhiệm là `d8c6d18120c7a01a4bf8aad13f14660d20e0cdf6`, chứa bản đóng băng contract
P11 và các triển khai P15/P16 đã được review. `origin/main` cục bộ là
`4e818b4a7c0c9b102bf1e85906a24d57fd6c192c`; đây là tổ tiên (ancestor) và chậm hơn main cục bộ
sáu commit. Không thực hiện thao tác ghi lên remote.

Theo ủy quyền review/fix/merge của người dùng, tích hợp cục bộ đăng ký
`{ "path": "./packages/verification" }` vào `tsconfig.json` gốc và importer của package
trong `pnpm-lock.yaml`. Các phiên bản dependency hiện có được giữ nguyên. Build/typecheck gốc
nay bao gồm P17, và test gốc tự động phát hiện các case của nó. README gốc cũng ghi lại trạng
thái package và lệnh test đích. Các thay đổi shared-file này thuộc về integration commit,
tách biệt với quyền sở hữu source.

P19 phải kết hợp các port contract được export với Runtime có thẩm quyền:

- Lưu `VerificationCycle` mới nhất được trả về bằng optimistic version trước khi định tuyến
  rework; xác thực snapshot mới nhất và ngăn replay snapshot cũ.
- Khi kết quả failed, định tuyến `findings[].details.taskId/responsibleRole` qua Coordinator,
  rồi ghi nhận repair/attempt/changeSet mới của Developer. Không bao giờ reset cycle để lấy
  lại ngân sách retry. Mặc định là ba lần verification iteration tổng cộng (lần nộp ban đầu
  cộng tối đa hai lần sửa), cấu hình được trong khoảng 1–10; rework policy của Core có thể
  áp đặt giới hạn thấp hơn.
- Định tuyến các envelope `RoleMessage` được trả về qua Runtime. Không có lệnh gọi Herdr trực
  tiếp, bỏ qua lease, dispatch hay thông điệp Conversation nào phát sinh từ đây.
- Cung cấp các gate capability cô lập đã được phê duyệt, danh tính executor/implementer đã
  xác thực, Git snapshot có thẩm quyền, proposal bytes đã materialize, và việc tra cứu
  specification đã phê duyệt có thẩm quyền. Chỉ khẳng định bằng metadata thì không chứng minh
  được sự cô lập vật lý hay trạng thái Git thật. Các automated check phải báo cáo command/exit
  status thực tế, tên test và số đo theo criterion.
- Chỉ cung cấp đường dẫn dependency đầy đủ khi an toàn để tái sử dụng evidence không bị ảnh
  hưởng; nếu không thì để `dependsOnPaths` vắng mặt. Workflow check luôn chạy lại.
- Task workflow verification có task ID riêng; cung cấp integrated head và các task ID tham gia
  qua tùy chọn `integration`. Không truyền kết quả cấp task làm evidence chấp nhận workflow.
- Đối soát (reconcile) intent đã lưu sau lỗi storage, crash, timeout hoặc cancellation.
  Runner timeout không chứng minh tiến trình từ xa đã dừng. Engine không bao giờ tự động gửi
  lại một execution. ArtifactStore và trạng thái Runtime là các transaction riêng biệt.
  Runtime sở hữu việc hủy thao tác và khôi phục dispatch.
- P16 vẫn là chủ sở hữu của policy TDD có điều kiện/hồ sơ evidence. P17 xác thực contract
  strategy, các command/level/mapping đã cấu hình và aggregate coverage của nó; P19 phải kết
  hợp việc thực thi Red/Green/refactor của P16 trước khi chấp nhận nghiệp vụ.

Không yêu cầu quyết định contract mới. `VerificationPlan`, cấu hình check, observation và các
tùy chọn repair/integration là cấu hình/codec cục bộ của engine; dữ liệu trao đổi dùng các
contract hiện có và các metadata slot của chúng. Tài liệu requirements đã lưu của P15 được
xác thực với các trường vòng đời phê duyệt được khôi phục, rồi so sánh chỉ loại trừ các
trường status/approval/reference/update-time, khớp với ngữ nghĩa `contentBytes()` của P15.
Requirement drift vẫn làm vô hiệu plan.

[Examples](examples/) được thu từ fake runner và xác thực bằng `VerificationResultSchema`.
Chúng minh họa các kết quả có cấu trúc; các URI test-store của chúng là fixture, không phải
artifact có thể triển khai. Fake runner và fake ArtifactStore lưu byte chỉ nằm trong
`test/fixtures.ts`. Việc thực thi Herdr thật, tích hợp Git P18, thực thi Runtime P19 và đóng
remote chưa được xác minh ở đây.
