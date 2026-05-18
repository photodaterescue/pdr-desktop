/**
 * AlbumsView (v2.0.8 — File Explorer split-pane layout).
 *
 * Two-pane surface inside the Memories tab strip's "Albums" branch:
 *
 *   • LEFT — Tree pane. Hierarchical text-list of source groups, user
 *     folders, and album leaves. Toolbar (Refresh / New folder / New
 *     album) lives at the top. Drag-drop reorganises here: drag an
 *     album leaf onto a user-folder header to add a membership; drag
 *     a user folder onto another to nest it (1 level deep max); drag
 *     a folder outside the tree to return it to root.
 *
 *   • RIGHT — Content pane. What's shown depends on the tree
 *     selection:
 *       - Group selected   → grid of album cards in that group.
 *       - Album selected   → photo grid inside that album.
 *       - Nothing selected → prompt "Pick something from the left".
 *
 * Source identity (icon + pastel tint + label) is preserved on every
 * album card across the surface — Created-here violet, Google
 * Photos Takeout red, future sources mapped in albumSourceProfile.ts.
 *
 * Multi-membership: an album can live in many groups. The tree shows
 * the album under EVERY group it belongs to; clicking it from any
 * location opens the same photos in the right pane.
 */

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  ChevronDown, ChevronRight, FolderPlus, FolderClosed, FolderOpen,
  Trash2, Pencil, Plus, Check, X, Image as ImageIcon, RefreshCw,
  Sparkles, FileText, LayoutGrid, FolderMinus,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/custom-button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
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
  addAlbumToGroup,
  removeAlbumFromGroup,
  moveAlbumGroup,
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
  isGroupDroppable,
} from '../lib/albumSourceProfile';

const DRAG_MIME_ALBUM = 'application/x-pdr-album-id';
const DRAG_MIME_FOLDER = 'application/x-pdr-folder-id';
const EXPANDED_STORAGE_KEY = 'pdr-albums-expanded-groups';

type Selection =
  | { type: 'all' }
  | { type: 'group'; id: number }
  | { type: 'album'; id: number }
  | null;

export default function AlbumsView() {
  // ── Data ──────────────────────────────────────────────────────────
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [groups, setGroups] = useState<AlbumGroupRecord[]>([]);
  const [memberships, setMemberships] = useState<AlbumGroupMembershipRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // ── Selection (drives the right pane) ────────────────────────────
  const [selection, setSelection] = useState<Selection>(null);
  const [albumPhotos, setAlbumPhotos] = useState<IndexedFile[]>([]);
  const [albumPhotosLoading, setAlbumPhotosLoading] = useState(false);

  // ── Tree expansion ───────────────────────────────────────────────
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(EXPANDED_STORAGE_KEY) : null;
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch { return new Set(); }
  });
  const persistExpanded = useCallback((next: Set<number>) => {
    try { localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next))); } catch {}
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

  useEffect(() => {
    if (expandedGroups.size === 0 && groups.length > 0) {
      const all = new Set(groups.map((g) => g.id));
      setExpandedGroups(all);
      persistExpanded(all);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);

  // Indices the renderer reads.
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
    for (const [, ids] of m) {
      ids.sort((a, b) => {
        const ta = albumsById.get(a)?.title ?? '';
        const tb = albumsById.get(b)?.title ?? '';
        return ta.localeCompare(tb, undefined, { sensitivity: 'base' });
      });
    }
    return m;
  }, [memberships, albumsById]);

  // ── Drag-drop ────────────────────────────────────────────────────
  const [dragOverGroupId, setDragOverGroupId] = useState<number | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);

  const handleAlbumDragStart = useCallback((e: React.DragEvent, albumId: number) => {
    e.dataTransfer.setData(DRAG_MIME_ALBUM, String(albumId));
    e.dataTransfer.effectAllowed = 'copyMove';
  }, []);
  const handleFolderDragStart = useCallback((e: React.DragEvent, groupId: number) => {
    e.dataTransfer.setData(DRAG_MIME_FOLDER, String(groupId));
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
  }, []);
  const handleGroupDragOver = useCallback((e: React.DragEvent, group: AlbumGroupRecord) => {
    if (!isGroupDroppable(group)) return;
    const hasAlbum = e.dataTransfer.types.includes(DRAG_MIME_ALBUM);
    const hasFolder = e.dataTransfer.types.includes(DRAG_MIME_FOLDER);
    if (!hasAlbum && !hasFolder) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = hasAlbum ? 'copy' : 'move';
    if (dragOverGroupId !== group.id) setDragOverGroupId(group.id);
  }, [dragOverGroupId]);
  const handleGroupDragLeave = useCallback((e: React.DragEvent, group: AlbumGroupRecord) => {
    const related = e.relatedTarget as Node | null;
    const current = e.currentTarget as HTMLElement;
    if (related && current.contains(related)) return;
    if (dragOverGroupId === group.id) setDragOverGroupId(null);
  }, [dragOverGroupId]);
  const handleGroupDrop = useCallback(async (e: React.DragEvent, group: AlbumGroupRecord) => {
    setDragOverGroupId(null);
    if (!isGroupDroppable(group)) return;
    e.preventDefault();
    e.stopPropagation();
    const albumIdStr = e.dataTransfer.getData(DRAG_MIME_ALBUM);
    if (albumIdStr) {
      const albumId = Number(albumIdStr);
      if (!Number.isFinite(albumId)) return;
      const album = albumsById.get(albumId);
      const r = await addAlbumToGroup(albumId, group.id);
      if (!r.success) { toast.error(`Couldn't add to "${group.title}"`, { description: r.error }); return; }
      if (r.inserted) toast.success(`Added "${album?.title ?? 'album'}" to "${group.title}"`);
      else toast.message(`Already in "${group.title}"`, { description: 'No duplicate created.' });
      await refreshAll();
      return;
    }
    const folderIdStr = e.dataTransfer.getData(DRAG_MIME_FOLDER);
    if (folderIdStr) {
      const folderId = Number(folderIdStr);
      if (!Number.isFinite(folderId) || folderId === group.id) return;
      const r = await moveAlbumGroup(folderId, group.id);
      if (!r.success) { toast.error(`Couldn't move folder`, { description: r.error }); return; }
      toast.success(`Moved folder into "${group.title}"`);
      await refreshAll();
    }
  }, [albumsById, refreshAll]);
  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME_FOLDER)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragOverRoot) setDragOverRoot(true);
  }, [dragOverRoot]);
  const handleRootDragLeave = useCallback((e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null;
    const current = e.currentTarget as HTMLElement;
    if (related && current.contains(related)) return;
    setDragOverRoot(false);
  }, []);
  const handleRootDrop = useCallback(async (e: React.DragEvent) => {
    setDragOverRoot(false);
    const folderIdStr = e.dataTransfer.getData(DRAG_MIME_FOLDER);
    if (!folderIdStr) return;
    e.preventDefault();
    const folderId = Number(folderIdStr);
    if (!Number.isFinite(folderId)) return;
    const r = await moveAlbumGroup(folderId, null);
    if (!r.success) { toast.error(`Couldn't move folder to root`, { description: r.error }); return; }
    toast.success(`Moved folder to the top`);
    await refreshAll();
  }, [refreshAll]);

  // ── Right-pane data: load album photos when an album is selected ──
  useEffect(() => {
    if (selection?.type !== 'album') { setAlbumPhotos([]); return; }
    let cancelled = false;
    (async () => {
      setAlbumPhotosLoading(true);
      const r = await listAlbumPhotos(selection.id);
      if (cancelled) return;
      setAlbumPhotos(r.success && r.data ? r.data : []);
      setAlbumPhotosLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selection]);

  // ── Thumbnail loader (covers + album photos) ─────────────────────
  useEffect(() => {
    let cancelled = false;
    const paths = new Set<string>();
    for (const a of albums) if (a.coverPath) paths.add(a.coverPath);
    for (const p of albumPhotos) paths.add(p.file_path);
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
        } catch {}
      }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    void Promise.allSettled(workers);
    return () => { cancelled = true; };
  }, [albums, albumPhotos]);

  // ── Actions ──────────────────────────────────────────────────────
  const handleCreateAlbum = async () => {
    const title = newAlbumTitle.trim();
    if (!title) return;
    const r = await createAlbum(title);
    if (r.success) { setNewAlbumTitle(''); setCreatingAlbum(false); await refreshAll(); }
  };
  const handleCreateFolder = async () => {
    const title = newFolderTitle.trim();
    if (!title) return;
    const r = await createAlbumGroup(title, null);
    if (r.success) { setNewFolderTitle(''); setCreatingFolder(false); await refreshAll(); }
  };
  const handleRenameAlbum = async () => {
    if (renamingAlbumId === null) return;
    const title = renameAlbumTitle.trim();
    if (!title) return;
    const r = await renameAlbum(renamingAlbumId, title);
    if (r.success) { setRenamingAlbumId(null); setRenameAlbumTitle(''); await refreshAll(); }
  };
  const handleRenameFolder = async () => {
    if (renamingGroupId === null) return;
    const title = renameGroupTitle.trim();
    if (!title) return;
    const r = await renameAlbumGroup(renamingGroupId, title);
    if (r.success) { setRenamingGroupId(null); setRenameGroupTitle(''); await refreshAll(); }
  };
  // Remove an album from a USER folder (membership-delete only). Does
  // NOT delete the album record — the album survives in its source
  // group (PDR / Google Photos / etc.) and anywhere else it's
  // linked. Terry 2026-05-18 bug report: previously the trash icon
  // inside a folder context was calling handleDeleteAlbum, which
  // killed the whole album. That's now reserved for the trash icon
  // when viewing the album under its source group.
  const handleRemoveFromFolder = async (albumId: number, folderId: number, albumTitle: string, folderTitle: string) => {
    const ok = await promptConfirm({
      title: 'Remove from folder?',
      message: `Remove "${albumTitle}" from the "${folderTitle}" folder. The album itself stays in your library and in any other folders it's in — only this folder link is removed.`,
      confirmLabel: 'Remove from folder',
      cancelLabel: 'Keep it',
    });
    if (!ok) return;
    const r = await removeAlbumFromGroup(albumId, folderId);
    if (r.success) {
      await refreshAll();
    } else {
      toast.error(`Couldn't remove from "${folderTitle}"`, { description: r.error });
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
      if (selection?.type === 'album' && selection.id === albumId) setSelection(null);
      await refreshAll();
    }
  };
  const handleDeleteFolder = async (groupId: number, groupTitle: string) => {
    const ok = await promptConfirm({
      title: 'Delete folder?',
      message: `Remove the "${groupTitle}" folder. Albums inside stay in your library — they just lose this folder grouping. Source folders (Google Photos Takeout / Created here / etc.) are unaffected.`,
      confirmLabel: 'Delete folder',
      cancelLabel: 'Keep it',
    });
    if (!ok) return;
    const r = await deleteAlbumGroup(groupId);
    if (r.success) {
      if (selection?.type === 'group' && selection.id === groupId) setSelection(null);
      await refreshAll();
    }
  };
  const handleOpenPhoto = async (idx: number) => {
    const paths = albumPhotos.map((p) => p.file_path);
    const names = albumPhotos.map((p) => p.filename);
    await openSearchViewer(paths, names, idx);
  };

  // ─────────────────────────────────────────────────────────────────
  // Left-pane: tree row rendering
  // ─────────────────────────────────────────────────────────────────

  const renderAlbumLeaf = (album: AlbumSummary, depth: number, parentGroupId: number) => {
    const profile = getSourceProfileForAlbum(album);
    const Icon = profile.Icon;
    const isSelected = selection?.type === 'album' && selection.id === album.id;
    const isRenaming = renamingAlbumId === album.id;
    // Hover-action affordances split by context: inside a USER FOLDER
    // the trash icon becomes a FolderMinus that ONLY removes the
    // membership (album survives in source + everywhere else linked).
    // Inside the album's SOURCE auto group, the trash icon does the
    // album-delete-with-confirm flow. Critical bug fix 2026-05-18:
    // previously the in-folder trash icon deleted the album entirely.
    const parentGroup = groups.find((g) => g.id === parentGroupId);
    const isInUserFolder = parentGroup?.source_kind === 'user';
    return (
      <div key={`leaf-${parentGroupId}-${album.id}`} className="group/leaf">
        <div
          className={`flex items-center gap-2 pr-2 py-1 rounded-md transition-colors cursor-pointer ${
            isSelected ? 'bg-primary/15 text-foreground' : 'hover:bg-muted/40'
          }`}
          style={{ paddingLeft: `${depth * 1.25 + 1.5}rem` }}
          onClick={() => { if (!isRenaming) setSelection({ type: 'album', id: album.id }); }}
          draggable={!isRenaming}
          onDragStart={(e) => handleAlbumDragStart(e, album.id)}
          data-testid={`tree-album-${album.id}`}
        >
          <span className={`shrink-0 ${profile.iconColorClass}`}><Icon className="w-3.5 h-3.5" /></span>
          {isRenaming ? (
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <input
                value={renameAlbumTitle}
                onChange={(e) => setRenameAlbumTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleRenameAlbum(); }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenamingAlbumId(null); setRenameAlbumTitle(''); }
                }}
                onClick={(e) => e.stopPropagation()}
                autoFocus
                className="px-2 py-0.5 rounded border border-border bg-background text-foreground text-xs flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <Button variant="primary" size="sm" onClick={(e) => { e.stopPropagation(); handleRenameAlbum(); }} className="px-1.5 py-0.5 h-auto">
                <Check className="w-3 h-3" />
              </Button>
              <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); setRenamingAlbumId(null); setRenameAlbumTitle(''); }} className="px-1.5 py-0.5 h-auto">
                <X className="w-3 h-3" />
              </Button>
            </div>
          ) : (
            <>
              <IconTooltip content={album.title}>
                <span className="text-xs text-foreground truncate flex-1">{album.title}</span>
              </IconTooltip>
              <span className="text-[10px] text-muted-foreground shrink-0">{album.photoCount}</span>
              <div className="hidden group-hover/leaf:flex items-center gap-0.5 shrink-0">
                {album.source === 'user_created' && (
                  <IconTooltip content="Rename album">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setRenamingAlbumId(album.id); setRenameAlbumTitle(album.title); }}
                      className="text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  </IconTooltip>
                )}
                {isInUserFolder ? (
                  /* Folder context — pure membership removal, never
                     touches the album record. Works for any album source. */
                  <IconTooltip content={`Remove from "${parentGroup?.title ?? 'folder'}"`}>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); if (parentGroup) handleRemoveFromFolder(album.id, parentGroup.id, album.title, parentGroup.title); }}
                      className="text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors"
                    >
                      <FolderMinus className="w-3 h-3" />
                    </button>
                  </IconTooltip>
                ) : album.source === 'user_created' && (
                  /* Source-group context — full album delete with confirm.
                     Only available for user_created; takeout albums are
                     source-immutable so the icon is hidden. */
                  <IconTooltip content="Delete album (photos stay)">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleDeleteAlbum(album.id, album.title); }}
                      className="text-muted-foreground hover:text-destructive p-0.5 rounded transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </IconTooltip>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderGroupRow = (group: AlbumGroupRecord, depth: number): JSX.Element => {
    const profile = getSourceProfileForGroup(group);
    const Icon = group.source_kind === 'auto' ? profile.Icon : (expandedGroups.has(group.id) ? FolderOpen : FolderClosed);
    const isExpanded = expandedGroups.has(group.id);
    const isUser = group.source_kind === 'user';
    const isSelected = selection?.type === 'group' && selection.id === group.id;
    const isRenaming = renamingGroupId === group.id;
    const isDropping = dragOverGroupId === group.id;
    const dropAccepted = isGroupDroppable(group);
    const childGroupList = childGroups.get(group.id) ?? [];
    const albumIdList = albumIdsByGroup.get(group.id) ?? [];
    const totalCount = albumIdList.length + childGroupList.length;

    return (
      <div key={`group-${group.id}`} className="group/row">
        <div
          className={`flex items-center gap-1.5 pr-2 py-1 rounded-md transition-colors cursor-pointer ${
            isDropping ? 'bg-primary/10 ring-2 ring-primary/40' : (isSelected ? 'bg-primary/15' : 'hover:bg-muted/40')
          } ${isUser ? 'cursor-grab active:cursor-grabbing' : ''}`}
          style={{ paddingLeft: `${depth * 1.25 + 0.25}rem` }}
          onClick={() => { if (!isRenaming) setSelection({ type: 'group', id: group.id }); }}
          draggable={isUser && !isRenaming}
          onDragStart={isUser ? (e) => handleFolderDragStart(e, group.id) : undefined}
          onDragOver={dropAccepted ? (e) => handleGroupDragOver(e, group) : undefined}
          onDragLeave={dropAccepted ? (e) => handleGroupDragLeave(e, group) : undefined}
          onDrop={dropAccepted ? (e) => handleGroupDrop(e, group) : undefined}
          data-testid={`tree-group-${group.id}`}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleGroupExpanded(group.id); }}
            className="shrink-0 text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
          <span className={`shrink-0 ${profile.iconColorClass}`}><Icon className="w-3.5 h-3.5" /></span>
          {isRenaming ? (
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <input
                value={renameGroupTitle}
                onChange={(e) => setRenameGroupTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleRenameFolder(); }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenamingGroupId(null); setRenameGroupTitle(''); }
                }}
                onClick={(e) => e.stopPropagation()}
                autoFocus
                className="px-2 py-0.5 rounded border border-border bg-background text-foreground text-xs flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <Button variant="primary" size="sm" onClick={(e) => { e.stopPropagation(); handleRenameFolder(); }} className="px-1.5 py-0.5 h-auto">
                <Check className="w-3 h-3" />
              </Button>
              <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); setRenamingGroupId(null); setRenameGroupTitle(''); }} className="px-1.5 py-0.5 h-auto">
                <X className="w-3 h-3" />
              </Button>
            </div>
          ) : (
            <>
              <IconTooltip content={group.title}>
                <span className="text-xs font-medium text-foreground truncate flex-1">{group.title}</span>
              </IconTooltip>
              <span className="text-[10px] text-muted-foreground shrink-0">{totalCount === 0 ? 'empty' : totalCount}</span>
              {isUser && (
                <div className="hidden group-hover/row:flex items-center gap-0.5 shrink-0">
                  <IconTooltip content="Rename folder">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setRenamingGroupId(group.id); setRenameGroupTitle(group.title); }}
                      className="text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  </IconTooltip>
                  <IconTooltip content="Delete folder (albums + photos stay)">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleDeleteFolder(group.id, group.title); }}
                      className="text-muted-foreground hover:text-destructive p-0.5 rounded transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </IconTooltip>
                </div>
              )}
            </>
          )}
        </div>
        {isExpanded && (
          <>
            {childGroupList.map((child) => renderGroupRow(child, depth + 1))}
            {albumIdList.map((id) => {
              const a = albumsById.get(id);
              return a ? renderAlbumLeaf(a, depth + 1, group.id) : null;
            })}
          </>
        )}
      </div>
    );
  };

  const rootGroups = childGroups.get(null) ?? [];

  // ─────────────────────────────────────────────────────────────────
  // Right-pane content
  // ─────────────────────────────────────────────────────────────────

  const selectedAlbum = selection?.type === 'album' ? (albumsById.get(selection.id) ?? null) : null;
  const selectedGroup = selection?.type === 'group' ? (groups.find((g) => g.id === selection.id) ?? null) : null;
  const selectedGroupAlbumIds = selectedGroup ? (albumIdsByGroup.get(selectedGroup.id) ?? []) : [];

  const renderRightPane = () => {
    if (loading) {
      return <p className="text-sm text-muted-foreground px-6 py-6">Loading albums…</p>;
    }
    // Default — nothing selected, OR the user picked the "All albums"
    // virtual tree row at the top of the left pane: show ALL albums
    // as a single grid sorted alphabetically. Terry 2026-05-18: "no
    // reason to be seeing a blank screen" — opening Memories →
    // Albums should land on something useful, not an empty-state
    // prompt. The "All albums" tree row gives a re-entry point
    // back to this view from anywhere else.
    if (!selection || selection.type === 'all') {
      const allSorted = [...albums].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      );
      return (
        <div className="flex flex-col h-full">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
            <h2 className="text-lg font-medium text-foreground truncate">All albums</h2>
            <span className="text-xs text-muted-foreground">{allSorted.length} album{allSorted.length === 1 ? '' : 's'}</span>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {allSorted.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No albums yet. Use "New album" on the left to create one, or import a Google Photos Takeout to auto-populate.
              </p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,220px)] gap-3">
                {allSorted.map((album) => {
                  const ap = getSourceProfileForAlbum(album);
                  const AIcon = ap.Icon;
                  return (
                    <button
                      key={`all-${album.id}`}
                      type="button"
                      onClick={() => setSelection({ type: 'album', id: album.id })}
                      draggable
                      onDragStart={(e) => handleAlbumDragStart(e, album.id)}
                      className={`flex flex-col rounded-lg bg-card overflow-hidden text-left hover:ring-2 hover:ring-primary/40 transition-all cursor-grab active:cursor-grabbing ${ap.cardBgClass}`}
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
                        <span className={`absolute top-2 right-2 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${ap.badgeBgClass} ${ap.badgeTextClass}`}>
                          <AIcon className="w-2.5 h-2.5" />
                          {ap.badgeLabel}
                        </span>
                      </div>
                      <div className="p-3">
                        <IconTooltip content={album.title}>
                          <p className="text-sm font-medium text-foreground truncate">{album.title}</p>
                        </IconTooltip>
                        <p className="text-xs text-muted-foreground mt-0.5">{album.photoCount} photo{album.photoCount === 1 ? '' : 's'}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      );
    }

    if (selectedGroup) {
      const profile = getSourceProfileForGroup(selectedGroup);
      const Icon = selectedGroup.source_kind === 'auto' ? profile.Icon : FolderOpen;
      return (
        <div className="flex flex-col h-full">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
            <span className={profile.iconColorClass}><Icon className="w-5 h-5" /></span>
            <h2 className="text-lg font-medium text-foreground truncate">{selectedGroup.title}</h2>
            <span className="text-xs text-muted-foreground">{selectedGroupAlbumIds.length} album{selectedGroupAlbumIds.length === 1 ? '' : 's'}</span>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {selectedGroupAlbumIds.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                {isGroupDroppable(selectedGroup)
                  ? 'This folder is empty. Drag album rows from the tree on the left into the folder header to add them here.'
                  : 'No albums in this source yet.'}
              </p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,220px)] gap-3">
                {selectedGroupAlbumIds.map((id) => {
                  const album = albumsById.get(id);
                  if (!album) return null;
                  const ap = getSourceProfileForAlbum(album);
                  const AIcon = ap.Icon;
                  return (
                    <button
                      key={`${selectedGroup.id}-${album.id}`}
                      type="button"
                      onClick={() => setSelection({ type: 'album', id: album.id })}
                      draggable
                      onDragStart={(e) => handleAlbumDragStart(e, album.id)}
                      className={`flex flex-col rounded-lg bg-card overflow-hidden text-left hover:ring-2 hover:ring-primary/40 transition-all cursor-grab active:cursor-grabbing ${ap.cardBgClass}`}
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
                        <span className={`absolute top-2 right-2 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${ap.badgeBgClass} ${ap.badgeTextClass}`}>
                          <AIcon className="w-2.5 h-2.5" />
                          {ap.badgeLabel}
                        </span>
                      </div>
                      <div className="p-3">
                        <IconTooltip content={album.title}>
                          <p className="text-sm font-medium text-foreground truncate">{album.title}</p>
                        </IconTooltip>
                        <p className="text-xs text-muted-foreground mt-0.5">{album.photoCount} photo{album.photoCount === 1 ? '' : 's'}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      );
    }

    if (selectedAlbum) {
      return (
        <div className="flex flex-col h-full">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
            <span className={getSourceProfileForAlbum(selectedAlbum).iconColorClass}>
              {(() => {
                const I = getSourceProfileForAlbum(selectedAlbum).Icon;
                return <I className="w-5 h-5" />;
              })()}
            </span>
            <h2 className="text-lg font-medium text-foreground truncate">{selectedAlbum.title}</h2>
            <span className="text-xs text-muted-foreground">{selectedAlbum.photoCount} photo{selectedAlbum.photoCount === 1 ? '' : 's'}</span>
            {selectedAlbum.source === 'takeout_imported' && (
              <span className="text-xs text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full shrink-0">From Google Takeout</span>
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

    return null;
  };

  // ─────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full" autoSaveId="pdr-albums-pane-split">
      {/* LEFT — tree pane (user-resizable, persists size in localStorage
          via autoSaveId on the ResizablePanelGroup). */}
      <ResizablePanel defaultSize={22} minSize={14} maxSize={45} className="flex flex-col border-r border-border bg-background/40">
        <div className="px-4 pt-4 pb-2">
          <div className="flex items-baseline gap-2 mb-2">
            <h2 className="text-base font-medium text-foreground">Albums</h2>
            {!loading && albums.length > 0 && (
              <span className="text-xs text-muted-foreground">{albums.length} album{albums.length === 1 ? '' : 's'}</span>
            )}
          </div>
          {creatingAlbum ? (
            <div className="flex items-center gap-1.5">
              <input
                value={newAlbumTitle}
                onChange={(e) => setNewAlbumTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleCreateAlbum(); }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreatingAlbum(false); setNewAlbumTitle(''); }
                }}
                placeholder="Album name"
                autoFocus
                className="px-2 py-1 rounded-md border border-border bg-background text-foreground text-xs flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="input-new-album-title"
              />
              <Button variant="primary" size="sm" onClick={handleCreateAlbum} disabled={!newAlbumTitle.trim()} className="px-2 py-1 h-auto">
                <Check className="w-3.5 h-3.5" />
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { setCreatingAlbum(false); setNewAlbumTitle(''); }} className="px-2 py-1 h-auto">
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ) : creatingFolder ? (
            <div className="flex items-center gap-1.5">
              <input
                value={newFolderTitle}
                onChange={(e) => setNewFolderTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleCreateFolder(); }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreatingFolder(false); setNewFolderTitle(''); }
                }}
                placeholder="Folder name"
                autoFocus
                className="px-2 py-1 rounded-md border border-border bg-background text-foreground text-xs flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="input-new-folder-title"
              />
              <Button variant="primary" size="sm" onClick={handleCreateFolder} disabled={!newFolderTitle.trim()} className="px-2 py-1 h-auto">
                <Check className="w-3.5 h-3.5" />
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { setCreatingFolder(false); setNewFolderTitle(''); }} className="px-2 py-1 h-auto">
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <IconTooltip content="Refresh albums">
                <Button variant="secondary" size="sm" onClick={() => refreshAll()} disabled={loading} className="px-2 py-1 h-auto" data-testid="button-refresh-albums">
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                </Button>
              </IconTooltip>
              <Button variant="secondary" size="sm" onClick={() => setCreatingFolder(true)} className="gap-1 px-2 py-1 h-auto flex-1 text-xs" data-testid="button-create-folder">
                <FolderClosed className="w-3.5 h-3.5" />
                New folder
              </Button>
              <Button variant="primary" size="sm" onClick={() => setCreatingAlbum(true)} className="gap-1 px-2 py-1 h-auto flex-1 text-xs" data-testid="button-create-album">
                <FolderPlus className="w-3.5 h-3.5" />
                New album
              </Button>
            </div>
          )}
        </div>
        <div
          onDragOver={handleRootDragOver}
          onDragLeave={handleRootDragLeave}
          onDrop={handleRootDrop}
          className={`flex-1 overflow-y-auto px-2 py-2 transition-colors ${dragOverRoot ? 'bg-primary/5 ring-2 ring-primary/30 ring-inset' : ''}`}
        >
          {loading ? (
            <p className="text-xs text-muted-foreground px-2">Loading…</p>
          ) : rootGroups.length === 0 ? (
            <p className="text-xs text-muted-foreground italic px-2">
              No albums yet. Create one with the buttons above, or import a Google Photos Takeout to auto-populate this list.
            </p>
          ) : (
            <>
              {/* "All albums" virtual row — sits above the real groups
                  and selects the "show every album" view in the right
                  pane (same content as the default no-selection state,
                  but with this row highlighted so the user knows where
                  they are). Not backed by an album_groups row; pure
                  client-side virtual node. */}
              <div
                onClick={() => setSelection({ type: 'all' })}
                className={`flex items-center gap-1.5 pr-2 py-1 mb-1 rounded-md transition-colors cursor-pointer ${
                  selection?.type === 'all' ? 'bg-primary/15' : 'hover:bg-muted/40'
                }`}
                style={{ paddingLeft: '1.75rem' }}
                data-testid="tree-all-albums"
              >
                <span className="shrink-0 text-muted-foreground"><LayoutGrid className="w-3.5 h-3.5" /></span>
                <span className="text-xs font-medium text-foreground truncate flex-1">All albums</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{albums.length}</span>
              </div>
              {rootGroups.map((g) => renderGroupRow(g, 0))}
            </>
          )}
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      {/* RIGHT — content pane */}
      <ResizablePanel defaultSize={78} className="flex flex-col">
        {renderRightPane()}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
