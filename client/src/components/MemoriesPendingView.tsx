// MemoriesPendingView — v2.1 round 69 (Terry 2026-06-09).
//
// "Needs dates" (formerly "Pending") page for files PDR couldn't date
// with confidence (confidence='marked'). Reached via the "Needs dates"
// entry at the top of the Memories — Dates left rail. Three quality
// tiers — Tentative, Placeholder, Unrecorded — see PENDING_TIER_SQL
// in electron/search-database.ts for the classification logic.
//
// Round 69 restructure (Terry's feedback on round 68):
//   - Top bar moved to span the FULL WIDTH above the rail, matching
//     the Memories drilldown layout exactly. Back-to-timeline now
//     sits OVER the rail column, not next to it.
//   - Back-to-timeline button now uses the same freehand blue
//     palette + h-8 px-3 rounded-md recipe as the drilldown's back
//     button, instead of the round-68 secondary Button variant.
//   - All-media filter chip + Insights popover moved to the LEFT
//     cluster (right next to the counts), not after a spacer. Only
//     the density toggle stays on the right.
//   - Label renamed "Pending" → "Needs dates" everywhere (rail
//     entry, page title, dropdown options). Terry's call:
//     self-explanatory beats single-word, and the 2-row wrap in
//     the narrow rail differentiates it from year buttons.

import { useState, useEffect, useMemo } from 'react';
import {
  ChevronLeft,
  ChevronDown,
  Loader2,
  Film,
  ImageIcon,
  CheckCircle2,
  Info,
  Files,
  MessageSquareText,
  ZoomIn,
  ZoomOut,
  X,
  Save,
  Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/custom-button';
import { DensityToggle, type Density } from '@/components/ui/density-toggle';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { BrandedDatePicker } from '@/components/ui/branded-date-picker';
import {
  getPendingFiles,
  getThumbnail,
  setPendingDate,
  type PendingFile,
  type PendingTier,
  type PendingCounts,
} from '@/lib/electron-bridge';
import { CaptionBadge } from '@/components/CaptionBadge';
import { TranscriptBadge } from '@/components/TranscriptBadge';
import { useTranscribedFileIds } from '@/hooks/useTranscribedFileIds';
import { toast } from 'sonner';

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
  years: number[];
  onJumpToYear: (year: number) => void;
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

  const [mediaFilter, setMediaFilter] = useState<'all' | 'photos' | 'videos'>('all');
  const [captionedOnly, setCaptionedOnly] = useState(false);

  const [tileSizeSlider, setTileSizeSlider] = useState<number>(35);
  const [selectionMode, setSelectionMode] = useState(false);
  const [metaFields, setMetaFields] = useState<TileMetaField[]>([]);

  const [titleOpen, setTitleOpen] = useState(false);

  // v2.1 round 71 (Terry 2026-06-09) — right-side date-editor panel
  // for single-file edits (Idea C, half one). panelFile = the file
  // currently being edited; null = panel closed. pickedDate is the
  // user's chosen calendar date (ISO YYYY-MM-DD, BrandedDatePicker
  // format). pickedTime is HH:MM or empty (empty = unknown → noon
  // default on save). Bulk selection-bar editing is the other half
  // of Idea C and lands in the next round.
  const [panelFile, setPanelFile] = useState<PendingFile | null>(null);
  const [pickedDate, setPickedDate] = useState<string>('');
  const [pickedTime, setPickedTime] = useState<string>('');
  const [saving, setSaving] = useState(false);

  // Open the panel for a file. Prefills the date picker from the
  // file's existing derived_date (if any — Tentative + Placeholder
  // tiles will have one; Unrecorded won't). Time defaults to empty
  // so the picker shows the noon placeholder.
  const openPanel = (f: PendingFile) => {
    setPanelFile(f);
    if (f.derived_date) {
      const m = f.derived_date.match(/^(\d{4}-\d{2}-\d{2})/);
      setPickedDate(m ? m[1] : '');
      const t = f.derived_date.match(/T(\d{2}:\d{2})/);
      setPickedTime(t ? t[1] : '');
    } else {
      setPickedDate('');
      setPickedTime('');
    }
  };

  const closePanel = () => {
    setPanelFile(null);
    setPickedDate('');
    setPickedTime('');
  };

  // Commit the user's chosen date for the current panel file.
  // Combines the date (required) with the time (optional → noon
  // default) into an ISO 8601 string, fires the IPC, then refreshes
  // the file list. Auto-advances to the next file in the current
  // grid order — same-index after refetch lands on what was the
  // NEXT file before the saved one was removed. If no files remain,
  // closes the panel.
  const savePanel = async () => {
    if (!panelFile || !pickedDate || saving) return;
    const time = pickedTime || '12:00';
    const iso = `${pickedDate}T${time}:00`;
    setSaving(true);
    try {
      const res = await setPendingDate({ fileIds: [panelFile.id], isoDateTime: iso });
      if (!res.success) {
        toast.error('Couldn’t save date', { description: res.error });
        return;
      }
      // Find this file's current index, refetch, then jump to same
      // index in the refreshed list (which is now the file that was
      // immediately AFTER the saved one).
      const savedId = panelFile.id;
      const idx = files?.findIndex((f) => f.id === savedId) ?? -1;
      const refreshed = await getPendingFiles({ runIds, tier });
      const nextList = refreshed.success && refreshed.data ? refreshed.data : [];
      setFiles(nextList);
      if (idx >= 0 && nextList[idx]) {
        openPanel(nextList[idx]);
      } else {
        closePanel();
      }
      // Fire a window event so the wrapper's pendingCounts useEffect
      // refetches the global badge count.
      try {
        window.dispatchEvent(new CustomEvent('pdr:pendingChanged'));
      } catch { /* event dispatch never throws */ }
    } finally {
      setSaving(false);
    }
  };

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

  const visibleFiles = useMemo(() => {
    if (!files) return null;
    let out = files;
    if (mediaFilter === 'photos') out = out.filter((f) => f.file_type === 'photo');
    else if (mediaFilter === 'videos') out = out.filter((f) => f.file_type === 'video');
    if (captionedOnly) out = out.filter((f) => !!f.caption && f.caption.length > 0);
    return out;
  }, [files, mediaFilter, captionedOnly]);

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

  // Counts breakdown subhead — zero tiers omitted.
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

  const titleOptions: Array<{ key: PendingTier | undefined; label: string; count: number }> = [
    { key: undefined, label: 'All', count: counts.total },
    { key: 'tentative', label: 'Tentative', count: counts.tentative },
    { key: 'placeholder', label: 'Placeholder', count: counts.placeholder },
    { key: 'unrecorded', label: 'Unrecorded', count: counts.unrecorded },
  ];

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Top bar — full width, spans OVER the rail column.
          Mirrors the Memories — Dates drilldown header exactly so
          the user sees the same shape they're used to. */}
      <div className="shrink-0 px-6 py-3 border-b border-border/60 flex items-center gap-2">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium transition-colors"
          style={{ backgroundColor: '#dbeafe', borderColor: '#3b82f6', color: '#1e3a8a', borderWidth: '1px', borderStyle: 'solid' }}
        >
          <ChevronLeft className="w-3.5 h-3.5" /> Back to timeline
        </button>

        {/* Title dropdown — All / Tentative / Placeholder / Unrecorded.
            Purple-tinted pill mirrors the month-picker dropdown's
            position + chevron treatment. */}
        <Popover open={titleOpen} onOpenChange={setTitleOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded-full bg-purple-500/10 hover:bg-purple-500/15 text-sm font-semibold text-purple-700 dark:text-purple-200 transition-colors"
              data-testid="memories-pending-title-dropdown"
            >
              <span>Needs dates{tier ? ` · ${TIER_LABEL[tier]}` : ''}</span>
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

        {/* All-media chip — clustered LEFT next to the counts, not
            right of a spacer. */}
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

        {/* Insights — clustered LEFT immediately after All-media,
            mirroring the Memories — Dates header order. */}
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
            align="start"
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

        <div className="flex-1" />

        <DensityToggle value={density} onChange={onDensityChange} />
      </div>

      {/* Rail + content row */}
      <div className="flex-1 flex min-h-0">
        {(years.length > 0 || counts.total > 0) && (
          <aside className="w-[68px] shrink-0 border-r border-border/60 overflow-y-auto py-4 px-1 text-center">
            {/* Active "Needs dates" entry — same purple highlight as the
                rail entry on the timeline (round 68 pulse dot). */}
            <div
              className="w-full px-1 py-1.5 rounded text-[11px] font-semibold text-purple-600 dark:text-purple-300 bg-purple-500/15 inline-flex flex-col items-center justify-center leading-tight"
              data-testid="memories-rail-pending-active"
            >
              <span>Needs</span>
              <span className="inline-flex items-center gap-1">
                <span>dates</span>
                <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" aria-hidden="true" />
              </span>
            </div>
            <div className="border-t border-border my-0 mx-1" />
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

        <div className="flex-1 overflow-y-auto p-6">
          {loading && !files ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading files…</span>
            </div>
          ) : sections.length === 0 ? (
            <div className="text-center py-16">
              <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-purple-500" />
              <h2 className="text-base font-semibold text-foreground mb-1">All caught up</h2>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                No files need a date decision
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
                    <span className="text-xs text-muted-foreground flex-1 truncate">
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
                        onClick={() => {
                          // Selection-mode tile-click parity with Memories
                          // — Dates lands in phase 2 (bulk selection bar).
                          // For now, any tile click opens the right-side
                          // date editor panel for that single file.
                          openPanel(f);
                        }}
                        className={`group cursor-pointer relative aspect-square bg-secondary/30 overflow-hidden ${tileRing} ${panelFile?.id === f.id ? 'ring-2 ring-purple-500' : 'hover:ring-primary/50'} transition-all`}
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

      {/* v2.1 round 72 (Terry 2026-06-09) — right-side date-editor
          panel. CORRECTLY placed INSIDE the rail+content flex ROW
          (round 71 had it as a sibling of the row, which made it
          stack VERTICALLY below the grid instead of slotting in
          side-by-side). Fixed 380px column on the right edge; the
          grid (flex-1 above) re-flows narrower. Closing the panel
          returns the page to its full-width grid. */}
      {panelFile && (
        <aside
          className="w-[380px] shrink-0 border-l border-border bg-background flex flex-col"
          data-testid="memories-pending-panel"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <div className="flex flex-col min-w-0">
              <h3 className="text-sm font-semibold text-foreground">Set date</h3>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
                {TIER_LABEL[panelFile.pending_tier]}
              </p>
            </div>
            <IconTooltip label="Close panel" side="left">
              <button
                type="button"
                onClick={closePanel}
                className="p-1.5 rounded-md hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close panel"
              >
                <X className="w-4 h-4" />
              </button>
            </IconTooltip>
          </div>

          {/* Preview */}
          <div className="px-4 py-3 shrink-0">
            <div className="aspect-square w-full rounded-lg overflow-hidden bg-secondary/30 ring-1 ring-border">
              {thumbs[panelFile.file_path] ? (
                <img
                  src={thumbs[panelFile.file_path]}
                  alt={panelFile.filename}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted-foreground/70">
                  {panelFile.file_type === 'video' ? (
                    <Film className="w-10 h-10" />
                  ) : (
                    <ImageIcon className="w-10 h-10" />
                  )}
                </div>
              )}
            </div>
            <p className="mt-2 text-xs font-medium text-foreground truncate" title={panelFile.filename}>
              {panelFile.filename}
            </p>
            {panelFile.derived_date ? (
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Current: <span className="text-foreground">{panelFile.derived_date.slice(0, 10)}</span>
                {panelFile.date_source && (
                  <span className="text-muted-foreground/80"> — {panelFile.date_source}</span>
                )}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground mt-0.5">
                No date on record — supply one to confirm.
              </p>
            )}
          </div>

          {/* Date + time inputs */}
          <div className="px-4 py-3 space-y-3 shrink-0">
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
                Date
              </label>
              <BrandedDatePicker
                value={pickedDate}
                onChange={setPickedDate}
                ariaLabel="Set date"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1 inline-flex items-center gap-1.5">
                <Clock className="w-3 h-3" />
                Time <span className="text-muted-foreground/70 normal-case">(optional)</span>
              </label>
              <input
                type="time"
                value={pickedTime}
                onChange={(e) => setPickedTime(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              {!pickedTime && (
                <p className="text-[10px] text-muted-foreground/70 mt-1">
                  Leave blank and PDR will stamp 12:00 noon (a neutral midday placeholder for unknown times).
                </p>
              )}
            </div>
          </div>

          {/* Footer actions */}
          <div className="mt-auto px-4 py-3 border-t border-border flex items-center justify-between gap-2 shrink-0">
            <button
              type="button"
              onClick={closePanel}
              className="text-sm text-muted-foreground hover:text-foreground font-medium transition-colors px-1"
            >
              Cancel
            </button>
            <Button
              variant="primary"
              size="sm"
              onClick={savePanel}
              disabled={!pickedDate || saving}
              className="gap-1.5"
              data-testid="memories-pending-save"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {saving ? 'Saving…' : 'Save & next'}
            </Button>
          </div>
        </aside>
      )}
      </div>
    </div>
  );
}
