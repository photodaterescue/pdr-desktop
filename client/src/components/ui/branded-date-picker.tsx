import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Branded date picker — replaces the native <input type="date"> in
 * places where the OS-rendered calendar widget looked out of place
 * against PDR's lavender / rounded-card design language. Built with
 * the existing Popover primitive, lucide icons, palette tokens
 * (bg-primary, text-primary-foreground, border-border, etc.) — no
 * freehand visuals.
 *
 * Features:
 *   • Future dates are disabled (photos can't have been taken in
 *     the future). Hard-coded — no escape hatch.
 *   • Year + month dropdowns at the top so the user can jump from
 *     2003 to 1987 in two clicks instead of mashing the chevron.
 *   • Month grid with the chosen day highlighted in lavender, today
 *     ringed in primary so the user always has a visual anchor.
 *   • ISO YYYY-MM-DD value compatible with the existing
 *     `dateFrom` / `dateTo` state — the upstream consumer doesn't
 *     change at all, this is a drop-in.
 *
 * Props:
 *   value     — current ISO date string ('' for no selection)
 *   onChange  — called with the new ISO date string
 *   placeholder — text shown in the trigger when value is empty
 *   ariaLabel — for screen readers
 *   className — extra classes for the trigger button
 *   minYear   — the earliest year in the year dropdown (defaults to 1900)
 */
export interface BrandedDatePickerProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  minYear?: number;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function pad2(n: number): string { return n.toString().padStart(2, '0'); }
function toIso(y: number, m: number, d: number): string { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }
function parseIso(value: string): { y: number; m: number; d: number } | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: parseInt(m[1], 10), m: parseInt(m[2], 10) - 1, d: parseInt(m[3], 10) };
}
function daysInMonth(year: number, monthZero: number): number {
  return new Date(year, monthZero + 1, 0).getDate();
}
function startWeekday(year: number, monthZero: number): number {
  // 0 = Sun. Convert to Mon-first (0 = Mon … 6 = Sun) so the grid
  // matches the rest of the European-style PDR UI.
  const sun0 = new Date(year, monthZero, 1).getDay();
  return (sun0 + 6) % 7;
}

export function BrandedDatePicker({
  value,
  onChange,
  placeholder = 'dd / mm / yyyy',
  ariaLabel,
  className,
  minYear = 1900,
}: BrandedDatePickerProps) {
  const today = useMemo(() => {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
  }, []);

  // Parsed selection, if any. Drives both the trigger label and the
  // initial year/month the calendar opens on.
  const parsed = useMemo(() => parseIso(value), [value]);

  // The year/month currently displayed in the popover. Independent
  // of the selection so the user can browse without committing.
  const [viewY, setViewY] = useState<number>(parsed?.y ?? today.y);
  const [viewM, setViewM] = useState<number>(parsed?.m ?? today.m);
  const [open, setOpen] = useState(false);

  // Reset the visible month/year to the selection (or today) every
  // time the picker opens. Keeps "open the picker" feeling fresh
  // rather than landing on whichever month the user last browsed.
  useEffect(() => {
    if (open) {
      setViewY(parsed?.y ?? today.y);
      setViewM(parsed?.m ?? today.m);
    }
  }, [open, parsed?.y, parsed?.m, today.y, today.m]);

  // Year list: minYear → today inclusive, descending (most recent
  // first), so 2026 / 2025 / 2024 / … is what the user sees on
  // open. Photos almost always come from the recent past, so this
  // ordering matches the typical use case.
  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = today.y; y >= minYear; y--) out.push(y);
    return out;
  }, [today.y, minYear]);

  // For the currently-viewed month, build the 6×7 grid. Pad to the
  // start with leading nulls (so the 1st lands on the right
  // weekday) and pad to the end with trailing nulls so every grid
  // is exactly 42 cells (= 6 rows). Keeps row count stable across
  // months so the popover doesn't jump in height.
  const grid = useMemo(() => {
    const lead = startWeekday(viewY, viewM);
    const total = daysInMonth(viewY, viewM);
    const cells: (number | null)[] = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= total; d++) cells.push(d);
    while (cells.length < 42) cells.push(null);
    return cells;
  }, [viewY, viewM]);

  const isFuture = (y: number, m: number, d: number) => {
    if (y > today.y) return true;
    if (y < today.y) return false;
    if (m > today.m) return true;
    if (m < today.m) return false;
    return d > today.d;
  };
  const isSelected = (y: number, m: number, d: number) =>
    parsed != null && parsed.y === y && parsed.m === m && parsed.d === d;
  const isToday = (y: number, m: number, d: number) =>
    today.y === y && today.m === m && today.d === d;

  const handleNudgeMonth = (delta: number) => {
    let y = viewY;
    let m = viewM + delta;
    while (m < 0) { m += 12; y -= 1; }
    while (m > 11) { m -= 12; y += 1; }
    if (y < minYear) return;
    if (y > today.y || (y === today.y && m > today.m)) return;
    setViewY(y);
    setViewM(m);
  };

  const triggerLabel = parsed
    ? `${pad2(parsed.d)} ${MONTH_NAMES[parsed.m]} ${parsed.y}`
    : placeholder;

  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={ariaLabel ?? 'Pick a date'}
          className={
            (className ?? 'px-1.5 py-1 rounded-md border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 w-[120px]') +
            ' flex items-center gap-1 ' + (parsed ? 'text-foreground' : 'text-muted-foreground')
          }
        >
          <CalendarIcon className="w-3 h-3 shrink-0 opacity-70" />
          <span className="truncate flex-1 text-left">{triggerLabel}</span>
          {parsed && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear date"
              onClick={(e) => { e.stopPropagation(); onChange(''); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  onChange('');
                }
              }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
            >
              <X className="w-3 h-3" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-3 space-y-2">
        {/* Header — month + year dropdowns + chevrons */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => handleNudgeMonth(-1)}
            className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"
            aria-label="Previous month"
            disabled={viewY === minYear && viewM === 0}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <select
            value={viewM}
            onChange={(e) => {
              const m = parseInt(e.target.value, 10);
              if (viewY === today.y && m > today.m) {
                setViewM(today.m);
              } else {
                setViewM(m);
              }
            }}
            className="flex-1 px-2 py-1 rounded-md border border-border bg-background text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
          >
            {MONTH_NAMES_FULL.map((name, idx) => {
              const future = viewY === today.y && idx > today.m;
              return (
                <option key={idx} value={idx} disabled={future}>{name}</option>
              );
            })}
          </select>
          <select
            value={viewY}
            onChange={(e) => {
              const y = parseInt(e.target.value, 10);
              if (y === today.y && viewM > today.m) {
                setViewM(today.m);
              }
              setViewY(y);
            }}
            className="w-[78px] px-2 py-1 rounded-md border border-border bg-background text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => handleNudgeMonth(1)}
            className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"
            aria-label="Next month"
            disabled={viewY === today.y && viewM === today.m}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Weekday headers */}
        <div className="grid grid-cols-7 gap-0.5">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((wd, i) => (
            <div
              key={i}
              className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground text-center py-1"
            >{wd}</div>
          ))}
        </div>

        {/* Day grid */}
        <div className="grid grid-cols-7 gap-0.5">
          {grid.map((d, i) => {
            if (d == null) {
              return <div key={i} className="aspect-square" />;
            }
            const future = isFuture(viewY, viewM, d);
            const selected = isSelected(viewY, viewM, d);
            const todayCell = isToday(viewY, viewM, d);
            return (
              <button
                key={i}
                type="button"
                disabled={future}
                onClick={() => {
                  onChange(toIso(viewY, viewM, d));
                  setOpen(false);
                }}
                className={
                  'aspect-square flex items-center justify-center text-xs rounded-md transition-colors ' +
                  (selected
                    ? 'bg-primary text-primary-foreground font-semibold'
                    : future
                      ? 'text-muted-foreground/30 cursor-not-allowed'
                      : 'text-foreground hover:bg-primary/10') +
                  (!selected && todayCell ? ' ring-1 ring-primary/60' : '')
                }
                aria-label={`${d} ${MONTH_NAMES_FULL[viewM]} ${viewY}${future ? ' (in the future, unavailable)' : ''}`}
                aria-current={todayCell ? 'date' : undefined}
              >
                {d}
              </button>
            );
          })}
        </div>

        {/* Footer — Today shortcut + Clear */}
        <div className="flex items-center justify-between pt-1 border-t border-border">
          <button
            type="button"
            onClick={() => {
              onChange(toIso(today.y, today.m, today.d));
              setOpen(false);
            }}
            className="text-[11px] font-medium text-primary hover:text-primary/80 px-1.5 py-1 rounded"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground px-1.5 py-1 rounded"
          >
            Clear
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
