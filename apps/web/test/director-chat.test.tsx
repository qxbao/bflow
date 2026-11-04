import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ApiClient } from '../src/api/client';
import { DirectorProvider, useDirector } from '../src/features/director/status';
import { DirectorChat } from '../src/features/director/chat';
import { directorServer, locks, message, readySession, sessionRead, view, at } from './director-fixtures';

beforeEach(()=>{localStorage.clear();vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'locks',{configurable:true,value:locks});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
function open({revision=0,resetEpoch=0,session=sessionRead(),api=new ApiClient()}:{revision?:number;resetEpoch?:number;session?:ReturnType<typeof sessionRead>|{key:string;loading:boolean;error?:unknown;data?:never};api?:ApiClient}={}){
  return <MemoryRouter><DirectorProvider api={api} projectId="p" session={session} revision={revision} resetEpoch={resetEpoch}><DirectorChat/></DirectorProvider></MemoryRouter>;
}
const input=()=>screen.getByLabelText<HTMLTextAreaElement>('Tin nhắn cho Director');
const sendButton=()=>screen.getByRole<HTMLButtonElement>('button',{name:'Gửi tin nhắn'});

it('selects Director chat on a confirmed Director view and ignores the legacy-only chat_adapter_unavailable blocker',async()=>{
  directorServer({messages:[message(1,{text:'<img src=x onerror=alert(1)>'}),message(2,{text:'Chào bạn, tôi là Director.'})]});
  render(open());
  expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText('Chào bạn, tôi là Director.')).toBeTruthy();
  await waitFor(()=>expect(input().disabled).toBe(false));
  expect(screen.queryByText(/Trò chuyện qua web chưa (sẵn sàng|khả dụng)/)).toBeNull();
});
it('queues a message while Director is absent and the host is alive, with exact project/session scope',async()=>{
  const {state}=directorServer();render(open());
  expect(await screen.findByText(/Director chưa có mặt/)).toBeTruthy();
  await waitFor(()=>expect(input().disabled).toBe(false));
  fireEvent.change(input(),{target:{value:'Làm tính năng tìm kiếm'}});fireEvent.click(sendButton());
  await waitFor(()=>expect(state.posts).toHaveLength(1));
  expect(state.posts[0]).toMatchObject({path:'/api/v1/projects/p/director/messages',body:{apiVersion:1,projectId:'p',sessionId:'host',content:'Làm tính năng tìm kiếm'}});
  expect(state.posts[0]!.body.runId).toBeUndefined();
  expect(await screen.findByText('Làm tính năng tìm kiếm')).toBeTruthy();
  expect(screen.getByText(/Director sẽ đọc khi mở phiên/)).toBeTruthy();
  expect(input().value).toBe('');
  expect(JSON.stringify(localStorage)).not.toContain('tìm kiếm');
});
it('a failed view read is unknown presence, never absent, and disables sending',async()=>{
  directorServer({view:()=>Response.json({apiVersion:1,code:'unavailable',message:'down',retryable:true,correlationId:'t'},{status:503})});
  render(open());
  expect(await screen.findByText(/Chưa đọc được trạng thái Director/)).toBeTruthy();
  expect(screen.queryByText(/Director chưa có mặt/)).toBeNull();
  expect(sendButton().disabled).toBe(true);
});
it('a later read failure keeps the transcript but turns presence into unknown',async()=>{
  let fail=false;directorServer({messages:[message(1)],view:()=>fail?Response.json({apiVersion:1,code:'unavailable',message:'down',retryable:true,correlationId:'t'},{status:503}):view({presence:'active',transcriptSeq:1})});
  const rendered=render(open());
  expect(await screen.findByText('Director đang hoạt động')).toBeTruthy();
  fail=true;rendered.rerender(open({revision:1}));
  expect(await screen.findByText(/Chưa đọc được trạng thái Director/)).toBeTruthy();
  expect(screen.queryByText('Director đang hoạt động')).toBeNull();expect(screen.getByText('Tin 1')).toBeTruthy();
});
it('Director absent then reappearing updates the presence text without a fake typing indicator',async()=>{
  let presence:'absent'|'waiting'='absent';directorServer({view:()=>view({presence,...(presence==='waiting'?{waitingSince:at}:{})})});
  const rendered=render(open());expect(await screen.findByText(/Director chưa có mặt/)).toBeTruthy();
  presence='waiting';rendered.rerender(open({revision:1}));
  expect(await screen.findByText('Director đang chờ tin của bạn')).toBeTruthy();
  expect(screen.queryByText(/Đang soạn/)).toBeNull();expect(document.querySelector('[class*="animate-"]')).toBeNull();
});
it('pages older messages with b<first-seq> and polls newer with a<last-seq>, merging without duplicates',async()=>{
  const all=Array.from({length:150},(_,i)=>message(i+1));const {state}=directorServer({messages:all});
  const rendered=render(open());
  expect(await screen.findByText('Tin 150')).toBeTruthy();expect(screen.queryByText('Tin 50')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Xem tin cũ hơn'}));
  expect(await screen.findByText('Tin 50')).toBeTruthy();
  expect(state.gets).toContain('/api/v1/projects/p/director/messages?cursor=b51');
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Xem tin cũ hơn'})).toBeNull());
  state.messages.push(message(151,{text:'Tin mới nhất'}));rendered.rerender(open({revision:1}));
  expect(await screen.findByText('Tin mới nhất')).toBeTruthy();
  expect(state.gets).toContain('/api/v1/projects/p/director/messages?cursor=a150');
  expect(screen.getAllByText('Tin 150')).toHaveLength(1);
});
it('a send result ahead of the held transcript fills the gap from the highest contiguous seq without a reset',async()=>{
  const {state}=directorServer({messages:Array.from({length:10},(_,i)=>message(i+1))});
  render(open());expect(await screen.findByText('Tin 10')).toBeTruthy();
  await waitFor(()=>expect(input().disabled).toBe(false));
  const latestReads=()=>state.gets.filter(path=>path==='/api/v1/projects/p/director/messages').length,before=latestReads();
  state.messages.push(message(11,{author:'director',channel:'cli',text:'Director trả lời trước'}));
  fireEvent.change(input(),{target:{value:'Tin người dùng 12'}});fireEvent.click(sendButton());
  await waitFor(()=>expect(state.posts).toHaveLength(1));
  expect(await screen.findByText('Tin người dùng 12')).toBeTruthy();
  expect(await screen.findByText('Director trả lời trước')).toBeTruthy();
  expect(state.gets).toContain('/api/v1/projects/p/director/messages?cursor=a10');
  expect(latestReads()).toBe(before);
  expect(screen.getAllByText('Tin 10')).toHaveLength(1);
});
it('an empty transcript followed by a Director reply and our send still fetches the reply (cursor from server pages only)',async()=>{
  const {state}=directorServer();
  render(open());await waitFor(()=>expect(input().disabled).toBe(false));
  await waitFor(()=>expect(state.gets).toContain('/api/v1/projects/p/director/messages'));
  const latestReads=()=>state.gets.filter(path=>path==='/api/v1/projects/p/director/messages').length,before=latestReads();
  state.messages.push(message(1,{author:'director',channel:'cli',text:'Director chào trước'}));
  fireEvent.change(input(),{target:{value:'Tin người dùng 2'}});fireEvent.click(sendButton());
  await waitFor(()=>expect(state.posts).toHaveLength(1));
  expect(await screen.findByText('Tin người dùng 2')).toBeTruthy();
  expect(await screen.findByText('Director chào trước')).toBeTruthy();
  expect(state.gets).toContain('/api/v1/projects/p/director/messages?cursor=a0');
  expect(latestReads()).toBe(before);
  expect(screen.getAllByText('Tin người dùng 2')).toHaveLength(1);
});
it('reloads the latest page when the transcript cursor goes backwards (store reset or restart)',async()=>{
  const {state}=directorServer({messages:[message(1),message(2),message(3,{text:'Cũ sẽ mất'})]});
  const rendered=render(open());expect(await screen.findByText('Cũ sẽ mất')).toBeTruthy();
  state.messages.splice(0,3,message(1,{messageId:'fresh',text:'Bản ghi mới sau khi đặt lại'}));
  rendered.rerender(open({revision:1}));
  expect(await screen.findByText('Bản ghi mới sau khi đặt lại')).toBeTruthy();expect(screen.queryByText('Cũ sẽ mất')).toBeNull();
});
it('an SSE reset reloads the latest transcript page',async()=>{
  const {state}=directorServer({messages:[message(1)]});
  const rendered=render(open());expect(await screen.findByText('Tin 1')).toBeTruthy();
  const before=state.gets.filter(path=>path==='/api/v1/projects/p/director/messages').length;
  rendered.rerender(open({resetEpoch:1}));
  await waitFor(()=>expect(state.gets.filter(path=>path==='/api/v1/projects/p/director/messages').length).toBeGreaterThan(before));
});
it('a lost ACK never auto-resends; focus moves to recovery; resend appears only after a complete scan and reuses the ID',async()=>{
  let lose=true;const {state}=directorServer({extra:(path,init)=>{if(init.method==='POST'&&lose){lose=false;state.posts.push({path,body:JSON.parse(String(init.body))});throw new TypeError('lost');}return undefined;}});
  render(open());await waitFor(()=>expect(input().disabled).toBe(false));
  fireEvent.change(input(),{target:{value:'Câu hỏi'}});fireEvent.click(sendButton());
  expect(await screen.findByText(/Chưa xác định được kết quả gửi/)).toBeTruthy();
  expect(state.posts).toHaveLength(1);expect(input().disabled).toBe(true);
  await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole('button',{name:'Đối chiếu tin nhắn'})));
  expect(screen.queryByRole('button',{name:'Gửi lại với cùng mã tin'})).toBeNull();
  const original=state.posts[0]!.body.messageId;
  fireEvent.click(screen.getByRole('button',{name:'Đối chiếu tin nhắn'}));
  fireEvent.click(await screen.findByRole('button',{name:'Gửi lại với cùng mã tin'}));
  await waitFor(()=>expect(state.posts).toHaveLength(2));expect(state.posts[1]!.body.messageId).toBe(original);
  expect(await screen.findByText('Câu hỏi')).toBeTruthy();
  await waitFor(()=>expect(input().disabled).toBe(false));
});
it('a definitive refusal of the resend keeps the pending ID and the composer locked to recovery',async()=>{
  let posts=0;const {state}=directorServer({extra:(path,init)=>{if(init.method!=='POST')return undefined;posts++;state.posts.push({path,body:JSON.parse(String(init.body))});
    if(posts===1)throw new TypeError('lost');return Response.json({apiVersion:1,code:'session_required',message:'x',retryable:false,correlationId:'t'},{status:401});}});
  render(open());await waitFor(()=>expect(input().disabled).toBe(false));
  fireEvent.change(input(),{target:{value:'Câu hỏi'}});fireEvent.click(sendButton());
  await screen.findByText(/Chưa xác định được kết quả gửi/);
  fireEvent.click(screen.getByRole('button',{name:'Đối chiếu tin nhắn'}));
  fireEvent.click(await screen.findByRole('button',{name:'Gửi lại với cùng mã tin'}));
  expect(await screen.findByText(/Gửi lại bị từ chối/)).toBeTruthy();expect(posts).toBe(2);
  const key=JSON.stringify(['bflow-director-chat','p']);
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({version:2,messageId:state.posts[0]!.body.messageId,sessionId:'host'});
  expect(input().disabled).toBe(true);expect(sendButton().disabled).toBe(true);
  expect(screen.getByRole('button',{name:'Đối chiếu tin nhắn'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Gửi lại với cùng mã tin'})).toBeNull();
});
it('a definitive refusal of the first attempt releases the ID',async()=>{
  directorServer({extra:(_path,init)=>init.method==='POST'?Response.json({apiVersion:1,code:'forbidden',message:'x',retryable:false,correlationId:'t'},{status:403}):undefined});
  render(open());await waitFor(()=>expect(input().disabled).toBe(false));
  fireEvent.change(input(),{target:{value:'Câu hỏi'}});fireEvent.click(sendButton());
  await waitFor(()=>expect(localStorage.getItem(JSON.stringify(['bflow-director-chat','p']))).toBeNull());
  await waitFor(()=>expect(input().disabled).toBe(false));expect(input().value).toBe('Câu hỏi');
});
it('after a reload only reconcile is offered for the stored ID (no text in memory)',async()=>{
  localStorage.setItem(JSON.stringify(['bflow-director-chat','p']),JSON.stringify({version:2,messageId:'00000000-0000-4000-8000-000000000009',sessionId:'host'}));
  const {state}=directorServer({messages:[message(1)]});render(open());
  expect(await screen.findByText(/Đang có tin nhắn trước chờ đối chiếu/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Gửi lại với cùng mã tin'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Đối chiếu tin nhắn'}));
  expect(await screen.findByText(/mở khóa khung soạn tin để gửi lại thủ công/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Gửi lại với cùng mã tin'})).toBeNull();expect(state.posts).toHaveLength(0);
});
it('a pending ID from another host session is unknown: no resend or reconcile, explicit dismiss keeps the draft',async()=>{
  const key=JSON.stringify(['bflow-director-chat','p']);
  localStorage.setItem(key,JSON.stringify({version:2,messageId:'00000000-0000-4000-8000-000000000009',sessionId:'old-host'}));
  const {state}=directorServer({messages:[message(1)]});render(open());
  expect(await screen.findByText('Không xác định, phiên đã đổi.')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Đối chiếu tin nhắn'})).toBeNull();expect(screen.queryByRole('button',{name:'Gửi lại với cùng mã tin'})).toBeNull();
  expect(input().disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Bỏ qua tin chưa xác định'}));
  await waitFor(()=>expect(input().disabled).toBe(false));expect(localStorage.getItem(key)).toBeNull();expect(state.posts).toHaveLength(0);
});
it('reconcile observes the transcript for the original ID without posting',async()=>{
  const {state}=directorServer({extra:(path,init)=>{if(init.method==='POST'){const body=JSON.parse(String(init.body));state.posts.push({path,body});state.messages.push(message(1,{messageId:body.messageId,author:'user',channel:'web',text:body.content}));throw new TypeError('lost');}return undefined;}});
  render(open());await waitFor(()=>expect(input().disabled).toBe(false));
  fireEvent.change(input(),{target:{value:'Đã tới host'}});fireEvent.click(sendButton());
  await screen.findByText(/Chưa xác định được kết quả gửi/);
  fireEvent.click(screen.getByRole('button',{name:'Đối chiếu tin nhắn'}));
  expect(await screen.findByText(/Đã tìm thấy tin nhắn gốc/)).toBeTruthy();expect(state.posts).toHaveLength(1);
});
it('chat text is never an approval: "duyệt" goes only to the Director transcript',async()=>{
  const {state,fetcher}=directorServer();render(open());await waitFor(()=>expect(input().disabled).toBe(false));
  fireEvent.change(input(),{target:{value:'duyệt'}});fireEvent.click(sendButton());
  await waitFor(()=>expect(state.posts).toHaveLength(1));
  expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST').map(([path])=>path)).toEqual(['/api/v1/projects/p/director/messages']);
  expect(screen.getByText(/không phải là phê duyệt/)).toBeTruthy();
});
it('Enter sends, Shift+Enter and IME composition do not; the label keeps focus on the input',async()=>{
  const {state}=directorServer();render(open());await waitFor(()=>expect(input().disabled).toBe(false));
  input().focus();fireEvent.change(input(),{target:{value:'Xin chào'}});
  fireEvent.keyDown(input(),{key:'Enter',shiftKey:true});fireEvent.keyDown(input(),{key:'Enter',isComposing:true});expect(state.posts).toHaveLength(0);
  fireEvent.keyDown(input(),{key:'Enter'});await waitFor(()=>expect(state.posts).toHaveLength(1));
  expect(document.activeElement).toBe(input());
});
it('host not ready or view not_started disables sending with a host message, not a Director-chat failure',async()=>{
  directorServer({view:()=>view({layout:'not_started',sessionId:undefined})});
  render(open({session:sessionRead({...readySession,state:'stopped',sessionId:undefined})}));
  expect(await screen.findByText(/Host của phiên chưa sẵn sàng/)).toBeTruthy();expect(sendButton().disabled).toBe(true);
});
it('background refresh keeps the transcript and the draft without a blocking skeleton',async()=>{
  directorServer({messages:[message(1)]});const rendered=render(open());
  await screen.findByText('Tin 1');await waitFor(()=>expect(input().disabled).toBe(false));
  fireEvent.change(input(),{target:{value:'nháp'}});input().focus();
  rendered.rerender(open({revision:1}));
  expect(screen.getByText('Tin 1')).toBeTruthy();expect(input().value).toBe('nháp');expect(document.activeElement).toBe(input());
  expect(screen.queryByText('Đang đọc hội thoại Director…')).toBeNull();
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
});
it('exposes a shared read controller for other surfaces',async()=>{
  directorServer({view:()=>view({presence:'active'})});let seen:ReturnType<typeof useDirector>|undefined;
  function Probe(){seen=useDirector();return null;}
  render(<MemoryRouter><DirectorProvider api={new ApiClient()} projectId="p" session={sessionRead()} revision={0} resetEpoch={0}><Probe/></DirectorProvider></MemoryRouter>);
  await waitFor(()=>expect(seen?.presence).toBe('active'));
  expect(seen).toMatchObject({layout:'director',directorLayout:true,chat:{canSend:true}});
});

describe('Classic integration',()=>{
  async function app(path:string,directorView:()=>unknown,session?:unknown){
    const {App}=await import('../src/app');const {projects,run,decision,preview}=await import('./fixtures');
    class Source{addEventListener(){}close(){}}vi.stubGlobal('EventSource',Source);
    const base:Record<string,unknown>={'/api/v1/session':{apiVersion:1,sessionId:'browser',expiresAt:new Date(Date.now()+3600000).toISOString(),csrfToken:'csrf'},
      '/api/v1/projects':{apiVersion:1,items:projects},'/api/v1/projects/p/preview':preview,'/api/v1/projects/p/runs?limit=25':{apiVersion:1,items:[run]},
      '/api/v1/projects/p/runs/run':run,'/api/v1/projects/p/decisions':{apiVersion:1,items:[decision]},...(session?{'/api/v1/projects/p/session':session}:{})};
    const server=directorServer({view:directorView as never,messages:[message(2,{text:'Director trả lời'})],extra:path=>base[path]});
    render(<MemoryRouter initialEntries={[path]}><App api={new ApiClient()}/></MemoryRouter>);
    return server;
  }
  it('Director layout hides the obsolete create_request form, the legacy chat blocker, and labels the infrastructure start separately',async()=>{
    await app('/projects/p',()=>view({presence:'absent'}));
    expect(await screen.findByRole('button',{name:'Mở phiên Director'})).toBeTruthy();
    expect(screen.getByText(/giao việc bằng cách trò chuyện với Director/)).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Tạo công việc'})).toBeNull();
    expect(screen.queryByText(/Trò chuyện qua web chưa khả dụng/)).toBeNull();
    expect(screen.getByRole('button',{name:'Khởi động hạ tầng phiên'})).toBeTruthy();
  });
  it('the chat route selects Director chat and keeps legacy run history explicitly read-only',async()=>{
    await app('/projects/p/chat',()=>view({presence:'waiting'}));
    expect(await screen.findByText('Director trả lời')).toBeTruthy();
    expect(screen.getByLabelText('Tin nhắn cho Director')).toBeTruthy();
    expect(screen.getByRole('navigation',{name:/chỉ đọc/})).toBeTruthy();
    expect(screen.queryByLabelText('Tin nhắn cho Conversation')).toBeNull();
  });
  it('a backend without the Director port keeps the legacy v2 UI unchanged',async()=>{
    await app('/projects/p',()=>Response.json({apiVersion:1,code:'operation_not_allowed',message:'no port',retryable:false,correlationId:'t'},{status:422}));
    expect(await screen.findByRole('button',{name:'Khởi động phiên'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Mở phiên Director'})).toBeNull();
  });
  it('a legacy v2 view keeps the create_request form, the legacy chat blocker banner and the Conversation chat',async()=>{
    await app('/projects/p',()=>view({layout:'legacy_v2',sessionId:undefined}));
    expect(await screen.findByRole('button',{name:'Tạo công việc'})).toBeTruthy();
    expect(screen.getByText(/Trò chuyện qua web chưa khả dụng/)).toBeTruthy();
    expect(screen.getByRole('button',{name:'Khởi động phiên'})).toBeTruthy();
    expect(screen.queryByRole('region',{name:'Director'})).toBeNull();
    await waitFor(()=>expect(localStorage.getItem('bflow:web:director-layout:p')).toBe('legacy_v2'));
    cleanup();await app('/projects/p/chat',()=>view({layout:'legacy_v2',sessionId:undefined}));
    expect(await screen.findByText('Tìm sách nhanh hơn')).toBeTruthy();
    expect(screen.queryByLabelText('Tin nhắn cho Director')).toBeNull();
  });
  it('a confirmed Director view records the layout hint',async()=>{
    await app('/projects/p',()=>view());
    await waitFor(()=>expect(localStorage.getItem('bflow:web:director-layout:p')).toBe('director'));
  });
  const stopped={...readySession,state:'stopped',sessionId:undefined,blockers:[{code:'chat_adapter_unavailable',message:'legacy'}]};
  const down=()=>Response.json({apiVersion:1,code:'unavailable',message:'down',retryable:true,correlationId:'t'},{status:503});
  it('host stopped with hint=director keeps the Director UX without authority',async()=>{
    localStorage.setItem('bflow:web:director-layout:p','director');
    await app('/projects/p',down,stopped);
    expect(await screen.findByRole('button',{name:'Khởi động hạ tầng phiên'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Tạo công việc'})).toBeNull();
    expect(screen.queryByText(/Trò chuyện qua web chưa khả dụng/)).toBeNull();
    const panel=screen.getByRole('region',{name:'Director'});
    expect(within(panel).getByText('Chưa đọc được trạng thái Director')).toBeTruthy();
    expect(within(panel).queryByRole('button',{name:'Mở phiên Director'})).toBeNull();
    cleanup();await app('/projects/p/chat',down,stopped);
    expect(await screen.findByLabelText('Tin nhắn cho Director')).toBeTruthy();
    expect(screen.getAllByText('Chưa đọc được trạng thái Director').length).toBeGreaterThan(0);
    expect(screen.getByRole<HTMLButtonElement>('button',{name:'Gửi tin nhắn'}).disabled).toBe(true);
    expect(localStorage.getItem('bflow:web:director-layout:p')).toBe('director');
  });
  it.each([['hint=legacy_v2','legacy_v2'],['no hint',undefined]])('host stopped with %s keeps the legacy UX and no Director panel',async(_name,hint)=>{
    if(hint)localStorage.setItem('bflow:web:director-layout:p',hint);
    await app('/projects/p',down,stopped);
    expect(await screen.findByRole('button',{name:'Khởi động phiên'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'Tạo công việc'})).toBeTruthy();
    expect(screen.queryByRole('region',{name:'Director'})).toBeNull();
    expect(screen.queryByText('Chưa đọc được trạng thái Director')).toBeNull();
  });
});
