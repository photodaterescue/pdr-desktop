/**
 * AddToAlbumPopover (v2.0.8 step 4; converted to a centred Dialog in v3.0.1).
 *
 * v3.0.1 (Terry 2026-07-07) — this was a Popover anchored to a hidden element parked
 * at -left-[9999px], so Radix rendered its content ~9800px off the left edge of the
 * screen and it was NEVER visible from any of the four selection surfaces (S&D,
 * Memories Dates, Albums, Needs Dates) — "Create/Add to album did nothing". Rebuilt
 * as a CENTRED Dialog (mirrors MoveCopyToAlbumDialog), controlled purely by
 * open/onOpenChange, so its position never depends on an anchor. Because the parent
 * owns the open state, opening it from a right-click on an UNSELECTED tile works too
 * (no mount-timing race — the old openTrigger/ref mechanism blocked that path).
 *
 * Lists existing albums with a live filter, plus a "Create new album" inline path
 * that creates AND adds in one transaction so the user never has to do
 * "create → switch view → add".
 */

import { useEffect, useState } from 'react';
import { FolderPlus, Search, Plus, Check, X, ImageIcon, Sparkles, PencilLine, ArrowLeft, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/custom-button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import {
  listAlbums,
  createAlbum,
  addPhotosToAlbum,
  removePhotosFromAlbum,
  type AlbumSummary,
} from '../lib/electron-bridge';
import { isAlbumSourceUserEditable } from '../lib/albumSourceProfile';
import { useAlbumReturnSource, setAlbumReturnSource, setPendingAlbumOpen } from '@/lib/album-return-source';

interface AddToAlbumPopoverProps {
  /** Controlled open state — owned by the parent surface (v3.0.1). */
  open: boolean;
  /** Fired when the dialog requests open/close (backdrop, Esc, the X, or an internal action). */
  onOpenChange: (o: boolean) => void;
  /** When true, the dialog opens directly on the "Create new album" form instead of the list. */
  createMode?: boolean;
  /** Indexed_files.id list to add. */
  fileIds: number[];
  /** Optional callback fired after a successful add (any path). Use to clear the selection. */
  onAdded?: () => void;
  /** v3.0 (Terry 2026-06-22) — MOVE mode. When set to a source album id, a successful add to a
   *  DIFFERENT album also REMOVES the photos from this album → a MOVE (vs the default copy/add).
   *  The header + toasts switch to "Move" wording and the source album is hidden from the dest list. */
  moveFromAlbumId?: number | null;
}

export default function AddToAlbumPopover({ open, onOpenChange, createMode = false, fileIds, onAdded, moveFromAlbumId }: AddToAlbumPopoverProps) {
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newAlbumTitle, setNewAlbumTitle] = useState('');
  const [busy, setBusy] = useState(false);

  // Source-album context — non-null when the user reached this surface via the
  // empty-album CTA. Drives the "Add to <album>" hero at the top of the dialog.
  const albumReturnSource = useAlbumReturnSource();

  // Load albums when the dialog opens (and land on the create form when createMode).
  // Reset transient state on close. Re-fetches on each open so freshly-created albums
  // elsewhere in the app show up.
  useEffect(() => {
    if (!open) {
      setSearch('');
      setCreating(false);
      setNewAlbumTitle('');
      setBusy(false);
      return;
    }
    setCreating(!!createMode);
    let cancelled = false;
    setLoading(true);
    listAlbums().then((r) => {
      if (cancelled) return;
      setAlbums(r.success && r.data ? r.data : []);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // createMode is read at open-time; a fresh open re-applies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Filter to user-created albums only — source-imported albums (Takeout / iCloud /
  // OneDrive / etc.) are content-locked because they represent factual snapshots of
  // what came from the source.
  // v3.0 (Terry) — MOVE mode (moveFromAlbumId set): a pick adds to the dest AND removes from the source
  // album. Hide the source album from the destination list (can't move into where they already live).
  const isMove = typeof moveFromAlbumId === 'number';
  const addressable = albums.filter((a) => isAlbumSourceUserEditable(a.source) && (!isMove || a.id !== moveFromAlbumId));
  const filtered = search.trim()
    ? addressable.filter((a) => a.title.toLowerCase().includes(search.toLowerCase()))
    : addressable;

  const handleAddToExisting = async (album: AlbumSummary) => {
    if (busy) return;
    // v3.0 (Terry) — moving INTO the same album is a no-op; just close.
    if (isMove && album.id === moveFromAlbumId) { onOpenChange(false); return; }
    setBusy(true);
    const r = await addPhotosToAlbum(album.id, fileIds);
    if (!r.success) {
      setBusy(false);
      toast.error(`Couldn't ${isMove ? 'move' : 'add'} to "${album.title}"`, { description: r.error });
      return;
    }
    // v3.0 (Terry) — MOVE = also remove from the source album. The add already succeeded; if the remove
    // fails the photos are in both (a harmless copy), so it's best-effort and never blocks the toast.
    if (isMove) { try { await removePhotosFromAlbum(moveFromAlbumId as number, fileIds); } catch (_) { /* leaves a copy */ } }
    setBusy(false);
    const inserted = r.inserted ?? 0;
    const total = fileIds.length;
    if (isMove) {
      toast.success(total === 1 ? `Photo moved to "${album.title}"` : `${total} photos moved to "${album.title}"`);
    } else if (inserted === 0) {
      toast.message(
        `Already in "${album.title}"`,
        { description: total === 1 ? 'This photo is already in the album.' : `All ${total} photos are already in the album.` }
      );
    } else if (inserted === total) {
      toast.success(
        total === 1 ? `Photo added to "${album.title}"` : `${total} photos added to "${album.title}"`
      );
    } else {
      toast.success(
        `${inserted} of ${total} added to "${album.title}"`,
        { description: `${total - inserted} were already in the album.` }
      );
    }
    onOpenChange(false);
    // Refresh any mounted AlbumsView so counts + tiles update without a manual refresh click.
    window.dispatchEvent(new CustomEvent('pdr:albumsRefresh'));
    onAdded?.();
  };

  // Hero action — add to the source album (the one the user came from via the
  // empty-album CTA). `goBack=true` also routes back to that album in the Albums view.
  const handleAddToSourceAlbum = async (goBack: boolean) => {
    if (busy || !albumReturnSource) return;
    const captured = albumReturnSource;
    setBusy(true);
    onOpenChange(false);

    // Fire nav synchronously — no await between the click and the page changing.
    if (goBack) {
      setAlbumReturnSource(null);
      setPendingAlbumOpen(captured.albumId);
      window.dispatchEvent(new CustomEvent('pdr:openAlbumsAlbum', { detail: { id: captured.albumId } }));
    }

    // Now do the actual add. Result toasts as usual.
    const r = await addPhotosToAlbum(captured.albumId, fileIds);
    setBusy(false);
    if (!r.success) {
      toast.error(`Couldn't add to "${captured.title}"`, { description: r.error });
      return;
    }
    const inserted = r.inserted ?? 0;
    const total = fileIds.length;
    if (inserted === 0) {
      toast.message(
        `Already in "${captured.title}"`,
        { description: total === 1 ? 'This photo is already in the album.' : `All ${total} photos are already in the album.` }
      );
    } else {
      toast.success(
        inserted === total
          ? (total === 1 ? `Photo added to "${captured.title}"` : `${total} photos added to "${captured.title}"`)
          : `${inserted} of ${total} added to "${captured.title}"`
      );
    }
    // Refresh AlbumsView so the (possibly newly-mounted) view reflects the new count + tiles.
    window.dispatchEvent(new CustomEvent('pdr:albumsRefresh'));
    onAdded?.();
  };

  const handleCreateAndAdd = async () => {
    const title = newAlbumTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    const createR = await createAlbum(title);
    if (!createR.success || !createR.id) {
      setBusy(false);
      toast.error(`Couldn't create album`, { description: createR.error });
      return;
    }
    const addR = await addPhotosToAlbum(createR.id, fileIds);
    if (!addR.success) {
      setBusy(false);
      toast.error(`Album created but couldn't add photos`, { description: addR.error });
      return;
    }
    // v3.0 (Terry) — MOVE into the new album = also remove from the source album (best-effort).
    if (isMove) { try { await removePhotosFromAlbum(moveFromAlbumId as number, fileIds); } catch (_) { /* leaves a copy */ } }
    setBusy(false);
    const inserted = addR.inserted ?? 0;
    toast.success(
      isMove
        ? (inserted === 1 ? `Moved 1 photo to new "${title}"` : `Moved ${inserted} photos to new "${title}"`)
        : (inserted === 1 ? `Created "${title}" with 1 photo` : `Created "${title}" with ${inserted} photos`)
    );
    onOpenChange(false);
    window.dispatchEvent(new CustomEvent('pdr:albumsRefresh'));
    onAdded?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-0 overflow-hidden gap-0" data-testid="add-to-album-dialog">
        {/* a11y title (Radix requires one); the visible header below carries the same text. */}
        <DialogTitle className="sr-only">{isMove ? 'Move' : 'Add'} photos to an album</DialogTitle>
        {/* Header */}
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-medium text-foreground">
            {isMove ? 'Move' : 'Add'} {fileIds.length} photo{fileIds.length === 1 ? '' : 's'} to…
          </p>
          {albums.length > 0 && !creating && (
            <div className="relative mt-2">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  // Prevent Enter/Escape from bubbling to SearchPanel's global keydown
                  // handler (which opens the focused photo's viewer on Enter).
                  if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation();
                }}
                placeholder="Find an album"
                className="w-full pl-7 pr-2 py-1.5 rounded-md border border-border bg-background text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="input-add-to-album-search"
              />
            </div>
          )}
        </div>

        {/* Source-album hero — only shown when the user reached this surface via the
            empty-album CTA. */}
        {albumReturnSource && !creating && (
          <div className="px-4 py-3 border-b border-border" style={{ backgroundColor: '#fff8eb' }} data-testid="add-to-album-source-hero">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">
              Album that sent you here
            </p>
            <p className="text-sm font-semibold text-foreground truncate mb-2.5" title={albumReturnSource.title}>
              {albumReturnSource.title}
            </p>
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => handleAddToSourceAlbum(true)}
                disabled={busy}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm hover:brightness-105 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
                style={{ backgroundColor: 'var(--color-gold)' }}
                data-testid="add-to-source-and-back"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Add &amp; go back to album
              </button>
              <button
                type="button"
                onClick={() => handleAddToSourceAlbum(false)}
                disabled={busy}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-foreground border border-border bg-background hover:bg-muted/40 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                data-testid="add-to-source-and-stay"
              >
                <ArrowRight className="w-3.5 h-3.5" />
                Add &amp; keep picking more
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
              Or pick a different album below, or create a new one.
            </p>
          </div>
        )}
        {/* Body — either the album list OR the inline-create input. */}
        {creating ? (
          <div className="p-3 border-b border-border">
            <label className="block text-xs font-medium text-foreground mb-1.5">New album name</label>
            <input
              type="text"
              value={newAlbumTitle}
              onChange={(e) => setNewAlbumTitle(e.target.value)}
              onKeyDown={(e) => {
                // stopPropagation: SearchPanel has a global Enter handler that opens the
                // focused photo. Without this, Enter to confirm the name ALSO opens a photo.
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleCreateAndAdd(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreating(false); }
              }}
              autoFocus
              placeholder="e.g. Summer 2024"
              className="w-full px-2.5 py-1.5 rounded-md border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              data-testid="input-add-to-album-new-name"
            />
            <div className="flex justify-end gap-2 mt-2">
              <Button variant="secondary" size="sm" onClick={() => { setCreating(false); setNewAlbumTitle(''); }} disabled={busy} className="gap-1">
                <X className="w-3.5 h-3.5" />
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleCreateAndAdd} disabled={busy || !newAlbumTitle.trim()} className="gap-1">
                <Check className="w-3.5 h-3.5" />
                Create &amp; add
              </Button>
            </div>
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {loading ? (
              <p className="px-4 py-6 text-xs text-muted-foreground text-center">Loading albums…</p>
            ) : albums.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-2">
                  <FolderPlus className="w-5 h-5 text-primary" />
                </div>
                <p className="text-xs font-medium text-foreground mb-1">No albums yet</p>
                <p className="text-xs text-muted-foreground">Create one below to get started.</p>
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-6 text-xs text-muted-foreground text-center">No albums match "{search}"</p>
            ) : (
              <ul className="py-1" role="listbox">
                {filtered.map((album) => (
                  <li key={album.id}>
                    <button
                      type="button"
                      onClick={() => handleAddToExisting(album)}
                      disabled={busy}
                      className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      data-testid={`add-to-album-row-${album.id}`}
                    >
                      <div className="w-8 h-8 rounded shrink-0 bg-muted flex items-center justify-center overflow-hidden">
                        <ImageIcon className="w-4 h-4 text-muted-foreground/40" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <IconTooltip content={album.title}>
                          <p className="text-sm text-foreground truncate">{album.title}</p>
                        </IconTooltip>
                        <p className="text-xs text-muted-foreground">{album.photoCount} photo{album.photoCount === 1 ? '' : 's'}</p>
                      </div>
                      {/* Source icon — Sparkles violet for Takeout imports, PencilLine muted for user-created. */}
                      {album.source === 'takeout_imported' ? (
                        <Sparkles className="w-3.5 h-3.5 text-violet-500 shrink-0" />
                      ) : (
                        <PencilLine className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Footer — "Create new album" CTA. Hidden while the create form is showing. */}
        {!creating && (
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setCreating(true)}
              disabled={busy}
              className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              data-testid="button-add-to-album-create-new"
            >
              <div className="w-8 h-8 rounded shrink-0 bg-primary/10 flex items-center justify-center">
                <Plus className="w-4 h-4 text-primary" />
              </div>
              <span className="text-sm font-medium text-foreground">Create new album</span>
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
