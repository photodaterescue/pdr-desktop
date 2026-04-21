import { useState, useMemo, useEffect } from 'react';
import { X, Users, AlertCircle, Info, Pencil, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { addRelationship, updateRelationship, removeRelationship, createPlaceholderPerson, createNamedPerson, type FamilyGraph, type FamilyGraphEdge } from '@/lib/electron-bridge';
import { UserPlus } from 'lucide-react';
import { DateTripleInput } from './DateTripleInput';
import { promptConfirm } from './promptConfirm';

interface PersonSummary { id: number; name: string; }

export type DeclarativeRelationshipType =
  // Family
  | 'parent' | 'child' | 'partner'
  | 'sibling' | 'half_sibling' | 'adopted_sibling'
  | 'grandparent' | 'grandchild'
  | 'aunt_uncle' | 'niece_nephew' | 'cousin'
  // Romantic — non-family
  | 'ex_partner'
  // Friendship
  | 'friend' | 'close_friend' | 'best_friend' | 'acquaintance' | 'neighbour'
  // Professional / social
  | 'colleague' | 'ex_colleague' | 'classmate' | 'teammate' | 'roommate'
  | 'manager' | 'mentor' | 'mentee' | 'client'
  // Free-form escape hatch
  | 'other';

interface SetRelationshipModalProps {
  /** The person whose relationships we're editing. */
  fromPersonId: number;
  fromPersonName: string;
  persons: PersonSummary[];
  /** Current family graph (for deriving parents, children etc. during inference). */
  graph: FamilyGraph | null;
  /** Optional: preselect the "other person" on mount. Used when the
   *  Edit-Relationships modal launches directly into editing a specific
   *  existing edge — the edge-detection useEffect then prefills the
   *  form automatically. */
  initialToPersonId?: number;
  onClose: () => void;
  onRelationshipCreated: () => void;
  /** Called when a new named person is created from within the modal, so
   *  the parent can refresh its all-persons list. */
  onPersonsChanged?: () => void;
}

/**
 * The core design: users assert a high-level relationship between two
 * already-named people. Internally, only `parent_of` and `spouse_of` edges
 * are stored — every other relationship type is decomposed into those
 * primitives via the graph. Where a derivation is impossible (e.g. trying
 * to mark a grandparent when the intermediate parent isn't set yet) we
 * show a clear "you need X first" message rather than silently failing.
 */
export function SetRelationshipModal({ fromPersonId, fromPersonName, persons, graph, initialToPersonId, onClose, onRelationshipCreated, onPersonsChanged }: SetRelationshipModalProps) {
  // Persons list grows locally when the user creates a new named person
  // inside the modal — so the newly-created name shows up immediately
  // in the list without a full parent refresh.
  const [locallyCreated, setLocallyCreated] = useState<PersonSummary[]>([]);
  const allPersonsLocal = useMemo(() => {
    const seen = new Set(persons.map(p => p.id));
    const extra = locallyCreated.filter(p => !seen.has(p.id));
    return [...persons, ...extra];
  }, [persons, locallyCreated]);
  const [type, setType] = useState<DeclarativeRelationshipType>('parent');
  const [toPersonId, setToPersonId] = useState<number | null>(initialToPersonId ?? null);
  const [query, setQuery] = useState('');
  const [flags, setFlags] = useState<{ biological: boolean; step: boolean; adopted: boolean; in_law: boolean }>({
    biological: true, step: false, adopted: false, in_law: false,
  });
  const [sinceDate, setSinceDate] = useState('');
  const [untilDate, setUntilDate] = useState('');
  const [sharedParentId, setSharedParentId] = useState<number | null>(null);
  const [customLabel, setCustomLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** When non-null, the modal is editing an existing stored edge rather
   *  than creating a new one. Populated whenever the user picks a
   *  `toPersonId` for whom a relationship already exists. */
  const [editingEdge, setEditingEdge] = useState<FamilyGraphEdge | null>(null);
  /** Collapse state for each category. Direct family always stays open. */
  const [openSections, setOpenSections] = useState({
    blended: false,
    extended: false,
    romantic: false,
    friends: false,
    work: false,
    other: false,
  });
  const toggle = (key: keyof typeof openSections) =>
    setOpenSections(prev => ({ ...prev, [key]: !prev[key] }));

  // Auto-expand the section that contains the currently-selected type, so
  // edit mode never hides the active pill behind a collapsed header.
  useEffect(() => {
    const section = sectionForType(type);
    if (section && !openSections[section]) {
      setOpenSections(prev => ({ ...prev, [section]: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const filteredPersons = useMemo(() => allPersonsLocal
    .filter(p => p.id !== fromPersonId && !p.name.startsWith('__'))
    .filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name)), [allPersonsLocal, query, fromPersonId]);

  const toPerson = allPersonsLocal.find(p => p.id === toPersonId);

  const trimmedQuery = query.trim();
  const hasExactMatch = trimmedQuery.length > 0 && filteredPersons.some(p => p.name.toLowerCase() === trimmedQuery.toLowerCase());
  const showCreateButton = trimmedQuery.length > 0 && !hasExactMatch;

  const handleCreateNewPerson = async () => {
    if (!trimmedQuery) return;
    const r = await createNamedPerson(trimmedQuery);
    if (!r.success || r.data == null) {
      setError(r.error ?? 'Could not create person.');
      return;
    }
    const newPerson = { id: r.data, name: trimmedQuery };
    setLocallyCreated(prev => [...prev, newPerson]);
    setToPersonId(newPerson.id);
    setQuery('');
    if (onPersonsChanged) onPersonsChanged();
  };

  // Whenever the "other person" changes, look for an existing stored
  // relationship between the two. If found, prefill the form so the
  // user can edit instead of blindly creating a duplicate (which would
  // trip the UNIQUE constraint with "that relationship already exists").
  useEffect(() => {
    if (!graph || toPersonId == null) { setEditingEdge(null); return; }
    const existing = graph.edges.find(e =>
      !e.derived && e.id != null
      && ((e.aId === fromPersonId && e.bId === toPersonId) || (e.aId === toPersonId && e.bId === fromPersonId))
    );
    if (!existing) { setEditingEdge(null); return; }
    setEditingEdge(existing);
    // Prefill inputs from the existing edge.
    const mapped = storedToDeclarative(existing, fromPersonId);
    if (mapped) setType(mapped);
    setSinceDate(existing.since ?? '');
    setUntilDate(existing.until ?? '');
    const ef: any = existing.flags ?? {};
    setFlags({
      biological: !!ef.biological,
      step: !!ef.step,
      adopted: !!ef.adopted,
      in_law: !!ef.in_law,
    });
    if (ef.label) setCustomLabel(ef.label);
  }, [toPersonId, graph, fromPersonId]);

  // For half-sibling: parents of the SELECTED other person (to offer as "which parent is shared").
  const potentialSharedParents = useMemo(() => {
    if (!graph || !toPersonId) return [];
    const parentIds = graph.edges
      .filter(e => e.type === 'parent_of' && e.bId === toPersonId && !e.derived)
      .map(e => e.aId);
    return graph.nodes.filter(n => parentIds.includes(n.personId));
  }, [graph, toPersonId]);

  const handleSave = async () => {
    setError(null);
    if (!toPersonId) { setError('Pick someone to link to first.'); return; }
    setBusy(true);
    try {
      const activeFlags: any = {};
      if (flags.step) activeFlags.step = true;
      if (flags.adopted) activeFlags.adopted = true;
      if (flags.in_law) activeFlags.in_law = true;
      if (!flags.step && !flags.adopted && !flags.in_law) activeFlags.biological = true;

      // Edit path — if we're sitting on an existing stored edge AND the
      // declarative type still maps to that same stored type, just UPDATE
      // the row (dates, flags, until date for divorce, ended flag, etc.).
      // If the user picked a different underlying type (e.g. was Partner,
      // now Friend), we delete the old row and create a new one so the
      // relationship shape is right.
      if (editingEdge && editingEdge.id != null) {
        const storedForNewType = declarativeToStoredType(type);
        // Both 'parent' and 'child' map to stored type 'parent_of', but
        // they point in OPPOSITE directions. If the user flipped the
        // declarative side (Parent → Child or vice versa), we must
        // drop the old edge and recreate it with swapped aId/bId —
        // a field patch alone would leave the original direction.
        const directionFlipped =
          editingEdge.type === 'parent_of' &&
          ((type === 'parent' && editingEdge.aId !== fromPersonId) ||
           (type === 'child'  && editingEdge.aId === fromPersonId));
        if (storedForNewType === editingEdge.type && !directionFlipped) {
          // Same stored type AND same direction → patch in place.
          const patch: any = {
            since: sinceDate || null,
            until: untilDate || null,
          };
          // Build merged flags depending on stored type.
          if (editingEdge.type === 'associated_with') {
            const kind = declarativeToAssociationKind(type);
            patch.flags = {
              kind: kind ?? ((editingEdge.flags as any)?.kind ?? 'other'),
              ...(type === 'ex_colleague' || type === 'ex_partner' ? { ended: true } : {}),
              ...(customLabel.trim() && type === 'other' ? { label: customLabel.trim() } : {}),
            };
          } else if (editingEdge.type === 'sibling_of') {
            patch.flags = {
              ...(type === 'half_sibling' ? { half: true } : {}),
              ...(type === 'adopted_sibling' ? { adopted: true } : {}),
            };
          } else if (editingEdge.type === 'parent_of') {
            patch.flags = activeFlags;
          }
          const r = await updateRelationship(editingEdge.id, patch);
          if (!r.success) { setError(r.error ?? 'Could not update.'); setBusy(false); return; }
          onRelationshipCreated();
          onClose();
          return;
        } else {
          // Type changed → drop old, create new.
          await removeRelationship(editingEdge.id);
        }
      }

      const results = await performDeclarativeCreate(type, fromPersonId, toPersonId, graph, {
        flags: activeFlags,
        sinceDate: sinceDate || undefined,
        untilDate: untilDate || undefined,
        sharedParentId,
        customLabel: customLabel.trim() || undefined,
      });
      if (results.error) { setError(results.error); setBusy(false); return; }
      onRelationshipCreated();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const handleRemoveEditing = async () => {
    if (!editingEdge || editingEdge.id == null) return;
    if (!(await promptConfirm({
      title: 'Remove relationship?',
      message: 'This removes only this one relationship. The people on either side are kept.',
      confirmLabel: 'Remove',
      danger: true,
    }))) return;
    setBusy(true);
    const r = await removeRelationship(editingEdge.id);
    if (!r.success) { setError(r.error ?? 'Could not remove.'); setBusy(false); return; }
    onRelationshipCreated();
    onClose();
  };

  const sentence = toPerson
    ? `${fromPersonName} ${TYPE_VERBS[type]} ${toPerson.name}.`
    : `${fromPersonName} ${TYPE_VERBS[type]} …`;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-xl shadow-2xl border border-border max-w-2xl w-full max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-background border-b border-border px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Set relationship</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Link to someone already named, or add a new family member by name.</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-4 py-4 flex flex-col gap-4">
          {/* Sentence preview */}
          <div className="px-3 py-2.5 bg-primary/5 border border-primary/20 rounded-lg text-sm text-foreground">
            {sentence}
          </div>

          {/* Edit-mode banner */}
          {editingEdge && toPerson && (
            <div className="flex items-start gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm">
              <Pencil className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
              <span className="text-amber-700 dark:text-amber-300">
                You already have a relationship with {toPerson.name}. Changes here <strong>update</strong> the existing record (e.g. set an Until date to mark as ex-).
              </span>
            </div>
          )}

          {/* Relationship type groups */}
          <div className="flex flex-col gap-3">
            {/* Direct family — always open. This is Trees' bread-and-butter. */}
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Direct family</label>
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                {(['parent', 'child', 'partner', 'sibling'] as DeclarativeRelationshipType[]).map(t => (
                  <TypeOption key={t} value={t} active={type === t} onClick={() => setType(t)} label={TYPE_LABELS[t]} />
                ))}
              </div>
            </div>

            {/* Collapsible sub-categories */}
            <CollapsibleSection title="Blended or adopted" open={openSections.blended} onToggle={() => toggle('blended')}>
              <div className="grid grid-cols-2 gap-2">
                {(['half_sibling', 'adopted_sibling'] as DeclarativeRelationshipType[]).map(t => (
                  <TypeOption key={t} value={t} active={type === t} onClick={() => setType(t)} label={TYPE_LABELS[t]} />
                ))}
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Extended family" open={openSections.extended} onToggle={() => toggle('extended')}>
              <div className="grid grid-cols-2 gap-2">
                {(['grandparent', 'grandchild', 'aunt_uncle', 'niece_nephew', 'cousin'] as DeclarativeRelationshipType[]).map(t => (
                  <TypeOption key={t} value={t} active={type === t} onClick={() => setType(t)} label={TYPE_LABELS[t]} />
                ))}
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Romantic (non-family)" open={openSections.romantic} onToggle={() => toggle('romantic')}>
              <div className="grid grid-cols-2 gap-2">
                {(['ex_partner'] as DeclarativeRelationshipType[]).map(t => (
                  <TypeOption key={t} value={t} active={type === t} onClick={() => setType(t)} label={TYPE_LABELS[t]} />
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-2 italic">Current partners and ex-spouses go under Direct family → Partner (set an Until date to mark as ex).</p>
            </CollapsibleSection>

            <CollapsibleSection title="Friends & neighbours" open={openSections.friends} onToggle={() => toggle('friends')}>
              <div className="grid grid-cols-2 gap-2">
                {(['friend', 'close_friend', 'best_friend', 'acquaintance', 'neighbour'] as DeclarativeRelationshipType[]).map(t => (
                  <TypeOption key={t} value={t} active={type === t} onClick={() => setType(t)} label={TYPE_LABELS[t]} />
                ))}
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Work & school" open={openSections.work} onToggle={() => toggle('work')}>
              <div className="grid grid-cols-2 gap-2">
                {(['colleague', 'ex_colleague', 'classmate', 'teammate', 'roommate', 'manager', 'mentor', 'mentee', 'client'] as DeclarativeRelationshipType[]).map(t => (
                  <TypeOption key={t} value={t} active={type === t} onClick={() => setType(t)} label={TYPE_LABELS[t]} />
                ))}
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Something else" open={openSections.other} onToggle={() => toggle('other')}>
              <div className="grid grid-cols-2 gap-2">
                <TypeOption value="other" active={type === 'other'} onClick={() => setType('other')} label={TYPE_LABELS.other} />
              </div>
              {type === 'other' && (
                <input
                  type="text"
                  value={customLabel}
                  onChange={e => setCustomLabel(e.target.value)}
                  placeholder="e.g. godparent, foster sibling, bandmate…"
                  className="mt-2 w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                />
              )}
            </CollapsibleSection>
          </div>

          {/* Other-person picker */}
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">The other person</label>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search or type a new name…"
              className="mt-1.5 w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
            <div className="mt-2 max-h-44 overflow-auto flex flex-col gap-1 border border-border rounded-lg p-1">
              {filteredPersons.length === 0 && !showCreateButton && (
                <p className="text-xs text-muted-foreground text-center py-3">Type a name to search or add someone new.</p>
              )}
              {filteredPersons.map(p => (
                <button
                  key={p.id}
                  onClick={() => setToPersonId(p.id)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm transition-colors ${
                    p.id === toPersonId ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-accent'
                  }`}
                >
                  <Users className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
              {showCreateButton && (
                <button
                  onClick={handleCreateNewPerson}
                  className="flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm hover:bg-primary/10 text-primary font-medium border-t border-border mt-1 pt-2"
                >
                  <UserPlus className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">Add "{trimmedQuery}" as a new person</span>
                </button>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 italic">
              New people here are added to People Manager too. You can assign photos later if any turn up.
            </p>
          </div>

          {/* Half-sibling: optionally name the shared parent. Completely
              optional — half-sibling is stored as a direct fact either way. */}
          {type === 'half_sibling' && toPersonId && potentialSharedParents.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Which parent is shared? <span className="font-normal italic">(optional)</span>
              </label>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                {potentialSharedParents.map(p => (
                  <button
                    key={p.personId}
                    onClick={() => setSharedParentId(sharedParentId === p.personId ? null : p.personId)}
                    className={`px-3 py-1.5 rounded-lg border text-sm text-left transition-colors ${
                      p.personId === sharedParentId ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">Tap to toggle. Leave unset if you don't know or don't have the photo yet — the sibling link is still stored.</p>
            </div>
          )}

          {/* Flags for parent/child relationships */}
          {(type === 'parent' || type === 'child') && (
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Type of parenthood</label>
              <div className="flex flex-wrap gap-3 mt-1.5 text-sm">
                <FlagCheckbox label="Biological" checked={flags.biological && !flags.step && !flags.adopted} onChange={() => setFlags({ biological: true, step: false, adopted: false, in_law: false })} />
                <FlagCheckbox label="Step" checked={flags.step} onChange={() => setFlags({ biological: false, step: true, adopted: false, in_law: false })} />
                <FlagCheckbox label="Adopted" checked={flags.adopted} onChange={() => setFlags({ biological: false, step: false, adopted: true, in_law: false })} />
                <FlagCheckbox label="In-law" checked={flags.in_law} onChange={() => setFlags({ biological: false, step: false, adopted: false, in_law: true })} />
              </div>
            </div>
          )}

          {/* Dates for partner */}
          {type === 'partner' && (
            <div className="grid grid-cols-2 gap-3">
              <DateTripleInput
                label="Since (optional)"
                value={sinceDate}
                onChange={setSinceDate}
              />
              <DateTripleInput
                label="Until (optional)"
                value={untilDate}
                onChange={setUntilDate}
                hint="Set to mark as ex-partner / deceased."
              />
            </div>
          )}

          {/* Inline explainer for skip-generation types — placeholders fill gaps silently. */}
          {(type === 'grandparent' || type === 'grandchild' || type === 'aunt_uncle' || type === 'niece_nephew' || type === 'cousin') && (
            <div className="flex items-start gap-2 px-3 py-2 bg-muted/50 rounded-lg text-xs text-muted-foreground">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Missing intermediates? PDR creates a faint "?" placeholder in the tree. Click it later to name the person or merge into someone you've already verified.
              </span>
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-600">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-background border-t border-border px-4 py-3 flex items-center gap-2">
          {editingEdge && (
            <button
              onClick={handleRemoveEditing}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-50"
              title="Delete just this one relationship"
            >
              <Trash2 className="w-4 h-4" />
              Remove this
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm hover:bg-accent">Cancel</button>
          <button
            onClick={handleSave}
            disabled={busy || !toPersonId}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 hover:bg-primary/90"
          >
            {editingEdge && <Pencil className="w-3.5 h-3.5" />}
            {busy ? 'Saving…' : editingEdge ? 'Update relationship' : 'Save relationship'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── helpers ─────────────────────────────

const TYPE_VERBS: Record<DeclarativeRelationshipType, string> = {
  parent: 'is parent of',
  child: 'is child of',
  partner: 'is partner of',
  sibling: 'is sibling of',
  half_sibling: 'is half-sibling of',
  adopted_sibling: 'is adopted sibling of',
  grandparent: 'is grandparent of',
  grandchild: 'is grandchild of',
  aunt_uncle: 'is aunt or uncle of',
  niece_nephew: 'is niece or nephew of',
  cousin: 'is cousin of',
  ex_partner: 'is ex-partner of',
  friend: 'is a friend of',
  close_friend: 'is a close friend of',
  best_friend: 'is best friend of',
  acquaintance: 'is an acquaintance of',
  neighbour: 'is a neighbour of',
  colleague: 'is a colleague of',
  ex_colleague: 'is a former colleague of',
  classmate: 'is a classmate of',
  teammate: 'is a teammate of',
  roommate: 'is a roommate of',
  manager: 'is manager of',
  mentor: 'is a mentor of',
  mentee: 'is a mentee of',
  client: 'is a client of',
  other: 'is connected to',
};

// Direction-sensitive labels spell out "…of" so the button's meaning
// matches the preview sentence below: "Nee is [Parent of…] <other>" vs
// "Nee is [Child of…] <other>". Symmetric types (Sibling, Partner,
// Cousin, Half-sibling) stay un-suffixed.
const TYPE_LABELS: Record<DeclarativeRelationshipType, string> = {
  parent: 'Parent of…',
  child: 'Child of…',
  partner: 'Partner / spouse',
  sibling: 'Sibling',
  half_sibling: 'Half-sibling',
  adopted_sibling: 'Adopted sibling',
  grandparent: 'Grandparent of…',
  grandchild: 'Grandchild of…',
  aunt_uncle: 'Aunt / uncle of…',
  niece_nephew: 'Niece / nephew of…',
  cousin: 'Cousin',
  ex_partner: 'Ex-partner',
  friend: 'Friend',
  close_friend: 'Close friend',
  best_friend: 'Best friend',
  acquaintance: 'Acquaintance',
  neighbour: 'Neighbour',
  colleague: 'Colleague',
  ex_colleague: 'Ex-colleague',
  classmate: 'Classmate',
  teammate: 'Teammate',
  roommate: 'Roommate',
  manager: 'Manager',
  mentor: 'Mentor',
  mentee: 'Mentee',
  client: 'Client',
  other: 'Other / custom…',
};

/** Map a stored edge back to the declarative type the UI would show for it,
 *  given which side of the edge the current "from" person is on. */
function storedToDeclarative(edge: FamilyGraphEdge, fromId: number): DeclarativeRelationshipType | null {
  if (edge.type === 'spouse_of') return 'partner';
  if (edge.type === 'sibling_of') {
    if ((edge.flags as any)?.adopted) return 'adopted_sibling';
    if ((edge.flags as any)?.half) return 'half_sibling';
    return 'sibling';
  }
  if (edge.type === 'parent_of') {
    // aId is the parent, bId the child. If fromId is the aId side, fromId
    // is the parent of toId → declarative 'parent'. Otherwise 'child'.
    return edge.aId === fromId ? 'parent' : 'child';
  }
  if (edge.type === 'associated_with') {
    const kind = (edge.flags as any)?.kind as string | undefined;
    const ended = (edge.flags as any)?.ended as boolean | undefined;
    switch (kind) {
      case 'friend': return 'friend';
      case 'close_friend': return 'close_friend';
      case 'best_friend': return 'best_friend';
      case 'acquaintance': return 'acquaintance';
      case 'neighbour': return 'neighbour';
      case 'colleague': return ended ? 'ex_colleague' : 'colleague';
      case 'classmate': return 'classmate';
      case 'teammate': return 'teammate';
      case 'roommate': return 'roommate';
      case 'manager': return 'manager';
      case 'mentor': return 'mentor';
      case 'mentee': return 'mentee';
      case 'client': return 'client';
      case 'ex_partner': return 'ex_partner';
      default: return 'other';
    }
  }
  return null;
}

/** Map a declarative type to the stored relationship type it decomposes to. */
function declarativeToStoredType(type: DeclarativeRelationshipType): 'parent_of' | 'spouse_of' | 'sibling_of' | 'associated_with' | null {
  if (type === 'parent' || type === 'child') return 'parent_of';
  if (type === 'partner') return 'spouse_of';
  if (type === 'sibling' || type === 'half_sibling' || type === 'adopted_sibling') return 'sibling_of';
  // Derived types (grandparent, aunt_uncle, cousin, etc.) expand into multiple
  // parent_of edges and can't be patched in place.
  if (type === 'grandparent' || type === 'grandchild' || type === 'aunt_uncle' || type === 'niece_nephew' || type === 'cousin') return null;
  // Non-family all map to associated_with.
  return 'associated_with';
}

/** Map a declarative non-family type to its canonical association kind. */
function declarativeToAssociationKind(type: DeclarativeRelationshipType): string | null {
  switch (type) {
    case 'friend': case 'close_friend': case 'best_friend':
    case 'acquaintance': case 'neighbour':
    case 'colleague': case 'classmate': case 'teammate': case 'roommate':
    case 'manager': case 'mentor': case 'mentee': case 'client':
      return type;
    case 'ex_colleague': return 'colleague';
    case 'ex_partner': return 'ex_partner';
    case 'other': return 'other';
    default: return null;
  }
}

/** Which collapsible section does a declarative type belong to? Direct-family
 *  types return null (they're always visible and don't need opening). */
function sectionForType(type: DeclarativeRelationshipType): 'blended' | 'extended' | 'romantic' | 'friends' | 'work' | 'other' | null {
  if (type === 'parent' || type === 'child' || type === 'partner' || type === 'sibling') return null;
  if (type === 'half_sibling' || type === 'adopted_sibling') return 'blended';
  if (type === 'grandparent' || type === 'grandchild' || type === 'aunt_uncle' || type === 'niece_nephew' || type === 'cousin') return 'extended';
  if (type === 'ex_partner') return 'romantic';
  if (type === 'friend' || type === 'close_friend' || type === 'best_friend' || type === 'acquaintance' || type === 'neighbour') return 'friends';
  if (type === 'colleague' || type === 'ex_colleague' || type === 'classmate' || type === 'teammate' || type === 'roommate' || type === 'manager' || type === 'mentor' || type === 'mentee' || type === 'client') return 'work';
  return 'other';
}

function CollapsibleSection({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {title}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

function TypeOption({ value, active, onClick, label }: { value: string; active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg border text-sm text-left transition-colors ${
        active ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'
      }`}
    >
      {label}
    </button>
  );
}

function FlagCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="radio" checked={checked} onChange={onChange} className="accent-primary" />
      <span>{label}</span>
    </label>
  );
}

/**
 * Decompose a high-level relationship assertion into one-or-more
 * primitive parent_of / spouse_of edges and persist them. Returns
 * { error } with a human-readable message if a required precondition
 * is missing (e.g. trying to mark a grandparent when the intermediate
 * parent doesn't exist yet).
 */
async function performDeclarativeCreate(
  type: DeclarativeRelationshipType,
  fromId: number,
  toId: number,
  graph: FamilyGraph | null,
  extra: { flags?: any; sinceDate?: string; untilDate?: string; sharedParentId?: number | null; customLabel?: string }
): Promise<{ error?: string }> {
  /** Helper: store an associated_with edge with a given kind + optional ended flag. */
  const storeAssociation = async (kind: string, ended = false, label?: string) => {
    const flags: any = { kind };
    if (ended) flags.ended = true;
    if (label) flags.label = label;
    const r = await addRelationship({ personAId: fromId, personBId: toId, type: 'associated_with', flags });
    return r.success ? {} : { error: r.error ?? 'Could not save.' };
  };
  const parentsOf = (pid: number): number[] => {
    if (!graph) return [];
    return graph.edges
      .filter(e => e.type === 'parent_of' && e.bId === pid && !e.derived)
      .map(e => e.aId);
  };

  switch (type) {
    case 'parent': {
      const r = await addRelationship({ personAId: fromId, personBId: toId, type: 'parent_of', flags: extra.flags });
      return r.success ? {} : { error: r.error ?? 'Could not save.' };
    }
    case 'child': {
      const r = await addRelationship({ personAId: toId, personBId: fromId, type: 'parent_of', flags: extra.flags });
      return r.success ? {} : { error: r.error ?? 'Could not save.' };
    }
    case 'partner': {
      const r = await addRelationship({
        personAId: fromId, personBId: toId, type: 'spouse_of',
        since: extra.sinceDate ?? null, until: extra.untilDate ?? null,
      });
      return r.success ? {} : { error: r.error ?? 'Could not save.' };
    }
    case 'sibling':
    case 'adopted_sibling': {
      // Goal: after this runs, both siblings share exactly TWO parents
      // (the biological family-tree default). Missing slots get filled
      // with placeholder "?" ghosts the user can name later. Extras the
      // user had already stay; user can remove any that don't fit.
      //
      // Strategy:
      //   1. Cross-inherit: each sibling picks up the other's parents,
      //      so both end up with the union of parent sets.
      //   2. Count unique parents in that union. Create placeholder
      //      ghosts (0, 1, or 2) to bring the shared count to 2.
      const flags = type === 'adopted_sibling' ? { adopted: true } : undefined;
      const fromParents = parentsOf(fromId);
      const toParents = parentsOf(toId);

      // Step 1 — cross-inherit.
      for (const pid of toParents) {
        if (!fromParents.includes(pid)) {
          await addRelationship({ personAId: pid, personBId: fromId, type: 'parent_of', flags });
        }
      }
      for (const pid of fromParents) {
        if (!toParents.includes(pid)) {
          await addRelationship({ personAId: pid, personBId: toId, type: 'parent_of', flags });
        }
      }

      // Step 2 — top up to 2 parents with ghosts.
      const sharedParents = new Set<number>([...fromParents, ...toParents]);
      const missing = Math.max(0, 2 - sharedParents.size);
      for (let i = 0; i < missing; i++) {
        const ph = await createPlaceholderPerson();
        if (!ph.success || ph.data == null) return { error: ph.error ?? 'Could not create placeholder.' };
        await addRelationship({ personAId: ph.data, personBId: fromId, type: 'parent_of', flags });
        await addRelationship({ personAId: ph.data, personBId: toId, type: 'parent_of', flags });
      }
      return {};
    }
    case 'half_sibling': {
      // If the user picked a shared parent, also create the parent_of
      // edge so the shared-parent relationship is recorded. Otherwise
      // just store the half-sibling fact on its own.
      const r = await addRelationship({ personAId: fromId, personBId: toId, type: 'sibling_of', flags: { half: true } });
      if (!r.success) return { error: r.error ?? 'Could not save.' };
      if (extra.sharedParentId) {
        await addRelationship({ personAId: extra.sharedParentId, personBId: fromId, type: 'parent_of' });
        await addRelationship({ personAId: extra.sharedParentId, personBId: toId, type: 'parent_of' });
      }
      return {};
    }
    case 'grandparent': {
      // fromId is grandparent of toId. Need ≥1 parent of toId to anchor to.
      // If none exist, create a placeholder parent automatically.
      let parents = parentsOf(toId);
      if (parents.length === 0) {
        const ph = await createPlaceholderPerson();
        if (!ph.success || ph.data == null) return { error: ph.error ?? 'Could not create placeholder.' };
        await addRelationship({ personAId: ph.data, personBId: toId, type: 'parent_of' });
        parents = [ph.data];
      }
      // Link the new grandparent above every known parent of toId.
      for (const pid of parents) {
        await addRelationship({ personAId: fromId, personBId: pid, type: 'parent_of' });
      }
      return {};
    }
    case 'grandchild': {
      // toId is grandchild of fromId. Need ≥1 parent of toId to anchor.
      let parents = parentsOf(toId);
      if (parents.length === 0) {
        const ph = await createPlaceholderPerson();
        if (!ph.success || ph.data == null) return { error: ph.error ?? 'Could not create placeholder.' };
        await addRelationship({ personAId: ph.data, personBId: toId, type: 'parent_of' });
        parents = [ph.data];
      }
      for (const pid of parents) {
        await addRelationship({ personAId: fromId, personBId: pid, type: 'parent_of' });
      }
      return {};
    }
    case 'aunt_uncle': {
      // fromId is aunt/uncle of toId. Need toId → parent → grandparent chain.
      let parents = parentsOf(toId);
      if (parents.length === 0) {
        const ph = await createPlaceholderPerson();
        if (!ph.success || ph.data == null) return { error: ph.error ?? 'Could not create placeholder.' };
        await addRelationship({ personAId: ph.data, personBId: toId, type: 'parent_of' });
        parents = [ph.data];
      }
      const targetParent = parents[0];
      let grandparents = parentsOf(targetParent);
      if (grandparents.length === 0) {
        const gph = await createPlaceholderPerson();
        if (!gph.success || gph.data == null) return { error: gph.error ?? 'Could not create placeholder.' };
        await addRelationship({ personAId: gph.data, personBId: targetParent, type: 'parent_of' });
        grandparents = [gph.data];
      }
      // fromId becomes the child of those grandparents → sibling of targetParent → aunt/uncle of toId.
      for (const gp of grandparents) {
        await addRelationship({ personAId: gp, personBId: fromId, type: 'parent_of' });
      }
      return {};
    }
    case 'niece_nephew': {
      // fromId is niece/nephew of toId. Mirror of aunt_uncle from fromId's side.
      let parents = parentsOf(fromId);
      if (parents.length === 0) {
        const ph = await createPlaceholderPerson();
        if (!ph.success || ph.data == null) return { error: ph.error ?? 'Could not create placeholder.' };
        await addRelationship({ personAId: ph.data, personBId: fromId, type: 'parent_of' });
        parents = [ph.data];
      }
      const targetParent = parents[0];
      let grandparents = parentsOf(targetParent);
      if (grandparents.length === 0) {
        const gph = await createPlaceholderPerson();
        if (!gph.success || gph.data == null) return { error: gph.error ?? 'Could not create placeholder.' };
        await addRelationship({ personAId: gph.data, personBId: targetParent, type: 'parent_of' });
        grandparents = [gph.data];
      }
      for (const gp of grandparents) {
        await addRelationship({ personAId: gp, personBId: toId, type: 'parent_of' });
      }
      return {};
    }
    case 'cousin': {
      // fromId and toId are cousins: their parents are siblings.
      // Ensure each has a parent; ensure those parents share a grandparent.
      let aParents = parentsOf(fromId);
      let bParents = parentsOf(toId);
      if (aParents.length === 0) {
        const ph = await createPlaceholderPerson();
        if (!ph.success || ph.data == null) return { error: ph.error ?? 'Could not create placeholder.' };
        await addRelationship({ personAId: ph.data, personBId: fromId, type: 'parent_of' });
        aParents = [ph.data];
      }
      if (bParents.length === 0) {
        const ph = await createPlaceholderPerson();
        if (!ph.success || ph.data == null) return { error: ph.error ?? 'Could not create placeholder.' };
        await addRelationship({ personAId: ph.data, personBId: toId, type: 'parent_of' });
        bParents = [ph.data];
      }
      let aPP = parentsOf(aParents[0]);
      if (aPP.length === 0) {
        const gph = await createPlaceholderPerson();
        if (!gph.success || gph.data == null) return { error: gph.error ?? 'Could not create placeholder.' };
        await addRelationship({ personAId: gph.data, personBId: aParents[0], type: 'parent_of' });
        aPP = [gph.data];
      }
      // Hook the OTHER parent (bParents[0]) up as child of those grandparents,
      // making the two parent nodes siblings → the two people cousins.
      for (const gp of aPP) {
        await addRelationship({ personAId: gp, personBId: bParents[0], type: 'parent_of' });
      }
      return {};
    }

    // ─── Non-family associations ───────────────────────────────
    case 'ex_partner':      return storeAssociation('ex_partner', true);
    case 'friend':          return storeAssociation('friend');
    case 'close_friend':    return storeAssociation('close_friend');
    case 'best_friend':     return storeAssociation('best_friend');
    case 'acquaintance':    return storeAssociation('acquaintance');
    case 'neighbour':       return storeAssociation('neighbour');
    case 'colleague':       return storeAssociation('colleague');
    case 'ex_colleague':    return storeAssociation('colleague', true);
    case 'classmate':       return storeAssociation('classmate');
    case 'teammate':        return storeAssociation('teammate');
    case 'roommate':        return storeAssociation('roommate');
    case 'manager':         return storeAssociation('manager');
    case 'mentor':          return storeAssociation('mentor');
    case 'mentee':          return storeAssociation('mentee');
    case 'client':          return storeAssociation('client');
    case 'other': {
      if (!extra.customLabel) return { error: 'Type a label for this relationship (e.g. godparent, bandmate).' };
      return storeAssociation('other', false, extra.customLabel);
    }
  }
}
