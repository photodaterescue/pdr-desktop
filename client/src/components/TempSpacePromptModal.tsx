import { useEffect } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/custom-button';

interface TempSpacePromptModalProps {
  /** Bytes the pre-extract needs (zip × 1.2 + 1 GB headroom). */
  neededBytes: number;
  /** Library Drive the user previously picked, or null if none. */
  destinationPath: string | null;
  /** False if destinationPath is a UNC / mapped network drive — we
   *  refuse network destinations as pre-extract targets, and the
   *  body copy explains why so the user understands the choice. */
  destinationLocal: boolean;
  /** Bytes free on the destination drive (null if probe failed). */
  destinationFreeBytes: number | null;
  /** Bytes free on the system %TEMP% drive (null if probe failed). */
  tempFreeBytes: number | null;
  /** Absolute path of the zip about to be unpacked. */
  zipPath: string;
  /** User wants to choose a different drive for this extraction. */
  onPickTempDir: () => void;
  /** Backdrop / X / Cancel — abandon the analysis. */
  onCancel: () => void;
}

function fmtGB(bytes: number | null): string {
  if (bytes == null) return 'unknown';
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1000 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(1)} GB`;
}

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const segs = trimmed.split(/[\\/]/);
  return segs[segs.length - 1] || p;
}

/**
 * Smart-prompt for the NO_TEMP_SPACE case. Fires when neither the
 * Library Drive nor %TEMP% has enough room to unpack a >2 GB zip.
 * We show the actual numbers (needed vs available on each candidate)
 * so the user can see *why* their previous picks didn't qualify, and
 * offer a one-click route to picking a different drive — usually an
 * external SSD or a NAS staging area, but we let them choose.
 *
 * Backdrop / radius / shadow mirror ReportProblemModal so the surface
 * family stays consistent.
 */
export function TempSpacePromptModal({
  neededBytes,
  destinationPath,
  destinationLocal,
  destinationFreeBytes,
  tempFreeBytes,
  zipPath,
  onPickTempDir,
  onCancel,
}: TempSpacePromptModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const zipName = basename(zipPath);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-background rounded-xl shadow-2xl border border-border w-full max-w-xl"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-labelledby="temp-space-prompt-title"
      >
        <div className="border-b border-border px-5 py-4 relative">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            <h3 id="temp-space-prompt-title" className="text-base font-semibold text-foreground">
              Not enough space to unpack
            </h3>
          </div>
          <button
            onClick={onCancel}
            className="absolute right-3 top-3 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-sm text-foreground leading-relaxed">
            PDR needs about <strong className="text-foreground font-semibold">{fmtGB(neededBytes)}</strong> of free space to safely unpack <strong className="text-foreground font-semibold">{zipName}</strong>. Neither candidate drive has enough room.
          </p>

          <div className="space-y-2 text-sm">
            <div className="flex items-baseline justify-between p-3 rounded-lg bg-secondary/30 border border-border">
              <div className="min-w-0 mr-3">
                <div className="font-medium text-foreground">Library Drive</div>
                <div className="text-xs text-muted-foreground truncate">
                  {destinationPath
                    ? (destinationLocal ? destinationPath : `${destinationPath} (network — unsupported as temp)`)
                    : 'not set'}
                </div>
              </div>
              <span className="text-xs font-mono text-muted-foreground shrink-0">
                {destinationPath && destinationLocal ? `${fmtGB(destinationFreeBytes)} free` : '—'}
              </span>
            </div>
            <div className="flex items-baseline justify-between p-3 rounded-lg bg-secondary/30 border border-border">
              <div className="min-w-0 mr-3">
                <div className="font-medium text-foreground">System temp drive</div>
                <div className="text-xs text-muted-foreground truncate">%TEMP% (usually C:)</div>
              </div>
              <span className="text-xs font-mono text-muted-foreground shrink-0">
                {tempFreeBytes != null ? `${fmtGB(tempFreeBytes)} free` : '—'}
              </span>
            </div>
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed">
            Pick another local drive with enough room — usually an external SSD or a roomy data drive. PDR will only use it as a temporary staging area while it analyses the zip; nothing is left behind once the run finishes.
          </p>
        </div>

        <div className="border-t border-border px-5 py-3 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onPickTempDir}>
            Pick another drive
          </Button>
        </div>
      </div>
    </div>
  );
}
