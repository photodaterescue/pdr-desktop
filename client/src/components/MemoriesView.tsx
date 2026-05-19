import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
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
  type MemoriesYearBucket,
  type MemoriesOnThisDayItem,
  type IndexedFile,
  type IndexedRun,
} from '../lib/electron-bridge';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { DensityToggle, type Density } from '@/components/ui/density-toggle';
import AddToAlbumPopover from './AddToAlbumPopover';

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
    // Normalise key so order doesn't matter and case is stable.
    const key = labels.map(l => l.toLowerCase().trim()).sort().join('||') || `__run_${r.id}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.runIds.push(r.id);
      existing.fileCount += r.file_count;
    } else {
      const label = labels.length > 0 ? labels.join(' + ') : (r.destination_path.split(/[\\/]/).filter(Boolean).pop() || `Run #${r.id}`);
      byKey.set(key, { key, label, runIds: [r.id], fileCount: r.file_count });
    }
  }
  return Array.from(byKey.values());
}

export default function MemoriesView() {
  // (Back-to-album pill moved into TitleBar — see TitleBar.tsx.)

  const [runs, setRuns] = useState<IndexedRun[]>([]);
  // Multi-select library filter — matches S&D's Library Drive
  // pattern (Terry 2026-05-19: "Libraries in By Date… should be
  // the same one as in S&D… have all enabled by default").
  // Default = all library keys; treated as a no-op filter when
  // every library is selected. State holds the SET of selected
  // keys; the data fetch maps to union of runIds.
  const [libraryKeys, setLibraryKeys] = useState<string[]>([]);
  const [buckets, setBuckets] = useState<MemoriesYearBucket[]>([]);
  const [onThisDay, setOnThisDay] = useState<MemoriesOnThisDayItem[]>([]);
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

  // Load once on mount.
  useEffect(() => {
    (async () => {
      const r = await listSearchRuns();
      if (r.success && r.data) setRuns(r.data);
    })();
  }, []);

  // Derived libraries grouping + currently-selected run IDs (or undefined
  // for "all libraries"). Libraries is memoised so the effect below doesn't
  // spin from identity-only changes.
  const libraries = useMemo(() => groupRunsIntoLibraries(runs), [runs]);

  // Default the selection to ALL library keys when the libraries list
  // first loads. Terry 2026-05-19: "have all enabled by default".
  // Re-runs if the underlying library set changes (e.g. new Fix run).
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
  }, [libraries]);

  const selectedRunIds = useMemo(() => {
    // All libraries selected (or none — treated as all for safety)
    // = no-op filter; pass undefined so the backend doesn't bother
    // narrowing.
    if (libraryKeys.length === 0 || libraryKeys.length === libraries.length) {
      return undefined;
    }
    const selectedSet = new Set(libraryKeys);
    return libraries
      .filter((l) => selectedSet.has(l.key))
      .flatMap((l) => l.runIds);
  }, [libraryKeys, libraries]);
  const selectedRunIdsKey = selectedRunIds ? selectedRunIds.join(',') : '';

  // Re-fetch whenever the scope changes.
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
  }, [selectedRunIdsKey]);

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
    const paths = new Set<string>();
    for (const b of buckets) if (b.sampleFilePath) paths.add(b.sampleFilePath);
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
  }, [buckets, onThisDay]);

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
    <div className="h-full flex flex-col bg-background">
      {/* Back-to-album pill moved into TitleBar (v2.0.8 polish pass).
          Terry 2026-05-19: "to the right of 'Photo Date Rescue' in
          the titlebar" — visible regardless of which surface is
          active. */}
      {/* By-Date controls row. The "Memories" page title now lives one
          level up in MemoriesPanel, above the [By Date | Albums] tabs,
          so we don't repeat it here. The summary line stays — it's
          specific to the By Date view (photo/video counts across
          years) and useful context just below the tab strip. */}
      <div className="shrink-0 px-6 pt-4 pb-3 border-b border-border/60 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground">
            {loading
              ? 'Loading…'
              : buckets.length === 0
                ? 'No photos indexed yet — run a Fix first to build your memory timeline.'
                : `${totalPhotos.toLocaleString()} photos · ${totalVideos.toLocaleString()} videos across ${yearGroups.length} ${yearGroups.length === 1 ? 'year' : 'years'}.`}
          </p>
          {/* Jump to most recent year — useful after returning from a
              deep drilldown into older years. Terry 2026-05-19:
              "there should be a button that says back to today, or
              latest photos". Hidden when timeline is empty. */}
          {yearGroups.length > 0 && (
            <IconTooltip label={`Jump to ${yearGroups[0][0]} (most recent)`} side="bottom">
              <button
                onClick={() => jumpToYear(yearGroups[0][0])}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-border bg-secondary/50 hover:bg-secondary text-xs font-medium text-foreground transition-colors"
                data-testid="button-jump-to-latest"
              >
                <ArrowUpToLine className="w-3 h-3" />
                Jump to latest
              </button>
            </IconTooltip>
          )}
        </div>

        {/* `data-tour="mem-controls"` wraps both static controls so step
            3 of the Memories tour has a guaranteed spotlight target.
            Replaces the previous `mem-on-this-day` step which was
            conditional on having past-year photos for today's date —
            users with no historical photos for today saw a centered
            tooltip and no highlight (Terry's report May 7 2026). */}
        <div className="flex items-center gap-3" data-tour="mem-controls">
          <DensityToggle value={density} onChange={changeDensity} />
          <LibrarySelector libraries={libraries} selectedKeys={libraryKeys} onChange={setLibraryKeys} />
        </div>
      </div>

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
            {onThisDay.length > 0 && (
              <section
                className="mx-6 mt-6 mb-4 p-4 rounded-2xl bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border border-primary/20 shadow-sm"
                data-tour="mem-on-this-day"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/20 text-[10px] font-semibold uppercase tracking-wider text-primary">
                    <Sparkles className="w-3 h-3" />
                    AI suggestion
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {onThisDay.length} {onThisDay.length === 1 ? 'photo' : 'photos'}
                  </span>
                </div>
                <div className="mb-3">
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
                      {monthBuckets.map((b) => (
                        <MonthTile
                          key={`${b.year}-${b.month}`}
                          bucket={b}
                          thumb={b.sampleFilePath ? thumbs[b.sampleFilePath] : undefined}
                          onOpen={() => openMonth(b.year, b.month)}
                          density={density}
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
  const allSelected = selectedKeys.length === 0 || selectedKeys.length === libraries.length;
  const summary = allSelected
    ? `All libraries (${libraries.length})`
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
        <div className="flex items-center justify-between px-2 pt-1 pb-2 border-b border-border mb-1">
          <span className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider">Libraries</span>
          <div className="flex items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => onChange(libraries.map((l) => l.key))}
              className="text-primary hover:underline disabled:opacity-40 disabled:no-underline"
              disabled={selectedKeys.length === libraries.length}
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-muted-foreground hover:underline disabled:opacity-40 disabled:no-underline"
              disabled={selectedKeys.length === 0}
            >
              Clear all
            </button>
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {libraries.map((lib) => {
            const checked = selectedKeys.includes(lib.key) || selectedKeys.length === 0;
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

function MonthTile({ bucket, thumb, onOpen, density }: { bucket: MemoriesYearBucket; thumb?: string; onOpen: () => void; density: Density }) {
  const total = (bucket.photoCount || 0) + (bucket.videoCount || 0);
  const tight = density === 'tight';
  return (
    <IconTooltip label={`${MONTH_NAMES[bucket.month - 1]} ${bucket.year} · ${total.toLocaleString()} files`} side="top">
    <button
      onClick={() => onOpen()}
      className={`group relative aspect-[4/3] overflow-hidden bg-secondary/30 transition-all text-left ${tight ? '' : 'rounded-xl ring-1 ring-border hover:ring-primary/50'}`}
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

function MemoriesDayDrilldown({ year, month, day, runIds, density, onDensityChange, onBack }: { year: number; month?: number; day?: number; runIds: number[] | undefined; density: Density; onDensityChange: (d: Density) => void; onBack: () => void }) {
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
  }, [year, month, day, runIdsKey]);

  // Per-day grid thumbnail load — same sliding-window pool pattern
  // as the year/month overview. See the comment on that effect for
  // the why.
  useEffect(() => {
    if (!files) return;
    let cancelled = false;
    const missing = files.filter((f) => !thumbs[f.file_path]);
    if (missing.length === 0) return;
    const CONCURRENCY = 12;
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
        {files != null && (
          <span className="text-xs text-muted-foreground">
            {files.length.toLocaleString()} {files.length === 1 ? 'file' : 'files'}
          </span>
        )}
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
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-border bg-secondary/50 hover:bg-secondary text-xs font-medium text-foreground transition-colors"
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
              // year/month/day set.
              const target = selectedFileIds.size > 0
                ? files.filter(f => selectedFileIds.has(f.id))
                : files;
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

      <div ref={gridScrollRef} className="flex-1 overflow-y-auto p-6">
        {files == null ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading…</div>
        ) : files.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            {month == null ? `No files for ${year}.` : day == null ? `No files for ${MONTH_NAMES[month - 1]} ${year}.` : 'No files on this day.'}
          </div>
        ) : (
          <div
            className={`grid ${density === 'tight' ? 'gap-0' : 'gap-3'}`}
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${drilldownSliderToPx(tileSizeSlider)}px, 1fr))` }}
          >
            {files.map((f, idx) => {
              const isMultiSelected = selectedFileIds.has(f.id);
              return (
              <ContextMenu key={f.id}>
                <ContextMenuTrigger asChild>
                    <button
                      // Native title attribute (sanctioned by
                      // IconTooltip's own source comment for tile-
                      // grid use cases — "Keep native title= only for
                      // pure overflow/truncation previews ... where
                      // converting thousands of DOM nodes to Radix
                      // tooltips would be a perf regression"). The
                      // previous IconTooltip wrapper broke
                      // ContextMenuTrigger asChild because Radix
                      // tried to forward trigger props to the
                      // TooltipProvider element — context-menu event
                      // never reached the button. With native title
                      // the button IS the trigger's direct child, so
                      // right-click works.
                      title={`${f.filename} · ${formatHumanDate(f.derived_date)}`}
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
                        if (e.shiftKey && lastClickedIndexRef.current !== null) {
                          const start = Math.min(lastClickedIndexRef.current, idx);
                          const end = Math.max(lastClickedIndexRef.current, idx);
                          for (let i = start; i <= end; i++) {
                            const file = files[i];
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
                        openSearchViewer(files.map(x => x.file_path), files.map(x => x.filename), idx);
                      }}
                      className={`group relative aspect-square overflow-hidden bg-secondary/30 transition-all ${
                        isMultiSelected ? 'ring-2 ring-primary' :
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
                            for (let i = start; i <= end; i++) {
                              const file = files[i];
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
                            ? 'bg-primary border-primary text-primary-foreground opacity-100'
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
                </ContextMenuContent>
              </ContextMenu>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
