import { Link } from 'react-router';
import { WebApiErrorCodeSchema, type WebApiError } from '@bflow/contracts/web';
import { ApiError } from '../api/client';
import type { Observation } from '../api/commands';
export const outcomeLabels={approved:'Duyệt',rejected:'Từ chối',changes_requested:'Yêu cầu sửa'} as const;
export const operationLabels={create_request:'Tạo yêu cầu',revise_request:'Chỉnh yêu cầu',answer_clarification:'Trả lời làm rõ',answer_decision:'Quyết định gói',resume:'Tiếp tục công việc',cancel:'Hủy công việc',session_start:'Khởi động phiên',session_stop:'Dừng phiên'};
const labels={accepted:'Đã tiếp nhận, đang chờ xử lý.',running:'Đang áp dụng thao tác.',applied:'Đã áp dụng thao tác. Trạng thái công việc được đọc riêng.',failed:'Thao tác không được áp dụng.',reconciliation_required:'Chưa xác định kết quả. Cần đối chiếu; không gửi lại.'};
const failureGuidance:Record<WebApiError['code'],{reason:string;remedy:string}>={
  invalid_request:{reason:'Thông tin gửi chưa hợp lệ. Kiểm tra nội dung yêu cầu, câu trả lời và các trường bắt buộc.',remedy:'Sau khi sửa thông tin, chọn “Bắt đầu thao tác mới” rồi gửi lại yêu cầu đã chỉnh.'},
  stale_version:{reason:'Phiên bản công việc hoặc gói xem xét đã thay đổi.',remedy:'Đọc lại công việc và xem xét gói hiện hành trước khi bắt đầu thao tác mới.'},
  session_required:{reason:'Phiên trình duyệt đã hết hạn.',remedy:'Mở lại Bflow Web từ máy này để ghép nối, rồi đọc lại thao tác trước khi tiếp tục.'},
  forbidden:{reason:'Phiên trình duyệt không có quyền thực hiện thao tác này.',remedy:'Ghép nối lại Bflow Web và kiểm tra đúng dự án trước khi tiếp tục.'},
  not_found:{reason:'Không tìm thấy công việc hoặc đối tượng của thao tác.',remedy:'Tải lại dự án và kiểm tra liên kết công việc trước khi bắt đầu thao tác mới.'},
  operation_conflict:{reason:'Mã thao tác đã được dùng cho nội dung khác.',remedy:'Đọc lại thao tác gốc để đối chiếu. Chỉ bắt đầu thao tác mới sau khi kết quả gốc đã được xác định.'},
  payload_too_large:{reason:'Nội dung gửi vượt giới hạn cho phép.',remedy:'Rút gọn nội dung trước khi chọn “Bắt đầu thao tác mới” và gửi yêu cầu đã chỉnh.'},
  operation_not_allowed:{reason:'Trạng thái hoặc quyền hiện tại chưa cho phép thao tác này.',remedy:'Tải lại công việc, xử lý điều kiện đang chặn và chỉ chọn thao tác đang được cho phép.'},
  unavailable:{reason:'Dịch vụ dự án hiện chưa sẵn sàng.',remedy:'Kiểm tra kết nối và điều kiện phiên trong Cài đặt dự án, rồi đọc lại thao tác trước khi tiếp tục.'},
  reconciliation_required:{reason:'Dịch vụ chưa xác định được kết quả thao tác.',remedy:'Chỉ đọc lại thao tác để đối chiếu; chưa gửi lại hoặc bắt đầu thao tác mới.'},
};
export function OperationStatus({observation,projectId}:{observation:Observation;projectId:string}) {
  const op=observation.operation,result=op?.result;
  const code=WebApiErrorCodeSchema.safeParse(op?.error?.code??(observation.error instanceof ApiError?observation.error.code:undefined));
  const guidance=code.success?failureGuidance[code.data]:undefined;
  const uncertain=!op || op.state==='reconciliation_required';
  return <div role="status" aria-live="polite"><h3>{operationLabels[observation.record.kind]}{observation.record.outcome?`: ${outcomeLabels[observation.record.outcome]}`:''}</h3><p>{op?labels[op.state]:'Mất phản hồi hoặc chưa tìm được thao tác. Đọc lại để đối chiếu; không tự gửi lại.'}</p>
    {op?.owner==='local_lifecycle' && op.error?.message && op.error.message.split('\n').filter(line=>line.trim()).slice(0,20).map((line,i)=><p key={i} className="identifier">{line}</p>)}
    {guidance && (op?.state==='failed' || uncertain) && <><p>{guidance.reason}</p><p>{uncertain?'Chỉ đọc lại thao tác để đối chiếu; chưa gửi lại hoặc bắt đầu thao tác mới.':guidance.remedy}</p>{uncertain && code.success && ['session_required','forbidden','unavailable'].includes(code.data) && <p>{guidance.remedy}</p>}</>}
    {observation.record.kind==='cancel' && <p>{op?.state==='applied'?'Yêu cầu hủy đã áp dụng; chỉ trạng thái công việc mới xác nhận đã hủy.':op?.state==='running'?'Đang xử lý yêu cầu hủy; chưa xác nhận đã dừng.':'Yêu cầu hủy chưa xác nhận tiến trình đã dừng.'}</p>}
    {result?.kind==='interaction' && <Link to={`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(result.currentRunId)}`}>{result.continuedAsRunId?'Mở công việc tiếp nối →':'Xem công việc sau thao tác →'}</Link>}
    {result?.kind==='intake' && <p>Đã tiếp nhận yêu cầu. Xem câu hỏi làm rõ và công việc trên Tổng quan.</p>}
    <details><summary>Mã đối chiếu thao tác</summary><span className="identifier">{observation.record.commandId}</span></details>
  </div>;
}
