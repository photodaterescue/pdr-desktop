import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Package, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';

// TakeoutMetadataSection — v2.0.13 Library Drive Manager subsection.
// Permanent home for the Takeout-sidecar cache that powers the cross-
// part date lookup. Visible whenever the LDM is open, regardless of
// whether the source-menu banner has been dismissed.
//
// Why this exists (Terry 2026-05-26 — "It should also mention where to
// continue with this if the banner is dismissed"):
//   The source-menu banner is a transient prompt. A user who dismisses
//   it for the session still needs a way to (a) see what's already
//   been scanned, (b) trigger a scan for more parts they add later,
//   (c) re-run the enrichment pass when new parts arrive.
//
// What it shows:
//   - Total sidecars cached across all groups, with a one-line
//     summary of the most recent scan.
//   - A row per Takeout group (each export the user has scanned)
//     showing the group id (the export's timestamp), number of zips
//     contributing sidecars, and total sidecar count.
//   - "Scan another Takeout part" button → opens an OS file picker
//     for one or more zips → fires the pre-scan IPC.
//   - "Run Enrichment" button (Phase 3) → opens the Enriching modal
//     to apply cached sidecar data to _RC / _MK files in the library.
//
// When the cache is empty (no scans run yet) we show a single-line
// empty state with the "Scan first Takeout part" CTA so the section
// always has an entry point.

interface SidecarGroup {
  groupId: string;
  sidecarCount: number;
  zipCount: number;
  lastScannedAt: string;
}

interface SidecarSummary {
  totalSidecars: number;
  groups: SidecarGroup[];
}

interface LatestEnrichmentRun {
  finishedAt: string;
  upgraded: number;
  dedupedDuplicates: number;
  distinctCollisions: number;
  errors: number;
}

function formatScannedDate(iso: string): string {
  try {
    const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
    if (isNaN(d.getTime())) return iso;
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.round(diffMs / 60_000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function prettyGroupId(groupId: string): string {
  // "20260503T203552Z" → "3 May 2026, 20:35"
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\d*Z$/.exec(groupId);
  if (!m) return groupId;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [, y, mm, dd, hh, mn] = m;
  return `${parseInt(dd, 10)} ${months[parseInt(mm, 10) - 1]} ${y}, ${hh}:${mn}`;
}

export function TakeoutMetadataSection() {
  const [summary, setSummary] = useState<SidecarSummary | null>(null);
  const [latestRun, setLatestRun] = useState<LatestEnrichmentRun | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [scanning, setScanning] = useState(false);
  // v2.0.13 (Terry 2026-05-26): the explainer text was too long for a
  // section that the user has already understood after one read. Show
  // a one-line summary by default; the full "what is this / can I
  // delete the zips / what about multiple accounts" detail collapses
  // behind a "What is this?" toggle.
  const [showDetail, setShowDetail] = useState(false);

  const refresh = async () => {
    try {
      const res = await (window as Window & {
        pdr?: { takeout?: { getSidecarSummary?: () => Promise<{ success: boolean; data?: SidecarSummary }> } };
      }).pdr?.takeout?.getSidecarSummary?.();
      if (res?.success && res.data) {
        setSummary(res.data);
      } else {
        setSummary({ totalSidecars: 0, groups: [] });
      }
    } catch (e) {
      console.warn('[TakeoutMetadataSection] refresh failed:', e);
      setSummary({ totalSidecars: 0, groups: [] });
    }
    // v2.0.13 (Terry 2026-05-26) — fetch the most recent enrichment
    // run summary so the "Last enriched X ago — N upgraded" line
    // under the export-group list reflects current state. Hidden
    // entirely if no run has ever finished.
    try {
      const er = await (window as Window & {
        pdr?: { enrich?: { getLatestRun?: () => Promise<{ success: boolean; data?: LatestEnrichmentRun | null }> } };
      }).pdr?.enrich?.getLatestRun?.();
      if (er?.success && er.data) {
        setLatestRun(er.data);
      } else {
        setLatestRun(null);
      }
    } catch (e) {
      console.warn('[TakeoutMetadataSection] latest-run fetch failed:', e);
      setLatestRun(null);
    }
    setLoaded(true);
  };

  useEffect(() => {
    refresh();
    // Re-fetch whenever the source-menu banner or any other surface
    // dispatches the "sidecars updated" event after a successful scan,
    // AND when the Enrichment pass finishes (Terry 2026-05-26 — the
    // section showed "scanned 54m ago" stale data after enrichment
    // completed because we forgot to invalidate the summary).
    const handler = () => { void refresh(); };
    window.addEventListener('pdr:takeoutSidecarsUpdated', handler);
    window.addEventListener('pdr:takeoutEnrichmentComplete', handler);
    return () => {
      window.removeEventListener('pdr:takeoutSidecarsUpdated', handler);
      window.removeEventListener('pdr:takeoutEnrichmentComplete', handler);
    };
  }, []);

  const handleScanAddMore = async () => {
    // v2.0.13 (Terry 2026-05-26) — uses PDR's branded FolderBrowserModal
    // via the workspace's pdr:pickTakeoutZipForCache event bridge.
    // Single-zip per click; user can click "Scan another Takeout part"
    // again to add more parts. This replaces the Windows-native
    // openTakeoutZips dialog that shipped with Phase 2.
    const pickedPath = await new Promise<string | null>((resolve) => {
      const handler = (e: Event) => {
        window.removeEventListener('pdr:takeoutZipForCachePicked', handler);
        const detail = (e as CustomEvent<{ path: string | null }>).detail ?? {};
        resolve(typeof detail.path === 'string' && detail.path.length > 0 ? detail.path : null);
      };
      window.addEventListener('pdr:takeoutZipForCachePicked', handler);
      window.dispatchEvent(new CustomEvent('pdr:pickTakeoutZipForCache'));
    });
    if (!pickedPath) return;

    const zips = [pickedPath];
    setScanning(true);
    const toastId = toast.loading(`Pre-scanning ${zips.length} Takeout part${zips.length === 1 ? '' : 's'}…`, {
      description: 'Reading JSON sidecars only — no photos are extracted.',
    });
    const unsubscribe = (window as Window & {
      pdr?: { takeout?: { onPreScanProgress?: (cb: (p: { zipPath: string; zipIndex: number; zipCount: number; scanned: number; inserted: number }) => void) => () => void } };
    }).pdr?.takeout?.onPreScanProgress?.((p) => {
      const zipName = p.zipPath.split(/[\\/]/).pop() ?? p.zipPath;
      toast.loading(`Pre-scanning ${zips.length} Takeout part${zips.length === 1 ? '' : 's'}…`, {
        id: toastId,
        description: `Part ${p.zipIndex + 1} of ${p.zipCount} — ${zipName} — ${p.inserted.toLocaleString()} sidecars cached`,
      });
    });
    try {
      const scanRes = await (window as Window & {
        pdr?: { takeout?: { preScanSidecars?: (zipPaths: string[]) => Promise<{ success: boolean; error?: string; data?: { totalInserted: number } }> } };
      }).pdr?.takeout?.preScanSidecars?.(zips);
      unsubscribe?.();
      if (scanRes?.success && scanRes.data) {
        toast.success(`Cached ${scanRes.data.totalInserted.toLocaleString()} new sidecars`, { id: toastId });
        await refresh();
        window.dispatchEvent(new CustomEvent('pdr:takeoutSidecarsUpdated'));
      } else {
        toast.error('Pre-scan failed', { id: toastId, description: scanRes?.error ?? 'See Help & Support for next steps.' });
      }
    } catch (e) {
      unsubscribe?.();
      toast.error('Pre-scan failed', { id: toastId, description: (e as Error).message });
    } finally {
      setScanning(false);
    }
  };

  const handleEnrichLibrary = () => {
    window.dispatchEvent(new CustomEvent('pdr:openEnrichingModal'));
  };

  if (!loaded) return null;

  const empty = !summary || summary.totalSidecars === 0;

  return (
    <div className="pt-2 border-t border-border space-y-2.5">
      <p className="text-caption uppercase tracking-wider">Takeout metadata</p>
      {empty ? (
        <div className="rounded-xl border border-border bg-secondary/30 p-3 space-y-2">
          <div className="flex items-start gap-2.5">
            <Package className="w-4 h-4 text-primary shrink-0 mt-0.5" />
            <p className="text-body text-foreground leading-snug">
              No Google Takeout sidecars cached yet. Pre-scan a multi-part export here to give every photo
              its precise date &mdash; no extraction needed.
            </p>
          </div>
          <Button onClick={handleScanAddMore} variant="primary" size="sm" disabled={scanning} data-testid="takeout-metadata-scan-first">
            <Plus className="w-4 h-4 mr-1.5" />
            {scanning ? 'Scanning…' : 'Scan first Takeout part'}
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-secondary/30 p-3 space-y-2.5">
          <div className="flex items-start gap-2.5">
            <Sparkles className="w-4 h-4 text-primary shrink-0 mt-0.5" />
            <div className="text-body text-foreground leading-snug flex-1 min-w-0">
              <p>
                <strong className="font-medium">{summary!.totalSidecars.toLocaleString()}</strong> sidecars cached
                across {summary!.groups.length} export{summary!.groups.length === 1 ? '' : 's'}.
              </p>
              <button
                type="button"
                onClick={() => setShowDetail((v) => !v)}
                className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                data-testid="takeout-metadata-detail-toggle"
              >
                {showDetail ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                What is this?
              </button>
              {showDetail && (
                <div className="mt-2 text-xs text-muted-foreground leading-relaxed space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
                  <p>The cache holds Google&apos;s sidecar JSONs &mdash; the dates, GPS, and captions that ride alongside your photos in a Takeout. Used to fill in metadata for photos that don&apos;t carry their own JSON sidecar in the part you&apos;re analyzing.</p>
                  <p>Only the JSON metadata is stored here &mdash; not the photo bytes. You can safely delete the original Takeout zips after they&apos;ve been scanned.</p>
                  <p>Adding Takeouts from another Google account creates a separate export group below; they never overwrite each other.</p>
                </div>
              )}
            </div>
          </div>
          <ul className="space-y-1 pl-6">
            {summary!.groups.map((g) => (
              <li key={g.groupId} className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                <span className="text-foreground font-medium">{prettyGroupId(g.groupId)}</span>
                <span>&mdash;</span>
                <span>{g.sidecarCount.toLocaleString()} sidecars from {g.zipCount} zip{g.zipCount === 1 ? '' : 's'}</span>
                <span>&middot;</span>
                <span>scanned {formatScannedDate(g.lastScannedAt)}</span>
              </li>
            ))}
          </ul>
          {latestRun && (
            <p className="text-xs text-muted-foreground pl-6" data-testid="takeout-metadata-last-enriched">
              Last enriched {formatScannedDate(latestRun.finishedAt)} &mdash;{' '}
              <span className="text-foreground font-medium">{latestRun.upgraded.toLocaleString()}</span>{' '}
              file{latestRun.upgraded === 1 ? '' : 's'} upgraded.
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <Button onClick={handleScanAddMore} variant="secondary" size="sm" disabled={scanning} data-testid="takeout-metadata-scan-more">
              {scanning ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-1.5 animate-spin" />
                  Scanning…
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4 mr-1.5" />
                  Scan another Takeout part
                </>
              )}
            </Button>
            <IconTooltip
              label="Apply the cached sidecars to existing _RC and _MK files in your library — never overrides anything you've manually curated."
              side="top"
            >
              <Button onClick={handleEnrichLibrary} variant="primary" size="sm" disabled={scanning} data-testid="takeout-metadata-enrich">
                <Sparkles className="w-4 h-4 mr-1.5" />
                Run Enrichment
              </Button>
            </IconTooltip>
          </div>
        </div>
      )}
    </div>
  );
}
