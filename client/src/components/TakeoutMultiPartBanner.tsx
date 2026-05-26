import { useEffect, useState } from 'react';
import { Sparkles, X, Package } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';

// TakeoutMultiPartBanner — v2.0.13 Dashboard banner that detects
// multi-part Google Takeout exports in the user's source menu and
// offers a one-click pre-scan of every sidecar JSON across all parts.
//
// Why this exists (Terry 2026-05-25 / 26):
//   Google's multi-part Takeout exports split photos and their JSON
//   sidecars across DIFFERENT zip files. Photo X may sit in
//   takeout-007 while its sidecar lives in takeout-008. PDR analyses
//   one part at a time, so ~24% of photos in any given part lose
//   their precise date (fall back to filename pattern or mtime,
//   marked _RC / _MK) when they should have had a confirmed date.
//
//   The fix is to pre-scan every Takeout zip's central directory for
//   JSON entries (no photo bytes touched — minutes per part, not
//   hours), build a shared sidecar DB on the Library Drive, and let
//   the analysis engine consult it before falling back to weaker
//   date sources.
//
// This banner is the user-facing trigger. It probes the source menu
// for Takeout-pattern zips on mount; if any are present AND any of
// their groups don't have a complete sidecar scan yet, it surfaces
// the pre-scan offer.
//
// Per Terry 2026-05-26: the banner shows on EVERY add of an
// unscanned Takeout part, not just the first one. And dismissal must
// mention where to continue if the user wants to come back later
// (the LDM "Takeout metadata" row is the permanent home).
//
// Dismissal is session-only — clears on every relaunch — because if
// the user keeps adding more parts they need the prompt again.

interface Source {
  id: string;
  path: string;
  type: string;
}

interface SidecarGroup {
  groupId: string;
  sidecarCount: number;
  zipCount: number;
  lastScannedAt: string;
}

interface TakeoutZipInfo {
  source: Source;
  groupId: string;
}

const SOURCES_KEY = 'pdr-sources';
const DISMISS_KEY = 'pdr-takeout-banner-dismissed';

export function TakeoutMultiPartBanner() {
  const [unscannedZips, setUnscannedZips] = useState<TakeoutZipInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (sessionStorage.getItem(DISMISS_KEY)) {
          setDismissed(true);
          setLoaded(true);
          return;
        }

        // Read the live source list. The workspace persists this to
        // localStorage on every change, so reading it here is the
        // cheapest way to stay in sync without an event subscription.
        let sources: Source[] = [];
        try {
          const raw = localStorage.getItem(SOURCES_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) sources = parsed;
          }
        } catch { /* corrupted localStorage — treat as no sources */ }

        // Filter to Takeout-pattern zips. The detectGroupId IPC
        // returns null for non-Takeout names, so anything with a
        // non-null group id is a multi-part Takeout part.
        const candidates: TakeoutZipInfo[] = [];
        for (const src of sources) {
          if (typeof src?.path !== 'string') continue;
          const lower = src.path.toLowerCase();
          if (!lower.endsWith('.zip')) continue;
          const res = await (window as Window & {
            pdr?: { takeout?: { detectGroupId?: (p: string) => Promise<{ success: boolean; data: string | null }> } };
          }).pdr?.takeout?.detectGroupId?.(src.path);
          if (res?.success && res.data) {
            candidates.push({ source: src, groupId: res.data });
          }
        }
        if (cancelled) return;
        if (candidates.length === 0) {
          setLoaded(true);
          return;
        }

        // Cross-reference against what's already been scanned. A
        // group with at least one zip in the source menu but zero
        // sidecars scanned is fully unscanned. A group with sidecars
        // scanned from fewer zips than are in the source menu is
        // partially scanned — still worth offering, because the
        // missing zips may carry sidecars for photos in the scanned
        // zips.
        const summaryRes = await (window as Window & {
          pdr?: { takeout?: { getSidecarSummary?: () => Promise<{ success: boolean; data?: { totalSidecars: number; groups: SidecarGroup[] } }> } };
        }).pdr?.takeout?.getSidecarSummary?.();
        const groups = summaryRes?.data?.groups ?? [];
        const scannedGroupCount = new Map<string, number>();
        for (const g of groups) scannedGroupCount.set(g.groupId, g.zipCount);

        const zipsPerGroupInSources = new Map<string, number>();
        for (const c of candidates) {
          zipsPerGroupInSources.set(c.groupId, (zipsPerGroupInSources.get(c.groupId) ?? 0) + 1);
        }

        const stillNeeded = candidates.filter((c) => {
          const scanned = scannedGroupCount.get(c.groupId) ?? 0;
          const inSources = zipsPerGroupInSources.get(c.groupId) ?? 0;
          return scanned < inSources;
        });

        if (!cancelled) {
          setUnscannedZips(stillNeeded);
          setLoaded(true);
        }
      } catch (e) {
        console.warn('[TakeoutMultiPartBanner] probe failed:', e);
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleScanNow = async () => {
    if (unscannedZips.length === 0) return;
    setScanning(true);

    const totalZips = unscannedZips.length;
    const toastId = toast.loading(`Pre-scanning ${totalZips} Takeout part${totalZips === 1 ? '' : 's'}…`, {
      description: 'Reading JSON sidecars only — no photos are extracted.',
    });

    // Subscribe to per-zip progress before firing the IPC so the
    // first event isn't missed. Returns an unsubscribe; we call it
    // on completion + on failure.
    const unsubscribe = (window as Window & {
      pdr?: { takeout?: { onPreScanProgress?: (cb: (p: { zipPath: string; zipIndex: number; zipCount: number; scanned: number; inserted: number }) => void) => () => void } };
    }).pdr?.takeout?.onPreScanProgress?.((p) => {
      const zipName = p.zipPath.split(/[\\/]/).pop() ?? p.zipPath;
      const idx = p.zipIndex + 1;
      toast.loading(`Pre-scanning ${totalZips} Takeout part${totalZips === 1 ? '' : 's'}…`, {
        id: toastId,
        description: `Part ${idx} of ${p.zipCount} — ${zipName} — ${p.inserted.toLocaleString()} sidecars cached`,
      });
    });

    try {
      const res = await (window as Window & {
        pdr?: { takeout?: { preScanSidecars?: (zipPaths: string[]) => Promise<{ success: boolean; error?: string; data?: { totalSeen: number; totalInserted: number; totalErrors: number; totalElapsedMs: number } }> } };
      }).pdr?.takeout?.preScanSidecars?.(unscannedZips.map((z) => z.source.path));
      unsubscribe?.();
      if (res?.success && res.data) {
        toast.success(`Cached ${res.data.totalInserted.toLocaleString()} Takeout sidecars`, {
          id: toastId,
          description: 'Future analyses will use this metadata for every photo across all your Takeout parts.',
        });
        // Banner clears itself once the scan completes. Re-probe to
        // confirm nothing's left unscanned.
        setUnscannedZips([]);
        // Broadcast so the LDM panel (when open) can refresh its
        // Takeout-metadata row without the user closing and reopening.
        window.dispatchEvent(new CustomEvent('pdr:takeoutSidecarsUpdated'));
      } else {
        toast.error('Pre-scan failed', { id: toastId, description: res?.error ?? 'See Help & Support for next steps.' });
      }
    } catch (e) {
      unsubscribe?.();
      toast.error('Pre-scan failed', { id: toastId, description: (e as Error).message });
    } finally {
      setScanning(false);
    }
  };

  const handleDismiss = () => {
    if (scanning) return;
    sessionStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  if (!loaded || dismissed || unscannedZips.length === 0) return null;

  // Group by group id for the body copy so a 3-part Takeout reads
  // as "3 parts" not "3 ZIPs from one export."
  const groupIds = new Set(unscannedZips.map((z) => z.groupId));
  const groupCount = groupIds.size;
  const zipCount = unscannedZips.length;

  return (
    <section
      className="mb-6 rounded-xl border border-primary/30 bg-gradient-to-r from-primary/10 to-primary/5 p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300"
      data-testid="takeout-multipart-banner"
    >
      <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
        <Package className="w-5 h-5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-h2 text-foreground inline-flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          {zipCount === 1
            ? 'This looks like part of a multi-part Google Takeout'
            : `${groupCount === 1 ? `${zipCount} parts of a Google Takeout` : `${zipCount} Takeout parts across ${groupCount} exports`} are ready to enrich`}
        </p>
        <p className="text-body-muted mt-1">
          Google splits photos and their date sidecars across different zips of the same export.
          PDR can read each zip&apos;s JSON metadata <strong className="text-foreground">without extracting any photos</strong> &mdash;
          minutes per part &mdash; so every photo gets its precise date regardless of which zip it lives in.
          {' '}<span className="text-xs italic">You can run this any time later from Library Drive Manager &rarr; Takeout metadata.</span>
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button onClick={handleScanNow} variant="primary" size="sm" disabled={scanning} data-testid="takeout-banner-scan">
          {scanning ? 'Scanning…' : 'Pre-scan now'}
        </Button>
        <IconTooltip label="Dismiss for this session" side="top">
          <button
            onClick={handleDismiss}
            disabled={scanning}
            className="p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            aria-label="Dismiss Takeout banner"
            data-testid="takeout-banner-dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </IconTooltip>
      </div>
    </section>
  );
}
