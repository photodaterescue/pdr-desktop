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
  Image as ImageIcon,
  Layers,
  X,
  Info,
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
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
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
  type MemoriesYearBucket,
  type MemoriesOnThisDayItem,
  type IndexedFile,
  type IndexedRun,
} from '../lib/electron-bridge';
import { IconTooltip } from '@/components/ui/icon-tooltip';
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
  const [selectedRange, setSelectedRange] = useState<{ year: number; month?: number; day?: number } | null>(null);
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
              {/* Manual refresh — to the left of the Spacious/Tight
                  toggle per Terry's placement spec 2026-05-20. Bumps
                  the refreshTick state, which re-runs the bucket +
                  on-this-day fetch. Tooltip via IconTooltip per
                  style-guide. The icon button matches the muted
                  border-button look used by Jump-to-latest and the
                  collapsed-sidebar burger so it visually belongs in
                  this control cluster. */}
              <IconTooltip label="Refresh — reload the timeline" side="bottom">
                <button
                  type="button"
                  onClick={() => setRefreshTick(t => t + 1)}
                  disabled={loading}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-border bg-secondary/50 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                  data-testid="memories-refresh"
                  aria-label="Refresh Memories"
                >
                  <RotateCcw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </IconTooltip>
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
        //     is the Memories brand accent (#f8c15c), used here for
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
                borderColor: '#f8c15c',
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
          {yearGroups.length > 1 && (
            <aside className="w-[68px] shrink-0 border-r border-border/60 overflow-y-auto py-4 px-1 text-center">
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
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/20 text-[10px] font-semibold uppercase tracking-wider text-primary">
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

function MemoriesDayDrilldown({ year, month, day, runIds, density, onDensityChange, onBack, onRequestRefresh }: { year: number; month?: number; day?: number; runIds: number[] | undefined; density: Density; onDensityChange: (d: Density) => void; onBack: () => void; onRequestRefresh: () => void }) {
  const [files, setFiles] = useState<IndexedFile[] | null>(null);
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
  // Clear selection on drilldown navigation — when the user clicks
  // a different year/month/day, the old selection is no longer
  // referenceable in the new file list.
  useEffect(() => { clearSelection(); }, [year, month, day]);

  // v2.0.14 — "Captioned only" filter, mirrored from AlbumsView. Resets
  // on year/month/day change so a niche filter doesn't silently follow
  // the user across the timeline.
  const [captionedOnly, setCaptionedOnly] = useState(false);
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

  // v2.0.15 — when ANY recycle change happens (this view's context
  // menu, the top-bar Delete button, a restore from the Recycle Bin
  // tab), re-fetch the visible files. Without this the just-deleted
  // tile lingered in the grid until the user navigated away and back.
  useEffect(() => {
    const off = onRecycleBinChanged(() => setDrilldownRefreshTick(t => t + 1));
    return () => off();
  }, []);

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
    return captionedOnly ? files.filter((f) => f.caption && f.caption.length > 0) : files;
  }, [files, captionedOnly]);

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
  const estimateDayRowHeight = (idx: number): number => {
    const group = filesByDay[idx];
    if (!group) return 200;
    const HEADER_HEIGHT = 44;
    const ROW_MARGIN_TOP = 12;
    const SECTION_GAP = 20;
    const rows = Math.ceil(group.files.length / colsPerRow);
    const gridHeight = rows * tilePx + Math.max(0, (rows - 1) * tileGap);
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
      <div className="shrink-0 px-6 py-4 border-b border-border/60 flex items-center gap-3">
        <button
          onClick={onBack}
          data-pdr-variant="information"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors"
          style={{ backgroundColor: '#dbeafe', borderColor: '#3b82f6', color: '#1e3a8a', borderWidth: '1px', borderStyle: 'solid' }}
        >
          <ChevronLeft className="w-4 h-4" /> Back to timeline
        </button>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {files != null && (() => {
          // Break out photos vs videos the same way the month tile
          // on the timeline does — Terry 2026-05-20: "There's NOTHING
          // that says the number of photos or videos while you're in
          // the month... are we meant to memorise the data from the
          // previous level that we can no longer see?". The previous
          // "X files" string lumped them together which made it
          // impossible to know what you'd actually find inside the
          // month at a glance. Mirrors MonthTile's photo / video
          // line so the two surfaces speak the same language.
          const photoCount = files.filter(f => f.file_type === 'photo').length;
          const videoCount = files.filter(f => f.file_type === 'video').length;
          const parts: string[] = [];
          if (photoCount > 0) parts.push(`${photoCount.toLocaleString()} ${photoCount === 1 ? 'photo' : 'photos'}`);
          if (videoCount > 0) parts.push(`${videoCount.toLocaleString()} ${videoCount === 1 ? 'video' : 'videos'}`);
          return (
            <span className="text-xs text-muted-foreground">
              {parts.join(' · ')}
            </span>
          );
        })()}
        {/* v2.0.14 — "Captioned only" chip, mirrored from AlbumsView
            (gold pill, same MessageSquareText icon, same hide-when-zero
            rule). Filters the drilldown's per-day grid to just photos
            with a non-empty caption. Only renders when at least one
            file in the current year/month/day has a caption. */}
        {files != null && (() => {
          const captionedCount = files.filter((f) => f.caption && f.caption.length > 0).length;
          if (captionedCount === 0) return null;
          return (
            <IconTooltip label={captionedOnly ? 'Show all photos' : 'Show only photos with captions'} side="bottom">
              <button
                type="button"
                onClick={() => setCaptionedOnly((v) => !v)}
                data-testid="memories-captioned-only-toggle"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ${
                  captionedOnly
                    ? 'bg-[var(--color-gold)] border-[var(--color-gold)] text-[#1f1a08]'
                    : 'bg-background border-border text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
              >
                <MessageSquareText className="w-3 h-3" />
                Captioned only · {captionedCount.toLocaleString()}
              </button>
            </IconTooltip>
          );
        })()}
        {/* Add Info — same checkbox dropdown style as S&D's tile
            metadata picker, so muscle-memory transfers. Defaults to
            NONE (clean photo wall) and lets the user opt into
            filename / date as they prefer. */}
        <Popover open={showMetaDropdown} onOpenChange={setShowMetaDropdown}>
          <IconTooltip label="Choose which details show below each photo" side="bottom">
            <PopoverTrigger asChild>
              <button
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border transition-colors text-xs font-medium ${metaFields.length > 0 ? 'bg-primary/10 text-primary border-primary/30' : 'text-muted-foreground border-border hover:text-foreground hover:bg-secondary/50 hover:border-primary/40'}`}
              >
                <Info className="w-3.5 h-3.5" />
                <span>Add Info{metaFields.length > 0 ? ` (${metaFields.length})` : ''}</span>
              </button>
            </PopoverTrigger>
          </IconTooltip>
          <PopoverContent className="w-56 p-2" align="start">
            <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider px-2 pt-1 pb-2">Show below each tile</p>
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
            {metaFields.length > 0 && (
              <button
                onClick={() => setMetaFields([])}
                className="w-full mt-2 px-3 py-1.5 rounded-md text-xs font-medium border border-border hover:bg-secondary text-muted-foreground transition-colors"
              >
                Clear all
              </button>
            )}
            <p className="text-[10px] text-muted-foreground/85 px-2 pt-2 leading-snug">
              Tip: Hold <kbd className="px-1 py-0.5 rounded bg-secondary text-[9px] font-mono">Ctrl</kbd> + scroll to zoom tile size.
            </p>
          </PopoverContent>
        </Popover>
        {/* v2.0.15 — manual refresh button (Terry 2026-05-29: monthly
            refresh should match year-view positioning — to the LEFT
            of the Spacious/Tight toggle, not inline with the title).
            Styling copies the year-view refresh button exactly
            (border-button look used by Jump-to-latest + the
            collapsed-sidebar burger) so the two surfaces share one
            visual language. Re-pulls the visible files + bumps the
            parent's refreshTick so the year-level buckets re-fetch
            too. Recycle / restore / caption events auto-refresh via
            the recycle:changed listener; this button covers the
            "background Fix completed, want to see new photos now"
            case. */}
        <IconTooltip label="Refresh — reload this month" side="bottom">
          <button
            type="button"
            onClick={() => { setDrilldownRefreshTick(t => t + 1); onRequestRefresh(); }}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-border bg-secondary/50 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
            data-testid="memories-drilldown-refresh"
            aria-label="Refresh this month"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </IconTooltip>
        {/* Density toggle — same control as the main timeline view,
            so the user can switch spacious/tight while drilled in
            (Terry 2026-05-19: "Spacious - Tight should still be an
            option when drilling into look at the months photos"). */}
        <DensityToggle value={density} onChange={onDensityChange} />
        {/* Select toggle — when on, checkboxes are visible by default.
            Mouse-only / accessibility alternative to Ctrl/Shift+click. */}
        <IconTooltip label={selectionMode ? 'Exit selection mode' : 'Show checkboxes on every photo'} side="bottom">
          <button
            onClick={() => setSelectionMode(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border transition-colors text-xs font-medium ${selectionMode ? 'bg-primary text-primary-foreground border-primary' : 'text-muted-foreground border-border hover:text-foreground hover:bg-secondary/50 hover:border-primary/40'}`}
            data-testid="button-selection-mode"
          >
            <ListChecks className="w-3.5 h-3.5" />
            {selectionMode ? 'Selecting' : 'Select'}
          </button>
        </IconTooltip>
        {/* Selection bar — only renders when user has checked items.
            Mirrors the S&D selection-bar contract: dismissable chip
            with count + AddToAlbumPopover sit between the static
            controls and the "Open all in Viewer" CTA. */}
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
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[var(--color-gold)] bg-[var(--color-gold)] hover:opacity-90 text-xs font-medium text-[#1f1a08] transition-colors"
                data-testid="memories-selection-chip"
              >
                {selectedFileIds.size} selected
                <X className="w-3 h-3 opacity-70" />
              </button>
            </IconTooltip>
            <AddToAlbumPopover
              fileIds={Array.from(selectedFileIds)}
              onAdded={clearSelection}
            />
            {/* v2.0.15 (Terry 2026-05-28) — soft-delete batch action.
                Moves the selected photos into the PDR Recycle Bin (sets
                in_recycle_bin = 1; file stays on disk). Reversible
                from the Recycle Bin view. Uses the destructive variant
                of custom-button for the rose-tinted "danger" palette
                that matches the rest of PDR's delete affordances. */}
            <IconTooltip label={`Move ${selectedFileIds.size} to PDR Recycle Bin`} side="bottom">
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
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
                data-testid="memories-selection-recycle"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                Delete
              </Button>
            </IconTooltip>
          </>
        )}
        {files != null && files.length > 1 && (
          <button
            onClick={() => {
              // When the user has a selection, open ONLY those files
              // in the viewer (Terry 2026-05-19: "if any photos have
              // been checked/selected, then it should read 'Open
              // Selected in Viewer' — and obviously only show the
              // selected in the viewer"). Otherwise open the full
              // year/month/day set. When the "Captioned only" chip is
              // on, the unselected open-all opens just the filtered
              // subset so arrow-key navigation stays inside what the
              // user can see (matches AlbumsView's contract).
              const base = visibleFiles ?? files;
              const target = selectedFileIds.size > 0
                ? base.filter(f => selectedFileIds.has(f.id))
                : base;
              openSearchViewer(target.map(f => f.file_path), target.map(f => f.filename));
            }}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all whitespace-nowrap"
            data-testid="button-open-in-viewer"
          >
            {selectedFileIds.size > 0
              ? `Open ${selectedFileIds.size} Selected in Viewer`
              : `Open ${title} in Viewer`}
          </button>
        )}
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
      <div ref={gridScrollRef} className="relative flex-1 overflow-y-auto p-6 outline-none">
        {files == null ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading…</div>
        ) : files.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            {month == null ? `No files for ${year}.` : day == null ? `No files for ${MONTH_NAMES[month - 1]} ${year}.` : 'No files on this day.'}
          </div>
        ) : (
          <>
            {/* v2.0.13 — floating "current day" pill that fades in
                while the user is scrolling. Anchored top-right inside
                the scroll area; pointer-events-none so it never
                blocks photo clicks. */}
            {currentDayLabel && (
              <div
                className={`pointer-events-none sticky top-2 z-30 flex justify-end transition-opacity duration-200 ${
                  scrollIndicatorVisible ? 'opacity-100' : 'opacity-0'
                }`}
                aria-hidden={!scrollIndicatorVisible}
              >
                <div className="px-3 py-1.5 rounded-full bg-background/95 backdrop-blur-sm border border-border shadow-md text-xs font-medium text-foreground">
                  {currentDayLabel}
                </div>
              </div>
            )}
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
                ref={rowVirtualizer.measureElement}
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
                      onClick={(e) => {
                        if (e.ctrlKey || e.metaKey) {
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
                      <CaptionBadge caption={f.caption} />
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
                    onSelect={() => { (window as any).pdr?.shell?.revealInFolder?.(f.file_path); }}
                    data-testid={`memories-tile-reveal-${f.id}`}
                  >
                    <HardDrive className="w-3.5 h-3.5 mr-2" />
                    Show in File Explorer
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
                      toggleSelection(f, 'add');
                      lastClickedIndexRef.current = idx;
                      toast.message('Added to selection', { description: 'Use "Add to album" in the header to pick the album.' });
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
