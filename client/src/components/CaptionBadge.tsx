// CaptionBadge — v2.0.13.
//
// Tiny indicator rendered in the bottom-right corner of a photo
// thumbnail when the photo has a caption (either user-typed in PDR
// or imported from a Google Takeout sidecar.description). Hover the
// thumbnail to see the caption text in the native title tooltip;
// this badge just makes captioned photos discoverable at a glance.
//
// Reused by MemoriesView's drilldown grid, AlbumsView's album-photo
// grid, and SearchPanel's FileCard so the affordance feels uniform
// across every photo surface in the app.
//
// Positioned absolutely; pointer-events:none so it never intercepts
// the photo's click/right-click handlers. Same `bg-background/85
// backdrop-blur-sm border border-border` recipe as the LDM /
// floating-pill surfaces so it sits cleanly over any image.

import { MessageSquareText } from 'lucide-react';

interface CaptionBadgeProps {
  /** Truthy → render badge. Empty / null / undefined → render nothing. */
  caption: string | null | undefined;
  /** Optional positioning override. Default bottom-right corner. */
  position?: 'bottom-right' | 'top-right' | 'bottom-left' | 'top-left';
}

export function CaptionBadge({ caption, position = 'bottom-right' }: CaptionBadgeProps) {
  if (!caption || caption.length === 0) return null;
  const pos = {
    'bottom-right': 'bottom-1.5 right-1.5',
    'top-right': 'top-1.5 right-1.5',
    'bottom-left': 'bottom-1.5 left-1.5',
    'top-left': 'top-1.5 left-1.5',
  }[position];
  // v2.0.13 — hovering the badge surfaces the caption text in a
  // PDR-gold tooltip (CaptionTooltip), so users can SEE their notes
  // without opening the viewer. The badge has its own pointer-events
  // so the hover registers; the rest of the photo's click area (the
  // ~95% NOT covered by this 20px badge) still routes to the
  // underlying photo button / ContextMenuTrigger normally.
  // v2.0.13 (Terry 2026-05-27) — gold badge to match the caption
  // tooltip's brand colour. Reads visually as "this is your content"
  // rather than a neutral system glyph. Dark icon on gold ground
  // reads cleanly on any photo backdrop. The badge stays as a
  // discovery cue; the actual hover-to-read affordance has moved
  // up to the whole tile (each photo grid wraps its cell with
  // CaptionTooltip directly), so users no longer have to find the
  // 20px badge target to reveal the caption.
  return (
    <div
      className={`pointer-events-none absolute ${pos} w-5 h-5 rounded-full bg-[var(--color-gold)] ring-1 ring-black/15 shadow-sm flex items-center justify-center`}
      aria-hidden="true"
      data-testid="caption-badge"
    >
      <MessageSquareText className="w-3 h-3" style={{ color: '#1f1a08' }} />
    </div>
  );
}
