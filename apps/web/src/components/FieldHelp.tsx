import { useCallback, useEffect, useId, useRef, useState } from 'react';

export interface FieldHelpProps {
  label: string;
  help: string;
  example?: string | undefined;
}

type Placement = {
  mobile: boolean;
  horizontal: 'left' | 'right';
  vertical: 'below' | 'above';
};

export function FieldHelp({ label, help, example }: FieldHelpProps) {
  const tipId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [placement, setPlacement] = useState<Placement>({
    mobile: false,
    horizontal: 'left',
    vertical: 'below',
  });

  const measure = useCallback(() => {
    if (typeof window === 'undefined') return;
    const rect = btnRef.current?.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    if (!rect) return;
    setPlacement({
      mobile: vw < 640,
      horizontal: rect.left + 296 > vw - 12 && rect.right >= 280 ? 'right' : 'left',
      vertical: rect.bottom + 180 > vh && rect.top > 180 ? 'above' : 'below',
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node | null)) {
        setPinned(false);
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPinned(false);
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const positionClass = placement.mobile
    ? 'pointer-events-none fixed right-3 bottom-3 left-3 z-50 block'
    : `pointer-events-none absolute z-50 block w-72 max-w-[calc(100vw-2rem)] ${placement.horizontal === 'right' ? 'right-0' : 'left-0'} ${placement.vertical === 'above' ? 'bottom-full pb-1.5' : 'top-full pt-1.5'}`;

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex shrink-0 items-center align-middle"
      onMouseEnter={() => {
        measure();
        setOpen(true);
      }}
      onMouseLeave={() => {
        if (!pinned && document.activeElement !== btnRef.current) setOpen(false);
      }}
    >
      <button
        ref={btnRef}
        type="button"
        aria-label="Xem giải thích"
        data-field-help={label}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        className="relative inline-flex size-[18px] min-h-0 min-w-0 shrink-0 items-center justify-center rounded-full border border-input bg-surface p-0 font-data text-[11px] leading-none font-bold text-muted transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:border-ink hover:bg-ink hover:text-surface focus-visible:border-ink focus-visible:bg-ink focus-visible:text-surface aria-expanded:border-ink aria-expanded:bg-brand aria-expanded:text-on-brand"
        onFocus={() => {
          measure();
          setOpen(true);
        }}
        onBlur={event => {
          if (!pinned && !wrapRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}
        onKeyDown={event => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            setPinned(false);
            setOpen(false);
          }
        }}
        onClick={event => {
          event.preventDefault();
          event.stopPropagation();
          measure();
          setPinned(prev => {
            const next = !prev;
            setOpen(next);
            return next;
          });
        }}
      >
        ?
      </button>
      {open && (
        <span id={tipId} role="tooltip" className={positionClass}>
          <span className="block border border-ink bg-surface p-2.5 text-left font-prose text-xs leading-relaxed font-normal text-ink shadow-md">
            <strong className="mb-1 block font-data text-xs font-semibold text-ink">{label}</strong>
            <span className="block text-muted">{help}</span>
            {example && <span className="mt-1.5 block border-t border-line pt-1 font-mono text-[11px] text-ink">{example}</span>}
          </span>
        </span>
      )}
    </span>
  );
}

export function FieldLabel({
  htmlFor,
  label,
  help,
  example,
  className = 'mb-1',
  labelClassName = '',
}: FieldHelpProps & { htmlFor: string; className?: string; labelClassName?: string }) {
  return (
    <div className={`flex items-center gap-1.5 ${className}`.trim()}>
      <label htmlFor={htmlFor} className={labelClassName || undefined}>
        {label}
      </label>
      <FieldHelp label={label} help={help} example={example} />
    </div>
  );
}
