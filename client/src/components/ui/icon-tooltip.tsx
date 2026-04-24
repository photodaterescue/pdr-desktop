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
  return (
    <TooltipProvider delayDuration={delayMs} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
