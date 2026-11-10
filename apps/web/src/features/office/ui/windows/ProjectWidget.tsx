import { forwardRef, type ReactNode } from 'react';

export const ProjectWidget=forwardRef<HTMLElement,{children:ReactNode;className?:string}>(function ProjectWidget({children,className=''},ref) {
  return <section ref={ref} aria-label="Văn phòng Bflow" className={`pointer-events-auto m-0 min-w-0 p-3 office-project-widget ${className}`}>{children}</section>;
});
