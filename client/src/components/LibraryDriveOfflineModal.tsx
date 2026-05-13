import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, AlertTriangle, Loader2, Plug, RotateCcw } from 'lucide-react';
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
//   - Change Library Drive: open the existing destination-picker flow
//     (the same one the Dashboard "Change Library Drive" button uses).
//     The parent supplies that handler via onChangeLibraryDrive.
//   - Close (X / Esc / backdrop): dismiss, but the underlying issue
//     remains — the user will hit it again the moment they try to do
//     anything that needs the drive.

interface LibraryDriveOfflineModalProps {
  isOpen: boolean;
  destinationPath: string | null;
  onClose: () => void;
  onChangeLibraryDrive: () => void;
  /** Returns true if the drive is now reachable, false otherwise. */
  onRetry: () => Promise<boolean>;
}

export function LibraryDriveOfflineModal({
  isOpen,
  destinationPath,
  onClose,
  onChangeLibraryDrive,
  onRetry,
}: LibraryDriveOfflineModalProps) {
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);

  if (!isOpen) return null;

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
            <h2 className="text-h1 text-foreground mb-2">Your Library Drive isn't connected</h2>
            <p className="text-body-muted max-w-sm">
              PDR can't reach your Library Drive at:
            </p>
            {destinationPath && (
              <p className="text-caption mt-2 break-all font-mono">{destinationPath}</p>
            )}
            <p className="text-body-muted max-w-sm mt-2">
              It's probably unplugged, sleeping, or offline. Plug it in and click Retry, or pick a different Library Drive.
            </p>
            {retryFailed && (
              <p className="text-caption text-rose-700 dark:text-rose-300 mt-3">
                Still not reachable. Make sure the drive is plugged in and recognised by Windows, then Retry.
              </p>
            )}
          </div>
        </div>
        <div className="px-6 pb-6 pt-2 space-y-3">
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
          <Button
            onClick={onChangeLibraryDrive}
            disabled={isRetrying}
            variant="secondary"
            className="w-full h-11"
          >
            <Plug className="w-4 h-4 mr-2" /> Change Library Drive
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
