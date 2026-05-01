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
    // Boundary-of-depth check used to skip ghost generation here.
    // Removed per Terry's feedback: even at the Steps / Generations
    // edge, an EMPTY parent slot needs its placeholder ghost so the
    // user has somewhere to click to add a real parent. Without it,
    // boundary cards painted a useless chevron above (or worse,
    // nothing at all) and offered no add-affordance — a regression
    // versus the old "click the ghost card to populate" UX.
    //
    // The real-parent overflow guard below (totalParentCount >
    // realParents.length) still prevents painting ghost slots above
    // people whose parents are STORED but just out-of-window — those
    // are the chevron's job.
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
          totalChildCount: 0,
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
      //
      // Compute drift over the subset of parents that ACTUALLY HAVE
      // PLACED CHILDREN — aunts / uncles in the same generation drag
      // the average right (they get pushed past Sally by the gap-
      // enforcement) and the correction would over-pull every parent
      // leftward, including the ones who do have kids. Result:
      // Terry's siblings sit centred at x=0 but Alan + Sally end up
      // off-centre on their left, so the kids look right-shifted
      // relative to their parents. Restricting the average to
      // parents-with-kids keeps THEIR midpoint above the kids'
      // midpoint while letting the kid-less parents drift to
      // wherever the gap-enforcement put them.
      const idxWithKids = ordered
        .map((_, i) => i)
        .filter(i => (childrenByParent.get(ordered[i].personId) ?? []).length > 0);
      const sliceFor = (arr: number[]): number[] =>
        idxWithKids.length > 0 ? idxWithKids.map(i => arr[i]) : arr;
      const desiredSubset = sliceFor(desired);
      const actualSubset = sliceFor(placedX);
      const desiredMean = desiredSubset.reduce((a, b) => a + b, 0) / desiredSubset.length;
      const actualMean  = actualSubset.reduce((a, b) => a + b, 0) / actualSubset.length;
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
    } else if (gen < 0) {
      // Descendant generation — group children by their parent-set
      // and centre each FAMILY under its own parents' midpoint, then
      // resolve overlaps left-to-right. Per-family centring (rather
      // than the row-wide drift correction the ancestor pass uses)
      // is what guarantees Lilly + Daisy sit symmetrically below
      // Colin, Elijah + Ethan symmetrically below Ben + Karen, Rex
      // symmetrically below Jenny + Dan, regardless of how far apart
      // those parent groups sit on the row.
      //
      // The previous attempt at this used a single uniform drift slide
      // across the whole row, which couldn't undo per-family pushing
      // — each family ended up with a partial nudge rather than its
      // own centre, and the misalignment got worse the wider the row.
      const parentsByChild = new Map<number, number[]>();
      for (const e of graph.edges) {
        if (e.type !== 'parent_of') continue;
        if (!ordered.some(n => n.personId === e.bId)) continue;
        if (!placed.has(e.aId)) continue;
        if (!parentsByChild.has(e.bId)) parentsByChild.set(e.bId, []);
        parentsByChild.get(e.bId)!.push(e.aId);
      }
      // Group children by sorted-parent-set signature. Children with
      // the same set of placed parents form one family that wants to
      // share a midpoint. Children with no placed parents (e.g.
      // partner-of-cousin landed in this row) get a unique key keyed
      // by their personId so they don't collide with any family.
      const groupKey = (childId: number): string => {
        const parents = (parentsByChild.get(childId) ?? []).slice().sort((a, b) => a - b);
        return parents.length > 0 ? parents.join(',') : `__solo_${childId}`;
      };
      type Group = { key: string; childIds: number[]; centre: number; hasParents: boolean };
      const groupsByKey = new Map<string, Group>();
      const groupOrder: Group[] = [];
      for (const c of ordered) {
        const key = groupKey(c.personId);
        let g = groupsByKey.get(key);
        if (!g) {
          const parents = parentsByChild.get(c.personId) ?? [];
          const xs = parents.map(p => placed.get(p)?.x).filter((x): x is number => x != null);
          const centre = xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
          g = { key, childIds: [], centre, hasParents: xs.length > 0 };
          groupsByKey.set(key, g);
          groupOrder.push(g);
        }
        g.childIds.push(c.personId);
      }
      // Sort families left-to-right by their desired centre. Ties
      // broken by group key for stability so siblings don't reshuffle
      // between renders.
      groupOrder.sort((a, b) => a.centre - b.centre || a.key.localeCompare(b.key));
      // Place each family centred at its desired X; if it would
      // overlap the previous family, shift right by just enough.
      // Within a family, siblings sit at spouseOffset spacing
      // (tighter than nodeSpacing) so they read as a tight cluster.
      // Between families, nodeSpacing keeps unrelated kids visually
      // separated.
      const placedX = new Map<number, number>();
      let prevRight = -Infinity;
      for (const g of groupOrder) {
        const span = (g.childIds.length - 1) * opts.spouseOffset;
        let leftEdge = g.centre - span / 2;
        if (prevRight !== -Infinity) {
          leftEdge = Math.max(leftEdge, prevRight + opts.nodeSpacing);
        }
        g.childIds.forEach((cid, i) => {
          placedX.set(cid, leftEdge + i * opts.spouseOffset);
        });
        prevRight = leftEdge + span;
      }
      ordered.forEach((node) => {
        const x = placedX.get(node.personId) ?? 0;
        placed.set(node.personId, {
          ...node,
          generation: gen,
          x,
          y: -gen * opts.rowHeight,
        });
      });
    } else {
      // Focus generation (gen 0) — initial pass uses evenly-spaced
      // layout as an anchor for the ancestor pass to centre over.
      // After ancestors are placed (later iterations of this loop),
      // we run a SECOND pass below that re-centres the focus row
      // under its newly-placed parents, using the same per-family
      // grouping the descendant pass uses. This is what gives Terry +
      // Colin + Amie a midpoint directly under Alan + Sally regardless
      // of how many cousins / in-laws also sit on the focus row.
      const totalWidth = (count - 1) * opts.nodeSpacing;
      const startX = -totalWidth / 2;
      ordered.forEach((node, i) => {
        placed.set(node.personId, {
          ...node,
          generation: gen,
          x: startX + i * opts.nodeSpacing,
          y: -gen * opts.rowHeight,
        });
      });
    }
  }

  // ── Second pass: re-centre EVERY generation under its placed
  // parents using per-family grouping. Top-down so each gen works
  // off the freshly-shifted positions of the gen above it.
  //
  // The rules baked in here are exactly what Terry's been asking
  // for, made unconditional:
  //  1. Each "family" (siblings sharing a parent-set) sits centred
  //     directly under its parents' midpoint.
  //  2. Partners stay glued — an in-law joins their bloodline
  //     spouse's family group so the couple stays a single block.
  //  3. Within a family group, ONLY the bloodline siblings count
  //     toward the midpoint — in-laws drift outward, so e.g. Alan
  //     sits to Sally's LEFT but Sally + Carol + Graham still sit
  //     centred under D + S, not nudged right by Alan's presence.
  //  4. When a person has both their own placed parents AND a
  //     partner with placed parents, they join whichever family has
  //     more siblings in this row — so Alan, who has only himself
  //     under G + D, joins Sally's D + S group rather than fragmenting
  //     the row.
  //  5. Sibling lines / brackets dynamically expand horizontally to
  //     fit the family, never the other way around.
  //
  // Top generation (max gen number) keeps its first-pass position —
  // it has no parents above to centre under.
  const allGensSorted = Array.from(byGen.keys()).sort((a, b) => b - a);
  const maxGen = allGensSorted[0];
  for (const gen of allGensSorted) {
    if (gen === maxGen) continue;
    const genNodes = byGen.get(gen)!;
    if (genNodes.length <= 1) continue;
    const genIds = new Set(genNodes.map(n => n.personId));

    // Each person's OWN placed parents (restricted to the gen
    // immediately above — gen+1 — so a great-grandparent visible in
    // gen+2 doesn't accidentally become an "anchor" for gen here).
    const parentsByChild = new Map<number, number[]>();
    for (const e of graph.edges) {
      if (e.type !== 'parent_of') continue;
      if (!genIds.has(e.bId)) continue;
      const parentNode = placed.get(e.aId);
      if (!parentNode || parentNode.generation !== gen + 1) continue;
      if (!parentsByChild.has(e.bId)) parentsByChild.set(e.bId, []);
      parentsByChild.get(e.bId)!.push(e.aId);
    }

    // Within-row spouse adjacency.
    const spouseMap = new Map<number, Set<number>>();
    for (const e of graph.edges) {
      if (e.type !== 'spouse_of') continue;
      if (!genIds.has(e.aId) || !genIds.has(e.bId)) continue;
      if (!spouseMap.has(e.aId)) spouseMap.set(e.aId, new Set());
      if (!spouseMap.has(e.bId)) spouseMap.set(e.bId, new Set());
      spouseMap.get(e.aId)!.add(e.bId);
      spouseMap.get(e.bId)!.add(e.aId);
    }

    // Count how many row members share a given parent-set key —
    // used as the tie-break when a person has both own and partner
    // parents available (Alan: G+D=1 vs D+S=3 → joins D+S).
    const familySize = new Map<string, number>();
    for (const c of genNodes) {
      const own = parentsByChild.get(c.personId);
      if (!own || own.length === 0) continue;
      const key = own.slice().sort((a, b) => a - b).join(',');
      familySize.set(key, (familySize.get(key) ?? 0) + 1);
    }

    const anchorKey = (pid: number): string => {
      type Cand = { key: string; size: number; isOwn: boolean };
      const cands: Cand[] = [];
      const own = parentsByChild.get(pid);
      if (own && own.length > 0) {
        const key = own.slice().sort((a, b) => a - b).join(',');
        cands.push({ key, size: familySize.get(key) ?? 1, isOwn: true });
      }
      for (const sp of spouseMap.get(pid) ?? []) {
        const spParents = parentsByChild.get(sp);
        if (!spParents || spParents.length === 0) continue;
        const key = spParents.slice().sort((a, b) => a - b).join(',');
        cands.push({ key, size: familySize.get(key) ?? 1, isOwn: false });
      }
      if (cands.length === 0) return `__solo_${pid}`;
      // Larger family wins; tie → own wins; tie again → key compare.
      cands.sort((a, b) =>
        b.size - a.size ||
        (a.isOwn === b.isOwn ? a.key.localeCompare(b.key) : a.isOwn ? -1 : 1)
      );
      return cands[0].key;
    };

    // Use first-pass x for stable in-family ordering — that's where
    // the spouses-first walk in orderNodesInGeneration glued
    // partners next to their bloodline counterpart.
    const orderedRow = genNodes
      .map(n => placed.get(n.personId))
      .filter((n): n is LaidOutNode => n != null)
      .sort((a, b) => a.x - b.x);

    type Group = { key: string; members: number[]; centre: number; bloodlineIdx: number[] };
    const groupsByKey = new Map<string, Group>();
    const groupOrder: Group[] = [];
    for (const node of orderedRow) {
      const key = anchorKey(node.personId);
      let g = groupsByKey.get(key);
      if (!g) {
        let centre = node.x;
        if (!key.startsWith('__solo_')) {
          const parentIds = key.split(',').map(Number);
          const xs = parentIds.map(p => placed.get(p)?.x).filter((x): x is number => x != null);
          if (xs.length > 0) centre = xs.reduce((a, b) => a + b, 0) / xs.length;
        }
        g = { key, members: [], centre, bloodlineIdx: [] };
        groupsByKey.set(key, g);
        groupOrder.push(g);
      }
      const memberIdx = g.members.length;
      g.members.push(node.personId);
      // Bloodline iff this person's OWN parent-set matches the
      // group's parent-set. In-laws (joined via partner) get skipped
      // for the midpoint computation — they drift outward instead.
      if (!key.startsWith('__solo_')) {
        const own = parentsByChild.get(node.personId);
        if (own && own.length > 0) {
          const ownKey = own.slice().sort((a, b) => a - b).join(',');
          if (ownKey === key) g.bloodlineIdx.push(memberIdx);
        }
      }
    }

    groupOrder.sort((a, b) => a.centre - b.centre || a.key.localeCompare(b.key));

    // RULE: siblings stay tight. Every member of a family group sits
    // exactly `spouseOffset` from the next, whether the adjacency is
    // couple-couple (Alan + Sally), couple-sibling (Sally + Carol),
    // or sibling-sibling (Carol + Graham). No subtree-width-driven
    // spreading — Terry's preference is the visual where Sally and
    // Carol sit shoulder-to-shoulder under D + S, with their
    // descendant families below shifted as needed to fit. That
    // shifting happens automatically in the descendant pass; this
    // pass focuses on parent-row tightness.
    const newX = new Map<number, number>();
    let prevRight = -Infinity;
    for (const g of groupOrder) {
      const offsets: number[] = [];
      for (let i = 0; i < g.members.length; i++) {
        offsets.push(i * opts.spouseOffset);
      }
      let leftEdge: number;
      if (g.bloodlineIdx.length > 0) {
        const meanOffset = g.bloodlineIdx
          .map(i => offsets[i])
          .reduce((a, b) => a + b, 0) / g.bloodlineIdx.length;
        leftEdge = g.centre - meanOffset;
      } else {
        const meanOffset = offsets.reduce((a, b) => a + b, 0) / offsets.length;
        leftEdge = g.centre - meanOffset;
      }
      if (prevRight !== -Infinity) {
        leftEdge = Math.max(leftEdge, prevRight + opts.nodeSpacing);
      }
      g.members.forEach((mid, i) => {
        newX.set(mid, leftEdge + offsets[i]);
      });
      prevRight = leftEdge + offsets[offsets.length - 1];
    }
    for (const node of genNodes) {
      const x = newX.get(node.personId);
      if (x == null) continue;
      const existing = placed.get(node.personId);
      if (!existing) continue;
      placed.set(node.personId, { ...existing, x });
    }
  }

  // ── Third pass: bottom-up ancestor recentring.
  // The top-down pass above shifted gen +1 (Alan, Sally, Carol,
  // Graham) under their parents in gen +2 — but gen +2 itself was
  // placed BEFORE gen +1 moved, leaving great-grandparents stranded
  // at gen +1's old positions. So once Alan slides left to sit
  // adjacent to Sally, his parents Grandad Filmer + Dorothy still
  // hover above where Alan USED to be, miles from where he is now.
  //
  // Walk back UP and re-centre each ancestor over their (now-
  // shifted) children. This mirrors the first-pass ancestor
  // centring math but reads from the post-shift positions, so
  // every parent stays directly above its kids' midpoint.
  for (const gen of allGensSorted.slice().reverse()) {
    if (gen <= 0) continue;
    const genNodes = byGen.get(gen)!;
    if (genNodes.length === 0) continue;
    // For each parent in this gen, the placed children below.
    const childrenByParent = new Map<number, number[]>();
    for (const e of graph.edges) {
      if (e.type !== 'parent_of') continue;
      const parentNode = placed.get(e.aId);
      if (!parentNode || parentNode.generation !== gen) continue;
      if (!placed.has(e.bId)) continue;
      if (!childrenByParent.has(e.aId)) childrenByParent.set(e.aId, []);
      childrenByParent.get(e.aId)!.push(e.bId);
    }
    // Sort genNodes by current x so adjacency is preserved.
    const sorted = genNodes
      .map(n => placed.get(n.personId))
      .filter((n): n is LaidOutNode => n != null)
      .sort((a, b) => a.x - b.x);
    if (sorted.length === 0) continue;

    // ── Per-family centring (replaces the row-wide bias shift) ──────────
    // Group parents by their kid-set signature. Every parent who shares
    // the SAME set of placed kids forms one family group whose desired
    // centre is that kid-set's midpoint. Patricia / Peter (no placed
    // kids = aunts/uncles of focus whose own children are hidden in
    // panels) and other kid-less in-laws form per-person solo groups
    // that just keep their current x — they fill the gap between the
    // kid-having groups without dragging the average.
    //
    // Each kid-having group is then centred at its OWN desired,
    // groups laid out left-to-right with nodeSpacing between them.
    // Net effect: Alan+Sally sit above Terry+Colin+Amie's midpoint
    // AND Carol+Graham sit above Ben+Jenny's midpoint — independent
    // of how far apart those two kid groups are. Replaces the old
    // single-shift bias correction which averaged the two desired
    // centres and put NEITHER family directly above its kids when
    // both were in the same row.
    type FamilyGroup = {
      key: string;
      members: number[];
      desired: number;
      hasKids: boolean;
    };
    const groupsByKey = new Map<string, FamilyGroup>();
    const groupOrder: FamilyGroup[] = [];
    for (const node of sorted) {
      const kids = childrenByParent.get(node.personId) ?? [];
      const hasKids = kids.length > 0;
      // Solo key for kid-less people — keeps each in their own slot,
      // sorted by current x so adjacency / order from earlier passes
      // is preserved.
      const key = hasKids
        ? [...kids].sort((a, b) => a - b).join(',')
        : `__solo_${node.personId}`;
      let g = groupsByKey.get(key);
      if (!g) {
        let desiredCentre = node.x;
        if (hasKids) {
          const xs = kids.map(k => placed.get(k)?.x).filter((x): x is number => x != null);
          if (xs.length > 0) desiredCentre = xs.reduce((a, b) => a + b, 0) / xs.length;
        }
        g = { key, members: [], desired: desiredCentre, hasKids };
        groupsByKey.set(key, g);
        groupOrder.push(g);
      }
      g.members.push(node.personId);
    }

    // Sort groups left-to-right by desired centre. Stable tiebreak on
    // group key so equal-desired groups keep a deterministic order
    // across renders.
    groupOrder.sort((a, b) => a.desired - b.desired || a.key.localeCompare(b.key));

    // Place each group — kid-having groups centre on their desired,
    // solo (kid-less) groups are placed at the kid-less node's
    // existing position. nodeSpacing enforced between adjacent
    // groups so the row reads cleanly left-to-right.
    const newX = new Map<number, number>();
    let prevRight = -Infinity;
    for (const g of groupOrder) {
      const groupSize = g.members.length;
      const halfSpan = (groupSize - 1) * opts.spouseOffset / 2;
      let leftEdge = g.desired - halfSpan;
      if (prevRight !== -Infinity) {
        leftEdge = Math.max(leftEdge, prevRight + opts.nodeSpacing);
      }
      g.members.forEach((pid, i) => {
        newX.set(pid, leftEdge + i * opts.spouseOffset);
      });
      prevRight = leftEdge + (groupSize - 1) * opts.spouseOffset;
    }

    sorted.forEach((node) => {
      const x = newX.get(node.personId);
      if (x == null) return;
      placed.set(node.personId, { ...node, x });
    });
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

  // ── Focus-parent ordering rule (Terry's pathway preference) ────────────
  // When this generation contains focus's direct parents, apply a
  // specific ordering rule:
  //   * Father (the focus parent on the LEFT of the pair) sits at the
  //     RIGHTMOST of his sibling group — paternal aunts/uncles sit to
  //     HIS left, with each aunt/uncle's in-law spouse further left
  //     still (outermost = furthest from focus).
  //   * Mother (the focus parent on the RIGHT of the pair) sits at
  //     the LEFTMOST of her sibling group — maternal aunts/uncles
  //     sit to HER right, with each aunt/uncle's in-law spouse
  //     further right still.
  // Net effect: father and mother stay adjacent in the middle, each
  // parent's siblings fan OUTWARD from them, and in-law spouses are
  // further out still — no overlap with the other parent's family,
  // and the row reads left-to-right as one unbroken pathway.
  const focusParentIds: number[] = [];
  for (const e of graph.edges) {
    if (e.type !== 'parent_of') continue;
    if (e.bId !== graph.focusPersonId) continue;
    if (!idSet.has(e.aId)) continue;
    if (!focusParentIds.includes(e.aId)) focusParentIds.push(e.aId);
  }
  if (focusParentIds.length > 0) {
    // Sort focus's parents by pull-X (then earliest edge to focus,
    // then person_id). This identifies which is on the LEFT vs RIGHT.
    const pullXOf = (pid: number): number => {
      const kids = childrenByParent.get(pid) ?? [];
      const xs = kids.map(k => placed.get(k)?.x).filter((x): x is number => x != null);
      if (xs.length === 0) return 0;
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    const earliestEdgeIdToFocus = (pid: number): number => {
      let minId = Number.MAX_SAFE_INTEGER;
      for (const e of graph.edges) {
        if (e.derived) continue;
        if (e.type !== 'parent_of') continue;
        if (e.aId !== pid || e.bId !== graph.focusPersonId) continue;
        if (e.id != null && e.id < minId) minId = e.id;
      }
      return minId;
    };
    const sortedFocusParents = [...focusParentIds].sort((a, b) => {
      const dx = pullXOf(a) - pullXOf(b);
      if (dx !== 0) return dx;
      const ea = earliestEdgeIdToFocus(a) - earliestEdgeIdToFocus(b);
      if (ea !== 0) return ea;
      return a - b;
    });
    const leftFP = sortedFocusParents[0];
    const rightFP = sortedFocusParents[sortedFocusParents.length - 1];
    const focusParentSet = new Set(focusParentIds);

    // Find each focus parent's siblings — others in this gen who
    // share at least one parent (= focus's grandparent) with the
    // focus parent. Excludes the OTHER focus parent (if both share
    // grandparents, that's a different topology we don't handle).
    const findSiblings = (parentId: number): number[] => {
      const grandparentIds = new Set<number>();
      for (const e of graph.edges) {
        if (e.type !== 'parent_of') continue;
        if (e.bId !== parentId) continue;
        grandparentIds.add(e.aId);
      }
      const sibs = new Set<number>();
      for (const e of graph.edges) {
        if (e.type !== 'parent_of') continue;
        if (!grandparentIds.has(e.aId)) continue;
        if (e.bId === parentId) continue;
        if (focusParentSet.has(e.bId)) continue;
        if (idSet.has(e.bId)) sibs.add(e.bId);
      }
      return [...sibs];
    };
    const leftSibs = findSiblings(leftFP);
    const rightSibs = leftFP === rightFP ? [] : findSiblings(rightFP);

    // For each aunt/uncle, find the in-law spouse(s) in this gen.
    // (Spouses who are themselves bloodline don't get the in-law
    // outermost treatment — they'd be focus's other relatives.)
    const findInLawSpouses = (auntUncleId: number): number[] => {
      const spouses: number[] = [];
      for (const e of graph.edges) {
        if (e.type !== 'spouse_of') continue;
        let other: number | null = null;
        if (e.aId === auntUncleId) other = e.bId;
        else if (e.bId === auntUncleId) other = e.aId;
        if (other == null) continue;
        if (other === auntUncleId) continue;
        if (focusParentSet.has(other)) continue;
        if (!idSet.has(other)) continue;
        if (!spouses.includes(other)) spouses.push(other);
      }
      return spouses;
    };

    // Build the ordered list. Stable tiebreak on aunt/uncle order:
    // sort by person_id so the layout doesn't reshuffle between
    // refreshes. (Could swap to earliest-edge later if Terry asks.)
    const used = new Set<number>();
    const orderedIds: number[] = [];
    const sortedLeftSibs = [...leftSibs].sort((a, b) => a - b);
    for (const auntUncleId of sortedLeftSibs) {
      // In-law spouse(s) outermost (furthest from focus parent),
      // then the bloodline aunt/uncle adjacent to leftFP.
      for (const spId of findInLawSpouses(auntUncleId)) {
        if (!used.has(spId)) { used.add(spId); orderedIds.push(spId); }
      }
      if (!used.has(auntUncleId)) { used.add(auntUncleId); orderedIds.push(auntUncleId); }
    }
    if (!used.has(leftFP)) { used.add(leftFP); orderedIds.push(leftFP); }
    if (rightFP !== leftFP && !used.has(rightFP)) { used.add(rightFP); orderedIds.push(rightFP); }
    const sortedRightSibs = [...rightSibs].sort((a, b) => a - b);
    for (const auntUncleId of sortedRightSibs) {
      // Bloodline aunt/uncle adjacent to rightFP, in-law spouse(s)
      // outermost (furthest from focus parent).
      if (!used.has(auntUncleId)) { used.add(auntUncleId); orderedIds.push(auntUncleId); }
      for (const spId of findInLawSpouses(auntUncleId)) {
        if (!used.has(spId)) { used.add(spId); orderedIds.push(spId); }
      }
    }
    // Anyone still unplaced (extra focus parents from a second
    // marriage, edge cases) trail at the end stable-sorted.
    for (const n of [...genNodes].sort((a, b) => a.personId - b.personId)) {
      if (!used.has(n.personId)) { used.add(n.personId); orderedIds.push(n.personId); }
    }
    return orderedIds.map(id => byId.get(id)!).filter((n): n is FamilyGraphNode => n != null);
  }
  // ────────────────────────────────────────────────────────────────────────

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

  // ALSO treat implicit co-parents (two people in this generation
  // who share a child) as spouses for LAYOUT purposes — even when
  // no spouse_of edge exists between them. Without this, an
  // unmarried co-parent (or a ghost placeholder added because the
  // child only has one named parent) ends up as a "straggler" at
  // the end of the row instead of sitting next to the parent
  // they share a child with. Terry's case: he adds Lilly as
  // Colin's child, the augmenter adds a ghost for Lilly's other
  // parent, and that ghost should sit between Colin and Amie —
  // not far right past Amie.
  const childrenByParentInGen = new Map<number, Set<number>>();
  for (const e of graph.edges) {
    if (e.type !== 'parent_of') continue;
    if (!idSet.has(e.aId)) continue;
    if (!childrenByParentInGen.has(e.aId)) childrenByParentInGen.set(e.aId, new Set());
    childrenByParentInGen.get(e.aId)!.add(e.bId);
  }
  const parentIdsInGen = Array.from(childrenByParentInGen.keys());
  for (let i = 0; i < parentIdsInGen.length; i++) {
    for (let j = i + 1; j < parentIdsInGen.length; j++) {
      const aKids = childrenByParentInGen.get(parentIdsInGen[i])!;
      const bKids = childrenByParentInGen.get(parentIdsInGen[j])!;
      let shared = false;
      for (const k of aKids) { if (bKids.has(k)) { shared = true; break; } }
      if (shared) addUndirected(spouseMap, parentIdsInGen[i], parentIdsInGen[j]);
    }
  }

  const focusInThisGen = genNodes.find(n => n.personId === graph.focusPersonId);

  // Non-focus generations: simple recursive walk. CRITICAL ordering:
  // SPOUSES first, THEN siblings. Walking siblings first produces
  // sequences like [Ben, Jenny (Ben's sister), Dan (Jenny's husband),
  // Karen (Ben's wife)] — Ben's wife ends up four columns away from
  // him because Jenny and her spouse jumped the queue. Spouses-first
  // means each person is immediately followed by their partner, then
  // their sibling chain, so partners stay glued: [Ben, Karen, Jenny,
  // Dan]. This is the unconditional rule Terry asked for — partners
  // adjacent, period, even if it shifts other cards along.
  if (!focusInThisGen) {
    const placed = new Set<number>();
    const result: FamilyGraphNode[] = [];
    const walk = (pid: number) => {
      if (placed.has(pid) || !byId.has(pid)) return;
      placed.add(pid);
      result.push(byId.get(pid)!);
      for (const sp of spouseMap.get(pid) ?? []) walk(sp);
      for (const sib of siblingMap.get(pid) ?? []) walk(sib);
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

  // Stragglers — anyone in this generation not directly tied to focus
  // by sibling or spouse edges (cousins, in-laws of cousins, etc.).
  // We can't just dump them in graph-node order: that's the bug that
  // put Ben's wife Karen four columns away from Ben because the raw
  // node list happened to come back as [Ben, Jenny, Dan, Karen]. Run
  // the same SPOUSES-FIRST recursive walk over the stragglers so each
  // person is immediately followed by their partner, then their
  // sibling chain — same rule the non-focus branch enforces, applied
  // consistently here so partners stay glued no matter where they
  // sit in the row.
  const stragglerNodes = genNodes.filter(n => !visited.has(n.personId));
  const stragglerPlaced = new Set<number>();
  const stragglerOrdered: FamilyGraphNode[] = [];
  const stragglerWalk = (pid: number) => {
    if (stragglerPlaced.has(pid) || !byId.has(pid)) return;
    if (visited.has(pid)) return; // belongs to focus / sibling chain — already in result
    stragglerPlaced.add(pid);
    stragglerOrdered.push(byId.get(pid)!);
    for (const sp of spouseMap.get(pid) ?? []) stragglerWalk(sp);
    for (const sib of siblingMap.get(pid) ?? []) stragglerWalk(sib);
  };
  for (const n of stragglerNodes) stragglerWalk(n.personId);

  return [...leftChain, focusInThisGen, ...rightChain, ...stragglerOrdered];
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
