import * as React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

interface IconTooltipProps {
  label: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delayMs?: number;
  children: React.ReactElement;
  disabled?: boolean;
}

/**
 * Premium label for icon-only buttons — drop-in replacement for the
 * browser's native `title=` attribute. Uses the Radix tooltip primitive
 * so the bubble matches the rest of the app (rounded, animated, dark)
 * and appears quickly (120ms default) instead of after the OS-controlled
 * 500ms+ hover delay.
 *
 * Prefer this over `title=` everywhere an icon button needs a label.
 * Keep native `title=` only for pure overflow/truncation previews of
 * long filenames/paths where converting thousands of DOM nodes to
 * Radix tooltips would be a perf regression for no real UX gain.
 */
export function IconTooltip({ label, side = 'top', delayMs = 120, children, disabled }: IconTooltipProps) {
  if (disabled || label == null || label === '') return children;

  // ONLY wrap in a span when the child is a disabled HTML button —
  // those have pointer-events: none (set by the Button variant), which
  // eats the mouseenter/leave that Radix needs. Wrapping unconditionally
  // (which we tried first) injects an extra layout box for every
  // tooltip-wrapped element, which broke grid/aspect-ratio layouts —
  // most visibly the Memories MonthTile grid where each tile collapsed
  // to zero height because the span between the grid and the button
  // didn't carry the `aspect-[4/3]` constraint upward.
  const child = React.Children.only(children) as React.ReactElement<{ disabled?: boolean }>;
  const isDisabledChild = child?.props?.disabled === true;

  return (
    <TooltipProvider delayDuration={delayMs} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          {isDisabledChild ? <span className="inline-flex">{children}</span> : children}
        </TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
