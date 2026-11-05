import { createContext, useContext, useState, type ReactNode } from 'react';
import type { DecisionDraft } from '../../../decisions';

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
