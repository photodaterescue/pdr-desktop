import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  Filter as FilterIcon,
  Undo2,
  Save,
  Users,
  MapPin,
  Sparkles,
  Type,
  FolderOpen,
  ArrowLeftRight,
  X,
  Search,
} from 'lucide-react';
import {
  searchFiles,
  getThumbnail,
  getDateSuggestions,
  applyDateCorrection,
  undoLastDateCorrection,
  type IndexedFile,
  type DateSuggestion,
} from '../lib/electron-bridge';
import { MainAliveBanner } from './MainAliveBanner';

type ConfidenceFilter = 'marked' | 'recovered' | 'confirmed' | 'corrected' | 'all';

const CONF_META: Record<string, { label: string; ring: string; badge: string; icon: any }> = {
  marked:    { label: 'Marked',    ring: 'ring-red-400',    badge: 'bg-red-500/15 text-red-600 dark:text-red-400',         icon: HelpCircle },
  recovered: { label: 'Recovered', ring: 'ring-amber-400',  badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',   icon: AlertTriangle },
  confirmed: { label: 'Confirmed', ring: 'ring-green-400',  badge: 'bg-green-500/15 text-green-600 dark:text-green-400',   icon: CheckCircle2 },
  corrected: { label: 'Corrected', ring: 'ring-primary/50', badge: 'bg-primary/15 text-primary',                            icon: CheckCircle2 },
};

const SOURCE_META: Record<string, { label: string; colour: string; icon: any; explain: string }> = {
  neighbour: { label: 'Neighbour',  colour: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',       icon: ArrowLeftRight, explain: 'Midpoint between Confirmed photos before and after in the same folder.' },
  sequence:  { label: 'Sequence',   colour: 'bg-purple-500/15 text-purple-600 dark:text-purple-400', icon: ArrowLeftRight, explain: 'Interpolated from the sequential numeric pattern in the filename.' },
  filename:  { label: 'Filename',   colour: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', icon: Type,        explain: 'Date/time pattern extracted directly from the filename.' },
  faces:     { label: 'Faces',      colour: 'bg-pink-500/15 text-pink-600 dark:text-pink-400',       icon: Users,          explain: 'Median date of Confirmed photos containing the same named people.' },
  gps:       { label: 'GPS',        colour: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',    icon: MapPin,         explain: 'Median date of Confirmed photos within ~1km of this location.' },
  folder:    { label: 'Folder',     colour: 'bg-muted text-muted-foreground',                         icon: FolderOpen,     explain: 'Median date of other Confirmed/Recovered photos in the same folder.' },
};

function pad2(n: number) { return String(n).padStart(2, '0'); }
function isoToDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function datetimeLocalToIso(local: string): string | null {
  if (!local) return null;
  const [datePart, timePart] = local.split('T');
  if (!datePart || !timePart) return null;
  const [yy, mo, dd] = datePart.split('-').map(Number);
  const [hh, mi] = timePart.split(':').map(Number);
  const d = new Date(yy, mo - 1, dd, hh, mi, 0);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}
function formatHumanDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function DateEditor() {
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>('marked');
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [bigPreview, setBigPreview] = useState<string | null>(null);

  const [suggestions, setSuggestions] = useState<DateSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  const [editorDate, setEditorDate] = useState('');
  const [writeExif, setWriteExif] = useState(true);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'err'; message: string } | null>(null);

  const filmstripRef = useRef<HTMLDivElement | null>(null);

  const selected = files[selectedIdx];

  // ─── Load files matching the confidence filter ────────────────────────────
  const loadFiles = async (keepSelectedId?: number) => {
    setLoadingFiles(true);
    setStatus(null);
    const query: any = {
      sortBy: 'derived_date',
      sortDir: 'desc',
      limit: 500,
      offset: 0,
    };
    if (confidenceFilter !== 'all') query.confidence = [confidenceFilter];
    const res = await searchFiles(query);
    const list = (res.success && res.data ? res.data.files : []) as IndexedFile[];
    setFiles(list);
    let idx = 0;
    if (keepSelectedId != null) {
      const found = list.findIndex((f) => f.id === keepSelectedId);
      if (found >= 0) idx = found;
    }
    setSelectedIdx(Math.min(idx, Math.max(0, list.length - 1)));
    setLoadingFiles(false);
  };

  useEffect(() => { loadFiles(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [confidenceFilter]);

  // ─── Thumbnails for the filmstrip ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const missing = files.filter((f) => !thumbs[f.file_path]);
      for (let i = 0; i < missing.length; i += 8) {
        if (cancelled) return;
        const batch = missing.slice(i, i + 8);
        const results = await Promise.allSettled(
          batch.map(async (f) => ({ path: f.file_path, r: await getThumbnail(f.file_path, 120) }))
        );
        if (cancelled) return;
        const add: Record<string, string> = {};
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.r.success && r.value.r.dataUrl) {
            add[r.value.path] = r.value.r.dataUrl;
          }
        }
        if (Object.keys(add).length > 0) setThumbs((p) => ({ ...p, ...add }));
      }
    })();
    return () => { cancelled = true; };
  }, [files]);

  // ─── Big preview for the currently-selected photo ─────────────────────────
  useEffect(() => {
    if (!selected) { setBigPreview(null); return; }
    let cancelled = false;
    (async () => {
      // Reuse any filmstrip thumb as an instant placeholder while the big one loads.
      setBigPreview(thumbs[selected.file_path] || null);
      const r = await getThumbnail(selected.file_path, 640);
      if (!cancelled && r.success && r.dataUrl) setBigPreview(r.dataUrl);
    })();
    return () => { cancelled = true; };
  }, [selected?.file_path]);

  // ─── Suggestions + seeded date for the currently-selected photo ──────────
  useEffect(() => {
    if (!selected) return;
    setEditorDate(isoToDatetimeLocal(selected.derived_date));
    setStatus(null);
    setSuggestionsLoading(true);
    setSuggestions([]);
    getDateSuggestions(selected.id).then((r) => {
      if (r.success && r.data) setSuggestions(r.data);
      setSuggestionsLoading(false);
    });
  }, [selected?.id]);

  // ─── Scroll active filmstrip item into view ───────────────────────────────
  useEffect(() => {
    const el = filmstripRef.current?.querySelector<HTMLDivElement>(`[data-idx="${selectedIdx}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [selectedIdx]);

  // ─── Keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { setSelectedIdx((i) => Math.max(0, i - 1)); e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { setSelectedIdx((i) => Math.min(files.length - 1, i + 1)); e.preventDefault(); }
      else if (e.key === 'Enter' && selected && editorDate && !applying) { applyNow(); e.preventDefault(); }
      else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { handleUndo(); e.preventDefault(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [files.length, selected?.id, editorDate, applying]);

  const applyNow = async () => {
    if (!selected) return;
    const iso = datetimeLocalToIso(editorDate);
    if (!iso) { setStatus({ tone: 'err', message: 'Pick a valid date/time first.' }); return; }
    setApplying(true);
    setStatus(null);
    try {
      const r = await applyDateCorrection({
        fileIds: [selected.id],
        date: iso,
        writeExif,
        renameFile: false, // Rename intentionally disabled here — main pipeline handles renames.
        reason: 'manual (date editor)',
      });
      if (r.success) {
        const rec = r.data?.applied[0];
        setStatus({ tone: 'ok', message: rec?.exifWritten ? 'Applied — EXIF and index updated.' : 'Applied — index updated.' });
        // Refresh list (this file may move out of the current filter) then
        // advance to the next un-corrected item.
        const nextId = files[selectedIdx + 1]?.id;
        await loadFiles(nextId);
      } else {
        setStatus({ tone: 'err', message: 'Failed: ' + (r.error || r.data?.errors[0]?.error || 'unknown') });
      }
    } finally {
      setApplying(false);
    }
  };

  const handleUndo = async () => {
    const r = await undoLastDateCorrection();
    if (r.success) {
      setStatus({ tone: 'ok', message: 'Undone.' });
      await loadFiles(selected?.id);
    } else {
      setStatus({ tone: 'err', message: 'Undo failed: ' + (r.error || 'nothing to undo') });
    }
  };

  const pickSuggestion = (s: DateSuggestion) => {
    setEditorDate(isoToDatetimeLocal(s.iso));
  };

  // ─── Header counts by tier (for the filter toolbar chips) ────────────────
  const counts = useMemo(() => ({ marked: 0, recovered: 0, confirmed: 0, corrected: 0 } as Record<string, number>), []);

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <MainAliveBanner />
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <header className="shrink-0 px-4 py-3 border-b border-border flex items-center gap-3">
        <Calendar className="w-5 h-5 text-primary" />
        <h1 className="text-base font-semibold">Date Editor</h1>
        <span className="text-xs text-muted-foreground">Review low-confidence dates and apply corrections backed by PDR's context engine.</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleUndo}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
            title="Undo the most recent correction (Ctrl+Z)"
          >
            <Undo2 className="w-3.5 h-3.5" />Undo last
          </button>
        </div>
      </header>

      {/* ─── Filter bar ───────────────────────────────────────────────────── */}
      <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-2 bg-secondary/20">
        <FilterIcon className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Show:</span>
        {(['marked', 'recovered', 'corrected', 'confirmed', 'all'] as ConfidenceFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setConfidenceFilter(f)}
            className={`px-3 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wide transition-all ${
              confidenceFilter === f
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
            }`}
          >
            {f === 'all' ? 'All' : CONF_META[f]?.label || f}
          </button>
        ))}
        <div className="ml-auto text-xs text-muted-foreground">
          {loadingFiles ? 'Loading…' : `${files.length} ${files.length === 1 ? 'photo' : 'photos'}`}
        </div>
      </div>

      {/* ─── Main 3-column layout ────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 grid grid-cols-[260px_1fr_360px] gap-0">
        {/* Left: filmstrip ─────────────────────────────────────────────── */}
        <aside ref={filmstripRef} className="border-r border-border overflow-y-auto bg-secondary/10">
          {files.length === 0 && !loadingFiles && (
            <div className="p-6 text-center text-muted-foreground text-xs italic">
              Nothing to review in this category.
            </div>
          )}
          <div className="p-2 space-y-1">
            {files.map((f, i) => {
              const meta = CONF_META[f.confidence] || CONF_META.marked;
              const Icon = meta.icon;
              const thumb = thumbs[f.file_path];
              return (
                <div
                  key={f.id}
                  data-idx={i}
                  onClick={() => setSelectedIdx(i)}
                  className={`group flex items-center gap-2 p-1.5 rounded-md cursor-pointer transition-all ${
                    i === selectedIdx
                      ? 'bg-primary/10 ring-1 ring-primary/50'
                      : 'hover:bg-secondary/40'
                  }`}
                >
                  <div className={`w-14 h-14 shrink-0 rounded-md overflow-hidden bg-black/40 ring-2 ring-offset-1 ring-offset-background ${meta.ring}`}>
                    {thumb ? (
                      <img src={thumb} className="w-full h-full object-cover" alt={f.filename} />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
                        <Icon className="w-5 h-5" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium text-foreground truncate">{f.filename}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{formatHumanDate(f.derived_date)}</div>
                    <div className={`mt-0.5 inline-block text-[9px] uppercase font-semibold px-1 py-px rounded ${meta.badge}`}>{meta.label}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* Middle: preview + metadata ─────────────────────────────────── */}
        <main className="overflow-y-auto">
          {selected ? (
            <div className="h-full flex flex-col">
              <div className="shrink-0 px-5 py-3 border-b border-border flex items-center gap-3">
                <button
                  onClick={() => setSelectedIdx((i) => Math.max(0, i - 1))}
                  disabled={selectedIdx === 0}
                  className="p-1.5 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-default"
                  title="Previous (←)"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs font-medium text-muted-foreground">
                  {selectedIdx + 1} of {files.length}
                </span>
                <button
                  onClick={() => setSelectedIdx((i) => Math.min(files.length - 1, i + 1))}
                  disabled={selectedIdx >= files.length - 1}
                  className="p-1.5 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-default"
                  title="Next (→)"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <div className="ml-2 min-w-0">
                  <div className="text-sm font-semibold text-foreground truncate">{selected.filename}</div>
                  <div className="text-[11px] text-muted-foreground truncate">{selected.file_path}</div>
                </div>
              </div>

              <div className="flex-1 min-h-0 flex items-start justify-center p-5">
                <div className="relative rounded-xl overflow-hidden bg-black/60 shadow-lg max-w-full max-h-full">
                  {bigPreview ? (
                    <img src={bigPreview} alt={selected.filename} className="max-w-full max-h-[62vh] object-contain block" />
                  ) : (
                    <div className="w-[480px] h-[320px] flex items-center justify-center text-muted-foreground/50">
                      <Search className="w-8 h-8 opacity-40" />
                    </div>
                  )}
                </div>
              </div>

              {/* Current-date summary */}
              <div className="shrink-0 px-5 pb-5">
                <div className="rounded-lg border border-border bg-secondary/20 px-4 py-3 flex items-center gap-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Current date</div>
                    <div className="text-lg font-mono font-semibold text-foreground mt-0.5">{formatHumanDate(selected.derived_date)}</div>
                  </div>
                  <div className="ml-auto text-right">
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Source</div>
                    <div className="text-xs text-foreground">{selected.date_source || '—'}</div>
                  </div>
                  <div className={`inline-flex items-center gap-1 text-[10px] uppercase font-bold px-2 py-1 rounded ${CONF_META[selected.confidence]?.badge || ''}`}>
                    {CONF_META[selected.confidence]?.label || selected.confidence}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
              {loadingFiles ? 'Loading…' : 'Pick a photo from the left to start.'}
            </div>
          )}
        </main>

        {/* Right: editor + suggestions ─────────────────────────────────── */}
        <aside className="border-l border-border overflow-y-auto bg-background">
          {selected ? (
            <div className="p-4 space-y-5">
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <h2 className="text-sm font-semibold">Suggestions</h2>
                  {suggestionsLoading && <span className="text-[10px] text-muted-foreground italic">Loading…</span>}
                </div>
                {!suggestionsLoading && suggestions.length === 0 && (
                  <p className="text-xs text-muted-foreground italic">
                    Not enough context to infer a date. Set one manually below.
                  </p>
                )}
                <div className="space-y-2">
                  {suggestions.map((s, idx) => {
                    const meta = SOURCE_META[s.source] || SOURCE_META.folder;
                    const Icon = meta.icon;
                    return (
                      <button
                        key={s.id}
                        onClick={() => pickSuggestion(s)}
                        className="w-full text-left rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors p-3 group"
                        title={meta.explain}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wide px-1.5 py-0.5 rounded ${meta.colour}`}>
                            <Icon className="w-3 h-3" />
                            {meta.label}
                          </span>
                          {idx === 0 && <span className="text-[10px] font-bold text-primary uppercase tracking-wide">Top pick</span>}
                          <span className="ml-auto text-[10px] text-muted-foreground">{Math.round(s.confidence * 100)}%</span>
                        </div>
                        <div className="text-sm font-mono font-semibold text-foreground">{s.label}</div>
                        <div className="text-[11px] text-muted-foreground mt-1 leading-snug">{s.reason}</div>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="flex items-center gap-2 mb-2">
                  <Calendar className="w-4 h-4 text-primary" />
                  <h2 className="text-sm font-semibold">Set date & time</h2>
                </div>
                <input
                  type="datetime-local"
                  value={editorDate}
                  onChange={(e) => setEditorDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm font-mono"
                />
                <label className="mt-3 flex items-center gap-2 cursor-pointer text-[12px]">
                  <input type="checkbox" checked={writeExif} onChange={(e) => setWriteExif(e.target.checked)} />
                  <span>Also write EXIF tags (DateTimeOriginal, CreateDate, ModifyDate)</span>
                </label>

                <button
                  onClick={applyNow}
                  disabled={applying || !editorDate}
                  className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-semibold shadow-sm hover:bg-primary/90 disabled:opacity-50 transition-all"
                >
                  <Save className="w-4 h-4" />
                  {applying ? 'Applying…' : 'Apply & next'}
                </button>

                {status && (
                  <div className={`mt-3 text-[11px] px-2 py-1.5 rounded flex items-start gap-1.5 ${
                    status.tone === 'ok'
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                      : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                  }`}>
                    {status.tone === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5 mt-px" /> : <X className="w-3.5 h-3.5 mt-px" />}
                    <span>{status.message}</span>
                  </div>
                )}

                <p className="mt-3 text-[10px] text-muted-foreground leading-relaxed">
                  Writes to the PDR index and, if enabled, to the file's EXIF tags.
                  Renaming is handled by the main date-processing pipeline — not here.
                  The photo is reclassified as <span className="font-semibold text-primary">Corrected</span>.
                </p>
              </section>
            </div>
          ) : (
            <div className="p-6 text-sm text-muted-foreground italic">Select a photo to edit its date.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
