import { useMemo, useEffect, useState, useRef } from 'react';
import { X, Pencil, Plus, Trash2, Users, Move } from 'lucide-react';
import { removeRelationship, listRelationshipsForPerson, getFamilyGraph, type RelationshipRecord, type FamilyGraphEdge } from '@/lib/electron-bridge';
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
  // be hidden from this list. Also fetch the derived family graph so
  // implied relationships (e.g. siblings through a shared parent, with
  // no explicit sibling_of edge stored) surface too. Refetch both on
  // every remove so the list stays in sync with the DB.
  const [edges, setEdges] = useState<RelationshipRecord[]>([]);
  const [derivedEdges, setDerivedEdges] = useState<FamilyGraphEdge[]>([]);
  /** All edges in the 2-hop graph around `personId`. Used to annotate
   *  placeholder-parent rows with "shared with [sibling]" so the user
   *  can tell which Unknown is their sibling's parent too — handy for
   *  cleaning up orphan placeholders produced by older sibling-add bugs. */
  const [twoHopEdges, setTwoHopEdges] = useState<FamilyGraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listRelationshipsForPerson(personId),
      getFamilyGraph(personId, 2),
    ]).then(([rRel, rGraph]) => {
      if (cancelled) return;
      if (rRel.success && rRel.data) setEdges(rRel.data);
      if (rGraph.success && rGraph.data) {
        setDerivedEdges(rGraph.data.edges.filter(e =>
          e.derived && (e.aId === personId || e.bId === personId)
        ));
        setTwoHopEdges(rGraph.data.edges);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [personId, bump]);

  interface Row {
    key: string;
    edge: RelationshipRecord | null; // null for derived rows
    otherId: number;
    label: string;
    otherName: string;
    derived: boolean;
    /** For Child-of rows: names of OTHER people who are also children
     *  of this same parent. Lets the user see at a glance which
     *  placeholder they actually share with siblings vs. an extra
     *  orphan left behind by a previous buggy add. */
    sharedWith?: string[];
    /** True for Child-of rows pointing at a placeholder parent that has
     *  NO other named children — i.e. safe to remove. Lets the UI
     *  display a muted "safe to remove" hint on these rows so users
     *  know which Unknown to target. */
    orphanPlaceholder?: boolean;
  }

  // For each (Alan's parent) in the 2-hop graph, list everyone ELSE
  // who is ALSO a child of that parent — so we can annotate Child-of
  // rows with the siblings that parent is shared with.
  const siblingsSharingParent = useMemo(() => {
    const m = new Map<number, number[]>(); // parentId → otherChildIds[]
    for (const e of twoHopEdges) {
      if (e.type !== 'parent_of' || e.derived) continue;
      if (e.bId === personId) continue; // we want OTHER children
      const existing = m.get(e.aId) ?? [];
      existing.push(e.bId);
      m.set(e.aId, existing);
    }
    return m;
  }, [twoHopEdges, personId]);

  // Per-person parent lists, built from the 2-hop graph. Used by the
  // derived sibling rows to tell full vs half at a glance: if the two
  // siblings share every known parent they're full; if either has a
  // stored parent the other doesn't, they're half. Purely inferential —
  // a "Full sibling (tentative)" label is picked when both sides only
  // have one stored parent (could still turn out to be half once the
  // second parent is filled in).
  const parentsByChild = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const e of twoHopEdges) {
      if (e.type !== 'parent_of' || e.derived) continue;
      if (!m.has(e.bId)) m.set(e.bId, []);
      m.get(e.bId)!.push(e.aId);
    }
    return m;
  }, [twoHopEdges]);

  /** Classify a derived sibling pair as 'full', 'half', or 'tentative'
   *  based on stored parent overlap. Orphan placeholder parents — ones
   *  with only a single named child (typically leftover junk from old
   *  sibling-add bugs) — are filtered out before comparing; otherwise
   *  one person's stale placeholder would mislabel an intended full
   *  sibling as half. */
  const classifySibling = (otherId: number): 'full' | 'half' | 'tentative' => {
    // Count of named children per parent across the 2-hop graph.
    // Placeholders with 0 or 1 named children are treated as "ghosts"
    // and excluded from the comparison.
    const namedChildrenCount = (parentId: number): number => {
      let c = 0;
      for (const e of twoHopEdges) {
        if (e.type !== 'parent_of' || e.derived) continue;
        if (e.aId !== parentId) continue;
        const childName = nameOf(e.bId);
        if (childName && childName !== 'Unknown') c++;
      }
      return c;
    };
    const isGhost = (parentId: number): boolean => {
      const n = nameOf(parentId);
      if (n && n !== 'Unknown') return false;         // named parent → real
      return namedChildrenCount(parentId) <= 1;       // orphan ghost
    };
    const mine = new Set((parentsByChild.get(personId) ?? []).filter(p => !isGhost(p)));
    const theirs = new Set((parentsByChild.get(otherId) ?? []).filter(p => !isGhost(p)));
    let shared = 0;
    for (const p of mine) if (theirs.has(p)) shared++;
    const mineOnly = mine.size - shared;
    const theirsOnly = theirs.size - shared;
    if (mineOnly > 0 || theirsOnly > 0) return 'half';
    if (mine.size >= 2 && theirs.size >= 2) return 'full';
    return 'tentative';
  };

  const rows = useMemo(() => {
    const out: Row[] = [];
    // Seen set so a direct edge wins over any derived duplicate.
    const seen = new Set<string>();
    for (const e of edges) {
      const aIsMe = e.person_a_id === personId;
      const bIsMe = e.person_b_id === personId;
      if (!aIsMe && !bIsMe) continue;
      const otherId = aIsMe ? e.person_b_id : e.person_a_id;
      const label = relationshipLabelFromRecord(e, aIsMe);
      const key = `${otherId}:${e.type}`;
      seen.add(key);
      // Child-of: compute which other people also have this parent.
      // A parent SHARED with named siblings is load-bearing — removing
      // it severs those sibling links. A parent with NO other named
      // children is an orphan, usually left behind by an older buggy
      // add; it's the one the user actually wants to delete. The UI
      // below uses these to warn on shared rows and gently suggest
      // removal on orphan rows.
      let sharedWith: string[] | undefined;
      let orphanPlaceholder = false;
      if (label === 'Child of') {
        const otherChildren = (siblingsSharingParent.get(otherId) ?? [])
          .map(id => nameOf(id))
          .filter(n => n && !n.startsWith('Unknown'));
        if (otherChildren.length > 0) sharedWith = otherChildren;
        // Orphan = placeholder (Unknown name) parent that has no other
        // named children. These are the leftover ghosts to clean up.
        const parentName = nameOf(otherId);
        if (!sharedWith && (parentName === 'Unknown' || parentName === '')) {
          orphanPlaceholder = true;
        }
      }
      out.push({ key: `${e.id}`, edge: e, otherId, label, otherName: nameOf(otherId), derived: false, sharedWith, orphanPlaceholder });
    }
    // Append derived edges that aren't already covered by a direct one.
    for (const e of derivedEdges) {
      const aIsMe = e.aId === personId;
      const otherId = aIsMe ? e.bId : e.aId;
      const key = `${otherId}:${e.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let label = relationshipLabelFromGraphEdge(e, aIsMe);
      // Upgrade derived-sibling rows from a generic "Sibling" to the
      // specific flavour inferred from stored parent overlap. Full /
      // Half / Full (tentative) — the last is for pairs where only
      // one parent is known for both and we can't yet rule out half.
      if (e.type === 'sibling_of' && e.derived) {
        const kind = classifySibling(otherId);
        if (kind === 'full') label = 'Full sibling';
        else if (kind === 'half') label = 'Half-sibling';
        else label = 'Full sibling (tentative)';
      }
      out.push({
        key: `derived-${otherId}-${e.type}`,
        edge: null, otherId, label, otherName: nameOf(otherId), derived: true,
      });
    }
    // Group by type for legibility: parent/child first, then partner,
    // then siblings, then everything else. Alpha within group.
    const typeOrder = (r: Row) => {
      if (r.label.startsWith('Parent')) return 0;
      if (r.label.startsWith('Child')) return 1;
      if (r.label.startsWith('Partner') || r.label.startsWith('Ex-partner')) return 2;
      if (
        r.label.startsWith('Sibling') ||
        r.label.startsWith('Half') ||
        r.label.startsWith('Full sibling')
      ) return 3;
      return 4;
    };
    out.sort((a, b) => {
      const oa = typeOrder(a); const ob = typeOrder(b);
      if (oa !== ob) return oa - ob;
      return a.otherName.localeCompare(b.otherName);
    });
    return out;
  }, [edges, derivedEdges, personId, nameOf]);

  const handleRemove = async (edge: RelationshipRecord, label: string, otherName: string, sharedWith?: string[]) => {
    // Extra-loud warning when the parent is shared with named siblings
    // — removing it severs those sibling links and leaves people
    // stranded. Users have previously removed the wrong row here; this
    // keeps the confirm possible but makes the consequence unmissable.
    const isSharedParent = !!sharedWith && sharedWith.length > 0;
    const message = isSharedParent
      ? `This "Unknown" parent is also the parent of ${sharedWith!.join(', ')}. Removing this link will BREAK the sibling connection between ${personName} and ${sharedWith!.join(' / ')}. Are you sure this isn't the row you meant to keep?`
      : `This removes only the "${label.toLowerCase()} — ${otherName}" link. The other person and all of their other relationships are kept.`;
    const ok = await promptConfirm({
      title: isSharedParent ? 'Break sibling link?' : 'Remove relationship?',
      message,
      confirmLabel: isSharedParent ? 'Yes, break the sibling link' : 'Remove',
      danger: true,
    });
    if (!ok) return;
    const r = await removeRelationship(edge.id);
    if (r.success) {
      setBump(b => b + 1); // refetch the list
      onChanged();         // refresh the tree
    }
  };

  // Drag-to-reposition — modal often lands over the person being edited.
  // Ref-based transform so dragging doesn't trigger React re-renders on
  // every pointermove (with a full relationships list below, that causes
  // visible lag). Clamped to ±(viewport/2) on each axis so the close
  // button can't be stranded off-screen.
  const modalRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ x: 0, y: 0, dragging: false, sx: 0, sy: 0, bx: 0, by: 0 });
  const onDragStart = (e: React.PointerEvent) => {
    // Skip drag when the press landed on an interactive child (the X
    // close button etc.) so its click handler fires normally.
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
    if (modalRef.current) {
      modalRef.current.style.transform = `translate3d(${d.x}px, ${d.y}px, 0)`;
    }
  };
  const onDragEnd = () => { dragRef.current.dragging = false; };

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
          <h3 className="text-center px-10">
            <span className="text-sm text-muted-foreground">Edit relationships for </span>
            <span className="text-lg font-bold text-foreground">{personName}</span>
          </h3>
        </div>

        <div className="px-4 py-4 flex flex-col gap-2">
          {rows.some(r => r.derived) && (
            <p className="text-xs text-muted-foreground italic -mb-1">
              Rows marked <span className="not-italic font-medium">· auto</span> are computed from the parent/partner links in the rows above them — e.g. two people automatically become siblings when they share a parent. They have no Edit/Remove buttons because there's no stored row to change; to alter an auto row, edit one of the parent/partner links it's derived from.
            </p>
          )}
          {loading ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {personName} has no relationships yet. Use the button below to add the first one.
            </div>
          ) : (
            rows.map((row) => (
              <div
                key={row.key}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors ${
                  row.derived
                    ? 'border-border/50 bg-muted/30'
                    : row.sharedWith
                    ? 'border-emerald-500/40 bg-emerald-500/5'
                    : row.orphanPlaceholder
                    ? 'border-amber-500/40 bg-amber-500/5'
                    : 'border-border hover:border-primary/40'
                }`}
              >
                <Users className={`w-4 h-4 shrink-0 ${row.derived ? 'text-muted-foreground/60' : 'text-muted-foreground'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-foreground truncate flex items-center gap-1.5">
                    <span>{row.otherName}</span>
                    {row.sharedWith && row.sharedWith.length > 0 && (
                      <span className="text-[10px] uppercase tracking-wide font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded">
                        Linked
                      </span>
                    )}
                    {row.orphanPlaceholder && (
                      <span className="text-[10px] uppercase tracking-wide font-semibold text-amber-700 dark:text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded">
                        Orphan
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {row.label}
                    {row.derived && <span className="italic"> · auto</span>}
                    {row.sharedWith && row.sharedWith.length > 0 && (
                      <span className="ml-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                        · also parent of {row.sharedWith.join(', ')} — <span className="font-semibold">keep</span> to preserve sibling links
                      </span>
                    )}
                    {row.orphanPlaceholder && (
                      <span className="ml-1 text-[11px] text-amber-700 dark:text-amber-400">
                        · no other children — safe to remove
                      </span>
                    )}
                  </div>
                </div>
                {!row.derived && (
                  <>
                    <button
                      onClick={() => onEditEdge(row.otherId)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs hover:bg-accent"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      Edit
                    </button>
                    <button
                      onClick={() => row.edge && handleRemove(row.edge, row.label, row.otherName, row.sharedWith)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-600 hover:bg-red-500/10"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Remove
                    </button>
                  </>
                )}
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

/** Same labelling rules for derived graph edges — same underlying types
 *  (parent_of, sibling_of, spouse_of, associated_with), just from the
 *  graph representation rather than a DB row. */
function relationshipLabelFromGraphEdge(edge: FamilyGraphEdge, aIsMe: boolean): string {
  if (edge.type === 'parent_of') return aIsMe ? 'Parent of' : 'Child of';
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
    if (kind) return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ');
    return 'Associated';
  }
  return edge.type;
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
