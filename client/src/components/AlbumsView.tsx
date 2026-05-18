/**
 * AlbumsView (v2.0.8 — hierarchical multi-membership tree).
 *
 * Top-level surface inside the Memories tab strip's "Albums" branch.
 * Renders the album library as a collapsible tree of groups:
 *
 *   - Auto-source groups (Google Photos Takeout, Created here, future
 *     Apple Photos / iCloud / OneDrive / etc.) at the root, always
 *     first and always present. System-managed: title, icon, palette
 *     fixed; can't be renamed, deleted, or have manual album drops.
 *   - User folders below, nestable up to USER_GROUP_MAX_DEPTH (1) —
 *     so the deepest tree is root → user-folder → album-leaf. User
 *     folders are renamable, deletable, drag-droppable (drag wiring
 *     lands in a follow-up commit).
 *
 * An album can belong to many groups simultaneously (M2M via
 * album_group_memberships). For v2.0.8 step 3 the only memberships
 * that exist are the auto-source ones the migration seeded; user
 * folders are empty until drag-drop or "Add to Folder" lands. Cards
 * appear in every group they're a member of — same album, same id,
 * rendered in each section it lives in.
 *
 * Detail view (when an album card is clicked) is unchanged from the
 * step 3 first cut — Rename / Delete / scrollable photo grid.
 */

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  ChevronDown, ChevronRight, ChevronLeft, FolderPlus, FolderClosed,
  Trash2, Pencil, Plus, Check, X, Image as ImageIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/custom-button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import {
  listAlbums,
  listAlbumGroups,
  listAlbumGroupMemberships,
  createAlbum,
  renameAlbum,
  deleteAlbum,
  createAlbumGroup,
  renameAlbumGroup,
  deleteAlbumGroup,
  listAlbumPhotos,
  getThumbnail,
  openSearchViewer,
  type AlbumSummary,
  type AlbumGroupRecord,
  type AlbumGroupMembershipRecord,
  type IndexedFile,
} from '../lib/electron-bridge';
import { promptConfirm } from './trees/promptConfirm';
import {
  getSourceProfileForGroup,
  getSourceProfileForAlbum,
} from '../lib/albumSourceProfile';

const EXPANDED_STORAGE_KEY = 'pdr-albums-expanded-groups';

export default function AlbumsView() {
  // ── Data ──────────────────────────────────────────────────────────
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [groups, setGroups] = useState<AlbumGroupRecord[]>([]);
  const [memberships, setMemberships] = useState<AlbumGroupMembershipRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // ── Drill-in state (detail view) ─────────────────────────────────
  const [selectedAlbumId, setSelectedAlbumId] = useState<number | null>(null);
  const [albumPhotos, setAlbumPhotos] = useState<IndexedFile[]>([]);
  const [albumPhotosLoading, setAlbumPhotosLoading] = useState(false);

  // ── Tree expansion (persists across sessions) ────────────────────
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(EXPANDED_STORAGE_KEY) : null;
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch { return new Set(); }
  });
  const persistExpanded = useCallback((next: Set<number>) => {
    try { localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next))); } catch { /* unwritable storage */ }
  }, []);
  const toggleGroupExpanded = useCallback((groupId: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      persistExpanded(next);
      return next;
    });
  }, [persistExpanded]);

  // ── Inline-edit state ────────────────────────────────────────────
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [newAlbumTitle, setNewAlbumTitle] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderTitle, setNewFolderTitle] = useState('');
  const [renamingAlbumId, setRenamingAlbumId] = useState<number | null>(null);
  const [renameAlbumTitle, setRenameAlbumTitle] = useState('');
  const [renamingGroupId, setRenamingGroupId] = useState<number | null>(null);
  const [renameGroupTitle, setRenameGroupTitle] = useState('');
  const renameAlbumInputRef = useRef<HTMLInputElement | null>(null);

  // ── Data loaders ────────────────────────────────────────────────
  const refreshAll = useCallback(async () => {
    setLoading(true);
    const [albumsR, groupsR, membershipsR] = await Promise.all([
      listAlbums(),
      listAlbumGroups(),
      listAlbumGroupMemberships(),
    ]);
    setAlbums(albumsR.success && albumsR.data ? albumsR.data : []);
    setGroups(groupsR.success && groupsR.data ? groupsR.data : []);
    setMemberships(membershipsR.success && membershipsR.data ? membershipsR.data : []);
    setLoading(false);
  }, []);
  useEffect(() => { refreshAll(); }, [refreshAll]);

  // First-load default expansion: every group expanded so the user
  // sees what's in their library without hunting. Only fires once on
  // first load when expandedGroups is empty and groups are present.
  useEffect(() => {
    if (expandedGroups.size === 0 && groups.length > 0) {
      const all = new Set(groups.map((g) => g.id));
      setExpandedGroups(all);
      persistExpanded(all);
    }
    // intentional: only on first non-empty groups load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);

  // Indices that the tree-renderer reads:
  //   albumsById   — fast lookup when a membership row needs the album
  //   childGroups  — children-of-parent map (parent_id -> AlbumGroupRecord[])
  //   albumIdsByGroup — group_id -> album_id[], ordered alphabetically
  const albumsById = useMemo(() => {
    const m = new Map<number, AlbumSummary>();
    for (const a of albums) m.set(a.id, a);
    return m;
  }, [albums]);

  const childGroups = useMemo(() => {
    const m = new Map<number | null, AlbumGroupRecord[]>();
    for (const g of groups) {
      const key = g.parent_id;
      const arr = m.get(key);
      if (arr) arr.push(g); else m.set(key, [g]);
    }
    return m;
  }, [groups]);

  const albumIdsByGroup = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const mb of memberships) {
      const arr = m.get(mb.group_id);
      if (arr) arr.push(mb.album_id); else m.set(mb.group_id, [mb.album_id]);
    }
    // Sort each group's albums alphabetically by title (case-insensitive).
    for (const [gid, ids] of m) {
      ids.sort((a, b) => {
        const ta = albumsById.get(a)?.title ?? '';
        const tb = albumsById.get(b)?.title ?? '';
        return ta.localeCompare(tb, undefined, { sensitivity: 'base' });
      });
    }
    return m;
  }, [memberships, albumsById]);

  // ── Thumbnail loader ─────────────────────────────────────────────
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

  // Detail-view album-photo loader (unchanged from step 3 first cut).
  useEffect(() => {
    if (selectedAlbumId === null) { setAlbumPhotos([]); return; }
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

  const handleCreateAlbum = async () => {
    const title = newAlbumTitle.trim();
    if (!title) return;
    const r = await createAlbum(title);
    if (r.success) {
      setNewAlbumTitle('');
      setCreatingAlbum(false);
      await refreshAll();
    }
  };

  const handleCreateFolder = async () => {
    const title = newFolderTitle.trim();
    if (!title) return;
    const r = await createAlbumGroup(title, null);
    if (r.success) {
      setNewFolderTitle('');
      setCreatingFolder(false);
      await refreshAll();
    }
  };

  const handleRenameAlbum = async () => {
    if (renamingAlbumId === null) return;
    const title = renameAlbumTitle.trim();
    if (!title) return;
    const r = await renameAlbum(renamingAlbumId, title);
    if (r.success) {
      setRenamingAlbumId(null);
      setRenameAlbumTitle('');
      await refreshAll();
    }
  };

  const handleRenameFolder = async () => {
    if (renamingGroupId === null) return;
    const title = renameGroupTitle.trim();
    if (!title) return;
    const r = await renameAlbumGroup(renamingGroupId, title);
    if (r.success) {
      setRenamingGroupId(null);
      setRenameGroupTitle('');
      await refreshAll();
    }
  };

  const handleDeleteAlbum = async (albumId: number, albumTitle: string) => {
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
      await refreshAll();
    }
  };

  const handleDeleteFolder = async (groupId: number, groupTitle: string) => {
    const ok = await promptConfirm({
      title: 'Delete folder?',
      message: `Remove the "${groupTitle}" folder. Albums inside stay in your library — they just lose this folder grouping. Their source folders (Google Photos Takeout / Created here / etc.) are unaffected.`,
      confirmLabel: 'Delete folder',
      cancelLabel: 'Keep it',
    });
    if (!ok) return;
    const r = await deleteAlbumGroup(groupId);
    if (r.success) await refreshAll();
  };

  const handleOpenPhoto = async (idx: number) => {
    const paths = albumPhotos.map((p) => p.file_path);
    const names = albumPhotos.map((p) => p.filename);
    await openSearchViewer(paths, names, idx);
  };

  // ─────────────────────────────────────────────────────────────────
  // Render: detail view (drill-in)
  // ─────────────────────────────────────────────────────────────────

  if (selectedAlbum) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <Button variant="secondary" size="sm" onClick={() => setSelectedAlbumId(null)} className="gap-1.5 shrink-0">
              <ChevronLeft className="w-4 h-4" />
              Albums
            </Button>
            {renamingAlbumId === selectedAlbum.id ? (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <input
                  ref={renameAlbumInputRef}
                  value={renameAlbumTitle}
                  onChange={(e) => setRenameAlbumTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleRenameAlbum(); }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenamingAlbumId(null); setRenameAlbumTitle(''); }
                  }}
                  autoFocus
                  className="px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-base font-medium flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-primary"
                  data-testid="input-album-rename"
                />
                <Button variant="primary" size="sm" onClick={handleRenameAlbum} className="gap-1.5 shrink-0">
                  <Check className="w-4 h-4" />
                  Save
                </Button>
                <Button variant="secondary" size="sm" onClick={() => { setRenamingAlbumId(null); setRenameAlbumTitle(''); }} className="gap-1.5 shrink-0">
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
                <Button variant="secondary" size="sm" onClick={() => { setRenamingAlbumId(selectedAlbum.id); setRenameAlbumTitle(selectedAlbum.title); }} className="gap-1.5">
                  <Pencil className="w-4 h-4" />
                  Rename
                </Button>
              </IconTooltip>
              <IconTooltip content="Delete album (photos stay)">
                <Button variant="caution" size="sm" onClick={() => handleDeleteAlbum(selectedAlbum.id, selectedAlbum.title)} className="gap-1.5">
                  <Trash2 className="w-4 h-4" />
                  Delete
                </Button>
              </IconTooltip>
            </div>
          )}
        </div>

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

  // ─────────────────────────────────────────────────────────────────
  // Render: tree view (list)
  // ─────────────────────────────────────────────────────────────────

  // Recursive group renderer. depth = 0 at root, 1 for nested, etc.
  // App-layer caps creation at depth 1 (USER_GROUP_MAX_DEPTH on the
  // backend), so this never recurses deeper than 1 in practice — but
  // recursion-safe regardless.
  const renderGroup = (group: AlbumGroupRecord, depth: number) => {
    const profile = getSourceProfileForGroup(group);
    const Icon = profile.Icon;
    const isExpanded = expandedGroups.has(group.id);
    const isUser = group.source_kind === 'user';
    const childGroupList = childGroups.get(group.id) ?? [];
    const albumIdList = albumIdsByGroup.get(group.id) ?? [];
    const totalCount = albumIdList.length + childGroupList.length;
    const isRenaming = renamingGroupId === group.id;

    return (
      <div key={group.id} className="mb-2" data-testid={`group-${group.id}`}>
        {/* Header */}
        <div
          className={`flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/40 transition-colors group/header`}
          style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
        >
          <button
            type="button"
            onClick={() => toggleGroupExpanded(group.id)}
            className="shrink-0 text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors"
            data-testid={`group-toggle-${group.id}`}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded
              ? <ChevronDown className="w-4 h-4" />
              : <ChevronRight className="w-4 h-4" />}
          </button>
          <span className={`shrink-0 ${profile.iconColorClass}`}>
            <Icon className="w-4 h-4" />
          </span>
          {isRenaming ? (
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <input
                value={renameGroupTitle}
                onChange={(e) => setRenameGroupTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleRenameFolder(); }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenamingGroupId(null); setRenameGroupTitle(''); }
                }}
                autoFocus
                className="px-2 py-1 rounded border border-border bg-background text-foreground text-sm font-medium flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid={`input-folder-rename-${group.id}`}
              />
              <Button variant="primary" size="sm" onClick={handleRenameFolder} className="gap-1 shrink-0">
                <Check className="w-3.5 h-3.5" />
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { setRenamingGroupId(null); setRenameGroupTitle(''); }} className="gap-1 shrink-0">
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => toggleGroupExpanded(group.id)}
                className="flex items-center gap-2 flex-1 min-w-0 text-left"
              >
                <span className="text-sm font-medium text-foreground truncate">{group.title}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {totalCount === 0 ? 'empty' : `${totalCount} ${totalCount === 1 ? 'item' : 'items'}`}
                </span>
              </button>
              {isUser && (
                <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover/header:opacity-100 transition-opacity">
                  <IconTooltip content="Rename folder">
                    <Button variant="secondary" size="sm" onClick={() => { setRenamingGroupId(group.id); setRenameGroupTitle(group.title); }} className="gap-1 px-2">
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                  </IconTooltip>
                  <IconTooltip content="Delete folder (albums + photos stay)">
                    <Button variant="caution" size="sm" onClick={() => handleDeleteFolder(group.id, group.title)} className="gap-1 px-2">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </IconTooltip>
                </div>
              )}
            </>
          )}
        </div>

        {/* Body */}
        {isExpanded && (
          <div style={{ paddingLeft: `${depth * 1.25 + 1.5}rem` }} className="mt-1">
            {/* Sub-folders first (so the nesting reads top-down) */}
            {childGroupList.map((child) => renderGroup(child, depth + 1))}

            {/* Album cards inside this group */}
            {albumIdList.length > 0 && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 py-2">
                {albumIdList.map((albumId) => {
                  const album = albumsById.get(albumId);
                  if (!album) return null;
                  const albumProfile = getSourceProfileForAlbum(album);
                  const AlbumIcon = albumProfile.Icon;
                  return (
                    <button
                      key={`${group.id}-${album.id}`}
                      type="button"
                      onClick={() => setSelectedAlbumId(album.id)}
                      className={`flex flex-col rounded-lg border bg-card overflow-hidden text-left hover:ring-2 hover:ring-primary/40 transition-all ${albumProfile.cardBgClass}`}
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
                        <span className={`absolute top-2 right-2 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${albumProfile.badgeBgClass} ${albumProfile.badgeTextClass}`}>
                          <AlbumIcon className="w-2.5 h-2.5" />
                          {album.source === 'takeout_imported' ? 'Takeout' : 'Yours'}
                        </span>
                      </div>
                      <div className="p-3">
                        <p className="text-sm font-medium text-foreground truncate" title={album.title}>{album.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{album.photoCount} photo{album.photoCount === 1 ? '' : 's'}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Empty hint for user folders with nothing in them */}
            {isUser && totalCount === 0 && (
              <p className="text-xs text-muted-foreground italic px-2 py-2">
                Drag an album here, or use "Add to Folder" from any album card. (Drag-drop lands in the next update.)
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  const rootGroups = childGroups.get(null) ?? [];
  const isEmpty = !loading && albums.length === 0 && rootGroups.filter((g) => g.source_kind === 'user').length === 0;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-border">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-medium text-foreground">Albums</h2>
          {!loading && albums.length > 0 && (
            <span className="text-xs text-muted-foreground">{albums.length} album{albums.length === 1 ? '' : 's'}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {creatingAlbum ? (
            <div className="flex items-center gap-2">
              <input
                value={newAlbumTitle}
                onChange={(e) => setNewAlbumTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleCreateAlbum(); }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreatingAlbum(false); setNewAlbumTitle(''); }
                }}
                placeholder="Album name"
                autoFocus
                className="px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm w-56 focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="input-new-album-title"
              />
              <Button variant="primary" size="sm" onClick={handleCreateAlbum} disabled={!newAlbumTitle.trim()} className="gap-1.5">
                <Check className="w-4 h-4" />
                Create album
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { setCreatingAlbum(false); setNewAlbumTitle(''); }} className="gap-1.5">
                <X className="w-4 h-4" />
              </Button>
            </div>
          ) : creatingFolder ? (
            <div className="flex items-center gap-2">
              <input
                value={newFolderTitle}
                onChange={(e) => setNewFolderTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleCreateFolder(); }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreatingFolder(false); setNewFolderTitle(''); }
                }}
                placeholder="Folder name"
                autoFocus
                className="px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm w-56 focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="input-new-folder-title"
              />
              <Button variant="primary" size="sm" onClick={handleCreateFolder} disabled={!newFolderTitle.trim()} className="gap-1.5">
                <Check className="w-4 h-4" />
                Create folder
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { setCreatingFolder(false); setNewFolderTitle(''); }} className="gap-1.5">
                <X className="w-4 h-4" />
              </Button>
            </div>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={() => setCreatingFolder(true)} className="gap-1.5" data-testid="button-create-folder">
                <FolderClosed className="w-4 h-4" />
                New folder
              </Button>
              <Button variant="primary" size="sm" onClick={() => setCreatingAlbum(true)} className="gap-1.5" data-testid="button-create-album">
                <FolderPlus className="w-4 h-4" />
                New album
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <p className="text-sm text-muted-foreground px-2">Loading albums…</p>
        ) : isEmpty ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center text-center py-16 max-w-lg mx-auto">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <FolderPlus className="w-6 h-6 text-primary" />
            </div>
            <h3 className="text-base font-medium text-foreground mb-2">No albums yet</h3>
            <p className="text-sm text-muted-foreground mb-5">
              Albums let you group photos by occasion, person, place — anything you like. They're virtual, so the underlying files stay exactly where they are. Folders let you organise albums across sources without losing the source identity.
            </p>
            <Button variant="primary" size="sm" onClick={() => setCreatingAlbum(true)} className="gap-1.5 mb-6">
              <Plus className="w-4 h-4" />
              Create your first album
            </Button>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-violet-50/40 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800/40 text-left">
              <p className="text-xs text-violet-700 dark:text-violet-300">
                <strong>Already used Google Photos?</strong> Your Google Photos albums will automatically appear here after you Fix a Takeout — or pull them in from an existing Takeout ZIP via <strong>Settings → After Fix</strong>.
              </p>
            </div>
          </div>
        ) : (
          /* Tree of groups */
          <div>
            {rootGroups.map((g) => renderGroup(g, 0))}
          </div>
        )}
      </div>
    </div>
  );
}
