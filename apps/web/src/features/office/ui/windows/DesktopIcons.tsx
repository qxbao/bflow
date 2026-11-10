import type { CSSProperties, ReactNode } from 'react';

export function DesktopIcons({children,style,className=''}:{children:ReactNode;style?:CSSProperties;className?:string}) {
  return <nav aria-label="Lối tắt" style={style} className={`pointer-events-auto office-rail absolute flex flex-col gap-1 p-1 ${className}`}>
    {children}
  </nav>;
}
