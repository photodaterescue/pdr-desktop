import React, { useEffect, useMemo, useRef } from 'react';
import { Clock as ClockIcon, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Branded time picker — replaces the native <input type="time"> in
 * places where the OS-rendered scroll wheel wrapped past 23/59 back
 * to 00. Two columns only: H and M. Format toggle (12 / 24) and the
 * AM/PM picker live OUTSIDE this component, in the consumer's panel
 * chrome — Terry asked for them not to be jammed inside the scroll
 * popover.
 *
 * Built on the same Popover + lucide + palette-token foundation as
 * BrandedDatePicker — no freehand visuals. Value contract is
 * canonical "HH:MM" 24-hour so the upstream save path doesn't change.
 *
 * Props:
 *   value     — "HH:MM" 24h string ('' for no selection)
 *   onChange  — called with the new "HH:MM" string
 *   mode      — '12' | '24' (controlled by the consumer; affects the
 *               hour column values 1..12 vs 0..23 and the trigger
 *               label format)
 *   placeholder — text shown in the trigger when value is empty
 *   ariaLabel — for screen readers
 *   className — extra classes for the trigger button
 */
export interface BrandedTimePickerProps {
  value: string;
  onChange: (next: string) => void;
  mode: '12' | '24';
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}

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

const HOURS_24 = Array.from({ length: 24 }, (_, i) => i); // 0..23
const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const MINUTES = Array.from({ length: 60 }, (_, i) => i); // 0..59

// Vertical list with a centred highlighted "selected" row. Item height
// stays fixed at 32 px so the scroll-to-centre maths can be done
// without measuring the DOM. 5 visible rows = 160 px viewport — same
// density as Apple's wheel pickers.
//
// Round 85 fixes vs round 84:
//   * scroll-snap-mandatory DROPPED — it caused the "locked, move
//     the mouse more before it scrolls again" friction Terry hit.
//     The list now scrolls freely; clicking a row commits + smoothly
//     scrolls that row to centre. Programmatic snap on scroll-end
//     would be the next step if free scroll feels too loose, but
//     click-to-pick is the primary interaction anyway.
//   * Padding-derived whitespace at the extremes is now masked with
//     a top + bottom linear-gradient fade so the "2 white rows
//     above 0" / "2 white rows below 59" Terry called out looks
//     intentional (Apple-style fade) instead of a layout bug.
const ITEM_H = 32;
const VISIBLE = 5;
const FADE_MASK = 'linear-gradient(to bottom, transparent 0%, black 25%, black 75%, transparent 100%)';

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
  // overflow-y-auto naturally clamps at top + bottom (no wrap),
  // which is exactly the behaviour Terry asked for vs Windows'
  // native picker.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const idx = values.indexOf(selected);
    if (idx < 0) return;
    const target = idx * ITEM_H;
    el.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }, [selected, values]);

  return (
    <div className="relative w-14 shrink-0">
      {/* Centred highlight band — purely visual; the row clicked is
          what commits. Lavender 10% tint + ring to match
          BrandedDatePicker's selected-day style. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-0 right-0 rounded-md bg-primary/10 ring-1 ring-primary/30 z-10"
        style={{ top: ((VISIBLE - 1) / 2) * ITEM_H, height: ITEM_H }}
      />
      <div
        ref={ref}
        role="listbox"
        aria-label={ariaLabel}
        data-testid={testId}
        className="overflow-y-auto scroll-smooth pdr-wheel-scroll"
        style={{
          height: VISIBLE * ITEM_H,
          paddingTop: ((VISIBLE - 1) / 2) * ITEM_H,
          paddingBottom: ((VISIBLE - 1) / 2) * ITEM_H,
          maskImage: FADE_MASK,
          WebkitMaskImage: FADE_MASK,
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
              style={{ height: ITEM_H }}
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
  mode,
  placeholder = '12:00',
  ariaLabel,
  className,
}: BrandedTimePickerProps) {
  const parsed = useMemo(() => parseTime(value), [value]);

  // Period is derived from value's hour — when the consumer's
  // AM/PM toggle flips, it'll have already adjusted value by ±12,
  // so we just read it here without round-tripping through props.
  const period: 'AM' | 'PM' = (parsed?.h ?? 12) < 12 ? 'AM' : 'PM';
  const hour12 = parsed
    ? (parsed.h % 12 === 0 ? 12 : parsed.h % 12)
    : 12; // default to 12 (== noon when period=PM)
  const hour24 = parsed?.h ?? 12;
  const minute = parsed?.m ?? 0;

  const commit = (h24: number, m: number) => {
    onChange(`${pad2(h24)}:${pad2(m)}`);
  };

  const setHour12 = (h12: number) => {
    const h24 = period === 'AM'
      ? (h12 === 12 ? 0 : h12)
      : (h12 === 12 ? 12 : h12 + 12);
    commit(h24, minute);
  };
  const setHour24 = (h24: number) => {
    commit(h24, minute);
  };
  const setMin = (m: number) => {
    commit(hour24, m);
  };

  const triggerLabel = parsed
    ? (mode === '12' ? `${pad2(hour12)}:${pad2(minute)}` : `${pad2(hour24)}:${pad2(minute)}`)
    : placeholder;

  return (
    <Popover>
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
        {/* Column headers — H / M only. 12/24 toggle + AM/PM live
            outside the popover (in the consumer's panel) per Terry's
            round-84 feedback. */}
        <div className="flex items-end gap-2">
          <div className="w-14 text-center text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            H
          </div>
          <div className="w-14 text-center text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            M
          </div>
        </div>

        <div className="flex items-start gap-2">
          {mode === '24' ? (
            <WheelColumn
              ariaLabel="Hour"
              testId="branded-time-picker-hour-24"
              values={HOURS_24}
              selected={hour24}
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
              format={(v) => pad2(v)}
            />
          )}
          <WheelColumn
            ariaLabel="Minute"
            testId="branded-time-picker-minute"
            values={MINUTES}
            selected={minute}
            onSelect={setMin}
            format={(v) => pad2(v)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
