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
 */
export function useHideCaptions(): boolean {
  const [hidden, setHidden] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    try {
      const pdr = (window as unknown as { pdr?: { settings?: { get?: () => Promise<any>; onChanged?: (cb: (p: { key: string; value: unknown }) => void) => () => void } } }).pdr;
      pdr?.settings?.get?.().then((s) => {
        if (!cancelled) setHidden(!!s?.hideCaptions);
      }).catch(() => { /* default off */ });
      const unsub = pdr?.settings?.onChanged?.((payload) => {
        if (payload?.key === 'hideCaptions') {
          setHidden(!!payload.value);
        }
      });
      return () => { cancelled = true; if (typeof unsub === 'function') unsub(); };
    } catch {
      return () => { cancelled = true; };
    }
  }, []);
  return hidden;
}
