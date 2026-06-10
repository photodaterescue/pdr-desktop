import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Clock as ClockIcon, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Branded time picker — replaces the native <input type="time"> in
 * places where the OS-rendered scroll wheel was wrong on two counts:
 *
 *   1. Windows' native picker WRAPS — scrolling minute 59 jumps to
 *      00, scrolling hour 23 jumps to 00. Terry asked for clamped
 *      boundaries (00:00 → 23:59, no wrap).
 *   2. The 24-hour clock is the only option. Not everyone reads 24h
 *      fluently, so a 12h / 24h toggle sits at the top of the popover
 *      with the user's preference persisted to localStorage.
 *
 * Built on the same Popover + lucide + palette-token foundation as
 * BrandedDatePicker — no freehand visuals. Value stays canonical
 * "HH:MM" (24h, zero-padded) so the upstream consumer doesn't change.
 *
 * Props:
 *   value     — "HH:MM" 24h string ('' for no selection)
 *   onChange  — called with the new "HH:MM" string
 *   placeholder — text shown in the trigger when value is empty
 *   ariaLabel — for screen readers
 *   className — extra classes for the trigger button
 */
export interface BrandedTimePickerProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}

const STORAGE_KEY = 'pdr-time-picker-mode'; // '12' | '24'

function pad2(n: number): string { return n.toString().padStart(2, '0'); }

function parseTime(value: string): { h: number; m: number } | null {
  if (!value) return null;
  const m = value.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

function format12(h24: number, m: number): { label: string; period: 'AM' | 'PM' } {
  const period: 'AM' | 'PM' = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { label: `${h12}:${pad2(m)} ${period}`, period };
}

const HOURS_24 = Array.from({ length: 24 }, (_, i) => i); // 0..23
const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const MINUTES = Array.from({ length: 60 }, (_, i) => i); // 0..59

// Vertical list with a centred highlighted "selected" row. Item height
// stays fixed at 32 px so scroll-into-view maths can be done without
// measuring the DOM. Five rows visible (= 160 px viewport) lets the
// user see two values above + two below the current pick, which is
// the same density as Apple's wheel pickers.
const ITEM_H = 32;
const VISIBLE = 5;

interface WheelColumnProps {
  values: number[];
  selected: number;
  onSelect: (v: number) => void;
  format: (v: number) => string;
  testId?: string;
  ariaLabel: string;
}

function WheelColumn({ values, selected, onSelect, format, testId, ariaLabel }: WheelColumnProps) {
  const ref = useRef<HTMLDivElement>(null);

  // On every selection change, scroll the selected row to centre.
  // overflow-y-auto naturally clamps at top + bottom (no wrap), which
  // is exactly the behaviour Terry asked for vs Windows' native picker.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const idx = values.indexOf(selected);
    if (idx < 0) return;
    const target = idx * ITEM_H - ((VISIBLE - 1) / 2) * ITEM_H;
    el.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }, [selected, values]);

  return (
    <div className="relative w-12 shrink-0">
      {/* Centred highlight band — purely visual; the row underneath
          is what's actually selected. Lavender 10% to match the
          BrandedDatePicker hover tint. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-0 right-0 rounded-md bg-primary/10 ring-1 ring-primary/30"
        style={{ top: ((VISIBLE - 1) / 2) * ITEM_H, height: ITEM_H }}
      />
      <div
        ref={ref}
        role="listbox"
        aria-label={ariaLabel}
        data-testid={testId}
        className="overflow-y-auto scrollbar-thin scroll-smooth"
        style={{
          height: VISIBLE * ITEM_H,
          scrollSnapType: 'y mandatory',
          paddingTop: ((VISIBLE - 1) / 2) * ITEM_H,
          paddingBottom: ((VISIBLE - 1) / 2) * ITEM_H,
        }}
      >
        {values.map((v) => {
          const isSel = v === selected;
          return (
            <button
              key={v}
              type="button"
              role="option"
              aria-selected={isSel}
              onClick={() => onSelect(v)}
              className={
                'w-full flex items-center justify-center text-sm tabular-nums transition-colors ' +
                (isSel
                  ? 'text-primary font-semibold'
                  : 'text-muted-foreground hover:text-foreground')
              }
              style={{ height: ITEM_H, scrollSnapAlign: 'center' }}
            >
              {format(v)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function BrandedTimePicker({
  value,
  onChange,
  placeholder = '--:--',
  ariaLabel,
  className,
}: BrandedTimePickerProps) {
  const parsed = useMemo(() => parseTime(value), [value]);
  const [open, setOpen] = useState(false);

  // 12h vs 24h preference. Persisted across sessions so the user's
  // last choice sticks; defaults to 24h (the format already in the
  // stored value).
  const [mode, setMode] = useState<'12' | '24'>(() => {
    if (typeof localStorage === 'undefined') return '24';
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === '12' || saved === '24' ? saved : '24';
  });
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* localStorage may be blocked — non-fatal */ }
  }, [mode]);

  // Working draft — local state so the user can scroll columns
  // without firing onChange on every tick. Committed onChange only
  // when the user clicks a row (or via popover close — see below).
  // Initialised from parsed value on every open so re-opening with
  // a different value lands on the right row.
  const initialH = parsed?.h ?? 12;
  const initialM = parsed?.m ?? 0;
  const [draftH, setDraftH] = useState<number>(initialH);
  const [draftM, setDraftM] = useState<number>(initialM);
  useEffect(() => {
    if (open) {
      setDraftH(parsed?.h ?? 12);
      setDraftM(parsed?.m ?? 0);
    }
  }, [open, parsed?.h, parsed?.m]);

  // Commit helper — converts draft into "HH:MM" 24h and fires
  // onChange. Called from every row click so the consumer sees the
  // update immediately.
  const commit = (h24: number, m: number) => {
    onChange(`${pad2(h24)}:${pad2(m)}`);
  };

  // ---- 12h ↔ 24h interop --------------------------------------------------
  // In 12h mode the hour column shows 1..12 and a third AM/PM column
  // appears. Internally draftH stays 0..23, so toggling the period
  // just adds / subtracts 12.
  const period: 'AM' | 'PM' = draftH < 12 ? 'AM' : 'PM';
  const hour12 = draftH % 12 === 0 ? 12 : draftH % 12;

  const setHour12 = (h12: number) => {
    const h24 = period === 'AM'
      ? (h12 === 12 ? 0 : h12)
      : (h12 === 12 ? 12 : h12 + 12);
    setDraftH(h24);
    commit(h24, draftM);
  };
  const setHour24 = (h24: number) => {
    setDraftH(h24);
    commit(h24, draftM);
  };
  const setMin = (m: number) => {
    setDraftM(m);
    commit(draftH, m);
  };
  const setPeriod = (p: 'AM' | 'PM') => {
    const next = p === 'AM'
      ? (draftH >= 12 ? draftH - 12 : draftH)
      : (draftH < 12 ? draftH + 12 : draftH);
    setDraftH(next);
    commit(next, draftM);
  };

  const triggerLabel = parsed
    ? (mode === '12' ? format12(parsed.h, parsed.m).label : `${pad2(parsed.h)}:${pad2(parsed.m)}`)
    : placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel ?? 'Pick a time'}
          className={
            (className ?? 'w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/40') +
            ' flex items-center gap-1.5 ' +
            (parsed ? 'text-foreground' : 'text-muted-foreground')
          }
          data-testid="branded-time-picker-trigger"
        >
          <ClockIcon className="w-3.5 h-3.5 shrink-0 opacity-70" />
          <span className="truncate flex-1 text-left tabular-nums">{triggerLabel}</span>
          {parsed && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear time"
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
      <PopoverContent align="start" className="w-auto p-3 space-y-2">
        {/* Mode toggle — 12h / 24h. Mirrors the Spacious/Tight
            segmented toggle used elsewhere in PDR (DensityToggle).
            Subtle, not the primary focus. */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            Time
          </span>
          <div
            role="radiogroup"
            aria-label="Clock format"
            className="inline-flex rounded-full bg-secondary/60 p-0.5 text-[10px] font-semibold"
          >
            {(['12', '24'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                role="radio"
                aria-checked={mode === opt}
                onClick={() => setMode(opt)}
                className={
                  'px-2 py-0.5 rounded-full transition-colors ' +
                  (mode === opt
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground')
                }
                data-testid={`branded-time-picker-mode-${opt}`}
              >
                {opt}h
              </button>
            ))}
          </div>
        </div>

        {/* Column headers — H / M (and AM/PM when in 12h mode).
            Same uppercase-tracking-wider typography as the date
            picker's weekday row so the two surfaces feel related. */}
        <div className="flex items-end gap-2">
          <div className="w-12 text-center text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            H
          </div>
          <div className="w-12 text-center text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            M
          </div>
          {mode === '12' && (
            <div className="w-12 text-center text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
              {/* No header text for AM/PM — the column values are
                  self-describing. Empty placeholder keeps the column
                  vertically aligned with H + M. */}
              &nbsp;
            </div>
          )}
        </div>

        <div className="flex items-start gap-2">
          {mode === '24' ? (
            <WheelColumn
              ariaLabel="Hour"
              testId="branded-time-picker-hour-24"
              values={HOURS_24}
              selected={draftH}
              onSelect={setHour24}
              format={(v) => pad2(v)}
            />
          ) : (
            <WheelColumn
              ariaLabel="Hour"
              testId="branded-time-picker-hour-12"
              values={HOURS_12}
              selected={hour12}
              onSelect={setHour12}
              format={(v) => v.toString()}
            />
          )}
          <WheelColumn
            ariaLabel="Minute"
            testId="branded-time-picker-minute"
            values={MINUTES}
            selected={draftM}
            onSelect={setMin}
            format={(v) => pad2(v)}
          />
          {mode === '12' && (
            <div className="relative w-12 shrink-0">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-0 right-0 rounded-md bg-primary/10 ring-1 ring-primary/30"
                style={{ top: ((VISIBLE - 1) / 2) * ITEM_H, height: ITEM_H }}
              />
              <div
                role="listbox"
                aria-label="AM or PM"
                className="overflow-y-auto"
                style={{
                  height: VISIBLE * ITEM_H,
                  paddingTop: ((VISIBLE - 1) / 2) * ITEM_H,
                  paddingBottom: ((VISIBLE - 1) / 2) * ITEM_H,
                }}
              >
                {(['AM', 'PM'] as const).map((p) => {
                  const isSel = p === period;
                  return (
                    <button
                      key={p}
                      type="button"
                      role="option"
                      aria-selected={isSel}
                      onClick={() => setPeriod(p)}
                      className={
                        'w-full flex items-center justify-center text-sm transition-colors ' +
                        (isSel
                          ? 'text-primary font-semibold'
                          : 'text-muted-foreground hover:text-foreground')
                      }
                      style={{ height: ITEM_H }}
                      data-testid={`branded-time-picker-period-${p}`}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer — Now shortcut + Clear, same vocabulary as the
            date picker's Today + Clear pair. */}
        <div className="flex items-center justify-between pt-1 border-t border-border">
          <button
            type="button"
            onClick={() => {
              const now = new Date();
              const h = now.getHours();
              const m = now.getMinutes();
              setDraftH(h);
              setDraftM(m);
              commit(h, m);
              setOpen(false);
            }}
            className="text-[11px] font-medium text-primary hover:text-primary/80 px-1.5 py-1 rounded"
          >
            Now
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
