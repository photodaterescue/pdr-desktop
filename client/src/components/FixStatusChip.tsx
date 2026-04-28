import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { useFixInProgress } from '@/lib/fix-state';
import { getFixProgress, onFixProgress, type FixProgressPayload } from '@/lib/electron-bridge';

/**
 * FixStatusChip — small pulsing pill shown when a Fix is running
 * in ANY window. Single source of truth for the chip across all
 * surfaces — Home, Source Selection, Workspace, People Manager,
 * Date Editor, Viewer. Subscribes to the cross-window
 * 'fix:progressBroadcast' channel so every window sees real
 * numbers instead of just "Fix in progress".
 *
 * Two flavours:
 *   • Passive (default) — pointer-events:none, just a visual cue.
 *     Used in PM / Date Editor / Viewer where we can't restore
 *     the modal directly (it lives in the main window).
 *   • Interactive — pass `interactive={true}`. Renders an "Open"
 *     button that fires a window-level CustomEvent
 *     'pdr:fix:restore'. The FixProgressModal listens for this
 *     event and un-minimises itself. Used in the main window so
 *     the chip is the user's restore handle.
 *
 * Position: top-center under the title bar. Same place across all
 * windows so muscle memory transfers.
 */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function FixStatusChip({ interactive = false }: { interactive?: boolean } = {}) {
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

  const handleOpenClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Tell the main-window FixProgressModal to un-minimise. Listen-
    // ed for in workspace.tsx's FixProgressModal useEffect.
    try { window.dispatchEvent(new CustomEvent('pdr:fix:restore')); } catch { /* non-fatal */ }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        className={`fixed top-1.5 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-full bg-amber-500 text-white shadow-lg ring-2 ring-amber-300/60 select-none animate-pulse-cta ${interactive ? 'cursor-pointer' : 'pointer-events-none'}`}
        data-testid={interactive ? 'fix-progress-chip' : 'fix-progress-chip-passive'}
        title={interactive ? 'Click to view full progress' : 'A Fix is in progress in the main PDR window'}
        onClick={interactive ? handleOpenClick : undefined}
        style={interactive ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        <span className="text-xs font-semibold tabular-nums whitespace-nowrap">
          Fix · {label}
          {detail && ` · ${detail}`}
          {progress && phase !== 'prescan' && phase !== 'mirror' && progress.progressPct > 0 && (
            <span className="opacity-90"> · {progress.progressPct}%</span>
          )}
          {progress && progress.elapsed > 0 && (
            <span className="opacity-90"> · {formatTime(progress.elapsed)}</span>
          )}
        </span>
        {interactive && (
          <button
            type="button"
            onClick={handleOpenClick}
            className="ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/25 hover:bg-white/40 transition-colors"
            aria-label="Restore full progress view"
          >
            Open
          </button>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
