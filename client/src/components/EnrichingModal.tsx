import { useEffect, useRef, useState } from 'react';
import { Sparkles, X, Minimize2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';

// EnrichingModal — v2.0.13. Applies the cached Takeout sidecar
// metadata to existing _RC / _MK files in the library. Strictly
// additive — never overrides user curation (see enrichment-engine.ts
// for the full rule).
//
// UX pattern (Terry 2026-05-26): "a modal like the Analyzing and
// Fixing with the option to continue working pill, and the return
// to it pill, so there will be the things like the progress bar and
// the estimated duration." We mirror the Analyzing modal's two-state
// behaviour:
//   - Open: a centered modal with progress bar, counts, elapsed time,
//     ETA, Minimize button, Cancel button.
//   - Minimized: drops to the workspace's pill row (the same one
//     Analyzing and Fixing use) showing "Enriching… 3,847 of 9,805".
//
// The pill is implemented as a separate component (EnrichingPill) that
// listens for the same lifecycle events this modal dispatches.
//
// Lifecycle events:
//   pdr:openEnrichingModal       — open (from LDM "Run Enrichment"
//                                  button or any future entry point).
//   pdr:enrichingMinimized       — modal hidden, pill visible.
//   pdr:enrichingRestored        — pill clicked, modal visible again.
//   pdr:enrichingComplete        — finished or cancelled; pill clears.

interface DryRun {
  totalCandidates: number;
  sidecarMatches: number;
  dateUpgrades: number;
  gpsAvailable: number;
  descriptionAvailable: number;
  peopleHintsAvailable: number;
}

interface Progress {
  inspected: number;
  upgraded: number;
  unchanged: number;
  skipped: number;
  total: number;
  currentFilename?: string;
}

interface RunSummary {
  inspected: number;
  upgraded: number;
  unchanged: number;
  skipped: number;
  exifDateWrites: number;
  exifGpsWrites: number;
  exifDescriptionWrites: number;
  faceHintsAdded: number;
  errors: number;
  elapsedMs: number;
  cancelled: boolean;
}

type Phase = 'idle' | 'dryRun' | 'confirm' | 'running' | 'minimized' | 'done';

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function formatEta(progress: Progress, startedAt: number): string {
  if (progress.inspected === 0) return '—';
  const elapsedMs = Date.now() - startedAt;
  const remaining = progress.total - progress.inspected;
  if (remaining <= 0) return 'finishing…';
  const msPerFile = elapsedMs / progress.inspected;
  const remainingMs = msPerFile * remaining;
  return formatElapsed(remainingMs) + ' left';
}

export function EnrichingModal() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [progress, setProgress] = useState<Progress>({ inspected: 0, upgraded: 0, unchanged: 0, skipped: 0, total: 0 });
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [startedAt, setStartedAt] = useState<number>(0);
  const [, setTick] = useState(0); // forces re-render so elapsed updates live
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Subscribe to the workspace event that opens this modal. Fired by
  // the LDM "Run Enrichment" button, the Takeout banner's optional
  // "Enrich after pre-scan" follow-up, etc.
  useEffect(() => {
    const handler = () => {
      // Restore from minimized → open. Or, if not yet running, start
      // a fresh dry-run probe.
      if (phase === 'minimized') {
        setPhase('running');
        window.dispatchEvent(new CustomEvent('pdr:enrichingRestored'));
        return;
      }
      if (phase === 'running') return; // already open
      void startDryRun();
    };
    window.addEventListener('pdr:openEnrichingModal', handler);
    return () => window.removeEventListener('pdr:openEnrichingModal', handler);
  }, [phase]);

  // Elapsed timer — only ticks while a run is in flight.
  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const startDryRun = async () => {
    setPhase('dryRun');
    try {
      const res = await (window as Window & {
        pdr?: { enrich?: { dryRun?: () => Promise<{ success: boolean; data?: DryRun; error?: string }> } };
      }).pdr?.enrich?.dryRun?.();
      if (res?.success && res.data) {
        setDryRun(res.data);
        setPhase('confirm');
      } else {
        toast.error('Enrichment unavailable', { description: res?.error ?? 'Failed to read sidecar cache.' });
        setPhase('idle');
      }
    } catch (e) {
      toast.error('Enrichment unavailable', { description: (e as Error).message });
      setPhase('idle');
    }
  };

  const startRun = async () => {
    setPhase('running');
    setProgress({ inspected: 0, upgraded: 0, unchanged: 0, skipped: 0, total: dryRun?.totalCandidates ?? 0 });
    setStartedAt(Date.now());

    const unsubscribe = (window as Window & {
      pdr?: { enrich?: { onProgress?: (cb: (p: Progress) => void) => () => void } };
    }).pdr?.enrich?.onProgress?.((p) => setProgress(p));
    unsubscribeRef.current = unsubscribe ?? null;

    try {
      const res = await (window as Window & {
        pdr?: { enrich?: { run?: () => Promise<{ success: boolean; data?: RunSummary; error?: string }> } };
      }).pdr?.enrich?.run?.();
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      if (res?.success && res.data) {
        setSummary(res.data);
        setPhase('done');
        window.dispatchEvent(new CustomEvent('pdr:enrichingComplete'));
        if (res.data.cancelled) {
          toast.info('Enrichment cancelled', {
            description: `${res.data.upgraded.toLocaleString()} files upgraded before cancel; everything already changed is saved.`,
          });
        } else {
          toast.success('Enrichment complete', {
            description: `${res.data.upgraded.toLocaleString()} files upgraded · ${res.data.unchanged.toLocaleString()} already current.`,
          });
        }
      } else {
        toast.error('Enrichment failed', { description: res?.error ?? 'See Help & Support.' });
        setPhase('idle');
        window.dispatchEvent(new CustomEvent('pdr:enrichingComplete'));
      }
    } catch (e) {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      toast.error('Enrichment failed', { description: (e as Error).message });
      setPhase('idle');
      window.dispatchEvent(new CustomEvent('pdr:enrichingComplete'));
    }
  };

  const handleMinimize = () => {
    if (phase !== 'running') return;
    setPhase('minimized');
    window.dispatchEvent(new CustomEvent('pdr:enrichingMinimized'));
  };

  const handleCancel = async () => {
    if (phase !== 'running') return;
    try {
      await (window as Window & { pdr?: { enrich?: { cancel?: () => Promise<{ success: boolean }> } } })
        .pdr?.enrich?.cancel?.();
    } catch (e) {
      console.warn('[Enriching] cancel failed:', e);
    }
  };

  const handleClose = () => {
    setPhase('idle');
    setDryRun(null);
    setSummary(null);
    setProgress({ inspected: 0, upgraded: 0, unchanged: 0, skipped: 0, total: 0 });
  };

  // Visible states only render the modal; idle and minimized render
  // nothing here (the pill handles minimized in a separate component).
  if (phase === 'idle' || phase === 'minimized') return null;

  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.inspected / progress.total) * 100)) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-[520px] mx-4 overflow-hidden">
        <header className="flex items-start justify-between p-6 pb-3 border-b border-border/40">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-h2 text-foreground">
                {phase === 'dryRun' && 'Checking what can be enriched…'}
                {phase === 'confirm' && 'Enrich library with Takeout metadata'}
                {phase === 'running' && 'Enriching your library…'}
                {phase === 'done' && (summary?.cancelled ? 'Enrichment stopped' : 'Enrichment complete')}
              </h2>
              <p className="text-body-muted">
                {phase === 'dryRun' && 'Reading the sidecar cache to see what improvements are available.'}
                {phase === 'confirm' && 'Only files whose date or metadata can be upgraded are touched. Your album curations, Trees and named people are left alone.'}
                {phase === 'running' && (progress.currentFilename ?? 'Reading file list…')}
                {phase === 'done' && (summary?.cancelled
                  ? 'Cancelled mid-run. Everything that was upgraded before you stopped is saved.'
                  : 'Your library now reflects the best metadata your Takeout exports contain.')}
              </p>
            </div>
          </div>
          {phase === 'running' && (
            <IconTooltip label="Minimize to pill — keep enriching in the background" side="left">
              <button
                onClick={handleMinimize}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Minimize"
                data-testid="enriching-minimize"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            </IconTooltip>
          )}
          {(phase === 'confirm' || phase === 'done') && (
            <IconTooltip label="Close" side="left">
              <button
                onClick={handleClose}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
                data-testid="enriching-close"
              >
                <X className="w-4 h-4" />
              </button>
            </IconTooltip>
          )}
        </header>

        <div className="p-6 pt-5 space-y-4">
          {phase === 'dryRun' && (
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-primary/60 animate-pulse" style={{ width: '40%' }} />
            </div>
          )}

          {phase === 'confirm' && dryRun && (
            <ul className="text-sm text-foreground space-y-2 leading-snug">
              <li>
                <strong className="font-medium">{dryRun.dateUpgrades.toLocaleString()}</strong>{' '}
                files have a precise Google Takeout date available — confidence will lift from
                <em className="text-muted-foreground"> _RC</em> /
                <em className="text-muted-foreground"> _MK</em> to
                <em className="text-foreground"> _CF</em>.
              </li>
              <li>
                <strong className="font-medium">{dryRun.gpsAvailable.toLocaleString()}</strong>{' '}
                files have GPS coordinates that will be written to EXIF.
              </li>
              <li>
                <strong className="font-medium">{dryRun.descriptionAvailable.toLocaleString()}</strong>{' '}
                files have captions Google captured — will be written to EXIF ImageDescription + XMP dc:description.
              </li>
              <li>
                <strong className="font-medium">{dryRun.peopleHintsAvailable.toLocaleString()}</strong>{' '}
                files have face-name hints — written to People Manager as <em className="text-muted-foreground">suggestions only</em>, never overrides a name you&apos;ve set.
              </li>
            </ul>
          )}

          {phase === 'running' && (
            <>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all duration-200" style={{ width: `${percent}%` }} />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  <strong className="text-foreground">{progress.inspected.toLocaleString()}</strong>{' '}
                  of {progress.total.toLocaleString()} ({percent}%)
                </span>
                <span>
                  <strong className="text-foreground">{progress.upgraded.toLocaleString()}</strong> upgraded
                </span>
                <span>{formatElapsed(Date.now() - startedAt)} · {formatEta(progress, startedAt)}</span>
              </div>
            </>
          )}

          {phase === 'done' && summary && (
            <ul className="text-sm text-foreground space-y-1.5 leading-snug">
              <li><strong className="font-medium">{summary.upgraded.toLocaleString()}</strong> files upgraded to _CF.</li>
              <li><strong className="font-medium">{summary.exifGpsWrites.toLocaleString()}</strong> GPS coordinates written.</li>
              <li><strong className="font-medium">{summary.exifDescriptionWrites.toLocaleString()}</strong> captions written.</li>
              <li><strong className="font-medium">{summary.faceHintsAdded.toLocaleString()}</strong> face-name hints added.</li>
              {summary.skipped > 0 && (
                <li className="text-muted-foreground">{summary.skipped.toLocaleString()} skipped (filename collisions or rename failures — see enrichment log).</li>
              )}
              {summary.errors > 0 && (
                <li className="text-muted-foreground">{summary.errors.toLocaleString()} errors (logged for support).</li>
              )}
              <li className="text-muted-foreground">Took {formatElapsed(summary.elapsedMs)}.</li>
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border/40 bg-muted/30">
          {phase === 'confirm' && (
            <>
              <Button variant="secondary" size="sm" onClick={handleClose} data-testid="enriching-cancel-confirm">
                Not now
              </Button>
              <Button variant="primary" size="sm" onClick={startRun} disabled={!dryRun || dryRun.dateUpgrades === 0} data-testid="enriching-run">
                <Sparkles className="w-4 h-4 mr-1.5" />
                {dryRun && dryRun.dateUpgrades > 0
                  ? `Enrich ${dryRun.dateUpgrades.toLocaleString()} file${dryRun.dateUpgrades === 1 ? '' : 's'}`
                  : 'Nothing to enrich'}
              </Button>
            </>
          )}
          {phase === 'running' && (
            <>
              <Button variant="secondary" size="sm" onClick={handleCancel} data-testid="enriching-cancel-run">
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleMinimize} data-testid="enriching-minimize-cta">
                Continue working
              </Button>
            </>
          )}
          {phase === 'done' && (
            <Button variant="primary" size="sm" onClick={handleClose} data-testid="enriching-done">
              Close
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
