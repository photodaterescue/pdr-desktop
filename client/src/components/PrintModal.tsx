import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Printer, FileText, Loader2, Square, Rows2, Grid2x2, LayoutGrid } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

type Layout = '1' | '2' | '4' | 'contact';
type Fit = 'fit' | 'fill';
type Paper = 'Letter' | 'A4' | '4x6' | '5x7' | '8x10';
type Orientation = 'portrait' | 'landscape';
type Color = 'color' | 'bw';

interface PrintModalProps {
  /** Absolute file paths to print. Non-null ⇒ open. */
  paths: string[] | null;
  onClose: () => void;
}

const PAPER_DIMS: Record<Paper, [number, number]> = {
  Letter: [8.5, 11], A4: [210, 297], '4x6': [4, 6], '5x7': [5, 7], '8x10': [8, 10],
};
const PAPER_OPTIONS: { key: Paper; label: string }[] = [
  { key: 'Letter', label: 'Letter' },
  { key: 'A4', label: 'A4' },
  { key: '4x6', label: '4×6 in — photo' },
  { key: '5x7', label: '5×7 in — photo' },
  { key: '8x10', label: '8×10 in — photo' },
];

const LAYOUTS: { key: Layout; label: string; icon: typeof Square }[] = [
  { key: '1', label: '1 / page', icon: Square },
  { key: '2', label: '2 / page', icon: Rows2 },
  { key: '4', label: '4 / page', icon: Grid2x2 },
  { key: 'contact', label: 'Contact', icon: LayoutGrid },
];

// v2.1 round 343 (Terry) — remember the print settings as the default (Terry: it defaulted to US
// "Letter"; should default to A4 outside the US + let me save my choice). Paper's FIRST-RUN default is
// locale-aware (Letter for the US / Canada / Mexico region, A4 for the rest of the world incl. the UK);
// after that the last-used settings persist in localStorage and pre-fill the dialog every time.
const PRINT_PREFS_KEY = 'pdr-print-settings';
function localeDefaultPaper(): Paper {
  try {
    const region = ((navigator.language || '').split('-')[1] || '').toUpperCase();
    if (['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'CR'].includes(region)) return 'Letter';
  } catch { /* fall through to A4 */ }
  return 'A4';
}
interface PrintPrefs { layout: Layout; fit: Fit; paper: Paper; orientation: Orientation; color: Color }
function loadPrintPrefs(): PrintPrefs {
  const d: PrintPrefs = { layout: '1', fit: 'fit', paper: localeDefaultPaper(), orientation: 'portrait', color: 'color' };
  try {
    const raw = localStorage.getItem(PRINT_PREFS_KEY);
    if (raw) return { ...d, ...(JSON.parse(raw) as Partial<PrintPrefs>) };
  } catch { /* use defaults */ }
  return d;
}

/** Small segmented control (module scope = stable identity, no remounts). */
function Segmented({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: { key: string; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-secondary/30 p-0.5 gap-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`px-2.5 h-7 rounded-md text-xs font-medium transition-colors ${
            value === o.key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * v2.1 round 280 (Terry) — Sharing Phase 3: Print + Print to PDF.
 *
 * Lays the selected photos out (1/2/4 per page or a contact sheet) at the chosen
 * paper + orientation + fit, with a live thumbnail preview of the first page.
 * "Print" opens the native OS dialog (every printer, local or network, plus
 * Microsoft Print to PDF); "Save as PDF" writes a PDF straight to disk. All
 * rendering happens in main (electron/print-manager.ts) — nothing leaves the PC.
 * Mirrors the PDR modal recipe (framer-motion overlay + Button primitive).
 */
export function PrintModal({ paths, onClose }: PrintModalProps) {
  const isOpen = !!paths && paths.length > 0;

  // v2.1 round 343 (Terry) — pre-fill from the saved defaults (locale-aware paper on first run).
  const [layout, setLayout] = useState<Layout>(() => loadPrintPrefs().layout);
  const [fit, setFit] = useState<Fit>(() => loadPrintPrefs().fit);
  const [paper, setPaper] = useState<Paper>(() => loadPrintPrefs().paper);
  const [orientation, setOrientation] = useState<Orientation>(() => loadPrintPrefs().orientation);
  const [color, setColor] = useState<Color>(() => loadPrintPrefs().color);
  const [busy, setBusy] = useState<null | 'print' | 'pdf'>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // Fetch a handful of thumbnails for the preview (covers any layout's 1st page).
  useEffect(() => {
    if (!isOpen || !paths) return;
    let cancelled = false;
    const want = paths.slice(0, 12);
    (async () => {
      const api = (window as any).pdr?.browser;
      if (!api?.thumbnail) return;
      for (const p of want) {
        if (cancelled) return;
        try {
          const r = await api.thumbnail(p, 400);
          if (!cancelled && r?.dataUrl) setThumbs((t) => (t[p] ? t : { ...t, [p]: r.dataUrl }));
        } catch { /* skip */ }
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, paths]);

  // v2.1 round 343 (Terry) — persist the settings so the current choices become the default next time
  // (a one-time pick of A4 then sticks; no separate "set default" button needed).
  useEffect(() => {
    try { localStorage.setItem(PRINT_PREFS_KEY, JSON.stringify({ layout, fit, paper, orientation, color })); } catch { /* ignore */ }
  }, [layout, fit, paper, orientation, color]);

  if (!isOpen || !paths) return null;

  const opts = { layout, fit, paper, orientation, color };
  const portrait = orientation === 'portrait';
  const [pw, ph] = PAPER_DIMS[paper];
  const aspect = portrait ? `${pw}/${ph}` : `${ph}/${pw}`;
  const perPage = layout === '1' ? 1 : layout === '2' ? 2 : layout === '4' ? 4 : 0;
  const pageCount = layout === 'contact'
    ? 1
    : Math.ceil(paths.length / Math.max(1, perPage));

  const doPrint = async () => {
    setBusy('print');
    try {
      const res = await (window as any).pdr?.print?.photos(paths, opts);
      if (res?.success) { onClose(); }
      else if (res?.cancelled) { /* user dismissed the print dialog */ }
      else { toast.error(res?.error || 'Could not print.'); }
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not print.');
    } finally {
      setBusy(null);
    }
  };

  const doSavePdf = async () => {
    setBusy('pdf');
    try {
      const res = await (window as any).pdr?.print?.savePdf(paths, opts);
      if (res?.success) { toast.success('PDF saved'); onClose(); }
      else if (res?.cancelled) { /* user dismissed the save dialog */ }
      else { toast.error(res?.error || 'Could not save the PDF.'); }
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not save the PDF.');
    } finally {
      setBusy(null);
    }
  };

  // Preview cells for the first page.
  const previewPaths = layout === 'contact' ? paths.slice(0, 12) : paths.slice(0, perPage);
  const gridStyle: React.CSSProperties =
    layout === '1' ? { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
    : layout === '2' ? (portrait ? { gridTemplateColumns: '1fr', gridTemplateRows: '1fr 1fr' } : { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr' })
    : layout === '4' ? { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' }
    : { gridTemplateColumns: 'repeat(4, 1fr)', gridAutoRows: 'minmax(0, 1fr)' };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: 'spring', duration: 0.5, bounce: 0.3 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-background rounded-2xl shadow-2xl max-w-2xl w-full border border-border overflow-hidden"
        >
          {/* Header */}
          <div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-transparent px-6 pt-6 pb-5">
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 bg-gradient-to-br from-primary/20 to-primary/5 rounded-xl flex items-center justify-center border border-primary/20 shadow-lg shadow-primary/10 flex-none">
                <Printer className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">Print photos</h2>
                <p className="text-muted-foreground text-[13px]">
                  {paths.length} {paths.length === 1 ? 'photo' : 'photos'} · {pageCount} {pageCount === 1 ? 'page' : 'pages'}
                </p>
              </div>
            </div>
          </div>

          {/* Body: preview + options */}
          <div className="px-6 pb-6 pt-4 grid sm:grid-cols-[220px_1fr] gap-6">
            {/* Preview */}
            <div className="flex sm:block justify-center">
              <div
                className="bg-white rounded-md shadow-md border border-border/60 overflow-hidden"
                style={{ aspectRatio: aspect, height: 280 }}
              >
                <div
                  className="w-full h-full grid gap-[3px] p-[6px]"
                  style={gridStyle}
                >
                  {previewPaths.map((p, i) => (
                    <div key={p + i} className="bg-secondary/40 overflow-hidden flex items-center justify-center rounded-[2px]">
                      {thumbs[p] ? (
                        <img
                          src={thumbs[p]}
                          alt=""
                          className="w-full h-full"
                          style={{
                            objectFit: fit === 'fill' || layout === 'contact' ? 'cover' : 'contain',
                            filter: color === 'bw' ? 'grayscale(1)' : undefined,
                          }}
                        />
                      ) : (
                        <Loader2 className="w-4 h-4 text-muted-foreground/50 animate-spin" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Options */}
            <div className="space-y-4">
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1.5">Layout</div>
                <div className="grid grid-cols-2 gap-2">
                  {LAYOUTS.map(({ key, label, icon: Icon }) => (
                    <button
                      key={key}
                      onClick={() => setLayout(key)}
                      className={`flex items-center gap-2 px-3 h-9 rounded-lg border text-sm font-medium transition-colors ${
                        layout === key
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:text-foreground hover:border-primary/40'
                      }`}
                    >
                      <Icon className="w-4 h-4" /> {label}
                    </button>
                  ))}
                </div>
              </div>

              {layout !== 'contact' && (
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Photo fit</span>
                  <Segmented
                    value={fit}
                    onChange={(v) => setFit(v as Fit)}
                    options={[{ key: 'fit', label: 'Fit' }, { key: 'fill', label: 'Fill' }]}
                  />
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted-foreground">Size</span>
                <select
                  value={paper}
                  onChange={(e) => setPaper(e.target.value as Paper)}
                  className="h-8 rounded-lg border border-border bg-secondary/30 px-2.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {PAPER_OPTIONS.map((o) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Color</span>
                <Segmented
                  value={color}
                  onChange={(v) => setColor(v as Color)}
                  options={[{ key: 'color', label: 'Color' }, { key: 'bw', label: 'B&W' }]}
                />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Orientation</span>
                <Segmented
                  value={orientation}
                  onChange={(v) => setOrientation(v as Orientation)}
                  options={[{ key: 'portrait', label: 'Portrait' }, { key: 'landscape', label: 'Landscape' }]}
                />
              </div>

              <div className="pt-1 space-y-2">
                <Button onClick={doPrint} disabled={busy !== null} className="w-full">
                  {busy === 'print' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Printer className="w-4 h-4 mr-2" />}
                  Print…
                </Button>
                <Button onClick={doSavePdf} disabled={busy !== null} variant="secondary" className="w-full">
                  {busy === 'pdf' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileText className="w-4 h-4 mr-2" />}
                  Save as PDF
                </Button>
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
