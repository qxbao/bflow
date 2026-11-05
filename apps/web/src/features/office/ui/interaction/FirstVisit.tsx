import { useEffect, useState } from 'react';

const STEPS = [
  { title: 'Trao đổi với Director', detail: 'Chọn bàn Director để giao việc hoặc hỏi tiến độ. Gợi ý chỉ điền nội dung, bạn vẫn chủ động gửi.', action: 'Director' },
  { title: 'Theo dõi trên bảng việc', detail: 'Mở bảng công việc để xem tiến độ và bước tiếp theo.', action: 'Bảng công việc' },
  { title: 'Trả lời trong hộp thư', detail: 'Mở hộp thư để đọc yêu cầu và quyết định khi cần.', action: 'Hộp thư' },
] as const;
const storageKey = (projectId: string): string => `bflow:immersive-office:first-visit:${encodeURIComponent(projectId)}`;
const replayEvent = (projectId: string): string => `bflow:immersive-office:replay:${encodeURIComponent(projectId)}`;
export const replayFirstVisit = (projectId: string): void => { window.dispatchEvent(new Event(replayEvent(projectId))); };

/** Three-step optional guide. Navigation is delegated to the caller and never sends chat or a decision. */
export function FirstVisit({ projectId, active, onDirector, onTasks, onInbox }: {
  projectId: string; active: boolean; onDirector: () => void; onTasks: () => void; onInbox: () => void;
}) {
  const key = storageKey(projectId);
  const [step, setStep] = useState<number | null>(() => {
    try { return localStorage.getItem(key) === 'dismissed' || localStorage.getItem(key) === 'completed' ? null : 0; } catch { return 0; }
  });
  useEffect(() => { const replayGuide = (): void => setStep(0); const event = replayEvent(projectId); window.addEventListener(event, replayGuide); return () => window.removeEventListener(event, replayGuide); }, [projectId]);
  const save = (value: 'dismissed' | 'completed'): void => { try { localStorage.setItem(key, value); } catch { /* Private browsing can deny storage; the guide remains usable this visit. */ } setStep(null); };
  if (!active) return null;
  if (step === null) return null;
  const current = STEPS[Math.min(step ?? 0, STEPS.length - 1)]!;
  const action = step === 0 ? onDirector : step === 1 ? onTasks : onInbox;
  return <section aria-label="Hướng dẫn lần đầu" data-component="FirstVisit" className="pointer-events-auto w-full max-w-sm rounded-xl border border-line bg-surface/95 p-3 shadow-lg backdrop-blur-md">
    <p className="m-0 text-xs font-data text-muted">Bắt đầu · {step + 1}/3</p>
    <h2 className="my-1 text-base">{current.title}</h2>
    <p className="my-1 text-sm">{current.detail}</p>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" className="min-h-10" onClick={action}>{current.action}</button>
      {step < 2 ? <button type="button" className="min-h-10" onClick={() => setStep(step + 1)}>Tiếp</button> : <button type="button" className="min-h-10" onClick={() => save('completed')}>Hoàn tất</button>}
      <button type="button" className="min-h-10" onClick={() => save('dismissed')}>Bỏ qua</button>
    </div>
  </section>;
}
