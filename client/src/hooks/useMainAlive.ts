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
 */
export function useMainAlive(intervalMs = 10_000, timeoutMs = 5_000): boolean {
  const [alive, setAlive] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let consecutiveFailures = 0;
    let declaredDead = false;

    const tick = async () => {
      if (cancelled || declaredDead) return;
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

    // Fire one immediately so the banner appears quickly if main is already gone.
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs, timeoutMs]);

  return alive;
}
