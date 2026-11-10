import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GameWindow } from '../src/features/office/ui/windows/GameWindow';

if (!window.PointerEvent) {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; }
  }
  Object.defineProperty(window, 'PointerEvent', { value: TestPointerEvent });
}

afterEach(cleanup);

function renderWindow(overrides: Partial<Parameters<typeof GameWindow>[0]> = {}) {
  const props = {
    id: 'agent:dev-1',
    kind: 'agent' as const,
    title: 'Developer 1',
    icon: 'agents' as const,
    color: 'var(--win-c-people)',
    rect: { x: 300, y: 160, w: 400, h: 520 },
    display: 'normal' as const,
    active: true,
    closable: true,
    minimizable: true,
    maximizable: true,
    resizable: true,
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onMinimize: vi.fn(),
    onToggleMaximize: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
    children: <p>Window content</p>,
    ...overrides,
  };
  render(<GameWindow {...props} />);
  return props;
}

test('window chrome exposes a labelled dialog and named window controls', () => {
  renderWindow();

  const dialog = screen.getByRole('dialog', { name: 'Developer 1' });
  expect(dialog.getAttribute('data-window-kind')).toBe('agent');
  expect(dialog.getAttribute('data-display')).toBe('normal');
  expect(dialog.getAttribute('aria-modal')).toBe('false');
  expect(screen.getByRole('button', { name: 'Thu nhỏ Developer 1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Phóng to Developer 1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Đóng cửa sổ Developer 1' })).toBeTruthy();
  expect(screen.getByText('Window content')).toBeTruthy();
});

test('title bar keyboard controls move, resize and maximize the window', () => {
  const props = renderWindow();
  const titlebar = screen.getByLabelText('Thanh tiêu đề Developer 1');

  fireEvent.keyDown(titlebar, { key: 'ArrowRight' });
  fireEvent.keyDown(titlebar, { key: 'ArrowDown', shiftKey: true });
  fireEvent.keyDown(titlebar, { key: 'Enter' });

  expect(props.onMove).toHaveBeenCalledWith(16, 0);
  expect(props.onResize).toHaveBeenCalledWith(0, 16);
  expect(props.onToggleMaximize).toHaveBeenCalledTimes(1);
});

test('pointer drag commits once on release and title-bar buttons do not drag', () => {
  const props = renderWindow();
  const titlebar = screen.getByLabelText('Thanh tiêu đề Developer 1');

  fireEvent.pointerDown(titlebar, { pointerId: 3, button: 0, clientX: 10, clientY: 20 });
  fireEvent.pointerMove(titlebar, { pointerId: 3, buttons: 1, clientX: 36, clientY: 42 });
  expect(props.onMove).not.toHaveBeenCalled();
  fireEvent.pointerUp(titlebar, { pointerId: 3, button: 0, clientX: 36, clientY: 42 });
  expect(props.onMove).toHaveBeenCalledTimes(1);
  expect(props.onMove).toHaveBeenCalledWith(26, 22);

  fireEvent.pointerDown(screen.getByRole('button', { name: 'Đóng cửa sổ Developer 1' }), { pointerId: 4, button: 0, clientX: 10, clientY: 20 });
  fireEvent.pointerMove(titlebar, { pointerId: 4, buttons: 1, clientX: 50, clientY: 60 });
  fireEvent.pointerUp(titlebar, { pointerId: 4, button: 0, clientX: 50, clientY: 60 });
  expect(props.onMove).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(0);
});

test('repair window has a modal surface with no dismiss controls', () => {
  renderWindow({ id: 'repair', kind: 'repair', title: 'Ghép nối lại', closable: false, minimizable: false, maximizable: false, resizable: false });

  expect(screen.getByRole('dialog', { name: 'Ghép nối lại' }).getAttribute('aria-modal')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Đóng cửa sổ Ghép nối lại' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Thu nhỏ Ghép nối lại' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Phóng to Ghép nối lại' })).toBeNull();
});

test('Escape in a non-active window leaves arbitration to the window manager',()=>{
  const props=renderWindow({active:false});
  fireEvent.keyDown(screen.getByLabelText('Thanh tiêu đề Developer 1'),{key:'Escape'});
  expect(props.onClose).not.toHaveBeenCalled();
});

test('activating a window while focus is already on an inner input preserves input focus, and director-chat drag emits live dialogue-state events', async () => {
  const events: Event[] = [];
  const onEvent = (e: Event) => events.push(e);
  window.addEventListener('bflow:director-dialogue-state', onEvent);
  const { rerender } = render(
    <GameWindow
      id="director-chat"
      kind="director-chat"
      title="Trò chuyện với Director"
      icon="chat"
      color="var(--win-c-chat)"
      rect={{ x: 300, y: 160, w: 400, h: 520 }}
      display="normal"
      active={false}
      closable
      minimizable
      maximizable
      resizable
      onFocus={() => {}}
      onClose={() => {}}
      onMinimize={() => {}}
      onToggleMaximize={() => {}}
      onMove={() => {}}
      onResize={() => {}}
    >
      <input aria-label="Chat input" />
    </GameWindow>
  );
  const input = screen.getByLabelText('Chat input');
  input.focus();
  expect(document.activeElement).toBe(input);
  rerender(
    <GameWindow
      id="director-chat"
      kind="director-chat"
      title="Trò chuyện với Director"
      icon="chat"
      color="var(--win-c-chat)"
      rect={{ x: 300, y: 160, w: 400, h: 520 }}
      display="normal"
      active={true}
      closable
      minimizable
      maximizable
      resizable
      onFocus={() => {}}
      onClose={() => {}}
      onMinimize={() => {}}
      onToggleMaximize={() => {}}
      onMove={() => {}}
      onResize={() => {}}
    >
      <input aria-label="Chat input" />
    </GameWindow>
  );
  await new Promise(resolve => requestAnimationFrame(resolve));
  expect(document.activeElement).toBe(input);

  const titlebar = screen.getByLabelText('Thanh tiêu đề Trò chuyện với Director');
  fireEvent.pointerDown(titlebar, { pointerId: 7, button: 0, clientX: 10, clientY: 20 });
  fireEvent.pointerMove(titlebar, { pointerId: 7, buttons: 1, clientX: 40, clientY: 50 });
  expect(events.length).toBeGreaterThanOrEqual(1);
  window.removeEventListener('bflow:director-dialogue-state', onEvent);
});
