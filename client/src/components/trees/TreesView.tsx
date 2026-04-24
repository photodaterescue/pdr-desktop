import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Users, X, GitBranch, RefreshCw, UserPlus, Pin, Pencil, FolderOpen, Info, Undo2, Redo2, Move, EyeOff, Eye } from 'lucide-react';
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
  listSavedTrees,
  createSavedTree,
  updateSavedTree,
  toggleHiddenAncestor,
  undoGraphOperation,
  redoGraphOperation,
  getGraphHistoryCounts,
  listRelationshipsForPerson,
  type FamilyGraph,
  type SavedTreeRecord,
} from '@/lib/electron-bridge';
import { computeFocusLayout, augmentWithVirtualGhosts } from '@/lib/trees-layout';
import { toast } from 'sonner';
import { TreesCanvas } from './TreesCanvas';
import { SetRelationshipModal } from './SetRelationshipModal';
import { EditRelationshipsModal } from './EditRelationshipsModal';
import { SiblingKindDialog, type SiblingKind } from './SiblingKindDialog';
import { HiddenSuggestionsReview } from './HiddenSuggestionsReview';
import { TreePeopleListModal } from './TreePeopleListModal';
import { useDraggableModal } from './useDraggableModal';
import { ManageTreesModal } from './ManageTreesModal';
import { DateQuickEditor } from './DateQuickEditor';
import { promptConfirm } from './promptConfirm';
import { IconTooltip } from '@/components/ui/icon-tooltip';

interface PersonSummary {
  id: number;
  name: string;
  /** Total photos this person is linked to via face detections —
   *  includes AI-suggested faces the user hasn't confirmed. Kept for
   *  legacy sorting in the picker. */
  photoCount: number;
  /** Photos where the linking face has been user-verified. Shown in
   *  the People-list modal as the real measure of invested work. */
  verifiedPhotoCount: number;
  /** Stored gender string ('male' / 'female' / 'non_binary' / …). Used
   *  by the People-list modal to render the gender column. */
  gender: string | null;
  /** Stored birth date (YYYY-MM-DD or partial). Used to anchor the
   *  Gen-from-youngest calculation in the People-list modal. */
  birthDate: string | null;
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
export interface TreesViewProps {
  /** Called when the user asks to set a tree's canvas background.
   *  The parent routes them to S&D in pick mode; the pick eventually
   *  writes via updateSavedTree, so TreesView doesn't need to observe
   *  the result — it re-reads via the normal savedTrees refresh. */
  onRequestCanvasBackgroundPick?: (args: { treeId: number; treeName: string }) => void;
  /** Called when the user asks to set a card background via right-click. */
  onRequestCardBackgroundPick?: (args: { treeId: number; treeName: string; personId: number; personName: string }) => void;
}

export function TreesView({ onRequestCanvasBackgroundPick, onRequestCardBackgroundPick }: TreesViewProps = {}) {
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
  /** Optional preselection for SetRelationshipModal's "other person" —
   *  used when Edit Relationships jumps straight into an existing edge. */
  const [relationshipEditorInitialTo, setRelationshipEditorInitialTo] = useState<number | null>(null);
  /** When set, the Edit Relationships list modal is open for this person. */
  const [editRelationshipsFor, setEditRelationshipsFor] = useState<number | null>(null);
  /** When set, the Sibling Kind dialog is open between these two people.
   *  Triggered by the +sibling quick-add; on confirm we run the chosen
   *  flavour of sibling wiring instead of the old assume-full default. */
  const [siblingKindDialog, setSiblingKindDialog] = useState<{ fromId: number; toId: number; fromName: string; toName: string } | null>(null);
  /** Saved trees — named view presets. Loaded on mount; one is always
   *  active so the user's current focus/filter state has a place to
   *  persist to. If none exist at first launch we auto-create one. */
  const [savedTrees, setSavedTrees] = useState<SavedTreeRecord[]>([]);
  const [currentTreeId, setCurrentTreeId] = useState<number | null>(null);
  const [manageTreesOpen, setManageTreesOpen] = useState(false);
  const [treePeopleOpen, setTreePeopleOpen] = useState(false);
  /** Inline rename of the current tree name in the header. */
  const [editingTreeName, setEditingTreeName] = useState(false);
  const [treeNameDraft, setTreeNameDraft] = useState('');
  /** When true, the focus picker is open in "pick focus for a NEW tree"
   *  mode. Distinct from the plain Change Focus picker so we can swap
   *  the onPick behaviour without adding flags. */
  const [newTreePickerOpen, setNewTreePickerOpen] = useState(false);
  /** Optional-field toggles for inside-card display. Persisted to
   *  localStorage so the user's choice sticks across sessions. */
  const [showDates, setShowDates] = useState(
    typeof window !== 'undefined' && localStorage.getItem('pdr-trees-show-dates') === 'true'
  );
  const [addInfoOpen, setAddInfoOpen] = useState(false);
  /** Date editor target — { personId, x, y } where x/y are screen
   *  coords for the popup. Null = editor closed. */
  const [dateEditor, setDateEditor] = useState<{ personId: number; x: number; y: number } | null>(null);
  /** Undo/redo availability counts from the graph_history table.
   *  Refreshed after every mutation + on app focus. The handlers that
   *  use refetchGraph / reloadPersons are declared AFTER those
   *  callbacks further below — see the second undo/redo block. */
  const [historyCounts, setHistoryCounts] = useState<{ canUndo: number; canRedo: number }>({ canUndo: 0, canRedo: 0 });
  const refreshHistoryCounts = useCallback(async () => {
    const r = await getGraphHistoryCounts();
    if (r.success && r.data) setHistoryCounts(r.data);
  }, []);
  useEffect(() => {
    refreshHistoryCounts();
    const onFocus = () => refreshHistoryCounts();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshHistoryCounts]);

  const toggleShowDates = useCallback((next: boolean) => {
    setShowDates(next);
    try {
      if (next) localStorage.setItem('pdr-trees-show-dates', 'true');
      else localStorage.removeItem('pdr-trees-show-dates');
    } catch {}
  }, []);
  /** Suppress auto-save while we're applying a loaded tree's settings
   *  (otherwise the act of loading would immediately overwrite the
   *  record we just read). */
  const applyingTreeRef = useRef(false);
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

  // ── Saved trees: initial load ──────────────────────────────────
  // On mount, load every saved tree and activate the most-recently-
  // opened one. If none exist this is the user's first visit — we
  // auto-create "My Tree" so the settings auto-save has a target.
  useEffect(() => {
    (async () => {
      const r = await listSavedTrees();
      if (!r.success) return;
      const list = r.data ?? [];
      if (list.length === 0) {
        // Wait for allPersons / auto-focus to settle before creating —
        // the tree record needs a focusPersonId to be meaningful.
        return;
      }
      setSavedTrees(list);
      // Activate the most recently opened one.
      const activate = list[0];
      applyingTreeRef.current = true;
      setCurrentTreeId(activate.id);
      if (activate.focusPersonId != null) setFocusPersonId(activate.focusPersonId);
      setStepsEnabled(activate.stepsEnabled);
      setExpandedHops(activate.stepsDepth);
      setGenerationsEnabled(activate.generationsEnabled);
      setAncestorsDepth(activate.ancestorsDepth);
      setDescendantsDepth(activate.descendantsDepth);
      // Mark as opened so it stays top of the list.
      updateSavedTree(activate.id, { markOpened: true });
      // Release the suppression after one tick so setters settle.
      setTimeout(() => { applyingTreeRef.current = false; }, 0);
    })();
    // Intentionally mount-only — further refreshes come from manage modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the person list — used by focus picker and relationship-target
  // picker. Exposed as a callback so modals that create new people can
  // ask for a refresh.
  const reloadPersons = useCallback(async () => {
    const res = await listPersons();
    if (res.success && res.data) {
      setAllPersons(res.data.map(p => ({
        id: p.id,
        name: p.name,
        photoCount: p.photo_count ?? 0,
        verifiedPhotoCount: (p as any).verified_photo_count ?? 0,
        gender: (p as any).gender ?? null,
        birthDate: (p as any).birth_date ?? null,
      })));
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

  /** Full set of person IDs in the focus's CONNECTED COMPONENT — every
   *  person reachable from the focus through any chain of relationships
   *  (parent_of, spouse_of, sibling_of, associated_with), unbounded by
   *  the Steps / Generations / fetchDepth caps that limit the rendered
   *  view. Used by the placeholder resolver to exclude already-linked
   *  people from "Link to existing" suggestions even when they're
   *  currently hidden, off-screen, or beyond the current fetch depth.
   *
   *  Refetched after every mutation via the `reloadConnectedComponent`
   *  bumper — any relationship add/remove could add or sever someone's
   *  tie into the tree. */
  const [connectedPersonIds, setConnectedPersonIds] = useState<Set<number>>(new Set());
  const [connectedBump, setConnectedBump] = useState(0);
  useEffect(() => {
    if (focusPersonId == null) { setConnectedPersonIds(new Set()); return; }
    let cancelled = false;
    (async () => {
      const r = await listAllRelationships();
      if (cancelled) return;
      const rels = r.success && r.data ? r.data : [];
      // Undirected BFS over every relationship type. Stops at anyone
      // already seen — no depth cap.
      const adj = new Map<number, Set<number>>();
      for (const rel of rels) {
        if (!adj.has(rel.person_a_id)) adj.set(rel.person_a_id, new Set());
        if (!adj.has(rel.person_b_id)) adj.set(rel.person_b_id, new Set());
        adj.get(rel.person_a_id)!.add(rel.person_b_id);
        adj.get(rel.person_b_id)!.add(rel.person_a_id);
      }
      const seen = new Set<number>([focusPersonId]);
      const stack = [focusPersonId];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const n of adj.get(cur) ?? []) {
          if (seen.has(n)) continue;
          seen.add(n);
          stack.push(n);
        }
      }
      if (!cancelled) setConnectedPersonIds(seen);
    })();
    return () => { cancelled = true; };
  }, [focusPersonId, connectedBump]);
  /** Call after any relationship mutation so the connected-component
   *  set recomputes. Safe no-op if focus is unset. */
  const reloadConnectedComponent = useCallback(() => {
    setConnectedBump(b => b + 1);
  }, []);

  // Undo / redo — declared here because the deps reference refetchGraph,
  // reloadPersons, AND fetchDepth, which are all defined in the hooks
  // above this point. Declaring these callbacks earlier caused a
  // temporal-dead-zone crash on mount.
  const handleUndo = useCallback(async () => {
    const r = await undoGraphOperation();
    if (r.success) {
      toast(`Undone: ${r.description ?? 'last change'}`);
      if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
      reloadPersons();
      // Saved trees may have changed too — e.g. undoing a hide-ancestry
      // flip writes to saved_trees.hidden_ancestor_person_ids, and the
      // canvas filter reads that off the current tree. Without this
      // refetch the undo succeeds in the DB but the canvas stays stale.
      reloadSavedTrees();
      refreshHistoryCounts();
    } else if (r.error) {
      toast.error(r.error);
    }
  }, [focusPersonId, fetchDepth, refetchGraph, reloadPersons, refreshHistoryCounts]);

  const handleRedo = useCallback(async () => {
    const r = await redoGraphOperation();
    if (r.success) {
      toast(`Redone: ${r.description ?? 'change'}`);
      if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
      reloadPersons();
      reloadSavedTrees();
      refreshHistoryCounts();
    } else if (r.error) {
      toast.error(r.error);
    }
  }, [focusPersonId, fetchDepth, refetchGraph, reloadPersons, refreshHistoryCounts]);

  // Keyboard shortcuts: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or
  // Ctrl/Cmd+Y = redo. Ignored when a text input is focused so the
  // user's typing-undo still works in name fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inText = (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA');
      if (inText) return;
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo, handleRedo]);

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
      // Extend by ONE hop of direct family (parent / partner / sibling)
      // past the boundary. Without this, stored family of boundary
      // people gets clipped — e.g. Dave (Lindsay's dad) would stay
      // invisible when Lindsay sits at the default depth edge. No
      // cascade: a single pass only.
      const extra: number[] = [];
      for (const e of graph.edges) {
        if (e.derived) continue;
        if (e.type !== 'parent_of' && e.type !== 'spouse_of' && e.type !== 'sibling_of') continue;
        if (visible.has(e.aId) && !visible.has(e.bId)) extra.push(e.bId);
        else if (visible.has(e.bId) && !visible.has(e.aId)) extra.push(e.aId);
      }
      for (const id of extra) visible.add(id);
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
    // Per-tree "hidden ancestor" trim — when the user says "hide X's
    // ancestry", we walk every parent_of edge upward from X and remove
    // the ancestors + their spouses + their siblings from `visible`.
    // The hidden person themself stays (they're still a partner, child,
    // etc. — just their family line is collapsed).
    //
    // Critical nuance: an ancestor may belong to MORE THAN ONE person's
    // ancestry. E.g. Mel's Mum is the mother of both Mel AND Nee (half-
    // siblings sharing one parent). If the user hides Nee's ancestry,
    // naive removal would also hide Mel's Mum — who's legitimately
    // Mel's mum, and Mel isn't in the hidden list. So we compute a
    // "protected" set = ancestry cloud of every OTHER visible person
    // whose line is NOT hidden, and intersect it out before applying
    // removal. An ancestor only goes away if nobody visible besides
    // the hidden person depends on them.
    const currentTreeEntry = savedTrees.find(t => t.id === currentTreeId);
    const hiddenAncestorIds = currentTreeEntry?.hiddenAncestorPersonIds ?? [];
    if (hiddenAncestorIds.length > 0) {
      // Full upward "family cloud" for a person — direct ancestors via
      // parent_up chain + spouses/siblings of those ancestors. Used as
      // the REMOVAL candidate set: hiding X's ancestry should also
      // strip ancestor-step-parents and great-aunts/uncles that only
      // sit in the tree because of X.
      const ancestorCloudFor = (personId: number): Set<number> => {
        const cloud = new Set<number>();
        const ancestors = new Set<number>();
        const stack = [personId];
        const seen = new Set<number>([personId]);
        while (stack.length) {
          const cur = stack.pop()!;
          for (const e of graph.edges) {
            if (e.type === 'parent_of' && e.bId === cur && !seen.has(e.aId)) {
              seen.add(e.aId);
              ancestors.add(e.aId);
              stack.push(e.aId);
            }
          }
        }
        for (const a of ancestors) {
          cloud.add(a);
          for (const e of graph.edges) {
            if (e.type === 'spouse_of' && (e.aId === a || e.bId === a)) {
              cloud.add(e.aId === a ? e.bId : e.aId);
            }
            if (e.type === 'sibling_of' && (e.aId === a || e.bId === a)) {
              cloud.add(e.aId === a ? e.bId : e.aId);
            }
          }
        }
        return cloud;
      };

      // Pure upward ancestor CHAIN — parents, grandparents, etc., no
      // spouses or siblings. Used as the PROTECTION set: an ancestor
      // stays visible only if they're somebody non-hidden's direct
      // upline. Using the cloud here over-protects co-parents of the
      // hidden person (e.g. Nee's Dad, who appears as a spouse of
      // Mel's Mum in Mel's cloud — but he's in the tree PURELY because
      // of Nee, so he shouldn't survive hiding Nee's ancestry).
      const ancestorChainFor = (personId: number): Set<number> => {
        const ancestors = new Set<number>();
        const stack = [personId];
        const seen = new Set<number>([personId]);
        while (stack.length) {
          const cur = stack.pop()!;
          for (const e of graph.edges) {
            if (e.type === 'parent_of' && e.bId === cur && !seen.has(e.aId)) {
              seen.add(e.aId);
              ancestors.add(e.aId);
              stack.push(e.aId);
            }
          }
        }
        return ancestors;
      };

      const hiddenSet = new Set<number>(hiddenAncestorIds);
      // Union of ancestor CLOUDS for all HIDDEN targets — candidates
      // for removal (ancestors + their spouses + their siblings).
      const hideCloud = new Set<number>();
      for (const hid of hiddenSet) {
        if (hid === focusPersonId) continue;
        for (const id of ancestorCloudFor(hid)) hideCloud.add(id);
      }
      // Union of pure ancestor CHAINS for every OTHER visible person —
      // these are the people whose ancestry the user has NOT hidden,
      // so their direct upline must remain visible. Deliberately NOT
      // cloud: a non-hidden person's ancestor's spouse can legitimately
      // be a hidden-only relative (Nee's Dad co-parented Nee with
      // Mel's Mum — protecting him because he shows up in Mel's cloud
      // would defeat the hide).
      const protectChain = new Set<number>();
      for (const vid of visible) {
        if (hiddenSet.has(vid)) continue;
        for (const id of ancestorChainFor(vid)) protectChain.add(id);
      }
      const toHide = new Set<number>();
      for (const id of hideCloud) {
        if (protectChain.has(id)) continue; // shared direct ancestry — keep.
        toHide.add(id);
      }
      // Never drop focus; never drop any pinned person the user asked for.
      toHide.delete(focusPersonId);
      for (const pid of pinnedPeople.keys()) toHide.delete(pid);
      for (const id of toHide) visible.delete(id);

      // Derived sibling_of edges are computed from shared parents on
      // the server, and sit in graph.edges. If we just hid those shared
      // parents, the derivation no longer holds — but the edge itself
      // is still in the list, and the BFS would happily walk it and
      // keep a half-sibling (like Nee) in view just because her only-
      // hidden parent was shared with a still-visible person (Mel).
      // So: for BFS purposes, a derived sibling_of edge is only live
      // if AT LEAST ONE of its shared parents is still in `visible`.
      const childrenByParent = new Map<number, Set<number>>();
      for (const e of graph.edges) {
        if (e.type !== 'parent_of') continue;
        if (!childrenByParent.has(e.aId)) childrenByParent.set(e.aId, new Set());
        childrenByParent.get(e.aId)!.add(e.bId);
      }
      const derivedSiblingLive = (aId: number, bId: number): boolean => {
        // There's a visible shared parent iff some parent p in visible
        // has both aId and bId among its children.
        for (const [p, kids] of childrenByParent) {
          if (!visible.has(p)) continue;
          if (kids.has(aId) && kids.has(bId)) return true;
        }
        return false;
      };

      // Orphan trim — after severing the hidden branch, anyone whose
      // only connection to the focus ran THROUGH that branch (e.g. a
      // half-sibling who shared just the now-hidden parent) is left
      // floating. We run a BFS from focus over edges where both
      // endpoints are still in `visible`, dropping derived sibling
      // edges whose shared parent is no longer visible. Focus + pinned
      // people are exempt so a pin survives even if the user hid
      // everything between them and the focus.
      const reachable = new Set<number>([focusPersonId]);
      const stack: number[] = [focusPersonId];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const e of graph.edges) {
          if (!visible.has(e.aId) || !visible.has(e.bId)) continue;
          if (e.type === 'sibling_of' && e.derived && !derivedSiblingLive(e.aId, e.bId)) continue;
          let other: number | null = null;
          if (e.aId === cur) other = e.bId;
          else if (e.bId === cur) other = e.aId;
          if (other == null || reachable.has(other)) continue;
          reachable.add(other);
          stack.push(other);
        }
      }
      // Protect the people whose ancestry was hidden — they're the
      // subjects of the action, not collateral damage. If hiding a
      // half-sibling's shared parent severs their only tie to the
      // focus, we still keep THEM in view (just without their family
      // line) so the user can right-click them and Show ancestry again.
      const hiddenSetForProtect = new Set<number>(hiddenAncestorIds);
      for (const id of Array.from(visible)) {
        if (id === focusPersonId) continue;
        if (pinnedPeople.has(id)) continue;
        if (hiddenSetForProtect.has(id)) continue;
        if (!reachable.has(id)) visible.delete(id);
      }
    }
    return {
      ...graph,
      nodes: graph.nodes.filter(n => visible.has(n.personId)),
      edges: graph.edges.filter(e => visible.has(e.aId) && visible.has(e.bId)),
    };
  }, [graph, focusPersonId, stepsEnabled, generationsEnabled, expandedHops, ancestorsDepth, descendantsDepth, generationOffsets, pinnedPeople, savedTrees, currentTreeId]);

  // Augment the visible graph with virtual ghost parents for every named
  // person that has fewer than 2 stored parents (one generation only).
  // Layout depth uses the widest active filter so spacing accommodates
  // the deepest visible branch.
  const effectiveLayoutHops = Math.max(
    stepsEnabled ? expandedHops : 0,
    generationsEnabled ? Math.max(ancestorsDepth, descendantsDepth) : 0,
    1, // never 0 — layout needs breathing room even in focus-only view
  );
  const layoutGraph = visibleGraph
    ? augmentWithVirtualGhosts(
        visibleGraph,
        effectiveLayoutHops,
        // Don't paint ghost parents above anyone the user has asked to
        // collapse — the whole point of "hide ancestry" is that the line
        // goes away, not that it's replaced by empty sockets begging to
        // be filled in. The augmenter reads each node's TOTAL DB parent
        // count (node.totalParentCount) so truncation detection is
        // authoritative rather than derived from the already-filtered
        // visible graph — see search-database.ts for the count's origin.
        savedTrees.find(t => t.id === currentTreeId)?.hiddenAncestorPersonIds,
      )
    : null;
  const layout = layoutGraph ? computeFocusLayout(layoutGraph, effectiveLayoutHops) : null;

  const handleRefocus = useCallback((personId: number) => {
    setFocusPersonId(personId);
  }, []);

  /** Resolve a +sibling quick-add now that the user has chosen the
   *  sibling flavour. Runs the appropriate wiring:
   *   full → cross-inherit parents + top up to 2 with ghosts
   *   half → explicit sibling_of with flags.half, cross-wire shared parent if known
   *   none/unknown → explicit sibling_of only, parents untouched
   */
  const finaliseSiblingKind = useCallback(async (kind: SiblingKind, sharedParentId: number | null) => {
    if (!siblingKindDialog) return;
    const { fromId, toId } = siblingKindDialog;
    setSiblingKindDialog(null);

    // Read parents LIVE from the DB per person, not from the React
    // graph state — previous adds may not have refetched by the time
    // the next sibling dialog fires, so reading the React state would
    // wrongly treat a just-added person as parentless and spin up a
    // whole new pair of placeholders (Alan → Trisha works, but Trisha
    // → Peter then mints P3/P4 instead of cross-inheriting P1/P2).
    const parentsOf = async (pid: number): Promise<number[]> => {
      const r = await listRelationshipsForPerson(pid);
      if (!r.success || !r.data) return [];
      return r.data
        .filter(row => row.type === 'parent_of' && row.person_b_id === pid)
        .map(row => row.person_a_id);
    };

    if (kind === 'full') {
      const fromParents = await parentsOf(fromId);
      const toParents = await parentsOf(toId);
      for (const pid of toParents) {
        if (!fromParents.includes(pid)) await addRelationship({ personAId: pid, personBId: fromId, type: 'parent_of' });
      }
      for (const pid of fromParents) {
        if (!toParents.includes(pid)) await addRelationship({ personAId: pid, personBId: toId, type: 'parent_of' });
      }
      const shared = new Set<number>([...fromParents, ...toParents]);
      const missing = Math.max(0, 2 - shared.size);
      for (let i = 0; i < missing; i++) {
        const ph = await createPlaceholderPerson();
        if (ph.success && ph.data != null) {
          await addRelationship({ personAId: ph.data, personBId: fromId, type: 'parent_of' });
          await addRelationship({ personAId: ph.data, personBId: toId, type: 'parent_of' });
        }
      }
    } else if (kind === 'half') {
      await addRelationship({ personAId: fromId, personBId: toId, type: 'sibling_of', flags: { half: true } });
      if (sharedParentId != null) {
        const fromParents = await parentsOf(fromId);
        const toParents = await parentsOf(toId);
        if (!fromParents.includes(sharedParentId)) {
          await addRelationship({ personAId: sharedParentId, personBId: fromId, type: 'parent_of' });
        }
        if (!toParents.includes(sharedParentId)) {
          await addRelationship({ personAId: sharedParentId, personBId: toId, type: 'parent_of' });
        }
      }
    } else {
      // 'none' or 'unknown' — just link them.
      await addRelationship({ personAId: fromId, personBId: toId, type: 'sibling_of' });
    }

    // Refresh the graph.
    if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
  }, [siblingKindDialog, focusPersonId, fetchDepth, refetchGraph]);

  // ── Saved trees: auto-save on state change ────────────────────
  // Persist the current filter / focus state to the active tree
  // whenever anything changes. Suppressed while we're applying a
  // loaded tree (otherwise we'd immediately overwrite it).
  useEffect(() => {
    if (applyingTreeRef.current) return;
    if (currentTreeId == null) return;
    if (focusPersonId == null) return; // nothing to save yet
    updateSavedTree(currentTreeId, {
      focusPersonId,
      stepsEnabled,
      stepsDepth: expandedHops,
      generationsEnabled,
      ancestorsDepth,
      descendantsDepth,
    });
  }, [currentTreeId, focusPersonId, stepsEnabled, expandedHops, generationsEnabled, ancestorsDepth, descendantsDepth]);

  // First-visit auto-create: once a focus person has been chosen AND
  // we have no saved trees yet, mint "My Tree" so auto-save has a
  // target. Runs once; guarded by the list length.
  useEffect(() => {
    if (currentTreeId != null) return;
    if (focusPersonId == null) return;
    if (savedTrees.length > 0) return;
    (async () => {
      const r = await createSavedTree({
        name: 'My Tree',
        focusPersonId,
        stepsEnabled,
        stepsDepth: expandedHops,
        generationsEnabled,
        ancestorsDepth,
        descendantsDepth,
      });
      if (r.success && r.data) {
        setSavedTrees([r.data]);
        setCurrentTreeId(r.data.id);
      }
    })();
  }, [currentTreeId, focusPersonId, savedTrees.length, stepsEnabled, expandedHops, generationsEnabled, ancestorsDepth, descendantsDepth]);

  const currentTree = savedTrees.find(t => t.id === currentTreeId) ?? null;

  const switchToTree = useCallback((tree: SavedTreeRecord) => {
    applyingTreeRef.current = true;
    setCurrentTreeId(tree.id);
    if (tree.focusPersonId != null) setFocusPersonId(tree.focusPersonId);
    setStepsEnabled(tree.stepsEnabled);
    setExpandedHops(tree.stepsDepth);
    setGenerationsEnabled(tree.generationsEnabled);
    setAncestorsDepth(tree.ancestorsDepth);
    setDescendantsDepth(tree.descendantsDepth);
    updateSavedTree(tree.id, { markOpened: true });
    setManageTreesOpen(false);
    setTimeout(() => { applyingTreeRef.current = false; }, 0);
  }, []);

  const reloadSavedTrees = useCallback(async () => {
    const r = await listSavedTrees();
    if (r.success && r.data) setSavedTrees(r.data);
  }, []);

  const commitTreeNameRename = useCallback(async () => {
    if (currentTreeId == null) { setEditingTreeName(false); return; }
    const trimmed = treeNameDraft.trim();
    if (!trimmed) { setEditingTreeName(false); return; }
    await updateSavedTree(currentTreeId, { name: trimmed });
    await reloadSavedTrees();
    setEditingTreeName(false);
  }, [currentTreeId, treeNameDraft, reloadSavedTrees]);

  // Per-tree suggestion-exclusion plumbing. Shared between the + quick-add
  // picker (FocusPickerModal) and the "Who is this?" placeholder resolver
  // (PlaceholderResolver) so a hide in either surface takes effect in
  // both — one tree, one exclusion list.
  const toggleExcludedSuggestion = useCallback(async (personId: number) => {
    if (currentTreeId == null) return;
    const tree = savedTrees.find(t => t.id === currentTreeId);
    const current = new Set(tree?.excludedSuggestionPersonIds ?? []);
    if (current.has(personId)) current.delete(personId);
    else current.add(personId);
    await updateSavedTree(currentTreeId, { excludedSuggestionPersonIds: [...current] });
    await reloadSavedTrees();
  }, [currentTreeId, savedTrees, reloadSavedTrees]);

  // Namesake lookup against the current tree — if the typed name matches
  // someone already in the family closure, return them so the caller can
  // warn. Root cause of the double-Dorothy bug: no warning fired in the
  // placeholder resolver's Name-them path.
  const nameConflictLookup = useCallback((typed: string) => {
    const needle = typed.trim().toLowerCase();
    if (!needle) return null;
    for (const p of allPersons) {
      if (!connectedPersonIds.has(p.id)) continue;
      if (p.name.trim().toLowerCase() === needle) {
        return { id: p.id, name: p.name };
      }
    }
    return null;
  }, [allPersons, connectedPersonIds]);

  // Hidden-person list for the review panel. Computed from the current
  // tree's exclusion IDs + the allPersons name lookup so both modals
  // can render the same "N hidden — review" footer.
  const hiddenSuggestions = (() => {
    const ids = currentTree?.excludedSuggestionPersonIds ?? [];
    return ids
      .map(id => allPersons.find(p => p.id === id))
      .filter((p): p is PersonSummary => p != null)
      .map(p => ({ id: p.id, name: p.name }));
  })();

  // Exclusion set as a Set<number> for O(1) filter checks.
  const excludedSuggestionIdSet = new Set(currentTree?.excludedSuggestionPersonIds ?? []);

  const handleRelationshipCreated = useCallback(() => {
    // A graph mutation can also change the person table (e.g. a ghost
    // placeholder getting named, or a new named person created via the
    // modal). Reload BOTH so pickers that filter by is_placeholder
    // don't leave the newly-named person out of the list.
    reloadPersons();
    if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
    refreshHistoryCounts();
  }, [focusPersonId, fetchDepth, refetchGraph, reloadPersons, refreshHistoryCounts]);

  /** Finalise a quick-add: the user has picked (or created) the other person,
   *  so wire the actual relationship based on the chip direction. */
  const finaliseQuickAdd = useCallback(async (otherPersonId: number, otherPersonName: string) => {
    if (!quickAdd) return;
    const { fromPersonId, kind } = quickAdd;
    setQuickAdd(null);
    if (kind === 'parent') {
      await addRelationship({ personAId: otherPersonId, personBId: fromPersonId, type: 'parent_of' });
    } else if (kind === 'child') {
      await addRelationship({ personAId: fromPersonId, personBId: otherPersonId, type: 'parent_of' });
      // Co-parent prompt — for every CURRENT (non-ended) spouse of the
      // person we're adding FROM, ask whether they're also the child's
      // parent. Previously this only fired when there was exactly ONE
      // current spouse, silently skipping every partner in polyamorous
      // or multi-partner configurations — so the user had to manually
      // wire each co-parent afterwards. Now we ask per partner so no
      // one gets silently left out.
      const rels = await listRelationshipsForPerson(fromPersonId);
      const currentSpouses = (rels.success && rels.data ? rels.data : []).filter(r =>
        r.type === 'spouse_of' && !r.until
      );
      if (currentSpouses.length > 0) {
        const fromName = allPersons.find(p => p.id === fromPersonId)?.name?.trim() || 'them';
        const childName = (otherPersonName || allPersons.find(p => p.id === otherPersonId)?.name || 'this child').trim();
        const multi = currentSpouses.length > 1;
        for (const rel of currentSpouses) {
          const spouseId = rel.person_a_id === fromPersonId ? rel.person_b_id : rel.person_a_id;
          const spouseName = allPersons.find(p => p.id === spouseId)?.name?.trim() || 'their partner';
          const yes = await promptConfirm({
            title: `Is ${spouseName} also ${childName}'s parent?`,
            message: multi
              ? `${fromName} has multiple current partners. Answer for each — choose Yes for every partner who's also ${childName}'s parent.`
              : `${fromName} has one current partner (${spouseName}). In most cases they're the second parent — choose No if ${childName} has a different co-parent.`,
            confirmLabel: `Yes, add ${spouseName} as parent`,
            cancelLabel: multi ? `No, skip ${spouseName}` : 'No, just ' + fromName,
          });
          if (yes) {
            await addRelationship({ personAId: spouseId, personBId: otherPersonId, type: 'parent_of' });
          }
        }
      }
    } else if (kind === 'partner') {
      await addRelationship({ personAId: fromPersonId, personBId: otherPersonId, type: 'spouse_of' });
    } else if (kind === 'sibling') {
      // Ask the user what kind of sibling relationship it is, rather
      // than silently assuming full siblings and auto-filling ghost
      // parents. Use the just-typed name (if this was a "Name them"
      // create) before falling back to allPersons, which may not have
      // reloaded yet.
      const fromName = allPersons.find(p => p.id === fromPersonId)?.name ?? 'this person';
      const toName = otherPersonName || allPersons.find(p => p.id === otherPersonId)?.name || 'this person';
      setSiblingKindDialog({ fromId: fromPersonId, toId: otherPersonId, fromName, toName });
      return; // dialog confirm handles the rest
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
    const personName = allPersons.find(p => p.id === personId)?.name ?? 'this person';
    const confirmMsg = `This will remove all ${edgesToRemove.length} relationship${edgesToRemove.length === 1 ? '' : 's'} involving ${personName}. The person themselves stays — only the relationships go. You'll have a few seconds to undo.`;
    if (!(await promptConfirm({
      title: `Remove all relationships?`,
      message: confirmMsg,
      confirmLabel: 'Remove all',
      danger: true,
    }))) return;
    // Snapshot edges BEFORE removal so Undo can re-create them.
    // We capture the full shape (type, flags, since/until) so restore
    // is lossless.
    const snapshot = edgesToRemove.map(e => ({
      personAId: e.aId,
      personBId: e.bId,
      type: e.type as any,
      since: e.since ?? null,
      until: e.until ?? null,
      flags: e.flags ?? null,
    }));
    for (const e of edgesToRemove) {
      if (e.id != null) await removeRelationship(e.id);
    }
    if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);

    // Offer Undo — re-creates the stored edges one by one. 12s window.
    toast(`Removed ${edgesToRemove.length} relationship${edgesToRemove.length === 1 ? '' : 's'} for ${personName}`, {
      duration: 12000,
      action: {
        label: 'Undo',
        onClick: async () => {
          for (const s of snapshot) {
            await addRelationship(s);
          }
          if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
          toast.success(`Restored ${snapshot.length} relationship${snapshot.length === 1 ? '' : 's'}`);
        },
      },
    });
  }, [graph, focusPersonId, fetchDepth, refetchGraph, allPersons]);


  return (
    <div className="flex-1 h-full flex flex-col bg-background relative">
      {/* Header bar */}
      <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-3">
        <GitBranch className="w-5 h-5 text-primary" />
        {/* Current tree name — click to rename inline. Falls back to
            'Trees' label while nothing is loaded yet. */}
        {editingTreeName ? (
          <input
            autoFocus
            value={treeNameDraft}
            onChange={e => setTreeNameDraft(e.target.value)}
            onBlur={commitTreeNameRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitTreeNameRename();
              else if (e.key === 'Escape') setEditingTreeName(false);
            }}
            className="text-base font-semibold bg-transparent border-b border-primary outline-none min-w-[12ch] max-w-[30ch]"
          />
        ) : (
          <IconTooltip label="Click to rename this tree" side="bottom" disabled={!currentTree}>
            <button
              onClick={() => {
                if (!currentTree) return;
                setTreeNameDraft(currentTree.name);
                setEditingTreeName(true);
              }}
              className="group inline-flex items-center gap-1.5 text-base font-semibold hover:text-primary transition-colors"
            >
              {currentTree?.name ?? 'Trees'}
              {currentTree && <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity" />}
            </button>
          </IconTooltip>
        )}
        {graph && (
          <>
            <span className="text-xs text-muted-foreground">
              {graph.nodes.length} {graph.nodes.length === 1 ? 'person' : 'people'} · {graph.edges.filter(e => !e.derived).length} relationships
            </span>
            <div className="flex-1" />
            {/* Add Info dropdown — per-card optional fields. For now just
                a 'Dates alive' toggle (off by default). More options can
                slot in here later. */}
            <div className="relative">
              <IconTooltip label="Show extra details inside each card (dates, etc.)" side="bottom">
                <button
                  onClick={() => setAddInfoOpen(v => !v)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                    showDates
                      ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
                      : 'bg-background border-border text-foreground hover:bg-accent'
                  }`}
                  aria-expanded={addInfoOpen}
                >
                  <Info className="w-4 h-4" />
                  Add Info{showDates ? ' (1)' : ''}
                </button>
              </IconTooltip>
              {addInfoOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setAddInfoOpen(false)}
                  />
                  <div className="absolute right-0 top-full mt-1 z-20 min-w-[220px] bg-popover border border-border rounded-lg shadow-lg py-1">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold px-3 pt-2 pb-1">Show below each card</p>
                    <label className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showDates}
                        onChange={e => toggleShowDates(e.target.checked)}
                        className="accent-primary"
                      />
                      <span className="flex-1">Dates Living</span>
                      <span className="text-[10px] text-muted-foreground">e.g. 1948–Living</span>
                    </label>
                  </div>
                </>
              )}
            </div>
            {/* Undo / Redo — history is persistent across sessions, so
                you can walk changes all the way back to when the app
                was first used. Buttons disable when the respective
                stack is empty; keyboard shortcut Ctrl/Cmd+Z also works. */}
            <div className="inline-flex items-center rounded-lg border border-border bg-background">
              <IconTooltip label={historyCounts.canUndo > 0 ? `Undo (Ctrl+Z) — ${historyCounts.canUndo} change${historyCounts.canUndo === 1 ? '' : 's'} available` : 'Nothing to undo'} side="bottom">
                <button
                  onClick={handleUndo}
                  disabled={historyCounts.canUndo === 0}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed rounded-l-lg"
                >
                  <Undo2 className="w-4 h-4" />
                </button>
              </IconTooltip>
              <div className="w-px h-5 bg-border" />
              <IconTooltip label={historyCounts.canRedo > 0 ? `Redo (Ctrl+Y) — ${historyCounts.canRedo} change${historyCounts.canRedo === 1 ? '' : 's'} available` : 'Nothing to redo'} side="bottom">
                <button
                  onClick={handleRedo}
                  disabled={historyCounts.canRedo === 0}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed rounded-r-lg"
                >
                  <Redo2 className="w-4 h-4" />
                </button>
              </IconTooltip>
            </div>
            <IconTooltip label="Rename, switch between, create, export, or remove saved trees" side="bottom">
              <button
                onClick={() => setManageTreesOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-sm font-medium text-primary hover:bg-primary/20 transition-colors"
              >
                <FolderOpen className="w-4 h-4" />
                Manage Trees
              </button>
            </IconTooltip>
            <IconTooltip label="List everyone on this tree, see photo counts, and delete mistakes" side="bottom">
              <button
                onClick={() => setTreePeopleOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-sm font-medium text-primary hover:bg-primary/20 transition-colors"
              >
                <Users className="w-4 h-4" />
                People
              </button>
            </IconTooltip>
            <IconTooltip label="Change the focus person" side="bottom">
              <button
                onClick={() => setFocusPickerOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-sm font-medium text-primary hover:bg-primary/20 transition-colors"
              >
                <Users className="w-4 h-4" />
                Change focus
              </button>
            </IconTooltip>
            {pinnedPeople.size > 0 && (
              <IconTooltip label={`${pinnedPeople.size} person${pinnedPeople.size === 1 ? ' is' : 's are'} pinned beyond your current Depth. Click to reset and re-hide them.`} side="bottom">
                <button
                  onClick={() => setPinnedPeople(new Map())}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-amber-500/10 border border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-colors"
                >
                  <Pin className="w-3 h-3" />
                  {pinnedPeople.size} pinned
                </button>
              </IconTooltip>
            )}
            {/* Steps filter — toggle + +/- stepper. Styled as a clear
                CTA pill: solid primary background when active, subtle
                outline when off. */}
            <FilterPill
              label="Steps"
              active={stepsEnabled}
              onToggle={() => setStepsEnabled(v => !v)}
            >
              <NumberStepper
                value={expandedHops}
                onChange={setExpandedHops}
                min={1}
                max={6}
                disabled={!stepsEnabled}
              />
            </FilterPill>
            {/* Generations filter — same look as Steps, but with two
                steppers (ancestors / descendants). No ↑/↓ arrows —
                Terry finds the extra chrome distracting. */}
            <FilterPill
              label="Generations"
              active={generationsEnabled}
              onToggle={() => setGenerationsEnabled(v => !v)}
            >
              <div className="inline-flex items-center gap-1">
                <NumberStepper
                  value={ancestorsDepth}
                  onChange={setAncestorsDepth}
                  min={0}
                  max={5}
                  disabled={!generationsEnabled}
                />
                <span className={`text-xs ${generationsEnabled ? 'text-muted-foreground' : 'text-muted-foreground/40'}`}>/</span>
                <NumberStepper
                  value={descendantsDepth}
                  onChange={setDescendantsDepth}
                  min={0}
                  max={5}
                  disabled={!generationsEnabled}
                />
              </div>
            </FilterPill>
            <IconTooltip label="Refresh" side="bottom">
              <button
                onClick={() => focusPersonId != null && refetchGraph(focusPersonId, fetchDepth)}
                className="p-1.5 rounded-lg border border-border hover:bg-accent transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </IconTooltip>
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
            onSetRelationship={(personId) => { setRelationshipEditorInitialTo(null); setRelationshipEditorFor(personId); }}
            onEditRelationships={(personId) => setEditRelationshipsFor(personId)}
            onRemovePerson={handleRemovePerson}
            onGraphMutated={handleRelationshipCreated}
            onQuickAddParent={(personId) => setQuickAdd({ fromPersonId: personId, kind: 'parent' })}
            onQuickAddPartner={(personId) => setQuickAdd({ fromPersonId: personId, kind: 'partner' })}
            onQuickAddChild={(personId) => setQuickAdd({ fromPersonId: personId, kind: 'child' })}
            onQuickAddSibling={(personId) => setQuickAdd({ fromPersonId: personId, kind: 'sibling' })}
            hideQuickAddChips={!stepsEnabled && !generationsEnabled}
            showDates={showDates}
            onEditDates={(personId, screenX, screenY) => {
              setDateEditor({ personId, x: screenX, y: screenY });
            }}
            canvasBackground={currentTree?.backgroundImage ?? null}
            canvasBackgroundOpacity={currentTree?.backgroundOpacity ?? 0.15}
            treeContrast={currentTree?.treeContrast ?? 0.3}
            allReachablePersonIds={connectedPersonIds}
            excludedSuggestionIds={excludedSuggestionIdSet}
            hiddenSuggestions={hiddenSuggestions}
            onHideSuggestion={currentTreeId != null ? toggleExcludedSuggestion : undefined}
            onUnhideSuggestion={currentTreeId != null ? toggleExcludedSuggestion : undefined}
            nameConflictLookup={nameConflictLookup}
            useGenderedLabels={currentTree?.useGenderedLabels ?? true}
            simplifyHalfLabels={currentTree?.simplifyHalfLabels ?? false}
            hideGenderMarker={currentTree?.hideGenderMarker ?? false}
            hiddenAncestorPersonIds={currentTree?.hiddenAncestorPersonIds ?? []}
            onToggleHiddenAncestor={async (personId) => {
              if (!currentTreeId || !currentTree) return;
              // Goes through toggleHiddenAncestor so the flip is logged
              // to graph_history — Ctrl+Z / Redo / "Revert to this
              // point" all roll it back like any relationship mutation.
              await toggleHiddenAncestor(currentTreeId, personId);
              await reloadSavedTrees();
              await refreshHistoryCounts();
            }}
            onRequestCardBackgroundPick={(personId, personName) => {
              if (!onRequestCardBackgroundPick || !currentTreeId) return;
              onRequestCardBackgroundPick({
                treeId: currentTreeId,
                treeName: currentTree?.name ?? 'tree',
                personId,
                personName,
              });
            }}
          />
        )}
        {/* Empty-state hint — anchored to the top of the canvas so it never
            overlaps with the centred focus avatar. */}
        {!loading && graph && graph.nodes.length === 1 && stepsEnabled === false && generationsEnabled === false ? (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 max-w-lg text-center px-4 py-3 bg-background/95 backdrop-blur rounded-lg shadow-md border border-border pointer-events-none">
            <h3 className="text-sm font-semibold">Nothing to show</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Both <strong>Steps</strong> and <strong>Generations</strong> are turned off, so only the focus person is visible. Turn one back on to see their family.
            </p>
          </div>
        ) : !loading && graph && graph.nodes.length === 1 && (
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
          // (name argument is accepted by onPick's type but unused here)
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
        const excludedSuggestions = currentTree?.excludedSuggestionPersonIds ?? [];
        const excluded = impossibleCandidates(quickAdd.fromPersonId, quickAdd.kind, graph, connectedPersonIds, excludedSuggestions);
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
            onHideSuggestion={currentTreeId != null ? toggleExcludedSuggestion : undefined}
            hiddenSuggestions={hiddenSuggestions}
            onUnhideSuggestion={currentTreeId != null ? toggleExcludedSuggestion : undefined}
            nameConflictLookup={nameConflictLookup}
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
            initialToPersonId={relationshipEditorInitialTo ?? undefined}
            onClose={() => { setRelationshipEditorFor(null); setRelationshipEditorInitialTo(null); }}
            onRelationshipCreated={handleRelationshipCreated}
            onPersonsChanged={reloadPersons}
            onOpenEditRelationships={(personId) => {
              // Close this modal and pop open Edit Relationships for
              // the other person so the user can fix the conflicting
              // link (remove it, or flip Parent ↔ Child).
              setRelationshipEditorFor(null);
              setRelationshipEditorInitialTo(null);
              setEditRelationshipsFor(personId);
            }}
          />
        );
      })()}

      {/* Edit Relationships list — shows every existing link for a
          person with per-row Edit / Remove controls and an Add-new CTA. */}
      {editRelationshipsFor != null && (() => {
        const person = allPersons.find(p => p.id === editRelationshipsFor);
        if (!person) return null;
        return (
          <EditRelationshipsModal
            personId={editRelationshipsFor}
            personName={person.name}
            persons={allPersons}
            onClose={() => setEditRelationshipsFor(null)}
            onEditEdge={(otherId) => {
              // Hand off to SetRelationshipModal with the other side
              // preselected — its edge-detection will prefill the form.
              const pid = editRelationshipsFor;
              setEditRelationshipsFor(null);
              setRelationshipEditorInitialTo(otherId);
              setRelationshipEditorFor(pid);
            }}
            onAddNew={() => {
              const pid = editRelationshipsFor;
              setEditRelationshipsFor(null);
              setRelationshipEditorInitialTo(null);
              setRelationshipEditorFor(pid);
            }}
            onChanged={handleRelationshipCreated}
          />
        );
      })()}

      {/* Manage Trees — list, rename, switch, (optionally) remove, and
          export as PNG / PDF. Opened from the header button. */}
      {manageTreesOpen && (
        <ManageTreesModal
          currentTreeId={currentTreeId}
          currentFocusPersonId={focusPersonId}
          getTreeSvg={() => document.querySelector<SVGSVGElement>('svg[data-tree-canvas="true"]')}
          onSwitch={switchToTree}
          onChanged={reloadSavedTrees}
          onClose={() => setManageTreesOpen(false)}
          onRequestNewTree={() => {
            // Close Manage Trees and open the focus picker so the user
            // starts a new tree with a chosen focal person + default
            // filters — NOT a clone of the current tree.
            setManageTreesOpen(false);
            setNewTreePickerOpen(true);
          }}
          onRequestBackgroundPick={(tree) => {
            if (!onRequestCanvasBackgroundPick) return;
            setManageTreesOpen(false);
            onRequestCanvasBackgroundPick({ treeId: tree.id, treeName: tree.name });
          }}
          getPersonName={(id) => {
            const p = allPersons.find(pp => pp.id === id);
            return p?.name?.trim() ? p.name : `Person #${id}`;
          }}
        />
      )}

      {/* New-tree focus picker — fires after the user clicks "New tree"
          in Manage Trees. On pick we create a saved tree with that
          focus and default filter settings, then switch to it. */}
      {newTreePickerOpen && (
        <FocusPickerModal
          persons={allPersons}
          currentFocusId={null}
          title="Who's at the centre of this new tree?"
          showSortOptions={true}
          onPick={async (personId) => {
            setNewTreePickerOpen(false);
            const r = await createSavedTree({
              name: 'Untitled tree',
              focusPersonId: personId,
              stepsEnabled: true,
              stepsDepth: 3,
              generationsEnabled: false,
              ancestorsDepth: 2,
              descendantsDepth: 2,
            });
            if (r.success && r.data) {
              await reloadSavedTrees();
              // Switch to the new tree (applies its settings and sets
              // focus via switchToTree).
              switchToTree(r.data);
              // Reopen Manage Trees so the user can immediately rename
              // the newly-created tree — it starts with "Untitled tree".
              setManageTreesOpen(true);
            }
          }}
          onPersonsChanged={reloadPersons}
          onClose={() => setNewTreePickerOpen(false)}
        />
      )}

      {/* Tree people list — shows everyone on the tree plus any
          orphaned persons (created in Trees but not reachable from the
          current focus). Lets the user delete mistakes with a 30-second
          undo toast; deletion of persons with photo tags is routed to
          People Manager so Trees can't casually destroy verified work. */}
      {treePeopleOpen && (
        <TreePeopleListModal
          focusPersonId={focusPersonId}
          treeName={currentTree?.name ?? 'this tree'}
          graph={graph}
          allPersons={allPersons}
          connectedPersonIds={connectedPersonIds}
          excludedSuggestionIds={excludedSuggestionIdSet}
          stepsEnabled={stepsEnabled}
          steps={expandedHops}
          onStepsChange={(next) => setExpandedHops(Math.max(1, Math.min(12, next)))}
          onSetFocus={(personId) => {
            // Inline focus change — the modal stays open; only the tree
            // state changes. The modal re-renders with the new focus
            // anchor and relationship labels.
            setFocusPersonId(personId);
          }}
          useGenderedLabels={currentTree?.useGenderedLabels ?? true}
          simplifyHalfLabels={currentTree?.simplifyHalfLabels ?? false}
          onClose={() => setTreePeopleOpen(false)}
          onPersonsChanged={async () => {
            await reloadPersons();
            if (focusPersonId != null) {
              const r = await getFamilyGraph(focusPersonId, fetchDepth);
              if (r.success && r.data) setGraph(r.data);
            }
          }}
        />
      )}

      {/* Date quick editor — opens when the user clicks the dates strip
          inside a card (when Dates Living is on). Year-only entry with
          a "still living" checkbox. Saves via updatePersonLifeEvents. */}
      {dateEditor && (() => {
        const node = graph?.nodes.find(n => n.personId === dateEditor.personId);
        const name = node?.name ?? allPersons.find(p => p.id === dateEditor.personId)?.name ?? '';
        return (
          <DateQuickEditor
            personId={dateEditor.personId}
            personName={name}
            birthDate={node?.birthDate ?? null}
            deathDate={node?.deathDate ?? null}
            x={dateEditor.x}
            y={dateEditor.y}
            onSaved={() => {
              setDateEditor(null);
              if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
            }}
            onClose={() => setDateEditor(null)}
          />
        );
      })()}

      {/* Sibling kind dialog — fires after the +sibling quick-add picks
          a person. Asks full vs half vs none vs unknown before touching
          any parent_of edges, so we don't silently auto-fill shared
          placeholder parents when that isn't the intent. */}
      {siblingKindDialog && (
        <SiblingKindDialog
          fromPersonId={siblingKindDialog.fromId}
          fromPersonName={siblingKindDialog.fromName}
          toPersonId={siblingKindDialog.toId}
          toPersonName={siblingKindDialog.toName}
          graph={graph}
          onConfirm={(kind, sharedParentId) => {
            finaliseSiblingKind(kind, sharedParentId);
          }}
          onClose={() => setSiblingKindDialog(null)}
        />
      )}
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
/** Header filter button with its own stepper control tucked to the right.
 *  Active state looks like a CTA (solid primary tint, primary border);
 *  off state looks muted but still clearly clickable. Matches the
 *  'Change focus' button's look so the three header controls read as a
 *  consistent row of actions, not a mix of labels and inputs. */
function FilterPill({ label, active, onToggle, children }: {
  label: string; active: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div
      className={`inline-flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded-lg border transition-colors ${
        active
          ? 'bg-primary/10 border-primary/30'
          : 'bg-background border-border'
      }`}
    >
      <button
        onClick={onToggle}
        aria-pressed={active}
        className={`px-2 py-0.5 rounded text-sm font-medium transition-colors ${
          active ? 'text-primary' : 'text-muted-foreground hover:bg-accent'
        }`}
      >
        {label}
      </button>
      {children}
    </div>
  );
}

/** Compact stepper control — two buttons (−/+) around a centered number.
 *  Replaces a native <select> where quick small adjustments matter.
 *  When disabled, the whole control dims but stays rendered so the
 *  header layout doesn't shift when the parent toggle flips. */
function NumberStepper({ value, onChange, min, max, disabled }: {
  value: number; onChange: (n: number) => void; min: number; max: number; disabled?: boolean;
}) {
  const dec = () => !disabled && onChange(Math.max(min, value - 1));
  const inc = () => !disabled && onChange(Math.min(max, value + 1));
  return (
    <div className={`inline-flex items-center text-xs ${disabled ? 'opacity-40' : ''}`}>
      <button
        type="button"
        onClick={dec}
        disabled={disabled || value <= min}
        className="w-5 h-5 flex items-center justify-center rounded hover:bg-accent disabled:hover:bg-transparent disabled:text-muted-foreground/40"
        aria-label="Decrease"
      >
        −
      </button>
      <span className="w-5 text-center font-mono tabular-nums">{value}</span>
      <button
        type="button"
        onClick={inc}
        disabled={disabled || value >= max}
        className="w-5 h-5 flex items-center justify-center rounded hover:bg-accent disabled:hover:bg-transparent disabled:text-muted-foreground/40"
        aria-label="Increase"
      >
        +
      </button>
    </div>
  );
}

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
  graph: FamilyGraph | null,
  /** Full DB-level family closure of the current tree (every person
   *  reachable from the focus by any relationship chain, no depth cap).
   *  Anyone already in the tree in some role is a poor quick-add
   *  candidate — adding them as a new role is almost always either a
   *  mistake (namesake confusion) or a structural change that belongs
   *  in the Edit Relationships flow, not a casual quick-add. Optional
   *  because the caller may not have it loaded yet on first render. */
  connectedPersonIds?: Set<number>,
  /** Per-tree user-flagged "not part of this family" list. Persists
   *  across sessions via the saved_trees.excluded_suggestion_person_ids
   *  column. Reversible via the picker's review list. */
  excludedSuggestionPersonIds?: Iterable<number>,
): Set<number> {
  const out = new Set<number>([fromId]);
  // Primary filter: exclude everyone already on this family tree via
  // the DB closure. The graph-based checks further down are a safety
  // net for the narrow window before connectedPersonIds resolves, plus
  // defensively for any case where the closure is stale.
  if (connectedPersonIds) {
    for (const id of connectedPersonIds) out.add(id);
  }
  // User-curated exclusions — people they've manually flagged as not
  // part of this family (e.g. Michael Gentleman for a Clapson tree).
  // These apply to every kind (parent/child/partner/sibling) because
  // "not in this family" means not in any role.
  if (excludedSuggestionPersonIds) {
    for (const id of excludedSuggestionPersonIds) out.add(id);
  }
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
    // The outer loop already excluded the full family closure (via
    // connectedPersonIds). Belt-and-braces: also exclude the fetched
    // graph closure in case connectedPersonIds is stale.
    const closure = familyClosure(fromId, graph);
    for (const id of closure) out.add(id);
    // Co-parents of fromId's children are exactly the couples the
    // user is likely trying to formalize as partners (e.g. Sally and
    // Alan, who share Colin as a child, but whose spouse_of edge
    // hasn't been asserted yet). Exempt them from BOTH the DB-level
    // closure AND the graph-level closure — they're valid candidates,
    // not hidden relatives.
    const coparents = coparentsOf(fromId, graph);
    for (const cp of coparents) out.delete(cp);
    // Self is never a valid partner, even if somehow flagged as a
    // co-parent of their own child (duplicate edge shouldn't exist
    // but we guard anyway).
    out.add(fromId);
    // Block anyone currently in an active spouse_of with a third
    // party — already-married people aren't valid partner suggestions
    // even if they're a co-parent.
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
  /** Called with the chosen person's id AND their display name. Name is
   *  passed explicitly because allPersons in the parent may not have
   *  reloaded yet when a brand-new person was just created via the
   *  "Name them" path, leaving callers to fall back to "this person". */
  onPick: (personId: number, personName: string) => void;
  onPersonsChanged?: () => void;
  onClose: () => void;
  /** When a typed name in the "Name them" tab matches an existing person
   *  already on this tree, return that person so the user can confirm
   *  whether they really intended to create a new namesake. null = no
   *  conflict. When omitted, no name-conflict warning is shown. */
  nameConflictLookup?: (name: string) => { id: number; name: string } | null;
  /** Hide a suggested person from future picker lists in this tree.
   *  Used for the "Michael Gentleman isn't in this family" case — one
   *  click removes them from every picker until the user un-hides via
   *  the review list. When omitted, per-row hide buttons don't render. */
  onHideSuggestion?: (personId: number) => void | Promise<void>;
  /** Persons currently hidden from suggestions in this tree. Surfaced
   *  in the "N hidden — review" footer so mistakes can be reversed. */
  hiddenSuggestions?: PersonSummary[];
  /** Counterpart of onHideSuggestion — removes a person from the hidden
   *  list, bringing them back into the suggestion pool. Called from the
   *  review list. */
  onUnhideSuggestion?: (personId: number) => void | Promise<void>;
}

type PickerSortMode = 'connections' | 'photos' | 'alpha';

function FocusPickerModal({ persons, currentFocusId, title, cooccurrenceAnchorId, showSortOptions, coparentIds, partnerScoreAnchorId, onPick, onPersonsChanged, onClose, nameConflictLookup, onHideSuggestion, hiddenSuggestions, onUnhideSuggestion }: FocusPickerModalProps) {
  // Shared drag hook — header stays on-screen even after drag.
  const { modalRef, dragHandleProps } = useDraggableModal();

  // Single-flow picker: one search input drives BOTH existing-person
  // filtering AND the "+ Add X to PDR" create affordance that appears
  // at the bottom of the results when the query doesn't exactly match
  // any existing person. Replaces the older tabbed design (Link to
  // existing / Name them) that split the same intent across two
  // surfaces and forced the user to pick a mode before typing.
  const [query, setQuery] = useState('');
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
    .filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()))
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

  const handleCreate = async (rawName: string) => {
    setError(null);
    const trimmed = rawName.trim();
    if (!trimmed) { setError('Type a name first.'); return; }
    // Namesake guard: if someone on this tree already has this exact
    // name, ask the user to confirm a genuine namesake before we
    // create a second person with the same name. Without this the
    // single-flow picker would cheerfully create a second Dorothy.
    const conflict = nameConflictLookup?.(trimmed);
    if (conflict) {
      const proceed = await promptConfirm({
        title: `"${conflict.name}" is already on this tree`,
        message: `Someone named "${conflict.name}" already exists on your tree. Creating a new person here will add a second person with the same name — only do this if they're genuinely different people who happen to share a name.`,
        confirmLabel: `Yes, create another "${trimmed}"`,
        cancelLabel: 'Cancel',
      });
      if (!proceed) return;
    }
    setBusy(true);
    const r = await createNamedPerson(trimmed);
    setBusy(false);
    if (!r.success || r.data == null) {
      setError(r.error ?? 'Could not create person.');
      return;
    }
    if (onPersonsChanged) onPersonsChanged();
    onPick(r.data, trimmed);
  };

  // Exact-match check used to decide whether to show the "+ Add X"
  // create row. If the user has typed a name that exactly matches an
  // existing candidate (case/whitespace insensitive), we skip the
  // create row — the existing person is already right there to click.
  const trimmedQuery = query.trim();
  const hasExactMatch = trimmedQuery.length > 0 && filtered.some(
    p => p.name.trim().toLowerCase() === trimmedQuery.toLowerCase()
  );
  const showCreateRow = trimmedQuery.length > 0 && !hasExactMatch && !busy;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={modalRef}
        className="bg-background rounded-xl shadow-2xl border border-border max-w-md w-full p-4"
        onClick={e => e.stopPropagation()}
      >
        <div
          {...dragHandleProps}
          className={`flex items-center gap-2 mb-3 ${dragHandleProps.className}`}
        >
          <Move className="w-3 h-3 text-muted-foreground/60 shrink-0" aria-hidden />
          <UserPlus className="w-4 h-4 text-primary" />
          <span className="text-base font-semibold">{title ?? 'Focus on who?'}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-0.5 rounded hover:bg-accent">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Single-flow picker: one search input, existing matches
            filtered below, a "+ Add X to PDR" create row appended at
            the bottom when the query doesn't match anyone. */}
        <div>
          <input
              type="text"
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const exact = filtered.find(p => p.name.trim().toLowerCase() === trimmedQuery.toLowerCase());
                  if (exact) onPick(exact.id);
                  else if (filtered.length === 1) onPick(filtered[0].id);
                  else if (showCreateRow) handleCreate(trimmedQuery);
                }
              }}
              placeholder="Search or type a new name…"
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
                // Context-specific rich label (shares children / shared
                // photos / connection count) takes priority when it
                // carries more signal than the raw photo count.
                let rightLabel: string | null = null;
                if (isCoparent) {
                  rightLabel = 'shares children';
                } else if (cooccurrenceAnchorId != null && coCount != null && coCount > 0) {
                  rightLabel = `${coCount} shared photo${coCount === 1 ? '' : 's'}`;
                } else if (showSortOptions) {
                  if (sortMode === 'connections' && connCount > 0) rightLabel = `${connCount} connection${connCount === 1 ? '' : 's'}`;
                  else if (sortMode === 'photos' && p.photoCount > 0) rightLabel = `${p.photoCount} photo${p.photoCount === 1 ? '' : 's'}`;
                }
                // Fallback: plain photo count, matching the placeholder
                // resolver's row format so users see the same signal
                // ("N photos") across both pickers — helps them spot
                // which candidate is the right match when names are
                // identical or similar.
                if (!rightLabel) {
                  rightLabel = `${p.photoCount} ${p.photoCount === 1 ? 'photo' : 'photos'}`;
                }
                return (
                  <div
                    key={p.id}
                    className={`group flex items-center gap-1 px-2 py-1 rounded text-sm ${
                      p.id === currentFocusId ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-accent'
                    } ${busy ? 'opacity-50' : ''}`}
                  >
                    <button
                      onClick={() => !busy && onPick(p.id)}
                      disabled={busy}
                      className="flex-1 min-w-0 flex items-center justify-between gap-2 text-left"
                    >
                      <span className="truncate">{p.name}</span>
                      {rightLabel && (
                        <span className="text-[10px] text-muted-foreground shrink-0">{rightLabel}</span>
                      )}
                    </button>
                    {onHideSuggestion && (
                      <IconTooltip label="Not in this family — hide from suggestions" side="left">
                        <button
                          onClick={(e) => { e.stopPropagation(); onHideSuggestion(p.id); }}
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded text-muted-foreground hover:text-destructive hover:bg-background shrink-0 transition-opacity"
                          aria-label={`Hide ${p.name} from suggestions`}
                        >
                          <EyeOff className="w-3 h-3" />
                        </button>
                      </IconTooltip>
                    )}
                  </div>
                );
              })}
              {showCreateRow && (
                <button
                  onClick={() => handleCreate(trimmedQuery)}
                  disabled={busy}
                  className="flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left text-primary hover:bg-primary/10 border-t border-dashed border-border/60 mt-0.5 pt-2 disabled:opacity-50"
                >
                  <UserPlus className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    <span className="text-muted-foreground">This person isn't on PDR yet. Add </span>
                    <strong className="text-foreground">{trimmedQuery}</strong>
                    <span className="text-muted-foreground"> as a new person?</span>
                  </span>
                </button>
              )}
            </div>
            {hiddenSuggestions && hiddenSuggestions.length > 0 && onUnhideSuggestion && (
              <HiddenSuggestionsReview
                hidden={hiddenSuggestions}
                onUnhide={onUnhideSuggestion}
              />
            )}
          </div>

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        <div className="flex items-center gap-2 mt-3 pt-2 border-t border-border">
          <div className="flex-1" />
          <button onClick={onClose} className="px-2.5 py-1 rounded text-xs hover:bg-accent">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

