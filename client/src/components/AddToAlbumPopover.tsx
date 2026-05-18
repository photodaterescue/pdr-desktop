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
import { FolderPlus, Search, Plus, Check, X, ImageIcon, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/custom-button';
import {
  listAlbums,
  createAlbum,
  addPhotosToAlbum,
  type AlbumSummary,
} from '../lib/electron-bridge';

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

  // Case-insensitive title filter. Cheap O(n) — album count is dozens-
  // to-hundreds in practice, not millions.
  const filtered = search.trim()
    ? albums.filter((a) => a.title.toLowerCase().includes(search.toLowerCase()))
    : albums;

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
                        <p className="text-sm text-foreground truncate" title={album.title}>{album.title}</p>
                        <p className="text-xs text-muted-foreground">{album.photoCount} photo{album.photoCount === 1 ? '' : 's'}</p>
                      </div>
                      {album.source === 'takeout_imported' && (
                        <Sparkles className="w-3.5 h-3.5 text-violet-500 shrink-0" />
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
