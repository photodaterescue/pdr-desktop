import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Copy } from 'lucide-react';
import { promptConfirm } from '@/components/trees/promptConfirm';
import { IconTooltip } from '@/components/ui/icon-tooltip';

/**
 * v2.1 round 35 (Terry 2026-06-08) — shared transcribe-videos hook.
 *
 * Lifted out of MemoriesView so the same Whisper-batch pipeline can
 * back the new right-click Transcribe item in AlbumsView and
 * SearchPanel. Single source of truth for the confirm modal, the
 * Sonner progress toast, the ref-guard against multi-fire, and the
 * IPC sequencing.
 *
 * Returns a callable + a boolean. Drop the callable into a
 * ContextMenuItem / button onSelect; use the boolean to disable the
 * caller's affordance while a batch is mid-flight (so e.g. the
 * toolbar button greys out, matching the behaviour MemoriesView
 * had before the extract).
 *
 * Implementation notes preserved from the original:
 * • useRef (not state) for the in-flight guard. State batches, so a
 *   second synchronous click would race past a setState-based guard.
 *   A ref flips synchronously and blocks the second entry.
 * • Modal copy is the full bordered key/value summary table per
 *   Terry's spec — labels in muted-foreground, values in
 *   tabular-nums foreground. No bold gymnastics.
 * • First-time download notice only renders when the model isn't
 *   cached yet (isTranscribeModelReady IPC).
 * • Single-file selection shows filename + copy-to-clipboard button.
 * • Dismiss button on the final toast uses Sonner's `cancel` slot
 *   (themed neutral grey), not `action` (themed primary CTA).
 */
export function useTranscribeVideos(): {
  transcribe: (filePaths: string[]) => Promise<void>;
  isBatchTranscribing: boolean;
} {
  const [isBatchTranscribing, setIsBatchTranscribing] = useState(false);
  const inFlightRef = useRef(false);

  const transcribe = async (filePaths: string[]) => {
    if (filePaths.length === 0 || isBatchTranscribing) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const pdrViewer = (window as any).pdr?.viewer;
    if (!pdrViewer?.transcribeVideo) {
      toast.error('Transcription unavailable', { description: 'Bridge missing — please relaunch PDR.' });
      inFlightRef.current = false;
      return;
    }

    // Pre-flight: model-ready + duration/eta estimate (parallel).
    let modelReady = true;
    let estimate: { totalDurationSec: number; etaSec: number; fileCount: number; alreadyDoneCount: number } | null = null;
    try {
      const [modelInfo, est] = await Promise.all([
        pdrViewer.isTranscribeModelReady?.() ?? Promise.resolve({ ready: true }),
        pdrViewer.estimateTranscribeBatch?.(filePaths) ?? Promise.resolve(null),
      ]);
      modelReady = !!(modelInfo && modelInfo.ready);
      estimate = est;
    } catch { /* fall through with safe defaults */ }

    const fmt = (sec: number): string => {
      if (sec <= 0) return '< 1s';
      if (sec < 60) return `${Math.round(sec)}s`;
      const minutes = Math.floor(sec / 60);
      const seconds = Math.round(sec % 60);
      if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
      }
      return seconds > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
    };

    const remaining = estimate ? Math.max(0, estimate.fileCount - estimate.alreadyDoneCount) : filePaths.length;

    const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
      <div className="flex items-baseline justify-between gap-4 py-1 border-b border-border/40 last:border-0">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-sm font-medium text-foreground tabular-nums">{value}</span>
      </div>
    );

    const summary = (
      <div className="rounded-lg border border-border bg-secondary/30 p-3">
        <Row label="Videos to transcribe" value={remaining} />
        {estimate && estimate.alreadyDoneCount > 0 && (
          <Row label="Already transcribed (skipped)" value={estimate.alreadyDoneCount} />
        )}
        <Row label="Total playing time" value={estimate ? fmt(estimate.totalDurationSec) : '—'} />
        <Row label="Estimated time to finish" value={estimate ? `~${fmt(estimate.etaSec)}` : '—'} />
      </div>
    );

    const downloadNotice = !modelReady ? (
      <div className="mb-3 text-sm text-muted-foreground">
        First time only: PDR will download a ~750 MB language model before this transcription can start.
      </div>
    ) : null;

    const singleFileBanner = filePaths.length === 1 ? (() => {
      const fp = filePaths[0];
      const filename = fp.split(/[/\\]/).pop() || fp;
      return (
        <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-secondary/30">
          <span className="text-xs text-muted-foreground shrink-0">File:</span>
          <span className="text-sm font-mono text-foreground truncate flex-1" title={filename}>{filename}</span>
          <IconTooltip label="Copy filename" side="top">
            <button
              type="button"
              onClick={() => {
                try {
                  navigator.clipboard.writeText(filename);
                  toast.success('Filename copied', { duration: 2000 });
                } catch { /* clipboard API restricted — non-fatal */ }
              }}
              className="shrink-0 p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
              data-testid="copy-transcribe-filename"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </IconTooltip>
        </div>
      );
    })() : null;

    const ok = await promptConfirm({
      eyebrow: 'TRANSCRIBE VIDEOS',
      title: `Transcribe ${filePaths.length} video${filePaths.length === 1 ? '' : 's'}?`,
      message: (
        <>
          {downloadNotice}
          {singleFileBanner}
          {summary}
        </>
      ),
      confirmLabel: 'Transcribe',
      cancelLabel: 'Cancel',
    });
    if (!ok) { inFlightRef.current = false; return; }

    setIsBatchTranscribing(true);
    let unsubProgress: (() => void) | null = null;
    let currentIdx = 0;
    let currentPct = 0;
    let currentPhaseShort = 'Starting';
    const failures: { filePath: string; error: string }[] = [];
    let alreadyTranscribed = 0;
    let freshlyTranscribed = 0;
    let noSpeech = 0;

    function shortPhase(raw: string): string {
      const cut = raw.indexOf(':');
      return (cut >= 0 ? raw.slice(0, cut) : raw).replace(/[…]/g, '').trim();
    }
    function buildTitle(): string {
      return `Transcribing ${currentIdx + 1} of ${filePaths.length} · ${currentPct}%`;
    }
    const toastId = toast.loading(buildTitle(), { description: shortPhase('Starting'), duration: Infinity });

    try {
      if (pdrViewer.onTranscribeProgress) {
        unsubProgress = pdrViewer.onTranscribeProgress((info: { phase: string; percent: number }) => {
          if (!info) return;
          currentPct = Math.max(0, Math.min(100, Math.round(info.percent)));
          currentPhaseShort = shortPhase(info.phase);
          toast.loading(buildTitle(), { id: toastId, description: currentPhaseShort, duration: Infinity });
        });
      }
      for (let i = 0; i < filePaths.length; i++) {
        currentIdx = i;
        currentPct = 0;
        currentPhaseShort = 'Starting';
        toast.loading(buildTitle(), { id: toastId, description: currentPhaseShort, duration: Infinity });
        try {
          const res = await pdrViewer.transcribeVideo({ filePath: filePaths[i] });
          if (res?.success) {
            if (res.existed) alreadyTranscribed++;
            else if ((res as any).noSpeech) noSpeech++;
            else freshlyTranscribed++;
          } else {
            failures.push({ filePath: filePaths[i], error: res?.error ?? 'Unknown error' });
          }
        } catch (err) {
          failures.push({ filePath: filePaths[i], error: (err as Error)?.message ?? String(err) });
        }
      }
      const parts: string[] = [];
      if (freshlyTranscribed > 0) parts.push(`${freshlyTranscribed} transcribed`);
      if (alreadyTranscribed > 0) parts.push(`${alreadyTranscribed} already done`);
      if (noSpeech > 0) parts.push(`${noSpeech} with no speech`);
      if (failures.length > 0) parts.push(`${failures.length} failed`);
      if (failures.length === 0) {
        toast.success(`Transcription complete`, {
          id: toastId,
          description: parts.join(' · ') || 'No changes',
          duration: Infinity,
          cancel: { label: 'Dismiss', onClick: () => toast.dismiss(toastId) },
        });
      } else {
        toast.warning(`Transcription finished with errors`, {
          id: toastId,
          description: `${parts.join(' · ')}. See PDR log for details.`,
          duration: Infinity,
          cancel: { label: 'Dismiss', onClick: () => toast.dismiss(toastId) },
        });
        console.warn('[transcribe] batch transcribe failures:', failures);
      }
    } finally {
      if (unsubProgress) { try { unsubProgress(); } catch { /* non-fatal */ } }
      setIsBatchTranscribing(false);
      inFlightRef.current = false;
    }
  };

  return { transcribe, isBatchTranscribing };
}
