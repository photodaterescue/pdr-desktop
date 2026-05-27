"use client";

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

/**
 * CaptionTooltip — v2.0.13.
 *
 * Distinct from IconTooltip on purpose. Captions are the user's own
 * notes / memories on a photo (or Google's, ported over from a
 * Takeout sidecar). They aren't system labels and they aren't bound
 * by a small character limit, so they need:
 *
 *   • A different brand colour (PDR gold, --color-gold) so the user
 *     can tell at a glance "this is your content" rather than "this
 *     is a PDR control label". Terry 2026-05-27: "the usual purple
 *     tooltips [aren't] the right look for captions since they are
 *     personal notes and not system information... we should perhaps
 *     switch them up to the other brand colour... the gold".
 *   • Multi-line wrapping with a sensible max width — captions can
 *     run to a paragraph; IconTooltip's single-line text-xs bubble
 *     truncates them awkwardly.
 *   • A slightly longer open delay so the user doesn't get a popping
 *     gold rectangle just from sweeping the mouse across a captioned
 *     thumbnail. 250ms feels intentional.
 *
 * Visual recipe: gold background with the same rounded-md /
 * shadow / animate-in slide-in pattern as IconTooltip, so it feels
 * of-a-piece with the rest of PDR even though the colour shifts.
 *
 * Foreground is intentionally near-black: PDR gold on white reads
 * fine, but the tooltip sits over photos which can be any colour —
 * a dark glyph on the gold ground always reads clearly.
 */
interface CaptionTooltipProps {
  caption: string | null | undefined;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delayMs?: number;
  children: React.ReactElement;
}

export function CaptionTooltip({ caption, side = 'top', delayMs = 250, children }: CaptionTooltipProps) {
  if (!caption || caption.length === 0) return children;
  return (
    <TooltipPrimitive.Provider delayDuration={delayMs} skipDelayDuration={0}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            collisionPadding={12}
            className={cn(
              'z-50 overflow-hidden rounded-md px-3 py-2 text-sm leading-snug shadow-md ring-1 ring-black/10',
              'max-w-xs whitespace-pre-wrap break-words',
              // PDR gold from --color-gold (defined in client/src/index.css).
              // Near-black foreground reads cleanly on the gold ground
              // regardless of the photo it floats over.
              'bg-[var(--color-gold)] text-[#1f1a08]',
              'animate-in fade-in-0 zoom-in-95',
              'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
              'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            )}
          >
            {caption}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
