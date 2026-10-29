import { useEffect, useRef, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import type { WebProject } from '@bflow/contracts/web';
export function AppShell({projects,projectId,children}:{projects:WebProject[];projectId?:string;children:ReactNode}) {
  const navigate=useNavigate(), location=useLocation(), main=useRef<HTMLElement>(null);
  useEffect(()=>{main.current?.focus();},[location.pathname]);
  const base=projectId?`/projects/${encodeURIComponent(projectId)}`:undefined;
  return <><a className="skip" href="#main">Bỏ qua điều hướng</a><header><Link className="brand" to="/">B<b>FLOW</b><span> / Không gian cục bộ</span></Link><span className="local">Trên máy của bạn</span></header>
    <div className="layout"><aside><label htmlFor="project">Dự án đang xem</label><select id="project" value={projectId??''} onChange={e=>navigate(e.target.value?`/projects/${encodeURIComponent(e.target.value)}`:'/')}><option value="">Chọn dự án</option>{projects.map(project=><option key={project.projectId} value={project.projectId}>{project.displayName}</option>)}</select>
    <nav aria-label="Điều hướng chính">{base && <>{[['','Tổng quan'],['/runs','Công việc'],['/review','Cần bạn quyết định'],['/settings','Cài đặt dự án']].map(([path,title])=><NavLink end={path===''} key={path} to={base+path}>{title}</NavLink>)}<span className="nav-disabled">Trò chuyện <small>Chưa hỗ trợ</small></span></>}<NavLink end to="/">Quản lý dự án</NavLink></nav><p className="aside-note">Đóng trình duyệt không dừng công việc. Trạng thái được đọc từ phiên dự án.</p></aside>
    <main id="main" ref={main} tabIndex={-1}>{children}</main></div><footer>Bflow · Web cục bộ · Theo dõi và xem xét công việc</footer></>;
}
