import type { FamilyGraphEdge } from './electron-bridge';

/** Derived relationship label from the focus person to every other
 *  person reachable in the graph.
 *
 *  Works by walking a BFS from the focus, recording the sequence of
 *  edge types traversed to reach each person AND the person each step
 *  lands on. Common sequences are mapped to human-readable labels —
 *  gendered (Mother/Brother/…) when the target person's gender is
 *  known AND the tree has gendered labels enabled, or neutral
 *  (Parent/Sibling/…) otherwise.
 *
 *  Some compound labels (e.g. "Sister-in-law's mother") depend on an
 *  INTERMEDIATE person's gender, not just the target's. Those are
 *  represented as functions that receive the full path-with-ids and
 *  synthesise the label with the relevant genders resolved.
 *
 *  Labels for distant/unmapped paths fall back to generic "Great-…"
 *  chains, "Distant in-law" (spouse step anywhere) or "Distant
 *  relative" so every non-focus node still gets something meaningful.
 */
export type RelStep = 'parent_up' | 'parent_down' | 'spouse' | 'sibling';

/** One step in a BFS path — the edge type taken AND the person it
 *  reached. Intermediate-gender labels read landed-on-ids to pick the
 *  right gendered form. */
interface PathItem { step: RelStep; toId: number; }

type SimpleLabel = { neutral: string; male?: string; female?: string; };
type LabelFn = (path: PathItem[], genderByPerson: Map<number, string | null> | undefined, gendered: boolean) => string;

type LabelEntry = SimpleLabel | LabelFn;

/** Pick brother-in-law / sister-in-law / sibling-in-law based on a
 *  person's gender. Shared helper for the compound-label functions. */
function siblingInLawFor(gender: string | null | undefined): string {
  if (gender === 'male')   return 'Brother-in-law';
  if (gender === 'female') return 'Sister-in-law';
  return 'Sibling-in-law';
}
/** Pick father / mother / parent based on a target's gender. */
function parentFor(gender: string | null | undefined): string {
  if (gender === 'male')   return 'father';
  if (gender === 'female') return 'mother';
  return 'parent';
}

const LABELS: Record<string, LabelEntry> = {
  'spouse':             { neutral: 'Partner', male: 'Husband', female: 'Wife' },
  'parent_up':          { neutral: 'Parent', male: 'Father', female: 'Mother' },
  'parent_down':        { neutral: 'Child', male: 'Son', female: 'Daughter' },
  'sibling':            { neutral: 'Sibling', male: 'Brother', female: 'Sister' },

  'parent_up,parent_up':    { neutral: 'Grandparent', male: 'Grandfather', female: 'Grandmother' },
  'parent_down,parent_down': { neutral: 'Grandchild', male: 'Grandson', female: 'Granddaughter' },

  'parent_up,sibling':      { neutral: 'Aunt / Uncle', male: 'Uncle', female: 'Aunt' },
  'sibling,parent_down':    { neutral: 'Niece / Nephew', male: 'Nephew', female: 'Niece' },
  // NOTE: cousin-family labels (1st cousin, 2nd cousin, Nth cousin M
  // times removed, …) are handled generically in `cousinLabel` below
  // so we don't have to enumerate the whole matrix.

  'spouse,parent_up':       { neutral: 'Parent-in-law', male: 'Father-in-law', female: 'Mother-in-law' },
  'parent_up,spouse':       { neutral: 'Step-parent', male: 'Stepfather', female: 'Stepmother' },
  'spouse,parent_down':     { neutral: 'Step-child', male: 'Stepson', female: 'Stepdaughter' },
  'parent_down,spouse':     { neutral: 'Son / Daughter-in-law', male: 'Son-in-law', female: 'Daughter-in-law' },
  'spouse,sibling':         { neutral: 'Sibling-in-law', male: 'Brother-in-law', female: 'Sister-in-law' },
  'sibling,spouse':         { neutral: 'Sibling-in-law', male: 'Brother-in-law', female: 'Sister-in-law' },
  // Your spouse's sibling's spouse — English collapses this to
  // "sibling-in-law" too (the word covers all three patterns: sibling's
  // spouse, spouse's sibling, and spouse's sibling's spouse).
  'spouse,sibling,spouse':  { neutral: 'Sibling-in-law', male: 'Brother-in-law', female: 'Sister-in-law' },
  // Your spouse's parent's sibling — no strict English term, but
  // "Aunt / Uncle-in-law" is the conventional informal rendering. Used
  // for e.g. Lindsay → Colin → Alan → Trisha.
  'spouse,parent_up,sibling': { neutral: 'Aunt / Uncle-in-law', male: 'Uncle-in-law', female: 'Aunt-in-law' },
  // Your spouse's sibling's child — niece / nephew through marriage.
  // Common English doesn't distinguish — it's just niece/nephew.
  'spouse,sibling,parent_down': { neutral: 'Niece / Nephew', male: 'Nephew', female: 'Niece' },
  // Your sibling's child's spouse — your niece / nephew's partner.
  'sibling,parent_down,spouse': { neutral: 'Niece / Nephew-in-law', male: 'Nephew-in-law', female: 'Niece-in-law' },
  // Your sibling's spouse's parent — e.g. your brother's wife's
  // mother. The sibling-in-law's gender (the intermediate person at
  // step 1) determines Brother/Sister; the target's gender at step 2
  // determines father/mother. Function form because both genders
  // matter, not just the target's.
  'sibling,spouse,parent_up': (path, genderByPerson, gendered) => {
    if (!gendered || !genderByPerson) return "Sibling-in-law's parent";
    const inLawGender = genderByPerson.get(path[1]?.toId ?? -1);
    const targetGender = genderByPerson.get(path[2]?.toId ?? -1);
    return `${siblingInLawFor(inLawGender)}'s ${parentFor(targetGender)}`;
  },
  // Two people who share a child but have no stored spouse_of edge.
  'parent_down,parent_up':  { neutral: 'Co-parent' },

  'parent_up,parent_up,parent_up': { neutral: 'Great-grandparent', male: 'Great-grandfather', female: 'Great-grandmother' },
  'parent_down,parent_down,parent_down': { neutral: 'Great-grandchild', male: 'Great-grandson', female: 'Great-granddaughter' },
  'parent_up,parent_up,sibling': { neutral: 'Great aunt / uncle', male: 'Great uncle', female: 'Great aunt' },
  'sibling,parent_down,parent_down': { neutral: 'Great niece / nephew', male: 'Great nephew', female: 'Great niece' },

  'parent_up,parent_up,parent_up,parent_up': { neutral: 'Great-great-grandparent', male: 'Great-great-grandfather', female: 'Great-great-grandmother' },
  'parent_down,parent_down,parent_down,parent_down': { neutral: 'Great-great-grandchild', male: 'Great-great-grandson', female: 'Great-great-granddaughter' },
};

/** English ordinal for small N; falls back to Nth for 8+. */
const ORDINAL: Record<number, string> = {
  1: 'First', 2: 'Second', 3: 'Third', 4: 'Fourth',
  5: 'Fifth', 6: 'Sixth', 7: 'Seventh',
};
function ordinal(n: number): string {
  return ORDINAL[n] ?? `${n}th`;
}

/** Human-readable "removed" suffix. Anything past five collapses to
 *  "N times removed" — you're deep in genealogy territory by then. */
const REMOVED_LABEL: Record<number, string> = {
  0: '',
  1: ' once removed',
  2: ' twice removed',
  3: ' three times removed',
  4: ' four times removed',
  5: ' five times removed',
};
function removedSuffix(n: number): string {
  return REMOVED_LABEL[n] ?? ` ${n} times removed`;
}

/** Detect the cousin pattern — a path of the form
 *    [parent_up × a, sibling, parent_down × b]
 *  Returns e.g. "First cousin", "Second cousin once removed", or null. */
function cousinLabel(steps: RelStep[]): string | null {
  if (steps.length < 3) return null;
  let a = 0;
  while (a < steps.length && steps[a] === 'parent_up') a++;
  if (a === 0) return null;
  if (steps[a] !== 'sibling') return null;
  let b = 0;
  for (let i = a + 1; i < steps.length; i++) {
    if (steps[i] !== 'parent_down') return null;
    b++;
  }
  if (b === 0) return null;
  const degree = Math.min(a, b);
  const removed = Math.abs(a - b);
  return `${ordinal(degree)} cousin${removedSuffix(removed)}`;
}

function resolveSimple(entry: SimpleLabel, gender: string | null | undefined, gendered: boolean): string {
  if (!gendered) return entry.neutral;
  if (gender === 'male' && entry.male) return entry.male;
  if (gender === 'female' && entry.female) return entry.female;
  return entry.neutral;
}

function labelFromPath(
  path: PathItem[],
  genderByPerson: Map<number, string | null> | undefined,
  gendered: boolean,
): string | null {
  if (path.length === 0) return null;
  const steps = path.map(p => p.step);
  const key = steps.join(',');
  const entry = LABELS[key];
  if (entry) {
    if (typeof entry === 'function') return entry(path, genderByPerson, gendered);
    const targetGender = genderByPerson?.get(path[path.length - 1].toId);
    return resolveSimple(entry, targetGender, gendered);
  }

  // Cousin pattern — covers every N-th cousin × M times removed combo
  // generically so we don't have to enumerate the matrix.
  const cousin = cousinLabel(steps);
  if (cousin) return cousin;

  // Generic fall-backs — any all-parent_up or all-parent_down chain of
  // length N gets "Great^(N-2)-grandparent/child". Gendered when
  // possible. Anything else is "Distant in-law" (if the path traverses
  // a spouse step) or "Distant relative" (pure blood, unnamed shape).
  const targetGender = genderByPerson?.get(path[path.length - 1].toId) ?? null;
  if (steps.every(s => s === 'parent_up')) {
    const n = steps.length;
    const prefix = 'Great-'.repeat(n - 2);
    if (gendered && targetGender === 'male')   return `${prefix}grandfather`;
    if (gendered && targetGender === 'female') return `${prefix}grandmother`;
    return `${prefix}grandparent`;
  }
  if (steps.every(s => s === 'parent_down')) {
    const n = steps.length;
    const prefix = 'Great-'.repeat(n - 2);
    if (gendered && targetGender === 'male')   return `${prefix}grandson`;
    if (gendered && targetGender === 'female') return `${prefix}granddaughter`;
    return `${prefix}grandchild`;
  }
  if (steps.includes('spouse')) return 'Distant in-law';
  return 'Distant relative';
}

/** Build a label map: personId → "Mother", "Sibling", …
 *  The focus person is intentionally not included.
 *
 *  @param focusPersonId — anchor person (labels are relative to them)
 *  @param edges         — graph edges (parent_of, spouse_of, sibling_of)
 *  @param allNodeIds    — ids of people the label should be computed for
 *  @param genderByPerson — id → gender string; undefined values treated
 *                          as "unknown" (falls back to neutral labels).
 *                          Intermediate genders along the path are read
 *                          from this map too, so labels like "Sister-in-
 *                          law's mother" can specialise correctly.
 *  @param gendered      — when false, every label is the neutral form
 *                          regardless of the gender lookup.
 */
export function computeRelationshipLabels(
  focusPersonId: number,
  edges: readonly FamilyGraphEdge[],
  allNodeIds: readonly number[],
  genderByPerson?: Map<number, string | null>,
  gendered: boolean = false,
): Map<number, string> {
  const out = new Map<number, string>();
  if (focusPersonId == null) return out;

  const adj = new Map<number, Array<{ to: number; step: RelStep }>>();
  const add = (from: number, to: number, step: RelStep) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push({ to, step });
  };
  for (const e of edges) {
    if (e.type === 'parent_of') {
      add(e.aId, e.bId, 'parent_down');
      add(e.bId, e.aId, 'parent_up');
    } else if (e.type === 'spouse_of') {
      add(e.aId, e.bId, 'spouse');
      add(e.bId, e.aId, 'spouse');
    } else if (e.type === 'sibling_of') {
      add(e.aId, e.bId, 'sibling');
      add(e.bId, e.aId, 'sibling');
    }
  }

  type QueueItem = { id: number; path: PathItem[] };
  const visited = new Set<number>([focusPersonId]);
  const queue: QueueItem[] = [{ id: focusPersonId, path: [] }];
  while (queue.length > 0) {
    const { id, path } = queue.shift()!;
    if (id !== focusPersonId) {
      const label = labelFromPath(path, genderByPerson, gendered);
      if (label && !out.has(id)) out.set(id, label);
    }
    const neighbours = adj.get(id);
    if (!neighbours) continue;
    for (const { to, step } of neighbours) {
      if (visited.has(to)) continue;
      visited.add(to);
      queue.push({ id: to, path: [...path, { step, toId: to }] });
    }
  }

  return out;
}
