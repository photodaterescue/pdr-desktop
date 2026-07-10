/**
 * FileInfoDialog (v3.0.1, Terry).
 *
 * Small centred modal that shows a photo/video's core file facts —
 * file size, dimensions (photos) or duration (videos), type, full path
 * (with a one-click copy), and the date. Opened from the "File info"
 * right-click item in Memories — Dates and Albums.
 *
 * DATA: every field here is already on the IndexedFile record that the
 * Memories (getMemoriesDayFiles → SELECT *) and Albums (listAlbumPhotos
 * → SELECT i.*) grid queries return, so there is NO extra IPC / fs.stat
 * on open — the dialog reads what the tile already holds. duration_seconds
 * is a lazily-probed column, so it may be null for a video that has never
 * been through a transcribe estimate; we simply omit the row when absent.
 *
 * Primitives: Dialog / DialogContent / DialogHeader / DialogTitle from
 * ui/dialog, Button (custom-button) for the copy affordance, IconTooltip
 * for the copy hint. Typography follows the muted-label / foreground-value
 * definition-list pattern used across PDR modals — no freehand sizes.
 */
import { useState, useEffect } from 'react';
import { Copy, Check, FolderOpen, Film, Image as ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/custom-button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { formatBytes, formatDuration, formatMbPerMin, ensureVideoDurations, type IndexedFile } from '@/lib/electron-bridge';

function formatFullDate(iso: string | null): string {
  if (!iso) return 'No date';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'No date';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// One row of the definition list. Label muted, value foreground; the
// value wraps/breaks for long paths so the modal never overflows.
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground w-24 shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-foreground min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

export default function FileInfoDialog({
  file,
  open,
  onOpenChange,
}: {
  file: IndexedFile | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  // v3.1 (Terry) — a video's duration is a lazily-probed column, so it's often null. When this card
  // opens on a video without a cached duration, probe it once (main caches it back). Used for both the
  // Duration row and the new "Storage rate" (MB/min) row.
  const [probedDur, setProbedDur] = useState<number | null>(null);
  useEffect(() => {
    setProbedDur(null);
    if (!open || !file || file.file_type !== 'video') return;
    if (typeof file.duration_seconds === 'number' && file.duration_seconds > 0) return;   // already cached
    let alive = true;
    ensureVideoDurations([file.file_path]).then((m) => {
      if (!alive) return;
      const d = m[file.file_path];
      if (typeof d === 'number' && d > 0) setProbedDur(d);
    }).catch(() => { /* leave the row omitted */ });
    return () => { alive = false; };
  }, [open, file]);

  if (!file) return null;

  const isVideo = file.file_type === 'video';
  const ext = (file.extension || '').replace(/^\./, '').toUpperCase();
  const typeLabel = ext
    ? `${ext}${isVideo ? ' video' : ' image'}`
    : (isVideo ? 'Video' : 'Image');
  const hasDims = file.width != null && file.height != null;
  const effDuration = (typeof file.duration_seconds === 'number' && file.duration_seconds > 0)
    ? file.duration_seconds : probedDur;
  const durationText = formatDuration(effDuration);
  const mbPerMin = formatMbPerMin(file.size_bytes, effDuration);   // v3.1 (Terry) — storage cost per minute

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.file_path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success('Path copied', { description: file.file_path });
    } catch {
      toast.error("Couldn't copy the path");
    }
  };

  const reveal = () => { (window as any).pdr?.revealInFolder?.(file.file_path); };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 min-w-0">
            {isVideo
              ? <Film className="w-4 h-4 shrink-0 text-muted-foreground" />
              : <ImageIcon className="w-4 h-4 shrink-0 text-muted-foreground" />}
            <span className="truncate">{file.filename}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="divide-y divide-border/60">
          <InfoRow label="File size">
            {file.size_bytes > 0 ? formatBytes(file.size_bytes) : 'Unknown'}
          </InfoRow>

          {/* Photos → dimensions (+ megapixels when known). Videos →
              duration when we have it, else fall through to dimensions
              (resolution) if that's all that's cached. */}
          {isVideo ? (
            <>
              {durationText && <InfoRow label="Duration">{durationText}</InfoRow>}
              {mbPerMin && <InfoRow label="Storage rate">{mbPerMin}</InfoRow>}
              {hasDims && (
                <InfoRow label="Resolution">
                  {file.width}&thinsp;×&thinsp;{file.height}
                </InfoRow>
              )}
            </>
          ) : (
            hasDims && (
              <InfoRow label="Dimensions">
                {file.width}&thinsp;×&thinsp;{file.height}
                {file.megapixels ? (
                  <span className="text-muted-foreground"> · {file.megapixels} MP</span>
                ) : null}
              </InfoRow>
            )
          )}

          <InfoRow label="Type">{typeLabel}</InfoRow>

          <InfoRow label="Date">{formatFullDate(file.derived_date)}</InfoRow>

          <InfoRow label="Location">
            <span className="font-mono text-xs leading-snug break-all">{file.file_path}</span>
            <div className="flex items-center gap-2 mt-2">
              <IconTooltip label="Copy the full path" side="bottom">
                <Button variant="secondary" size="sm" onClick={copyPath} className="gap-1.5">
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy path'}
                </Button>
              </IconTooltip>
              <IconTooltip label="Show this file in File Explorer" side="bottom">
                <Button variant="ghost" size="sm" onClick={reveal} className="gap-1.5">
                  <FolderOpen className="w-3.5 h-3.5" />
                  Show in Explorer
                </Button>
              </IconTooltip>
            </div>
          </InfoRow>
        </div>
      </DialogContent>
    </Dialog>
  );
}
