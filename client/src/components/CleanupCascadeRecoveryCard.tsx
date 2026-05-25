import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { promptConfirm } from './trees/promptConfirm';

// CleanupCascadeRecoveryCard — Dashboard banner that surfaces a usable
// rescue when the local DB has been damaged by a cascade-delete event
// (most famously v2.0.10's purgeDuplicateRuns, which kept the newest
// indexed_run per destination_path and FK-cascaded everything else
// including album_files).
//
// Why this exists (Terry 2026-05-25):
//   v2.0.11 neutered the buggy purge, but anyone upgrading 2.0.10 →
//   2.0.11/12 still gets hit one last time on the final 2.0.10 launch
//   before the installer applies — that launch fires the cleanup and
//   wipes indexed_files + album_files. The sidecar DB on the Library
//   Drive is usually written 10–30s before that launch (after the
//   morning's Fix), so a row-count diff between sidecar and local is
//   a reliable cascade signature with a usable rescue waiting on disk.
//
//   Terry hit this himself on 2026-05-25 — 69 Google Photos albums
//   went to 0 photos each in seconds. We recovered via a manual file
//   copy of the sidecar. This banner makes that recovery one-click for
//   every future user who hits the same pattern.
//
// Trigger condition is in electron/library-sidecar.ts:detectRecoveryGap
// — both must be true:
//   1. Sidecar has ≥2× the local file count AND absolute diff ≥1,000.
//   2. Sidecar has more indexed_runs than the local DB.
// Tunings designed to never false-positive on a new / partially-
// indexed library (which has equal run counts) or a tiny library.
//
// Styling: amber-on-amber, more urgent than the lavender UnindexedLibraries
// banner. Dismissable with a confirmation, but the data is genuinely
// recoverable and we'd rather the user act on it than wave it away.
// Once Restore succeeds the page reloads so every view (S&D, Memories,
// Trees) re-reads the restored DB instead of trying to live-patch state.

interface RecoveryGap {
  libraryRoot: string;
  localFiles: number;
  sidecarFiles: number;
  localRuns: number;
  sidecarRuns: number;
  localAlbumLinks: number;
  sidecarAlbumLinks: number;
  sidecarWrittenAt: string | null;
}

const DISMISS_KEY = 'pdr-recovery-gap-dismissed-at';

function formatBackupAge(writtenAt: string | null): string {
  if (!writtenAt) return 'your Library Drive';
  try {
    const written = new Date(writtenAt);
    const now = new Date();
    const diffMs = now.getTime() - written.getTime();
    const diffMin = Math.round(diffMs / 60_000);
    if (diffMin < 1) return 'a few seconds ago';
    if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
    const diffDay = Math.round(diffHr / 24);
    return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  } catch {
    return 'your Library Drive';
  }
}

export function CleanupCascadeRecoveryCard() {
  const [gap, setGap] = useState<RecoveryGap | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Probe once on mount. The IPC reads the local DB row counts (live
  // connection) and opens the sidecar read-only for its counts, so
  // there's no contention with any writer process. Returns null when
  // there's nothing to recover — banner stays hidden in that case.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prevDismiss = localStorage.getItem(DISMISS_KEY);
        if (prevDismiss) setDismissed(true);

        const res = await (window as Window & {
          pdr?: { library?: { detectRecoveryGap?: () => Promise<{ success: boolean; data: RecoveryGap | null }> } };
        }).pdr?.library?.detectRecoveryGap?.();
        if (cancelled) return;
        if (res?.success && res.data) {
          setGap(res.data);
        }
      } catch (e) {
        console.warn('[CleanupCascadeRecoveryCard] detectRecoveryGap failed:', e);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleRestore = async () => {
    if (!gap) return;
    setRestoring(true);
    const toastId = toast.loading('Restoring library backup…', {
      description: `Copying ${gap.sidecarFiles.toLocaleString()} photo records from your Library Drive`,
    });
    try {
      // Pull license key + device name. attachFromSidecar verifies the
      // key matches the writer-lock fingerprint, so we can't restore
      // someone else's library on this device by accident.
      const licenseRes = await (window as Window & {
        pdr?: { license?: { get?: () => Promise<{ success: boolean; data?: { key?: string } }> } };
      }).pdr?.license?.get?.();
      const licenseKey = licenseRes?.data?.key ?? '';
      const settingsRes = await (window as Window & {
        pdr?: { settings?: { get?: () => Promise<{ deviceName?: string }> } };
      }).pdr?.settings?.get?.();
      const deviceName = settingsRes?.deviceName ?? 'This device';

      const result = await (window as Window & {
        pdr?: { library?: { attachFromSidecar?: (o: { libraryRoot: string; licenseKey: string; deviceName: string }) => Promise<{ success: boolean; error?: string }> } };
      }).pdr?.library?.attachFromSidecar?.({
        libraryRoot: gap.libraryRoot,
        licenseKey,
        deviceName,
      });

      if (result?.success) {
        toast.success('Library restored', {
          id: toastId,
          description: 'Reloading PDR to refresh every view with your restored data…',
        });
        // Hard reload — every mounted view (S&D, Memories, Trees, etc.)
        // has its own in-memory cache of the DB. A full reload is
        // simpler and more correct than trying to broadcast a "DB
        // changed" event and invalidate every cache individually.
        setTimeout(() => window.location.reload(), 1500);
      } else {
        toast.error('Restore failed', {
          id: toastId,
          description: result?.error ?? 'See Help & Support for next steps.',
        });
        setRestoring(false);
      }
    } catch (e) {
      toast.error('Restore failed', {
        id: toastId,
        description: (e as Error).message,
      });
      setRestoring(false);
    }
  };

  const handleDismiss = async () => {
    if (restoring || !gap) return;
    const missing = gap.sidecarFiles - gap.localFiles;
    const ok = await promptConfirm({
      title: 'Skip restoring your library backup?',
      message: (
        <>
          Your Library Drive backup will still be there next launch &mdash; but until you restore,{' '}
          <strong className="text-foreground">{missing.toLocaleString()}</strong>{' '}
          photo records will be missing from Search &amp; Discovery, Memories, and Albums on this device.
        </>
      ),
      confirmLabel: 'Skip for now',
      cancelLabel: 'Restore instead',
      danger: true,
    });
    if (!ok) return;
    localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    setDismissed(true);
  };

  if (!loaded || !gap || dismissed) return null;

  const missingFiles = gap.sidecarFiles - gap.localFiles;
  const missingAlbumLinks = gap.sidecarAlbumLinks - gap.localAlbumLinks;
  const backupAge = formatBackupAge(gap.sidecarWrittenAt);

  return (
    <section
      className="mb-6 rounded-xl border border-amber-400 dark:border-amber-600/60 bg-gradient-to-r from-amber-100 to-amber-50 dark:from-amber-900/30 dark:to-amber-950/20 p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300"
      data-testid="cleanup-cascade-recovery-card"
    >
      <div className="w-10 h-10 rounded-full bg-amber-200 dark:bg-amber-900/50 flex items-center justify-center shrink-0">
        <AlertTriangle className="w-5 h-5 text-amber-700 dark:text-amber-300" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-h2 text-foreground">
          Your library backup has more photos than PDR is showing
        </p>
        <p className="text-body-muted mt-1">
          A backup on your Library Drive (written {backupAge}) contains{' '}
          <strong className="text-foreground">{gap.sidecarFiles.toLocaleString()} photos</strong>
          {missingAlbumLinks > 0 && (
            <> and <strong className="text-foreground">{gap.sidecarAlbumLinks.toLocaleString()} album memberships</strong></>
          )}
          , but PDR is currently indexing only{' '}
          <strong className="text-foreground">{gap.localFiles.toLocaleString()}</strong>. A previous version&apos;s
          startup cleanup likely deleted database rows that shouldn&apos;t have been touched. Photos on disk are fine —
          one click restores the missing{' '}
          <strong className="text-foreground">{missingFiles.toLocaleString()}</strong> records from your Library Drive&apos;s backup.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button onClick={handleRestore} variant="primary" size="sm" disabled={restoring} data-testid="cleanup-cascade-restore">
          {restoring ? 'Restoring…' : 'Restore now'}
        </Button>
        <IconTooltip label="Dismiss" side="top">
          <button
            onClick={handleDismiss}
            disabled={restoring}
            className="p-1.5 rounded-md hover:bg-amber-200/60 dark:hover:bg-amber-900/40 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            aria-label="Dismiss recovery banner"
            data-testid="cleanup-cascade-dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </IconTooltip>
      </div>
    </section>
  );
}
