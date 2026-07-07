/**
 * AddToAlbumPopover (v2.0.8 step 4; centred Dialog since v3.0.1).
 *
 * v3.0.1 (Terry 2026-07-07):
 *  - Was a Popover anchored to a hidden -left-[9999px] element → Radix rendered it
 *    ~9800px off-screen; rebuilt as a centred controlled Dialog (open/onOpenChange),
 *    mirroring MoveCopyToAlbumDialog. Opening from a right-click on an UNSELECTED tile
 *    works too (parent owns the open state; no mount-timing race).
 *  - Rows now show the album's REAL cover (same image as Memories → Albums), not a blank
 *    placeholder.
 *  - "Already in" indicators: for one selected photo, a "✓ In here" tag; for several, a
 *    per-album count ("3 of 5 here" / "✓ All 5 here"). Adding just tops up the missing ones.
 *  - Creating a new album no longer hides the list — the name field appears WITH the
 *    existing albums still visible beneath it, for naming-convention reference.
 *
 * One entry point ("Add to / create album…") opens it in list mode; creating lives inside.
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
  getAlbumMembershipCounts,
  getThumbnail,
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
   *  DIFFERENT album also REMOVES the photos from this album → a MOVE (vs the default copy/add). */
  moveFromAlbumId?: number | null;
}

export default function AddToAlbumPopover({ open, onOpenChange, createMode = false, fileIds, onAdded, moveFromAlbumId }: AddToAlbumPopoverProps) {
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newAlbumTitle, setNewAlbumTitle] = useState('');
  const [busy, setBusy] = useState(false);
  // coverPath -> thumbnail data URL; albumId -> how many of fileIds are already in it.
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [membership, setMembership] = useState<Record<number, number>>({});

  const albumReturnSource = useAlbumReturnSource();

  // Load albums + membership when the dialog opens (land on the create form when createMode).
  // Reset transient state on close. Re-fetches each open so freshly-created albums show up.
  useEffect(() => {
    if (!open) {
      setSearch('');
      setCreating(false);
      setNewAlbumTitle('');
      setBusy(false);
      setMembership({});
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
    getAlbumMembershipCounts(fileIds).then((m) => { if (!cancelled) setMembership(m || {}); }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Load real cover thumbnails for the albums (same image Memories → Albums shows).
  useEffect(() => {
    let cancelled = false;
    albums.forEach((a) => {
      const cp = a.coverPath;
      if (!cp || thumbs[cp]) return;
      // Same bridge + size (200) Albums uses, so the cover cache is shared and covers appear instantly.
      getThumbnail(cp, 200).then((r) => {
        if (!cancelled && r && r.success && r.dataUrl) setThumbs((prev) => (prev[cp] ? prev : { ...prev, [cp]: r.dataUrl }));
      }).catch(() => {});
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albums]);

  const isMove = typeof moveFromAlbumId === 'number';
  const total = fileIds.length;
  const addressable = albums.filter((a) => isAlbumSourceUserEditable(a.source) && (!isMove || a.id !== moveFromAlbumId));
  const filtered = search.trim()
    ? addressable.filter((a) => a.title.toLowerCase().includes(search.toLowerCase()))
    : addressable;

  const handleAddToExisting = async (album: AlbumSummary) => {
    if (busy) return;
    if (isMove && album.id === moveFromAlbumId) { onOpenChange(false); return; }
    setBusy(true);
    const r = await addPhotosToAlbum(album.id, fileIds);
    if (!r.success) {
      setBusy(false);
      toast.error(`Couldn't ${isMove ? 'move' : 'add'} to "${album.title}"`, { description: r.error });
      return;
    }
    if (isMove) { try { await removePhotosFromAlbum(moveFromAlbumId as number, fileIds); } catch (_) { /* leaves a copy */ } }
    setBusy(false);
    const inserted = r.inserted ?? 0;
    if (isMove) {
      toast.success(total === 1 ? `Photo moved to "${album.title}"` : `${total} photos moved to "${album.title}"`);
    } else if (inserted === 0) {
      toast.message(`Already in "${album.title}"`, { description: total === 1 ? 'This photo is already in the album.' : `All ${total} photos are already in the album.` });
    } else if (inserted === total) {
      toast.success(total === 1 ? `Photo added to "${album.title}"` : `${total} photos added to "${album.title}"`);
    } else {
      toast.success(`${inserted} of ${total} added to "${album.title}"`, { description: `${total - inserted} were already in the album.` });
    }
    onOpenChange(false);
    window.dispatchEvent(new CustomEvent('pdr:albumsRefresh'));
    onAdded?.();
  };

  const handleAddToSourceAlbum = async (goBack: boolean) => {
    if (busy || !albumReturnSource) return;
    const captured = albumReturnSource;
    setBusy(true);
    onOpenChange(false);
    if (goBack) {
      setAlbumReturnSource(null);
      setPendingAlbumOpen(captured.albumId);
      window.dispatchEvent(new CustomEvent('pdr:openAlbumsAlbum', { detail: { id: captured.albumId } }));
    }
    const r = await addPhotosToAlbum(captured.albumId, fileIds);
    setBusy(false);
    if (!r.success) {
      toast.error(`Couldn't add to "${captured.title}"`, { description: r.error });
      return;
    }
    const inserted = r.inserted ?? 0;
    if (inserted === 0) {
      toast.message(`Already in "${captured.title}"`, { description: total === 1 ? 'This photo is already in the album.' : `All ${total} photos are already in the album.` });
    } else {
      toast.success(
        inserted === total
          ? (total === 1 ? `Photo added to "${captured.title}"` : `${total} photos added to "${captured.title}"`)
          : `${inserted} of ${total} added to "${captured.title}"`
      );
    }
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

  // "Already in this album" indicator for a row. null when none of the selection is in it.
  const renderMembership = (albumId: number) => {
    const inCount = membership[albumId] || 0;
    if (inCount <= 0) return null;
    const all = inCount >= total;
    const label = total === 1 ? 'In here' : (all ? `All ${total} here` : `${inCount} of ${total} here`);
    return (
      <span
        className={`shrink-0 text-[10px] font-medium flex items-center gap-0.5 ${all ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}
        title={all ? 'All selected photos are already in this album' : `${inCount} of ${total} selected are already in this album`}
      >
        {all && <Check className="w-3 h-3" />}
        {label}
      </span>
    );
  };

  // The inline "New album name" card — shown ABOVE the list (which stays visible) so the
  // user can match their naming conventions against the existing albums.
  const createCard = (
    <div className="p-3 border-b border-border bg-primary/[0.04]">
      <label className="block text-xs font-medium text-foreground mb-1.5">New album name</label>
      <input
        type="text"
        value={newAlbumTitle}
        onChange={(e) => setNewAlbumTitle(e.target.value)}
        onKeyDown={(e) => {
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
          <X className="w-3.5 h-3.5" /> Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={handleCreateAndAdd} disabled={busy || !newAlbumTitle.trim()} className="gap-1">
          <Check className="w-3.5 h-3.5" /> Create &amp; add
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-0 overflow-hidden gap-0" data-testid="add-to-album-dialog">
        <DialogTitle className="sr-only">{isMove ? 'Move' : 'Add'} photos to an album</DialogTitle>
        {/* Header — title + live album filter (stays available even while creating). */}
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-medium text-foreground">
            {isMove ? 'Move' : 'Add'} {total} photo{total === 1 ? '' : 's'} to…
          </p>
          {addressable.length > 0 && (
            <div className="relative mt-2">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation(); }}
                placeholder="Find an album"
                className="w-full pl-7 pr-2 py-1.5 rounded-md border border-border bg-background text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="input-add-to-album-search"
              />
            </div>
          )}
        </div>

        {/* Source-album hero — only when the user arrived via the empty-album CTA. */}
        {albumReturnSource && !creating && (
          <div className="px-4 py-3 border-b border-border" style={{ backgroundColor: '#fff8eb' }} data-testid="add-to-album-source-hero">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">Album that sent you here</p>
            <p className="text-sm font-semibold text-foreground truncate mb-2.5" title={albumReturnSource.title}>{albumReturnSource.title}</p>
            <div className="flex flex-col gap-1.5">
              <button type="button" onClick={() => handleAddToSourceAlbum(true)} disabled={busy}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm hover:brightness-105 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
                style={{ backgroundColor: 'var(--color-gold)' }} data-testid="add-to-source-and-back">
                <ArrowLeft className="w-3.5 h-3.5" /> Add &amp; go back to album
              </button>
              <button type="button" onClick={() => handleAddToSourceAlbum(false)} disabled={busy}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-foreground border border-border bg-background hover:bg-muted/40 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                data-testid="add-to-source-and-stay">
                <ArrowRight className="w-3.5 h-3.5" /> Add &amp; keep picking more
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">Or pick a different album below, or create a new one.</p>
          </div>
        )}

        {/* Create-new card sits ABOVE the list — the list stays visible for naming reference. */}
        {creating && createCard}

        {/* Album list — always visible (with real covers + "already in" indicators). */}
        <div className="max-h-72 overflow-y-auto">
          {loading ? (
            <p className="px-4 py-6 text-xs text-muted-foreground text-center">Loading albums…</p>
          ) : addressable.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-2">
                <FolderPlus className="w-5 h-5 text-primary" />
              </div>
              <p className="text-xs font-medium text-foreground mb-1">No albums yet</p>
              <p className="text-xs text-muted-foreground">{creating ? 'Name it above to create your first one.' : 'Create one below to get started.'}</p>
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
                    <div className="w-9 h-9 rounded shrink-0 bg-muted flex items-center justify-center overflow-hidden">
                      {album.coverPath && thumbs[album.coverPath] ? (
                        <img src={thumbs[album.coverPath]} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageIcon className="w-4 h-4 text-muted-foreground/40" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <IconTooltip content={album.title}>
                        <p className="text-sm text-foreground truncate">{album.title}</p>
                      </IconTooltip>
                      <p className="text-xs text-muted-foreground">{album.photoCount} photo{album.photoCount === 1 ? '' : 's'}</p>
                    </div>
                    {renderMembership(album.id)}
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

        {/* Footer — "Create new album" opens the inline card above (list stays visible). */}
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
