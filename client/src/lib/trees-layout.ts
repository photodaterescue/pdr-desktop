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
  /** True when this node takes a real slot on the main canvas (bloodline +
   *  their on-canvas spouses). False for PARKED nodes — in-law families that
   *  the renderer shows in floating side-panels, not inline. Lets the layout
   *  invariant suite check only what's actually drawn on the canvas. */
  slotted?: boolean;
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
export function computePedigreeLayout(graph: FamilyGraph, options: LayoutOptions = {}, expandedHeads: Set<number> = new Set(), collapsedDirect: Set<number> = new Set()): TreeLayout {
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

  // ── Panel-only set (`panelledIds`) ──────────────────────────────
  // Side-branch DESCENDANTS — cousins / their partners / their kids,
  // i.e. everyone whose only on-screen home is a chevron-opened
  // panel above an aunt/uncle. The third-pass uses this to filter a
  // parent's kids down to "kids that are visible on canvas" so the
  // parent's desired centre is dragged only by visible kids — never
  // by panelled subtree midpoints. The aunt/uncle themselves
  // (side-branch HEADS) are NOT in this set; they sit on canvas as
  // siblings of focus's parents and ARE counted for centring (so
  // Grandad + Dorothy get pulled over the midpoint of all their
  // bloodline kids — Alan + Patricia + Peter — not just Alan).
  const panelledIds = (() => {
    const childrenOf = new Map<number, number[]>();
    const parentsOf = new Map<number, number[]>();
    for (const e of graph.edges) {
      if (e.type !== 'parent_of') continue;
      if (!childrenOf.has(e.aId)) childrenOf.set(e.aId, []);
      childrenOf.get(e.aId)!.push(e.bId);
      if (!parentsOf.has(e.bId)) parentsOf.set(e.bId, []);
      parentsOf.get(e.bId)!.push(e.aId);
    }
    const focusId = graph.focusPersonId;
    // Strict ancestors of focus (excluding focus).
    const strictAncestors = new Set<number>();
    {
      const upQ = [focusId];
      while (upQ.length) {
        const cur = upQ.shift()!;
        for (const p of parentsOf.get(cur) ?? []) {
          if (strictAncestors.has(p)) continue;
          strictAncestors.add(p);
          upQ.push(p);
        }
      }
    }
    // Direct line that should NEVER be marked panelled — focus + its
    // strict ancestors + focus's siblings + descendants of focus +
    // descendants of focus's siblings (nieces / nephews etc.). Used
    // to guard against accidentally hiding a niece who descends via
    // two paths (cousin marriage etc.).
    const directLine = new Set<number>([focusId, ...strictAncestors]);
    {
      const downQ = [focusId];
      while (downQ.length) {
        const cur = downQ.shift()!;
        for (const c of childrenOf.get(cur) ?? []) {
          if (directLine.has(c)) continue;
          directLine.add(c);
          downQ.push(c);
        }
      }
      const focusParents = parentsOf.get(focusId) ?? [];
      const sibQ: number[] = [];
      for (const fp of focusParents) {
        for (const c of childrenOf.get(fp) ?? []) {
          if (c === focusId) continue;
          if (directLine.has(c)) continue;
          directLine.add(c);
          sibQ.push(c);
        }
      }
      while (sibQ.length) {
        const cur = sibQ.shift()!;
        for (const c of childrenOf.get(cur) ?? []) {
          if (directLine.has(c)) continue;
          directLine.add(c);
          sibQ.push(c);
        }
      }
    }
    // Side-branch heads = siblings of every strict ancestor (children
    // of strict ancestors' parents, excluding the ancestor + focus).
    const heads = new Set<number>();
    for (const a of strictAncestors) {
      for (const p of parentsOf.get(a) ?? []) {
        for (const c of childrenOf.get(p) ?? []) {
          if (c === a) continue;
          if (c === focusId) continue;
          if (strictAncestors.has(c)) continue;
          heads.add(c);
        }
      }
    }
    // Also: great-aunts/uncles linked to a strict ancestor only via a derived
    // sibling_of edge (shared parent is a stripped placeholder) — Terry r437.
    // Mirror of the canvas head detection so a collapsed Gladys's child Marion
    // is PANELLED (not slotted) instead of placed inline + spreading her out.
    for (const e of graph.edges) {
      if (e.type !== 'sibling_of') continue;
      if (strictAncestors.has(e.aId) && e.bId !== focusId && !strictAncestors.has(e.bId)) heads.add(e.bId);
      if (strictAncestors.has(e.bId) && e.aId !== focusId && !strictAncestors.has(e.aId)) heads.add(e.aId);
    }
    // Walk DOWN from each head; collect descendants that aren't in
    // directLine (so cousin-marriage / half-relations don't get
    // accidentally marked panelled).
    const hidden = new Set<number>();
    for (const head of heads) {
      // PER-LEVEL (Terry r439): a node's children are SHOWN only when the node
      // itself is expanded. The head's children appear iff the head is in
      // expandedHeads; THEIR children iff they too are expanded; and everything
      // beneath a collapsed node stays hidden regardless of its own flag
      // (hiddenAbove carries that down). This replaces the old all-or-nothing
      // "expanded head reveals its whole branch" so the user can open the tree
      // one generation at a time.
      const q: { id: number; hiddenAbove: boolean }[] = [{ id: head, hiddenAbove: false }];
      const seen = new Set<number>([head]);
      while (q.length) {
        const { id: cur, hiddenAbove } = q.shift()!;
        const curOpen = expandedHeads.has(cur);
        for (const c of childrenOf.get(cur) ?? []) {
          if (seen.has(c)) continue;
          seen.add(c);
          if (directLine.has(c)) continue;
          const cHidden = hiddenAbove || !curOpen;
          if (cHidden) hidden.add(c);
          q.push({ id: c, hiddenAbove: cHidden });
        }
      }
    }
    // Direct-line collapse (Terry r440): the default-OPEN downward direct line
    // (focus's descendants, siblings + their descendants) is collapsible too —
    // "all offspring should have the chevron, even my own direct family". When
    // the user collapses such a node, panel its WHOLE subtree away so the row
    // closes up with no empty slot. Never the strict ancestors (the upward
    // spine has no collapse control). Mirror in TreesCanvas hiddenSideBranchIds.
    for (const start of collapsedDirect) {
      if (strictAncestors.has(start) || !directLine.has(start)) continue;
      const q = [...(childrenOf.get(start) ?? [])];
      const seen = new Set<number>([start]);
      while (q.length) {
        const cur = q.shift()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        hidden.add(cur);
        for (const c of childrenOf.get(cur) ?? []) q.push(c);
      }
    }
    // Sweep spouse_of edges so non-bloodline partners of any hidden
    // descendant come along (otherwise they linger on canvas while
    // their spouse + kids are tucked inside the panel).
    for (const e of graph.edges) {
      if (e.type !== 'spouse_of') continue;
      if (hidden.has(e.aId) && !directLine.has(e.bId) && !heads.has(e.bId)) hidden.add(e.bId);
      if (hidden.has(e.bId) && !directLine.has(e.aId) && !heads.has(e.aId)) hidden.add(e.aId);
    }
    return hidden;
  })();

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

  {
    // ───────────────────────────────────────────────────────────────
    // X-COORDINATE ASSIGNMENT — tidy, compact, balanced (Terry r421).
    //
    // Replaces the old averaging + cascade passes. The first pass above
    // already fixed each node's GENERATION, within-row ORDER and Y; this
    // recomputes every X with a principled layered-graph method so that:
    //   • only canvas-visible nodes take a horizontal slot — panelled
    //     cousins / collapsed side-branches are PARKED on their nearest
    //     visible relative, so they never open a phantom gap in a row nor
    //     inflate the navigable bounds (which forced the zoom right out);
    //   • every parent sits over the SPAN of its own visible children
    //     (not the average of the whole row → no ancestors stranded in
    //     the empty middle, no lines stretching across to reach kids);
    //   • branches pack as tight as the min-gap allows (no dead space);
    //   • result is symmetric + deterministic (no crossing parent paths).
    //
    // Method: layers = generations (fixed); order within a layer = fixed
    // (from the first pass). Iterate up/down sweeps; each sweep sets every
    // node's desired X to the mean of its already-placed neighbours in the
    // adjacent layer, then solves the per-layer "sit at desired, honour
    // the min-gaps" problem OPTIMALLY via pool-adjacent-violators (an
    // isotonic regression). Converges to a compact, centred tree — the
    // standard, well-understood approach for this exact problem.
    const focusId = graph.focusPersonId;
    const pushMap = (m: Map<number, number[]>, k: number, v: number) => {
      const a = m.get(k); if (a) a.push(v); else m.set(k, [v]);
    };
    const parentsOf = new Map<number, number[]>();
    const childrenOf = new Map<number, number[]>();
    const spousesOf = new Map<number, number[]>();
    for (const e of graph.edges) {
      if (e.type === 'parent_of') { pushMap(childrenOf, e.aId, e.bId); pushMap(parentsOf, e.bId, e.aId); }
      else if (e.type === 'spouse_of') { pushMap(spousesOf, e.aId, e.bId); pushMap(spousesOf, e.bId, e.aId); }
    }

    // Canvas-visible set: the focus's BLOODLINE + the direct SPOUSES of every
    // bloodline person. Bloodline = focus + its ancestors (walk parent_of UP)
    // + everyone descended from the focus OR one of those ancestors (walk
    // childrenOf DOWN). We must NOT walk parent_of UP from a down-reached
    // node: a cousin has two parents — one bloodline, one married-IN — and
    // ascending to the married-in parent would drag their ENTIRE family
    // (siblings, parents, nieces…) in as bogus "bloodline", padding the focus
    // row with invisible slots that fling the real cousins apart (Terry: Amie
    // stranded, Patricia's offspring flung wide). sibling_of is followed to
    // catch a blood sibling whose shared parent is an unshared ghost
    // (great-aunts/uncles). In-law families attach only via spouse_of, so they
    // never enter the bloodline and stay parked → floating panels.
    const siblingsOf = new Map<number, number[]>();
    for (const e of graph.edges) {
      if (e.type === 'sibling_of') { pushMap(siblingsOf, e.aId, e.bId); pushMap(siblingsOf, e.bId, e.aId); }
    }
    const ancestors = new Set<number>();
    {
      const q = [focusId];
      while (q.length) {
        const c = q.shift()!;
        for (const p of parentsOf.get(c) ?? []) if (!ancestors.has(p)) { ancestors.add(p); q.push(p); }
      }
    }
    const bloodline = new Set<number>([focusId, ...ancestors]);
    {
      const q = [focusId, ...ancestors];
      while (q.length) {
        const c = q.shift()!;
        for (const k of childrenOf.get(c) ?? []) if (!bloodline.has(k)) { bloodline.add(k); q.push(k); }
        for (const s of siblingsOf.get(c) ?? []) if (!bloodline.has(s)) { bloodline.add(s); q.push(s); }
      }
    }
    const visible = new Set<number>(bloodline);
    for (const id of bloodline) for (const sp of spousesOf.get(id) ?? []) visible.add(sp);

    const isSlotted = (id: number) => placed.has(id) && visible.has(id) && !panelledIds.has(id);

    // Per-generation ordered list of SLOTTED nodes (order taken from the
    // first pass's x, so spouse/sibling adjacency is preserved).
    const gensSorted = Array.from(byGen.keys()).sort((a, b) => a - b);
    const slottedByGen = new Map<number, number[]>();
    for (const g of gensSorted) {
      const ids = (byGen.get(g) ?? [])
        .map(n => n.personId)
        .filter(isSlotted)
        .sort((a, b) => (placed.get(a)!.x - placed.get(b)!.x) || (a - b));
      slottedByGen.set(g, ids);
    }

    // Order each DESCENDANT row to follow its PARENT row's left-to-right
    // order, so a cousin branch lands UNDER its own parent instead of being
    // dumped at the row's end (Terry r428). The first pass orders the focus
    // generation as [spouses, focus, siblings, …cousins-as-stragglers], which
    // appends every expanded cousin on the far right regardless of which
    // parent they belong to — so expanding a paternal uncle whose slot sits
    // LEFT of the focus's parent flung his kids to the right and crossed the
    // focus's own family. We re-sort top-down (parents are ordered before
    // their children) by each node's parent's INDEX in the row above (couples
    // keyed by their leftmost parent; a spouse with no parent of their own
    // borrows their partner's). Ties keep first-pass order, so couples and
    // sibling sub-order are preserved.
    for (const g of gensSorted.filter(x => x <= 0).sort((a, b) => b - a)) {
      const ids = slottedByGen.get(g);
      if (!ids || ids.length < 2) continue;
      const parentRow = slottedByGen.get(g + 1) ?? [];
      if (parentRow.length === 0) continue;
      const pIndex = new Map<number, number>();
      parentRow.forEach((pid, i) => pIndex.set(pid, i));
      const keyOf = (id: number): number => {
        let best = Infinity;
        for (const p of parentsOf.get(id) ?? []) { const idx = pIndex.get(p); if (idx != null && idx < best) best = idx; }
        if (best === Infinity) for (const sp of spousesOf.get(id) ?? []) for (const p of parentsOf.get(sp) ?? []) { const idx = pIndex.get(p); if (idx != null && idx < best) best = idx; }
        return best;
      };
      const decorated = ids.map((id, i) => ({ id, k: keyOf(id), i }));
      decorated.sort((a, b) => (a.k - b.k) || (a.i - b.i));
      // Couple-adjacency (Terry 2026-06-26 — the couples-split bug): drop each
      // married-in (non-bloodline) spouse immediately AFTER their bloodline
      // partner. Without this a sibling tiebreaks in between (Colin|Amie|Lindsay)
      // — especially when the in-law has her own parked family, which keys her
      // by her partner but leaves her first-pass x out by her parked parents.
      const ordered = decorated.map(d => d.id);
      const genSet = new Set(ordered);
      const paired: number[] = [];
      const seenPair = new Set<number>();
      // Pass 1: walk the BLOODLINE nodes in order, each immediately followed by
      // their married-in spouse(s). Iterating bloodline-first (not just "first
      // seen") is essential — otherwise an in-law who happens to sort ahead of
      // their partner (Karen before Ben) gets emitted alone and the couple stays
      // interleaved (Karen|Dan|Ben|Jenny). Skipping in-laws here lets them be
      // pulled in beside their partner instead.
      for (const id of ordered) {
        if (seenPair.has(id) || !bloodline.has(id)) continue;
        paired.push(id); seenPair.add(id);
        for (const sp of spousesOf.get(id) ?? []) {
          if (!seenPair.has(sp) && genSet.has(sp) && !bloodline.has(sp)) { paired.push(sp); seenPair.add(sp); }
        }
      }
      // Pass 2: leftovers (in-laws whose partner isn't in this row, all-in-law
      // rows) keep their order so nothing is dropped.
      for (const id of ordered) if (!seenPair.has(id)) { paired.push(id); seenPair.add(id); }
      slottedByGen.set(g, paired);
    }

    // ── GLOBAL couple-adjacency GUARANTEE (Terry 2026-06-26) ──────────────
    // No matter the focus or the generation, a couple is NEVER split by a
    // sibling. The parent-keyed pass above only paired descendants (g<=0); a
    // couple at an ANCESTOR generation (e.g. focus=Lucy → her parent's cousin
    // Colin + wife Lindsay with his sister Amie between them) was left
    // interleaved. This runs for EVERY generation as the final word on row
    // order: walk the row, emit each node immediately followed by its same-row
    // spouse(s), bloodline-first so the married-in spouse sits on the outside.
    // Verified by the invariant harness (spouses-adjacent, every shape × every
    // focus) — the scalable guarantee, not another per-person patch.
    for (const g of gensSorted) {
      const ids = slottedByGen.get(g);
      if (!ids || ids.length < 2) continue;
      const rowSet = new Set(ids);
      const placedAdj = new Set<number>();
      const out: number[] = [];
      for (const id of ids) {
        if (placedAdj.has(id)) continue;
        // A married-in spouse whose bloodline partner is also in this row waits
        // for the partner to pull them in (keeps the bloodline sibling run intact).
        if (!bloodline.has(id)
          && (spousesOf.get(id) ?? []).some(sp => rowSet.has(sp) && bloodline.has(sp) && !placedAdj.has(sp))) {
          continue;
        }
        const sps = (spousesOf.get(id) ?? []).filter(sp => rowSet.has(sp) && !placedAdj.has(sp));
        if (sps.length <= 1) {
          out.push(id); placedAdj.add(id);
          for (const sp of sps) { out.push(sp); placedAdj.add(sp); }
        } else {
          // Remarriage: a person with 2+ same-row spouses sits in the MIDDLE of
          // their spouse cluster so they stay adjacent to each. (A single row
          // can't keep one node beside 3+, but the realistic <=2 case is exact;
          // without this the second spouse lands two slots away — caught by the
          // remarriage stress shape in the harness.)
          const half = Math.floor(sps.length / 2);
          for (let i = 0; i < half; i++) { out.push(sps[i]); placedAdj.add(sps[i]); }
          out.push(id); placedAdj.add(id);
          for (let i = half; i < sps.length; i++) { out.push(sps[i]); placedAdj.add(sps[i]); }
        }
      }
      // Safety net: anything not yet emitted (shouldn't happen) keeps its order.
      for (const id of ids) if (!placedAdj.has(id)) { out.push(id); placedAdj.add(id); }
      slottedByGen.set(g, out);
    }

    // Minimum centre-to-centre gap between two adjacent nodes in a row.
    const isSpouse = (a: number, b: number) => (spousesOf.get(a) ?? []).includes(b);
    // A "unit" starting at index i = the node PLUS every contiguous spouse of
    // anyone already in the unit. Normally a couple (2), but handles remarriage
    // (a person with 2+ same-row spouses is one indivisible block) so the
    // unit-walking passes below never split a second spouse off as a lone unit
    // and fling it past the first family (Terry — the remarriage stress shape).
    const unitFrom = (ids: number[], i: number): number[] => {
      const u = [ids[i]];
      let j = i + 1;
      while (j < ids.length && u.some(m => isSpouse(m, ids[j]))) { u.push(ids[j]); j++; }
      return u;
    };
    // Uniform tight spacing (Terry r424): every adjacency packs at the same
    // tight gap. The OLD rule gave "unrelated" neighbours a wider nodeSpacing
    // gap — that is exactly what made an in-law sitting beside a sibling
    // (Sally↔Patricia, Wendy↔Ian) read ~30% further apart than two siblings.
    // Horizontal width is now EARNED only by a real sub-tree below (the
    // subtree-aware focus-row re-pack in the settle widens a branch by exactly
    // what its descendants occupy), never by a fixed relationship gap — so the
    // whole tree reads uniform until a branch genuinely needs the room.
    const sep = (_a: number, _b: number) => opts.spouseOffset;

    const X = new Map<number, number>();
    for (const g of gensSorted) { // initial compact left-pack per row
      const ids = slottedByGen.get(g)!;
      let x = 0;
      for (let i = 0; i < ids.length; i++) { if (i > 0) x += sep(ids[i - 1], ids[i]); X.set(ids[i], x); }
    }

    // Solve one row: choose x_1<=…<=x_n with x_{i+1} >= x_i + gap_i that
    // minimises Σ(x_i − desired_i)². Exact O(n) via pool-adjacent-
    // violators on the gap-shifted targets.
    const solveLayer = (ids: number[], desired: number[]) => {
      const n = ids.length;
      if (n === 0) return;
      const cum: number[] = [0];
      for (let i = 1; i < n; i++) cum.push(cum[i - 1] + sep(ids[i - 1], ids[i]));
      const t = desired.map((d, i) => d - cum[i]);
      const sum: number[] = [];
      const cnt: number[] = [];
      for (let i = 0; i < n; i++) {
        sum.push(t[i]); cnt.push(1);
        while (sum.length >= 2 && sum[sum.length - 2] / cnt[sum.length - 2] > sum[sum.length - 1] / cnt[sum.length - 1]) {
          const s = sum.pop()!, c = cnt.pop()!;
          sum[sum.length - 1] += s; cnt[cnt.length - 1] += c;
        }
      }
      let idx = 0;
      for (let b = 0; b < sum.length; b++) {
        const v = sum[b] / cnt[b];
        for (let c = 0; c < cnt[b]; c++) { X.set(ids[idx], v + cum[idx]); idx++; }
      }
    };

    const meanOf = (ids: number[] | undefined) => {
      if (!ids) return null;
      let s = 0, n = 0;
      for (const id of ids) { const x = X.get(id); if (x != null) { s += x; n++; } }
      return n === 0 ? null : s / n;
    };

    const ITERS = 12;
    for (let it = 0; it < ITERS; it++) {
      const downward = it % 2 === 0;
      const order = downward
        ? gensSorted.slice().sort((a, b) => b - a)   // parents before children
        : gensSorted.slice().sort((a, b) => a - b);  // children before parents
      for (const g of order) {
        const ids = slottedByGen.get(g)!;
        if (ids.length === 0) continue;
        const desired = ids.map(id => {
          let a = downward ? meanOf(parentsOf.get(id)) : meanOf(childrenOf.get(id));
          if (a == null) a = meanOf(spousesOf.get(id));   // keep couples together
          return a == null ? (X.get(id) ?? 0) : a;
        });
        solveLayer(ids, desired);
      }
    }

    // Final direction-correct settle (drift-free). The alternating sweeps
    // above can let a DEEP expanded branch creep rightward — a cousin's kids
    // get forced right by the row's min-gap chain, that drags the cousin
    // right (parent chasing kids), and nothing pulls them back, leaving big
    // gaps (Terry: Amie stranded, Patricia's offspring flung wide). Pinning
    // each side to its correct anchor removes the feedback: DESCENDANTS +
    // the focus row sit strictly UNDER their parents (top-down), ANCESTORS
    // strictly OVER their children (bottom-up). A few rounds converge.
    // ── Subtree-AWARE spacing (Terry r424). Spacing is driven by how much
    // room each branch's DESCENDANTS actually need, not a fixed relationship
    // gap. A childless couple sits as tight as two siblings; a couple with a
    // big brood gets exactly the width its sub-tree occupies — no more, no
    // arbitrary "family boundary" gap. Method: fan descendants DOWN under
    // their parents, MEASURE each focus-row unit's real sub-tree extent, then
    // re-pack the focus row left-to-right so neighbouring sub-trees just clear
    // each other; fan UP so ancestors centre over the result; repeat (a few
    // rounds converge). The min gap between adjacent sub-trees is the same
    // tight value as between two siblings, so the whole tree reads uniform.
    const descOf = new Map<number, number[]>();
    for (const r of (slottedByGen.get(0) ?? [])) {
      const acc: number[] = []; const q = [...(childrenOf.get(r) ?? [])]; const seen = new Set<number>();
      while (q.length) { const c = q.shift()!; if (seen.has(c) || !isSlotted(c)) continue; seen.add(c); acc.push(c); for (const k of childrenOf.get(c) ?? []) q.push(k); }
      descOf.set(r, acc);
    }
    {
      const g0 = slottedByGen.get(0) ?? [];
      let xp = 0;
      for (let i = 0; i < g0.length; i++) { if (i > 0) xp += sep(g0[i - 1], g0[i]); X.set(g0[i], xp); }
    }
    const fanDown = () => {
      for (const g of gensSorted.filter(x => x < 0).sort((a, b) => b - a)) {
        const ids = slottedByGen.get(g)!;
        if (ids.length === 0) continue;
        const desired = ids.map(id => {
          // BLOODLINE descendants sit under their parents; a MARRIED-IN spouse
          // (non-bloodline — e.g. Lindsay, who has her own parked family) sits
          // beside their PARTNER, never dragged out under their parked parents
          // (Terry 2026-06-26 — the couples-split bug). Fall back to the other
          // anchor only if the preferred one isn't on canvas.
          let a = bloodline.has(id) ? meanOf(parentsOf.get(id)) : meanOf(spousesOf.get(id));
          if (a == null) a = meanOf(parentsOf.get(id)) ?? meanOf(spousesOf.get(id));
          return a == null ? (X.get(id) ?? 0) : a;
        });
        solveLayer(ids, desired);
      }
    };
    // ── No-slotted-kids ancestor anchoring (Terry r431, broadened r437) ─────
    // An ancestor with no children PLACED on the canvas — genuinely childless
    // (a great-aunt/uncle with no descendants, e.g. Sylvia) OR whose branch is
    // currently COLLAPSED (its kids panelled away, e.g. Gladys with Marion
    // tucked under a chevron) — has no sub-tree to sit over, so it must borrow
    // a column. The correct home is its bloodline SIBLING: a sister sits
    // beside her brother. (r431 originally gated on "no children AT ALL"; r437
    // broadened it to "no SLOTTED children" so a great-aunt whose one child is
    // collapsed snaps next to her sibling instead of spreading out over the
    // hidden kid — the Gladys/Marion mess.)
    const hasSlottedKids = (id: number) => (childrenOf.get(id) ?? []).some(k => isSlotted(k));
    // True when fanUp() can give this no-slotted-kids node a real anchor (a
    // sibling that has children, or a spouse who is themselves so anchored — so
    // a great-aunt's in-law husband trails her). Used to keep tighten off them.
    const fanUpAnchors = (id: number) => !hasSlottedKids(id) && (
      (siblingsOf.get(id) ?? []).some(hasSlottedKids) ||
      (spousesOf.get(id) ?? []).some(s => hasSlottedKids(s) || (siblingsOf.get(s) ?? []).some(hasSlottedKids))
    );
    const fanUp = () => {
      for (const g of gensSorted.filter(x => x > 0).sort((a, b) => a - b)) {
        const ids = slottedByGen.get(g)!;
        if (ids.length === 0) continue;
        // An ancestor sits over its CHILDREN. A genuinely childless one borrows
        // its bloodline sibling's column (then an already-anchored spouse), and
        // only falls back to keep-x when it has no anchor at all — which is what
        // stops childless married-in couples from floating away as a unit.
        const desired = ids.map(id => {
          const kidMean = meanOf(childrenOf.get(id));
          if (kidMean != null) return kidMean;
          if (!hasSlottedKids(id)) {
            const sibMean = meanOf((siblingsOf.get(id) ?? []).filter(hasSlottedKids));
            if (sibMean != null) return sibMean;
            const spMean = meanOf((spousesOf.get(id) ?? []).filter(s => hasSlottedKids(s) || (siblingsOf.get(s) ?? []).some(hasSlottedKids)));
            if (spMean != null) return spMean;
          }
          return X.get(id) ?? 0;
        });
        solveLayer(ids, desired);
      }
    };
    // Close the excess gap a childless ("leaf") ancestor unit leaves behind: it
    // has no sub-tree to sit over, so it should pack tight beside its sibling
    // rather than float at a stale x. Only ever pulls a unit LEFT to close a
    // gap — never pushes right (which could collide with a real sub-tree). Runs
    // each settle round so the next fan-up re-centres any grandparent over the
    // tightened unit.
    const tightenLeafAncestors = () => {
      for (const g of gensSorted.filter(x => x > 0).sort((a, b) => a - b)) {
        const ids = slottedByGen.get(g)!;
        let prevRight = -Infinity, i = 0;
        while (i < ids.length) {
          const members = unitFrom(ids, i);
          const hasKids = members.some(m => (childrenOf.get(m) ?? []).some(k => isSlotted(k)));
          // Leave fanUp's sibling-anchored childless nodes alone — dragging them
          // leftward here is exactly what stranded Sylvia onto the wrong family.
          const anchored = members.some(fanUpAnchors);
          const uMin = Math.min(...members.map(m => X.get(m) ?? 0));
          if (!hasKids && !anchored && prevRight > -Infinity) {
            const delta = (prevRight + opts.spouseOffset) - uMin;
            if (delta < 0) for (const m of members) X.set(m, (X.get(m) ?? 0) + delta);
          }
          prevRight = Math.max(...members.map(m => X.get(m) ?? 0));
          i += members.length;
        }
      }
    };
    // Re-pack the focus row so each unit's whole sub-tree clears the previous
    // unit's sub-tree by the tight gap. A "unit" is a couple (kept together)
    // or a single. Childless units fall back to just their own width → tight.
    const repackFocusRow = () => {
      const g0 = slottedByGen.get(0) ?? [];
      let cursor = -Infinity, i = 0;
      while (i < g0.length) {
        const members = unitFrom(g0, i);
        let uMin = Infinity, uMax = -Infinity;
        for (const m of members) {
          let mn = X.get(m) ?? 0, mx = X.get(m) ?? 0;
          for (const d of descOf.get(m) ?? []) { const dx = X.get(d); if (dx != null) { if (dx < mn) mn = dx; if (dx > mx) mx = dx; } }
          if (mn < uMin) uMin = mn;
          if (mx > uMax) uMax = mx;
        }
        // Set this unit exactly one tight gap past the previous sub-tree's
        // right edge — pulling IN where the first pass over-spaced (e.g. an
        // in-law beside a sibling) as well as pushing OUT where a wide brood
        // needs the room. (A plain max(0,…) could only push out, so stale
        // wide gaps survived.)
        const delta = cursor === -Infinity ? 0 : (cursor + opts.spouseOffset) - uMin;
        if (delta !== 0) for (const m of members) { X.set(m, (X.get(m) ?? 0) + delta); for (const d of descOf.get(m) ?? []) X.set(d, (X.get(d) ?? 0) + delta); }
        cursor = uMax + delta;
        i += members.length;
      }
    };
    for (let f = 0; f < 6; f++) { fanDown(); repackFocusRow(); fanUp(); tightenLeafAncestors(); }
    fanDown();

    // ── Pull stranded CHILDLESS bloodline-siblings snug (Terry 2026-06-26) ──
    // THE GENERAL fix for the recurring "derived sibling flung to the side"
    // bug — previously patched per-relative (Joy r426, Gladys's tile r434,
    // great-aunts r437) but r437 only covered the UPWARD direction (fanUp).
    // A bloodline sibling whose only link is through STRIPPED PLACEHOLDER
    // parents has no visible parent to seat it under, so repackFocusRow / the
    // settle sequence it PAST its sibling's whole sub-tree → it lands far out
    // with empty space beside it (focus=Grandad → his childless sister Sylvia
    // Mills; focus=Nan → Gladys, but she has Marion so the column is USED and
    // looks right). Rule: a sibling that owns NO sub-tree belongs snug beside
    // its sibling's CARD, not past its sub-tree. One pass, every generation;
    // ancestors fanUp already snugged see delta≈0 and are left as-is; only
    // ever pulls a unit INWARD; skips any move that would collide in-row.
    {
      const genOf = new Map<number, number>();
      for (const [g, ids] of slottedByGen) for (const id of ids) genOf.set(id, g);
      const unitOf = (id: number): number[] => {
        for (const s of spousesOf.get(id) ?? []) if (isSlotted(s) && genOf.get(s) === genOf.get(id)) return [id, s];
        return [id];
      };
      const processed = new Set<number>();
      for (const N of [...X.keys()]) {
        if (processed.has(N) || !isSlotted(N)) continue;
        const gN = genOf.get(N);
        if (gN == null) continue;
        const unit = unitOf(N);
        for (const m of unit) processed.add(m);
        if (!unit.some(m => bloodline.has(m))) continue;            // must be a real bloodline sibling unit
        if (unit.some(m => hasSlottedKids(m))) continue;            // unit owns a sub-tree → it needs its own column
        const sibs = unit.flatMap(m => siblingsOf.get(m) ?? [])
          .filter(s => isSlotted(s) && genOf.get(s) === gN && hasSlottedKids(s));
        if (sibs.length === 0) continue;                            // no sibling-with-a-branch to snug against
        const nMin = Math.min(...unit.map(m => X.get(m) ?? 0));
        const nMax = Math.max(...unit.map(m => X.get(m) ?? 0));
        const S = sibs.reduce((b, s) => Math.abs((X.get(s) ?? 0) - nMin) < Math.abs((X.get(b) ?? 0) - nMin) ? s : b);
        const sUnit = unitOf(S);
        const sMin = Math.min(...sUnit.map(m => X.get(m) ?? 0));
        const sMax = Math.max(...sUnit.map(m => X.get(m) ?? 0));
        let delta: number;
        if (nMin >= (X.get(S) ?? 0)) {                              // N sits to the RIGHT of its sibling
          delta = (sMax + opts.spouseOffset) - nMin;
          if (delta >= 0) continue;                                // already tight / would push outward
        } else {                                                    // N sits to the LEFT
          delta = (sMin - opts.spouseOffset) - nMax;
          if (delta <= 0) continue;
        }
        const newMin = nMin + delta, newMax = nMax + delta;
        const clash = (slottedByGen.get(gN) ?? []).some(id =>
          !unit.includes(id) && (X.get(id) ?? 0) > newMin - opts.spouseOffset && (X.get(id) ?? 0) < newMax + opts.spouseOffset);
        if (clash) continue;
        for (const m of unit) X.set(m, (X.get(m) ?? 0) + delta);
      }
    }

    // ───────────────────────────────────────────────────────────────────
    // HARD PARENT-CENTRING POSITIONER (Terry 2026-06-26).
    //
    // The settle above (fanDown/fanUp/repackFocusRow/solveLayer) positions each
    // generation row semi-independently, so a family's parent row and child row
    // drift apart — a childless sibling can steal the column the lineage node
    // needs, and a wide parent row never widens the children below it. This
    // OVERRIDES the settle's X for every slotted node with a focus-rooted,
    // subtree-band layout in which EVERY parent (or couple) is centred over its
    // children with no overlaps.
    //
    // Method (focus-rooted tree — a proper tree both ways because rooting at the
    // focus turns the top-down DAG "merge" into an up-fork):
    //   • UNITS = a node + its contiguous same-row spouse(s) (couples kept whole).
    //   • DOWN-CONE: a unit centred over its children, sibling subtrees packed by
    //     bounding box so they never overlap (classic tidy top-down).
    //   • CONE ROOTS = focus unit + every branch head (a unit at an ancestor gen
    //     that is a child of a bloodline ancestor but not itself on the focus
    //     spine — i.e. focus's siblings, aunts/uncles, great-aunts/uncles…).
    //   • Pack each cone root's down-cone side-by-side (left→right in
    //     slottedByGen order) with per-generation cursors so no row overlaps;
    //     then seat each spine ancestor bottom-up centred over its children
    //     (the up-fork resolves to side-by-side, within the check's slack).
    // Order WITHIN every row is taken from slottedByGen (already correct, couples
    // adjacent) — this only sets X. Y is untouched.
    {
      const GAP = opts.spouseOffset; // uniform tight min centre-to-centre gap
      // Generation of each slotted node, and an index within its row (for L→R order).
      const genOf = new Map<number, number>();
      const rowIndex = new Map<number, number>();
      for (const [g, ids] of slottedByGen) ids.forEach((id, i) => { genOf.set(id, g); rowIndex.set(id, i); });

      // UNITS — partition each row via unitFrom (couple/single/remarriage block).
      const unitOfMember = new Map<number, number[]>();   // member id → its unit members
      const unitKeyOf = new Map<number, number>();        // member id → unit key (members[0])
      const unitsByGen = new Map<number, number[]>();      // gen → unit keys, in row order
      for (const [g, ids] of slottedByGen) {
        const keys: number[] = [];
        let i = 0;
        while (i < ids.length) {
          const members = unitFrom(ids, i);
          const key = members[0];
          for (const m of members) { unitOfMember.set(m, members); unitKeyOf.set(m, key); }
          keys.push(key);
          i += members.length;
        }
        unitsByGen.set(g, keys);
      }
      const allUnitKeys = Array.from(unitsByGen.values()).flat();
      const membersOfUnit = (u: number) => unitOfMember.get(u) ?? [u];
      const genOfUnit = (u: number) => genOf.get(u)!;
      const rowIndexOfUnit = (u: number) => Math.min(...membersOfUnit(u).map(m => rowIndex.get(m) ?? 0));

      // Unit-level child / parent / SIBLING relations (slotted only). Siblings are
      // followed via sibling_of so a "derived sibling" (joined only by a stripped-
      // placeholder shared parent → no visible parent edge) still attaches to the
      // tree beside its sibling instead of being orphaned.
      const childUnitsOf = new Map<number, number[]>();
      const parentUnitsOf = new Map<number, number[]>();
      const sibUnitsOf = new Map<number, number[]>();
      for (const u of allUnitKeys) {
        const kids = new Set<number>();
        const pars = new Set<number>();
        const sibs = new Set<number>();
        for (const m of membersOfUnit(u)) {
          for (const c of childrenOf.get(m) ?? []) if (isSlotted(c)) kids.add(unitKeyOf.get(c)!);
          for (const p of parentsOf.get(m) ?? []) if (isSlotted(p)) pars.add(unitKeyOf.get(p)!);
          for (const s of siblingsOf.get(m) ?? []) if (isSlotted(s)) sibs.add(unitKeyOf.get(s)!);
        }
        kids.delete(u); pars.delete(u); sibs.delete(u);
        childUnitsOf.set(u, [...kids].sort((a, b) => rowIndexOfUnit(a) - rowIndexOfUnit(b)));
        parentUnitsOf.set(u, [...pars].sort((a, b) => rowIndexOfUnit(a) - rowIndexOfUnit(b)));
        sibUnitsOf.set(u, [...sibs].sort((a, b) => rowIndexOfUnit(a) - rowIndexOfUnit(b)));
      }

      // Spine = focus unit + every strict bloodline ANCESTOR unit (walk parent
      // units UP from the focus). These are SEATED over their children; everyone
      // else attaches to the spine as a branch head (cone root).
      const focusUnit = unitKeyOf.get(focusId)!;
      const spine = new Set<number>([focusUnit]);
      {
        const q = [focusUnit];
        while (q.length) {
          const u = q.shift()!;
          for (const pu of parentUnitsOf.get(u) ?? []) {
            if (genOfUnit(pu) <= genOfUnit(u)) continue;       // strictly above
            if (spine.has(pu)) continue;
            if (!membersOfUnit(pu).some(m => bloodline.has(m))) continue;  // bloodline only
            spine.add(pu); q.push(pu);
          }
        }
      }

      // Down-cone: relative layout of a unit + ALL its descendants, tidy
      // (Reingold–Tilford). Returns pos (member id → relX), per-gen extent
      // [min,max] and the unit's own centre. Children subtrees are packed by
      // bounding box so no row overlaps; the unit is centred over its kids' band.
      type Cone = { pos: Map<number, number>; ext: Map<number, [number, number]>; centre: number };
      const mergeExtInto = (into: Map<number, [number, number]>, g: number, mn: number, mx: number) => {
        const cur = into.get(g);
        if (!cur) into.set(g, [mn, mx]); else into.set(g, [Math.min(cur[0], mn), Math.max(cur[1], mx)]);
      };
      const shiftCone = (c: Cone, dx: number): Cone => {
        if (dx === 0) return c;
        const pos = new Map<number, number>();
        for (const [id, x] of c.pos) pos.set(id, x + dx);
        const ext = new Map<number, [number, number]>();
        for (const [g, [mn, mx]] of c.ext) ext.set(g, [mn + dx, mx + dx]);
        return { pos, ext, centre: c.centre + dx };
      };
      // Smallest dx so cone `c` sits entirely to the RIGHT of `cursor` at every
      // gen it occupies (cursor = next-free x per gen; absent gen ⇒ free at -inf).
      const dxToClearRight = (c: Cone, cursor: Map<number, number>): number => {
        let dx = 0, any = false;
        for (const [cg, [mn]] of c.ext) {
          const cur = cursor.get(cg);
          if (cur == null) continue;
          const need = cur - mn;
          if (!any || need > dx) { dx = need; any = true; }
        }
        return any ? dx : 0;
      };
      const downCone = (u: number): Cone => {
        const members = membersOfUnit(u);
        const g = genOfUnit(u);
        const kids = (childUnitsOf.get(u) ?? []).filter(cu => genOfUnit(cu) === g - 1);
        const pos = new Map<number, number>();
        const ext = new Map<number, [number, number]>();
        const placeMembers = (centre: number) => {
          const span = (members.length - 1) * GAP;
          const left = centre - span / 2;
          members.forEach((m, i) => pos.set(m, left + i * GAP));
          mergeExtInto(ext, g, left, left + span);
        };
        if (kids.length === 0) { placeMembers(0); return { pos, ext, centre: 0 }; }
        const cursor = new Map<number, number>();
        const childCentres: number[] = [];
        for (const k of kids) {
          const kc = downCone(k);
          const sc = shiftCone(kc, dxToClearRight(kc, cursor));
          for (const [id, x] of sc.pos) pos.set(id, x);
          for (const [cg, [mn, mx]] of sc.ext) { mergeExtInto(ext, cg, mn, mx); cursor.set(cg, mx + GAP); }
          childCentres.push(sc.centre);
        }
        placeMembers((childCentres[0] + childCentres[childCentres.length - 1]) / 2);
        return { pos, ext, centre: (childCentres[0] + childCentres[childCentres.length - 1]) / 2 };
      };

      // GLOBAL placement. NX = final relative X per member. `occ` = occupied
      // [min,max] per gen so newly-placed cones never overlap an existing row.
      const NX = new Map<number, number>();
      const occ = new Map<number, [number, number]>();
      const stampCone = (c: Cone) => {
        for (const [id, x] of c.pos) NX.set(id, x);
        for (const [g, [mn, mx]] of c.ext) mergeExtInto(occ, g, mn, mx);
      };
      const centreOfUnit = (u: number): number => {
        const ms = membersOfUnit(u).map(m => NX.get(m)).filter((x): x is number => x != null);
        return ms.length ? (Math.min(...ms) + Math.max(...ms)) / 2 : 0;
      };
      const edgeOfUnit = (u: number, side: 'left' | 'right'): number => {
        const ms = membersOfUnit(u).map(m => NX.get(m)).filter((x): x is number => x != null);
        if (!ms.length) return centreOfUnit(u);
        return side === 'left' ? Math.min(...ms) : Math.max(...ms);
      };
      // Place a cone on a given SIDE, as far IN toward `innerEdge` as possible
      // while clearing all current occupancy by GAP at every gen it touches.
      // 'left'  ⇒ cone's RIGHT edge = min(innerEdge − GAP, every leftmost-occupied − GAP).
      // 'right' ⇒ cone's LEFT  edge = max(innerEdge + GAP, every rightmost-occupied + GAP).
      // A childless-leaf branch head (single-gen cone, no descendants below to
      // clear) thus sits snug beside its anchor instead of being flung out past a
      // deep cousin branch — the stranded-sibling fix, structural not per-person.
      const placeConeSide = (c: Cone, side: 'left' | 'right', innerEdge: number) => {
        // A LEAF cone (single generation, no descendant rows) is placed directly
        // adjacent to the anchor and NOT pushed past far-away same-row occupancy —
        // the final per-row spread resolves any same-row overlap. This keeps a
        // childless great-aunt snug beside her own sibling instead of flung past an
        // unrelated couple sitting elsewhere in the row. A MULTI-gen cone must
        // clear ALL occupancy (its descendant rows can't be fixed by the per-row
        // spread without tearing the cone apart), so it sits beyond everything.
        const isLeaf = c.ext.size <= 1;
        if (side === 'left') {
          let rightEdge = innerEdge - GAP;
          if (!isLeaf) for (const [cg, [, mx]] of c.ext) { void mx; const o = occ.get(cg); if (o) rightEdge = Math.min(rightEdge, o[0] - GAP); }
          const curMax = Math.max(...[...c.ext.values()].map(([, mx]) => mx));
          stampCone(shiftCone(c, rightEdge - curMax));
        } else {
          let leftEdge = innerEdge + GAP;
          if (!isLeaf) for (const [cg, [mn]] of c.ext) { const o = occ.get(cg); if (o) leftEdge = Math.max(leftEdge, o[1] + GAP); }
          const curMin = Math.min(...[...c.ext.values()].map(([mn]) => mn));
          stampCone(shiftCone(c, leftEdge - curMin));
        }
      };
      // Park a stray cone fully to one side of ALL occupancy (no inner anchor).
      const parkConeSide = (c: Cone, side: 'left' | 'right') => {
        const o0 = [...occ.values()];
        if (!o0.length) { stampCone(c); return; }
        const innerEdge = side === 'left' ? Math.min(...o0.map(o => o[0])) : Math.max(...o0.map(o => o[1]));
        placeConeSide(c, side, innerEdge);
      };

      // 1) Focus down-cone at the origin.
      stampCone(downCone(focusUnit));

      // Splay branch-head cones around an already-placed anchor unit: those whose
      // row order sits left of the anchor go LEFT (nearest first, snug to the
      // anchor's left edge); the rest go RIGHT.
      const placeBranchHeadsAround = (anchorUnit: number, heads: number[]) => {
        const aIdx = rowIndexOfUnit(anchorUnit);
        const lefts = heads.filter(h => rowIndexOfUnit(h) < aIdx).sort((a, b) => rowIndexOfUnit(b) - rowIndexOfUnit(a)); // nearest first
        const rights = heads.filter(h => rowIndexOfUnit(h) >= aIdx).sort((a, b) => rowIndexOfUnit(a) - rowIndexOfUnit(b));
        for (const h of lefts) { if (!NX.has(h)) placeConeSide(downCone(h), 'left', edgeOfUnit(anchorUnit, 'left')); }
        for (const h of rights) { if (!NX.has(h)) placeConeSide(downCone(h), 'right', edgeOfUnit(anchorUnit, 'right')); }
      };

      // 2) Attach derived siblings of the focus (no slotted parent → not reached
      // by the climb) directly beside the focus, at the focus generation.
      {
        const focusSibs = (sibUnitsOf.get(focusUnit) ?? [])
          .filter(s => genOfUnit(s) === genOfUnit(focusUnit) && !spine.has(s) && !NX.has(s)
            && (parentUnitsOf.get(s) ?? []).every(pu => !NX.has(pu)));
        placeBranchHeadsAround(focusUnit, focusSibs);
      }

      const spanOfUnit = (u: number) => (membersOfUnit(u).length - 1) * GAP;
      const setUnitCentre = (u: number, c: number) => {
        const members = membersOfUnit(u);
        const left = c - spanOfUnit(u) / 2;
        members.forEach((m, i) => NX.set(m, left + i * GAP));
      };
      // Authoritative seat used by the final pass: centre P over the span of its
      // OWN child CARDS (members with a parent_of edge from a P member), NOT over
      // the merged child-UNIT centres. This matters at the maternal/paternal fork:
      // a grandparent couple's child unit is the [dad,mum] couple, but the couple's
      // actual child is just dad (one card) — seating over dad (then letting the
      // two grandparent couples spread to clear each other) keeps each grandparent
      // over its own child, exactly what checkParentsCentred measures. Returns the
      // target centre, or null when P has no slotted child card.
      const spineSeatCentre = (P: number): number | null => {
        let mn = Infinity, mx = -Infinity;
        for (const m of membersOfUnit(P)) for (const c of childrenOf.get(m) ?? []) {
          const x = NX.get(c);
          if (x != null) { if (x < mn) mn = x; if (x > mx) mx = x; }
        }
        return mn === Infinity ? null : (mn + mx) / 2;
      };

      // 3) CLIMB the spine: from each spine unit (bottom-up), splay that unit's
      // parent's OTHER children (the aunts/uncles = branch heads) around the
      // already-placed spine child, then seat the parent over its children. The
      // maternal/paternal fork is handled because a spine unit can have two parent
      // spine units — each seats over its own children's span.
      const spineByGenAsc = [...spine].filter(s => genOfUnit(s) > genOfUnit(focusUnit)).sort((a, b) => genOfUnit(a) - genOfUnit(b));
      for (const P of spineByGenAsc) {
        const g = genOfUnit(P);
        const kidsBelow = (childUnitsOf.get(P) ?? []).filter(cu => genOfUnit(cu) === g - 1);
        const placedKids = kidsBelow.filter(cu => membersOfUnit(cu).some(m => NX.has(m)));
        const anchor = placedKids.length
          ? placedKids.reduce((b, k) => centreOfUnit(k) < centreOfUnit(b) ? k : b)
          : (kidsBelow[0] ?? P);
        placeBranchHeadsAround(anchor, kidsBelow.filter(cu => !spine.has(cu) && !NX.has(cu)));
        // Seat P over its (now placed) children; record occupancy.
        const members = membersOfUnit(P);
        const cs = (placedKids.length ? placedKids : kidsBelow).filter(cu => membersOfUnit(cu).some(m => NX.has(m))).map(centreOfUnit);
        const centre = cs.length ? (Math.min(...cs) + Math.max(...cs)) / 2 : centreOfUnit(P);
        setUnitCentre(P, centre);
        const o = occ.get(g);
        if (o) { const lo = Math.min(...members.map(m => NX.get(m)!)); const hi = Math.max(...members.map(m => NX.get(m)!));
          if (hi > o[0] && lo < o[1]) {
            const span = spanOfUnit(P);
            const leftOpt = o[0] - GAP - span, rightOpt = o[1] + GAP;
            setUnitCentre(P, (Math.abs(leftOpt - (centre - span / 2)) <= Math.abs(rightOpt - (centre - span / 2)) ? leftOpt : rightOpt) + span / 2);
          }
        }
        mergeExtInto(occ, g, Math.min(...members.map(m => NX.get(m)!)), Math.max(...members.map(m => NX.get(m)!)));
        // P's own derived siblings (great-aunts/uncles) splay beside P.
        placeBranchHeadsAround(P, (sibUnitsOf.get(P) ?? [])
          .filter(s => genOfUnit(s) === g && !spine.has(s) && !NX.has(s) && (parentUnitsOf.get(s) ?? []).every(pu => !NX.has(pu))));
      }

      // 4) Any remaining slotted unit not yet placed (disconnected oddities) —
      // park to the right of all occupancy so it never overlaps.
      for (const u of allUnitKeys) {
        if (NX.has(u)) continue;
        parkConeSide(downCone(u), 'right');
      }

      // 5) Finalize BOTTOM-UP — EVERY parent (spine AND non-spine) centred over its
      // OWN children, in every expansion state (Terry 2026-06-26). The cone packing
      // (1–4) already centres each unit over its kids WITHIN its own cone, but the
      // old finalize re-resolved each row in isolation: a moved unit's children (in
      // the row below, already settled) did NOT follow it, so a parent and its kids
      // desynced — aunt/uncle couples (Kevin+Sarah, Nicholas+Lauren) and cousin
      // couples sat up to ~147px off their own children because Jo+Paul's wider brood
      // was seated first and the aunts were merely gap-packed around it.
      //
      // Fix: a single bottom-up contour sweep. For each ancestor row (deepest first),
      // seat EVERY unit with placed children over its own children's-span centre
      // (member-level, so the maternal/paternal fork seats each grandparent couple
      // over its own single child). A leaf unit (no placed kids — a childless
      // great-aunt, a collapsed branch head) keeps its cone X. Then resolve same-row
      // overlaps L→R and R→L by shifting whole SUBTREES rigidly: moving a unit drags
      // its entire descendant cone with it, so a shifted child keeps its own
      // parent-over-kids. Each unit that is pinned by its own kids is "anchored"; an
      // anchored↔anchored collision is the genuine fork (each over disjoint children)
      // and splits symmetrically. Family-with-more-children is WIDER (its subtree
      // occupies more room) and pushes neighbours further out, never stealing their
      // column. Re-seating ancestors above happens naturally because they are swept
      // last, over the now-final child positions.
      const minGapBetween = (a: number, b: number) => spanOfUnit(a) / 2 + GAP + spanOfUnit(b) / 2;
      // Descendant units of U strictly below U's generation (for rigid subtree shift).
      const subtreeBelow = (u: number): number[] => {
        const acc: number[] = [];
        const seen = new Set<number>([u]);
        const q = [u];
        while (q.length) {
          const cur = q.shift()!;
          for (const k of childUnitsOf.get(cur) ?? []) {
            if (seen.has(k)) continue;
            if (genOfUnit(k) >= genOfUnit(cur)) continue;   // strictly downward only
            seen.add(k); acc.push(k); q.push(k);
          }
        }
        return acc;
      };
      // Shift a unit AND its whole descendant subtree rigidly by dx, so children stay
      // centred under the moved parent.
      const shiftUnitSubtree = (u: number, dx: number) => {
        if (dx === 0) return;
        for (const m of membersOfUnit(u)) { const x = NX.get(m); if (x != null) NX.set(m, x + dx); }
        for (const su of subtreeBelow(u)) for (const m of membersOfUnit(su)) { const x = NX.get(m); if (x != null) NX.set(m, x + dx); }
      };
      // Seat each unit in `rowKeys` over its OWN children, then clear same-row
      // overlaps by shifting whole subtrees. ANCHORED units (those with placed
      // children) are PINNED at their children's-span centre — that pin is the whole
      // point (every parent centred over its kids), so the overlap solver must not let
      // them drift the way a plain pool-adjacent-violators would. CHILDLESS leaf units
      // pack into the gaps AROUND the pinned anchors. Two anchored units genuinely too
      // close (the maternal/paternal fork, or sibling parents whose broods don't fit)
      // split symmetrically — and only then, when leaves can't fit between them or two
      // pins collide. Every move is a rigid subtree shift so children stay centred
      // under their moved parent; ancestors re-seat on the next (higher) row.
      const resolveRowOverChildren = (rowKeys: number[]) => {
        const keys = rowKeys.filter(u => membersOfUnit(u).some(m => NX.has(m)));
        if (keys.length === 0) return;
        // 1) Seat anchored units over their own child cards (unit only — the children
        //    below are the reference and must not move here). The focus unit is the
        //    tree's anchor: keep it where it is (re-centred on focus at the very end).
        const anchored: boolean[] = [];
        keys.sort((a, b) => rowIndexOfUnit(a) - rowIndexOfUnit(b));
        for (const u of keys) {
          const s = u === focusUnit ? null : spineSeatCentre(u);
          if (s != null) { setUnitCentre(u, s); anchored.push(true); }
          else anchored.push(u === focusUnit);   // focus pinned-in-place too
        }
        if (keys.length === 1) return;
        // 2) Resolve overlaps with anchored units PINNED. `c` = working centres.
        const c = keys.map(centreOfUnit);
        const gap = (i: number, j: number) => minGapBetween(keys[i], keys[j]);
        // 2a) Pin-vs-pin: where two anchored units (with only leaves, or nothing,
        //     between them) are too close even before packing leaves, push them — and
        //     all pins — apart symmetrically. Iterating adjacent anchored pairs only
        //     ever increases separation, so it converges.
        for (let pass = 0; pass < keys.length; pass++) {
          let moved = false;
          for (let i = 0; i + 1 < keys.length; i++) {
            if (!anchored[i] || !anchored[i + 1]) continue;
            const need = gap(i, i + 1) - (c[i + 1] - c[i]);
            if (need > 1e-6) { c[i] -= need / 2; c[i + 1] += need / 2; moved = true; }
          }
          if (!moved) break;
        }
        // 2b) Pack each maximal run of consecutive LEAF units between its bounding
        //     anchored pins (or the row ends). Left-pack at min-gap from the left pin,
        //     then slide the run toward each leaf's own desired centre without crossing
        //     either pin. If the run can't fit, push the right pin (and every pin to
        //     its right) outward to make exactly enough room, then place left-packed.
        let i = 0;
        while (i < keys.length) {
          if (anchored[i]) { i++; continue; }
          let j = i; while (j + 1 < keys.length && !anchored[j + 1]) j++;   // [i..j] leaves
          const leftPin = i - 1 >= 0 ? i - 1 : -1;
          const rightPin = j + 1 < keys.length ? j + 1 : -1;
          // run internal width (centre of first leaf → centre of last leaf)
          let internal = 0;
          for (let k = i; k < j; k++) internal += gap(k, k + 1);
          const lo = leftPin >= 0 ? c[leftPin] + gap(leftPin, i) : -Infinity;
          const hi = rightPin >= 0 ? c[rightPin] - gap(j, rightPin) : Infinity;
          // Ensure room between pins; if not, shove the right pin (+ pins to its right).
          if (leftPin >= 0 && rightPin >= 0 && hi - lo < internal - 1e-6) {
            const deficit = internal - (hi - lo);
            for (let k = rightPin; k < keys.length; k++) c[k] += deficit;
          }
          const hi2 = rightPin >= 0 ? c[rightPin] - gap(j, rightPin) : Infinity;
          // desired centre of the run's first leaf (so the run sits near its kids /
          // its cone position), clamped so the whole run stays within [lo, hi2].
          const firstDesired = (() => {
            const u = keys[i]; const s = u === focusUnit ? null : spineSeatCentre(u);
            return (s != null ? s : centreOfUnit(u));
          })();
          let start = firstDesired;
          if (start < lo) start = lo;
          if (start + internal > hi2) start = hi2 - internal;
          if (!isFinite(start)) start = lo !== -Infinity ? lo : (hi2 !== Infinity ? hi2 - internal : c[i]);
          let acc = start;
          for (let k = i; k <= j; k++) { c[k] = acc; if (k < j) acc += gap(k, k + 1); }
          i = j + 1;
        }
        // 3) Apply as rigid subtree shifts so each moved parent carries its children.
        keys.forEach((u, k) => shiftUnitSubtree(u, c[k] - centreOfUnit(u)));
      };
      // Single bottom-up contour sweep over EVERY row, children before parents.
      // Generation increases UPWARD (descendants are negative, ancestors positive),
      // so ascending-gen order visits the deepest descendant row first and the top
      // ancestor row last — exactly the order resolveRowOverChildren needs (it seats
      // each unit over its already-final children in the row below). The deepest rows
      // have no children → it just clears their same-row overlaps (the cone packing
      // already placed them tightly); every row above then seats its units over those
      // now-final kids and shifts whole subtrees to clear overlaps. Uniform across
      // descendant, focus and ancestor rows, so a cousin couple deep in a side branch
      // is centred over its kids exactly like the focus's own parents are.
      const gensAsc = [...unitsByGen.keys()].sort((a, b) => a - b);
      for (const g of gensAsc) resolveRowOverChildren(unitsByGen.get(g) ?? []);

      // Defensive: any slotted node still unplaced keeps its settle X.
      for (const id of X.keys()) if (isSlotted(id) && !NX.has(id)) NX.set(id, X.get(id)!);
      // Override the settle's X with the new positions for slotted nodes.
      for (const [id, x] of NX) if (isSlotted(id)) X.set(id, x);
    }

    // Centre the whole tree on the focus.
    const fx = X.get(focusId) ?? 0;
    if (fx !== 0) for (const id of [...X.keys()]) X.set(id, X.get(id)! - fx);

    // Park every non-slotted placed node on its nearest slotted relative
    // (BFS outward). Keeps panels anchored near their owner and the
    // navigable bounds tight; the canvas relocates them into chevron
    // panels on expand, so the parked x only sets their resting home.
    for (const node of placed.values()) {
      if (X.has(node.personId)) continue;
      const q = [node.personId];
      const seen = new Set<number>([node.personId]);
      let parkX: number | null = null;
      while (q.length && parkX == null) {
        const c = q.shift()!;
        for (const m of [...(parentsOf.get(c) ?? []), ...(childrenOf.get(c) ?? []), ...(spousesOf.get(c) ?? []), ...(siblingsOf.get(c) ?? [])]) {
          if (X.has(m)) { parkX = X.get(m)!; break; }
          if (!seen.has(m)) { seen.add(m); q.push(m); }
        }
      }
      X.set(node.personId, parkX ?? 0);
    }

    // Write the new X back (Y is untouched — set by the first pass). Also stamp
    // `slotted` here, while isSlotted is in scope, so the layout output can tell
    // canvas nodes from parked in-law-panel nodes (used by the invariant suite).
    for (const node of Array.from(placed.values())) {
      const x = X.get(node.personId);
      if (x != null) placed.set(node.personId, { ...node, x, slotted: isSlotted(node.personId) });
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

  // ── Bloodline-pathway pair ordering rule (recursive) ───────────────────
  // At every ancestor generation, each bloodline-pathway PAIR (a couple
  // whose child sits on the focus → ancestors pathway) gets the same
  // fan-out treatment Terry asked for at his immediate parents row:
  //   * Within each pair, the LEFT parent (= "father") is rightmost of
  //     his sibling group — siblings + their in-law spouses fan LEFT.
  //   * Within each pair, the RIGHT parent (= "mother") is leftmost of
  //     her sibling group — siblings + their in-law spouses fan RIGHT.
  // Net effect: each ancestor couple sits with its own siblings on the
  // outward side at every gen, recursively. Paternal grandparents pair
  // sits left-of-canvas, maternal pair sits right-of-canvas, each with
  // their own great-aunts/uncles fanning out away from focus's bloodline.
  // pathwaySet = focus + every ancestor reachable via parent_of (BFS up).
  const pathwaySet = new Set<number>([graph.focusPersonId]);
  {
    const queue = [graph.focusPersonId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of graph.edges) {
        if (e.type !== 'parent_of') continue;
        if (e.bId !== cur) continue;
        if (pathwaySet.has(e.aId)) continue;
        pathwaySet.add(e.aId);
        queue.push(e.aId);
      }
    }
  }
  const pathwayInGen: number[] = genNodes
    .filter(n => pathwaySet.has(n.personId))
    .map(n => n.personId);
  if (pathwayInGen.length > 0) {
    const pullXOf = (pid: number): number => {
      const kids = childrenByParent.get(pid) ?? [];
      const xs = kids.map(k => placed.get(k)?.x).filter((x): x is number => x != null);
      if (xs.length === 0) return 0;
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    // Group pathway-parents into PAIRS — two pathway parents form a
    // pair when they share at least one placed child who is also on
    // the bloodline pathway (= the child connecting down toward focus).
    type Pair = { left: number; right: number | null; pullX: number; key: string };
    const pairs: Pair[] = [];
    const parentToPair = new Map<number, number>();
    for (const aId of pathwayInGen) {
      if (parentToPair.has(aId)) continue;
      const aKids = (childrenByParent.get(aId) ?? []).filter(k => pathwaySet.has(k));
      // Find a co-parent in pathwayInGen who shares one of aKids.
      let coParent: number | null = null;
      for (const bId of pathwayInGen) {
        if (bId === aId) continue;
        if (parentToPair.has(bId)) continue;
        const bKids = (childrenByParent.get(bId) ?? []).filter(k => pathwaySet.has(k));
        if (bKids.some(k => aKids.includes(k))) {
          coParent = bId;
          break;
        }
      }
      // Order pair members by:
      //   1. pull-X (mean of placed children's x — usually a tie
      //      because both parents share the same kids).
      //   2. GENDER — male first, so the "father" of the pair sits
      //      on the LEFT and "mother" on the RIGHT whenever the
      //      data has gender set. Without this, the left/right
      //      slot was decided purely by whichever parent_of edge
      //      was created first, which is fragile (Sylvia added
      //      before Derek would land Sylvia on the left even
      //      though she's the mother).
      //   3. Earliest parent_of edge to the shared bloodline child
      //      — the existing slot-order rule (matters when both
      //      parents are same-gender or have no gender on file).
      //   4. person_id as a final stable tiebreak.
      const candidates = [aId, ...(coParent != null ? [coParent] : [])];
      const sharedKid = (() => {
        if (coParent == null) return null;
        const aKidSet = new Set(aKids);
        const cKids = (childrenByParent.get(coParent) ?? []).filter(k => pathwaySet.has(k));
        return cKids.find(k => aKidSet.has(k)) ?? null;
      })();
      const earliestEdgeToShared = (pid: number): number => {
        if (sharedKid == null) return Number.MAX_SAFE_INTEGER;
        let minId = Number.MAX_SAFE_INTEGER;
        for (const e of graph.edges) {
          if (e.derived) continue;
          if (e.type !== 'parent_of') continue;
          if (e.aId !== pid || e.bId !== sharedKid) continue;
          if (e.id != null && e.id < minId) minId = e.id;
        }
        return minId;
      };
      // Gender rank: male=0 (left), female=1 (right), unknown=0.5
      // (sits between, falls through to other tiebreaks). 'combined'
      // (intersex / both) treated as unknown for layout — same
      // tiebreak path as no-gender.
      const genderRank = (pid: number): number => {
        const g = byId.get(pid)?.gender;
        if (g === 'male') return 0;
        if (g === 'female') return 1;
        return 0.5;
      };
      const sorted = [...candidates].sort((x, y) => {
        const dx = pullXOf(x) - pullXOf(y);
        if (dx !== 0) return dx;
        const dg = genderRank(x) - genderRank(y);
        if (dg !== 0) return dg;
        const ea = earliestEdgeToShared(x) - earliestEdgeToShared(y);
        if (ea !== 0) return ea;
        return x - y;
      });
      const left = sorted[0];
      const right = sorted.length > 1 ? sorted[sorted.length - 1] : null;
      const pairPullX = pullXOf(left);
      const key = right != null ? `${Math.min(left, right)}-${Math.max(left, right)}` : `${left}-solo`;
      const idx = pairs.length;
      pairs.push({ left, right, pullX: pairPullX, key });
      parentToPair.set(left, idx);
      if (right != null) parentToPair.set(right, idx);
    }

    // Sort pairs left-to-right by pull-X so paternal-line stays on
    // the canvas's left side and maternal-line on the right.
    pairs.sort((p, q) => p.pullX - q.pullX || p.key.localeCompare(q.key));

    const pairMembers = new Set<number>(parentToPair.keys());

    // Find each pathway-parent's siblings (other children of their
    // own parents in this gen — = great-aunts/uncles via this
    // ancestor). Excludes pair-mates so paternal grandfather doesn't
    // get paternal grandmother counted as a sibling even when they
    // happen to share a grandparent (the rare incest topology — we
    // don't handle that gracefully, but excluding pair-mates is the
    // sane default).
    const findSiblings = (parentId: number): number[] => {
      const sibs = new Set<number>();
      // Method A — shared grandparents (parent_of upward, then downward).
      // Standard sibling derivation when both parents exist on the tree.
      const grandparentIds = new Set<number>();
      for (const e of graph.edges) {
        if (e.type !== 'parent_of') continue;
        if (e.bId !== parentId) continue;
        grandparentIds.add(e.aId);
      }
      for (const e of graph.edges) {
        if (e.type !== 'parent_of') continue;
        if (!grandparentIds.has(e.aId)) continue;
        if (e.bId === parentId) continue;
        if (pairMembers.has(e.bId)) continue;
        if (idSet.has(e.bId)) sibs.add(e.bId);
      }
      // Method B — direct sibling_of edges (stored OR derived). Critical
      // for the case where the shared parent IS in the DB but has been
      // stripped from layoutGraph (e.g. an unnamed placeholder grandmother
      // glueing two named sisters together): method A finds no
      // grandparents, so without this fallback Gladys would lose her
      // Sylvia-adjacent slot. The server synthesises a derived
      // sibling_of edge for any pair sharing a parent (placeholder
      // included), so this hits exactly the topology we need.
      for (const e of graph.edges) {
        if (e.type !== 'sibling_of') continue;
        let other: number | null = null;
        if (e.aId === parentId) other = e.bId;
        else if (e.bId === parentId) other = e.aId;
        if (other == null) continue;
        if (pairMembers.has(other)) continue;
        if (!idSet.has(other)) continue;
        sibs.add(other);
      }
      return [...sibs];
    };
    const findInLawSpouses = (auntUncleId: number): number[] => {
      const spouses: number[] = [];
      for (const e of graph.edges) {
        if (e.type !== 'spouse_of') continue;
        let other: number | null = null;
        if (e.aId === auntUncleId) other = e.bId;
        else if (e.bId === auntUncleId) other = e.aId;
        if (other == null) continue;
        if (other === auntUncleId) continue;
        if (pairMembers.has(other)) continue;
        if (!idSet.has(other)) continue;
        if (!spouses.includes(other)) spouses.push(other);
      }
      return spouses;
    };

    const used = new Set<number>();
    const orderedIds: number[] = [];
    for (const pair of pairs) {
      const leftSibs = [...findSiblings(pair.left)].sort((a, b) => a - b);
      const rightSibs = pair.right != null ? [...findSiblings(pair.right)].sort((a, b) => a - b) : [];
      for (const auntUncleId of leftSibs) {
        for (const spId of findInLawSpouses(auntUncleId)) {
          if (!used.has(spId)) { used.add(spId); orderedIds.push(spId); }
        }
        if (!used.has(auntUncleId)) { used.add(auntUncleId); orderedIds.push(auntUncleId); }
      }
      if (!used.has(pair.left)) { used.add(pair.left); orderedIds.push(pair.left); }
      if (pair.right != null && !used.has(pair.right)) { used.add(pair.right); orderedIds.push(pair.right); }
      for (const auntUncleId of rightSibs) {
        if (!used.has(auntUncleId)) { used.add(auntUncleId); orderedIds.push(auntUncleId); }
        for (const spId of findInLawSpouses(auntUncleId)) {
          if (!used.has(spId)) { used.add(spId); orderedIds.push(spId); }
        }
      }
    }
    // Trail anything not connected to a bloodline-pathway pair —
    // typically aunts/uncles whose own bloodline pair-mate isn't on
    // canvas, or stray non-pathway nodes. Stable sort by person_id.
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
  const idSet = new Set(genNodes.map(n => n.personId));
  const byId = new Map(genNodes.map(n => [n.personId, n] as const));
  const spousesById = new Map<number, number[]>();
  const childrenOf = new Map<number, number[]>();
  const parentsOf = new Map<number, number[]>();
  const sibOf = new Map<number, number[]>();
  const push = (m: Map<number, number[]>, k: number, v: number) => { if (!m.has(k)) m.set(k, []); m.get(k)!.push(v); };
  for (const e of graph.edges) {
    if (e.type === 'spouse_of') { if (idSet.has(e.aId)) push(spousesById, e.aId, e.bId); if (idSet.has(e.bId)) push(spousesById, e.bId, e.aId); }
    else if (e.type === 'parent_of') { push(childrenOf, e.aId, e.bId); push(parentsOf, e.bId, e.aId); }
    else if (e.type === 'sibling_of') { push(sibOf, e.aId, e.bId); push(sibOf, e.bId, e.aId); }
  }
  // Bloodline = focus + ancestors + everyone descended from focus/an ancestor +
  // siblings (mirror of computePedigreeLayout's `bloodline`). Married-in spouses
  // attach via spouse_of only and are NOT in here — that's how we tell a real
  // in-law (Lindsay, who has her own parked family) from a bloodline child.
  const focus = graph.focusPersonId;
  const anc = new Set<number>();
  { const q = [focus]; while (q.length) { const c = q.shift()!; for (const p of parentsOf.get(c) ?? []) if (!anc.has(p)) { anc.add(p); q.push(p); } } }
  const bloodlineSet = new Set<number>([focus, ...anc]);
  { const q = [focus, ...anc]; while (q.length) { const c = q.shift()!; for (const k of childrenOf.get(c) ?? []) if (!bloodlineSet.has(k)) { bloodlineSet.add(k); q.push(k); } for (const s of sibOf.get(c) ?? []) if (!bloodlineSet.has(s)) { bloodlineSet.add(s); q.push(s); } } }
  const pullX = (childId: number): number | null => {
    const parentXs = graph.edges
      .filter(e => e.type === 'parent_of' && e.bId === childId)
      .map(e => placed.get(e.aId)?.x)
      .filter((x): x is number => x != null);
    if (parentXs.length === 0) return null;
    return parentXs.reduce((a, b) => a + b, 0) / parentXs.length;
  };
  // SPOUSE ADJACENCY (Terry 2026-06-26 — the couples-split bug): the old
  // version sorted EVERY node by parent-midpoint, so married-in spouses
  // clustered away from their partners (Colin's wife landed past his sister;
  // Ben+Karen / Jenny+Dan interleaved). The married-in test is BLOODLINE, not
  // "has no parents" — a real in-law (Lindsay) has her OWN parked family, so
  // pullX isn't null for her. Fix: order the BLOODLINE descendants by parent
  // midpoint, then drop each married-in (non-bloodline) spouse in immediately
  // beside their partner so every couple stays together. Tiebreak person_id ASC
  // (stable, "first-created sits left") matching orderParentGeneration.
  const kids = genNodes.filter(n => bloodlineSet.has(n.personId));
  kids.sort((a, b) => {
    const dx = (pullX(a.personId) ?? 0) - (pullX(b.personId) ?? 0);
    return dx !== 0 ? dx : a.personId - b.personId;
  });
  const result: FamilyGraphNode[] = [];
  const used = new Set<number>();
  for (const n of kids) {
    if (used.has(n.personId)) continue;
    result.push(n); used.add(n.personId);
    // append this child's married-in (non-bloodline) spouse(s) right beside them
    for (const s of spousesById.get(n.personId) ?? []) {
      if (idSet.has(s) && !used.has(s) && !bloodlineSet.has(s)) { result.push(byId.get(s)!); used.add(s); }
    }
  }
  // Leftovers — spouses whose partner isn't in this gen, or all-in-law rows —
  // keep in a stable order so nothing is dropped.
  for (const n of genNodes) if (!used.has(n.personId)) { result.push(n); used.add(n.personId); }
  return result;
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
  options: LayoutOptions = {},
  expandedHeads: Set<number> = new Set(),
  collapsedDirect: Set<number> = new Set()
): TreeLayout & { collapsedCountPerAnchor: Map<number, number> } {
  const base = computePedigreeLayout(graph, options, expandedHeads, collapsedDirect);
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
