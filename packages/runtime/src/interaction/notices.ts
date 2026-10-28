import { IdentifierSchema, WebNoticeDisplayedResultSchema, type OperationResult, type WebNoticeDisplayed } from '@bflow/contracts';
import type { HostReceiptJournal } from '../agentic/host-receipts.js';
/** Called only from the dedicated authenticated UI ingress, never from feed delivery. */
export async function acknowledgeDisplayedNotice(receipts: HostReceiptJournal, projectId: string, requestedProject: string, noticeId: string): Promise<OperationResult<WebNoticeDisplayed>> {
  try {
    IdentifierSchema.parse(noticeId);
    if(projectId!==requestedProject)throw Error('scope');
    const notice = await receipts.readConversationNoticeDisplay(noticeId);
    if(!notice) return {ok:false,error:{code:'not_found',retryable:false,message:'Notice not found.'}};
    if(!notice.displayedAt) {
      await receipts.markConversationNoticesSurfaced([noticeId]);
      await receipts.markConversationNoticesDisplayed([noticeId]);
    }
    const recorded = await receipts.readConversationNoticeDisplay(noticeId);
    if(!recorded?.displayedAt)throw Error('Not user facing');
    return WebNoticeDisplayedResultSchema.parse({ok:true,value:{apiVersion:1,noticeId,displayedAt:recorded.displayedAt}});
  } catch { return {ok:false,error:{code:'validation',retryable:false,message:'Notice acknowledgement refused.'}}; }
}
