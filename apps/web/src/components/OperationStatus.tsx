import { Link } from 'react-router';
import type { Observation } from '../api/commands';
export const operationLabels={create_request:'Tạo yêu cầu',revise_request:'Chỉnh yêu cầu',answer_clarification:'Trả lời làm rõ',answer_decision:'Quyết định gói',resume:'Tiếp tục công việc',cancel:'Hủy công việc',session_start:'Khởi động phiên',session_stop:'Dừng phiên'};
const labels={accepted:'Đã tiếp nhận, đang chờ xử lý.',running:'Đang áp dụng thao tác.',applied:'Đã áp dụng thao tác. Trạng thái công việc được đọc riêng.',failed:'Thao tác không được áp dụng.',reconciliation_required:'Chưa xác định kết quả. Cần đối chiếu; không gửi lại.'};
export function OperationStatus({observation,projectId}:{observation:Observation;projectId:string}) {
  const op=observation.operation,result=op?.result;
  return <div role="status" aria-live="polite"><h3>{operationLabels[observation.record.kind]}</h3><p>{op?labels[op.state]:'Mất phản hồi hoặc chưa tìm được thao tác. Đọc lại để đối chiếu; không tự gửi lại.'}</p>
    {observation.record.kind==='cancel' && <p>{op?.state==='applied'?'Yêu cầu hủy đã áp dụng; chỉ trạng thái công việc mới xác nhận đã hủy.':op?.state==='running'?'Đang xử lý yêu cầu hủy; chưa xác nhận đã dừng.':'Yêu cầu hủy chưa xác nhận tiến trình đã dừng.'}</p>}
    {result?.kind==='interaction' && <Link to={`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(result.currentRunId)}`}>{result.continuedAsRunId?'Mở công việc tiếp nối →':'Xem công việc sau thao tác →'}</Link>}
    {result?.kind==='intake' && <p>Đã tiếp nhận yêu cầu. Xem câu hỏi làm rõ và công việc trên Tổng quan.</p>}
    <details><summary>Mã đối chiếu thao tác</summary><span className="identifier">{observation.record.commandId}</span></details>
  </div>;
}
