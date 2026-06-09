/* v2.1 round 57 (Terry 2026-06-09) — shared cache of file_ids that
 * have transcripts, used by tile renderers in Memories / Albums /
 * S&D to overlay a small "T" badge on already-transcribed videos.
 *
 * Why a hook + a global event instead of a per-tile lookup: the
 * batch transcribe pipeline can flip dozens of files in one go;
 * each rendered tile probing the DB individually would be both
 * expensive and racy. Instead, one IPC round-trip on mount builds
 * a Set<number>, every tile does an O(1) `has()` check, and the
 * `pdr:transcribeCompleted` event (dispatched by
 * useTranscribeVideos after each successful transcription) tells
 * the cache to refetch so newly-transcribed videos light up
 * without a page reload.
 *
 * Returns a tuple [set, refresh]. The refresh fn is rarely needed
 * directly — the event listener handles routine updates — but it's
 * exposed for cases where a caller knows the set is stale (e.g.
 * after deleting a transcript). */

import { useCallback, useEffect, useState } from 'react';

export function useTranscribedFileIds(): [Set<number>, () => Promise<void>] {
  const [ids, setIds] = useState<Set<number>>(() => new Set());

  const refresh = useCallback(async () => {
    try {
      // v2.1 round 59 (Terry 2026-06-09 — T badge regression fix).
      // The bridge entry lives at pdr.viewer.listTranscribedFileIds
      // (round-57 added it inside the `viewer: { … }` namespace at
      // preload.ts:582). The earlier call to pdr.listTranscribedFileIds
      // resolved to undefined, the catch swallowed it, and every tile
      // saw an empty Set — so no badges rendered even on Terry's 15
      // already-transcribed videos. Re-checked against preload.ts.
      const res = await (window as any).pdr?.viewer?.listTranscribedFileIds?.();
      if (res?.success && Array.isArray(res.ids)) {
        setIds(new Set<number>(res.ids));
      }
    } catch {
      /* non-fatal — badge just won't appear; right-click still works */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handler = () => { void refresh(); };
    window.addEventListener('pdr:transcribeCompleted', handler);
    return () => window.removeEventListener('pdr:transcribeCompleted', handler);
  }, [refresh]);

  return [ids, refresh];
}
