import { useState } from 'react';
import type { UiMode } from '../../mode';

export interface StartMenuProps { mode:UiMode;onMode:(mode:UiMode)=>void;onOverview:()=>void;onRefresh:()=>void;onCloseAll:()=>void;onResetLayout:()=>void;projects:readonly {projectId:string;displayName:string}[];projectId:string;onProject:(projectId:string)=>void;onNavigate:(path:'runs'|'review'|'chat'|'agents'|'settings')=>void;onDocuments:()=>void;onGuide:()=>void;onStatusOpen:()=>void;statusText:string }
export function StartMenu(props:StartMenuProps){
  const [open,setOpen]=useState(false);
  const close=(action:()=>void)=>()=>{action();setOpen(false);};
  return <div className="taskbar-start-wrap"><button type="button" className="taskbar-start" aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>◆ Bflow</button>{open&&<div role="menu" className="taskbar-start-menu">
    <label>Dự án<select aria-label="Chuyển dự án" value={props.projectId} onChange={event=>{props.onProject(event.target.value);setOpen(false);}}>{props.projects.some(item=>item.projectId===props.projectId)?null:<option value={props.projectId}>Dự án hiện tại</option>}{props.projects.map(item=><option key={item.projectId} value={item.projectId}>{item.displayName}</option>)}<option value="">Quản lý dự án…</option></select></label>
    <button role="menuitem" onClick={close(props.onOverview)}>Tổng quan</button>{(['runs','review','chat','agents','settings'] as const).map((path,index)=><button role="menuitem" key={path} onClick={close(()=>props.onNavigate(path))}>{['Công việc','Quyết định','Trò chuyện','Nhân viên','Cài đặt'][index]}</button>)}
    <button role="menuitem" onClick={close(props.onDocuments)}>Tài liệu</button><button role="menuitem" onClick={close(props.onStatusOpen)}>Trạng thái · {props.statusText}</button><button role="menuitem" onClick={close(props.onGuide)}>Xem lại hướng dẫn</button>
    <button role="menuitem" onClick={close(()=>props.onMode(props.mode==='visual'?'classic':'visual'))}>{props.mode==='visual'?'Chế độ Web':'Chế độ 3D'}</button><button role="menuitem" onClick={close(props.onResetLayout)}>Sắp xếp lại cửa sổ</button><button role="menuitem" onClick={close(props.onCloseAll)}>Đóng mọi cửa sổ</button><button role="menuitem" onClick={close(props.onRefresh)}>Tải lại dữ liệu</button>
  </div>}</div>;
}
