import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { ApiClient } from '../src/api/client';
import { Runs } from '../src/features/runs';
import { Projects } from '../src/features/projects';
import { AppShell } from '../src/components/AppShell';
import { LoadingState } from '../src/components/LoadingState';
import { installApi, projects, run } from './fixtures';
import { WebProjectSchema } from '@bflow/contracts/web';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function LocationControls(){const location=useLocation(),navigate=useNavigate();return <><output aria-label="URL">{location.search}</output><button onClick={()=>navigate(-1)}>Historique précédent</button><button onClick={()=>navigate(1)}>Historique suivant</button></>;}
it('keeps server filters on retry and supports previous cursor pages and browser history',async()=>{
 installApi({'/api/v1/projects/p/runs?limit=25&search=sach':{apiVersion:1,items:[run],nextCursor:'second'},'/api/v1/projects/p/runs?limit=25&search=sach&cursor=second':{apiVersion:1,items:[{...run,runId:'second',title:'Trang hai'}]}});
 const user=userEvent.setup();render(<MemoryRouter initialEntries={['/?search=sach']}><Runs api={new ApiClient()} id="p" revision={0} refresh={()=>{}}/><LocationControls/></MemoryRouter>);
 await screen.findByRole('heading',{name:run.title});await user.click(screen.getByRole('button',{name:'Trang tiếp theo'}));
 await screen.findByRole('heading',{name:'Trang hai'});expect(screen.getByLabelText('URL').textContent).toContain('search=sach');
 await user.click(screen.getByRole('button',{name:'Trang trước'}));await screen.findByRole('heading',{name:run.title});
 await user.click(screen.getByRole('button',{name:'Historique précédent'}));await screen.findByRole('heading',{name:'Trang hai'});
});
it('does not invent a previous page or page number on a cursor deep link',async()=>{
 installApi({'/api/v1/projects/p/runs?limit=25&cursor=opaque':{apiVersion:1,items:[run]}});
 render(<MemoryRouter initialEntries={['/?cursor=opaque']}><Runs api={new ApiClient()} id="p" revision={0} refresh={()=>{}}/></MemoryRouter>);
 await screen.findByRole('heading',{name:run.title});expect(screen.getByText(/Trang hiện tại/)).toBeTruthy();expect((screen.getByRole('button',{name:'Trang trước'}) as HTMLButtonElement).disabled).toBe(true);
});
it('preserves filters when a read fails and retry is requested',async()=>{
 installApi();const refresh=vi.fn(),user=userEvent.setup();
 render(<MemoryRouter initialEntries={['/?search=missing&phase=failed']}><Runs api={new ApiClient()} id="p" revision={0} refresh={refresh}/><LocationControls/></MemoryRouter>);
 await user.click(await screen.findByRole('button',{name:'Thử tải lại'}));expect(refresh).toHaveBeenCalledOnce();expect(screen.getByLabelText('URL').textContent).toBe('?search=missing&phase=failed');
});
it('paginates projects, searches paths and distinguishes no search results',async()=>{
 const items=Array.from({length:15},(_,i)=>WebProjectSchema.parse({...projects[0],projectId:'p'+i,displayName:'Kho '+i,canonicalPath:'/work/repo-'+i}));
 const user=userEvent.setup();render(<MemoryRouter><Projects api={new ApiClient()} projects={items} refresh={()=>{}}/></MemoryRouter>);
 expect(screen.getAllByRole('link',{name:/Xem dự án/})).toHaveLength(12);
 await user.click(screen.getByRole('button',{name:'Trang tiếp theo'}));expect(screen.getAllByRole('link',{name:/Xem dự án/})).toHaveLength(3);
 await user.type(screen.getByRole('searchbox',{name:'Tìm dự án'}),'repo-14');expect(screen.getAllByRole('link',{name:/Xem dự án/})).toHaveLength(1);
 await user.clear(screen.getByRole('searchbox',{name:'Tìm dự án'}));await user.type(screen.getByRole('searchbox',{name:'Tìm dự án'}),'absent');expect(screen.getByRole('heading',{name:'Không có dự án phù hợp'})).toBeTruthy();
});
it('toggles accessible mobile navigation and closes on route selection',async()=>{
 const user=userEvent.setup();render(<MemoryRouter initialEntries={['/projects/p']}><AppShell projects={[]} projectId="p"><LocationControls/></AppShell></MemoryRouter>);
 const toggle=screen.getByRole('button',{name:'Điều hướng'});expect(toggle.getAttribute('aria-expanded')).toBe('false');
 await user.click(toggle);expect(toggle.getAttribute('aria-expanded')).toBe('true');await user.click(screen.getByRole('link',{name:'Công việc'}));
 expect(toggle.getAttribute('aria-expanded')).toBe('false');expect(document.activeElement?.id).toBe('main');
});
it('reserves skeleton rows initially and uses a small status for background refresh',()=>{
 const {rerender}=render(<LoadingState loading initial label="Đang tải danh sách…"/>);
 expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');expect(screen.getByText('Đang tải danh sách…').className).toContain('sr-only');
 rerender(<LoadingState loading initial={false} label="Đang tải danh sách…"/>);expect(within(screen.getByRole('status')).getByText('Đang cập nhật dữ liệu…')).toBeTruthy();
 rerender(<LoadingState loading={false} initial={false} label="Đang tải danh sách…"/>);expect(screen.queryByRole('status')).toBeNull();
});
it('bounds review requests to the visible page and protects an unfinished decision when paging',async()=>{
 const { Review }=await import('../src/features/review');const { Operations }=await import('../src/features/operations');
 const { decision }=await import('./fixtures');
 vi.stubGlobal('navigator',{onLine:true,locks:{request:async(_key:string,callback:()=>unknown)=>callback()}});localStorage.clear();
 const items=Array.from({length:12},(_,i)=>({...decision,decisionId:'d'+i,question:'Quyết định '+i,expectedVersion:{...decision.expectedVersion,approvalId:'d'+i}}));
 const {fetcher}=installApi({'/api/v1/projects/p/decisions':{apiVersion:1,items},'/api/v1/projects/p/runs/run':{...run,decisions:items,availableActions:[{actionId:'answer',kind:'answer_decision',enabled:true,expectedVersion:items[0]!.expectedVersion}]}});
 const user=userEvent.setup();render(<MemoryRouter><Operations api={new ApiClient()} id="p" refresh={()=>{}}><Review api={new ApiClient()} id="p" revision={0} refresh={()=>{}}/></Operations></MemoryRouter>);
 const open=await screen.findAllByRole('button',{name:'Xem xét gói'});expect(open).toHaveLength(10);
 await vi.waitFor(()=>expect((open[0] as HTMLButtonElement).disabled).toBe(false));
 expect(fetcher.mock.calls.filter(([path])=>path==='/api/v1/projects/p/runs/run')).toHaveLength(1);
 await user.click(open[0]!);await user.type(screen.getByLabelText(/Lý do/),'Cần bổ sung kiểm chứng');
 await user.click(screen.getByRole('button',{name:'Trang tiếp theo'}));expect(screen.getByRole('heading',{name:'Rời nội dung quyết định chưa gửi?'})).toBeTruthy();
 await user.click(screen.getByRole('button',{name:'Quay lại'}));expect((screen.getByLabelText(/Lý do/) as HTMLTextAreaElement).value).toBe('Cần bổ sung kiểm chứng');
 await user.click(screen.getByRole('button',{name:'Trang tiếp theo'}));await user.click(screen.getByRole('button',{name:'Bỏ nội dung và tiếp tục'}));expect(await screen.findAllByRole('button',{name:'Xem xét gói'})).toHaveLength(2);expect(screen.queryByLabelText(/Lý do/)).toBeNull();
});
it('keeps the current content and focused search draft during a background read',async()=>{
 const {act}=await import('@testing-library/react');const {fetcher}=installApi();const api=new ApiClient();
 const view=(revision:number)=><MemoryRouter><Runs api={api} id="p" revision={revision} refresh={()=>{}}/></MemoryRouter>;
 const mounted=render(view(0));await screen.findByRole('heading',{name:run.title});
 const input=screen.getByRole('searchbox',{name:'Tìm công việc'});const user=userEvent.setup();await user.type(input,'bản nháp');
 let finish!:(value:Response)=>void;fetcher.mockImplementation(()=>new Promise<Response>(resolve=>{finish=resolve;}));mounted.rerender(view(1));
 expect(screen.getByRole('heading',{name:run.title})).toBeTruthy();expect(screen.getByText('Đang cập nhật dữ liệu…')).toBeTruthy();expect(document.activeElement).toBe(input);
 await act(async()=>finish(Response.json({apiVersion:1,items:[{...run,title:'Dữ liệu mới'}]})));await screen.findByRole('heading',{name:'Dữ liệu mới'});expect((input as HTMLInputElement).value).toBe('bản nháp');expect(document.activeElement).toBe(input);
});
it('clamps local pages after a collection shrinks and rejects malformed page values',async()=>{
 const {localPage}=await import('../src/features/pagination');expect(localPage([1,2,3],'99',2)).toEqual({page:2,pages:2,items:[3]});expect(localPage([1,2,3],'Infinity',2).page).toBe(1);expect(localPage([],'2',12)).toEqual({page:1,pages:1,items:[]});
});
it('retains revision-pinned review drafts across browser Back/Forward and invalidates changed packages',async()=>{
 const { Review }=await import('../src/features/review'),{ Operations }=await import('../src/features/operations'),{ decision }=await import('./fixtures');
 vi.stubGlobal('navigator',{onLine:true,locks:{request:async(_key:string,callback:()=>unknown)=>callback()}});localStorage.clear();
 const items=Array.from({length:12},(_,i)=>({...decision,decisionId:'h'+i,question:'Historique '+i,expectedVersion:{...decision.expectedVersion,approvalId:'h'+i}}));
 const {fetcher}=installApi({'/api/v1/projects/p/decisions':{apiVersion:1,items},'/api/v1/projects/p/runs/run':{...run,decisions:items,availableActions:items.map(item=>({actionId:item.decisionId,kind:'answer_decision',enabled:true,expectedVersion:item.expectedVersion}))}});
 const api=new ApiClient(),user=userEvent.setup();
 const view=(revision:number)=><MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><Review api={api} id="p" revision={revision} refresh={()=>{}}/><LocationControls/></Operations></MemoryRouter>;
 const mounted=render(view(0));await screen.findByRole('heading',{name:'Historique 0'});await user.click(screen.getByRole('button',{name:'Trang tiếp theo'}));
 await user.click((await screen.findAllByRole('button',{name:'Xem xét gói'}))[0]!);await user.type(screen.getByLabelText(/Lý do/),'Bản nháp cần giữ');
 await user.click(screen.getByRole('button',{name:'Historique précédent'}));await screen.findByRole('heading',{name:'Historique 0'});
 await user.click(screen.getByRole('button',{name:'Historique suivant'}));expect((await screen.findByLabelText(/Lý do/) as HTMLTextAreaElement).value).toBe('Bản nháp cần giữ');
 items[10]!.expectedVersion={...items[10]!.expectedVersion,revision:2,evidenceDigest:'b'.repeat(64)};mounted.rerender(view(1));await screen.findByRole('button',{name:'Đọc lại gói hiện hành'});expect(screen.queryByRole('button',{name:'Duyệt gói'})).toBeNull();expect(fetcher.mock.calls.every((call:any)=>!call[1] || call[1].method==='GET')).toBe(true);
});
it('isolates a failed run read while leaving another authorized review usable',async()=>{
 const { Review }=await import('../src/features/review'),{ Operations }=await import('../src/features/operations'),{ decision }=await import('./fixtures');
 vi.stubGlobal('navigator',{onLine:true,locks:{request:async(_key:string,callback:()=>unknown)=>callback()}});localStorage.clear();
 installApi({'/api/v1/projects/p/decisions':{apiVersion:1,items:[decision,{...decision,decisionId:'missing',runId:'missing',question:'Công việc không truy cập được',expectedVersion:{...decision.expectedVersion,approvalId:'missing'}}]},'/api/v1/projects/p/runs/run':{...run,availableActions:[{actionId:'good',kind:'answer_decision',enabled:true,expectedVersion:decision.expectedVersion}]}});
 render(<MemoryRouter><Operations api={new ApiClient()} id="p" refresh={()=>{}}><Review api={new ApiClient()} id="p" revision={0} refresh={()=>{}}/></Operations></MemoryRouter>);
 const buttons=await screen.findAllByRole('button',{name:'Xem xét gói'});await vi.waitFor(()=>expect((buttons[0] as HTMLButtonElement).disabled).toBe(false));expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole('alert')).toBeTruthy();
});
