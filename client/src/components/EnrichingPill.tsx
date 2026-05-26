import { useEffect, useState } from 'react';
import { Sparkles, ChevronUp } from 'lucide-react';

// EnrichingPill — v2.0.13. Minimized form of the EnrichingModal.
// Lives in the workspace's pill row alongside the existing
// Analyzing and Fixing pills, so a user who hits "Continue working"
// during an Enrichment run can still see progress without the modal
// blocking their workspace.
//
// State machine (driven entirely by window events, no props):
//   pdr:enrichingMinimized   → show pill, subscribe to progress
//   pdr:enrichingRestored    → hide pill (modal is open again)
//   pdr:enrichingComplete    → hide pill (run finished or cancelled)
//
// Clicking the pill dispatches pdr:openEnrichingModal which is the
// same event the LDM "Run Enrichment" button uses — the EnrichingModal
// component's listener restores the modal to its current run state
// rather than starting a fresh dry-run.

interface Progress {
  inspected: number;
  upgraded: number;
  unchanged: number;
  skipped: number;
  total: number;
  currentFilename?: string;
}

export function EnrichingPill() {
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState<Progress>({ inspected: 0, upgraded: 0, unchanged: 0, skipped: 0, total: 0 });
  const [startedAt, setStartedAt] = useState<number>(0);

  // Lifecycle wiring.
  useEffect(() => {
    const onMin = () => {
      setVisible(true);
      setStartedAt((s) => (s === 0 ? Date.now() : s));
    };
    const onRestore = () => setVisible(false);
    const onComplete = () => {
      setVisible(false);
      setStartedAt(0);
    };
    window.addEventListener('pdr:enrichingMinimized', onMin);
    window.addEventListener('pdr:enrichingRestored', onRestore);
    window.addEventListener('pdr:enrichingComplete', onComplete);
    return () => {
      window.removeEventListener('pdr:enrichingMinimized', onMin);
      window.removeEventListener('pdr:enrichingRestored', onRestore);
      window.removeEventListener('pdr:enrichingComplete', onComplete);
    };
  }, []);

  // Progress subscription — only active while pill is visible to
  // avoid leaking a listener when the modal owns the progress.
  useEffect(() => {
    if (!visible) return;
    const unsub = (window as Window & {
      pdr?: { enrich?: { onProgress?: (cb: (p: Progress) => void) => () => void } };
    }).pdr?.enrich?.onProgress?.((p) => setProgress(p));
    return () => { unsub?.(); };
  }, [visible]);

  if (!visible) return null;

  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.inspected / progress.total) * 100)) : 0;
  const elapsedSec = startedAt > 0 ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const elapsedLabel = elapsedSec < 60
    ? `${elapsedSec}s`
    : `${Math.floor(elapsedSec / 60)}m ${String(elapsedSec % 60).padStart(2, '0')}s`;

  return (
    <div
      // Opt out of the title bar's drag region so this pill is fully
      // clickable — matches the Analyzing / Fixing pills.
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/40 bg-gradient-to-r from-primary/15 to-primary/5 cursor-pointer hover:from-primary/20 hover:to-primary/10 transition-colors animate-in fade-in slide-in-from-top-2 duration-200"
      onClick={() => window.dispatchEvent(new CustomEvent('pdr:openEnrichingModal'))}
      data-testid="enriching-pill"
    >
      <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
      <span className="text-xs text-foreground">
        <span className="font-medium">Enriching</span>
        <span className="text-muted-foreground"> · {progress.inspected.toLocaleString()} of {progress.total.toLocaleString()} ({percent}%) · {elapsedLabel}</span>
      </span>
      <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
    </div>
  );
}
