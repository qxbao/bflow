import { createContext, useContext, useState, type ReactNode } from 'react';
import { WebDecisionSchema } from '@bflow/contracts/web';
import type { DecisionDraft } from '../../../decisions';
import { immersiveOfficeEnabled } from '../../immersive';

type DraftStore = { drafts: Record<string, DecisionDraft>; setDraft: (key: string, draft: DecisionDraft) => void };
const Context = createContext<DraftStore | undefined>(undefined);

export function DecisionDraftProvider({ value, children }: { value: DraftStore; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDecisionDrafts() {
  const value = useContext(Context);
  if (!value) throw new Error('Decision drafts must be read inside DecisionDraftProvider');
  return value;
}

/** Components remain usable in their existing standalone tests and embedders. */
export function useDecisionDraftStore(): DraftStore {
  const shared = useContext(Context);
  const [local, setLocal] = useState<Record<string, DecisionDraft>>({});
  const setLocalDraft = (key: string, draft: DecisionDraft) => setLocal(old => old[key]?.review === draft.review && old[key]?.reason === draft.reason && old[key]?.option === draft.option ? old : { ...old, [key]: draft });
  return shared ?? { drafts: local, setDraft: setLocalDraft };
}

export const decisionDraftKey = (runId: string, decisionId: string) => JSON.stringify([runId, decisionId]);

const draftsStorageKey = (projectId: string) => `bflow:immersive-office:decision-drafts:v1:${encodeURIComponent(projectId)}`;
const MAX_DRAFTS = 100;
const MAX_REASON = 16_000;
const MAX_OPTION = 2_000;

/** Session-only, project-scoped draft restoration. Each public decision snapshot is validated at this browser-storage ingress. */
export function readDecisionDrafts(projectId: string): Record<string, DecisionDraft> {
  try {
    if (!immersiveOfficeEnabled()) return {};
    const raw = sessionStorage.getItem(draftsStorageKey(projectId));
    if (!raw || raw.length > 1_000_000) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1 || (parsed as { projectId?: unknown }).projectId !== projectId) return {};
    const source = (parsed as { drafts?: unknown }).drafts;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
    const entries = Object.entries(source).slice(-MAX_DRAFTS);
    const drafts: Record<string, DecisionDraft> = {};
    for (const [key, value] of entries) {
      let ids: unknown;
      try { ids = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(ids) || ids.length !== 2 || typeof ids[0] !== 'string' || typeof ids[1] !== 'string' || !value || typeof value !== 'object') continue;
      const item = value as { review?: unknown; reason?: unknown; option?: unknown };
      if (typeof item.reason !== 'string' || item.reason.length > MAX_REASON || typeof item.option !== 'string' || item.option.length > MAX_OPTION) continue;
      const review = item.review === undefined ? undefined : WebDecisionSchema.safeParse(item.review);
      const validReview = review?.success && review.data.runId === ids[0] && review.data.decisionId === ids[1] ? review.data : undefined;
      drafts[key] = { review: validReview, reason: item.reason, option: item.option };
    }
    return drafts;
  } catch { return {}; }
}

export function writeDecisionDrafts(projectId: string, drafts: Record<string, DecisionDraft>): void {
  try {
    if (!immersiveOfficeEnabled()) return;
    const entries = Object.entries(drafts).filter(([, draft]) => draft.review || draft.reason || draft.option).slice(-MAX_DRAFTS);
    const serialized = JSON.stringify({ version: 1, projectId, drafts: Object.fromEntries(entries) });
    if (serialized.length <= 1_000_000) sessionStorage.setItem(draftsStorageKey(projectId), serialized);
  } catch { /* Storage can be unavailable or full; draft editing remains usable in memory. */ }
}
