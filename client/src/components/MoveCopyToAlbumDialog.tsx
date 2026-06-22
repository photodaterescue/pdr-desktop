/**
 * MoveCopyToAlbumDialog (v3.0, Terry 2026-06-22).
 *
 * ONE centered modal for both MOVE and COPY of selected photos between albums,
 * opened from the Albums Actions dropdown AND the per-photo right-click menu via a
 * single "Move/Copy to album…" line. Copy = add to the destination, keep them here.
 * Move = add to the destination + remove from the source album.
 *
 * It is a centred Dialog (NOT a popover anchored to a hidden off-screen element),
 * so it reliably appears wherever it was triggered from — the off-screen-anchor
 * popover this replaces did nothing when launched from the Actions dropdown.
 */
import { useEffect, useState } from 'react';
import { Search, Plus, Check, X, ImageIcon, Copy as CopyIcon, FolderInput, Sparkles, PencilLine } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** indexed_files.id list to move/copy. */
  fileIds: number[];
  /** The album the photos currently live in (the source for a MOVE). */
  sourceAlbumId: number | null;
  /** false → the source album is a read-only source (Takeout/iCloud) → MOVE disabled (Copy still fine). */
  sourceEditable: boolean;
  /** Fired after a successful move/copy (clear the selection). */
  onDone?: () => void;
}

export default function MoveCopyToAlbumDialog({ open, onOpenChange, fileIds, sourceAlbumId, sourceEditable, onDone }: Props) {
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) { setSearch(''); setCreating(false); setNewTitle(''); setBusy(false); setMode('copy'); return; }
    let cancelled = false;
    setLoading(true);
    listAlbums().then((r) => { if (!cancelled) { setAlbums(r.success && r.data ? r.data : []); setLoading(false); } });
    return () => { cancelled = true; };
  }, [open]);

  const isMove = mode === 'move';
  const total = fileIds.length;
  // Destinations: user-editable albums, excluding the source (can't move/copy into where they already are).
  const addressable = albums.filter((a) => isAlbumSourceUserEditable(a.source) && a.id !== sourceAlbumId);
  const filtered = search.trim() ? addressable.filter((a) => a.title.toLowerCase().includes(search.toLowerCase())) : addressable;

  // Core add (+ remove for move). Returns true on success. No busy-guard — callers own busy.
  async function doAction(destId: number, destTitle: string): Promise<boolean> {
    const addR = await addPhotosToAlbum(destId, fileIds);
    if (!addR.success) { toast.error(`Couldn't ${isMove ? 'move' : 'copy'} to "${destTitle}"`, { description: addR.error }); return false; }
    if (isMove && sourceAlbumId != null) {
      try { await removePhotosFromAlbum(sourceAlbumId, fileIds); } catch (_) { /* add succeeded → leaves a harmless copy */ }
    }
    if (isMove) {
      toast.success(total === 1 ? `Photo moved to "${destTitle}"` : `${total} photos moved to "${destTitle}"`);
    } else {
      const ins = addR.inserted ?? 0;
      if (ins === 0) toast.message(`Already in "${destTitle}"`, { description: total === 1 ? 'This photo is already in that album.' : `All ${total} photos are already there.` });
      else toast.success(ins === total ? (total === 1 ? `Photo copied to "${destTitle}"` : `${total} photos copied to "${destTitle}"`) : `${ins} of ${total} copied to "${destTitle}"`);
    }
    window.dispatchEvent(new CustomEvent('pdr:albumsRefresh'));
    return true;
  }

  async function pick(album: AlbumSummary) {
    if (busy) return;
    setBusy(true);
    const ok = await doAction(album.id, album.title);
    setBusy(false);
    if (ok) { onOpenChange(false); onDone?.(); }
  }

  async function createAndAct() {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    const cR = await createAlbum(title);
    if (!cR.success || !cR.id) { setBusy(false); toast.error("Couldn't create album", { description: cR.error }); return; }
    const ok = await doAction(cR.id, title);
    setBusy(false);
    if (ok) { onOpenChange(false); onDone?.(); }
  }

  const moveBtnClass = `px-3 py-1 text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${isMove ? 'bg-background shadow-sm font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[26rem] max-w-[26rem] p-0 overflow-hidden gap-0">
        <DialogHeader className="px-4 py-3 border-b border-border space-y-0">
          <DialogTitle className="text-sm font-medium text-foreground">
            Move or copy {total} photo{total === 1 ? '' : 's'}
          </DialogTitle>
          {/* Copy / Move toggle (Move disabled for read-only source albums) */}
          <div className="flex items-center gap-1 mt-2 p-0.5 bg-muted/60 rounded-md w-fit">
            <button
              type="button"
              onClick={() => setMode('copy')}
              className={`px-3 py-1 text-xs rounded transition-colors ${!isMove ? 'bg-background shadow-sm font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              data-testid="movecopy-mode-copy"
            >
              <CopyIcon className="w-3 h-3 inline mr-1 -mt-0.5" />Copy
            </button>
            {sourceEditable ? (
              <button type="button" onClick={() => setMode('move')} className={moveBtnClass} data-testid="movecopy-mode-move">
                <FolderInput className="w-3 h-3 inline mr-1 -mt-0.5" />Move
              </button>
            ) : (
              <IconTooltip content="Can't move out of a read-only source album (Google Photos / iCloud). Copy instead.">
                <button type="button" disabled className={moveBtnClass} data-testid="movecopy-mode-move">
                  <FolderInput className="w-3 h-3 inline mr-1 -mt-0.5" />Move
                </button>
              </IconTooltip>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
            {isMove ? 'Adds them to the album you pick and removes them from here.' : 'Adds them to the album you pick — they stay here too.'}
          </p>
          {albums.length > 0 && !creating && (
            <div className="relative mt-2">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation(); }}
                placeholder="Find an album"
                className="w-full pl-7 pr-2 py-1.5 rounded-md border border-border bg-background text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="movecopy-search"
              />
            </div>
          )}
        </DialogHeader>

        {creating ? (
          <div className="p-3 border-b border-border">
            <label className="block text-xs font-medium text-foreground mb-1.5">New album name</label>
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); createAndAct(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreating(false); }
              }}
              autoFocus
              placeholder="e.g. Summer 2024"
              className="w-full px-2.5 py-1.5 rounded-md border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              data-testid="movecopy-new-name"
            />
            <div className="flex justify-end gap-2 mt-2">
              <Button variant="secondary" size="sm" onClick={() => { setCreating(false); setNewTitle(''); }} disabled={busy} className="gap-1"><X className="w-3.5 h-3.5" />Cancel</Button>
              <Button variant="primary" size="sm" onClick={createAndAct} disabled={busy || !newTitle.trim()} className="gap-1"><Check className="w-3.5 h-3.5" />{isMove ? 'Create & move' : 'Create & copy'}</Button>
            </div>
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {loading ? (
              <p className="px-4 py-6 text-xs text-muted-foreground text-center">Loading albums…</p>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-6 text-xs text-muted-foreground text-center">{search ? `No albums match "${search}"` : 'No other albums yet — create one below.'}</p>
            ) : (
              <ul className="py-1" role="listbox">
                {filtered.map((album) => (
                  <li key={album.id}>
                    <button
                      type="button"
                      onClick={() => pick(album)}
                      disabled={busy}
                      className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      data-testid={`movecopy-row-${album.id}`}
                    >
                      <div className="w-8 h-8 rounded shrink-0 bg-muted flex items-center justify-center overflow-hidden"><ImageIcon className="w-4 h-4 text-muted-foreground/40" /></div>
                      <div className="flex-1 min-w-0">
                        <IconTooltip content={album.title}><p className="text-sm text-foreground truncate">{album.title}</p></IconTooltip>
                        <p className="text-xs text-muted-foreground">{album.photoCount} photo{album.photoCount === 1 ? '' : 's'}</p>
                      </div>
                      {album.source === 'takeout_imported'
                        ? <Sparkles className="w-3.5 h-3.5 text-violet-500 shrink-0" />
                        : <PencilLine className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!creating && (
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setCreating(true)}
              disabled={busy}
              className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              data-testid="movecopy-create-new"
            >
              <div className="w-8 h-8 rounded shrink-0 bg-primary/10 flex items-center justify-center"><Plus className="w-4 h-4 text-primary" /></div>
              <span className="text-sm font-medium text-foreground">{isMove ? 'Move to a new album…' : 'Copy to a new album…'}</span>
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
