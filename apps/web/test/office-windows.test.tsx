import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { clampRect, defaultRect, sceneInset } from '../src/features/office/ui/windows/geometry';
import type { WindowKind } from '../src/features/office/ui/windows/GameWindow';
import { windowReducer, type WinState } from '../src/features/office/ui/windows/WindowManager';
import { WindowManagerProvider, useWindows } from '../src/features/office/ui/windows/WindowManager';
import { Taskbar } from '../src/features/office/ui/windows/Taskbar';
import { MemoryRouter } from 'react-router';

const viewport = { width: 1440, height: 900 };
const open = (state: WinState[], kind: WindowKind, params?: { instanceId?: string }) => windowReducer(state, { type: 'open', kind, ...(params ? { params } : {}), viewport });

afterEach(cleanup);

describe('game window state and geometry', () => {
  test('clamps windows to a reachable title bar and keeps minimum dimensions', () => {
    expect(clampRect({ x: 2000, y: -20, w: 100, h: 100 }, viewport)).toEqual({ x: 1120, y: 0, w: 320, h: 240 });
    expect(defaultRect('app', viewport).w).toBeGreaterThanOrEqual(420);
  });
  test('limits agents and visible windows while preserving repair', () => {
    let state: WinState[] = [];
    state = open(state, 'repair');
    for (let index = 1; index <= 4; index++) state = open(state, 'agent', { instanceId: `dev-${index}` });
    expect(state.filter(item => item.kind === 'agent')).toHaveLength(3);
    for (const kind of ['app', 'unseated', 'cabinet'] as const) state = open(state, kind);
    expect(state.filter(item => item.display !== 'minimized' && item.kind !== 'repair')).toHaveLength(4);
    state = windowReducer(state, { type: 'close', id: 'repair' });
    expect(state.some(item => item.kind === 'repair')).toBe(true);
    state = windowReducer(state, { type: 'closeAll', keep: ['repair'] });
    expect(state.map(item => item.kind)).toEqual(['repair']);
    state = windowReducer(state, { type: 'forceClose', id: 'repair' });
    expect(state).toHaveLength(0);
  });
  test('focus raises z order and opening restores saved geometry', () => {
    let state: WinState[] = [];
    state = open(state, 'app'); state = open(state, 'cabinet');
    state = windowReducer(state, { type: 'focus', id: 'app' });
    expect(state.find(item=>item.id==='app')!.z).toBeGreaterThan(state.find(item=>item.id==='cabinet')!.z);
    state = windowReducer(state, { type: 'close', id: 'cabinet' });
    state = windowReducer(state, { type: 'open', kind: 'cabinet', viewport, saved:{rect:{x:500,y:200,w:420,h:480},display:'maximized'} });
    expect(state.find(item=>item.id==='cabinet')).toMatchObject({ rect:{x:500,y:200,w:420,h:480}, display:'maximized' });
  });
  test('app plus three tool windows remain visible, and focused agent order controls LRU removal',()=>{
    let state:WinState[]=[];
    state=windowReducer(state,{type:'open',kind:'app',viewport,maxVisible:4});
    for(const kind of ['cabinet','server','status'] as const)state=windowReducer(state,{type:'open',kind,viewport,maxVisible:4});
    expect(state.filter(item=>item.display!=='minimized')).toHaveLength(4);
    expect(state.map(item=>item.kind)).toEqual(['app','cabinet','server','status']);
    state=[];
    for(const instanceId of ['A','B','C'])state=windowReducer(state,{type:'open',kind:'agent',params:{instanceId},viewport});
    state=windowReducer(state,{type:'focus',id:'agent:A'});
    state=windowReducer(state,{type:'open',kind:'agent',params:{instanceId:'D'},viewport});
    expect(state.map(item=>item.id).sort()).toEqual(['agent:A','agent:C','agent:D']);
  });
  test('computes scene inset from visible windows and viewport', () => {
    const inset = sceneInset([{ rect: { x: 900, y: 20, w: 500, h: 700 }, display: 'normal' }, { rect: { x: 0, y: 0, w: 320, h: 200 }, display: 'minimized' }], viewport);
    expect(inset).toEqual({ left: 88, right: 540, bottom: 112 });
    expect(sceneInset([], { width: 390, height: 844 })).toEqual({ left: 0, right: 0, bottom: 112 });
  });
  test('taskbar opens Start actions and restores minimized tools', async () => {
    const onMode=vi.fn(),onOverview=vi.fn(),onRefresh=vi.fn(),onCloseAll=vi.fn(),onProject=vi.fn(),onNavigate=vi.fn(),onDocuments=vi.fn(),onGuide=vi.fn(),onStatusOpen=vi.fn();
    function Harness(){const wm=useWindows();return <><button onClick={()=>wm.open('cabinet')}>Open docs</button><button onClick={()=>wm.minimize('cabinet')}>Minimize docs</button><Taskbar quickChat={<form aria-label="quick chat"/>} mode="visual" onMode={onMode} onOverview={onOverview} onRefresh={onRefresh} onCloseAll={onCloseAll} projects={[{projectId:'p',displayName:'Project'}]} projectId="p" onProject={onProject} onNavigate={onNavigate} onDocuments={onDocuments} onGuide={onGuide} onStatusOpen={onStatusOpen} statusText="Đã kết nối"/></>;}
    render(<MemoryRouter><WindowManagerProvider projectId="test-taskbar"><Harness/></WindowManagerProvider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button',{name:'Open docs'}));
    const windowButton=await screen.findByRole('button',{name:'Tài liệu'});
    expect(windowButton.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button',{name:'Minimize docs'}));
    expect(windowButton.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(windowButton);
    expect(windowButton.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button',{name:'◆ Bflow'}));
    fireEvent.click(within(screen.getByRole('group',{name:'Menu Bflow'})).getByRole('button',{name:'Chế độ Web'}));
    expect(onMode).toHaveBeenCalledWith('classic');
    fireEvent.click(screen.getByRole('button',{name:'◆ Bflow'}));
    fireEvent.click(within(screen.getByRole('group',{name:'Menu Bflow'})).getByRole('button',{name:'Tài liệu'}));
    expect(onDocuments).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button',{name:'Mở trạng thái: Đã kết nối'}));
    expect(onStatusOpen).toHaveBeenCalledTimes(1);
  });
});
