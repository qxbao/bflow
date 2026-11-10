import type { ReactNode } from 'react';

export function StatusTray({children}:{children:ReactNode}) {
  return <details aria-label="Trạng thái văn phòng" className="office-status mt-2 border-t border-line pt-1.5 font-data text-xs text-ink">
    {children}
  </details>;
}
