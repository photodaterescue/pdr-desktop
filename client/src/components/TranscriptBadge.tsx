// TranscriptBadge — v2.1 round 58 (Terry 2026-06-09).
//
// Tiny "T" indicator rendered in the bottom-right corner of a video
// thumbnail when PDR has a Whisper transcript on disk for that file.
// Sibling to CaptionBadge: same 20×20 circle + ring + shadow recipe
// so the two read as a single status-cluster family, but uses the
// lavender brand colour (bg-primary) instead of gold to keep
// "speech-to-text" visually distinct from "user-added caption".
//
// Positioning is caption-aware. If a caption ALSO exists on the
// file, this badge shifts left by one badge-width-plus-gap so it
// sits IMMEDIATELY to the LEFT of the gold caption badge — Terry's
// explicit ask 2026-06-09 ("a 'T' to the left of the caption icon
// if both exist"). When there's no caption, the badge takes the
// bottom-right corner itself.
//
// Privacy: the user can hide this everywhere via Settings →
// Privacy & Security → "Hide transcripts" — the existence-indicator
// is suppressed entirely, not just dimmed, so a guest viewing the
// user's screen can't tell which videos have transcripts. The
// transcripts + .vtt sidecars stay on disk; flipping the switch
// back restores the badges across every surface.

import { useHideVideoTranscripts } from '@/hooks/useHideVideoTranscripts';

interface TranscriptBadgeProps {
  /** Truthy → render badge. False / undefined → render nothing. */
  hasTranscript: boolean | null | undefined;
  /** True when the same file also has a caption (gold CaptionBadge).
   *  Shifts this badge left by one badge-width + gap so the two
   *  sit shoulder-to-shoulder: [T][caption] at bottom-right.
   *  Default false (badge takes the bottom-right corner alone). */
  hasCaption?: boolean;
}

export function TranscriptBadge({ hasTranscript, hasCaption = false }: TranscriptBadgeProps) {
  const hidden = useHideVideoTranscripts();
  if (hidden || !hasTranscript) return null;
  // CaptionBadge uses `bottom-1.5 right-1.5` (6px) with w-5 (20px).
  // To sit immediately to its left with a 4px gap, this badge needs
  // right-[30px] = 6 + 20 + 4. When no caption, claim the corner.
  const rightClass = hasCaption ? 'right-[30px]' : 'right-1.5';
  return (
    <div
      className={`pointer-events-none absolute bottom-1.5 ${rightClass} w-5 h-5 rounded-full bg-primary ring-1 ring-black/15 shadow-sm flex items-center justify-center`}
      aria-hidden="true"
      data-testid="transcript-badge"
    >
      <span className="text-[10px] font-bold leading-none text-primary-foreground">T</span>
    </div>
  );
}
