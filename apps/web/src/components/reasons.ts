const reasons:Record<string,string>={
 host_unavailable:'Chưa kết nối được phiên dự án. Hãy kiểm tra điều kiện sẵn sàng.',host_inactive:'Phiên dự án chưa được kích hoạt.',
 structured_commands_unavailable:'Phiên hiện tại chưa hỗ trợ thao tác trực tiếp.',core_projection_unavailable:'Chưa đọc được trạng thái thực thi hiện hành. Cần đối chiếu trước khi thao tác.',
 follow_up_budget_exhausted:'Đã hết số lượt yêu cầu sửa được cho phép. Cần người phụ trách xem xét.',delivery_reconciliation_required:'Chưa xác định chắc chắn việc chuyển giao. Cần đối chiếu, không tự gửi lại.',
 resume_budget_exhausted:'Đã hết số lượt tiếp tục được cho phép. Cần người phụ trách xem xét.',decision_required:'Đang chờ quyết định của bạn.',action_not_pending:'Thao tác này không còn ở trạng thái chờ.',
 capability_revalidation_required:'Cần kiểm tra lại điều kiện của tác nhân trước khi tiếp tục.',projection_truncated:'Dữ liệu đã chạm giới hạn hiển thị. Thu hẹp lựa chọn để đọc đầy đủ.',runtime_blocked:'Công việc cần được xem xét. Kiểm tra quyết định hoặc hướng xử lý hiện hành.',
 core_execution_started:'Nhiệm vụ đã bắt đầu thực thi nên không thể chỉnh yêu cầu tại chỗ. Muốn đổi yêu cầu, hãy hủy công việc này rồi tạo công việc mới.',
 manual_resume_required:'Công việc đang dừng và chờ bạn. Dùng nút “Tiếp tục” nếu đang bật, hoặc hủy công việc.',
 auto_resume_scheduled:'Hệ thống sẽ tự tiếp tục trong giới hạn số lần cho phép. Bạn chưa cần thao tác.',
 capability_repair_pending:'Đang chờ tác nhân đạt lại điều kiện cần thiết. Công việc tự tiếp tục khi kiểm tra đạt.',
 coordinator_continuation_pending:'Đang chờ Coordinator ghi nhận bước tiếp theo. Bạn chưa cần thao tác.',
 execution_plan_drift:'Mã nguồn đã đổi trước khi giao việc nên kế hoạch cần xác nhận lại. Chưa có thao tác nào được gửi đi; đây không phải lỗi chuyển giao, không cần gửi lại.',
 chat_adapter_unavailable:'Trò chuyện qua web chưa khả dụng. Biểu mẫu và nút quyết định vẫn dùng được.',
 session_unavailable:'Chưa có phiên Conversation đang hoạt động.',
};
export function reason(code:string|undefined){return code?(reasons[code]??'Có điều kiện cần xử lý. Xem chẩn đoán dự án để biết chi tiết.'):'Chưa có hướng xử lý được công bố.';}
export type Severity='action'|'degraded'|'checking';
const degraded=new Set(['chat_adapter_unavailable']),checking=new Set(['auto_resume_scheduled','capability_repair_pending','coordinator_continuation_pending','core_projection_unavailable']);
/** Unknown codes stay "action": an unclassified blocker must not look optional. */
export function severity(code:string):Severity{return degraded.has(code)?'degraded':checking.has(code)?'checking':'action';}
export const severityLabels:Record<Severity,string>={action:'Cần xử lý',degraded:'Suy giảm tùy chọn',checking:'Đang kiểm tra'};
