import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/app';
import { ApiClient } from '../src/api/client';
import { directorTime } from '../src/features/director/status';
import { AccessibleOffice } from '../src/features/office/ui/AccessibleOffice';
import { sortProjects } from '../src/features/projects';
import { installApi } from './fixtures';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('provides an empty registry and visible absolute path label',async()=>{
 installApi({'/api/v1/projects':{apiVersion:1,items:[]}});render(<MemoryRouter><App api={new ApiClient()}/></MemoryRouter>);
 expect(await screen.findByRole('heading',{name:'Chưa có dự án'})).toBeTruthy();expect(screen.getByLabelText('Đường dẫn Git tuyệt đối')).toBeTruthy();
});
it('shows missing host remediation without starting a session',async()=>{
 const {fetcher}=installApi();render(<MemoryRouter initialEntries={['/projects/p']}><App api={new ApiClient()}/></MemoryRouter>);
 expect(await screen.findByText('Phiên: Chưa sẵn sàng')).toBeTruthy();
 expect(screen.getByRole('link',{name:'Kiểm tra điều kiện dự án →'})).toBeTruthy();
 expect(fetcher.mock.calls.some(([path])=>path.includes('/start'))).toBe(false);
});
it('explains expired browser sessions without exposing server internals',async()=>{
 installApi();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({apiVersion:1,code:'session_required',message:'raw-private-error',retryable:false,correlationId:'test'}),{status:401})));
 render(<MemoryRouter><App api={new ApiClient()}/></MemoryRouter>);
 expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.getByText(/Phiên trình duyệt đã hết hạn/)).toBeTruthy();expect(screen.queryByText('raw-private-error')).toBeNull();
});
it('ac-1: AccessibleOffice.tsx hiển thị thời gian quan sát qua directorTime(a.observedAt) và projects.tsx cung cấp hàm sortProjects ưu tiên dự án ngoài /tmp/ lên trước.',()=>{
 const sorted=sortProjects([
  {projectId:'p1',displayName:'Temp',canonicalPath:'/tmp/demo',registrationState:'registered',createdAt:'2026-11-07T00:00:00.000Z',updatedAt:'2026-11-07T00:00:00.000Z'},
  {projectId:'p2',displayName:'Real',canonicalPath:'/mnt/proj',registrationState:'registered',createdAt:'2026-11-07T00:00:00.000Z',updatedAt:'2026-11-07T00:00:00.000Z'},
 ]);
 expect(sorted.map(p=>p.projectId)).toEqual(['p2','p1']);
 const formatted=directorTime('2026-11-07T20:01:32.898Z');
 expect(formatted).toMatch(/^\d{2}:\d{2}$/);
 render(
  <AccessibleOffice
   visible={true}
   onSelect={()=>{}}
   model={{
    tier:'full',
    statusText:'Sẵn sàng',
    certainty:'confirmed',
    connection:'live',
    pendingDecisions:0,
    handoffs:[],
    tasks:[],
    agents:[{instanceId:'a1',label:'Dev 1',role:'developer',statusText:'Đang làm',certainty:'confirmed',observedAt:'2026-11-07T20:01:32.898Z'} as never],
   } as never}
  />,
 );
 expect(screen.getByText(new RegExp(`quan sát lúc ${formatted}`))).toBeTruthy();
});
