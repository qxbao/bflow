const reasons:Record<string,string>={
 host_unavailable:'Chưa kết nối được phiên dự án. Hãy kiểm tra điều kiện sẵn sàng.',
 host_inactive:'Phiên dự án chưa được kích hoạt. Hãy bấm “Khởi động phiên” ở trang Tổng quan.',
 structured_commands_unavailable:'Phiên hiện tại chưa hỗ trợ thao tác trực tiếp trên web.',
 core_projection_unavailable:'Đang đồng bộ trạng thái thực thi hiện hành. Vui lòng đợi đối chiếu trước khi thao tác.',
 follow_up_budget_exhausted:'Đã hết số lượt chỉnh sửa yêu cầu tự động cho phép. Hãy tạo công việc mới nếu cần thay đổi thêm.',
 delivery_reconciliation_required:'Hệ thống đang đối chiếu kết quả chuyển tin trước đó; không tự gửi lại để tránh trùng lặp.',
 resume_budget_exhausted:'Đã hết số lượt thử tiếp tục cho phép. Cần kiểm tra nguyên nhân chặn hoặc hủy và tạo công việc mới.',
 decision_required:'Đang chờ bạn xem xét và duyệt gói quyết định bên dưới.',
 approval_required:'Đang chờ bạn phê duyệt gói xem xét trước khi tiếp tục.',
 action_not_pending:'Hiện không có bước tạm dừng nào cần tiếp tục thủ công.',
 not_resumable:'Công việc đang chạy bình thường hoặc chờ bước khác, chưa cần bấm Tiếp tục.',
 no_pending_decision:'Hiện không có gói quyết định nào đang chờ duyệt.',
 terminal_run:'Công việc đã kết thúc nên không còn thao tác này.',
 capability_revalidation_required:'Hệ thống đang kiểm tra lại điều kiện sẵn sàng của bộ công cụ thực thi trước khi tiếp tục.',
 projection_truncated:'Danh sách dữ liệu quá lớn nên đang rút gọn hiển thị. Hãy dùng bộ lọc để xem chi tiết.',
 runtime_blocked:'Công việc đang tạm dừng để chờ xử lý. Hãy kiểm tra mục Điểm cần xử lý hoặc gói quyết định bên dưới.',
 core_execution_started:'Nhiệm vụ đã bắt đầu thực thi nên không thể chỉnh yêu cầu tại chỗ. Muốn đổi yêu cầu, hãy hủy công việc này rồi tạo công việc mới.',
 manual_resume_required:'Công việc đang dừng và chờ bạn. Dùng nút “Tiếp tục” nếu đang bật, hoặc hủy công việc.',
 auto_resume_scheduled:'Hệ thống đã lên lịch tự động tiếp tục trong giới hạn an toàn. Bạn chưa cần thao tác.',
 capability_repair_pending:'Kết nối công cụ nội bộ của một vai trò chưa sẵn sàng. Hệ thống đang tự kiểm tra lại; nếu kéo dài quá 1 phút, hãy dừng và khởi động lại phiên dự án.',
 coordinator_continuation_pending:'Hệ thống đang chuyển sang bước điều phối tiếp theo. Bạn chưa cần thao tác.',
 execution_plan_drift:'Mã nguồn dự án đã thay đổi trước khi giao việc nên kế hoạch cần xác nhận lại. Chưa có thao tác nào bị gửi trùng.',
 chat_adapter_unavailable:'Trò chuyện qua web chưa khả dụng. Biểu mẫu và nút quyết định vẫn dùng được.',
 session_unavailable:'Chưa có phiên làm việc đang chạy cho dự án này.',
 verification_failed:'Kiểm chứng chưa đạt tiêu chí chất lượng. Xem nhiệm vụ thất bại bên dưới hoặc bấm Tiếp tục để thử lại.',
 verification_sandbox_unavailable:'Môi trường cô lập kiểm chứng ứng dụng chưa khả dụng trên máy này. Xem Cài đặt dự án để kiểm tra điều kiện hệ thống.',
};
const benignDisabled=new Set(['not_resumable','no_pending_decision','action_not_pending','terminal_run']);
export function isBenignDisabledReason(code:string|undefined):boolean{return Boolean(code && benignDisabled.has(code));}
export function reason(code:string|undefined){return code?(reasons[code]??'Có điều kiện cần xử lý. Xem chẩn đoán dự án để biết chi tiết.'):'Chưa có hướng xử lý được công bố.';}
export type Severity='action'|'degraded'|'checking';
const degraded=new Set(['chat_adapter_unavailable']),checking=new Set(['auto_resume_scheduled','capability_repair_pending','coordinator_continuation_pending','core_projection_unavailable']);
/** Unknown codes stay "action": an unclassified blocker must not look optional. */
export function severity(code:string):Severity{return degraded.has(code)?'degraded':checking.has(code)?'checking':'action';}
export const severityLabels:Record<Severity,string>={action:'Cần xử lý',degraded:'Suy giảm tùy chọn',checking:'Đang kiểm tra'};
