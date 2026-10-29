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
 expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/projects/p/sessions/host/messages');
 expect(fetcher.mock.calls.every(([,init])=>init.method==='GET')).toBe(true);
});
it('refuses a foreign session and never exposes its content',async()=>{
 response({apiVersion:1,items:[{...message,sessionId:'other',content:'foreign-secret'}]});render(open());
 expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('foreign-secret')).toBeNull();
});
it('never interprets unavailable history as an empty transcript or enables send',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({apiVersion:1,code:'invalid_request',message:'private backend text',retryable:false,correlationId:'test'}),{status:400})));
 render(open());expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('Chưa có tin nhắn trong trang lịch sử này.')).toBeNull();expect(screen.queryByText('private backend text')).toBeNull();
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
 await screen.findByText('Chưa có tin nhắn trong trang lịch sử này.');await act(async()=>{finish(new Response(JSON.stringify({apiVersion:1,items:[message]})));});
 expect(screen.queryByText(message.content)).toBeNull();
});
it('loads exact encoded history cursors without resending a message',async()=>{
 const fetcher=response({apiVersion:1,items:[message],nextCursor:'page:2'});render(open());await screen.findByText(message.content);
 fireEvent.click(screen.getByRole('button',{name:'Trang tin nhắn tiếp theo'}));
 await vi.waitFor(()=>expect(fetcher.mock.calls.some(([path])=>path.endsWith('?cursor=page%3A2'))).toBe(true));
});

it('keeps intentionally identical text as distinct stable messages',async()=>{
 response({apiVersion:1,items:[{...message,content:'Giống nhau'},{...message,messageId:'528227ee-8198-4177-a135-1e0d4ebd4a22',content:'Giống nhau',delivery:'queued'}]});render(open());
 expect(await screen.findAllByText('Giống nhau')).toHaveLength(2);expect(screen.getByText('Đang chờ gửi')).toBeTruthy();
});
it('refuses duplicate message IDs instead of hiding a conflicting replay',async()=>{
 response({apiVersion:1,items:[message,{...message,content:'conflicting replay'}]});render(open());
 expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('conflicting replay')).toBeNull();
});
