import { useEffect, useState } from 'react';
import { Sparkles, X, Database } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { runLibraryRefresh, isLibraryRefreshRunning } from '@/lib/library-refresh';

// UnindexedLibrariesCard — Dashboard banner that surfaces libraries
// whose files-on-disk count exceeds their search-DB count, prompting
// the user to index them. v2.0.9 addition (Terry 2026-05-20).
//
// Auto-index by default has been on since v2.0.5 ("Searchable Fixed
// photos by default"), so any library created on v2.0.4 or earlier
// — or one where the user explicitly turned off auto-index — has
// files on disk that don't appear in S&D / Memories / Date Editor.
// This banner detects that gap and offers a one-click backfill.
//
// Trigger condition: any saved Library Drive path where the on-disk
// media-file count exceeds the indexed-file count by more than 5 %
// (a slack margin so a couple of files added between the two probes
// don't trip the banner). Once dismissed, settings flag
// `unindexedLibrariesDismissedAt` keeps it suppressed — same
// pattern as LowRamAdvisoryCard. Users who later add more libraries
// can re-trigger by clearing the flag (no UI for that yet, intentional
// — the per-row LDM pill is the explicit re-entry).
//
// The actual indexing is delegated to the existing
// `search:rebuildFromLibraries` IPC (live since v2.0.6 with the non-
// destructive findExistingFilePaths fix). Progress is shown in the
// title bar via the existing `search:rebuildProgress` channel.

interface LibraryRow {
  path: string;
  indexedCount: number;
  onDiskCount: number | null; // null when path isn't reachable
  // v3.0.1 (Terry 2026-07-12) — on-disk files NOT covered anywhere in the index
  // by (filename, size). This, not the raw onDisk−indexed gap, is what actually
  // "needs refreshing": files already indexed under another drive (a test/backup
  // copy of the real library) are searchable and must not nag. null = unreachable.
  uncoveredCount: number | null;
}

const SAVED_DESTINATIONS_KEY = 'pdr-saved-destinations';

export function UnindexedLibrariesCard() {
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<LibraryRow[]>([]);
  // v3.0.1 (Terry 2026-07-12) — the banner now hides itself for as long as a
  // library refresh is actually running, sourced from the shared
  // runLibraryRefresh coordinator (isLibraryRefreshRunning). This covers a
  // refresh started from HERE and one started from the Library Drive Manager —
  // either way the nag disappears while the work is in flight and re-probes the
  // gap when it ends (so it clears if the gap closed, or returns to offer a
  // retry if the refresh failed). Nothing is persisted until the explicit X or
  // the gap naturally closing on a later probe.
  const [refreshRunning, setRefreshRunning] = useState<boolean>(isLibraryRefreshRunning());

  // Probe the row data once. Extracted so we can re-run on
  // pdr:libraryRebuildComplete and reflect the post-index state
  // (banner clears if the gap closed). cancelledRef guards against
  // late completions of probes started before unmount.
  const probeRows = async (cancelledRef: { current: boolean }) => {
    try {
      const settings = await (window as any).pdr?.settings?.get?.();
      const currentPath: string | null = settings?.destinationPath ?? null;
      let saved: string[] = [];
      try {
        const raw = localStorage.getItem(SAVED_DESTINATIONS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
          saved = parsed.filter((p): p is string => typeof p === 'string' && p.length > 0);
        }
      } catch { /* localStorage unavailable / corrupted — empty list */ }

      const allPaths = currentPath ? [currentPath, ...saved] : [...saved];
      const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
      const seen = new Set<string>();
      const paths: string[] = [];
      for (const p of allPaths) {
        const n = norm(p);
        if (seen.has(n)) continue;
        seen.add(n);
        paths.push(p);
      }

      const probed = await Promise.all(paths.map(async (p): Promise<LibraryRow | null> => {
        try {
          const [idxRes, diskRes] = await Promise.all([
            (window as any).pdr?.library?.countFilesAtPath?.(p),
            (window as any).pdr?.library?.countOnDiskFiles?.(p),
          ]);
          if (!idxRes?.success || !diskRes?.success) return null;
          return {
            path: p,
            indexedCount: idxRes.data?.indexedFileCount ?? 0,
            onDiskCount: diskRes.data?.reachable ? (diskRes.data?.onDiskCount ?? 0) : null,
            uncoveredCount: diskRes.data?.reachable ? (diskRes.data?.uncoveredCount ?? 0) : null,
          };
        } catch { return null; }
      }));
      if (cancelledRef.current) return;
      const valid = probed.filter((r): r is LibraryRow => r !== null);
      setRows(valid);
    } catch { /* leaves rows empty — card stays hidden */ }
  };

  useEffect(() => {
    const cancelledRef = { current: false };
    (async () => {
      try {
        const settings = await (window as any).pdr?.settings?.get?.();
        if (!cancelledRef.current && settings) {
          setDismissedAt(settings.unindexedLibrariesDismissedAt ?? null);
        }
      } catch { /* defaults to not dismissed */ }

      await probeRows(cancelledRef);
      if (!cancelledRef.current) setLoaded(true);
    })();

    // Re-probe whenever any rebuild completes — covers both this
    // banner's own "Index now" (which fires the event itself) AND
    // the LDM per-row Index pill (which dispatches the same event).
    // Without this listener, indexing via the LDM would clear the
    // LDM pill but leave the Dashboard banner showing the stale
    // gap until the next mount. Terry 2026-05-23.
    const onRebuildComplete = () => { void probeRows(cancelledRef); };
    window.addEventListener('pdr:libraryRebuildComplete', onRebuildComplete);
    // v3.0.1 (Terry 2026-07-12) — reflect the shared refresh state: hide the
    // banner while a refresh runs (from here OR the Library Drive Manager) and
    // re-probe the gap the moment it ends.
    const onRefreshState = () => {
      const r = isLibraryRefreshRunning();
      setRefreshRunning(r);
      if (!r) void probeRows(cancelledRef);
    };
    window.addEventListener('pdr:libraryRefreshStateChange', onRefreshState);

    return () => {
      cancelledRef.current = true;
      window.removeEventListener('pdr:libraryRebuildComplete', onRebuildComplete);
      window.removeEventListener('pdr:libraryRefreshStateChange', onRefreshState);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!loaded) return null;
  if (dismissedAt) return null;
  if (refreshRunning) return null;   // a refresh (here or the Library Drive Manager) is in flight

  // v3.0.1 (Terry 2026-07-12) — a library is "stale" only if it has a real
  // number of files that aren't indexed ANYWHERE (uncoveredCount), not merely
  // files missing from THIS path's rows. This stops the banner nagging about a
  // test/backup drive whose photos are already searchable via the real library
  // (they de-dupe to the other drive, so onDisk−indexed looks big but uncovered
  // is ~0). Small floor of 10 so a handful of freshly-added files don't nag.
  // Unreachable libraries (uncoveredCount === null) are excluded.
  const stale = rows.filter((r) => r.uncoveredCount !== null && r.uncoveredCount > 10);
  if (stale.length === 0) return null;

  const totalMissing = stale.reduce((sum, r) => sum + (r.uncoveredCount ?? 0), 0);

  const handleDismiss = async () => {
    try {
      const ts = new Date().toISOString();
      await (window as any).pdr?.settings?.set?.('unindexedLibrariesDismissedAt', ts);
      setDismissedAt(ts);
      // Tell the user the dismissal isn't permanent and where to re-enter
      // from — the per-row "Index" pill in the Library Drive Manager
      // (v2.0.11 addition). Without this hint, dismissing the banner used
      // to leave users with no obvious way back to indexing. 8-second
      // duration so it's readable but doesn't linger.
      toast.message("Hidden — you can refresh any library from the Library Drive Manager", {
        description: "Open any library row's ⋯ menu and pick Refresh search index to bring PDR's view of that library up to date.",
        duration: 8000,
      });
    } catch (e) {
      console.warn('[UnindexedLibrariesCard] dismiss failed:', e);
    }
  };

  const handleIndexNow = async () => {
    if (isLibraryRefreshRunning()) return;
    // v3.0.1 (Terry 2026-07-12) — delegate to the SINGLE shared refresh owner
    // (client/src/lib/library-refresh.ts). It creates exactly one progress
    // toast and runs exactly one rebuild — so this banner and the Library Drive
    // Manager can no longer each spawn their own toast/rebuild (the "2 toast
    // screens ... freaking out" bug). runLibraryRefresh dispatches
    // pdr:libraryRefreshStateChange (which hides this banner via the effect's
    // listener) and, on success, pdr:libraryRebuildComplete (which re-probes
    // the gap here + re-fetches data across S&D/Memories/LDM). We deliberately
    // never persist a dismiss on failure — a failed refresh leaves the gap, so
    // the re-probe simply brings the banner back for a retry.
    await runLibraryRefresh(stale.map((r) => r.path));
  };

  return (
    <section className="mb-6 rounded-xl border border-primary/30 bg-gradient-to-r from-primary/10 to-primary/5 p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300" data-testid="unindexed-libraries-card">
      <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
        <Database className="w-5 h-5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-h2 text-foreground inline-flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          {stale.length === 1
            ? `One of your libraries isn't fully searchable yet`
            : `${stale.length} of your libraries aren't fully searchable yet`}
        </p>
        <p className="text-body-muted mt-1">
          {totalMissing.toLocaleString()} photo{totalMissing === 1 ? '' : 's'} on disk haven't been added to PDR's search index. They won't appear in <strong className="text-foreground">Search &amp; Discovery</strong>, <strong className="text-foreground">Memories</strong>, or the <strong className="text-foreground">Date Editor</strong> until PDR's view of these libraries is refreshed. From v2.0.5 onwards new Fixes refresh automatically; this is a one-off catch-up for libraries created earlier.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button onClick={handleIndexNow} variant="primary" size="sm" disabled={refreshRunning} data-testid="unindexed-libraries-index-now">
          Refresh now
        </Button>
        <IconTooltip label="Dismiss" side="top">
          <button
            onClick={handleDismiss}
            disabled={refreshRunning}
            className="p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            aria-label="Dismiss advisory"
            data-testid="unindexed-libraries-dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </IconTooltip>
      </div>
    </section>
  );
}
