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
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/custom-button';
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

type Density = 'spacious' | 'tight';

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
  const [runs, setRuns] = useState<IndexedRun[]>([]);
  const [libraryKey, setLibraryKey] = useState<string | undefined>(undefined); // undefined = all libraries
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
  const selectedRunIds = useMemo(() => {
    if (!libraryKey) return undefined;
    const lib = libraries.find(l => l.key === libraryKey);
    return lib ? lib.runIds : undefined;
  }, [libraryKey, libraries]);
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

  const openMonth = (year: number, month: number) => setSelectedRange({ year, month });
  const openYear = (year: number) => setSelectedRange({ year });

  // Year sidebar — quick scroll to a year.
  const jumpToYear = (year: number) => {
    const el = document.getElementById(`memories-year-${year}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (selectedRange) {
    return (
      <MemoriesDayDrilldown
        year={selectedRange.year}
        month={selectedRange.month}
        day={selectedRange.day}
        runIds={selectedRunIds}
        density={density}
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
      {/* Header: title + library selector */}
      <div className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <CalendarRange className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Memories</h1>
            <p className="text-xs text-muted-foreground">
              {loading
                ? 'Loading…'
                : buckets.length === 0
                  ? 'No photos indexed yet — run a Fix first to build your memory timeline.'
                  : `${totalPhotos.toLocaleString()} photos · ${totalVideos.toLocaleString()} videos across ${yearGroups.length} ${yearGroups.length === 1 ? 'year' : 'years'}.`}
            </p>
          </div>
        </div>

        {/* `data-tour="mem-controls"` wraps both static controls so step
            3 of the Memories tour has a guaranteed spotlight target.
            Replaces the previous `mem-on-this-day` step which was
            conditional on having past-year photos for today's date —
            users with no historical photos for today saw a centered
            tooltip and no highlight (Terry's report May 7 2026). */}
        <div className="flex items-center gap-3" data-tour="mem-controls">
          <DensityToggle value={density} onChange={changeDensity} />
          <LibrarySelector libraries={libraries} value={libraryKey} onChange={setLibraryKey} />
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
            {/* On This Day row — `data-tour="mem-on-this-day"` is the
                spotlight target for step 3 of the Memories tour. */}
            {onThisDay.length > 0 && (
              <section className="px-6 pt-6 pb-4" data-tour="mem-on-this-day">
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <h2 className="text-sm font-semibold text-foreground">On {otdLabel} in previous years</h2>
                  <span className="text-xs text-muted-foreground">· {onThisDay.length} {onThisDay.length === 1 ? 'photo' : 'photos'}</span>
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

// ─── Density toggle ───────────────────────────────────────────────────────

function DensityToggle({ value, onChange }: { value: Density; onChange: (d: Density) => void }) {
  return (
    <div className="flex items-center rounded-md border border-border overflow-hidden bg-background">
      <IconTooltip label="Space between photos" side="bottom">
        <button
          onClick={() => onChange('spacious')}
          className={`px-2 py-1 text-[11px] font-medium transition-colors ${value === 'spacious' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
        >
          Spacious
        </button>
      </IconTooltip>
      <IconTooltip label="No gaps between photos — dense wall view" side="bottom">
        <button
          onClick={() => onChange('tight')}
          className={`px-2 py-1 text-[11px] font-medium transition-colors border-l border-border ${value === 'tight' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
        >
          Tight
        </button>
      </IconTooltip>
    </div>
  );
}

// ─── Library selector ──────────────────────────────────────────────────────

function LibrarySelector({ libraries, value, onChange }: { libraries: Library[]; value: string | undefined; onChange: (key: string | undefined) => void }) {
  // Hide entirely when there's only one logical library — nothing to choose
  // between. Destinations alone don't create separate libraries; parallel
  // structures (when they ship) will surface as distinct entries here
  // because they carry a different source-labels signature.
  if (libraries.length <= 1) return null;
  return (
    <div className="flex items-center gap-2">
      <Layers className="w-4 h-4 text-muted-foreground" />
      <label className="text-xs text-muted-foreground">Library</label>
      <select
        value={value ?? 'all'}
        onChange={(e) => onChange(e.target.value === 'all' ? undefined : e.target.value)}
        className="px-2.5 py-1 rounded-md border border-border bg-background text-xs text-foreground cursor-pointer"
      >
        <option value="all">All libraries ({libraries.length})</option>
        {libraries.map((lib) => (
          <option key={lib.key} value={lib.key}>
            {lib.label} · {lib.fileCount.toLocaleString()} files
          </option>
        ))}
      </select>
    </div>
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

function MemoriesDayDrilldown({ year, month, day, runIds, density, onBack }: { year: number; month?: number; day?: number; runIds: number[] | undefined; density: Density; onBack: () => void }) {
  const [files, setFiles] = useState<IndexedFile[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

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
        {files != null && files.length > 1 && (
          <button
            onClick={() => openSearchViewer(files.map(f => f.file_path), files.map(f => f.filename))}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all"
          >
            Open all in Viewer
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
            {files.map((f, idx) => (
              <IconTooltip key={f.id} label={`${f.filename} · ${formatHumanDate(f.derived_date)}`} side="top">
                <button
                  // Pass every file in this drilldown + the clicked
                  // index so the viewer's arrows browse the whole
                  // year/month/day from where the user landed.
                  onClick={() => openSearchViewer(files.map(x => x.file_path), files.map(x => x.filename), idx)}
                  className={`group relative aspect-square overflow-hidden bg-secondary/30 transition-all ${density === 'tight' ? '' : 'rounded-lg ring-1 ring-border hover:ring-primary/50'}`}
                >
                  {thumbs[f.file_path] ? (
                    <img src={thumbs[f.file_path]} alt={f.filename} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-muted-foreground/70">
                      {f.file_type === 'video' ? <Film className="w-6 h-6" /> : <ImageIcon className="w-6 h-6" />}
                    </div>
                  )}
                  {f.file_type === 'video' && (
                    <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[9px] font-medium flex items-center gap-1">
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
              </IconTooltip>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
