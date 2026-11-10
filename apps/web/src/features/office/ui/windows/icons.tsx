import type { SVGProps } from 'react';

export type StickerIconName =
  | 'overview'
  | 'tasks'
  | 'decision'
  | 'chat'
  | 'issues'
  | 'agents'
  | 'docs'
  | 'settings'
  | 'refresh'
  | 'hourglass'
  | 'start'
  | 'server'
  | 'queue';

const shapes: Record<StickerIconName, React.ReactNode> = {
  overview: <><rect x="3.5" y="4" width="17" height="13" rx="1.5"/><path d="M8 21h8M12 17v4M7 8h10M7 12h6"/></>,
  tasks: <><path d="M7 3h10v3H7z"/><rect x="4.5" y="5" width="15" height="16" rx="2"/><path d="m8 11 1.5 1.5L12 10M14 12h3M8 17h9"/></>,
  decision: <><path d="M4 12.5 7 5h10l3 7.5V20H4z"/><path d="M4 12.5h5l1.5 2h3l1.5-2h5M9 8h6"/></>,
  chat: <path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-7L6 21v-4.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5Z"/>,
  issues: <><path d="m12 3 9 17H3z"/><path d="M12 9v5M12 17v.3"/></>,
  agents: <><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.4"/><path d="M16.3 14.4a5.5 5.5 0 0 1 5.2 5.6"/></>,
  docs: <><path d="M6 3.5h8l4.5 4.5v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4.5 20V5A1.5 1.5 0 0 1 6 3.5Z"/><path d="M14 4v5h5M8 13h8M8 17h8"/></>,
  settings: <><path d="M5 7h14M5 12h14M5 17h14"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="11" cy="17" r="2"/></>,
  refresh: <><path d="M20 11a8 8 0 1 0 1 4"/><path d="M20 4v7h-7"/></>,
  hourglass: <><path d="M6 3.5h12M6 20.5h12M7 4c0 4 5 5 5 8s-5 4-5 8M17 4c0 4-5 5-5 8s5 4 5 8"/><path d="M9 16h6"/></>,
  start: <><path d="m12 2.5 9.5 9.5-9.5 9.5L2.5 12z"/><path d="M9 9h6v6H9z"/></>,
  server: <><rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M7.5 7.5h.1M7.5 16.5h.1M11 7.5h5M11 16.5h5"/></>,
  queue: <><path d="M6 4h15M6 10h15M6 16h15"/><circle cx="3" cy="4" r=".6"/><circle cx="3" cy="10" r=".6"/><circle cx="3" cy="16" r=".6"/></>,
};

const fills: Record<StickerIconName, string> = {
  overview: '#77d7e8',
  tasks: '#f28dbd',
  decision: '#ffc15a',
  chat: '#b49cff',
  issues: '#ff876f',
  agents: '#68c6bd',
  docs: '#79a9ee',
  settings: '#b5a8ed',
  refresh: '#8ecb84',
  hourglass: '#f2c76d',
  start: '#ffc400',
  server: '#82b3ed',
  queue: '#f0a3c3',
};

export function StickerIcon({ name, className, ...props }: { name: StickerIconName; className?: string } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill={fills[name]} stroke="var(--win-ink, #1b1033)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>{shapes[name]}</svg>;
}
