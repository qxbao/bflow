# ADR 0005 — EP-01: execution preview và kiểm tra drift

Trạng thái: project owner chấp nhận trong cuộc hội thoại ngày 2026-10-27:
“Duyệt EP-01 và Specification/TDD”, sau khi đọc đề xuất
`packages/runtime/execution-preview-design.md`. Owner cũng chấp nhận
“Cho phép mở ownership để hỗ trợ custom skills thành công”.

Động lực: người dùng cần xem kế hoạch và nguồn của từng quyết định trước khi
Runtime thực hiện công việc. Preview phải dùng cùng resolution/policy với
execution, không tự dựng một planner khác hoặc gọi model để đoán kế hoạch.

Quyết định cho phép contracts additive version 3 cho plan/input, provenance,
observations, expectation và diff; pack khai báo cục bộ được pin theo
id/version/digest. Các owner bị ảnh hưởng là Contracts/integration, Runtime,
CLI và Skills. Precedence của pack là default → pack → project → explicit
override đối với những trường pack được phép cung cấp; quy tắc thực tế của
profile/skill/tool policy hiện có tiếp tục được giữ và phải giải thích được.
Pack không cấp quyền, không tự duyệt công việc hoặc làm yếu gate bắt buộc.

Preview phân biệt intake với specification/DAG được Runtime chấp nhận. Kế
hoạch ổn định có fingerprint riêng; readiness là observation có nguồn và độ
mới. Không có lease, reservation, launch, install, config write, approval
creation, dispatch hoặc model/probe có phí trong preview. Dữ liệu output
được giới hạn và che secret; preview không là bằng chứng thành công.

Execution kiểm tra lại đầu vào và prerequisites trước side effect liên quan.
Accepted plan giữ binding đầu vào trong Runtime-private state, kể cả khi
không có CLI preview expectation. Drift trả về diff có nguồn và lý do;
chỉ policy hiện có về revision/evidence/target quyết định approval nào hết
hiệu lực. Readiness thay đổi không tự tạo approval mới.

Tương thích: giữ nguyên các signature RuntimeService, RoleMessage,
SessionManifest, provider launch và approval hiện có. Không có SQL migration
hoặc upcaster suy diễn lịch sử. Run cũ thiếu binding không có bằng chứng
drift lịch sử; prerequisite và approval-binding vẫn phải được kiểm tra.
Reader của tài liệu preview mới từ chối version không biết. Không chọn pack
thì giữ hành vi cấu hình hiện có.

Conditional TDD của feature này là required, do liên quan policy, secrets và
side effects. Local tests không chứng minh live-provider/Herdr hoặc full
SDLC acceptance. Quyết định này không cho phép commit, push, tạo PR hoặc
ghi dịch vụ ngoài.
