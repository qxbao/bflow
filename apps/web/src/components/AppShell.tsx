import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import type { WebProject } from '@bflow/contracts/web';
import { FieldHelp } from './FieldHelp';
import { GameWindow } from '../features/office/ui/windows/GameWindow';
import { defaultRect } from '../features/office/ui/windows/geometry';
import { useWindows } from '../features/office/ui/windows/WindowManager';
import type { WindowDisplay, WindowRect } from '../features/office/ui/windows/GameWindow';

/** `dockPx` is the height of the HUD's bottom block; on phones the panel stops above it so the operations dock is never covered. */
export type VisualShell={panelOpen:boolean;closable:boolean;immersive?:boolean;dockPx:number;onClose:()=>void;onOverview:()=>void;windowsRef:(element:HTMLElement|null)=>void;hudRef:(element:HTMLElement|null)=>void;stageRef:(element:HTMLElement|null)=>void};
export function isEscapeDismissal(event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'isComposing'>): boolean { return event.key==='Escape'&&!event.defaultPrevented&&!event.isComposing; }
interface AppWindowActions { focus:()=>void;minimize:()=>void;toggleMaximize:()=>void;move:(dx:number,dy:number)=>void;resize:(dw:number,dh:number)=>void }
interface AppWindowView { rect:WindowRect;display:WindowDisplay;z:number;active:boolean }
function AppWindowBridge({open,routeKey,onState,actionsRef}:{open:boolean;routeKey:string;onState:(state:AppWindowView|null)=>void;actionsRef:{current:AppWindowActions|null}}){
  const manager=useWindows(),app=manager.windows.find(window=>window.id==='app');
  const previousRoute=useRef(routeKey);
  useEffect(()=>{if(open&&!app)manager.open('app');else if(!open&&app)manager.close('app');else if(open&&app?.display==='minimized'&&previousRoute.current!==routeKey)manager.focus('app');previousRoute.current=routeKey;},[open,Boolean(app),app?.display,routeKey,manager.open,manager.close,manager.focus]);
  useEffect(()=>{
    actionsRef.current={focus:()=>manager.focus('app'),minimize:()=>manager.minimize('app'),toggleMaximize:()=>manager.toggleMaximize('app'),move:(dx,dy)=>manager.move('app',dx,dy),resize:(dw,dh)=>manager.resize('app',dw,dh)};
    const top=manager.windows.filter(item=>item.display!=='minimized').sort((a,b)=>b.z-a.z)[0];
    const layer=document.getElementById('office-windows');if(layer)layer.style.zIndex=top?.kind==='repair'?'2000':top?.id==='app'?'0':'50';
    onState(app?{rect:app.rect,display:app.display,z:app.z,active:top?.id==='app'}:null);
  },[manager.windows,manager.minimize,manager.toggleMaximize,manager.move,manager.resize,app,onState,actionsRef]);
  return null;
}
export function AppShell({projects,projectId,visual,modeSwitch,children}:{projects:WebProject[];projectId?:string;visual?:VisualShell|undefined;modeSwitch?:ReactNode;children:ReactNode}) {
  const navigate=useNavigate(), location=useLocation(), main=useRef<HTMLElement>(null);
  const [menuOpen,setMenuOpen]=useState(false);
  const [chromeHost,setChromeHost]=useState<HTMLElement|null>(null);
  const [appWindow,setAppWindow]=useState<AppWindowView|null>(null),actionsRef=useRef<AppWindowActions|null>(null);
  const appRect=appWindow?.rect??defaultRect('app',{width:window.innerWidth,height:window.innerHeight});
  const appDisplay=appWindow?.display??'normal';
  const routeBase=projectId?`/projects/${encodeURIComponent(projectId)}`:'';
  const routeTail=routeBase?location.pathname.slice(routeBase.length):location.pathname;
  const currentTitle=routeTail===''||routeTail==='/'?(projectId?'Tổng quan':'Quản lý dự án'):routeTail==='/runs'?'Công việc':routeTail.startsWith('/runs/')?'Công việc / Chi tiết':routeTail==='/chat'||routeTail.startsWith('/chat/')?'Trò chuyện':routeTail==='/agents'?'Nhân viên':routeTail==='/issues'||routeTail.startsWith('/issues/')?'Sự cố':routeTail==='/review'?'Cần bạn quyết định':routeTail==='/settings'?'Cài đặt dự án':'Không tìm thấy';
  const currentIcon=currentTitle==='Công việc'?'tasks':currentTitle==='Trò chuyện'?'chat':currentTitle==='Nhân viên'?'agents':currentTitle==='Cần bạn quyết định'||currentTitle==='Sự cố'?'decision':currentTitle==='Cài đặt dự án'?'settings':'overview';
  const currentColor=currentTitle==='Công việc'?'var(--win-c-work)':currentTitle==='Trò chuyện'?'var(--win-c-chat)':currentTitle==='Nhân viên'?'var(--win-c-people)':currentTitle==='Cần bạn quyết định'||currentTitle==='Sự cố'?'var(--win-c-decide)':'var(--win-c-system)';
  const appMove=(dx:number,dy:number)=>{actionsRef.current?.move(dx,dy);requestAnimationFrame(()=>window.dispatchEvent(new Event('bflow:windows-changed')));};
  const appResize=(dw:number,dh:number)=>{actionsRef.current?.resize(dw,dh);requestAnimationFrame(()=>window.dispatchEvent(new Event('bflow:windows-changed')));};
  const menuButton=useRef<HTMLButtonElement>(null),menu=useRef<HTMLElement>(null);
  const panelClosed=Boolean(visual && !visual.panelOpen),panelClosedRef=useRef(panelClosed);panelClosedRef.current=panelClosed;
  // A closed visual panel is hidden: focus stays with whatever OfficeFrame restores instead of being pulled to <main>.
  useEffect(()=>{setMenuOpen(false);if(!panelClosedRef.current)main.current?.focus();},[location.pathname]);
  const base=projectId?`/projects/${encodeURIComponent(projectId)}`:undefined;
  const project=projects.find(item=>item.projectId===projectId);
  function toggleMenu(){if(menuOpen && menu.current?.contains(document.activeElement))menuButton.current?.focus();setMenuOpen(value=>!value);}
  return <div className={visual?`workspace-shell office-3d min-h-dvh ${visual.immersive?'office-immersive':''}`:'workspace-shell min-h-dvh'} style={visual?{'--hud-h':`${visual.dockPx}px`} as CSSProperties:undefined}>
    <a className="sr-only absolute z-30 bg-surface p-3 focus:not-sr-only focus:top-2 focus:left-3" href={visual?'#office-hud':'#main'}>Bỏ qua điều hướng</a>
    {/* Web mode: the Web | 3D pill sits where the 3D HUD puts it (16px from the top-right corner), so switching never moves it. */}
    {modeSwitch && <div className="absolute top-4 right-4 z-40">{modeSwitch}</div>}
    <header className={`${visual?'hidden ':'flex '}min-h-14 items-center justify-between gap-3 border-b border-line px-4 sm:px-6 ${modeSwitch?'pr-32 sm:pr-36':''}`}>
      <Link className="shrink-0 font-display text-xl font-extrabold tracking-[.2em] text-ink no-underline hover:no-underline" to="/">B<span className="text-accent">FLOW</span></Link>
      <span className="hidden min-w-0 font-data text-xs text-muted sm:block">Không gian làm việc <span aria-hidden="true">/</span> {project?.displayName??'Quản lý dự án'}</span>
      <button className="lg:hidden" ref={menuButton} aria-controls="workspace-navigation" aria-expanded={menuOpen} onClick={toggleMenu}>{menuOpen?'Đóng điều hướng':'Điều hướng'}</button>
      <span className="hidden font-data text-xs text-muted lg:block">Trên máy của bạn</span>
    </header>
    <div className="workspace-grid mx-auto grid max-w-[1680px] lg:min-h-[calc(100dvh-7rem)] lg:grid-cols-[232px_minmax(0,1fr)]">
      <aside id="workspace-navigation" ref={menu} className={`${visual?'hidden':menuOpen?'block':'hidden'} workspace-navigation min-w-0 border-b border-line p-4 ${visual?'':'lg:block'} lg:border-r lg:border-b-0 lg:p-5`}>
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
          {base && <>{[['','Tổng quan'],['/runs','Công việc'],['/chat','Trò chuyện'],['/agents','Nhân viên'],['/review','Cần bạn quyết định'],['/issues','Cần xử lý'],['/settings','Cài đặt dự án']].map(([path,title])=><NavLink end={path===''} key={path} to={base+path} onClick={path===''&&visual?visual.onOverview:undefined} className="border-l-2 border-transparent px-3 py-2.5 font-data text-sm font-medium text-muted no-underline hover:bg-faint hover:no-underline aria-[current=page]:border-accent aria-[current=page]:bg-faint aria-[current=page]:text-ink lg:py-2">{title}</NavLink>)}</>}
          <NavLink end to="/" className="border-l-2 border-transparent px-3 py-2.5 font-data text-sm font-medium text-muted no-underline hover:bg-faint hover:no-underline aria-[current=page]:border-accent aria-[current=page]:bg-faint aria-[current=page]:text-ink lg:py-2">Quản lý dự án</NavLink>
        </nav>
        <p className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-muted">Đóng trình duyệt không dừng công việc. Bạn có thể quay lại bất cứ lúc nào.</p>
      </aside>
      {visual && <><AppWindowBridge open={visual.panelOpen} routeKey={location.pathname} onState={setAppWindow} actionsRef={actionsRef}/><section ref={visual.stageRef} aria-label="Văn phòng" className="office-stage fixed inset-0 z-0 m-0 min-w-0 bg-canvas"/><section ref={visual.hudRef} id="office-hud" tabIndex={-1} aria-label="Thanh điều khiển" onKeyDown={e=>{if(isEscapeDismissal(e.nativeEvent) && visual.panelOpen){e.preventDefault();visual.onClose();}}} className="office-hud-root pointer-events-none fixed inset-y-0 left-0 right-0 z-30 m-0"/><section ref={visual.windowsRef} id="office-windows" aria-label="Cửa sổ công cụ" className="office-windows pointer-events-none fixed inset-0 m-0"/></>}
      <main id="main" ref={main} tabIndex={-1} role={visual?'dialog':undefined} aria-modal={visual?'false':undefined} aria-labelledby={visual?'app-window-title':undefined} data-window-kind={visual?'app':undefined} data-display={visual?appDisplay:undefined} data-active={appWindow?.active??true} hidden={visual?(!visual.panelOpen||appDisplay==='minimized'):undefined} onKeyDown={visual?e=>{if(isEscapeDismissal(e.nativeEvent)){if(e.target instanceof Element && e.target.closest('dialog[open]'))return;e.preventDefault();visual.onClose();}}:undefined} className={visual?`workspace-main bwin bwin-app min-w-0 overflow-hidden bg-surface px-0 pt-0 pb-0 [overflow-wrap:anywhere] focus:outline-none fixed z-40 ${visual.panelOpen&&appDisplay!=='minimized'?'':'hidden'}`:'workspace-main min-w-0 px-4 pt-5 pb-12 [overflow-wrap:anywhere] focus:outline-none sm:px-6 lg:px-10'} style={visual?{'--app-left':`${visual.panelOpen&&appDisplay!=='minimized'?appRect.x:window.innerWidth}px`,left:appDisplay==='maximized'?0:appRect.x,top:appDisplay==='maximized'?0:appRect.y,width:appDisplay==='maximized'?'100vw':appRect.w,height:appDisplay==='maximized'?'calc(100dvh - 56px)':appRect.h,zIndex:(appWindow?.z??0)+40} as CSSProperties:undefined}>
        <div ref={setChromeHost} className={visual?'bwin-chrome-host':'classic-chrome-host'}/>
        <div className={visual?'bwin-body workspace-main-content':'classic-route-host'}>{children}</div>
      </main>
      {visual&&chromeHost&&createPortal(<GameWindow id="app" kind="app" title={currentTitle} titleId="app-window-title" icon={currentIcon} color={currentColor} rect={appRect} display={appDisplay} z={appWindow?.z??1} active={appWindow?.active??true} closable={visual.closable} minimizable maximizable movable={window.innerWidth>=1100} resizable={window.innerWidth>=1100} onFocus={()=>actionsRef.current?.focus()} onClose={visual.onClose} onMinimize={()=>actionsRef.current?.minimize()} onToggleMaximize={()=>actionsRef.current?.toggleMaximize()} onMove={appMove} onResize={appResize} embedded nav={<div className="bwin-nav-buttons"><button aria-label="Quay lại" onClick={()=>navigate(-1)}>←</button><button aria-label="Tiến" onClick={()=>navigate(1)}>→</button><button aria-label="Tải lại trang" onClick={()=>navigate(0)}>⟳</button><span>{currentTitle}</span></div>}/>,chromeHost)}
    </div>
    <footer className={`${visual?'hidden ':''}border-t border-line px-4 py-4 font-data text-xs text-muted sm:px-6`}>Bflow · Web cục bộ · Theo dõi và xem xét công việc</footer>
  </div>;
}
