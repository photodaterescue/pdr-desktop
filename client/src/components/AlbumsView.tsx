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

import { useEffect, useState, useCallback, useMemo, useRef, Fragment } from 'react';
import {
  ChevronDown, ChevronRight, ChevronLeft, FolderPlus, FolderClosed, FolderOpen,
  Trash2, Pencil, Plus, Check, X, Image as ImageIcon, RefreshCw,
  Sparkles, FileText, LayoutGrid, FolderMinus, Layers, GripVertical,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/custom-button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
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
  reorderAlbumGroups,
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
/** Section-card MIME — used when dragging the WHOLE "Album Sources"
 *  or "Folders" card to swap their on-screen order. Distinct from the
 *  row/album MIMEs so row-level handlers ignore it during dragOver. */
const DRAG_MIME_SECTION = 'application/x-pdr-section';
const EXPANDED_STORAGE_KEY = 'pdr-albums-expanded-groups';
const SECTION_ORDER_STORAGE_KEY = 'pdr-albums-section-order';

type SectionOrder = 'sources-first' | 'folders-first';
type SectionKind = 'sources' | 'folders';

type Selection =
  | { type: 'all' }
  | { type: 'group'; id: number }
  | { type: 'album'; id: number }
  | null;

/**
 * Build a lightweight floating drag-preview chip the browser uses
 * as the drag image (replaces the default semi-transparent clone of
 * the dragged row, which obscured the target row's text when the
 * cursor hovered a sibling — Terry 2026-05-18: "the words are
 * overlapping. This feels instinctively wrong"). Small lavender-
 * bordered pill matching PDR's --primary palette.
 *
 * The chip is mounted off-screen, snapshotted by the browser on
 * dragstart, then removed on the next tick. Caller positions it via
 * `e.dataTransfer.setDragImage(chip, 12, 8)` — the 12×8 offset puts
 * it down-right of the cursor so the target's name stays readable.
 *
 * Raw DOM (not JSX): `setDragImage` requires an element already in
 * the document — we can't render React inside the dragStart handler.
 */
function createDragPreviewChip(label: string, kind: 'folder' | 'album'): HTMLElement {
  const chip = document.createElement('div');
  chip.style.cssText = [
    'position: absolute',
    'top: -1000px',
    'left: -1000px',
    'pointer-events: none',
    'display: inline-flex',
    'align-items: center',
    'gap: 6px',
    'padding: 4px 10px',
    'background: var(--card, white)',
    'border: 1.5px solid var(--primary, #ad9eff)',
    'border-radius: 8px',
    'box-shadow: 0 4px 12px rgba(173, 158, 255, 0.35)',
    'font: 500 12px/1.4 var(--font-sans, system-ui, sans-serif)',
    'color: var(--foreground, #1a1a1a)',
    'white-space: nowrap',
    'max-width: 240px',
    'overflow: hidden',
    'text-overflow: ellipsis',
    'z-index: 99999',
  ].join('; ');
  const iconSvg = kind === 'folder'
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ad9eff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ad9eff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';
  const iconWrap = document.createElement('span');
  iconWrap.style.cssText = 'display: inline-flex; flex-shrink: 0';
  iconWrap.innerHTML = iconSvg;
  const textEl = document.createElement('span');
  textEl.textContent = label;
  chip.appendChild(iconWrap);
  chip.appendChild(textEl);
  document.body.appendChild(chip);
  // Remove on next tick — after the browser has snapshotted the
  // element for use as the drag image. The element is no longer
  // needed once the snapshot is taken; the drag preview follows the
  // cursor independently.
  setTimeout(() => { if (chip.parentNode) chip.parentNode.removeChild(chip); }, 0);
  return chip;
}

interface AlbumsViewProps {
  /** Optional header rendered at the very top of the LEFT pane,
   *  above the Albums toolbar. MemoriesPanel passes its "Memories"
   *  h1 + tab switcher here so the vertical divider between the
   *  tree and the right content extends all the way up to the
   *  title bar (Terry 2026-05-18: "The pencil bar should go all
   *  the way to the title bar also"). When undefined, the left
   *  pane starts with the Albums toolbar directly. */
  headerSlot?: React.ReactNode;
}

export default function AlbumsView({ headerSlot }: AlbumsViewProps = {}) {
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

  // Forward-only navigation history. Terry 2026-05-19: "the Go Back
  // button is confusing. I think what I actually wanted was a chevron
  // at the front to replace the album name that used to be there...
  // a chevron which if I click it, will take me forward to the one
  // last visited."
  //
  // Model (browser-style forward stack only — no separate back stack,
  // since "going back" is done by clicking earlier breadcrumb segments):
  //   navigateSelection(target)  — fresh navigation. Clears forward
  //                                 stack so previous-back history is
  //                                 abandoned (user moved sideways).
  //   navigateBackward(target)   — breadcrumb-segment click going UP
  //                                 the path. Pushes the CURRENT
  //                                 selection onto forwardStack so the
  //                                 user can return via chevron.
  //   goForward()                — pops forwardStack, sets selection.
  //                                 Used by the chevron(s) rendered at
  //                                 the front of the breadcrumb.
  const [forwardStack, setForwardStack] = useState<Selection[]>([]);
  const navigateSelection = useCallback((next: Selection) => {
    setSelection(prev => {
      if (prev !== null && JSON.stringify(prev) !== JSON.stringify(next)) {
        setForwardStack([]);
      }
      return next;
    });
  }, []);
  const navigateBackward = useCallback((target: Selection) => {
    setSelection(prev => {
      if (prev !== null && JSON.stringify(prev) !== JSON.stringify(target)) {
        setForwardStack(f => [...f, prev]);
      }
      return target;
    });
  }, []);
  const goForward = useCallback(() => {
    setForwardStack(prev => {
      if (prev.length === 0) return prev;
      const target = prev[prev.length - 1];
      setSelection(target);
      return prev.slice(0, -1);
    });
  }, []);

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
  /** Parent folder id when creating a sub-folder via the right-click
   *  "New sub-folder" context-menu action. NULL = creating at root via
   *  the toolbar "New folder" button. The same input flow handles
   *  both; the placeholder + on-submit call use this id. */
  const [subfolderParentId, setSubfolderParentId] = useState<number | null>(null);
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
  /** Where the drop will land relative to the hovered row:
   *   'above' = reorder the dragged folder ABOVE this row
   *   'below' = reorder the dragged folder BELOW this row
   *   'into'  = nest the dragged folder INSIDE this row (only if
   *             the target is a user folder that accepts drops)
   *   null    = no drag is hovering
   *  Set during dragOver based on Y position within the row. Drives
   *  both the indicator line (above/below) and the ring (into).
   *
   *  Mirrored in `dragOverPositionRef` so the drop handler can read
   *  the latest value synchronously even if React hasn't re-rendered
   *  between the last dragOver event and the drop, AND so a stray
   *  dragLeave clearing the state still leaves the ref intact for
   *  the drop dispatch. State drives the render; ref drives the
   *  drop logic. Without this split, drop was a no-op because
   *  `dragOverPosition` was sometimes null at the moment we read it
   *  inside handleGroupDrop. */
  const [dragOverPosition, setDragOverPosition] = useState<'above' | 'below' | 'into' | null>(null);
  const dragOverPositionRef = useRef<'above' | 'below' | 'into' | null>(null);
  const dragOverGroupIdRef = useRef<number | null>(null);
  /** ID of the item being dragged in the current session. Set in
   *  dragStart, cleared at the start of the next session. Lets
   *  handleGroupDragOver compute whether the cursor position would
   *  produce a no-op drop (same sibling position, same parent, etc.)
   *  — needed because the HTML5 drag API hides dataTransfer values
   *  outside of the drop event for security reasons, so we can't
   *  read what's being dragged from the event itself during hover. */
  const draggedFolderIdRef = useRef<number | null>(null);
  const draggedAlbumIdRef = useRef<number | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);

  // ── Section ordering (Sources / Folders cards) ────────────────────
  /** Order of the two section cards. Persisted in localStorage so the
   *  user's preference survives reloads. Default = sources-first
   *  (matches premium convention: sources at the top, user
   *  organisation below — Apple Photos / Lightroom / Google Photos). */
  const [sectionOrder, setSectionOrder] = useState<SectionOrder>(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SECTION_ORDER_STORAGE_KEY) : null;
      return raw === 'folders-first' ? 'folders-first' : 'sources-first';
    } catch { return 'sources-first'; }
  });
  const [draggedSection, setDraggedSection] = useState<SectionKind | null>(null);
  const [dragOverSection, setDragOverSection] = useState<SectionKind | null>(null);

  const handleSectionDragStart = useCallback((e: React.DragEvent, kind: SectionKind) => {
    e.dataTransfer.setData(DRAG_MIME_SECTION, kind);
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
    setDraggedSection(kind);
    // Custom drag preview chip — matches the row drag affordance so
    // section moves visually rhyme with row moves.
    const chip = createDragPreviewChip(kind === 'sources' ? 'Album Sources' : 'Folders', 'folder');
    e.dataTransfer.setDragImage(chip, 12, 8);
  }, []);
  const handleSectionDragOver = useCallback((e: React.DragEvent, kind: SectionKind) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME_SECTION)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverSection !== kind) setDragOverSection(kind);
  }, [dragOverSection]);
  const handleSectionDragLeave = useCallback((e: React.DragEvent, kind: SectionKind) => {
    const related = e.relatedTarget as Node | null;
    const current = e.currentTarget as HTMLElement;
    if (related && current.contains(related)) return;
    if (dragOverSection === kind) setDragOverSection(null);
  }, [dragOverSection]);
  const handleSectionDrop = useCallback((e: React.DragEvent, kind: SectionKind) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME_SECTION)) return;
    e.preventDefault();
    e.stopPropagation();
    const dragged = e.dataTransfer.getData(DRAG_MIME_SECTION) as SectionKind;
    setDraggedSection(null);
    setDragOverSection(null);
    if (!dragged || dragged === kind) return;
    // Only two sections — any cross-drop swaps the order.
    const next: SectionOrder = sectionOrder === 'sources-first' ? 'folders-first' : 'sources-first';
    setSectionOrder(next);
    try { localStorage.setItem(SECTION_ORDER_STORAGE_KEY, next); } catch {}
  }, [sectionOrder]);
  const handleSectionDragEnd = useCallback(() => {
    setDraggedSection(null);
    setDragOverSection(null);
  }, []);

  const handleAlbumDragStart = useCallback((e: React.DragEvent, albumId: number) => {
    e.dataTransfer.setData(DRAG_MIME_ALBUM, String(albumId));
    e.dataTransfer.effectAllowed = 'copyMove';
    // Replace the browser's default drag image (a semi-transparent
    // clone of the row that obscures the target's text when hovering
    // a sibling) with a small lavender chip showing the album name.
    // Offset (12, 8) puts the chip down-right of the cursor so the
    // target row text stays readable underneath.
    const album = albumsById.get(albumId);
    if (album) {
      const chip = createDragPreviewChip(album.title, 'album');
      e.dataTransfer.setDragImage(chip, 12, 8);
    }
    // Clear stale ref state from any previous drag — refs survive
    // dragLeave on purpose (so drop can read the last hover even if
    // the browser fired dragLeave before drop). Without this reset,
    // a fresh drag session could inherit the last session's target
    // group and silently dispatch to it on release.
    dragOverGroupIdRef.current = null;
    dragOverPositionRef.current = null;
    draggedAlbumIdRef.current = albumId;
    draggedFolderIdRef.current = null;
  }, [albumsById]);
  const handleFolderDragStart = useCallback((e: React.DragEvent, groupId: number) => {
    e.dataTransfer.setData(DRAG_MIME_FOLDER, String(groupId));
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
    // See handleAlbumDragStart — custom drag chip prevents the
    // dragged row name from overlapping the target row name during
    // hover.
    const group = groups.find((g) => g.id === groupId);
    if (group) {
      const chip = createDragPreviewChip(group.title, 'folder');
      e.dataTransfer.setDragImage(chip, 12, 8);
    }
    // See handleAlbumDragStart — reset refs at session start.
    dragOverGroupIdRef.current = null;
    dragOverPositionRef.current = null;
    draggedFolderIdRef.current = groupId;
    draggedAlbumIdRef.current = null;
  }, [groups]);
  const handleGroupDragOver = useCallback((e: React.DragEvent, group: AlbumGroupRecord) => {
    const hasAlbum = e.dataTransfer.types.includes(DRAG_MIME_ALBUM);
    const hasFolder = e.dataTransfer.types.includes(DRAG_MIME_FOLDER);
    if (!hasAlbum && !hasFolder) return;
    // Albums can only drop INTO user folders (nest = add membership);
    // they aren't reorderable in v2.0.8. Folders can drop above/below
    // any group (sibling reorder) AND into user folders (nest).
    if (hasAlbum && !isGroupDroppable(group)) return;
    // Y-position math: top 30% = drop above, bottom 30% = drop below,
    // middle 40% = nest into (only if target accepts nesting). When
    // the target doesn't accept nesting (auto group), the middle
    // band collapses to above/below based on side of centre. Mirrors
    // People Manager's drop-above pattern, extended to support
    // 'below' + 'into' for folder hierarchies.
    let position: 'above' | 'below' | 'into';
    if (hasAlbum) {
      position = 'into';
    } else {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const yRatio = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
      if (yRatio < 0.3) position = 'above';
      else if (yRatio > 0.7) position = 'below';
      else if (isGroupDroppable(group)) position = 'into';
      else position = yRatio < 0.5 ? 'above' : 'below';
    }
    // Cycle check (folder drags only). If the proposed drop would
    // nest a folder under its own descendant — directly via 'into',
    // or indirectly via the parent-realignment that 'above'/'below'
    // does to land the dragged folder beside the target — REFUSE
    // to be a drop target by skipping preventDefault(). The cursor
    // automatically shows "not allowed" and releasing here fires
    // no handler. This replaces the post-drop error toast with
    // hover-time visual feedback. Terry 2026-05-18: "the folder
    // you're trying to drop it into should be greyed out or
    // something so that no one is left thinking it can even be
    // dropped." Skip when target IS the dragged itself — the
    // no-op path further down handles that case gracefully and
    // we don't want the cursor flipping to not-allowed on the
    // user's own row.
    if (hasFolder) {
      const draggedId = draggedFolderIdRef.current;
      if (draggedId !== null && draggedId !== group.id) {
        const proposedNewParent = position === 'into' ? group.id : group.parent_id;
        if (proposedNewParent !== null) {
          let curId: number | null = proposedNewParent;
          const seen = new Set<number>();
          let isCycle = false;
          while (curId !== null && !seen.has(curId)) {
            if (curId === draggedId) { isCycle = true; break; }
            seen.add(curId);
            const g = groups.find((x) => x.id === curId);
            curId = g ? g.parent_id : null;
          }
          if (isCycle) {
            // Clear any highlight + ref that pointed at this row so
            // a stray drop bubble doesn't dispatch the move here.
            if (dragOverGroupId === group.id) {
              setDragOverGroupId(null);
              setDragOverPosition(null);
            }
            if (dragOverGroupIdRef.current === group.id) {
              dragOverGroupIdRef.current = null;
              dragOverPositionRef.current = null;
            }
            return;
          }
        }
      }
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = hasAlbum ? 'copy' : 'move';
    // No-op detection: suppress the visual indicator when the drop
    // would leave the dragged item in its current location. Three
    // cases qualify:
    //   1. Folder hovering its OWN row (any position)
    //   2. Folder 'into' a target that's already its parent
    //   3. Folder 'above'/'below' adjacent same-parent sibling that
    //      would produce the same sibling order (drop above the row
    //      directly after you, or below the row directly before you)
    //   4. Album dropping into a folder it's already a member of
    // Refs still set so the drop event routes correctly if it
    // bubbles — dispatchFolderDrop and addAlbumToGroup are idempotent
    // on no-ops. Terry 2026-05-18: "the horizontal line to indicate
    // dropping it in it's current location ... feels like you're
    // going to be making a change, but in fact you're not."
    let isNoOp = false;
    if (hasFolder) {
      const draggedId = draggedFolderIdRef.current;
      if (draggedId !== null) {
        if (draggedId === group.id) {
          isNoOp = true;
        } else {
          const draggedFolder = groups.find((g) => g.id === draggedId);
          if (draggedFolder) {
            if (position === 'into') {
              if (draggedFolder.parent_id === group.id) isNoOp = true;
            } else if (draggedFolder.parent_id === group.parent_id) {
              const siblings = groups
                .filter((g) => g.parent_id === group.parent_id)
                .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
              const draggedIdx = siblings.findIndex((s) => s.id === draggedId);
              const targetIdx = siblings.findIndex((s) => s.id === group.id);
              if (position === 'above' && draggedIdx === targetIdx - 1) isNoOp = true;
              if (position === 'below' && draggedIdx === targetIdx + 1) isNoOp = true;
            }
          }
        }
      }
    } else if (hasAlbum) {
      const draggedAlbumId = draggedAlbumIdRef.current;
      if (draggedAlbumId !== null && memberships.some((m) => m.album_id === draggedAlbumId && m.group_id === group.id)) {
        isNoOp = true;
      }
    }
    // Write to BOTH state (drives re-render of the indicator) and the
    // ref (latest-value source-of-truth for the drop handler). When
    // isNoOp, state stays cleared so no indicator shows; the refs
    // are still set so the drop routes to dispatchFolderDrop (which
    // silently no-ops itself, no DB write, no flicker).
    dragOverPositionRef.current = position;
    dragOverGroupIdRef.current = group.id;
    if (isNoOp) {
      if (dragOverGroupId !== null) setDragOverGroupId(null);
      if (dragOverPosition !== null) setDragOverPosition(null);
    } else {
      if (dragOverGroupId !== group.id) setDragOverGroupId(group.id);
      if (dragOverPosition !== position) setDragOverPosition(position);
    }
  }, [dragOverGroupId, dragOverPosition, groups, memberships]);
  const handleGroupDragLeave = useCallback((e: React.DragEvent, group: AlbumGroupRecord) => {
    const related = e.relatedTarget as Node | null;
    const current = e.currentTarget as HTMLElement;
    if (related && current.contains(related)) return;
    if (dragOverGroupId === group.id) {
      // Clear the VISUAL state but keep the ref intact — if a drop
      // is about to fire on this same row (HTML5 fires dragLeave
      // immediately before drop in some browsers), the drop handler
      // can still read the last-known position from the ref.
      setDragOverGroupId(null);
      setDragOverPosition(null);
    }
  }, [dragOverGroupId]);
  /** Folder-drop dispatcher shared between handleGroupDrop (row hit)
   *  and handleRootDrop (drop bubbled past an album row up to root).
   *  Branches on position:
   *    above/below → sibling reorder via reorderAlbumGroups, with a
   *                  pre-move to align parent_id if dragged is moving
   *                  between branches. moveAlbumGroup guards depth +
   *                  cycles + auto-immutable rules.
   *    into       → nest into target via moveAlbumGroup (only valid
   *                 if target accepts nesting). */
  const dispatchFolderDrop = useCallback(async (
    folderId: number,
    targetGroup: AlbumGroupRecord,
    position: 'above' | 'below' | 'into',
  ) => {
    if (folderId === targetGroup.id) return;

    if (position === 'above' || position === 'below') {
      const draggedFolder = groups.find((g) => g.id === folderId);
      if (!draggedFolder) return;
      const targetParentId = targetGroup.parent_id;
      if (draggedFolder.parent_id !== targetParentId) {
        const moveR = await moveAlbumGroup(folderId, targetParentId);
        if (!moveR.success) { toast.error(`Couldn't move folder`, { description: moveR.error }); return; }
      }
      const siblings = groups
        .filter((g) => g.parent_id === targetParentId)
        .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
      const filtered = siblings.filter((s) => s.id !== folderId);
      const targetIdx = filtered.findIndex((s) => s.id === targetGroup.id);
      if (targetIdx < 0) return;
      const insertIdx = position === 'above' ? targetIdx : targetIdx + 1;
      const newOrder = [...filtered.slice(0, insertIdx), draggedFolder, ...filtered.slice(insertIdx)].map((s) => s.id);
      const reorderR = await reorderAlbumGroups(newOrder);
      if (!reorderR.success) { toast.error(`Couldn't reorder`, { description: reorderR.error }); return; }
      await refreshAll();
      return;
    }

    // 'into' → nest into the target.
    if (!isGroupDroppable(targetGroup)) return;
    const r = await moveAlbumGroup(folderId, targetGroup.id);
    if (!r.success) { toast.error(`Couldn't move folder`, { description: r.error }); return; }
    // Silent on success — the folder visibly appears in its new
    // location, no toast needed. Terry 2026-05-18: "Don't people
    // just expect these folders and albums to move without a message
    // popping up telling them that it's moved?"
    await refreshAll();
  }, [groups, refreshAll]);

  const handleGroupDrop = useCallback(async (e: React.DragEvent, group: AlbumGroupRecord) => {
    // Read the latest position from the ref (survives any stray
    // dragLeave that fired between the last dragOver and the drop).
    const position = dragOverPositionRef.current ?? 'into';
    dragOverPositionRef.current = null;
    dragOverGroupIdRef.current = null;
    setDragOverGroupId(null);
    setDragOverPosition(null);
    e.preventDefault();
    e.stopPropagation();

    // Album drop → membership add (only into user folders, no reorder).
    const albumIdStr = e.dataTransfer.getData(DRAG_MIME_ALBUM);
    if (albumIdStr) {
      if (!isGroupDroppable(group)) return;
      const albumId = Number(albumIdStr);
      if (!Number.isFinite(albumId)) return;
      const r = await addAlbumToGroup(albumId, group.id);
      if (!r.success) { toast.error(`Couldn't add to "${group.title}"`, { description: r.error }); return; }
      // Silent on success (and silent if already a member — the
      // album is visibly in the folder either way). See the
      // dispatchFolderDrop comment for the rationale.
      await refreshAll();
      return;
    }

    // Folder drop → delegate to shared dispatcher.
    const folderIdStr = e.dataTransfer.getData(DRAG_MIME_FOLDER);
    if (!folderIdStr) return;
    const folderId = Number(folderIdStr);
    if (!Number.isFinite(folderId)) return;
    await dispatchFolderDrop(folderId, group, position);
  }, [albumsById, dispatchFolderDrop, refreshAll]);
  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME_FOLDER)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragOverRoot) setDragOverRoot(true);
    // If the event originated on the root container ITSELF (cursor
    // is over genuinely-empty padding, not bubbled up from a child
    // row), clear any stale group-row hover refs. This way a drop
    // in real empty space dispatches to "move to root" rather than
    // being mis-routed to the last-hovered group row. The check
    // `e.target === e.currentTarget` distinguishes "originated here"
    // from "bubbled from a descendant."
    if (e.target === e.currentTarget) {
      dragOverGroupIdRef.current = null;
      dragOverPositionRef.current = null;
      if (dragOverGroupId !== null) setDragOverGroupId(null);
      if (dragOverPosition !== null) setDragOverPosition(null);
    }
  }, [dragOverRoot, dragOverGroupId, dragOverPosition]);
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

    // Drop bubbled up to root. If the user's last hover was on a
    // group row (cursor passed over an album leaf at the moment of
    // release — album leaves have no drop handler, so the drop
    // event bubbled past them), dispatch to that group's logic
    // instead of dumping the folder at root. Without this, drag-
    // reorder fails whenever the cursor crosses a child album row
    // at release time.
    const targetGroupId = dragOverGroupIdRef.current;
    const targetPosition = dragOverPositionRef.current;
    dragOverGroupIdRef.current = null;
    dragOverPositionRef.current = null;
    setDragOverGroupId(null);
    setDragOverPosition(null);

    if (targetGroupId !== null && targetPosition !== null) {
      const targetGroup = groups.find((g) => g.id === targetGroupId);
      if (targetGroup) {
        await dispatchFolderDrop(folderId, targetGroup, targetPosition);
        return;
      }
    }

    // True empty-space drop → move folder to root.
    const r = await moveAlbumGroup(folderId, null);
    if (!r.success) { toast.error(`Couldn't move folder to root`, { description: r.error }); return; }
    // Silent on success — the folder visibly returns to root.
    await refreshAll();
  }, [dispatchFolderDrop, groups, refreshAll]);

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
    const r = await createAlbumGroup(title, subfolderParentId);
    if (r.success) {
      setNewFolderTitle('');
      setCreatingFolder(false);
      setSubfolderParentId(null);
      await refreshAll();
    }
  };
  /** Cancel the create-folder flow + reset the sub-folder parent so the
   *  next "New folder" toolbar click starts at root again. */
  const cancelCreateFolder = () => {
    setCreatingFolder(false);
    setNewFolderTitle('');
    setSubfolderParentId(null);
  };
  /** Start a sub-folder create flow for `group`. Called from the
   *  right-click context menu's "New sub-folder" entry. The shared
   *  toolbar input becomes the entry surface; on submit the new folder
   *  lands inside `group`. */
  const startSubfolderCreate = (group: AlbumGroupRecord) => {
    setSubfolderParentId(group.id);
    setNewFolderTitle('');
    setCreatingFolder(true);
    // Expand the parent so the user sees the new sub-folder appear.
    if (!expandedGroups.has(group.id)) {
      const next = new Set(expandedGroups);
      next.add(group.id);
      setExpandedGroups(next);
      persistExpanded(next);
    }
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
        <ContextMenu>
          <ContextMenuTrigger asChild>
        <div
          className={`flex items-center gap-2 pr-2 py-1 rounded-md transition-colors cursor-pointer ${
            isSelected ? 'bg-primary/15 text-foreground' : 'hover:bg-muted/40'
          }`}
          style={{ paddingLeft: `${depth * 1.25 + 1.5}rem` }}
          onClick={() => { if (!isRenaming) navigateSelection({ type: 'album', id: album.id }); }}
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
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => navigateSelection({ type: 'album', id: album.id })}>
              <ImageIcon className="w-3.5 h-3.5 mr-2" />
              Open
            </ContextMenuItem>
            {album.source === 'user_created' && (
              <ContextMenuItem onSelect={() => { setRenamingAlbumId(album.id); setRenameAlbumTitle(album.title); }}>
                <Pencil className="w-3.5 h-3.5 mr-2" />
                Rename
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            {isInUserFolder && parentGroup ? (
              /* In a user folder: remove the link only, never delete
                 the album record. Membership-delete. */
              <ContextMenuItem onSelect={() => handleRemoveFromFolder(album.id, parentGroup.id, album.title, parentGroup.title)}>
                <FolderMinus className="w-3.5 h-3.5 mr-2" />
                Remove from "{parentGroup.title}"
              </ContextMenuItem>
            ) : album.source === 'user_created' && (
              /* In the source group: full album delete with confirm.
                 Only available for user_created; takeout albums are
                 source-immutable so this item is hidden for them. */
              <ContextMenuItem
                onSelect={() => handleDeleteAlbum(album.id, album.title)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" />
                Delete album
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
      </div>
    );
  };

  const renderGroupRow = (group: AlbumGroupRecord, depth: number): JSX.Element => {
    const profile = getSourceProfileForGroup(group);
    const isExpanded = expandedGroups.has(group.id);
    const isUser = group.source_kind === 'user';
    const isSelected = selection?.type === 'group' && selection.id === group.id;
    const isRenaming = renamingGroupId === group.id;
    // 'into' nest-style highlight only fires when the cursor is in
    // the row's middle band AND the target accepts nesting. The
    // above/below indicators are separate <div> overlays rendered
    // below.
    const isNestHighlight = dragOverGroupId === group.id && dragOverPosition === 'into';
    // Folder icon swaps to OPEN when the row is the active drop
    // target (in addition to when it's expanded). Signals "I'm
    // opening to receive the drop" — borrowed from OS file managers.
    const Icon = group.source_kind === 'auto'
      ? profile.Icon
      : ((isExpanded || isNestHighlight) ? FolderOpen : FolderClosed);
    const showAboveIndicator = dragOverGroupId === group.id && dragOverPosition === 'above';
    const showBelowIndicator = dragOverGroupId === group.id && dragOverPosition === 'below';
    const childGroupList = childGroups.get(group.id) ?? [];
    const albumIdList = albumIdsByGroup.get(group.id) ?? [];
    const totalCount = albumIdList.length + childGroupList.length;

    // Right-click context menu items vary by group kind. Auto groups
    // (source-managed: PDR, Google Photos) get nothing actionable —
    // they aren't renamable, deletable, or sub-folder-receivable.
    // User folders get the full create/rename/delete kit. Depth-1
    // folders skip the "New sub-folder" entry (USER_GROUP_MAX_DEPTH).
    const canHaveSubfolders = isUser && depth === 0;
    return (
      <div key={`group-${group.id}`} className="group/row">
        <ContextMenu>
          <ContextMenuTrigger asChild>
        <div
          className={`relative flex items-center gap-1.5 pr-2 py-1 rounded-md transition-all cursor-pointer ${
            isNestHighlight ? 'bg-primary/20 ring-2 ring-primary shadow-sm' : (isSelected ? 'bg-primary/15' : 'hover:bg-muted/40')
          } ${isUser ? 'cursor-grab active:cursor-grabbing' : ''}`}
          style={{ paddingLeft: `${depth * 1.25 + 0.25}rem` }}
          onClick={() => { if (!isRenaming) navigateSelection({ type: 'group', id: group.id }); }}
          draggable={(isUser || group.source_kind === 'auto') && !isRenaming}
          onDragStart={(isUser || group.source_kind === 'auto') ? (e) => handleFolderDragStart(e, group.id) : undefined}
          // Drag handlers always attached so EVERY group row is a
          // potential drop target — at minimum for above/below
          // sibling reorder. The handlers themselves filter what
          // actions are valid (nest only into user folders, etc.).
          onDragOver={(e) => handleGroupDragOver(e, group)}
          onDragLeave={(e) => handleGroupDragLeave(e, group)}
          onDrop={(e) => handleGroupDrop(e, group)}
          data-testid={`tree-group-${group.id}`}
        >
          {/* "Above" indicator — pinned to the row's top edge. Mirrors
              the People Manager Unnamed-tab drop-above pattern. The
              "below" indicator lives OUTSIDE this row div (rendered
              after the row's expanded children) so it sits between
              this group's subtree and the next sibling visually, not
              between the row and its first child album. Terry
              2026-05-18: "the horizontal line should only appear
              above and below an album source... and not between
              it's albums." */}
          {showAboveIndicator && (
            <div className="absolute -top-px left-2 right-2 h-0.5 bg-primary rounded-full pointer-events-none shadow-[0_0_4px_var(--tw-shadow-color)] shadow-primary/40" />
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleGroupExpanded(group.id); }}
            className="shrink-0 text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
          <span className={`shrink-0 transition-colors ${isNestHighlight ? 'text-primary' : profile.iconColorClass}`}><Icon className="w-3.5 h-3.5" /></span>
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
          </ContextMenuTrigger>
          {isUser ? (
            <ContextMenuContent>
              {canHaveSubfolders && (
                <>
                  <ContextMenuItem onSelect={() => startSubfolderCreate(group)}>
                    <FolderPlus className="w-3.5 h-3.5 mr-2" />
                    New sub-folder
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem onSelect={() => { setRenamingGroupId(group.id); setRenameGroupTitle(group.title); }}>
                <Pencil className="w-3.5 h-3.5 mr-2" />
                Rename
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => handleDeleteFolder(group.id, group.title)} className="text-destructive focus:text-destructive">
                <Trash2 className="w-3.5 h-3.5 mr-2" />
                Delete folder
              </ContextMenuItem>
            </ContextMenuContent>
          ) : (
            /* Auto groups (PDR / Google Photos / future iCloud etc.):
               not renamable, not deletable, can't host sub-folders.
               One useful action — refresh — for symmetry with the
               toolbar refresh button. */
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => refreshAll()}>
                <RefreshCw className="w-3.5 h-3.5 mr-2" />
                Refresh
              </ContextMenuItem>
            </ContextMenuContent>
          )}
        </ContextMenu>
        {isExpanded && (
          <>
            {childGroupList.map((child) => renderGroupRow(child, depth + 1))}
            {albumIdList.map((id) => {
              const a = albumsById.get(id);
              return a ? renderAlbumLeaf(a, depth + 1, group.id) : null;
            })}
          </>
        )}
        {/* "Below" indicator — sits AFTER the row's expanded children
            (or directly under the row if collapsed). When PDR is
            expanded and the user is dropping AFTER PDR, the line
            lands between PDR's last child and the next sibling group
            (e.g. Google Photos), not between the PDR row and its
            first child. Same palette + shadow as the "above" line
            inside the row. */}
        {showBelowIndicator && (
          <div className="h-0.5 mx-2 my-px bg-primary rounded-full pointer-events-none shadow-[0_0_4px_var(--tw-shadow-color)] shadow-primary/40" />
        )}
      </div>
    );
  };

  const rootGroups = childGroups.get(null) ?? [];
  // Split root groups by source_kind so we can render each zone as
  // its own brand-tinted card (Sources = lavender, Folders = gold).
  // Premium pattern: source identity stays at top-level navigation,
  // user organisation lives in its own zone — matches Apple Photos /
  // Lightroom / Google Photos sidebar conventions. Order between
  // the two cards is user-swappable via drag (sectionOrder state).
  const autoRootGroups = rootGroups.filter((g) => g.source_kind === 'auto');
  const userRootGroups = rootGroups.filter((g) => g.source_kind === 'user');

  const renderSectionCard = (kind: SectionKind): JSX.Element => {
    const isSources = kind === 'sources';
    const groupsForCard = isSources ? autoRootGroups : userRootGroups;
    const isDragging = draggedSection === kind;
    const isDropTarget = dragOverSection === kind && draggedSection !== null && draggedSection !== kind;

    // Brand-tinted card surface (Terry 2026-05-18: "should look
    // almost like cards and have the PDR brand colours very faintly,
    // one lavender and the other is brand orange/gold").
    //   Sources → --primary lavender at 5–10% opacity
    //   Folders → --color-gold (#f8c15c) at 10–15% opacity
    // Hex arbitrary values per feedback_tailwind_v4_pale_palette
    // (Tailwind v4's oklch palette is paler than v3 — chip tints use
    // hex for predictability).
    const cardClass = isSources
      ? 'bg-primary/5 border-primary/30'
      : 'bg-[#f8c15c]/10 border-[#f8c15c]/40';
    const dropRingClass = isSources
      ? 'ring-2 ring-primary bg-primary/15'
      : 'ring-2 ring-[#f8c15c] bg-[#f8c15c]/20';
    const headerIconColor = isSources ? 'text-primary' : 'text-[#a16207]';
    const HeaderIcon = isSources ? Layers : FolderClosed;
    const headerLabel = isSources ? 'Album Sources' : 'Folders';
    const emptyMessage = isSources
      ? 'No sources yet. Run Fix on a Google Photos Takeout, or create an album here, to populate this zone.'
      : 'No folders yet. Use "New folder" above to start organising your albums.';

    return (
      <div
        key={`section-${kind}`}
        onDragOver={(e) => handleSectionDragOver(e, kind)}
        onDragLeave={(e) => handleSectionDragLeave(e, kind)}
        onDrop={(e) => handleSectionDrop(e, kind)}
        className={`rounded-lg border p-1.5 transition-all ${cardClass} ${isDropTarget ? dropRingClass : ''} ${isDragging ? 'opacity-50' : ''}`}
        data-testid={`section-${kind}`}
      >
        <div
          draggable
          onDragStart={(e) => handleSectionDragStart(e, kind)}
          onDragEnd={handleSectionDragEnd}
          className="flex items-center gap-1.5 px-1.5 py-1 cursor-grab active:cursor-grabbing select-none"
        >
          <IconTooltip content="Drag to swap section order">
            <span className="inline-flex items-center gap-1.5">
              <GripVertical className={`w-3 h-3 opacity-60 ${headerIconColor}`} />
              <HeaderIcon className={`w-3 h-3 ${headerIconColor}`} />
              <span className={`text-[10px] font-semibold uppercase tracking-wider ${headerIconColor}`}>
                {headerLabel}
              </span>
            </span>
          </IconTooltip>
        </div>
        {groupsForCard.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic px-2 py-1">{emptyMessage}</p>
        ) : (
          groupsForCard.map((g) => renderGroupRow(g, 0))
        )}
      </div>
    );
  };

  // ─────────────────────────────────────────────────────────────────
  // Right-pane content
  // ─────────────────────────────────────────────────────────────────

  const selectedAlbum = selection?.type === 'album' ? (albumsById.get(selection.id) ?? null) : null;
  const selectedGroup = selection?.type === 'group' ? (groups.find((g) => g.id === selection.id) ?? null) : null;
  const selectedGroupAlbumIds = selectedGroup ? (albumIdsByGroup.get(selectedGroup.id) ?? []) : [];

  // ── Breadcrumb ───────────────────────────────────────────────────
  // Derives a clickable path from the current selection. Album drills
  // through its first membership's group chain; group walks its own
  // parent_id chain. Every level is clickable for direct jumps. Going
  // UP the path uses navigateBackward (preserves forwardStack so the
  // chevron at the front lets the user re-enter the level they just
  // backed out of). Terry 2026-05-19: "There should be a file path
  // that's clickable to go back to different levels".
  type BreadcrumbSegment =
    | { kind: 'all'; label: 'All albums' }
    | { kind: 'group'; id: number; label: string }
    | { kind: 'album'; id: number; label: string };

  const breadcrumb = useMemo<BreadcrumbSegment[]>(() => {
    const segs: BreadcrumbSegment[] = [{ kind: 'all', label: 'All albums' }];
    if (!selection || selection.type === 'all') return segs;

    const walkGroupChain = (startId: number): AlbumGroupRecord[] => {
      const chain: AlbumGroupRecord[] = [];
      let curId: number | null = startId;
      const seen = new Set<number>();
      while (curId !== null && !seen.has(curId)) {
        seen.add(curId);
        const g = groups.find(x => x.id === curId);
        if (!g) break;
        chain.unshift(g);
        curId = g.parent_id;
      }
      return chain;
    };

    if (selection.type === 'group') {
      for (const g of walkGroupChain(selection.id)) {
        segs.push({ kind: 'group', id: g.id, label: g.title });
      }
      return segs;
    }
    if (selection.type === 'album') {
      const album = albumsById.get(selection.id);
      if (!album) return segs;
      const memb = memberships.find(m => m.album_id === selection.id);
      if (memb) {
        for (const g of walkGroupChain(memb.group_id)) {
          segs.push({ kind: 'group', id: g.id, label: g.title });
        }
      }
      segs.push({ kind: 'album', id: album.id, label: album.title });
    }
    return segs;
  }, [selection, groups, memberships, albumsById]);

  const renderBreadcrumb = () => {
    // Forward chevrons rendered at the FRONT (left) of the breadcrumb
    // when the user has clicked an earlier breadcrumb segment to back
    // out of a deeper selection. Each chevron represents one level
    // available to re-enter; clicking advances ONE step forward.
    // Capped at 3 visible chevrons for visual sanity — extra steps
    // still navigable by clicking repeatedly. Terry 2026-05-19: "If
    // there happens to be 2 levels gone back, then there should be
    // two chevrons indicating to go forward to the most recent
    // visited."
    const visibleForwardChevrons = Math.min(forwardStack.length, 3);
    const forwardLabel =
      forwardStack.length === 0
        ? null
        : forwardStack.length === 1
          ? 'Go forward'
          : `Go forward (1 of ${forwardStack.length})`;
    return (
      <div className="flex items-center gap-1 text-xs px-6 py-1.5 border-b border-border/60 bg-background/40">
        {forwardStack.length > 0 && (
          <IconTooltip content={forwardLabel ?? ''}>
            <button
              type="button"
              onClick={goForward}
              className="inline-flex items-center px-1 py-0.5 rounded text-primary hover:bg-primary/10 transition-colors"
              data-testid="button-breadcrumb-forward"
            >
              {Array.from({ length: visibleForwardChevrons }).map((_, i) => (
                <ChevronRight key={i} className="w-3.5 h-3.5 -mx-1" />
              ))}
              {forwardStack.length > 3 && (
                <span className="ml-1 text-[10px] font-medium">+{forwardStack.length - 3}</span>
              )}
            </button>
          </IconTooltip>
        )}
        {breadcrumb.map((seg, i) => {
          const isLast = i === breadcrumb.length - 1;
          return (
            <Fragment key={`${seg.kind}-${seg.kind === 'all' ? 'all' : seg.id}`}>
              {i > 0 && <ChevronRight className="w-3 h-3 text-muted-foreground/60 shrink-0" />}
              <button
                type="button"
                onClick={() => {
                  if (isLast) return;
                  // Breadcrumb segment clicks navigate UP the path —
                  // use navigateBackward so the current selection
                  // joins forwardStack (chevrons let user re-enter).
                  if (seg.kind === 'all') navigateBackward({ type: 'all' });
                  else if (seg.kind === 'group') navigateBackward({ type: 'group', id: seg.id });
                  else navigateBackward({ type: 'album', id: seg.id });
                }}
                disabled={isLast}
                className={`px-1.5 py-0.5 rounded transition-colors truncate max-w-[200px] ${
                  isLast
                    ? 'text-foreground font-medium cursor-default'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/40 cursor-pointer'
                }`}
                data-testid={`breadcrumb-${seg.kind}-${seg.kind === 'all' ? 'all' : seg.id}`}
              >
                {seg.label}
              </button>
            </Fragment>
          );
        })}
      </div>
    );
  };

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
          {renderBreadcrumb()}
          <div className="flex items-center gap-3 px-6 py-3 border-b border-border">
            <h2 className="text-lg font-medium text-foreground truncate">All albums</h2>
            <span className="text-xs text-muted-foreground">{allSorted.length} album{allSorted.length === 1 ? '' : 's'}</span>
          </div>
          <div className="flex-1 overflow-y-auto px-6 pt-3 pb-4">
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
                      onClick={() => navigateSelection({ type: 'album', id: album.id })}
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
          {renderBreadcrumb()}
          <div className="flex items-center gap-3 px-6 py-3 border-b border-border">
            <span className={profile.iconColorClass}><Icon className="w-5 h-5" /></span>
            <h2 className="text-lg font-medium text-foreground truncate">{selectedGroup.title}</h2>
            <span className="text-xs text-muted-foreground">{selectedGroupAlbumIds.length} album{selectedGroupAlbumIds.length === 1 ? '' : 's'}</span>
          </div>
          <div className="flex-1 overflow-y-auto px-6 pt-3 pb-4">
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
                      onClick={() => navigateSelection({ type: 'album', id: album.id })}
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
      const isHeaderRenaming = renamingAlbumId === selectedAlbum.id;
      return (
        <div className="flex flex-col h-full group/album-header">
          {renderBreadcrumb()}
          <div className="flex items-center gap-3 px-6 py-3 border-b border-border">
            <span className={getSourceProfileForAlbum(selectedAlbum).iconColorClass}>
              {(() => {
                const I = getSourceProfileForAlbum(selectedAlbum).Icon;
                return <I className="w-5 h-5" />;
              })()}
            </span>
            {isHeaderRenaming ? (
              /* Inline rename input in the header — same renamingAlbumId
                 state as the tree row, so the user can drive the rename
                 from either surface. Terry 2026-05-18: "There should be
                 the ability to rename to album up here". */
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                <input
                  value={renameAlbumTitle}
                  onChange={(e) => setRenameAlbumTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleRenameAlbum(); }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenamingAlbumId(null); setRenameAlbumTitle(''); }
                  }}
                  autoFocus
                  className="px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-base flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-primary"
                  data-testid="input-rename-album-header"
                />
                <Button variant="primary" size="sm" onClick={handleRenameAlbum} className="px-2 py-1 h-auto">
                  <Check className="w-3.5 h-3.5" />
                </Button>
                <Button variant="secondary" size="sm" onClick={() => { setRenamingAlbumId(null); setRenameAlbumTitle(''); }} className="px-2 py-1 h-auto">
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            ) : (
              <>
                <h2 className="text-lg font-medium text-foreground truncate">{selectedAlbum.title}</h2>
                {selectedAlbum.source === 'user_created' && (
                  <IconTooltip content="Rename album">
                    <button
                      type="button"
                      onClick={() => { setRenamingAlbumId(selectedAlbum.id); setRenameAlbumTitle(selectedAlbum.title); }}
                      className="opacity-0 group-hover/album-header:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted/50"
                      data-testid="button-rename-album-header"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </IconTooltip>
                )}
                <span className="text-xs text-muted-foreground">{selectedAlbum.photoCount} photo{selectedAlbum.photoCount === 1 ? '' : 's'}</span>
                {selectedAlbum.source === 'takeout_imported' && (
                  <span className="text-xs text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full shrink-0">From Google Takeout</span>
                )}
              </>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-6 pt-3 pb-4">
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
        {/* MemoriesPanel-supplied header (Memories h1 + tab switcher).
            Rendered INSIDE the left pane so the vertical divider
            between this pane and the right content runs all the
            way to the title bar. */}
        {headerSlot}
        <div className="px-4 pt-4 pb-2">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-base font-medium text-foreground">Albums</h2>
            {!loading && albums.length > 0 && (
              <span className="text-xs text-muted-foreground">{albums.length} album{albums.length === 1 ? '' : 's'}</span>
            )}
            {/* Refresh sits right next to the count — static cluster.
                No `ml-auto` so widening the pencil bar doesn't push it
                to the right edge (Terry 2026-05-18: "should remain
                static"). */}
            <IconTooltip content="Refresh albums">
              <Button variant="secondary" size="sm" onClick={() => refreshAll()} disabled={loading} className="px-1.5 py-0.5 h-auto" data-testid="button-refresh-albums">
                <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </IconTooltip>
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
                // outline-pulse animation matches the Workspace's "Add
                // Source" pulse pattern so the user knows the input
                // wants their attention (Terry 2026-05-18: "I didn't
                // realise I had to do something in there before"). The
                // pulse stops once a value's been typed so it doesn't
                // distract from the user actually composing the name.
                style={!newAlbumTitle ? { animation: 'outline-pulse 2s ease-in-out infinite' } : undefined}
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
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelCreateFolder(); }
                }}
                placeholder={subfolderParentId !== null
                  ? `Sub-folder in "${groups.find((g) => g.id === subfolderParentId)?.title ?? 'folder'}"`
                  : 'Folder name'}
                autoFocus
                className="px-2 py-1 rounded-md border border-border bg-background text-foreground text-xs flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="input-new-folder-title"
                style={!newFolderTitle ? { animation: 'outline-pulse 2s ease-in-out infinite' } : undefined}
              />
              <Button variant="primary" size="sm" onClick={handleCreateFolder} disabled={!newFolderTitle.trim()} className="px-2 py-1 h-auto">
                <Check className="w-3.5 h-3.5" />
              </Button>
              <Button variant="secondary" size="sm" onClick={cancelCreateFolder} className="px-2 py-1 h-auto">
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              {/* Compact pills hugging their content. No `flex-1` so
                  widening the pencil bar doesn't stretch them into
                  long lavender bars — they stay static next to each
                  other on the left of the toolbar (Terry 2026-05-18:
                  "they... shouldn't move when the pencil bar does"). */}
              <Button variant="secondary" size="sm" onClick={() => setCreatingFolder(true)} className="gap-1 px-3 py-1 h-auto text-xs" data-testid="button-create-folder">
                <FolderClosed className="w-3.5 h-3.5" />
                New folder
              </Button>
              <Button variant="primary" size="sm" onClick={() => setCreatingAlbum(true)} className="gap-1 px-3 py-1 h-auto text-xs" data-testid="button-create-album">
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
              {/* "All albums" virtual row — sits above the section
                  cards and selects the "show every album" view in
                  the right pane. Not backed by an album_groups row;
                  pure client-side virtual node. */}
              <div
                onClick={() => navigateSelection({ type: 'all' })}
                className={`flex items-center gap-1.5 pr-2 py-1 mb-2 rounded-md transition-colors cursor-pointer ${
                  selection?.type === 'all' ? 'bg-primary/15' : 'hover:bg-muted/40'
                }`}
                style={{ paddingLeft: '1.75rem' }}
                data-testid="tree-all-albums"
              >
                <span className="shrink-0 text-muted-foreground"><LayoutGrid className="w-3.5 h-3.5" /></span>
                <span className="text-xs font-medium text-foreground truncate flex-1">All albums</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{albums.length}</span>
              </div>
              {/* Section cards — order swappable via dragging either
                  section's header onto the other. Premium pattern:
                  sources zone (lavender) + folders zone (gold), each
                  in its own brand-tinted card. */}
              <div className="space-y-2">
                {(sectionOrder === 'sources-first'
                  ? (['sources', 'folders'] as const)
                  : (['folders', 'sources'] as const)
                ).map((kind) => renderSectionCard(kind))}
              </div>
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
