import { useEffect, useState, useMemo } from 'react';
import { useDraggableModal } from './useDraggableModal';
import { X, Plus, Pencil, Check, Trash2, Image as ImageIcon, FileText, Users, Move, History as HistoryIcon, ChevronDown, ChevronRight, RotateCcw, Eye, EyeOff } from 'lucide-react';
import {
  listSavedTrees,
  updateSavedTree,
  deleteSavedTree,
  toggleHiddenAncestor,
  listGraphHistoryEntries,
  revertToGraphHistoryEntry,
  type SavedTreeRecord,
  type GraphHistoryEntry,
} from '@/lib/electron-bridge';
import { promptConfirm } from './promptConfirm';
import { IconTooltip } from '@/components/ui/icon-tooltip';

interface ManageTreesModalProps {
  currentTreeId: number | null;
  currentFocusPersonId: number | null;
  /** Returns the tree SVG element so we can export it. Null if nothing
   *  is rendered yet. */
  getTreeSvg: () => SVGSVGElement | null;
  onSwitch: (tree: SavedTreeRecord) => void;
  onChanged: () => void;
  onClose: () => void;
  /** Ask the parent to start the "new tree" flow — a blank-canvas
   *  create that prompts for the focus person. Parent handles focus
   *  picking then creates the tree with default filter settings. */
  onRequestNewTree: () => void;
  /** Ask the parent to route the user to S&D in "pick a photo for this
   *  tree's canvas background" mode. Parent closes this modal first
   *  then opens the search view. */
  onRequestBackgroundPick?: (tree: SavedTreeRecord) => void;
  /** Lookup person name by id — used to render the hidden-ancestry
   *  list under each tree. Falls back to "#id" when unknown. */
  getPersonName?: (id: number) => string;
  /** Render WITHOUT the fixed-inset backdrop chrome (drag handle / X
   *  close / centred overlay) so the body can mount inside another
   *  surface — used by Trees Settings to host this modal's content
   *  as a dedicated tab. The outer dialog provides its own close X
   *  and drag handle, so embedding skips them here to avoid double
   *  chrome. */
  embedded?: boolean;
}

const MAX_TREES = 5;

/**
 * List of saved trees + create / rename / switch / remove + export.
 * Remove is gated behind Settings → AI → Advanced → "Allow Tree Removal"
 * (read from localStorage) so users can't accidentally wipe hours of
 * relationship-wiring work.
 */
export function ManageTreesModal({
  currentTreeId, currentFocusPersonId, getTreeSvg, onSwitch, onChanged, onClose, onRequestNewTree, onRequestBackgroundPick, getPersonName, embedded,
}: ManageTreesModalProps) {
  const [trees, setTrees] = useState<SavedTreeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [exporting, setExporting] = useState<'png' | 'pdf' | null>(null);
  const [busy, setBusy] = useState(false);


  // History panel — lazy-loaded when expanded so we don't hit the DB
  // for users who just want to rename / switch trees.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<GraphHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    if (!historyOpen) return;
    let cancelled = false;
    setHistoryLoading(true);
    listGraphHistoryEntries().then(r => {
      if (cancelled) return;
      if (r.success && r.data) setHistoryEntries(r.data);
      setHistoryLoading(false);
    });
    return () => { cancelled = true; };
  }, [historyOpen]);

  const allowRemove = typeof window !== 'undefined'
    && localStorage.getItem('pdr-allow-tree-removal') === 'true';

  // Shared drag hook — header stays on-screen.
  const { modalRef, dragHandleProps } = useDraggableModal();

  const reload = async () => {
    setLoading(true);
    const r = await listSavedTrees();
    if (r.success && r.data) setTrees(r.data);
    setLoading(false);
  };
  useEffect(() => { reload(); }, []);

  const startRename = (t: SavedTreeRecord) => {
    setEditingId(t.id);
    setEditingName(t.name);
  };
  const commitRename = async () => {
    if (editingId == null) return;
    const trimmed = editingName.trim();
    if (!trimmed) { setEditingId(null); return; }
    setBusy(true);
    await updateSavedTree(editingId, { name: trimmed });
    setBusy(false);
    setEditingId(null);
    await reload();
    onChanged();
  };

  const handleCreate = () => {
    if (trees.length >= MAX_TREES) return;
    // Delegate to the parent — it'll prompt for the focus person
    // (fresh canvas, not a clone of the current tree) and then call
    // back to refresh this list.
    onRequestNewTree();
  };

  const handleRemove = async (t: SavedTreeRecord) => {
    const ok = await promptConfirm({
      title: `Remove "${t.name}"?`,
      message: 'This only deletes the saved tree preset (its name + settings). The people, relationships, and photos behind it are kept — other trees that share people are unaffected.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    await deleteSavedTree(t.id);
    setBusy(false);
    await reload();
    onChanged();
  };

  const handlePickBackground = (t: SavedTreeRecord) => {
    if (!onRequestBackgroundPick) return;
    onRequestBackgroundPick(t);
  };

  const handleClearBackground = async (t: SavedTreeRecord) => {
    setBusy(true);
    await updateSavedTree(t.id, { backgroundImage: null });
    setBusy(false);
    await reload();
    onChanged();
  };

  // Opacity slider — the earlier version called reload() on every tick,
  // which re-queried the DB and swapped the trees array; the swap
  // re-mounted the slider's containing DOM and made the modal flicker
  // mid-drag. Now:
  //   • live drag patches the modal's LOCAL trees state (so the row
  //     stays in sync without hitting the DB)
  //   • AND fires a no-await updateSavedTree + onChanged() so the canvas
  //     preview follows the slider in real time
  //   • no modal reload() mid-drag
  const handleBackgroundOpacityLive = (t: SavedTreeRecord, value: number) => {
    setTrees(prev => prev.map(x => x.id === t.id ? { ...x, backgroundOpacity: value } : x));
    updateSavedTree(t.id, { backgroundOpacity: value }).then(() => onChanged());
  };
  /** Tree contrast slider — boosts card borders/shadows so cards stay
   *  legible over a busy canvas background. Same live-commit pattern
   *  as the fade slider. */
  const handleTreeContrastLive = (t: SavedTreeRecord, value: number) => {
    setTrees(prev => prev.map(x => x.id === t.id ? { ...x, treeContrast: value } : x));
    updateSavedTree(t.id, { treeContrast: value }).then(() => onChanged());
  };

  /** Tree-scoped toggle for gendered relationship labels — live commit
   *  pattern same as Fade / Tree pop so there's no modal flicker. */
  const handleToggleGendered = async (t: SavedTreeRecord, value: boolean) => {
    setTrees(prev => prev.map(x => x.id === t.id ? { ...x, useGenderedLabels: value } : x));
    await updateSavedTree(t.id, { useGenderedLabels: value });
    onChanged();
  };

  /** Tree-scoped toggle for hiding the gender marker in the top-right
   *  corner of cards. Off by default — the marker appears as soon as
   *  the user sets a gender. */
  const handleToggleHideMarker = async (t: SavedTreeRecord, value: boolean) => {
    setTrees(prev => prev.map(x => x.id === t.id ? { ...x, hideGenderMarker: value } : x));
    await updateSavedTree(t.id, { hideGenderMarker: value });
    onChanged();
  };

  /** Tree-scoped preference for collapsing Half-brother / Half-sister
   *  labels down to the plain Brother / Sister terms. Off by default —
   *  relationship labels stay technically accurate unless the user opts
   *  into the simpler wording. */
  const handleToggleSimplifyHalf = async (t: SavedTreeRecord, value: boolean) => {
    setTrees(prev => prev.map(x => x.id === t.id ? { ...x, simplifyHalfLabels: value } : x));
    await updateSavedTree(t.id, { simplifyHalfLabels: value });
    onChanged();
  };

  /** Remove a person id from a tree's hidden-ancestry list, restoring
   *  their family line to the canvas. Goes through toggleHiddenAncestor
   *  so the flip is logged to graph_history — Ctrl+Z will restore the
   *  hide, and the history list below picks it up as "Showed X's
   *  ancestry in Y". */
  const handleUnhideAncestry = async (t: SavedTreeRecord, personId: number) => {
    const next = (t.hiddenAncestorPersonIds ?? []).filter(id => id !== personId);
    setTrees(prev => prev.map(x => x.id === t.id ? { ...x, hiddenAncestorPersonIds: next } : x));
    await toggleHiddenAncestor(t.id, personId);
    onChanged();
  };

  const handleExportPng = async () => {
    const svg = getTreeSvg();
    if (!svg) return;
    setExporting('png');
    try {
      const blob = await svgToPngBlob(svg, 2);
      downloadBlob(blob, `${currentTreeName() || 'tree'}.png`);
    } finally {
      setExporting(null);
    }
  };
  const handleExportPdf = async () => {
    const svg = getTreeSvg();
    if (!svg) return;
    setExporting('pdf');
    try {
      // Render PNG first, then wrap in a printable window.
      const blob = await svgToPngBlob(svg, 2);
      const url = URL.createObjectURL(blob);
      const w = window.open('', '_blank', 'width=900,height=700');
      if (!w) { URL.revokeObjectURL(url); return; }
      w.document.write(`<!doctype html><html><head><title>${escapeHtml(currentTreeName() || 'Tree')}</title>
        <style>
          body { margin: 0; display: flex; align-items: center; justify-content: center; background: white; }
          img { max-width: 100%; max-height: 100vh; }
          @media print { body { align-items: flex-start; justify-content: flex-start; } img { max-height: none; width: 100%; } }
        </style></head><body><img src="${url}" onload="window.focus(); window.print();" /></body></html>`);
      w.document.close();
    } finally {
      setExporting(null);
    }
  };
  const currentTreeName = () =>
    trees.find(t => t.id === currentTreeId)?.name ?? '';

  // Header chrome (drag handle, X close, title) is owned by the
  // standalone modal mode. When embedded inside Trees Settings the
  // outer dialog already has its own drag handle / X / title, so we
  // skip this row to avoid duplicate chrome.
  const headerChrome = !embedded ? (
    <div
      {...dragHandleProps}
      className={`sticky top-0 bg-background border-b border-border px-4 py-3 relative ${dragHandleProps.className}`}
    >
      <Move className="absolute left-3 top-3 w-3.5 h-3.5 text-muted-foreground/60" aria-hidden />
      <button onClick={onClose} className="absolute right-3 top-3 p-1 rounded hover:bg-accent" aria-label="Close">
        <X className="w-4 h-4" />
      </button>
      <h3 className="text-base font-semibold text-center px-10 text-foreground">Manage Trees</h3>
      <p className="text-xs text-muted-foreground text-center mt-0.5 px-10">
        {trees.length} of {MAX_TREES} trees
      </p>
    </div>
  ) : (
    // Embedded: just the count, no title (parent shows "Trees Settings"
    // in its own dialog header and the active tab tells the user what
    // they're looking at).
    <p className="text-xs text-muted-foreground text-center pb-2">
      {trees.length} of {MAX_TREES} trees
    </p>
  );

  // Body (the always-rendered list / history / export panel).
  const bodyContent = (
    <>
      {headerChrome}
      <div className="px-4 py-4 flex flex-col gap-2">
          {loading ? (
            <div className="text-center text-sm text-muted-foreground py-6">Loading…</div>
          ) : trees.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-6">No saved trees yet. Create your first one below.</div>
          ) : (
            trees.map(t => {
              const isCurrent = t.id === currentTreeId;
              const hasBg = !!t.backgroundImage;
              return (
                <div
                  key={t.id}
                  className={`flex flex-col gap-2 px-3 py-2.5 rounded-lg border transition-colors ${
                    isCurrent
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:border-primary/40'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Users className={`w-4 h-4 shrink-0 ${isCurrent ? 'text-primary' : 'text-muted-foreground'}`} />
                    <div className="flex-1 min-w-0">
                      {editingId === t.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            autoFocus
                            value={editingName}
                            onChange={e => setEditingName(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitRename();
                              else if (e.key === 'Escape') setEditingId(null);
                            }}
                            className="flex-1 px-2 py-1 rounded border border-primary bg-background text-sm text-foreground"
                          />
                          <button onClick={commitRename} disabled={busy} className="p-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90">
                            <Check className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <IconTooltip label="Switch to this tree" side="right">
                          <button
                            onClick={() => onSwitch(t)}
                            className="w-full text-left truncate"
                          >
                            <span className={`text-sm font-medium text-foreground ${isCurrent ? 'font-semibold' : ''}`}>{t.name}</span>
                            {isCurrent && (
                              <span className="ml-2 text-[10px] uppercase tracking-wide font-semibold text-foreground bg-primary/20 px-1.5 py-0.5 rounded">
                                current
                              </span>
                            )}
                          </button>
                        </IconTooltip>
                      )}
                    </div>
                    {editingId !== t.id && (
                      <button
                        onClick={() => startRename(t)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-accent/60 border border-border hover:bg-accent text-foreground"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        Rename
                      </button>
                    )}
                    {editingId !== t.id && allowRemove && trees.length > 1 && (
                      <button
                        onClick={() => handleRemove(t)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-red-500/10 border border-red-500/40 text-red-600 hover:bg-red-500/20"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Remove
                      </button>
                    )}
                  </div>

                  {/* Per-tree background controls — swatch + pick/change/clear,
                      plus an opacity slider that only appears when a background
                      is set. */}
                  {editingId !== t.id && (
                    <div className="flex items-center gap-2 pl-6">
                      <div className="relative group shrink-0">
                        <div
                          className="w-8 h-8 rounded border border-border bg-muted"
                          style={hasBg ? {
                            backgroundImage: `url("${t.backgroundImage}")`,
                            backgroundSize: 'cover',
                            backgroundPosition: 'center',
                          } : undefined}
                          aria-hidden
                        />
                        {hasBg && (
                          // Hover-enlarge preview — the 8x8 swatch is too
                          // small to judge how the image will look behind
                          // the tree. On hover a larger (224x140) version
                          // pops up to the right of the swatch.
                          <div
                            className="pointer-events-none absolute left-10 top-0 z-10 w-56 h-36 rounded-lg border border-border shadow-xl bg-muted opacity-0 scale-95 group-hover:opacity-100 group-hover:scale-100 transition-all duration-150"
                            style={{
                              backgroundImage: `url("${t.backgroundImage}")`,
                              backgroundSize: 'cover',
                              backgroundPosition: 'center',
                            }}
                            aria-hidden
                          />
                        )}
                      </div>
                      <IconTooltip label="Pick an image to display behind this tree's canvas" side="top">
                        <button
                          onClick={() => handlePickBackground(t)}
                          disabled={busy}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-accent/60 border border-border hover:bg-accent text-foreground"
                        >
                          <ImageIcon className="w-3.5 h-3.5" />
                          {hasBg ? 'Change background' : 'Set background'}
                        </button>
                      </IconTooltip>
                      {hasBg && (
                        <>
                          <button
                            onClick={() => handleClearBackground(t)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-accent/30 border border-border hover:bg-accent text-foreground"
                          >
                            <X className="w-3.5 h-3.5" />
                            Clear
                          </button>
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto">
                            <span>Fade</span>
                            <input
                              type="range"
                              min={0.05}
                              max={0.6}
                              step={0.01}
                              value={t.backgroundOpacity}
                              onChange={e => handleBackgroundOpacityLive(t, parseFloat(e.target.value))}
                              className="w-20"
                            />
                          </label>
                        </>
                      )}
                    </div>
                  )}

                  {/* Tree pop — boosts card borders + shadows so cards
                      stay legible on a busy backdrop. Always visible
                      (works even without a background image). */}
                  {editingId !== t.id && (
                    <div className="flex items-center gap-2 pl-6">
                      <span className="text-xs text-muted-foreground w-20 shrink-0">Tree pop</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={t.treeContrast}
                        onChange={e => handleTreeContrastLive(t, parseFloat(e.target.value))}
                        className="flex-1"
                      />
                      <span className="text-xs text-muted-foreground w-8 text-right">{Math.round(t.treeContrast * 100)}</span>
                    </div>
                  )}

                  {/* Gender controls — two independent checkboxes:
                      • Gendered labels drives the wording under names
                        (Mother/Father vs Parent).
                      • Hide gender markers suppresses the Mars/Venus
                        symbol in the top-right of each card. */}
                  {editingId !== t.id && (
                    <div className="flex flex-col gap-1.5 pl-6">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={t.useGenderedLabels}
                          onChange={e => handleToggleGendered(t, e.target.checked)}
                          className="w-3.5 h-3.5"
                        />
                        <span className="text-foreground">Gendered relationship labels</span>
                        <span className="ml-1 text-muted-foreground/70">
                          ({t.useGenderedLabels ? 'Mother / Father / Sister / …' : 'Parent / Sibling / …'})
                        </span>
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={t.hideGenderMarker}
                          onChange={e => handleToggleHideMarker(t, e.target.checked)}
                          className="w-3.5 h-3.5"
                        />
                        <span className="text-foreground">Hide gender markers on cards</span>
                        <span className="ml-1 text-muted-foreground/70">
                          (♂ / ♀ / ⚥ in the top-right corner)
                        </span>
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={t.simplifyHalfLabels}
                          onChange={e => handleToggleSimplifyHalf(t, e.target.checked)}
                          className="w-3.5 h-3.5"
                        />
                        <span className="text-foreground">Show half-siblings as plain Brother / Sister</span>
                        <span className="ml-1 text-muted-foreground/70">
                          (hides the technically-accurate "Half-" prefix)
                        </span>
                      </label>
                    </div>
                  )}

                  {/* Hidden ancestries — one row per person whose line
                      the user has suppressed in this tree. The card
                      might not be on the canvas any more (their only
                      tie to the focus may have gone with the branch),
                      so this list is the guaranteed way back. */}
                  {editingId !== t.id && (t.hiddenAncestorPersonIds ?? []).length > 0 && (
                    <div className="pl-6 border-t border-border/60 pt-2 mt-1">
                      <p className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground mb-1.5 flex items-center gap-1.5">
                        <EyeOff className="w-3 h-3" />
                        Hidden ancestries
                      </p>
                      <ul className="flex flex-col gap-1">
                        {(t.hiddenAncestorPersonIds ?? []).map(pid => (
                          <li key={pid} className="flex items-center justify-between gap-2 text-sm">
                            <span className="text-foreground truncate">
                              {getPersonName?.(pid) ?? `#${pid}`}
                            </span>
                            <button
                              onClick={() => handleUnhideAncestry(t, pid)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-accent/60 border border-border hover:bg-accent text-foreground shrink-0"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              Show ancestry
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })
          )}

          <button
            onClick={handleCreate}
            disabled={busy || trees.length >= MAX_TREES}
            className="mt-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            {trees.length >= MAX_TREES ? `Maximum of ${MAX_TREES} trees reached` : 'New tree'}
          </button>

          {!allowRemove && (
            <p className="text-xs text-muted-foreground italic mt-1">
              Tip: the Remove button is hidden by default. To enable it, go to <strong>Settings → AI → Advanced</strong> and turn on <strong>Allow Tree Removal</strong>.
            </p>
          )}

          <HistorySection
            open={historyOpen}
            onToggle={() => setHistoryOpen(v => !v)}
            loading={historyLoading}
            entries={historyEntries}
            onRevert={async (targetId, description) => {
              const ok = await promptConfirm({
                title: 'Revert to this point?',
                message: `Every change made AFTER "${description}" will be undone. You can redo them afterwards with the Redo button if you change your mind.`,
                confirmLabel: 'Revert',
                danger: true,
              });
              if (!ok) return;
              const r = await revertToGraphHistoryEntry(targetId);
              if (r.success) {
                // Refresh the list so 'undone' flags are up to date.
                const r2 = await listGraphHistoryEntries();
                if (r2.success && r2.data) setHistoryEntries(r2.data);
                onChanged();
              }
            }}
          />

          <div className="mt-4 pt-4 border-t border-border">
            <p className="text-xs uppercase tracking-wide text-foreground font-semibold mb-2">Export current tree</p>
            <div className="flex gap-2">
              <button
                onClick={handleExportPng}
                disabled={exporting != null || !currentTreeId}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50"
              >
                <ImageIcon className="w-4 h-4" />
                {exporting === 'png' ? 'Exporting…' : 'Save as PNG'}
              </button>
              <button
                onClick={handleExportPdf}
                disabled={exporting != null || !currentTreeId}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg bg-accent/60 border border-border text-foreground text-sm font-medium hover:bg-accent disabled:opacity-50"
              >
                <FileText className="w-4 h-4" />
                {exporting === 'pdf' ? 'Opening…' : 'Print / Save PDF'}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              PNG is the quickest way to share (email, Messenger, social). PDF opens a print dialog — pick "Save as PDF" in the destination to get a PDF, or pick your printer for a wall chart.
            </p>
          </div>
        </div>

      {!embedded && (
        <div className="sticky bottom-0 bg-background border-t border-border px-4 py-3 flex items-center justify-end">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm hover:bg-accent text-foreground">Done</button>
        </div>
      )}
    </>
  );

  // Embedded mode: hand the body straight back to the parent surface
  // (Trees Settings dialog) which provides backdrop, drag, and X close.
  if (embedded) return bodyContent;

  // Standalone mode: full fixed-inset overlay + draggable card.
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={modalRef}
        className="bg-background rounded-xl shadow-2xl border border-border max-w-lg w-full max-h-[85vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        {bodyContent}
      </div>
    </div>
  );
}

// ───────────────────────────── helpers ─────────────────────────────

/** Serialise an SVG element and rasterise to a PNG blob at `scale` (2x
 *  for retina-quality output). Embedded images (avatar href="data:…")
 *  ride along with the serialisation; plain text uses system fonts. */
async function svgToPngBlob(svg: SVGSVGElement, scale: number): Promise<Blob> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // Ensure the clone carries its current on-screen dimensions as
  // attributes (the original uses CSS sizing which doesn't serialise).
  const rect = svg.getBoundingClientRect();
  clone.setAttribute('width', String(rect.width));
  clone.setAttribute('height', String(rect.height));
  // White background so light-theme exports aren't transparent.
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
  bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%');
  bg.setAttribute('fill', 'white');
  clone.insertBefore(bg, clone.firstChild);

  const serialized = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = canvas.getContext('2d')!;

  return new Promise<Blob>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas export failed'));
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG load failed')); };
    img.src = url;
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);
}

// ───────────────────────────── History ─────────────────────────────

/** Collapsible section at the bottom of Manage Trees listing every
 *  stored relationship change with a timestamp. Users can revert the
 *  graph to the state just after any entry — all newer entries are
 *  undone (and can be redone individually via Ctrl+Shift+Z if the
 *  user changes their mind). */
function HistorySection({ open, onToggle, loading, entries, onRevert }: {
  open: boolean;
  onToggle: () => void;
  loading: boolean;
  entries: GraphHistoryEntry[];
  onRevert: (targetId: number, description: string) => void;
}) {
  const grouped = useMemo(() => groupByBucket(entries), [entries]);
  const activeCount = entries.filter(e => !e.undone).length;

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 text-xs uppercase tracking-wide text-foreground font-semibold mb-2"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <HistoryIcon className="w-3.5 h-3.5" />
        <span className="flex-1 text-left">History</span>
        <span className="text-[10px] text-muted-foreground font-normal normal-case">
          {activeCount} change{activeCount === 1 ? '' : 's'} saved
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3">
          {loading && <p className="text-xs text-muted-foreground py-2">Loading…</p>}
          {!loading && entries.length === 0 && (
            <p className="text-xs text-muted-foreground py-2">No changes recorded yet.</p>
          )}
          {grouped.map(group => (
            <div key={group.label}>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">{group.label}</p>
              <div className="flex flex-col gap-1">
                {group.entries.map(e => (
                  <div
                    key={e.id}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-xs transition-colors ${
                      e.undone
                        ? 'border-border/50 bg-muted/30 text-muted-foreground italic'
                        : 'border-border hover:border-primary/40'
                    }`}
                  >
                    <span className="text-[10px] font-mono text-muted-foreground w-12 shrink-0">
                      {formatTime(e.createdAt)}
                    </span>
                    <span className="flex-1 truncate">{e.description}</span>
                    {e.undone && (
                      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">undone</span>
                    )}
                    {!e.undone && (
                      <IconTooltip label="Revert to the state just after this change (undo everything newer)" side="left">
                        <button
                          onClick={() => onRevert(e.id, e.description)}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Revert to here
                        </button>
                      </IconTooltip>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground italic">
            Reverting undoes every change made after the one you picked. Individual changes can still be redone afterwards if you change your mind.
          </p>
        </div>
      )}
    </div>
  );
}

/** Bucket entries into human-scale time groups: Today, Yesterday, This
 *  week, This month, Older. */
function groupByBucket(entries: GraphHistoryEntry[]): { label: string; entries: GraphHistoryEntry[] }[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfWeek = startOfToday - 6 * 86400000; // last 7 days
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const buckets = { today: [] as GraphHistoryEntry[], yesterday: [] as GraphHistoryEntry[], thisWeek: [] as GraphHistoryEntry[], thisMonth: [] as GraphHistoryEntry[], older: [] as GraphHistoryEntry[] };
  for (const e of entries) {
    const t = Date.parse(e.createdAt + 'Z') || Date.parse(e.createdAt);
    if (t >= startOfToday) buckets.today.push(e);
    else if (t >= startOfYesterday) buckets.yesterday.push(e);
    else if (t >= startOfWeek) buckets.thisWeek.push(e);
    else if (t >= startOfMonth) buckets.thisMonth.push(e);
    else buckets.older.push(e);
  }
  const out: { label: string; entries: GraphHistoryEntry[] }[] = [];
  if (buckets.today.length)     out.push({ label: 'Today',      entries: buckets.today });
  if (buckets.yesterday.length) out.push({ label: 'Yesterday',  entries: buckets.yesterday });
  if (buckets.thisWeek.length)  out.push({ label: 'This week',  entries: buckets.thisWeek });
  if (buckets.thisMonth.length) out.push({ label: 'This month', entries: buckets.thisMonth });
  if (buckets.older.length)     out.push({ label: 'Older',      entries: buckets.older });
  return out;
}

/** Compact HH:MM from the stored ISO timestamp. */
function formatTime(iso: string): string {
  const d = new Date(iso + 'Z');
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
