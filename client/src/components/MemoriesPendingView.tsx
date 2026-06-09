// MemoriesPendingView — v2.1 round 68 (Terry 2026-06-09).
//
// "Pending" page for files PDR couldn't date with confidence (i.e.
// confidence='marked' rows). Reached via the Pending entry at the top
// of the Memories — Dates left rail. Three quality tiers — Tentative,
// Placeholder, Unrecorded — see PENDING_TIER_SQL in
// electron/search-database.ts for the classification logic.
//
// Round 68 update: page chrome now matches Memories — Dates drilldown
// almost 1:1 — the left year rail (with Pending sticky at the top as
// the active entry), the All-media filter chip, the Insights popover,
// the density toggle. Page title is itself a dropdown that lets the
// user switch between All / Tentative / Placeholder / Unrecorded
// without going back to the rail. Date editing is still OUT OF SCOPE
// — Terry: "ship the surface so we can see how it lands, then iterate
// the date-editing UX once it does."

import { useState, useEffect, useMemo } from 'react';
import {
  ArrowLeft,
  Loader2,
  Film,
  ImageIcon,
  CheckCircle2,
  ChevronDown,
  Info,
  Files,
  MessageSquareText,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from '@/components/ui/custom-button';
import { DensityToggle, type Density } from '@/components/ui/density-toggle';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { IconTooltip } from '@/components/ui/icon-tooltip';
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

type TileMetaField = 'filename' | 'date';

interface MemoriesPendingViewProps {
  tier?: PendingTier;
  runIds: number[] | undefined;
  density: Density;
  onDensityChange: (d: Density) => void;
  onBack: () => void;
  counts: PendingCounts;
  /** Years available in the user's library, passed from the wrapper
   *  so the Pending page can render the same year rail as the
   *  timeline view (Terry: "should still be visible to keep that
   *  consistency"). */
  years: number[];
  /** Clicking a year on the Pending rail leaves Pending and jumps
   *  to that year on the timeline. */
  onJumpToYear: (year: number) => void;
  /** Switch the current tier scope (All / Tentative / Placeholder /
   *  Unrecorded) without leaving the page. Called from the title
   *  dropdown. */
  onChangeTier: (tier: PendingTier | undefined) => void;
}

export default function MemoriesPendingView({
  tier,
  runIds,
  density,
  onDensityChange,
  onBack,
  counts,
  years,
  onJumpToYear,
  onChangeTier,
}: MemoriesPendingViewProps) {
  const [files, setFiles] = useState<PendingFile[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [transcribedFileIds] = useTranscribedFileIds();

  // Round 68 — All-media chip state (mirror Memories — Dates).
  const [mediaFilter, setMediaFilter] = useState<'all' | 'photos' | 'videos'>('all');
  const [captionedOnly, setCaptionedOnly] = useState(false);

  // Round 68 — Insights popover state (mirror Memories — Dates).
  const [tileSizeSlider, setTileSizeSlider] = useState<number>(35);
  const [selectionMode, setSelectionMode] = useState(false);
  const [metaFields, setMetaFields] = useState<TileMetaField[]>([]);

  // Title dropdown for tier scope switching.
  const [titleOpen, setTitleOpen] = useState(false);

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

  // Bulk thumbnail prewarm (concurrency 4, capped at 200).
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

  // Apply the All-media chip's filters (media type + captioned only)
  // to the raw fetched list. Done in-memory because the page is
  // already scoped server-side to confidence='marked'; secondary
  // filters are cheap to compute on the result set.
  const visibleFiles = useMemo(() => {
    if (!files) return null;
    let out = files;
    if (mediaFilter === 'photos') out = out.filter((f) => f.file_type === 'photo');
    else if (mediaFilter === 'videos') out = out.filter((f) => f.file_type === 'video');
    if (captionedOnly) out = out.filter((f) => !!f.caption && f.caption.length > 0);
    return out;
  }, [files, mediaFilter, captionedOnly]);

  // Group visible files by tier for the all-tiers view; single
  // section when scoped via the title dropdown / rail sub-entry.
  const sections = useMemo(() => {
    if (!visibleFiles) return [] as Array<[PendingTier, PendingFile[]]>;
    if (tier) return [[tier, visibleFiles]] as Array<[PendingTier, PendingFile[]]>;
    const groups: Array<[PendingTier, PendingFile[]]> = [];
    for (const t of ['tentative', 'placeholder', 'unrecorded'] as PendingTier[]) {
      const subset = visibleFiles.filter((f) => f.pending_tier === t);
      if (subset.length > 0) groups.push([t, subset]);
    }
    return groups;
  }, [visibleFiles, tier]);

  // Breakdown subhead — global counts, zero tiers omitted.
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

  // All-media chip label — mirrors Memories — Dates labelling.
  const totalVisible = visibleFiles?.length ?? 0;
  const totalAvailable = files?.length ?? 0;
  const photoCount = files?.filter((f) => f.file_type === 'photo').length ?? 0;
  const videoCount = files?.filter((f) => f.file_type === 'video').length ?? 0;
  const captionedCount =
    files?.filter((f) => {
      if (!f.caption || f.caption.length === 0) return false;
      if (mediaFilter === 'photos') return f.file_type === 'photo';
      if (mediaFilter === 'videos') return f.file_type === 'video';
      return true;
    }).length ?? 0;
  const mediaDefault = mediaFilter === 'all' && !captionedOnly;
  let mediaChipLabel: string;
  if (mediaDefault) mediaChipLabel = `All media · ${totalAvailable.toLocaleString()}`;
  else if (mediaFilter === 'photos' && !captionedOnly)
    mediaChipLabel = `Photos · ${photoCount.toLocaleString()}`;
  else if (mediaFilter === 'videos' && !captionedOnly)
    mediaChipLabel = `Videos · ${videoCount.toLocaleString()}`;
  else if (mediaFilter === 'all' && captionedOnly)
    mediaChipLabel = `Captioned · ${totalVisible.toLocaleString()}`;
  else
    mediaChipLabel = `${mediaFilter === 'photos' ? 'Photos' : 'Videos'} + Captioned · ${totalVisible.toLocaleString()}`;
  const ChipIcon =
    mediaFilter === 'photos' && !captionedOnly
      ? ImageIcon
      : mediaFilter === 'videos' && !captionedOnly
        ? Film
        : captionedOnly && mediaFilter === 'all'
          ? MessageSquareText
          : Files;

  const insightsCount = (selectionMode ? 1 : 0) + metaFields.length;
  const insightsActive = insightsCount > 0;

  // Tile size + grid gap mirror MemoriesView — Dates drilldown.
  const drilldownTilePx = (slider: number): number => {
    const min = 100;
    const max = 320;
    return Math.round(min + ((max - min) * slider) / 100);
  };
  const tilePx = drilldownTilePx(tileSizeSlider);
  const tileGap = density === 'tight' ? 'gap-0' : 'gap-3';
  const tileRing = density === 'tight' ? '' : 'rounded-xl ring-1 ring-border';
  const showFilename = metaFields.includes('filename');
  const showDate = metaFields.includes('date');

  // The title-dropdown options. All scope first, then per-tier in
  // the agreed confidence cascade order.
  const titleOptions: Array<{ key: PendingTier | undefined; label: string; count: number }> = [
    { key: undefined, label: 'All', count: counts.total },
    { key: 'tentative', label: 'Tentative', count: counts.tentative },
    { key: 'placeholder', label: 'Placeholder', count: counts.placeholder },
    { key: 'unrecorded', label: 'Unrecorded', count: counts.unrecorded },
  ];

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left rail — mirrors Memories — Dates timeline rail. Pending
          is sticky at the top with an active treatment (since the
          user is currently here); below it sit the year buttons,
          clicking any of them leaves Pending and jumps to that year
          on the timeline (per Terry's "should still be visible to
          keep that consistency"). */}
      {(years.length > 0 || counts.total > 0) && (
        <aside className="w-[68px] shrink-0 border-r border-border/60 overflow-y-auto py-4 px-1 text-center">
          <div
            className="w-full px-1 py-1.5 mb-0.5 rounded text-xs font-semibold text-purple-600 dark:text-purple-300 bg-purple-500/15 inline-flex items-center justify-center gap-1"
            data-testid="memories-rail-pending-active"
          >
            <span>Pending</span>
            <span
              className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse"
              aria-hidden="true"
            />
          </div>
          <div className="border-t border-border/60 my-1 mx-1" />
          {years.map((y) => (
            <IconTooltip key={y} label={`Jump to ${y}`} side="right">
              <button
                onClick={() => onJumpToYear(y)}
                className="w-full px-1 py-1.5 mb-0.5 rounded text-xs font-mono text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
              >
                {y}
              </button>
            </IconTooltip>
          ))}
        </aside>
      )}

      <div className="flex-1 flex flex-col min-h-0">
        {/* Header — mirrors the Memories drilldown header so the page
            reads as part of the Memories — Dates family. */}
        <div className="px-6 py-3 flex items-center gap-3 flex-wrap border-b border-border/60">
          <Button variant="secondary" size="sm" onClick={onBack} className="gap-1.5">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to timeline
          </Button>

          {/* Title dropdown — All / Tentative / Placeholder / Unrecorded.
              Mirrors the month-picker dropdown on the day drilldown
              (clickable title with a chevron, popover shows options
              with counts). */}
          <Popover open={titleOpen} onOpenChange={setTitleOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-purple-500/10 hover:bg-purple-500/15 text-sm font-semibold text-purple-700 dark:text-purple-200 transition-colors"
                data-testid="memories-pending-title-dropdown"
              >
                <span>Pending{tier ? ` · ${TIER_LABEL[tier]}` : ''}</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-70" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-1">
              <RadioGroup
                value={tier ?? 'all'}
                onValueChange={(v) => {
                  setTitleOpen(false);
                  onChangeTier(v === 'all' ? undefined : (v as PendingTier));
                }}
                className="gap-0"
              >
                {titleOptions.map((opt) => {
                  const key = opt.key ?? 'all';
                  return (
                    <label
                      key={key}
                      htmlFor={`pending-title-${key}`}
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm cursor-pointer hover:bg-muted/50 transition-colors"
                      data-testid={`memories-pending-title-${key}`}
                    >
                      <span className="text-foreground">{opt.label}</span>
                      <span className="inline-flex items-center gap-3">
                        <span className="text-xs text-muted-foreground tabular-nums">{opt.count.toLocaleString()}</span>
                        <RadioGroupItem id={`pending-title-${key}`} value={key} />
                      </span>
                    </label>
                  );
                })}
              </RadioGroup>
            </PopoverContent>
          </Popover>

          {breakdownText && (
            <span className="text-xs text-muted-foreground">{breakdownText}</span>
          )}

          <div className="flex-1" />

          {/* All-media filter chip (mirrors Memories — Dates). */}
          <Popover>
            <IconTooltip label="Filter what's shown — Photos, Videos, Captioned" side="bottom">
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium transition-colors border ${
                    !mediaDefault
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'bg-background border-border text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                  data-testid="memories-pending-media-filter"
                >
                  <ChipIcon className="w-3.5 h-3.5" />
                  {mediaChipLabel}
                  <ChevronDown className="w-3 h-3 opacity-70" />
                </button>
              </PopoverTrigger>
            </IconTooltip>
            <PopoverContent align="start" className="w-64 p-1">
              <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider px-3 pt-2 pb-1">Type</p>
              <RadioGroup value={mediaFilter} onValueChange={(v) => setMediaFilter(v as 'all' | 'photos' | 'videos')} className="gap-0">
                {([
                  { key: 'all' as const, label: 'All media', Icon: Files, count: totalAvailable },
                  { key: 'photos' as const, label: 'Photos', Icon: ImageIcon, count: photoCount },
                  { key: 'videos' as const, label: 'Videos', Icon: Film, count: videoCount },
                ]).map(({ key, label, Icon, count }) => (
                  <label key={key} htmlFor={`pending-media-${key}`} className="flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm cursor-pointer hover:bg-muted/50 transition-colors">
                    <span className="inline-flex items-center gap-2 text-foreground">
                      <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                      {label}
                    </span>
                    <span className="inline-flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">{count.toLocaleString()}</span>
                      <RadioGroupItem id={`pending-media-${key}`} value={key} />
                    </span>
                  </label>
                ))}
              </RadioGroup>
              <div className="h-px bg-border my-1" />
              <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider px-3 pt-1 pb-1">Also filter</p>
              <label className={`flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm transition-colors ${captionedCount === 0 ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-muted/50'}`}>
                <span className="inline-flex items-center gap-2 text-foreground">
                  <MessageSquareText className="w-3.5 h-3.5 text-muted-foreground" />
                  Captions
                </span>
                <span className="inline-flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">{captionedCount.toLocaleString()}</span>
                  <Checkbox checked={captionedOnly} disabled={captionedCount === 0} onCheckedChange={(v) => setCaptionedOnly(!!v)} />
                </span>
              </label>
            </PopoverContent>
          </Popover>

          {/* Insights popover (mirrors Memories — Dates). */}
          <Popover>
            <IconTooltip label="View options — tile size, selection mode, photo info" side="bottom">
              <PopoverTrigger asChild>
                <Button variant={insightsActive ? 'secondary' : 'ghost'} size="sm" data-testid="memories-pending-insights">
                  <Info className="w-3.5 h-3.5 mr-1.5" />
                  Insights
                  {insightsActive && (
                    <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary/15 text-primary text-[10px] font-semibold tabular-nums">
                      {insightsCount}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
            </IconTooltip>
            <PopoverContent
              className="w-64 p-3"
              align="end"
              // Ctrl+wheel zoom keeps working while the popover is
              // open — same gesture S&D / Memories already support.
              onWheel={(e) => {
                if (!(e.ctrlKey || e.metaKey)) return;
                e.preventDefault();
                e.stopPropagation();
                setTileSizeSlider((prev) => Math.max(0, Math.min(100, prev + (e.deltaY < 0 ? 5 : -5))));
              }}
            >
              <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider mb-2">Tile size</p>
              <div className="flex items-center gap-1 mb-3">
                <button type="button" onClick={() => setTileSizeSlider((prev) => Math.max(0, prev - 10))} disabled={tileSizeSlider <= 0} className="flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" aria-label="Zoom out">
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <button type="button" onClick={() => setTileSizeSlider(35)} className="flex-1 text-xs font-medium text-foreground tabular-nums hover:bg-secondary/40 rounded py-1 transition-colors" aria-label="Reset zoom">
                  {tileSizeSlider}% <span className="text-muted-foreground/70 text-[10px]">(click to reset)</span>
                </button>
                <button type="button" onClick={() => setTileSizeSlider((prev) => Math.min(100, prev + 10))} disabled={tileSizeSlider >= 100} className="flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" aria-label="Zoom in">
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="border-t border-border my-2" />
              <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider mb-2">Selection mode</p>
              <label className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectionMode}
                  onChange={() => setSelectionMode((v) => !v)}
                  className="rounded border-border text-purple-500 focus:ring-purple-400/50"
                />
                <span className="text-sm text-foreground flex-1">Tile checkboxes</span>
              </label>
              <div className="border-t border-border my-2" />
              <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider mb-2">Show below each tile</p>
              {([
                { key: 'filename' as TileMetaField, label: 'Filename' },
                { key: 'date' as TileMetaField, label: 'Date' },
              ]).map((opt) => {
                const checked = metaFields.includes(opt.key);
                return (
                  <label key={opt.key} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/50 cursor-pointer">
                    <input type="checkbox" checked={checked} onChange={() => setMetaFields((prev) => checked ? prev.filter((f) => f !== opt.key) : [...prev, opt.key])} className="rounded border-border text-purple-500 focus:ring-purple-400/50" />
                    <span className="text-sm text-foreground flex-1">{opt.label}</span>
                  </label>
                );
              })}
              <p className="text-[10px] text-muted-foreground/85 px-2 pt-2 leading-snug">
                Tip: Hold <kbd className="px-1 py-0.5 rounded bg-secondary text-[9px] font-mono">Ctrl</kbd> + scroll over the grid to zoom.
              </p>
            </PopoverContent>
          </Popover>

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
            <div className="text-center py-16">
              <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-purple-500" />
              <h2 className="text-base font-semibold text-foreground mb-1">All caught up</h2>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                No files are pending your date review
                {tier ? ` in the ${TIER_LABEL[tier]} tier` : ''} for the current
                library + filter selection.
              </p>
            </div>
          ) : (
            <div className="space-y-8">
              {sections.map(([sectionTier, sectionFiles]) => (
                <section key={sectionTier}>
                  <div className="flex items-baseline gap-3 mb-3 sticky top-0 bg-background/95 backdrop-blur py-2 z-10">
                    <h2 className="text-sm font-bold uppercase tracking-wider text-purple-600 dark:text-purple-300">
                      {TIER_LABEL[sectionTier]}
                    </h2>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {sectionFiles.length.toLocaleString()} {sectionFiles.length === 1 ? 'file' : 'files'}
                    </span>
                    <span className="text-[10px] text-muted-foreground/80 italic flex-1 truncate">
                      {TIER_BLURB[sectionTier]}
                    </span>
                  </div>
                  <div
                    className={`grid ${tileGap}`}
                    style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tilePx}px, 1fr))` }}
                  >
                    {sectionFiles.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className={`group cursor-pointer relative aspect-square bg-secondary/30 overflow-hidden ${tileRing} hover:ring-primary/50 transition-all`}
                        title={f.filename}
                      >
                        {thumbs[f.file_path] ? (
                          <img src={thumbs[f.file_path]} alt={f.filename} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-muted-foreground/70">
                            {f.file_type === 'video' ? <Film className="w-6 h-6" /> : <ImageIcon className="w-6 h-6" />}
                          </div>
                        )}
                        {f.file_type === 'video' && (
                          <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[9px] font-medium flex items-center gap-1">
                            <Film className="w-2.5 h-2.5" /> Video
                          </div>
                        )}
                        <CaptionBadge caption={f.caption} />
                        <TranscriptBadge hasTranscript={f.file_type === 'video' && transcribedFileIds.has(f.id)} hasCaption={!!f.caption} />
                        {(showFilename || showDate) && (
                          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent px-2 pb-1.5 pt-6 space-y-0.5">
                            {showFilename && <div className="text-[11px] text-white/90 truncate">{f.filename}</div>}
                            {showDate && <div className="text-[10px] text-white/75 truncate">{f.derived_date ?? '—'}</div>}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
