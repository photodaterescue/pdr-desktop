import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { useFixInProgress } from '@/lib/fix-state';
import { getFixProgress, onFixProgress, type FixProgressPayload } from '@/lib/electron-bridge';

/**
 * FixStatusChip — small pulsing pill shown when a Fix is running
 * in any window. Subscribes to the cross-window
 * 'fix:progressBroadcast' channel so non-main windows (People
 * Manager, Date Editor) see real numbers instead of just "Fix in
 * progress".
 *
 * The main window has its own chip rendered from inside the
 * FixProgressModal — that one carries an Open button to restore
 * the full modal. This component is the *passive* version for
 * windows that can't restore the modal because they don't own
 * the fix state. Click brings the main window to focus so the
 * user can interact with it there.
 *
 * Position: top-center under the title bar. Same place the main
 * window's chip lives, so muscle memory transfers.
 */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function FixStatusChip() {
  const inProgress = useFixInProgress();
  const [progress, setProgress] = useState<FixProgressPayload | null>(null);

  // Pull current progress on mount (cold-start when this window
  // opened mid-fix), then subscribe to live updates.
  useEffect(() => {
    let cancelled = false;
    if (inProgress) {
      getFixProgress().then((p) => { if (!cancelled) setProgress(p); });
    } else {
      setProgress(null);
    }
    const unsubscribe = onFixProgress((p) => { setProgress(p); });
    return () => { cancelled = true; unsubscribe(); };
  }, [inProgress]);

  if (!inProgress) return null;

  const phase = progress?.phase;
  const label = phase === 'prescan'
    ? 'Preparing'
    : phase === 'mirror'
      ? 'Uploading'
      : phase === 'staging'
        ? 'Staging'
        : phase === 'applying'
          ? 'Applying'
          : 'Working';

  const detail = progress
    ? phase === 'prescan'
      ? `${progress.prescanCount.toLocaleString()} checked`
      : phase === 'mirror' && progress.mirrorTotal > 0
        ? `${progress.mirrorDone.toLocaleString()}/${progress.mirrorTotal.toLocaleString()}`
        : `${progress.processed.toLocaleString()}/${progress.total.toLocaleString()}`
    : '';

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        className="fixed top-12 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 pl-3 pr-3 py-1.5 rounded-full bg-amber-500 text-white shadow-lg ring-2 ring-amber-300/60 select-none animate-pulse-cta pointer-events-none"
        data-testid="fix-progress-chip-passive"
        title="A Fix is in progress in the main PDR window"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        <span className="text-xs font-semibold tabular-nums whitespace-nowrap">
          Fix · {label}
          {detail && ` · ${detail}`}
          {progress && phase !== 'prescan' && phase !== 'mirror' && progress.progressPct > 0 && (
            <span className="opacity-80"> · {progress.progressPct}%</span>
          )}
          {progress && progress.elapsed > 0 && (
            <span className="opacity-80"> · {formatTime(progress.elapsed)}</span>
          )}
        </span>
      </motion.div>
    </AnimatePresence>
  );
}
