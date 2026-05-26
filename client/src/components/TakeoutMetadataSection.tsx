import { useEffect, useState } from 'react';
import { Package, Plus, RefreshCw, Sparkles } from 'lucide-react';
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
  const [loaded, setLoaded] = useState(false);
  const [scanning, setScanning] = useState(false);

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
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    refresh();
    // Re-fetch whenever the source-menu banner or any other surface
    // dispatches the "sidecars updated" event after a successful scan.
    const handler = () => { void refresh(); };
    window.addEventListener('pdr:takeoutSidecarsUpdated', handler);
    return () => window.removeEventListener('pdr:takeoutSidecarsUpdated', handler);
  }, []);

  const handleScanAddMore = async () => {
    // Open a multi-select file picker for .zip files. The native
    // dialog returns paths the renderer can pass straight to the
    // pre-scan IPC.
    const res = await (window as Window & {
      pdr?: { openTakeoutZips?: () => Promise<{ success: boolean; data?: string[] }> };
    }).pdr?.openTakeoutZips?.();
    if (!res?.success || !res.data || res.data.length === 0) return;

    const zips = res.data;
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
    // Wired in Phase 3 when the Enriching modal exists. For now fire
    // a custom event so workspace.tsx can intercept and open the
    // modal once it ships; in the meantime show a tooltip so this
    // button doesn't look broken when clicked before the modal lands.
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
            <p className="text-body text-foreground leading-snug">
              <strong className="font-medium">{summary!.totalSidecars.toLocaleString()}</strong> sidecars cached
              across {summary!.groups.length} export{summary!.groups.length === 1 ? '' : 's'}. Used to fill in
              precise dates and metadata for photos that don&apos;t carry their own JSON sidecar in the part
              you&apos;re analysing.
            </p>
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
