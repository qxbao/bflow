import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import type { WebProject } from '@bflow/contracts/web';

export function AppShell({projects,projectId,children}:{projects:WebProject[];projectId?:string;children:ReactNode}) {
  const navigate=useNavigate(), location=useLocation(), main=useRef<HTMLElement>(null);
  const [menuOpen,setMenuOpen]=useState(false);
  const menuButton=useRef<HTMLButtonElement>(null),menu=useRef<HTMLElement>(null);
  useEffect(()=>{setMenuOpen(false);main.current?.focus();},[location.pathname]);
  const base=projectId?`/projects/${encodeURIComponent(projectId)}`:undefined;
  const project=projects.find(item=>item.projectId===projectId);
  function toggleMenu(){if(menuOpen && menu.current?.contains(document.activeElement))menuButton.current?.focus();setMenuOpen(value=>!value);}
  return <div className="min-h-dvh">
    <a className="sr-only absolute z-30 bg-surface p-3 focus:not-sr-only focus:top-2 focus:left-3" href="#main">Bỏ qua điều hướng</a>
    <header className="flex min-h-14 items-center justify-between gap-3 border-b border-line px-4 sm:px-6">
      <Link className="shrink-0 font-display text-xl font-extrabold tracking-[.2em] text-ink no-underline hover:no-underline" to="/">B<span className="text-accent">FLOW</span></Link>
      <span className="hidden min-w-0 font-data text-xs text-muted sm:block">Không gian cục bộ <span aria-hidden="true">/</span> {project?.displayName??'Quản lý dự án'}</span>
      <button className="lg:hidden" ref={menuButton} aria-controls="workspace-navigation" aria-expanded={menuOpen} onClick={toggleMenu}>{menuOpen?'Đóng điều hướng':'Điều hướng'}</button>
      <span className="hidden font-data text-xs text-muted lg:block">Trên máy của bạn</span>
    </header>
    <div className="mx-auto grid max-w-[1680px] lg:min-h-[calc(100dvh-7rem)] lg:grid-cols-[224px_minmax(0,1fr)]">
      <aside id="workspace-navigation" ref={menu} className={`${menuOpen?'block':'hidden'} min-w-0 border-b border-line p-4 lg:block lg:border-r lg:border-b-0 lg:p-5`}>
        <label htmlFor="project">Dự án đang xem</label>
        <select id="project" className="mt-2 mb-4" value={projectId??''} onChange={e=>navigate(e.target.value?`/projects/${encodeURIComponent(e.target.value)}`:'/')}>
          <option value="">Chọn dự án</option>{projects.map(item=><option key={item.projectId} value={item.projectId}>{item.displayName}</option>)}
        </select>
        <nav aria-label="Điều hướng chính" className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
          {base && <>{[['','Tổng quan'],['/runs','Công việc'],['/review','Cần bạn quyết định'],['/settings','Cài đặt dự án']].map(([path,title])=><NavLink end={path===''} key={path} to={base+path} className="border-l-2 border-transparent px-3 py-2.5 font-data text-sm font-medium text-muted no-underline hover:bg-faint hover:no-underline aria-[current=page]:border-accent aria-[current=page]:bg-faint aria-[current=page]:text-ink lg:py-2">{title}</NavLink>)}</>}
          <NavLink end to="/" className="border-l-2 border-transparent px-3 py-2.5 font-data text-sm font-medium text-muted no-underline hover:bg-faint hover:no-underline aria-[current=page]:border-accent aria-[current=page]:bg-faint aria-[current=page]:text-ink lg:py-2">Quản lý dự án</NavLink>
        </nav>
        <p className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-muted">Đóng trình duyệt không dừng công việc. Trạng thái được đọc từ phiên dự án.</p>
      </aside>
      <main id="main" ref={main} tabIndex={-1} className="min-w-0 px-4 pt-5 pb-12 [overflow-wrap:anywhere] focus:outline-none sm:px-6 lg:px-8">{children}</main>
    </div>
    <footer className="border-t border-line px-4 py-4 font-data text-xs text-muted sm:px-6">Bflow · Web cục bộ · Theo dõi và xem xét công việc</footer>
  </div>;
}
