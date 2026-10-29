import { useId, useState, type FormEvent } from 'react';
import type { WebClarification } from '@bflow/contracts/web';
import { ApiClient, explain } from '../../api/client';
import { useCommands } from '../operations';
export function ClarificationForm({api,id,question,runId,intakeId,enabled}:{api:ApiClient;id:string;question:WebClarification;runId?:string;intakeId?:string;enabled:boolean}) {
  const uid=useId(),[answer,setAnswer]=useState(''),[error,setError]=useState(''),commands=useCommands(`question:${runId??intakeId}:${question.questionId}`);
  async function submit(e:FormEvent){e.preventDefault();if(!answer.trim()){setError('Nhập câu trả lời hoặc chọn một gợi ý.');return;}
    try{
      if(!enabled || !commands.online)return;
      if(runId){const run=await api.run(id,runId);if(run.currentRunId!==runId || ['completed','failed','cancelled'].includes(run.sdlcStatus) || !run.clarifications.some(q=>q.questionId===question.questionId && q.expectedVersion.revisionToken===question.expectedVersion.revisionToken))throw new Error('Câu hỏi đã thay đổi. Đọc lại công việc.');}
      else{const session=await api.sessionView(id);if(session.state!=='ready' || !session.pendingIntakes.some(i=>i.intakeId===intakeId && i.status==='clarifying' && i.clarifications.some(q=>q.questionId===question.questionId && q.expectedVersion.revisionToken===question.expectedVersion.revisionToken)))throw new Error('Câu hỏi đã thay đổi. Đọc lại tổng quan.');}
      await commands.submit({kind:'answer_clarification',...(runId?{runId}:{intakeId:intakeId!}),questionId:question.questionId,expectedVersion:question.expectedVersion,answer:answer.trim()});setError('');
    }catch(e){setError(e instanceof Error && !('code' in e)?e.message:explain(e));}
  }
  return <article className="panel min-w-0 border border-line bg-surface p-4 sm:p-5"><h3>{question.question}</h3><form onSubmit={e=>void submit(e)}><label htmlFor={uid}>Câu trả lời</label><textarea id={uid} maxLength={16000} rows={3} value={answer} onChange={e=>setAnswer(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={error?uid+'error':undefined}/>{question.options.length>0 && <div className="my-4 flex flex-wrap items-center gap-2">{question.options.map(option=><button type="button" key={option} onClick={()=>setAnswer(option)}>{option}</button>)}</div>}{error && <p id={uid+'error'} role="alert">{error}</p>}<button disabled={!enabled || commands.busy || !commands.online}>Gửi câu trả lời</button></form></article>;
}
