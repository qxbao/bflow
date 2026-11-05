import type { ReactNode } from 'react';

/** Persistent presentation shell for the shared Director chat. `hidden` keeps the chat controller mounted while leaving the desk. */
export function DirectorDialogue({active,onClose,children}:{active:boolean;onClose:()=>void;children:ReactNode}) {
  return <section aria-label="Hội thoại tại bàn Director" aria-hidden={!active} inert={!active} style={{display:active?undefined:'none'}} className="director-dialogue fixed inset-x-3 top-20 z-40 mx-auto m-0 flex max-h-[calc(100dvh-6rem)] w-[min(44rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl sm:inset-x-auto sm:right-6 sm:top-20 sm:bottom-6 sm:w-[min(44rem,calc(100vw-3rem))] sm:max-h-none">
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-2">
      <p className="m-0 font-data text-sm font-semibold">Director · Trao đổi</p>
      <button type="button" className="min-h-11" onClick={onClose} aria-label="Rời bàn Director">Rời bàn</button>
    </header>
    <div className="min-h-0 grow overflow-y-auto">{children}</div>
  </section>;
}
