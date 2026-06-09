// MemoriesPendingView — v2.1 round 67 (Terry 2026-06-09).
//
// "Pending" page for files PDR couldn't date with confidence (i.e.
// confidence='marked' rows). Reached via the Pending entry at the top
// of the Memories — Dates left rail. Three quality tiers — Tentative,
// Placeholder, Unrecorded — see PENDING_TIER_SQL in
// electron/search-database.ts for the classification logic.
//
// Page chrome mirrors the Memories Dates drilldown so the user sees a
// familiar shape: back-to-timeline button, title + breakdown subhead,
// density toggle, photo-grid body grouped into tier sections (when
// scope='all') or a single section (when scope to one tier). Right-
// side preview panel, date editing, write-back, and the All-media /
// Insights chrome are deliberately OUT OF SCOPE for this first cut —
// Terry's call 2026-06-09: ship the surface so we can see how the
// page lands, then iterate the date-editing UX once it does.
//
// Live update path: when the (future) date-editor mutates a file's
// confidence away from 'marked', dispatch `pdr:pendingChanged` and
// this view will refetch. For now the only mutation surface is the
// user opening a file in the Viewer (no date change yet), so the
// refresh contract is in place but mostly idle.

import { useState, useEffect, useMemo } from 'react';
import { ArrowLeft, Loader2, Film, ImageIcon, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/custom-button';
import { DensityToggle, type Density } from '@/components/ui/density-toggle';
import {
  getPendingFiles,
  getThumbnail,
  type PendingFile,
  type PendingTier,
  type PendingCounts,
} from '@/lib/electron-bridge';
import { CaptionBadge } from '@/components/CaptionBadge';
import { TranscriptBadge } from '@/components/TranscriptBadge';
import { useTranscribedFileIds } from '@/hooks/useTranscribedFileIds';

const TIER_LABEL: Record<PendingTier, string> = {
  tentative: 'Tentative',
  placeholder: 'Placeholder',
  unrecorded: 'Unrecorded',
};

const TIER_BLURB: Record<PendingTier, string> = {
  tentative:
    'PDR has a date from a filesystem timestamp (mtime / archive entry). Might be the real date — might be the date of a later copy.',
  placeholder:
    'PDR has a date that almost certainly refers to the wrong event (scan time, not photo date). A stand-in awaiting the real value.',
  unrecorded:
    'PDR found no date anywhere — no EXIF, no XMP, no Takeout sidecar, no filename pattern, no fallback. You’ll need to supply one.',
};

interface MemoriesPendingViewProps {
  /** Optional tier scope. Undefined → show all three tiers as sequential
   *  sections in the page. Set → show just that one tier. */
  tier?: PendingTier;
  /** Active library filter (runIds from the wrapper). Pending file list
   *  honours this so the page matches the rest of Memories' library
   *  scoping. The COUNT badge in the rail stays global. */
  runIds: number[] | undefined;
  /** Current density (Spacious / Tight) from the wrapper state. */
  density: Density;
  onDensityChange: (d: Density) => void;
  /** Returns the user to the Timeline view. */
  onBack: () => void;
  /** Pre-fetched global counts for the breakdown subhead. The list
   *  fetched inside this component may be filtered by library + tier
   *  and so won't match these numbers — the subhead is the GLOBAL
   *  truth so the user always sees their full backlog. */
  counts: PendingCounts;
}

export default function MemoriesPendingView({
  tier,
  runIds,
  density,
  onDensityChange,
  onBack,
  counts,
}: MemoriesPendingViewProps) {
  const [files, setFiles] = useState<PendingFile[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [transcribedFileIds] = useTranscribedFileIds();

  // Fetch pending files on mount + whenever scope or library changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getPendingFiles({ runIds, tier }).then((res) => {
      if (cancelled) return;
      setFiles(res.success && res.data ? res.data : []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [tier, runIds]);

  // Bulk thumbnail prewarm (concurrency 4, capped at 200 to keep the
  // first paint fast on huge Pending lists). Matches the MemoriesView
  // monthly drilldown's thumbnail prewarm shape.
  useEffect(() => {
    if (!files) return;
    let cancelled = false;
    const toLoad = files.filter((f) => !thumbs[f.file_path]).slice(0, 200);
    let active = 0;
    let i = 0;
    const next = () => {
      if (cancelled) return;
      while (active < 4 && i < toLoad.length) {
        const file = toLoad[i++];
        active++;
        void getThumbnail(file.file_path, 220)
          .then((r) => {
            if (cancelled) return;
            if (r.success && r.dataUrl) {
              setThumbs((prev) => ({ ...prev, [file.file_path]: r.dataUrl }));
            }
          })
          .finally(() => {
            active--;
            if (!cancelled) next();
          });
      }
    };
    next();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  // Group files by tier for the all-tiers view; single section when scoped.
  const sections = useMemo(() => {
    if (!files) return [] as Array<[PendingTier, PendingFile[]]>;
    if (tier) return [[tier, files]] as Array<[PendingTier, PendingFile[]]>;
    const groups: Array<[PendingTier, PendingFile[]]> = [];
    for (const t of ['tentative', 'placeholder', 'unrecorded'] as PendingTier[]) {
      const subset = files.filter((f) => f.pending_tier === t);
      if (subset.length > 0) groups.push([t, subset]);
    }
    return groups;
  }, [files, tier]);

  // Build the breakdown subhead — global counts (zero tiers omitted).
  const breakdownParts: string[] = [];
  if (counts.tentative > 0)
    breakdownParts.push(`${counts.tentative.toLocaleString()} tentative`);
  if (counts.placeholder > 0)
    breakdownParts.push(`${counts.placeholder.toLocaleString()} placeholder`);
  if (counts.unrecorded > 0)
    breakdownParts.push(`${counts.unrecorded.toLocaleString()} unrecorded`);
  const breakdownText = tier
    ? `${(counts[tier] ?? 0).toLocaleString()} ${TIER_LABEL[tier]} files awaiting your decision`
    : breakdownParts.join(' · ');

  const tileGap = density === 'tight' ? 'gap-0' : 'gap-3';
  const tileRing = density === 'tight' ? '' : 'rounded-xl ring-1 ring-border';

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header bar — mirrors the day-drilldown header pattern so the
          page reads as part of the Memories — Dates family. */}
      <div className="px-6 py-3 flex items-center gap-4 flex-wrap border-b border-border/60">
        <Button variant="secondary" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to timeline
        </Button>
        <div className="flex flex-col min-w-0">
          <h1 className="text-lg font-semibold text-foreground leading-tight">
            {tier ? `Pending · ${TIER_LABEL[tier]}` : 'Pending'}
          </h1>
          {breakdownText && (
            <p className="text-xs text-muted-foreground">{breakdownText}</p>
          )}
        </div>
        <div className="flex-1" />
        <DensityToggle value={density} onChange={onDensityChange} />
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading && !files ? (
          <div className="flex items-center justify-center h-64 text-muted-foreground gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading Pending files…</span>
          </div>
        ) : sections.length === 0 ? (
          /* Celebratory empty state — Terry 2026-06-09: hitting zero
             Pending is a milestone worth marking, not silently
             vanishing. */
          <div className="text-center py-16">
            <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-purple-500" />
            <h2 className="text-base font-semibold text-foreground mb-1">
              All caught up
            </h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              No files are pending your date review
              {tier ? ` in the ${TIER_LABEL[tier]} tier` : ''} for the current
              library selection.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {sections.map(([sectionTier, sectionFiles]) => (
              <section key={sectionTier}>
                {/* Tier header — sticky so it stays visible while the
                    user scans the tiles below. Purple tint to mirror
                    the PM "AI / PDR-derived" colour family the
                    OnThisDay strip uses. */}
                <div className="flex items-baseline gap-3 mb-3 sticky top-0 bg-background/95 backdrop-blur py-2 z-10">
                  <h2 className="text-sm font-bold uppercase tracking-wider text-purple-600 dark:text-purple-300">
                    {TIER_LABEL[sectionTier]}
                  </h2>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {sectionFiles.length.toLocaleString()}{' '}
                    {sectionFiles.length === 1 ? 'file' : 'files'}
                  </span>
                  <span className="text-[10px] text-muted-foreground/80 italic flex-1 truncate">
                    {TIER_BLURB[sectionTier]}
                  </span>
                </div>
                <div
                  className={`grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] ${tileGap}`}
                >
                  {sectionFiles.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`group cursor-pointer relative aspect-square bg-secondary/30 overflow-hidden ${tileRing} hover:ring-primary/50 transition-all`}
                      title={f.filename}
                    >
                      {thumbs[f.file_path] ? (
                        <img
                          src={thumbs[f.file_path]}
                          alt={f.filename}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground/70">
                          {f.file_type === 'video' ? (
                            <Film className="w-6 h-6" />
                          ) : (
                            <ImageIcon className="w-6 h-6" />
                          )}
                        </div>
                      )}
                      {f.file_type === 'video' && (
                        <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[9px] font-medium flex items-center gap-1">
                          <Film className="w-2.5 h-2.5" /> Video
                        </div>
                      )}
                      <CaptionBadge caption={f.caption} />
                      <TranscriptBadge
                        hasTranscript={
                          f.file_type === 'video' &&
                          transcribedFileIds.has(f.id)
                        }
                        hasCaption={!!f.caption}
                      />
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
