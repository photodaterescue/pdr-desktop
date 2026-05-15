import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, AlertTriangle, Loader2, Plug, RotateCcw, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

// LibraryDriveOfflineModal — calmly surfaces the case where PDR's
// configured Library Drive isn't currently reachable on disk (drive
// unplugged, NAS offline, USB asleep). Replaces the cryptic raw
// ENOENT error Jane Clapson received for several days ("no such file
// or directory, mkdir ...takeout-...") with a clear path forward.
//
// Two entry points trigger this modal:
//   1. Workspace-load check: useEffect calls
//      window.pdr.library.checkDestinationOnline() — if online === false,
//      we open this modal before the user can attempt anything.
//   2. Reactive: any IPC that returns code === 'DESTINATION_OFFLINE'
//      (currently analysis:run, more to come) routes here.
//
// User actions:
//   - Retry: re-check the drive. If it's now online, close. If still
//     missing, keep the modal open.
//   - Change Library Drive: open the Library Drive Management panel
//     (LibraryPanel). The previous version of this modal had THREE
//     mechanically-identical entries — "Change Library Drive", an
//     Advanced "Set up a new library here instead" link, AND the offline
//     modal itself — all of which ultimately just changed destinationPath
//     to a different folder. Terry called the duplication out, so we now
//     route every "I want to manage / swap / set up" intent into the
//     single Library Drive Management surface that the Library pill in
//     the title bar also opens. One surface, one source of truth.
//   - Close (X / Esc / backdrop): dismiss, but the underlying issue
//     remains — the user will hit it again the moment they try to do
//     anything that needs the drive.

// Context = what the user JUST tried to do that needed the Library
// Drive. Drives the headline + the "needs this drive for" line so the
// modal explains why the wall just appeared, rather than generic
// "your drive is offline" copy. The "still works without it" list
// is the same across contexts — it's there to remind the user the
// app isn't broken, just temporarily restricted.
type OfflineContext = 'run-fix' | 'open-file' | 'sync-now' | 'generic';

interface LibraryDriveOfflineModalProps {
  isOpen: boolean;
  destinationPath: string | null;
  /** What operation triggered this modal. Drives the contextual
   *  "needs for this action" copy. 'generic' = the catch-all banner
   *  click; otherwise an action-specific framing applies. */
  context?: OfflineContext;
  onClose: () => void;
  /** Open Library Drive Management (LibraryPanel) — covers swap-to-
   *  different-existing, set-up-new, take-over-writer, disconnect, all
   *  inside one cohesive surface. Replaces what used to be two inline
   *  CTAs ("Change Library Drive" + Advanced "Set up new library"). */
  onOpenLibraryPanel: () => void;
  /** Soft, acknowledged dismiss — user is aware they need to plug
   *  the drive in but is choosing to defer until later this session. */
  onConnectLater: () => void;
  /** Returns true if the drive is now reachable, false otherwise. */
  onRetry: () => Promise<boolean>;
}

export function LibraryDriveOfflineModal({
  isOpen,
  destinationPath,
  context = 'generic',
  onClose,
  onOpenLibraryPanel,
  onConnectLater,
  onRetry,
}: LibraryDriveOfflineModalProps) {
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);

  if (!isOpen) return null;

  // Contextual headline + "needs for this action" copy. Generic =
  // banner-click path; the others are reactive (user just tried to
  // do something that hit DESTINATION_OFFLINE). Each headline names
  // the specific action that's blocked so the user understands why
  // the modal just appeared.
  const contextCopy = (() => {
    switch (context) {
      case 'run-fix':
        return {
          headline: 'Plug in your Library Drive to run Fix',
          why: 'Fix copies your fixed photos to the Library Drive, so the drive has to be connected before it can run.',
        };
      case 'open-file':
        return {
          headline: 'This photo lives on your Library Drive',
          why: 'PDR needs the drive connected to open the original file.',
        };
      case 'sync-now':
        return {
          headline: 'Library backup can\'t sync right now',
          why: 'PDR mirrors your library database onto the Library Drive so it can be recovered on another PC. The drive has to be connected.',
        };
      default:
        return {
          headline: 'Your Library Drive isn\'t connected',
          why: 'PDR uses this drive to store fixed photos and a backup of your library database.',
        };
    }
  })();

  const handleRetry = async () => {
    setIsRetrying(true);
    setRetryFailed(false);
    try {
      const stillOnline = await onRetry();
      if (stillOnline) {
        onClose();
      } else {
        setRetryFailed(true);
      }
    } catch {
      setRetryFailed(true);
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="w-full max-w-md bg-background rounded-2xl shadow-2xl overflow-hidden border border-border"
      >
        <div className="relative bg-gradient-to-br from-amber-100 via-amber-50 to-transparent dark:from-amber-950/40 dark:via-amber-950/20 px-6 pt-8 pb-6">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
          <div className="flex flex-col items-center text-center">
            <motion.div
              initial={{ scale: 0, rotate: -20 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ delay: 0.1, type: 'spring', stiffness: 200 }}
              className="w-16 h-16 bg-gradient-to-br from-amber-200 to-amber-50 dark:from-amber-700 dark:to-amber-900 rounded-2xl flex items-center justify-center mb-4 border border-amber-300/60 shadow-lg shadow-amber-500/10"
            >
              <AlertTriangle className="w-8 h-8 text-amber-600 dark:text-amber-400" />
            </motion.div>
            <h2 className="text-h1 text-foreground mb-2">{contextCopy.headline}</h2>
            {destinationPath && (
              <p className="text-mono mt-1 break-all">{destinationPath}</p>
            )}
            <p className="text-body-muted max-w-sm mt-3">
              {contextCopy.why}
            </p>
            {retryFailed && (
              <p className="text-body-muted text-rose-700 dark:text-rose-300 mt-3">
                Still not reachable. Make sure the drive is plugged in and recognised by Windows, then Retry.
              </p>
            )}
          </div>
        </div>
        {/* "Still works without it" reassurance — same across all
            contexts. Tells the user the app isn't broken, just
            temporarily restricted on a few specific operations.
            Two-column layout: needs (rose X) + still works (emerald ✓)
            scans in 2 seconds without forcing the user to read prose. */}
        <div className="px-6 pt-4 pb-1 grid grid-cols-2 gap-4 border-b border-border">
          <div>
            <p className="text-caption uppercase tracking-wider mb-2">Needs the drive</p>
            <ul className="space-y-1.5">
              <li className="flex items-start gap-1.5">
                <XCircle className="w-3.5 h-3.5 text-rose-500 dark:text-rose-400 shrink-0 mt-0.5" />
                <span className="text-body-muted">Running Fix</span>
              </li>
              <li className="flex items-start gap-1.5">
                <XCircle className="w-3.5 h-3.5 text-rose-500 dark:text-rose-400 shrink-0 mt-0.5" />
                <span className="text-body-muted">Opening fixed photos</span>
              </li>
              <li className="flex items-start gap-1.5">
                <XCircle className="w-3.5 h-3.5 text-rose-500 dark:text-rose-400 shrink-0 mt-0.5" />
                <span className="text-body-muted">Library backup sync</span>
              </li>
            </ul>
          </div>
          <div>
            <p className="text-caption uppercase tracking-wider mb-2">Still works</p>
            <ul className="space-y-1.5">
              <li className="flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                <span className="text-body-muted">Adding sources</span>
              </li>
              <li className="flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                <span className="text-body-muted">Browsing, search, tagging</span>
              </li>
              <li className="flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                <span className="text-body-muted">Editing dates on sources</span>
              </li>
            </ul>
          </div>
        </div>
        <div className="px-6 pb-6 pt-4 space-y-3">
          <Button
            onClick={handleRetry}
            disabled={isRetrying}
            variant="primary"
            className="w-full h-12"
          >
            {isRetrying ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Checking...
              </>
            ) : (
              <>
                <RotateCcw className="w-4 h-4 mr-2" /> Retry
              </>
            )}
          </Button>
          {/* "Change Library Drive" — opens Library Drive Management
              (LibraryPanel). The user-facing label keeps the same wording
              as before because that's still the user's mental intent;
              what changed underneath is that this now routes to the
              single management surface instead of a one-off folder
              picker. Inside LibraryPanel they can swap to a different
              existing drive, set up a brand-new library, take over as
              writer, or disconnect — all in one place. */}
          <Button
            onClick={onOpenLibraryPanel}
            disabled={isRetrying}
            variant="secondary"
            className="w-full h-11"
          >
            <Plug className="w-4 h-4 mr-2" /> Change Library Drive
          </Button>

          {/* Soft acknowledged dismiss — distinct from a blank X close.
              The user is making an informed deferral ("I know, later")
              rather than just clicking past the popup. Discouraged-option
              pattern from STYLE_GUIDE.md: variant="link" + the sanctioned
              text-muted-foreground override so the option exists but
              visually de-emphasises so users who should retry / change
              drive aren't pulled toward defer-and-forget. */}
          <div className="pt-2 border-t border-border">
            <Button
              onClick={onConnectLater}
              disabled={isRetrying}
              variant="link"
              className="w-full h-9 justify-center text-muted-foreground hover:text-foreground"
            >
              Connect Library Drive later
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
