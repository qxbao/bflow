import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import type { WebProject } from '@bflow/contracts/web';
import { FieldHelp } from './FieldHelp';

/** `dockPx` is the height of the HUD's bottom block; on phones the panel stops above it so the operations dock is never covered. */
export type VisualShell={panelOpen:boolean;closable:boolean;dockPx:number;onClose:()=>void;onOverview:()=>void;inspectorRef:(element:HTMLElement|null)=>void;hudRef:(element:HTMLElement|null)=>void;stageRef:(element:HTMLElement|null)=>void};
export function AppShell({projects,projectId,visual,children}:{projects:WebProject[];projectId?:string;visual?:VisualShell|undefined;children:ReactNode}) {
  const navigate=useNavigate(), location=useLocation(), main=useRef<HTMLElement>(null);
  const [menuOpen,setMenuOpen]=useState(false);
  const menuButton=useRef<HTMLButtonElement>(null),menu=useRef<HTMLElement>(null);
  const panelClosed=Boolean(visual && !visual.panelOpen),panelClosedRef=useRef(panelClosed);panelClosedRef.current=panelClosed;
  // A closed visual panel is hidden: focus stays with whatever OfficeFrame restores instead of being pulled to <main>.
  useEffect(()=>{setMenuOpen(false);if(!panelClosedRef.current)main.current?.focus();},[location.pathname]);
  const base=projectId?`/projects/${encodeURIComponent(projectId)}`:undefined;
  const project=projects.find(item=>item.projectId===projectId);
  function toggleMenu(){if(menuOpen && menu.current?.contains(document.activeElement))menuButton.current?.focus();setMenuOpen(value=>!value);}
  return <div className={visual?'office-3d min-h-dvh':'min-h-dvh'} style={visual?{'--hud-h':`${visual.dockPx}px`} as CSSProperties:undefined}>
    <a className="sr-only absolute z-30 bg-surface p-3 focus:not-sr-only focus:top-2 focus:left-3" href={visual?'#office-hud':'#main'}>Bỏ qua điều hướng</a>
    <header className={`${visual?'hidden ':'flex '}min-h-14 items-center justify-between gap-3 border-b border-line px-4 sm:px-6`}>
      <Link className="shrink-0 font-display text-xl font-extrabold tracking-[.2em] text-ink no-underline hover:no-underline" to="/">B<span className="text-accent">FLOW</span></Link>
      <span className="hidden min-w-0 font-data text-xs text-muted sm:block">Không gian cục bộ <span aria-hidden="true">/</span> {project?.displayName??'Quản lý dự án'}</span>
      <button className="lg:hidden" ref={menuButton} aria-controls="workspace-navigation" aria-expanded={menuOpen} onClick={toggleMenu}>{menuOpen?'Đóng điều hướng':'Điều hướng'}</button>
      <span className="hidden font-data text-xs text-muted lg:block">Trên máy của bạn</span>
    </header>
    <div className="mx-auto grid max-w-[1680px] lg:min-h-[calc(100dvh-7rem)] lg:grid-cols-[224px_minmax(0,1fr)]">
      <aside id="workspace-navigation" ref={menu} className={`${visual?'hidden':menuOpen?'block':'hidden'} min-w-0 border-b border-line p-4 ${visual?'':'lg:block'} lg:border-r lg:border-b-0 lg:p-5`}>
        <div className="flex items-center justify-between gap-1.5">
          <label htmlFor="project">Dự án đang xem</label>
          <FieldHelp
            label="Dự án đang xem"
            help="Chuyển nhanh giữa các kho Git đã đăng ký trên máy này để xem tiến độ công việc, hộp phê duyệt hoặc cài đặt riêng của từng dự án."
          />
        </div>
        <select id="project" className="mt-2 mb-4" value={projectId??''} onChange={e=>navigate(e.target.value?`/projects/${encodeURIComponent(e.target.value)}`:'/')}>
          <option value="">Chọn dự án</option>{projects.map(item=><option key={item.projectId} value={item.projectId}>{item.displayName}</option>)}
        </select>
        <nav aria-label="Điều hướng chính" className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
          {base && <>{[['','Tổng quan'],['/runs','Công việc'],['/chat','Trò chuyện'],['/agents','Nhân viên'],['/review','Cần bạn quyết định'],['/issues','Sự cố đang treo'],['/settings','Cài đặt dự án']].map(([path,title])=><NavLink end={path===''} key={path} to={base+path} onClick={path===''&&visual?visual.onOverview:undefined} className="border-l-2 border-transparent px-3 py-2.5 font-data text-sm font-medium text-muted no-underline hover:bg-faint hover:no-underline aria-[current=page]:border-accent aria-[current=page]:bg-faint aria-[current=page]:text-ink lg:py-2">{title}</NavLink>)}</>}
          <NavLink end to="/" className="border-l-2 border-transparent px-3 py-2.5 font-data text-sm font-medium text-muted no-underline hover:bg-faint hover:no-underline aria-[current=page]:border-accent aria-[current=page]:bg-faint aria-[current=page]:text-ink lg:py-2">Quản lý dự án</NavLink>
        </nav>
        <p className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-muted">Đóng trình duyệt không dừng công việc. Trạng thái được đọc từ phiên dự án.</p>
      </aside>
      {visual && <><section ref={visual.stageRef} aria-label="Văn phòng" className="fixed inset-0 z-0 m-0 min-w-0 bg-canvas"/><section ref={visual.hudRef} id="office-hud" tabIndex={-1} aria-label="Thanh điều khiển" onKeyDown={e=>{if(e.key==='Escape' && visual.panelOpen && !e.defaultPrevented){e.preventDefault();visual.onClose();}}} className={`pointer-events-none fixed inset-y-0 left-0 z-30 m-0 ${visual.panelOpen?'right-0 md:right-[min(720px,70vw)]':'right-0'}`}/></>}
      <main id="main" ref={main} tabIndex={-1} onKeyDown={visual?e=>{if(e.key==='Escape' && !e.defaultPrevented){e.preventDefault();visual.onClose();}}:undefined} className={visual?`min-w-0 overflow-y-auto border-l border-line bg-surface/95 px-4 pt-5 pb-12 [overflow-wrap:anywhere] focus:outline-none sm:px-6 fixed top-0 right-0 bottom-[var(--hud-h,0px)] z-20 w-full backdrop-blur-md md:bottom-0 md:w-[min(720px,70vw)] md:max-w-full md:rounded-l-xl ${visual.panelOpen?'':'hidden'}`:'min-w-0 px-4 pt-5 pb-12 [overflow-wrap:anywhere] focus:outline-none sm:px-6 lg:px-8'}>{visual && <div className="mb-3 flex justify-end"><button type="button" disabled={!visual.closable} onClick={visual.onClose}>Đóng bảng</button></div>}{visual && <div ref={visual.inspectorRef}/>}{children}</main>
    </div>
    <footer className={`${visual?'hidden ':''}border-t border-line px-4 py-4 font-data text-xs text-muted sm:px-6`}>Bflow · Web cục bộ · Theo dõi và xem xét công việc</footer>
  </div>;
}
