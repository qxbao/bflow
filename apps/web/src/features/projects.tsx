import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { WebProject } from '@bflow/contracts/web';
import { ApiClient, explain } from '../api/client';
import { EmptyState } from '../components/EmptyState';
export function Projects({api,projects,refresh}:{api:ApiClient;projects:WebProject[];refresh:()=>void}) {
  const [path,setPath]=useState(''),[error,setError]=useState<unknown>(),[busy,setBusy]=useState(false);
  async function submit(event:FormEvent) { event.preventDefault();setError(undefined);setBusy(true);try{await api.register(path);setPath('');refresh();}catch(e){setError(e);}finally{setBusy(false);} }
  return <><div className="eyebrow">Không gian làm việc</div><h1>Dự án <em>của bạn.</em></h1><p className="lead">Theo dõi công việc và đọc kết quả ngay trên máy này.</p>
    {projects.length===0?<EmptyState title="Chưa có dự án"><p>Đăng ký một kho Git có sẵn để bắt đầu theo dõi. Sau khi đăng ký, mở Cài đặt để khởi tạo Bflow và GitNexus.</p></EmptyState>:<div className="card-grid">{projects.map(project=><Link className="project-card" key={project.projectId} to={`/projects/${encodeURIComponent(project.projectId)}`}><span className="eyebrow">{project.registrationState==='registered'?'Đã đăng ký':'Không truy cập được'}</span><h2>{project.displayName}</h2><p className="identifier">{project.canonicalPath}</p><span>Xem dự án →</span></Link>)}</div>}
    <section className="panel"><h2>Đăng ký dự án có sẵn</h2><form onSubmit={submit}><label htmlFor="path">Đường dẫn Git tuyệt đối</label><p id="path-help" className="muted">Dùng đường dẫn trên máy chạy Bflow. Sau khi đăng ký, mở Cài đặt để khởi tạo, chọn model và kiểm tra điều kiện chạy.</p><div className="input-row"><input id="path" required value={path} onChange={e=>setPath(e.target.value)} aria-describedby={error?'path-help path-error':'path-help'} aria-invalid={Boolean(error)} placeholder="/duong-dan/du-an"/><button disabled={busy} className="primary">{busy?'Đang đăng ký…':'Đăng ký dự án'}</button></div>{Boolean(error) && <p id="path-error" role="alert">{explain(error)}</p>}</form></section></>;
}
