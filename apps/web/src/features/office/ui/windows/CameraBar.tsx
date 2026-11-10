import type { ReactNode } from 'react';

export function CameraBar({children}:{children:ReactNode}) {
  return <div role="group" aria-label="Góc nhìn camera" className="office-cameras pointer-events-auto flex flex-wrap gap-1 self-start p-1 rounded-xl border border-line bg-surface/85 backdrop-blur-md">
    {children}
  </div>;
}
