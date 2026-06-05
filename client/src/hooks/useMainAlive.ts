import { useEffect, useState } from 'react';

/**
 * Heartbeat to the main Electron process. Used by child windows (People,
 * Date Editor) so they can surface a clear banner if the main process is
 * hanging or gone — rather than silently failing IPC calls and leaving the
 * user to wonder whether their input was saved.
 *
 * - Pings every `intervalMs` (default 10s) with a `timeoutMs` cap (default 5s).
 * - Tolerates a single missed ping to avoid flapping on a slow main process.
 * - Returns `true` while main is healthy, `false` once two consecutive pings
 *   have failed. Never returns to `true` after declaring dead — the only
 *   correct recovery is to close and relaunch.
 *
 * v2.0.15 (Terry 2026-06-05) — ping-gate on document.visibilityState.
 *   PM and Date Editor are PRE-WARMED on app start (created hidden,
 *   shown later when the user clicks the icon). The hook used to start
 *   pinging the moment the window was created — i.e. during boot when
 *   main is busy with sidecar-snapshot, worker prewarms, geocoder load,
 *   etc. If two of those pings timed out during the boot-busy window,
 *   `declaredDead` latched and the banner was already on the moment the
 *   user opened PM, with no path to recovery. Now: skip ticks while the
 *   window is hidden, and fire an immediate tick on visibilitychange so
 *   the first real ping happens once the window is genuinely visible.
 */
export function useMainAlive(intervalMs = 10_000, timeoutMs = 5_000): boolean {
  const [alive, setAlive] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let consecutiveFailures = 0;
    let declaredDead = false;

    const tick = async () => {
      if (cancelled || declaredDead) return;
      // v2.0.15 — skip ticks while window is hidden (prewarmed). Prevents
      // false-positive "dead" declarations during the boot-busy window.
      if (typeof document !== 'undefined' && document.hidden) return;
      const pdr = (window as any).pdr;
      if (!pdr?.ping) return; // Not running in Electron — skip silently.
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('ping timeout')), timeoutMs)
        );
        await Promise.race([pdr.ping(), timeout]);
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 2) {
          declaredDead = true;
          if (!cancelled) setAlive(false);
        }
      }
    };

    // Fire one immediately. If we're still hidden (prewarm phase), tick
    // returns early without pinging — visibilitychange handler below will
    // fire the first real ping when the window is shown.
    tick();
    const id = setInterval(tick, intervalMs);

    // v2.0.15 — fire an immediate tick when the window becomes visible
    // (typically: user clicks the icon on a prewarmed window for the
    // first time). Without this, the first real ping could be up to
    // intervalMs late after the user opens the window.
    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        tick();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      cancelled = true;
      clearInterval(id);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [intervalMs, timeoutMs]);

  return alive;
}
