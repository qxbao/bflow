import { useWindows } from './WindowManager';
import type { UiMode } from '../../mode';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { StartMenu } from './StartMenu';
import { StickerIcon, type StickerIconName } from './icons';
import { WINDOW_REGISTRY } from './registry';

const names: Record<string,string> = { app:'Tổng quan',agent:'Nhân viên',unseated:'Lập trình viên',director:'Director',queue:'Sự cố',cabinet:'Tài liệu',server:'Máy chủ',repair:'Ghép nối lại',operations:'Thao tác đã gửi',status:'Trạng thái','director-chat':'Trò chuyện với Director' };
export function Taskbar({ mode, onMode, onOverview, onHistory, onPageReload, onRefresh, onCloseAll, projects, projectId, onProject, onNavigate, onDocuments, onGuide, onStatusOpen, statusText, quickChat }: { mode:UiMode;onMode:(mode:UiMode)=>void;onOverview:()=>void;onHistory?:(delta:-1|1)=>void;onPageReload?:()=>void;onRefresh:()=>void;onCloseAll:()=>void;projects:readonly {projectId:string;displayName:string}[];projectId:string;onProject:(projectId:string)=>void;onNavigate:(path:'runs'|'review'|'chat'|'agents'|'settings')=>void;onDocuments:()=>void;onGuide:()=>void;onStatusOpen:()=>void;statusText:string;quickChat:ReactNode }) {
  const { windows, focus, resetLayout } = useWindows();
  const location=useLocation(),routeBase=location.pathname.match(/^\/projects\/[^/]+/)?.[0]??'',route=routeBase?location.pathname.slice(routeBase.length):location.pathname;
  const appTitle=route===''||route==='/'?'Tổng quan':route==='/runs'?'Công việc':route.startsWith('/runs/')?'Công việc / Chi tiết':route==='/chat'||route.startsWith('/chat/')?'Trò chuyện':route==='/agents'?'Nhân viên':route==='/review'?'Cần bạn quyết định':route.startsWith('/issues')?'Sự cố':route==='/settings'?'Cài đặt dự án':'Tổng quan';
  const appIcon:StickerIconName=route.startsWith('/runs')?'tasks':route.startsWith('/chat')?'chat':route.startsWith('/review')?'decision':route.startsWith('/issues')?'issues':route.startsWith('/agents')?'agents':route.startsWith('/settings')?'settings':'overview';
  const activeId=windows.filter(item=>item.display!=='minimized').sort((a,b)=>b.z-a.z)[0]?.id;
  return <nav className="bflow-taskbar" aria-label="Thanh tác vụ">
    <StartMenu onOverview={onOverview} {...(onHistory?{onHistory}:{})} {...(onPageReload?{onPageReload}:{})} onCloseAll={onCloseAll} onResetLayout={resetLayout} projects={projects} projectId={projectId} onProject={onProject} onNavigate={onNavigate} onDocuments={onDocuments} onGuide={onGuide}/>
    <div className="taskbar-windows" role="group" aria-label="Cửa sổ đang mở">{windows.filter(item=>item.kind!=='repair').map(item=><button key={item.id} type="button" aria-pressed={item.id===activeId&&item.display!=='minimized'} onClick={()=>focus(item.id)}><StickerIcon name={item.kind==='app'?appIcon:WINDOW_REGISTRY[item.kind].icon} className="taskbar-button-icon"/><span>{item.kind==='app'?appTitle:names[item.kind]??item.kind}{item.kind==='agent'?` ${item.params?.instanceId??''}`:''}</span></button>)}</div>
    {quickChat}
    <div className="taskbar-end"><button type="button" className="taskbar-status" aria-label={`Mở trạng thái: ${statusText}`} title={statusText} onClick={onStatusOpen}><span aria-hidden="true" className={`taskbar-live-dot ${/lỗi|cũ|kiểm tra|ghép nối|chờ/i.test(statusText)?'is-warning':''}`}/></button><div className="taskbar-mode" role="group" aria-label="Chế độ hiển thị"><button type="button" aria-pressed={mode==='classic'} onClick={()=>onMode('classic')}>Web</button><button type="button" aria-pressed={mode==='visual'} onClick={()=>onMode('visual')}>3D</button></div><button type="button" aria-label="Tải lại dữ liệu" onClick={onRefresh}>⟳</button></div>
  </nav>;
}
