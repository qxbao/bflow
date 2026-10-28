import { useState } from 'react';
import type { WebProject, WebProjectInspection } from '@bflow/contracts/web';
import { ApiClient } from '../api/client';
import { ErrorState } from '../components/ErrorState';
import { StatusBadge } from '../components/StatusBadge';
export function Settings({api,project}:{api:ApiClient;project:WebProject}) {
  const [inspection,setInspection]=useState<WebProjectInspection>(),[error,setError]=useState<unknown>(),[busy,setBusy]=useState(false);
  async function inspect(){setBusy(true);setError(undefined);try{setInspection(await api.inspect(project.projectId));}catch(e){setError(e);}finally{setBusy(false);}}
  return <><div className="eyebrow">Thông tin trên máy này</div><h1>Cài đặt dự án</h1><section className="panel"><h2>{project.displayName}</h2><p className="identifier">{project.canonicalPath}</p><p>Đăng ký dự án không tự khởi tạo hoặc khởi động phiên.</p><button disabled={busy} onClick={inspect}>{busy?'Đang kiểm tra…':'Kiểm tra điều kiện sẵn sàng'}</button></section>
    {Boolean(error) && <ErrorState error={error} stale={Boolean(inspection)} retry={inspect}/>}{inspection && <section><h2>Kết quả kiểm tra</h2><p>{inspection.ready?'Các kiểm tra được báo cáo đã đạt.':'Dự án còn điều kiện cần xử lý.'}</p>{inspection.checks.map((check,index)=><article className="panel" key={index}><StatusBadge value={check.state}/><p>{check.message}</p></article>)}<p>Quan sát lúc {new Date(inspection.observedAt).toLocaleString('vi')}</p></section>}
    <details><summary>Chẩn đoán chỉ đọc</summary><p>Đầu ra pane và tin nhắn Conversation là hai nguồn riêng. Chưa có đầu ra terminal an toàn để hiển thị trên trình duyệt.</p><p>Để thay đổi trạng thái phiên, sử dụng Bflow trên máy này. Đăng nhập provider, khi được yêu cầu, thực hiện trên máy theo hướng dẫn của Bflow.</p></details>
  </>;
}
