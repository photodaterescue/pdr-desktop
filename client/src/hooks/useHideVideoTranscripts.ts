import { useEffect, useState } from 'react';

/**
 * v2.1 round 58 (Terry 2026-06-09) — Live read of the global
 * Hide-video-transcripts privacy setting. When true, every PDR
 * surface that surfaces a transcript MUST suppress it — the on-tile
 * "T" indicator across Memories / Albums / S&D, the PDR Viewer's
 * CC button + subtitle overlay, and any future transcript-aware
 * affordance.
 *
 * Note the conceptual split (Terry 2026-06-09):
 *   Caption    = a comment the user has attached to a file (photo or
 *                video). Governed by `hideCaptions` and the gold
 *                CaptionBadge primitive.
 *   Transcript = the speech in a video converted to text by Whisper.
 *                Governed by `hideVideoTranscripts` and the lavender
 *                TranscriptBadge primitive.
 * The two settings are now strictly orthogonal — the descriptions
 * in Settings → Privacy & Security were updated in the same round
 * to remove the legacy "auto-generated caption overlay" wording
 * that conflated the two.
 *
 * Auto-updates across the app on settings:changed broadcast, so
 * flipping the toggle in Settings propagates live to every open
 * window without a refresh.
 *
 * Implementation mirrors useHideCaptions: a module-level singleton
 * fires the underlying `settings.get()` IPC ONCE per app session
 * regardless of how many TranscriptBadge instances mount. A
 * Memories month with hundreds of video tiles would otherwise
 * serialise hundreds of preload round-trips on first render.
 */

let cachedValue = false;
let initPromise: Promise<void> | null = null;
const subscribers = new Set<(v: boolean) => void>();

function notifyAll(v: boolean) {
  cachedValue = v;
  for (const fn of subscribers) {
    try { fn(v); } catch { /* swallow */ }
  }
}

function ensureInit(): void {
  if (initPromise) return;
  initPromise = (async () => {
    try {
      const pdr = (window as unknown as { pdr?: { settings?: { get?: () => Promise<any>; onChanged?: (cb: (p: { key: string; value: unknown }) => void) => () => void } } }).pdr;
      const s = await pdr?.settings?.get?.();
      const next = !!(s && (s as any).hideVideoTranscripts);
      notifyAll(next);
      pdr?.settings?.onChanged?.((payload) => {
        if (payload?.key === 'hideVideoTranscripts') {
          notifyAll(!!payload.value);
        }
      });
    } catch {
      // bridge missing — keep default false
    }
  })();
}

export function useHideVideoTranscripts(): boolean {
  const [hidden, setHidden] = useState<boolean>(cachedValue);
  useEffect(() => {
    ensureInit();
    subscribers.add(setHidden);
    if (cachedValue !== hidden) setHidden(cachedValue);
    return () => { subscribers.delete(setHidden); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return hidden;
}
