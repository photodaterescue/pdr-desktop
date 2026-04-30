/**
 * Trees v1 — pure layout math.
 *
 * Takes a FamilyGraph (from the backend) and produces 2D positions in a
 * logical coordinate system. The renderer (chunk 3) owns zoom, pan, drag
 * and actual drawing; this module only decides where each node SHOULD
 * live if nobody has dragged it yet.
 *
 * No DOM, no React — easy to unit-test.
 */

import type { FamilyGraphEdge, FamilyGraphNode, FamilyGraph } from './electron-bridge';

/**
 * Augment the fetched family graph with virtual ghost parents — but
 * ONLY for named people who are missing a parent slot, and ONLY one
 * generation up. No cascading.
 *
 * Rule:
 *   - Every named (non-placeholder) person with fewer than 2 stored
 *     parents gets ghost parents added to fill to 2.
 *   - Ghosts themselves never get ghost parents — the tree stops there.
 *   - If the user wants more generations visible, they click the + chip
 *     on a named person OR name a ghost (which then gets its own ghost
 *     parents as a named person).
 *
 * Virtual ghost IDs are negative so the canvas can distinguish them
 * from real persisted placeholders. Clicking a virtual materialises
 * it into a real placeholder_person on the backend before opening
 * the resolver.
 */
export function augmentWithVirtualGhosts(
  graph: FamilyGraph,
  maxDepth: number,
  skipPersonIds?: Iterable<number>,
): FamilyGraph {
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];

  // Collect real parent IDs per child. We use this both to count (to
  // know how many ghosts are needed) and to SIGNATURE siblings — two
  // children with the same real-parent set share any remaining ghost
  // slots, so three confirmed siblings all missing the same 2nd parent
  // paint one shared ghost instead of three identical-looking ones.
  const realParentsByChild = new Map<number, number[]>();
  for (const e of edges) {
    if (e.type !== 'parent_of') continue;
    if (!realParentsByChild.has(e.bId)) realParentsByChild.set(e.bId, []);
    realParentsByChild.get(e.bId)!.push(e.aId);
  }

  let virtualId = -1;
  const skipSet = skipPersonIds ? new Set(skipPersonIds) : null;

  // One entry per unique (sorted-real-parents × needed-slots) signature.
  // All children matching the signature wire to the SAME ghost IDs, so
  // the render treats them as one family with shared unnamed parents.
  const ghostsBySignature = new Map<string, number[]>();

  // Snapshot the ORIGINAL named nodes so ghosts added in this pass don't
  // trigger more ghosts above them (no cascade).
  const originalNamedNodes = graph.nodes.filter(n => !n.isPlaceholder);
  for (const node of originalNamedNodes) {
    // Skip ghost generation for anyone the caller has flagged — typically
    // a partner whose ancestry the user explicitly hid for this tree.
    // Painting ghosts above them contradicts the hide action and tempts
    // the user into populating a line that's meant to stay collapsed.
    if (skipSet && skipSet.has(node.personId)) continue;
    // People sitting AT the Steps boundary never get ghost slots —
    // any parents would live one hop past the current view, which is
    // exactly what the step-count badge on the card signals. Applies
    // whether or not they have real parents in the DB; without this
    // rule, boundary people with 0 DB parents still get ghosts painted
    // in territory the user has deliberately excluded.
    if (node.hopsFromFocus >= maxDepth) continue;
    const realParents = realParentsByChild.get(node.personId) ?? [];
    // If the DB has MORE parents for this person than we can see in
    // the visible graph, those missing-from-view parents are really
    // stored — just beyond the Steps window. Don't paint ghost slots
    // above them; the step-count badge on the card already tells the
    // user the view is truncated here. Reads TRUE total from the
    // server (node.totalParentCount) so this works even when the
    // parents themselves aren't in the fetched graph.
    if (node.totalParentCount > realParents.length) continue;
    const needed = Math.max(0, 2 - realParents.length);
    if (needed === 0) continue;

    // Ghost consolidation only applies when there IS a shared real
    // parent to key the signature by. With zero real parents visible,
    // two unrelated children (e.g. Mel and Lindsay, both of whose
    // real parents sit beyond the Steps window) would otherwise
    // collide on the same empty signature and end up SHARING ghost
    // parents — wrongly treated as siblings and pulled out of place
    // next to their spouses. Per-node unique ghosts in that case.
    const canShare = realParents.length > 0;
    const sig = canShare
      ? [...realParents].sort((a, b) => a - b).join(',') + '|' + needed
      : `__unique_${node.personId}|${needed}`;
    let ghostIds = ghostsBySignature.get(sig);
    if (!ghostIds) {
      ghostIds = [];
      for (let i = 0; i < needed; i++) ghostIds.push(virtualId--);
      ghostsBySignature.set(sig, ghostIds);
      // Add the ghost NODES once per unique ghost ID — not once per
      // child that references them. Otherwise siblings would duplicate
      // the ghost node into the layout.
      for (const ghostId of ghostIds) {
        nodes.push({
          personId: ghostId,
          name: '',
          avatarData: null,
          representativeFaceId: null,
          representativeFaceFilePath: null,
          representativeFaceBox: null,
          birthDate: null,
          deathDate: null,
          deceasedMarker: null,
          cardBackground: null,
          gender: null,
          hopsFromFocus: node.hopsFromFocus + 1,
          photoCount: 0,
          totalParentCount: 0,
          isPlaceholder: true,
        });
      }
    }
    for (const ghostId of ghostIds) {
      edges.push({
        id: null,
        aId: ghostId,
        bId: node.personId,
        type: 'parent_of',
        since: null,
        until: null,
        flags: null,
        derived: false,
      });
    }
  }

  return { ...graph, nodes, edges };
}

export interface LaidOutNode extends FamilyGraphNode {
  /** Generation relative to focus: 0 = focus, +1 = parents, -1 = children. */
  generation: number;
  /** Logical x coord in an arbitrary unit — renderer scales to pixels. */
  x: number;
  /** Logical y coord — tiers are evenly spaced by `rowHeight`. */
  y: number;
}

export interface LaidOutEdge extends FamilyGraphEdge {
  /** Whether the edge should be rendered given the current layout. */
  visible: boolean;
}

export interface TreeLayout {
  focusPersonId: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

export interface LayoutOptions {
  /** Horizontal space between adjacent sibling nodes. */
  nodeSpacing?: number;
  /** Vertical space between generations. */
  rowHeight?: number;
  /** Horizontal offset applied to a spouse placed beside their partner. */
  spouseOffset?: number;
}

const DEFAULT_OPTIONS: Required<LayoutOptions> = {
  // Card-style nodes are wider (~170px) than the old circles, so
  // horizontal spacing bumps to keep a readable gap between siblings
  // and to leave room for the spouse connector between partners.
  // Vertical spacing increases to keep branches airy — lines look
  // much cleaner with room to breathe between generations.
  // Wider cards need more lateral breathing room: with 170-wide cards
  // and 210px spacing the gap between siblings was 40px, making the
  // partnership horizontal and the midpoint dot feel crammed. 280 gives
  // 110px gaps — the connector has visual room and siblings read as
  // separate cards rather than a single block.
  nodeSpacing: 280,
  rowHeight: 260,
  spouseOffset: 220,
};

/**
 * Assign a generation number to every node, relative to focus (gen 0).
 *   · parent_of(A, B) → B = A.gen − 1 (parent is older)
 *   · spouse_of / sibling_of / associated_with → same gen
 *
 * A single loop propagates both kinds of edges from any assigned node
 * outward until stable. This handles cases like Mel (focus's partner,
 * reachable only via spouse_of) whose OWN parent_of-ancestors would
 * otherwise never be reached from focus via pure parent BFS.
 */
export function assignGenerations(graph: FamilyGraph): Map<number, number> {
  const gens = new Map<number, number>();
  if (graph.nodes.length === 0) return gens;
  gens.set(graph.focusPersonId, 0);

  const parentEdges: FamilyGraphEdge[] = graph.edges.filter(e => e.type === 'parent_of');
  const sameGenEdges: FamilyGraphEdge[] = graph.edges.filter(e =>
    e.type === 'spouse_of' || e.type === 'sibling_of' || e.type === 'associated_with'
  );

  // Loop until no new generations get assigned. Each iteration tries to
  // extend the known-set via both parent_of (vertical) and same-gen
  // (horizontal) edges. Order of iterations doesn't matter because any
  // newly-assigned node becomes a propagation source in the next round.
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of parentEdges) {
      const ga = gens.get(e.aId);
      const gb = gens.get(e.bId);
      // aId is parent, bId is child → b.gen = a.gen - 1; a.gen = b.gen + 1
      if (ga !== undefined && gb === undefined) { gens.set(e.bId, ga - 1); changed = true; }
      else if (gb !== undefined && ga === undefined) { gens.set(e.aId, gb + 1); changed = true; }
    }
    for (const e of sameGenEdges) {
      const ga = gens.get(e.aId);
      const gb = gens.get(e.bId);
      if (ga !== undefined && gb === undefined) { gens.set(e.bId, ga); changed = true; }
      else if (gb !== undefined && ga === undefined) { gens.set(e.aId, gb); changed = true; }
    }
  }

  // Any still-unassigned nodes (fully disconnected from focus) fall
  // to gen 0 so they at least render somewhere.
  for (const n of graph.nodes) {
    if (!gens.has(n.personId)) gens.set(n.personId, 0);
  }

  return gens;
}

/**
 * Classic pedigree-style layout: tier-based, centred on the focus.
 * Nodes of the same generation are laid out in a row; spouses are placed
 * adjacent to each other; children are roughly centred under their parents.
 *
 * This is the "Canopy" renderer's layout. The focus-explorer renderer can
 * use the same nodes but hide anyone beyond a given hop count.
 */
export function computePedigreeLayout(graph: FamilyGraph, options: LayoutOptions = {}): TreeLayout {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const generations = assignGenerations(graph);

  // Group nodes by generation.
  const byGen = new Map<number, FamilyGraphNode[]>();
  for (const n of graph.nodes) {
    const g = generations.get(n.personId) ?? 0;
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g)!.push(n);
  }

  // Within each generation, order nodes so that:
  //   1. Spouses sit adjacent to each other.
  //   2. Siblings group together under shared parents.
  const placed = new Map<number, LaidOutNode>();

  // Place focus first at (0, 0).
  const focusNode = graph.nodes.find(n => n.personId === graph.focusPersonId);
  if (!focusNode) {
    return { focusPersonId: graph.focusPersonId, nodes: [], edges: [], bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 } };
  }

  // Process generations in a specific order so that when we place
  // parents (gen +N) we already know where their children sit:
  //   1. Focus generation (0) first — centred with focus in the middle
  //   2. Ancestor generations (+1, +2, …) next — each row ordered by the
  //      x-position of the children below it, so parents sit above their
  //      actual kids instead of being shuffled across the row.
  //   3. Descendant generations (−1, −2, …) last — each row ordered by
  //      the x-position of the parents above.
  // This stops the crossed-over-families bug where Terry+Colin's parents
  // ended up above Mel+Nee and vice versa.
  const allGens = Array.from(byGen.keys()).sort((a, b) => a - b);
  const orderedGens: number[] = [];
  if (byGen.has(0)) orderedGens.push(0);
  for (const g of allGens) if (g > 0) orderedGens.push(g); // ascending up
  for (const g of allGens.reverse()) if (g < 0) orderedGens.push(g); // descending down

  for (const gen of orderedGens) {
    const genNodes = byGen.get(gen)!;
    let ordered: FamilyGraphNode[];
    if (gen === 0) {
      ordered = orderNodesInGeneration(genNodes, graph);
    } else if (gen > 0) {
      // Parents — order by the average x of their children (who are
      // already placed below in a lower gen).
      ordered = orderParentGeneration(genNodes, graph, placed);
    } else {
      // Children — order by the average x of their parents (who are
      // already placed above). Spouses still stay adjacent.
      ordered = orderChildGeneration(genNodes, graph, placed);
    }
    const count = ordered.length;
    // X-positioning strategy depends on generation:
    //
    //   gen > 0 (ancestors) — try to sit each parent ABOVE their own
    //     children. We compute a desired x per parent (mean of their
    //     placed children's x), then walk left-to-right enforcing a
    //     minimum gap: spouseOffset between parents who share a child
    //     (partners stay close), nodeSpacing between unrelated parent
    //     groups. This stops a spouse's parents drifting sideways into
    //     another family's column (the "MD ends up above Terry" bug).
    //
    //   gen == 0 (focus row) or gen < 0 (descendants) — keep the
    //     evenly-spaced row layout. The focus row's ordering already
    //     handles spouse adjacency, and descendants we'll revisit once
    //     the ancestor layout is solid.
    if (gen > 0) {
      // Build children-by-parent restricted to THIS generation's nodes.
      const childrenByParent = new Map<number, number[]>();
      for (const e of graph.edges) {
        if (e.type !== 'parent_of') continue;
        if (!ordered.some(n => n.personId === e.aId)) continue;
        if (!placed.has(e.bId)) continue;
        if (!childrenByParent.has(e.aId)) childrenByParent.set(e.aId, []);
        childrenByParent.get(e.aId)!.push(e.bId);
      }
      const sharesAnyChild = (a: number, b: number): boolean => {
        const aKids = childrenByParent.get(a);
        const bKids = childrenByParent.get(b);
        if (!aKids || !bKids) return false;
        for (const k of aKids) if (bKids.includes(k)) return true;
        return false;
      };
      const desired = ordered.map(p => {
        const kids = childrenByParent.get(p.personId) ?? [];
        const xs = kids.map(k => placed.get(k)?.x).filter((x): x is number => x != null);
        if (xs.length === 0) return 0;
        return xs.reduce((a, b) => a + b, 0) / xs.length;
      });
      const placedX: number[] = [];
      for (let i = 0; i < ordered.length; i++) {
        const want = desired[i];
        if (i === 0) { placedX.push(want); continue; }
        const minGap = sharesAnyChild(ordered[i - 1].personId, ordered[i].personId)
          ? opts.spouseOffset
          : opts.nodeSpacing;
        placedX.push(Math.max(want, placedX[i - 1] + minGap));
      }
      // Bias-correct: if the whole row drifted (everything pushed right
      // by the overlap pass), slide it back so the centre of gravity
      // matches the desired centre. Only slides LEFT — never extends
      // beyond the natural desired positions.
      const desiredMean = desired.reduce((a, b) => a + b, 0) / desired.length;
      const actualMean  = placedX.reduce((a, b) => a + b, 0) / placedX.length;
      const drift = actualMean - desiredMean;
      if (drift > 0) for (let i = 0; i < placedX.length; i++) placedX[i] -= drift;
      ordered.forEach((node, i) => {
        placed.set(node.personId, {
          ...node,
          generation: gen,
          x: placedX[i],
          y: -gen * opts.rowHeight,
        });
      });
    } else {
      const totalWidth = (count - 1) * opts.nodeSpacing;
      const startX = -totalWidth / 2;
      ordered.forEach((node, i) => {
        placed.set(node.personId, {
          ...node,
          generation: gen,
          x: startX + i * opts.nodeSpacing,
          y: -gen * opts.rowHeight, // positive gen = older = up on screen (negative y)
        });
      });
    }
  }

  const laidOutNodes: LaidOutNode[] = Array.from(placed.values());
  const laidOutEdges: LaidOutEdge[] = graph.edges.map(e => ({
    ...e,
    visible: placed.has(e.aId) && placed.has(e.bId),
  }));

  const xs = laidOutNodes.map(n => n.x);
  const ys = laidOutNodes.map(n => n.y);
  const bounds = laidOutNodes.length === 0
    ? { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    : { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };

  return { focusPersonId: graph.focusPersonId, nodes: laidOutNodes, edges: laidOutEdges, bounds };
}

/**
 * Order a PARENT generation so each couple sits above their actual
 * children. We group parents by their child-set (so co-parents of the
 * same family stay adjacent), compute each group's "pull x" as the
 * average x of its children, and sort groups by that pull x.
 *
 * Example: Mel+Nee (kids on the left) get their parent pair on the left;
 * Terry+Colin (kids on the right) get their parent pair on the right.
 * No more crossed-over families.
 */
function orderParentGeneration(
  genNodes: FamilyGraphNode[],
  graph: FamilyGraph,
  placed: Map<number, LaidOutNode>
): FamilyGraphNode[] {
  if (genNodes.length <= 1) return genNodes;
  const idSet = new Set(genNodes.map(n => n.personId));
  const byId = new Map(genNodes.map(n => [n.personId, n] as const));

  // For each parent in this gen, collect their children (from the already-
  // placed lower generation).
  const childrenByParent = new Map<number, number[]>();
  for (const e of graph.edges) {
    if (e.type !== 'parent_of') continue;
    if (!idSet.has(e.aId)) continue;
    if (!childrenByParent.has(e.aId)) childrenByParent.set(e.aId, []);
    childrenByParent.get(e.aId)!.push(e.bId);
  }

  // Group parents by their child-set signature (same children = same family).
  const groupKey = (parentId: number): string => {
    const kids = childrenByParent.get(parentId) ?? [];
    return [...kids].sort((a, b) => a - b).join(',');
  };
  const groups = new Map<string, number[]>();
  for (const n of genNodes) {
    const k = groupKey(n.personId);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(n.personId);
  }

  // Pull x for a group = mean x of its children.
  const pullX = (parentIds: number[]): number => {
    if (parentIds.length === 0) return 0;
    const kids = childrenByParent.get(parentIds[0]) ?? [];
    const xs = kids.map(cid => placed.get(cid)?.x).filter((x): x is number => x != null);
    if (xs.length === 0) return 0;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };

  // Sort groups left-to-right by pull x; within a group, sort members
  // by the AGE of their parent_of edge to a shared child — earlier-
  // created edges go LEFT. This matches the user's mental model: the
  // placeholder slot you click on the LEFT was created first; when
  // you fill it with a person the person inherits that slot's
  // position regardless of whether the fill renamed the placeholder
  // (preserves person_id) or merged into a different existing person
  // (changes person_id but keeps the relationship row's id since
  // mergePlaceholderIntoPerson uses UPDATE not DELETE+INSERT).
  // Sorting by person_id alone broke the LEFT/RIGHT slot when a fresh
  // placeholder (small id) sat next to a freshly-typed person (much
  // larger id) — Terry's "I added grandad to the left placeholder
  // but he appeared on the right" bug.
  const earliestEdgeId = (parentId: number, childIds: number[]): number => {
    let minId = Number.MAX_SAFE_INTEGER;
    for (const childId of childIds) {
      for (const e of graph.edges) {
        if (e.derived) continue;
        if (e.type !== 'parent_of') continue;
        if (e.aId !== parentId || e.bId !== childId) continue;
        if (e.id != null && e.id < minId) minId = e.id;
      }
    }
    return minId;
  };
  const sortedGroupIds = Array.from(groups.values()).sort((a, b) => pullX(a) - pullX(b));
  const result: FamilyGraphNode[] = [];
  const seen = new Set<number>();
  for (const groupParentIds of sortedGroupIds) {
    const sharedKids = childrenByParent.get(groupParentIds[0]) ?? [];
    const inGroupOrder = [...groupParentIds].sort((a, b) => {
      const ea = earliestEdgeId(a, sharedKids);
      const eb = earliestEdgeId(b, sharedKids);
      if (ea !== eb) return ea - eb;
      // Last-resort tiebreak by person_id (covers the rare case where
      // edge ids are identical / both Number.MAX_SAFE_INTEGER).
      return a - b;
    });
    for (const pid of inGroupOrder) {
      if (seen.has(pid) || !byId.has(pid)) continue;
      seen.add(pid);
      result.push(byId.get(pid)!);
    }
  }
  // Any parents with no children in the placed set trail at the end —
  // sorted the same way for stability across refreshes.
  const trailing = genNodes.filter(n => !seen.has(n.personId)).sort((a, b) => a.personId - b.personId);
  for (const n of trailing) result.push(n);
  return result;
}

/**
 * Order a CHILD generation so each child sits under the midpoint of their
 * parents. Similar logic to orderParentGeneration but inverted.
 */
function orderChildGeneration(
  genNodes: FamilyGraphNode[],
  graph: FamilyGraph,
  placed: Map<number, LaidOutNode>
): FamilyGraphNode[] {
  if (genNodes.length <= 1) return genNodes;
  const byId = new Map(genNodes.map(n => [n.personId, n] as const));
  const pullX = (childId: number): number => {
    const parentXs = graph.edges
      .filter(e => e.type === 'parent_of' && e.bId === childId)
      .map(e => placed.get(e.aId)?.x)
      .filter((x): x is number => x != null);
    if (parentXs.length === 0) return 0;
    return parentXs.reduce((a, b) => a + b, 0) / parentXs.length;
  };
  // Tiebreaker: when two children have the same parent midpoint
  // (siblings sharing both parents), fall back to person_id ASC so
  // "first-created sits left" — matching the same rule used in
  // orderParentGeneration. Otherwise SQL row order leaks into the
  // layout and siblings can swap places between refreshes.
  return [...genNodes].sort((a, b) => {
    const dx = pullX(a.personId) - pullX(b.personId);
    if (dx !== 0) return dx;
    return a.personId - b.personId;
  });
}

/**
 * Decide a left-to-right order within a single generation.
 *
 * Strategy — for the generation that contains the focus person, lay them
 * out centred with SPOUSES to the left and SIBLINGS to the right. This
 * prevents sibling edges from being visually crossed by a partner who
 * happens to sit in the middle of the row (the classic "Mel between
 * Terry and Colin so the sibling line disappears behind her" bug).
 *
 * For other generations we just chain spouses adjacent and siblings
 * adjacent using a simple recursive walk — nowhere near perfect for big
 * trees, but acceptable until a proper pedigree algorithm lands.
 */
function orderNodesInGeneration(genNodes: FamilyGraphNode[], graph: FamilyGraph): FamilyGraphNode[] {
  if (genNodes.length <= 1) return genNodes;

  const idSet = new Set(genNodes.map(n => n.personId));
  const byId = new Map(genNodes.map(n => [n.personId, n] as const));
  const spouseMap = new Map<number, Set<number>>();
  const siblingMap = new Map<number, Set<number>>();

  const addUndirected = (map: Map<number, Set<number>>, a: number, b: number) => {
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a)!.add(b);
    map.get(b)!.add(a);
  };

  // Any two people who share at least one parent are siblings for layout
  // purposes, regardless of whether a direct sibling_of edge exists.
  const parentsByChild = new Map<number, Set<number>>();
  for (const e of graph.edges) {
    if (e.type !== 'parent_of') continue;
    if (!parentsByChild.has(e.bId)) parentsByChild.set(e.bId, new Set());
    parentsByChild.get(e.bId)!.add(e.aId);
  }
  const childIds = Array.from(parentsByChild.keys()).filter(id => idSet.has(id));
  for (let i = 0; i < childIds.length; i++) {
    for (let j = i + 1; j < childIds.length; j++) {
      const pa = parentsByChild.get(childIds[i])!;
      const pb = parentsByChild.get(childIds[j])!;
      let shared = false;
      for (const p of pa) { if (pb.has(p)) { shared = true; break; } }
      if (shared) addUndirected(siblingMap, childIds[i], childIds[j]);
    }
  }

  for (const e of graph.edges) {
    if (!idSet.has(e.aId) || !idSet.has(e.bId)) continue;
    if (e.type === 'spouse_of') addUndirected(spouseMap, e.aId, e.bId);
    else if (e.type === 'sibling_of') addUndirected(siblingMap, e.aId, e.bId);
  }

  const focusInThisGen = genNodes.find(n => n.personId === graph.focusPersonId);

  // Non-focus generations: simple recursive walk (siblings first to keep
  // siblings clustered together, then spouses).
  if (!focusInThisGen) {
    const placed = new Set<number>();
    const result: FamilyGraphNode[] = [];
    const walk = (pid: number) => {
      if (placed.has(pid) || !byId.has(pid)) return;
      placed.add(pid);
      result.push(byId.get(pid)!);
      for (const sib of siblingMap.get(pid) ?? []) walk(sib);
      for (const sp of spouseMap.get(pid) ?? []) walk(sp);
    };
    for (const n of genNodes) walk(n.personId);
    return result;
  }

  // Focus generation: centre the focus, spouses left, siblings right.
  const visited = new Set<number>([focusInThisGen.personId]);
  const leftChain: FamilyGraphNode[] = [];
  const rightChain: FamilyGraphNode[] = [];

  const pushSpouses = (pid: number) => {
    for (const sp of spouseMap.get(pid) ?? []) {
      if (visited.has(sp) || !byId.has(sp)) continue;
      visited.add(sp);
      leftChain.unshift(byId.get(sp)!); // prepend — each new spouse pushes existing left
      pushSpouses(sp);
      // ALSO the spouse's own siblings belong next to them, on the
      // far-left side of the row. Example: focus's partner Mel has a
      // sister Nee → want [Nee, Mel, Focus, ...] not [..., Focus, Mel, Nee].
      for (const sib of siblingMap.get(sp) ?? []) {
        if (!visited.has(sib) && byId.has(sib)) {
          visited.add(sib);
          leftChain.unshift(byId.get(sib)!);
          // Their spouses stick adjacent too.
          for (const sibSp of spouseMap.get(sib) ?? []) {
            if (!visited.has(sibSp) && byId.has(sibSp)) {
              visited.add(sibSp);
              leftChain.unshift(byId.get(sibSp)!);
            }
          }
        }
      }
    }
  };

  const pushSiblings = (pid: number) => {
    for (const sib of siblingMap.get(pid) ?? []) {
      if (visited.has(sib) || !byId.has(sib)) continue;
      visited.add(sib);
      rightChain.push(byId.get(sib)!);
      // Sibling's own spouse sits immediately next to them.
      for (const sibSp of spouseMap.get(sib) ?? []) {
        if (!visited.has(sibSp) && byId.has(sibSp)) {
          visited.add(sibSp);
          rightChain.push(byId.get(sibSp)!);
        }
      }
      pushSiblings(sib);
    }
  };

  pushSpouses(focusInThisGen.personId);
  pushSiblings(focusInThisGen.personId);

  // Stragglers (disconnected from focus) trail on the right.
  const stragglers = genNodes.filter(n => !visited.has(n.personId));

  return [...leftChain, focusInThisGen, ...rightChain, ...stragglers];
}

/**
 * Focus-explorer layout: same positions as pedigree, but tags nodes beyond
 * a hop threshold so the renderer can collapse or fade them.
 */
export function computeFocusLayout(
  graph: FamilyGraph,
  expandedHops: number,
  options: LayoutOptions = {}
): TreeLayout & { collapsedCountPerAnchor: Map<number, number> } {
  const base = computePedigreeLayout(graph, options);
  // Identify nodes whose hopsFromFocus > expandedHops → these are "beyond
  // the current horizon" and should be collapsed. Anchor each collapsed
  // node to its nearest expanded neighbour so the renderer can draw a
  // single "…N more" chevron per anchor instead of a forest of ghosts.
  const collapsed = new Map<number, number>(); // anchorPersonId → count
  for (const n of base.nodes) {
    if (n.hopsFromFocus > expandedHops) {
      // Pick the "most relevant" neighbour that IS within the horizon —
      // we walk edges and take the first one pointing at an expanded
      // node. Order doesn't much matter; UI just needs a stable anchor.
      const anchor = base.edges.find(e =>
        (e.aId === n.personId || e.bId === n.personId)
        && base.nodes.some(bn => {
          const other = e.aId === n.personId ? e.bId : e.aId;
          return bn.personId === other && bn.hopsFromFocus <= expandedHops;
        })
      );
      if (anchor) {
        const other = anchor.aId === n.personId ? anchor.bId : anchor.aId;
        collapsed.set(other, (collapsed.get(other) ?? 0) + 1);
      }
    }
  }
  return { ...base, collapsedCountPerAnchor: collapsed };
}
