import { useEffect, useState, useRef } from 'react';
import { X, Plus, Pencil, Check, Trash2, Image as ImageIcon, FileText, Users, Move } from 'lucide-react';
import {
  listSavedTrees,
  createSavedTree,
  updateSavedTree,
  deleteSavedTree,
  type SavedTreeRecord,
} from '@/lib/electron-bridge';
import { promptConfirm } from './promptConfirm';

interface ManageTreesModalProps {
  currentTreeId: number | null;
  currentFocusPersonId: number | null;
  /** Snapshot of the live filter state so "New tree" can inherit it as
   *  its starting point. The user can then change focus/filters while
   *  the new tree is active — auto-save persists those changes. */
  liveSettings: {
    stepsEnabled: boolean;
    stepsDepth: number;
    generationsEnabled: boolean;
    ancestorsDepth: number;
    descendantsDepth: number;
  };
  /** Returns the tree SVG element so we can export it. Null if nothing
   *  is rendered yet. */
  getTreeSvg: () => SVGSVGElement | null;
  onSwitch: (tree: SavedTreeRecord) => void;
  onChanged: () => void;
  onClose: () => void;
}

const MAX_TREES = 5;

/**
 * List of saved trees + create / rename / switch / remove + export.
 * Remove is gated behind Settings → AI → Advanced → "Allow Tree Removal"
 * (read from localStorage) so users can't accidentally wipe hours of
 * relationship-wiring work.
 */
export function ManageTreesModal({
  currentTreeId, currentFocusPersonId, liveSettings, getTreeSvg, onSwitch, onChanged, onClose,
}: ManageTreesModalProps) {
  const [trees, setTrees] = useState<SavedTreeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [exporting, setExporting] = useState<'png' | 'pdf' | null>(null);
  const [busy, setBusy] = useState(false);

  const allowRemove = typeof window !== 'undefined'
    && localStorage.getItem('pdr-allow-tree-removal') === 'true';

  // Drag-to-reposition (same pattern as the other Trees modals).
  const modalRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ x: 0, y: 0, dragging: false, sx: 0, sy: 0, bx: 0, by: 0 });
  const onDragStart = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('button, input, select, textarea, a')) return;
    const d = dragRef.current;
    d.dragging = true;
    d.sx = e.clientX; d.sy = e.clientY;
    d.bx = d.x; d.by = d.y;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.dragging) return;
    const rawX = d.bx + e.clientX - d.sx;
    const rawY = d.by + e.clientY - d.sy;
    const halfW = window.innerWidth / 2;
    const halfH = window.innerHeight / 2;
    d.x = Math.max(-halfW, Math.min(halfW, rawX));
    d.y = Math.max(-halfH, Math.min(halfH, rawY));
    if (modalRef.current) modalRef.current.style.transform = `translate3d(${d.x}px, ${d.y}px, 0)`;
  };
  const onDragEnd = () => { dragRef.current.dragging = false; };

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

  const handleCreate = async () => {
    if (trees.length >= MAX_TREES) return;
    setBusy(true);
    const r = await createSavedTree({
      name: `Untitled tree ${trees.length + 1}`,
      focusPersonId: currentFocusPersonId,
      ...liveSettings,
    });
    setBusy(false);
    if (r.success && r.data) {
      await reload();
      onSwitch(r.data);
      onChanged();
      // Jump straight into renaming so the user picks a name right away.
      startRename(r.data);
    }
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

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={modalRef}
        className="bg-background rounded-xl shadow-2xl border border-border max-w-lg w-full max-h-[85vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        <div
          className="sticky top-0 bg-background border-b border-border px-4 py-3 relative select-none cursor-grab active:cursor-grabbing"
          style={{ touchAction: 'none' }}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <Move className="absolute left-3 top-3 w-3.5 h-3.5 text-muted-foreground/60" aria-hidden />
          <button onClick={onClose} className="absolute right-3 top-3 p-1 rounded hover:bg-accent" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
          <h3 className="text-base font-semibold text-center px-10">Manage Trees</h3>
          <p className="text-xs text-muted-foreground text-center mt-0.5 px-10">
            {trees.length} of {MAX_TREES} trees
          </p>
        </div>

        <div className="px-4 py-4 flex flex-col gap-2">
          {loading ? (
            <div className="text-center text-sm text-muted-foreground py-6">Loading…</div>
          ) : trees.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-6">No saved trees yet. Create your first one below.</div>
          ) : (
            trees.map(t => (
              <div
                key={t.id}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
                  t.id === currentTreeId
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-primary/40'
                }`}
              >
                <Users className={`w-4 h-4 shrink-0 ${t.id === currentTreeId ? 'text-primary' : 'text-muted-foreground'}`} />
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
                        className="flex-1 px-2 py-0.5 rounded border border-border bg-background text-sm"
                      />
                      <button onClick={commitRename} disabled={busy} className="p-1 rounded hover:bg-accent text-primary">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => onSwitch(t)}
                      className="w-full text-left text-sm truncate hover:underline"
                      title="Switch to this tree"
                    >
                      <span className={t.id === currentTreeId ? 'font-semibold text-primary' : 'text-foreground'}>{t.name}</span>
                      {t.id === currentTreeId && <span className="ml-2 text-[10px] uppercase tracking-wide text-primary/80">current</span>}
                    </button>
                  )}
                </div>
                {editingId !== t.id && (
                  <button
                    onClick={() => startRename(t)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs hover:bg-accent"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    Rename
                  </button>
                )}
                {editingId !== t.id && allowRemove && trees.length > 1 && (
                  <button
                    onClick={() => handleRemove(t)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-600 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Remove
                  </button>
                )}
              </div>
            ))
          )}

          <button
            onClick={handleCreate}
            disabled={busy || trees.length >= MAX_TREES}
            className="mt-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-border text-sm hover:bg-accent disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            {trees.length >= MAX_TREES ? `Maximum of ${MAX_TREES} trees reached` : 'New tree'}
          </button>

          {!allowRemove && (
            <p className="text-[11px] text-muted-foreground italic mt-1">
              Tip: the Remove button is hidden by default. To enable it, go to <strong>Settings → AI → Advanced</strong> and turn on <strong>Allow Tree Removal</strong>.
            </p>
          )}

          <div className="mt-4 pt-4 border-t border-border">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">Export current tree</p>
            <div className="flex gap-2">
              <button
                onClick={handleExportPng}
                disabled={exporting != null || !currentTreeId}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent disabled:opacity-50"
              >
                <ImageIcon className="w-4 h-4" />
                {exporting === 'png' ? 'Exporting…' : 'Save as PNG'}
              </button>
              <button
                onClick={handleExportPdf}
                disabled={exporting != null || !currentTreeId}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent disabled:opacity-50"
              >
                <FileText className="w-4 h-4" />
                {exporting === 'pdf' ? 'Opening…' : 'Print / Save PDF'}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">
              PNG for sharing (email, Messenger, social). PDF opens a print dialog — pick "Save as PDF" in the destination.
            </p>
          </div>
        </div>

        <div className="sticky bottom-0 bg-background border-t border-border px-4 py-3 flex items-center justify-end">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm hover:bg-accent">Done</button>
        </div>
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
