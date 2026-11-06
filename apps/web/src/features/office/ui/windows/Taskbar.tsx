import { useWindows } from './WindowManager';
import type { UiMode } from '../../mode';
import { StartMenu } from './StartMenu';

const names: Record<string,string> = { app:'Tổng quan',agent:'Nhân viên',unseated:'Lập trình viên',director:'Director',queue:'Sự cố',cabinet:'Tài liệu',server:'Máy chủ',repair:'Ghép nối lại',operations:'Thao tác đã gửi',status:'Trạng thái','director-chat':'Trò chuyện với Director' };
export function Taskbar({ mode, onMode, onOverview, onRefresh, onCloseAll, projects, projectId, onProject, onNavigate, onDocuments, onGuide, onStatusOpen, statusText }: { mode:UiMode;onMode:(mode:UiMode)=>void;onOverview:()=>void;onRefresh:()=>void;onCloseAll:()=>void;projects:readonly {projectId:string;displayName:string}[];projectId:string;onProject:(projectId:string)=>void;onNavigate:(path:'runs'|'review'|'chat'|'agents'|'settings')=>void;onDocuments:()=>void;onGuide:()=>void;onStatusOpen:()=>void;statusText:string }) {
  const { windows, focus, resetLayout } = useWindows();
  const activeId=windows.filter(item=>item.display!=='minimized').sort((a,b)=>b.z-a.z)[0]?.id;
  return <nav className="bflow-taskbar" aria-label="Thanh tác vụ">
    <StartMenu mode={mode} onMode={onMode} onOverview={onOverview} onRefresh={onRefresh} onCloseAll={onCloseAll} onResetLayout={resetLayout} projects={projects} projectId={projectId} onProject={onProject} onNavigate={onNavigate} onDocuments={onDocuments} onGuide={onGuide} onStatusOpen={onStatusOpen} statusText={statusText}/>
    <div className="taskbar-windows" role="group" aria-label="Cửa sổ đang mở">{windows.filter(item=>item.kind!=='repair').map(item=><button key={item.id} type="button" aria-pressed={item.id===activeId&&item.display!=='minimized'} onClick={()=>focus(item.id)}>{names[item.kind]??item.kind}{item.kind==='agent'?` ${item.params?.instanceId??''}`:''}</button>)}</div>
    <div className="taskbar-end"><button type="button" className="taskbar-status" aria-label={`Mở trạng thái: ${statusText}`} onClick={onStatusOpen}>● {statusText}</button><div className="taskbar-mode" role="group" aria-label="Chế độ hiển thị"><button type="button" aria-pressed={mode==='classic'} onClick={()=>onMode('classic')}>Web</button><button type="button" aria-pressed={mode==='visual'} onClick={()=>onMode('visual')}>3D</button></div><button type="button" aria-label="Tải lại dữ liệu" onClick={onRefresh}>⟳</button></div>
  </nav>;
}
