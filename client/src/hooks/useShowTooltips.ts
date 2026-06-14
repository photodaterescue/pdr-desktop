import { useEffect, useState } from 'react';

/**
 * v2.1 round 167 (Terry 2026-06-14) — live read of the global "Show tooltips"
 * setting. ON by default (helps the learning curve). When the user turns it
 * OFF in Settings → General, every PDR-branded tooltip is suppressed so they
 * can crack on without the tips getting in the way — both the React
 * IconTooltip (this hook) and the Viewer/Collage data-pdr-tooltip manager
 * (gated separately in viewer.html via the same settings:changed broadcast).
 *
 * Same module-singleton mechanics as useHideCaptions: one IPC settings.get()
 * per session, one shared settings:changed listener, fanned out to all hooks.
 */

let cachedValue = true; // tooltips shown by default
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
      // default true: only false when explicitly disabled
      notifyAll(s ? (s as any).showTooltips !== false : true);
      pdr?.settings?.onChanged?.((payload) => {
        if (payload?.key === 'showTooltips') {
          notifyAll(payload.value !== false);
        }
      });
    } catch {
      // bridge missing — keep default true
    }
  })();
}

export function useShowTooltips(): boolean {
  const [show, setShow] = useState<boolean>(cachedValue);
  useEffect(() => {
    ensureInit();
    subscribers.add(setShow);
    if (cachedValue !== show) setShow(cachedValue);
    return () => { subscribers.delete(setShow); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return show;
}
