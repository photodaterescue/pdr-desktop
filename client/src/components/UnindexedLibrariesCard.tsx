import { useEffect, useState } from 'react';
import { Sparkles, X, Database } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';

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
}

const SAVED_DESTINATIONS_KEY = 'pdr-saved-destinations';

export function UnindexedLibrariesCard() {
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [indexing, setIndexing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await (window as any).pdr?.settings?.get?.();
        if (!cancelled && settings) {
          setDismissedAt(settings.unindexedLibrariesDismissedAt ?? null);
        }
      } catch { /* defaults to not dismissed */ }

      try {
        // Gather every library root the user has ever picked: current
        // destination + every entry under pdr-saved-destinations.
        // Deduplicated case-insensitively to avoid double-counting
        // when settings + localStorage hold the same path with different
        // separators.
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

        // Probe each library in parallel. Indexed count is fast (single
        // SQL query); on-disk count walks the folder tree and can take
        // several seconds on large libraries — but each probe is
        // independent, so wall time is roughly the slowest single one
        // rather than the sum.
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
            };
          } catch { return null; }
        }));
        if (cancelled) return;
        const valid = probed.filter((r): r is LibraryRow => r !== null);
        setRows(valid);
      } catch { /* leaves rows empty — card stays hidden */ }
      if (!cancelled) setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!loaded) return null;
  if (dismissedAt) return null;

  // 5 % slack so a single new file between the two probes doesn't
  // trip the banner. Unreachable libraries (onDiskCount === null)
  // are excluded because we can't actually compare.
  const stale = rows.filter((r) =>
    r.onDiskCount !== null && r.onDiskCount > Math.ceil(r.indexedCount * 1.05)
  );
  if (stale.length === 0) return null;

  const totalMissing = stale.reduce((sum, r) => sum + ((r.onDiskCount ?? 0) - r.indexedCount), 0);

  const handleDismiss = async () => {
    try {
      const ts = new Date().toISOString();
      await (window as any).pdr?.settings?.set?.('unindexedLibrariesDismissedAt', ts);
      setDismissedAt(ts);
    } catch (e) {
      console.warn('[UnindexedLibrariesCard] dismiss failed:', e);
    }
  };

  const handleIndexNow = async () => {
    if (indexing) return;
    setIndexing(true);
    const pathsToIndex = stale.map((r) => r.path);
    const totalLibraries = pathsToIndex.length;

    // Toast-driven progress. Sonner's loading toast updates in place
    // as rebuildProgress events come in, then resolves to success on
    // the final phase='complete' event from the last root. Banner
    // dismisses immediately so the user can navigate freely — the
    // toast follows them across views (it's mounted on <Toaster />
    // at the workspace root).
    const toastId = toast.loading(
      `Indexing ${totalLibraries} librar${totalLibraries === 1 ? 'y' : 'ies'}…`,
      { description: 'Starting…' }
    );

    // Subscribe to rebuild progress BEFORE firing the IPC so we don't
    // miss the very first 'walking' event. Unsubscribes itself on the
    // final 'complete' event of the last root.
    let lastRootIndex = -1;
    const unsubscribe = (window as any).pdr?.search?.onRebuildProgress?.((progress: {
      phase: 'walking' | 'reading-exif' | 'inserting' | 'complete';
      rootIndex: number;
      rootCount: number;
      rootPath: string;
      current: number;
      total: number;
      currentFile: string;
    }) => {
      const rootName = progress.rootPath.split(/[\\/]/).filter(Boolean).pop() ?? progress.rootPath;
      const libProgress = progress.rootCount > 1
        ? `(library ${progress.rootIndex + 1} of ${progress.rootCount}) `
        : '';
      let description = '';
      if (progress.phase === 'walking') {
        description = `${libProgress}Scanning "${rootName}"…`;
      } else if (progress.phase === 'reading-exif') {
        description = `${libProgress}Reading "${rootName}" — ${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}`;
      } else if (progress.phase === 'inserting') {
        description = `${libProgress}Saving "${rootName}"…`;
      } else if (progress.phase === 'complete') {
        if (progress.rootIndex >= progress.rootCount - 1) {
          // Last root finished — resolve the loading toast.
          toast.success(`Finished indexing ${totalLibraries} librar${totalLibraries === 1 ? 'y' : 'ies'}`,
            { id: toastId, description: 'Your photos are now searchable in S&D, Memories, and the Date Editor.' });
          unsubscribe?.();
          return;
        }
      }
      lastRootIndex = progress.rootIndex;
      toast.loading(`Indexing ${totalLibraries} librar${totalLibraries === 1 ? 'y' : 'ies'}…`,
        { id: toastId, description });
    });

    try {
      // Fire-and-forget — we don't await, so the user can navigate
      // away while the indexer runs. Resolution is driven by the
      // progress subscription above.
      void (window as any).pdr?.search?.rebuildFromLibraries?.(pathsToIndex)
        .catch((e: any) => {
          console.warn('[UnindexedLibrariesCard] rebuild failed:', e);
          toast.error('Indexing failed', { id: toastId, description: String(e?.message ?? e) });
          unsubscribe?.();
        });
      // Dismiss the banner so it doesn't keep nagging while the
      // background indexer churns. Subsequent launches re-check; if
      // some libraries still have gaps, the banner returns. (`stale`
      // mention shuts up the "lastRootIndex assigned but never used"
      // TS warning when the file is type-checked strictly.)
      void lastRootIndex;
      await handleDismiss();
    } catch (e) {
      console.warn('[UnindexedLibrariesCard] index-now failed:', e);
      toast.error('Indexing failed to start', { id: toastId });
      unsubscribe?.();
    } finally {
      setIndexing(false);
    }
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
          {totalMissing.toLocaleString()} photo{totalMissing === 1 ? '' : 's'} on disk haven't been added to PDR's search index. They won't appear in <strong className="text-foreground">Search &amp; Discovery</strong>, <strong className="text-foreground">Memories</strong>, or the <strong className="text-foreground">Date Editor</strong> until indexed. From v2.0.5 onwards new Fixes index automatically; this is a one-off catch-up for libraries created earlier.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button onClick={handleIndexNow} variant="primary" size="sm" disabled={indexing} data-testid="unindexed-libraries-index-now">
          {indexing ? 'Starting…' : 'Index now'}
        </Button>
        <IconTooltip label="Dismiss" side="left">
          <button
            onClick={handleDismiss}
            disabled={indexing}
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
