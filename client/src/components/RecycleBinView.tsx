/**
 * RecycleBinView (v2.0.15 — Terry 2026-05-28).
 *
 * Third tab in the Memories surface. Lists every photo currently in the
 * PDR Recycle Bin (soft-deleted: `indexed_files.in_recycle_bin = 1`),
 * sorted by recycled-date descending. Two batch actions on the top bar:
 *   • Restore — flips the flag back to 0; photo reappears everywhere it
 *     used to live (every album it was in, the chronological timeline,
 *     every S&D result it would have matched). Reversible.
 *   • Empty / Permanent delete — sends the underlying file to the OS
 *     Trash (shell.trashItem) and removes the index row + dependent
 *     rows (album_files, face_detections, ai_tags). Confirmed before
 *     it runs because this is the only point in PDR that touches the
 *     real file system.
 *
 * Per-tile right-click menu offers the same two actions plus Show in
 * File Explorer. Selection styling matches MemoriesView (gold).
 */

import { useEffect, useMemo, useState } from 'react';
import { Trash2, RotateCcw, HardDrive, Check, Film, Image as ImageIcon, Inbox, ChevronLeft } from 'lucide-react';
import { toast } from 'sonner';
import {
  listRecycleBin,
  restoreFromRecycleBin,
  permanentDeleteFromRecycleBin,
  getThumbnail,
  onRecycleBinChanged,
  type RecycleBinEntry,
} from '../lib/electron-bridge';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { Button } from '@/components/ui/custom-button';
import { IconTooltip } from '@/components/ui/icon-tooltip';

function formatRecycledOn(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export default function RecycleBinView({ onBack, backLabel = 'Back' }: { onBack?: () => void; backLabel?: string } = {}) {
  const [entries, setEntries] = useState<RecycleBinEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [confirmEmptyOpen, setConfirmEmptyOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setLoading(true);
    const r = await listRecycleBin();
    if (r.success) {
      setEntries(r.data ?? []);
      // Drop any selections that no longer exist
      setSelected(prev => {
        const next = new Set<number>();
        const validIds = new Set((r.data ?? []).map(e => e.id));
        for (const id of prev) if (validIds.has(id)) next.add(id);
        return next;
      });
    } else {
      toast.error('Couldn’t load Recycle Bin', { description: r.error });
    }
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);

  // Refresh when main broadcasts a recycle change from anywhere else
  // (e.g. context-menu delete on another tile in the same view, or a
  // move happening on the Memories tab while this view is open).
  useEffect(() => {
    const off = onRecycleBinChanged(() => { void refresh(); });
    return () => off();
  }, []);

  // Lazy thumbnail load for currently-visible entries. Cheap pass: ask
  // for every thumb at mount; getThumbnail is async so this fans out
  // without blocking paint.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const e of entries) {
        if (cancelled) return;
        if (thumbs[e.file_path]) continue;
        try {
          const t = await getThumbnail(e.file_path, 240);
          if (cancelled) return;
          if (t?.success && t.dataUrl) setThumbs(prev => ({ ...prev, [e.file_path]: t.dataUrl }));
        } catch { /* best-effort */ }
      }
    })();
    return () => { cancelled = true; };
  }, [entries]); // eslint-disable-line react-hooks/exhaustive-deps

  const allSelected = entries.length > 0 && selected.size === entries.length;

  const toggleOne = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(entries.map(e => e.id)));
  const clearSelection = () => setSelected(new Set());

  const doRestore = async (ids: number[]) => {
    if (ids.length === 0) return;
    setBusy(true);
    const r = await restoreFromRecycleBin(ids);
    setBusy(false);
    if (r.success) {
      toast.success(ids.length === 1 ? 'Restored' : `Restored ${r.count ?? ids.length} item${ids.length === 1 ? '' : 's'}`);
      clearSelection();
      await refresh();
    } else {
      toast.error('Couldn’t restore', { description: r.error });
    }
  };

  const doPermanentDelete = async (ids: number[]) => {
    if (ids.length === 0) return;
    setBusy(true);
    const r = await permanentDeleteFromRecycleBin(ids);
    setBusy(false);
    if (r.success) {
      const removed = r.removed ?? ids.length;
      const failed = r.failed?.length ?? 0;
      if (failed > 0) {
        toast.warning(`Deleted ${removed}, ${failed} couldn’t be sent to Trash`);
      } else {
        toast.success(removed === 1 ? 'Permanently deleted' : `Permanently deleted ${removed} item${removed === 1 ? '' : 's'}`);
      }
      clearSelection();
      await refresh();
    } else {
      toast.error('Couldn’t permanently delete', { description: r.error });
    }
  };

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  return (
    <div className="flex flex-col h-full">
      {/* Header strip — back nav + count + batch actions */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-wrap">
        {/* v2.0.15 (Terry 2026-05-29) — Back button. Mirrors the
            "Back to timeline" affordance in MemoriesDayDrilldown so
            the two surfaces share one visual language for "leave
            this view and return to where I was." Label is passed in
            by workspace.tsx so it reads "Back to Memories" / "Back
            to Search & Discovery" / etc. based on the previous
            activeView. Information variant (blue) — same colour
            family used elsewhere in PDR for navigation breadcrumbs. */}
        {onBack && (
          <button
            onClick={onBack}
            data-pdr-variant="information"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors"
            style={{ backgroundColor: '#dbeafe', borderColor: '#3b82f6', color: '#1e3a8a', borderWidth: '1px', borderStyle: 'solid' }}
            data-testid="recycle-back"
          >
            <ChevronLeft className="w-4 h-4" /> {backLabel}
          </button>
        )}
        <div className="text-sm text-muted-foreground">
          {loading ? 'Loading…' :
            entries.length === 0 ? 'Recycle Bin is empty'
            : `${entries.length} item${entries.length === 1 ? '' : 's'}`}
        </div>
        {entries.length > 0 && (
          <>
            <span aria-hidden className="text-border select-none">|</span>
            <button
              type="button"
              onClick={() => (allSelected ? clearSelection() : selectAll())}
              className="text-xs font-medium text-foreground hover:text-primary transition-colors"
              data-testid="recycle-select-all"
            >
              {allSelected ? 'Clear selection' : `Select all (${entries.length})`}
            </button>
            {selected.size > 0 && (
              <>
                {/* Selection chip — gold per the v2.0.15 selection palette. */}
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[var(--color-gold)] bg-[var(--color-gold)] text-xs font-medium text-[#1f1a08]"
                  data-testid="recycle-selection-chip"
                >
                  {selected.size} selected
                </span>
                <IconTooltip label={`Restore ${selected.size} to their original locations`} side="bottom">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => doRestore(selectedIds)}
                    disabled={busy}
                    data-testid="recycle-restore-selected"
                  >
                    <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                    Restore
                  </Button>
                </IconTooltip>
                <IconTooltip label={`Send ${selected.size} to the OS Recycle Bin permanently`} side="bottom">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setConfirmEmptyOpen(true)}
                    disabled={busy}
                    data-testid="recycle-permanent-delete-selected"
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    Delete permanently
                  </Button>
                </IconTooltip>
              </>
            )}
            {selected.size === 0 && (
              <IconTooltip label="Send EVERY item in the bin to the OS Recycle Bin permanently" side="bottom">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmEmptyOpen(true)}
                  disabled={busy}
                  className="ml-auto"
                  data-testid="recycle-empty"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  Empty Recycle Bin
                </Button>
              </IconTooltip>
            )}
          </>
        )}
      </div>

      {/* Grid */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? null : entries.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3 px-6 text-center">
            <Inbox className="w-10 h-10 opacity-60" />
            <div className="text-sm">Nothing here yet. Deleted photos land here first — restore or permanently delete from this view.</div>
          </div>
        ) : (
          <div className="grid p-3 gap-2"
               style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
            {entries.map(e => {
              const isSelected = selected.has(e.id);
              return (
                <ContextMenu key={e.id}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={() => toggleOne(e.id)}
                      className={`relative aspect-square overflow-hidden rounded-lg border bg-card text-left transition-all group ${isSelected ? 'ring-2 ring-[var(--color-gold)] border-[var(--color-gold)]' : 'border-border hover:ring-2 hover:ring-primary/40'}`}
                      data-testid={`recycle-tile-${e.id}`}
                    >
                      {/* Selection check circle */}
                      <div
                        className={`absolute top-1.5 left-1.5 z-10 w-5 h-5 rounded-full border flex items-center justify-center transition-all ${
                          isSelected
                            ? 'bg-[var(--color-gold)] border-[var(--color-gold)] text-[#1f1a08] opacity-100'
                            : 'border-white/80 bg-black/40 text-transparent group-hover:border-white group-hover:bg-black/60 opacity-0 group-hover:opacity-100'
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3" />}
                      </div>
                      {thumbs[e.file_path] ? (
                        <img src={thumbs[e.file_path]} alt={e.filename} className="w-full h-full object-cover opacity-80" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground/70">
                          {e.file_type === 'video' ? <Film className="w-6 h-6" /> : <ImageIcon className="w-6 h-6" />}
                        </div>
                      )}
                      {/* Footer overlay — filename + recycled-on stamp */}
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2 pb-1.5 pt-6">
                        <div className="text-[11px] text-white/90 truncate">{e.filename}</div>
                        <div className="text-[10px] text-white/70 truncate">Deleted {formatRecycledOn(e.recycled_at)}</div>
                      </div>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      onSelect={() => { (window as any).pdr?.revealInFolder?.(e.file_path); }}
                      data-testid={`recycle-tile-reveal-${e.id}`}
                    >
                      <HardDrive className="w-3.5 h-3.5 mr-2" />
                      Show in File Explorer
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onSelect={() => {
                        const ids = selected.has(e.id) && selected.size > 1
                          ? Array.from(selected)
                          : [e.id];
                        void doRestore(ids);
                      }}
                      data-testid={`recycle-tile-restore-${e.id}`}
                    >
                      <RotateCcw className="w-3.5 h-3.5 mr-2" />
                      {selected.has(e.id) && selected.size > 1
                        ? `Restore ${selected.size} items`
                        : 'Restore'}
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => {
                        const ids = selected.has(e.id) && selected.size > 1
                          ? Array.from(selected)
                          : [e.id];
                        // Stage the IDs in the confirm modal via a single-shot
                        // selection swap — the modal always operates on
                        // whatever's selected when it opens.
                        if (ids.length > 1) {
                          setSelected(new Set(ids));
                        } else {
                          setSelected(new Set([e.id]));
                        }
                        setConfirmEmptyOpen(true);
                      }}
                      className="text-red-600 dark:text-red-400 focus:text-red-700 focus:bg-red-50 dark:focus:bg-red-950/30"
                      data-testid={`recycle-tile-perm-delete-${e.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-2" />
                      Delete permanently…
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        )}
      </div>

      {/* Confirm modal for permanent delete — gates the only step in
          PDR that physically deletes a file from the user's disk. */}
      {confirmEmptyOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setConfirmEmptyOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-background border border-border shadow-xl p-5"
            onClick={(ev) => ev.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-foreground mb-2">
              Permanently delete {selected.size > 0 ? selected.size : entries.length} item{(selected.size > 0 ? selected.size : entries.length) === 1 ? '' : 's'}?
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              The selected file{(selected.size > 0 ? selected.size : entries.length) === 1 ? '' : 's'} will be sent to your computer’s Recycle Bin. You can recover from there until you empty the OS Recycle Bin. PDR will remove the index entries and any album / face / tag links.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmEmptyOpen(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
                  const ids = selected.size > 0 ? Array.from(selected) : entries.map(e => e.id);
                  setConfirmEmptyOpen(false);
                  await doPermanentDelete(ids);
                }}
                disabled={busy}
                data-testid="recycle-confirm-perm-delete"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                Delete permanently
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
