import { useEffect, useState } from 'react';

/**
 * Per-surface CSS-zoom state. Each caller passes a unique storage key
 * so its zoom level doesn't bleed into other surfaces — Terry hit
 * the bug where People Manager / Workspace / Welcome were all
 * sharing one global key, and zooming one screen permanently
 * changed the next screen the user visited.
 *
 * Range: MIN_ZOOM..MAX_ZOOM in ZOOM_STEP increments. Applied as CSS
 * `zoom: value / 100` on whatever content container the caller picks.
 *
 * Returns zoom value + handlers + Ctrl+wheel handler you can attach
 * to a scroll container. The caller renders whatever UI they want
 * around these primitives.
 *
 * The default key is kept as `pdr-zoom-level` for backward compat
 * with any old localStorage value already on a user's machine, but
 * every NEW caller should pass an explicit per-surface key like
 * `pdr-welcome-zoom`, `pdr-workspace-zoom`, etc.
 */
export const ZOOM_MIN = 60;
export const ZOOM_MAX = 150;
export const ZOOM_STEP = 5;

export function useZoomLevel(storageKey: string = 'pdr-zoom-level') {
  const [zoomLevel, setZoomLevel] = useState<number>(() => {
    if (typeof window === 'undefined') return 100;
    const saved = localStorage.getItem(storageKey);
    const n = saved ? Number(saved) : 100;
    if (!Number.isFinite(n)) return 100;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n));
  });

  const applyZoom = (newZoom: number) => {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
    setZoomLevel(clamped);
    try { localStorage.setItem(storageKey, String(clamped)); } catch {}
  };

  const zoomIn = () => applyZoom(zoomLevel + ZOOM_STEP);
  const zoomOut = () => applyZoom(zoomLevel - ZOOM_STEP);
  const zoomReset = () => applyZoom(100);

  // Ctrl+wheel for keyboard-mouse users. Caller adds the handler to
  // their scroll container via a useEffect like:
  //   useEffect(() => {
  //     const el = ref.current; if (!el) return;
  //     el.addEventListener('wheel', onWheelZoom, { passive: false });
  //     return () => el.removeEventListener('wheel', onWheelZoom);
  //   }, [onWheelZoom]);
  const onWheelZoom = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoomLevel(prev => {
      const next = e.deltaY < 0
        ? Math.min(ZOOM_MAX, prev + ZOOM_STEP)
        : Math.max(ZOOM_MIN, prev - ZOOM_STEP);
      try { localStorage.setItem(storageKey, String(next)); } catch {}
      return next;
    });
  };

  // Attach a window-level Ctrl+wheel listener by default so users can
  // zoom without having to target any specific container. Each
  // surface mounts its own listener while it's active; only the
  // currently-routed page's hook fires for any given Ctrl+wheel.
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoomLevel(prev => {
        const next = e.deltaY < 0
          ? Math.min(ZOOM_MAX, prev + ZOOM_STEP)
          : Math.max(ZOOM_MIN, prev - ZOOM_STEP);
        try { localStorage.setItem(storageKey, String(next)); } catch {}
        return next;
      });
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, [storageKey]);

  return {
    zoomLevel,
    zoomIn,
    zoomOut,
    zoomReset,
    onWheelZoom,
    canZoomIn: zoomLevel < ZOOM_MAX,
    canZoomOut: zoomLevel > ZOOM_MIN,
    MIN: ZOOM_MIN,
    MAX: ZOOM_MAX,
  };
}

/**
 * Standalone zoom-control pill — vertical stack of in / reset / out.
 * Same visual as the Workspace ships; reused for Welcome and source-
 * selection so zoom controls look identical everywhere.
 */
