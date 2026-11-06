import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { StickerIcon, type StickerIconName } from './icons';

export type WindowKind = 'app' | 'agent' | 'unseated' | 'director' | 'director-chat' | 'queue' | 'cabinet' | 'server' | 'repair' | 'operations' | 'status';
export type WindowDisplay = 'normal' | 'minimized' | 'maximized';
export interface WindowRect { x: number; y: number; w: number; h: number }

export interface GameWindowProps {
  id: string;
  kind: WindowKind;
  title: string;
  icon: StickerIconName;
  color: string;
  titleText?: string;
  badge?: ReactNode;
  rect: WindowRect;
  z?: number;
  display: WindowDisplay;
  active: boolean;
  closable: boolean;
  minimizable: boolean;
  maximizable: boolean;
  resizable: boolean;
  movable?: boolean;
  hidden?: boolean;
  embedded?: boolean;
  modal?: boolean;
  titleId?: string;
  nav?: ReactNode;
  children?: ReactNode;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onMove: (dx: number, dy: number) => void;
  onResize: (dw: number, dh: number) => void;
}

interface PointerStart { pointerId: number; x: number; y: number; dx: number; dy: number; resize: boolean }

export function GameWindow(props: GameWindowProps) {
  const {
    id, kind, title, icon, color, titleText, badge, rect, display, active, closable, minimizable, maximizable,
    resizable, movable = true, hidden = false, embedded = false, modal = kind === 'repair', titleId, nav, children,
    onFocus, onClose, onMinimize, onToggleMaximize, onMove, onResize,
  } = props;
  const generatedId = useId();
  const headingId = titleId ?? `window-title-${generatedId}`;
  const pointer = useRef<PointerStart | undefined>(undefined);
  const titlebar = useRef<HTMLElement>(null);
  const style: CSSProperties = {
    left: display==='maximized'?0:rect.x,
    top: display==='maximized'?0:rect.y,
    width: display==='maximized'?'100vw':rect.w,
    height: display==='maximized'?'calc(100dvh - 56px)':rect.h,
    zIndex: kind === 'repair' ? 2000 : props.z === undefined ? undefined : props.z + 40,
    '--win-accent': color,
    '--win-title-ink': titleText ?? (color.includes('decide') || kind === 'queue' || kind === 'status' ? 'var(--win-ink)' : '#fff'),
  } as CSSProperties;
  const visible = !hidden && display !== 'minimized';
  useEffect(()=>{if(embedded||!visible||!active)return;const frame=requestAnimationFrame(()=>titlebar.current?.focus());return()=>cancelAnimationFrame(frame);},[embedded,visible,active]);

  function windowElement(): HTMLElement | null {
    return embedded ? document.getElementById('main') : titlebar.current?.closest<HTMLElement>('.bwin') ?? null;
  }

  function startPointer(event: PointerEvent<HTMLElement>, resize: boolean): void {
    if (event.button !== 0 || (!resize && (!movable || (event.target as Element).closest('button, a, input, select, textarea')))) return;
    pointer.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0, resize };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    onFocus();
  }

  function movePointer(event: PointerEvent<HTMLElement>): void {
    const start = pointer.current;
    if (!start || start.pointerId !== event.pointerId) return;
    start.dx = event.clientX - start.x;
    start.dy = event.clientY - start.y;
    const element = windowElement();
    if (!element) return;
    if (start.resize) {
      element.style.setProperty('--bwin-preview-width', `${Math.max(320, rect.w + start.dx)}px`);
      element.style.setProperty('--bwin-preview-height', `${Math.max(240, rect.h + start.dy)}px`);
    } else {
      element.style.transform = `translate3d(${start.dx}px, ${start.dy}px, 0)`;
    }
  }

  function endPointer(event: PointerEvent<HTMLElement>, commit: boolean): void {
    const start = pointer.current;
    if (!start || start.pointerId !== event.pointerId) return;
    pointer.current = undefined;
    const element = windowElement();
    if (element) {
      element.style.transform = '';
      element.style.removeProperty('--bwin-preview-width');
      element.style.removeProperty('--bwin-preview-height');
    }
    if (!commit) return;
    if (start.resize) onResize(start.dx, start.dy);
    else if (start.dx !== 0 || start.dy !== 0) onMove(start.dx, start.dy);
    if (kind === 'director-chat') window.dispatchEvent(new Event('bflow:director-dialogue-state'));
  }

  function titleKey(event: KeyboardEvent<HTMLElement>): void {
    if (event.target !== event.currentTarget || event.defaultPrevented) return;
    const step = event.shiftKey ? 16 : 0;
    const directions: Record<string, [number, number]> = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] };
    const delta = directions[event.key];
    if (delta) {
      event.preventDefault();
      if (step && resizable) onResize(delta[0], delta[1]);
      else if (!step && movable) onMove(delta[0], delta[1]);
    } else if (event.key === 'Enter' && maximizable) {
      event.preventDefault();
      onToggleMaximize();
    }
  }

  const titlebarElement = <header
    ref={titlebar}
    className={`bwin-titlebar ${active ? '' : 'is-inactive'}`}
    aria-label={`Thanh tiêu đề ${title}`}
    aria-roledescription="thanh tiêu đề"
    tabIndex={0}
    onKeyDown={titleKey}
    onPointerDown={event => startPointer(event, false)}
    onPointerMove={movePointer}
    onPointerUp={event => endPointer(event, true)}
    onPointerCancel={event => endPointer(event, false)}
  >
    <StickerIcon name={icon} className="bwin-title-icon"/>
    <h2 id={headingId} className="bwin-title-text">{title}</h2>
    {badge}
    <div className="bwin-controls">
      {minimizable && <button type="button" aria-label={`Thu nhỏ ${title}`} title="Thu nhỏ" onPointerDown={event => event.stopPropagation()} onClick={onMinimize}>_</button>}
      {maximizable && <button type="button" aria-label={`${display === 'maximized' ? 'Khôi phục' : 'Phóng to'} ${title}`} title={display === 'maximized' ? 'Khôi phục' : 'Phóng to'} onPointerDown={event => event.stopPropagation()} onClick={onToggleMaximize}>{display === 'maximized' ? '❐' : '□'}</button>}
      {closable && <button type="button" aria-label={`Đóng cửa sổ ${title}`} title="Đóng" onPointerDown={event => event.stopPropagation()} onClick={onClose}>×</button>}
    </div>
  </header>;

  const navElement = nav && <div className="bwin-nav">{nav}</div>;
  const resizeHandle = resizable && !embedded && <button
    type="button"
    className="bwin-resize"
    aria-label={`Thay đổi kích thước ${title}`}
    onPointerDown={event => startPointer(event, true)}
    onPointerMove={movePointer}
    onPointerUp={event => endPointer(event, true)}
    onPointerCancel={event => endPointer(event, false)}
    onClick={event => event.preventDefault()}
  ><span aria-hidden="true">///</span></button>;

  if (embedded) return <>{titlebarElement}{navElement}{resizeHandle}</>;

  const focusable = (event: KeyboardEvent<HTMLElement>): void => {
    if (!modal || event.key !== 'Tab') return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')];
    if (!items.length) { event.preventDefault(); event.currentTarget.focus(); return; }
    const first = items[0]!, last = items.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const windowKeyDown=(event:KeyboardEvent<HTMLElement>)=>{
    if(event.key==='Escape'&&!event.defaultPrevented&&!event.nativeEvent.isComposing){if(event.target instanceof Element&&event.target.closest('dialog[open]'))return;event.preventDefault();if(closable)onClose();return;}
    focusable(event);
  };

  return <>
    {modal && visible && <div className="bwin-backdrop" style={{zIndex:kind==='repair'?1999:(props.z??1)+39}} aria-hidden="true"/>}
    <section
      className={`bwin ${active ? 'is-active' : ''} ${display === 'maximized' ? 'is-maximized' : ''}`}
      style={style}
      role="dialog"
      aria-modal={modal ? 'true' : 'false'}
      aria-labelledby={headingId}
      aria-hidden={!visible}
      data-window-id={id}
      data-window-kind={kind}
      data-display={display}
      hidden={!visible}
      tabIndex={-1}
      onPointerDown={onFocus}
      onKeyDown={windowKeyDown}
    >
      {titlebarElement}
      {navElement}
      <div className="bwin-body">{children}</div>
      {resizeHandle}
    </section>
  </>;
}
