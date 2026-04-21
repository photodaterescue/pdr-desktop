import { useMemo } from 'react';
import { X, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { removeRelationship, type FamilyGraph, type FamilyGraphEdge } from '@/lib/electron-bridge';
import { promptConfirm } from './promptConfirm';

interface PersonSummary { id: number; name: string; }

interface EditRelationshipsModalProps {
  personId: number;
  personName: string;
  persons: PersonSummary[];
  graph: FamilyGraph | null;
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
  personId, personName, persons, graph, onClose, onEditEdge, onAddNew, onChanged,
}: EditRelationshipsModalProps) {
  const nameOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of persons) m.set(p.id, p.name);
    return (id: number) => m.get(id) ?? 'Unknown';
  }, [persons]);

  const rows = useMemo(() => {
    if (!graph) return [] as Array<{ edge: FamilyGraphEdge; otherId: number; label: string; otherName: string }>;
    const out: Array<{ edge: FamilyGraphEdge; otherId: number; label: string; otherName: string }> = [];
    for (const e of graph.edges) {
      if (e.derived) continue;
      if (e.id == null) continue; // derived edges have no id; defensive
      const aIsMe = e.aId === personId;
      const bIsMe = e.bId === personId;
      if (!aIsMe && !bIsMe) continue;
      const otherId = aIsMe ? e.bId : e.aId;
      out.push({ edge: e, otherId, label: relationshipLabel(e, aIsMe), otherName: nameOf(otherId) });
    }
    // Group by type for legibility: parent/child first, then partner,
    // then siblings, then everything else. Alpha within group.
    const typeOrder = (r: { edge: FamilyGraphEdge; label: string }) => {
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
  }, [graph, personId, nameOf]);

  const handleRemove = async (edge: FamilyGraphEdge, label: string, otherName: string) => {
    if (edge.id == null) return;
    const ok = await promptConfirm({
      title: 'Remove relationship?',
      message: `This removes only the "${label.toLowerCase()} — ${otherName}" link. The other person and all of their other relationships are kept.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    const r = await removeRelationship(edge.id);
    if (r.success) onChanged();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-background rounded-xl shadow-2xl border border-border max-w-lg w-full max-h-[85vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-background border-b border-border px-4 py-3 relative">
          <button onClick={onClose} className="absolute right-3 top-3 p-1 rounded hover:bg-accent" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
          <h3 className="text-base font-semibold text-center mb-0.5 px-6">Edit relationships</h3>
          <p className="text-xs text-muted-foreground text-center px-6">{personName}</p>
        </div>

        <div className="px-4 py-4 flex flex-col gap-2">
          {rows.length === 0 ? (
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

/** Convert a stored edge into a human label from the perspective of
 *  the person whose modal is open (their side = aIsMe). */
function relationshipLabel(edge: FamilyGraphEdge, aIsMe: boolean): string {
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
