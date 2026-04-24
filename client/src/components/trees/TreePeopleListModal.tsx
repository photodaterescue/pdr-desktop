import { useRef, useState, useMemo } from 'react';
import { Move, Users, X, Trash2, Image as ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { PersonSummary, FamilyGraph } from '@/lib/electron-bridge';
import { deletePersonRecord, restorePerson } from '@/lib/electron-bridge';
import { promptConfirm } from './promptConfirm';
import { computeRelationshipLabels } from '@/lib/relationship-label';

/** Modal listing everyone on the current tree — connected and orphaned —
 *  so the user can see photo counts and delete mistakes. The delete flow
 *  uses the existing soft-delete (discardPerson) and pairs it with a
 *  sonner undo toast so a mis-click is one tap away from reversal. */
export function TreePeopleListModal({
  focusPersonId,
  treeName,
  graph,
  allPersons,
  connectedPersonIds,
  onClose,
  onPersonsChanged,
  useGenderedLabels,
}: {
  focusPersonId: number | null;
  treeName: string;
  graph: FamilyGraph | null;
  allPersons: PersonSummary[];
  connectedPersonIds: Set<number>;
  onClose: () => void;
  onPersonsChanged: () => void;
  useGenderedLabels?: boolean;
}) {
  // Drag-to-reposition — same pattern as the other Trees modals.
  const modalRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ x: 0, y: 0, dragging: false, sx: 0, sy: 0, bx: 0, by: 0 });
  const onDragStart = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('button, input, textarea, a')) return;
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

  const [query, setQuery] = useState('');

  // Relationship labels for every connected person, computed the same
  // way the canvas computes them (so "Brother" here matches "Brother"
  // on the card). Focus person gets the literal "Focus" label.
  const labels = useMemo(() => {
    if (focusPersonId == null || !graph) return new Map<number, string>();
    const genderByPerson = new Map<number, string | null>();
    for (const n of graph.nodes) genderByPerson.set(n.personId, n.gender ?? null);
    return computeRelationshipLabels(
      focusPersonId,
      graph.edges,
      graph.nodes.map(n => n.personId),
      genderByPerson,
      !!useGenderedLabels,
    );
  }, [focusPersonId, graph, useGenderedLabels]);

  // Partition persons into connected / orphaned for this tree.
  // Connected = anyone reachable from focus through any relationship
  // chain (connectedPersonIds). Orphaned = in the DB but not reachable
  // from this tree's focus. Orphans are exactly the "Dorothy was
  // created twice and now one's floating off by herself" case.
  const { connected, orphaned } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (p: PersonSummary) => !needle || p.name.toLowerCase().includes(needle);
    const connected: PersonSummary[] = [];
    const orphaned: PersonSummary[] = [];
    for (const p of allPersons) {
      if (p.name.startsWith('__')) continue; // internal ignored/unsure buckets
      if (!matches(p)) continue;
      if (connectedPersonIds.has(p.id)) connected.push(p);
      else orphaned.push(p);
    }
    // Sort connected by focus first, then by name. Sort orphaned by name.
    connected.sort((a, b) => {
      if (a.id === focusPersonId) return -1;
      if (b.id === focusPersonId) return 1;
      return a.name.localeCompare(b.name);
    });
    orphaned.sort((a, b) => a.name.localeCompare(b.name));
    return { connected, orphaned };
  }, [allPersons, connectedPersonIds, focusPersonId, query]);

  const handleDelete = async (person: PersonSummary) => {
    const hasPhotos = person.photoCount > 0;
    if (hasPhotos) {
      // Person has verified photo tags — the work is significant and
      // the deletion is more consequential. Route to People Manager
      // (once it gains that capability) instead of letting Trees
      // casually remove them from here. For now, surface a friendly
      // block message.
      await promptConfirm({
        title: `Delete ${person.name.trim() || 'this person'}?`,
        message: `${person.photoCount} photo${person.photoCount === 1 ? ' is' : 's are'} tagged to this person. Because verifying photos represents real time investment, deletion of anyone with photo tags happens from People Manager — not from here. (That flow is coming soon.)`,
        confirmLabel: 'OK',
        hideCancel: true,
      });
      return;
    }
    // Zero photos — low-stakes deletion. Mild confirmation, then soft-
    // delete with a 30-second undo toast.
    const proceed = await promptConfirm({
      title: `Delete ${person.name.trim() || 'this person'}?`,
      message: `${person.name.trim() || 'They'} currently has no photos tagged.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!proceed) return;

    const result = await deletePersonRecord(person.id);
    if (!result.success) {
      toast.error(`Could not delete ${person.name.trim() || 'person'}.`);
      return;
    }
    onPersonsChanged();

    // Undo toast — 30 seconds is long enough for a double-take but
    // short enough that the user doesn't wonder if it's still there.
    toast.success(`Deleted ${person.name.trim() || 'person'}.`, {
      duration: 30000,
      action: {
        label: 'Undo',
        onClick: async () => {
          const r = await restorePerson(person.id);
          if (r.success) {
            toast.success(`Restored ${person.name.trim() || 'person'}.`);
            onPersonsChanged();
          } else {
            toast.error(`Could not restore ${person.name.trim() || 'person'}.`);
          }
        },
      },
    });
  };

  const total = connected.length + orphaned.length;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={modalRef}
        className="bg-background rounded-xl shadow-2xl border border-border w-full max-w-lg flex flex-col max-h-[80vh]"
        onClick={e => e.stopPropagation()}
      >
        <div
          className="border-b border-border px-4 py-3 relative select-none cursor-grab active:cursor-grabbing"
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
          <div className="flex items-center justify-center gap-2 pr-6 pl-6">
            <Users className="w-4 h-4 text-primary shrink-0" />
            <h3 className="text-sm text-foreground text-center leading-snug">
              <span className="text-muted-foreground">People on </span>
              <span className="font-bold">{treeName}</span>
            </h3>
          </div>
          <p className="text-xs text-muted-foreground text-center mt-1">
            {total} {total === 1 ? 'person' : 'people'}
            {orphaned.length > 0 && ` · ${orphaned.length} not connected to this tree`}
          </p>
        </div>

        <div className="px-4 pt-3 pb-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by name…"
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-sm"
          />
        </div>

        <div className="flex-1 overflow-auto px-4 pb-3">
          {connected.length > 0 && (
            <>
              <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mt-1 mb-1.5">
                On this tree
              </h4>
              <div className="flex flex-col gap-0.5 mb-3">
                {connected.map(p => (
                  <PersonRow
                    key={p.id}
                    person={p}
                    relationshipLabel={
                      p.id === focusPersonId ? 'Focus' : (labels.get(p.id) ?? null)
                    }
                    onDelete={() => handleDelete(p)}
                  />
                ))}
              </div>
            </>
          )}
          {orphaned.length > 0 && (
            <>
              <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mt-1 mb-1.5">
                Not connected to this tree
              </h4>
              <p className="text-[11px] text-muted-foreground mb-1.5">
                These people exist but aren't wired into the family graph from <strong>{treeName}</strong>. Delete them here if they were created by mistake.
              </p>
              <div className="flex flex-col gap-0.5">
                {orphaned.map(p => (
                  <PersonRow
                    key={p.id}
                    person={p}
                    relationshipLabel={null}
                    onDelete={() => handleDelete(p)}
                  />
                ))}
              </div>
            </>
          )}
          {connected.length === 0 && orphaned.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-6">
              No people match "{query}".
            </p>
          )}
        </div>

        <div className="border-t border-border px-4 py-2.5 flex items-center justify-end">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-sm hover:bg-accent">Close</button>
        </div>
      </div>
    </div>
  );
}

function PersonRow({
  person, relationshipLabel, onDelete,
}: {
  person: PersonSummary;
  relationshipLabel: string | null;
  onDelete: () => void;
}) {
  const hasPhotos = person.photoCount > 0;
  return (
    <div className="group flex items-center gap-3 px-2 py-1.5 rounded hover:bg-accent/50">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{person.name || '(unnamed)'}</p>
        {relationshipLabel && (
          <p className="text-[11px] text-muted-foreground truncate">{relationshipLabel}</p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0 text-xs text-muted-foreground">
        <ImageIcon className="w-3 h-3" />
        <span>{person.photoCount}</span>
      </div>
      <button
        onClick={onDelete}
        className={`p-1 rounded shrink-0 transition-colors ${
          hasPhotos
            ? 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-background'
            : 'text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-destructive hover:bg-destructive/10'
        }`}
        title={hasPhotos
          ? `${person.photoCount} photo${person.photoCount === 1 ? ' tagged' : 's tagged'} — delete from People Manager`
          : 'Delete this person (no photos tagged)'}
        aria-label={`Delete ${person.name}`}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
