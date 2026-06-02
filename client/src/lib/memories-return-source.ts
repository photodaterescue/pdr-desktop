/**
 * Cross-cutting state for "user navigated FROM Memories (By Date or
 * Albums) INTO Search & Discovery via Send-to-S&D" (v2.0.15 — Terry
 * 2026-06-02). Mirror of `album-return-source.ts` for the inverse
 * direction.
 *
 * Lives outside React for the same reason that file does — producer
 * (MemoriesView / AlbumsView context menu, deep in the tree) and
 * consumer (TitleBar back-pill, top-level surface) don't share a
 * sensible context boundary.
 *
 * Cleared by workspace.tsx whenever `activeView` leaves both
 * 'search' and 'memories'. Clicking the back pill itself also
 * clears it after dispatching the navigate event.
 */

import { useEffect, useState } from 'react';

export interface MemoriesReturnSource {
  /** Which Memories sub-tab the user came from. Drives whether the
   *  back-pill returns to the By-Date timeline or the Albums tree. */
  tab: 'byDate' | 'albums';
  /** Optional friendly label rendered on the pill — e.g. the album
   *  title for an albums-source, or "Memories" / "By Date" for the
   *  date-source. Pure UX hint; the actual return target is the
   *  `tab` field above. */
  label?: string;
  /** v2.0.15 (Terry 2026-06-02) — for byDate tab, the drilldown
   *  coordinates the user was viewing when they sent to S&D. The
   *  back-pill click restores this so the user lands back on the
   *  same month / day instead of the top of the timeline. */
  drilldown?: { year: number; month?: number; day?: number };
  /** v2.0.15 (Terry 2026-06-02) — for albums tab, the album the
   *  user was viewing when they sent to S&D. Without this the back
   *  pill only switches to the Albums tab and dumps the user at
   *  All Albums; with it, the AlbumsView restores the specific
   *  album via the same localStorage latch the empty-album CTA
   *  uses. */
  albumId?: number;
  /** v2.0.15 (Terry 2026-06-02) — file id of the tile the user
   *  right-clicked when sending to S&D. The back-pill flow uses
   *  this to scroll the target view to that specific tile after
   *  it loads — so the user doesn't have to manually re-find their
   *  place after returning. */
  scrollToFileId?: number;
}

let current: MemoriesReturnSource | null = null;
const listeners = new Set<(next: MemoriesReturnSource | null) => void>();

export function getMemoriesReturnSource(): MemoriesReturnSource | null {
  return current;
}

export function setMemoriesReturnSource(next: MemoriesReturnSource | null): void {
  current = next;
  for (const l of listeners) {
    try { l(next); } catch { /* listener errors must not break siblings */ }
  }
}

export function subscribeMemoriesReturnSource(
  listener: (next: MemoriesReturnSource | null) => void
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useMemoriesReturnSource(): MemoriesReturnSource | null {
  const [value, setValue] = useState<MemoriesReturnSource | null>(current);
  useEffect(() => subscribeMemoriesReturnSource(setValue), []);
  return value;
}
