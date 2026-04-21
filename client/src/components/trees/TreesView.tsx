import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Users, X, GitBranch, RefreshCw, UserPlus, Pin } from 'lucide-react';
import {
  getFamilyGraph,
  listPersons,
  removeRelationship,
  createNamedPerson,
  createPlaceholderPerson,
  addRelationship,
  getPersonsCooccurrence,
  getPartnerSuggestionScores,
  listAllRelationships,
  type FamilyGraph,
} from '@/lib/electron-bridge';
import { computeFocusLayout, augmentWithVirtualGhosts } from '@/lib/trees-layout';
import { TreesCanvas } from './TreesCanvas';
import { SetRelationshipModal } from './SetRelationshipModal';
import { promptConfirm } from './promptConfirm';

interface PersonSummary {
  id: number;
  name: string;
  /** Photos this person appears in — used for the Photos sort option. */
  photoCount: number;
}

/**
 * Trees v1 — family graph explorer.
 *
 * Flow:
 *   1. Mount → show focus picker modal.
 *   2. User picks focus person → fetch graph + compute layout.
 *   3. Canvas renders; double-click a node → refocus on that person.
 *   4. Right-click a node → Add parent / partner / child / Remove.
 */
export function TreesView() {
  const [focusPersonId, setFocusPersonId] = useState<number | null>(null);
  // The picker opens only if we can't auto-pick a sensible focus.
  const [focusPickerOpen, setFocusPickerOpen] = useState(false);
  const [autoFocusAttempted, setAutoFocusAttempted] = useState(false);
  const [graph, setGraph] = useState<FamilyGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedHops, setExpandedHops] = useState(3);
  // Two independent filters, each can be on or off:
  //   • Steps — undirected hops from focus (wide net, includes cousins
  //     and in-laws at each step).
  //   • Generations — vertical ancestor/descendant depth, with siblings
  //     and spouses at each level included automatically.
  // When both are ON, a person must satisfy BOTH criteria (intersection)
  // to be shown — the two filters compose rather than replace each other.
  // When both are OFF, only the focus person is visible.
  const [stepsEnabled, setStepsEnabled] = useState(true);
  const [generationsEnabled, setGenerationsEnabled] = useState(false);
  const [ancestorsDepth, setAncestorsDepth] = useState(2);
  const [descendantsDepth, setDescendantsDepth] = useState(2);
  const [allPersons, setAllPersons] = useState<PersonSummary[]>([]);
  const [relationshipEditorFor, setRelationshipEditorFor] = useState<number | null>(null);
  /** Target of an in-flight quick-add (chip around a node). null = no picker open. */
  const [quickAdd, setQuickAdd] = useState<{
    fromPersonId: number;
    kind: 'parent' | 'partner' | 'child' | 'sibling';
  } | null>(null);
  /**
   * People who should remain visible even though they're beyond the
   * user's selected Depth. Map of personId → their hop distance from
   * the current focus. Cleared when the focus changes (pins are
   * focus-relative). Populated when the user creates a new person via a
   * + chip that ends up further out than the Depth dropdown allows.
   */
  const [pinnedPeople, setPinnedPeople] = useState<Map<number, number>>(new Map());
  const lastFocusRef = useRef<number | null>(null);

  // Load the person list — used by focus picker and relationship-target
  // picker. Exposed as a callback so modals that create new people can
  // ask for a refresh.
  const reloadPersons = useCallback(async () => {
    const res = await listPersons();
    if (res.success && res.data) {
      setAllPersons(res.data.map(p => ({ id: p.id, name: p.name, photoCount: p.photo_count ?? 0 })));
    }
  }, []);

  useEffect(() => {
    reloadPersons();
  }, [reloadPersons]);

  // Auto-focus on first open: ONLY use the last focus you explicitly
  // chose (stored in localStorage). If there isn't one, show the picker.
  // We don't second-guess with graph analysis — your first pick wins
  // forever, and you change it deliberately via the Change focus button.
  useEffect(() => {
    if (autoFocusAttempted || focusPersonId != null) return;
    if (allPersons.length === 0) return;
    setAutoFocusAttempted(true);
    try {
      // One-time migration: previous builds had an auto-picker that
      // clobbered localStorage with "most-photographed" as focus. Wipe
      // any such stale value on first run of this build so the user
      // gets to choose fresh.
      if (!localStorage.getItem('pdr-trees-last-focus-migrated-v3')) {
        localStorage.removeItem('pdr-trees-last-focus');
        localStorage.setItem('pdr-trees-last-focus-migrated-v3', '1');
      }
      const stored = localStorage.getItem('pdr-trees-last-focus');
      const storedId = stored ? parseInt(stored, 10) : NaN;
      if (Number.isFinite(storedId) && allPersons.some(p => p.id === storedId)) {
        setFocusPersonId(storedId);
        return;
      }
    } catch {}
    // No stored default → open the picker so the user makes a deliberate choice.
    setFocusPickerOpen(true);
  }, [allPersons, autoFocusAttempted, focusPersonId]);

  // Persist focus so the next Trees open lands on the same person.
  useEffect(() => {
    if (focusPersonId != null) {
      try { localStorage.setItem('pdr-trees-last-focus', String(focusPersonId)); } catch {}
    }
  }, [focusPersonId]);

  // Fetch graph whenever the focus OR the requested depth changes.
  // Depth === the number of relationship hops walked outward from the
  // focus person. It's also reused as the display horizon so the
  // dropdown genuinely controls what you see.
  const refetchGraph = useCallback(async (personId: number, hops: number) => {
    setLoading(true);
    const res = await getFamilyGraph(personId, hops);
    if (res.success && res.data) setGraph(res.data);
    setLoading(false);
  }, []);

  // Total fetch depth = max(whichever filter is active, deepest pinned
  // pathway). Generations mode needs +1 hop over the deepest shown level
  // to capture same-generation spouses reached through a spouse_of edge.
  const fetchDepth = useMemo(() => {
    const stepsReach = stepsEnabled ? expandedHops : 0;
    const gensReach = generationsEnabled
      ? Math.max(ancestorsDepth, descendantsDepth) + 1
      : 0;
    let max = Math.max(stepsReach, gensReach, 1); // floor at 1 so "both off" still fetches focus + immediate neighbours for any add-flows
    for (const hop of pinnedPeople.values()) max = Math.max(max, hop);
    return Math.min(max, 10); // safety cap
  }, [stepsEnabled, generationsEnabled, expandedHops, ancestorsDepth, descendantsDepth, pinnedPeople]);

  useEffect(() => {
    if (focusPersonId == null) return;
    if (lastFocusRef.current !== focusPersonId) {
      // Focus changed → pins are from the previous focus's perspective,
      // so drop them rather than keep stale hop numbers around.
      setPinnedPeople(new Map());
      lastFocusRef.current = focusPersonId;
    }
    refetchGraph(focusPersonId, fetchDepth);
  }, [focusPersonId, fetchDepth, refetchGraph]);

  // ─── Generation-offset BFS ──────────────────────────────────────
  // For each person in the graph, compute their generation relative to
  // focus: 0 = same generation (focus + siblings + spouses), +1 = parents
  // generation, +2 = grandparents, -1 = children, etc. parent_of edges
  // shift the offset; sibling_of and spouse_of keep it; associated_with
  // is ignored (no clear generation meaning). Null = unreachable.
  const generationOffsets = useMemo(() => {
    const out = new Map<number, number>();
    if (!graph || focusPersonId == null) return out;
    out.set(focusPersonId, 0);
    const queue: number[] = [focusPersonId];
    while (queue.length) {
      const cur = queue.shift()!;
      const curGen = out.get(cur)!;
      for (const e of graph.edges) {
        if (e.derived) continue;
        let neighbour: number | null = null;
        let shift = 0;
        if (e.type === 'parent_of') {
          if (e.aId === cur) { neighbour = e.bId; shift = -1; } // child
          else if (e.bId === cur) { neighbour = e.aId; shift = +1; } // parent
        } else if (e.type === 'sibling_of' || e.type === 'spouse_of') {
          if (e.aId === cur) neighbour = e.bId;
          else if (e.bId === cur) neighbour = e.aId;
          // shift = 0
        }
        if (neighbour == null) continue;
        const newGen = curGen + shift;
        const existing = out.get(neighbour);
        // Keep the offset closest to focus (smallest absolute value) —
        // stops BFS from inflating offsets through long spouse chains.
        if (existing == null || Math.abs(newGen) < Math.abs(existing)) {
          out.set(neighbour, newGen);
          queue.push(neighbour);
        }
      }
    }
    return out;
  }, [graph, focusPersonId]);

  // ─── Asymmetric visibility filter ──────────────────────────────
  // Rather than expanding the entire tree when one branch goes deep
  // (symmetric depth bump), we restrict the rendered graph to:
  //   • Steps mode: every node within the user-selected Depth from focus
  //   • Generations mode: everyone whose generation offset is in the
  //     range [-descendantsDepth, +ancestorsDepth]. Siblings and spouses
  //     at each shown level come along automatically (same-generation).
  //   • PLUS the shortest-path from focus to each pinned person
  //     (i.e. "unlock only that pathway")
  // Other branches stay at the dropdown's depth.
  const visibleGraph = useMemo(() => {
    if (!graph || focusPersonId == null) return graph;
    const visible = new Set<number>();
    // Always show the focus person regardless of filters — they're the
    // anchor the view is centred on.
    visible.add(focusPersonId);
    // Apply filters: intersection when both on, single when one on,
    // nothing extra when both off (focus-only).
    if (stepsEnabled || generationsEnabled) {
      for (const n of graph.nodes) {
        const passesSteps = !stepsEnabled ? true : n.hopsFromFocus <= expandedHops;
        const gen = generationOffsets.get(n.personId);
        const passesGens = !generationsEnabled
          ? true
          : (gen != null && gen >= -descendantsDepth && gen <= ancestorsDepth);
        if (passesSteps && passesGens) visible.add(n.personId);
      }
    }
    if (pinnedPeople.size > 0) {
      // Build an undirected adjacency map for BFS.
      const adj = new Map<number, Set<number>>();
      for (const e of graph.edges) {
        if (!adj.has(e.aId)) adj.set(e.aId, new Set());
        if (!adj.has(e.bId)) adj.set(e.bId, new Set());
        adj.get(e.aId)!.add(e.bId);
        adj.get(e.bId)!.add(e.aId);
      }
      for (const pinnedId of pinnedPeople.keys()) {
        const path = bfsShortestPath(adj, focusPersonId, pinnedId);
        for (const id of path) visible.add(id);
      }
    }
    return {
      ...graph,
      nodes: graph.nodes.filter(n => visible.has(n.personId)),
      edges: graph.edges.filter(e => visible.has(e.aId) && visible.has(e.bId)),
    };
  }, [graph, focusPersonId, stepsEnabled, generationsEnabled, expandedHops, ancestorsDepth, descendantsDepth, generationOffsets, pinnedPeople]);

  // Augment the visible graph with virtual ghost parents for every named
  // person that has fewer than 2 stored parents (one generation only).
  // Layout depth uses the widest active filter so spacing accommodates
  // the deepest visible branch.
  const effectiveLayoutHops = Math.max(
    stepsEnabled ? expandedHops : 0,
    generationsEnabled ? Math.max(ancestorsDepth, descendantsDepth) : 0,
    1, // never 0 — layout needs breathing room even in focus-only view
  );
  const layoutGraph = visibleGraph ? augmentWithVirtualGhosts(visibleGraph, effectiveLayoutHops) : null;
  const layout = layoutGraph ? computeFocusLayout(layoutGraph, effectiveLayoutHops) : null;

  const handleRefocus = useCallback((personId: number) => {
    setFocusPersonId(personId);
  }, []);

  const handleRelationshipCreated = useCallback(() => {
    // A graph mutation can also change the person table (e.g. a ghost
    // placeholder getting named, or a new named person created via the
    // modal). Reload BOTH so pickers that filter by is_placeholder
    // don't leave the newly-named person out of the list.
    reloadPersons();
    if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
  }, [focusPersonId, fetchDepth, refetchGraph, reloadPersons]);

  /** Finalise a quick-add: the user has picked (or created) the other person,
   *  so wire the actual relationship based on the chip direction. */
  const finaliseQuickAdd = useCallback(async (otherPersonId: number) => {
    if (!quickAdd) return;
    const { fromPersonId, kind } = quickAdd;
    setQuickAdd(null);
    if (kind === 'parent') {
      await addRelationship({ personAId: otherPersonId, personBId: fromPersonId, type: 'parent_of' });
    } else if (kind === 'child') {
      await addRelationship({ personAId: fromPersonId, personBId: otherPersonId, type: 'parent_of' });
    } else if (kind === 'partner') {
      await addRelationship({ personAId: fromPersonId, personBId: otherPersonId, type: 'spouse_of' });
    } else if (kind === 'sibling') {
      // Use the same 2-parents-guaranteed logic as the modal: cross-inherit, then top up with ghosts.
      const parentsOf = (pid: number): number[] => {
        if (!graph) return [];
        return graph.edges
          .filter(e => e.type === 'parent_of' && e.bId === pid && !e.derived)
          .map(e => e.aId);
      };
      const fromParents = parentsOf(fromPersonId);
      const toParents = parentsOf(otherPersonId);
      for (const pid of toParents) {
        if (!fromParents.includes(pid)) await addRelationship({ personAId: pid, personBId: fromPersonId, type: 'parent_of' });
      }
      for (const pid of fromParents) {
        if (!toParents.includes(pid)) await addRelationship({ personAId: pid, personBId: otherPersonId, type: 'parent_of' });
      }
      const shared = new Set<number>([...fromParents, ...toParents]);
      const missing = Math.max(0, 2 - shared.size);
      for (let i = 0; i < missing; i++) {
        const ph = await createPlaceholderPerson();
        if (ph.success && ph.data != null) {
          await addRelationship({ personAId: ph.data, personBId: fromPersonId, type: 'parent_of' });
          await addRelationship({ personAId: ph.data, personBId: otherPersonId, type: 'parent_of' });
        }
      }
    }

    // Probe fetch depth upward until the new person appears, so we know
    // their hop distance. If they end up beyond the user's selected
    // Depth, pin them — that keeps them visible via the asymmetric
    // pathway without expanding every other branch symmetrically.
    if (focusPersonId != null) {
      let probeDepth = fetchDepth;
      for (let i = 0; i < 7 && probeDepth <= 10; i++) {
        const res = await getFamilyGraph(focusPersonId, probeDepth);
        if (res.success && res.data) {
          const found = res.data.nodes.find(n => n.personId === otherPersonId);
          if (found) {
            setGraph(res.data);
            if (found.hopsFromFocus > expandedHops) {
              setPinnedPeople(prev => {
                const next = new Map(prev);
                next.set(otherPersonId, found.hopsFromFocus);
                return next;
              });
            }
            return;
          }
        }
        probeDepth++;
      }
      // Couldn't find them within 10 hops — unusual; just refresh at default.
      refetchGraph(focusPersonId, fetchDepth);
    }
  }, [quickAdd, graph, focusPersonId, expandedHops, fetchDepth, refetchGraph]);

  const handleRemovePerson = useCallback(async (personId: number) => {
    // Remove every edge touching this person in the current graph.
    if (!graph) return;
    const edgesToRemove = graph.edges.filter(e =>
      (e.aId === personId || e.bId === personId) && e.id != null && !e.derived
    );
    if (edgesToRemove.length === 0) return;
    const confirmMsg = `This will remove all ${edgesToRemove.length} relationship${edgesToRemove.length === 1 ? '' : 's'} involving this person. The person themselves stays — only the relationships go.`;
    if (!(await promptConfirm({
      title: `Remove all relationships?`,
      message: confirmMsg,
      confirmLabel: 'Remove all',
      danger: true,
    }))) return;
    for (const e of edgesToRemove) {
      if (e.id != null) await removeRelationship(e.id);
    }
    if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
  }, [graph, focusPersonId, fetchDepth, refetchGraph]);


  return (
    <div className="flex-1 h-full flex flex-col bg-background relative">
      {/* Header bar */}
      <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-3">
        <GitBranch className="w-5 h-5 text-primary" />
        <h2 className="text-base font-semibold">Trees</h2>
        {graph && (
          <>
            <span className="text-xs text-muted-foreground">
              {graph.nodes.length} {graph.nodes.length === 1 ? 'person' : 'people'} · {graph.edges.filter(e => !e.derived).length} relationships
            </span>
            <div className="flex-1" />
            <button
              onClick={() => setFocusPickerOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-accent transition-colors"
              title="Change the focus person"
            >
              <Users className="w-4 h-4" />
              Change focus
            </button>
            {pinnedPeople.size > 0 && (
              <button
                onClick={() => setPinnedPeople(new Map())}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-amber-500/10 border border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-colors"
                title={`${pinnedPeople.size} person${pinnedPeople.size === 1 ? ' is' : 's are'} pinned beyond your current Depth. Click to reset and re-hide them.`}
              >
                <Pin className="w-3 h-3" />
                {pinnedPeople.size} pinned
              </button>
            )}
            {/* Steps filter — toggle + always-visible Depth dropdown.
                Fields stay rendered (just dimmed) when the toggle is
                off so the header layout never jumps between states. */}
            <div className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-lg border border-border bg-background">
              <button
                onClick={() => setStepsEnabled(v => !v)}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${stepsEnabled ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent'}`}
                title={stepsEnabled
                  ? 'Click to turn off the Steps filter. With both filters off, only the focus person is shown.'
                  : 'Turn on Steps — undirected hops from focus. Includes siblings, cousins, in-laws equally as each step expands.'}
                aria-pressed={stepsEnabled}
              >
                Steps
              </button>
              <select
                value={expandedHops}
                onChange={e => setExpandedHops(parseInt(e.target.value, 10))}
                disabled={!stepsEnabled}
                className={`bg-background border border-border rounded px-1 py-0 text-xs ${stepsEnabled ? '' : 'opacity-40'}`}
                title="Hops from focus: 1 = parents/partners/siblings/children only. Higher values reach further."
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
                <option value={5}>5</option>
                <option value={6}>6</option>
              </select>
            </div>
            {/* Generations filter — toggle + always-visible ↑ / ↓ dials. */}
            <div className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-lg border border-border bg-background">
              <button
                onClick={() => setGenerationsEnabled(v => !v)}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${generationsEnabled ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent'}`}
                title={generationsEnabled
                  ? 'Click to turn off the Generations filter.'
                  : 'Turn on Generations — vertical ancestor/descendant depth. Siblings and spouses at each shown generation come along automatically.'}
                aria-pressed={generationsEnabled}
              >
                Generations
              </button>
              <label className={`inline-flex items-center gap-0.5 text-xs ${generationsEnabled ? 'text-muted-foreground' : 'text-muted-foreground/40'}`} title="Generations above focus (parents, grandparents…)">
                ↑
                <select
                  value={ancestorsDepth}
                  onChange={e => setAncestorsDepth(parseInt(e.target.value, 10))}
                  disabled={!generationsEnabled}
                  className={`bg-background border border-border rounded px-1 py-0 text-xs ${generationsEnabled ? '' : 'opacity-40'}`}
                >
                  <option value={0}>0</option>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                  <option value={5}>5</option>
                </select>
              </label>
              <label className={`inline-flex items-center gap-0.5 text-xs ${generationsEnabled ? 'text-muted-foreground' : 'text-muted-foreground/40'}`} title="Generations below focus (children, grandchildren…)">
                ↓
                <select
                  value={descendantsDepth}
                  onChange={e => setDescendantsDepth(parseInt(e.target.value, 10))}
                  disabled={!generationsEnabled}
                  className={`bg-background border border-border rounded px-1 py-0 text-xs ${generationsEnabled ? '' : 'opacity-40'}`}
                >
                  <option value={0}>0</option>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                  <option value={5}>5</option>
                </select>
              </label>
            </div>
            <button
              onClick={() => focusPersonId != null && refetchGraph(focusPersonId, fetchDepth)}
              className="p-1.5 rounded-lg border border-border hover:bg-accent transition-colors"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </>
        )}
      </div>

      {/* Canvas */}
      <div className="flex-1 relative overflow-hidden">
        {loading && !layout && (
          <div className="absolute inset-0 flex items-center justify-center">
            <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {layout && (
          <TreesCanvas
            layout={layout}
            onRefocus={handleRefocus}
            onSetRelationship={(personId) => setRelationshipEditorFor(personId)}
            onRemovePerson={handleRemovePerson}
            onGraphMutated={handleRelationshipCreated}
            onQuickAddParent={(personId) => setQuickAdd({ fromPersonId: personId, kind: 'parent' })}
            onQuickAddPartner={(personId) => setQuickAdd({ fromPersonId: personId, kind: 'partner' })}
            onQuickAddChild={(personId) => setQuickAdd({ fromPersonId: personId, kind: 'child' })}
            onQuickAddSibling={(personId) => setQuickAdd({ fromPersonId: personId, kind: 'sibling' })}
          />
        )}
        {/* Empty-state hint — anchored to the top of the canvas so it never
            overlaps with the centred focus avatar. */}
        {!loading && graph && graph.nodes.length === 1 && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 max-w-lg text-center px-4 py-3 bg-background/95 backdrop-blur rounded-lg shadow-md border border-border pointer-events-none">
            <h3 className="text-sm font-semibold">Right-click your focus person to set a relationship</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              You've already named people in People Manager — here you just connect them. Pick any two, say how they're related (parent, sibling, cousin, partner…), and PDR stores the link.
            </p>
          </div>
        )}
      </div>

      {/* Focus picker modal — the sort toggle is enabled here so the user
          can browse by Connections / Photos / A–Z when changing focus. */}
      {focusPickerOpen && (
        <FocusPickerModal
          persons={allPersons}
          currentFocusId={focusPersonId}
          showSortOptions={true}
          onPick={(personId) => {
            setFocusPersonId(personId);
            setFocusPickerOpen(false);
          }}
          onPersonsChanged={reloadPersons}
          onClose={() => {
            if (focusPersonId != null) setFocusPickerOpen(false);
          }}
        />
      )}

      {/* Quick-add picker — fires when the user clicks one of the +
          chips around a node. Uses the same searchable person list with
          "create new" support as the focus picker. */}
      {quickAdd && (() => {
        const fromPerson = allPersons.find(p => p.id === quickAdd.fromPersonId);
        const title = quickAdd.kind === 'parent'  ? `Add ${fromPerson?.name ?? 'this person'}'s parent`
                    : quickAdd.kind === 'child'   ? `Add ${fromPerson?.name ?? 'this person'}'s child`
                    : quickAdd.kind === 'partner' ? `Add ${fromPerson?.name ?? 'this person'}'s partner`
                    : `Add a sibling for ${fromPerson?.name ?? 'this person'}`;
        // Filter out logically-impossible candidates so the picker only
        // suggests people who CAN hold the relationship you're adding.
        //   • Always exclude the "from" person themselves
        //   • For + parent: exclude descendants and siblings
        //   • For + child: exclude ancestors
        //   • For + partner: exclude blood relatives
        //   • For + sibling: exclude your own parents/children
        const excluded = impossibleCandidates(quickAdd.fromPersonId, quickAdd.kind, graph);
        // For + partner: compute the set of co-parents — people who are
        // already a parent of at least one of fromPerson's children.
        // These are the strongest partner suggestions (Alan is Sally's
        // children's other parent → Alan should top the list, not Mel
        // who just happens to share a photo with Sally).
        const coparents = quickAdd.kind === 'partner' ? coparentsOf(quickAdd.fromPersonId, graph) : undefined;
        // For partner quick-add, use intimacy/tag-weighted partner score
        // instead of raw cooccurrence count — 2 group photos shouldn't
        // beat 1 intimate photo. Non-partner adds keep the simple count.
        const isPartner = quickAdd.kind === 'partner';
        return (
          <FocusPickerModal
            persons={allPersons.filter(p => p.id !== quickAdd.fromPersonId && !excluded.has(p.id))}
            currentFocusId={null}
            title={title}
            cooccurrenceAnchorId={isPartner ? undefined : quickAdd.fromPersonId}
            partnerScoreAnchorId={isPartner ? quickAdd.fromPersonId : undefined}
            coparentIds={coparents}
            onPick={finaliseQuickAdd}
            onPersonsChanged={reloadPersons}
            onClose={() => setQuickAdd(null)}
          />
        );
      })()}

      {/* Declarative relationship editor — any two named people, any link type. */}
      {relationshipEditorFor != null && (() => {
        const fromPerson = allPersons.find(p => p.id === relationshipEditorFor);
        if (!fromPerson) return null;
        return (
          <SetRelationshipModal
            fromPersonId={relationshipEditorFor}
            fromPersonName={fromPerson.name}
            persons={allPersons}
            graph={graph}
            onClose={() => setRelationshipEditorFor(null)}
            onRelationshipCreated={handleRelationshipCreated}
            onPersonsChanged={reloadPersons}
          />
        );
      })()}
    </div>
  );
}

/**
 * Return the set of person IDs who are "co-parents" of `fromId` — i.e.,
 * anyone currently registered as a parent of any of fromId's children.
 * These are the obvious candidates when asking "who's fromId's partner?"
 * because they already share kids in the tree, regardless of whether a
 * spouse_of edge has been asserted yet.
 */
function coparentsOf(fromId: number, graph: FamilyGraph | null): Set<number> {
  const out = new Set<number>();
  if (!graph) return out;
  const myChildren = graph.edges
    .filter(e => e.type === 'parent_of' && e.aId === fromId && !e.derived)
    .map(e => e.bId);
  for (const childId of myChildren) {
    for (const e of graph.edges) {
      if (e.type !== 'parent_of' || e.derived) continue;
      if (e.bId === childId && e.aId !== fromId) out.add(e.aId);
    }
  }
  return out;
}

/**
 * Return the set of person IDs that CAN'T hold a given kind of
 * relationship to `fromId`, so the quick-add picker doesn't suggest
 * them. Common-sense filters:
 *   • + parent: can't be yourself, your siblings, your descendants,
 *     or anyone ALREADY on your parent list (you already have them).
 *   • + child: can't be yourself, your ancestors, or an existing child.
 *   • + partner: can't be yourself, anyone in your existing family
 *     graph closure (blood, in-laws, ex-in-laws, exes — anyone reached
 *     by any chain of recorded relationships), and can't be someone
 *     currently partnered to a third party.
 *   • + sibling: can't be yourself, your parents, or your children.
 */
function impossibleCandidates(
  fromId: number,
  kind: 'parent' | 'partner' | 'child' | 'sibling',
  graph: FamilyGraph | null
): Set<number> {
  const out = new Set<number>([fromId]);
  if (!graph) return out;

  const parentsOf = (pid: number): number[] =>
    graph.edges.filter(e => e.type === 'parent_of' && e.bId === pid && !e.derived).map(e => e.aId);
  const childrenOf = (pid: number): number[] =>
    graph.edges.filter(e => e.type === 'parent_of' && e.aId === pid && !e.derived).map(e => e.bId);

  // BFS up/down helpers.
  const ancestors = (start: number): Set<number> => {
    const seen = new Set<number>();
    const q = [start];
    while (q.length) {
      const cur = q.shift()!;
      for (const p of parentsOf(cur)) {
        if (seen.has(p)) continue;
        seen.add(p);
        q.push(p);
      }
    }
    return seen;
  };
  const descendants = (start: number): Set<number> => {
    const seen = new Set<number>();
    const q = [start];
    while (q.length) {
      const cur = q.shift()!;
      for (const c of childrenOf(cur)) {
        if (seen.has(c)) continue;
        seen.add(c);
        q.push(c);
      }
    }
    return seen;
  };

  const myParents = new Set(parentsOf(fromId));
  const myChildren = new Set(childrenOf(fromId));

  // Siblings = people who share at least one parent with fromId.
  const mySiblings = new Set<number>();
  for (const p of myParents) {
    for (const sib of childrenOf(p)) {
      if (sib !== fromId) mySiblings.add(sib);
    }
  }

  if (kind === 'parent') {
    // Exclude descendants, siblings, and existing parents.
    for (const d of descendants(fromId)) out.add(d);
    for (const s of mySiblings) out.add(s);
    for (const p of myParents) out.add(p);
  } else if (kind === 'child') {
    for (const a of ancestors(fromId)) out.add(a);
    for (const c of myChildren) out.add(c);
  } else if (kind === 'partner') {
    // Full family-graph closure: anyone reached by walking ANY recorded
    // relationship edge (parent_of, sibling_of, spouse_of incl. ended,
    // associated_with) from fromId. This naturally excludes blood
    // relatives (incest), in-laws (brother's wife's family), ex-in-laws
    // (brother's ex-wife), and the person's own exes in a single pass.
    for (const id of familyClosure(fromId, graph)) out.add(id);
    // Plus anyone currently in an active spouse_of with a third party.
    for (const id of currentlyPartnered(graph, fromId)) out.add(id);
  } else if (kind === 'sibling') {
    for (const a of ancestors(fromId)) out.add(a);
    for (const d of descendants(fromId)) out.add(d);
  }
  return out;
}

/**
 * Connected component of `fromId` using every non-derived relationship
 * edge as an undirected link. Produces the "extended family closure":
 * blood relatives, in-laws, ex-in-laws, exes, and anyone else already
 * tied to fromId through a chain of recorded relationships.
 */
function familyClosure(fromId: number, graph: FamilyGraph | null): Set<number> {
  const closure = new Set<number>([fromId]);
  if (!graph) return closure;
  const adj = new Map<number, Set<number>>();
  for (const e of graph.edges) {
    if (e.derived) continue;
    if (!adj.has(e.aId)) adj.set(e.aId, new Set());
    if (!adj.has(e.bId)) adj.set(e.bId, new Set());
    adj.get(e.aId)!.add(e.bId);
    adj.get(e.bId)!.add(e.aId);
  }
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (closure.has(next)) continue;
      closure.add(next);
      queue.push(next);
    }
  }
  return closure;
}

/**
 * People currently in an active spouse_of relationship (no `until` date)
 * with someone OTHER than `exceptId`. Excluded from partner suggestions
 * so we don't suggest someone already married.
 */
function currentlyPartnered(graph: FamilyGraph | null, exceptId: number): Set<number> {
  const out = new Set<number>();
  if (!graph) return out;
  for (const e of graph.edges) {
    if (e.derived) continue;
    if (e.type !== 'spouse_of') continue;
    if (e.until) continue; // ended marriages don't count
    if (e.aId !== exceptId) out.add(e.aId);
    if (e.bId !== exceptId) out.add(e.bId);
  }
  return out;
}

/** Breadth-first shortest path (in edge count) from `fromId` to `toId`
 *  on the undirected adjacency graph. Returns the node IDs along the
 *  path, inclusive of both endpoints. Empty array if unreachable. */
function bfsShortestPath(adj: Map<number, Set<number>>, fromId: number, toId: number): number[] {
  if (fromId === toId) return [fromId];
  const prev = new Map<number, number>();
  const visited = new Set<number>([fromId]);
  const queue: number[] = [fromId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      prev.set(next, cur);
      if (next === toId) {
        const path: number[] = [];
        let step: number | undefined = next;
        while (step != null) {
          path.unshift(step);
          step = prev.get(step);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────
// Focus / person picker modal
// ─────────────────────────────────────────────────────────────────

interface FocusPickerModalProps {
  persons: PersonSummary[];
  currentFocusId: number | null;
  title?: string;
  /** When set, the "Pick existing" list is sorted by how many photos
   *  each candidate co-appears in with this person — so the most
   *  likely match (e.g. the current focus's partner) floats to the top. */
  cooccurrenceAnchorId?: number;
  /** Show a sort toggle (Connections / Photos / A–Z) above the list.
   *  Used for the Change-focus picker where the user wants to browse
   *  by different criteria. Ignored when `cooccurrenceAnchorId` is set. */
  showSortOptions?: boolean;
  /** For partner quick-adds: set of person IDs who are CO-PARENTS of the
   *  anchor's children — i.e., the obvious partner candidates. These
   *  float to the top of suggestions ahead of simple co-occurrence. */
  coparentIds?: Set<number>;
  /** For partner quick-adds: when set, fetch intimacy- and tag-weighted
   *  partner scores for this anchor and sort candidates by score DESC
   *  instead of raw shared-photo count. Two group photos lose to one
   *  2-person photo; a wedding tag boosts; a 20-person group penalises. */
  partnerScoreAnchorId?: number;
  onPick: (personId: number) => void;
  onPersonsChanged?: () => void;
  onClose: () => void;
}

type PickerSortMode = 'connections' | 'photos' | 'alpha';

function FocusPickerModal({ persons, currentFocusId, title, cooccurrenceAnchorId, showSortOptions, coparentIds, partnerScoreAnchorId, onPick, onPersonsChanged, onClose }: FocusPickerModalProps) {
  // Tabbed design mirroring the "Who is this?" placeholder resolver:
  //   Tab 1: Name them       — type a new name, creates a real named person
  //   Tab 2: Pick existing   — search the already-named people list
  // Default to "Pick existing" when either
  //   a) the modal has a co-occurrence anchor (quick-add, where the best
  //      pick is almost always someone already named), or
  //   b) sort options are enabled (Change focus, same reasoning).
  // Otherwise default to Name them.
  const [mode, setMode] = useState<'name' | 'link'>(
    (cooccurrenceAnchorId != null || partnerScoreAnchorId != null || showSortOptions) ? 'link' : 'name'
  );
  const [nameInput, setNameInput] = useState('');
  const [linkQuery, setLinkQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** personId → co-occurrence photo count with the anchor, or null until loaded. */
  const [cooccurrence, setCooccurrence] = useState<Map<number, number> | null>(null);
  /** personId → weighted partner score for the partner quick-add anchor. */
  const [partnerScores, setPartnerScores] = useState<Map<number, number> | null>(null);
  /** Relationship-edge count per person, used by the Connections sort. */
  const [connectionCounts, setConnectionCounts] = useState<Map<number, number>>(new Map());
  /** Current sort mode when showSortOptions is enabled. */
  const [sortMode, setSortMode] = useState<PickerSortMode>('connections');

  // When an anchor is provided (e.g. quick-add for Terry), load how many
  // photos each candidate shares with Terry so the Pick-existing list
  // can surface Mel (or whoever Terry appears with most) at the top.
  useEffect(() => {
    if (cooccurrenceAnchorId == null) { setCooccurrence(null); return; }
    (async () => {
      const r = await getPersonsCooccurrence([cooccurrenceAnchorId]);
      if (r.success && r.data) {
        const m = new Map<number, number>();
        for (const row of r.data) m.set(row.id, row.photo_count);
        setCooccurrence(m);
      }
    })();
  }, [cooccurrenceAnchorId]);

  // Partner quick-add: fetch intimacy/tag-weighted scores for the anchor.
  // Replaces the raw co-occurrence sort so 2 group photos don't outrank
  // 1 intimate photo.
  useEffect(() => {
    if (partnerScoreAnchorId == null) { setPartnerScores(null); return; }
    (async () => {
      const r = await getPartnerSuggestionScores(partnerScoreAnchorId);
      if (r.success && r.data) {
        const m = new Map<number, number>();
        for (const row of r.data) m.set(row.id, row.score);
        setPartnerScores(m);
      }
    })();
  }, [partnerScoreAnchorId]);

  // Load relationship-edge counts if the sort UI is enabled.
  useEffect(() => {
    if (!showSortOptions) return;
    (async () => {
      const r = await listAllRelationships();
      if (r.success && r.data) {
        const counts = new Map<number, number>();
        for (const rel of r.data) {
          counts.set(rel.person_a_id, (counts.get(rel.person_a_id) ?? 0) + 1);
          counts.set(rel.person_b_id, (counts.get(rel.person_b_id) ?? 0) + 1);
        }
        setConnectionCounts(counts);
      }
    })();
  }, [showSortOptions]);

  const filtered = persons
    .filter(p => !p.name.startsWith('__'))
    .filter(p => p.name.toLowerCase().includes(linkQuery.trim().toLowerCase()))
    .sort((a, b) => {
      // Partner quick-add — weighted score wins over raw photo count.
      //   1. Co-parents to the top (they already share a child).
      //   2. Intimacy/tag-weighted partner score DESC. A 2-person wedding
      //      photo (score ~1.5) now beats two 10-person group shots
      //      (score ~0.2) that used to win on raw count alone.
      //   3. Alphabetical tie-break for people with no partner signal.
      if (partnerScoreAnchorId != null) {
        const isCoparentA = coparentIds?.has(a.id) ? 1 : 0;
        const isCoparentB = coparentIds?.has(b.id) ? 1 : 0;
        if (isCoparentA !== isCoparentB) return isCoparentB - isCoparentA;
        const scoreA = partnerScores?.get(a.id) ?? 0;
        const scoreB = partnerScores?.get(b.id) ?? 0;
        if (scoreA !== scoreB) return scoreB - scoreA;
        return a.name.localeCompare(b.name);
      }
      // When an anchor is set (non-partner quick-add), sort priorities:
      //   1. Co-parents float to the top.
      //   2. Co-occurrence DESC — people in many shared photos next.
      //   3. Alphabetical tie-break.
      if (cooccurrenceAnchorId != null) {
        const isCoparentA = coparentIds?.has(a.id) ? 1 : 0;
        const isCoparentB = coparentIds?.has(b.id) ? 1 : 0;
        if (isCoparentA !== isCoparentB) return isCoparentB - isCoparentA;
        const countA = cooccurrence?.get(a.id) ?? 0;
        const countB = cooccurrence?.get(b.id) ?? 0;
        if (countA !== countB) return countB - countA;
        return a.name.localeCompare(b.name);
      }
      // With sort options, honour the chosen mode.
      if (showSortOptions) {
        if (sortMode === 'connections') {
          const ca = connectionCounts.get(a.id) ?? 0;
          const cb = connectionCounts.get(b.id) ?? 0;
          if (ca !== cb) return cb - ca;
          return a.name.localeCompare(b.name);
        }
        if (sortMode === 'photos') {
          if (a.photoCount !== b.photoCount) return b.photoCount - a.photoCount;
          return a.name.localeCompare(b.name);
        }
        return a.name.localeCompare(b.name); // alpha
      }
      return a.name.localeCompare(b.name);
    });

  const handleName = async () => {
    setError(null);
    const trimmed = nameInput.trim();
    if (!trimmed) { setError('Type a name first.'); return; }
    setBusy(true);
    const r = await createNamedPerson(trimmed);
    setBusy(false);
    if (!r.success || r.data == null) {
      setError(r.error ?? 'Could not create person.');
      return;
    }
    if (onPersonsChanged) onPersonsChanged();
    onPick(r.data);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-background rounded-xl shadow-2xl border border-border max-w-md w-full p-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <UserPlus className="w-4 h-4 text-primary" />
          <span className="text-base font-semibold">{title ?? 'Focus on who?'}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-0.5 rounded hover:bg-accent">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Mode switcher — "Name them" first because for most quick-adds
            (grandparents etc.), new people aren't in People Manager yet. */}
        <div className="flex gap-1 mb-3 p-0.5 bg-muted rounded-lg text-xs">
          <button
            onClick={() => setMode('name')}
            className={`flex-1 px-2 py-1 rounded ${mode === 'name' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
          >
            Name them
          </button>
          <button
            onClick={() => setMode('link')}
            className={`flex-1 px-2 py-1 rounded ${mode === 'link' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
          >
            Pick existing
          </button>
        </div>

        {mode === 'name' ? (
          <div>
            <input
              type="text"
              autoFocus
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleName(); } }}
              placeholder="e.g. Grandma Eileen"
              className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-sm"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Creates a new named person. They'll appear in People Manager so you can link photos later.
            </p>
          </div>
        ) : (
          <div>
            <input
              type="text"
              autoFocus
              value={linkQuery}
              onChange={e => setLinkQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const exact = filtered.find(p => p.name.toLowerCase() === linkQuery.trim().toLowerCase());
                  if (exact) onPick(exact.id);
                  else if (filtered.length === 1) onPick(filtered[0].id);
                }
              }}
              placeholder="Search named people…"
              className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-sm"
            />
            {showSortOptions && cooccurrenceAnchorId == null && (
              <div className="flex items-center gap-1 mt-2 p-0.5 bg-muted rounded-lg text-[10px]">
                {(['connections', 'photos', 'alpha'] as PickerSortMode[]).map(m => (
                  <button
                    key={m}
                    onClick={() => setSortMode(m)}
                    className={`flex-1 px-2 py-1 rounded transition-colors ${sortMode === m ? 'bg-background shadow-sm font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {m === 'connections' ? 'Connections' : m === 'photos' ? 'Photos' : 'A–Z'}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 max-h-72 overflow-auto flex flex-col gap-0.5 border border-border rounded p-0.5">
              {filtered.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-2">No matches.</p>
              )}
              {filtered.map(p => {
                const coCount = cooccurrence?.get(p.id);
                const connCount = connectionCounts.get(p.id) ?? 0;
                const isCoparent = coparentIds?.has(p.id) ?? false;
                let rightLabel: string | null = null;
                if (isCoparent) {
                  rightLabel = 'shares children';
                } else if (cooccurrenceAnchorId != null && coCount != null && coCount > 0) {
                  rightLabel = `${coCount} shared photo${coCount === 1 ? '' : 's'}`;
                } else if (showSortOptions) {
                  if (sortMode === 'connections' && connCount > 0) rightLabel = `${connCount} connection${connCount === 1 ? '' : 's'}`;
                  else if (sortMode === 'photos' && p.photoCount > 0) rightLabel = `${p.photoCount} photo${p.photoCount === 1 ? '' : 's'}`;
                }
                return (
                  <button
                    key={p.id}
                    onClick={() => onPick(p.id)}
                    disabled={busy}
                    className={`flex items-center justify-between gap-2 px-2 py-1 rounded text-left text-sm disabled:opacity-50 ${
                      p.id === currentFocusId ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-accent'
                    }`}
                  >
                    <span className="truncate">{p.name}</span>
                    {rightLabel && (
                      <span className="text-[10px] text-muted-foreground shrink-0">{rightLabel}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        <div className="flex items-center gap-2 mt-3 pt-2 border-t border-border">
          <div className="flex-1" />
          <button onClick={onClose} className="px-2.5 py-1 rounded text-xs hover:bg-accent">
            Cancel
          </button>
          {mode === 'name' && (
            <button
              onClick={handleName}
              disabled={busy || !nameInput.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 hover:bg-primary/90"
            >
              <UserPlus className="w-3 h-3" />
              {busy ? 'Saving…' : 'Save name'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
