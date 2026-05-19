import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Spacious / Tight density toggle — sliding-thumb segmented control.
 *
 * Originally defined inline in MemoriesView (v2.0.x). Extracted to a
 * shared UI primitive in v2.0.8 so the Albums view can reuse the
 * exact same surface for its photo grids — single visual language
 * across both Memories surfaces.
 *
 * Mirrors the By Date / Albums tab switcher's "lavender pill with
 * white sliding thumb" pattern. The thumb's left + width are
 * measured from the active trigger's offset and animated via CSS
 * transitions (cubic-bezier ease-out, 300ms).
 *
 * Native `title=` for hover labels rather than IconTooltip — the
 * Radix Slot+asChild forwarding was occasionally interfering with
 * the offsetLeft / offsetWidth measurements of the trigger buttons
 * in certain layouts. The native tooltip is sufficient for a
 * two-state toggle.
 */
export type Density = 'spacious' | 'tight';

interface DensityToggleProps {
  value: Density;
  onChange: (next: Density) => void;
  /** Optional test-id prefix so callers can target the surface. */
  testId?: string;
}

export function DensityToggle({ value, onChange, testId }: DensityToggleProps) {
  // Single outer button — click anywhere on the pill flips state
  // (Terry 2026-05-19: "they just click it anywhere and it toggles
  // the other way"). Inner spans are pure visual labels; the
  // sliding thumb sits behind whichever one is active.
  const spaciousRef = useRef<HTMLSpanElement>(null);
  const tightRef = useRef<HTMLSpanElement>(null);
  const [thumbStyle, setThumbStyle] = useState<{ left: number; width: number } | null>(null);

  // Measure on every value change AND whenever the span actually
  // gets a real size. ResizeObserver covers the hidden-mount case
  // (Terry 2026-05-19 repro): when MemoriesView mounts inside a
  // hidden Radix TabsContent (display:none), offsetLeft/Width
  // both return 0. A useLayoutEffect-only measure latches that
  // bogus zero into thumbStyle, leaving the "active" span text-
  // primary (lavender) on the lavender pill — invisible — until
  // a remount. Observing the span fires when display flips from
  // none → visible, so the measure self-heals.
  useLayoutEffect(() => {
    const target = value === 'spacious' ? spaciousRef.current : tightRef.current;
    if (!target) return;
    const measure = () => {
      if (!target.isConnected) return;
      const left = target.offsetLeft;
      const width = target.offsetWidth;
      // Skip zero-size measurements — those happen when the
      // parent surface is currently display:none. We'll re-fire
      // when the span gets a real size.
      if (width === 0) return;
      setThumbStyle((prev) => {
        if (prev && prev.left === left && prev.width === width) return prev;
        return { left, width };
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    // Also observe the OTHER span — if the active span shifts when
    // the inactive one's font finishes loading or its content
    // changes, we re-measure too.
    const other = value === 'spacious' ? tightRef.current : spaciousRef.current;
    if (other) ro.observe(other);
    return () => ro.disconnect();
  }, [value]);
  return (
    <button
      type="button"
      onClick={() => onChange(value === 'spacious' ? 'tight' : 'spacious')}
      title={value === 'spacious' ? 'Switch to tight (dense wall view)' : 'Switch to spacious (gap between photos)'}
      className="relative inline-flex items-center h-8 p-0.5 bg-primary rounded-full shrink-0 cursor-pointer"
      data-testid={testId}
    >
      {thumbStyle && (
        <span
          aria-hidden
          className="absolute top-0.5 h-7 bg-background rounded-full shadow-sm pointer-events-none transition-[left,width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
          style={{ left: `${thumbStyle.left}px`, width: `${thumbStyle.width}px` }}
        />
      )}
      <span
        ref={spaciousRef}
        className={`relative z-10 px-3 h-7 inline-flex items-center rounded-full text-[11px] font-medium transition-colors duration-300 ${value === 'spacious' ? 'text-primary' : 'text-primary-foreground'}`}
        data-testid={testId ? `${testId}-spacious` : undefined}
      >
        Spacious
      </span>
      <span
        ref={tightRef}
        className={`relative z-10 px-3 h-7 inline-flex items-center rounded-full text-[11px] font-medium transition-colors duration-300 ${value === 'tight' ? 'text-primary' : 'text-primary-foreground'}`}
        data-testid={testId ? `${testId}-tight` : undefined}
      >
        Tight
      </span>
    </button>
  );
}
