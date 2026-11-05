import { useEffect, type ReactNode } from 'react';

/** Persistent presentation shell for the shared Director chat. `hidden` keeps the chat controller mounted while leaving the desk. */
export function DirectorDialogue({ active, onClose, children }: { active: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (active) requestAnimationFrame(() => document.querySelector<HTMLElement>('.director-dialogue > header button')?.focus());
  }, [active]);
  return <>
    <div aria-hidden="true" onClick={onClose} className="fixed inset-0 z-40 bg-ink/10" />
    <section role="region" aria-label="Hội thoại tại bàn Director" aria-hidden={!active} style={{ display: active ? undefined : 'none' }} className="director-dialogue fixed inset-x-2 top-[max(0.5rem,env(safe-area-inset-top))] bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-50 mx-auto m-0 flex max-h-none w-[min(44rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl sm:inset-x-auto sm:right-6 sm:top-5 sm:bottom-6 sm:w-[min(44rem,calc(100vw-3rem))]">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-2">
        <p className="m-0 font-data text-sm font-semibold">Director · Trao đổi</p>
        <button type="button" className="min-h-11" onClick={onClose} aria-label="Rời bàn Director">Rời bàn</button>
      </header>
      <div className="min-h-0 grow overflow-hidden overscroll-contain">{children}</div>
    </section>
  </>;
}
