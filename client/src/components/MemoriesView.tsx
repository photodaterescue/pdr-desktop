import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Sparkles,
  Film,
  Scissors,
  Image as ImageIcon,
  Layers,
  X,
  Info,
  Eye,
  HardDrive,
  PlayCircle,
  ArrowRight,
  Check,
  Copy,
  FolderPlus,
  ListChecks,
  ArrowUpToLine,
  RotateCcw,
  Star,
  MessageSquareText,
  Captions,
  Files,
  Trash2,
  ZoomIn,
  ZoomOut,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { promptConfirm } from '@/components/trees/promptConfirm';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/custom-button';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import {
  getMemoriesYearMonthBuckets,
  getMemoriesOnThisDay,
  getMemoriesDayFiles,
  getThumbnail,
  listSearchRuns,
  openSearchViewer,
  setMonthlyThumbnail,
  moveToRecycleBin,
  onRecycleBinChanged,
  onLibraryFilesAdded,
  type MemoriesYearBucket,
  type MemoriesOnThisDayItem,
  type IndexedFile,
  type IndexedRun,
} from '../lib/electron-bridge';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { useTranscribeVideos } from '@/hooks/useTranscribeVideos';
import { useTranscribedFileIds } from '@/hooks/useTranscribedFileIds';
import { TranscriptBadge } from '@/components/TranscriptBadge';
import MemoriesPendingView from '@/components/MemoriesPendingView';
import { getPendingCounts, type PendingCounts, type PendingTier } from '@/lib/electron-bridge';
import { usePopoverGraceClose } from '@/hooks/usePopoverGraceClose';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { DensityToggle, type Density } from '@/components/ui/density-toggle';
import AddToAlbumPopover from './AddToAlbumPopover';
import { getPrefetchedMemories, getPrefetchedThumb, invalidatePrefetchedMemories } from '../lib/memories-prefetch';
import { editPhotoCaption } from '@/lib/caption-actions';
import { CaptionBadge } from '@/components/CaptionBadge';
import { CaptionTooltip } from '@/components/ui/caption-tooltip';

// ─── Helpers ───────────────────────────────────────────────────────────────

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ── Tile-size + metadata config (drilldown only) ──────────────────────
// Mirrors the S&D ribbon's Add Info dropdown so users get a familiar
// surface for choosing what shows on each thumbnail. Values are
// persisted in localStorage so they survive a session.
type DrilldownMetaField = 'filename' | 'date';
const DRILLDOWN_TILE_PX_MIN = 100;
const DRILLDOWN_TILE_PX_MAX = 360;
function drilldownSliderToPx(slider: number): number {
  const clamped = Math.max(0, Math.min(100, slider));
  return Math.round(DRILLDOWN_TILE_PX_MIN + (DRILLDOWN_TILE_PX_MAX - DRILLDOWN_TILE_PX_MIN) * (clamped / 100));
}

function formatHumanDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

// ─── Main component ────────────────────────────────────────────────────────

// `Density` is now defined in @/components/ui/density-toggle so the
// Albums view (v2.0.8 step 6) can reuse the exact same surface
// without duplicating the type or the segmented-control component.

// A "library" in the UI is one or more runs that share the same set of
// source labels. Two runs that fixed the same sources into two destinations
// (e.g. local SSD + NAS backup) are still one library to the user — the
// destinations are just where the output lives. Only when parallel
// structures ship will same-source runs deserve separate entries.
interface Library {
  key: string;                 // stable id derived from the source-label set
  label: string;               // human label (source labels joined)
  runIds: number[];            // every indexed_run that rolls up into this library
  fileCount: number;
}

function sourceLabelsOf(run: IndexedRun): string[] {
  try {
    const parsed = run.source_labels ? JSON.parse(run.source_labels) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function groupRunsIntoLibraries(runs: IndexedRun[]): Library[] {
  const byKey = new Map<string, Library>();
  for (const r of runs) {
    const labels = sourceLabelsOf(r);
    // v2.0.15 (Terry 2026-05-28) — group by DESTINATION PATH, not by
    // source labels. The previous logic used the ZIP filename list as
    // the key, which meant every Takeout-part-N.zip import created
    // its own "library" entry in the dropdown — Terry was seeing the
    // same folder ("1. PDR Library Drive") repeated 9× because each
    // ZIP carried a distinct source_labels array. The user-facing
    // mental model is "a library = a destination folder," not "a
    // library = the set of source files that originally landed in
    // it"; grouping by destination_path matches that model and
    // collapses repeat imports into the same library entry. The
    // source_labels are still folded into the label when present so
    // users can see what's landed in each library, but they no longer
    // split the entry.
    const destKey = (r.destination_path || '').replace(/[\\/]+$/, '').toLowerCase();
    const key = destKey || `__run_${r.id}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.runIds.push(r.id);
      existing.fileCount += r.file_count;
    } else {
      const label = r.destination_path.split(/[\\/]/).filter(Boolean).pop() || `Run #${r.id}`;
      byKey.set(key, { key, label, runIds: [r.id], fileCount: r.file_count });
    }
    void labels; // labels currently unused for grouping; kept available if a future UI wants to surface them per-entry
  }
  return Array.from(byKey.values());
}

// `headerControlsTarget` — DOM node owned by MemoriesPanel. When
// provided, MemoriesView portals its summary + jump-to-latest +
// density + library-selector controls into that node so they live
// on the same row as the [By Date | Albums] toggle pill. This
// reclaims the otherwise-empty horizontal real estate to the right
// of the toggle and removes a whole header row from the timeline
// surface, giving the photo grid more vertical room. Terry
// 2026-05-20: "consolidation of the buttons and info to the same
// row as the toggle switch for By Date / Albums but with a |
// divider between them. This will allow more real estate for the
// thing that really matters — the pictures." Falls back to the
// previous in-place rendering when the prop isn't passed (keeps the
// component usable from any future caller that hasn't wired the
// slot).
export default function MemoriesView({ headerControlsTarget }: { headerControlsTarget?: HTMLElement | null } = {}) {
  // (Back-to-album pill moved into TitleBar — see TitleBar.tsx.)

  // v2.1 round 58 (Terry 2026-06-09) — set of file_ids that have a
  // transcript on disk. Feeds the TranscriptBadge (lavender "T"
  // pill) rendered on OnThisDay video tiles below. Visibility of
  // the badge is governed centrally by Settings → Privacy &
  // Security → "Hide transcripts"; the badge component reads that
  // setting itself, so this view only needs to know which files
  // have transcripts. Both MemoriesView and MemoriesDayDrilldown
  // call this hook independently — they're separate React closures
  // and the underlying cache is a module-level Set so the extra
  // call is free (no duplicate IPC).
  const [transcribedFileIds] = useTranscribedFileIds();

  const [runs, setRuns] = useState<IndexedRun[]>([]);
  // Multi-select library filter — matches S&D's Library Drive
  // pattern (Terry 2026-05-19: "Libraries in By Date… should be
  // the same one as in S&D… have all enabled by default").
  // Default = all library keys; treated as a no-op filter when
  // every library is selected. State holds the SET of selected
  // keys; the data fetch maps to union of runIds.
  const [libraryKeys, setLibraryKeys] = useState<string[]>([]);
  // Buckets state seeded from the Welcome-page prefetch (see
  // memories-prefetch.ts). If the prefetch completed before
  // MemoriesView mounted, the first render already has the full
  // bucket list — no async wait, no flash of the empty-timeline
  // skeleton, no fresh IPC call. If the prefetch hasn't completed
  // (user clicked Memories very fast, or skipped Welcome entirely),
  // we fall back to the existing cold fetch in the effect below.
  const [buckets, setBuckets] = useState<MemoriesYearBucket[]>(() => {
    const pref = getPrefetchedMemories();
    return pref ? pref.buckets : [];
  });
  const [onThisDay, setOnThisDay] = useState<MemoriesOnThisDayItem[]>([]);
  // v2.1 round 67 (Terry 2026-06-09) — "Pending" rail entry. State
  // shape: null = user is on Timeline / drilldown views (default); set
  // = user has navigated INTO Pending (with optional tier scope).
  // Counts always fetched globally so the rail badge shows the true
  // cross-library backlog. Refreshed on mount + whenever the wrapper
  // triggers a data refresh (refreshTick increment).
  const [pendingScope, setPendingScope] = useState<{ tier?: PendingTier } | null>(null);
  const [pendingCounts, setPendingCounts] = useState<PendingCounts>({ total: 0, tentative: 0, placeholder: 0, unrecorded: 0 });
  const [pendingRailExpanded, setPendingRailExpanded] = useState(false);
  // "On This Day" AI-suggestion card — hidden when the user has
  // dismissed it via the X. Persists across sessions in localStorage
  // so Terry doesn't have to re-dismiss every launch. Terry
  // 2026-05-20: "There should be the way to hide the AI suggestion
  // on Memories — By Date". The card can be brought back from a small
  // text link that surfaces in the header controls slot when it's
  // currently hidden (symmetric: hide via the X on the card, restore
  // via the link on the controls row). Both surfaces flip the same
  // flag so wherever the user looks they see consistent state.
  const OTD_HIDDEN_KEY = 'pdr-memories-otd-hidden';
  const [otdHidden, setOtdHidden] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(OTD_HIDDEN_KEY) === '1';
  });
  // "Ready to render" gate that defers the OTD card's first mount
  // by one frame after Memories itself mounts. Terry's theory
  // 2026-05-21: with the OTD card mounting in the same render
  // cycle as the workspace's activeView change, the heavyweight
  // OTD work (its IntersectionObservers, thumbnail IPCs, gradient
  // layout) competes for the first paint and the sidebar's
  // collapse state-update doesn't land before the browser draws
  // — so the user sees the wide sidebar for a frame before it
  // snaps shut. Hiding OTD during initial mount with a one-frame
  // setTimeout means the sidebar's tempExpanded reset wins the
  // race and the first visible frame already has the correct
  // collapsed layout. After that one frame the OTD card mounts
  // normally; the user doesn't perceive the delay.
  const [otdReady, setOtdReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOtdReady(true), 0);
    return () => clearTimeout(t);
  }, []);
  const hideOnThisDay = () => {
    setOtdHidden(true);
    try { localStorage.setItem(OTD_HIDDEN_KEY, '1'); } catch { /* localStorage may be unavailable */ }
  };
  const showOnThisDay = () => {
    setOtdHidden(false);
    try { localStorage.removeItem(OTD_HIDDEN_KEY); } catch { /* localStorage may be unavailable */ }
  };
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  // Drilldown selection. `month` and `day` are independently optional
  // so a single state shape covers all three granularities:
  //   { year }                → whole year (clicking the year heading)
  //   { year, month }         → whole month (clicking a month tile)
  //   { year, month, day }    → single day (reserved for future per-day drill-in)
  // v2.0.15 (Terry 2026-06-02) — read the back-pill drilldown latch
  // at useState init time so the very first render lands on the
  // right month/day. The previous useEffect-based listener approach
  // missed historical events (MemoriesView mounts AFTER the back-pill
  // click dispatches `pdr:memoriesSwitchTab`), so the listener never
  // caught the drilldown info. useState(init) runs synchronously
  // during the very first construction, BEFORE any effects, so the
  // localStorage read can never race the click. removeItem clears
  // it so a stale value can't hijack a future mount.
  const [selectedRange, setSelectedRange] = useState<{ year: number; month?: number; day?: number } | null>(() => {
    try {
      const raw = localStorage.getItem('pdr-memories-pending-drilldown');
      if (raw) {
        localStorage.removeItem('pdr-memories-pending-drilldown');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.year === 'number') {
          return {
            year: parsed.year,
            month: typeof parsed.month === 'number' ? parsed.month : undefined,
            day: typeof parsed.day === 'number' ? parsed.day : undefined,
          };
        }
      }
    } catch { /* localStorage may be unavailable / corrupted */ }
    return null;
  });

  // v2.0.15 (Terry 2026-06-02) — restore the drilldown when the user
  // clicks the TitleBar "Back to Memories — Dates" pill. TitleBar
  // dispatches pdr:memoriesSwitchTab with detail = { tab, drilldown }
  // where drilldown carries the year/month/day they were viewing when
  // they did Send-to-S&D. Setting selectedRange triggers the existing
  // drilldown render path so the user lands back on the same view
  // they came from instead of the timeline top.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tab?: string; drilldown?: { year: number; month?: number; day?: number } } | undefined;
      if (detail?.tab !== 'byDate' || !detail.drilldown) return;
      setSelectedRange(detail.drilldown);
    };
    window.addEventListener('pdr:memoriesSwitchTab', handler as EventListener);
    return () => window.removeEventListener('pdr:memoriesSwitchTab', handler as EventListener);
  }, []);
  // Gap density — some users prefer a dense wall of photos with no gaps,
  // others prefer breathing room. Persist across sessions for this surface.
  const [density, setDensity] = useState<Density>(() => {
    if (typeof localStorage === 'undefined') return 'spacious';
    return (localStorage.getItem('pdr-memories-density') as Density) || 'spacious';
  });
  const changeDensity = (d: Density) => {
    setDensity(d);
    try { localStorage.setItem('pdr-memories-density', d); } catch {}
  };

  // Load once on mount + whenever the catch-up indexer signals new
  // rows landed. The pdr:libraryRebuildComplete event fires from
  // UnindexedLibrariesCard when the last root finishes; re-fetching
  // runs picks up any new ones so libraries / timeline reflect the
  // newly-indexed photos without restarting PDR. v2.0.9.
  useEffect(() => {
    const refetch = async () => {
      const r = await listSearchRuns();
      if (r.success && r.data) setRuns(r.data);
    };
    refetch();
    window.addEventListener('pdr:libraryRebuildComplete', refetch);
    return () => window.removeEventListener('pdr:libraryRebuildComplete', refetch);
  }, []);

  // Derived libraries grouping + currently-selected run IDs (or undefined
  // for "all libraries"). Libraries is memoised so the effect below doesn't
  // spin from identity-only changes.
  const libraries = useMemo(() => groupRunsIntoLibraries(runs), [runs]);

  // Default the selection to ALL library keys when the libraries list
  // first loads. Terry 2026-05-19: "have all enabled by default".
  // Re-runs if the underlying library set changes (e.g. new Fix run).
  // hasInitialized flips true once we've actually populated keys —
  // before that, the data fetch treats the empty state as "loading"
  // (pass undefined = show all) so we don't briefly render an empty
  // timeline between mount and the useEffect firing.
  const [hasInitialized, setHasInitialized] = useState(false);
  useEffect(() => {
    if (libraries.length === 0) return;
    setLibraryKeys((prev) => {
      // First load OR new libraries appeared → reset to everything.
      if (prev.length === 0) return libraries.map((l) => l.key);
      // Drop any stale keys that no longer exist; add any new ones.
      const valid = new Set(libraries.map((l) => l.key));
      const filtered = prev.filter((k) => valid.has(k));
      const missing = libraries.map((l) => l.key).filter((k) => !prev.includes(k));
      if (filtered.length === prev.length && missing.length === 0) return prev;
      return [...filtered, ...missing];
    });
    setHasInitialized(true);
  }, [libraries]);

  const selectedRunIds = useMemo(() => {
    // Loading state — libraries haven't finished initialising yet.
    // Pass `undefined` so the backend returns everything; avoids a
    // brief empty-timeline flash before useEffect populates keys.
    if (!hasInitialized) return undefined;
    // All selected = no-op filter (skip the backend narrowing path).
    if (libraryKeys.length === libraries.length) return undefined;
    // Explicit Clear all → return an empty array. The backend treats
    // an empty runIds list as "match no runs", so the timeline goes
    // empty — matching what the UI shows (no checkboxes ticked).
    // Terry 2026-05-20: Clear all wasn't visibly doing anything
    // because the previous shortcut quietly translated empty into
    // "all" at this point; now the user gets the change they asked
    // for.
    if (libraryKeys.length === 0) return [];
    const selectedSet = new Set(libraryKeys);
    return libraries
      .filter((l) => selectedSet.has(l.key))
      .flatMap((l) => l.runIds);
  }, [hasInitialized, libraryKeys, libraries]);
  const selectedRunIdsKey = selectedRunIds ? selectedRunIds.join(',') : '';

  // Manual-refresh tick. Bumping this triggers the fetch effect
  // below to re-run with the same scope. Terry 2026-05-20: "There
  // should be a refresh in By Date and Albums also." Useful when
  // a Fix completes in another surface and the user wants the
  // timeline updated without waiting for the auto-refresh event.
  const [refreshTick, setRefreshTick] = useState(0);
  // Re-fetch whenever the scope changes — or when the user
  // explicitly hits Refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const today = new Date();
      const [ym, otd] = await Promise.all([
        getMemoriesYearMonthBuckets(selectedRunIds),
        getMemoriesOnThisDay({ month: today.getMonth() + 1, day: today.getDate(), runIds: selectedRunIds, limit: 40 }),
      ]);
      if (cancelled) return;
      setBuckets(ym.success && ym.data ? ym.data : []);
      setOnThisDay(otd.success && otd.data ? otd.data : []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selectedRunIdsKey, refreshTick]);

  // v2.1 round 67 (Terry 2026-06-09) — Pending counts fetched
  // globally (no runIds) so the rail badge shows the true cross-
  // library backlog regardless of the current library filter. Same
  // refreshTick trigger so a Fix completion that moves files out of
  // 'marked' updates the rail badge live.
  useEffect(() => {
    let cancelled = false;
    void getPendingCounts().then((r) => {
      if (cancelled) return;
      if (r.success && r.data) setPendingCounts(r.data);
    });
    return () => { cancelled = true; };
  }, [refreshTick]);

  // v2.0.15 — when any recycle change happens (anywhere), bump the
  // refresh tick AND invalidate the Welcome-screen prefetch cache so
  // the next Welcome → Memories navigation reads fresh bucket counts
  // (otherwise the cached month-card counts include the recycled
  // items until the cache TTL fires).
  useEffect(() => {
    const off = onRecycleBinChanged(() => {
      invalidatePrefetchedMemories();
      setRefreshTick(t => t + 1);
    });
    return () => off();
  }, []);

  // v2.0.15 (Terry 2026-06-06) — Phase 3a. When the Viewer's "Save
  // Enhanced" flow lands a new _E sibling and indexEnhancedSibling
  // upserts the row, main emits library:filesAdded. Memories needs
  // the same treatment as a Recycle change: invalidate the Welcome-
  // screen prefetch cache (so month-card counts pick up the new
  // file) and bump refreshTick (so the day-grid re-fetches and the
  // new _E shows next to its source).
  useEffect(() => {
    const off = onLibraryFilesAdded(() => {
      invalidatePrefetchedMemories();
      setRefreshTick(t => t + 1);
    });
    return () => off();
  }, []);

  // v2.0.15 (Terry 2026-05-29) — titlebar Refresh button dispatches
  // pdr:refreshActiveView. Year-level view bumps refreshTick (which
  // re-pulls buckets + on-this-day) and invalidates the prefetch
  // cache so a subsequent Welcome → Memories navigation reads fresh.
  useEffect(() => {
    const handler = () => {
      invalidatePrefetchedMemories();
      setRefreshTick(t => t + 1);
    };
    window.addEventListener('pdr:refreshActiveView', handler as EventListener);
    return () => window.removeEventListener('pdr:refreshActiveView', handler as EventListener);
  }, []);

  // Load sample thumbnails for each year/month card + on-this-day items.
  // Uses a sliding-window pool (12 concurrent requests) and writes
  // each thumbnail to state as soon as it returns, so the grid fills
  // progressively instead of waiting for whole batches. The previous
  // version processed in waves of 8 with an inter-batch await — if
  // one item in a wave was slow (large RAW, network drive, sharp/
  // ffmpeg busy from PM's face-crop work) every other item in the
  // same wave waited too. On a cold first-Memories-after-PM session
  // that produced the ~30 seconds of placeholder tiles Terry hit.
  useEffect(() => {
    let cancelled = false;
    // Month tile thumbnails are now fetched lazily by each
    // MonthTile via IntersectionObserver — only the visible tiles
    // (plus a 600px lead margin) request their image, so a 200-
    // month timeline doesn't fire 200 IPCs on every Memories
    // mount. This loop now exists only for the "On This Day" AI
    // suggestion strip, which is small (≤40 items, hardcoded
    // limit on the IPC call) and always visible at the top.
    const paths = new Set<string>();
    for (const o of onThisDay) paths.add(o.file_path);
    const toLoad = Array.from(paths).filter((p) => !thumbs[p]);
    if (toLoad.length === 0) return;
    const CONCURRENCY = 12;
    let cursor = 0;
    const worker = async () => {
      while (!cancelled && cursor < toLoad.length) {
        const i = cursor++;
        const p = toLoad[i];
        try {
          const r = await getThumbnail(p, 160);
          if (cancelled) return;
          if (r.success && r.dataUrl) {
            setThumbs((prev) => prev[p] ? prev : { ...prev, [p]: r.dataUrl });
          }
        } catch { /* per-thumb failure is non-fatal */ }
      }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    void Promise.allSettled(workers);
    return () => { cancelled = true; };
  }, [onThisDay]);

  // Group buckets by year for the main timeline render.
  const yearGroups = useMemo(() => {
    const map = new Map<number, MemoriesYearBucket[]>();
    for (const b of buckets) {
      const arr = map.get(b.year) || [];
      arr.push(b);
      map.set(b.year, arr);
    }
    // Sort months ASC within each year for a natural Jan → Dec read.
    for (const arr of map.values()) arr.sort((a, b) => a.month - b.month);
    return Array.from(map.entries()).sort((a, b) => b[0] - a[0]); // years DESC
  }, [buckets]);

  const totalPhotos = useMemo(() => buckets.reduce((s, b) => s + (b.photoCount || 0), 0), [buckets]);
  const totalVideos = useMemo(() => buckets.reduce((s, b) => s + (b.videoCount || 0), 0), [buckets]);

  // Remember the year the user drilled into so "Back to timeline"
  // can scroll the timeline back to that year, not the top. Terry
  // 2026-05-19: "if someone had drilled into a month of 2004, there
  // unlikely to want to go back to May 2026 when they go back to
  // timeline". Set by openMonth/openYear, consumed by the effect
  // below when selectedRange returns to null.
  const [lastDrilledYear, setLastDrilledYear] = useState<number | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  const openMonth = (year: number, month: number) => {
    setLastDrilledYear(year);
    setSelectedRange({ year, month });
  };
  const openYear = (year: number) => {
    setLastDrilledYear(year);
    setSelectedRange({ year });
  };

  // Year sidebar — quick scroll to a year.
  const jumpToYear = (year: number) => {
    const el = document.getElementById(`memories-year-${year}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // When returning from a drilldown, scroll the timeline to the
  // year the user was browsing (if any). Use 'auto' scroll so it
  // feels like "back to where I was" instead of an animated jump.
  useEffect(() => {
    if (selectedRange !== null) return;
    if (lastDrilledYear === null) return;
    // Defer to next tick so the timeline DOM has re-rendered.
    const id = setTimeout(() => {
      const el = document.getElementById(`memories-year-${lastDrilledYear}`);
      if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
    }, 0);
    return () => clearTimeout(id);
  }, [selectedRange, lastDrilledYear]);

  // v2.1 round 67 (Terry 2026-06-09) — Pending takes precedence over
  // the day drilldown because both can't be active at once and the
  // Pending entry-point is reached from the same rail. Back button
  // inside Pending clears pendingScope, returning the user to the
  // Timeline view.
  if (pendingScope) {
    return (
      <MemoriesPendingView
        tier={pendingScope.tier}
        runIds={selectedRunIds}
        density={density}
        onDensityChange={changeDensity}
        onBack={() => setPendingScope(null)}
        counts={pendingCounts}
        years={yearGroups.map(([y]) => y)}
        onJumpToYear={(year) => {
          // Leaving Pending to jump to a specific year on the
          // timeline. setSelectedRange would drill into that year's
          // month grid; clearing pendingScope + bumping scrollToYear
          // would scroll the timeline. For consistency with rail
          // jumps on the yearly view (which scroll, not drill), we
          // just clear pendingScope and let jumpToYear handle the
          // scroll on the next render.
          setPendingScope(null);
          setTimeout(() => jumpToYear(year), 0);
        }}
        onChangeTier={(tier) => setPendingScope({ tier })}
      />
    );
  }

  if (selectedRange) {
    return (
      <MemoriesDayDrilldown
        year={selectedRange.year}
        month={selectedRange.month}
        day={selectedRange.day}
        runIds={selectedRunIds}
        density={density}
        onDensityChange={changeDensity}
        onBack={() => setSelectedRange(null)}
        onRequestRefresh={() => setRefreshTick((t) => t + 1)}
        allYearBuckets={buckets}
        onNavigateToRange={(year, month, day) => setSelectedRange({ year, month, day })}
      />
    );
  }

  const gridGap = density === 'tight' ? 'gap-0' : 'gap-3';
  const tileRing = density === 'tight' ? '' : 'rounded-xl ring-1 ring-border';
  const tileRingHover = density === 'tight' ? '' : 'hover:ring-primary/50';
  const otdTileClass = density === 'tight' ? '' : 'rounded-lg ring-1 ring-border hover:ring-primary/50';

  const today = new Date();
  const otdLabel = `${MONTH_NAMES[today.getMonth()]} ${today.getDate()}`;

  return (
    <div className="h-full flex flex-col bg-background animate-in fade-in-0 duration-300">
      {/* Back-to-album pill moved into TitleBar (v2.0.8 polish pass).
          Terry 2026-05-19: "to the right of 'Photo Date Rescue' in
          the titlebar" — visible regardless of which surface is
          active. */}
      {/* By-Date controls row. The "Memories" page title now lives one
          level up in MemoriesPanel, above the [By Date | Albums] tabs,
          so we don't repeat it here. The summary line stays — it's
          specific to the By Date view (photo/video counts across
          years) and useful context just below the tab strip. */}
      {/* Header controls — summary text, Jump to latest, density
          toggle, and library selector. Rendered EITHER into the slot
          MemoriesPanel hands us (consolidated onto the toggle row) OR
          inline as a standalone row when no slot exists (legacy
          fallback). The two render targets share the same JSX via
          `controlsContent` so behaviour stays identical regardless of
          where the controls land. */}
      {(() => {
        const summaryText = loading
          ? 'Loading…'
          : buckets.length === 0
            ? 'No photos indexed yet — run a Fix first to build your memory timeline.'
            : `${totalPhotos.toLocaleString()} photos · ${totalVideos.toLocaleString()} videos across ${yearGroups.length} ${yearGroups.length === 1 ? 'year' : 'years'}.`;
        const controlsContent = (
          <>
            <div className="flex items-center gap-3 min-w-0">
              <p className="text-xs text-muted-foreground truncate">{summaryText}</p>
              {/* Jump to most recent year — useful after returning from a
                  deep drilldown into older years. Terry 2026-05-19:
                  "there should be a button that says back to today, or
                  latest photos". Hidden when timeline is empty. */}
              {yearGroups.length > 0 && (
                <IconTooltip label={`Jump to ${yearGroups[0][0]} (most recent)`} side="bottom">
                  <button
                    onClick={() => jumpToYear(yearGroups[0][0])}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-border bg-secondary/50 hover:bg-secondary text-xs font-medium text-foreground transition-colors shrink-0"
                    data-testid="button-jump-to-latest"
                  >
                    <ArrowUpToLine className="w-3 h-3" />
                    Jump to latest
                  </button>
                </IconTooltip>
              )}
              {/* "Show On This Day" — restores the dismissed AI
                  suggestion card. Only rendered when the card is
                  currently hidden AND there's something to suggest
                  (otd has entries) — no point teasing a restore link
                  for an empty surface. Pill style matches Jump to
                  latest so the controls row feels uniform. */}
              {otdHidden && onThisDay.length > 0 && (
                <IconTooltip label="Show the On This Day AI suggestion" side="bottom">
                  <button
                    onClick={showOnThisDay}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-primary/30 bg-primary/10 hover:bg-primary/20 text-xs font-medium text-foreground transition-colors shrink-0"
                    data-testid="otd-show"
                  >
                    <Sparkles className="w-3 h-3 text-primary" />
                    Show On This Day
                  </button>
                </IconTooltip>
              )}
            </div>
            {/* `data-tour="mem-controls"` wraps both static controls so
                step 3 of the Memories tour has a guaranteed spotlight
                target. Replaces the previous `mem-on-this-day` step
                which was conditional on having past-year photos for
                today's date — users with no historical photos for today
                saw a centered tooltip and no highlight (Terry's report
                May 7 2026). */}
            <div className="flex items-center gap-3 shrink-0" data-tour="mem-controls">
              {/* v2.0.15 (Terry 2026-05-29) — REMOVED year-level
                  refresh button. Refresh consolidated into the
                  titlebar (next to the Recycle Bin icon). This view
                  subscribes to pdr:refreshActiveView (see the
                  useEffect below) and bumps refreshTick when fired. */}
              <DensityToggle value={density} onChange={changeDensity} />
              <LibrarySelector libraries={libraries} selectedKeys={libraryKeys} onChange={setLibraryKeys} />
            </div>
          </>
        );
        if (headerControlsTarget) {
          // Portal into the slot MemoriesPanel set aside next to the
          // [By Date | Albums] toggle. No standalone row is rendered
          // here — the photo grid moves up by exactly that one row.
          return createPortal(controlsContent, headerControlsTarget);
        }
        return (
          <div className="shrink-0 px-6 pt-4 pb-3 border-b border-border/60 flex items-center justify-between gap-4 flex-wrap">
            {controlsContent}
          </div>
        );
      })()}

      {buckets.length === 0 && !loading ? (
        // Rich first-launch empty state. The previous "Nothing to show
        // here yet." line read as a budget app — Terry asked for
        // something that explains what Memories DOES, what users will
        // see once they've run a Fix, and how to get there. Layout:
        // (a) hero (icon + headline + 1-sentence pitch),
        // (b) three feature mini-cards (timeline / On This Day /
        //     slideshow), so the user knows what to expect,
        // (c) gold-tinted storage tip referencing Drive Advisor — gold
        //     is the Memories brand accent (--color-gold), used here for
        //     the tip card so the surface still feels "Memories-y"
        //     even before a single photo lands,
        // (d) a primary CTA dispatching `pdr:goWorkspace` — workspace
        //     listens for that event and switches the active view back
        //     to the dashboard (where Add Source lives).
        <div className="flex-1 overflow-y-auto p-6 sm:p-10 flex items-start justify-center">
          <div className="max-w-2xl w-full mx-auto">
            {/* Hero */}
            <div className="text-center mb-8">
              <div className="inline-flex w-16 h-16 rounded-2xl bg-primary/10 items-center justify-center mb-4">
                <CalendarRange className="w-8 h-8 text-primary" />
              </div>
              <h2 className="text-2xl font-semibold text-foreground mb-2">Your Memories will appear here</h2>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-lg mx-auto">
                Once you've added sources and run your first Fix, every photo and video PDR has corrected will be sorted into a year-by-year timeline. Click any year to drill into the months; click a month to see a day-by-day grid.
              </p>
            </div>

            {/* What you'll get — three feature cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
              <div className="rounded-xl border border-border bg-card p-4 flex flex-col items-center text-center gap-2">
                <CalendarRange className="w-6 h-6 text-primary" />
                <p className="text-xs font-semibold text-foreground">Chronological timeline</p>
                <p className="text-[11px] text-muted-foreground leading-snug">Every fixed photo and video, sorted year-by-year and month-by-month across decades.</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-4 flex flex-col items-center text-center gap-2">
                <Sparkles className="w-6 h-6 text-primary" />
                <p className="text-xs font-semibold text-foreground">On This Day</p>
                <p className="text-[11px] text-muted-foreground leading-snug">A row of photos taken on this calendar date in past years — a nice surprise on a quiet morning.</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-4 flex flex-col items-center text-center gap-2">
                <PlayCircle className="w-6 h-6 text-primary" />
                <p className="text-xs font-semibold text-foreground">Slideshow viewer</p>
                <p className="text-[11px] text-muted-foreground leading-snug">Open any day, month or year and play through it as a slideshow with persistent rotation.</p>
              </div>
            </div>

            {/* Storage tip — gold-tinted (Memories brand accent) */}
            <div
              className="rounded-xl p-4 mb-6"
              style={{
                backgroundColor: '#fef7e6',
                borderColor: 'var(--color-gold)',
                borderWidth: '1px',
                borderStyle: 'solid',
              }}
            >
              <div className="flex items-start gap-3">
                <HardDrive className="w-5 h-5 shrink-0 mt-0.5" style={{ color: '#b07a18' }} />
                <div className="space-y-1.5 text-xs leading-relaxed">
                  <p className="font-semibold text-foreground">Before you start — pick a Library Drive with plenty of room</p>
                  <p className="text-muted-foreground">PDR copies your fixed files to your Library Drive without modifying the originals. The <strong className="text-foreground font-medium">Library Drive Advisor</strong> rates each connected drive on speed and capacity, so you can pick one with comfortable headroom for the size of library you're building.</p>
                </div>
              </div>
            </div>

            {/* Primary CTA → back to Workspace where Add Source lives */}
            <div className="flex justify-center">
              <Button
                variant="primary"
                onClick={() => window.dispatchEvent(new CustomEvent('pdr:goWorkspace'))}
                className="gap-2"
              >
                Go to Workspace to add your first Source
                <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Left: year jump rail */}
          {(yearGroups.length > 1 || pendingCounts.total > 0) && (
            <aside className="w-[68px] shrink-0 border-r border-border/60 overflow-y-auto py-4 px-1 text-center">
              {/* v2.1 round 69 (Terry 2026-06-09) — "Needs dates" rail
                  entry. Renamed from "Pending" — self-explanatory beats
                  single-word for a sidebar nav that the user may glance
                  at without reading the tooltip. Two-line wrap in the
                  68px rail is intentional: it visually differentiates
                  this row from the 4-digit year buttons below. Pulse
                  dot still signals "something to show". Tier selection
                  happens via the title dropdown on the destination
                  page. Self-hides when count is zero. */}
              {pendingCounts.total > 0 && (
                <>
                  <IconTooltip
                    label={`${pendingCounts.total.toLocaleString()} files need a date decision — ${pendingCounts.tentative} Tentative · ${pendingCounts.placeholder} Placeholder · ${pendingCounts.unrecorded} Unrecorded`}
                    side="right"
                  >
                    {/* v2.1 round 78 (Terry 2026-06-09) — pulsing dot
                        removed (Terry: "I've failed to see what the
                        fuck the dot is"); the entry's existence is
                        signal enough that there's work to do, since
                        the whole row self-hides at count zero. With
                        the dot gone, "Needs" and "dates" are each
                        block-centered on their own line, so the
                        two-line label aligns properly down the rail. */}
                    <button
                      onClick={() => setPendingScope({})}
                      className="w-full px-1 py-1.5 rounded text-[11px] font-semibold text-purple-600 dark:text-purple-300 hover:bg-purple-500/10 transition-colors flex flex-col items-center justify-center leading-tight"
                      data-testid="memories-rail-pending"
                    >
                      <span>Needs</span>
                      <span>dates</span>
                    </button>
                  </IconTooltip>
                  {/* v2.1 round 75 (Terry 2026-06-09) — divider needs
                      VISIBLE breathing room above and below so it
                      reads as a section separator, not as the bottom
                      edge of the "Needs dates" pill. Round 71's
                      `my-0` made the line touch the pill, which made
                      Needs-dates look like a heading-of-2026 rather
                      than its own section. `my-2` gives 8px symmetric
                      padding on each side of the hairline, so the
                      divider sits visibly centred between the
                      lavender outline and the first year number. */}
                  <div className="border-t border-border my-2 mx-1" />
                </>
              )}
              {yearGroups.map(([year]) => (
                <IconTooltip key={year} label={`Jump to ${year}`} side="right">
                  <button
                    onClick={() => jumpToYear(year)}
                    className="w-full px-1 py-1.5 mb-0.5 rounded text-xs font-mono text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
                  >
                    {year}
                  </button>
                </IconTooltip>
              ))}
            </aside>
          )}

          {/* Main scroll area */}
          <div className="flex-1 overflow-y-auto">
            {/* On This Day row — premium-event styling so it reads as
                a curated suggestion rather than another scroll-row
                (Terry 2026-05-19: "should look like more of an
                event… it just looks like the same as the other rows,
                they all blend into one"). Soft lavender gradient
                card + AI-suggestion badge + larger heading make the
                hierarchy obvious. `data-tour="mem-on-this-day"` is
                the spotlight target for step 3 of the Memories tour. */}
            {onThisDay.length > 0 && !otdHidden && otdReady && (
              <section
                className="mx-6 mt-6 mb-4 p-4 rounded-2xl bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border border-primary/20 shadow-sm relative"
                data-tour="mem-on-this-day"
              >
                {/* Hide button. Sets a persistent localStorage flag so
                    the card stays dismissed across sessions. The
                    counterpart "Show On This Day" link appears in the
                    header controls slot when this is hidden, so it's
                    always recoverable. Terry 2026-05-20. */}
                <IconTooltip label="Hide this AI suggestion" side="left">
                  <button
                    onClick={hideOnThisDay}
                    className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label="Hide On This Day"
                    data-testid="otd-hide"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </IconTooltip>
                <div className="flex items-center gap-2 mb-2">
                  {/* v2.1 round 66 (Terry 2026-06-09) — AI Suggestion
                      badge now uses the PM purple recipe instead of
                      the generic lavender brand. PM established
                      bg-purple-500/15 + text-purple-600 + ring-purple-
                      500/30 as the visual signature for "AI did
                      something" (face clustering, named-count badges,
                      etc.); reusing it here ties the OnThisDay strip
                      into the same family so users learn ONE colour
                      means "this came from PDR's AI." */}
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-500/15 text-[10px] font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-300 ring-1 ring-purple-500/30">
                    <Sparkles className="w-3 h-3" />
                    AI suggestion
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {onThisDay.length} {onThisDay.length === 1 ? 'photo' : 'photos'}
                  </span>
                </div>
                <div className="mb-3 pr-8">
                  <h2 className="text-base font-bold text-foreground leading-tight">On {otdLabel} in previous years</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Photos taken on this date in earlier years — rediscover what you were up to.
                  </p>
                </div>
                <div className={`flex ${density === 'tight' ? 'gap-0' : 'gap-2.5'} overflow-x-auto pb-2`}>
                  {onThisDay.map((item, idx) => (
                    <IconTooltip key={item.id} label={`${item.filename} · ${formatHumanDate(item.derived_date)}`} side="top">
                    <button
                      // First thumbnail carries `data-tour="mem-open"`
                      // for step 4 of the Memories tour ("Open a
                      // Memory"). Direct attribute (not conditional
                      // spread) — undefined values get omitted by the
                      // DOM, same effect with one fewer prop-merge
                      // edge case to worry about. Tour silently skips
                      // the highlight when On This Day is empty —
                      // same conditional gate as `mem-on-this-day`.
                      data-tour={idx === 0 ? 'mem-open' : undefined}
                      // Pass the full strip + this item's index so the
                      // viewer's left/right arrows browse the rest of
                      // the "On this day in previous years" set.
                      onClick={() => openSearchViewer(onThisDay.map(o => o.file_path), onThisDay.map(o => o.filename), idx)}
                      className={`group relative shrink-0 w-[140px] h-[140px] overflow-hidden bg-secondary/30 transition-all ${otdTileClass}`}
                    >
                      {thumbs[item.file_path] ? (
                        <img src={thumbs[item.file_path]} alt={item.filename} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground/70">
                          {item.file_type === 'video' ? <Film className="w-5 h-5" /> : <ImageIcon className="w-5 h-5" />}
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-2 pb-1.5 pt-6 text-left">
                        <div className="text-[10px] text-white/70 uppercase tracking-wider">{item.year}</div>
                        <div className="text-[11px] text-white/90 truncate">{item.filename}</div>
                      </div>
                      {item.file_type === 'video' && (
                        <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-[9px] font-medium flex items-center gap-1">
                          <Film className="w-2.5 h-2.5" /> Video
                        </div>
                      )}
                      {/* v2.1 round 58 (Terry 2026-06-09) — lavender
                          "T" indicator at bottom-right when this video
                          has a transcript. OnThisDay items don't carry
                          caption metadata, so hasCaption is always
                          false here — badge claims the corner. */}
                      <TranscriptBadge hasTranscript={transcribedFileIds.has(item.id)} />
                    </button>
                    </IconTooltip>
                  ))}
                </div>
              </section>
            )}

            {/* Main timeline — year groups with month tiles.
                `data-tour="mem-rows"` is the spotlight target for step 2
                of the Memories tour ("Time Rows"). */}
            <section className="px-6 pb-10 space-y-8" data-tour="mem-rows">
              {yearGroups.map(([year, monthBuckets]) => {
                const yearPhotos = monthBuckets.reduce((s, b) => s + (b.photoCount || 0), 0);
                const yearVideos = monthBuckets.reduce((s, b) => s + (b.videoCount || 0), 0);
                return (
                  <div key={year} id={`memories-year-${year}`} className="scroll-mt-4">
                    <div className="flex items-baseline gap-3 mb-3 sticky top-0 bg-background/95 backdrop-blur py-2 z-10">
                      {/* Year label is now clickable — opens a year-wide
                          drilldown showing every file in that year.
                          Hover ring + cursor signal "this is a button". */}
                      <IconTooltip label={`Open all of ${year}`} side="bottom">
                        <button
                          type="button"
                          onClick={() => openYear(year)}
                          className="text-lg font-semibold text-foreground hover:text-primary transition-colors cursor-pointer"
                        >
                          {year}
                        </button>
                      </IconTooltip>
                      <span className="text-xs text-muted-foreground">
                        {yearPhotos.toLocaleString()} {yearPhotos === 1 ? 'photo' : 'photos'}
                        {yearVideos > 0 && ` · ${yearVideos.toLocaleString()} ${yearVideos === 1 ? 'video' : 'videos'}`}
                      </span>
                    </div>
                    <div className={`grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] ${gridGap}`}>
                      {monthBuckets.map((b, idx) => (
                        <MonthTile
                          key={`${b.year}-${b.month}`}
                          bucket={b}
                          onOpen={() => openMonth(b.year, b.month)}
                          density={density}
                          enterIndex={idx}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Library selector ──────────────────────────────────────────────────────

function LibrarySelector({ libraries, selectedKeys, onChange }: { libraries: Library[]; selectedKeys: string[]; onChange: (keys: string[]) => void }) {
  // Hide entirely when there's only one logical library — nothing to choose
  // between. Destinations alone don't create separate libraries; parallel
  // structures (when they ship) will surface as distinct entries here
  // because they carry a different source-labels signature.
  if (libraries.length <= 1) return null;
  const allSelected = selectedKeys.length === libraries.length;
  const noneSelected = selectedKeys.length === 0;
  const summary = allSelected
    ? `All libraries (${libraries.length})`
    : noneSelected
      ? 'No libraries'
      : `${selectedKeys.length} of ${libraries.length}`;
  const toggle = (key: string) => {
    if (selectedKeys.includes(key)) {
      onChange(selectedKeys.filter((k) => k !== key));
    } else {
      onChange([...selectedKeys, key]);
    }
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-border bg-background hover:bg-muted/40 text-xs font-medium text-foreground transition-colors"
          data-testid="memories-library-selector"
        >
          <Layers className="w-3.5 h-3.5 text-muted-foreground" />
          <span>{summary}</span>
          <ChevronRight className="w-3 h-3 text-muted-foreground rotate-90" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        {/* Select all / Clear all — match S&D's pattern: HIDE the
            button rather than disabling it when it'd be a no-op. Mixed
            with the literal `checked` below, this means Clear all
            triggers a visible UI change (boxes empty out + button
            disappears) every time it's clicked, instead of silently
            doing nothing because the old "empty = all" shortcut left
            every box visually ticked. */}
        <div className="flex items-center justify-between px-2 pt-1 pb-2 border-b border-border mb-1">
          <span className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider">Libraries</span>
          <div className="flex items-center gap-2 text-[11px]">
            {!allSelected && (
              <button
                type="button"
                onClick={() => onChange(libraries.map((l) => l.key))}
                className="px-2 py-1 font-medium rounded-md text-foreground hover:bg-primary/5 transition-colors"
                data-testid="memories-library-select-all"
              >
                Select all
              </button>
            )}
            {!noneSelected && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="px-2 py-1 font-medium rounded-md text-foreground hover:bg-primary/5 transition-colors"
                data-testid="memories-library-clear-all"
              >
                Clear all
              </button>
            )}
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {libraries.map((lib) => {
            // Literal — drop the "OR length===0" shortcut that previously
            // made every box still appear ticked after Clear all,
            // hiding the change from the user. Matches S&D's
            // FilterCheckbox pattern.
            const checked = selectedKeys.includes(lib.key);
            return (
              <label
                key={lib.key}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(lib.key)}
                  className="rounded border-border text-primary focus:ring-primary/40"
                />
                <span className="flex-1 text-sm text-foreground truncate">{lib.label}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                  {lib.fileCount.toLocaleString()}
                </span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Month tile ────────────────────────────────────────────────────────────

function MonthTile({ bucket, onOpen, density, enterIndex = 0 }: { bucket: MemoriesYearBucket; onOpen: () => void; density: Density; enterIndex?: number }) {
  const total = (bucket.photoCount || 0) + (bucket.videoCount || 0);
  const tight = density === 'tight';
  // Self-fetched thumbnail. Each tile observes its own visibility
  // and only fetches when it enters the viewport (with a 600px
  // lead margin so the next strip of tiles loads just before the
  // user scrolls to them). Replaces the previous up-front
  // load-every-month-thumbnail-on-mount pool which made first-
  // Memories-click feel slow — for a 200-month timeline that was
  // 200 IPC round-trips and 200 React state writes on mount, even
  // though only ~36 tiles are visible (Terry 2026-05-20:
  // "Surely it only needs to fire up the visible thumbnails…").
  // Disk-cached thumbnails (warmed by workspace.tsx's prewarm)
  // resolve in under a millisecond per IPC, so this stays
  // smooth even when scrolling fast.
  const tileRef = useRef<HTMLButtonElement>(null);
  // Seed thumb from the Welcome-page prefetch when available. The
  // very first render of MonthTile then already has the image, no
  // IntersectionObserver fetch needed. Falls back to null when the
  // prefetch hasn't populated this path (cold open, very fast
  // click, or a bucket added since Welcome was last visited) —
  // observer below picks up those cases.
  const [thumb, setThumb] = useState<string | null>(() => {
    const path = bucket.sampleFilePath;
    if (!path) return null;
    return getPrefetchedThumb(path) ?? null;
  });
  // Skip the IntersectionObserver entirely when the prefetch
  // already supplied a thumb on first render — no point watching
  // for visibility when the image is already correct.
  const requestedRef = useRef<boolean>(thumb !== null);
  // v2.0.13 (Terry 2026-05-26) — when the user sets a custom monthly
  // thumbnail via right-click, the parent re-fetches buckets so
  // `bucket.sampleFilePath` changes for this tile. The useState init
  // above only runs on mount, and the previous useEffect early-returned
  // when `requestedRef.current` was true — so the displayed thumb
  // stayed on the OLD sample (the default auto-picked one). Track the
  // last-rendered sample path and reset state when it changes; the
  // observer flow then picks up the new path on visibility, or the
  // prefetch lookup wins if it's been populated for the new path.
  const lastSamplePathRef = useRef<string | null | undefined>(bucket.sampleFilePath);
  useEffect(() => {
    const samplePath = bucket.sampleFilePath;
    const pathChanged = lastSamplePathRef.current !== samplePath;
    lastSamplePathRef.current = samplePath;
    if (pathChanged) {
      // Reset state for the new sample path. Re-read prefetch in case
      // it's been populated since mount; if not, the observer below
      // (or an immediate fetch) handles the cold case.
      if (!samplePath) {
        setThumb(null);
        requestedRef.current = false;
      } else {
        const prefetched = getPrefetchedThumb(samplePath);
        if (prefetched) {
          setThumb(prefetched);
          requestedRef.current = true;
        } else {
          setThumb(null);
          requestedRef.current = false;
        }
      }
    }
    if (!samplePath) return;
    if (requestedRef.current) return;
    const el = tileRef.current;
    if (!el) return;
    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !requestedRef.current) {
          requestedRef.current = true;
          observer.unobserve(el);
          (async () => {
            try {
              const r = await getThumbnail(samplePath, 160);
              if (!cancelled && r.success && r.dataUrl) setThumb(r.dataUrl);
            } catch { /* per-tile failure is non-fatal — placeholder stays */ }
          })();
          break;
        }
      }
    }, { rootMargin: '600px 0px' });
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [bucket.sampleFilePath]);
  return (
    <IconTooltip label={`${MONTH_NAMES[bucket.month - 1]} ${bucket.year} · ${total.toLocaleString()} files`} side="top">
    <button
      ref={tileRef}
      onClick={() => onOpen()}
      // Premium hover: 2px lift + softer shadow when in spacious
      // (rounded) mode where the grid has breathing room (gap-2).
      // Tight mode keeps the flat look — its gap-1 tiles are too
      // close-packed for a lift to read cleanly. ease-out 200ms
      // matches the FileCard hover timing for consistency.
      //
      // First-paint stagger: each tile fades + rises 4px into
      // place on mount, delayed by enterIndex * 30ms (capped at 8
      // cells so the longest delay is 240ms — past that the
      // stagger becomes a slog). fill-mode-both keeps the tile
      // invisible BEFORE its delay runs and at the end state
      // AFTER the animation completes.
      className={`group relative aspect-[4/3] overflow-hidden bg-secondary/30 transition-all duration-200 ease-out text-left animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both ${tight ? '' : 'rounded-xl ring-1 ring-border hover:ring-primary/50 hover:-translate-y-[2px] hover:shadow-lg hover:z-10'}`}
      // animationDuration set via style to avoid clashing with the
      // duration-200 class above (Tailwind's duration utility
      // affects both transition AND animation in tw-animate-css).
      style={{ animationDelay: `${Math.min(enterIndex, 8) * 30}ms`, animationDuration: '400ms' }}
    >
      {thumb ? (
        <img src={thumb} alt={`${MONTH_NAMES[bucket.month - 1]} ${bucket.year}`} className="absolute inset-0 w-full h-full object-cover transition-transform group-hover:scale-105" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/70">
          <ImageIcon className="w-8 h-8" />
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 p-3">
        <div className="text-white font-semibold text-sm leading-tight">{MONTH_NAMES[bucket.month - 1]}</div>
        <div className="text-white/70 text-[11px] mt-0.5">
          {bucket.photoCount > 0 && `${bucket.photoCount.toLocaleString()} ${bucket.photoCount === 1 ? 'photo' : 'photos'}`}
          {bucket.photoCount > 0 && bucket.videoCount > 0 && ' · '}
          {bucket.videoCount > 0 && `${bucket.videoCount.toLocaleString()} ${bucket.videoCount === 1 ? 'video' : 'videos'}`}
        </div>
      </div>
    </button>
    </IconTooltip>
  );
}

// ─── Day drill-down ────────────────────────────────────────────────────────

function MemoriesDayDrilldown({ year, month, day, runIds, density, onDensityChange, onBack, onRequestRefresh, allYearBuckets, onNavigateToRange }: { year: number; month?: number; day?: number; runIds: number[] | undefined; density: Density; onDensityChange: (d: Density) => void; onBack: () => void; onRequestRefresh: () => void; allYearBuckets: MemoriesYearBucket[]; onNavigateToRange: (year: number, month?: number, day?: number) => void }) {
  const [files, setFiles] = useState<IndexedFile[] | null>(null);
  // v2.0.15 (Terry 2026-06-02) — controlled open state for the month
  // picker Popover so clicking a month closes the dropdown
  // immediately. Without this Radix kept the popover open until the
  // user clicked outside.
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  // v2.1 round 97 (Terry 2026-06-11) — year-picker dropdown on the
  // year-view title. Mirrors the month picker primitive (Popover +
  // PopoverTrigger + PopoverContent) so the two surfaces feel of-a-
  // piece. Open state lives at the component root because the title
  // render is inside an IIFE that can't carry its own React state.
  const [yearPickerOpen, setYearPickerOpen] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  // Selection mode toggle — when on, checkboxes are visible by
  // default (not only on hover). Mirrors the S&D "Select" button
  // contract so users without keyboards can still drive multi-
  // select. Terry 2026-05-19: "I want you to include the select
  // button as shown in the screenshot from S&D. This will make
  // it easier for people that can't use the keyboard for
  // whatever reason."
  const [selectionMode, setSelectionMode] = useState(false);

  // Multi-select state — same model as S&D so users can build albums
  // while browsing chronologically. Terry 2026-05-18: "There should
  // be the same photo checking/selecting available in Memories—By
  // Date as what is in S&D... this will enable users to create
  // albums or add to them as they see photos in a chronological
  // view." Plain click still opens the viewer; Ctrl/Cmd+click
  // toggles selection; Shift+click range-selects; checkbox click
  // also toggles. Mirrors SearchPanel's FileCard contract.
  const [selectedFileIds, setSelectedFileIds] = useState<Set<number>>(new Set());
  const lastClickedIndexRef = useRef<number | null>(null);
  // v2.0.15 (Terry 2026-06-01) — open trigger for AddToAlbumPopover.
  // Bumped by the per-tile context menu's "Add to album…" item so
  // the picker opens directly instead of requiring the user to then
  // hunt down the pill in the header.
  const [addToAlbumOpenTick, setAddToAlbumOpenTick] = useState(0);
  const toggleSelection = (file: IndexedFile, mode?: 'add' | 'remove') => {
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

  // v2.1 (Terry 2026-06-07) — batch video transcription. Loops the
  // existing single-video viewer:transcribeVideo IPC (idempotent —
  // already-transcribed videos return instantly from the DB cache,
  // so the per-call cost on a re-run is one round-trip). Progress
  // surfaces in a sonner promise toast with current/total + the
  // inner Whisper phase. Worker is serial (one Whisper inference
  // at a time keeps CPU spikes within the half-cores cap), so this
  // is genuinely a queue.
  // v2.1 round 35 (Terry 2026-06-08) — transcribe flow extracted to a
  // reusable hook so AlbumsView and SearchPanel can use the same
  // modal + Whisper-batch pipeline behind their right-click
  // Transcribe items. MemoriesView is now just a consumer.
  const { transcribe: transcribeSelectedVideos, isBatchTranscribing: batchTranscribing } = useTranscribeVideos();

  // Clear selection on drilldown navigation — when the user clicks
  // a different year/month/day, the old selection is no longer
  // referenceable in the new file list.
  useEffect(() => { clearSelection(); }, [year, month, day]);

  // v2.0.14 — "Captioned only" filter, mirrored from AlbumsView. Resets
  // on year/month/day change so a niche filter doesn't silently follow
  // the user across the timeline.
  const [captionedOnly, setCaptionedOnly] = useState(false);
  // v2.1 round 26 (Terry 2026-06-08) — Show filter switched from
  // two independent booleans back to a radio for Type. Reason:
  // checkbox mode let users untick both Photos AND Videos and stare
  // at an empty grid, AND it tempted the wrong mental model on the
  // Captioned row (Terry: "3 things selected inside the dropdown
  // but only 1 photo being shown"). Radio guarantees exactly one
  // Type is always selected, so the grid can never be empty by
  // construction. Captioned is still a separate independent
  // checkbox below — it refines whichever Type is active.
  // Two-step migration:
  //   1. Round-24 keys (pdr-memories-show-photos / pdr-memories-
  //      show-videos) → derive the equivalent radio value.
  //   2. Legacy pdr-memories-media-filter ('all'|'photos'|'videos')
  //      from round 23 still works directly.
  const [mediaFilter, setMediaFilter] = useState<'all' | 'photos' | 'videos'>(() => {
    try {
      const sp = localStorage.getItem('pdr-memories-show-photos');
      const sv = localStorage.getItem('pdr-memories-show-videos');
      if (sp === '0' && sv === '1') return 'videos';
      if (sp === '1' && sv === '0') return 'photos';
      if (sp === '1' && sv === '1') return 'all';
      const legacy = localStorage.getItem('pdr-memories-media-filter');
      if (legacy === 'photos' || legacy === 'videos') return legacy;
      return 'all';
    } catch { return 'all'; }
  });
  useEffect(() => {
    try { localStorage.setItem('pdr-memories-media-filter', mediaFilter); } catch {}
  }, [mediaFilter]);
  useEffect(() => { setCaptionedOnly(false); }, [year, month, day]);

  // Tile size — Ctrl+scroll to zoom, persisted across sessions.
  const [tileSizeSlider, setTileSizeSlider] = useState<number>(() => {
    if (typeof localStorage === 'undefined') return 35;
    const saved = parseInt(localStorage.getItem('pdr-memories-tile-size') || '', 10);
    return isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 35;
  });
  useEffect(() => {
    try { localStorage.setItem('pdr-memories-tile-size', String(tileSizeSlider)); } catch {}
  }, [tileSizeSlider]);

  // Which fields show in each tile's footer overlay. Defaults to NONE
  // — pure photos, no captions — since the user explicitly asked to
  // be able to remove the filename. Persists across sessions.
  const [metaFields, setMetaFields] = useState<DrilldownMetaField[]>(() => {
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('pdr-memories-tile-meta') : null;
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem('pdr-memories-tile-meta', JSON.stringify(metaFields)); } catch {}
  }, [metaFields]);
  const [showMetaDropdown, setShowMetaDropdown] = useState(false);
  const showFilename = metaFields.includes('filename');
  const showDate = metaFields.includes('date');
  // v2.1 round 58 (Terry 2026-06-09) — set of file_ids with a
  // transcript on disk. Drives the lavender "T" TranscriptBadge
  // rendered next to CaptionBadge on each video tile below. The
  // round-57 localStorage-backed `showTranscriptBadge` toggle was
  // removed in favour of the existing Settings → Privacy &
  // Security → "Hide transcripts" switch (so transcripts and
  // captions share the same privacy lever pattern). TranscriptBadge
  // reads that setting via useHideVideoTranscripts internally.
  const [transcribedFileIds] = useTranscribedFileIds();
  // v2.1 round 41 (Terry 2026-06-08) — grace-close hooks for the
  // three toolbar dropdowns. 1500 ms after the mouse leaves both
  // trigger and content, the dropdown auto-closes. Re-entry cancels.
  const mediaFilterGrace = usePopoverGraceClose(1500);
  const insightsGrace = usePopoverGraceClose(1500);
  const actionsGrace = usePopoverGraceClose(1500);

  // v2.1 round 40 (Terry 2026-06-08, take 2) — capture Ctrl/Cmd at
  // mousedown time rather than relying on the click event's modifier
  // flag. Terry's report: "when I first go to Memories... Ctrl+left-
  // click on the image, PDRV will open... if I release CTRL and try
  // again, the next time it works perfectly."
  //
  // The previous attempt (a document keydown tracker) had a gap:
  // if Ctrl was pressed BEFORE Memories mounted (the exact failing
  // case — user holds Ctrl, clicks the Memories tab, clicks a tile),
  // the keydown for that already-held Ctrl never fired inside the
  // tracker because the listener attached AFTER the press. So the
  // ref stayed false on the first click.
  //
  // The new approach: read the modifier at MOUSEDOWN time on the
  // tile button itself. mousedown fires the instant the physical
  // button press happens, before any focus shift / event-loop yield.
  // Its ctrlKey is sampled directly from the OS keyboard state at
  // press time — there's no race window for it to be stale. We
  // stash it in a ref keyed by the file ID being pressed, then the
  // onClick handler reads from the ref as the source of truth.
  // Safe to OR with e.ctrlKey for the normal (non-racy) path so
  // nothing regresses.
  const pressModifierRef = useRef<{ id: number | null; ctrl: boolean }>({ id: null, ctrl: false });

  // Ctrl+scroll zoom on the grid container — same gesture Workspace
  // and PM use, so the muscle memory transfers. The wheel listener
  // attaches to the scroll area (not window) so vertical scrolling
  // outside the grid keeps working normally. preventDefault on
  // ctrl-wheel stops the OS from also zooming the whole window.
  const gridScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      // CRITICAL: stop the event before it bubbles up to the
      // window-level Ctrl+wheel listener in workspace.tsx, which
      // zooms the WHOLE Workspace UI (60–150%) and persists to
      // pdr-workspace-zoom. Without this, every Memories tile-zoom
      // gesture also pulled the workspace zoom — that's the
      // "Workspace shrinks while I scroll Memories tiles" bug.
      // stopImmediatePropagation also blocks any other native wheel
      // listeners on the same chain from running.
      e.stopPropagation();
      e.stopImmediatePropagation();
      setTileSizeSlider(prev => {
        // Wheel up (deltaY < 0) = zoom in (bigger tiles). 5-step
        // increments mirror PM's zoom feel.
        const next = Math.max(0, Math.min(100, prev + (e.deltaY < 0 ? 5 : -5)));
        return next;
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const runIdsKey = runIds ? runIds.join(',') : '';

  // Refetch trigger — local tick that bumps when anything wants the
  // grid re-pulled (recycle move / restore from anywhere, manual
  // Refresh button, etc.). Separate from the parent's refreshTick so
  // the drilldown can react to events that don't bubble through the
  // bucket layer.
  const [drilldownRefreshTick, setDrilldownRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    (async () => {
      // Backend treats missing month/day as "no constraint at this
      // level" — so omitting day → full month, omitting both → full
      // year. Pass null explicitly so the IPC payload is normalised.
      const r = await getMemoriesDayFiles({ year, month: month ?? null, day: day ?? null, runIds });
      if (cancelled) return;
      setFiles(r.success && r.data ? r.data : []);
    })();
    return () => { cancelled = true; };
  }, [year, month, day, runIdsKey, drilldownRefreshTick]);

  // v2.1 (Terry 2026-06-07) — Phase 3a's listener bumps the
  // year-level `refreshTick` but NOT the day-level
  // `drilldownRefreshTick`, so an Enhance or Trim save fired
  // library:filesAdded but the user's day grid (where the new
  // sibling should appear alongside its parent) never re-fetched.
  // This second listener fixes that — same broadcast, day-grid
  // re-runs its getMemoriesDayFiles query and the new file pops in.
  useEffect(() => {
    const off = onLibraryFilesAdded(() => {
      setDrilldownRefreshTick(t => t + 1);
    });
    return () => off();
  }, []);

  // v2.0.15 — when ANY recycle change happens (this view's context
  // menu, the top-bar Delete button, a restore from the Recycle Bin
  // tab), re-fetch the visible files. Without this the just-deleted
  // tile lingered in the grid until the user navigated away and back.
  useEffect(() => {
    const off = onRecycleBinChanged(() => setDrilldownRefreshTick(t => t + 1));
    return () => off();
  }, []);

  // v2.0.15 (Terry 2026-05-29) — titlebar Refresh button dispatches
  // pdr:refreshActiveView. The drilldown listens AND notifies its
  // parent so the year-level buckets re-fetch too. (The parent
  // MemoriesView also listens directly, so even without the drilldown
  // being mounted, refresh still works at the year level.)
  useEffect(() => {
    const handler = () => {
      setDrilldownRefreshTick(t => t + 1);
      onRequestRefresh();
    };
    window.addEventListener('pdr:refreshActiveView', handler as EventListener);
    return () => window.removeEventListener('pdr:refreshActiveView', handler as EventListener);
  }, [onRequestRefresh]);

  // v2.0.13 — keep the in-state caption in sync with edits made via
  // the right-click "Caption…" menu, so the indicator badge appears /
  // disappears immediately without a manual refresh. The event detail
  // carries the new caption value so we patch in place rather than
  // re-fetching the whole files array.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ fileId: number; caption: string }>).detail;
      if (!detail) return;
      setFiles((prev) => prev ? prev.map((f) => f.id === detail.fileId ? { ...f, caption: detail.caption || null } : f) : prev);
    };
    window.addEventListener('pdr:captionsChanged', handler);
    return () => window.removeEventListener('pdr:captionsChanged', handler);
  }, []);

  // v2.0.14 (Terry 2026-05-28) — refresh the in-memory thumb cache
  // when the user rotates a photo in the viewer. Without this the
  // grid keeps showing the pre-rotation thumb until navigated away +
  // back. The disk thumb-cache key already includes user_rotation so
  // the getThumbnail call lands on a fresh entry (or generates one).
  useEffect(() => {
    const off = (window as any).pdr?.viewer?.onRotationChanged?.((data: { filePath: string; rotation: number }) => {
      const fp = data?.filePath;
      if (!fp) return;
      // Drop the stale entry first so the placeholder briefly shows
      // if the refetch is slow — never serve the old rotation.
      setThumbs((prev) => {
        if (!prev[fp]) return prev;
        const { [fp]: _, ...rest } = prev;
        return rest;
      });
      // Refetch at the drilldown grid's tile size (220 — matches the
      // bulk-prewarm worker's getThumbnail call).
      getThumbnail(fp, 220).then((r) => {
        if (r.success && r.dataUrl) {
          setThumbs((prev) => ({ ...prev, [fp]: r.dataUrl }));
        }
      });
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // v2.0.13 (Terry 2026-05-26) — Day grouping + scroll-position
  // affordances.
  //
  // The drilldown used to be a single flat grid of every photo in the
  // year / month / day filter. Scrolling through a busy month felt
  // disorienting because there was no visual indication of which day
  // you were looking at. Three coordinated additions:
  //
  //   1. Per-day section with a sticky header showing the long-form
  //      day ("Tuesday, 7 February 2022 — 23 photos"). Sticks to the
  //      top of the scroll area as the user scrolls past, so the
  //      current day's label is always visible.
  //   2. Floating "current day" pill that fades in while scrolling
  //      and out a moment after the scroll stops. Anchored to the
  //      top-right of the scroll area so it never overlaps photos.
  //   3. Two floating arrow buttons (bottom-right) that jump to the
  //      next / previous day's header. PageDown / PageUp keyboard
  //      shortcuts wired to the same handlers.
  //
  // The per-day grouping is memoised so we don't rebuild on every
  // scroll tick.
  // v2.0.14 — filtered view used by the day-grouping memo + the
  // "Open in Viewer" target. Header counts and the thumb-prewarm pass
  // continue to use the unfiltered `files` so the chip's count reflects
  // the underlying total and we don't re-warm thumbs every toggle.
  const visibleFiles = useMemo(() => {
    if (!files) return null;
    // v2.1 round 26 — Type is a radio (all/photos/videos), Captioned
    // is an independent refinement checkbox. Type filter applied
    // first so the captioned count surfaced in the dropdown reflects
    // only what's visible after the type narrows the bucket.
    let out = files;
    if (mediaFilter === 'photos') out = out.filter((f) => f.file_type === 'photo');
    else if (mediaFilter === 'videos') out = out.filter((f) => f.file_type === 'video');
    if (captionedOnly) out = out.filter((f) => f.caption && f.caption.length > 0);
    return out;
  }, [files, captionedOnly, mediaFilter]);

  // v2.0.14 (Terry 2026-05-27) — grid virtualisation for the drilldown.
  // Year drilldowns can hold 6,000+ photos which means 6,000+ React
  // <button> elements + ContextMenu + CaptionTooltip wrappers. Mounting
  // that many DOM nodes pegs the renderer for 10-15 s on the way into
  // the view, and the white-titlebar flash recurs whenever React's
  // diff runs over the lot (e.g. captioned-only toggle re-render).
  // The virtualiser keeps only the day-groups currently in viewport
  // mounted — typically 3-6 groups — so even a year with thousands of
  // files mounts in tens of milliseconds. Day boundaries stay intact
  // and the existing per-tile interaction code paths are untouched.
  const [containerWidth, setContainerWidth] = useState(1400);
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const filesByDay = useMemo(() => {
    if (!visibleFiles) return [] as Array<{ dayKey: string; date: Date; files: IndexedFile[]; baseIndex: number }>;
    const groups: Array<{ dayKey: string; date: Date; files: IndexedFile[]; baseIndex: number }> = [];
    let currentKey: string | null = null;
    let baseIndex = 0;
    for (let i = 0; i < visibleFiles.length; i++) {
      const f = visibleFiles[i];
      let d: Date | null = null;
      if (f.derived_date) {
        d = new Date(f.derived_date);
        if (isNaN(d.getTime())) d = null;
      }
      // Fallback bucket for files with no parseable date. Rare in a
      // Memories view (which queries by year/month/day), but defend
      // against bad data — they cluster at the bottom under a
      // dedicated header.
      const key = d
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        : '__no-date__';
      if (key !== currentKey) {
        baseIndex = i;
        groups.push({ dayKey: key, date: d ?? new Date(0), files: [f], baseIndex });
        currentKey = key;
      } else {
        groups[groups.length - 1].files.push(f);
      }
    }
    return groups;
  }, [visibleFiles]);

  // v2.0.14 — drilldown row virtualiser. One virtual row per day group.
  // Heights vary (a day with 100 photos is taller than a day with 1),
  // so estimateSize predicts from the photo count + current tile size
  // and react-virtual refines via measureElement after first mount.
  const tilePx = drilldownSliderToPx(tileSizeSlider);
  const tileGap = density === 'tight' ? 0 : 12;
  const colsPerRow = Math.max(1, Math.floor((containerWidth - 48 + tileGap) / (tilePx + tileGap)));
  // v2.0.15 (Terry 2026-06-06) — the CSS grid uses
  // `repeat(auto-fill, minmax(${tilePx}px, 1fr))`, which means the
  // RENDERED tile width is the MINIMUM tilePx (and bigger if the row
  // has leftover space — `1fr` stretches columns to fill). Square
  // tiles then make the rendered height match the rendered width.
  // The estimator must use the actual rendered tile size, NOT the
  // minimum tilePx, or the row height is consistently under-estimated
  // — measureElement then refines the height after first paint, the
  // virtualiser adjusts scroll to keep the visual position stable,
  // and the page reads as "jiggling" for the seconds it takes every
  // newly-virtualised row to settle. Computing the actual stretched
  // width up-front eliminates the diff and the layout stays stable.
  const actualTilePx = colsPerRow > 0
    ? Math.floor((containerWidth - 48 - (colsPerRow - 1) * tileGap) / colsPerRow)
    : tilePx;
  const estimateDayRowHeight = (idx: number): number => {
    const group = filesByDay[idx];
    if (!group) return 200;
    // Header geometry: text-sm (line-height ~20px) + py-2 (16px) +
    // border-b 1px = 37px. The previous 44px estimate was a leftover
    // from an earlier, taller header style and added 7px of error
    // per day group — multiplied across visible rows it was a major
    // contributor to the post-jump layout jitter.
    const HEADER_HEIGHT = 37;
    const ROW_MARGIN_TOP = 12;
    const SECTION_GAP = 20;
    const rows = Math.ceil(group.files.length / colsPerRow);
    const gridHeight = rows * actualTilePx + Math.max(0, (rows - 1) * tileGap);
    return HEADER_HEIGHT + ROW_MARGIN_TOP + gridHeight + SECTION_GAP;
  };
  const rowVirtualizer = useVirtualizer({
    count: filesByDay.length,
    getScrollElement: () => gridScrollRef.current,
    estimateSize: estimateDayRowHeight,
    overscan: 2,
  });
  // When the inputs to estimateSize change (tile size, density,
  // container width, or the file list itself), the cached row heights
  // are stale — force the virtualiser to remeasure.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [tilePx, tileGap, colsPerRow, filesByDay]);

  // v2.0.15 (Terry 2026-06-02) — scroll-to-tile after files load.
  // Back-pill flow latches the file id the user right-clicked from
  // into localStorage; after the day groups land we find which day
  // contains that file and scrollToIndex the virtualiser to it.
  // One-shot: removeItem after read so a stale value can't hijack
  // a future drilldown visit. Day-level granularity is fine because
  // a single day's grid is short enough that the user sees their
  // photo without further scrolling.
  useEffect(() => {
    if (filesByDay.length === 0) return;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem('pdr-memories-pending-scroll-to');
      if (raw) localStorage.removeItem('pdr-memories-pending-scroll-to');
    } catch { return; }
    if (!raw) return;
    const targetId = parseInt(raw, 10);
    if (!Number.isFinite(targetId)) return;
    const groupIndex = filesByDay.findIndex((g) => g.files.some((f) => f.id === targetId));
    if (groupIndex < 0) return;
    const id = requestAnimationFrame(() => {
      rowVirtualizer.scrollToIndex(groupIndex, { align: 'start', behavior: 'auto' });
    });
    return () => cancelAnimationFrame(id);
  }, [filesByDay, rowVirtualizer]);

  // Format the day header label. Full long form so the user can read
  // the date without parsing abbreviations.
  const formatDayHeader = (d: Date, dayKey: string): string => {
    if (dayKey === '__no-date__') return 'No date';
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
  };

  // Current visible day — driven by scroll position. The pill at the
  // top-right shows this label while scrolling.
  const [currentDayKey, setCurrentDayKey] = useState<string | null>(null);
  const [scrollIndicatorVisible, setScrollIndicatorVisible] = useState(false);
  const scrollIndicatorTimeoutRef = useRef<number | null>(null);
  const dayHeaderElsRef = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    const scrollEl = gridScrollRef.current;
    if (!scrollEl) return;
    const recompute = () => {
      if (filesByDay.length === 0) return;
      const scrollTop = scrollEl.scrollTop;
      // v2.0.14 — with virtualisation, dayHeaderElsRef only carries
      // refs for the day groups currently mounted. Use the virtualiser's
      // own row offsets instead — they're the authoritative positions
      // for every row, mounted or not. Find the row whose [start, end)
      // interval straddles the scroll top.
      const virtualItems = rowVirtualizer.getVirtualItems();
      for (const item of virtualItems) {
        if (scrollTop >= item.start && scrollTop < item.start + item.size) {
          setCurrentDayKey(filesByDay[item.index].dayKey);
          return;
        }
      }
      // Edge case: scroll is above all mounted items (very top of list)
      // or past the last mounted item. Default to the first virtual
      // item (the topmost mounted one) so the pill keeps showing
      // something sensible.
      if (virtualItems.length > 0) {
        setCurrentDayKey(filesByDay[virtualItems[0].index].dayKey);
      }
    };
    const onScroll = () => {
      recompute();
      setScrollIndicatorVisible(true);
      if (scrollIndicatorTimeoutRef.current) {
        clearTimeout(scrollIndicatorTimeoutRef.current);
      }
      scrollIndicatorTimeoutRef.current = window.setTimeout(() => {
        setScrollIndicatorVisible(false);
      }, 1200);
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    // Initial computation once headers are in the DOM.
    recompute();
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      if (scrollIndicatorTimeoutRef.current) clearTimeout(scrollIndicatorTimeoutRef.current);
    };
  }, [filesByDay]);

  const goToDayByKey = (dayKey: string) => {
    // v2.0.14 — virtualised rows aren't in DOM until they scroll into
    // view, so rely on the virtualiser's index math instead of the
    // (possibly absent) header ref. align: 'start' puts the day header
    // right at the top of the scroll area, matching the previous
    // offsetTop - 4 behaviour.
    const idx = filesByDay.findIndex((g) => g.dayKey === dayKey);
    if (idx < 0) return;
    // v2.0.14 (Terry 2026-05-28) — 'auto' (instant snap) instead of
    // 'smooth' because the smooth scroll animation rolls past every
    // intervening day's tiles in turn, which on a busy year drilldown
    // looks juddery as the virtualiser mounts/unmounts row after row.
    // Snap-to-place reads as premium; the user already knows where
    // they're going.
    rowVirtualizer.scrollToIndex(idx, { align: 'start', behavior: 'auto' });
  };
  const goToNextDay = () => {
    if (filesByDay.length === 0) return;
    const idx = currentDayKey ? filesByDay.findIndex((g) => g.dayKey === currentDayKey) : -1;
    const next = idx >= 0 && idx < filesByDay.length - 1 ? filesByDay[idx + 1] : null;
    if (next) goToDayByKey(next.dayKey);
  };
  const goToPrevDay = () => {
    if (filesByDay.length === 0) return;
    const idx = currentDayKey ? filesByDay.findIndex((g) => g.dayKey === currentDayKey) : -1;
    const prev = idx > 0 ? filesByDay[idx - 1] : null;
    if (prev) goToDayByKey(prev.dayKey);
  };

  // v2.0.14 (Terry 2026-05-28) — month-step navigation for year
  // drilldowns. PageUp/PageDown only step by day; punching them 30
  // times to skip a month is tedious on a year view with thousands
  // of files. These walk filesByDay until the month boundary changes,
  // then scroll to that day group. "Prev month" walks UP the list
  // (lower index) which after the DESC sort flip is the NEWER month;
  // "Next month" walks DOWN (higher index) = OLDER month.
  const goToPrevMonth = () => {
    if (filesByDay.length === 0 || !currentDayKey) return;
    const currentIdx = filesByDay.findIndex((g) => g.dayKey === currentDayKey);
    if (currentIdx < 0) return;
    const currentMonth = filesByDay[currentIdx].date.getMonth();
    const currentYear = filesByDay[currentIdx].date.getFullYear();
    for (let i = currentIdx - 1; i >= 0; i--) {
      const d = filesByDay[i].date;
      if (d.getMonth() !== currentMonth || d.getFullYear() !== currentYear) {
        goToDayByKey(filesByDay[i].dayKey);
        return;
      }
    }
  };
  const goToNextMonth = () => {
    if (filesByDay.length === 0 || !currentDayKey) return;
    const currentIdx = filesByDay.findIndex((g) => g.dayKey === currentDayKey);
    if (currentIdx < 0) return;
    const currentMonth = filesByDay[currentIdx].date.getMonth();
    const currentYear = filesByDay[currentIdx].date.getFullYear();
    for (let i = currentIdx + 1; i < filesByDay.length; i++) {
      const d = filesByDay[i].date;
      if (d.getMonth() !== currentMonth || d.getFullYear() !== currentYear) {
        goToDayByKey(filesByDay[i].dayKey);
        return;
      }
    }
  };

  // Whether the drilldown spans more than one calendar month — drives
  // the visibility of the month-step column. Year drilldowns always
  // span multiple months; month drilldowns never do; day drilldowns
  // are single-day so the whole arrow stack already hides via the
  // `filesByDay.length > 1` guard.
  const hasMultipleMonths = useMemo(() => {
    if (filesByDay.length < 2) return false;
    const firstMonth = filesByDay[0].date.getMonth();
    const firstYear = filesByDay[0].date.getFullYear();
    return filesByDay.some((g) => g.date.getMonth() !== firstMonth || g.date.getFullYear() !== firstYear);
  }, [filesByDay]);

  // v2.0.14 (Terry 2026-05-28) — month-jump rail for the year
  // drilldown. Mirrors the year-jump rail on the timeline view in
  // both layout (68 px left column, mono labels, hover lavender) and
  // intent (one-click jump to the first day of that month). Only the
  // months that actually have photos in the current drilldown appear,
  // so a year with zero photos in Feb doesn't show a dead "Feb" row.
  const monthBoundaries = useMemo(() => {
    if (filesByDay.length === 0) return [] as Array<{ key: string; month: number; label: string; firstDayKey: string }>;
    const seen = new Set<string>();
    const out: Array<{ key: string; month: number; label: string; firstDayKey: string }> = [];
    for (const g of filesByDay) {
      const y = g.date.getFullYear();
      const m = g.date.getMonth();
      const k = `${y}-${m}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ key: k, month: m, label: MONTH_NAMES[m].slice(0, 3), firstDayKey: g.dayKey });
    }
    return out;
  }, [filesByDay]);
  // v2.0.14 (Terry 2026-05-28) — day-jump rail for the month
  // drilldown. Same shape as the month rail above (and the year rail
  // on the timeline) — sits in the same left-column slot at every
  // depth so the user always has one-click navigation to whichever
  // unit is "below" the current view. Year → months, month → days,
  // day → (nothing, only one day group).
  const dayBoundaries = useMemo(() => {
    if (filesByDay.length === 0) return [] as Array<{ key: string; label: string; firstDayKey: string }>;
    return filesByDay.map((g) => ({
      key: g.dayKey,
      label: String(g.date.getDate()),
      firstDayKey: g.dayKey,
    }));
  }, [filesByDay]);
  // The day rail is the "right depth" only on a month drilldown
  // (month set, day not set). On a year drilldown the month rail is
  // the right granularity; on a day drilldown there's only one day
  // group so no rail. Computed here so the JSX stays a single
  // ternary instead of a nested if.
  const isMonthDrilldown = month != null && day == null && filesByDay.length > 1;

  // Active highlight for the month rail — derived from currentDayKey
  // (which the scroll-listener keeps in sync with the topmost visible
  // day). Compared as `year-month` so a drilldown that crosses years
  // (rare but possible if the source row range spans new year's eve)
  // still highlights correctly.
  const currentMonthKey = useMemo(() => {
    if (!currentDayKey) return null;
    const g = filesByDay.find((x) => x.dayKey === currentDayKey);
    if (!g) return null;
    return `${g.date.getFullYear()}-${g.date.getMonth()}`;
  }, [currentDayKey, filesByDay]);

  // Disabled-state computation for the month arrows. Without this the
  // buttons render enabled while on the first / last month and clicking
  // does nothing silently.
  const monthEdges = useMemo(() => {
    if (!currentDayKey || filesByDay.length === 0) return { hasPrev: false, hasNext: false };
    const idx = filesByDay.findIndex((g) => g.dayKey === currentDayKey);
    if (idx < 0) return { hasPrev: false, hasNext: false };
    const m = filesByDay[idx].date.getMonth();
    const y = filesByDay[idx].date.getFullYear();
    let hasPrev = false, hasNext = false;
    for (let i = 0; i < idx; i++) {
      const d = filesByDay[i].date;
      if (d.getMonth() !== m || d.getFullYear() !== y) { hasPrev = true; break; }
    }
    for (let i = idx + 1; i < filesByDay.length; i++) {
      const d = filesByDay[i].date;
      if (d.getMonth() !== m || d.getFullYear() !== y) { hasNext = true; break; }
    }
    return { hasPrev, hasNext };
  }, [filesByDay, currentDayKey]);

  // PageDown / PageUp keyboard shortcuts for the same navigation.
  // Only active while the scroll container has focus (or no other
  // interactive element claims it) so it doesn't fight with the
  // browser's default Page behaviour on text inputs.
  useEffect(() => {
    const scrollEl = gridScrollRef.current;
    if (!scrollEl) return;
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack when an input / textarea has focus.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'PageDown') {
        e.preventDefault();
        goToNextDay();
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        goToPrevDay();
      }
    };
    scrollEl.addEventListener('keydown', onKey);
    // Make sure the scroll container is focusable for the keys to land.
    if (scrollEl.tabIndex < 0) scrollEl.tabIndex = 0;
    return () => scrollEl.removeEventListener('keydown', onKey);
  }, [filesByDay, currentDayKey]);

  const currentDayLabel = useMemo(() => {
    if (!currentDayKey) return '';
    const g = filesByDay.find((x) => x.dayKey === currentDayKey);
    if (!g) return '';
    return formatDayHeader(g.date, g.dayKey);
  }, [currentDayKey, filesByDay]);

  // Per-day grid thumbnail load — same sliding-window pool pattern
  // as the year/month overview. See the comment on that effect for
  // the why.
  useEffect(() => {
    if (!files) return;
    let cancelled = false;
    const missing = files.filter((f) => !thumbs[f.file_path]);
    if (missing.length === 0) return;
    // v2.0.14 (Terry 2026-05-28) — dropped from 12 to 4. With 12
    // concurrent thumbnail requests in flight at any given moment,
    // main's browser:thumbnail handler + libuv worker pool + disk I/O
    // were all saturated, and the PDR Viewer's pdr-file:// protocol
    // handler had to queue behind them on every photo click (~15 s
    // wait for the first frame). 4 keeps the prewarm itself plenty
    // fast (most thumbs are disk-cache hits at ~10 ms each) and
    // leaves bandwidth for viewer opens, IntersectionObserver fetches,
    // and the AI worker's per-file reads.
    const CONCURRENCY = 4;
    let cursor = 0;
    const worker = async () => {
      while (!cancelled && cursor < missing.length) {
        const i = cursor++;
        const f = missing[i];
        try {
          const r = await getThumbnail(f.file_path, 220);
          if (cancelled) return;
          if (r.success && r.dataUrl) {
            setThumbs((prev) => prev[f.file_path] ? prev : { ...prev, [f.file_path]: r.dataUrl });
          }
        } catch { /* non-fatal */ }
      }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    void Promise.allSettled(workers);
    return () => { cancelled = true; };
  }, [files]);

  // v2.0.14 (Terry 2026-05-28) — viewport-driven thumbnail load. The
  // bulk prewarm above walks `files` in array order, so when the user
  // scrolls to a day in the middle of a year drilldown the tiles wait
  // for the prewarm to crawl to that position — Terry saw 3+ minutes
  // of empty placeholders after scrolling to June 2018. This effect
  // hooks the virtualiser's visible range: any tile that's currently
  // on screen but missing a thumb gets its own getThumbnail call
  // immediately, jumping the queue. Re-fires whenever the range
  // changes (scroll, resize, filter toggle). thumbsRef avoids putting
  // `thumbs` in deps (would infinite-loop since every loaded thumb
  // mutates state).
  const thumbsRef = useRef(thumbs);
  useEffect(() => { thumbsRef.current = thumbs; }, [thumbs]);
  const visibleRangeStart = rowVirtualizer.range?.startIndex ?? -1;
  const visibleRangeEnd = rowVirtualizer.range?.endIndex ?? -1;
  useEffect(() => {
    if (!files || visibleRangeStart < 0 || visibleRangeEnd < 0) return;
    const visibleFilePaths: string[] = [];
    for (let idx = visibleRangeStart; idx <= visibleRangeEnd; idx++) {
      const group = filesByDay[idx];
      if (!group) continue;
      for (const f of group.files) {
        if (!thumbsRef.current[f.file_path]) visibleFilePaths.push(f.file_path);
      }
    }
    if (visibleFilePaths.length === 0) return;
    let cancelled = false;
    const VIEWPORT_CONCURRENCY = 8;
    let cursor = 0;
    const worker = async () => {
      while (!cancelled && cursor < visibleFilePaths.length) {
        const fp = visibleFilePaths[cursor++];
        if (thumbsRef.current[fp]) continue;
        try {
          const r = await getThumbnail(fp, 220);
          if (cancelled || !r.success || !r.dataUrl) continue;
          setThumbs((prev) => prev[fp] ? prev : { ...prev, [fp]: r.dataUrl });
        } catch { /* per-file non-fatal */ }
      }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < VIEWPORT_CONCURRENCY; i++) workers.push(worker());
    void Promise.allSettled(workers);
    return () => { cancelled = true; };
  }, [visibleRangeStart, visibleRangeEnd, filesByDay, files]);

  // v2.0.14 (Terry 2026-05-27) — foreground prewarm for the filtered
  // set. The bulk prewarm above iterates `files` in array order (which
  // is derived_date order, so January files first). On a year drilldown
  // with 6,000+ files the worker pool takes 10-15 s to crawl from
  // January through to a captioned photo in the middle of the year.
  // When the user toggles "Captioned only", their few captioned tiles
  // are visible immediately but their thumbnails are still queued
  // behind 3,000+ January-to-mid-year files. This effect jumps the
  // queue: when the filtered subset is smaller than the full set, we
  // request its thumbnails sequentially with no concurrency cap so
  // they arrive at main ahead of the bulk-prewarm's queued items.
  // Cache hits return in ~10 ms; cache misses still pay the read +
  // sharp resize cost, but at least they're not also queued behind
  // a thousand others.
  useEffect(() => {
    if (!visibleFiles || !files) return;
    if (visibleFiles.length === files.length) return;
    let cancelled = false;
    (async () => {
      for (const f of visibleFiles) {
        if (cancelled) return;
        try {
          const r = await getThumbnail(f.file_path, 220);
          if (cancelled || !r.success || !r.dataUrl) continue;
          setThumbs((prev) => prev[f.file_path] ? prev : { ...prev, [f.file_path]: r.dataUrl });
        } catch { /* per-file failures non-fatal */ }
      }
    })();
    return () => { cancelled = true; };
  }, [visibleFiles, files]);

  // Title adapts to granularity: "2005" / "February 2005" / "February 1, 2005".
  const title = month == null
    ? `${year}`
    : day == null
      ? `${MONTH_NAMES[month - 1]} ${year}`
      : `${MONTH_NAMES[month - 1]} ${day}, ${year}`;

  return (
    <div className="h-full flex flex-col bg-background">
      {/* v2.0.15 (Terry 2026-05-30) — unified toolbar rhythm.
          Every control on this row standardises on h-8 height,
          text-xs typography, and gap-2 spacing so the cluster reads
          as one toolbar instead of a freehand mix. Specialised
          radii (rounded-full for the gold selection chip, rounded-lg
          for the zoom stepper) stay because they signal "this is a
          different KIND of control" — the height + spacing carry the
          family resemblance. */}
      <div className="shrink-0 px-6 py-3 border-b border-border/60 flex items-center gap-2">
        {/* v2.1 round 97 (Terry 2026-06-11) — Back button now wears
            the view-pill shape (lifted from MemoriesPendingView round
            96) — blue tokens preserve nav identity, h-8 + rounded-md
            + border match the rest of the toolbar family. */}
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border border-blue-300 bg-blue-50/60 hover:bg-blue-50 text-blue-800 transition-colors"
          data-testid="memories-drilldown-back"
        >
          <ChevronLeft className="w-3.5 h-3.5" /> Back to timeline
        </button>
        <span className="h-6 w-px bg-border mx-1" aria-hidden="true" />
        {/* v2.0.15 (Terry 2026-06-02) — month picker dropdown. The
            title doubles as a Popover trigger; opening it lists all
            months in the current year that have photos, so the user
            can jump to a sibling month without going back to the
            timeline and re-scrolling. Reuses the same Popover primitive
            as Memories' Add-to-Album / On-This-Day / month sample
            popovers. Title remains static when only the year is in
            scope (no month-level navigation makes sense at that
            depth) or when the parent failed to supply allYearBuckets. */}
        {(() => {
          // v2.1 round 97 (Terry 2026-06-11) — year-view title is now
          // a year-picker pill matching the Media + Display recipe.
          // Dropdown lists ALL years from the earliest dated photo in
          // the library to the latest, including years with zero
          // photos (Terry: "If there's 0, then just state it in the
          // dropdown menu and grey it out"). Static h2 fallback kept
          // for the edge case where allYearBuckets hasn't loaded yet.
          if (!allYearBuckets || allYearBuckets.length === 0) {
            return <h2 className="text-base font-semibold text-foreground leading-none">{title}</h2>;
          }
          if (month == null) {
            // Year view — render the year-picker pill.
            const yearTotals = new Map<number, number>();
            let minYear = Number.POSITIVE_INFINITY;
            let maxYear = Number.NEGATIVE_INFINITY;
            for (const b of allYearBuckets) {
              yearTotals.set(b.year, (yearTotals.get(b.year) ?? 0) + b.photoCount + b.videoCount);
              if (b.year < minYear) minYear = b.year;
              if (b.year > maxYear) maxYear = b.year;
            }
            const yearsRange: Array<{ year: number; total: number }> = [];
            for (let y = maxYear; y >= minYear; y--) {
              yearsRange.push({ year: y, total: yearTotals.get(y) ?? 0 });
            }
            return (
              <Popover open={yearPickerOpen} onOpenChange={setYearPickerOpen}>
                <IconTooltip label="Jump to another year" side="bottom">
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center justify-between gap-1.5 h-8 px-3 rounded-md text-xs font-medium border border-border bg-background hover:bg-accent text-foreground transition-colors min-w-[150px]"
                      data-testid="memories-drilldown-year-picker"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarRange className="w-3.5 h-3.5" />
                        <span className="text-muted-foreground/85">Year:</span>
                        <span>{year}</span>
                      </span>
                      <ChevronDown className="w-3.5 h-3.5 opacity-70" />
                    </button>
                  </PopoverTrigger>
                </IconTooltip>
                <PopoverContent align="start" className="w-56 p-1 max-h-[60vh] overflow-y-auto">
                  <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider px-3 pt-2 pb-1">
                    Jump to year
                  </p>
                  {yearsRange.map((y) => {
                    const isCurrent = y.year === year;
                    const isEmpty = y.total === 0;
                    return (
                      <button
                        key={y.year}
                        type="button"
                        disabled={isEmpty}
                        onClick={() => {
                          setYearPickerOpen(false);
                          if (!isEmpty) onNavigateToRange(y.year);
                        }}
                        className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left rounded-md text-sm transition-colors ${isCurrent ? 'bg-secondary text-foreground font-semibold' : isEmpty ? 'text-muted-foreground/50 cursor-not-allowed' : 'text-foreground hover:bg-muted/50'}`}
                        data-testid={`memories-drilldown-year-${y.year}`}
                      >
                        <span>{y.year}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {isEmpty ? '0' : y.total.toLocaleString()}
                        </span>
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
            );
          }
          // v2.0.15 (Terry 2026-06-06) — newest-first to match the
          // Year timeline (top = most recent year) and the Day rail
          // (top = most recent day). December at top, January at
          // bottom, so all three navigation surfaces share one
          // direction-of-time convention.
          const monthsForYear = allYearBuckets
            .filter((b) => b.year === year)
            .sort((a, b) => b.month - a.month);
          if (monthsForYear.length <= 1) {
            return <h2 className="text-base font-semibold text-foreground leading-none">{title}</h2>;
          }
          // v2.1 round 97 part 4 (Terry 2026-06-11) — month picker
          // now wears the same pill recipe as Year + Media + Display.
          // Trigger: h-8 + rounded-md + border-border + bg-background
          // + min-w-[150px] + justify-between, CalendarRange icon,
          // "Month:" prefix mirroring Year's "Year:" prefix.
          // IconTooltip wraps the trigger like the year picker.
          return (
            <Popover open={monthPickerOpen} onOpenChange={setMonthPickerOpen}>
              <IconTooltip label={`Jump to a different month in ${year}`} side="bottom">
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center justify-between gap-1.5 h-8 px-3 rounded-md text-xs font-medium border border-border bg-background hover:bg-accent text-foreground transition-colors min-w-[150px]"
                    data-testid="memories-drilldown-month-picker"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarRange className="w-3.5 h-3.5" />
                      <span className="text-muted-foreground/85">Month:</span>
                      <span>{MONTH_NAMES[month - 1]}</span>
                    </span>
                    <ChevronDown className="w-3.5 h-3.5 opacity-70" />
                  </button>
                </PopoverTrigger>
              </IconTooltip>
              <PopoverContent align="start" className="w-56 p-1 max-h-[60vh] overflow-y-auto">
                <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider px-3 pt-2 pb-1">
                  Jump to month in {year}
                </p>
                {monthsForYear.map((b) => {
                  const isCurrent = b.month === month;
                  const total = (b.photoCount || 0) + (b.videoCount || 0);
                  return (
                    <button
                      key={b.month}
                      type="button"
                      onClick={() => {
                        setMonthPickerOpen(false);
                        onNavigateToRange(year, b.month);
                      }}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left rounded-md text-sm transition-colors ${isCurrent ? 'bg-secondary text-foreground font-semibold' : 'text-foreground hover:bg-muted/50'}`}
                      data-testid={`memories-drilldown-month-${b.month}`}
                    >
                      <span>{MONTH_NAMES[b.month - 1]}</span>
                      <span className="text-xs text-muted-foreground">{total.toLocaleString()}</span>
                    </button>
                  );
                })}
              </PopoverContent>
            </Popover>
          );
        })()}
        {/* v2.1 round 97 part 3 (Terry 2026-06-11) — photo/video count
            moved to the right-side cluster (before Open in Viewer)
            so it stops breaking the rhythm of the three view pills.
            Same recipe Needs Dates uses for its inline stats. */}
        {/* v2.1 round 24 (Terry 2026-06-08) — standalone "Captioned
            only" chip removed; Captioned now lives as a checkbox in
            the Show dropdown below alongside Photos / Videos. */}
        {/* v2.1 round 23 (Terry 2026-06-08) — Media dropdown. Earlier
            two-chip layout (Photos · N + Videos · M) ate too much
            horizontal space on narrow screens. Collapsed into a
            single dropdown chip: label reflects the active filter,
            popover lists all three options with counts (so Terry's
            "I kinda like knowing how many there are of each" stays
            true — counts just live in the menu now). Same primitive
            shape as Captioned only (h-8 px-3 rounded-full border,
            IconTooltip wrapper, lavender bg-primary when filter
            non-default). Render only when both types exist. */}
        {files != null && (() => {
          const photoCount = files.filter((f) => f.file_type === 'photo').length;
          const videoCount = files.filter((f) => f.file_type === 'video').length;
          // v2.1 round 29 (Terry 2026-06-08) — Captions count must
          // respect the active TYPE filter. Before this fix, the
          // count showed all captioned items regardless of whether
          // the user had Photos or Videos selected; picking the
          // Captions checkbox then yielded an empty grid because
          // the only captioned items were of the other type.
          // Recompute per TYPE so the number always matches what
          // the user would see if they ticked the box right now.
          const captionedCount = files.filter((f) => {
            if (!f.caption || f.caption.length === 0) return false;
            if (mediaFilter === 'photos') return f.file_type === 'photo';
            if (mediaFilter === 'videos') return f.file_type === 'video';
            return true;
          }).length;
          if (files.length === 0) return null;
          // v2.1 round 26 (Terry 2026-06-08) — chip label reflects the
          // radio-Type + checkbox-Captioned state. Empty-grid impossible
          // by construction (radio always has one selected). Six clean
          // states map to readable chip labels.
          const filteredCount = (visibleFiles ?? files).length;
          const isDefault = mediaFilter === 'all' && !captionedOnly;
          let chipLabel: string;
          if (isDefault) {
            chipLabel = `All media · ${files.length.toLocaleString()}`;
          } else if (mediaFilter === 'photos' && !captionedOnly) {
            chipLabel = `Photos · ${photoCount.toLocaleString()}`;
          } else if (mediaFilter === 'videos' && !captionedOnly) {
            chipLabel = `Videos · ${videoCount.toLocaleString()}`;
          } else if (mediaFilter === 'all' && captionedOnly) {
            chipLabel = `Captioned · ${filteredCount.toLocaleString()}`;
          } else {
            // Photos+Captioned or Videos+Captioned
            chipLabel = `${mediaFilter === 'photos' ? 'Photos' : 'Videos'} + Captioned · ${filteredCount.toLocaleString()}`;
          }
          const ChipIcon =
            (mediaFilter === 'photos' && !captionedOnly) ? ImageIcon :
            (mediaFilter === 'videos' && !captionedOnly) ? Film :
            (captionedOnly && mediaFilter === 'all') ? MessageSquareText :
            Files;
          const filterGrace = mediaFilterGrace;
          // v2.1 round 97 — Media pill matches MemoriesPendingView's
          // uniform shape: h-8 + rounded-md + border + min-w-[150px]
          // + justify-between so the chevron sits flush right. Type
          // label kept short (no count — count moves to the right-
          // side stats inline so the pill width stays uniform with
          // its Display sibling).
          const mediaShortLabel = isDefault
            ? 'All'
            : mediaFilter === 'photos' && !captionedOnly
              ? 'Photos'
              : mediaFilter === 'videos' && !captionedOnly
                ? 'Videos'
                : mediaFilter === 'all' && captionedOnly
                  ? 'Captioned'
                  : `${mediaFilter === 'photos' ? 'Photos' : 'Videos'} + Captioned`;
          return (
            <Popover open={filterGrace.open} onOpenChange={filterGrace.setOpen}>
              <IconTooltip label="Filter what's shown — Photos, Videos, Captioned" side="bottom">
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-testid="memories-show-filter"
                    {...filterGrace.triggerHoverProps}
                    className={`inline-flex items-center justify-between gap-1.5 h-8 px-3 rounded-md text-xs font-medium border transition-colors min-w-[150px] ${
                      !isDefault
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background hover:bg-accent text-foreground'
                    }`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <ChipIcon className="w-3.5 h-3.5" />
                      <span className="text-muted-foreground/85">Media:</span>
                      <span>{mediaShortLabel}</span>
                    </span>
                    <ChevronDown className="w-3.5 h-3.5 opacity-70" />
                  </button>
                </PopoverTrigger>
              </IconTooltip>
              <PopoverContent align="start" className="w-64 p-1" {...filterGrace.contentHoverProps}>
                {/* v2.1 round 27 (Terry 2026-06-08) — "Show all media"
                    reset removed: "All media" is already the first
                    radio option and accomplishes the same thing in
                    one click, so the dedicated row was redundant. */}
                <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider px-3 pt-2 pb-1">
                  Type
                </p>
                <RadioGroup
                  value={mediaFilter}
                  onValueChange={(v) => setMediaFilter(v as 'all' | 'photos' | 'videos')}
                  className="gap-0"
                >
                  {([
                    { key: 'all' as const, label: 'All media', count: photoCount + videoCount, Icon: Files, disabled: false },
                    { key: 'photos' as const, label: 'Photos', count: photoCount, Icon: ImageIcon, disabled: photoCount === 0 },
                    { key: 'videos' as const, label: 'Videos', count: videoCount, Icon: Film, disabled: videoCount === 0 },
                  ]).map(({ key, label, count, Icon, disabled }) => (
                    <label
                      key={key}
                      data-testid={`memories-show-filter-${key}`}
                      htmlFor={`memories-show-filter-radio-${key}`}
                      className={`flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-muted/50'}`}
                    >
                      <span className="inline-flex items-center gap-2 text-foreground">
                        <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                        {label}
                      </span>
                      <span className="inline-flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">{count.toLocaleString()}</span>
                        <RadioGroupItem
                          id={`memories-show-filter-radio-${key}`}
                          value={key}
                          disabled={disabled}
                        />
                      </span>
                    </label>
                  ))}
                </RadioGroup>
                <div className="h-px bg-border my-1" />
                <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider px-3 pt-1 pb-1">
                  Also filter
                </p>
                {/* v2.1 round 28 (Terry 2026-06-08) — reverted the
                    "always toggle-able" change. Toggling Captions
                    on in a bucket with zero captioned items just
                    produces an explicit empty grid for no benefit,
                    so disable when count=0. BUT: explain why via
                    an IconTooltip wrapper, because seeing "0" next
                    to a checkbox you can't click is mildly
                    frustrating (Terry's word) — the tooltip closes
                    the loop. */}
                {(() => {
                  const disabled = captionedCount === 0;
                  const row = (
                    <label
                      data-testid="memories-show-filter-captioned"
                      className={`flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-muted/50'}`}
                    >
                      <span className="inline-flex items-center gap-2 text-foreground">
                        <MessageSquareText className="w-3.5 h-3.5 text-muted-foreground" />
                        Captions
                      </span>
                      <span className="inline-flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">{captionedCount.toLocaleString()}</span>
                        <Checkbox
                          checked={captionedOnly}
                          disabled={disabled}
                          onCheckedChange={(v) => setCaptionedOnly(!!v)}
                        />
                      </span>
                    </label>
                  );
                  return disabled ? (
                    <IconTooltip label="No media in this view has a caption — nothing to filter to" side="left">
                      <div>{row}</div>
                    </IconTooltip>
                  ) : row;
                })()}
              </PopoverContent>
            </Popover>
          );
        })()}
        {/* v2.1 round 36 (Terry 2026-06-08) — INSIGHTS dropdown.
            Renamed from "Add Info" + absorbed three previously-
            standalone toolbar controls (zoom %, Select toggle,
            Filename/Date checkboxes). Terry: "I realise things
            are going to have an extra hub, but it will bring
            peace and tranquillity to this space." Right. The
            popover keeps each control in its own section
            separated by a horizontal divider so the dropdown
            reads as 3 distinct concerns, not a kitchen-drawer
            jumble. Trigger button matches the Actions
            DropdownMenuTrigger in height + padding so the two
            "hubs" sit shoulder-to-shoulder visually. */}
        {/* v2.1 round 37 (Terry 2026-06-08) — Insights trigger
            tracks active state of EVERYTHING inside the popover
            (tile size away from default, selection mode on, or
            any tile-info checkboxes ticked). Default = ghost
            (neutral, doesn't pretend to be active); active =
            lavender-bordered secondary so the button reads as
            "you've changed something in here". Matches the
            original Add Info button's active-state behaviour
            before this round's restructure. */}
        {(() => {
          // v2.1 round 38 (Terry 2026-06-08) — count of active items
          // inside Insights. Tile size away from default = 1, selection
          // mode on = 1, each tile-info checkbox = 1. Surfaced as a
          // small numeric badge next to the label so the user can
          // remember they've toggled things on without having to open
          // the popover. Same "(N)" pattern the old Add Info button
          // used pre-restructure.
          // v2.1 round 64 (Terry 2026-06-09) — count only TRUE
          // additions, not preferences. Tile size is a personal
          // preference, not "you've turned something ON". Only
          // Selection Mode + on-tile metadata fields are genuine
          // additions worth surfacing in the (N) badge.
          const insightsCount =
            (selectionMode ? 1 : 0) +
            metaFields.length;
          const insightsActive = insightsCount > 0;
          return (
            <Popover open={insightsGrace.open} onOpenChange={insightsGrace.setOpen}>
              <IconTooltip label="Display options — tile size, selection mode, info under tiles" side="bottom">
                <PopoverTrigger asChild>
                  {/* v2.1 round 97 — renamed Insights → Display and
                      retooled into the uniform view-pill shape that
                      MemoriesPendingView's round 96 established.
                      Same min-w-[150px] + justify-between recipe as
                      Media (above) so the two pills sit equal-width
                      regardless of label length. Eye icon family
                      replaces the round-36 Info bubble. */}
                  <button
                    type="button"
                    data-testid="memories-insights-trigger"
                    {...insightsGrace.triggerHoverProps}
                    className={`inline-flex items-center justify-between gap-1.5 h-8 px-3 rounded-md text-xs font-medium border transition-colors min-w-[150px] ${insightsActive ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background hover:bg-accent text-foreground'}`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Eye className="w-3.5 h-3.5" />
                      <span>Display</span>
                      {insightsActive && (
                        <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary/15 text-primary text-[10px] font-semibold tabular-nums">
                          {insightsCount}
                        </span>
                      )}
                    </span>
                    <ChevronDown className="w-3.5 h-3.5 opacity-70" />
                  </button>
                </PopoverTrigger>
              </IconTooltip>
          <PopoverContent
            className="w-64 p-3"
            align="start"
            {...insightsGrace.contentHoverProps}
            // v2.1 round 65 (Terry 2026-06-09) — Ctrl+wheel zoom keeps
            // working while the Insights popover is open, so the user
            // can WATCH the % number tick live and dial in their
            // preferred size without closing the popover first.
            // Without this, the popover's own scroll container
            // swallowed the wheel event before it reached the grid's
            // useEffect-attached ctrlKey listener and the displayed %
            // stayed frozen. Step (5) matches the existing
            // grid-container wheel handler in this file (gridScrollRef
            // useEffect).
            onWheel={(e) => {
              if (!(e.ctrlKey || e.metaKey)) return;
              e.preventDefault();
              e.stopPropagation();
              setTileSizeSlider(prev => Math.max(0, Math.min(100, prev + (e.deltaY < 0 ? 5 : -5))));
            }}
          >
            {/* — Tile size section — */}
            <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider mb-2">Tile size</p>
            <div className="flex items-center gap-1 mb-3">
              <button
                type="button"
                onClick={() => setTileSizeSlider((prev) => Math.max(0, prev - 10))}
                disabled={tileSizeSlider <= 0}
                className="flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                data-testid="button-bydate-zoom-out"
                aria-label="Zoom out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setTileSizeSlider(35)}
                className="flex-1 text-xs font-medium text-foreground tabular-nums hover:bg-secondary/40 rounded py-1 transition-colors"
                data-testid="button-bydate-zoom-reset"
                aria-label="Reset zoom"
              >
                {tileSizeSlider}% <span className="text-muted-foreground/70 text-[10px]">(click to reset)</span>
              </button>
              <button
                type="button"
                onClick={() => setTileSizeSlider((prev) => Math.min(100, prev + 10))}
                disabled={tileSizeSlider >= 100}
                className="flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                data-testid="button-bydate-zoom-in"
                aria-label="Zoom in"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="border-t border-border my-2" />
            {/* — Selection mode section — */}
            <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider mb-2">Selection mode</p>
            <label className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/50 cursor-pointer">
              <input
                type="checkbox"
                checked={selectionMode}
                onChange={() => setSelectionMode(v => !v)}
                className="rounded border-border text-purple-500 focus:ring-purple-400/50"
                data-testid="button-selection-mode"
              />
              <span className="text-sm text-foreground flex-1">Tile checkboxes</span>
            </label>
            <div className="border-t border-border my-2" />
            {/* — Tile info section — */}
            <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider mb-2">Show below each tile</p>
            {([
              { key: 'filename' as DrilldownMetaField, label: 'Filename' },
              { key: 'date' as DrilldownMetaField, label: 'Date' },
            ]).map(opt => {
              const checked = metaFields.includes(opt.key);
              return (
                <label key={opt.key} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setMetaFields(prev => checked ? prev.filter(f => f !== opt.key) : [...prev, opt.key]);
                    }}
                    className="rounded border-border text-purple-500 focus:ring-purple-400/50"
                  />
                  <span className="text-sm text-foreground flex-1">{opt.label}</span>
                </label>
              );
            })}
            <p className="text-[10px] text-muted-foreground/85 px-2 pt-2 leading-snug">
              Tip: Hold <kbd className="px-1 py-0.5 rounded bg-secondary text-[9px] font-mono">Ctrl</kbd> + scroll over the grid to zoom.
            </p>
          </PopoverContent>
            </Popover>
          );
        })()}
        {/* Selection bar — only renders when user has checked items.
            Mirrors the S&D selection-bar contract: dismissable chip
            with count + AddToAlbumPopover sit between the static
            controls and the "Open all in Viewer" CTA. */}
        {/* v2.1 round 37 (Terry 2026-06-08) — Actions dropdown
            moved ahead of the selection chip so the two "hub"
            buttons (Insights + Actions) sit shoulder-to-shoulder.
            Terry: "Actions dropdown should be next to Insights
            and not be sandwiched by the No. selected." The chip
            now follows Actions, keeping the visual chain:
            view-options hub → do-stuff hub → "you have N picked"
            indicator. AddToAlbumPopover anchor renders alongside
            the chip since both depend on having a selection. */}
        {selectedFileIds.size > 0 && (() => {
          const base = visibleFiles ?? files ?? [];
          const selectedVideos = base.filter(f => selectedFileIds.has(f.id) && f.file_type === 'video');
          return (
            <DropdownMenu open={actionsGrace.open} onOpenChange={actionsGrace.setOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  data-testid="memories-selection-actions"
                  className="bg-[var(--color-gold)] border border-[var(--color-gold)] hover:opacity-90 text-[#1f1a08] hover:bg-[var(--color-gold)]"
                  {...actionsGrace.triggerHoverProps}
                >
                  Actions
                  <ChevronDown className="w-3.5 h-3.5 ml-1.5 opacity-80" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[260px]" {...actionsGrace.contentHoverProps}>
                {/* v2.1 round 39 (Terry 2026-06-08) — these items mirror
                    the per-tile right-click context menu so the
                    Actions dropdown is a viable second entry point
                    when the user's working from the toolbar. Each
                    routes through the exact same handlers the
                    context menu uses (same revealInFolder bridge,
                    same pdr:sendToSearchPile event, same
                    setMonthlyThumbnail helper) — single source of
                    truth for the underlying action, two surfaces
                    for invoking it. */}
                <DropdownMenuItem
                  onSelect={() => {
                    const target = base.filter(f => selectedFileIds.has(f.id));
                    if (target.length === 0) return;
                    openSearchViewer(target.map(f => f.file_path), target.map(f => f.filename));
                  }}
                  data-testid="memories-actions-open-viewer"
                >
                  <PlayCircle className="w-3.5 h-3.5 mr-2" />
                  Open {selectedFileIds.size} Selected in Viewer
                </DropdownMenuItem>
                {selectedFileIds.size === 1 && (
                  <DropdownMenuItem
                    onSelect={() => {
                      const target = base.find(f => selectedFileIds.has(f.id));
                      if (!target) return;
                      (window as any).pdr?.revealInFolder?.(target.file_path);
                    }}
                    data-testid="memories-actions-reveal"
                  >
                    <HardDrive className="w-3.5 h-3.5 mr-2" />
                    Show in File Explorer
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {/* Send to S&D (replace) + Add to S&D pile (accumulate)
                    — same event the per-tile context menu fires, just
                    targeting the selection set. setMemoriesReturnSource
                    so the back-pill jumps back to this drilldown. */}
                <DropdownMenuItem
                  onSelect={() => {
                    const fileIds = Array.from(selectedFileIds);
                    if (fileIds.length === 0) return;
                    void import('@/lib/memories-return-source').then(m => m.setMemoriesReturnSource({
                      tab: 'byDate',
                      label: 'Memories — Dates',
                      drilldown: { year, month, day },
                    }));
                    window.dispatchEvent(new CustomEvent('pdr:sendToSearchPile', {
                      detail: { fileIds, source: 'memories', mode: 'replace' },
                    }));
                  }}
                  data-testid="memories-actions-send-to-sd"
                >
                  <Search className="w-3.5 h-3.5 mr-2" />
                  Send {selectedFileIds.size} to S&amp;D
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    const fileIds = Array.from(selectedFileIds);
                    if (fileIds.length === 0) return;
                    void import('@/lib/memories-return-source').then(m => m.setMemoriesReturnSource({
                      tab: 'byDate',
                      label: 'Memories — Dates',
                      drilldown: { year, month, day },
                    }));
                    window.dispatchEvent(new CustomEvent('pdr:sendToSearchPile', {
                      detail: { fileIds, source: 'memories', mode: 'accumulate' },
                    }));
                  }}
                  data-testid="memories-actions-add-to-sd-pile"
                >
                  <Search className="w-3.5 h-3.5 mr-2" />
                  Add {selectedFileIds.size} to S&amp;D pile
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => { setAddToAlbumOpenTick(t => t + 1); }}
                  data-testid="memories-actions-add-to-album"
                >
                  <FolderPlus className="w-3.5 h-3.5 mr-2" />
                  Add to album…
                </DropdownMenuItem>
                {selectedVideos.length > 0 && (
                  <DropdownMenuItem
                    onSelect={() => transcribeSelectedVideos(selectedVideos.map(v => v.file_path))}
                    data-testid="memories-actions-transcribe"
                  >
                    <Captions className="w-3.5 h-3.5 mr-2" />
                    Transcribe {selectedVideos.length} video{selectedVideos.length === 1 ? '' : 's'}…
                  </DropdownMenuItem>
                )}
                {/* Set as monthly thumbnail — single-photo + month
                    drilldown only. Mirrors the per-tile menu's
                    same-conditional item exactly. */}
                {selectedFileIds.size === 1 && month != null && (
                  <DropdownMenuItem
                    onSelect={async () => {
                      const target = base.find(f => selectedFileIds.has(f.id));
                      if (!target) return;
                      const result = await setMonthlyThumbnail({ year, month, fileId: target.id });
                      if (result.success) {
                        invalidatePrefetchedMemories();
                        onRequestRefresh();
                        toast.success('Monthly thumbnail set', {
                          description: `${MONTH_NAMES[month - 1]} ${year} now uses this photo`,
                        });
                      } else {
                        toast.error("Couldn't set monthly thumbnail", { description: result.error });
                      }
                    }}
                    data-testid="memories-actions-set-monthly-thumb"
                  >
                    <Star className="w-3.5 h-3.5 mr-2" />
                    Set as monthly thumbnail
                  </DropdownMenuItem>
                )}
                {/* Copy filename(s) — newline-separated for multi-select.
                    Terry asked whether space-separated would be best;
                    newline is the safer call because (a) filenames CAN
                    contain spaces (rare in PDR-organised libraries but
                    possible for imported files), (b) newline gives
                    proper list formatting when pasted into Notepad /
                    Excel / email, and (c) most text inputs collapse
                    newlines to spaces on paste anyway — so newline is
                    a superset of space's usefulness without the
                    parsing-ambiguity downside. */}
                <DropdownMenuItem
                  onSelect={async () => {
                    const target = base.filter(f => selectedFileIds.has(f.id));
                    if (target.length === 0) return;
                    const names = target.map(f => f.filename).join('\n');
                    try {
                      await navigator.clipboard.writeText(names);
                      toast.success(
                        target.length === 1 ? 'Filename copied' : `Copied ${target.length} filenames`,
                        target.length === 1 ? { description: target[0].filename } : undefined,
                      );
                    } catch {
                      toast.error("Couldn't copy filename" + (target.length === 1 ? '' : 's'));
                    }
                  }}
                  data-testid="memories-actions-copy-filenames"
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
                      onRequestRefresh();
                    } else {
                      toast.error('Couldn’t move to Recycle Bin', { description: r.error });
                    }
                  }}
                  className="text-destructive focus:text-destructive"
                  data-testid="memories-actions-delete"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-2" />
                  Move {selectedFileIds.size} to Recycle Bin
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })()}
        {selectedFileIds.size > 0 && (
          <>
            <IconTooltip label="Clear selection" side="bottom">
              <button
                onClick={clearSelection}
                // v2.0.15 (Terry 2026-05-28) — DELIBERATE OVERRIDE of
                // the "gold = captions only" semantic rule. Terry's
                // call: users scrolling 100s of photos in a year
                // drilldown absolutely need to see selection state at
                // a glance, and the lavender-tinted version still
                // read as passive info. Selection is now gold across
                // PDR — chip + tile ring + checkmark circle. The
                // captioned-only chip stays gold too; they don't
                // collide because they appear in different header
                // positions and the captioned chip carries the
                // chat-bubble icon to disambiguate.
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-[var(--color-gold)] bg-[var(--color-gold)] hover:opacity-90 text-xs font-medium text-[#1f1a08] transition-colors"
                data-testid="memories-selection-chip"
              >
                {selectedFileIds.size} selected
                <X className="w-3 h-3 opacity-70" />
              </button>
            </IconTooltip>
            {/* v2.1 round 35 (Terry 2026-06-08) — toolbar restructure.
                Terry: "we should combine the CTAs into a dropdown
                menu, because they are quite simply doing my fucking
                head in seeing them pollute the top of this, what
                should be a tranquil space to view your memories."
                Right — Add-to-album / Transcribe / Delete now live
                in a single "Actions" dropdown. The selection chip
                (gold pill above) stays in its own spot so the
                "you have N selected" affordance is still
                immediately visible without an extra click.
                AddToAlbumPopover stays mounted but its trigger
                is squashed to 0×0 so it serves only as the anchor
                for the popover content the dropdown item opens
                via openTrigger. */}
            <div className="absolute -left-[9999px] top-0">
              <AddToAlbumPopover
                fileIds={Array.from(selectedFileIds)}
                onAdded={clearSelection}
                openTrigger={addToAlbumOpenTick}
              />
            </div>
          </>
        )}
        {/* v2.1 round 37 (Terry 2026-06-08) — far-right cluster.
            Terry: "Spacious/Tight toggle should be moved to the
            right of Open March button, since the positioning will
            remain constant for it." Right — DensityToggle is now
            ALWAYS the rightmost item, regardless of whether the
            Open button is rendered (which depends on selection
            state). ml-auto on the wrapping container pushes the
            whole group to the right edge; inside, Open button
            (conditional) comes first, DensityToggle is always
            last. */}
        <div className="ml-auto flex items-center gap-2">
          {/* v2.1 round 97 part 3 (Terry 2026-06-11) — photo/video
              stats relocated here from between Year + Media (where
              they broke the dropdown rhythm). Same recipe Needs
              Dates uses: text-[11px] muted, tabular-nums, hidden
              when a media-type filter narrows the view (the active
              Media chip would otherwise repeat the count). */}
          {files != null && (() => {
            const filterNarrows = mediaFilter !== 'all' || captionedOnly;
            if (filterNarrows) return null;
            const photoCount = files.filter(f => f.file_type === 'photo').length;
            const videoCount = files.filter(f => f.file_type === 'video').length;
            const parts: string[] = [];
            if (photoCount > 0) parts.push(`${photoCount.toLocaleString()} ${photoCount === 1 ? 'photo' : 'photos'}`);
            if (videoCount > 0) parts.push(`${videoCount.toLocaleString()} ${videoCount === 1 ? 'video' : 'videos'}`);
            if (parts.length === 0) return null;
            return (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {parts.join(' · ')}
              </span>
            );
          })()}
          {files != null && files.length > 1 && selectedFileIds.size === 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const base = visibleFiles ?? files;
                openSearchViewer(base.map(f => f.file_path), base.map(f => f.filename));
              }}
              data-testid="button-open-in-viewer"
            >
              <PlayCircle className="w-3.5 h-3.5 mr-1.5" />
              Open {title} in Viewer
            </Button>
          )}
          <DensityToggle value={density} onChange={onDensityChange} />
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* v2.0.14 (Terry 2026-05-28) — left-column jump rail. Three
            levels deep: timeline shows years, year drilldown shows
            months, month drilldown shows days. The rail itself is
            the same 68 px wide aside with the same button class
            shape (matches the year rail's mono labels, hover
            lavender, active = bg-primary/10 + text-primary); only
            the data source and the active-key comparison differ. */}
        {hasMultipleMonths ? (
          <aside className="w-[68px] shrink-0 border-r border-border/60 overflow-y-auto py-4 px-1 text-center">
            {monthBoundaries.map((m) => {
              const isActive = currentMonthKey === m.key;
              return (
                <IconTooltip key={m.key} label={MONTH_NAMES[m.month]} side="right">
                  <button
                    type="button"
                    onClick={() => goToDayByKey(m.firstDayKey)}
                    className={`w-full px-1 py-1.5 mb-0.5 rounded text-xs font-mono transition-colors ${
                      isActive
                        ? 'bg-primary/10 text-primary font-semibold'
                        : 'text-muted-foreground hover:text-primary hover:bg-primary/5'
                    }`}
                    data-testid={`drilldown-month-jump-${m.month}`}
                  >
                    {m.label}
                  </button>
                </IconTooltip>
              );
            })}
          </aside>
        ) : isMonthDrilldown ? (
          <aside className="w-[68px] shrink-0 border-r border-border/60 overflow-y-auto py-4 px-1 text-center">
            {dayBoundaries.map((d) => {
              const isActive = currentDayKey === d.key;
              const g = filesByDay.find((x) => x.dayKey === d.key);
              const tooltipLabel = g ? formatDayHeader(g.date, g.dayKey) : d.label;
              return (
                <IconTooltip key={d.key} label={tooltipLabel} side="right">
                  <button
                    type="button"
                    onClick={() => goToDayByKey(d.firstDayKey)}
                    className={`w-full px-1 py-1.5 mb-0.5 rounded text-xs font-mono transition-colors ${
                      isActive
                        ? 'bg-primary/10 text-primary font-semibold'
                        : 'text-muted-foreground hover:text-primary hover:bg-primary/5'
                    }`}
                    data-testid={`drilldown-day-jump-${d.label}`}
                  >
                    {d.label}
                  </button>
                </IconTooltip>
              );
            })}
          </aside>
        ) : null}
      <div ref={gridScrollRef} className="relative flex-1 overflow-y-auto px-6 pb-6 outline-none">
        {files == null ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading…</div>
        ) : files.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            {month == null ? `No files for ${year}.` : day == null ? `No files for ${MONTH_NAMES[month - 1]} ${year}.` : 'No files on this day.'}
          </div>
        ) : (
          <>
            {/* v2.1 round 98 (Terry 2026-06-11) — sticky day-header
                banner. Was a top-right pill that faded in during
                scroll and out after 1.2 s (round v2.0.13); Terry
                hit "incredibly easy to lose track of what date
                you're looking at" and asked for the day header to
                stay in view always — same behaviour as the Needs
                Dates TENTATIVE / UNRECORDED section headers.
                Now a full-width band that matches the in-section
                day header recipe exactly (-mx-6 px-6 py-2 +
                bg-background/95 backdrop-blur-sm + border-b +
                text-sm font-semibold + count span). Sits sticky at
                top-0 of the scroll container so when a day-group
                row scrolls past, its header is replaced by the
                sticky banner showing that day's label + count.
                pointer-events-none so clicks pass through to the
                photo grid below. Slight visual overlap with the
                in-section inline header at the very top of a day
                section is acceptable — both show the same text,
                same chrome, so the redundancy is invisible. */}
            {currentDayLabel && (() => {
              const currentDayGroup = filesByDay.find((g) => g.dayKey === currentDayKey);
              const count = currentDayGroup?.files.length ?? 0;
              return (
                <div
                  // v2.1 round 99 (Terry 2026-06-11) — dropped
                  // bg-background/95 + backdrop-blur (made the band
                  // float over the photos with translucency,
                  // reading as "floating" instead of "stuck flush
                  // to the toolbar"). Solid bg-background matches
                  // the Needs Dates tier-section header's exact
                  // recipe so the band sits hard-flush against
                  // the toolbar above as the user scrolls.
                  className="pointer-events-none sticky top-0 z-30 -mx-6 px-6 py-2 bg-background border-b border-border/60 text-sm font-semibold text-foreground"
                  data-testid="memories-drilldown-sticky-day"
                  aria-live="polite"
                >
                  {currentDayLabel}
                  {count > 0 && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {count.toLocaleString()} {count === 1 ? 'photo' : 'photos'}
                    </span>
                  )}
                </div>
              );
            })()}
            {/* v2.0.14 — virtualised day-group container. Each virtual
                row holds one day's section (header + photo grid). Only
                the ~3-6 rows currently in viewport are mounted at a
                time, so a year drilldown with 6,000+ files mounts in
                tens of milliseconds instead of locking the renderer
                for 10-15 seconds while React diffs through all those
                <button> + ContextMenu + CaptionTooltip subtrees. */}
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const group = filesByDay[virtualRow.index];
                if (!group) return null;
                return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                /* v2.1 round 10 (Terry 2026-06-07) — measureElement ref
                   REMOVED. ResizeObserver was re-measuring every row
                   on mount/unmount, the virtualiser kept adjusting
                   the total-size + scroll position to compensate,
                   and the result was the "nodding goose" judder
                   Terry described when scrolling or jumping between
                   days. estimateDayRowHeight is now the authoritative
                   row size — the math is accurate enough (header
                   geometry, tile grid, gaps all spec'd to the px)
                   that a real measurement isn't needed. Any tiny
                   sub-pixel drift in tightly-packed grids is
                   invisible and doesn't compound. */
                data-day-key={group.dayKey}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                  paddingBottom: 20,
                }}
              >
                {/* Per-day header — long-form so the user can read the
                    date without parsing abbreviations. Sticky top
                    behaviour was dropped in v2.0.14 because the
                    virtual rows are absolute-positioned (sticky
                    doesn't apply inside an absolute container); the
                    floating "current day" pill above the scroll area
                    is the cue now. */}
                <h3
                  ref={(el) => { dayHeaderElsRef.current[group.dayKey] = el; }}
                  className="-mx-6 px-6 py-2 bg-background/95 backdrop-blur-sm border-b border-border/60 text-sm font-semibold text-foreground"
                >
                  {formatDayHeader(group.date, group.dayKey)}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {group.files.length.toLocaleString()} {group.files.length === 1 ? 'photo' : 'photos'}
                  </span>
                </h3>
                <div
                  className={`mt-3 grid ${density === 'tight' ? 'gap-0' : 'gap-3'}`}
                  style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${drilldownSliderToPx(tileSizeSlider)}px, 1fr))` }}
                >
                  {group.files.map((f, dayIdx) => {
                    const idx = group.baseIndex + dayIdx;
              const isMultiSelected = selectedFileIds.has(f.id);
              return (
              // v2.0.13 (Terry 2026-05-27) — CaptionTooltip wraps the
              // whole tile so the gold caption preview fires on any
              // hover, not just on the corner badge. The wrapping div
              // is the tooltip's asChild target; ContextMenuTrigger
              // asChild still forwards to the button inside, so
              // right-click is unaffected. Caption-less tiles
              // short-circuit inside CaptionTooltip and render their
              // children straight through (no wrapper overhead).
              <CaptionTooltip key={f.id} caption={f.caption} side="top">
                <div className="aspect-square">
              <ContextMenu>
                <ContextMenuTrigger asChild>
                    <button
                      // v2.0.15 (Terry 2026-05-28) — native OS drag to
                      // external apps (WhatsApp, Discord, mail, etc.).
                      // The browser fires dragstart on draggable=true
                      // elements when the user mouse-drags past the
                      // threshold. We preventDefault (so the browser
                      // doesn't try its own HTML5 drag) and ask main
                      // to start the OS-level drag via
                      // webContents.startDrag — receivers get the
                      // ORIGINAL file from disk, not the cached thumb.
                      // If the user has a multi-select active and the
                      // dragged tile is one of the selected, drag the
                      // whole selection; otherwise just this tile.
                      //
                      // effectAllowed = 'copy' is a best-effort hint
                      // to receivers that this drag is copy-only —
                      // Chromium-based receivers honour it; File
                      // Explorer ignores it and uses the Windows shell
                      // default (MOVE for same-drive, COPY for cross-
                      // drive). Electron's startDrag doesn't expose a
                      // way to clamp the OS drag-effect mask at source
                      // level (longstanding open issue), so File
                      // Explorer same-drive drops can still MOVE files
                      // out of the library unless the user holds Ctrl.
                      // Practical user guidance: drag to apps, never
                      // to File Explorer windows.
                      draggable
                      onDragStart={(e) => {
                        try { e.dataTransfer.effectAllowed = 'copy'; } catch { /* readonly in some contexts */ }
                        e.preventDefault();
                        const base = visibleFiles ?? files ?? [];
                        const dragSet = (selectedFileIds.size > 0 && selectedFileIds.has(f.id))
                          ? base.filter((x) => selectedFileIds.has(x.id)).map((x) => x.file_path)
                          : [f.file_path];
                        const iconUrl = thumbs[f.file_path];
                        (window as any).pdr?.drag?.start?.(dragSet, iconUrl);
                      }}
                      // Modifier-key contract mirrors SearchPanel/S&D:
                      //   plain click            → open viewer (jump in at idx)
                      //   selectionMode + click  → toggle selection (Select-button affordance)
                      //   Ctrl/Cmd+click         → toggle selection
                      //   Shift+click            → range select from last clicked
                      onMouseDown={(e) => {
                        // v2.1 round 40 take 2 (Terry 2026-06-08) —
                        // sample Ctrl/Cmd at PHYSICAL press time, before
                        // any focus shift can stale-cache the click's
                        // modifier flag. Stored keyed by file id so a
                        // press on one tile + click on another can't
                        // leak state across tiles (paranoia case).
                        pressModifierRef.current = {
                          id: f.id,
                          ctrl: e.ctrlKey || e.metaKey,
                        };
                      }}
                      onClick={(e) => {
                        // v2.1 round 40 take 2 — read the modifier from
                        // the mousedown capture above. The synthetic
                        // event's e.ctrlKey is the OS's read AT CLICK
                        // FIRE TIME, which on the first click after a
                        // navigation focus shift is sometimes stale
                        // (returns false even when Ctrl is held). The
                        // mousedown capture happens earlier in the
                        // press lifecycle and is reliable. OR with
                        // e.ctrlKey so the non-racy normal path also
                        // works if mousedown was somehow missed.
                        const pressedCtrl = pressModifierRef.current.id === f.id && pressModifierRef.current.ctrl;
                        if (e.ctrlKey || e.metaKey || pressedCtrl) {
                          e.preventDefault();
                          toggleSelection(f);
                          lastClickedIndexRef.current = idx;
                          return;
                        }
                        // v2.0.14 — `idx` is relative to the filtered
                        // arrangement (filesByDay iterates visibleFiles
                        // and baseIndex is computed from that walk), so
                        // shift-range select + viewer-open MUST index
                        // into the same filtered array, not the raw
                        // unfiltered `files`. Without this, clicking a
                        // captioned tile under "Captioned only" opened
                        // a totally unrelated photo at the same row in
                        // the unfiltered set.
                        const baseArr = visibleFiles ?? files;
                        if (e.shiftKey && lastClickedIndexRef.current !== null) {
                          const start = Math.min(lastClickedIndexRef.current, idx);
                          const end = Math.max(lastClickedIndexRef.current, idx);
                          for (let i = start; i <= end; i++) {
                            const file = baseArr[i];
                            if (file) toggleSelection(file, 'add');
                          }
                          lastClickedIndexRef.current = idx;
                          return;
                        }
                        // Selection-mode body click toggles selection
                        // (mouse-only alternative). Terry 2026-05-19:
                        // "Select button should allow the user to
                        // click anywhere on the photo to select it,
                        // not just the top left corner."
                        if (selectionMode) {
                          toggleSelection(f);
                          lastClickedIndexRef.current = idx;
                          return;
                        }
                        lastClickedIndexRef.current = idx;
                        openSearchViewer(baseArr.map(x => x.file_path), baseArr.map(x => x.filename), idx);
                      }}
                      className={`group relative w-full h-full overflow-hidden bg-secondary/30 transition-all ${
                        // v2.0.15 — gold ring on selected tile (see
                        // chip comment above for the rationale). Tile
                        // shape doesn't differ by density when ring
                        // is on so it stays a solid gold halo.
                        isMultiSelected ? 'ring-2 ring-[var(--color-gold)]' :
                        density === 'tight' ? '' : 'rounded-lg ring-1 ring-border hover:ring-primary/50'
                      }`}
                    >
                      {/* Selection checkbox — visible on hover, OR
                          when selected, OR when selectionMode is on
                          (the "Select" toggle in the header forces
                          every checkbox visible for keyboard-free
                          users). */}
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          const multiSelectActive = selectedFileIds.size > 0;
                          if (e.shiftKey && multiSelectActive && lastClickedIndexRef.current !== null) {
                            const start = Math.min(lastClickedIndexRef.current, idx);
                            const end = Math.max(lastClickedIndexRef.current, idx);
                            // Same captioned-only safety as the body
                            // click handler above — idx is in visibleFiles
                            // space when the filter is on.
                            const checkBase = visibleFiles ?? files;
                            for (let i = start; i <= end; i++) {
                              const file = checkBase[i];
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
                            // v2.0.15 — gold checkmark circle when
                            // selected; matches the gold tile ring +
                            // selection chip up top. Dark text colour
                            // for the Check icon so it reads cleanly
                            // against the gold fill.
                            ? 'bg-[var(--color-gold)] border-[var(--color-gold)] text-[#1f1a08] opacity-100'
                            : selectionMode
                              ? 'border-white/80 bg-black/40 text-transparent hover:border-white hover:bg-black/60 opacity-100'
                              : 'border-white/80 bg-black/40 text-transparent hover:border-white hover:bg-black/60 opacity-0 group-hover:opacity-100'
                        }`}
                        data-testid={`memories-tile-checkbox-${f.id}`}
                      >
                        {isMultiSelected && <Check className="w-3 h-3" />}
                      </div>
                      {thumbs[f.file_path] ? (
                        <img src={thumbs[f.file_path]} alt={f.filename} className="w-full h-full object-cover" />
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
                      {/* v2.1 (Terry 2026-06-07) — Clip badge for files
                          created by the PDR Viewer's Trim panel.
                          clip_of_file_id IS NOT NULL means this row is
                          a derivative of another indexed file. Positioned
                          top-LEFT so it doesn't collide with the
                          top-right Video badge above (clips are videos
                          too, so both badges can render on the same
                          tile). Cyan matches the `_T` chip family
                          established in Best Practices → Filename
                          Conventions. */}
                      {f.clip_of_file_id != null && (
                        <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-cyan-600/85 text-white text-[9px] font-medium flex items-center gap-1">
                          <Scissors className="w-2.5 h-2.5" /> Clip
                        </div>
                      )}
                      <CaptionBadge caption={f.caption} />
                      {/* v2.1 round 58 (Terry 2026-06-09) — TranscriptBadge
                          sibling. Sits to the LEFT of CaptionBadge when
                          the file has both a caption AND a transcript;
                          claims the bottom-right corner alone if there's
                          no caption. Visibility governed by Settings →
                          Privacy & Security → "Hide transcripts". */}
                      <TranscriptBadge hasTranscript={f.file_type === 'video' && transcribedFileIds.has(f.id)} hasCaption={!!f.caption} />
                      {/* Footer strip — only rendered when at least one
                          meta field is enabled, so the default view is a
                          clean photo wall with zero overlay. */}
                      {(showFilename || showDate) && (
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent px-2 pb-1.5 pt-6 space-y-0.5">
                          {showFilename && <div className="text-[11px] text-white/90 truncate">{f.filename}</div>}
                          {showDate && <div className="text-[10px] text-white/75 truncate">{formatHumanDate(f.derived_date)}</div>}
                        </div>
                      )}
                    </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  {/* v2.0.15 (Terry 2026-05-28) — "Show in File
                      Explorer" — opens File Explorer at the photo's
                      folder and highlights the file. Lets users see
                      where in their library the photo actually lives
                      without having to copy the filename and search
                      for it. */}
                  <ContextMenuItem
                    onSelect={() => { (window as any).pdr?.revealInFolder?.(f.file_path); }}
                    data-testid={`memories-tile-reveal-${f.id}`}
                  >
                    <HardDrive className="w-3.5 h-3.5 mr-2" />
                    Show in File Explorer
                  </ContextMenuItem>
                  {/* v2.0.15 (Terry 2026-06-05) — Send to S&D. If the
                      right-clicked tile is part of a multi-select,
                      send the whole selection; otherwise send just
                      this one file. Default mode is REPLACE — wipes
                      any residual S&D filter / pile state so the
                      arriving selection IS the new S&D contents.
                      Terry's report: prior runs left filters from
                      earlier S&D activity on screen, making the new
                      selection look "added to" whatever was there
                      instead of starting fresh. The sibling "Add to
                      S&D pile" below opts in to ACCUMULATE for
                      building up a review set across multiple visits. */}
                  <ContextMenuItem
                    onSelect={() => {
                      const fileIds = selectedFileIds.size > 0 && selectedFileIds.has(f.id)
                        ? Array.from(selectedFileIds)
                        : [f.id];
                      // v2.0.15 (Terry 2026-06-02) — record where the
                      // pile came from so the TitleBar's back-pill can
                      // return the user to the same drilldown view
                      // (year / month / day) instead of dropping them
                      // at the top of the timeline.
                      void import('@/lib/memories-return-source').then(m => m.setMemoriesReturnSource({
                        tab: 'byDate',
                        label: 'Memories — Dates',
                        drilldown: { year, month, day },
                        scrollToFileId: f.id,
                      }));
                      window.dispatchEvent(new CustomEvent('pdr:sendToSearchPile', {
                        detail: { fileIds, source: 'memories', mode: 'replace' },
                      }));
                    }}
                    data-testid={`memories-tile-send-to-sd-${f.id}`}
                  >
                    <Search className="w-3.5 h-3.5 mr-2" />
                    Send to S&amp;D{selectedFileIds.size > 0 && selectedFileIds.has(f.id) ? ` (${selectedFileIds.size})` : ''}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => {
                      const fileIds = selectedFileIds.size > 0 && selectedFileIds.has(f.id)
                        ? Array.from(selectedFileIds)
                        : [f.id];
                      void import('@/lib/memories-return-source').then(m => m.setMemoriesReturnSource({
                        tab: 'byDate',
                        label: 'Memories — Dates',
                        drilldown: { year, month, day },
                        scrollToFileId: f.id,
                      }));
                      window.dispatchEvent(new CustomEvent('pdr:sendToSearchPile', {
                        detail: { fileIds, source: 'memories', mode: 'accumulate' },
                      }));
                    }}
                    data-testid={`memories-tile-send-to-sd-pile-${f.id}`}
                  >
                    <Search className="w-3.5 h-3.5 mr-2" />
                    Add to S&amp;D pile
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  {/* Right-click actions — Terry 2026-05-19. "Add to
                      album" adds the photo to the current selection
                      so the user can drive the AddToAlbumPopover in
                      the header to pick the album. "Copy filename"
                      writes the filename to the clipboard. */}
                  <ContextMenuItem
                    onSelect={async () => {
                      try {
                        await navigator.clipboard.writeText(f.filename);
                        toast.success('Filename copied', { description: f.filename });
                      } catch {
                        toast.error("Couldn't copy filename");
                      }
                    }}
                  >
                    <Copy className="w-3.5 h-3.5 mr-2" />
                    Copy filename
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={() => {
                      // v2.0.15 (Terry 2026-06-01) — open the picker
                      // directly. If the right-clicked tile isn't
                      // part of an active multi-select, treat the
                      // operation as single-photo: replace the
                      // selection with just this file so the
                      // popover targets the right set. If it IS
                      // already in the selection, keep the existing
                      // multi-select. Either way bump the trigger
                      // tick so the popover opens on next render.
                      const alreadyInMulti = selectedFileIds.size > 0 && selectedFileIds.has(f.id);
                      if (!alreadyInMulti) {
                        setSelectedFileIds(new Set([f.id]));
                      }
                      lastClickedIndexRef.current = idx;
                      setAddToAlbumOpenTick(t => t + 1);
                    }}
                  >
                    <FolderPlus className="w-3.5 h-3.5 mr-2" />
                    Add to album…
                  </ContextMenuItem>
                  {/* v2.0.13 — per-photo caption. Pre-fills with the
                      current caption (if any) so the same item handles
                      add / edit / clear. Empty save clears. EXIF
                      ImageDescription + XMP dc:description are written
                      by default so the caption travels with the file. */}
                  <ContextMenuItem
                    onSelect={() => { void editPhotoCaption({ fileId: f.id, filename: f.filename }); }}
                    data-testid={`memories-tile-caption-${f.id}`}
                  >
                    <MessageSquareText className="w-3.5 h-3.5 mr-2" />
                    {f.caption ? 'Edit caption…' : 'Add caption…'}
                  </ContextMenuItem>
                  {/* v2.1 round 34 (Terry 2026-06-08) — Transcribe video.
                      Only shows on video tiles (Whisper is audio-only).
                      Behaves like Send-to-S&D above: if the right-clicked
                      tile is part of an active multi-select, transcribe
                      the whole selection; otherwise just this one. Same
                      transcribeSelectedVideos pipeline as the toolbar
                      button, so the same modal + ref-guard + Whisper
                      worker handle it. */}
                  {f.file_type === 'video' && (
                    <ContextMenuItem
                      onSelect={() => {
                        const inMulti = selectedFileIds.size > 0 && selectedFileIds.has(f.id);
                        const targets = inMulti
                          ? files.filter(file => selectedFileIds.has(file.id) && file.file_type === 'video').map(file => file.file_path)
                          : [f.file_path];
                        if (targets.length === 0) return;
                        void transcribeSelectedVideos(targets);
                      }}
                      data-testid={`memories-tile-transcribe-${f.id}`}
                    >
                      <Captions className="w-3.5 h-3.5 mr-2" />
                      Transcribe{selectedFileIds.size > 0 && selectedFileIds.has(f.id)
                        ? ` (${files.filter(file => selectedFileIds.has(file.id) && file.file_type === 'video').length})`
                        : ''}…
                    </ContextMenuItem>
                  )}
                  {/* Monthly-thumbnail override — only shown when the user
                      is inside a month context (month != null). Lets them
                      override the auto-picked sample shown on the month
                      tile in the By-Date grid. After a successful set we
                      invalidate the prefetch cache (so a later visit from
                      Welcome reads fresh) and bump the parent's refresh
                      tick (so the month tile updates as soon as the user
                      goes back). */}
                  {month != null && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={async () => {
                          const result = await setMonthlyThumbnail({ year, month, fileId: f.id });
                          if (result.success) {
                            invalidatePrefetchedMemories();
                            onRequestRefresh();
                            toast.success('Monthly thumbnail set', {
                              description: `${MONTH_NAMES[month - 1]} ${year} now uses this photo`,
                            });
                          } else {
                            toast.error("Couldn't set monthly thumbnail", { description: result.error });
                          }
                        }}
                      >
                        <Star className="w-3.5 h-3.5 mr-2" />
                        Set as monthly thumbnail
                      </ContextMenuItem>
                    </>
                  )}
                  {/* v2.0.15 (Terry 2026-05-28) — PDR Recycle Bin.
                      Soft-delete: photo stays on disk, hides from
                      every view, restorable from the Recycle Bin tab.
                      If the user already has a multi-select that
                      includes this photo, send the whole selection in
                      one go (right-click on any tile inside the
                      selection works like a bulk command); otherwise
                      just this photo. */}
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={async () => {
                      const ids = selectedFileIds.has(f.id) && selectedFileIds.size > 1
                        ? Array.from(selectedFileIds)
                        : [f.id];
                      const r = await moveToRecycleBin(ids);
                      if (r.success) {
                        toast.success(ids.length === 1 ? 'Moved to Recycle Bin' : `Moved ${r.count ?? ids.length} to Recycle Bin`);
                        if (ids.length > 1) clearSelection();
                        onRequestRefresh();
                      } else {
                        toast.error('Couldn’t move to Recycle Bin', { description: r.error });
                      }
                    }}
                    className="text-red-600 dark:text-red-400 focus:text-red-700 focus:bg-red-50 dark:focus:bg-red-950/30"
                    data-testid={`memories-tile-recycle-${f.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-2" />
                    {selectedFileIds.has(f.id) && selectedFileIds.size > 1
                      ? `Move ${selectedFileIds.size} to PDR Recycle Bin`
                      : 'Move to PDR Recycle Bin'}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
                </div>
              </CaptionTooltip>
              );
            })}
                </div>
              </div>
                );
              })}
            </div>
          </>
        )}
        {/* v2.0.14 (Terry 2026-05-28) — floating navigation cluster.
            Single rounded pill at bottom-right of the scroll area
            holding a D (day) column always, and an M (month) column
            only when the drilldown spans multiple months (year view).
            Layout reads vertically as ↑ → label → ↓ in each column,
            matching the spatial scroll direction and saving the user
            from punching PageDown 30 times to skip a month. Tooltips
            stay short (single word + shortcut) because the inline
            D/M letter labels already disambiguate the columns. */}
        {files != null && filesByDay.length > 1 && (
          <div className="pointer-events-none sticky bottom-4 z-20 flex justify-end pr-2 -mt-4">
            <div className="pointer-events-auto flex items-stretch gap-1 bg-background/95 backdrop-blur-sm border border-border shadow-md rounded-2xl p-1">
              {/* Day column — always shown when filesByDay.length > 1. */}
              <div className="flex flex-col items-center">
                <IconTooltip label="Newer day (PageUp)" side="left">
                  <button
                    type="button"
                    onClick={goToPrevDay}
                    disabled={!currentDayKey || filesByDay.findIndex((g) => g.dayKey === currentDayKey) <= 0}
                    className="w-7 h-7 rounded-md text-foreground hover:bg-accent transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                    data-testid="drilldown-prev-day"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                </IconTooltip>
                <span className="text-[10px] font-semibold tracking-wider text-muted-foreground py-0.5 select-none" aria-hidden="true">D</span>
                <IconTooltip label="Older day (PageDown)" side="left">
                  <button
                    type="button"
                    onClick={goToNextDay}
                    disabled={!currentDayKey || filesByDay.findIndex((g) => g.dayKey === currentDayKey) >= filesByDay.length - 1}
                    className="w-7 h-7 rounded-md text-foreground hover:bg-accent transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                    data-testid="drilldown-next-day"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </IconTooltip>
              </div>
              {/* Month column — only when the drilldown crosses month
                  boundaries (i.e. the user is on a year drilldown). */}
              {hasMultipleMonths && (
                <>
                  <div className="w-px bg-border/60 mx-0.5" aria-hidden="true" />
                  <div className="flex flex-col items-center">
                    <IconTooltip label="Newer month" side="left">
                      <button
                        type="button"
                        onClick={goToPrevMonth}
                        disabled={!monthEdges.hasPrev}
                        className="w-7 h-7 rounded-md text-foreground hover:bg-accent transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                        data-testid="drilldown-prev-month"
                      >
                        <ChevronUp className="w-4 h-4" />
                      </button>
                    </IconTooltip>
                    <span className="text-[10px] font-semibold tracking-wider text-muted-foreground py-0.5 select-none" aria-hidden="true">M</span>
                    <IconTooltip label="Older month" side="left">
                      <button
                        type="button"
                        onClick={goToNextMonth}
                        disabled={!monthEdges.hasNext}
                        className="w-7 h-7 rounded-md text-foreground hover:bg-accent transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                        data-testid="drilldown-next-month"
                      >
                        <ChevronDown className="w-4 h-4" />
                      </button>
                    </IconTooltip>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
