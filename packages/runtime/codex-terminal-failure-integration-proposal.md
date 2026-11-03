# D-EXT-CODEX-TERMINAL — đề xuất tương thích native failure

Trạng thái: đề xuất, chờ chủ dự án; chưa sửa production parser hay public contracts.

## Vấn đề và bằng chứng

Spike độc lập dùng Codex CLI0.166.0 thật, profile riêng và proxy loopback. Primary gpt-6.1-sol trả marker thành công, không dùng tool. Khi proxy gây429 ở lượt tiếp theo của cùng native session, Codex tự ghi:

```json
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"<actual turn>","error":{"codex_error_info":"usage_limit_exceeded","message":"<discarded>"}}}
```

Bflow hiện chỉ nhận `event_msg.payload.type=error` với code trực tiếp trong payload. Gọi readCodexFailure trên chính transcript thật trả undefined. Bằng chứng đã làm gọn: evidence/native-reader-format-blocker.json và evidence/native-terminal-error-frame.json. Fallback gpt-6-luna đã trả marker độc lập, không dùng tool; đây chưa phải switch trong Runtime.

## Phương án1 — đề xuất chọn

Cho phép sửa tương thích có giới hạn để đọc đúng terminal error đã quan sát, gồm:

1. Bổ sung ingress schema/nhánh parse có runtime validation ở packages/contracts/src/provider-failover.ts cho `task_complete.error.codex_error_info`. Tái sử dụng allow-list code và HTTP-status projection hiện có, loại bỏ message/prose/unknown fields. Chuẩn hóa sang projection hiện hành, giữ kiểu output/signature ProviderFailureObservation và chính sách eligibility hiện tại. Không coi task_complete không có structured error là failure.
2. Runtime reader kiểm native transcript root/file/session/owner/acceptedAt như hiện tại; thêm kiểm đúng turn đối với terminal frame, loại lỗi của turn cũ, và không giữ lỗi tạm đã có terminal success. Không đọc code từ agent prose hay tool output.
3. Không tạo native event, verified handle hay failure receipt từ harness. Host chỉ tạo observation khi structured native evidence khớp execution thật đang accepted; authenticate, stop proof, reconciliation, lease/fence, pin/policy và TDD history giữ nguyên.
4. Thêm Red→Green cho frame thật đã làm gọn; malformed/missing/unknown code, prose giả, sai session/turn/time/path, newer turn và terminal success; giữ toàn bộ test định dạng cũ/Claude. Regression classification, transcript security, host authentication và provider continuation. Build/type/dependency cùng scope tests bắt buộc; full checks trước tích hợp.

Affected owners: contracts/integration, Runtime; Agent Providers cần test tương thích classification, chỉ sửa classifier nếu typing/normalization thực sự cần. Quyền dự án được xin cho các đường này và package-local tests/tài liệu quyết định; không root config/lockfile/provider-global change.

Compatibility/migration: additive input support; output projection, ProviderFailureObservation v3, Core/RoleMessage/SDK signatures và stored receipt formats không đổi. Historical records giữ nguyên; không upcast thiếu proof. Không version allowlist. Unknown structures/code tiếp tục fail closed/unknown và không đủ điều kiện switch.

Đây là ngoại lệ cụ thể đối với giới hạn “không nới parser” của thiết kế cũ, dựa trên native frame thật đã quan sát. Nó không nới điều kiện task-success hay cấp thêm quyền. Sau sửa vẫn phải chạy probe failover Runtime/Herdr thật; spike hiện tại không đóng ext-7/#12.

## Phương án2

Giữ parser/contracts hiện tại, ghi #12 bị chặn bởi native-format mismatch, tiếp tục BA/QA và các kiểm tra còn lại; không báo live failover PASS. Không yêu cầu đổi binary chỉ dựa release label.

## Phạm vi quyết định cần duyệt

Chủ dự án chọn phương án1 để cho phép ingress compatibility và regression nêu trên, hoặc phương án2 để giữ #12 blocked. Quyết định dự án này không thay bất kỳ business/document/design approval trong workflow. Không push.
