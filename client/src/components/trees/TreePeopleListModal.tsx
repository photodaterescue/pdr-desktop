import { useRef, useState, useMemo, useEffect } from 'react';
import { Move, Users, X, Trash2, ArrowUp, ArrowDown, Minus, Plus, Target, Undo2, Archive, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import type { FamilyGraph, DiscardedPerson } from '@/lib/electron-bridge';
import { deletePersonRecord, restorePerson, listDiscardedPersons, permanentlyDeletePerson } from '@/lib/electron-bridge';
import { promptConfirm } from './promptConfirm';
import { computeRelationshipLabels } from '@/lib/relationship-label';
import { useDraggableModal } from './useDraggableModal';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { IconTooltip } from '@/components/ui/icon-tooltip';

interface PersonSummary {
  id: number;
  name: string;
  photoCount: number;
  verifiedPhotoCount: number;
  gender: string | null;
  birthDate: string | null;
}

type SortColumn = 'name' | 'gen' | 'photos' | 'gender' | 'relationship';
type SortDirection = 'asc' | 'desc';
interface SortKey { column: SortColumn; direction: SortDirection; }

/** Modal listing everyone connected to the current tree plus orphans,
 *  with sortable columns (shift+click for secondary), in-modal focus
 *  and Steps controls, and a delete flow that's timid for anyone with
 *  verified photo tags. */
export function TreePeopleListModal({
  focusPersonId,
  treeName,
  graph,
  allPersons,
  connectedPersonIds,
  excludedSuggestionIds,
  stepsEnabled,
  steps,
  onStepsChange,
  onSetFocus,
  onClose,
  onPersonsChanged,
  useGenderedLabels,
  simplifyHalfLabels,
}: {
  focusPersonId: number | null;
  treeName: string;
  graph: FamilyGraph | null;
  allPersons: PersonSummary[];
  connectedPersonIds: Set<number>;
  excludedSuggestionIds?: Set<number>;
  stepsEnabled: boolean;
  steps: number;
  onStepsChange: (next: number) => void;
  /** Set the tree's focus person inline — no external picker modal,
   *  no canvas navigation. The People list re-renders around the new
   *  focus immediately. */
  onSetFocus: (personId: number) => void;
  onClose: () => void;
  onPersonsChanged: () => void;
  useGenderedLabels?: boolean;
  simplifyHalfLabels?: boolean;
}) {
  // Shared drag hook — clamps the drag so the header can't be pushed
  // above/below the viewport, which used to strand the modal off-
  // screen when the user dragged it too far.
  const { modalRef, dragHandleProps } = useDraggableModal();

  // Backdrop close safety: only dismiss if BOTH pointerdown AND the
  // resulting click happened on the backdrop itself. Without this,
  // starting a CSS resize from the bottom-right corner and releasing
  // the pointer outside the modal closes the modal — a correction
  // I've had to apply more than once.
  const downOnBackdrop = useRef(false);

  const [query, setQuery] = useState('');
  const [sortStack, setSortStack] = useState<SortKey[]>([
    { column: 'gen', direction: 'asc' },
  ]);

  // Modal-local focus-change undo stack. Kept separate from the
  // canvas undo history so it doesn't pollute graph_history or clash
  // with Ctrl+Z on the tree. When the user changes focus via the
  // in-row target button we push the previous focus here; clicking
  // Undo walks back through the stack until we run out.
  const [focusHistory, setFocusHistory] = useState<(number | null)[]>([]);

  // Recycle Bin: persons the user has soft-deleted. Fetched on open
  // and after any delete/restore. Terry lost track of the two
  // Dorothys because the toast 30s expired and we had no UI showing
  // where they'd gone — this section answers "where did my deleted
  // person go?" and lets the user bring them back or remove them
  // for good.
  const [discarded, setDiscarded] = useState<DiscardedPerson[]>([]);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const reloadDiscarded = async () => {
    const r = await listDiscardedPersons();
    if (r.success && r.data) setDiscarded(r.data);
  };
  useEffect(() => { reloadDiscarded(); }, []);
  const handleSetFocus = (newId: number) => {
    if (newId === focusPersonId) return;
    setFocusHistory(h => [...h, focusPersonId]);
    onSetFocus(newId);
  };
  const handleUndoFocus = () => {
    if (focusHistory.length === 0) return;
    const previous = focusHistory[focusHistory.length - 1];
    setFocusHistory(h => h.slice(0, -1));
    if (previous != null) onSetFocus(previous);
  };

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
      !!simplifyHalfLabels,
    );
  }, [focusPersonId, graph, useGenderedLabels, simplifyHalfLabels]);

  // Generation anchor: among CONNECTED persons with a stored birth_date,
  // pick the one with the latest birth — that's the youngest. BFS from
  // them with parent_up = +1 gen, parent_down = -1 gen, sibling/spouse =
  // same gen. Shift so the youngest reads as Gen 1. Fallback: if no
  // connected person has a birth_date, use the focus as anchor so at
  // least the immediate family gets sensible numbers. Disconnected
  // persons remain ungen'd (show "—").
  const generations = useMemo(() => {
    const gen = new Map<number, number>();
    if (!graph) return gen;
    const connectedWithBirth = allPersons
      .filter(p => connectedPersonIds.has(p.id) && p.birthDate && !Number.isNaN(Date.parse(p.birthDate)));
    let anchor: number | null = null;
    if (connectedWithBirth.length > 0) {
      connectedWithBirth.sort((a, b) => Date.parse(b.birthDate!) - Date.parse(a.birthDate!));
      anchor = connectedWithBirth[0].id;
    } else if (focusPersonId != null) {
      anchor = focusPersonId;
    }
    if (anchor == null) return gen;

    const adj = new Map<number, Array<{ to: number; delta: number }>>();
    const add = (from: number, to: number, delta: number) => {
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, delta });
    };
    for (const e of graph.edges) {
      if (e.type === 'parent_of') {
        add(e.aId, e.bId, -1);
        add(e.bId, e.aId, +1);
      } else if (e.type === 'sibling_of' || e.type === 'spouse_of') {
        add(e.aId, e.bId, 0);
        add(e.bId, e.aId, 0);
      }
    }
    gen.set(anchor, 0);
    const queue = [anchor];
    while (queue.length) {
      const cur = queue.shift()!;
      const curGen = gen.get(cur)!;
      for (const { to, delta } of adj.get(cur) ?? []) {
        if (gen.has(to)) continue;
        gen.set(to, curGen + delta);
        queue.push(to);
      }
    }
    if (gen.size === 0) return gen;
    const min = Math.min(...gen.values());
    const shifted = new Map<number, number>();
    for (const [id, g] of gen) shifted.set(id, g - min + 1);
    return shifted;
  }, [allPersons, connectedPersonIds, graph, focusPersonId]);

  const { connected, orphaned } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (p: PersonSummary) => !needle || p.name.toLowerCase().includes(needle);
    const connected: PersonSummary[] = [];
    const orphaned: PersonSummary[] = [];
    for (const p of allPersons) {
      if (p.name.startsWith('__')) continue;
      if (!matches(p)) continue;
      if (excludedSuggestionIds?.has(p.id)) continue;
      if (connectedPersonIds.has(p.id)) connected.push(p);
      else orphaned.push(p);
    }
    return { connected, orphaned };
  }, [allPersons, connectedPersonIds, excludedSuggestionIds, query]);

  const compareByColumn = (a: PersonSummary, b: PersonSummary, col: SortColumn): number => {
    if (col === 'name') return a.name.localeCompare(b.name);
    if (col === 'gen') {
      const ga = generations.get(a.id) ?? Number.POSITIVE_INFINITY;
      const gb = generations.get(b.id) ?? Number.POSITIVE_INFINITY;
      return ga - gb;
    }
    if (col === 'photos') return a.verifiedPhotoCount - b.verifiedPhotoCount;
    if (col === 'gender') return (a.gender ?? 'zz').localeCompare(b.gender ?? 'zz');
    if (col === 'relationship') return (labels.get(a.id) ?? 'zzz').localeCompare(labels.get(b.id) ?? 'zzz');
    return 0;
  };

  // Walk the sort stack primary-first; first non-zero comparator wins.
  // If every level ties, fall back to name for a stable order. No focus
  // pinning — Terry rightly called out that pinning the focus to the
  // top makes sort unpredictable ("Gen 1 rows should start at the top
  // of a Gen-ascending sort, not whoever happens to be focus").
  const sortRows = (rows: PersonSummary[]) => {
    const sorted = [...rows].sort((a, b) => {
      for (const { column, direction } of sortStack) {
        const cmp = compareByColumn(a, b, column);
        if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
      }
      return a.name.localeCompare(b.name);
    });
    return sorted;
  };
  const connectedSorted = useMemo(() => sortRows(connected), [connected, sortStack, generations, labels]);
  const orphanedSorted = useMemo(() => sortRows(orphaned), [orphaned, sortStack, generations, labels]);

  const clickHeader = (col: SortColumn, shiftKey: boolean) => {
    const existing = sortStack.find(k => k.column === col);
    if (!shiftKey) {
      // Primary sort replace. If already primary, flip direction; else
      // reset stack to just this column ascending.
      if (sortStack[0]?.column === col) {
        setSortStack([{ column: col, direction: sortStack[0].direction === 'asc' ? 'desc' : 'asc' }]);
      } else {
        setSortStack([{ column: col, direction: 'asc' }]);
      }
      return;
    }
    // Shift-click adds secondary/tertiary or flips direction if already present.
    if (existing) {
      setSortStack(sortStack.map(k =>
        k.column === col ? { ...k, direction: k.direction === 'asc' ? 'desc' : 'asc' } : k
      ));
    } else {
      // Cap at 3 levels — beyond that is noise.
      const next = [...sortStack, { column: col, direction: 'asc' as SortDirection }];
      setSortStack(next.slice(-3));
    }
  };

  const handleDelete = async (person: PersonSummary) => {
    const name = person.name.trim() || 'this person';
    const hasVerified = person.verifiedPhotoCount > 0;
    // Every delete goes through the same soft-delete path (Recycle
    // Bin is the real safety net), but the confirmation weight scales
    // with cost:
    //   * 0 verified photos  — simple Yes/No
    //   * 1+ verified photos — type-to-confirm gate (user must type
    //     the person's name) so muscle-memory clicks can't nuke
    //     real tagging work.
    const message = hasVerified
      ? `${person.verifiedPhotoCount} verified photo${person.verifiedPhotoCount === 1 ? ' is' : 's are'} tagged to ${name}. Deleting moves them to the Recycle Bin — restoring them from there brings every tag back. The photos themselves are never deleted.`
      : `${name} currently has no verified photos tagged. Deleting moves them to the Recycle Bin — restorable there, or one-click undo via the toast.`;
    const proceed = await promptConfirm({
      title: `Delete ${name}?`,
      message,
      confirmLabel: hasVerified ? `Delete ${name}` : 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
      typeToConfirm: hasVerified ? (person.name.trim() || undefined) : undefined,
    });
    if (!proceed) return;

    const result = await deletePersonRecord(person.id);
    if (!result.success) {
      toast.error(`Could not delete ${person.name.trim() || 'person'}.`);
      return;
    }
    onPersonsChanged();
    reloadDiscarded();

    toast.success(`Deleted ${person.name.trim() || 'person'}.`, {
      duration: 30000,
      action: {
        label: 'Undo',
        onClick: async () => {
          const r = await restorePerson(person.id);
          if (r.success) {
            toast.success(`Restored ${person.name.trim() || 'person'}.`);
            onPersonsChanged();
            reloadDiscarded();
          } else {
            toast.error(`Could not restore ${person.name.trim() || 'person'}.`);
          }
        },
      },
    });
  };

  const handleRestoreDiscarded = async (p: DiscardedPerson) => {
    const r = await restorePerson(p.id);
    if (r.success) {
      toast.success(`Restored ${p.name.trim() || 'person'}.`);
      onPersonsChanged();
      reloadDiscarded();
    } else {
      toast.error(`Could not restore ${p.name.trim() || 'person'}.`);
    }
  };

  const handlePurgeDiscarded = async (p: DiscardedPerson) => {
    const name = p.name.trim();
    const proceed = await promptConfirm({
      title: `Permanently delete ${name || 'this person'}?`,
      message: `This removes them from the Recycle Bin forever. You can't get them back, and any remaining photo-tag links are cleared. Photos themselves are not deleted.`,
      confirmLabel: 'Permanently delete',
      cancelLabel: 'Cancel',
      danger: true,
      // Permanent deletion is truly irreversible — type-gate it by
      // the person's name. Falls back to simple confirmation if
      // the record has no name (edge case: an unnamed discarded
      // row has nothing meaningful to type).
      typeToConfirm: name || undefined,
    });
    if (!proceed) return;
    const r = await permanentlyDeletePerson(p.id);
    if (r.success) {
      toast.success(`Permanently deleted ${p.name.trim() || 'person'}.`);
      reloadDiscarded();
    } else {
      toast.error(`Could not permanently delete.`);
    }
  };

  const total = connected.length + orphaned.length;
  const focusName = (() => {
    if (focusPersonId == null) return null;
    return allPersons.find(p => p.id === focusPersonId)?.name?.trim() || null;
  })();

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={modalRef}
        className="bg-background rounded-xl shadow-2xl border border-border flex flex-col overflow-hidden"
        style={{
          width: 'min(700px, 95vw)',
          height: 'min(680px, 85vh)',
          minWidth: '520px',
          minHeight: '360px',
          resize: 'both',
        }}
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
              <span className="text-muted-foreground">People on </span>
              <span className="font-bold">{treeName}</span>
            </h3>
          </div>
          <p className="text-xs text-muted-foreground text-center mt-1">
            {total} {total === 1 ? 'person' : 'people'}
            {orphaned.length > 0 && ` · ${orphaned.length} not connected to this tree`}
          </p>
        </div>

        {/* Tree controls: Focus indicator + Steps + modal-local undo.
            Focus is not changed from this strip — use the target
            icon next to any row in the list. The strip just shows
            the current focus and offers a local undo for recent
            changes. */}
        <div className="flex items-center gap-2 px-4 pt-2 pb-1.5 text-xs shrink-0">
          <span className="text-muted-foreground shrink-0">Focus:</span>
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-primary/10 text-primary font-medium max-w-[180px]">
            <Target className="w-3 h-3 shrink-0" />
            <span className="truncate">{focusName || '(none)'}</span>
          </span>
          <IconTooltip label={focusHistory.length === 0
            ? 'No focus changes to undo'
            : `Undo the last focus change (${focusHistory.length} in history)`} side="bottom">
            <button
              onClick={handleUndoFocus}
              disabled={focusHistory.length === 0}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
            >
              <Undo2 className="w-3 h-3" />
              <span>Undo focus</span>
            </button>
          </IconTooltip>
          <span className="text-muted-foreground shrink-0 ml-2">Steps:</span>
          <div className="inline-flex items-center gap-0.5 border border-border rounded">
            <IconTooltip label="Fewer steps from focus" side="bottom">
              <button
                onClick={() => onStepsChange(Math.max(1, steps - 1))}
                disabled={!stepsEnabled || steps <= 1}
                className="p-0.5 hover:bg-accent rounded-l disabled:opacity-40"
              >
                <Minus className="w-3 h-3" />
              </button>
            </IconTooltip>
            <span className="px-2 font-medium text-foreground min-w-[20px] text-center">
              {stepsEnabled ? steps : '∞'}
            </span>
            <IconTooltip label="More steps from focus" side="bottom">
              <button
                onClick={() => onStepsChange(steps + 1)}
                disabled={!stepsEnabled}
                className="p-0.5 hover:bg-accent rounded-r disabled:opacity-40"
              >
                <Plus className="w-3 h-3" />
              </button>
            </IconTooltip>
          </div>
          <div className="flex-1" />
        </div>

        <div className="px-4 pt-1 pb-2 shrink-0">
          <input
            type="text"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by name…"
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-sm"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            Click a column to sort. Shift-click a second column to chain sorts (e.g. Sex, then Name).
          </p>
        </div>

        <div
          className="px-4 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold border-b border-border/60 py-1.5 grid gap-2 items-center shrink-0"
          style={{ gridTemplateColumns: '28px 1.7fr 42px 60px 40px 1.2fr 28px' }}
        >
          <span />
          <SortHeader label="Name" column="name" stack={sortStack} onClick={clickHeader} />
          <SortHeader label="Gen" column="gen" stack={sortStack} onClick={clickHeader} />
          <SortHeader label="Photos" column="photos" stack={sortStack} onClick={clickHeader} align="right" />
          <SortHeader label="Sex" column="gender" stack={sortStack} onClick={clickHeader} align="center" />
          <SortHeader label="Relationship" column="relationship" stack={sortStack} onClick={clickHeader} />
          <span />
        </div>

        <div className="flex-1 overflow-auto px-4 pb-2 pt-1">
          {connectedSorted.length > 0 && (
            <div className="flex flex-col mb-3">
              {connectedSorted.map(p => (
                <PersonRow
                  key={p.id}
                  person={p}
                  isFocus={p.id === focusPersonId}
                  gen={generations.get(p.id) ?? null}
                  relationshipLabel={
                    p.id === focusPersonId ? 'Focus' : (labels.get(p.id) ?? null)
                  }
                  onSetFocus={() => handleSetFocus(p.id)}
                  onDelete={() => handleDelete(p)}
                />
              ))}
            </div>
          )}
          {orphanedSorted.length > 0 && (
            <>
              <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mt-2 mb-1.5">
                Not connected to this tree
              </h4>
              <p className="text-[11px] text-muted-foreground mb-1.5">
                These persons exist in the database but aren't wired into <strong>{treeName}</strong>. Usually this means they were created by mistake in Trees.
              </p>
              <div className="flex flex-col">
                {orphanedSorted.map(p => (
                  <PersonRow
                    key={p.id}
                    person={p}
                    isFocus={false}
                    gen={null}
                    relationshipLabel={null}
                    onSetFocus={() => handleSetFocus(p.id)}
                    onDelete={() => handleDelete(p)}
                  />
                ))}
              </div>
            </>
          )}
          {connected.length === 0 && orphaned.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-6">
              {query ? `No people match "${query}".` : 'No people on this tree yet.'}
            </p>
          )}

          {discarded.length > 0 && (
            <div className="mt-3 border-t border-border pt-2">
              <button
                onClick={() => setRecycleOpen(v => !v)}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <Archive className="w-3 h-3" />
                <span>
                  Recycle Bin: {discarded.length} deleted {recycleOpen ? '— close' : '— review'}
                </span>
              </button>
              {recycleOpen && (
                <div className="mt-1.5 flex flex-col gap-0.5">
                  <p className="text-[11px] text-muted-foreground mb-1">
                    Restore brings the person (and their photo tags) back. Permanent delete removes them forever.
                  </p>
                  {discarded.map(p => {
                    const when = p.discarded_at ? new Date(p.discarded_at).toLocaleString() : '';
                    return (
                      <div
                        key={p.id}
                        className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-muted/40 text-xs"
                      >
                        <div className="flex-1 min-w-0">
                          <span className="truncate font-medium">{p.name.trim() || '(unnamed)'}</span>
                          {when && <span className="text-muted-foreground/70 ml-2 text-[10px]">deleted {when}</span>}
                        </div>
                        <IconTooltip label="Restore to the tree and People Manager" side="left">
                          <button
                            onClick={() => handleRestoreDiscarded(p)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-foreground hover:bg-primary/10"
                          >
                            <RotateCcw className="w-3 h-3 text-primary" />
                            Restore
                          </button>
                        </IconTooltip>
                        <IconTooltip label="Delete forever" side="left">
                          <button
                            onClick={() => handlePurgeDiscarded(p)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="w-3 h-3" />
                            Delete forever
                          </button>
                        </IconTooltip>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border px-4 py-2.5 flex items-center justify-between shrink-0">
          <p className="text-[10px] text-muted-foreground leading-tight">
            Drag the bottom-right corner to resize.
          </p>
          <button onClick={onClose} className="px-3 py-1.5 rounded text-sm hover:bg-accent">Close</button>
        </div>
      </div>
    </div>
  );
}

function SortHeader({
  label, column, stack, onClick, align = 'left',
}: {
  label: string;
  column: SortColumn;
  stack: SortKey[];
  onClick: (col: SortColumn, shiftKey: boolean) => void;
  align?: 'left' | 'right' | 'center';
}) {
  const alignClass = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  const idx = stack.findIndex(k => k.column === column);
  const active = idx !== -1;
  const dir = active ? stack[idx].direction : null;
  return (
    <IconTooltip
      label={active
        ? `Sort level ${idx + 1} · ${dir}. Click to flip direction or drop to primary. Shift-click to cycle shift-level.`
        : 'Click to sort. Shift-click to add as secondary sort.'}
      side="top"
    >
      <button
        onClick={(e) => onClick(column, e.shiftKey)}
        className={`flex items-center gap-1 ${alignClass} ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
      >
        <span className="truncate">{label}</span>
        {active && (
          <span className="inline-flex items-center">
            {dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
            {stack.length > 1 && (
              <span className="text-[8px] ml-0.5 font-bold">{idx + 1}</span>
            )}
          </span>
        )}
      </button>
    </IconTooltip>
  );
}

function PersonRow({
  person, isFocus, gen, relationshipLabel, onSetFocus, onDelete,
}: {
  person: PersonSummary;
  isFocus: boolean;
  gen: number | null;
  relationshipLabel: string | null;
  onSetFocus: () => void;
  onDelete: () => void;
}) {
  const hasVerified = person.verifiedPhotoCount > 0;
  return (
    <div
      className={`group grid gap-2 items-center px-2 py-1.5 rounded text-sm transition-colors ${
        isFocus
          ? 'bg-amber-500/10 ring-1 ring-amber-500/50 hover:bg-amber-500/15'
          : 'hover:bg-accent/50'
      }`}
      style={{ gridTemplateColumns: '28px 1.7fr 42px 60px 40px 1.2fr 28px' }}
    >
      <IconTooltip label={isFocus ? 'Current focus' : `Make ${person.name} the focus of this tree`} side="right">
        <button
          onClick={onSetFocus}
          disabled={isFocus}
          className={`p-1 rounded shrink-0 transition-colors ${
            isFocus
              ? 'text-amber-600 dark:text-amber-400 cursor-default'
              : 'text-muted-foreground/70 opacity-0 group-hover:opacity-100 hover:text-primary hover:bg-primary/10 focus:opacity-100'
          }`}
          aria-label={isFocus ? `${person.name} — current focus` : `Make ${person.name} the focus`}
        >
          <Target className="w-3.5 h-3.5" />
        </button>
      </IconTooltip>
      <p className="truncate font-medium">{person.name || '(unnamed)'}</p>
      <span className="text-xs text-muted-foreground">{gen != null ? gen : '—'}</span>
      <div className="flex items-center justify-end text-xs text-muted-foreground tabular-nums">
        {person.verifiedPhotoCount}
      </div>
      <div className="flex items-center justify-center">
        <GenderGlyph gender={person.gender} />
      </div>
      <p className="text-xs text-muted-foreground truncate">{relationshipLabel ?? '—'}</p>
      <IconTooltip label={hasVerified
        ? `Delete ${person.name} (${person.verifiedPhotoCount} verified photo${person.verifiedPhotoCount === 1 ? '' : 's'} — strong confirmation required)`
        : `Delete ${person.name} (no verified photos)`} side="left">
        <button
          onClick={onDelete}
          className="p-1 rounded shrink-0 text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
          aria-label={`Delete ${person.name}`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </IconTooltip>
    </div>
  );
}

/** Miniature native-SVG gender glyph — same shapes as the card badge,
 *  scaled to fit a 16x16 inline slot. */
function GenderGlyph({ gender }: { gender: string | null }) {
  if (!gender) return <span className="text-muted-foreground/70 text-xs">—</span>;
  const showArrow = gender === 'male' || gender === 'non_binary';
  const showCross = gender === 'female' || gender === 'non_binary';
  if (!showArrow && !showCross) return <span className="text-muted-foreground/70 text-xs">—</span>;
  const isNB = gender === 'non_binary';
  const cx = 8 + (isNB ? 0 : (showArrow ? -1 : 0));
  const cy = 8 + (isNB ? 0 : (showArrow ? 1 : -1));
  const r = 3;
  const arrowTipX = 13;
  const arrowTipY = 3;
  const arrowStartX = cx + r * 0.707;
  const arrowStartY = cy - r * 0.707;
  const crossTop = cy + r;
  const crossBottom = 14;
  const crossMid = (crossTop + crossBottom) / 2 + 0.3;
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" className="text-foreground/80">
      <g stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <circle cx={cx} cy={cy} r={r} />
        {showArrow && (
          <>
            <line x1={arrowStartX} y1={arrowStartY} x2={arrowTipX} y2={arrowTipY} />
            <polyline points={`${arrowTipX - 2.5},${arrowTipY} ${arrowTipX},${arrowTipY} ${arrowTipX},${arrowTipY + 2.5}`} />
          </>
        )}
        {showCross && (
          <>
            <line x1={cx} y1={crossTop} x2={cx} y2={crossBottom} />
            <line x1={cx - 2.2} y1={crossMid} x2={cx + 2.2} y2={crossMid} />
          </>
        )}
      </g>
    </svg>
  );
}
