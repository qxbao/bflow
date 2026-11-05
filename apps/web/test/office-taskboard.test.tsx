import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ApiClient } from '../src/api/client';
import { TaskBoard } from '../src/features/office/ui/interaction/TaskBoard';
import { installApi, run } from './fixtures';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('TaskBoard preserves the Runs search and phase URL filters in its first API read', async () => {
  const endpoint='/api/v1/projects/p/runs?limit=25&search=book&sdlcStatus=implementing';
  const {fetcher}=installApi({[endpoint]:{apiVersion:1,items:[run]}});
  render(<MemoryRouter initialEntries={['/projects/p/runs?search=book&phase=implementing']}><Routes><Route path="/projects/:id/runs" element={<TaskBoard api={new ApiClient()} id="p" revision={0} refresh={()=>{}}/>}/></Routes></MemoryRouter>);
  expect(await screen.findByRole('link',{name:new RegExp(run.title)})).toBeTruthy();
  expect(fetcher.mock.calls.some(([path])=>path===endpoint)).toBe(true);
  expect((screen.getByLabelText('Tìm công việc') as HTMLInputElement).value).toBe('book');
  expect((screen.getByLabelText('Giai đoạn') as HTMLSelectElement).value).toBe('implementing');
});
