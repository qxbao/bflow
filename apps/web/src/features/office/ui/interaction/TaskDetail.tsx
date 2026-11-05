import { ApiClient } from '../../../../api/client';
import { RunView } from '../../../runs';
import { useDecisionDraftStore } from './decision-drafts';

export function TaskDetail({ api, id, runId, revision, refresh, immersive = true }: { api: ApiClient; id: string; runId: string; revision: number; refresh: () => void; immersive?: boolean }) {
  const { drafts, setDraft } = useDecisionDraftStore();
  const view = <RunView api={api} id={id} runId={runId} revision={revision} refresh={refresh} decisionDrafts={drafts} onDecisionDraftChange={setDraft} decisionModal={immersive} />;
  if (!immersive) return view;
  return <div className="mx-auto w-full max-w-4xl px-1 sm:px-4" data-component="TaskDetail">{view}</div>;
}
