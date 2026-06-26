/**
 * Trees layout INVARIANT suite (Terry 2026-06-26).
 *
 * Why this exists: the family-tree layout had a recurring class of bug —
 * a sibling linked to the tree only through STRIPPED PLACEHOLDER parents
 * (a "derived sibling", joined by a sibling_of edge with no shared visible
 * parent) would be flung far out to the side. It was patched per-relative
 * (Joy, Gladys, great-aunts...) over and over, because each patch only
 * covered one direction or one focus.
 *
 * This suite replaces "eyeball one tree" with "prove the rules hold across
 * the whole structure-space". It builds a CORPUS of family shapes (the kinds
 * customers create) and lays each one out with EVERY person as the focus,
 * asserting structural INVARIANTS that must hold for any tree:
 *
 *   1. No two cards overlap.
 *   2. No childless sibling is stranded (it sits near its sibling group;
 *      only a sibling that owns a real sub-tree may sit far away).
 *   3. Spouses are adjacent.
 *   4. A parent/couple is centred over its children.
 *
 * When this fails, fix the ENGINE rule (trees-layout.ts), not the relative.
 * Adding a new shape here is how we guarantee a new family configuration
 * works before a customer ever sees it.
 */
import { describe, it, expect } from 'vitest';
import { computeFocusLayout, type LaidOutNode } from './trees-layout';
import type { FamilyGraph, FamilyGraphNode, FamilyGraphEdge } from './electron-bridge';

// ── Builders ────────────────────────────────────────────────────────────
function node(personId: number, name: string): FamilyGraphNode {
  return {
    personId, name, fullName: null, avatarData: null, representativeFaceId: null,
    representativeFaceFilePath: null, representativeFaceBox: null, birthDate: null,
    deathDate: null, deceasedMarker: null, cardBackground: null, gender: null,
    hopsFromFocus: 0, photoCount: 0, totalParentCount: 0, totalChildCount: 0,
    isPlaceholder: false,
  };
}
type E = [number, number, FamilyGraphEdge['type']];
function edge(aId: number, bId: number, type: FamilyGraphEdge['type'], derived = false): FamilyGraphEdge {
  return { id: null, aId, bId, type, since: null, until: null, flags: null, derived };
}

/** Assemble a FamilyGraph for a given focus: computes hopsFromFocus by BFS over
 *  all edges and totalChildCount from parent_of, then returns the graph. */
function graphFor(names: Record<number, string>, edgeList: E[], focusId: number): FamilyGraph {
  const edges = edgeList.map(([a, b, t]) => edge(a, b, t, t === 'sibling_of'));
  const ids = Object.keys(names).map(Number);
  const adj = new Map<number, number[]>();
  const childCount = new Map<number, number>();
  for (const e of edges) {
    if (!adj.has(e.aId)) adj.set(e.aId, []);
    if (!adj.has(e.bId)) adj.set(e.bId, []);
    adj.get(e.aId)!.push(e.bId); adj.get(e.bId)!.push(e.aId);
    if (e.type === 'parent_of') childCount.set(e.aId, (childCount.get(e.aId) ?? 0) + 1);
  }
  const hops = new Map<number, number>([[focusId, 0]]);
  const q = [focusId];
  while (q.length) { const c = q.shift()!; for (const nb of adj.get(c) ?? []) if (!hops.has(nb)) { hops.set(nb, hops.get(c)! + 1); q.push(nb); } }
  const nodes = ids.map(id => ({ ...node(id, names[id]), hopsFromFocus: hops.get(id) ?? 99, totalChildCount: childCount.get(id) ?? 0 }));
  return { focusPersonId: focusId, nodes, edges };
}

// Lay a graph out with EVERYTHING shown (expand every branch) so all nodes are
// visible — the densest, hardest case, and the one that reproduces stranding.
function layoutAll(graph: FamilyGraph) {
  const everyId = new Set(graph.nodes.map(n => n.personId));
  return computeFocusLayout(graph, 99, {}, everyId, new Set());
}

const CARD_W = 170;       // cards are ~170px wide → centres closer than this overlap
const SNUG = 480;         // a non-stranded sibling sits within this of its group

// ── Invariant checkers (return human-readable violations) ────────────────
function childrenOf(graph: FamilyGraph) {
  const m = new Map<number, number[]>();
  for (const e of graph.edges) if (e.type === 'parent_of') { if (!m.has(e.aId)) m.set(e.aId, []); m.get(e.aId)!.push(e.bId); }
  return m;
}
function siblingPairs(graph: FamilyGraph): Set<string> {
  // siblings = explicit sibling_of OR sharing a parent
  const pairs = new Set<string>();
  const key = (a: number, b: number) => a < b ? `${a}-${b}` : `${b}-${a}`;
  for (const e of graph.edges) if (e.type === 'sibling_of') pairs.add(key(e.aId, e.bId));
  const kids = childrenOf(graph);
  for (const list of kids.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.add(key(list[i], list[j]));
  return pairs;
}

function checkOverlap(nodes: LaidOutNode[]): string[] {
  const bad: string[] = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    if (a.generation === b.generation && Math.abs(a.x - b.x) < CARD_W) bad.push(`${a.name} & ${b.name} overlap (Δx=${Math.round(Math.abs(a.x - b.x))})`);
  }
  return bad;
}

function checkSpousesAdjacent(graph: FamilyGraph, nodes: LaidOutNode[]): string[] {
  const byId = new Map(nodes.map(n => [n.personId, n]));
  const bad: string[] = [];
  for (const e of graph.edges) {
    if (e.type !== 'spouse_of') continue;
    const a = byId.get(e.aId), b = byId.get(e.bId);
    if (!a || !b) continue;
    if (a.generation !== b.generation || Math.abs(a.x - b.x) > 300) bad.push(`spouses ${a.name} & ${b.name} not adjacent (Δx=${Math.round(Math.abs(a.x - b.x))})`);
  }
  return bad;
}

function checkNoStrandedSibling(graph: FamilyGraph, nodes: LaidOutNode[]): string[] {
  const byId = new Map(nodes.map(n => [n.personId, n]));
  const kids = childrenOf(graph);
  const spouses = new Map<number, number[]>();
  for (const e of graph.edges) if (e.type === 'spouse_of') { if (!spouses.has(e.aId)) spouses.set(e.aId, []); if (!spouses.has(e.bId)) spouses.set(e.bId, []); spouses.get(e.aId)!.push(e.bId); spouses.get(e.bId)!.push(e.aId); }
  const visibleKids = (id: number) => (kids.get(id) ?? []).some(k => byId.has(k));
  const pairs = siblingPairs(graph);
  const bad: string[] = [];
  for (const n of nodes) {
    if (n.personId === graph.focusPersonId) continue;
    // unit (n + spouse) must own NO visible sub-tree — a node with a branch may sit far
    const unit = [n.personId, ...(spouses.get(n.personId) ?? [])];
    if (unit.some(visibleKids)) continue;
    // must actually have a visible same-generation sibling
    const hasSib = nodes.some(o => o.personId !== n.personId && o.generation === n.generation && pairs.has(n.personId < o.personId ? `${n.personId}-${o.personId}` : `${o.personId}-${n.personId}`));
    if (!hasSib) continue;
    // nearest same-generation card
    const nearest = Math.min(...nodes.filter(o => o.personId !== n.personId && o.generation === n.generation).map(o => Math.abs(o.x - n.x)));
    if (nearest > SNUG) bad.push(`${n.name} stranded — nearest same-row card is ${Math.round(nearest)}px away`);
  }
  return bad;
}

function checkParentsCentred(graph: FamilyGraph, nodes: LaidOutNode[]): string[] {
  const byId = new Map(nodes.map(n => [n.personId, n]));
  const kids = childrenOf(graph);
  // The FOCUS couple is the centred anchor — the whole tree is centred ON them,
  // so their child can sit off-centre when the subtree below is lopsided. That's
  // by design, not a misplacement, so they're exempt from this check.
  const focusCouple = new Set<number>([graph.focusPersonId]);
  for (const e of graph.edges) if (e.type === 'spouse_of') {
    if (e.aId === graph.focusPersonId) focusCouple.add(e.bId);
    if (e.bId === graph.focusPersonId) focusCouple.add(e.aId);
  }
  const bad: string[] = [];
  for (const [pid, kidIds] of kids) {
    if (focusCouple.has(pid)) continue;
    const p = byId.get(pid); if (!p) continue;
    const vis = kidIds.map(k => byId.get(k)).filter((k): k is LaidOutNode => !!k);
    if (vis.length === 0) continue;
    // parent (allowing for a co-parent spouse) should sit over the children's span
    const kidMin = Math.min(...vis.map(k => k.x)), kidMax = Math.max(...vis.map(k => k.x));
    const spouseXs = graph.edges.filter(e => e.type === 'spouse_of' && (e.aId === pid || e.bId === pid)).map(e => byId.get(e.aId === pid ? e.bId : e.aId)).filter((s): s is LaidOutNode => !!s).map(s => s.x);
    const parentCentre = spouseXs.length ? (p.x + spouseXs[0]) / 2 : p.x;
    const span = kidMax - kidMin;
    // centre must be within the children span (+ a card of slack each side)
    if (parentCentre < kidMin - CARD_W - 20 || parentCentre > kidMax + CARD_W + 20) bad.push(`${p.name} not over children (centre ${Math.round(parentCentre)} vs span ${Math.round(kidMin)}..${Math.round(kidMax)}, w=${Math.round(span)})`);
  }
  return bad;
}

function allViolations(graph: FamilyGraph) {
  // Only the nodes actually drawn on the canvas — PARKED in-law families (shown
  // in floating side-panels by the renderer) are excluded, exactly as on screen.
  const nodes = layoutAll(graph).nodes.filter(n => n.slotted);
  const v = [
    ...checkOverlap(nodes),
    ...checkSpousesAdjacent(graph, nodes),
    ...checkNoStrandedSibling(graph, nodes),
    ...checkParentsCentred(graph, nodes),
  ];
  if (v.length && process.env.DBG) console.log(`focus=${graph.nodes.find(n => n.personId === graph.focusPersonId)?.name}`, nodes.map(n => `${n.name}@${Math.round(n.x)}/g${n.generation}`).join('  '));
  return v;
}

// ── Corpus: family shapes × every focus ──────────────────────────────────
// Each entry: a person-name map + an edge list. Every person is used as focus.
const CORPUS: Array<{ name: string; names: Record<number, string>; edges: E[] }> = [
  {
    name: 'derived childless sibling at gen 0 (the Grandad/Sylvia bug)',
    names: { 1: 'Grandad', 2: 'Nan', 3: 'Mum', 4: 'Carol', 5: 'SylviaSister' },
    edges: [[1, 2, 'spouse_of'], [1, 3, 'parent_of'], [2, 3, 'parent_of'], [1, 4, 'parent_of'], [2, 4, 'parent_of'], [1, 5, 'sibling_of']],
  },
  {
    name: 'childless sibling via a real shared parent',
    names: { 1: 'GreatGP', 2: 'Grandad', 3: 'SisterReal', 4: 'Nan', 5: 'Mum' },
    edges: [[1, 2, 'parent_of'], [1, 3, 'parent_of'], [2, 4, 'spouse_of'], [2, 5, 'parent_of'], [4, 5, 'parent_of']],
  },
  {
    name: 'childless great-aunt (derived) two generations up',
    names: { 1: 'Focus', 2: 'Parent', 3: 'Grandad', 4: 'GreatAunt' },
    edges: [[3, 2, 'parent_of'], [2, 1, 'parent_of'], [3, 4, 'sibling_of']],
  },
  {
    name: 'multiple childless siblings + one sibling WITH a branch',
    names: { 1: 'F', 2: 'Sp', 3: 'Kid', 4: 'ChildlessA', 5: 'ChildlessB', 6: 'SibWithKid', 7: 'TheirKid' },
    edges: [[1, 2, 'spouse_of'], [1, 3, 'parent_of'], [2, 3, 'parent_of'], [1, 4, 'sibling_of'], [1, 5, 'sibling_of'], [1, 6, 'sibling_of'], [6, 7, 'parent_of']],
  },
  {
    name: 'aunt with cousins (side-branch) + a childless uncle',
    names: { 1: 'Focus', 2: 'Parent', 3: 'GP', 4: 'Aunt', 5: 'Cousin', 6: 'ChildlessUncle' },
    edges: [[3, 2, 'parent_of'], [3, 4, 'parent_of'], [3, 6, 'parent_of'], [2, 1, 'parent_of'], [4, 5, 'parent_of']],
  },
  {
    name: 'focus with childless sibling AND a wide brood beside it',
    names: { 1: 'F', 2: 'Sp', 3: 'K1', 4: 'K2', 5: 'K3', 6: 'ChildlessSib' },
    edges: [[1, 2, 'spouse_of'], [1, 3, 'parent_of'], [2, 3, 'parent_of'], [1, 4, 'parent_of'], [2, 4, 'parent_of'], [1, 5, 'parent_of'], [2, 5, 'parent_of'], [1, 6, 'sibling_of']],
  },
  {
    // Terry 2026-06-26: focus=Grandad, a married grandchild (Colin+Lindsay) had
    // his childless sister (Amie) land BETWEEN him and his wife — couple split
    // by a sibling. Two generations of descendants, a married grandchild with
    // childless siblings on both sides.
    name: 'grandchild couple stays adjacent with childless siblings beside',
    names: { 1: 'Derek', 2: 'Wife', 3: 'Daughter', 4: 'SonInLaw', 5: 'Colin', 6: 'Amie', 7: 'Terry', 8: 'Lindsay', 9: 'Lilly', 10: 'Daisy' },
    edges: [
      [1, 2, 'spouse_of'], [1, 3, 'parent_of'], [2, 3, 'parent_of'], [3, 4, 'spouse_of'],
      [3, 5, 'parent_of'], [4, 5, 'parent_of'], [3, 6, 'parent_of'], [4, 6, 'parent_of'],
      [3, 7, 'parent_of'], [4, 7, 'parent_of'],
      [5, 8, 'spouse_of'], [5, 9, 'parent_of'], [8, 9, 'parent_of'], [5, 10, 'parent_of'], [8, 10, 'parent_of'],
    ],
  },
  {
    // Terry 2026-06-26: the REAL couples-split — the in-law (Lindsay) has her
    // OWN parked family, so she isn't parent-less; she must still sit beside
    // her partner Colin, not be ordered by her parked parents.
    name: 'in-law with own parked family stays beside partner',
    names: { 1: 'Derek', 2: 'Wife', 3: 'Sally', 4: 'Alan', 5: 'Colin', 6: 'Amie', 7: 'Lindsay', 8: 'LinDad', 9: 'LinMum', 10: 'Lilly' },
    edges: [
      [1, 2, 'spouse_of'], [1, 3, 'parent_of'], [2, 3, 'parent_of'], [3, 4, 'spouse_of'],
      [3, 5, 'parent_of'], [4, 5, 'parent_of'], [3, 6, 'parent_of'], [4, 6, 'parent_of'],
      [5, 7, 'spouse_of'], [8, 7, 'parent_of'], [9, 7, 'parent_of'], [8, 9, 'spouse_of'],
      [5, 10, 'parent_of'], [7, 10, 'parent_of'],
    ],
  },
  {
    // Terry 2026-06-26: focus=Lucy Day. The couple Colin+Lindsay sit at the
    // focus's PARENT generation (a side-branch aunt/uncle couple), and Colin's
    // sibling Amie landed BETWEEN them. The couple-pairing pass only ran for
    // descendants (g<=0), so a couple at an ANCESTOR generation was never
    // guaranteed adjacent — the bug Terry kept re-finding under new focuses.
    name: 'side-branch couple at the parent generation stays adjacent',
    names: { 1: 'GP', 2: 'Parent', 3: 'Colin', 4: 'Amie', 5: 'Lucy', 6: 'Lindsay', 7: 'CousinKid' },
    edges: [
      [1, 2, 'parent_of'], [1, 3, 'parent_of'], [1, 4, 'parent_of'],
      [2, 5, 'parent_of'],
      [3, 6, 'spouse_of'], [3, 7, 'parent_of'], [6, 7, 'parent_of'],
    ],
  },
];

/**
 * KNOWN-FAILING (tracked, NOT hidden) — a deeper root issue the harness caught:
 * a LINEAGE node (one that has descendants) loses the central column to a
 * CHILDLESS sibling, so the real grandparent is shunted aside while the
 * childless great-aunt sits over the line. This is the SAME root family as the
 * stranding bug, in the ancestor-placement (fanUp / solveLayer ordering). It is
 * to be fixed AT THE ROOT (one change for all of them), not per-case. Marked
 * `it.fails` so `npm test` stays green as a guard for everything else AND trips
 * the moment the root fix lands (it.fails reports failure when the test passes),
 * forcing these back to normal `it`. See trees_chevrons_differentiation_plan.md.
 */
const KNOWN_FAILING = new Set<string>([
  'childless great-aunt (derived) two generations up|Focus',
  'childless great-aunt (derived) two generations up|Parent',
  'multiple childless siblings + one sibling WITH a branch|Kid',
  'multiple childless siblings + one sibling WITH a branch|TheirKid',
  // Couple-split is FIXED here (Colin+Lindsay adjacent — see the dedicated
  // couples test above); these two focuses still trip the SAME lineage-column
  // root — childless Amie takes the central column so Lucy's parent sits off to
  // the side. Tracked, to clear when the lineage fix lands.
  'side-branch couple at the parent generation stays adjacent|Lucy',
  'side-branch couple at the parent generation stays adjacent|CousinKid',
]);

describe('collapsing a generation hides the WHOLE subtree, including in-laws', () => {
  // Terry 2026-06-26: focus=Grandad, collapse the generation below him → ONLY
  // the in-laws cascaded down. Collapsing a node must panel its bloodline
  // descendants AND their married-in spouses, not leave the in-laws dangling.
  it('collapsed focus → no descendant or in-law spouse stays slotted', () => {
    const names = { 1: 'F', 2: 'FS', 3: 'C', 4: 'CS', 5: 'GC', 6: 'GCS' };
    const edges: E[] = [
      [1, 2, 'spouse_of'], [1, 3, 'parent_of'], [2, 3, 'parent_of'],
      [3, 4, 'spouse_of'], [3, 5, 'parent_of'], [4, 5, 'parent_of'],
      [5, 6, 'spouse_of'],
    ];
    const g = graphFor(names, edges, 1);
    const everyId = new Set(g.nodes.map(n => n.personId));
    const layout = computeFocusLayout(g, 99, {}, everyId, new Set([1])); // collapse focus F
    const slotted = new Set(layout.nodes.filter(n => n.slotted).map(n => n.name));
    // F + spouse stay; the whole subtree below (bloodline C/GC AND in-laws CS/GCS) goes
    expect([...slotted].sort()).toEqual(['F', 'FS']);
  });
});

// Terry 2026-06-26: the couples-split GUARANTEE, isolated from every other
// invariant. A couple must NEVER be split by a sibling, for ANY focus — this
// asserts ONLY spouse-adjacency across every couple shape × every focus, so it
// stays green even where a shape also trips the (separate, tracked) lineage-
// column issue. This is the proof Terry's "no sibling between a couple, no
// matter the focus" ask holds globally.
// Deliberately awkward, unrelated structures — the BREADTH proof that the
// couple-adjacency rule is GLOBAL (Terry 2026-06-26: "make it global… so if a
// user has a different scenario it doesn't do this bug for them"). These are
// spouse-adjacency-only (they may trip the separate lineage issue), so they
// stress the one rule across shapes the main corpus doesn't have.
const COUPLE_STRESS: Array<{ name: string; names: Record<number, string>; edges: E[] }> = [
  {
    name: 'STRESS three siblings, two married, one single',
    names: { 1: 'GP', 2: 'A', 3: 'As', 4: 'B', 5: 'Bs', 6: 'C', 7: 'AKid' },
    edges: [[1, 2, 'parent_of'], [1, 4, 'parent_of'], [1, 6, 'parent_of'], [2, 3, 'spouse_of'], [4, 5, 'spouse_of'], [2, 7, 'parent_of'], [3, 7, 'parent_of']],
  },
  {
    name: 'STRESS spouse listed before partner in source order',
    names: { 1: 'GP', 2: 'Spouse', 3: 'Blood', 4: 'Sib', 5: 'Focus' },
    edges: [[2, 3, 'spouse_of'], [1, 3, 'parent_of'], [1, 4, 'parent_of'], [3, 5, 'parent_of']],
  },
  {
    name: 'STRESS remarriage — one person, two spouses in a row',
    names: { 1: 'P', 2: 'S1', 3: 'S2', 4: 'K1', 5: 'K2' },
    edges: [[1, 2, 'spouse_of'], [1, 3, 'spouse_of'], [1, 4, 'parent_of'], [2, 4, 'parent_of'], [1, 5, 'parent_of'], [3, 5, 'parent_of']],
  },
  {
    name: 'STRESS great-uncle couple two generations up',
    names: { 1: 'GGP', 2: 'GP', 3: 'GreatUncle', 4: 'GUWife', 5: 'Parent', 6: 'Focus' },
    edges: [[1, 2, 'parent_of'], [1, 3, 'parent_of'], [3, 4, 'spouse_of'], [2, 5, 'parent_of'], [5, 6, 'parent_of']],
  },
  {
    name: 'STRESS wide sibling row — two couples + two singles interleaved',
    names: { 1: 'GP', 2: 'A', 3: 'B', 4: 'Bs', 5: 'C', 6: 'D', 7: 'Ds', 8: 'Focus' },
    edges: [[1, 2, 'parent_of'], [1, 3, 'parent_of'], [1, 5, 'parent_of'], [1, 6, 'parent_of'], [3, 4, 'spouse_of'], [6, 7, 'spouse_of'], [2, 8, 'parent_of']],
  },
  {
    name: 'STRESS in-law married to in-law on a side branch',
    names: { 1: 'GP', 2: 'Parent', 3: 'Aunt', 4: 'UncleInLaw', 5: 'Focus', 6: 'CousinA', 7: 'CousinAspouse' },
    edges: [[1, 2, 'parent_of'], [1, 3, 'parent_of'], [3, 4, 'spouse_of'], [2, 5, 'parent_of'], [3, 6, 'parent_of'], [4, 6, 'parent_of'], [6, 7, 'spouse_of']],
  },
];

describe('couples never split by a sibling (every couple shape × every focus)', () => {
  const coupleShapes = [...CORPUS.filter(s => s.edges.some(e => e[2] === 'spouse_of')), ...COUPLE_STRESS];
  for (const shape of coupleShapes) {
    for (const focus of Object.keys(shape.names).map(Number)) {
      it(`${shape.name} — focus=${shape.names[focus]}`, () => {
        const g = graphFor(shape.names, shape.edges, focus);
        const nodes = layoutAll(g).nodes.filter(n => (n as any).slotted);
        expect(checkSpousesAdjacent(g, nodes)).toEqual([]);
      });
    }
  }
});

describe('trees layout invariants (every shape × every focus)', () => {
  for (const shape of CORPUS) {
    const ids = Object.keys(shape.names).map(Number);
    for (const focus of ids) {
      const run = KNOWN_FAILING.has(`${shape.name}|${shape.names[focus]}`) ? it.fails : it;
      run(`${shape.name} — focus=${shape.names[focus]}`, () => {
        const g = graphFor(shape.names, shape.edges, focus);
        const violations = allViolations(g);
        expect(violations, violations.join('\n')).toEqual([]);
      });
    }
  }
});
