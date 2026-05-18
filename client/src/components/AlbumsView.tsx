/**
 * AlbumsView (v2.0.8 step 3).
 *
 * The "Albums" branch of the Memories surface. Two states in one
 * component to keep the file footprint small:
 *
 *   • List view — grid of album cards (cover thumb + title + photo
 *     count + source badge), "Create new album" CTA at the top, and an
 *     empty state with the Takeout-import teaser line when no albums
 *     exist yet.
 *
 *   • Detail view — clicking a card. Shows the album's photos sorted by
 *     taken-date (the v2.0.8 design's question-1 resolution), with a
 *     header that carries the title + Rename / Delete actions and a
 *     back link to the list.
 *
 * Add-photos and Remove-from-album are deferred to step 4 (the "Add to
 * Album" popover surfaces in Memories By Date and S&D, which is the
 * natural place to pick photos). Export-as-PL is deferred to step 6.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { FolderPlus, ChevronLeft, Trash2, Pencil, Sparkles, Image as ImageIcon, Plus, Check, X, PencilLine } from 'lucide-react';
import { Button } from '@/components/ui/custom-button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import {
  listAlbums,
  createAlbum,
  renameAlbum,
  deleteAlbum,
  listAlbumPhotos,
  getThumbnail,
  openSearchViewer,
  type AlbumSummary,
  type IndexedFile,
} from '../lib/electron-bridge';
import { promptConfirm } from './trees/promptConfirm';

export default function AlbumsView() {
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAlbumId, setSelectedAlbumId] = useState<number | null>(null);
  const [albumPhotos, setAlbumPhotos] = useState<IndexedFile[]>([]);
  const [albumPhotosLoading, setAlbumPhotosLoading] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // Inline-edit state for create + rename. Kept simple — no portal
  // modal, just a text input revealed in-context with Save / Cancel.
  const [creating, setCreating] = useState(false);
  const [newAlbumTitle, setNewAlbumTitle] = useState('');
  const [renamingAlbumId, setRenamingAlbumId] = useState<number | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const refreshAlbums = useCallback(async () => {
    setLoading(true);
    const r = await listAlbums();
    setAlbums(r.success && r.data ? r.data : []);
    setLoading(false);
  }, []);

  useEffect(() => { refreshAlbums(); }, [refreshAlbums]);

  // Load thumbnails for album covers (list view) and album photos
  // (detail view). Mirrors MemoriesView's sliding-window pool so the
  // grid fills progressively rather than waiting for full batches.
  useEffect(() => {
    let cancelled = false;
    const paths = new Set<string>();
    if (selectedAlbumId === null) {
      for (const a of albums) if (a.coverPath) paths.add(a.coverPath);
    } else {
      for (const p of albumPhotos) paths.add(p.file_path);
    }
    const toLoad = Array.from(paths).filter((p) => !thumbs[p]);
    if (toLoad.length === 0) return;
    const CONCURRENCY = 12;
    let cursor = 0;
    const worker = async () => {
      while (!cancelled && cursor < toLoad.length) {
        const i = cursor++;
        const p = toLoad[i];
        try {
          const r = await getThumbnail(p, 200);
          if (cancelled) return;
          if (r.success && r.dataUrl) {
            setThumbs((prev) => prev[p] ? prev : { ...prev, [p]: r.dataUrl });
          }
        } catch { /* per-thumb failure is non-fatal */ }
      }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    void Promise.allSettled(workers);
    return () => { cancelled = true; };
  }, [albums, albumPhotos, selectedAlbumId]);

  // Load photos when entering an album.
  useEffect(() => {
    if (selectedAlbumId === null) {
      setAlbumPhotos([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setAlbumPhotosLoading(true);
      const r = await listAlbumPhotos(selectedAlbumId);
      if (cancelled) return;
      setAlbumPhotos(r.success && r.data ? r.data : []);
      setAlbumPhotosLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selectedAlbumId]);

  const selectedAlbum = selectedAlbumId !== null
    ? albums.find((a) => a.id === selectedAlbumId) ?? null
    : null;

  // ── Actions ──────────────────────────────────────────────────────

  const handleCreate = async () => {
    const title = newAlbumTitle.trim();
    if (!title) return;
    const r = await createAlbum(title);
    if (r.success) {
      setNewAlbumTitle('');
      setCreating(false);
      await refreshAlbums();
    }
  };

  const handleRename = async () => {
    if (renamingAlbumId === null) return;
    const title = renameTitle.trim();
    if (!title) return;
    const r = await renameAlbum(renamingAlbumId, title);
    if (r.success) {
      setRenamingAlbumId(null);
      setRenameTitle('');
      await refreshAlbums();
    }
  };

  const handleDelete = async (albumId: number, albumTitle: string) => {
    const ok = await promptConfirm({
      title: 'Delete album?',
      message: `Remove "${albumTitle}" from your library. The photos themselves stay where they are — only the album grouping is removed.`,
      confirmLabel: 'Delete album',
      cancelLabel: 'Keep it',
    });
    if (!ok) return;
    const r = await deleteAlbum(albumId);
    if (r.success) {
      if (selectedAlbumId === albumId) setSelectedAlbumId(null);
      await refreshAlbums();
    }
  };

  const handleOpenPhoto = async (idx: number) => {
    const paths = albumPhotos.map((p) => p.file_path);
    const names = albumPhotos.map((p) => p.filename);
    await openSearchViewer(paths, names, idx);
  };

  // ── Render: detail view ──────────────────────────────────────────

  if (selectedAlbum) {
    return (
      <div className="flex flex-col h-full">
        {/* Detail header — back link + title (or rename input) + actions */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <Button variant="secondary" size="sm" onClick={() => setSelectedAlbumId(null)} className="gap-1.5 shrink-0">
              <ChevronLeft className="w-4 h-4" />
              Albums
            </Button>
            {renamingAlbumId === selectedAlbum.id ? (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <input
                  ref={renameInputRef}
                  value={renameTitle}
                  onChange={(e) => setRenameTitle(e.target.value)}
                  onKeyDown={(e) => {
                    // Stop Enter/Escape from leaking to any parent
                    // keyboard handler (S&D's global Enter-opens-viewer
                    // handler is the known offender; defensive against
                    // any other surface this view ever embeds in).
                    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleRename(); }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenamingAlbumId(null); setRenameTitle(''); }
                  }}
                  autoFocus
                  className="px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-base font-medium flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-primary"
                  data-testid="input-album-rename"
                />
                <Button variant="primary" size="sm" onClick={handleRename} className="gap-1.5 shrink-0">
                  <Check className="w-4 h-4" />
                  Save
                </Button>
                <Button variant="secondary" size="sm" onClick={() => { setRenamingAlbumId(null); setRenameTitle(''); }} className="gap-1.5 shrink-0">
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <>
                <h2 className="text-lg font-medium text-foreground truncate">{selectedAlbum.title}</h2>
                {selectedAlbum.source === 'takeout_imported' && (
                  <span className="text-xs text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full shrink-0">From Google Takeout</span>
                )}
              </>
            )}
          </div>
          {renamingAlbumId !== selectedAlbum.id && (
            <div className="flex items-center gap-2 shrink-0">
              <IconTooltip content="Rename album">
                <Button variant="secondary" size="sm" onClick={() => { setRenamingAlbumId(selectedAlbum.id); setRenameTitle(selectedAlbum.title); }} className="gap-1.5">
                  <Pencil className="w-4 h-4" />
                  Rename
                </Button>
              </IconTooltip>
              <IconTooltip content="Delete album (photos stay)">
                <Button variant="caution" size="sm" onClick={() => handleDelete(selectedAlbum.id, selectedAlbum.title)} className="gap-1.5">
                  <Trash2 className="w-4 h-4" />
                  Delete
                </Button>
              </IconTooltip>
            </div>
          )}
        </div>

        {/* Photo grid */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {albumPhotosLoading ? (
            <p className="text-sm text-muted-foreground">Loading photos…</p>
          ) : albumPhotos.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-16">
              <ImageIcon className="w-10 h-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-foreground font-medium mb-1">This album is empty</p>
              <p className="text-xs text-muted-foreground max-w-sm">Add photos from Memories By Date or Search &amp; Discovery — coming in the next update.</p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
              {albumPhotos.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleOpenPhoto(i)}
                  className="aspect-square overflow-hidden rounded-lg border border-border hover:ring-2 hover:ring-primary/40 transition-all"
                  data-testid={`album-photo-${p.id}`}
                >
                  {thumbs[p.file_path] ? (
                    <img src={thumbs[p.file_path]} alt={p.filename} className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full bg-muted animate-pulse" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Render: list view ────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar — title + create CTA */}
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-border">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-medium text-foreground">Albums</h2>
          {!loading && albums.length > 0 && (
            <span className="text-xs text-muted-foreground">{albums.length} album{albums.length === 1 ? '' : 's'}</span>
          )}
        </div>
        {creating ? (
          <div className="flex items-center gap-2">
            <input
              value={newAlbumTitle}
              onChange={(e) => setNewAlbumTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleCreate(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreating(false); setNewAlbumTitle(''); }
              }}
              placeholder="Album name"
              autoFocus
              className="px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm w-64 focus:outline-none focus:ring-2 focus:ring-primary"
              data-testid="input-new-album-title"
            />
            <Button variant="primary" size="sm" onClick={handleCreate} disabled={!newAlbumTitle.trim()} className="gap-1.5">
              <Check className="w-4 h-4" />
              Create
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { setCreating(false); setNewAlbumTitle(''); }} className="gap-1.5">
              <X className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)} className="gap-1.5" data-testid="button-create-album">
            <FolderPlus className="w-4 h-4" />
            New album
          </Button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading albums…</p>
        ) : albums.length === 0 ? (
          /* Empty state — explainer card with Takeout teaser */
          <div className="flex flex-col items-center justify-center text-center py-16 max-w-lg mx-auto">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <FolderPlus className="w-6 h-6 text-primary" />
            </div>
            <h3 className="text-base font-medium text-foreground mb-2">No albums yet</h3>
            <p className="text-sm text-muted-foreground mb-5">
              Albums let you group photos by occasion, person, place — anything you like. They're virtual, so the underlying files stay exactly where they are.
            </p>
            <Button variant="primary" size="sm" onClick={() => setCreating(true)} className="gap-1.5 mb-6">
              <Plus className="w-4 h-4" />
              Create your first album
            </Button>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-violet-50/40 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800/40 text-left">
              <Sparkles className="w-4 h-4 text-violet-500 mt-0.5 shrink-0" />
              <p className="text-xs text-violet-700 dark:text-violet-300">
                <strong>Already used Google Photos?</strong> Your Google Photos albums will automatically appear here after you Fix a Takeout — or pull them in from an existing Takeout ZIP via <strong>Settings → After Fix</strong>.
              </p>
            </div>
          </div>
        ) : (
          /* Album grid */
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {albums.map((album) => (
              <button
                key={album.id}
                type="button"
                onClick={() => setSelectedAlbumId(album.id)}
                className="flex flex-col rounded-lg border border-border bg-card overflow-hidden text-left hover:ring-2 hover:ring-primary/40 transition-all"
                data-testid={`album-card-${album.id}`}
              >
                <div className="aspect-square bg-muted relative">
                  {album.coverPath && thumbs[album.coverPath] ? (
                    <img src={thumbs[album.coverPath]} alt={album.title} className="w-full h-full object-cover" loading="lazy" />
                  ) : album.coverPath ? (
                    <div className="w-full h-full bg-muted animate-pulse" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <ImageIcon className="w-8 h-8 text-muted-foreground/30" />
                    </div>
                  )}
                  {/* Source badge — Takeout-imported gets Sparkles +
                      violet palette (premium "magical import" cue);
                      user-created gets PencilLine + muted palette
                      ("authored locally"). Both surfaces stay
                      symmetrical so the user can tell at a glance
                      what kind of album they're looking at without
                      reading the label. */}
                  {album.source === 'takeout_imported' ? (
                    <span className="absolute top-2 right-2 inline-flex items-center gap-1 text-[10px] font-medium text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/80 px-1.5 py-0.5 rounded">
                      <Sparkles className="w-2.5 h-2.5" />
                      Takeout
                    </span>
                  ) : (
                    <span className="absolute top-2 right-2 inline-flex items-center gap-1 text-[10px] font-medium text-foreground bg-background/80 dark:bg-background/60 backdrop-blur-sm px-1.5 py-0.5 rounded border border-border">
                      <PencilLine className="w-2.5 h-2.5" />
                      Yours
                    </span>
                  )}
                </div>
                <div className="p-3">
                  <p className="text-sm font-medium text-foreground truncate" title={album.title}>{album.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{album.photoCount} photo{album.photoCount === 1 ? '' : 's'}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
