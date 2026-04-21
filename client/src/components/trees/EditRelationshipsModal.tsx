import { useMemo, useEffect, useState, useRef } from 'react';
import { X, Pencil, Plus, Trash2, Users, Move } from 'lucide-react';
import { removeRelationship, listRelationshipsForPerson, type RelationshipRecord } from '@/lib/electron-bridge';
import { promptConfirm } from './promptConfirm';

interface PersonSummary { id: number; name: string; }

interface EditRelationshipsModalProps {
  personId: number;
  personName: string;
  persons: PersonSummary[];
  onClose: () => void;
  /** Fired when the user clicks Edit on a specific edge — parent opens
   *  SetRelationshipModal with initialToPersonId set. */
  onEditEdge: (otherPersonId: number) => void;
  /** Fired when the user clicks Add new — parent opens SetRelationshipModal
   *  fresh (no preselection). */
  onAddNew: () => void;
  /** Fired after a remove so the parent can refetch the graph. */
  onChanged: () => void;
}

/**
 * Lists every non-derived relationship edge touching `personId`, with
 * Edit and Remove controls per row and an "Add new relationship" CTA
 * in the footer. Answers the common workflow "who is this person
 * linked to, and can I fix one of those links?" — previously only
 * reachable by right-click → Unlink + re-add, which wiped too much.
 */
export function EditRelationshipsModal({
  personId, personName, persons, onClose, onEditEdge, onAddNew, onChanged,
}: EditRelationshipsModalProps) {
  const nameOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of persons) m.set(p.id, p.name);
    return (id: number) => m.get(id) ?? 'Unknown';
  }, [persons]);

  // Fetch directly from the DB instead of reading the visible tree
  // graph — people outside the current viewport (or linked via an
  // accidental inverted edge the tree can't render) would otherwise
  // be hidden from this list. Refetch on every remove so the list
  // stays in sync with the DB.
  const [edges, setEdges] = useState<RelationshipRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listRelationshipsForPerson(personId).then(r => {
      if (cancelled) return;
      if (r.success && r.data) setEdges(r.data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [personId, bump]);

  const rows = useMemo(() => {
    const out: Array<{ edge: RelationshipRecord; otherId: number; label: string; otherName: string }> = [];
    for (const e of edges) {
      const aIsMe = e.person_a_id === personId;
      const bIsMe = e.person_b_id === personId;
      if (!aIsMe && !bIsMe) continue;
      const otherId = aIsMe ? e.person_b_id : e.person_a_id;
      out.push({ edge: e, otherId, label: relationshipLabelFromRecord(e, aIsMe), otherName: nameOf(otherId) });
    }
    // Group by type for legibility: parent/child first, then partner,
    // then siblings, then everything else. Alpha within group.
    const typeOrder = (r: { label: string }) => {
      if (r.label.startsWith('Parent')) return 0;
      if (r.label.startsWith('Child')) return 1;
      if (r.label.startsWith('Partner') || r.label.startsWith('Ex-partner')) return 2;
      if (r.label.startsWith('Sibling') || r.label.startsWith('Half')) return 3;
      return 4;
    };
    out.sort((a, b) => {
      const oa = typeOrder(a); const ob = typeOrder(b);
      if (oa !== ob) return oa - ob;
      return a.otherName.localeCompare(b.otherName);
    });
    return out;
  }, [edges, personId, nameOf]);

  const handleRemove = async (edge: RelationshipRecord, label: string, otherName: string) => {
    const ok = await promptConfirm({
      title: 'Remove relationship?',
      message: `This removes only the "${label.toLowerCase()} — ${otherName}" link. The other person and all of their other relationships are kept.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    const r = await removeRelationship(edge.id);
    if (r.success) {
      setBump(b => b + 1); // refetch the list
      onChanged();         // refresh the tree
    }
  };

  // Drag-to-reposition — the modal often parks itself over the very
  // person you're editing. Grab the header to drag it out of the way.
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  const onDragStart = (e: React.PointerEvent) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, bx: pos.x, by: pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setPos({ x: dragRef.current.bx + e.clientX - dragRef.current.sx, y: dragRef.current.by + e.clientY - dragRef.current.sy });
  };
  const onDragEnd = () => { dragRef.current = null; };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-background rounded-xl shadow-2xl border border-border max-w-lg w-full max-h-[85vh] overflow-auto"
        style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
        onClick={e => e.stopPropagation()}
      >
        <div
          className="sticky top-0 bg-background border-b border-border px-4 py-3 relative select-none"
          style={{ cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          title="Drag to move"
        >
          <Move className="absolute left-3 top-3 w-3.5 h-3.5 text-muted-foreground/60" aria-hidden />
          <button onClick={onClose} className="absolute right-3 top-3 p-1 rounded hover:bg-accent" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
          <h3 className="text-center px-10">
            <span className="text-sm text-muted-foreground">Edit relationships for </span>
            <span className="text-lg font-bold text-foreground">{personName}</span>
          </h3>
        </div>

        <div className="px-4 py-4 flex flex-col gap-2">
          {loading ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {personName} has no relationships yet. Use the button below to add the first one.
            </div>
          ) : (
            rows.map(({ edge, otherId, label, otherName }) => (
              <div
                key={edge.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border hover:border-primary/40 transition-colors"
              >
                <Users className="w-4 h-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-foreground truncate">{otherName}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
                <button
                  onClick={() => onEditEdge(otherId)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs hover:bg-accent"
                  title="Open in the relationship editor — change type, dates, flags."
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Edit
                </button>
                <button
                  onClick={() => handleRemove(edge, label, otherName)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-600 hover:bg-red-500/10"
                  title="Remove this one link only."
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Remove
                </button>
              </div>
            ))
          )}
        </div>

        <div className="sticky bottom-0 bg-background border-t border-border px-4 py-3 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm hover:bg-accent">Close</button>
          <button
            onClick={onAddNew}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            <Plus className="w-3.5 h-3.5" />
            Add new relationship
          </button>
        </div>
      </div>
    </div>
  );
}

/** Convert a stored RelationshipRecord into a human label from the
 *  perspective of the person whose modal is open (their side = aIsMe). */
function relationshipLabelFromRecord(edge: RelationshipRecord, aIsMe: boolean): string {
  if (edge.type === 'parent_of') {
    return aIsMe ? 'Parent of' : 'Child of';
  }
  if (edge.type === 'spouse_of') {
    if (edge.until) return 'Ex-partner';
    return 'Partner / spouse';
  }
  if (edge.type === 'sibling_of') {
    const flags: any = edge.flags ?? {};
    if (flags.half) return 'Half-sibling';
    if (flags.adopted) return 'Adopted sibling';
    return 'Sibling';
  }
  if (edge.type === 'associated_with') {
    const flags: any = edge.flags ?? {};
    const kind = flags.kind as string | undefined;
    const ended = flags.ended as boolean | undefined;
    if (kind === 'ex_partner') return 'Ex-partner';
    if (kind === 'colleague' && ended) return 'Ex-colleague';
    if (kind === 'other' && flags.label) return flags.label;
    if (kind) return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ');
    return 'Associated';
  }
  return edge.type;
}
