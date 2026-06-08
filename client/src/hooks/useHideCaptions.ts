import { useEffect, useState } from 'react';

/**
 * v2.1 (Terry 2026-06-08) — Live read of the global Hide-captions
 * setting. When true, every PDR surface that displays caption text
 * or the gold caption badge MUST suppress them — Memories tile
 * badges, Memories CaptionTooltip, Albums tile badges, S&D result
 * caption blocks, PDR Viewer caption bar.
 *
 * Privacy lever the user flips when sharing their screen / showing
 * PDR to family. The captions stay in the DB; only the rendering
 * is hidden. Default OFF — captions visible.
 *
 * Auto-updates across the app on settings:changed broadcast, so
 * flipping the toggle in Settings propagates live to every open
 * window without a refresh.
 *
 * ---
 *
 * v2.1 follow-up (Terry 2026-06-08 — Monthly view first-load was
 * taking ~10s after the hook landed) — Module-level singleton so
 * the IPC `settings.get()` fires ONCE per app session, not once
 * per CaptionTooltip / CaptionBadge mount. A Memories month with
 * hundreds of tiles serialised hundreds of preload round-trips
 * on first render; now they all read from the same cached value
 * and subscribe to a single shared listener set.
 *
 * Mechanics:
 *   - `cachedValue` holds the current setting, seeded from React
 *     state default (false) so first render is synchronous.
 *   - `initPromise` is created lazily on first hook mount and
 *     never re-created — only ONE IPC `settings.get()` per session.
 *   - The settings:changed subscription is also module-level
 *     (one listener total) and fans out to every mounted hook
 *     via the subscribers Set.
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
      const next = !!(s && (s as any).hideCaptions);
      notifyAll(next);
      pdr?.settings?.onChanged?.((payload) => {
        if (payload?.key === 'hideCaptions') {
          notifyAll(!!payload.value);
        }
      });
    } catch {
      // bridge missing — keep default false
    }
  })();
}

export function useHideCaptions(): boolean {
  const [hidden, setHidden] = useState<boolean>(cachedValue);
  useEffect(() => {
    ensureInit();
    subscribers.add(setHidden);
    // If init already resolved before this mount, sync to the
    // cached value so we don't miss the initial fetch result.
    if (cachedValue !== hidden) setHidden(cachedValue);
    return () => { subscribers.delete(setHidden); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return hidden;
}
