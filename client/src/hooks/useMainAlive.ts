import { useEffect, useState } from 'react';

/**
 * Heartbeat to the main Electron process. Used by child windows (People,
 * Date Editor) so they can surface a clear banner if the main process is
 * hanging or gone — rather than silently failing IPC calls and leaving the
 * user to wonder whether their input was saved.
 *
 * - Pings every `intervalMs` (default 10s) with a `timeoutMs` cap (default 5s).
 * - Returns `true` while main is healthy, `false` once 5 consecutive pings
 *   have failed (~50s+ of no response). Banner CLEARS on the next successful
 *   ping — main coming back resets the state (v2.0.15 change; was previously
 *   a permanent latch). Three separate v2.0.15 changes in this hook:
 *
 * v2.0.15 (Terry 2026-06-05) — ping-gate on document.visibilityState.
 *   PM and Date Editor are PRE-WARMED on app start (created hidden,
 *   shown later when the user clicks the icon). The hook used to start
 *   pinging the moment the window was created — i.e. during boot when
 *   main is busy with sidecar-snapshot, worker prewarms, geocoder load,
 *   etc. If pings timed out during the boot-busy window, the banner was
 *   already on the moment the user opened PM. Now: skip ticks while the
 *   window is hidden, and fire an immediate tick on visibilitychange so
 *   the first real ping happens once the window is genuinely visible.
 *
 * v2.0.15 (Terry 2026-06-05) — recoverable + threshold bumped to 3.
 *   Verifying ~30 face-thumbnails in PM made main genuinely busy for
 *   ~15s (DB writes + AI worker queueing), enough for the previous
 *   2-failure latch to fire and stay on permanently after main recovered.
 *   Banner now clears as soon as the next ping succeeds; threshold bumped
 *   to 3 so transient mid-task busy windows are even less likely to fire
 *   it in the first place.
 */
export function useMainAlive(intervalMs = 10_000, timeoutMs = 5_000): boolean {
  const [alive, setAlive] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let consecutiveFailures = 0;
    // v2.0.15 (Terry 2026-06-05) — was a permanent latch (declaredDead =
    // true after 2 consecutive failures, never cleared). Replaced with
    // recoverable state: a successful ping resets the failure count AND
    // clears the banner. The reason: PM ran 30 face-verifications and
    // main got busy for ~15s doing the DB writes + AI queueing — two
    // pings timed out, banner latched, never went away even after main
    // recovered. With recovery, transient busy-windows don't permanently
    // disable PM. Threshold also bumped from 2 → 3 consecutive failures
    // (so a 30s+ outage is still required, just no longer permanent).
    let bannerOn = false;

    const tick = async () => {
      if (cancelled) return;
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
        // v2.0.15 — recover the banner if it was on. Main came back.
        if (bannerOn && !cancelled) {
          bannerOn = false;
          setAlive(true);
        }
      } catch {
        consecutiveFailures += 1;
        // v2.0.15 (Terry 2026-06-05) — threshold bumped 3 → 5. The
        // "Improve Facial Recognition" workflow in PM legitimately
        // pegs main for 30s+ while it re-embeds 2 800+ thumbnails;
        // 3 consecutive failures at 10s interval + 5s timeout = ~30s,
        // which was still firing the banner mid-operation. 5 raises
        // the bar to ~50s of no response — still well within "main
        // is dead" territory, but past the longest legitimate busy
        // window. Real fix is to move that work off main; this is
        // the bandaid until that lands.
        if (consecutiveFailures >= 5 && !bannerOn && !cancelled) {
          bannerOn = true;
          setAlive(false);
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
