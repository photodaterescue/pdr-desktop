import { useRef, useState, useMemo } from 'react';
import { Move, Users, X, Trash2, Image as ImageIcon, ArrowUp, ArrowDown } from 'lucide-react';
import { toast } from 'sonner';
import type { FamilyGraph } from '@/lib/electron-bridge';
import { deletePersonRecord, restorePerson } from '@/lib/electron-bridge';
import { promptConfirm } from './promptConfirm';
import { computeRelationshipLabels } from '@/lib/relationship-label';

interface PersonSummary {
  id: number;
  name: string;
  photoCount: number;
  gender: string | null;
}

type SortColumn = 'name' | 'gen' | 'photos' | 'gender' | 'relationship';
type SortDirection = 'asc' | 'desc';

/** Modal listing everyone connected to the current tree plus any
 *  orphaned persons, with sortable columns and a delete flow that's
 *  intentionally timid for anyone with verified photo tags. */
export function TreePeopleListModal({
  focusPersonId,
  treeName,
  graph,
  allPersons,
  connectedPersonIds,
  excludedSuggestionIds,
  onClose,
  onPersonsChanged,
  useGenderedLabels,
}: {
  focusPersonId: number | null;
  treeName: string;
  graph: FamilyGraph | null;
  allPersons: PersonSummary[];
  connectedPersonIds: Set<number>;
  /** Persons the user has flagged as "not in this family" via the
   *  suggestion pickers. Excluded from the Not-Connected section —
   *  they're deliberately not family, so they shouldn't clutter the
   *  family list either. Still visible in People Manager though; the
   *  hide action is about suggestion pickers, not about existence. */
  excludedSuggestionIds?: Set<number>;
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
  const [sortColumn, setSortColumn] = useState<SortColumn>('gen');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');

  // Relationship labels computed the same way the canvas computes them
  // — so "Brother" here matches "Brother" on the card.
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

  // Generation number per person, BFS from focus. Simple scheme for
  // this iteration: focus = 1, each parent_up hop adds 1, each
  // parent_down hop subtracts 1, siblings/spouses stay at the same
  // gen. After computing relatively, we shift so the SMALLEST gen is
  // 1 — which means the youngest generation in the visible tree is
  // labelled Gen 1 and older generations get higher numbers.
  //
  // TODO (follow-up): anchor on the youngest by birth_date instead of
  // focus, so Gen stays stable regardless of who the current focus is.
  const generations = useMemo(() => {
    const rel = new Map<number, number>();
    if (focusPersonId == null || !graph) return rel;
    rel.set(focusPersonId, 0);
    const adj = new Map<number, Array<{ to: number; delta: number }>>();
    const add = (from: number, to: number, delta: number) => {
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, delta });
    };
    for (const e of graph.edges) {
      if (e.type === 'parent_of') {
        add(e.aId, e.bId, -1); // parent → child, generation descends
        add(e.bId, e.aId, +1); // child → parent, generation ascends
      } else if (e.type === 'sibling_of' || e.type === 'spouse_of') {
        add(e.aId, e.bId, 0);
        add(e.bId, e.aId, 0);
      }
    }
    const queue = [focusPersonId];
    while (queue.length) {
      const cur = queue.shift()!;
      const curGen = rel.get(cur)!;
      for (const { to, delta } of adj.get(cur) ?? []) {
        if (rel.has(to)) continue;
        rel.set(to, curGen + delta);
        queue.push(to);
      }
    }
    // Shift so the min is 1 (youngest gen in the visible tree = 1).
    if (rel.size === 0) return rel;
    const min = Math.min(...rel.values());
    const shifted = new Map<number, number>();
    for (const [id, g] of rel) shifted.set(id, g - min + 1);
    return shifted;
  }, [focusPersonId, graph]);

  // Partition persons. Connected = reachable from focus via any edge
  // chain. Orphaned = in the DB but not on this tree. People the user
  // has explicitly hidden from this tree's pickers are excluded from
  // both sections — they're not part of this family by the user's own
  // declaration. They still live in People Manager.
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

  // Sort function used by both sections — keyed off the current sort
  // column + direction. Focus always pinned to the top regardless of
  // sort (it's the anchor for everyone else's relationship label).
  const sortRows = (rows: PersonSummary[]) => {
    const sorted = [...rows].sort((a, b) => {
      if (a.id === focusPersonId) return -1;
      if (b.id === focusPersonId) return 1;
      let cmp = 0;
      if (sortColumn === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortColumn === 'gen') {
        const ga = generations.get(a.id) ?? Number.POSITIVE_INFINITY;
        const gb = generations.get(b.id) ?? Number.POSITIVE_INFINITY;
        cmp = ga - gb;
      } else if (sortColumn === 'photos') cmp = a.photoCount - b.photoCount;
      else if (sortColumn === 'gender') cmp = (a.gender ?? 'zz').localeCompare(b.gender ?? 'zz');
      else if (sortColumn === 'relationship') {
        cmp = (labels.get(a.id) ?? 'zzz').localeCompare(labels.get(b.id) ?? 'zzz');
      }
      if (cmp === 0) cmp = a.name.localeCompare(b.name);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  };

  const connectedSorted = useMemo(() => sortRows(connected), [connected, sortColumn, sortDir, generations, labels]);
  const orphanedSorted = useMemo(() => sortRows(orphaned), [orphaned, sortColumn, sortDir, generations, labels]);

  const toggleSort = (col: SortColumn) => {
    if (sortColumn === col) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(col);
      setSortDir('asc');
    }
  };

  const handleDelete = async (person: PersonSummary) => {
    const hasPhotos = person.photoCount > 0;
    if (hasPhotos) {
      await promptConfirm({
        title: `Delete ${person.name.trim() || 'this person'}?`,
        message: `${person.photoCount} photo${person.photoCount === 1 ? ' is' : 's are'} tagged to this person. Because verifying photos represents real time investment, deletion of anyone with photo tags happens from People Manager — not from here. (That flow is coming soon.)`,
        confirmLabel: 'OK',
        hideCancel: true,
      });
      return;
    }
    const proceed = await promptConfirm({
      title: `Delete ${person.name.trim() || 'this person'}?`,
      message: `${person.name.trim() || 'They'} currently has no photos tagged. Deleting here removes them from this tree and from People Manager (they go to the Recycle Bin — undo within 30 seconds or restore from there later).`,
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
        className="bg-background rounded-xl shadow-2xl border border-border flex flex-col overflow-hidden"
        style={{
          width: 'min(640px, 95vw)',
          height: 'min(640px, 85vh)',
          minWidth: '480px',
          minHeight: '360px',
          resize: 'both',
        }}
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

        <div className="px-4 pt-3 pb-2 shrink-0">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by name…"
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-sm"
          />
        </div>

        {/* Column headers — clickable for sort. Grid columns kept in
            lock-step with the row layout below so headers + cells
            line up without a real <table>. */}
        <div
          className="px-4 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold border-b border-border/60 py-1.5 grid gap-2 items-center shrink-0"
          style={{ gridTemplateColumns: '1.7fr 42px 52px 40px 1.2fr 28px' }}
        >
          <SortHeader label="Name" active={sortColumn === 'name'} dir={sortDir} onClick={() => toggleSort('name')} />
          <SortHeader label="Gen" active={sortColumn === 'gen'} dir={sortDir} onClick={() => toggleSort('gen')} />
          <SortHeader label="Photos" active={sortColumn === 'photos'} dir={sortDir} onClick={() => toggleSort('photos')} align="right" />
          <SortHeader label="Sex" active={sortColumn === 'gender'} dir={sortDir} onClick={() => toggleSort('gender')} align="center" />
          <SortHeader label="Relationship" active={sortColumn === 'relationship'} dir={sortDir} onClick={() => toggleSort('relationship')} />
          <span />
        </div>

        <div className="flex-1 overflow-auto px-4 pb-2 pt-1">
          {connectedSorted.length > 0 && (
            <div className="flex flex-col mb-3">
              {connectedSorted.map(p => (
                <PersonRow
                  key={p.id}
                  person={p}
                  gen={generations.get(p.id) ?? null}
                  relationshipLabel={
                    p.id === focusPersonId ? 'Focus' : (labels.get(p.id) ?? null)
                  }
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
                    gen={null}
                    relationshipLabel={null}
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
  label, active, dir, onClick, align = 'left',
}: {
  label: string;
  active: boolean;
  dir: SortDirection;
  onClick: () => void;
  align?: 'left' | 'right' | 'center';
}) {
  const alignClass = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 ${alignClass} ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
    >
      <span className="truncate">{label}</span>
      {active && (dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
    </button>
  );
}

function PersonRow({
  person, gen, relationshipLabel, onDelete,
}: {
  person: PersonSummary;
  gen: number | null;
  relationshipLabel: string | null;
  onDelete: () => void;
}) {
  const hasPhotos = person.photoCount > 0;
  return (
    <div
      className="group grid gap-2 items-center px-2 py-1.5 rounded hover:bg-accent/50 text-sm"
      style={{ gridTemplateColumns: '1.7fr 42px 52px 40px 1.2fr 28px' }}
    >
      <p className="truncate font-medium">{person.name || '(unnamed)'}</p>
      <span className="text-xs text-muted-foreground">{gen != null ? gen : '—'}</span>
      <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
        <ImageIcon className="w-3 h-3" />
        <span>{person.photoCount}</span>
      </div>
      <div className="flex items-center justify-center">
        <GenderGlyph gender={person.gender} />
      </div>
      <p className="text-xs text-muted-foreground truncate">{relationshipLabel ?? '—'}</p>
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

/** Miniature native-SVG gender glyph — same shapes as the card badge
 *  (Mars / Venus / combined), scaled to fit a 16x16 inline slot. */
function GenderGlyph({ gender }: { gender: string | null }) {
  if (!gender) return <span className="text-muted-foreground/50 text-xs">—</span>;
  const showArrow = gender === 'male' || gender === 'non_binary';
  const showCross = gender === 'female' || gender === 'non_binary';
  if (!showArrow && !showCross) return <span className="text-muted-foreground/50 text-xs">—</span>;
  const isNB = gender === 'non_binary';
  // Coords chosen for a 16x16 viewBox with the circle roughly centred.
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
