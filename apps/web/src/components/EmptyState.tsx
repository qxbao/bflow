import type { ReactNode } from 'react';
export function EmptyState({title,children}:{title:string;children?:ReactNode}) { return <section className="min-w-0 border border-dashed border-line bg-surface p-5 sm:p-6"><h2>{title}</h2>{children}</section>; }
