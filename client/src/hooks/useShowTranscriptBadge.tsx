/* v2.1 round 57 (Terry 2026-06-09) — read-only consumer of the
 * "show transcript (T) badge on videos" setting. The writer lives
 * in MemoriesView's Insights popover (single owner); SearchPanel
 * and AlbumsView read via this hook so a toggle in Memories
 * updates their tiles immediately without a page reload.
 *
 * Storage key: pdr-show-transcript-badge ("1" = on, "0" = off,
 * missing = on by default — same default the writer uses).
 *
 * Sync mechanism: a `pdr:showTranscriptBadgeChanged` CustomEvent
 * is dispatched by the writer on every toggle. Each listening
 * view updates its local state from the event detail so renders
 * stay consistent across the workspace. Falls back to a fresh
 * localStorage read if the event arrives without a detail (e.g.
 * cross-tab via storage event — not currently wired but cheap
 * to support). */

import { useEffect, useState } from 'react';

function readInitial(): boolean {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('pdr-show-transcript-badge') : null;
    return saved === null ? true : saved === '1';
  } catch {
    return true;
  }
}

export function useShowTranscriptBadge(): boolean {
  const [value, setValue] = useState<boolean>(() => readInitial());
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (detail && typeof detail.value === 'boolean') {
        setValue(detail.value);
      } else {
        setValue(readInitial());
      }
    };
    window.addEventListener('pdr:showTranscriptBadgeChanged', handler);
    return () => window.removeEventListener('pdr:showTranscriptBadgeChanged', handler);
  }, []);
  return value;
}
