import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/app';
import { ApiClient } from '../src/api/client';
import { installApi, run } from './fixtures';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function open(){render(<MemoryRouter initialEntries={['/projects/p/runs/run']}><App api={new ApiClient()}/></MemoryRouter>);}
it('keeps engine phase and terminal unknown/done distinct from completion',async()=>{
 installApi();open();await screen.findByRole('heading',{name:run.title});
 expect(screen.getByText('Triển khai')).toBeTruthy();expect(screen.getByText('Chưa xác định')).toBeTruthy();expect(screen.getByText('Kết thúc lượt')).toBeTruthy();expect(screen.queryByText('Hoàn tất')).toBeNull();expect(screen.getByText('Thêm bộ lọc sách')).toBeTruthy();
});
it('keeps the historical run and links to its continuation',async()=>{
 installApi({'/api/v1/projects/p/runs/run':{...run,currentRunId:'child',continuedAsRunId:'child'}});open();
 const link=await screen.findByRole('link',{name:'Mở công việc hiện hành →'});expect(link.getAttribute('href')).toBe('/projects/p/runs/child');expect(screen.getByRole('heading',{name:run.title})).toBeTruthy();
});
it('retains visible snapshots with a stale offline label',async()=>{
 installApi();open();await screen.findByRole('heading',{name:run.title});fireEvent(window,new Event('offline'));
 expect(screen.getByText(/mất kết nối. Đang giữ dữ liệu cũ/)).toBeTruthy();expect(screen.getByRole('heading',{name:run.title})).toBeTruthy();
});
it('shows a readable error for a missing deep link',async()=>{
 installApi({'/api/v1/projects/p/runs/run':undefined});open();expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.getByText(/Không tìm thấy dữ liệu/)).toBeTruthy();
});
it('marks a retained snapshot stale when SSE reconnects but its authoritative refresh fails',async()=>{
 const {fetcher,handlers}=installApi();open();await screen.findByRole('heading',{name:run.title});
 fetcher.mockImplementation(async()=>new Response(JSON.stringify({apiVersion:1,code:'unavailable',message:'unavailable',retryable:true,correlationId:'test'}),{status:503}));
 handlers.get('reset')?.(new MessageEvent('reset',{data:JSON.stringify({apiVersion:1,projectId:'p',cursor:'epoch:2',type:'reset',resourceIds:[],occurredAt:'2026-10-29T00:00:00Z'})}));
 expect(await screen.findByText(/Dữ liệu bên dưới đã cũ/)).toBeTruthy();expect(screen.getByRole('heading',{name:run.title})).toBeTruthy();
});
it('labels every consumed engine/task state rather than silently calling it unknown',async()=>{
 const {WebRunViewSchema}=await import('@bflow/contracts/web');const {phases}=await import('../src/components/StatusBadge');
 const shape=WebRunViewSchema.shape;
 for(const state of [...shape.tasks.element.shape.status.options,...shape.coreStatus.unwrap().options,...shape.sdlcStatus.options]) expect(phases[state],state).toBeDefined();
});
