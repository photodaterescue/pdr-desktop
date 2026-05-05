import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/custom-button';
import {
  subscribeUpdateState,
  downloadUpdate,
  installUpdateNow,
  type UpdateState,
} from '@/lib/electron-bridge';

/**
 * Auto-update toast — bottom-right tile that follows the
 * electron-updater state machine in main process. See
 * electron/update-checker.ts for the full lifecycle. Three visible
 * states:
 *
 *   available     "Update available — Get it now / Later"
 *   downloading   progress bar (no buttons)
 *   downloaded    "Update ready — Restart now / Later"
 *
 * idle/checking/not-available/error all render nothing — we only
 * surface UI when there's something the user can act on. A backend
 * error contacting the update server is logged, not toasted, to avoid
 * alarming users when the issue is e.g. transient network failure.
 *
 * "Later" sets a session-scoped dismissal — the toast stays hidden
 * until the next state transition (e.g. download completes), at which
 * point a new actionable state surfaces a fresh toast.
 */
export function UpdateNotification() {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  const [dismissedKind, setDismissedKind] = useState<UpdateState['kind'] | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeUpdateState((next) => {
      setState(next);
      // Clearing the dismissal whenever the state machine advances to
      // a new actionable kind means each milestone gets one toast.
      // (e.g. user dismisses 'available', then download finishes →
      // they see the 'downloaded' toast even though they previously
      // dismissed.)
      setDismissedKind((prev) => (prev === next.kind ? prev : null));
    });
    return unsubscribe;
  }, []);

  const visible =
    (state.kind === 'available' ||
      state.kind === 'downloading' ||
      state.kind === 'downloaded') &&
    dismissedKind !== state.kind;

  const onLater = () => setDismissedKind(state.kind);

  const renderBody = () => {
    if (state.kind === 'available') {
      return (
        <>
          <h3 className="font-semibold text-foreground">Update available</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Version {state.version} is ready to download
            {state.currentVersion && ` (you're on ${state.currentVersion})`}.
          </p>
          {state.releaseNotes && (
            <p className="text-xs text-muted-foreground mt-1 italic line-clamp-3">
              {state.releaseNotes}
            </p>
          )}
          <div className="flex gap-2 mt-3 justify-end">
            <Button size="sm" variant="secondary" onClick={onLater}>
              Later
            </Button>
            <Button size="sm" onClick={() => void downloadUpdate()}>
              <Download className="w-4 h-4 mr-1.5" />
              Get update
            </Button>
          </div>
        </>
      );
    }
    if (state.kind === 'downloading') {
      const pct = Math.max(0, Math.min(100, Math.round(state.percent ?? 0)));
      return (
        <>
          <h3 className="font-semibold text-foreground">Downloading update</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {pct}% — {formatBytes(state.transferred)} of {formatBytes(state.total)}
          </p>
          <div className="mt-3 h-1.5 w-full rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
        </>
      );
    }
    if (state.kind === 'downloaded') {
      return (
        <>
          <h3 className="font-semibold text-foreground">Update ready</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Version {state.version} will install when you restart Photo Date Rescue.
          </p>
          <div className="flex gap-2 mt-3 justify-end">
            <Button size="sm" variant="secondary" onClick={onLater}>
              Later
            </Button>
            <Button size="sm" onClick={() => void installUpdateNow()}>
              <RefreshCw className="w-4 h-4 mr-1.5" />
              Restart now
            </Button>
          </div>
        </>
      );
    }
    return null;
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 30 }}
          className="fixed bottom-4 right-4 z-50 max-w-sm"
        >
          <div className="bg-background rounded-xl shadow-2xl border border-border p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-full bg-primary/10 shrink-0">
                <Download className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                {renderBody()}
              </div>
              {state.kind !== 'downloading' && (
                <button
                  onClick={onLater}
                  aria-label="Dismiss"
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
