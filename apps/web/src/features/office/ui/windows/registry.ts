import type { StickerIconName } from './icons';
import type { WindowKind } from './GameWindow';

export interface WindowDefinition { title:string; icon:StickerIconName; color:string; singleton:boolean; closable:boolean; }
export const WINDOW_REGISTRY:Record<WindowKind,WindowDefinition>={
  app:{title:'Tổng quan',icon:'overview',color:'var(--win-c-system)',singleton:true,closable:true},
  agent:{title:'Nhân viên',icon:'agents',color:'var(--win-c-people)',singleton:false,closable:true},
  unseated:{title:'Lập trình viên chưa hiện trong cảnh',icon:'agents',color:'var(--win-c-people)',singleton:true,closable:true},
  director:{title:'Director',icon:'chat',color:'var(--win-c-chat)',singleton:true,closable:true},
  'director-chat':{title:'Trò chuyện với Director',icon:'chat',color:'var(--win-c-chat)',singleton:true,closable:true},
  queue:{title:'Sự cố',icon:'issues',color:'var(--win-c-decide)',singleton:true,closable:true},
  cabinet:{title:'Tài liệu',icon:'docs',color:'var(--win-c-docs)',singleton:true,closable:true},
  server:{title:'Máy chủ',icon:'server',color:'var(--win-c-system)',singleton:true,closable:true},
  repair:{title:'Cần ghép nối lại',icon:'hourglass',color:'var(--win-c-alert)',singleton:true,closable:false},
  operations:{title:'Thao tác đã gửi',icon:'tasks',color:'var(--win-c-work)',singleton:true,closable:true},
  status:{title:'Trạng thái',icon:'settings',color:'var(--win-c-system)',singleton:true,closable:true},
};
