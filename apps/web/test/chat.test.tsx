import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ApiClient } from '../src/api/client';
import { ChatHistory } from '../src/features/chat';
import { now } from './fixtures';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const message={apiVersion:1,messageId:'23a23332-3060-4fc5-b594-323368ea1f9a',sessionId:'host',runId:'run',sender:'conversation',content:'<img src=x onerror=alert(1)>',createdAt:now,delivery:'delivered',source:'native'};
function open(sessionId='host',revision=0){return <MemoryRouter><ChatHistory api={new ApiClient()} projectId="p" sessionId={sessionId} runId="run" revision={revision}/></MemoryRouter>;}
function response(value:unknown){const fetcher=vi.fn(async(_path:string,_init:RequestInit)=>new Response(JSON.stringify(value)));vi.stubGlobal('fetch',fetcher);return fetcher;}
it('renders normalized text as text and leaves send unavailable even after history succeeds',async()=>{
 const fetcher=response({apiVersion:1,items:[message]});render(open());
 expect(await screen.findByText(message.content)).toBeTruthy();expect(document.querySelector('img')).toBeNull();
 expect(screen.getByRole<HTMLButtonElement>('button',{name:'Gửi tin nhắn'}).disabled).toBe(true);
 expect(screen.getByText(/Trò chuyện qua web chưa sẵn sàng/)).toBeTruthy();
 expect(fetcher.mock.calls.some(([path])=>path==='/api/v1/projects/p/sessions/host/messages')).toBe(true);
 expect(fetcher.mock.calls.every(([,init])=>init.method==='GET')).toBe(true);
});
it('refuses a foreign session and never exposes its content',async()=>{
 response({apiVersion:1,items:[{...message,sessionId:'other',content:'foreign-secret'}]});render(open());
 expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('foreign-secret')).toBeNull();
});
it('never interprets unavailable history as an empty transcript or enables send',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({apiVersion:1,code:'invalid_request',message:'private backend text',retryable:false,correlationId:'test'}),{status:400})));
 render(open());expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('Chưa có tin nhắn trong công việc này.')).toBeNull();expect(screen.queryByText('private backend text')).toBeNull();
 expect(screen.getByRole<HTMLButtonElement>('button',{name:'Gửi tin nhắn'}).disabled).toBe(true);
});
it('keeps unknown delivery distinct and offers observation only',async()=>{
 const fetcher=response({apiVersion:1,items:[{...message,sender:'user',source:'web',delivery:'unknown_delivery'}]});render(open());
 expect(await screen.findByText('Chưa rõ đã gửi')).toBeTruthy();expect(screen.getByText(/Không gửi lại khi chưa đối chiếu/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Đọc lại lịch sử'}));
 expect(fetcher.mock.calls.every(([,init])=>init.method==='GET')).toBe(true);expect(screen.queryByRole('button',{name:'Gửi lại'})).toBeNull();
});
it('discards old session results when a new native session replaces it',async()=>{
 let finish!:(value:Response)=>void;
 vi.stubGlobal('fetch',vi.fn((path:string)=>path.includes('/host/')?new Promise<Response>(resolve=>{finish=resolve;}):Promise.resolve(new Response(JSON.stringify({apiVersion:1,items:[]})))));
 const view=render(open());view.rerender(open('replacement'));
 await screen.findByText('Chưa có tin nhắn trong công việc này.');await act(async()=>{finish(new Response(JSON.stringify({apiVersion:1,items:[message]})));});
 expect(screen.queryByText(message.content)).toBeNull();
});
it('loads exact encoded history cursors without resending a message',async()=>{
 const fetcher=response({apiVersion:1,items:[message],nextCursor:'page:2'});render(open());await screen.findByText(message.content);
 await vi.waitFor(()=>expect(fetcher.mock.calls.some(([path])=>path.endsWith('?cursor=page%3A2'))).toBe(true));
 expect(fetcher.mock.calls.every(([,init])=>init.method==='GET')).toBe(true);
});
const readySession={apiVersion:1,projectId:'p',sessionId:'host',state:'ready',pendingIntakes:[],blockers:[],updatedAt:now};
function chatApi(history:()=>unknown[],session:unknown=readySession){vi.stubGlobal('fetch',vi.fn(async(path:string)=>new Response(JSON.stringify(path.endsWith('/session')?session:{apiVersion:1,items:history()}))));}
const own={...message,sender:'user',source:'web',content:'Câu hỏi của tôi'};
const justNow=()=>new Date().toISOString();
it('shows only this run and unassigned messages, without a whole-session view',async()=>{
 chatApi(()=>[{...message,content:'Trả lời chung',runId:undefined},{...message,messageId:'528227ee-8198-4177-a135-1e0d4ebd4a22',runId:'other',content:'Tin công việc khác'}]);render(open());
 expect(await screen.findByText('Trả lời chung')).toBeTruthy();expect(screen.queryByText('Tin công việc khác')).toBeNull();
 expect(screen.queryByRole('button',{name:'Toàn phiên'})).toBeNull();
});
it('shows composing only after delivery, while ready, recently and until a reply arrives',async()=>{
 const items:unknown[]=[{...own,createdAt:justNow()}];chatApi(()=>items);
 const view=render(open());
 expect(await screen.findByText('Đang soạn tin')).toBeTruthy();
 items.push({...message,messageId:'528227ee-8198-4177-a135-1e0d4ebd4a22',content:'Đã trả lời',createdAt:justNow()});
 fireEvent.click(screen.getByRole('button',{name:'Đọc lại lịch sử'}));
 await screen.findByText('Đã trả lời');expect(screen.queryByText('Đang soạn tin')).toBeNull();view.unmount();
});
it.each([
 ['the message is not delivered yet',{...own,delivery:'queued',createdAt:new Date().toISOString()},readySession],
 ['delivery is unknown',{...own,delivery:'unknown_delivery',createdAt:new Date().toISOString()},readySession],
 ['the message is old',{...own,createdAt:'2020-01-01T00:00:00Z'},readySession],
 ['the session is not ready',{...own,createdAt:new Date().toISOString()},{...readySession,state:'stopped'}],
])('never claims composing when %s',async(_name,item,session)=>{
 chatApi(()=>[item],session);render(open());
 await screen.findByText('Câu hỏi của tôi');await screen.findByRole('button',{name:'Đọc lại lịch sử'});
 await act(async()=>{await new Promise(accept=>setTimeout(accept,20));});
 expect(screen.queryByText('Đang soạn tin')).toBeNull();
});
it('polls history while the last message is unsettled and reports its delivery on the bubble',async()=>{
 vi.useFakeTimers({shouldAdvanceTime:true});
 try{
  const items=[{...own,delivery:'queued',createdAt:justNow()}];chatApi(()=>items);render(open());
  expect(await screen.findByText('Đang chờ gửi')).toBeTruthy();expect(screen.getByText(/đang chờ tới lượt chuyển/)).toBeTruthy();
  items[0]={...items[0]!,delivery:'delivered'};
  await act(async()=>{await vi.advanceTimersByTimeAsync(5100);});
  expect(await screen.findByText('Đã chuyển')).toBeTruthy();expect(await screen.findByText('Đang soạn tin')).toBeTruthy();
 }finally{vi.useRealTimers();}
});
it('sends on Enter, keeps Shift+Enter and IME composition, and shows the sending bubble',async()=>{
 localStorage.clear();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_key:string,work:()=>Promise<unknown>)=>work()}});
 let finish!:(value:Response)=>void;const posts:string[]=[];const history:unknown[]=[];
 vi.stubGlobal('fetch',vi.fn((path:string,init:RequestInit)=>{
  if(path.endsWith('/session'))return Promise.resolve(new Response(JSON.stringify(readySession)));
  if(init.method==='POST'){posts.push(String(init.body));return new Promise<Response>(resolve=>{finish=resolve;});}
  return Promise.resolve(new Response(JSON.stringify({apiVersion:1,items:history})));
 }));
 render(open());const input=await screen.findByLabelText<HTMLTextAreaElement>('Tin nhắn cho Conversation');await vi.waitFor(()=>expect(input.disabled).toBe(false));
 fireEvent.change(input,{target:{value:'Xin chào'}});
 fireEvent.keyDown(input,{key:'Enter',shiftKey:true});fireEvent.keyDown(input,{key:'Enter',isComposing:true});expect(posts).toHaveLength(0);
 fireEvent.keyDown(input,{key:'Enter'});
 await screen.findByText('Đang gửi');expect(screen.getByText('Xin chào')).toBeTruthy();expect(posts).toHaveLength(1);expect(input.disabled).toBe(false);
 const body=JSON.parse(posts[0]!);
 await act(async()=>{finish(new Response(JSON.stringify({...own,messageId:body.messageId,content:'Xin chào',delivery:'queued'}),{status:202}));});
 await screen.findByText('Đang chờ gửi');expect(input.value).toBe('');expect(screen.getAllByText('Xin chào')).toHaveLength(1);
});

it('keeps intentionally identical text as distinct stable messages',async()=>{
 response({apiVersion:1,items:[{...message,content:'Giống nhau'},{...message,messageId:'528227ee-8198-4177-a135-1e0d4ebd4a22',sender:'user',source:'web',content:'Giống nhau',delivery:'queued'}]});render(open());
 expect(await screen.findAllByText('Giống nhau')).toHaveLength(2);expect(screen.getByText('Đang chờ gửi')).toBeTruthy();
});
it('refuses duplicate message IDs instead of hiding a conflicting replay',async()=>{
 response({apiVersion:1,items:[message,{...message,content:'conflicting replay'}]});render(open());
 expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('conflicting replay')).toBeNull();
});
it('sends a validated message with exact run/session and never auto retries a lost ACK',async()=>{
 localStorage.clear();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_key:string,work:()=>Promise<unknown>)=>work()}});
 let sent=0,original:string|undefined;const metadata:unknown[]=[];
 vi.stubGlobal('fetch',vi.fn(async(path:string,init:RequestInit)=>{
  if(path.endsWith('/session'))return new Response(JSON.stringify({apiVersion:1,projectId:'p',sessionId:'host',state:'ready',pendingIntakes:[],blockers:[],updatedAt:now}));
  if(init.method==='POST'){const input=JSON.parse(String(init.body));metadata.push(input);sent++;original=input.messageId;throw Error('Lost ACK');}
  return new Response(JSON.stringify({apiVersion:1,items:original?[{...message,messageId:original,sender:'user',source:'web',content:'Nội dung mới',delivery:'queued'}]:[]}));
 }));
 render(open());const input=await screen.findByLabelText<HTMLTextAreaElement>('Tin nhắn cho Conversation');await vi.waitFor(()=>expect(input.disabled).toBe(false));
 fireEvent.change(input,{target:{value:'Nội dung mới'}});fireEvent.click(screen.getByRole('button',{name:'Gửi tin nhắn'}));
 await screen.findByText(/Chưa xác định được kết quả gửi/);expect(sent).toBe(1);expect(metadata[0]).toMatchObject({projectId:'p',sessionId:'host',runId:'run',content:'Nội dung mới'});
 expect(JSON.stringify(localStorage)).not.toContain('Nội dung mới');
 fireEvent.click(screen.getByRole('button',{name:'Đối chiếu tin nhắn'}));await screen.findByText(/Đã tìm thấy tin nhắn gốc/);expect(sent).toBe(1);
});
it('allows a new message after verified session readiness while first-message history is unavailable',async()=>{
 localStorage.clear();
 const fetcher=vi.fn(async(path:string,_init?:RequestInit)=>path.endsWith('/session')
  ?new Response(JSON.stringify({apiVersion:1,projectId:'p',sessionId:'host',state:'ready',pendingIntakes:[],blockers:[],updatedAt:now}))
  :new Response(JSON.stringify({apiVersion:1,code:'unavailable',message:'History not created yet',retryable:true,correlationId:'cold'}),{status:503}));
 vi.stubGlobal('fetch',fetcher);render(open());
 await screen.findByRole('alert');
 await vi.waitFor(()=>expect(screen.getByLabelText<HTMLTextAreaElement>('Tin nhắn cho Conversation').disabled).toBe(false));
 expect(screen.queryByText('Chưa có tin nhắn trong công việc này.')).toBeNull();
 expect(fetcher.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
});
