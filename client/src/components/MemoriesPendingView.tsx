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

import { useState, useEffect, useMemo, useRef } from 'react';
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
  Check,
  PlayCircle,
  HardDrive,
  Search,
  FolderPlus,
  Captions,
  Copy,
  Trash2,
  CalendarClock,
} from 'lucide-react';
import { Button } from '@/components/ui/custom-button';
import { DensityToggle, type Density } from '@/components/ui/density-toggle';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { BrandedDatePicker } from '@/components/ui/branded-date-picker';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  getPendingFiles,
  getThumbnail,
  setPendingDate,
  moveToRecycleBin,
  openSearchViewer,
  type PendingFile,
  type PendingTier,
  type PendingCounts,
} from '@/lib/electron-bridge';
import { CaptionBadge } from '@/components/CaptionBadge';
import { TranscriptBadge } from '@/components/TranscriptBadge';
import { useTranscribedFileIds } from '@/hooks/useTranscribedFileIds';
import { useTranscribeVideos } from '@/hooks/useTranscribeVideos';
import AddToAlbumPopover from '@/components/AddToAlbumPopover';
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

  // v2.1 round 76 phase 2 (Terry 2026-06-09) — Memories — Dates
  // selection-model parity. Mirrors MemoriesDayDrilldown:
  //   * selectedFileIds  — the Set<number> of currently checked tiles
  //   * lastClickedIndexRef — anchor for shift-range select
  //   * pressModifierRef    — Ctrl/Cmd captured at mousedown so the
  //     subsequent onClick reads the modifier reliably even when
  //     focus shifts steal the synthetic event's modifier flag
  //   * addToAlbumOpenTick  — bump to open the AddToAlbumPopover
  //   * panelBulkFiles      — when non-null, the right-side panel
  //     enters BULK MODE and Save commits to every file in this array
  //     in one IPC call. Mutually exclusive with panelFile (single).
  const [selectedFileIds, setSelectedFileIds] = useState<Set<number>>(new Set());
  const lastClickedIndexRef = useRef<number | null>(null);
  const pressModifierRef = useRef<{ id: number | null; ctrl: boolean }>({ id: null, ctrl: false });
  const [addToAlbumOpenTick, setAddToAlbumOpenTick] = useState(0);
  const [panelBulkFiles, setPanelBulkFiles] = useState<PendingFile[] | null>(null);
  const { transcribe: transcribeSelectedVideos } = useTranscribeVideos();

  const toggleSelection = (file: PendingFile, mode?: 'add' | 'remove') => {
    setSelectedFileIds(prev => {
      const next = new Set(prev);
      if (mode === 'add') next.add(file.id);
      else if (mode === 'remove') next.delete(file.id);
      else if (next.has(file.id)) next.delete(file.id);
      else next.add(file.id);
      return next;
    });
  };
  const clearSelection = () => {
    setSelectedFileIds(new Set());
    lastClickedIndexRef.current = null;
  };

  // Clear selection on tier scope change — IDs from a different
  // tier set aren't referenceable in the new file list.
  useEffect(() => { clearSelection(); }, [tier]);

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

  // (closePanel — bulk-aware version below; the single-only one
  // that used to live here was deleted when openBulkPanel landed.)

  // v2.1 round 76 phase 2 — opens the panel in BULK mode for the
  // current selection. Pre-fills the picker from the most recent
  // derived_date across the batch (a sensible "start here" rather
  // than blank). Closes any existing single-mode panel.
  const openBulkPanel = (filesToEdit: PendingFile[]) => {
    if (filesToEdit.length === 0) return;
    setPanelFile(null);
    setPanelBulkFiles(filesToEdit);
    // Prefill from the first file's derived_date if any, otherwise
    // leave blank so the picker shows its placeholder.
    const seed = filesToEdit.find((f) => !!f.derived_date)?.derived_date;
    if (seed) {
      const m = seed.match(/^(\d{4}-\d{2}-\d{2})/);
      setPickedDate(m ? m[1] : '');
      const t = seed.match(/T(\d{2}:\d{2})/);
      setPickedTime(t ? t[1] : '');
    } else {
      setPickedDate('');
      setPickedTime('');
    }
  };

  const closePanel = () => {
    setPanelFile(null);
    setPanelBulkFiles(null);
    setPickedDate('');
    setPickedTime('');
  };

  // Commit the user's chosen date for either the single panel file
  // OR the bulk selection — same IPC, same setPendingDate({fileIds,
  // isoDateTime}) signature. Single mode auto-advances to the next
  // file at the same grid index; bulk mode just refreshes the list
  // and closes the panel (the whole batch is done).
  const savePanel = async () => {
    if (!pickedDate || saving) return;
    const time = pickedTime || '12:00';
    const iso = `${pickedDate}T${time}:00`;
    const fileIds = panelBulkFiles
      ? panelBulkFiles.map((f) => f.id)
      : panelFile
        ? [panelFile.id]
        : [];
    if (fileIds.length === 0) return;
    setSaving(true);
    try {
      const res = await setPendingDate({ fileIds, isoDateTime: iso });
      if (!res.success) {
        toast.error('Couldn’t save date', { description: res.error });
        return;
      }
      if (panelBulkFiles) {
        toast.success(
          `Date set for ${fileIds.length} file${fileIds.length === 1 ? '' : 's'}`,
        );
        clearSelection();
        const refreshed = await getPendingFiles({ runIds, tier });
        setFiles(refreshed.success && refreshed.data ? refreshed.data : []);
        closePanel();
      } else if (panelFile) {
        // Single-file mode — auto-advance to the next file at the
        // same grid index after refetch.
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
      }
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

  // v2.1 round 74 (Terry 2026-06-09 — thumbnail-cap bug) — removed
  // the round-67 `slice(0, 200)` cap. Terry's library has 265 Pending
  // files; everything past index 200 silently never queued a thumbnail
  // fetch, so scrolling down the grid showed nothing but the image
  // placeholder. Concurrency stays at 4 so the queue drains gradually
  // without saturating disk/CPU. Memories — Dates drilldown uses
  // virtualisation + IntersectionObserver for the truly enormous
  // cases (single buckets with thousands of files); the Pending
  // workflow caps out at a few hundred per library so a flat queue
  // is good enough for now.
  useEffect(() => {
    if (!files) return;
    let cancelled = false;
    const toLoad = files.filter((f) => !thumbs[f.file_path]);
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

  // v2.1 round 76 phase 2 — flat (file_id → grid index) map so
  // shift-range select can resolve a range across tier sections in
  // O(1) per tile rather than scanning visibleFiles on every click.
  const flatIndexById = useMemo(() => {
    const m = new Map<number, number>();
    visibleFiles?.forEach((f, i) => { m.set(f.id, i); });
    return m;
  }, [visibleFiles]);

  // Selection helpers for the toolbar / actions dropdown.
  const selectedFiles = useMemo(() => {
    if (!visibleFiles) return [] as PendingFile[];
    return visibleFiles.filter((f) => selectedFileIds.has(f.id));
  }, [visibleFiles, selectedFileIds]);
  const selectedVideos = useMemo(
    () => selectedFiles.filter((f) => f.file_type === 'video'),
    [selectedFiles],
  );

  return (
    // v2.1 round 73 (Terry 2026-06-09) — outer flips to horizontal
    // flex so the date-editor panel can extend the FULL page height
    // as a right sibling, instead of starting below the toolbar
    // band. Option 2 from the design chat: panel top edge aligns
    // with the page toolbar (one band up from round 72), but stays
    // BELOW the Memories / Dates+Albums router band so the
    // workspace's global chrome is never covered. The left column
    // (top bar + rail+content row) shrinks naturally when the panel
    // claims its 380px on the right; the toolbar's Spacious/Tight
    // toggle remains right-aligned within the now-narrower toolbar
    // band, requiring no layout move (Sub-A from the design chat).
    <div className="h-full flex bg-background">
      <div className="flex-1 flex flex-col min-w-0">
      {/* Top bar — spans the LEFT column's full width (which is the
          whole page when the panel is closed; narrower when open).
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

        {/* v2.1 round 76 phase 2 (Terry 2026-06-09) — Memories — Dates
            selection bar parity. When at least one tile is selected,
            we show:
              1. A gold "Actions" dropdown carrying every Memories
                 selection action (Open Viewer / Send to S&D / Add to
                 S&D pile / Add to album / Transcribe / Copy filenames
                 / Move to Recycle Bin) PLUS a new "Set date for N
                 selected…" entry that opens the right-side panel in
                 BULK mode.
              2. A gold "N selected · X" chip with one-click clear.
              3. An off-screen AddToAlbumPopover anchor that the
                 dropdown's Add-to-album item bumps via openTrigger.
            Same vocabulary, palette, and behaviour as the day-
            drilldown so users moving between the two surfaces see no
            difference. */}
        {selectedFileIds.size > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="bg-[var(--color-gold)] border border-[var(--color-gold)] hover:opacity-90 text-[#1f1a08] hover:bg-[var(--color-gold)]"
                data-testid="pending-selection-actions"
              >
                Actions
                <ChevronDown className="w-3.5 h-3.5 ml-1.5 opacity-80" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[260px]">
              <DropdownMenuItem
                onSelect={() => {
                  if (selectedFiles.length === 0) return;
                  void openSearchViewer(
                    selectedFiles.map((f) => f.file_path),
                    selectedFiles.map((f) => f.filename),
                  );
                }}
              >
                <PlayCircle className="w-3.5 h-3.5 mr-2" />
                Open {selectedFileIds.size} Selected in Viewer
              </DropdownMenuItem>
              {selectedFileIds.size === 1 && (
                <DropdownMenuItem
                  onSelect={() => {
                    const target = selectedFiles[0];
                    if (target) (window as any).pdr?.revealInFolder?.(target.file_path);
                  }}
                >
                  <HardDrive className="w-3.5 h-3.5 mr-2" />
                  Show in File Explorer
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {/* The headline NEW action — bulk-edit the date for
                  every selected file in one shot. Opens the right-
                  side panel in bulk mode; Save commits to all
                  selected files at once. */}
              <DropdownMenuItem
                onSelect={() => openBulkPanel(selectedFiles)}
                data-testid="pending-actions-bulk-set-date"
              >
                <CalendarClock className="w-3.5 h-3.5 mr-2" />
                Set date for {selectedFileIds.size} selected…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  const fileIds = Array.from(selectedFileIds);
                  if (fileIds.length === 0) return;
                  void import('@/lib/memories-return-source').then((m) =>
                    m.setMemoriesReturnSource({ tab: 'byDate', label: 'Memories — Needs dates' }),
                  );
                  window.dispatchEvent(new CustomEvent('pdr:sendToSearchPile', {
                    detail: { fileIds, source: 'memories', mode: 'replace' },
                  }));
                }}
              >
                <Search className="w-3.5 h-3.5 mr-2" />
                Send {selectedFileIds.size} to S&amp;D
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  const fileIds = Array.from(selectedFileIds);
                  if (fileIds.length === 0) return;
                  void import('@/lib/memories-return-source').then((m) =>
                    m.setMemoriesReturnSource({ tab: 'byDate', label: 'Memories — Needs dates' }),
                  );
                  window.dispatchEvent(new CustomEvent('pdr:sendToSearchPile', {
                    detail: { fileIds, source: 'memories', mode: 'accumulate' },
                  }));
                }}
              >
                <Search className="w-3.5 h-3.5 mr-2" />
                Add {selectedFileIds.size} to S&amp;D pile
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setAddToAlbumOpenTick((t) => t + 1)}>
                <FolderPlus className="w-3.5 h-3.5 mr-2" />
                Add to album…
              </DropdownMenuItem>
              {selectedVideos.length > 0 && (
                <DropdownMenuItem
                  onSelect={() => transcribeSelectedVideos(selectedVideos.map((v) => v.file_path))}
                >
                  <Captions className="w-3.5 h-3.5 mr-2" />
                  Transcribe {selectedVideos.length} video{selectedVideos.length === 1 ? '' : 's'}…
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={async () => {
                  if (selectedFiles.length === 0) return;
                  const names = selectedFiles.map((f) => f.filename).join('\n');
                  try {
                    await navigator.clipboard.writeText(names);
                    toast.success(
                      selectedFiles.length === 1 ? 'Filename copied' : `Copied ${selectedFiles.length} filenames`,
                      selectedFiles.length === 1 ? { description: selectedFiles[0].filename } : undefined,
                    );
                  } catch {
                    toast.error("Couldn't copy filename" + (selectedFiles.length === 1 ? '' : 's'));
                  }
                }}
              >
                <Copy className="w-3.5 h-3.5 mr-2" />
                {selectedFileIds.size === 1 ? 'Copy filename' : `Copy ${selectedFileIds.size} filenames`}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={async () => {
                  const ids = Array.from(selectedFileIds);
                  if (ids.length === 0) return;
                  const r = await moveToRecycleBin(ids);
                  if (r.success) {
                    toast.success(`Moved ${r.count ?? ids.length} to Recycle Bin`);
                    clearSelection();
                    const refreshed = await getPendingFiles({ runIds, tier });
                    setFiles(refreshed.success && refreshed.data ? refreshed.data : []);
                    try {
                      window.dispatchEvent(new CustomEvent('pdr:pendingChanged'));
                    } catch { /* event dispatch never throws */ }
                  } else {
                    toast.error('Couldn’t move to Recycle Bin', { description: r.error });
                  }
                }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" />
                Move {selectedFileIds.size} to Recycle Bin
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {selectedFileIds.size > 0 && (
          <>
            <IconTooltip label="Clear selection" side="bottom">
              <button
                onClick={clearSelection}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-[var(--color-gold)] bg-[var(--color-gold)] hover:opacity-90 text-xs font-medium text-[#1f1a08] transition-colors"
                data-testid="pending-selection-chip"
              >
                {selectedFileIds.size} selected
                <X className="w-3 h-3 opacity-70" />
              </button>
            </IconTooltip>
            {/* Off-screen anchor for AddToAlbumPopover — opened by
                the dropdown item via openTrigger bump. */}
            <div className="absolute -left-[9999px] top-0">
              <AddToAlbumPopover
                fileIds={Array.from(selectedFileIds)}
                onAdded={clearSelection}
                openTrigger={addToAlbumOpenTick}
              />
            </div>
          </>
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
            {/* v2.1 round 75 (Terry 2026-06-09) — symmetric breathing
                room around the divider so it reads as a section
                separator rather than the bottom edge of the
                Needs-dates pill. Mirrors the timeline rail. */}
            <div className="border-t border-border my-2 mx-1" />
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

        {/* v2.1 round 75 (Terry 2026-06-09) — scroll container drops
            its TOP padding so the sticky tier header below sits
            flush against the page toolbar when scrolled. p-6
            previously pushed the sticky stop-point 24px below the
            toolbar, which made the header read as "floating" with
            tiles bleeding through the gap. Horizontal + bottom
            padding stay on the parent; the first tier header's
            own py-3 gives the visual top breathing room when not
            scrolled. */}
        <div className="flex-1 overflow-y-auto px-6 pb-6">
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
                  {/* v2.1 round 74 (Terry 2026-06-09) — tier header
                      now uses a SOLID bg-background so the tiles
                      below don't bleed through when the sticky header
                      crosses them. Previously bg-background/95 +
                      backdrop-blur read as "floating" instead of
                      "flush below the toolbar band" per Terry's
                      request. Sits at top-0 of the scroll container
                      so it stops right at the bottom of the page
                      toolbar above. Subtle border-b adds the same
                      hairline separation the toolbar uses. */}
                  <div className="flex items-baseline gap-3 sticky top-0 bg-background py-3 -mx-6 px-6 border-b border-border/60 z-10">
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
                    {sectionFiles.map((f) => {
                      const idx = flatIndexById.get(f.id) ?? 0;
                      const isMultiSelected = selectedFileIds.has(f.id);
                      const isPanelActive = panelFile?.id === f.id || (panelBulkFiles?.some((bf) => bf.id === f.id) ?? false);
                      return (
                      <button
                        key={f.id}
                        type="button"
                        // v2.1 round 76 phase 2 (Terry 2026-06-09) — port
                        // the Memories — Dates modifier-aware click
                        // contract. Mirrors the day-drilldown handler:
                        //   plain click            → open panel for this file
                        //   Selection Mode + click → toggle selection
                        //   Ctrl/Cmd+click         → toggle selection
                        //   Shift+click            → range select from anchor
                        // Ctrl is sampled at mousedown to dodge stale
                        // synthetic-event modifier flags after focus
                        // shifts (same race the round-40 fix solved).
                        onMouseDown={(e) => {
                          pressModifierRef.current = { id: f.id, ctrl: e.ctrlKey || e.metaKey };
                        }}
                        onClick={(e) => {
                          const pressedCtrl = pressModifierRef.current.id === f.id && pressModifierRef.current.ctrl;
                          if (e.ctrlKey || e.metaKey || pressedCtrl) {
                            e.preventDefault();
                            toggleSelection(f);
                            lastClickedIndexRef.current = idx;
                            return;
                          }
                          if (e.shiftKey && lastClickedIndexRef.current !== null && visibleFiles) {
                            const start = Math.min(lastClickedIndexRef.current, idx);
                            const end = Math.max(lastClickedIndexRef.current, idx);
                            for (let i = start; i <= end; i++) {
                              const file = visibleFiles[i];
                              if (file) toggleSelection(file, 'add');
                            }
                            lastClickedIndexRef.current = idx;
                            return;
                          }
                          if (selectionMode) {
                            toggleSelection(f);
                            lastClickedIndexRef.current = idx;
                            return;
                          }
                          lastClickedIndexRef.current = idx;
                          openPanel(f);
                        }}
                        className={`group cursor-pointer relative aspect-square bg-secondary/30 overflow-hidden transition-all ${
                          isMultiSelected
                            ? 'rounded-lg ring-2 ring-[var(--color-gold)]'
                            : isPanelActive
                              ? `${tileRing} ring-2 ring-purple-500`
                              : `${tileRing} hover:ring-primary/50`
                        }`}
                        title={f.filename}
                      >
                        {/* v2.1 round 76 phase 2 — selection checkbox.
                            Same recipe as MemoriesDayDrilldown: hidden
                            by default, visible on tile hover; pinned
                            visible when Selection Mode is on or the
                            tile is checked. Shift+click extends a
                            range from the last clicked tile. Gold
                            fill when selected matches the tile ring
                            + selection chip in the toolbar. */}
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            if (e.shiftKey && selectedFileIds.size > 0 && lastClickedIndexRef.current !== null && visibleFiles) {
                              const start = Math.min(lastClickedIndexRef.current, idx);
                              const end = Math.max(lastClickedIndexRef.current, idx);
                              for (let i = start; i <= end; i++) {
                                const file = visibleFiles[i];
                                if (file && !selectedFileIds.has(file.id)) toggleSelection(file, 'add');
                              }
                              lastClickedIndexRef.current = idx;
                              return;
                            }
                            toggleSelection(f);
                            lastClickedIndexRef.current = idx;
                          }}
                          className={`absolute top-1.5 left-1.5 w-5 h-5 rounded border-2 flex items-center justify-center transition-all cursor-pointer hover:scale-110 z-10 ${
                            isMultiSelected
                              ? 'bg-[var(--color-gold)] border-[var(--color-gold)] text-[#1f1a08] opacity-100'
                              : selectionMode
                                ? 'border-white/80 bg-black/40 text-transparent hover:border-white hover:bg-black/60 opacity-100'
                                : 'border-white/80 bg-black/40 text-transparent hover:border-white hover:bg-black/60 opacity-0 group-hover:opacity-100'
                          }`}
                          data-testid={`pending-tile-checkbox-${f.id}`}
                        >
                          {isMultiSelected && <Check className="w-3 h-3" />}
                        </div>
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
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>{/* close rail+content row */}
      </div>{/* close LEFT column wrapper — round 73 */}

      {/* v2.1 round 73 (Terry 2026-06-09) — right-side date-editor
          panel. Now a sibling of the LEFT column wrapper (not inside
          the rail+content row), so it spans the full page height
          from the top toolbar band all the way to the bottom edge.
          Fixed 380px width; the left column flex-shrinks to make
          room. Closing the panel returns the page to its full width. */}
      {(panelFile || panelBulkFiles) && (
        <aside
          className="w-[380px] shrink-0 border-l border-border bg-background flex flex-col"
          data-testid="memories-pending-panel"
        >
          {/* Header — single mode shows the tier label; bulk mode
              shows the file count so the user can confirm scope. */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <div className="flex flex-col min-w-0">
              <h3 className="text-sm font-semibold text-foreground">
                {panelBulkFiles ? `Set date for ${panelBulkFiles.length} files` : 'Set date'}
              </h3>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
                {panelBulkFiles ? 'Bulk edit' : panelFile && TIER_LABEL[panelFile.pending_tier]}
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

          {/* Preview — single mode renders the file's thumbnail at
              full panel width; bulk mode shows up to 4 thumbnails as
              a 2×2 grid with a "+N more" overlay when the batch is
              larger, so the user gets a glance at what's about to
              be committed without scrolling. */}
          <div className="px-4 py-3 shrink-0">
            {panelBulkFiles ? (
              <>
                <div className="grid grid-cols-2 gap-1 aspect-square w-full rounded-lg overflow-hidden bg-secondary/30 ring-1 ring-border">
                  {panelBulkFiles.slice(0, 4).map((f, i) => (
                    <div key={f.id} className="relative bg-secondary/40">
                      {thumbs[f.file_path] ? (
                        <img src={thumbs[f.file_path]} alt={f.filename} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground/70">
                          {f.file_type === 'video' ? <Film className="w-5 h-5" /> : <ImageIcon className="w-5 h-5" />}
                        </div>
                      )}
                      {i === 3 && panelBulkFiles.length > 4 && (
                        <div className="absolute inset-0 bg-black/55 flex items-center justify-center text-white text-sm font-semibold">
                          +{panelBulkFiles.length - 4}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Sets the same date + time on every selected file. Confidence stays Marked
                  (still a best-guess); these files leave Needs dates on save.
                </p>
              </>
            ) : panelFile ? (
              <>
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
              </>
            ) : null}
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
              {saving
                ? 'Saving…'
                : panelBulkFiles
                  ? `Save ${panelBulkFiles.length}`
                  : 'Save & next'}
            </Button>
          </div>
        </aside>
      )}
    </div>
  );
}
