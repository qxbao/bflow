import { useEffect, useId, useRef, useState } from 'react';
import { StickerIcon, type StickerIconName } from './icons';

export interface StartMenuProps {
  onOverview:()=>void;
  onHistory?:(delta:-1|1)=>void;
  onPageReload?:()=>void;
  onCloseAll:()=>void;
  onResetLayout:()=>void;
  projects:readonly {projectId:string;displayName:string}[];
  projectId:string;
  onProject:(projectId:string)=>void;
  onNavigate:(path:'runs'|'review'|'chat'|'agents'|'settings')=>void;
  onQueue?:()=>void;
  onDocuments:()=>void;
  onGuide:()=>void;
}

export function StartMenu(props:StartMenuProps){
  const [open,setOpen]=useState(false);
  const id=useId(),trigger=useRef<HTMLButtonElement>(null);
  const close=(action:()=>void)=>()=>{action();setOpen(false);};
  useEffect(()=>{if(!open)return;const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[open]);
  const mobile:[StickerIconName,string,()=>void][]=[
    ['overview','Tổng quan',props.onOverview],['tasks','Công việc',()=>props.onNavigate('runs')],
    ['decision','Quyết định',()=>props.onNavigate('review')],['chat','Trò chuyện',()=>props.onNavigate('chat')],
    ...(props.onQueue?[['issues','Sự cố',props.onQueue] as [StickerIconName,string,()=>void]]:[]),
    ['agents','Nhân viên',()=>props.onNavigate('agents')],['settings','Cài đặt',()=>props.onNavigate('settings')],
    ['docs','Tài liệu',props.onDocuments],
  ];
  return <div className="taskbar-start-wrap"><button ref={trigger} type="button" className="taskbar-start" aria-label="◆ Bflow" aria-haspopup="true" aria-controls={id} aria-expanded={open} onClick={()=>setOpen(value=>!value)}><StickerIcon name="start" className="taskbar-button-icon"/><span>Bflow</span></button>{open&&<div id={id} role="group" aria-label="Menu Bflow" className="taskbar-start-menu">
    <div className="taskbar-mobile-menu"><label>Dự án<select aria-label="Chuyển dự án" value={props.projectId} onChange={event=>{props.onProject(event.target.value);setOpen(false);}}>{props.projects.some(item=>item.projectId===props.projectId)?null:<option value={props.projectId}>Dự án hiện tại</option>}{props.projects.map(item=><option key={item.projectId} value={item.projectId}>{item.displayName}</option>)}<option value="">Quản lý dự án…</option></select></label>
      {mobile.map(([icon,label,action])=><button key={label} type="button" onClick={close(action)}><StickerIcon name={icon} className="taskbar-button-icon"/>{label}</button>)}
      <button type="button" onClick={close(props.onGuide)}><StickerIcon name="hourglass" className="taskbar-button-icon"/>Xem lại hướng dẫn</button>
    </div>
    {props.onHistory&&<div className="taskbar-history-menu"><button onClick={close(()=>props.onHistory?.(-1))}>← Quay lại</button><button onClick={close(()=>props.onHistory?.(1))}>Tiến →</button><button onClick={close(()=>props.onPageReload?.())}>⟳ Tải lại trang</button></div>}
    <button type="button" onClick={close(props.onResetLayout)}><StickerIcon name="refresh" className="taskbar-button-icon"/>Sắp xếp lại cửa sổ</button>
    <button type="button" onClick={close(props.onCloseAll)}><StickerIcon name="queue" className="taskbar-button-icon"/>Đóng mọi cửa sổ</button>
  </div>}</div>;
}
