const reasons:Record<string,string>={
 host_unavailable:'Chưa kết nối được phiên dự án. Hãy kiểm tra điều kiện sẵn sàng.',host_inactive:'Phiên dự án chưa được kích hoạt.',
 structured_commands_unavailable:'Phiên hiện tại chưa hỗ trợ thao tác trực tiếp.',core_projection_unavailable:'Chưa đọc được trạng thái thực thi hiện hành. Cần đối chiếu trước khi thao tác.',
 follow_up_budget_exhausted:'Đã hết số lượt yêu cầu sửa được cho phép. Cần người phụ trách xem xét.',delivery_reconciliation_required:'Chưa xác định chắc chắn việc chuyển giao. Cần đối chiếu, không tự gửi lại.',
 resume_budget_exhausted:'Đã hết số lượt tiếp tục được cho phép. Cần người phụ trách xem xét.',decision_required:'Đang chờ quyết định của bạn.',action_not_pending:'Thao tác này không còn ở trạng thái chờ.',
 capability_revalidation_required:'Cần kiểm tra lại điều kiện của tác nhân trước khi tiếp tục.',projection_truncated:'Dữ liệu đã chạm giới hạn hiển thị. Thu hẹp lựa chọn để đọc đầy đủ.',runtime_blocked:'Công việc cần được xem xét. Kiểm tra quyết định hoặc hướng xử lý hiện hành.',
};
export function reason(code:string|undefined){return code?(reasons[code]??'Có điều kiện cần xử lý. Xem chẩn đoán dự án để biết chi tiết.'):'Chưa có hướng xử lý được công bố.';}
