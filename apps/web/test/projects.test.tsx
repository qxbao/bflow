import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/app';
import { ApiClient } from '../src/api/client';
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
