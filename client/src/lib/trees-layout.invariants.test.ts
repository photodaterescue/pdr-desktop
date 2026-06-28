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


// Lay a graph out with only a SUBSET of branch heads expanded (the others collapse,
// so their descendants are panelled and NOT slotted). This is the partial /
// collapsed state that the spine-drift bug needed: with a side branch panelled, the
// focus's parents used to be pooled off their children. `expand` is the set of heads
// to expand; the focus is always added.
function layoutPartial(graph: FamilyGraph, expand: Iterable<number>) {
  const heads = new Set<number>([graph.focusPersonId, ...expand]);
  return computeFocusLayout(graph, 99, {}, heads, new Set());
}

const CARD_W = 170;       // cards are ~170px wide → centres closer than this overlap
const SNUG = 480;         // a non-stranded sibling sits within this of its group
// Tight centre tolerance for a SPINE parent/couple over its own children. Calibrated
// against the layout: with the spine-seating fix, the worst legitimate full+partial
// residual a blood-ancestor shows is ~55px (a real maternal/paternal fork where the
// two grandparent couples must split to clear each other). 80px sits comfortably
// above that and far below the drift this catches (engineered partial-collapse cases
// drift the focus's parents 200px+ before the fix; the old ±190 footprint slack hid
// even Terry's live ~170px). Residual is measured AFTER subtracting the unavoidable
// "couple wider than its children" spread, so it is NOT fork-specific slack.
const SPINE_CENTRE_TOL = 80;

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

// Adjacent SIBLINGS (with nothing between them in their row) must sit TIGHT:
// their sub-trees' closest horizontal approach should be ~one card + a small gap,
// never a wasteful empty corridor. This catches the recurring "expand/collapse a
// generation and a gap opens up between my family and the cousins" / "Derek and
// his sister drift apart" class — in EVERY expand/collapse state, so it can't
// reappear unnoticed. A wide sub-tree legitimately pushes its sibling's HEAD far
// away, but somewhere below the two sub-trees must still nearly touch; we measure
// the CLOSEST approach across shared generations, so legitimate wide families pass.
function checkSiblingGap(graph: FamilyGraph, nodes: LaidOutNode[]): string[] {
  const byId = new Map(nodes.map(n => [n.personId, n]));
  const kids = childrenOf(graph);
  const subtreeContour = (root: number) => {
    const m = new Map<number, [number, number]>();
    const seen = new Set<number>();
    const q = [root];
    while (q.length) {
      const c = q.shift()!;
      if (seen.has(c)) continue;
      seen.add(c);
      const n = byId.get(c);
      if (n) { const e = m.get(n.generation); if (!e) m.set(n.generation, [n.x, n.x]); else { if (n.x < e[0]) e[0] = n.x; if (n.x > e[1]) e[1] = n.x; } }
      for (const k of kids.get(c) ?? []) q.push(k);
    }
    return m;
  };
  const subtreeSet = (root: number) => { const s = new Set<number>(); const q = [root]; while (q.length) { const c = q.shift()!; if (s.has(c)) continue; s.add(c); for (const k of kids.get(c) ?? []) q.push(k); } return s; };
  const EMPTY_TOL = 150; // empty space (beyond one card) allowed at the closest approach
  const bad: string[] = [];
  for (const key of siblingPairs(graph)) {
    const [a, b] = key.split('-').map(Number);
    const na = byId.get(a), nb = byId.get(b);
    if (!na || !nb || na.generation !== nb.generation) continue;
    const L = na.x <= nb.x ? na : nb, R = na.x <= nb.x ? nb : na;
    // Only ADJACENT siblings — skip if another node of their gen sits between them.
    if (nodes.some(n => n.generation === L.generation && n.x > L.x + 1 && n.x < R.x - 1)) continue;
    const cl = subtreeContour(L.personId), cr = subtreeContour(R.personId);
    let closest = Infinity;
    for (const [gen, le] of cl) { const re = cr.get(gen); if (re) closest = Math.min(closest, re[0] - le[1]); }
    if (closest === Infinity) continue;
    const emptyGap = closest - CARD_W;
    if (emptyGap <= EMPTY_TOL) continue;
    // Real stranding only if the corridor between them is NOT occupied by a THIRD
    // family — if another branch's cards sit between the siblings, the separation is
    // legitimate (e.g. a grandparent's own descendants between two great-aunts), not
    // a spurious gap.
    const lSet = subtreeSet(L.personId), rSet = subtreeSet(R.personId);
    const third = nodes.some(n => !lSet.has(n.personId) && !rSet.has(n.personId) && n.x > L.x + CARD_W / 2 && n.x < R.x - CARD_W / 2);
    if (!third) bad.push(`adjacent siblings ${L.name} & ${R.name} over-separated: ${Math.round(emptyGap)}px of empty space at their closest approach`);
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

// A parent/couple must sit CENTRED over its own children. This is now CENTRE-based
// (couple-midpoint vs the children's-span centre), not the old "is the centre inside
// the children's footprint ±a card" — that ±190 slack hid a real ~170px spine drift
// that only appeared when a side branch was collapsed.
//
// The tight tolerance (SPINE_CENTRE_TOL) now applies to EVERY parent — spine AND
// non-spine (Terry 2026-06-26). It was previously gated to blood-ancestors only,
// which let aunt/uncle and cousin couples sit up to ~147px off their own children
// (a wider spine brood was seated first and the side couples merely gap-packed). The
// layout's finalize now seats every parent over its own children, so the same tight
// rule holds for all of them. We subtract the one unavoidable component first: a
// COUPLE that is wider than its visible children can't shrink, so a residual up to
// (coupleWidth − childSpan)/2 is geometric, not drift (a general couple rule applied
// to every couple — NOT fork-specific slack). At a genuine maternal/paternal fork the
// two grandparent couples split to clear each other; that residual stays within the
// tolerance, so the fork passes without any special-casing.
//
// The FOCUS couple stays exempt: the whole tree is centred ON them, so their child
// can sit off-centre when the subtree below is lopsided — by design, not drift.
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
    const kidMin = Math.min(...vis.map(k => k.x)), kidMax = Math.max(...vis.map(k => k.x));
    const spouseXs = graph.edges.filter(e => e.type === 'spouse_of' && (e.aId === pid || e.bId === pid)).map(e => byId.get(e.aId === pid ? e.bId : e.aId)).filter((s): s is LaidOutNode => !!s).map(s => s.x);
    const parentCentre = spouseXs.length ? (p.x + spouseXs[0]) / 2 : p.x;
    const kidsCentre = (kidMin + kidMax) / 2;
    // TIGHT centre check on EVERY parent. Subtract the geometric couple-slack first
    // (a couple wider than its children can't centre tighter than (cw−span)/2).
    const coupleWidth = spouseXs.length ? Math.abs(p.x - spouseXs[0]) : 0;
    const childSpan = kidMax - kidMin;
    const coupleSlack = Math.max(0, (coupleWidth - childSpan) / 2);
    const residual = Math.max(0, Math.abs(parentCentre - kidsCentre) - coupleSlack);
    if (residual > SPINE_CENTRE_TOL) bad.push(`${p.name} not centred over children (centre ${Math.round(parentCentre)} vs kids-centre ${Math.round(kidsCentre)}, residual ${Math.round(residual)} > ${SPINE_CENTRE_TOL})`);
  }
  return bad;
}

// PLANARITY (Phase 2): no two subtrees may INTERLEAVE horizontally — that's a
// crossed connector line, the "trapped-interior branch" case. If A sits left of
// B in their generation, A's whole subtree must stay left of B's whole subtree at
// every shared descendant generation. Co-parents (spouses, or any two parents
// sharing a child) legitimately share descendants, and the rare shared-descendant
// merge (cousin marriage) is skipped too — neither is a crossing. Contours use
// card CENTRES, so adjacent disjoint subtrees (a card-width apart) pass; only a
// genuine overlap of the centre-spans is flagged.
function checkNoCrossedLines(graph: FamilyGraph, nodes: LaidOutNode[]): string[] {
  const byId = new Map(nodes.map(n => [n.personId, n]));
  const kids = childrenOf(graph);
  const key = (a: number, b: number) => a < b ? `${a}-${b}` : `${b}-${a}`;
  const coparent = new Set<string>();
  for (const e of graph.edges) if (e.type === 'spouse_of') coparent.add(key(e.aId, e.bId));
  const parentsOf = new Map<number, number[]>();
  for (const e of graph.edges) if (e.type === 'parent_of') { if (!parentsOf.has(e.bId)) parentsOf.set(e.bId, []); parentsOf.get(e.bId)!.push(e.aId); }
  for (const ps of parentsOf.values()) for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) coparent.add(key(ps[i], ps[j]));
  const contour = (root: number) => {
    const m = new Map<number, [number, number]>(); const seen = new Set<number>(); const q = [root];
    while (q.length) { const c = q.shift()!; if (seen.has(c)) continue; seen.add(c);
      const n = byId.get(c); if (n) { const e = m.get(n.generation); if (!e) m.set(n.generation, [n.x, n.x]); else { if (n.x < e[0]) e[0] = n.x; if (n.x > e[1]) e[1] = n.x; } }
      for (const k of kids.get(c) ?? []) q.push(k); }
    return m;
  };
  const subSet = (root: number) => { const s = new Set<number>(); const q = [root]; while (q.length) { const c = q.shift()!; if (s.has(c)) continue; s.add(c); for (const k of kids.get(c) ?? []) q.push(k); } return s; };
  const byGen = new Map<number, LaidOutNode[]>();
  for (const n of nodes) { if (!byGen.has(n.generation)) byGen.set(n.generation, []); byGen.get(n.generation)!.push(n); }
  const EPS = 1;
  const bad: string[] = [];
  for (const row of byGen.values()) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
      const A = sorted[i], B = sorted[j];
      if (A.x === B.x) continue;
      if (coparent.has(key(A.personId, B.personId))) continue;
      const sa = subSet(A.personId); if ([...subSet(B.personId)].some(x => sa.has(x))) continue; // shared-descendant merge — not a crossing
      const ca = contour(A.personId), cb = contour(B.personId);
      for (const [g, ae] of ca) { const be = cb.get(g); if (!be) continue; if (ae[1] > be[0] + EPS) { bad.push(`${A.name} & ${B.name} subtrees cross at gen ${g} (${A.name}.maxX=${Math.round(ae[1])} > ${B.name}.minX=${Math.round(be[0])})`); break; } }
    }
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
    ...checkSiblingGap(graph, nodes),
    ...checkNoCrossedLines(graph, nodes),
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
  {
    // Terry 2026-06-26: focus=Lucy. Her parent-couple Jo+Paul has THREE children
    // (Lucy + 2 sibs); it is FLANKED by two aunt-couples Kevin+Sarah and
    // Nicholas+Lauren, EACH with their own 2 children, all under one grandparent
    // couple. The aunt-couples' children used to bleed sideways into the focus's
    // family — the side couples sat up to ~147px off their OWN children because
    // Jo+Paul's wider brood was seated first. Asserts EVERY couple (spine AND the
    // two non-spine aunt couples) is centred over its own children, every focus.
    name: 'aunt couples with their own broods flank the focus parents (Lucy)',
    names: {
      1: 'GPa', 2: 'GMa',
      3: 'Kevin', 4: 'Sarah', 5: 'Jo', 6: 'Paul', 7: 'Nicholas', 8: 'Lauren',
      10: 'Lucy', 11: 'LSib1', 12: 'LSib2',
      20: 'KevK1', 21: 'KevK2', 30: 'NicK1', 31: 'NicK2',
    },
    edges: [
      [1, 2, 'spouse_of'], [1, 3, 'parent_of'], [2, 3, 'parent_of'], [1, 5, 'parent_of'], [2, 5, 'parent_of'], [1, 7, 'parent_of'], [2, 7, 'parent_of'],
      [3, 4, 'spouse_of'], [5, 6, 'spouse_of'], [7, 8, 'spouse_of'],
      [5, 10, 'parent_of'], [6, 10, 'parent_of'], [5, 11, 'parent_of'], [6, 11, 'parent_of'], [5, 12, 'parent_of'], [6, 12, 'parent_of'],
      [3, 20, 'parent_of'], [4, 20, 'parent_of'], [3, 21, 'parent_of'], [4, 21, 'parent_of'],
      [7, 30, 'parent_of'], [8, 30, 'parent_of'], [7, 31, 'parent_of'], [8, 31, 'parent_of'],
    ],
  },
];

/**
 * KNOWN-FAILING — CLEARED (Terry 2026-06-26). The deeper root issue the harness
 * caught — a LINEAGE node (one with descendants) losing its central column to a
 * CHILDLESS sibling so the real grandparent was shunted aside while the childless
 * great-aunt sat over the line — is now FIXED at the root. The X-coordinate pass
 * in trees-layout.ts was replaced with a focus-rooted, subtree-band positioner
 * (down-cones for the focus + every branch head, the spine seated bottom-up
 * centred over its children). Every parent/couple is centred over its children
 * with no overlaps, so all six formerly-failing focuses now pass as normal `it`.
 */
const KNOWN_FAILING = new Set<string>([]);

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

// ── PARTIAL-expansion (collapsed) corpus ──────────────────────────────────
// The spine-drift bug only appeared in PARTIAL states: with some branch heads
// collapsed, their descendants panel away (not slotted), so the focus's parents
// row holds only a few units — and the layout used to POOL the focus's parents
// with a too-close collapsed leaf branch-head, dragging them off their children.
// layoutAll (everything expanded) never reproduced it. Each shape below is laid
// out with ONLY its spine expanded (every side branch collapsed) and asserts the
// SAME structural invariants, with the parents-centred check now tight on the
// spine. Before the spine-seating fix these drift the focus's parents 70–250px
// off their children; after it they sit dead-centre.
const PARTIAL_CORPUS: Array<{ name: string; names: Record<number, string>; edges: E[]; focus: number; expand: number[] }> = [
  {
    // focus + 2 sibs; the focus's parent has a sibling Uncle (collapsed) with 3
    // cousins; grandparents above. The collapsed Uncle leaf sits left of Par.
    name: 'parent with a collapsed uncle branch',
    names: { 1: 'GP1', 2: 'GP2', 3: 'Par', 4: 'ParSp', 5: 'Uncle', 6: 'UncleSp', 7: 'Focus', 8: 'Sib1', 9: 'Sib2', 10: 'Cou1', 11: 'Cou2', 12: 'Cou3' },
    edges: [[1, 2, 'spouse_of'], [1, 3, 'parent_of'], [2, 3, 'parent_of'], [1, 5, 'parent_of'], [2, 5, 'parent_of'], [3, 4, 'spouse_of'], [5, 6, 'spouse_of'], [3, 7, 'parent_of'], [4, 7, 'parent_of'], [3, 8, 'parent_of'], [4, 8, 'parent_of'], [3, 9, 'parent_of'], [4, 9, 'parent_of'], [5, 10, 'parent_of'], [6, 10, 'parent_of'], [5, 11, 'parent_of'], [6, 11, 'parent_of'], [5, 12, 'parent_of'], [6, 12, 'parent_of']],
    focus: 7, expand: [1, 2, 3, 4], // spine only; Uncle collapsed
  },
  {
    // two uncles, one each side, both collapsed, each with cousins.
    name: 'two collapsed uncle branches, one each side',
    names: { 1: 'GP1', 2: 'GP2', 3: 'Par', 4: 'ParSp', 5: 'UncL', 6: 'UncLsp', 7: 'UncR', 8: 'UncRsp', 9: 'Focus', 10: 'Sib', 11: 'CL1', 12: 'CL2', 13: 'CR1', 14: 'CR2' },
    edges: [[1, 2, 'spouse_of'], [1, 3, 'parent_of'], [2, 3, 'parent_of'], [1, 5, 'parent_of'], [2, 5, 'parent_of'], [1, 7, 'parent_of'], [2, 7, 'parent_of'], [3, 4, 'spouse_of'], [5, 6, 'spouse_of'], [7, 8, 'spouse_of'], [3, 9, 'parent_of'], [4, 9, 'parent_of'], [3, 10, 'parent_of'], [4, 10, 'parent_of'], [5, 11, 'parent_of'], [6, 11, 'parent_of'], [5, 12, 'parent_of'], [6, 12, 'parent_of'], [7, 13, 'parent_of'], [8, 13, 'parent_of'], [7, 14, 'parent_of'], [8, 14, 'parent_of']],
    focus: 9, expand: [1, 2, 3, 4],
  },
  {
    // THREE uncles all to the LEFT of Par, each with a deep cousin subtree; focus
    // + 1 sib on the right. Heavy one-sided pull — the strongest reproduction
    // (the focus's parents drift ~250px before the fix).
    name: 'three deep collapsed uncle branches on one side',
    names: {
      1: 'GP1', 2: 'GP2', 3: 'UncA', 4: 'UncAsp', 5: 'UncB', 6: 'UncBsp', 7: 'UncC', 8: 'UncCsp', 9: 'Par', 10: 'ParSp',
      11: 'Focus', 12: 'Sib',
      13: 'CA1', 14: 'CA2', 15: 'CB1', 16: 'CB2', 17: 'CC1', 18: 'CC2', 19: 'GCA1', 20: 'GCB1', 21: 'GCC1',
    },
    edges: [
      [1, 2, 'spouse_of'], [1, 3, 'parent_of'], [2, 3, 'parent_of'], [1, 5, 'parent_of'], [2, 5, 'parent_of'], [1, 7, 'parent_of'], [2, 7, 'parent_of'], [1, 9, 'parent_of'], [2, 9, 'parent_of'],
      [3, 4, 'spouse_of'], [5, 6, 'spouse_of'], [7, 8, 'spouse_of'], [9, 10, 'spouse_of'],
      [9, 11, 'parent_of'], [10, 11, 'parent_of'], [9, 12, 'parent_of'], [10, 12, 'parent_of'],
      [3, 13, 'parent_of'], [4, 13, 'parent_of'], [3, 14, 'parent_of'], [4, 14, 'parent_of'],
      [5, 15, 'parent_of'], [6, 15, 'parent_of'], [5, 16, 'parent_of'], [6, 16, 'parent_of'],
      [7, 17, 'parent_of'], [8, 17, 'parent_of'], [7, 18, 'parent_of'], [8, 18, 'parent_of'],
      [13, 19, 'parent_of'], [15, 20, 'parent_of'], [17, 21, 'parent_of'],
    ],
    focus: 11, expand: [1, 2, 9, 10], // spine only; all 3 uncles collapsed
  },
  {
    // Terry's live case in a PARTIAL state: focus=Lucy, parent-couple Jo+Paul (3
    // kids), flanked by aunt-couples Kevin+Sarah and Nicholas+Lauren (2 kids each).
    // ONE aunt (Kevin) is EXPANDED so HIS children are slotted and MUST be centred
    // under him, while the other aunt (Nicholas) stays collapsed. The asymmetry is
    // exactly what pushed the expanded aunt off his own kids before the fix.
    name: 'one aunt expanded beside the focus parents stays centred over her kids (Lucy)',
    names: {
      1: 'GPa', 2: 'GMa',
      3: 'Kevin', 4: 'Sarah', 5: 'Jo', 6: 'Paul', 7: 'Nicholas', 8: 'Lauren',
      10: 'Lucy', 11: 'LSib1', 12: 'LSib2',
      20: 'KevK1', 21: 'KevK2', 30: 'NicK1', 31: 'NicK2',
    },
    edges: [
      [1, 2, 'spouse_of'], [1, 3, 'parent_of'], [2, 3, 'parent_of'], [1, 5, 'parent_of'], [2, 5, 'parent_of'], [1, 7, 'parent_of'], [2, 7, 'parent_of'],
      [3, 4, 'spouse_of'], [5, 6, 'spouse_of'], [7, 8, 'spouse_of'],
      [5, 10, 'parent_of'], [6, 10, 'parent_of'], [5, 11, 'parent_of'], [6, 11, 'parent_of'], [5, 12, 'parent_of'], [6, 12, 'parent_of'],
      [3, 20, 'parent_of'], [4, 20, 'parent_of'], [3, 21, 'parent_of'], [4, 21, 'parent_of'],
      [7, 30, 'parent_of'], [8, 30, 'parent_of'], [7, 31, 'parent_of'], [8, 31, 'parent_of'],
    ],
    focus: 10, expand: [1, 2, 5, 6, 3, 4], // spine + Kevin's couple expanded; Nicholas collapsed
  },
];

describe('parents stay centred in PARTIAL / collapsed states', () => {
  for (const shape of PARTIAL_CORPUS) {
    it(`${shape.name} — focus=${shape.names[shape.focus]}`, () => {
      const g = graphFor(shape.names, shape.edges, shape.focus);
      const nodes = layoutPartial(g, shape.expand).nodes.filter(n => n.slotted);
      const violations = [
        ...checkOverlap(nodes),
        ...checkSpousesAdjacent(g, nodes),
        ...checkNoStrandedSibling(g, nodes),
        ...checkParentsCentred(g, nodes),
        ...checkSiblingGap(g, nodes),
        ...checkNoCrossedLines(g, nodes),
      ];
      expect(violations, violations.join('\n')).toEqual([]);
    });
  }

  // Also exercise the EXISTING corpus shapes in partial states: for every shape ×
  // every focus, collapse each branch head one at a time (and all-but-spine) and
  // re-run the invariants. Broad coverage that the parents-centred guarantee holds
  // under collapse, not just full expansion.
  for (const shape of CORPUS) {
    const ids = Object.keys(shape.names).map(Number);
    for (const focus of ids) {
      it(`partial sweep — ${shape.name} — focus=${shape.names[focus]}`, () => {
        const g = graphFor(shape.names, shape.edges, focus);
        const heads = ids.filter(id => id !== focus);
        // a handful of representative subsets: none expanded, all expanded, and
        // each single head expanded alone.
        const subsets: number[][] = [[], heads, ...heads.map(h => [h])];
        for (const sub of subsets) {
          const nodes = layoutPartial(g, sub).nodes.filter(n => n.slotted);
          const violations = [
            ...checkOverlap(nodes),
            ...checkSpousesAdjacent(g, nodes),
            ...checkNoStrandedSibling(g, nodes),
            ...checkParentsCentred(g, nodes),
            ...checkSiblingGap(g, nodes),
            ...checkNoCrossedLines(g, nodes),
          ];
          expect(violations, `expand=[${sub.join(',')}]\n` + violations.join('\n')).toEqual([]);
        }
      });
    }
  }
});

// ── Collateral-sibling collapse at row 4+ (Terry 2026-06-27, lowered from 5) ──
// On the 4th generation ROW and above (youngest shown row = 1, counting up), a
// collateral sibling is NOT slotted on canvas — it collapses to an "N siblings"
// chip + lavender panel. The LAYOUT must mark such heads (and their descendants)
// as panelled, so the tree packs tight (render-side hiding would leave a gap).
describe('collateral siblings collapse off-canvas (panelled) at row 4+', () => {
  it('great-grand-uncle (row 5) is panelled; bloodline ancestors stay slotted', () => {
    // rows from youngest: K=1, F=2, P=3, GP=4, GGP=5, GGGP=6. GGU is GGP's sibling
    // (row 5) → panelled; GGU's child too. Bloodline 1,2,5,6,7,8 stay on canvas.
    const names = { 1: 'GGGP', 2: 'GGP', 3: 'GGU', 4: 'GGUK', 5: 'GP', 6: 'P', 7: 'F', 8: 'K' };
    const edges: E[] = [
      [1, 2, 'parent_of'], [1, 3, 'parent_of'],
      [2, 5, 'parent_of'], [5, 6, 'parent_of'], [6, 7, 'parent_of'], [7, 8, 'parent_of'],
      [3, 4, 'parent_of'],
    ];
    const g = graphFor(names, edges, 7);
    const by = new Map(layoutAll(g).nodes.map(n => [n.personId, n]));
    const slotted = (id: number) => !!by.get(id)?.slotted;
    for (const id of [1, 2, 5, 6, 7, 8]) expect(slotted(id), `${names[id as keyof typeof names]} should be slotted`).toBe(true);
    expect(slotted(3), 'GGU (row-5 collateral sibling) should be panelled, not slotted').toBe(false);
    expect(slotted(4), "GGU's child should be panelled").toBe(false);
  });

  it('row-4 great-aunt panels; row-3 aunt stays — the rule starts at row 4', () => {
    // rows from youngest: K=1, F=2, P=3, GP=4, GGP=5. PU = P's sibling (row 3, aunt)
    // → STAYS. GU = GP's sibling (row 4, great-aunt) + GUK her child → PANEL.
    const names = { 1: 'K', 2: 'F', 3: 'P', 4: 'GP', 5: 'GGP', 6: 'PU', 7: 'GU', 8: 'GUK' };
    const edges: E[] = [
      [5, 4, 'parent_of'], [5, 7, 'parent_of'],   // GGP → GP + GU (row-4 siblings)
      [4, 3, 'parent_of'], [4, 6, 'parent_of'],   // GP → P + PU (row-3 siblings)
      [3, 2, 'parent_of'], [2, 1, 'parent_of'],   // P → F → K
      [7, 8, 'parent_of'],                         // GU → GUK
    ];
    const g = graphFor(names, edges, 2);          // focus = F
    const by = new Map(layoutAll(g).nodes.map(n => [n.personId, n]));
    const slotted = (id: number) => !!by.get(id)?.slotted;
    expect(slotted(6), 'PU (row-3 aunt) should stay slotted').toBe(true);
    expect(slotted(7), 'GU (row-4 great-aunt) should panel').toBe(false);
    expect(slotted(8), "GU's child should panel").toBe(false);
  });
});

// Self-test: prove checkNoCrossedLines actually DETECTS a crossing (a checker that
// always returns [] would be a silent no-op that passes everything). A deliberately
// interleaved layout — sibling P1 sits left of P2, but P1's child is placed RIGHT of
// P2's child — must be flagged; the same layout uncrossed must pass.
describe('planarity invariant self-test', () => {
  it('flags a deliberately interleaved (crossed) layout, passes the uncrossed one', () => {
    const g = graphFor(
      { 1: 'GP', 2: 'P1', 3: 'P2', 4: 'C1', 5: 'C2' },
      [[1, 2, 'parent_of'], [1, 3, 'parent_of'], [2, 4, 'parent_of'], [3, 5, 'parent_of']],
      1,
    );
    const crossed = [
      { personId: 1, name: 'GP', x: 100, generation: 1 },
      { personId: 2, name: 'P1', x: 0, generation: 0 },
      { personId: 3, name: 'P2', x: 200, generation: 0 },
      { personId: 4, name: 'C1', x: 300, generation: -1 },  // P1's child placed to the RIGHT…
      { personId: 5, name: 'C2', x: 100, generation: -1 },  // …of P2's child → lines cross
    ] as unknown as LaidOutNode[];
    expect(checkNoCrossedLines(g, crossed).length).toBeGreaterThan(0);
    const ok = crossed.map(n => n.personId === 4 ? { ...n, x: 100 } : n.personId === 5 ? { ...n, x: 300 } : n) as unknown as LaidOutNode[];
    expect(checkNoCrossedLines(g, ok)).toEqual([]);
  });
});
