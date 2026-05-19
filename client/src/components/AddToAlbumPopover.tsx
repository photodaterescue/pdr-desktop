/**
 * AddToAlbumPopover (v2.0.8 step 4).
 *
 * Drop-in popover for any selection-bar surface (S&D today; Memories By
 * Date and Memories Albums detail-view land once those surfaces gain
 * selection state). Lists existing albums with a live filter, plus a
 * "Create new album" inline path that creates AND adds in one
 * transaction so the user never has to do "create → switch view → add".
 *
 * Encapsulates its own trigger pill (matching the S&D selection bar's
 * existing chip pattern) and content, so call sites just render
 * `<AddToAlbumPopover fileIds={...} />`. The pill is freehand to
 * stay visually consistent with the surrounding PL pill — both lift to
 * the Button primitive together in step 7's PL discoverability pass.
 */

import { useEffect, useState } from 'react';
import { FolderPlus, Search, Plus, Check, X, ImageIcon, Sparkles, PencilLine, ArrowLeft, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/custom-button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import {
  listAlbums,
  createAlbum,
  addPhotosToAlbum,
  type AlbumSummary,
} from '../lib/electron-bridge';
import { isAlbumSourceUserEditable } from '../lib/albumSourceProfile';
import { useAlbumReturnSource, setAlbumReturnSource, setPendingAlbumOpen } from '@/lib/album-return-source';

interface AddToAlbumPopoverProps {
  /** Indexed_files.id list to add. Empty array disables the trigger. */
  fileIds: number[];
  /** Optional callback fired after a successful add (any path). Use to
   *  clear the selection or refresh dependent UI. */
  onAdded?: () => void;
  /** Override the disabled state from the outside (e.g. when a Fix is
   *  running and PDR globally blocks mutations). */
  disabled?: boolean;
  /** Optional tooltip-style label that callers can use to explain WHY
   *  the action is unavailable (mirrors the PL button's pattern). */
  disabledReason?: string;
}

export default function AddToAlbumPopover({ fileIds, onAdded, disabled = false, disabledReason }: AddToAlbumPopoverProps) {
  const [open, setOpen] = useState(false);
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newAlbumTitle, setNewAlbumTitle] = useState('');
  const [busy, setBusy] = useState(false);

  // Source-album context — non-null when the user reached this
  // surface via the empty-album CTA. Drives the "Add to <album>"
  // hero rendered at the top of the popover (v2.0.8 step 6 polish,
  // Terry 2026-05-19: "it should say… Add to <Empty Folder Name>
  // and go back to albums? Add and continue looking around? or
  // create a new album").
  const albumReturnSource = useAlbumReturnSource();

  // Refresh album list when popover opens. Cached for the lifetime of
  // the open state; closing + reopening re-fetches so freshly-created
  // albums elsewhere in the app show up.
  useEffect(() => {
    if (!open) {
      // Reset transient state when popover closes.
      setSearch('');
      setCreating(false);
      setNewAlbumTitle('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    listAlbums().then((r) => {
      if (cancelled) return;
      setAlbums(r.success && r.data ? r.data : []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open]);

  const triggerDisabled = disabled || fileIds.length === 0;

  // Filter to user-created albums only — source-imported albums
  // (Takeout / iCloud / OneDrive / etc.) are content-locked because
  // they represent factual snapshots of what came from the source.
  // Adding new photos to them would dilute the source identity, the
  // same way auto-source MEMBERSHIPS are immutable. Users who want
  // to extend a source album create a new PDR album beside it and
  // drop the source album link into the same folder — both visible
  // in one basket, each carrying its own source identity. (Terry
  // 2026-05-18.)
  const addressable = albums.filter((a) => isAlbumSourceUserEditable(a.source));
  const filtered = search.trim()
    ? addressable.filter((a) => a.title.toLowerCase().includes(search.toLowerCase()))
    : addressable;

  const handleAddToExisting = async (album: AlbumSummary) => {
    if (busy) return;
    setBusy(true);
    const r = await addPhotosToAlbum(album.id, fileIds);
    setBusy(false);
    if (!r.success) {
      toast.error(`Couldn't add to "${album.title}"`, { description: r.error });
      return;
    }
    const inserted = r.inserted ?? 0;
    const total = fileIds.length;
    if (inserted === 0) {
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
    setOpen(false);
    // Refresh any mounted AlbumsView so counts + tiles update
    // without a manual refresh click.
    window.dispatchEvent(new CustomEvent('pdr:albumsRefresh'));
    onAdded?.();
  };

  // Hero action — add to the source album (the one the user came
  // from via the empty-album CTA). `goBack=true` also routes the
  // user back to that album in the Albums view; `goBack=false`
  // adds silently and keeps them where they are so they can pick
  // more photos.
  //
  // OPTIMISTIC NAVIGATION (Terry 2026-05-19: "Add and go back to
  // album has a delay"). Dispatch the back-nav event BEFORE
  // awaiting the add IPC so the user gets immediate visual feedback.
  // The add IPC runs in parallel; once it completes we fire
  // `pdr:albumsRefresh` so AlbumsView reloads photo counts + tiles.
  const handleAddToSourceAlbum = async (goBack: boolean) => {
    if (busy || !albumReturnSource) return;
    const captured = albumReturnSource;
    setBusy(true);
    setOpen(false);

    // Fire nav synchronously — no await between user click and
    // the page changing.
    if (goBack) {
      setAlbumReturnSource(null);
      setPendingAlbumOpen(captured.albumId);
      window.dispatchEvent(new CustomEvent('pdr:openAlbumsAlbum', { detail: { id: captured.albumId } }));
    }
    // ELSE: "Add & keep picking" — leave the back-pill in place.
    // The user is still actively adding to this album, so the
    // hero CTA + the title-bar pill should both persist until
    // either they click the X to dismiss, switch to a non-S&D /
    // non-Memories app, or explicitly click "Add & go back".
    // Terry 2026-05-19: "the orange pill disappears and then the
    // custom add files to the album no longer appears. This isn't
    // the desired outcome, it should continue until I've finished
    // or closed the orange pill, or come out of S&D to go to the
    // workspace, or trees, etc."

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
    // Refresh AlbumsView so the (possibly newly-mounted) view
    // reflects the new photo count + tiles without a manual
    // refresh click.
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
    setBusy(false);
    if (!addR.success) {
      toast.error(`Album created but couldn't add photos`, { description: addR.error });
      return;
    }
    const inserted = addR.inserted ?? 0;
    toast.success(
      inserted === 1 ? `Created "${title}" with 1 photo` : `Created "${title}" with ${inserted} photos`
    );
    setOpen(false);
    window.dispatchEvent(new CustomEvent('pdr:albumsRefresh'));
    onAdded?.();
  };

  return (
    <Popover open={open} onOpenChange={(o) => { if (triggerDisabled && o) return; setOpen(o); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={triggerDisabled}
          title={triggerDisabled && disabledReason ? disabledReason : undefined}
          className="text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1 rounded-full flex items-center gap-1.5 transition-colors"
          data-testid="button-add-to-album"
        >
          <FolderPlus className="w-3 h-3" />
          Add to Album
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0 overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-medium text-foreground">
            Add {fileIds.length} photo{fileIds.length === 1 ? '' : 's'} to…
          </p>
          {albums.length > 0 && !creating && (
            <div className="relative mt-2">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  // Prevent Enter/Escape from bubbling to SearchPanel's
                  // global keydown handler (which opens the focused
                  // photo's viewer on Enter). See note on the create-
                  // album input below for the same fix.
                  if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation();
                }}
                placeholder="Find an album"
                className="w-full pl-7 pr-2 py-1.5 rounded-md border border-border bg-background text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="input-add-to-album-search"
              />
            </div>
          )}
        </div>

        {/* Source-album hero — only shown when the user reached this
            surface via the empty-album CTA. Two prominent actions
            (Add & go back / Add & stay) plus a quiet "or pick a
            different album below" hint. Gold-tinted card so it
            reads as the obvious thing to do, matching the gold
            back-pill in the title bar. */}
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
                style={{ backgroundColor: '#f8c15c' }}
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
                // stopPropagation: SearchPanel.tsx has a global Enter
                // handler at line 685 that opens the focused photo in
                // the viewer. Without this, pressing Enter to confirm
                // the new album name ALSO opens a photo behind the
                // popover. Same for Escape — keep both from leaking.
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
                      {/* Source icon — Sparkles violet for Takeout
                          imports, PencilLine muted for user-created.
                          Mirrors the AlbumsView grid card badges so
                          the same fact reads the same way across
                          surfaces. */}
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

        {/* Footer — "Create new album" CTA. Hidden while the create form is
            already showing (it becomes the form). */}
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
      </PopoverContent>
    </Popover>
  );
}
