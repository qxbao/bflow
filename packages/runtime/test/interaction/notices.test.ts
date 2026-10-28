import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { HostReceiptJournal } from '../../src/agentic/host-receipts.js';
import { acknowledgeDisplayedNotice } from '../../src/interaction/notices.js';
import type { RoleMessage } from '@bflow/contracts';
it('only explicit acknowledgement marks the exact notice; delivery and display never settle the decision',async()=>{
 const root=await mkdtemp('/tmp/w05-notice-'); const j=new HostReceiptJournal(join(root,'receipts'),root,'s');
 const message:RoleMessage={schema_version:2,message_id:'notice-1',correlation_id:'c',run_id:'r',sender:{role:'runtime'},recipient:{role:'conversation'},type:'approval.request',artifact_references:[],occurred_at:new Date().toISOString(),idempotency_key:'n',payload:{schemaVersion:2,approvalId:'apr-1',runId:'r',metadata:{kind:'user_decision',question:'Chọn?',requestedByRole:'developer',options:['A','B']}}};
 try{
 await j.appendConversationNotice(message);
 expect((await j.conversationNoticeStates())[0]).toMatchObject({displayed:false,surfaced:false});
 expect(await acknowledgeDisplayedNotice(j,'p','foreign','notice-1')).toMatchObject({ok:false});
 expect(await acknowledgeDisplayedNotice(j,'p','p','missing')).toMatchObject({ok:false});
 expect((await j.conversationNoticeStates())[0]?.displayed).toBe(false);
 const result=await acknowledgeDisplayedNotice(j,'p','p','notice-1');expect(result).toMatchObject({ok:true,value:{noticeId:'notice-1'}});
 expect((await j.conversationNoticeStates())[0]).toMatchObject({displayed:true,approvalId:'apr-1'});
 const again=await acknowledgeDisplayedNotice(new HostReceiptJournal(join(root,'receipts'),root,'s'),'p','p','notice-1');expect(again).toEqual(result);
 expect(await j.resurfaceConversationNotice('notice-1')).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
