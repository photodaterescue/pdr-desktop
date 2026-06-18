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
  Sparkles, FileText, LayoutGrid, FolderMinus, Layers, GripVertical, Copy, Smartphone, Printer,
  CalendarRange, Search as SearchIcon, Images, Undo2, Redo2,
  ZoomIn, ZoomOut, RotateCcw, MessageSquareText, Star, HardDrive,
  Captions, Info, Eye, Filter, Film, Files,
  // v2.1 round 275 (Terry) — icons for the new multi-select Actions
  // toolbar ported from MemoriesView (Dates). ChevronDown + FolderPlus
  // already imported above; PlayCircle is new (Open-in-viewer item).
  PlayCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/custom-button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
// v2.1 round 277 (Terry) — Sharing Phase 1: shared multi-file OS drag helper.
import { startFileDrag } from '@/lib/os-file-drag';
import { useCopyFilesHotkey } from '@/lib/useCopyFilesHotkey';
// v2.1 round 275 (Terry) — Actions dropdown for the Albums multi-select
// toolbar (parity with Dates). Same primitives MemoriesView uses.
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { usePopoverGraceClose } from '@/hooks/usePopoverGraceClose';
import AddToAlbumPopover from './AddToAlbumPopover';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import ParallelStructureModal from '@/components/ParallelStructureModal';
import { useFixInProgress, FIX_BLOCKED_TOOLTIP } from '@/lib/fix-state';
import { DensityToggle, type Density } from '@/components/ui/density-toggle';
import { consumePendingAlbumOpen } from '@/lib/album-return-source';
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
  setAlbumCoverPhoto,
  openCollageComposer,
  // v2.1 round 275 (Terry) — recycle handler for the new Albums
  // multi-select toolbar + per-photo menu (parity with Dates).
  moveToRecycleBin,
  type AlbumSummary,
  type AlbumGroupRecord,
  type AlbumGroupMembershipRecord,
  type IndexedFile,
} from '../lib/electron-bridge';
import { promptConfirm } from './trees/promptConfirm';
import { editPhotoCaption } from '@/lib/caption-actions';
import { useTranscribeVideos } from '@/hooks/useTranscribeVideos';
import { useTranscribedFileIds } from '@/hooks/useTranscribedFileIds';
import { TranscriptBadge } from '@/components/TranscriptBadge';

// v2.1 round 35 (Terry 2026-06-08) — extension-based video detector
// for the right-click Transcribe item. AlbumsView's photo objects
// don't carry file_type the way MemoriesView's do; the path's ext
// is the cheapest reliable signal. Matches the VIDEO_EXTS set in
// the main process / viewer.html so behaviour is consistent.
const VIDEO_EXT_RE = /\.(mp4|mov|webm|avi|mkv|m4v|wmv|flv|3gp|3g2|ogv|mts|m2ts|ts)$/i;
function isVideoPathExt(fp: string): boolean { return VIDEO_EXT_RE.test(fp || ''); }
import { CaptionBadge } from '@/components/CaptionBadge';
import { CaptionTooltip } from '@/components/ui/caption-tooltip';
import {
  getSourceProfileForGroup,
  getSourceProfileForAlbum,
  isGroupDroppable,
} from '../lib/albumSourceProfile';

const DRAG_MIME_ALBUM = 'application/x-pdr-album-id';
const DRAG_MIME_FOLDER = 'application/x-pdr-folder-id';
/** Carries the source group id (where the dragged album was
 *  picked up FROM) so the drop handler can decide between move
 *  semantics (user folder → user folder = move) and copy
 *  semantics (auto group → anywhere, or CTRL-held). v2.0.8 step
 *  6 (Terry 2026-05-19). */
const DRAG_MIME_ALBUM_SOURCE_GROUP = 'application/x-pdr-album-source-group-id';
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

  // v2.0.14 (Terry 2026-05-28) — refresh on rotate. The viewer's
  // setRotation broadcasts pdr:rotationChanged to all renderers; we
  // drop the stale cached thumb and re-fetch so the album cover and
  // photo tiles update without the user having to navigate away.
  // The disk thumb-cache key now includes user_rotation so the
  // refetch lands on a fresh entry.
  useEffect(() => {
    const off = (window as any).pdr?.viewer?.onRotationChanged?.((data: { filePath: string; rotation: number }) => {
      const fp = data?.filePath;
      if (!fp) return;
      setThumbs((prev) => {
        if (!prev[fp]) return prev;
        const { [fp]: _, ...rest } = prev;
        return rest;
      });
      // AlbumsView fetches album-cover + per-photo tiles both at 200.
      getThumbnail(fp, 200).then((r) => {
        if (r.success && r.dataUrl) {
          setThumbs((prev) => ({ ...prev, [fp]: r.dataUrl }));
        }
      });
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // ── Selection (drives the right pane) ────────────────────────────
  // Default selection is the "All albums" virtual row so opening
  // Memories → Albums lands on a useful surface (the All-albums
  // grid) AND the tree's "All albums" row is highlighted from
  // the first paint. Pre-fix the user landed with `selection: null`
  // — the grid still rendered (the right-pane fallback covers
  // `!selection`), but the tree showed no highlight, which meant
  // Ctrl+wheel zoom didn't visually associate with anything until
  // they manually clicked into a row. Terry 2026-05-19: "it should
  // automatically have All Albums highlighted, because I keep
  // wanting to change the zoom by using my mouse when I enter."
  // v2.0.15 (Terry 2026-06-02) — read the back-pill album latch at
  // useState init time so the very first render lands on the right
  // album. The previous useEffect-based consume approach was missing
  // the historical event (AlbumsView mounts AFTER the back-pill click
  // dispatches `pdr:openAlbumsAlbum`) and the mount-effect consume
  // was returning null intermittently across remount cycles.
  // useState(init) runs synchronously during the very first
  // construction, BEFORE any effects, so the localStorage read can
  // never race the click. removeItem clears it so a stale value
  // can't hijack a future mount.
  const [selection, setSelection] = useState<Selection>(() => {
    try {
      const raw = localStorage.getItem('pdr-albums-pending-open');
      if (raw) {
        localStorage.removeItem('pdr-albums-pending-open');
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed)) return { type: 'album', id: parsed };
      }
    } catch { /* localStorage may be unavailable */ }
    return { type: 'all' };
  });
  const [albumPhotos, setAlbumPhotos] = useState<IndexedFile[]>([]);
  // v2.1 round 275 (Terry) — bump to re-run the album-photos loader for the SAME album (e.g.
  // after Move to Recycle Bin) so deleted tiles vanish. Declared HERE (not with the other
  // round-275 state further down) because the loader effect lists it in its dependency array,
  // which is evaluated at render BEFORE that lower block — declaring it there hit a TDZ
  // ("Cannot access … before initialization") that blanked the Albums view.
  const [albumPhotosRefreshTick, setAlbumPhotosRefreshTick] = useState(0);
  const [albumPhotosLoading, setAlbumPhotosLoading] = useState(false);
  // v2.0.13 (Terry 2026-05-27) — "Captioned only" filter. Narrows the
  // album's photo grid to just the rows whose indexed_files.caption is
  // non-empty. Toggled per-album via a header button; resets to OFF
  // whenever the user navigates to a different album so a niche
  // filter doesn't silently follow them around the library.
  const [captionedOnly, setCaptionedOnly] = useState(false);
  useEffect(() => { setCaptionedOnly(false); }, [selection]);

  // v2.1 round 102 (Terry 2026-06-11) — media type filter inside an
  // album (All / Photos / Videos). Same primitive MemoriesView and
  // Needs Dates use for the Media pill. Resets on selection change
  // so a leftover filter from one album doesn't bleed into the next.
  const [mediaFilter, setMediaFilter] = useState<'all' | 'photos' | 'videos'>('all');
  useEffect(() => { setMediaFilter('all'); }, [selection]);

  // v2.1 round 102 (Terry 2026-06-11) — group an album's photos by
  // day with sticky-banner day headers (same UX as Memories Dates).
  // ON by default per Terry's spec; toggle lives in the new Display
  // popover, persisted to localStorage so the preference survives
  // navigation + reloads.
  const ALBUMS_GROUP_BY_DAY_KEY = 'pdr-albums-group-by-day';
  const [groupByDay, setGroupByDay] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return true;
    const saved = localStorage.getItem(ALBUMS_GROUP_BY_DAY_KEY);
    return saved == null ? true : saved === 'true';
  });
  useEffect(() => {
    try { localStorage.setItem(ALBUMS_GROUP_BY_DAY_KEY, groupByDay ? 'true' : 'false'); } catch { /* localStorage may be unavailable */ }
  }, [groupByDay]);

  // ── "Export as Parallel Library" entry point (v2.0.8 step 6) ─────
  // The PL wizard is re-used as a verb invoked from this album view —
  // no new modal, no new code path. Disabled during an active Fix
  // because PL shares the same copy engine.
  //
  // Two entry points share one wizard:
  //   1. The header Export button on the open album (uses albumPhotos
  //      already loaded for the right-pane grid).
  //   2. The "Export as Parallel Library" item in any album row's
  //      right-click context menu in the left tree (lazy-fetches that
  //      album's photos before opening the wizard).
  //
  // `exportPhotos` holds the list the modal will see — populated by
  // whichever handler opened it. Keeps the right-pane's albumPhotos
  // state independent of the export flow.
  const [showStructureModal, setShowStructureModal] = useState(false);
  const [exportPhotos, setExportPhotos] = useState<IndexedFile[]>([]);
  // Controlled "Add files" popover (in the album-detail header).
  // We need control so the popover can close on action — Radix's
  // built-in close-on-click only fires for elements wrapped in
  // PopoverClose, and we want full control of the nav-dispatch
  // ordering. Terry 2026-05-19: "the Pick Photos from window still
  // appeared when it took me to the By Date screen... very buggy."
  const [addFilesPopoverOpen, setAddFilesPopoverOpen] = useState(false);
  const fixActive = useFixInProgress();

  const startExportAlbumAsPL = useCallback(async (album: AlbumSummary) => {
    if (fixActive) {
      toast.error('Wait for the current Fix to finish — Parallel Libraries use the same copy engine.');
      return;
    }
    // Fast path — already on this album and photos are loaded.
    if (selection?.type === 'album' && selection.id === album.id && albumPhotos.length > 0) {
      setExportPhotos(albumPhotos);
      setShowStructureModal(true);
      return;
    }
    // Lazy path — context menu on a different album row. Fetch
    // photos before opening the wizard so the file count is honest
    // from the very first frame.
    const res = await listAlbumPhotos(album.id);
    if (!res.success || !res.data || res.data.length === 0) {
      toast.info('This album is empty — add photos first.');
      return;
    }
    setExportPhotos(res.data as IndexedFile[]);
    setShowStructureModal(true);
  }, [fixActive, selection, albumPhotos]);

  // ── Undo / Redo ring buffer (v2.0.8 step 6) ───────────────────────
  // Last-10 history of reversible membership operations: add-to-group,
  // remove-from-group, and move-between-groups. Toolbar Undo button
  // (and Ctrl-Z) pops the most recent entry and applies its inverse;
  // Redo (and Ctrl-Y / Ctrl-Shift-Z) replays the most recent
  // undone op in the original direction. Album + folder deletions
  // deliberately not yet supported here — those need backend
  // snapshot-and-restore plumbing (deferred to a follow-up).
  type UndoOp =
    | { kind: 'add_membership'; albumId: number; groupId: number; albumTitle: string; groupTitle: string }
    | { kind: 'remove_membership'; albumId: number; groupId: number; albumTitle: string; groupTitle: string }
    | { kind: 'move_album'; albumId: number; fromGroupId: number; toGroupId: number; albumTitle: string; fromTitle: string; toTitle: string };
  const [undoStack, setUndoStack] = useState<UndoOp[]>([]);
  const [redoStack, setRedoStack] = useState<UndoOp[]>([]);

  const pushUndo = useCallback((op: UndoOp) => {
    // Fresh user action — invalidates any redo history (matches
    // Word / VS Code / browser editor convention).
    setRedoStack([]);
    setUndoStack((prev) => {
      const next = [...prev, op];
      // Cap at 10 — drop oldest when exceeded.
      return next.length > 10 ? next.slice(next.length - 10) : next;
    });
  }, []);

  // Apply an op's INVERSE — used by performUndo. Returns true on success.
  const applyInverse = useCallback(async (op: UndoOp): Promise<boolean> => {
    try {
      if (op.kind === 'add_membership') {
        const r = await removeAlbumFromGroup(op.albumId, op.groupId);
        if (!r.success) { toast.error(`Couldn't undo`, { description: r.error }); return false; }
      } else if (op.kind === 'remove_membership') {
        const r = await addAlbumToGroup(op.albumId, op.groupId);
        if (!r.success) { toast.error(`Couldn't undo`, { description: r.error }); return false; }
      } else if (op.kind === 'move_album') {
        const a = await addAlbumToGroup(op.albumId, op.fromGroupId);
        if (!a.success) { toast.error(`Couldn't undo`, { description: a.error }); return false; }
        const r = await removeAlbumFromGroup(op.albumId, op.toGroupId);
        if (!r.success) { toast.error(`Couldn't undo move`, { description: r.error }); return false; }
      }
      return true;
    } catch (err) {
      toast.error(`Couldn't undo`, { description: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }, []);

  // Apply an op in its FORWARD direction — used by performRedo.
  const applyForward = useCallback(async (op: UndoOp): Promise<boolean> => {
    try {
      if (op.kind === 'add_membership') {
        const r = await addAlbumToGroup(op.albumId, op.groupId);
        if (!r.success) { toast.error(`Couldn't redo`, { description: r.error }); return false; }
      } else if (op.kind === 'remove_membership') {
        const r = await removeAlbumFromGroup(op.albumId, op.groupId);
        if (!r.success) { toast.error(`Couldn't redo`, { description: r.error }); return false; }
      } else if (op.kind === 'move_album') {
        const a = await addAlbumToGroup(op.albumId, op.toGroupId);
        if (!a.success) { toast.error(`Couldn't redo`, { description: a.error }); return false; }
        const r = await removeAlbumFromGroup(op.albumId, op.fromGroupId);
        if (!r.success) { toast.error(`Couldn't redo move`, { description: r.error }); return false; }
      }
      return true;
    } catch (err) {
      toast.error(`Couldn't redo`, { description: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }, []);

  const performUndo = useCallback(async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    const ok = await applyInverse(last);
    if (!ok) return;
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, last]);
    await refreshAll();
  }, [undoStack, applyInverse]);

  const performRedo = useCallback(async () => {
    const last = redoStack[redoStack.length - 1];
    if (!last) return;
    const ok = await applyForward(last);
    if (!ok) return;
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => {
      const next = [...prev, last];
      return next.length > 10 ? next.slice(next.length - 10) : next;
    });
    await refreshAll();
  }, [redoStack, applyForward]);

  // Keyboard shortcuts — Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y =
  // Ctrl/Cmd+Shift+Z = redo. Only when the user isn't typing in an
  // input / textarea / contentEditable (matches editor convention).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      const inEditable = !!t && (
        t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as HTMLElement).isContentEditable
      );
      if (inEditable) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        void performUndo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        void performRedo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [performUndo, performRedo]);

  // v2.1 round 285 (Terry) — Ctrl/Cmd+C copies the selected album photo(s) to the
  // clipboard so Ctrl+V pastes them all. Gated on AlbumsView being visible.
  useCopyFilesHotkey(albumsRootRef, () => (
    selectedAlbumPhotoIds.size > 0 ? albumPhotos.filter(p => selectedAlbumPhotoIds.has(p.id)).map(p => p.file_path) : []
  ));

  // ── Tile-size zoom (v2.0.8 step 6 polish, Terry 2026-05-19) ───────
  // Same zoom interaction Memories By Date uses — Ctrl+scroll on the
  // grid container scales the tiles — plus a visible pill control
  // (Zoom out / percent / Zoom in) so the affordance isn't hidden
  // behind a keyboard chord. Drives the gap-less album-photo grid
  // and the album-card grids. 0–100 slider; mapped to two pixel
  // ranges so photo tiles and album cards each look right.
  const ALBUMS_TILE_KEY = 'pdr-albums-tile-size';
  const TILE_SLIDER_MIN = 0;
  const TILE_SLIDER_MAX = 100;
  const TILE_SLIDER_STEP = 10;
  const [tileSizeSlider, setTileSizeSlider] = useState<number>(() => {
    if (typeof localStorage === 'undefined') return 50;
    const saved = parseInt(localStorage.getItem(ALBUMS_TILE_KEY) || '', 10);
    return Number.isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 50;
  });
  useEffect(() => {
    try { localStorage.setItem(ALBUMS_TILE_KEY, String(tileSizeSlider)); } catch { /* localStorage may be unavailable */ }
  }, [tileSizeSlider]);
  // Photo tiles in the album detail view: 100–300px.
  const albumPhotoTilePx = Math.round(100 + (tileSizeSlider / 100) * 200);
  // Album cards in the All-albums / per-group grids: 160–300px.
  const albumCardTilePx = Math.round(160 + (tileSizeSlider / 100) * 140);

  // v2.1 round 86 (Terry 2026-06-10) — Insights popover state. Lifted
  // from MemoriesView so the two surfaces (Memories — Dates +
  // Memories — Albums) carry the same view-options vocabulary:
  //   • Selection mode = "Tile checkboxes" toggle. When ON, photo
  //     tile checkboxes are always visible (vs the default hover-
  //     revealed behaviour). Mirrors MemoriesView's selectionMode.
  //   • metaFields = which strings render below each photo tile.
  //     'filename' and/or 'date'. Off by default — Albums tiles
  //     historically rendered as bare thumbnails.
  // Both persisted to localStorage with `pdr-albums-*` keys so the
  // settings stay scoped to Albums and don't collide with the
  // identically-named MemoriesView preferences.
  type AlbumTileMetaField = 'filename' | 'date';
  const ALBUMS_SELECTION_MODE_KEY = 'pdr-albums-selection-mode';
  const ALBUMS_TILE_META_KEY = 'pdr-albums-tile-meta';
  const [selectionMode, setSelectionMode] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(ALBUMS_SELECTION_MODE_KEY) === 'true';
  });
  useEffect(() => {
    try { localStorage.setItem(ALBUMS_SELECTION_MODE_KEY, selectionMode ? 'true' : 'false'); } catch { /* localStorage may be unavailable */ }
  }, [selectionMode]);
  const [metaFields, setMetaFields] = useState<AlbumTileMetaField[]>(() => {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(ALBUMS_TILE_META_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((f): f is AlbumTileMetaField => f === 'filename' || f === 'date');
    } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem(ALBUMS_TILE_META_KEY, JSON.stringify(metaFields)); } catch { /* localStorage may be unavailable */ }
  }, [metaFields]);
  const showFilename = metaFields.includes('filename');
  const showDate = metaFields.includes('date');

  // Ctrl+wheel zoom — same interaction the S&D grid and Memories
  // By Date use. Previously attached to `gridScrollRef` (the per-
  // surface grid container), which had a subtle bug: when the user
  // first opens Memories → Albums, the right pane is mounted but
  // the gridScrollRef-bound useEffect's `el` is sometimes null at
  // attach time (the surface mounts inside a hidden TabsContent on
  // first load), so the listener never registered. The user had to
  // click into the tree to trigger a selection change before the
  // effect re-ran with a non-null `el`. Terry 2026-05-19: "Why am
  // I having to physically click on every fucking album on the
  // tree first before I can zoom in our out?"
  //
  // Fix: ONE listener attached to a stable outer container (the
  // AlbumsView root) at mount, valid for the lifetime of the
  // component. Fires whenever Ctrl-wheel hits anywhere inside
  // Albums — no per-surface re-attachment, no ref timing race.
  const albumsRootRef = useRef<HTMLDivElement | null>(null);
  // Keep gridScrollRef for callers (right-click ContextMenu trigger,
  // various place still reference it via ref={gridScrollRef}). It's
  // no longer used for the wheel listener but harmless to retain.
  const gridScrollRef = useRef<HTMLDivElement | null>(null);

  // v2.1 round 88 (Terry 2026-06-10) — floating "scroll position
  // date" pill for the album-detail view (Terry SS2 — the
  // "Saturday, 23 May 2026" chip that appears top-right while
  // scrolling Memories — Dates). Photos in an album come back from
  // the DB unsorted with respect to derived_date, but the pill
  // still shows whichever photo sits at the top of the visible
  // viewport — useful even when the order isn't strict date desc
  // because Albums get loaded as the user added them. State auto-
  // hides 1.2 s after the last scroll, matching MemoriesView's
  // scrollIndicatorTimeoutRef timing.
  const [scrollDateLabel, setScrollDateLabel] = useState<string | null>(null);
  const [scrollIndicatorVisible, setScrollIndicatorVisible] = useState(false);
  const scrollIndicatorTimeoutRef = useRef<number | null>(null);
  // v2.1 round 103 (Terry 2026-06-11) — dayKey ("YYYY-MM-DD") of the
  // day currently shown in the sticky banner. Drives the
  // invisible-when-current trick on inline day dividers (see round
  // 101 for Memories Dates' equivalent). Set alongside
  // scrollDateLabel in the scroll listener.
  const [albumScrollDayKey, setAlbumScrollDayKey] = useState<string | null>(null);
  // Refs to each inline day-divider element rendered inside the
  // album-detail grid, keyed by dayKey. The scroll listener walks
  // these to find the last divider whose top is at or above
  // scrollTop, which is the current day at the viewport top.
  const albumDayHeaderRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    const el = albumsRootRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setTileSizeSlider((prev) => {
        const next = e.deltaY < 0
          ? Math.min(TILE_SLIDER_MAX, prev + TILE_SLIDER_STEP)
          : Math.max(TILE_SLIDER_MIN, prev - TILE_SLIDER_STEP);
        return next;
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // ── Spacious / Tight density (v2.0.8 step 6 polish) ──────────────
  // Same segmented control Memories By Date uses, so the visual
  // language stays consistent across both Memories surfaces. Persists
  // to its own localStorage key — independent from the By Date
  // density so changing one doesn't unexpectedly retune the other.
  // Drives the photo-grid gap in the album detail view and the
  // album-card-grid gap in the All Albums / per-group views.
  const ALBUMS_DENSITY_KEY = 'pdr-albums-density';
  const [density, setDensity] = useState<Density>(() => {
    if (typeof localStorage === 'undefined') return 'spacious';
    return localStorage.getItem(ALBUMS_DENSITY_KEY) === 'tight' ? 'tight' : 'spacious';
  });
  useEffect(() => {
    try { localStorage.setItem(ALBUMS_DENSITY_KEY, density); } catch { /* localStorage may be unavailable */ }
  }, [density]);

  // ── v2.1 round 276 (Terry) — responsive album-detail toolbar ──────
  // The album-detail header packs a lot: the multi-select Actions
  // dropdown + "N selected" pill, an "Export Album as Parallel
  // Library" CTA, plus Media / Display / density / Add-files view
  // controls. On a narrow window these wrapped / clipped. Rather than
  // a horizontal scrollbar, we degrade in two steps:
  //   • toolbarCompact      — the COLLAPSIBLE view controls (Media,
  //                           Display, density, Add files) shrink to
  //                           ICON-ONLY buttons (tooltips retained).
  //   • toolbarVeryCompact  — those same controls fold into a single
  //                           "⋯ More" dropdown.
  // HIGH-priority controls (Actions, the N-selected pill, the Export
  // Album button) stay inline with full labels at every width.
  //
  // We observe the HEADER CONTAINER's width, never the items. The
  // items change size as the flags flip, but the container is the
  // fixed-width header row, so its measured width is independent of
  // our own output — no resize feedback loop / flicker. Thresholds
  // chosen for the album-detail row's fixed left content (icon +
  // title + count + badges) plus the right cluster; tune if the left
  // content grows. Hysteresis isn't needed because the container
  // width only changes on real window/pane resizes, not on our
  // class swaps.
  const headerToolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarCompact, setToolbarCompact] = useState(false);
  const [toolbarVeryCompact, setToolbarVeryCompact] = useState(false);
  useEffect(() => {
    const el = headerToolbarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = (w: number) => {
      // < 760px → fold collapsibles into "⋯ More"; < 980px → icon-only.
      const veryCompact = w < 760;
      const compact = w < 980;
      setToolbarVeryCompact((prev) => (prev === veryCompact ? prev : veryCompact));
      setToolbarCompact((prev) => (prev === compact ? prev : compact));
    };
    measure(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect?.width ?? (entry.target as HTMLElement).getBoundingClientRect().width;
        measure(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
    // Re-attach when the selection changes album because the header
    // container is conditionally rendered (different element instance
    // per selection branch); a one-shot mount effect would bind to a
    // stale / unmounted node.
  }, [selection]);

  // v2.1 round 88 (Terry 2026-06-10) — Scroll-position date pill
  // listener. Computes the photo at the visible top using grid maths
  // (uniform tile dimensions after the round-88 gap fix), reads its
  // derived_date, formats it as "Weekday, D Month YYYY" and surfaces
  // it via the scrollIndicatorVisible auto-hide pattern lifted from
  // MemoriesView (1.2 s after last scroll).
  // NOTE: This block MUST stay below `density` because the dep array
  // reads it — placing the block above `density` triggers a TDZ
  // ReferenceError on first render (which masks the whole tree and
  // leaves the body's --primary lavender filling the window — round
  // 88's first attempt did this).
  useEffect(() => {
    if (selection?.type !== 'album') return;
    const scrollEl = gridScrollRef.current;
    if (!scrollEl) return;
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const formatLong = (iso: string): string | null => {
      const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return null;
      const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
      if (isNaN(d.getTime())) return null;
      return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    };
    const compute = () => {
      if (albumPhotos.length === 0) return;
      // v2.1 round 103 (Terry 2026-06-11) — when groupByDay is on,
      // inline day-dividers occupy variable grid rows so the round-88
      // grid-maths approach (rowHeight × cols → photoIdx) breaks.
      // Walk the rendered day-divider refs and find the last one
      // whose offsetTop is at or above scrollTop; its day is the
      // current one.
      if (groupByDay) {
        // v2.1 round 104 (Terry 2026-06-11) — coordinate-system fix.
        // Round 103 used el.offsetTop which is measured from the
        // nearest positioned ancestor (`offsetParent`). The album-
        // detail scroll container has `position: static` by default
        // so offsetParent walks UP past it to a positioned ancestor
        // (ResizablePanel / outer chrome), and the reported offsetTop
        // gets inflated by every pixel of header / chrome above the
        // scroll area. The `top <= scrollTop + 5` threshold then
        // fired LATE — Terry's screenshots showed the banner not
        // updating until the next day's first row of photos was
        // already visible.
        // Fix: use getBoundingClientRect on both the divider and
        // the scroll container, subtract to get the divider's true
        // position relative to the scroll container's top edge. No
        // offsetParent involved.
        const scrollRect = scrollEl.getBoundingClientRect();
        let bestKey: string | null = null;
        let bestRelTop = Number.NEGATIVE_INFINITY;
        for (const [key, el] of Object.entries(albumDayHeaderRefs.current)) {
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          const relTop = rect.top - scrollRect.top;
          if (relTop <= 5 && relTop > bestRelTop) {
            bestKey = key;
            bestRelTop = relTop;
          }
        }
        if (bestKey) {
          // Find any photo whose dayKey matches so we have a real
          // derived_date to format; we walk albumPhotos rather than
          // visiblePhotos because this useEffect can't see the
          // current filter chain (it'd add too many deps and
          // re-run the listener every filter flip).
          const matchPhoto = albumPhotos.find((p) => (p.derived_date?.slice(0, 10) ?? 'no-date') === bestKey);
          if (matchPhoto?.derived_date) {
            const label = formatLong(matchPhoto.derived_date);
            if (label) {
              setScrollDateLabel(label);
              setAlbumScrollDayKey(bestKey);
            }
          }
        }
        return;
      }
      // Flat-grid path (groupByDay off): original round-88 math.
      const gridEl = scrollEl.querySelector<HTMLElement>('[data-album-photo-grid]');
      if (!gridEl) return;
      const gridRect = gridEl.getBoundingClientRect();
      const scrollRect = scrollEl.getBoundingClientRect();
      const visibleYWithinGrid = scrollRect.top - gridRect.top;
      const colCount = Math.max(1, Math.floor(gridRect.width / albumPhotoTilePx));
      const rowHeight = (gridRect.width / colCount) + (density === 'tight' ? 0 : 12);
      const rowIdx = Math.max(0, Math.floor(visibleYWithinGrid / rowHeight));
      const photoIdx = Math.min(albumPhotos.length - 1, rowIdx * colCount);
      const photo = albumPhotos[photoIdx];
      if (!photo?.derived_date) return;
      const label = formatLong(photo.derived_date);
      if (label) {
        setScrollDateLabel(label);
        setAlbumScrollDayKey(photo.derived_date.slice(0, 10));
      }
    };
    const onScroll = () => {
      compute();
      setScrollIndicatorVisible(true);
      if (scrollIndicatorTimeoutRef.current) clearTimeout(scrollIndicatorTimeoutRef.current);
      scrollIndicatorTimeoutRef.current = window.setTimeout(() => {
        setScrollIndicatorVisible(false);
      }, 1200);
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    compute();
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      if (scrollIndicatorTimeoutRef.current) clearTimeout(scrollIndicatorTimeoutRef.current);
    };
  }, [selection, albumPhotos, albumPhotoTilePx, density, groupByDay]);

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

  // v2.0.15 (Terry 2026-05-29) — titlebar Refresh button dispatches
  // pdr:refreshActiveView. AlbumsView re-runs the full refreshAll
  // pass (listAlbums + groups + memberships) so freshly-imported
  // albums show up without navigating away.
  useEffect(() => {
    const handler = () => { void refreshAll(); };
    window.addEventListener('pdr:refreshActiveView', handler as EventListener);
    return () => window.removeEventListener('pdr:refreshActiveView', handler as EventListener);
  }, [refreshAll]);

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

  // v2.0.15 (Terry 2026-06-02) — surface user-created albums that
  // aren't a member of any folder. Without this, an album created
  // via the Memories "Add to album → Create new" path lands in the
  // database with no group membership and would be invisible in the
  // tree (only "All albums" or direct selection would surface it).
  // Rendered at the bottom of the "Folders" section as bare album
  // rows. Auto-imported albums (Takeout) are deliberately excluded
  // here — they live under their own auto group in the Sources zone.
  const ungroupedUserAlbums = useMemo(() => {
    const grouped = new Set<number>();
    for (const mb of memberships) grouped.add(mb.album_id);
    return albums
      .filter((a) => a.source === 'user_created' && !grouped.has(a.id))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  }, [albums, memberships]);

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
  // Source group of the album being dragged — used by dragOver to
  // set the cursor's "copy" vs "move" hint correctly. dataTransfer
  // .getData() is empty during dragOver for security reasons, so
  // we mirror the value into this ref at dragStart time.
  const draggedAlbumSourceGroupRef = useRef<number | null>(null);
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

  const handleAlbumDragStart = useCallback((e: React.DragEvent, albumId: number, sourceGroupId: number | null) => {
    e.dataTransfer.setData(DRAG_MIME_ALBUM, String(albumId));
    // Encode source group so the drop handler knows whether to MOVE
    // (user folder → user folder, default) or COPY (auto group, or
    // CTRL-held). When the drag came from a context with no group
    // membership (e.g. All-albums grid), source is `null` and the
    // handler falls back to COPY semantics — safest default.
    if (sourceGroupId !== null) {
      e.dataTransfer.setData(DRAG_MIME_ALBUM_SOURCE_GROUP, String(sourceGroupId));
    }
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
    draggedAlbumSourceGroupRef.current = sourceGroupId;
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
    // Cursor hint: 'move' when this drop will move the album out of
    // a user folder (default semantic); 'copy' for everything else
    // (source-group → folder, or CTRL-held). The actual decision
    // happens on drop, but giving the user a correct cursor at
    // dragOver time helps them anticipate the result.
    if (hasAlbum) {
      const sourceId = draggedAlbumSourceGroupRef.current;
      const sourceGroup = sourceId !== null ? groups.find((g) => g.id === sourceId) ?? null : null;
      const willMove = sourceGroup?.source_kind === 'user' && !(e.ctrlKey || e.metaKey) && sourceGroup.id !== group.id;
      e.dataTransfer.dropEffect = willMove ? 'move' : 'copy';
    } else {
      e.dataTransfer.dropEffect = 'move';
    }
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
    // v2.0.8 step 6 (Terry 2026-05-19): MOVE-vs-COPY semantics.
    //   - From a USER folder, no CTRL → MOVE (add to target, remove
    //     from source) so the user can shuffle albums between folders
    //     without ending up with duplicate memberships everywhere.
    //   - From a USER folder, CTRL/Cmd held → COPY (keep both
    //     memberships) — explicit opt-in to duplicate.
    //   - From an album SOURCE (auto group: PDR / Google Photos) →
    //     always COPY. The source group is the "canonical home" of
    //     the album and must never lose its membership via drag.
    //   - From the All-albums grid (no source-group context) →
    //     COPY (safe default).
    const albumIdStr = e.dataTransfer.getData(DRAG_MIME_ALBUM);
    if (albumIdStr) {
      if (!isGroupDroppable(group)) return;
      const albumId = Number(albumIdStr);
      if (!Number.isFinite(albumId)) return;

      const sourceGroupIdStr = e.dataTransfer.getData(DRAG_MIME_ALBUM_SOURCE_GROUP);
      const sourceGroupId = sourceGroupIdStr ? Number(sourceGroupIdStr) : null;
      // Drop onto the same group the drag started in = silent no-op.
      if (sourceGroupId === group.id) return;
      const sourceGroup = sourceGroupId !== null
        ? groups.find((g) => g.id === sourceGroupId) ?? null
        : null;
      const isFromUserFolder = sourceGroup?.source_kind === 'user';
      const ctrlHeld = e.ctrlKey || e.metaKey;
      const shouldMove = isFromUserFolder && !ctrlHeld;

      // ADD first — if this fails, we haven't lost anything (the
      // source membership is still intact, no destructive change
      // has been made).
      const addRes = await addAlbumToGroup(albumId, group.id);
      if (!addRes.success) { toast.error(`Couldn't add to "${group.title}"`, { description: addRes.error }); return; }

      const album = albumsById.get(albumId);
      const albumTitle = album?.title ?? `album #${albumId}`;

      if (shouldMove && sourceGroup) {
        // Remove from source AFTER the add succeeded. If this fails,
        // the user has a duplicate membership rather than a lost
        // album — recoverable. We log but don't error-toast unless
        // it's clearly a real failure.
        const remRes = await removeAlbumFromGroup(albumId, sourceGroup.id);
        if (!remRes.success) {
          toast.warning(`Move incomplete`, { description: `Added to "${group.title}", but couldn't remove from "${sourceGroup.title}".` });
        } else {
          pushUndo({
            kind: 'move_album',
            albumId,
            fromGroupId: sourceGroup.id,
            toGroupId: group.id,
            albumTitle,
            fromTitle: sourceGroup.title,
            toTitle: group.title,
          });
        }
      } else {
        // COPY path — pure add, undo just removes the new
        // membership.
        pushUndo({
          kind: 'add_membership',
          albumId,
          groupId: group.id,
          albumTitle,
          groupTitle: group.title,
        });
      }
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

  // ── Return-nav from TitleBar back-pill ───────────────────────────
  // Two paths into AlbumsView from the back-pill:
  //
  //   A) AlbumsView is ALREADY mounted (user was on Memories or
  //      S&D). The `pdr:openAlbumsAlbum` event fires; this listener
  //      catches it and runs navigateSelection.
  //
  //   B) AlbumsView is NOT yet mounted (user was on Dashboard /
  //      Trees / PM; workspace only mounts MemoriesPanel — and
  //      therefore AlbumsView — when activeView === 'memories').
  //      The event fires before this listener registers, so it's
  //      missed. Instead, the back-pill click latches the target
  //      id into `pendingAlbumOpen`; the mount-time effect below
  //      consumes it.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { id?: number } | undefined;
      if (!detail || typeof detail.id !== 'number') return;
      navigateSelection({ type: 'album', id: detail.id });
      // Force a refresh so the album's photo count + tiles reflect
      // any photos added moments ago in the AddToAlbumPopover.
      // Without this the count stays stale until the user manually
      // refreshes — Terry 2026-05-19: "the no. photos doesn't
      // update unless the albums page is refreshed".
      void refreshAll();
    };
    window.addEventListener('pdr:openAlbumsAlbum', handler as EventListener);
    return () => window.removeEventListener('pdr:openAlbumsAlbum', handler as EventListener);
  }, [navigateSelection, refreshAll]);

  // Mount-time consume of any latched album-open target. Handles
  // path B above (AlbumsView wasn't mounted when the back-pill
  // fired). Runs once per mount; the singleton's read clears it.
  //
  // v2.0.15 (Terry 2026-06-02) — also read the localStorage
  // fallback that TitleBar writes alongside the singleton. The
  // singleton was failing intermittently (consume returned null
  // by the time this effect ran across remount cycles when the
  // user came from S&D back into Memories), landing the user on
  // All Albums instead of the specific album they came from.
  // localStorage survives those timing quirks and is single-shot
  // (we removeItem after reading) so it can't accidentally land
  // the user on the album twice.
  useEffect(() => {
    let id = consumePendingAlbumOpen();
    if (id === null) {
      try {
        const raw = localStorage.getItem('pdr-albums-pending-open');
        if (raw) {
          const parsed = parseInt(raw, 10);
          if (Number.isFinite(parsed)) id = parsed;
        }
      } catch { /* localStorage may be unavailable */ }
    }
    // Always clear the localStorage latch so a stale value can't
    // hijack a future mount.
    try { localStorage.removeItem('pdr-albums-pending-open'); } catch { /* localStorage may be unavailable */ }
    if (id !== null) navigateSelection({ type: 'album', id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh on demand — AddToAlbumPopover fires this after
  // successfully adding photos so the visible album view picks
  // up the new count + tiles without a manual refresh click.
  useEffect(() => {
    const handler = () => { void refreshAll(); };
    window.addEventListener('pdr:albumsRefresh', handler as EventListener);
    return () => window.removeEventListener('pdr:albumsRefresh', handler as EventListener);
  }, [refreshAll]);

  // ── Right-pane data: load album photos when an album is selected ──
  useEffect(() => {
    if (selection?.type !== 'album') { setAlbumPhotos([]); return; }
    let cancelled = false;
    (async () => {
      setAlbumPhotosLoading(true);
      const r = await listAlbumPhotos(selection.id);
      if (cancelled) return;
      // v2.1 round 89 (Terry 2026-06-10) — sort album photos by
      // derived_date DESC (most recent first) so the chronological
      // order matches Memories — Dates. Terry: "Albums has them
      // ordered from furthest away at the top to most recent at
      // the bottom... they should match, and consideration has gone
      // into Dates, so I would have albums match Dates." Falls back
      // to file id desc as a tiebreaker for rows with no derived_date
      // so groups of dateless files stay together near the bottom
      // instead of scattering across the grid.
      const raw = r.success && r.data ? r.data : [];
      const sorted = [...raw].sort((a, b) => {
        const aDate = a.derived_date ?? '';
        const bDate = b.derived_date ?? '';
        if (aDate && !bDate) return -1;
        if (!aDate && bDate) return 1;
        if (aDate !== bDate) return bDate.localeCompare(aDate);
        return b.id - a.id;
      });
      setAlbumPhotos(sorted);
      setAlbumPhotosLoading(false);
    })();
    return () => { cancelled = true; };
    // v2.1 round 275 (Terry) — albumPhotosRefreshTick added so a
    // Move-to-Recycle-Bin can force-reload the SAME album's photos
    // (selection is unchanged, so without this the grid keeps showing
    // deleted tiles — RISK 1).
  }, [selection, albumPhotosRefreshTick]);

  // v2.0.15 (Terry 2026-06-02) — scroll-to-tile after photos load.
  // Back-pill flow latches the file id the user right-clicked from
  // into localStorage; after the album's photo grid mounts we find
  // the matching tile and scroll it into view so the user lands at
  // their exact starting point. One-shot: removeItem after read so
  // a stale value can't hijack a future visit. requestAnimationFrame
  // gives the tile DOM time to commit before the scroll math runs.
  useEffect(() => {
    if (selection?.type !== 'album') return;
    if (albumPhotos.length === 0 || albumPhotosLoading) return;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem('pdr-memories-pending-scroll-to');
      if (raw) localStorage.removeItem('pdr-memories-pending-scroll-to');
    } catch { return; }
    if (!raw) return;
    const targetId = parseInt(raw, 10);
    if (!Number.isFinite(targetId)) return;
    if (!albumPhotos.some((p) => p.id === targetId)) return;
    const id = requestAnimationFrame(() => {
      const el = document.querySelector(`[data-testid="album-tile-checkbox-${targetId}"]`)?.closest('button');
      if (el) el.scrollIntoView({ behavior: 'auto', block: 'center' });
    });
    return () => cancelAnimationFrame(id);
  }, [albumPhotos, albumPhotosLoading, selection]);

  // v2.0.13 — keep caption state in sync with edits from the right-
  // click "Caption…" menu so the indicator badge appears / disappears
  // immediately without a manual refresh.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ fileId: number; caption: string }>).detail;
      if (!detail) return;
      setAlbumPhotos((prev) => prev.map((f) => f.id === detail.fileId ? { ...f, caption: detail.caption || null } : f));
    };
    window.addEventListener('pdr:captionsChanged', handler);
    return () => window.removeEventListener('pdr:captionsChanged', handler);
  }, []);

  // ── Thumbnail loader (album photos only — covers are lazy) ───────
  // Album-detail photos (the contents of one opened album) are
  // loaded up-front because there's only ever one album-worth of
  // photos in view at a time — usually tens, sometimes hundreds.
  // Album COVERS, however, can run into the thousands (Takeout
  // imports) and used to all fetch on mount even when the user
  // was looking at a different surface. They're now lazy-loaded
  // via a separate IntersectionObserver effect below — only the
  // covers that scroll into view get fetched, with a 600px lead
  // margin so the next strip is already there when the user
  // scrolls. Terry 2026-05-20: "it just needs to fire up the
  // visible thumbnails… the ones below that can be loaded up
  // afterwards".
  useEffect(() => {
    let cancelled = false;
    const paths = new Set<string>();
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
  }, [albumPhotos]);

  // ── Lazy cover loader — observes every album tile's outer
  // element (tagged with data-cover-path) and fetches its
  // thumbnail only when the tile scrolls into view (with a
  // 600px lead margin). Same pattern as MonthTile in
  // MemoriesView. Re-runs when `albums` changes so newly-
  // added tiles get observed. Falls back to a no-op when
  // gridScrollRef isn't mounted yet (e.g. on the empty-state
  // surface where no grid is rendered).
  useEffect(() => {
    const container = gridScrollRef.current;
    if (!container) return;
    const requested = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const path = (entry.target as HTMLElement).dataset.coverPath;
        if (!path || requested.has(path)) continue;
        requested.add(path);
        observer.unobserve(entry.target);
        (async () => {
          try {
            const r = await getThumbnail(path, 200);
            if (r.success && r.dataUrl) {
              setThumbs((prev) => prev[path] ? prev : { ...prev, [path]: r.dataUrl });
            }
          } catch { /* per-tile failure is non-fatal */ }
        })();
      }
    }, { root: container, rootMargin: '600px 0px' });
    // Observe every cover-bearing tile currently in the DOM.
    // requestAnimationFrame defers one frame so the album grid
    // has actually rendered when we query for [data-cover-path].
    const raf = requestAnimationFrame(() => {
      const els = container.querySelectorAll('[data-cover-path]');
      els.forEach((el) => observer.observe(el));
    });
    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, [albums]);

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
   *  right-click context menu's "New sub-folder" entry. Renders an
   *  inline input inside the parent group's expanded children; on
   *  submit the new folder lands inside `group`. */
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

  // Inline sub-folder input — focused immediately after the inline
  // input row mounts. autoFocus is unreliable here because the
  // Radix ContextMenu that triggered the create flow steals focus
  // back to itself during its close animation. We use a callback
  // ref with two requestAnimationFrames so the focus call lands
  // AFTER Radix's focus-restoration dance. Terry 2026-05-19: "When
  // a new sub-folder is made, the cursor should be ready to start
  // typing in the name field of that sub-folder."
  const subfolderInputCallbackRef = useCallback((el: HTMLInputElement | null) => {
    if (!el) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try { el.focus(); } catch { /* ignore — element may have unmounted between frames */ }
      });
    });
  }, []);
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
      // Record for undo — restore the membership row by re-adding.
      pushUndo({ kind: 'remove_membership', albumId, groupId: folderId, albumTitle, groupTitle: folderTitle });
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
    // v2.0.13 — when the "Captioned only" filter is on, the viewer
    // opens with just the filtered subset so arrow-key navigation
    // stays within the photos the user can see. Otherwise the
    // viewer opens with the full album, the way it always did.
    const source = captionedOnly
      ? albumPhotos.filter((p) => p.caption && p.caption.length > 0)
      : albumPhotos;
    const paths = source.map((p) => p.file_path);
    const names = source.map((p) => p.filename);
    await openSearchViewer(paths, names, idx);
  };

  // v2.0.15 (Terry 2026-06-01) — per-photo selection inside the
  // album detail view. Mirrors MemoriesView's contract: plain click
  // opens the viewer; Ctrl/Cmd+click toggles a single tile; Shift+
  // click range-selects from the last anchor. Tiles render a check
  // overlay when in the selectedAlbumPhotoIds set. Selection is the
  // basis for multi-photo "Send to S&D" and (later) other batch
  // actions on AlbumsView. Cleared whenever the user navigates to a
  // different album so we never carry a stale selection across views.
  const [selectedAlbumPhotoIds, setSelectedAlbumPhotoIds] = useState<Set<number>>(new Set());
  // v2.1 round 35 (Terry 2026-06-08) — Transcribe hook for the
  // right-click context menu item below. Same Whisper-batch pipeline
  // MemoriesView and SearchPanel use; one source of truth.
  const { transcribe: transcribeVideoPaths } = useTranscribeVideos();
  // v2.1 round 58 (Terry 2026-06-09) — file_ids with a transcript.
  // Drives the lavender TranscriptBadge sibling to CaptionBadge on
  // each album-photo tile. Visibility governed by Settings →
  // Privacy & Security → "Hide transcripts" (read inside the
  // badge primitive itself, not here).
  const [transcribedFileIds] = useTranscribedFileIds();
  const lastAlbumClickedIndexRef = useRef<number | null>(null);
  useEffect(() => { setSelectedAlbumPhotoIds(new Set()); lastAlbumClickedIndexRef.current = null; }, [selection]);
  // v2.1 round 275 (Terry) — multi-select Actions toolbar parity with
  // Dates (MemoriesView). Grace-close for the Actions dropdown (same
  // 1500 ms forgiveness MemoriesView uses), plus open-ticks for the
  // hidden AddToAlbumPopover anchor: addToAlbumOpenTick opens it in
  // list mode ("Add to album…"), addToAlbumCreateTick opens it
  // directly in create-new mode ("Create new album from selection").
  const actionsGrace = usePopoverGraceClose(1500);
  const [addToAlbumOpenTick, setAddToAlbumOpenTick] = useState(0);
  const [addToAlbumCreateTick, setAddToAlbumCreateTick] = useState(0);
  // v2.1 round 275 (Terry) — albumPhotosRefreshTick (the RISK-1 recycle-refresh tick) is
  // declared up with `albumPhotos`, because the loader effect references it in its dep array
  // and must therefore be initialized before that effect (avoids a TDZ blank-screen).
  // v2.1 round 275 (Terry) — mirrors MemoriesView.clearSelection.
  const clearAlbumSelection = () => {
    setSelectedAlbumPhotoIds(new Set());
    lastAlbumClickedIndexRef.current = null;
  };

  // v2.1 round 276 (Terry) — export only the SELECTED photos as a
  // Parallel Library. Reuses the SAME shared wizard
  // (ParallelStructureModal) — we just feed exportPhotos the subset
  // instead of the whole album. Mirrors the fixActive guard + toast
  // from startExportAlbumAsPL. Plain fn (not useCallback) so it always
  // reads the live selectedAlbumPhotoIds / albumPhotos — and so it can
  // sit below the selectedAlbumPhotoIds declaration without a dep-array
  // TDZ. Reached from the multi-select Actions dropdown (selection > 0);
  // the standalone header "Export Album…" button is hidden while a
  // selection is live, so the two never compete.
  const startExportSelectedAsPL = () => {
    if (fixActive) {
      toast.error('Wait for the current Fix to finish — Parallel Libraries use the same copy engine.');
      return;
    }
    const sel = albumPhotos.filter(p => selectedAlbumPhotoIds.has(p.id));
    if (!sel.length) return;
    setExportPhotos(sel);
    setShowStructureModal(true);
  };
  const handleAlbumPhotoClick = (
    visibleList: Array<{ id: number }>,
    idx: number,
    e: React.MouseEvent,
  ) => {
    const photo = visibleList[idx];
    if (!photo) return;
    const isModifier = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    if (isShift && lastAlbumClickedIndexRef.current != null) {
      const a = Math.min(lastAlbumClickedIndexRef.current, idx);
      const b = Math.max(lastAlbumClickedIndexRef.current, idx);
      setSelectedAlbumPhotoIds(prev => {
        const next = new Set(prev);
        for (let i = a; i <= b; i++) {
          const ph = visibleList[i];
          if (ph) next.add(ph.id);
        }
        return next;
      });
      return;
    }
    if (isModifier) {
      setSelectedAlbumPhotoIds(prev => {
        const next = new Set(prev);
        if (next.has(photo.id)) next.delete(photo.id);
        else next.add(photo.id);
        return next;
      });
      lastAlbumClickedIndexRef.current = idx;
      return;
    }
    // Plain click — open viewer. Clear any active selection so the
    // user's next plain click on a different tile doesn't surprise
    // them by leaving stale highlights behind.
    if (selectedAlbumPhotoIds.size > 0) setSelectedAlbumPhotoIds(new Set());
    lastAlbumClickedIndexRef.current = idx;
    void handleOpenPhoto(idx);
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
          className={`flex items-center gap-1.5 pr-2 py-1 rounded-md transition-colors ${
            isSelected ? 'bg-primary/15 text-foreground' : 'hover:bg-muted/40'
          } ${isRenaming ? 'cursor-text' : 'cursor-grab active:cursor-grabbing'}`}
          style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
          onClick={() => { if (!isRenaming) navigateSelection({ type: 'album', id: album.id }); }}
          draggable={!isRenaming}
          onDragStart={(e) => handleAlbumDragStart(e, album.id, parentGroupId)}
          data-testid={`tree-album-${album.id}`}
        >
          {/* Persistent drag handle — signals "this is pickable"
              without requiring a hover. Subtle at rest (30%
              opacity), brightens on row hover (70%). Same lucide
              glyph the section header uses, kept small so the row
              still reads as text-first. Terry 2026-05-19: "albums
              can be dragged and copied to a folder, but right now
              it looks like they can't." */}
          <span
            className="shrink-0 text-muted-foreground opacity-30 group-hover/leaf:opacity-70 transition-opacity"
            aria-hidden="true"
          >
            <GripVertical className="w-3 h-3" />
          </span>
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
                {/* Rename pencil is shown for albums from EVERY source
                    (user_created, takeout_imported, future cloud
                    sources). PDR owns the local title of the album
                    record regardless of where it was originally
                    sourced — Terry 2026-05-21: "There must also be the
                    ability to rename albums from all album sources
                    since they will live and be managed on PDR." Delete
                    stays gated to user_created so a Takeout-import
                    link can't be silently severed. */}
                <IconTooltip content="Rename album">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setRenamingAlbumId(album.id); setRenameAlbumTitle(album.title); }}
                    className="text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                </IconTooltip>
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
            {/* Rename available for every source (Terry 2026-05-21). */}
            <ContextMenuItem onSelect={() => { setRenamingAlbumId(album.id); setRenameAlbumTitle(album.title); }}>
              <Pencil className="w-3.5 h-3.5 mr-2" />
              Rename
            </ContextMenuItem>
            {/* Export-as-Parallel-Library — works from any album row
                in the tree without first navigating into the album.
                Lazy-fetches that album's photos via the shared
                handler so the wizard opens with the right file count.
                Disabled with greyed-out item when a Fix is in flight
                (PL shares the copy engine) or the album is empty. */}
            <ContextMenuItem
              onSelect={() => startExportAlbumAsPL(album)}
              disabled={fixActive || album.photoCount === 0}
              data-testid={`context-menu-export-pl-${album.id}`}
            >
              <Copy className="w-3.5 h-3.5 mr-2" />
              Export as Parallel Library
            </ContextMenuItem>
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
            // Dashed inner outline reads as "drop here" without the
            // heavy filled chip the old solid ring produced. Same OS-
            // standard convention as folder drop zones in Finder /
            // Explorer. Terry 2026-05-19 redesign pass.
            isNestHighlight ? 'border-2 border-dashed border-primary bg-primary/5 -m-0.5' : (isSelected ? 'bg-primary/15' : 'hover:bg-muted/40')
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
            /* onCloseAutoFocus preventDefault keeps focus away from
               the trigger row when the menu closes — without it
               Radix returns focus to the row's div, which steals
               focus from the freshly-rendered inline sub-folder
               input. Terry 2026-05-19: "the cursor highlights the
               field after creating but then immediately disappears.
               It's like something else is calling its attention."
               That "something else" was this exact focus
               restoration. */
            <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
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
            {/* Inline sub-folder create input — rendered at the depth
                the new folder will land. Replaces the previous flow
                where the toolbar input at the top of the panel was
                used for sub-folders too (Terry 2026-05-19: "should
                allow the subfolder to be named where it's created…
                not back up at the top"). Auto-focused when the
                context menu opens this surface; Enter commits, Esc
                cancels. */}
            {creatingFolder && subfolderParentId === group.id && (
              <div
                className="flex items-center gap-1.5 py-1 pr-2"
                style={{ paddingLeft: `${(depth + 1) * 1.25 + 0.25}rem` }}
                data-testid={`tree-inline-subfolder-input-${group.id}`}
              >
                <FolderClosed className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <input
                  ref={subfolderInputCallbackRef}
                  value={newFolderTitle}
                  onChange={(e) => setNewFolderTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleCreateFolder(); }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelCreateFolder(); }
                  }}
                  placeholder="Sub-folder name"
                  className="px-2 py-0.5 rounded border border-border bg-background text-foreground text-xs flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <Button variant="primary" size="sm" onClick={(e) => { e.stopPropagation(); handleCreateFolder(); }} className="px-1.5 py-0.5 h-auto">
                  <Check className="w-3 h-3" />
                </Button>
                <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); cancelCreateFolder(); }} className="px-1.5 py-0.5 h-auto">
                  <X className="w-3 h-3" />
                </Button>
              </div>
            )}
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

    // v2.0.8 step 6 redesign (Terry 2026-05-19): drop the tinted
    // card wrappers entirely. The sidebar reads calmer as two flat
    // zones separated by a hairline divider, with quiet section
    // headers that signal "what's below" without competing
    // visually for attention. Brand colour survives as a 6×6 dot
    // alongside each section label — lavender for sources, gold
    // for folders — so the colour identity is preserved.
    //
    // Drop-target affordance migrates from "tinted background fill"
    // to a dashed lavender / gold ring around the section block.
    // Reads as "this is where the dropped thing will land" without
    // requiring a card chrome to outline. The dashed line is the
    // standard OS drop-zone convention.
    const dotColorClass = isSources ? 'bg-primary' : 'bg-[var(--color-gold)]';
    const labelColorClass = isSources ? 'text-primary' : 'text-[#a16207]';
    const dropRingColorClass = isSources ? 'border-primary' : 'border-[var(--color-gold)]';
    const headerLabel = isSources ? 'Album Sources' : 'Folders';
    const emptyMessage = isSources
      ? 'No sources yet. Run Fix on a Google Photos Takeout, or create an album here, to populate this zone.'
      : 'No folders yet. Use "New folder" above to start organizing your albums.';

    return (
      <div
        key={`section-${kind}`}
        onDragOver={(e) => handleSectionDragOver(e, kind)}
        onDragLeave={(e) => handleSectionDragLeave(e, kind)}
        onDrop={(e) => handleSectionDrop(e, kind)}
        className={`px-1 py-1 rounded-md transition-colors ${isDropTarget ? `border-2 border-dashed ${dropRingColorClass}` : 'border-2 border-transparent'} ${isDragging ? 'opacity-50' : ''}`}
        data-testid={`section-${kind}`}
      >
        {/* Quiet section header — colour dot + uppercase label, faint
            hairline below. The whole header is the drag handle for
            section reordering (cursor-grab); the GripVertical glyph
            is suppressed in favour of a less-noisy surface. */}
        <div
          draggable
          onDragStart={(e) => handleSectionDragStart(e, kind)}
          onDragEnd={handleSectionDragEnd}
          className="flex items-center gap-1.5 px-1 pb-1 mb-1 border-b border-border/60 cursor-grab active:cursor-grabbing select-none"
          data-testid={`section-${kind}-header`}
        >
          <IconTooltip label="Drag to swap section order" side="right">
            <span className="inline-flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${dotColorClass}`} aria-hidden="true" />
              <span className={`text-[10px] font-semibold uppercase tracking-wider ${labelColorClass}`}>
                {headerLabel}
              </span>
            </span>
          </IconTooltip>
        </div>
        {groupsForCard.length === 0 && !(!isSources && ungroupedUserAlbums.length > 0) ? (
          <p className="text-[11px] text-muted-foreground italic px-2 py-1">{emptyMessage}</p>
        ) : (
          <>
            {groupsForCard.map((g) => renderGroupRow(g, 0))}
            {/* v2.0.15 (Terry 2026-06-02) — ungrouped user-created
                albums rendered as bare rows in the Folders section.
                Without this an album created via Memories' "Create
                new album" was orphaned (no folder membership) and
                invisible in the tree. Auto-imported albums (Takeout)
                are routed to the Sources section by their own group
                — they never need this fallback. parentGroupId=0 is
                the "no folder" sentinel (real group IDs are > 0):
                renderAlbumLeaf's hover-actions skip the folder-minus
                affordance in that case. */}
            {!isSources && ungroupedUserAlbums.map((a) => renderAlbumLeaf(a, 0, 0))}
          </>
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

  // v2.1 round 86 (Terry 2026-06-10) — Insights popover, lifted
  // verbatim from MemoriesView so the two surfaces (Memories — Dates
  // + Memories — Albums) carry the same view-options vocabulary.
  // The inline zoom pill that used to live here is now wrapped INSIDE
  // the popover's first section, alongside Selection Mode and
  // Show-below-each-tile checkboxes. Insights trigger replaces zoomPill
  // in all three header rows (All-albums, per-group, album-detail).
  // Active-state badge counts changes from defaults — selectionMode on
  // counts 1; each metaField counts 1. Tile size is a personal
  // preference, not surfaced in the badge (matches MemoriesView round
  // 64 rule).
  // v2.1 round 102 (Terry 2026-06-11) — Display button count includes
  // group-by-day OFF (its non-default state) so the user can see "I've
  // changed something here" without opening the popover.
  const insightsCount = (selectionMode ? 1 : 0) + metaFields.length + (groupByDay ? 0 : 1);
  const insightsActive = insightsCount > 0;
  // Display button — renamed from Insights to match MemoriesView /
  // Needs Dates view-pill family (round 97). Uniform pill recipe:
  // h-8 + rounded-md + border + min-w-[150px] + justify-between +
  // Eye icon. Active-state badge counts non-default Display toggles
  // (selectionMode + metaFields + groupByDay-OFF).
  // v2.1 round 276 (Terry) — render-fn (was a const) so the responsive
  // album-detail toolbar can ask for an ICON-ONLY variant (`compact`)
  // when space is tight. Identical popover body in both modes — only
  // the trigger chrome differs (label + min-width hidden when compact,
  // and the active-count badge shrinks to a dot). Other render sites
  // (All-albums / Group headers) call it with no arg = full label.
  const renderDisplayButton = (compact = false) => (
    <Popover>
      <IconTooltip label="Display options — tile size, selection mode, info under tiles, group by day" side="bottom">
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="albums-display-trigger"
            className={`inline-flex items-center ${compact ? 'justify-center w-8' : 'justify-between min-w-[150px]'} gap-1.5 h-8 px-3 rounded-md text-xs font-medium border transition-colors ${insightsActive ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background hover:bg-accent text-foreground'}`}
          >
            <span className="inline-flex items-center gap-1.5 relative">
              <Eye className="w-3.5 h-3.5" />
              {!compact && <span>Display</span>}
              {insightsActive && !compact && (
                <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary/15 text-primary text-[10px] font-semibold tabular-nums">
                  {insightsCount}
                </span>
              )}
              {/* Compact mode: a tiny dot stands in for the count badge
                  so the user can still tell a non-default Display state
                  exists without the label/number taking up width. */}
              {insightsActive && compact && (
                <span className="absolute -top-1.5 -right-2 w-2 h-2 rounded-full bg-primary" />
              )}
            </span>
            {!compact && <ChevronDown className="w-3.5 h-3.5 opacity-70" />}
          </button>
        </PopoverTrigger>
      </IconTooltip>
      <PopoverContent
        className="w-64 p-3"
        align="start"
        // Ctrl+wheel zoom keeps working while the popover is open so
        // the user can watch the % number tick live without closing
        // it first (lifted from MemoriesView round 65).
        onWheel={(e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          e.stopPropagation();
          setTileSizeSlider((prev) => Math.max(TILE_SLIDER_MIN, Math.min(TILE_SLIDER_MAX, prev + (e.deltaY < 0 ? TILE_SLIDER_STEP / 2 : -TILE_SLIDER_STEP / 2))));
        }}
      >
        {/* — Tile size section — */}
        <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider mb-2">Tile size</p>
        <div className="flex items-center gap-1 mb-3">
          <button
            type="button"
            onClick={() => setTileSizeSlider((prev) => Math.max(TILE_SLIDER_MIN, prev - TILE_SLIDER_STEP))}
            disabled={tileSizeSlider <= TILE_SLIDER_MIN}
            className="flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            data-testid="button-albums-zoom-out"
            aria-label="Zoom out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setTileSizeSlider(50)}
            className="flex-1 text-xs font-medium text-foreground tabular-nums hover:bg-secondary/40 rounded py-1 transition-colors"
            data-testid="button-albums-zoom-reset"
            aria-label="Reset zoom"
          >
            {tileSizeSlider}% <span className="text-muted-foreground/70 text-[10px]">(click to reset)</span>
          </button>
          <button
            type="button"
            onClick={() => setTileSizeSlider((prev) => Math.min(TILE_SLIDER_MAX, prev + TILE_SLIDER_STEP))}
            disabled={tileSizeSlider >= TILE_SLIDER_MAX}
            className="flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            data-testid="button-albums-zoom-in"
            aria-label="Zoom in"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="border-t border-border my-2" />
        {/* — Selection mode section — */}
        <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider mb-2">Selection mode</p>
        <label className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/50 cursor-pointer">
          <input
            type="checkbox"
            checked={selectionMode}
            onChange={() => setSelectionMode((v) => !v)}
            className="rounded border-border text-purple-500 focus:ring-purple-400/50"
            data-testid="button-albums-selection-mode"
          />
          <span className="text-sm text-foreground flex-1">Tile checkboxes</span>
        </label>
        <div className="border-t border-border my-2" />
        {/* — Tile info section — */}
        <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider mb-2">Show below each tile</p>
        {([
          { key: 'filename' as AlbumTileMetaField, label: 'Filename' },
          { key: 'date' as AlbumTileMetaField, label: 'Date' },
        ]).map((opt) => {
          const checked = metaFields.includes(opt.key);
          return (
            <label key={opt.key} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/50 cursor-pointer">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => {
                  setMetaFields((prev) => checked ? prev.filter((f) => f !== opt.key) : [...prev, opt.key]);
                }}
                className="rounded border-border text-purple-500 focus:ring-purple-400/50"
              />
              <span className="text-sm text-foreground flex-1">{opt.label}</span>
            </label>
          );
        })}
        <div className="border-t border-border my-2" />
        {/* — Group-by-day section (album-detail only) — */}
        {/* v2.1 round 102 (Terry 2026-06-11) — group an album's
            photos by day with the same sticky-banner pattern as
            Memories Dates. Only meaningful in the album-detail
            view; we still show the toggle on All-albums + Group
            views because hiding/showing it depending on selection
            would cause the Display popover to reflow (annoying
            UX). Default ON. */}
        <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider mb-2">Group photos by</p>
        <label className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/50 cursor-pointer">
          <input
            type="checkbox"
            checked={groupByDay}
            onChange={() => setGroupByDay((v) => !v)}
            className="rounded border-border text-purple-500 focus:ring-purple-400/50"
            data-testid="button-albums-group-by-day"
          />
          <span className="text-sm text-foreground flex-1">Show Day and Date</span>
        </label>
        <p className="text-[10px] text-muted-foreground/85 px-2 pt-2 leading-snug">
          Tip: Hold <kbd className="px-1 py-0.5 rounded bg-secondary text-[9px] font-mono">Ctrl</kbd> + scroll over the grid to zoom.
        </p>
      </PopoverContent>
    </Popover>
  );

  // v2.1 round 102 (Terry 2026-06-11) — Media pill (album-detail
  // only). Mirrors MemoriesView / Needs Dates' Media pill recipe
  // verbatim: same h-8 + rounded-md + border + min-w-[150px] +
  // justify-between + ChipIcon + "Media:" prefix + ChevronDown.
  // Absorbs the existing captionedOnly toggle plus a new
  // photos/videos filter so Albums catches up with the other
  // surfaces' filter capability.
  const mediaPhotoCount = albumPhotos.filter((p) => p.file_type === 'photo').length;
  const mediaVideoCount = albumPhotos.filter((p) => p.file_type === 'video').length;
  const mediaCaptionedCount = albumPhotos.filter((p) => {
    if (!p.caption || p.caption.length === 0) return false;
    if (mediaFilter === 'photos') return p.file_type === 'photo';
    if (mediaFilter === 'videos') return p.file_type === 'video';
    return true;
  }).length;
  const mediaIsDefault = mediaFilter === 'all' && !captionedOnly;
  const mediaShortLabel = mediaIsDefault
    ? 'All'
    : mediaFilter === 'photos' && !captionedOnly
      ? 'Photos'
      : mediaFilter === 'videos' && !captionedOnly
        ? 'Videos'
        : mediaFilter === 'all' && captionedOnly
          ? 'Captioned'
          : `${mediaFilter === 'photos' ? 'Photos' : 'Videos'} + Captioned`;
  const MediaChipIcon =
    mediaFilter === 'photos' && !captionedOnly
      ? ImageIcon
      : mediaFilter === 'videos' && !captionedOnly
        ? Film
        : captionedOnly && mediaFilter === 'all'
          ? MessageSquareText
          : Files;
  // v2.1 round 276 (Terry) — render-fn (was a const) so the responsive
  // album-detail toolbar can request an ICON-ONLY variant when space
  // is tight. Same popover body either way; compact hides the
  // "Media: <label>" text + min-width and shows a dot when a non-
  // default filter is active.
  const renderMediaButton = (compact = false) => (
    <Popover>
      <IconTooltip label="Filter what's shown — Photos, Videos, Captioned" side="bottom">
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="albums-media-filter"
            className={`inline-flex items-center ${compact ? 'justify-center w-8' : 'justify-between min-w-[150px]'} gap-1.5 h-8 px-3 rounded-md text-xs font-medium border transition-colors ${!mediaIsDefault ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background hover:bg-accent text-foreground'}`}
          >
            <span className="inline-flex items-center gap-1.5 relative">
              <MediaChipIcon className="w-3.5 h-3.5" />
              {!compact && <span className="text-muted-foreground/85">Media:</span>}
              {!compact && <span>{mediaShortLabel}</span>}
              {!mediaIsDefault && compact && (
                <span className="absolute -top-1.5 -right-2 w-2 h-2 rounded-full bg-primary" />
              )}
            </span>
            {!compact && <ChevronDown className="w-3.5 h-3.5 opacity-70" />}
          </button>
        </PopoverTrigger>
      </IconTooltip>
      <PopoverContent align="start" className="w-64 p-1">
        <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider px-3 pt-2 pb-1">Type</p>
        <RadioGroup value={mediaFilter} onValueChange={(v) => setMediaFilter(v as 'all' | 'photos' | 'videos')} className="gap-0">
          {([
            { key: 'all' as const, label: 'All media', Icon: Files, count: albumPhotos.length },
            { key: 'photos' as const, label: 'Photos', Icon: ImageIcon, count: mediaPhotoCount },
            { key: 'videos' as const, label: 'Videos', Icon: Film, count: mediaVideoCount },
          ]).map(({ key, label, Icon, count }) => (
            <label key={key} htmlFor={`albums-media-${key}`} className="flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm cursor-pointer hover:bg-muted/50 transition-colors">
              <span className="inline-flex items-center gap-2 text-foreground">
                <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                {label}
              </span>
              <span className="inline-flex items-center gap-3">
                <span className="text-xs text-muted-foreground">{count.toLocaleString()}</span>
                <RadioGroupItem id={`albums-media-${key}`} value={key} />
              </span>
            </label>
          ))}
        </RadioGroup>
        <div className="h-px bg-border my-1" />
        <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider px-3 pt-1 pb-1">Also filter</p>
        <label className={`flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm transition-colors ${mediaCaptionedCount === 0 ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-muted/50'}`}>
          <span className="inline-flex items-center gap-2 text-foreground">
            <MessageSquareText className="w-3.5 h-3.5 text-muted-foreground" />
            Captions
          </span>
          <span className="inline-flex items-center gap-3">
            <span className="text-xs text-muted-foreground">{mediaCaptionedCount.toLocaleString()}</span>
            <Checkbox checked={captionedOnly} disabled={mediaCaptionedCount === 0} onCheckedChange={(v) => setCaptionedOnly(!!v)} />
          </span>
        </label>
      </PopoverContent>
    </Popover>
  );

  // v2.0.15 (Terry 2026-05-29) — refresh consolidated into the
  // titlebar (next to the Recycle Bin icon). AlbumsView listens to
  // pdr:refreshActiveView via the useEffect below. refreshButton
  // kept as null so the three existing {refreshButton} render points
  // don't need to be hunted down and removed individually — gap-2
  // collapses cleanly when the child renders nothing.
  const refreshButton: React.ReactNode = null;

  // v2.1 round 276 (Terry) — Add-files control as a render-fn so the
  // responsive album-detail toolbar can show it full-label, icon-only,
  // or skip it (it's relocated into "⋯ More" at the narrowest width).
  // Same controlled Popover + same two destination dispatches as the
  // original inline block; only the trigger chrome changes. Guarded on
  // selectedAlbum (only the album-detail branch calls it, and only for
  // user_created albums — the caller still gates on source).
  const renderAddFilesControl = (compact = false) => {
    if (!selectedAlbum) return null;
    const albumId = selectedAlbum.id;
    const albumTitle = selectedAlbum.title;
    return (
      <Popover open={addFilesPopoverOpen} onOpenChange={setAddFilesPopoverOpen}>
        <IconTooltip label="Pick more photos from Search & Discovery or By Date" side="bottom">
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              className={compact ? 'justify-center w-8 px-0 h-8' : 'gap-1.5 px-3 py-1 h-auto text-xs'}
              data-testid="button-album-add-from-elsewhere"
            >
              <Plus className="w-3.5 h-3.5" />
              {!compact && 'Add files'}
            </Button>
          </PopoverTrigger>
        </IconTooltip>
        <PopoverContent align="end" className="w-64 p-1">
          <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider px-3 pt-2 pb-1">
            Pick photos from…
          </p>
          <button
            type="button"
            onClick={() => {
              setAddFilesPopoverOpen(false);
              window.dispatchEvent(new CustomEvent('pdr:openSearchDiscovery', {
                detail: { from: { albumId, title: albumTitle } },
              }));
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-md hover:bg-muted/50 text-sm text-foreground transition-colors"
            data-testid="album-add-from-sd"
          >
            <SearchIcon className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="font-medium">Search &amp; Discovery</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setAddFilesPopoverOpen(false);
              window.dispatchEvent(new CustomEvent('pdr:memoriesSwitchTab', {
                detail: { tab: 'byDate', from: { albumId, title: albumTitle } },
              }));
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-md hover:bg-muted/50 text-sm text-foreground transition-colors"
            data-testid="album-add-from-bydate"
          >
            <CalendarRange className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="font-medium">Dates</span>
          </button>
        </PopoverContent>
      </Popover>
    );
  };

  // v2.1 round 276 (Terry) — density control. Full segmented
  // DensityToggle when there's room; an icon-only toggle button in
  // compact mode (the shared DensityToggle has baked-in "Spacious /
  // Tight" text labels and lives in ui/, which is out of scope to
  // edit — so the compact form is a small local icon button that
  // flips the SAME density state). Layers icon = spacious (gaps),
  // Rows/LayoutGrid swap conveys tight; we keep one glyph + tooltip
  // for clarity.
  const renderDensityControl = (compact = false) => {
    if (!compact) {
      return <DensityToggle value={density} onChange={setDensity} testId="albums-density-toggle" />;
    }
    return (
      <IconTooltip
        label={density === 'spacious' ? 'Density: Spacious — switch to Tight' : 'Density: Tight — switch to Spacious'}
        side="bottom"
      >
        <button
          type="button"
          onClick={() => setDensity(density === 'spacious' ? 'tight' : 'spacious')}
          className={`inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs font-medium transition-colors ${density === 'tight' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background hover:bg-accent text-foreground'}`}
          data-testid="albums-density-toggle-compact"
          aria-label="Toggle density"
        >
          {/* Dense grid glyph when tight, layered glyph when spacious —
              the icon itself signals current state (reinforced by the
              lavender active border). */}
          {density === 'tight' ? <LayoutGrid className="w-3.5 h-3.5" /> : <Layers className="w-3.5 h-3.5" />}
        </button>
      </IconTooltip>
    );
  };

  // v2.1 round 276 (Terry) — "⋯ More" overflow menu for the narrowest
  // album-detail toolbar (toolbarVeryCompact). Relocates the SAME
  // collapsible control components — full-label Media + Display
  // popovers, the Add-files popover, and the DensityToggle — into a
  // dropdown, stacked as rows. We DON'T reimplement their internals;
  // we render the very same components, just inside the menu.
  //
  // Nested-portal note: these children open their own Radix popovers.
  // A DropdownMenu normally closes when you interact "outside" it —
  // which a nested popover's portal counts as. We keep the More menu
  // open while the user works a nested popover by vetoing
  // onInteractOutside / onFocusOutside when the event target sits in a
  // Radix popper wrapper ([data-radix-popper-content-wrapper]) — i.e.
  // inside one of OUR nested popovers — and by running modal={false}
  // so the page doesn't lock. Closing the More menu itself (Escape /
  // click its trigger / click truly outside) still works.
  const renderMoreMenu = () => {
    const insideNestedPopper = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest('[data-radix-popper-content-wrapper]');
    return (
      <DropdownMenu modal={false}>
        <IconTooltip label="More view controls — Media, Display, density, Add files" side="bottom">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border bg-background hover:bg-accent text-foreground transition-colors"
              data-testid="albums-toolbar-more"
              aria-label="More controls"
            >
              <span className="text-base leading-none font-semibold tracking-widest">⋯</span>
            </button>
          </DropdownMenuTrigger>
        </IconTooltip>
        <DropdownMenuContent
          align="end"
          className="p-2 min-w-[230px]"
          onInteractOutside={(e) => { if (insideNestedPopper(e.target)) e.preventDefault(); }}
          onFocusOutside={(e) => { if (insideNestedPopper(e.target)) e.preventDefault(); }}
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider px-1">View</span>
            {renderMediaButton(false)}
            {renderDisplayButton(false)}
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-xs text-muted-foreground">Spacing</span>
              <DensityToggle value={density} onChange={setDensity} testId="albums-density-toggle-more" />
            </div>
            {selectedAlbum?.source === 'user_created' && (
              <div className="pt-1">{renderAddFilesControl(false)}</div>
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
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
            {/* Zoom pill + Density toggle — zoom drives tile size,
                density drives gap. Zoom sits LEFT of density so the
                "size" control reads as preceding the "spacing"
                control. Both share state across the All-albums /
                per-group / detail surfaces. */}
            <div className="ml-auto flex items-center gap-2 shrink-0">
              {/* v2.1 round 276 (Terry) — displayButton is now a render-fn;
                  All-albums view stays full-label (not space-constrained). */}
              {renderDisplayButton()}
              {refreshButton}
              <DensityToggle value={density} onChange={setDensity} testId="albums-all-density-toggle" />
            </div>
          </div>
          <div ref={gridScrollRef} className="flex-1 overflow-y-auto px-6 pt-3 pb-4">
            {allSorted.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No albums yet. Use "New album" on the left to create one, or import a Google Photos Takeout to auto-populate.
              </p>
            ) : (
              <div
                className={`grid ${density === 'tight' ? 'gap-1' : 'gap-3'}`}
                style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${albumCardTilePx}px, 1fr))` }}
              >
                {allSorted.map((album, idx) => {
                  const ap = getSourceProfileForAlbum(album);
                  const AIcon = ap.Icon;
                  return (
                    <button
                      key={`all-${album.id}`}
                      type="button"
                      onClick={() => navigateSelection({ type: 'album', id: album.id })}
                      draggable
                      data-cover-path={album.coverPath ?? undefined}
                      // All-albums grid has no specific source-group
                      // context (the album might live in several
                      // groups). Pass null → drop handler falls back
                      // to COPY semantics, which is the safe default.
                      onDragStart={(e) => handleAlbumDragStart(e, album.id, null)}
                      // Premium hover: 2px lift + softer shadow.
                      // ease-out 200ms matches FileCard/MonthTile.
                      // hover:z-10 keeps the shadow above neighbour
                      // tiles instead of being clipped.
                      //
                      // First-paint stagger: capped at 8 cells * 30ms
                      // so the slowest tile starts at 240ms — past
                      // that the stagger becomes a slog. Duration via
                      // inline style to avoid clashing with the
                      // duration-200 class (Tailwind duration affects
                      // both transition AND animation).
                      className={`flex flex-col rounded-lg bg-card overflow-hidden text-left hover:ring-2 hover:ring-primary/40 hover:-translate-y-[2px] hover:shadow-lg hover:z-10 relative transition-all duration-200 ease-out cursor-grab active:cursor-grabbing animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both ${ap.cardBgClass}`}
                      style={{ animationDelay: `${Math.min(idx, 8) * 30}ms`, animationDuration: '400ms' }}
                    >
                      {/* Cover image container — square via BOTH the
                          aspect-square utility AND explicit inline
                          aspectRatio. The class alone wasn't reliably
                          forcing a 1:1 ratio inside the flex-col card
                          (Terry 2026-05-21 screenshot showed cards in
                          the same row with dramatically different
                          heights). The img inside gets w-full + h-full +
                          absolute positioning so its intrinsic
                          dimensions can't leak through to grow the
                          container vertically. */}
                      <div className="aspect-square bg-muted relative overflow-hidden" style={{ aspectRatio: '1 / 1' }}>
                        {album.coverPath && thumbs[album.coverPath] ? (
                          <img src={thumbs[album.coverPath]} alt={album.title} className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
                        ) : album.coverPath ? (
                          <div className="absolute inset-0 skeleton-shimmer" />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center">
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
            {/* Zoom + Density — follows the user across all three
                surfaces (All-albums / per-group / album detail).
                State is shared, so resizing here also resizes
                everywhere else. */}
            <div className="ml-auto flex items-center gap-2 shrink-0">
              {/* v2.1 round 276 (Terry) — full-label render-fn call. */}
              {renderDisplayButton()}
              {refreshButton}
              <DensityToggle value={density} onChange={setDensity} testId="albums-group-density-toggle" />
            </div>
          </div>
          <div ref={gridScrollRef} className="flex-1 overflow-y-auto px-6 pt-3 pb-4">
            {selectedGroupAlbumIds.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                {isGroupDroppable(selectedGroup)
                  ? 'This folder is empty. Drag album rows from the tree on the left into the folder header to add them here.'
                  : 'No albums in this source yet.'}
              </p>
            ) : (
              <div
                className={`grid ${density === 'tight' ? 'gap-1' : 'gap-3'}`}
                style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${albumCardTilePx}px, 1fr))` }}
              >
                {selectedGroupAlbumIds.map((id, idx) => {
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
                      data-cover-path={album.coverPath ?? undefined}
                      // Group view = clear source-group context.
                      // Drag from a user folder → MOVE semantics
                      // apply on drop (CTRL = copy). Drag from a
                      // source auto-group (Google Photos / PDR) →
                      // COPY always.
                      onDragStart={(e) => handleAlbumDragStart(e, album.id, selectedGroup.id)}
                      // Premium hover + stagger first-paint — mirrors
                      // the all-albums grid above.
                      className={`flex flex-col rounded-lg bg-card overflow-hidden text-left hover:ring-2 hover:ring-primary/40 hover:-translate-y-[2px] hover:shadow-lg hover:z-10 relative transition-all duration-200 ease-out cursor-grab active:cursor-grabbing animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both ${ap.cardBgClass}`}
                      style={{ animationDelay: `${Math.min(idx, 8) * 30}ms`, animationDuration: '400ms' }}
                    >
                      {/* Cover image container — square via BOTH the
                          aspect-square utility AND explicit inline
                          aspectRatio. The class alone wasn't reliably
                          forcing a 1:1 ratio inside the flex-col card
                          (Terry 2026-05-21 screenshot showed cards in
                          the same row with dramatically different
                          heights). The img inside gets w-full + h-full +
                          absolute positioning so its intrinsic
                          dimensions can't leak through to grow the
                          container vertically. */}
                      <div className="aspect-square bg-muted relative overflow-hidden" style={{ aspectRatio: '1 / 1' }}>
                        {album.coverPath && thumbs[album.coverPath] ? (
                          <img src={thumbs[album.coverPath]} alt={album.title} className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
                        ) : album.coverPath ? (
                          <div className="absolute inset-0 skeleton-shimmer" />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center">
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
          {/* v2.1 round 276 (Terry) — headerToolbarRef drives the
              responsive overflow (ResizeObserver → toolbarCompact /
              toolbarVeryCompact). min-w-0 lets the row actually shrink
              below its content so the observer sees narrow widths. */}
          <div ref={headerToolbarRef} className="flex items-center gap-3 px-6 py-3 border-b border-border min-w-0">
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
                {/* Rename pencil shown on every album source — Terry
                    2026-05-21: PDR owns the local title once imported. */}
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
                <span className="text-xs text-muted-foreground">{selectedAlbum.photoCount} photo{selectedAlbum.photoCount === 1 ? '' : 's'}</span>
                {selectedAlbum.source === 'takeout_imported' && (
                  <span className="text-xs text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full shrink-0">From Google Takeout</span>
                )}
                {/* v2.0.13 (Terry 2026-05-27) — Captioned-only filter.
                    Gold styling when active so it visually links to the
                    gold caption tooltip / badge across the rest of PDR.
                    Only rendered when at least one photo in this album
                    has a caption — otherwise the toggle would just
                    confuse the user with an empty result set. */}
                {(() => {
                  const captionedCount = albumPhotos.filter((p) => p.caption && p.caption.length > 0).length;
                  if (captionedCount === 0) return null;
                  return (
                    <IconTooltip label={captionedOnly ? 'Show all photos' : 'Show only photos with captions'} side="bottom">
                      <button
                        type="button"
                        onClick={() => setCaptionedOnly((v) => !v)}
                        data-testid="album-captioned-only-toggle"
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ${
                          captionedOnly
                            ? 'bg-[var(--color-gold)] border-[var(--color-gold)] text-[#1f1a08]'
                            : 'bg-background border-border text-muted-foreground hover:text-foreground hover:bg-accent'
                        }`}
                      >
                        <MessageSquareText className="w-3 h-3" />
                        Captioned only · {captionedCount.toLocaleString()}
                      </button>
                    </IconTooltip>
                  );
                })()}
                {/* Right-cluster: + (add from elsewhere) + zoom +
                    density + Export-as-PL CTA. Order reads left-to-
                    right as "summon photos → size → spacing →
                    export". + is hidden for source-imported albums
                    (content-locked) — same gating the right-click
                    menu uses. All controls reuse shared primitives. */}
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  {/* v2.1 round 275 (Terry) — multi-select Actions
                      toolbar, ported verbatim from MemoriesView (Dates,
                      the reference block) for full parity. Gated on a
                      live selection. Substitutions vs Dates:
                      selectedFileIds→selectedAlbumPhotoIds,
                      clearSelection→clearAlbumSelection, base =
                      albumPhotos.filter(selected), return-source uses
                      the ALBUM shape, "Set as monthly thumbnail" →
                      "Set as album thumbnail", recycle bumps
                      albumPhotosRefreshTick (RISK 1), plus a NEW
                      "Create new album from N" item. All handlers are
                      the existing shared ones (openSearchViewer,
                      openCollageComposer, moveToRecycleBin,
                      setAlbumCoverPhoto, transcribeVideoPaths, the
                      pdr:sendToSearchPile event, AddToAlbumPopover via
                      open-ticks). */}
                  {selectedAlbumPhotoIds.size > 0 && (() => {
                    const base = albumPhotos.filter(p => selectedAlbumPhotoIds.has(p.id));
                    const selectedVideos = base.filter(f => isVideoPathExt(f.file_path));
                    return (
                      <DropdownMenu open={actionsGrace.open} onOpenChange={actionsGrace.setOpen}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="sm"
                            data-testid="albums-selection-actions"
                            className="bg-[var(--color-gold)] border border-[var(--color-gold)] hover:opacity-90 text-[#1f1a08] hover:bg-[var(--color-gold)]"
                            {...actionsGrace.triggerHoverProps}
                          >
                            Actions
                            <ChevronDown className="w-3.5 h-3.5 ml-1.5 opacity-80" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[260px]" {...actionsGrace.contentHoverProps}>
                          <DropdownMenuItem
                            onSelect={() => {
                              if (base.length === 0) return;
                              openSearchViewer(base.map(f => f.file_path), base.map(f => f.filename));
                            }}
                            data-testid="albums-actions-open-viewer"
                          >
                            <PlayCircle className="w-3.5 h-3.5 mr-2" />
                            Open {selectedAlbumPhotoIds.size} Selected in Viewer
                          </DropdownMenuItem>
                          {selectedAlbumPhotoIds.size === 1 && (
                            <DropdownMenuItem
                              onSelect={() => {
                                const target = base[0];
                                if (!target) return;
                                (window as any).pdr?.revealInFolder?.(target.file_path);
                              }}
                              data-testid="albums-actions-reveal"
                            >
                              <HardDrive className="w-3.5 h-3.5 mr-2" />
                              Show in File Explorer
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {/* Send to S&D (replace) + Add to S&D pile
                              (accumulate). Album-shape return-source so the
                              back-pill drills back into THIS album — copied
                              from the Albums per-photo context menu below. */}
                          <DropdownMenuItem
                            onSelect={() => {
                              const fileIds = Array.from(selectedAlbumPhotoIds);
                              if (fileIds.length === 0) return;
                              void import('@/lib/memories-return-source').then(m => m.setMemoriesReturnSource({ tab: 'albums', label: `Album "${selectedAlbum.title}"`, albumId: selectedAlbum.id }));
                              window.dispatchEvent(new CustomEvent('pdr:sendToSearchPile', {
                                detail: { fileIds, source: 'albums', mode: 'replace' },
                              }));
                            }}
                            data-testid="albums-actions-send-to-sd"
                          >
                            <SearchIcon className="w-3.5 h-3.5 mr-2" />
                            Send {selectedAlbumPhotoIds.size} to S&amp;D
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              const fileIds = Array.from(selectedAlbumPhotoIds);
                              if (fileIds.length === 0) return;
                              void import('@/lib/memories-return-source').then(m => m.setMemoriesReturnSource({ tab: 'albums', label: `Album "${selectedAlbum.title}"`, albumId: selectedAlbum.id }));
                              window.dispatchEvent(new CustomEvent('pdr:sendToSearchPile', {
                                detail: { fileIds, source: 'albums', mode: 'accumulate' },
                              }));
                            }}
                            data-testid="albums-actions-add-to-sd-pile"
                          >
                            <SearchIcon className="w-3.5 h-3.5 mr-2" />
                            Add {selectedAlbumPhotoIds.size} to S&amp;D pile
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => { setAddToAlbumOpenTick(t => t + 1); }}
                            data-testid="albums-actions-add-to-album"
                          >
                            <FolderPlus className="w-3.5 h-3.5 mr-2" />
                            Add to album…
                          </DropdownMenuItem>
                          {/* v2.1 round 275 (Terry) — NEW: create a fresh
                              album straight from the selection. Opens the
                              AddToAlbumPopover directly in create mode via
                              openCreateTrigger → handleCreateAndAdd makes
                              the album + adds these photos in one go. */}
                          <DropdownMenuItem
                            onSelect={() => { setAddToAlbumCreateTick(t => t + 1); }}
                            data-testid="albums-actions-create-album"
                          >
                            <FolderPlus className="w-3.5 h-3.5 mr-2" />
                            Create new album from {selectedAlbumPhotoIds.size} photo{selectedAlbumPhotoIds.size === 1 ? '' : 's'}…
                          </DropdownMenuItem>
                          {/* Create Collage from 2+ selected photos →
                              composer → PDRV. Photos only (videos can't be
                              tiled into a still collage). */}
                          {(() => {
                            const photos = base.filter(f => !isVideoPathExt(f.file_path));
                            if (photos.length < 2) return null;
                            return (
                              <DropdownMenuItem
                                onSelect={() => { void openCollageComposer(photos.map(p => p.file_path)); }}
                                data-testid="albums-actions-create-collage"
                              >
                                <LayoutGrid className="w-3.5 h-3.5 mr-2" />
                                Create collage from {photos.length} photos…
                              </DropdownMenuItem>
                            );
                          })()}
                          {/* v2.1 round 276 (Terry) — export ONLY the
                              selected photos as a Parallel Library. The
                              standalone header "Export Album…" button is
                              hidden while a selection is live; this is its
                              selection-scoped counterpart. Same Copy icon
                              + fixActive guard as that button (PL shares
                              the Fix copy engine). */}
                          <DropdownMenuItem
                            onSelect={startExportSelectedAsPL}
                            disabled={fixActive}
                            data-testid="albums-actions-export-pl"
                          >
                            <Copy className="w-3.5 h-3.5 mr-2" />
                            Export {selectedAlbumPhotoIds.size} Selected as Parallel Library
                          </DropdownMenuItem>
                          {/* v2.1 round 279 (Terry) — Sharing Phase 2: send the
                              selected photos to a phone over local Wi-Fi (QR). */}
                          <DropdownMenuItem
                            onSelect={() => window.dispatchEvent(new CustomEvent('pdr:sendToPhone', { detail: { paths: base.map(f => f.file_path) } }))}
                            data-testid="albums-actions-send-phone"
                          >
                            <Smartphone className="w-3.5 h-3.5 mr-2" />
                            Send {selectedAlbumPhotoIds.size} to Phone…
                          </DropdownMenuItem>
                          {/* v2.1 round 280 (Terry) — Sharing Phase 3: print the
                              selection (any printer + Print to PDF). */}
                          <DropdownMenuItem
                            onSelect={() => window.dispatchEvent(new CustomEvent('pdr:printPhotos', { detail: { paths: base.map(f => f.file_path) } }))}
                            data-testid="albums-actions-print"
                          >
                            <Printer className="w-3.5 h-3.5 mr-2" />
                            Print {selectedAlbumPhotoIds.size}…
                          </DropdownMenuItem>
                          {selectedVideos.length > 0 && (
                            <DropdownMenuItem
                              onSelect={() => transcribeVideoPaths(selectedVideos.map(v => v.file_path))}
                              data-testid="albums-actions-transcribe"
                            >
                              <Captions className="w-3.5 h-3.5 mr-2" />
                              Transcribe {selectedVideos.length} video{selectedVideos.length === 1 ? '' : 's'}…
                            </DropdownMenuItem>
                          )}
                          {/* Set as ALBUM thumbnail — single-photo only.
                              Replaces Dates' "Set as monthly thumbnail";
                              same setAlbumCoverPhoto + refreshAll the
                              per-photo menu uses. */}
                          {selectedAlbumPhotoIds.size === 1 && (
                            <DropdownMenuItem
                              onSelect={async () => {
                                const target = base[0];
                                if (!target) return;
                                const result = await setAlbumCoverPhoto(selectedAlbum.id, target.id);
                                if (result.success) {
                                  void refreshAll();
                                  toast.success('Album thumbnail set', {
                                    description: `“${selectedAlbum.title}” now uses this photo`,
                                  });
                                } else {
                                  toast.error("Couldn't set album thumbnail", { description: result.error });
                                }
                              }}
                              data-testid="albums-actions-set-album-thumb"
                            >
                              <Star className="w-3.5 h-3.5 mr-2" />
                              Set as album thumbnail
                            </DropdownMenuItem>
                          )}
                          {/* Copy filename(s) — newline-separated for
                              multi-select (matches Dates). */}
                          <DropdownMenuItem
                            onSelect={async () => {
                              if (base.length === 0) return;
                              const names = base.map(f => f.filename).join('\n');
                              try {
                                await navigator.clipboard.writeText(names);
                                toast.success(
                                  base.length === 1 ? 'Filename copied' : `Copied ${base.length} filenames`,
                                  base.length === 1 ? { description: base[0].filename } : undefined,
                                );
                              } catch {
                                toast.error("Couldn't copy filename" + (base.length === 1 ? '' : 's'));
                              }
                            }}
                            data-testid="albums-actions-copy-filenames"
                          >
                            <Copy className="w-3.5 h-3.5 mr-2" />
                            {selectedAlbumPhotoIds.size === 1 ? 'Copy filename' : `Copy ${selectedAlbumPhotoIds.size} filenames`}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={async () => {
                              const ids = Array.from(selectedAlbumPhotoIds);
                              if (ids.length === 0) return;
                              const r = await moveToRecycleBin(ids);
                              if (r.success) {
                                toast.success(`Moved ${r.count ?? ids.length} to Recycle Bin`);
                                clearAlbumSelection();
                                // v2.1 round 275 (Terry) — RISK 1: force the
                                // album-photos loader to re-run so deleted
                                // tiles vanish (refreshAll alone reloads only
                                // albums/groups/memberships, not albumPhotos).
                                setAlbumPhotosRefreshTick(t => t + 1);
                                void refreshAll();
                              } else {
                                toast.error('Couldn’t move to Recycle Bin', { description: r.error });
                              }
                            }}
                            className="text-destructive focus:text-destructive"
                            data-testid="albums-actions-delete"
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-2" />
                            Move {selectedAlbumPhotoIds.size} to Recycle Bin
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    );
                  })()}
                  {selectedAlbumPhotoIds.size > 0 && (
                    <>
                      <IconTooltip label="Clear selection" side="bottom">
                        <button
                          onClick={clearAlbumSelection}
                          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-[var(--color-gold)] bg-[var(--color-gold)] hover:opacity-90 text-xs font-medium text-[#1f1a08] transition-colors"
                          data-testid="albums-selection-chip"
                        >
                          {selectedAlbumPhotoIds.size} selected
                          <X className="w-3 h-3 opacity-70" />
                        </button>
                      </IconTooltip>
                      {/* v2.1 round 277 (Terry) — Sharing Phase 1
                          discoverability cue (mirrors MemoriesView). Static
                          muted hint that selected tiles can be dragged out
                          to another app / email; the in-motion "Drag (N)"
                          gold badge is the during-drag affordance. */}
                      {/* v2.1 round 278 (Terry) — AI-styled cue (sparkle +
                          violet→fuchsia gradient + glow) so it gets noticed;
                          mirrors MemoriesView. Not AI, just attention. */}
                      <IconTooltip label="Drag any selected photo to another app, email, or folder — they all come along" side="bottom">
                        <span className="hidden sm:inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full select-none text-[11px] font-semibold text-violet-700 dark:text-violet-200 bg-gradient-to-r from-violet-100 to-fuchsia-100 dark:from-violet-500/20 dark:to-fuchsia-500/20 border border-violet-300/70 dark:border-violet-400/30 shadow-[0_0_10px_rgba(139,92,246,0.25)]">
                          <Sparkles className="w-3.5 h-3.5" />
                          drag to share
                        </span>
                      </IconTooltip>
                      {/* Hidden AddToAlbumPopover anchor — squashed off-
                          screen so it serves only as the popover anchor
                          the Actions items open via open-ticks (list mode
                          + create mode). Mirrors the MemoriesView pattern. */}
                      <div className="absolute -left-[9999px] top-0">
                        <AddToAlbumPopover
                          fileIds={Array.from(selectedAlbumPhotoIds)}
                          onAdded={clearAlbumSelection}
                          openTrigger={addToAlbumOpenTick}
                          openCreateTrigger={addToAlbumCreateTick}
                        />
                      </div>
                    </>
                  )}
                  {/* v2.1 round 276 (Terry) — COLLAPSIBLE view controls.
                      Three responsive states driven by the
                      headerToolbarRef ResizeObserver:
                        • veryCompact → all fold into the "⋯ More" menu.
                        • compact     → icon-only (tooltips retained):
                                        Add files / Media / Display / density.
                        • wide        → full labels, exactly as before.
                      The Actions dropdown, the N-selected pill, and the
                      Export-Album button (below) are HIGH-priority and
                      never collapse. */}
                  {toolbarVeryCompact ? (
                    renderMoreMenu()
                  ) : toolbarCompact ? (
                    <>
                      {selectedAlbum.source === 'user_created' && renderAddFilesControl(true)}
                      {renderMediaButton(true)}
                      {renderDisplayButton(true)}
                      {refreshButton}
                      {renderDensityControl(true)}
                    </>
                  ) : (
                    <>
                      {selectedAlbum.source === 'user_created' && renderAddFilesControl(false)}
                      {renderMediaButton(false)}
                      {renderDisplayButton(false)}
                      {refreshButton}
                      {renderDensityControl(false)}
                    </>
                  )}
                  {/* v2.1 round 276 (Terry) — HIGH-priority "Export Album
                      as Parallel Library" CTA. Renamed from "Export as
                      Parallel Library" and now gated to render ONLY when
                      there's NO photo selection — with a selection live,
                      its selection-scoped counterpart lives in the
                      Actions dropdown ("Export N Selected as Parallel
                      Library"). Never collapses to an icon (it's a
                      primary action). */}
                  {selectedAlbumPhotoIds.size === 0 && (
                    <IconTooltip
                      label={
                        fixActive
                          ? `${FIX_BLOCKED_TOOLTIP} — Parallel Libraries use the same copy engine as the Fix.`
                          : selectedAlbum.photoCount === 0
                            ? 'Add photos to this album before exporting'
                            : `Copy these ${selectedAlbum.photoCount} photo${selectedAlbum.photoCount === 1 ? '' : 's'} into a Parallel Library`
                      }
                      side="bottom"
                    >
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          if (fixActive || albumPhotos.length === 0) return;
                          startExportAlbumAsPL(selectedAlbum);
                        }}
                        disabled={fixActive || albumPhotos.length === 0}
                        className="gap-1.5 px-3 py-1 h-auto text-xs"
                        data-testid="button-album-export-pl"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        Export Album as Parallel Library
                      </Button>
                    </IconTooltip>
                  )}
                </div>
              </>
            )}
          </div>
          {/* Right-click context menu wraps the photo grid area — lets
              the user summon photos into THIS album from S&D or
              By Date without first emptying it (Terry 2026-05-19:
              "users can populate their albums actively which is
              super fucking cool. It shouldn't be resigned to only
              empty albums"). Items only render for user-created
              albums; Takeout-imported albums are content-locked. */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
          <div ref={gridScrollRef} className="flex-1 overflow-y-auto px-6 pb-4">
            {/* v2.1 round 102 (Terry 2026-06-11) — sticky day-banner,
                gated on the new groupByDay toggle in the Display
                popover. Was a floating top-right pill (round 88)
                that faded after 1.2 s; now a full-width band that
                lands hard-flush against the toolbar above as the
                user scrolls. Verbatim copy of the Memories Dates
                sticky-banner recipe (round 100): solid
                bg-background (no backdrop-blur), -mx-6 px-6 py-2,
                border-b border-border/60, text-sm font-semibold
                text-foreground, pointer-events-none. Scroll
                container's `pt-3` dropped so sticky top-0 actually
                lands at the toolbar's bottom border (same lesson
                from MemoriesView round 100 — sticky pins to the
                padding edge). aria-live polite so screen readers
                announce the day change as the user scrolls. */}
            {scrollDateLabel && groupByDay && (
              <div
                className="pointer-events-none sticky top-0 z-30 -mx-6 px-6 py-2 bg-background border-b border-border/60 text-sm font-semibold text-foreground"
                data-testid="albums-sticky-day"
                aria-live="polite"
              >
                {scrollDateLabel}
              </div>
            )}
            {albumPhotosLoading ? (
              <p className="text-sm text-muted-foreground">Loading photos…</p>
            ) : albumPhotos.length === 0 ? (
              <>
                {/* Empty-album CTA — premium polish pass (Terry
                    2026-05-19). Icon swapped from the generic mountain
                    ImageIcon to lucide `Images` (a stack of photos) so
                    the surface reads as "a collection waiting to be
                    filled," not a missing-thumbnail placeholder. Two
                    CTAs share a min-w-200px so they balance side-by-
                    side instead of two different widths. Both dispatch
                    nav events with the album id+title in detail so
                    the destination surface can show a back-to-album
                    pill until the user navigates to a different app. */}
              <div className="flex flex-col items-center justify-center text-center py-20">
                <div className="relative mb-4">
                  <span className="absolute inset-0 rounded-2xl bg-primary/10 blur-xl" aria-hidden="true" />
                  <Images className="relative w-12 h-12 text-primary/70" />
                </div>
                <p className="text-base text-foreground font-semibold mb-1.5">This album is empty</p>
                <p className="text-xs text-muted-foreground max-w-sm mb-6 leading-relaxed">
                  Pick photos from <strong className="text-foreground">Memories By Date</strong> or <strong className="text-foreground">Search &amp; Discovery</strong>, then use <em>Add to Album</em> to drop them in here.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => window.dispatchEvent(new CustomEvent('pdr:memoriesSwitchTab', {
                      detail: { tab: 'byDate', from: { albumId: selectedAlbum.id, title: selectedAlbum.title } },
                    }))}
                    className="gap-1.5 px-4 py-1.5 h-auto text-xs min-w-[200px] justify-center"
                    data-testid="button-empty-album-go-bydate"
                  >
                    <CalendarRange className="w-3.5 h-3.5" />
                    Go to By Date
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => window.dispatchEvent(new CustomEvent('pdr:openSearchDiscovery', {
                      detail: { from: { albumId: selectedAlbum.id, title: selectedAlbum.title } },
                    }))}
                    className="gap-1.5 px-4 py-1.5 h-auto text-xs min-w-[200px] justify-center"
                    data-testid="button-empty-album-go-sd"
                  >
                    <SearchIcon className="w-3.5 h-3.5" />
                    Go to Search &amp; Discovery
                  </Button>
                </div>
              </div>
              </>
            ) : (
              <>
                {/* Photo grid — gap + tile-rounding driven by the
                    density toggle. Spacious = breathing room (gap-3,
                    rounded corners). Tight = dense wall view (no
                    gaps, no rounding) — matches the By-Date
                    drilldown's tight mode visually. */}
              <div
                data-album-photo-grid
                className={`grid ${density === 'tight' ? 'gap-0' : 'gap-3'}`}
                style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${albumPhotoTilePx}px, 1fr))` }}
              >
                {(() => {
                  // v2.0.15 (Terry 2026-06-01) — capture the visible
                  // photo list once so the click handler can do
                  // shift+click range select against the SAME indexing
                  // as the rendered grid (captionedOnly filtering
                  // changes the index space).
                  // v2.1 round 102 (Terry 2026-06-11) — apply the new
                  // mediaFilter on top of the existing captionedOnly
                  // filter so the Media pill's Photos / Videos radio
                  // actually narrows the visible grid.
                  let visiblePhotos = albumPhotos;
                  if (mediaFilter === 'photos') visiblePhotos = visiblePhotos.filter((p) => p.file_type === 'photo');
                  else if (mediaFilter === 'videos') visiblePhotos = visiblePhotos.filter((p) => p.file_type === 'video');
                  if (captionedOnly) visiblePhotos = visiblePhotos.filter((p) => p.caption && p.caption.length > 0);
                  // v2.1 round 103 (Terry 2026-06-11) — format day labels
                  // the same way the scroll listener does so the inline
                  // divider text matches the sticky banner verbatim.
                  const DAYS_R = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                  const MONTHS_R = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
                  const formatDay = (iso: string): string => {
                    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
                    if (!m) return '';
                    const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
                    if (isNaN(d.getTime())) return '';
                    return `${DAYS_R[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS_R[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
                  };
                  // Track previously seen dayKey so we only render a
                  // divider when the day changes.
                  let prevDayKey: string | null = null;
                  return visiblePhotos.map((p, i) => {
                    const isSelected = selectedAlbumPhotoIds.has(p.id);
                    const myDayKey = p.derived_date?.slice(0, 10) ?? 'no-date';
                    const dayChanged = groupByDay && myDayKey !== prevDayKey;
                    prevDayKey = myDayKey;
                    return (
                  <Fragment key={p.id}>
                  {dayChanged && (
                    /* v2.1 round 103 (Terry 2026-06-11) — inline day
                       divider, spans the full grid width via
                       gridColumn: 1 / -1. Goes `invisible` (CSS
                       visibility:hidden — keeps layout space so the
                       photos below don't jump) when its day matches
                       the day currently in the sticky banner. Same
                       trick as Memories Dates round 101. Typography
                       mirrors the sticky banner so the two surfaces
                       feel of-a-piece. The first divider is always
                       shown so the top of the album reads as a
                       proper day section.
                       Recipe matches the Memories Dates day-header:
                       bg-background, border-b, text-sm font-semibold
                       text-foreground, py-2. */
                    <div
                      ref={(el) => { albumDayHeaderRefs.current[myDayKey] = el; }}
                      style={{ gridColumn: '1 / -1' }}
                      className={`py-2 mt-2 first:mt-0 border-b border-border/60 bg-background text-sm font-semibold text-foreground ${myDayKey === albumScrollDayKey ? 'invisible' : ''}`}
                      data-album-day-key={myDayKey}
                    >
                      {p.derived_date ? formatDay(p.derived_date) : 'Undated'}
                      <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                        {(() => {
                          const sameDay = visiblePhotos.filter((q) => (q.derived_date?.slice(0, 10) ?? 'no-date') === myDayKey).length;
                          return `${sameDay.toLocaleString()} ${sameDay === 1 ? 'photo' : 'photos'}`;
                        })()}
                      </span>
                    </div>
                  )}
                  {/* v2.0.13 — per-photo ContextMenu. The OUTER ContextMenu
                      wrapping the whole grid handles right-clicks on the
                      empty grid area (Add photos from S&D / By Date). This
                      inner ContextMenu takes precedence on a specific
                      photo. CaptionTooltip wraps the whole tile (via the
                      intermediate div) so hovering anywhere on the
                      photo reveals the gold caption preview; the button
                      inside is still ContextMenuTrigger's asChild target,
                      so right-click is unaffected. */}
                  <CaptionTooltip caption={p.caption} side="top">
                    {/* v2.1 round 86 (Terry 2026-06-10) — wrapper
                        carries the aspect-square tile AND the optional
                        filename / date strip rendered below, so the
                        grid cell grows to include the metadata when
                        Insights toggles are on. Single-child contract
                        of CaptionTooltip is preserved by this wrapper.
                        v2.1 round 88 (Terry 2026-06-10) — was `flex
                        flex-col`; that turned each wrapper into a flex
                        container whose children inherited
                        `flex-basis: auto` (= intrinsic content size).
                        The `<img>`'s natural pixel dimensions then
                        leaked through and overrode `aspect-square`
                        for portrait images, making those specific
                        tiles taller than the rest of the row →
                        SS1's "big gaps" under the square neighbours.
                        Plain block wrapper inherits column width and
                        lets aspect-square compute height = width
                        consistently for every tile. */}
                    <div className="block">
                    <div className="aspect-square">
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        // v2.0.15 (Terry 2026-05-28) — native OS drag
                        // to external apps. See MemoriesView for the
                        // full rationale + the File Explorer caveat.
                        data-pick-path={isVideoPathExt(p.file_path) ? undefined : p.file_path}
                        draggable
                        onDragStart={(e) => {
                          // v2.1 round 277 (Terry) — Sharing Phase 1: was
                          // single-file. Now drags the WHOLE selection when
                          // the dragged tile is part of it (mirrors
                          // startExportSelectedAsPL's set), else just this
                          // photo. Routed through the shared helper for the
                          // count badge + never-empty icon guarantee.
                          const dragSet = (selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id))
                            ? albumPhotos.filter((x) => selectedAlbumPhotoIds.has(x.id)).map((x) => x.file_path)
                            : [p.file_path];
                          startFileDrag(e, dragSet, { iconSrc: thumbs[dragSet[0]] });
                        }}
                        onClick={(e) => handleAlbumPhotoClick(visiblePhotos, i, e)}
                        className={`group relative w-full h-full overflow-hidden transition-all ${
                          // v2.0.15 (Terry 2026-06-01) — match Memories'
                          // gold ring on selected tile. Was using
                          // ring-primary (lavender) which clashed with
                          // the existing By Date selection language.
                          isSelected
                            ? 'ring-2 ring-[var(--color-gold)]'
                            : density === 'tight' ? '' : 'rounded-lg border border-border hover:ring-2 hover:ring-primary/40'
                        }`}
                      >
                        {/* v2.0.15 (Terry 2026-06-01) — hover-revealed
                            checkbox, gold fill when selected. Lifted
                            verbatim from MemoriesView so the two
                            surfaces use one selection language. */}
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            const multiActive = selectedAlbumPhotoIds.size > 0;
                            if (e.shiftKey && multiActive && lastAlbumClickedIndexRef.current !== null) {
                              const start = Math.min(lastAlbumClickedIndexRef.current, i);
                              const end = Math.max(lastAlbumClickedIndexRef.current, i);
                              setSelectedAlbumPhotoIds(prev => {
                                const next = new Set(prev);
                                for (let k = start; k <= end; k++) {
                                  const ph = visiblePhotos[k];
                                  if (ph) next.add(ph.id);
                                }
                                return next;
                              });
                              lastAlbumClickedIndexRef.current = i;
                              return;
                            }
                            setSelectedAlbumPhotoIds(prev => {
                              const next = new Set(prev);
                              if (next.has(p.id)) next.delete(p.id);
                              else next.add(p.id);
                              return next;
                            });
                            lastAlbumClickedIndexRef.current = i;
                          }}
                          className={`absolute top-1.5 left-1.5 w-5 h-5 rounded border-2 flex items-center justify-center transition-all cursor-pointer hover:scale-110 z-10 ${
                            isSelected
                              ? 'bg-[var(--color-gold)] border-[var(--color-gold)] text-[#1f1a08] opacity-100'
                              : selectionMode
                                ? 'border-white/80 bg-black/40 text-transparent hover:border-white hover:bg-black/60 opacity-100'
                                : 'border-white/80 bg-black/40 text-transparent hover:border-white hover:bg-black/60 opacity-0 group-hover:opacity-100'
                          }`}
                          data-testid={`album-tile-checkbox-${p.id}`}
                        >
                          {isSelected && <Check className="w-3 h-3" />}
                        </div>
                        {thumbs[p.file_path] ? (
                          <img
                            src={thumbs[p.file_path]}
                            alt={p.filename}
                            className="w-full h-full object-cover"
                            // v2.1 round 87 (Terry 2026-06-10) — anchor
                            // the crop to the TOP of each photo so
                            // portrait images keep heads visible
                            // instead of centre-cropping them off
                            // (Terry SS1: Bowel Cancer fundraiser album
                            // top row showed only the lower half of
                            // each portrait). Landscape photos lose
                            // some bottom (usually floor / foreground)
                            // — a net win on the typical photo album.
                            style={{ objectPosition: 'top' }}
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full skeleton-shimmer" />
                        )}
                        <CaptionBadge caption={p.caption} />
                        {/* v2.1 round 58 (Terry 2026-06-09) — lavender
                            TranscriptBadge sibling. Renders bottom-right
                            (shifts left to make room for CaptionBadge
                            when both exist). The round-57 attempt added
                            a top-right Video pill here as well, but
                            Terry only asked for the "T" indicator —
                            reverted that addition and kept Albums
                            tiles visually as they were apart from the
                            new transcript indicator. */}
                        <TranscriptBadge hasTranscript={isVideoPathExt(p.file_path) && transcribedFileIds.has(p.id)} hasCaption={!!p.caption} />
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {/* v2.1 round 275 (Terry) — Open in viewer, parity
                          with the Dates per-tile menu. Opens just this
                          photo in the shared viewer. */}
                      <ContextMenuItem
                        onSelect={() => { void openSearchViewer([p.file_path], [p.filename]); }}
                        data-testid={`album-photo-open-viewer-${p.id}`}
                      >
                        <PlayCircle className="w-3.5 h-3.5 mr-2" />
                        Open in viewer
                      </ContextMenuItem>
                      {/* v2.0.15 (Terry 2026-05-28) — "Show in File
                          Explorer" opens File Explorer at the photo's
                          folder and highlights the file. */}
                      <ContextMenuItem
                        onSelect={() => { (window as any).pdr?.revealInFolder?.(p.file_path); }}
                        data-testid={`album-photo-reveal-${p.id}`}
                      >
                        <HardDrive className="w-3.5 h-3.5 mr-2" />
                        Show in File Explorer
                      </ContextMenuItem>
                      {/* v2.1 round 138 (Terry) — Create Collage from a
                          multi-selection of album photos → composer →
                          PDRV. Photos only. v2.1 round 154 (Terry) —
                          moved ABOVE the two S&D items so "Send to S&D"
                          + "Add to S&D pile" stay adjacent. */}
                      {(() => {
                        if (!(selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id))) return null;
                        const photos = albumPhotos.filter(ph => selectedAlbumPhotoIds.has(ph.id) && !isVideoPathExt(ph.file_path));
                        if (photos.length < 2) return null;
                        return (
                          <ContextMenuItem
                            onSelect={() => { void openCollageComposer(photos.map(ph => ph.file_path)); }}
                            data-testid={`album-create-collage-${p.id}`}
                          >
                            <LayoutGrid className="w-3.5 h-3.5 mr-2" />
                            Create collage from {photos.length} photos…
                          </ContextMenuItem>
                        );
                      })()}
                      {/* v2.0.15 (Terry 2026-06-05) — Send to S&D.
                          When the right-clicked tile is part of an
                          active multi-select, sends the whole
                          selection; otherwise sends just this one.
                          Default mode is REPLACE — wipes any
                          residual S&D filter / pile state so the
                          arriving selection IS the new S&D contents
                          (instead of being merged into whatever was
                          there from earlier S&D activity). The
                          sibling "Add to S&D pile" below opts in to
                          ACCUMULATE for building up a review set
                          across multiple visits. */}
                      <ContextMenuItem
                        onSelect={() => {
                          const fileIds = selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id)
                            ? Array.from(selectedAlbumPhotoIds)
                            : [p.id];
                          // v2.0.15 (Terry 2026-06-02) — back-pill source.
                          // Label is the album title so the user sees
                          // exactly which album they'll return to;
                          // albumId is needed so the back pill can
                          // actually drill back into THIS album, not
                          // just dump the user at All Albums.
                          void import('@/lib/memories-return-source').then(m => m.setMemoriesReturnSource({ tab: 'albums', label: `Album "${selectedAlbum.title}"`, albumId: selectedAlbum.id, scrollToFileId: p.id }));
                          window.dispatchEvent(new CustomEvent('pdr:sendToSearchPile', {
                            detail: { fileIds, source: 'albums', mode: 'replace' },
                          }));
                        }}
                        data-testid={`album-photo-send-to-sd-${p.id}`}
                      >
                        <SearchIcon className="w-3.5 h-3.5 mr-2" />
                        Send to S&amp;D{selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id) ? ` (${selectedAlbumPhotoIds.size})` : ''}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          const fileIds = selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id)
                            ? Array.from(selectedAlbumPhotoIds)
                            : [p.id];
                          void import('@/lib/memories-return-source').then(m => m.setMemoriesReturnSource({ tab: 'albums', label: `Album "${selectedAlbum.title}"`, albumId: selectedAlbum.id, scrollToFileId: p.id }));
                          window.dispatchEvent(new CustomEvent('pdr:sendToSearchPile', {
                            detail: { fileIds, source: 'albums', mode: 'accumulate' },
                          }));
                        }}
                        data-testid={`album-photo-send-to-sd-pile-${p.id}`}
                      >
                        <SearchIcon className="w-3.5 h-3.5 mr-2" />
                        Add to S&amp;D pile
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      {/* v2.1 round 283 (Terry) — album actions grouped (Create
                          first, then Add), then a separator, then share actions.
                          Whole selection when the right-clicked tile is part of it,
                          else just this photo. */}
                      <ContextMenuItem
                        onSelect={() => {
                          if (!(selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id))) {
                            setSelectedAlbumPhotoIds(new Set([p.id]));
                            lastAlbumClickedIndexRef.current = null;
                          }
                          setAddToAlbumCreateTick(t => t + 1);
                        }}
                      >
                        <FolderPlus className="w-3.5 h-3.5 mr-2" />
                        Create new album…
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          if (!(selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id))) {
                            setSelectedAlbumPhotoIds(new Set([p.id]));
                            lastAlbumClickedIndexRef.current = null;
                          }
                          setAddToAlbumOpenTick(t => t + 1);
                        }}
                        data-testid={`album-photo-add-to-album-${p.id}`}
                      >
                        <FolderPlus className="w-3.5 h-3.5 mr-2" />
                        Add to album…
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() => {
                          const inMulti = selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id);
                          const paths = inMulti ? albumPhotos.filter(x => selectedAlbumPhotoIds.has(x.id)).map(x => x.file_path) : [p.file_path];
                          window.dispatchEvent(new CustomEvent('pdr:sendToPhone', { detail: { paths } }));
                        }}
                      >
                        <Smartphone className="w-3.5 h-3.5 mr-2" />
                        Send to phone…
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          const inMulti = selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id);
                          const paths = inMulti ? albumPhotos.filter(x => selectedAlbumPhotoIds.has(x.id)).map(x => x.file_path) : [p.file_path];
                          window.dispatchEvent(new CustomEvent('pdr:printPhotos', { detail: { paths } }));
                        }}
                      >
                        <Printer className="w-3.5 h-3.5 mr-2" />
                        Print…
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={async () => {
                          try {
                            await navigator.clipboard.writeText(p.filename);
                            toast.success('Filename copied', { description: p.filename });
                          } catch {
                            toast.error("Couldn't copy filename");
                          }
                        }}
                        data-testid={`album-photo-copy-filename-${p.id}`}
                      >
                        <Copy className="w-3.5 h-3.5 mr-2" />
                        Copy filename
                      </ContextMenuItem>
                      {/* v2.1 round 284 (Terry) — Sharing Phase 4: copy the photo
                          as an image to paste into a chat / email / document. */}
                      <ContextMenuItem
                        onSelect={async () => {
                          try {
                            const r = await (window as any).pdr?.clipboard?.copyImage(p.file_path);
                            if (r?.success) toast.success('Image copied', { description: 'Paste it into a chat, email, or document.' });
                            else toast.error(r?.error || "Couldn't copy the image");
                          } catch { toast.error("Couldn't copy the image"); }
                        }}
                      >
                        <ImageIcon className="w-3.5 h-3.5 mr-2" />
                        Copy image
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() => { void editPhotoCaption({ fileId: p.id, filename: p.filename }); }}
                        data-testid={`album-photo-caption-${p.id}`}
                      >
                        <MessageSquareText className="w-3.5 h-3.5 mr-2" />
                        {p.caption ? 'Edit caption…' : 'Add caption…'}
                      </ContextMenuItem>
                      {/* v2.1 round 35 (Terry 2026-06-08) — Transcribe
                          video. Only shows for video files (detected
                          by extension). If the right-clicked tile is
                          part of an active multi-select, transcribe
                          the whole selection (filtered to videos);
                          otherwise just this one. Same hook the
                          MemoriesView + SearchPanel context menus and
                          the Memories toolbar button drive — single
                          source of truth for the confirm modal +
                          progress toast + Whisper batch pipeline. */}
                      {isVideoPathExt(p.file_path) && (
                        <ContextMenuItem
                          onSelect={() => {
                            const inMulti = selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id);
                            const targets = inMulti
                              ? albumPhotos.filter(ph => selectedAlbumPhotoIds.has(ph.id) && isVideoPathExt(ph.file_path)).map(ph => ph.file_path)
                              : [p.file_path];
                            if (targets.length === 0) return;
                            void transcribeVideoPaths(targets);
                          }}
                          data-testid={`album-photo-transcribe-${p.id}`}
                        >
                          <Captions className="w-3.5 h-3.5 mr-2" />
                          Transcribe{selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id)
                            ? ` (${albumPhotos.filter(ph => selectedAlbumPhotoIds.has(ph.id) && isVideoPathExt(ph.file_path)).length})`
                            : ''}…
                        </ContextMenuItem>
                      )}
                      {/* v2.0.13 (Terry 2026-05-26) — "Set as album
                          thumbnail" overrides the auto-picked first-by-
                          date cover. Writes to albums.cover_file_id and
                          refreshes the album list so the change is
                          visible immediately when the user navigates
                          back to the album grid.
                          v2.1 round 137 (Terry) — a cover is one photo,
                          so hide this when a multi-selection is active
                          (size > 1). 0 or 1 selected = fine. */}
                      {selectedAlbumPhotoIds.size <= 1 && (
                      <ContextMenuItem
                        onSelect={async () => {
                          const result = await setAlbumCoverPhoto(selectedAlbum.id, p.id);
                          if (result.success) {
                            void refreshAll();
                            toast.success('Album thumbnail set', {
                              description: `“${selectedAlbum.title}” now uses this photo`,
                            });
                          } else {
                            toast.error("Couldn't set album thumbnail", { description: result.error });
                          }
                        }}
                        data-testid={`album-photo-album-thumb-${p.id}`}
                      >
                        <Star className="w-3.5 h-3.5 mr-2" />
                        Set as album thumbnail
                      </ContextMenuItem>
                      )}
                      {/* v2.1 round 275 (Terry) — Move to Recycle Bin,
                          parity with Dates. Recycles the whole active
                          multi-select if the clicked tile is part of it,
                          else just this one. RISK 1: after the recycle we
                          bump albumPhotosRefreshTick so the grid reloads
                          and the deleted tiles vanish (refreshAll alone
                          does not reload albumPhotos). */}
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={async () => {
                          const ids = selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id)
                            ? Array.from(selectedAlbumPhotoIds)
                            : [p.id];
                          if (ids.length === 0) return;
                          const r = await moveToRecycleBin(ids);
                          if (r.success) {
                            toast.success(`Moved ${r.count ?? ids.length} to Recycle Bin`);
                            clearAlbumSelection();
                            setAlbumPhotosRefreshTick(t => t + 1);
                            void refreshAll();
                          } else {
                            toast.error('Couldn’t move to Recycle Bin', { description: r.error });
                          }
                        }}
                        className="text-destructive focus:text-destructive"
                        data-testid={`album-photo-recycle-${p.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-2" />
                        Move to PDR Recycle Bin{selectedAlbumPhotoIds.size > 0 && selectedAlbumPhotoIds.has(p.id) ? ` (${selectedAlbumPhotoIds.size})` : ''}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                    </div>
                    {(showFilename || showDate) && (
                      <div className="px-1 pt-1 pb-0.5 min-w-0">
                        {showFilename && (
                          <p className="text-[11px] font-medium text-foreground truncate" title={p.filename}>
                            {p.filename}
                          </p>
                        )}
                        {showDate && (
                          <p className="text-[10px] text-muted-foreground truncate">
                            {p.derived_date ? p.derived_date.slice(0, 10) : '—'}
                          </p>
                        )}
                      </div>
                    )}
                    </div>
                  </CaptionTooltip>
                  </Fragment>
                    );
                  });
                })()}
              </div>
              </>
            )}
          </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {selectedAlbum.source === 'user_created' ? (
                <>
                  <ContextMenuItem
                    onSelect={() => window.dispatchEvent(new CustomEvent('pdr:openSearchDiscovery', {
                      detail: { from: { albumId: selectedAlbum.id, title: selectedAlbum.title } },
                    }))}
                    data-testid="album-context-menu-add-from-sd"
                  >
                    <SearchIcon className="w-3.5 h-3.5 mr-2" />
                    Add photos from Search &amp; Discovery
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => window.dispatchEvent(new CustomEvent('pdr:memoriesSwitchTab', {
                      detail: { tab: 'byDate', from: { albumId: selectedAlbum.id, title: selectedAlbum.title } },
                    }))}
                    data-testid="album-context-menu-add-from-bydate"
                  >
                    <CalendarRange className="w-3.5 h-3.5 mr-2" />
                    Add photos from By Date
                  </ContextMenuItem>
                </>
              ) : (
                <ContextMenuItem disabled>
                  Source-imported album — content is locked
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
        </div>
      );
    }

    return null;
  };

  // ─────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────

  return (
    <>
    {/* Wrap in a ref'd container so the Ctrl+wheel zoom listener can
        attach to a stable element for the lifetime of AlbumsView,
        independent of which right-pane surface is currently
        rendered. The wrapper is presentational only — h-full so it
        doesn't collapse the panel-group's layout. */}
    <div ref={albumsRootRef} className="h-full animate-in fade-in-0 duration-300">
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
            <IconTooltip label="Refresh albums" side="bottom">
              <Button variant="secondary" size="sm" onClick={() => refreshAll()} disabled={loading} className="px-1.5 py-0.5 h-auto" data-testid="button-refresh-albums">
                <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </IconTooltip>
            {/* Undo + Redo — icon-only, sit next to Refresh as the
                "history controls" pair. Disabled (and visually
                muted via opacity) when their respective stacks are
                empty. Ctrl-Z / Ctrl-Y / Ctrl-Shift-Z also work
                anywhere in the app outside a text input. v2.0.8
                step 6 polish (Terry 2026-05-19). */}
            <IconTooltip
              label={(() => {
                const last = undoStack[undoStack.length - 1];
                if (!last) return 'Nothing to undo';
                if (last.kind === 'move_album') return `Undo: move "${last.albumTitle}" back to "${last.fromTitle}" (Ctrl+Z)`;
                if (last.kind === 'add_membership') return `Undo: remove "${last.albumTitle}" from "${last.groupTitle}" (Ctrl+Z)`;
                return `Undo: put "${last.albumTitle}" back in "${last.groupTitle}" (Ctrl+Z)`;
              })()}
              side="bottom"
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={performUndo}
                disabled={undoStack.length === 0}
                className="px-1.5 py-0.5 h-auto"
                data-testid="button-albums-undo"
              >
                <Undo2 className="w-3 h-3" />
              </Button>
            </IconTooltip>
            <IconTooltip
              label={(() => {
                const last = redoStack[redoStack.length - 1];
                if (!last) return 'Nothing to redo';
                if (last.kind === 'move_album') return `Redo: move "${last.albumTitle}" to "${last.toTitle}" (Ctrl+Y)`;
                if (last.kind === 'add_membership') return `Redo: add "${last.albumTitle}" to "${last.groupTitle}" (Ctrl+Y)`;
                return `Redo: remove "${last.albumTitle}" from "${last.groupTitle}" (Ctrl+Y)`;
              })()}
              side="bottom"
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={performRedo}
                disabled={redoStack.length === 0}
                className="px-1.5 py-0.5 h-auto"
                data-testid="button-albums-redo"
              >
                <Redo2 className="w-3 h-3" />
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
          ) : creatingFolder && subfolderParentId === null ? (
            /* Root-folder create — keeps the inline-toolbar input
               surface (no parent to anchor to in the tree). When
               creating a SUB-folder, this branch is skipped so the
               input renders inline inside the parent group instead.
               See the inline-subfolder-input block in renderGroupRow. */
            <div className="flex items-center gap-1.5">
              <input
                value={newFolderTitle}
                onChange={(e) => setNewFolderTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleCreateFolder(); }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelCreateFolder(); }
                }}
                placeholder="Folder name"
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
              {/* v2.1 round 241 (Terry) — standalone "New collage" workspace
                  entry point, sitting with New folder / New album because a
                  collage is a creative artefact that lives alongside albums
                  (saved collages even gather into the "PDR Collages" album,
                  round 162). Opens a FRESH, empty collage window; the user
                  populates it via the in-collage "Add photos". Same
                  openCollageComposer helper the selection "Create collage"
                  actions use — passing no paths opens it empty. */}
              <Button variant="secondary" size="sm" onClick={() => { void openCollageComposer(); }} className="gap-1 px-3 py-1 h-auto text-xs" data-testid="button-create-collage">
                <LayoutGrid className="w-3.5 h-3.5" />
                New collage
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
    </div>
    {/* Parallel Library wizard — mounted at the AlbumsView root so it
        overlays the whole split pane, not just the right pane.
        Files come from `exportPhotos`, populated by either the
        header Export button (uses the open album's loaded photos)
        or any album's context-menu Export item (lazy-fetches that
        album's photos first). Same wizard S&D launches; no new
        modal, no new code path. v2.0.8 step 6. */}
    <ParallelStructureModal
      isOpen={showStructureModal}
      onClose={() => { setShowStructureModal(false); setExportPhotos([]); }}
      files={exportPhotos}
      totalResultCount={exportPhotos.length}
    />
    </>
  );
}
