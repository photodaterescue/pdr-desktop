import { useEffect, useMemo, useState } from 'react';
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Film,
  Image as ImageIcon,
  Layers,
  X,
} from 'lucide-react';
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

// ─── Helpers ───────────────────────────────────────────────────────────────

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function runLabel(run: IndexedRun): string {
  try {
    const labels = run.source_labels ? (JSON.parse(run.source_labels) as string[]) : [];
    if (labels.length > 0) return labels.join(' + ');
  } catch { /* legacy format */ }
  // Fallback: show the destination folder tail.
  const tail = run.destination_path.split(/[\\/]/).filter(Boolean).pop() || `Run #${run.id}`;
  return tail;
}

function formatHumanDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

// ─── Main component ────────────────────────────────────────────────────────

type Density = 'spacious' | 'tight';

export default function MemoriesView() {
  const [runs, setRuns] = useState<IndexedRun[]>([]);
  const [runId, setRunId] = useState<number | undefined>(undefined); // undefined = all libraries
  const [buckets, setBuckets] = useState<MemoriesYearBucket[]>([]);
  const [onThisDay, setOnThisDay] = useState<MemoriesOnThisDayItem[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<{ year: number; month: number; day: number } | null>(null);
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

  // Re-fetch whenever the scope changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const today = new Date();
      const [ym, otd] = await Promise.all([
        getMemoriesYearMonthBuckets(runId),
        getMemoriesOnThisDay({ month: today.getMonth() + 1, day: today.getDate(), runId, limit: 40 }),
      ]);
      if (cancelled) return;
      setBuckets(ym.success && ym.data ? ym.data : []);
      setOnThisDay(otd.success && otd.data ? otd.data : []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [runId]);

  // Batch-load sample thumbnails for each year/month card + on-this-day items.
  useEffect(() => {
    let cancelled = false;
    const paths = new Set<string>();
    for (const b of buckets) if (b.sampleFilePath) paths.add(b.sampleFilePath);
    for (const o of onThisDay) paths.add(o.file_path);
    const toLoad = Array.from(paths).filter((p) => !thumbs[p]);
    (async () => {
      for (let i = 0; i < toLoad.length; i += 8) {
        if (cancelled) return;
        const batch = toLoad.slice(i, i + 8);
        const results = await Promise.allSettled(
          batch.map(async (p) => ({ p, r: await getThumbnail(p, 160) }))
        );
        if (cancelled) return;
        const add: Record<string, string> = {};
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.r.success && r.value.r.dataUrl) {
            add[r.value.p] = r.value.r.dataUrl;
          }
        }
        if (Object.keys(add).length > 0) setThumbs((prev) => ({ ...prev, ...add }));
      }
    })();
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

  const openDay = (year: number, month: number, day: number) => {
    setSelectedDay({ year, month, day });
  };

  // Year sidebar — quick scroll to a year.
  const jumpToYear = (year: number) => {
    const el = document.getElementById(`memories-year-${year}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (selectedDay) {
    return (
      <MemoriesDayDrilldown
        year={selectedDay.year}
        month={selectedDay.month}
        day={selectedDay.day}
        runId={runId}
        density={density}
        onBack={() => setSelectedDay(null)}
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

        <div className="flex items-center gap-3">
          <DensityToggle value={density} onChange={changeDensity} />
          <LibrarySelector runs={runs} value={runId} onChange={setRunId} />
        </div>
      </div>

      {buckets.length === 0 && !loading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-10">
          Nothing to show here yet.
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Left: year jump rail */}
          {yearGroups.length > 1 && (
            <aside className="w-[68px] shrink-0 border-r border-border/60 overflow-y-auto py-4 px-1 text-center">
              {yearGroups.map(([year]) => (
                <button
                  key={year}
                  onClick={() => jumpToYear(year)}
                  className="w-full px-1 py-1.5 mb-0.5 rounded text-xs font-mono text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
                  title={`Jump to ${year}`}
                >
                  {year}
                </button>
              ))}
            </aside>
          )}

          {/* Main scroll area */}
          <div className="flex-1 overflow-y-auto">
            {/* On This Day row */}
            {onThisDay.length > 0 && (
              <section className="px-6 pt-6 pb-4">
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <h2 className="text-sm font-semibold text-foreground">On {otdLabel} in previous years</h2>
                  <span className="text-xs text-muted-foreground">· {onThisDay.length} {onThisDay.length === 1 ? 'photo' : 'photos'}</span>
                </div>
                <div className={`flex ${density === 'tight' ? 'gap-0' : 'gap-2.5'} overflow-x-auto pb-2`}>
                  {onThisDay.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => openSearchViewer(item.file_path, item.filename)}
                      className={`group relative shrink-0 w-[140px] h-[140px] overflow-hidden bg-secondary/30 transition-all ${otdTileClass}`}
                      title={`${item.filename} · ${formatHumanDate(item.derived_date)}`}
                    >
                      {thumbs[item.file_path] ? (
                        <img src={thumbs[item.file_path]} alt={item.filename} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
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
                  ))}
                </div>
              </section>
            )}

            {/* Main timeline — year groups with month tiles */}
            <section className="px-6 pb-10 space-y-8">
              {yearGroups.map(([year, monthBuckets]) => {
                const yearPhotos = monthBuckets.reduce((s, b) => s + (b.photoCount || 0), 0);
                const yearVideos = monthBuckets.reduce((s, b) => s + (b.videoCount || 0), 0);
                return (
                  <div key={year} id={`memories-year-${year}`} className="scroll-mt-4">
                    <div className="flex items-baseline gap-3 mb-3 sticky top-0 bg-background/95 backdrop-blur py-2 z-10">
                      <h2 className="text-lg font-semibold text-foreground">{year}</h2>
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
                          onOpen={(day) => openDay(b.year, b.month, day)}
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
      <button
        onClick={() => onChange('spacious')}
        className={`px-2 py-1 text-[11px] font-medium transition-colors ${value === 'spacious' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
        title="Space between photos"
      >
        Spacious
      </button>
      <button
        onClick={() => onChange('tight')}
        className={`px-2 py-1 text-[11px] font-medium transition-colors border-l border-border ${value === 'tight' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/50'}`}
        title="No gaps between photos — dense wall view"
      >
        Tight
      </button>
    </div>
  );
}

// ─── Library selector ──────────────────────────────────────────────────────

function LibrarySelector({ runs, value, onChange }: { runs: IndexedRun[]; value: number | undefined; onChange: (id: number | undefined) => void }) {
  if (runs.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <Layers className="w-4 h-4 text-muted-foreground" />
      <label className="text-xs text-muted-foreground">Library</label>
      <select
        value={value ?? 'all'}
        onChange={(e) => onChange(e.target.value === 'all' ? undefined : Number(e.target.value))}
        className="px-2.5 py-1 rounded-md border border-border bg-background text-xs text-foreground cursor-pointer"
      >
        <option value="all">All libraries ({runs.length})</option>
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {runLabel(r)} · {r.file_count.toLocaleString()} files
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── Month tile ────────────────────────────────────────────────────────────

function MonthTile({ bucket, thumb, onOpen, density }: { bucket: MemoriesYearBucket; thumb?: string; onOpen: (day: number) => void; density: Density }) {
  const total = (bucket.photoCount || 0) + (bucket.videoCount || 0);
  const tight = density === 'tight';
  return (
    <button
      onClick={() => onOpen(1)}
      className={`group relative aspect-[4/3] overflow-hidden bg-secondary/30 transition-all text-left ${tight ? '' : 'rounded-xl ring-1 ring-border hover:ring-primary/50'}`}
      title={`${MONTH_NAMES[bucket.month - 1]} ${bucket.year} · ${total.toLocaleString()} files`}
    >
      {thumb ? (
        <img src={thumb} alt={`${MONTH_NAMES[bucket.month - 1]} ${bucket.year}`} className="absolute inset-0 w-full h-full object-cover transition-transform group-hover:scale-105" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/40">
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
  );
}

// ─── Day drill-down ────────────────────────────────────────────────────────

function MemoriesDayDrilldown({ year, month, day, runId, density, onBack }: { year: number; month: number; day: number; runId: number | undefined; density: Density; onBack: () => void }) {
  const [files, setFiles] = useState<IndexedFile[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [monthDays, setMonthDays] = useState<Set<number>>(new Set());

  // Load every day in the month that has files so we can enable prev/next
  // arrows between days (and grey out empty days).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await getMemoriesYearMonthBuckets(runId);
      if (cancelled || !r.success || !r.data) return;
      // Quick pass — the buckets query gives counts per month only. For per-day
      // availability we use the day query itself when navigating.
      setMonthDays(new Set());
    })();
    return () => { cancelled = true; };
  }, [year, month, runId]);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    (async () => {
      const r = await getMemoriesDayFiles({ year, month, day, runId });
      if (cancelled) return;
      setFiles(r.success && r.data ? r.data : []);
    })();
    return () => { cancelled = true; };
  }, [year, month, day, runId]);

  useEffect(() => {
    if (!files) return;
    let cancelled = false;
    (async () => {
      const missing = files.filter((f) => !thumbs[f.file_path]);
      for (let i = 0; i < missing.length; i += 8) {
        if (cancelled) return;
        const batch = missing.slice(i, i + 8);
        const results = await Promise.allSettled(
          batch.map(async (f) => ({ p: f.file_path, r: await getThumbnail(f.file_path, 220) }))
        );
        if (cancelled) return;
        const add: Record<string, string> = {};
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.r.success && r.value.r.dataUrl) {
            add[r.value.p] = r.value.r.dataUrl;
          }
        }
        if (Object.keys(add).length > 0) setThumbs((p) => ({ ...p, ...add }));
      }
    })();
    return () => { cancelled = true; };
  }, [files]);

  const title = `${MONTH_NAMES[month - 1]} ${day}, ${year}`;

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="shrink-0 px-6 py-4 border-b border-border/60 flex items-center gap-3">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" /> Back to timeline
        </button>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {files != null && (
          <span className="text-xs text-muted-foreground">
            {files.length.toLocaleString()} {files.length === 1 ? 'file' : 'files'}
          </span>
        )}
        {files != null && files.length > 1 && (
          <button
            onClick={() => openSearchViewer(files.map(f => f.file_path), files.map(f => f.filename))}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all"
          >
            Open all in Viewer
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {files == null ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading…</div>
        ) : files.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">No files on this day.</div>
        ) : (
          <div className={`grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] ${density === 'tight' ? 'gap-0' : 'gap-3'}`}>
            {files.map((f) => (
              <button
                key={f.id}
                onClick={() => openSearchViewer(f.file_path, f.filename)}
                className={`group relative aspect-square overflow-hidden bg-secondary/30 transition-all ${density === 'tight' ? '' : 'rounded-lg ring-1 ring-border hover:ring-primary/50'}`}
                title={`${f.filename} · ${formatHumanDate(f.derived_date)}`}
              >
                {thumbs[f.file_path] ? (
                  <img src={thumbs[f.file_path]} alt={f.filename} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
                    {f.file_type === 'video' ? <Film className="w-6 h-6" /> : <ImageIcon className="w-6 h-6" />}
                  </div>
                )}
                {f.file_type === 'video' && (
                  <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[9px] font-medium flex items-center gap-1">
                    <Film className="w-2.5 h-2.5" /> Video
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent px-2 pb-1.5 pt-6">
                  <div className="text-[11px] text-white/90 truncate">{f.filename}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
