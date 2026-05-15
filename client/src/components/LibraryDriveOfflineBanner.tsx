import { useState } from 'react';
import { AlertTriangle, Loader2, RotateCcw, Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';

// LibraryDriveOfflineBanner — calm, always-visible status indicator that
// appears at the top of the workspace whenever PDR's configured Library
// Drive isn't reachable on disk. Replaces the previous "blocking modal
// on workspace mount" behaviour, which was too aggressive: there's plenty
// the user can still do without the Library Drive (add sources, browse,
// tag faces, edit dates, search), so the workspace shouldn't be held
// hostage to a state that isn't strictly an error.
//
// The banner is the STATE indicator. The companion modal
// (LibraryDriveOfflineModal) is the ACTIONABLE moment — it fires only
// when the user attempts an operation that genuinely requires the drive
// (Run Fix, opening a photo that lives on the drive, syncing the
// backup). Two complementary surfaces, one source of truth.
//
// Tone: amber/caution palette per STYLE_GUIDE button-tier semantics
// (recoverable warning, not destructive). One line of headline + one
// line of body so the banner reads in a glance without dominating the
// workspace; the modal carries the detailed framing.

interface LibraryDriveOfflineBannerProps {
  /** The configured Library Drive path that isn't reachable. */
  path: string;
  /** Returns true if the drive is now reachable. The caller is
   *  responsible for clearing the banner state when the drive comes
   *  back; the banner just calls onRetry and lets the parent decide. */
  onRetry: () => Promise<boolean>;
  /** Open the Library Drive Management surface (LibraryPanel). Same
   *  CustomEvent dispatch the offline modal uses. */
  onOpenLibraryPanel: () => void;
}

export function LibraryDriveOfflineBanner({
  path,
  onRetry,
  onOpenLibraryPanel,
}: LibraryDriveOfflineBannerProps) {
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await onRetry();
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-amber-200/70 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-2.5 flex items-center gap-3">
      <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
      <div className="min-w-0 flex-1">
        {/* Headline = text-body so the alert reads with full opacity.
            Path inline as text-mono; secondary copy as text-body-muted
            to keep the banner compact (single visual row, two text
            tiers). */}
        <p className="text-body text-foreground">
          <span className="font-medium">Library Drive offline</span>
          <span className="text-muted-foreground"> · </span>
          <span className="text-mono">{path}</span>
        </p>
        <p className="text-body-muted">
          You can still add sources, browse, tag faces, and edit dates. Reconnect the drive to run Fix or open fixed photos.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {/* Variants + size only, no per-call className overrides for
            sizing or colour — per STYLE_GUIDE.md. size="sm" gives the
            defined small-button shape (min-h-8 px-3 text-xs) without us
            freehanding heights. primary on Retry = lavender filled
            (high contrast against amber); secondary on Manage = the
            outline-lavender alternative. */}
        <Button
          onClick={handleRetry}
          disabled={isRetrying}
          variant="primary"
          size="sm"
        >
          {isRetrying ? (
            <Loader2 className="animate-spin" />
          ) : (
            <RotateCcw />
          )}
          Retry
        </Button>
        <Button
          onClick={onOpenLibraryPanel}
          disabled={isRetrying}
          variant="secondary"
          size="sm"
        >
          <Plug />
          Manage
        </Button>
      </div>
    </div>
  );
}
