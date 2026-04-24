import { useMemo, useState } from 'react';
import { X, Users, Move } from 'lucide-react';
import type { FamilyGraph } from '@/lib/electron-bridge';
import { useDraggableModal } from './useDraggableModal';

export type SiblingKind = 'full' | 'half' | 'none' | 'unknown';

interface SiblingKindDialogProps {
  fromPersonId: number;
  fromPersonName: string;
  toPersonId: number;
  toPersonName: string;
  graph: FamilyGraph | null;
  onConfirm: (kind: SiblingKind, sharedParentId: number | null) => void;
  onClose: () => void;
}

/**
 * Disambiguates what kind of sibling relationship the user means
 * BEFORE we touch the parent_of graph. Before this, the app silently
 * assumed "full siblings" and auto-filled shared placeholder parents,
 * which quietly destroyed accuracy for half-siblings, step-siblings,
 * and unknown cases.
 *
 * Behaviour per choice:
 *   full    — cross-inherit existing parents and top up to 2 shared
 *             placeholder parents. Today's behaviour, now opt-in.
 *   half    — store an explicit sibling_of edge with flags.half. If
 *             the user knows which parent is shared, cross-wire just
 *             that one parent_of edge so both sides share it. No
 *             placeholder fill.
 *   none    — store an explicit sibling_of edge. Don't touch parents
 *             at all (step-siblings, chosen family, blended families).
 *   unknown — same as none — they're siblings, parents can be sorted
 *             out later.
 */
export function SiblingKindDialog({
  fromPersonId, fromPersonName, toPersonId, toPersonName, graph, onConfirm, onClose,
}: SiblingKindDialogProps) {
  const [kind, setKind] = useState<SiblingKind>('full');
  const [sharedParentId, setSharedParentId] = useState<number | null>(null);

  // Shared drag hook — clamps so header stays on-screen.
  const { modalRef, dragHandleProps } = useDraggableModal();

  // Candidate shared parents = anyone who is already a parent of EITHER
  // of these two people. If known, half-sibling pick can be precise.
  const parentChoices = useMemo(() => {
    if (!graph) return [] as { id: number; name: string }[];
    const parentIds = new Set<number>();
    for (const e of graph.edges) {
      if (e.derived) continue;
      if (e.type !== 'parent_of') continue;
      if (e.bId === fromPersonId || e.bId === toPersonId) parentIds.add(e.aId);
    }
    const out: { id: number; name: string }[] = [];
    for (const n of graph.nodes) {
      if (parentIds.has(n.personId)) {
        out.push({ id: n.personId, name: n.name || '(unnamed)' });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [graph, fromPersonId, toPersonId]);

  const handleConfirm = () => {
    onConfirm(kind, kind === 'half' ? sharedParentId : null);
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={modalRef}
        className="bg-background rounded-xl shadow-2xl border border-border max-w-md w-full"
        onClick={e => e.stopPropagation()}
      >
        <div
          {...dragHandleProps}
          className={`border-b border-border px-4 py-3 relative ${dragHandleProps.className}`}
        >
          <Move className="absolute left-3 top-3 w-3.5 h-3.5 text-muted-foreground/60" aria-hidden />
          <button onClick={onClose} className="absolute right-3 top-3 p-1 rounded hover:bg-accent" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
          <div className="flex items-center justify-center gap-2 pr-6 pl-6">
            <Users className="w-4 h-4 text-primary shrink-0" />
            <h3 className="text-sm text-foreground text-center leading-snug">
              <span className="text-muted-foreground">How are </span>
              <span className="font-bold">{fromPersonName}</span>
              <span className="text-muted-foreground"> and </span>
              <span className="font-bold">{toPersonName}</span>
              <span className="text-muted-foreground"> related?</span>
            </h3>
          </div>
        </div>

        <div className="px-4 py-4 flex flex-col gap-2">
          <KindOption
            label="Full siblings"
            sub="They share the same two parents."
            selected={kind === 'full'}
            onClick={() => setKind('full')}
          />
          <KindOption
            label="Half-siblings"
            sub="They share one parent, not both."
            selected={kind === 'half'}
            onClick={() => setKind('half')}
          />

          {kind === 'half' && (
            <div className="ml-6 mr-1 mt-1 mb-2 pl-3 border-l-2 border-primary/30">
              <p className="text-xs text-muted-foreground mb-1.5">Which parent is shared?</p>
              {parentChoices.length === 0 ? (
                <p className="text-xs italic text-muted-foreground">No parents recorded yet — pick <em>Not sure yet</em> below instead and add the parents afterwards.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {parentChoices.map(p => (
                    <button
                      key={p.id}
                      onClick={() => setSharedParentId(sharedParentId === p.id ? null : p.id)}
                      className={`px-2 py-1 text-left text-xs rounded border transition-colors ${
                        sharedParentId === p.id
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:bg-accent'
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                  <button
                    onClick={() => setSharedParentId(null)}
                    className={`px-2 py-1 text-left text-xs rounded border transition-colors italic ${
                      sharedParentId === null ? 'border-primary/60 bg-primary/5' : 'border-border hover:bg-accent'
                    }`}
                  >
                    Don't know yet
                  </button>
                </div>
              )}
            </div>
          )}

          <KindOption
            label="No shared parents"
            sub="Step-siblings, chosen family, blended families etc. They're linked as siblings but don't share a biological parent."
            selected={kind === 'none'}
            onClick={() => setKind('none')}
          />
          <KindOption
            label="Not sure yet"
            sub="Just link them as siblings — figure out the parents later."
            selected={kind === 'unknown'}
            onClick={() => setKind('unknown')}
          />
        </div>

        <div className="border-t border-border px-4 py-3 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm hover:bg-accent">Cancel</button>
          <button
            onClick={handleConfirm}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            Save relationship
          </button>
        </div>
      </div>
    </div>
  );
}

function KindOption({ label, sub, selected, onClick }: { label: string; sub: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-left px-3 py-2 rounded-lg border transition-colors ${
        selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent'
      }`}
    >
      <div className={`text-sm font-medium ${selected ? 'text-primary' : 'text-foreground'}`}>{label}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
    </button>
  );
}
