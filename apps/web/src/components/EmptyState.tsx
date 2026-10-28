import type { ReactNode } from 'react';
export function EmptyState({title,children}:{title:string;children?:ReactNode}) { return <section className="empty"><h2>{title}</h2>{children}</section>; }
