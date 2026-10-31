import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { App } from '../src/app';
import { ApiClient } from '../src/api/client';
import { installApi } from './fixtures';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('reloads a deep-linked run and renders Vietnamese navigation with route focus',async()=>{
 installApi();render(<MemoryRouter initialEntries={['/projects/p/runs/run']}><App api={new ApiClient()}/></MemoryRouter>);
 expect(await screen.findByRole('heading',{name:'Tìm sách nhanh hơn'})).toBeTruthy();
 expect(screen.getByRole('navigation',{name:'Điều hướng chính'})).toBeTruthy();
 expect(document.activeElement?.id).toBe('main');
});
it('opens chat in its own tab with one conversation per run and links the run page to it',async()=>{
 installApi({'/api/v1/projects/p/sessions/host-session/messages':{apiVersion:1,items:[]}});
 render(<MemoryRouter initialEntries={['/projects/p/chat']}><App api={new ApiClient()}/></MemoryRouter>);
 const user=userEvent.setup();
 expect((await screen.findByRole('link',{name:'Trò chuyện'})).getAttribute('aria-current')).toBe('page');
 expect(await screen.findByText('Chọn một công việc')).toBeTruthy();
 await user.click(await screen.findByRole('link',{name:/Tìm sách nhanh hơn/}));
 expect(await screen.findByRole('region',{name:'Trò chuyện của công việc'})).toBeTruthy();
 expect(await screen.findByText('Chưa có tin nhắn trong công việc này.')).toBeTruthy();
 await user.click(screen.getByRole('link',{name:'Xem công việc →'}));
 expect((await screen.findByRole('link',{name:'Mở trò chuyện của công việc →'})).getAttribute('href')).toBe('/projects/p/chat/run');
 expect(screen.queryByRole('region',{name:'Trò chuyện của công việc'})).toBeNull();
});
it('switches project using the native keyboard accessible select',async()=>{
 installApi({'/api/v1/projects/q/session':{apiVersion:1,projectId:'q',state:'stopped',pendingIntakes:[],blockers:[],updatedAt:'2026-10-29T00:00:00Z'},'/api/v1/projects/q/preview':{apiVersion:1,projectId:'q',available:false,summary:'Chưa chạy.',blockers:[],observedAt:'2026-10-29T00:00:00Z'}});
 render(<MemoryRouter><App api={new ApiClient()}/></MemoryRouter>);
 await screen.findByRole('option',{name:'Kho phim'});
 const user=userEvent.setup();const select=screen.getByLabelText('Dự án đang xem');select.focus();
 await user.selectOptions(select,'q');
 expect(await screen.findByText('Phiên: Đã dừng')).toBeTruthy();
 expect(screen.getByRole('link',{name:'Tổng quan'}).getAttribute('href')).toBe('/projects/q');
});
