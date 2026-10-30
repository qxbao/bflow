import { useEffect, useRef, type ReactNode } from 'react';
/** Inline confirmation preserves document order and avoids a modal focus trap. */
export function ActionConfirmation({title,children,onBack}:{title:string;children:ReactNode;onBack:()=>void}){
  const heading=useRef<HTMLHeadingElement>(null);useEffect(()=>{const previous=document.activeElement;heading.current?.focus();return()=>{if(previous instanceof HTMLElement && previous.isConnected)previous.focus();};},[]);
  return <section className="panel min-w-0 border border-line bg-surface p-4 sm:p-5" aria-label={title}><h3 ref={heading} tabIndex={-1}>{title}</h3>{children}<button type="button" onClick={onBack}>Quay lại</button></section>;
}
