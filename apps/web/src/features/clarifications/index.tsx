import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { WebClarification } from '@bflow/contracts/web';
import { ApiClient, ApiError, explain } from '../../api/client';
import { FieldLabel } from '../../components/FieldHelp';
import { useCommands } from '../operations';
const unsettled=(cmd:{tracked?:unknown;operation?:{state:string}|undefined})=>Boolean(cmd.tracked && (!cmd.operation || !['applied','failed'].includes(cmd.operation.state)));
const isSettled=(cmd:{operation?:{state:string}|undefined})=>Boolean(cmd.operation && ['applied','failed'].includes(cmd.operation.state));
const samePrompt=(a:WebClarification,b:WebClarification)=>a.questionId===b.questionId && a.question===b.question && JSON.stringify(a.options)===JSON.stringify(b.options);
export function ClarificationForm({api,id,question,runId,intakeId,enabled,refresh}:{api:ApiClient;id:string;question:WebClarification;runId?:string|undefined;intakeId?:string|undefined;enabled:boolean;refresh?:(()=>void)|undefined}) {
  const uid=useId(),[answer,setAnswer]=useState(''),[error,setError]=useState(''),commands=useCommands(`question:${runId??intakeId}:${question.questionId}`);
  const questionIdRef=useRef(question.questionId);
  useEffect(()=>{if(questionIdRef.current!==question.questionId){questionIdRef.current=question.questionId;setAnswer('');setError('');}},[question.questionId]);
  async function submit(e:FormEvent){e.preventDefault();if(!answer.trim()){setError('Nhập câu trả lời hoặc chọn một gợi ý.');return;}
    try{
      if(!enabled || !commands.online || unsettled(commands))return;
      let expectedVersion=question.expectedVersion;
      if(runId){
        const run=await api.run(id,runId);
        const live=run.currentRunId===runId && !['completed','failed','cancelled'].includes(run.sdlcStatus)?run.clarifications.find(q=>samePrompt(q,question)):undefined;
        if(!live){refresh?.();throw new Error('Câu hỏi đã thay đổi. Đọc lại công việc.');}
        expectedVersion=live.expectedVersion;
      }else{
        const session=await api.sessionView(id);
        const intake=session.state==='ready'?session.pendingIntakes.find(i=>i.intakeId===intakeId && i.status==='clarifying'):undefined;
        const live=intake?.clarifications.find(q=>samePrompt(q,question));
        if(!live){refresh?.();throw new Error('Câu hỏi đã thay đổi. Đọc lại tổng quan.');}
        expectedVersion=live.expectedVersion;
      }
      if(isSettled(commands))await commands.startNew();
      await commands.submit({kind:'answer_clarification',...(runId?{runId}:{intakeId:intakeId!}),questionId:question.questionId,expectedVersion,answer:answer.trim()});setError('');
    }catch(e){
      if(e instanceof ApiError && e.code==='stale_version')refresh?.();
      setError(e instanceof Error && !('code' in e)?e.message:explain(e));
    }
  }
  return <article className="panel min-w-0 border border-line bg-surface p-4 sm:p-5"><h3 className="m-0 [overflow-wrap:anywhere]">{question.question}</h3><form onSubmit={e=>void submit(e)}><FieldLabel htmlFor={uid} label="Câu trả lời" help="Trả lời trực tiếp câu hỏi làm rõ của Trợ lý tiếp nhận (hoặc bấm chọn nhanh một gợi ý bên dưới rồi chỉnh sửa thêm trước khi gửi)."/><textarea id={uid} maxLength={16000} rows={3} value={answer} onChange={e=>setAnswer(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={error?uid+'error':undefined}/>{question.options.length>0 && <div className="my-4 flex flex-wrap items-center gap-2">{question.options.map(option=><button type="button" key={option} onClick={()=>setAnswer(option)}>{option}</button>)}</div>}{error && <p id={uid+'error'} role="alert">{error}</p>}{commands.tracked && <p role="status" className="my-2 text-xs text-muted">{unsettled(commands)?'Đang xử lý hoặc chờ đối chiếu câu trả lời…':commands.tracked.operation?.state==='applied'?'Đã áp dụng câu trả lời.':commands.tracked.operation?.state==='failed'?'Câu trả lời không được áp dụng.':'Đang theo dõi thao tác trả lời.'}</p>}<button disabled={!enabled || commands.busy || !commands.online || unsettled(commands)}>{commands.busy?'Đang gửi…':'Gửi câu trả lời'}</button></form></article>;
}
