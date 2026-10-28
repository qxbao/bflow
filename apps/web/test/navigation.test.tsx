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
it('switches project using the native keyboard accessible select',async()=>{
 installApi({'/api/v1/projects/q/session':{apiVersion:1,projectId:'q',state:'stopped',pendingIntakes:[],blockers:[],updatedAt:'2026-10-29T00:00:00Z'},'/api/v1/projects/q/preview':{apiVersion:1,projectId:'q',available:false,summary:'Chưa chạy.',blockers:[],observedAt:'2026-10-29T00:00:00Z'}});
 render(<MemoryRouter><App api={new ApiClient()}/></MemoryRouter>);
 await screen.findByRole('option',{name:'Kho phim'});
 const user=userEvent.setup();const select=screen.getByLabelText('Dự án đang xem');select.focus();
 await user.selectOptions(select,'q');
 expect(await screen.findByText('Phiên: Đã dừng')).toBeTruthy();
 expect(screen.getByRole('link',{name:'Tổng quan'}).getAttribute('href')).toBe('/projects/q');
});
