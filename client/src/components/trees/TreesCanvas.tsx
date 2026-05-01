import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { Link2, Trash2, Eye, EyeOff, Pencil, HelpCircle, UserPlus, X, Image as ImageIcon, Move } from 'lucide-react';
import { getFaceCrop, updateRelationship, removeRelationship, namePlaceholder, mergePlaceholderIntoPerson, removePlaceholder, listPersons, listRelationshipsForPerson, createPlaceholderPerson, createNamedPerson, addRelationship, setPersonCardBackground, type FamilyGraphEdge } from '@/lib/electron-bridge';
import type { TreeLayout, LaidOutNode, LaidOutEdge } from '@/lib/trees-layout';
import { DateTripleInput } from './DateTripleInput';
import { promptConfirm, promptChoice } from './promptConfirm';
import { HiddenSuggestionsReview } from './HiddenSuggestionsReview';
import { useDraggableModal } from './useDraggableModal';
import { computeRelationshipLabels } from '@/lib/relationship-label';
import { GenderPickerModal, genderMarkerSymbol } from './GenderPickerModal';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { setPersonGender as setPersonGenderApi, type PersonGender } from '@/lib/electron-bridge';

interface TreesCanvasProps {
  layout: TreeLayout & { collapsedCountPerAnchor?: Map<number, number> };
  onRefocus: (personId: number) => void;
  onSetRelationship: (personId: number) => void;
  /** Opens a list of all existing relationships touching this person,
   *  with per-row Edit and Remove controls plus an Add-new CTA. */
  onEditRelationships: (personId: number) => void;
  onRemovePerson: (personId: number) => void;
  /** Direct-relationship quick adds triggered by the +/chips around each node.
   *  Each fires a lightweight add flow (opens a small person picker). */
  onQuickAddParent: (personId: number) => void;
  onQuickAddPartner: (personId: number) => void;
  onQuickAddChild: (personId: number) => void;
  onQuickAddSibling: (personId: number) => void;
  /** Suppress the +parent/+child/+partner/+sibling chips around each
   *  node. Used when both the Steps and Generations filters are off —
   *  the user can't see the tree they'd be adding into, and any
   *  relationships they'd create probably already exist outside the
   *  (empty) visible window. */
  hideQuickAddChips?: boolean;
  /** Show the optional birth–death dates line inside each card. Toggled
   *  from the header's 'Add Info' dropdown. */
  showDates?: boolean;
  /** Called when the user clicks the date strip on a card to edit
   *  birth/death years inline. Parent opens DateQuickEditor. */
  onEditDates?: (personId: number, screenX: number, screenY: number) => void;
  /** Called when the user clicks the name on a card to edit short
   *  + full names. Parent opens NameQuickEditor anchored to the
   *  click point. */
  onEditName?: (personId: number, screenX: number, screenY: number) => void;
  /** Called after an inline edge edit succeeds so the parent can refetch the graph. */
  onGraphMutated: () => void;
  /** Optional per-tree canvas background image (data URL). Rendered as a
   *  fixed, faded backdrop behind the family graph. */
  canvasBackground?: string | null;
  /** 0–1 opacity for the canvas background image. */
  canvasBackgroundOpacity?: number;
  /** 0–1 contrast boost — stronger card border + shadow + edge strokes
   *  so the tree pops against a busy background. */
  treeContrast?: number;
  /** When true, relationship labels under card names use gendered
   *  forms (Mother/Father/…) for people whose gender is set. */
  useGenderedLabels?: boolean;
  /** When true, half-sibling relationships render as plain Brother /
   *  Sister / Sibling instead of the technically-accurate Half-*
   *  forms. Tree-level preference set from Manage Trees. */
  simplifyHalfLabels?: boolean;
  /** When true, the Mars/Venus/Combined symbol in the top-right of each
   *  card is suppressed even when gender is set. The "G" button stays
   *  visible so the user can still edit gender — it just doesn't
   *  preview the result. */
  hideGenderMarker?: boolean;
  /** Person IDs whose ancestors are hidden in this tree. When set, any
   *  person reachable ONLY through that person's parent_of↑ chain is
   *  filtered from the render. */
  hiddenAncestorPersonIds?: number[];
  /** Toggle whether a partner's ancestry is hidden in this tree. */
  onToggleHiddenAncestor?: (personId: number) => void;
  /** Parent-provided handler that opens the S&D picker flow for a
   *  specific person's card background. */
  onRequestCardBackgroundPick?: (personId: number, personName: string) => void;
  /** Every person ID connected to the focus in the fetched family
   *  graph — BEFORE Steps / hide-ancestry filtering. Used by the
   *  placeholder resolver to exclude already-linked people from "Link
   *  to existing" suggestions, including those currently off-screen
   *  or hidden. */
  allReachablePersonIds?: Set<number>;
  /** Per-tree "not in this family" exclusion list — same set used by
   *  the + quick-add picker, so hides in either surface take effect
   *  everywhere. Includes the toggle + review data for symmetry. */
  excludedSuggestionIds?: Set<number>;
  hiddenSuggestions?: { id: number; name: string }[];
  onHideSuggestion?: (personId: number) => void | Promise<void>;
  onUnhideSuggestion?: (personId: number) => void | Promise<void>;
  /** Namesake guard — if the user types a name matching someone
   *  already on this tree, warn before silently creating a duplicate.
   *  (Root cause of the double-Dorothy bug.) */
  nameConflictLookup?: (name: string) => { id: number; name: string } | null;
  /** Fired after a placeholder has been resolved as a NEW parent of
   *  some child. The resolver itself doesn't own the marriage prompt;
   *  the parent (TreesView) does, so it can ask "how are these two
   *  parents related?" once a child reaches its second parent. */
  onParentResolved?: (parentId: number, childId: number) => Promise<void>;
  /** Fired when the user clicks the ^ chevron above a person whose
   *  totalParentCount exceeds the parents currently visible — i.e.
   *  ancestors exist beyond the active Steps / Generations window.
   *  TreesView probes the graph at deeper depth and pins whichever
   *  ancestors weren't already on canvas, mirroring the behaviour
   *  of pinning a quick-add result that lands beyond Depth. */
  onExpandAncestors?: (personId: number) => void;
  /** Fired when the user clicks the v chevron below a person whose
   *  totalChildCount exceeds the children currently visible — i.e.
   *  descendants exist beyond the active filters. Same probe-and-pin
   *  pattern as onExpandAncestors but downward. */
  onExpandDescendants?: (personId: number) => void;
  /** Person IDs whose ancestors have been REVEALED via the ^ chevron.
   *  Drives the chevron's toggle indicator: members of the set show
   *  a "collapse" glyph; others show an "expand" glyph. Click on a
   *  member fires onExpandAncestors as a hide instead of a reveal,
   *  same as a second click on a folder in a file tree. */
  expandedAncestorsOf?: Set<number>;
  /** Mirror of expandedAncestorsOf for the v chevron below the card. */
  expandedDescendantsOf?: Set<number>;
}

interface Viewport { tx: number; ty: number; scale: number; }

const NODE_RADIUS = 42; // legacy — kept for spouse-line math and partner-chip positioning
const NODE_WIDTH = 150;
const NODE_HEIGHT = 150;
// Card-style node dimensions (royal-chart style). Internal padding is
// distributed evenly so there's room above the avatar, between avatar
// and name, and between name and dates — no big empty gap at the
// bottom as there was in the first pass.
const CARD_W = 170;
// 10% taller than v1 to give the relationship label + dates line
// enough breathing room. Layout row height is bumped in lockstep via
// trees-layout.ts so vertical gaps don't shrink to nothing.
const CARD_H = 154;
const AVATAR_R = 36;
const CARD_TOP_PAD = 14;
const AVATAR_TO_NAME = 22;
// Name → relationship label gap (label sits beneath the name, above
// the dates line). Kept tight so the label reads as name metadata.
const NAME_TO_LABEL = 15;
// Name → dates baseline. Includes NAME_TO_LABEL + ~14px for the label
// itself so dates clear it cleanly.
const NAME_TO_DATES = 30;
const AVATAR_CY = -CARD_H / 2 + CARD_TOP_PAD + AVATAR_R;

/** Step-distance badge colours. Terry picked the palette: lavender →
 *  gold → blue → green → pink → yellow → grey → eggshell. Kept as
 *  tinted pastel fills so the dark number stays legible on top. */
const STEP_BADGE_FILL: Record<number, string> = {
  1: '#c4b5fd', // lavender (violet-300)
  2: '#fcd34d', // gold (amber-300)
  3: '#93c5fd', // blue (blue-300)
  4: '#86efac', // green (green-300)
  5: '#f9a8d4', // pink (pink-300)
  6: '#fde68a', // yellow (yellow-200)
  7: '#d1d5db', // grey (gray-300)
  8: '#f5f5dc', // eggshell
};

export function TreesCanvas({ layout, onRefocus, onSetRelationship, onEditRelationships, onRemovePerson, onQuickAddParent, onQuickAddPartner, onQuickAddChild, onQuickAddSibling, hideQuickAddChips, showDates, onEditDates, onEditName, onGraphMutated, canvasBackground, canvasBackgroundOpacity = 0.15, treeContrast = 0.3, useGenderedLabels = false, simplifyHalfLabels = false, hideGenderMarker = false, hiddenAncestorPersonIds, onToggleHiddenAncestor, onRequestCardBackgroundPick, allReachablePersonIds, excludedSuggestionIds, hiddenSuggestions, onHideSuggestion, onUnhideSuggestion, nameConflictLookup, onParentResolved, onExpandAncestors, onExpandDescendants, expandedAncestorsOf, expandedDescendantsOf }: TreesCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ tx: 0, ty: 0, scale: 1 });
  const [avatars, setAvatars] = useState<Map<number, string>>(new Map());
  const [contextMenu, setContextMenu] = useState<{ personId: number; x: number; y: number } | null>(null);

  /** Step 6 of TREES_PANEL_DESIGN.md — drag mechanics + constraints +
   *  position memory. Per-panel offset (in screen pixels) from the
   *  panel's auto-computed default position. Keyed by
   *  `${personId}-${direction}` so each chevron's panel remembers its
   *  drag position independently within the session. */
  const [panelOffsets, setPanelOffsets] = useState<Map<string, { x: number; y: number }>>(new Map());
  const panelDragRef = useRef<{
    active: boolean;
    panelKey: string;
    startMouseX: number;
    startMouseY: number;
    startOffsetX: number;
    startOffsetY: number;
    // Cached for live-clamp during drag — without these we'd have to
    // re-derive the constraint bounds on every mousemove.
    minOffsetX: number;
    maxOffsetX: number;
    minOffsetY: number;
    maxOffsetY: number;
  }>({
    active: false,
    panelKey: '',
    startMouseX: 0, startMouseY: 0,
    startOffsetX: 0, startOffsetY: 0,
    minOffsetX: 0, maxOffsetX: 0,
    minOffsetY: 0, maxOffsetY: 0,
  });
  /** Popup editor anchored to a clicked edge. Only set while the popup is open. */
  const [edgeEditor, setEdgeEditor] = useState<{ edge: FamilyGraphEdge; x: number; y: number } | null>(null);
  /** Popup for resolving a placeholder ghost node (name/link/remove). */
  // Placeholder editor state. Two modes:
  //   { personId, ... }      — editing a PERSISTED placeholder (real DB row)
  //   { virtualChildId, ... } — resolving a VIRTUAL ghost that hasn't been
  //                             materialised yet. On commit the resolver
  //                             creates (or links) a real person and wires
  //                             the parent_of edge; on cancel nothing
  //                             persists, so orphan 'Unknown' rows no
  //                             longer accumulate.
  const [placeholderEditor, setPlaceholderEditor] = useState<
    | { kind: 'persisted'; personId: number; x: number; y: number }
    | { kind: 'virtual'; virtualChildIds: number[]; x: number; y: number }
    | null
  >(null);


  const panState = useRef<{ active: boolean; startX: number; startY: number; startTx: number; startTy: number }>({
    active: false, startX: 0, startY: 0, startTx: 0, startTy: 0,
  });

  // ─── Centre the focus on mount / layout change ────────────────
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setViewport({
      tx: rect.width / 2,
      ty: rect.height / 2,
      scale: 1,
    });
    setContextMenu(null);
  }, [layout.focusPersonId]);

  // ─── Lazy-load avatar face crops ───────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const node of layout.nodes) {
        if (avatars.has(node.personId)) continue;
        if (!node.representativeFaceFilePath || !node.representativeFaceBox) continue;
        const box = node.representativeFaceBox;
        const res = await getFaceCrop(node.representativeFaceFilePath, box.x, box.y, box.w, box.h, 128);
        if (cancelled) return;
        if (res.success && res.dataUrl) {
          setAvatars(prev => {
            const next = new Map(prev);
            next.set(node.personId, res.dataUrl!);
            return next;
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [layout.nodes]);

  // ─── Viewport interactions ─────────────────────────────────────
  const handleWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = 1 + direction * 0.1;
    setViewport(v => {
      const newScale = Math.min(3, Math.max(0.2, v.scale * factor));
      // Zoom about the cursor: keep the world-point under the cursor fixed.
      const worldX = (mouseX - v.tx) / v.scale;
      const worldY = (mouseY - v.ty) / v.scale;
      return {
        tx: mouseX - worldX * newScale,
        ty: mouseY - worldY * newScale,
        scale: newScale,
      };
    });
  }, []);

  const handlePanStart = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    setContextMenu(null);
    panState.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startTx: viewport.tx,
      startTy: viewport.ty,
    };
  }, [viewport]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (panState.current.active) {
        setViewport(v => ({
          ...v,
          tx: panState.current.startTx + (e.clientX - panState.current.startX),
          ty: panState.current.startTy + (e.clientY - panState.current.startY),
        }));
      }
      if (panelDragRef.current.active) {
        // Live-clamp during drag — design doc specifies hard-clamp
        // behaviour (no spring-back), so we apply min/max bounds at
        // every mousemove rather than letting the offset go free
        // and snapping later.
        const d = panelDragRef.current;
        const rawX = d.startOffsetX + (e.clientX - d.startMouseX);
        const rawY = d.startOffsetY + (e.clientY - d.startMouseY);
        const x = Math.max(d.minOffsetX, Math.min(d.maxOffsetX, rawX));
        const y = Math.max(d.minOffsetY, Math.min(d.maxOffsetY, rawY));
        setPanelOffsets(prev => {
          const next = new Map(prev);
          next.set(d.panelKey, { x, y });
          return next;
        });
      }
    };
    const onUp = () => {
      panState.current.active = false;
      panelDragRef.current.active = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [viewport.scale]);

  // Individual-node dragging is intentionally disabled — the layout is
  // deterministic and stable, so letting users drag people around just
  // produces crooked lines and visual chaos. Users still pan the whole
  // canvas by dragging empty space and change focus to re-centre.
  const handleNodeMouseDown = useCallback((_e: React.MouseEvent, _node: LaidOutNode) => {
    // No-op: lets mousedown bubble to the SVG so pan works over nodes.
  }, []);

  const handleNodeDoubleClick = useCallback((e: React.MouseEvent, node: LaidOutNode) => {
    e.stopPropagation();
    // Placeholders don't accept refocus — they're not real people yet.
    if (node.isPlaceholder) return;
    if (node.personId !== layout.focusPersonId) onRefocus(node.personId);
  }, [layout.focusPersonId, onRefocus]);

  const handleNodeClick = useCallback(async (e: React.MouseEvent, node: LaidOutNode) => {
    // Only single-click matters for placeholders: opens the resolver popup.
    if (!node.isPlaceholder) return;
    e.stopPropagation();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const screenX = viewport.tx + node.renderedX * viewport.scale;
    const screenY = viewport.ty + node.renderedY * viewport.scale;

    // Virtual ghosts have negative IDs. Pass the virtual-edge info to
    // the resolver — DO NOT materialise into a real placeholder yet.
    // Materialising on click caused orphan 'Unknown' rows to pile up
    // every time the user opened + closed the popup without committing.
    if (node.personId < 0) {
      // Collect EVERY child the ghost parents — a shared ghost for a
      // sibling group has one parent_of edge per sibling. Previously
      // used `.find()` which grabbed only the first, silently dropping
      // the rest and demoting full siblings to half siblings when the
      // ghost was filled in.
      const childIds = layout.edges
        .filter(ed => ed.aId === node.personId && ed.type === 'parent_of')
        .map(ed => ed.bId);
      if (childIds.length === 0) return;
      setPlaceholderEditor({ kind: 'virtual', virtualChildIds: childIds, x: screenX, y: screenY });
    } else {
      setPlaceholderEditor({ kind: 'persisted', personId: node.personId, x: screenX, y: screenY });
    }
    setEdgeEditor(null);
    setContextMenu(null);
  }, [viewport, layout]);

  const handleNodeContextMenu = useCallback((e: React.MouseEvent, node: LaidOutNode) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setContextMenu({
      personId: node.personId,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }, []);

  // Per-card background picker — defers to the workspace which routes
  // the user to S&D "pick mode" with a confirmation banner. The pick
  // is persisted upstream; we just refresh the graph once it returns.
  const pickCardBackgroundFor = useCallback((personId: number) => {
    if (!onRequestCardBackgroundPick) return;
    const node = layout.nodes.find(n => n.personId === personId);
    // Prefer full name in the pick-mode banner — that's a formal
    // string the user sees while choosing a photo, not a node label.
    const name = node?.fullName?.trim() || node?.name?.trim() || 'this person';
    onRequestCardBackgroundPick(personId, name);
  }, [onRequestCardBackgroundPick, layout.nodes]);

  const clearCardBackgroundFor = useCallback(async (personId: number) => {
    await setPersonCardBackground(personId, null);
    onGraphMutated();
  }, [onGraphMutated]);

  // Rendered positions come straight from the deterministic layout;
  // there are no per-node offsets since individual dragging is disabled.
  // (hiddenExtendedIds is applied AT RENDER TIME below, not here, so
  // nodeById and the various edge maps still see the full layout.)
  const placedNodes = useMemo(() => layout.nodes.map(n => ({
    ...n, renderedX: n.x, renderedY: n.y,
  })), [layout.nodes]);

  const nodeById = useMemo(() => {
    const m = new Map<number, typeof placedNodes[0]>();
    for (const n of placedNodes) m.set(n.personId, n);
    return m;
  }, [placedNodes]);

  /** Per-person count of CURRENT (not ended) spouse_of edges. The
   *  +sibling/+partner chip menu uses this to decide which option
   *  to highlight as primary — if the user already has a partner,
   *  Sibling is the more likely follow-up; otherwise Partner is. */
  const currentPartnerCount = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of layout.edges) {
      if (e.type !== 'spouse_of') continue;
      if (e.derived) continue;
      const flags = (e.flags ?? {}) as { ended?: boolean };
      if (flags.ended) continue;
      if (e.until) continue;
      m.set(e.aId, (m.get(e.aId) ?? 0) + 1);
      m.set(e.bId, (m.get(e.bId) ?? 0) + 1);
    }
    return m;
  }, [layout.edges]);

  /** How many parents and children are CURRENTLY VISIBLE on canvas
   *  for each person — counted from the laid-out parent_of edges
   *  (a is parent, b is child). Compared against the DB-wide
   *  totalParentCount / totalChildCount to know whether out-of-
   *  scope ancestors / descendants exist. Placeholder ghost edges
   *  count too — they tell the user the slot is "filled" even if
   *  the name isn't, so we shouldn't pretend more parents are
   *  hiding off-screen on top of a ghost. */
  const visibleParentChildCounts = useMemo(() => {
    const parentCount = new Map<number, number>();
    const childCount = new Map<number, number>();
    for (const e of layout.edges) {
      if (e.type !== 'parent_of') continue;
      if (!nodeById.has(e.aId) || !nodeById.has(e.bId)) continue;
      childCount.set(e.aId, (childCount.get(e.aId) ?? 0) + 1);
      parentCount.set(e.bId, (parentCount.get(e.bId) ?? 0) + 1);
    }
    return { parentCount, childCount };
  }, [layout.edges, nodeById]);

  /** For each non-bloodline visible person, the full set of their
   *  unique ancestors (everyone reachable upward via parent_of that
   *  ISN'T on the focus's bloodline). This is what the per-card
   *  chevron toggles — by default these are hidden so the tree
   *  doesn't sprawl with every partner's family-of-origin every time
   *  a sibling marries someone new. Empty entries (the rare case
   *  where the non-bloodline person has no known parents at all)
   *  are dropped so we don't paint a useless no-op chevron. */
  /** Bloodline-of-focus set = every BLOOD RELATIVE of the focus.
   *
   *  A person is bloodline iff they share at least one biological
   *  ancestor with the focus (or ARE the focus). The two-pass walk
   *  captures the whole closure correctly:
   *    1. Climb parent_of edges UP from focus → ancestors_of_focus.
   *    2. From each ancestor (and from the focus itself), descend
   *       parent_of edges DOWN → every descendant of any ancestor.
   *  The union catches siblings (descendants of parents), nieces /
   *  nephews (descendants of siblings), aunts / uncles (descendants
   *  of grandparents), cousins (their offspring), great-aunts /
   *  great-cousins, etc. — anyone reached without ever crossing a
   *  spouse_of edge.
   *
   *  Crucially: the walk NEVER follows spouse_of, so people who
   *  married INTO the family (and their parents, siblings, in-laws
   *  by marriage, sibling's-spouse's-siblings, cousins'-partners'-
   *  families, etc.) are correctly excluded. Half-relatives like
   *  Sally's half-brother Graham still come out bloodline because
   *  they share ONE parent (Sylvia) with the focus's lineage —
   *  Graham's other parent (the unrelated half) is correctly NOT
   *  bloodline since it's only reachable by going up from Graham
   *  rather than down from a focus-ancestor. */
  const bloodlineSet = useMemo(() => {
    const childrenOf = new Map<number, number[]>();
    const parentsOf = new Map<number, number[]>();
    for (const e of layout.edges) {
      if (e.type !== 'parent_of') continue;
      if (!childrenOf.has(e.aId)) childrenOf.set(e.aId, []);
      childrenOf.get(e.aId)!.push(e.bId);
      if (!parentsOf.has(e.bId)) parentsOf.set(e.bId, []);
      parentsOf.get(e.bId)!.push(e.aId);
    }
    // Step 1: ancestors of focus (focus included).
    const ancestors = new Set<number>([layout.focusPersonId]);
    const upQueue: number[] = [layout.focusPersonId];
    while (upQueue.length) {
      const cur = upQueue.shift()!;
      for (const p of parentsOf.get(cur) ?? []) {
        if (ancestors.has(p)) continue;
        ancestors.add(p);
        upQueue.push(p);
      }
    }
    // Step 2: every descendant of every ancestor.
    const bloodline = new Set<number>(ancestors);
    const downQueue: number[] = Array.from(ancestors);
    while (downQueue.length) {
      const cur = downQueue.shift()!;
      for (const c of childrenOf.get(cur) ?? []) {
        if (bloodline.has(c)) continue;
        bloodline.add(c);
        downQueue.push(c);
      }
    }
    return bloodline;
  }, [layout.edges, layout.focusPersonId]);

  /** "Direct line" set — every blood relative whose visibility we
   *  consider tier-1: focus + direct ancestors + direct descendants
   *  + focus's siblings + focus's siblings' descendants. These never
   *  hide. Anyone in bloodline who isn't in here is part of a side
   *  branch (aunts/uncles, cousins, great-aunts, etc.) and is
   *  governed by the descendant chevron below.
   *
   *  Why focus's-siblings'-descendants are tier-1: nieces and
   *  nephews are immediate-feeling family — Terry showed Lilly +
   *  Daisy (his nieces) in every screenshot as part of the default
   *  view. Hiding them by default would feel hostile. */
  const directLineSet = useMemo(() => {
    const childrenOf = new Map<number, number[]>();
    const parentsOf = new Map<number, number[]>();
    for (const e of layout.edges) {
      if (e.type !== 'parent_of') continue;
      if (!childrenOf.has(e.aId)) childrenOf.set(e.aId, []);
      childrenOf.get(e.aId)!.push(e.bId);
      if (!parentsOf.has(e.bId)) parentsOf.set(e.bId, []);
      parentsOf.get(e.bId)!.push(e.aId);
    }
    const set = new Set<number>([layout.focusPersonId]);
    // Direct ancestors of focus (focus included via the seed).
    const upQueue = [layout.focusPersonId];
    while (upQueue.length) {
      const cur = upQueue.shift()!;
      for (const p of parentsOf.get(cur) ?? []) {
        if (set.has(p)) continue;
        set.add(p);
        upQueue.push(p);
      }
    }
    // Direct descendants of focus.
    const downQueue = [layout.focusPersonId];
    while (downQueue.length) {
      const cur = downQueue.shift()!;
      for (const c of childrenOf.get(cur) ?? []) {
        if (set.has(c)) continue;
        set.add(c);
        downQueue.push(c);
      }
    }
    // Focus's siblings + their descendants. Siblings = other children
    // of focus's parents. Walk down from each non-focus sibling.
    const focusParents = parentsOf.get(layout.focusPersonId) ?? [];
    const siblingDownQueue: number[] = [];
    for (const fp of focusParents) {
      for (const c of childrenOf.get(fp) ?? []) {
        if (c === layout.focusPersonId) continue;
        if (set.has(c)) continue;
        set.add(c);
        siblingDownQueue.push(c);
      }
    }
    while (siblingDownQueue.length) {
      const cur = siblingDownQueue.shift()!;
      for (const c of childrenOf.get(cur) ?? []) {
        if (set.has(c)) continue;
        set.add(c);
        siblingDownQueue.push(c);
      }
    }
    return set;
  }, [layout.edges, layout.focusPersonId]);

  /** For each side-branch head (an aunt / uncle / great-aunt / etc.
   *  — anyone in bloodline who's a sibling of a direct ancestor of
   *  focus, but isn't focus or a direct ancestor themselves), the
   *  full transitive set of their descendants. Cousins, second
   *  cousins, their kids — everyone reachable downward from the head
   *  who ISN'T already in directLineSet (so we don't accidentally
   *  hide a niece who happens to also descend from an aunt via some
   *  cross-cousin marriage).
   *
   *  These descendants are HIDDEN BY DEFAULT — the v chevron on the
   *  head's bottom edge toggles them. The head itself stays visible. */
  const sideBranchDescendantsByHead = useMemo(() => {
    const childrenOf = new Map<number, number[]>();
    const parentsOf = new Map<number, number[]>();
    for (const e of layout.edges) {
      if (e.type !== 'parent_of') continue;
      if (!childrenOf.has(e.aId)) childrenOf.set(e.aId, []);
      childrenOf.get(e.aId)!.push(e.bId);
      if (!parentsOf.has(e.bId)) parentsOf.set(e.bId, []);
      parentsOf.get(e.bId)!.push(e.aId);
    }
    // Strict ancestors of focus (NOT including focus itself).
    const strictAncestors = new Set<number>();
    const upQueue = [layout.focusPersonId];
    while (upQueue.length) {
      const cur = upQueue.shift()!;
      for (const p of parentsOf.get(cur) ?? []) {
        if (strictAncestors.has(p)) continue;
        strictAncestors.add(p);
        upQueue.push(p);
      }
    }
    // Side-branch heads = siblings of strict ancestors (children of
    // strict ancestors' parents, excluding the ancestor themselves
    // and focus).
    const heads = new Set<number>();
    for (const a of strictAncestors) {
      for (const p of parentsOf.get(a) ?? []) {
        for (const c of childrenOf.get(p) ?? []) {
          if (c === a) continue;
          if (c === layout.focusPersonId) continue;
          if (strictAncestors.has(c)) continue;
          heads.add(c);
        }
      }
    }
    // For each head, walk DOWN collecting descendants that aren't in
    // directLineSet. directLineSet exclusion guards against the rare
    // overlap (cousin marriage, half-relations) where a node could
    // reach focus via two routes.
    const m = new Map<number, Set<number>>();
    for (const head of heads) {
      const desc = new Set<number>();
      const queue = [head];
      const seen = new Set<number>([head]);
      while (queue.length) {
        const cur = queue.shift()!;
        for (const c of childrenOf.get(cur) ?? []) {
          if (seen.has(c)) continue;
          seen.add(c);
          if (directLineSet.has(c)) continue;
          desc.add(c);
          queue.push(c);
        }
      }
      if (desc.size > 0) m.set(head, desc);
    }
    return m;
  }, [layout.edges, layout.focusPersonId, directLineSet]);

  /** Person IDs ALWAYS hidden from the dimmed canvas because they
   *  belong to a side-branch (cousins + their descendants + the
   *  cousins' non-bloodline partners). Per Option B: the panel
   *  "owns" the revealed branch, the canvas stays focused on
   *  bloodline + immediate family.
   *
   *  Includes:
   *    1. Every bloodline descendant of any side-branch head
   *       (cousins of focus + their kids, etc.).
   *    2. Non-bloodline partners of those descendants — so when
   *       Ben joins his aunt's panel, his wife Karen comes with him
   *       (otherwise Karen lingers on the canvas as a stranded
   *       in-law card while her husband and kids are in the panel).
   */
  const hiddenSideBranchIds = useMemo(() => {
    const hidden = new Set<number>();
    for (const [, desc] of sideBranchDescendantsByHead) {
      for (const id of desc) hidden.add(id);
    }
    // Sweep spouse_of edges once to pull in non-bloodline partners
    // of any already-hidden side-branch descendant.
    for (const e of layout.edges) {
      if (e.type !== 'spouse_of') continue;
      if (hidden.has(e.aId) && !bloodlineSet.has(e.bId)) hidden.add(e.bId);
      if (hidden.has(e.bId) && !bloodlineSet.has(e.aId)) hidden.add(e.aId);
    }
    return hidden;
  }, [sideBranchDescendantsByHead, layout.edges, bloodlineSet]);

  /** Per-side-branch-head chevron geometry: position, leader-line
   *  endpoints, and per-parent bloodline colours. The v chevron now
   *  sits at the midpoint between the bloodline head (Carol) and
   *  her partner (Graham) when both are on canvas, so the chevron
   *  reads as "this couple's cousins line" rather than just Carol's.
   *  Two short leader lines descend from each parent's bottom edge
   *  to the chevron, each in that parent's bloodline colour
   *  (lavender for the bloodline head, orange for the in-law
   *  partner) — the same dual-colour rule applied globally so every
   *  chevron's tether is geometrically and tonally accurate.
   *  Single-partner case only here; multi-partner heads still get
   *  one chevron centred on the head (the per-partnership panel
   *  split arrives in a follow-up). */
  const sideBranchChevrons = useMemo(() => {
    type ChevronInfo = {
      headId: number;
      headX: number; headY: number;
      partnerId: number | null;
      partnerX: number | null; partnerY: number | null;
      midX: number; midY: number;
      headColour: string;
      partnerColour: string | null;
    };
    const list: ChevronInfo[] = [];
    // Build a map of each head's spouse_of partners that are placed
    // on the canvas (excluding hidden ids — partners whose card is
    // hidden don't anchor a chevron leader).
    const partnersOf = new Map<number, number[]>();
    for (const e of layout.edges) {
      if (e.type !== 'spouse_of') continue;
      if (!partnersOf.has(e.aId)) partnersOf.set(e.aId, []);
      if (!partnersOf.has(e.bId)) partnersOf.set(e.bId, []);
      partnersOf.get(e.aId)!.push(e.bId);
      partnersOf.get(e.bId)!.push(e.aId);
    }
    for (const headId of sideBranchDescendantsByHead.keys()) {
      const headNode = nodeById.get(headId);
      if (!headNode) continue;
      // Pick the partner whose card is currently visible AND who is
      // a co-parent of one of head's hideable descendants. That
      // ensures the chevron's other leader line goes to the right
      // person (the actual co-parent of the cousins, not some
      // unrelated past partner).
      const candidates = (partnersOf.get(headId) ?? [])
        .map(pid => nodeById.get(pid))
        .filter((n): n is NonNullable<typeof n> => n != null);
      let partnerNode: typeof headNode | null = null;
      for (const cand of candidates) {
        // Co-parent test: there exists a parent_of edge from cand
        // to a descendant of head.
        const desc = sideBranchDescendantsByHead.get(headId)!;
        let isCoParent = false;
        for (const e of layout.edges) {
          if (e.type !== 'parent_of') continue;
          if (e.aId !== cand.personId) continue;
          if (desc.has(e.bId) || (layout.edges.some(e2 =>
            e2.type === 'parent_of' && e2.aId === headId && e2.bId === e.bId,
          ))) {
            isCoParent = true;
            break;
          }
        }
        if (isCoParent) { partnerNode = cand; break; }
      }
      const headOnBlood = bloodlineSet.has(headId);
      const headColour = headOnBlood ? '#ad9eff' : '#f59e0b';
      const partnerColour = partnerNode
        ? (bloodlineSet.has(partnerNode.personId) ? '#ad9eff' : '#f59e0b')
        : null;
      const midX = partnerNode ? (headNode.x + partnerNode.x) / 2 : headNode.x;
      const midY = partnerNode ? (headNode.y + partnerNode.y) / 2 : headNode.y;
      list.push({
        headId,
        headX: headNode.x, headY: headNode.y,
        partnerId: partnerNode?.personId ?? null,
        partnerX: partnerNode?.x ?? null,
        partnerY: partnerNode?.y ?? null,
        midX, midY,
        headColour, partnerColour,
      });
    }
    return list;
  }, [sideBranchDescendantsByHead, layout.edges, nodeById, bloodlineSet]);

  /** Person IDs that are CURRENTLY revealed via an expanded
   *  side-branch chevron — i.e. cousins who would normally be hidden
   *  but the user clicked the aunt's v chevron. Drives the lift /
   *  drop-shadow polish on revealed cards (premium "popped out"
   *  feel without committing to actual 3D). */
  const revealedSideBranchIds = useMemo(() => {
    const set = new Set<number>();
    const expanded = expandedDescendantsOf ?? new Set<number>();
    for (const head of expanded) {
      const desc = sideBranchDescendantsByHead.get(head);
      if (!desc) continue;
      for (const id of desc) set.add(id);
    }
    return set;
  }, [sideBranchDescendantsByHead, expandedDescendantsOf]);

  /** For each non-bloodline person on canvas, the transitive set of
   *  their unique ancestors (everyone reachable upward via parent_of
   *  that ISN'T already on the focus's bloodline). Drives:
   *    1. the per-card chevron — rendered when this set is non-empty
   *       so the user has something to toggle, skipped when empty
   *       (would be a no-op click).
   *    2. the default-hidden filter — every person in any of these
   *       sets gets filtered out at render time UNLESS their owner is
   *       in expandedAncestorsOf. Keeps Lindsay's family-of-origin
   *       collapsed by default so partners marrying in don't double
   *       the canvas size. */
  const extendedAncestorsByPerson = useMemo(() => {
    const m = new Map<number, Set<number>>();
    const parentsOf = new Map<number, number[]>();
    for (const e of layout.edges) {
      if (e.type !== 'parent_of') continue;
      if (!parentsOf.has(e.bId)) parentsOf.set(e.bId, []);
      parentsOf.get(e.bId)!.push(e.aId);
    }
    for (const node of layout.nodes) {
      if (bloodlineSet.has(node.personId)) continue;
      // Walk upward, collecting only ancestors NOT in bloodline.
      // Stop ascending past a bloodline ancestor — those upper rungs
      // are shared with the focus and shouldn't get tied to this
      // chevron's collapse state.
      const extended = new Set<number>();
      const stack: number[] = [node.personId];
      const seen = new Set<number>([node.personId]);
      while (stack.length) {
        const cur = stack.pop()!;
        for (const p of parentsOf.get(cur) ?? []) {
          if (seen.has(p)) continue;
          seen.add(p);
          if (bloodlineSet.has(p)) continue;
          extended.add(p);
          stack.push(p);
        }
      }
      if (extended.size > 0) m.set(node.personId, extended);
    }
    return m;
  }, [layout.nodes, layout.edges, bloodlineSet]);

  /** Person IDs to FILTER OUT of the rendered tree. Computed from
   *  extendedAncestorsByPerson minus anyone unhidden by an expanded
   *  chevron — ref-counted so two non-bloodline people who share an
   *  ancestor (e.g. two sisters-in-law from the same family) only
   *  hide it when BOTH are collapsed. */
  const hiddenExtendedIds = useMemo(() => {
    // Step 5 of TREES_PANEL_DESIGN.md: extended ancestors (in-law
    // family-of-origin) are now ALWAYS hidden from the dimmed
    // canvas. When a chevron is expanded, those people render in
    // the tethered panel instead. Same Option B principle as the
    // side-branch descendants above — the panel owns the revealed
    // branch, the canvas stays focused on bloodline + immediate
    // family.
    const hidden = new Set<number>();
    for (const [, extended] of extendedAncestorsByPerson) {
      for (const id of extended) hidden.add(id);
    }
    return hidden;
  }, [extendedAncestorsByPerson]);

  /** Relationship label for each person relative to the current
   *  focus — "Parent", "Sibling", "Grandchild", etc. Gendered when the
   *  tree has gendered labels enabled AND the target has a gender
   *  set. Computed client-side so it follows refocus without a
   *  refetch. */
  const relationshipLabels = useMemo(() => {
    const genderByPerson = new Map<number, string | null>();
    for (const n of layout.nodes) genderByPerson.set(n.personId, n.gender);
    return computeRelationshipLabels(
      layout.focusPersonId,
      layout.edges,
      layout.nodes.map(n => n.personId),
      genderByPerson,
      useGenderedLabels,
      simplifyHalfLabels,
    );
  }, [layout.focusPersonId, layout.edges, layout.nodes, useGenderedLabels, simplifyHalfLabels]);

  /** Person whose gender the user is currently editing. null = modal
   *  closed. The picker commits via setPersonGenderApi which logs
   *  history; on success we onGraphMutated() to refetch. */
  const [genderPickerFor, setGenderPickerFor] = useState<number | null>(null);

  /**
   * Group parent_of edges into "families": a shared parent-set maps to
   * a list of children with that exact set of parents. Rendering a
   * whole family as ONE marriage-bar-plus-bracket structure is what
   * makes pedigree diagrams readable — instead of drawing each edge
   * as an individual Z that overlaps every other Z at the same mid-Y.
   *
   * Key is the sorted parent IDs, joined with commas.
   */
  const familyGroups = useMemo(() => {
    const parentsByChild = new Map<number, number[]>();
    for (const e of layout.edges) {
      if (e.type !== 'parent_of') continue;
      if (!nodeById.has(e.aId) || !nodeById.has(e.bId)) continue;
      if (!parentsByChild.has(e.bId)) parentsByChild.set(e.bId, []);
      parentsByChild.get(e.bId)!.push(e.aId);
    }
    const groups = new Map<string, { parentIds: number[]; childIds: number[] }>();
    for (const [childId, parentIds] of parentsByChild) {
      const sorted = [...parentIds].sort((a, b) => a - b);
      const key = sorted.join(',');
      if (!groups.has(key)) groups.set(key, { parentIds: sorted, childIds: [] });
      groups.get(key)!.childIds.push(childId);
    }
    return Array.from(groups.values());
  }, [layout.edges, nodeById]);

  return (
    <div className="absolute inset-0 select-none">
      {canvasBackground && (
        <div
          className="absolute inset-0 pointer-events-none"
          aria-hidden="true"
          style={{
            backgroundImage: `url("${canvasBackground}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            opacity: Math.max(0, Math.min(1, canvasBackgroundOpacity)),
          }}
        />
      )}
      {(() => {
        // Step 2 of the floating-panel plan (TREES_PANEL_DESIGN.md):
        // when ANY chevron has been expanded, the base canvas dims so
        // the eventual panel layer reads as elevated above the rest
        // of the tree. Originally spec'd at 35% but bumped to 55%
        // after Terry tested it — at 35% the tree was unreadable.
        // 55% feels recessed without losing legibility. The doc has
        // been updated to match.
        // Computed inside the SVG block so future panel rendering
        // can read the same value off props.
        const anyPanelOpen =
          (expandedAncestorsOf?.size ?? 0) + (expandedDescendantsOf?.size ?? 0) > 0;
        return (
          <svg
            ref={svgRef}
            data-tree-canvas="true"
            className={`w-full h-full cursor-grab active:cursor-grabbing ${canvasBackground ? '' : 'bg-[radial-gradient(circle,_rgba(167,139,250,0.06)_1px,_transparent_1px)] [background-size:24px_24px]'}`}
            onWheel={handleWheel}
            onMouseDown={handlePanStart}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          >
            <g
              transform={`translate(${viewport.tx} ${viewport.ty}) scale(${viewport.scale})`}
              opacity={anyPanelOpen ? 0.55 : 1}
              style={{ transition: 'opacity 220ms ease-out' }}
            >
          {/* Pedigree family groups — one marriage bar + sibling bracket
              per parent-set. Drawn BEFORE individual edges so they sit
              underneath the nodes. */}
          {familyGroups.map((group, i) => {
            // Skip families where the parent-side OR child-side has
            // nothing visible to anchor against:
            //  • All parents hidden — children may still render via
            //    a different family group; we just don't draw the
            //    marriage bar / sibling bracket from hidden parents.
            //  • All children hidden — the marriage bar can stay
            //    (parents are visible) but there's no descendant
            //    bracket to draw, so the family-group's drop line +
            //    horizontal bracket would otherwise dangle into
            //    empty canvas. This was the "lines going to no
            //    one" Terry flagged when Carol + Graham's cousins
            //    moved into the panel.
            const allParentsHidden = group.parentIds.every(id =>
              hiddenExtendedIds.has(id) || hiddenSideBranchIds.has(id),
            );
            if (allParentsHidden) return null;
            const allChildrenHidden = group.childIds.every(id =>
              hiddenExtendedIds.has(id) || hiddenSideBranchIds.has(id),
            );
            if (allChildrenHidden) return null;
            // Are the parents married (stored spouse_of between any of
            // them)? If yes, EdgeLine draws the partnership connector —
            // we skip our own marriage bar to avoid duplicate overlap.
            const hasStoredSpouse = layout.edges.some(e =>
              e.type === 'spouse_of' && !e.derived
              && group.parentIds.includes(e.aId) && group.parentIds.includes(e.bId)
            );
            // Bloodline-aware tinting: a family group counts as
            // bloodline if at least one child is in bloodlineSet.
            // Visible canvas content is bloodline-only after the
            // panel UX moved cousins / in-laws into panels, so this
            // effectively turns every visible canvas family into
            // lavender — bloodline lines instead of grey scaffolding.
            const isFamilyBloodline = group.childIds.some(id => bloodlineSet.has(id));
            return (
              <FamilyGroup
                key={`fam-${i}-${group.parentIds.join('_')}`}
                parents={group.parentIds.map(id => nodeById.get(id)!).filter(Boolean)}
                children={group.childIds.map(id => nodeById.get(id)!).filter(Boolean)}
                parentsAreSpouses={hasStoredSpouse}
                // Stagger the bracket Y so different families don't share
                // the same horizontal line. Deterministic per-group offset.
                bracketOffset={i * 8}
                contrast={treeContrast}
                strokeOverride={isFamilyBloodline ? '#ad9eff' : undefined}
                onParentClick={(parentId) => {
                  const parent = nodeById.get(parentId);
                  if (!parent) return;
                  if (parent.isPlaceholder) {
                    const rect = svgRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    const screenX = viewport.tx + parent.renderedX * viewport.scale;
                    const screenY = viewport.ty + parent.renderedY * viewport.scale;
                    // Virtual ghost: defer materialisation; persisted
                    // placeholder: edit the existing row.
                    if (parentId < 0) {
                      const childIds = layout.edges
                        .filter(ed => ed.aId === parentId && ed.type === 'parent_of')
                        .map(ed => ed.bId);
                      if (childIds.length === 0) return;
                      setPlaceholderEditor({ kind: 'virtual', virtualChildIds: childIds, x: screenX, y: screenY });
                    } else {
                      setPlaceholderEditor({ kind: 'persisted', personId: parentId, x: screenX, y: screenY });
                    }
                  }
                }}
              />
            );
          })}

          {/* Non-parent edges (spouse_of, sibling_of, associated_with) — parent_of is now rendered as family groups above. */}
          {layout.edges.map((edge, idx) => {
            if (!edge.visible) return null;
            if (edge.type === 'parent_of') return null;
            // Skip any edge whose endpoint has been collapsed-hidden by
            // EITHER an inactive non-bloodline chevron (in-laws) OR an
            // inactive side-branch chevron (cousins). Otherwise we'd
            // draw a partnership / sibling line into thin air.
            if (hiddenExtendedIds.has(edge.aId) || hiddenExtendedIds.has(edge.bId)) return null;
            if (hiddenSideBranchIds.has(edge.aId) || hiddenSideBranchIds.has(edge.bId)) return null;
            // Derived sibling_of edges are redundant when the shared
            // parent is already on-screen — the Alan-Sally bracket
            // above their children already says "these four are
            // siblings". Drawing a dotted line across intermediate
            // cards (a partner's wife, a cousin, …) is more noise
            // than information. We only keep the derived line when the
            // shared parent is NOT visible — rare case where you want
            // a visible cue that two same-gen cards are linked.
            if (edge.type === 'sibling_of' && edge.derived) {
              let anySharedParentVisible = false;
              for (const pe of layout.edges) {
                if (pe.type !== 'parent_of') continue;
                const isAChildOfPE = pe.bId === edge.aId;
                const isBChildOfPE = pe.bId === edge.bId;
                if (!isAChildOfPE && !isBChildOfPE) continue;
                // Find matching parent_of for the OTHER sibling.
                const otherChildId = isAChildOfPE ? edge.bId : edge.aId;
                for (const pe2 of layout.edges) {
                  if (pe2.type !== 'parent_of') continue;
                  if (pe2.aId !== pe.aId) continue;
                  if (pe2.bId !== otherChildId) continue;
                  if (nodeById.has(pe.aId)) { anySharedParentVisible = true; break; }
                }
                if (anySharedParentVisible) break;
              }
              if (anySharedParentVisible) return null;
            }
            const a = nodeById.get(edge.aId);
            const b = nodeById.get(edge.bId);
            if (!a || !b) return null;
            const hopA = a.hopsFromFocus;
            const hopB = b.hopsFromFocus;
            const maxHop = Math.max(hopA, hopB);
            const opacity = Math.max(0.15, 1 - maxHop * 0.15);
            // Stored (non-derived) edges are clickable → inline editor.
            // EXCEPTION: if either endpoint is a placeholder ghost, clicking
            // anywhere along the line is ambiguous (is it Terry's parent edge?
            // Colin's parent edge?), so we route to the placeholder resolver
            // where you can name or link the ghost instead.
            const onClick = edge.derived || edge.id == null ? undefined : (ev: React.MouseEvent) => {
              ev.stopPropagation();
              const rect = svgRef.current?.getBoundingClientRect();
              if (!rect) return;
              const ghostNode = a.isPlaceholder ? a : (b.isPlaceholder ? b : null);
              if (ghostNode) {
                const screenX = viewport.tx + ghostNode.renderedX * viewport.scale;
                const screenY = viewport.ty + ghostNode.renderedY * viewport.scale;
                if (ghostNode.personId < 0) {
                  // Virtual ghost on this edge — collect EVERY child the
                  // ghost parents, not just the one at the other end of
                  // this specific edge. A shared ghost represents a
                  // shared missing parent, so filling it must complete
                  // the entire sibling group, not just one sibling.
                  const childIds = layout.edges
                    .filter(ed => ed.aId === ghostNode.personId && ed.type === 'parent_of')
                    .map(ed => ed.bId);
                  if (childIds.length === 0) return;
                  setPlaceholderEditor({ kind: 'virtual', virtualChildIds: childIds, x: screenX, y: screenY });
                } else {
                  setPlaceholderEditor({ kind: 'persisted', personId: ghostNode.personId, x: screenX, y: screenY });
                }
                setEdgeEditor(null);
                setContextMenu(null);
                return;
              }
              // World midpoint → screen coord via current viewport transform.
              const midWorldX = (a.renderedX + b.renderedX) / 2;
              const midWorldY = (a.renderedY + b.renderedY) / 2;
              const screenX = viewport.tx + midWorldX * viewport.scale;
              const screenY = viewport.ty + midWorldY * viewport.scale;
              setEdgeEditor({ edge: edge as FamilyGraphEdge, x: screenX, y: screenY });
              setContextMenu(null);
            };
            return (
              <EdgeLine
                key={`${edge.type}-${edge.aId}-${edge.bId}-${idx}`}
                ax={a.renderedX}
                ay={a.renderedY}
                bx={b.renderedX}
                by={b.renderedY}
                type={edge.type}
                until={edge.until}
                opacity={opacity}
                derived={edge.derived}
                flags={edge.flags as { half?: boolean; adopted?: boolean } | null}
                onClick={onClick}
                contrast={treeContrast}
              />
            );
          })}

          {/* Nodes */}
          {placedNodes.map(node => {
            // Hidden by either filter — collapsed extended-family
            // ancestor (in-law lineage) or collapsed side-branch
            // descendant (cousin / second cousin). Skip the card and
            // any placeholder ghost variant so collapsed branches
            // stay genuinely off the canvas.
            if (hiddenExtendedIds.has(node.personId)) return null;
            if (hiddenSideBranchIds.has(node.personId)) return null;
            const avatar = avatars.get(node.personId);
            const isFocus = node.personId === layout.focusPersonId;
            const dimOpacity = Math.max(0.5, 1 - node.hopsFromFocus * 0.1);
            if (node.isPlaceholder) {
              // Bloodline status of a ghost is INHERITED from any child
              // it parents. If at least one child is bloodline, the
              // ghost itself is a bloodline ancestor (paint purple);
              // otherwise it sits above an in-law and paints orange.
              // Walking layout.edges once per ghost is fine — there are
              // typically only a handful of ghosts on canvas.
              let ghostIsOnBloodline = false;
              for (const e of layout.edges) {
                if (e.type !== 'parent_of') continue;
                if (e.aId !== node.personId) continue;
                if (bloodlineSet.has(e.bId)) {
                  ghostIsOnBloodline = true;
                  break;
                }
              }
              return (
                <PlaceholderNode
                  key={node.personId}
                  node={node}
                  opacity={dimOpacity}
                  onClick={(e) => handleNodeClick(e, node)}
                  onMouseDown={(e) => handleNodeMouseDown(e, node)}
                  isOnBloodline={ghostIsOnBloodline}
                />
              );
            }
            return (
              <PersonNode
                key={node.personId}
                node={node}
                avatar={avatar}
                isFocus={isFocus}
                opacity={dimOpacity}
                hideChips={hideQuickAddChips}
                showDates={showDates}
                onEditDates={onEditDates ? (clientX, clientY) => onEditDates(node.personId, clientX, clientY) : undefined}
                onEditName={onEditName ? (clientX, clientY) => onEditName(node.personId, clientX, clientY) : undefined}
                onMouseDown={(e) => handleNodeMouseDown(e, node)}
                onDoubleClick={(e) => handleNodeDoubleClick(e, node)}
                onContextMenu={(e) => handleNodeContextMenu(e, node)}
                onQuickAddParent={() => onQuickAddParent(node.personId)}
                onQuickAddPartner={() => onQuickAddPartner(node.personId)}
                onQuickAddChild={() => onQuickAddChild(node.personId)}
                onQuickAddSibling={() => onQuickAddSibling(node.personId)}
                contrast={treeContrast}
                relationshipLabel={relationshipLabels.get(node.personId) ?? null}
                hideGenderMarker={hideGenderMarker}
                onOpenGenderPicker={() => setGenderPickerFor(node.personId)}
                canAddParent={true}
                hasCurrentPartner={(currentPartnerCount.get(node.personId) ?? 0) > 0}
                hasOutOfScopeAncestors={
                  // Two cases trigger the ^ chevron:
                  //   1. Non-bloodline person with hideable extended
                  //      ancestry — chevron always paints so the user
                  //      can reveal their family-of-origin on demand
                  //      (default state: hidden).
                  //   2. Bloodline person whose DB-recorded ancestor
                  //      count exceeds what's currently visible — the
                  //      old "out-of-scope" capacity case.
                  extendedAncestorsByPerson.has(node.personId)
                  || node.totalParentCount > (visibleParentChildCounts.parentCount.get(node.personId) ?? 0)
                }
                // Side-branch chevron is no longer rendered inside
                // the per-card SVG — it's drawn at the canvas level
                // (see sideBranchChevrons memo + canvas chevron
                // layer below) so the chevron can sit at the
                // midpoint between BOTH parents of the cousin
                // branch (Carol + Graham), with dual-coloured
                // leader lines from each parent. Anchoring it to
                // a single card no longer made geometric sense
                // once we acknowledged the cousins descend from
                // the couple, not from one parent alone.
                hasHideableDescendants={false}
                isOnBloodline={bloodlineSet.has(node.personId)}
                onExpandAncestors={onExpandAncestors ? () => onExpandAncestors(node.personId) : undefined}
                onExpandDescendants={onExpandDescendants ? () => onExpandDescendants(node.personId) : undefined}
                ancestorsExpanded={expandedAncestorsOf?.has(node.personId) ?? false}
                descendantsExpanded={expandedDescendantsOf?.has(node.personId) ?? false}
                // Lift styling for cards revealed via someone else's
                // side-branch chevron — the "popped out" feel without
                // committing to real 3D. Drop-shadow + slight scale
                // applied inside PersonNode.
                lifted={revealedSideBranchIds.has(node.personId)}
                // Branded card outline by bloodline status: lavender
                // for blood relatives, brand orange for in-laws who
                // married in (Alan, Lindsay, Karen, Dan, etc.). The
                // focus halo (amber) still wins on the focus card —
                // PersonNode honours isFocus over borderOverride.
                borderOverride={bloodlineSet.has(node.personId) ? '#ad9eff' : '#f59e0b'}
              />
            );
          })}

        {/* Side-branch chevrons — drawn at the canvas level (not
            inside per-card PersonNode SVGs) so each chevron can sit
            at the midpoint between BOTH parents of the cousin
            branch (e.g. between Carol and Graham), with two short
            leader lines from each parent's bottom edge to the
            chevron in that parent's bloodline colour. Lavender
            from the bloodline head (Carol), orange from the in-law
            partner (Graham) — geometrically and tonally accurate
            so the chevron reads as "this couple's cousins line"
            rather than just one person's.

            CRITICAL: this <g> sits INSIDE the outer transform
            group (translate + scale) so its coordinates are in
            WORLD space, the same as the cards above. Outside that
            wrapper, the chevrons render at raw SVG coords, which
            puts them way off-screen at any non-trivial pan/zoom. */}
        <g>
          {sideBranchChevrons.map(info => {
            if (hiddenSideBranchIds.has(info.headId)) return null;
            if (info.partnerId != null && hiddenSideBranchIds.has(info.partnerId)) return null;
            if (hiddenExtendedIds.has(info.headId)) return null;
            const r = 17;
            const stemLen = 24;
            const cardBottomY = info.headY + CARD_H / 2;
            const chevronCy = cardBottomY + stemLen + r;
            const chevronCx = info.midX;
            const expanded = expandedDescendantsOf?.has(info.headId) ?? false;
            const fill = '#ad9eff';
            const rim = '#7e6df0';
            const label = expanded
              ? 'Hide cousins on this branch'
              : 'Show cousins on this branch';
            const glyphPath = expanded
              ? 'M -7 2 L 0 -5 L 7 2'
              : 'M -7 -2 L 0 5 L 7 -2';
            return (
              <g key={`sbc-${info.headId}`}>
                {/* Head's leader line — from head's card bottom
                    edge down/across to the chevron, in the head's
                    bloodline colour. */}
                <line
                  x1={info.headX}
                  y1={cardBottomY}
                  x2={chevronCx}
                  y2={chevronCy - r}
                  stroke={info.headColour}
                  strokeWidth={2}
                  strokeLinecap="round"
                  style={{ pointerEvents: 'none' }}
                />
                {/* Partner's leader line — only when a partner is
                    on canvas and is the actual co-parent of the
                    cousins. Coloured by the partner's bloodline
                    status (typically orange — they're the in-law
                    married into the family). */}
                {info.partnerId != null && info.partnerX != null && info.partnerColour && (
                  <line
                    x1={info.partnerX}
                    y1={info.partnerY != null ? info.partnerY + CARD_H / 2 : cardBottomY}
                    x2={chevronCx}
                    y2={chevronCy - r}
                    stroke={info.partnerColour}
                    strokeWidth={2}
                    strokeLinecap="round"
                    style={{ pointerEvents: 'none' }}
                  />
                )}
                <g
                  transform={`translate(${chevronCx} ${chevronCy})`}
                  style={{ cursor: 'pointer' }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onExpandDescendants?.(info.headId); }}
                >
                  <IconTooltip label={label} side="bottom">
                    <g>
                      <ellipse
                        cx={0} cy={3}
                        rx={r * 0.92} ry={r * 0.55}
                        fill="rgba(0,0,0,0.22)"
                        style={{ pointerEvents: 'none' }}
                      />
                      <circle r={r} cx={0} cy={1.5} fill={rim} style={{ pointerEvents: 'none' }} />
                      <circle r={r} fill={fill} stroke="none" />
                      <path
                        d={`M ${-r * 0.7} ${-r * 0.35} A ${r * 0.85} ${r * 0.85} 0 0 1 ${r * 0.7} ${-r * 0.35}`}
                        stroke="rgba(255,255,255,0.45)"
                        strokeWidth={1.5}
                        fill="none"
                        strokeLinecap="round"
                        style={{ pointerEvents: 'none' }}
                      />
                      <path
                        d={glyphPath}
                        stroke="#ffffff"
                        strokeWidth={3}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ pointerEvents: 'none' }}
                      />
                    </g>
                  </IconTooltip>
                </g>
              </g>
            );
          })}
        </g>
        </g>

        {/* Fixed overlay: zoom indicator */}
        <g>
          <rect x={12} y={12} rx={6} ry={6} width={56} height={22} fill="rgba(0,0,0,0.45)" />
          <text x={40} y={27} textAnchor="middle" fontSize={12} fill="#fff">
            {Math.round(viewport.scale * 100)}%
          </text>
        </g>
      </svg>
        );
      })()}

      {/* ── Step 3 + Step 4 of TREES_PANEL_DESIGN.md.
          Step 3: floating panel near each currently-expanded chevron.
          Step 4: Bezier tether line from each chevron to its panel,
          drawn in a separate SVG layer that sits above the dimmed
          base canvas but below the panel HTML divs (z-index 25 vs
          panels' 30). The tether colour matches the chevron-button:
          lavender for bloodline-cousin chevrons, brand orange for
          in-law chevrons. Bezier control points are pulled along
          the direction of travel so the curve flexes naturally as
          the panel moves (drag arrives in step 6). */}
      {(() => {
        type PanelOrigin = { personId: number; direction: 'ancestor' | 'descendant' };
        const origins: PanelOrigin[] = [];
        for (const pid of expandedAncestorsOf ?? new Set<number>()) {
          origins.push({ personId: pid, direction: 'ancestor' });
        }
        for (const pid of expandedDescendantsOf ?? new Set<number>()) {
          origins.push({ personId: pid, direction: 'descendant' });
        }
        if (origins.length === 0) return null;

        const VERTICAL_GAP = 80;
        // Chevron-button geometry inside PersonNode — kept here so
        // tether origin points line up exactly with where the
        // chevron-circle sits on screen.
        const CHEVRON_STEM = 24;
        const CHEVRON_R = 17;
        // Panel size is AUTO-COMPUTED per panel from its mini-tree
        // content, scaled by viewport.scale so panel cards visually
        // match canvas cards. The abbreviated mode (zoomed-out)
        // collapses the header to a single "Surname branch" line,
        // so HEADER_H and MIN_PANEL_H shrink in lockstep — keeps
        // the panel from being mostly whitespace at low zoom.
        // MAX bumped to 1200x800 so most branches open at full
        // content size without forcing internal scroll.
        const isAbbreviated = viewport.scale < 0.5;
        const HEADER_H = isAbbreviated ? 56 : 130;
        const PANEL_PADDING = 24;
        const MINI_CARD_GAP_X = 30;
        const MINI_ROW_GAP_Y = 60;
        const MIN_PANEL_W = isAbbreviated ? 140 : 280;
        const MIN_PANEL_H = isAbbreviated ? 100 : 220;
        const MAX_PANEL_W = 1200;
        const MAX_PANEL_H = 800;

        type MiniPlacement = {
          personId: number;
          /** Centre coordinates of the card inside the panel SVG. */
          cx: number;
          cy: number;
          node: LaidOutNode & { renderedX: number; renderedY: number };
        };
        type StepLine = { key: string; d: string };

        type Layout = {
          personId: number;
          direction: 'ancestor' | 'descendant';
          panelKey: string;
          personName: string;
          directionLabel: string;
          /** Person IDs to render INSIDE the panel. */
          contentPeople: number[];
          /** Single-word surname representing this branch — used
           *  for the abbreviated header at low zoom ("McCall branch"
           *  / "Rouse branch"). For descendants: the head's surname
           *  (Carol Rouse → Rouse). For ancestors: the topmost
           *  ancestor's surname (Lindsay's parent Keith McCall →
           *  McCall). */
          branchSurname: string;
          /** Per-card placements inside the panel SVG (centre coords). */
          miniPlacements: MiniPlacement[];
          /** Family groups inside the panel — used to render the
           *  marriage-bar + drop + sibling-bracket geometry that
           *  matches the canvas exactly (via FamilyGroup component). */
          panelFamilyGroups: { parentIds: number[]; childIds: number[] }[];
          /** Spouse_of edges between panel content people — rendered
           *  as EdgeLine partnership lines so the marriage bar is
           *  visible alongside FamilyGroup's brackets. */
          panelSpouseEdges: LaidOutEdge[];
          /** Direct bloodline kin of the origin that live INSIDE the
           *  panel — used by the tether-continuation drop-line to
           *  bracket them as if the canvas tether were a real
           *  family-tree line crossing the panel boundary.
           *    descendant — origin's direct children (e.g. Carol →
           *      Ben + Jenny). Karen / Dan (Ben + Jenny's spouses)
           *      are intentionally excluded — they're not Carol's
           *      direct children, only her children's partners.
           *    ancestor   — origin's direct parents (e.g. Lindsay →
           *      Keith + her mother). */
          directKinIds: number[];
          /** SVG content size (panel sizes itself around this + header + padding). */
          contentWidth: number;
          contentHeight: number;
          /** Top / bottom padding inside the SVG. The chevron-facing
           *  side gets an extra MINI_ROW_GAP_Y/2 of "bracket room" so
           *  the tether-continuation bracket can sit at the same
           *  spacing the canvas uses for family-group brackets. */
          padTop: number;
          padBottom: number;
          bracketRoom: number;
          /** Auto-computed panel size (clamped to MIN/MAX). */
          panelW: number;
          panelH: number;
          // Default (auto-computed) panel position before drag offset.
          defaultPanelLeft: number;
          defaultPanelTop: number;
          // Final panel position after applying any drag offset.
          panelLeft: number;
          panelTop: number;
          // Constraint bounds on the offset (used by drag-start).
          minOffsetX: number;
          maxOffsetX: number;
          minOffsetY: number;
          maxOffsetY: number;
          chevronScreenX: number;
          chevronScreenY: number;
          panelAnchorX: number;
          panelAnchorY: number;
          tetherColour: string;
        };
        const layouts: Layout[] = [];
        for (const { personId, direction } of origins) {
          const origin = placedNodes.find(n => n.personId === personId);
          if (!origin) continue;
          const originScreenX = viewport.tx + origin.renderedX * viewport.scale;
          const originScreenY = viewport.ty + origin.renderedY * viewport.scale;
          const cardHalfHeight = (CARD_H / 2) * viewport.scale;
          const chevronOffset = (CARD_H / 2 + CHEVRON_STEM + CHEVRON_R) * viewport.scale;
          // Descendant chevrons live at the MIDPOINT between the
          // bloodline head and their co-parent (when both are on
          // canvas), so the panel tether starts from the same
          // spot. Ancestor chevrons stay anchored to the in-law's
          // single card. Falls back to origin's X if no co-parent
          // is currently on canvas.
          const chevInfo = direction === 'descendant'
            ? sideBranchChevrons.find(c => c.headId === personId)
            : null;
          const chevronWorldX = chevInfo ? chevInfo.midX : origin.renderedX;
          const chevronScreenX = viewport.tx + chevronWorldX * viewport.scale;
          const chevronScreenY = direction === 'descendant'
            ? originScreenY + chevronOffset
            : originScreenY - chevronOffset;
          // Compute the panel's content set FIRST — needed before
          // the mini-tree layout so we know who to lay out.
          //  • Descendant chevron — bloodline descendants of the
          //    head + their non-bloodline partners.
          //  • Ancestor chevron — the non-bloodline person's
          //    family-of-origin ancestors.
          const contentSet = new Set<number>();
          if (direction === 'descendant') {
            const desc = sideBranchDescendantsByHead.get(personId);
            if (desc) for (const id of desc) contentSet.add(id);
            for (const e of layout.edges) {
              if (e.type !== 'spouse_of') continue;
              if (contentSet.has(e.aId) && !bloodlineSet.has(e.bId)) contentSet.add(e.bId);
              if (contentSet.has(e.bId) && !bloodlineSet.has(e.aId)) contentSet.add(e.aId);
            }
          } else {
            const ext = extendedAncestorsByPerson.get(personId);
            if (ext) for (const id of ext) contentSet.add(id);
          }
          const contentPeople = Array.from(contentSet)
            .map(id => ({ id, x: nodeById.get(id)?.x ?? 0 }))
            .sort((a, b) => a.x - b.x)
            .map(o => o.id);

          // Compute the mini-tree layout for this panel's content —
          // we use its size to auto-size the panel itself. The
          // mini-tree uses full canvas-card dimensions (CARD_W /
          // CARD_H) so each person inside the panel looks identical
          // to a person on the main canvas.
          const peopleInPanel = contentPeople
            .map(id => placedNodes.find(n => n.personId === id))
            .filter((n): n is (LaidOutNode & { renderedX: number; renderedY: number }) => n != null);
          const byGen = new Map<number, typeof peopleInPanel>();
          for (const p of peopleInPanel) {
            if (!byGen.has(p.generation)) byGen.set(p.generation, []);
            byGen.get(p.generation)!.push(p);
          }
          for (const g of byGen.keys()) byGen.get(g)!.sort((a, b) => a.x - b.x);
          const sortedGens = Array.from(byGen.keys()).sort((a, b) => b - a);
          let maxRowWidth = 0;
          for (const g of sortedGens) {
            const row = byGen.get(g)!;
            const rowW = row.length * CARD_W + (row.length - 1) * MINI_CARD_GAP_X;
            if (rowW > maxRowWidth) maxRowWidth = rowW;
          }
          const contentWidth = Math.max(CARD_W, maxRowWidth) + PANEL_PADDING * 2;
          // Extra padding on the chevron-facing side of the SVG so the
          // tether-continuation bracket has room to sit MINI_ROW_GAP_Y/2
          // away from the cards — same spacing the canvas uses for its
          // family-group brackets, so panel scaffolding visually matches.
          const TETHER_BRACKET_ROOM = MINI_ROW_GAP_Y / 2;
          const padTop = direction === 'descendant' ? PANEL_PADDING + TETHER_BRACKET_ROOM : PANEL_PADDING;
          const padBottom = direction === 'ancestor' ? PANEL_PADDING + TETHER_BRACKET_ROOM : PANEL_PADDING;
          const contentHeight = sortedGens.length === 0
            ? CARD_H
            : sortedGens.length * CARD_H
              + (sortedGens.length - 1) * MINI_ROW_GAP_Y
              + padTop + padBottom;
          const miniPlacements: MiniPlacement[] = [];
          sortedGens.forEach((g, rowIdx) => {
            const row = byGen.get(g)!;
            const rowW = row.length * CARD_W + (row.length - 1) * MINI_CARD_GAP_X;
            const startCx = (contentWidth - rowW) / 2 + CARD_W / 2;
            row.forEach((node, i) => {
              miniPlacements.push({
                personId: node.personId,
                cx: startCx + i * (CARD_W + MINI_CARD_GAP_X),
                cy: padTop + rowIdx * (CARD_H + MINI_ROW_GAP_Y) + CARD_H / 2,
                node,
              });
            });
          });
          const placedById = new Map<number, MiniPlacement>(miniPlacements.map(p => [p.personId, p]));
          // Build family groups inside the panel so we can use the
          // canvas's FamilyGroup component (marriage-bar + drop +
          // sibling bracket geometry) instead of custom step-lines.
          // Same algorithm as the canvas's familyGroups memo.
          const panelParentsByChild = new Map<number, number[]>();
          for (const e of layout.edges) {
            if (e.type !== 'parent_of') continue;
            if (!placedById.has(e.aId) || !placedById.has(e.bId)) continue;
            if (!panelParentsByChild.has(e.bId)) panelParentsByChild.set(e.bId, []);
            panelParentsByChild.get(e.bId)!.push(e.aId);
          }
          type PanelFamilyGroup = { parentIds: number[]; childIds: number[] };
          const panelFamilyGroupsMap = new Map<string, PanelFamilyGroup>();
          for (const [childId, parentIds] of panelParentsByChild) {
            const sorted = [...parentIds].sort((a, b) => a - b);
            const key = sorted.join(',');
            if (!panelFamilyGroupsMap.has(key)) panelFamilyGroupsMap.set(key, { parentIds: sorted, childIds: [] });
            panelFamilyGroupsMap.get(key)!.childIds.push(childId);
          }
          const panelFamilyGroups = Array.from(panelFamilyGroupsMap.values());
          // Spouse-of edges between people in the panel — used to
          // decide which family groups have stored partnership lines
          // (so FamilyGroup skips its dashed bar) and to render
          // partnership EdgeLines below.
          const panelSpouseEdges: typeof layout.edges = [];
          for (const e of layout.edges) {
            if (e.type !== 'spouse_of') continue;
            if (!placedById.has(e.aId) || !placedById.has(e.bId)) continue;
            panelSpouseEdges.push(e);
          }
          // Direct kin of the origin that live INSIDE the panel.
          //  descendant: parent_of edges where origin is the parent →
          //    origin's direct bloodline children. Excludes spouses
          //    (those come in via spouse_of, not parent_of).
          //  ancestor: parent_of edges where origin is the child →
          //    origin's direct parents.
          // The tether-continuation drop-line brackets these so the
          // canvas tether reads as a real family-tree line crossing
          // the panel boundary.
          const directKinSeen = new Set<number>();
          const directKinIds: number[] = [];
          for (const e of layout.edges) {
            if (e.type !== 'parent_of') continue;
            let kinId: number | null = null;
            if (direction === 'descendant' && e.aId === personId) kinId = e.bId;
            else if (direction === 'ancestor' && e.bId === personId) kinId = e.aId;
            if (kinId == null) continue;
            if (!placedById.has(kinId)) continue;
            if (directKinSeen.has(kinId)) continue;
            directKinSeen.add(kinId);
            directKinIds.push(kinId);
          }
          // Auto-size the panel from content — clamp between MIN and
          // MAX so it stays draggable. Content dimensions are
          // multiplied by viewport.scale so the panel cards visually
          // match the canvas cards at the current zoom. We add 2 px
          // panel border on each side (4 px total) to the size so
          // the SVG content fits inside the border without forcing
          // a scrollbar — Terry flagged sloppy scrollbars when
          // content already fitted.
          const PANEL_BORDER = 2;
          const scaledContentW = contentWidth * viewport.scale;
          const scaledContentH = contentHeight * viewport.scale;
          const panelW = Math.max(MIN_PANEL_W, Math.min(MAX_PANEL_W, scaledContentW + PANEL_BORDER * 2));
          const panelH = Math.max(MIN_PANEL_H, Math.min(MAX_PANEL_H, HEADER_H + scaledContentH + PANEL_BORDER * 2));
          const defaultPanelLeft = originScreenX - panelW / 2;
          const defaultPanelTop = direction === 'descendant'
            ? originScreenY + cardHalfHeight + VERTICAL_GAP
            : originScreenY - cardHalfHeight - VERTICAL_GAP - panelH;
          // Drag offset (set by drag handlers, persisted in
          // panelOffsets state for position memory within session).
          const panelKey = `${personId}-${direction}`;
          const offset = panelOffsets.get(panelKey) ?? { x: 0, y: 0 };
          // Constraint bounds on the offset (per design doc §3.1,
          // tuned after Terry's drag test):
          //  • Vertical: descendant panel top must be ≥ origin row's
          //    bottom + small gap (10 px tolerance); ancestor panel
          //    bottom ≤ origin row's top - small gap.
          //  • Horizontal: panel centre within ±3 × PANEL_W of
          //    origin's X. Initial ±1.5 × value was too tight —
          //    Terry was forced to overlap the tree to find a
          //    parking spot. ±3 gives ~2 panel widths of drift in
          //    each direction, enough to dodge the tree without
          //    the tether becoming absurd.
          const minOffsetX = -panelW * 3;
          const maxOffsetX = panelW * 3;
          let minOffsetY: number;
          let maxOffsetY: number;
          if (direction === 'descendant') {
            // Panel-top must remain ≥ origin's row-bottom (with a
            // 10 px upward tolerance for fine positioning, no further).
            const minPanelTop = originScreenY + cardHalfHeight - 10;
            minOffsetY = minPanelTop - defaultPanelTop;
            maxOffsetY = 4 * panelH; // generous downward room
          } else {
            // Ancestor panel — bottom must remain ≤ origin's row-top.
            const maxPanelBottom = originScreenY - cardHalfHeight + 10;
            const maxPanelTop = maxPanelBottom - panelH;
            minOffsetY = -4 * panelH;
            maxOffsetY = maxPanelTop - defaultPanelTop;
          }
          // Apply offset to compute final panel position. Already
          // clamped on commit by the drag handler; re-clamping here
          // is defensive in case viewport changes mid-session push
          // an old offset out of range.
          const clampedX = Math.max(minOffsetX, Math.min(maxOffsetX, offset.x));
          const clampedY = Math.max(minOffsetY, Math.min(maxOffsetY, offset.y));
          const panelLeft = defaultPanelLeft + clampedX;
          const panelTop = defaultPanelTop + clampedY;
          const panelAnchorX = panelLeft + panelW / 2;
          const panelAnchorY = direction === 'descendant' ? panelTop : panelTop + panelH;
          const personName = origin.fullName?.trim() || origin.name?.trim() || 'this person';
          const directionLabel = direction === 'descendant' ? 'descendants' : 'family of origin';
          const isOriginBloodline = bloodlineSet.has(personId);
          const tetherColour = direction === 'descendant'
            ? '#ad9eff'
            : (isOriginBloodline ? '#ad9eff' : '#f59e0b');
          // Branch surname for the abbreviated zoomed-out header.
          // Descendant: head's own surname (the cousins' family
          // name typically follows it). Ancestor: topmost
          // ancestor's surname (the in-law family-of-origin).
          const surnameOf = (n: { fullName: string | null; name: string }): string => {
            const raw = (n.fullName?.trim() || n.name?.trim() || '').trim();
            if (!raw) return '';
            const parts = raw.split(/\s+/);
            return parts[parts.length - 1] || '';
          };
          let branchSurname = '';
          if (direction === 'descendant') {
            branchSurname = surnameOf(origin);
          } else if (peopleInPanel.length > 0) {
            const topAncestor = peopleInPanel.reduce(
              (acc, n) => n.generation > acc.generation ? n : acc,
              peopleInPanel[0],
            );
            branchSurname = surnameOf(topAncestor);
          }
          layouts.push({
            personId, direction, panelKey, personName, directionLabel,
            contentPeople,
            branchSurname,
            miniPlacements, panelFamilyGroups, panelSpouseEdges,
            directKinIds,
            contentWidth, contentHeight,
            padTop, padBottom, bracketRoom: TETHER_BRACKET_ROOM,
            panelW, panelH,
            defaultPanelLeft, defaultPanelTop,
            panelLeft, panelTop,
            minOffsetX, maxOffsetX, minOffsetY, maxOffsetY,
            chevronScreenX, chevronScreenY,
            panelAnchorX, panelAnchorY,
            tetherColour,
          });
        }

        return (
          <>
            {/* Tether layer — SVG path between each chevron and its
                panel anchor. w-full / h-full needed so the SVG has
                a paintable area; without them the element is 0×0
                even with inset-0 and the path renders nowhere.
                pointer-events disabled so the line never intercepts
                clicks meant for the canvas or panel. */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ zIndex: 25 }}
            >
              {layouts.map(l => {
                // Bezier control points pulled 40% of the vertical
                // delta along the direction of travel — produces a
                // smooth S-curve that bends naturally if the panel
                // is offset diagonally. (Diagonal offset arrives
                // when drag lands in step 6.)
                const dy = l.panelAnchorY - l.chevronScreenY;
                const c1x = l.chevronScreenX;
                const c1y = l.chevronScreenY + dy * 0.4;
                const c2x = l.panelAnchorX;
                const c2y = l.panelAnchorY - dy * 0.4;
                const path = `M ${l.chevronScreenX} ${l.chevronScreenY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${l.panelAnchorX} ${l.panelAnchorY}`;
                return (
                  <path
                    key={`tether-${l.personId}-${l.direction}`}
                    d={path}
                    stroke={l.tetherColour}
                    strokeWidth={2}
                    fill="none"
                    strokeLinecap="round"
                    opacity={0.9}
                  />
                );
              })}
            </svg>
            {/* Panels */}
            {layouts.map(l => (
              <Card
                key={`panel-${l.personId}-${l.direction}`}
                className="absolute flex flex-col overflow-hidden"
                style={{
                  left: l.panelLeft,
                  top: l.panelTop,
                  width: l.panelW,
                  height: l.panelH,
                  boxShadow: '0 12px 32px rgba(0, 0, 0, 0.20)',
                  borderColor: l.tetherColour,
                  borderWidth: 2,
                  zIndex: 30,
                }}
              >
                {/* CardHeader and CardContent are rendered in
                    direction-dependent order so the SVG always sits
                    on the chevron-facing side of the panel — that
                    way the canvas tether and the in-panel
                    continuation meet at the same screen point with
                    no header-height gap between them.
                      Descendant panel (chevron above origin's row →
                        tether enters panel TOP)  →  SVG first, header
                        last, so the bracket continuation reads as a
                        seamless extension of the canvas line.
                      Ancestor panel (chevron below origin → tether
                        enters panel BOTTOM)      →  header first,
                        SVG last; same continuity, mirrored.
                    Header doubles as a drag handle, and so does the
                    SVG body so empty space anywhere catches the
                    mouse. Double-click on the header snaps the
                    panel back to its auto-computed default. */}
                {(() => {
                  const startDrag = (e: React.MouseEvent) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    const current = panelOffsets.get(l.panelKey) ?? { x: 0, y: 0 };
                    panelDragRef.current = {
                      active: true,
                      panelKey: l.panelKey,
                      startMouseX: e.clientX,
                      startMouseY: e.clientY,
                      startOffsetX: current.x,
                      startOffsetY: current.y,
                      minOffsetX: l.minOffsetX,
                      maxOffsetX: l.maxOffsetX,
                      minOffsetY: l.minOffsetY,
                      maxOffsetY: l.maxOffsetY,
                    };
                  };
                  const resetPosition = (e: React.MouseEvent) => {
                    e.preventDefault();
                    panelDragRef.current.active = false;
                    setPanelOffsets(prev => {
                      const next = new Map(prev);
                      next.delete(l.panelKey);
                      return next;
                    });
                  };
                  const headerNode = (
                    <CardHeader
                      key="header"
                      className="cursor-grab active:cursor-grabbing select-none"
                      style={isAbbreviated ? { padding: '12px 16px', gap: 0 } : undefined}
                      onMouseDown={startDrag}
                      onDoubleClick={resetPosition}
                    >
                      {isAbbreviated ? (
                        <CardTitle className="text-h2 text-foreground">
                          {l.branchSurname || l.personName} branch
                        </CardTitle>
                      ) : (
                        <>
                          <div className="text-caption uppercase tracking-wider">
                            {l.direction === 'descendant' ? "Cousins of focus" : "Family of origin"}
                          </div>
                          <CardTitle className="text-h2">{l.personName}</CardTitle>
                          <div className="text-body-muted">
                            {l.direction === 'descendant'
                              ? `${l.contentPeople.length} relative${l.contentPeople.length === 1 ? '' : 's'} on this branch`
                              : `${l.contentPeople.length} ancestor${l.contentPeople.length === 1 ? '' : 's'} on this line`}
                          </div>
                        </>
                      )}
                    </CardHeader>
                  );
                  // CardContent flex-aligns the SVG to the
                  // chevron-facing edge so the SVG meets the panel
                  // border on that side. HEADER_H is a constant
                  // estimate of the actual rendered header height,
                  // and the real header is ~25 px shorter than the
                  // estimate; without justify-end on ancestor
                  // CardContent that slack appeared as a visible
                  // gap between the SVG bottom and the panel's
                  // bottom border (where the canvas tether arrives),
                  // breaking the line continuity. Descendants use
                  // justify-start (the default) — SVG already sits
                  // at the top of CardContent so its top touches the
                  // panel border, slack falls below near the
                  // bottom-rendered header.
                  const contentJustify = l.direction === 'ancestor' ? 'justify-end' : 'justify-start';
                  const contentNode = (
                    <CardContent key="content" className={`flex-1 min-h-0 overflow-auto p-0 flex flex-col ${contentJustify}`}>
                  {/* Full-size canvas-card mini-tree inside the panel.
                      Reuses PersonNode at full CARD_W / CARD_H so each
                      person inside looks identical to a person on the
                      main canvas — same avatar, name, gender marker,
                      step badge. SVG viewBox stays at unscaled
                      contentWidth/contentHeight; the outer width/
                      height is multiplied by viewport.scale so the
                      cards visually match the canvas's current zoom.
                      onMouseDown on the SVG also drags the panel
                      (PersonNode stopPropagation prevents its own
                      clicks from bubbling here, so only empty SVG
                      space initiates drag). */}
                  <svg
                    width={l.contentWidth * viewport.scale}
                    height={l.contentHeight * viewport.scale}
                    viewBox={`0 0 ${l.contentWidth} ${l.contentHeight}`}
                    style={{ display: 'block', margin: '0 auto', cursor: 'grab' }}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      const current = panelOffsets.get(l.panelKey) ?? { x: 0, y: 0 };
                      panelDragRef.current = {
                        active: true,
                        panelKey: l.panelKey,
                        startMouseX: e.clientX,
                        startMouseY: e.clientY,
                        startOffsetX: current.x,
                        startOffsetY: current.y,
                        minOffsetX: l.minOffsetX,
                        maxOffsetX: l.maxOffsetX,
                        minOffsetY: l.minOffsetY,
                        maxOffsetY: l.maxOffsetY,
                      };
                    }}
                  >
                    {/* Tether-continuation drop-line — extends the
                        canvas tether INTO the panel as a family-tree
                        drop + sibling bracket connecting the panel
                        edge to the origin's direct kin. So Carol's
                        lavender tether reads as one continuous
                        family-tree line crossing the panel boundary
                        and bracketing Ben + Jenny inside; Lindsay's
                        orange tether mirrors that, going UP from the
                        panel's bottom edge to bracket her parents in
                        the bottom row. Drawn first so FamilyGroup
                        scaffolding paints over it where they meet
                        (avoids cosmetic over-strikes at junctions). */}
                    {(() => {
                      if (l.directKinIds.length === 0) return null;
                      const kinPlacements = l.directKinIds
                        .map(id => l.miniPlacements.find(p => p.personId === id))
                        .filter((p): p is MiniPlacement => p != null);
                      if (kinPlacements.length === 0) return null;
                      const xs = kinPlacements.map(p => p.cx);
                      const minX = Math.min(...xs);
                      const maxX = Math.max(...xs);
                      const centerX = l.contentWidth / 2;
                      if (l.direction === 'descendant') {
                        // Drop down from panel-top into a bracket
                        // that sits MINI_ROW_GAP_Y/2 above the head's
                        // direct children — same spacing the canvas
                        // family-group brackets use, so panel and
                        // canvas scaffolding read as a single system.
                        const entryY = 0;
                        const cardTop = l.padTop;
                        const bracketY = l.padTop - l.bracketRoom;
                        return (
                          <g
                            stroke={l.tetherColour}
                            strokeWidth={2}
                            fill="none"
                            strokeLinecap="round"
                          >
                            <line x1={centerX} y1={entryY} x2={centerX} y2={bracketY} />
                            <line x1={minX} y1={bracketY} x2={maxX} y2={bracketY} />
                            {kinPlacements.map(p => (
                              <line
                                key={`tcd-${p.personId}`}
                                x1={p.cx}
                                y1={bracketY}
                                x2={p.cx}
                                y2={cardTop}
                              />
                            ))}
                          </g>
                        );
                      }
                      // Ancestor — drop UP from panel-bottom into a
                      // bracket that sits MINI_ROW_GAP_Y/2 below the
                      // in-law's direct parents (canvas-matching).
                      const entryY = l.contentHeight;
                      const cardBottom = l.contentHeight - l.padBottom;
                      const bracketY = l.contentHeight - l.padBottom + l.bracketRoom;
                      return (
                        <g
                          stroke={l.tetherColour}
                          strokeWidth={2}
                          fill="none"
                          strokeLinecap="round"
                        >
                          <line x1={centerX} y1={entryY} x2={centerX} y2={bracketY} />
                          <line x1={minX} y1={bracketY} x2={maxX} y2={bracketY} />
                          {kinPlacements.map(p => (
                            <line
                              key={`tca-${p.personId}`}
                              x1={p.cx}
                              y1={bracketY}
                              x2={p.cx}
                              y2={cardBottom}
                            />
                          ))}
                        </g>
                      );
                    })()}
                    {/* Family-group brackets — same FamilyGroup
                        component the canvas uses, so panel geometry
                        matches the canvas exactly: marriage bar
                        between couples (drawn either by FamilyGroup
                        as a dashed bar OR by the EdgeLine partnership
                        line below), drop from the bar's midpoint,
                        sibling bracket, drops to each child.
                        strokeOverride tints the scaffolding with the
                        panel's brand colour (lavender for bloodline,
                        orange for in-law). */}
                    {l.panelFamilyGroups.map((group, i) => {
                      const parentNodes = group.parentIds
                        .map(id => l.miniPlacements.find(p => p.personId === id))
                        .filter((p): p is MiniPlacement => p != null)
                        .map(p => ({ ...p.node, renderedX: p.cx, renderedY: p.cy, isPlaceholder: false }));
                      const childNodes = group.childIds
                        .map(id => l.miniPlacements.find(p => p.personId === id))
                        .filter((p): p is MiniPlacement => p != null)
                        .map(p => ({ ...p.node, renderedX: p.cx, renderedY: p.cy }));
                      const hasStoredSpouse = l.panelSpouseEdges.some(e =>
                        !e.derived && group.parentIds.includes(e.aId) && group.parentIds.includes(e.bId),
                      );
                      return (
                        <FamilyGroup
                          key={`pf-${i}-${group.parentIds.join('_')}`}
                          parents={parentNodes}
                          children={childNodes}
                          parentsAreSpouses={hasStoredSpouse}
                          bracketOffset={i * 8}
                          contrast={treeContrast}
                          strokeOverride={l.tetherColour}
                          onParentClick={() => {}}
                        />
                      );
                    })}
                    {/* Partnership lines — same EdgeLine component
                        the canvas uses, so the marriage bar between
                        couples renders identically inside the panel
                        (dotted-pair, ended-states, etc.). */}
                    {l.panelSpouseEdges.map((edge, idx) => {
                      const a = l.miniPlacements.find(p => p.personId === edge.aId);
                      const b = l.miniPlacements.find(p => p.personId === edge.bId);
                      if (!a || !b) return null;
                      return (
                        <EdgeLine
                          key={`pe-${edge.aId}-${edge.bId}-${idx}`}
                          ax={a.cx}
                          ay={a.cy}
                          bx={b.cx}
                          by={b.cy}
                          type="spouse_of"
                          until={edge.until}
                          opacity={1}
                          derived={edge.derived}
                          flags={edge.flags as { half?: boolean; adopted?: boolean } | null}
                          contrast={treeContrast}
                        />
                      );
                    })}
                    {/* Each panel-person rendered as a full PersonNode
                        with all interactions disabled (hideChips, no
                        chevrons, no quick-add handlers, no edit
                        handlers). The card visual itself is unchanged
                        — same primitive as the main canvas. */}
                    {l.miniPlacements.map(p => {
                      const nodeAtPanelCoords = {
                        ...p.node,
                        renderedX: p.cx,
                        renderedY: p.cy,
                      };
                      return (
                        <PersonNode
                          key={p.personId}
                          node={nodeAtPanelCoords}
                          avatar={avatars.get(p.personId)}
                          isFocus={false}
                          opacity={1}
                          hideChips={true}
                          relationshipLabel={relationshipLabels.get(p.personId)}
                          onMouseDown={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => { e.stopPropagation(); onRefocus(p.personId); }}
                          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                          onQuickAddParent={() => {}}
                          onQuickAddPartner={() => {}}
                          onQuickAddChild={() => {}}
                          onQuickAddSibling={() => {}}
                          contrast={treeContrast}
                          canAddParent={false}
                          hasOutOfScopeAncestors={false}
                          hasHideableDescendants={false}
                          isOnBloodline={bloodlineSet.has(p.personId)}
                          // Per-person bloodline colour (lavender =
                          // bloodline, orange = in-law). Same rule as
                          // canvas — Karen and Dan get orange even
                          // inside Carol's lavender panel because
                          // they're non-bloodline.
                          borderOverride={bloodlineSet.has(p.personId) ? '#ad9eff' : '#f59e0b'}
                        />
                      );
                    })}
                  </svg>
                </CardContent>
                  );
                  // SVG sits on the side of the panel that faces
                  // the chevron, so the canvas tether's panel-edge
                  // anchor and the in-SVG bracket continuation meet
                  // at the same point — no header-height gap.
                  return l.direction === 'descendant'
                    ? <>{contentNode}{headerNode}</>
                    : <>{headerNode}{contentNode}</>;
                })()}
              </Card>
            ))}
          </>
        );
      })()}

      {contextMenu && (
        <NodeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          personId={contextMenu.personId}
          isFocus={contextMenu.personId === layout.focusPersonId}
          hasCardBackground={!!nodeById.get(contextMenu.personId)?.cardBackground}
          ancestryHidden={!!hiddenAncestorPersonIds?.includes(contextMenu.personId)}
          canHideAncestry={contextMenu.personId !== layout.focusPersonId && !!onToggleHiddenAncestor}
          onSetRelationship={() => { onSetRelationship(contextMenu.personId); setContextMenu(null); }}
          onEditRelationships={() => { onEditRelationships(contextMenu.personId); setContextMenu(null); }}
          onRefocus={() => { onRefocus(contextMenu.personId); setContextMenu(null); }}
          onRemovePerson={() => { onRemovePerson(contextMenu.personId); setContextMenu(null); }}
          onSetCardBackground={() => { pickCardBackgroundFor(contextMenu.personId); setContextMenu(null); }}
          onClearCardBackground={() => { clearCardBackgroundFor(contextMenu.personId); setContextMenu(null); }}
          onToggleAncestry={() => { onToggleHiddenAncestor?.(contextMenu.personId); setContextMenu(null); }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {edgeEditor && (
        <EdgeQuickEditor
          edge={edgeEditor.edge}
          x={edgeEditor.x}
          y={edgeEditor.y}
          personNameLookup={(id) => nodeById.get(id)?.name ?? `#${id}`}
          onSaved={() => { onGraphMutated(); setEdgeEditor(null); }}
          onClose={() => setEdgeEditor(null)}
        />
      )}

      {placeholderEditor && (
        <PlaceholderResolver
          personId={placeholderEditor.kind === 'persisted' ? placeholderEditor.personId : null}
          virtualChildIds={placeholderEditor.kind === 'virtual' ? placeholderEditor.virtualChildIds : null}
          x={placeholderEditor.x}
          y={placeholderEditor.y}
          onResolved={() => { onGraphMutated(); setPlaceholderEditor(null); }}
          onClose={() => setPlaceholderEditor(null)}
          peopleAlreadyInTree={new Set(
            // Exclude only people CURRENTLY VISIBLE on the canvas, not
            // the full connected component from listAllRelationships.
            // The connected-component approach used to filter Terry's
            // already-tagged "Nan" / "Grandad" out of every placeholder
            // picker even after he undid their relationships — because
            // a stray edge still made them reachable from the focus,
            // they were treated as "in the tree" forever. Layout nodes
            // are the right denominator for "already placed somewhere
            // visible right now".
            layout.nodes
              .filter(n => !n.isPlaceholder && n.personId > 0)
              .map(n => n.personId),
          )}
          excludedSuggestionIds={excludedSuggestionIds}
          hiddenSuggestions={hiddenSuggestions}
          onHideSuggestion={onHideSuggestion}
          onUnhideSuggestion={onUnhideSuggestion}
          nameConflictLookup={nameConflictLookup}
          onParentResolved={onParentResolved}
        />
      )}

      {genderPickerFor != null && (() => {
        const n = layout.nodes.find(nd => nd.personId === genderPickerFor);
        return (
          <GenderPickerModal
            personName={n?.name?.trim() || 'this person'}
            currentGender={(n?.gender ?? null) as PersonGender}
            onSelect={async (gender) => {
              await setPersonGenderApi(genderPickerFor, gender);
              setGenderPickerFor(null);
              onGraphMutated();
            }}
            onClose={() => setGenderPickerFor(null)}
          />
        );
      })()}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Pedigree "family group" rendering
// ─────────────────────────────────────────────────────────────────

/**
 * Renders ONE family unit: its parent(s) get a marriage bar between
 * them (if there are two), a vertical drop from the bar's midpoint to
 * a horizontal sibling bracket, and vertical drops from that bracket
 * down to each child. This is the canonical pedigree look.
 *
 * Accepts any N parents and any M children. When N=1 the marriage bar
 * is skipped and the drop comes straight from the lone parent.
 */
function FamilyGroup({ parents, children, parentsAreSpouses, bracketOffset, onParentClick, contrast = 0.3, strokeOverride }: {
  parents: (LaidOutNode & { renderedX: number; renderedY: number; isPlaceholder: boolean })[];
  children: (LaidOutNode & { renderedX: number; renderedY: number })[];
  /** True when a stored spouse_of edge exists between parents. In that
   *  case the partnership line is drawn by EdgeLine, so we skip our
   *  own marriage bar to avoid duplicate overlap. */
  parentsAreSpouses: boolean;
  bracketOffset: number;
  onParentClick: (parentId: number) => void;
  contrast?: number;
  /** Optional override for the stroke colour. When set, replaces
   *  the contrast-driven default for ALL scaffolding lines (marriage
   *  bar, drop, bracket, child drops). Used by the panel to tint
   *  the family-group geometry with the panel's brand colour, and
   *  by the canvas to tint bloodline families lavender. */
  strokeOverride?: string;
}) {
  if (parents.length === 0 || children.length === 0) return null;

  // Partnership line now sits at AVATAR level between the card SIDES
  // (royal-chart style), not below the cards. Children's vertical
  // drop starts at that avatar-level midpoint and descends past the
  // card bottoms to the bracket.
  const parentY = parents[0].renderedY + AVATAR_CY; // avatar level

  const childY = children[0].renderedY - CARD_H / 2;
  // Bracket Y — computed from card BOTTOM / child TOP (the gap
  // between the two generations), independent of where the partnership
  // line itself sits. That keeps the drop length sensible.
  const parentCardBottom = parents[0].renderedY + CARD_H / 2;
  const bracketY = parentCardBottom + (childY - parentCardBottom) * 0.45 + bracketOffset;

  // Parent x extents — the partnership bar spans from the right edge
  // of the leftmost parent to the left edge of the rightmost. For
  // ghosts we use the smaller ghost radius so the bar hugs the circle.
  const GHOST_R = 28;
  const halfWidthFor = (p: LaidOutNode & { isPlaceholder?: boolean }) =>
    p.isPlaceholder ? GHOST_R : CARD_W / 2;
  const sortedParents = [...parents].sort((a, b) => a.renderedX - b.renderedX);
  const leftParent = sortedParents[0];
  const rightParent = sortedParents[sortedParents.length - 1];
  const barLeftX = leftParent.renderedX + halfWidthFor(leftParent);
  const barRightX = rightParent.renderedX - halfWidthFor(rightParent);
  const marriageBarMidX = (leftParent.renderedX + rightParent.renderedX) / 2;

  // Bracket geometry — UNIFIED rule for any number of children:
  //   • The drop ALWAYS originates at the marriage-bar midpoint
  //     (or the lone parent's centre when there's only one). This is
  //     the "where do the kids come from" anchor in pedigree
  //     diagrams; it's wrong to make it follow whichever child
  //     happens to sit nearest one parent.
  //   • The horizontal bracket spans from min(childMinX, midpoint)
  //     to max(childMaxX, midpoint) — i.e. it stretches to encompass
  //     both the drop anchor AND every child. This works whether the
  //     midpoint sits inside, left of, or right of the children's
  //     range.
  //
  // The earlier code clamped the drop into the children's range and
  // bridged with a parent-level connector when the midpoint was
  // outside it. That produced the visible bug where a couple's
  // children all sitting under ONE parent (e.g. Alan + Sally with
  // kids stacked under Sally) would drop a vertical from Sally's
  // column rather than from between the two parents. The bracket
  // sits in the empty band between parent and child rows, so it
  // can't collide with another card horizontally — there was never
  // a real reason to clamp.
  const childXs = children.map(c => c.renderedX).sort((a, b) => a - b);
  const childMinX = childXs[0];
  const childMaxX = childXs[childXs.length - 1];
  const bracketStart = Math.min(childMinX, marriageBarMidX);
  const bracketEnd   = Math.max(childMaxX, marriageBarMidX);
  const dropAnchorX = marriageBarMidX;
  const needsConnector = false;

  // Stroke darkens + thickens with contrast so the family scaffolding
  // (marriage bar, bracket, child drops) reads clearly against busy
  // backgrounds. Halo is a wider white underlay drawn first.
  const strokeBase = '#64748b';
  const strokeDark = '#1f2937';
  const stroke = strokeOverride ?? (contrast > 0.5 ? strokeDark : strokeBase);
  const strokeWidth = 1.5 + contrast * 1.5;
  const haloWidth = strokeWidth + 3 + contrast * 3;
  const haloOpacity = 0.35 + contrast * 0.5;
  const withHalo = contrast > 0;

  return (
    <g>
      {/* White halo underlay — drawn first so the coloured scaffolding
          sits on top. Makes the family lines readable against any
          canvas background image. */}
      {withHalo && (
        <g opacity={haloOpacity} style={{ pointerEvents: 'none' }}>
          {parents.length >= 2 && !parentsAreSpouses && barLeftX < barRightX && (
            <line x1={barLeftX} y1={parentY} x2={barRightX} y2={parentY}
              stroke="#ffffff" strokeWidth={haloWidth} strokeLinecap="round" />
          )}
          {needsConnector && (
            <line x1={marriageBarMidX} y1={parentY} x2={dropAnchorX} y2={parentY}
              stroke="#ffffff" strokeWidth={haloWidth} strokeLinecap="round" />
          )}
          <line x1={dropAnchorX} y1={parentY} x2={dropAnchorX} y2={bracketY}
            stroke="#ffffff" strokeWidth={haloWidth} strokeLinecap="round" />
          {bracketStart !== bracketEnd && (
            <line x1={bracketStart} y1={bracketY} x2={bracketEnd} y2={bracketY}
              stroke="#ffffff" strokeWidth={haloWidth} strokeLinecap="round" />
          )}
          {children.map(c => (
            <line key={`halo-${c.personId}`} x1={c.renderedX} y1={bracketY}
              x2={c.renderedX} y2={c.renderedY - CARD_H / 2}
              stroke="#ffffff" strokeWidth={haloWidth} strokeLinecap="round" />
          ))}
        </g>
      )}
      {/* Partnership bar at AVATAR level — drawn only when parents don't
          already have a stored spouse_of edge (which EdgeLine renders).
          Hugs each parent's side edge so it doesn't cut through cards. */}
      {parents.length >= 2 && !parentsAreSpouses && barLeftX < barRightX && (
        <>
          <line
            x1={barLeftX}
            y1={parentY}
            x2={barRightX}
            y2={parentY}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeDasharray="6 4"
          />
          <circle cx={marriageBarMidX} cy={parentY} r={2.5 + contrast} fill={stroke} />
        </>
      )}
      {/* Short horizontal connector from marriage midpoint to the drop
          column, only when the midpoint doesn't sit above the children
          already. Kept at parentY so it hugs the parent generation and
          doesn't intrude on other rows. */}
      {needsConnector && (
        <line
          x1={marriageBarMidX}
          y1={parentY}
          x2={dropAnchorX}
          y2={parentY}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      )}
      {/* Drop from parent column to the bracket level — starts at the
          drop anchor (which is clamped to the children's x range) so
          it never runs straight down through a card that isn't a child
          in this family. */}
      <line
        x1={dropAnchorX}
        y1={parentY}
        x2={dropAnchorX}
        y2={bracketY}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      {/* Horizontal at bracket level — spans all children */}
      {bracketStart !== bracketEnd && (
        <line
          x1={bracketStart}
          y1={bracketY}
          x2={bracketEnd}
          y2={bracketY}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      )}
      {/* Drops to each child — end at the card's TOP edge */}
      {children.map(c => (
        <line
          key={c.personId}
          x1={c.renderedX}
          y1={bracketY}
          x2={c.renderedX}
          y2={c.renderedY - CARD_H / 2}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      ))}
      {/* Click targets sitting on top of the lines — let users click
          the marriage bar or any drop to open the resolver for a
          ghost parent (if one is involved). Single-parent groups let
          you click the drop itself. */}
      {parents.length === 1 && parents[0].isPlaceholder && (
        <line
          x1={dropAnchorX}
          y1={parentY}
          x2={dropAnchorX}
          y2={bracketY}
          stroke="transparent"
          strokeWidth={14}
          pointerEvents="stroke"
          style={{ cursor: 'pointer' }}
          onClick={(e) => { e.stopPropagation(); onParentClick(parents[0].personId); }}
        />
      )}
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────
// Edge rendering
// ─────────────────────────────────────────────────────────────────

function EdgeLine({ ax, ay, bx, by, type, until, opacity, derived, flags, onClick, contrast = 0.3 }: {
  ax: number; ay: number; bx: number; by: number;
  type: 'parent_of' | 'spouse_of' | 'sibling_of' | 'associated_with';
  until: string | null;
  opacity: number;
  derived: boolean;
  flags: { half?: boolean; adopted?: boolean; kind?: string; ended?: boolean; label?: string } | null;
  onClick?: (e: React.MouseEvent) => void;
  contrast?: number;
}) {
  // parent_of: solid vertical-preferring line, slight curve
  // spouse_of: solid double line between partners, horizontal preferred; dashed if ended
  // sibling_of:
  //   · derived (from shared parents, not stored) — thin dotted light violet
  //   · stored full sibling — solid violet medium weight
  //   · stored half-sibling — short-dash violet
  //   · stored adopted sibling — long-dash teal
  // associated_with: grey curve, lighter weight, kind label on the line.
  //   · ended (ex-colleague etc.) — dashed
  const midX = (ax + bx) / 2;
  const midY = (ay + by) / 2;
  const hitArea = onClick ? (
    <line x1={ax} y1={ay} x2={bx} y2={by}
      stroke="transparent"
      strokeWidth={14}
      style={{ cursor: 'pointer' }}
      pointerEvents="stroke"
    />
  ) : null;
  if (type === 'associated_with') {
    const color = ASSOCIATION_COLORS[flags?.kind ?? 'other'] ?? '#9ca3af';
    const labelText = flags?.kind === 'other' ? (flags?.label ?? 'other')
                    : flags?.kind ? ASSOCIATION_LABELS[flags.kind] ?? flags.kind : '';
    const endedLabel = flags?.ended ? `ex-${labelText.toLowerCase()}` : labelText;
    return (
      <g onClick={onClick}>
        {hitArea}
        <line x1={ax} y1={ay} x2={bx} y2={by}
          stroke={color}
          strokeWidth={1.25}
          strokeDasharray={flags?.ended ? '6 4' : undefined}
          opacity={opacity * 0.75}
        />
        {endedLabel && (
          <text x={midX} y={midY - 4} textAnchor="middle" fontSize={9} fill={color} opacity={opacity * 0.9}
            style={{ pointerEvents: 'none', fontStyle: 'italic' }}>
            {endedLabel}
          </text>
        )}
      </g>
    );
  }
  // Halo helpers — white underlay drawn behind the coloured stroke so
  // edges stay readable against busy canvas backgrounds. Width and
  // opacity scale with the Tree pop slider.
  const haloWidth = (w: number) => w + 3 + contrast * 3;
  const haloOpacity = 0.35 + contrast * 0.5;
  const withHalo = contrast > 0;

  if (type === 'sibling_of') {
    // Derived sibling edges aren't stored, so they're never clickable.
    if (derived) {
      return (
        <g>
          {withHalo && (
            <line x1={ax} y1={ay} x2={bx} y2={by}
              stroke="#ffffff" strokeWidth={haloWidth(1)} strokeLinecap="round"
              opacity={haloOpacity * 0.7} />
          )}
          <line x1={ax} y1={ay} x2={bx} y2={by}
            stroke={contrast > 0.5 ? '#7c3aed' : '#a78bfa'}
            strokeWidth={1 + contrast * 0.75}
            strokeDasharray="2 4" opacity={opacity * 0.6} />
        </g>
      );
    }
    const stroke = flags?.adopted ? '#14b8a6' : (contrast > 0.5 ? '#7c3aed' : '#a78bfa');
    const dash = flags?.adopted ? '8 4' : flags?.half ? '4 3' : undefined;
    const width = 1.5 + contrast * 1.25;
    return (
      <g onClick={onClick}>
        {hitArea}
        {withHalo && (
          <line x1={ax} y1={ay} x2={bx} y2={by}
            stroke="#ffffff" strokeWidth={haloWidth(width)} strokeLinecap="round"
            opacity={haloOpacity} />
        )}
        <line x1={ax} y1={ay} x2={bx} y2={by}
          stroke={stroke} strokeWidth={width} strokeDasharray={dash} opacity={opacity} />
      </g>
    );
  }
  if (type === 'spouse_of') {
    const dashed = !!until;
    // Royal-chart style: a single thin slate line between the two
    // cards at AVATAR level (the photo row), with a small dot at the
    // midpoint where any children's vertical drop originates.
    const xLeft  = Math.min(ax, bx) + CARD_W / 2;
    const xRight = Math.max(ax, bx) - CARD_W / 2;
    const yMid = (ay + by) / 2 + AVATAR_CY; // avatar-level horizontal
    const xMid = (xLeft + xRight) / 2;
    const spouseStroke = contrast > 0.5 ? '#1f2937' : '#64748b';
    const spouseWidth = 1.5 + contrast * 1.5;
    return (
      <g onClick={onClick}>
        {hitArea}
        {withHalo && (
          <line x1={xLeft} y1={yMid} x2={xRight} y2={yMid}
            stroke="#ffffff" strokeWidth={haloWidth(spouseWidth)} strokeLinecap="round"
            opacity={haloOpacity} />
        )}
        <line x1={xLeft} y1={yMid} x2={xRight} y2={yMid}
          stroke={spouseStroke} strokeWidth={spouseWidth}
          strokeDasharray={dashed ? '6 4' : undefined}
          opacity={opacity} />
        <circle cx={xMid} cy={yMid} r={2.5 + contrast} fill={spouseStroke} opacity={opacity} />
      </g>
    );
  }
  // parent_of — orthogonal path: straight down from parent to the gap
  // between tiers, across to the child's x, then straight down to the
  // child. Classic pedigree-chart elbows rather than chaotic S-curves.
  const orthPath = `M ${ax} ${ay} L ${ax} ${midY} L ${bx} ${midY} L ${bx} ${by}`;
  const parentStroke = contrast > 0.5 ? '#4338ca' : '#6366f1';
  const parentWidth = 1.75 + contrast * 1.5;
  return (
    <g onClick={onClick}>
      {onClick && (
        <path d={orthPath} stroke="transparent" strokeWidth={14} fill="none"
          style={{ cursor: 'pointer' }} pointerEvents="stroke" />
      )}
      {withHalo && (
        <path d={orthPath} stroke="#ffffff" strokeWidth={haloWidth(parentWidth)}
          strokeLinecap="round" strokeLinejoin="round" fill="none"
          opacity={haloOpacity} />
      )}
      <path
        d={orthPath}
        stroke={parentStroke}
        strokeWidth={parentWidth}
        fill="none"
        opacity={opacity}
      />
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────
// Person node rendering
// ─────────────────────────────────────────────────────────────────

const INITIAL_COLORS = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#3b82f6'];

const ASSOCIATION_COLORS: Record<string, string> = {
  friend: '#10b981',         // green
  close_friend: '#059669',
  best_friend: '#047857',
  acquaintance: '#9ca3af',   // grey
  neighbour: '#64748b',
  colleague: '#0ea5e9',      // sky
  classmate: '#6366f1',
  teammate: '#f59e0b',
  roommate: '#a855f7',
  manager: '#0284c7',
  mentor: '#0d9488',
  mentee: '#14b8a6',
  client: '#ca8a04',
  ex_partner: '#ec4899',     // pink (dashed via ended flag)
  other: '#9ca3af',
};

const ASSOCIATION_LABELS: Record<string, string> = {
  friend: 'friend',
  close_friend: 'close friend',
  best_friend: 'best friend',
  acquaintance: 'acquaintance',
  neighbour: 'neighbour',
  colleague: 'colleague',
  classmate: 'classmate',
  teammate: 'teammate',
  roommate: 'roommate',
  manager: 'manager',
  mentor: 'mentor',
  mentee: 'mentee',
  client: 'client',
  ex_partner: 'partner',
  other: 'other',
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFromId(id: number): string {
  return INITIAL_COLORS[id % INITIAL_COLORS.length];
}

function PersonNode({ node, avatar, isFocus, opacity, hideChips, showDates, onEditDates, onEditName, onMouseDown, onDoubleClick, onContextMenu, onQuickAddParent, onQuickAddPartner, onQuickAddChild, onQuickAddSibling, contrast = 0.3, relationshipLabel, hideGenderMarker, onOpenGenderPicker, canAddParent = true, hasCurrentPartner = false, hasOutOfScopeAncestors = false, hasHideableDescendants = false, isOnBloodline = false, onExpandAncestors, onExpandDescendants, ancestorsExpanded = false, descendantsExpanded = false, lifted = false, borderOverride }: {
  node: LaidOutNode & { renderedX: number; renderedY: number };
  avatar: string | undefined;
  isFocus: boolean;
  opacity: number;
  hideChips?: boolean;
  showDates?: boolean;
  onEditDates?: (screenX: number, screenY: number) => void;
  onEditName?: (screenX: number, screenY: number) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onQuickAddParent: () => void;
  onQuickAddPartner: () => void;
  onQuickAddChild: () => void;
  onQuickAddSibling: () => void;
  contrast?: number;
  relationshipLabel?: string | null;
  /** When true, the gender symbol preview is suppressed even if the
   *  person has a gender set. The small "G" button remains so the user
   *  can still edit — but the card doesn't display the result. */
  hideGenderMarker?: boolean;
  /** Opens the gender picker modal for this person. */
  onOpenGenderPicker?: () => void;
  /** When false, the +parent chip is hidden — the person already has
   *  two stored parents and can't take a third (even if only one is
   *  currently visible due to Steps cutting off the other). */
  canAddParent?: boolean;
  /** True when this person already has a current (non-ended)
   *  spouse_of edge. Drives the +sibling/+partner chip menu's
   *  primary CTA: if a partner is already on file, Sibling is the
   *  more likely follow-up; otherwise Partner is. */
  hasCurrentPartner?: boolean;
  /** True when DB knows of more parents than the canvas currently
   *  shows. Renders a small ^ chevron above the card inviting the
   *  user to pull those ancestors in (probe + pin). */
  hasOutOfScopeAncestors?: boolean;
  /** True when this person is a side-branch head (aunt / uncle /
   *  great-aunt / etc.) with bloodline descendants currently hidden
   *  by default. Paints the v chevron below the card; click toggles
   *  reveal/hide of every cousin / second-cousin in their branch. */
  hasHideableDescendants?: boolean;
  /** True when this person is on the focus's direct bloodline
   *  (focus + transitive ancestors + transitive descendants).
   *  Drives the chevron stroke palette: lavender for bloodline,
   *  slate for extended / in-laws. */
  isOnBloodline?: boolean;
  /** Click handler for the ^ chevron. Undefined disables the
   *  chevron entirely (TreesView didn't wire it). */
  onExpandAncestors?: () => void;
  /** Click handler for the v chevron. Undefined disables it. */
  onExpandDescendants?: () => void;
  /** True when this person's beyond-cap ancestors are currently
   *  pinned in via the chevron. Flips the chevron's tooltip + glyph
   *  to a "collapse" affordance so a second click hides them again. */
  ancestorsExpanded?: boolean;
  /** Mirror of ancestorsExpanded for the descendants chevron below. */
  descendantsExpanded?: boolean;
  /** True when this card has been REVEALED by an expanded
   *  side-branch chevron (i.e. a cousin / second cousin appearing
   *  via their aunt's expansion). Drives the lift / drop-shadow
   *  treatment that gives revealed branches a "popped out" feel
   *  without committing to actual 3D rendering. */
  lifted?: boolean;
  /** When set, overrides the card's outer border colour. Used inside
   *  panels so each card's outline matches the panel's brand colour
   *  (lavender for bloodline, orange for in-law) — the whole panel,
   *  including its cards, reads as one branded unit. Does NOT apply
   *  to the focus halo (focus retains its amber ring). */
  borderOverride?: string;
}) {
  const [hovered, setHovered] = useState(false);
  // Separate hover state for the extend / collapse chevron above the
  // card. While the user is over the chevron we hide the four +chips
  // on this card so they don't fight for the same screen edge — see
  // the chip render block below for the gate.
  const [chevronHovered, setChevronHovered] = useState(false);
  const ringColor = isFocus ? '#f59e0b' : '#6366f1';
  // Trees prefers the long-form name when set — that's where
  // genealogical detail (middle names, surnames) actually matters.
  // Falls back to the short name when full_name is null.
  const treeName = (node.fullName && node.fullName.trim()) || node.name;
  const initials = initialsOf(treeName);
  const bgColor = colorFromId(node.personId);
  const lifeLine = formatLife(node.birthDate, node.deathDate);
  const isDeceased = !!node.deathDate;
  const displayName = treeName.length > 22 ? treeName.slice(0, 20) + '…' : treeName;

  return (
    <g
      transform={`translate(${node.renderedX} ${node.renderedY})`}
      opacity={opacity}
      // Lift treatment for cards revealed via a side-branch chevron.
      // CSS drop-shadow gives the card a "popped out" feel without
      // committing to actual 3D rendering — Terry asked for the
      // hover-menu metaphor, this is the cheap version. Class wires
      // through to the chevron-revealed-card animation in
      // index.css (fade + slight scale on appearance).
      className={lifted ? 'pdr-tree-lifted-card' : undefined}
      style={{
        cursor: 'default',
        ...(lifted ? { filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.18))' } : {}),
      }}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Invisible hover buffer — covers the card AND the chip area
          around it so moving from card → chip doesn't trigger mouseleave
          and hide the chips. Drawn first so it never intercepts clicks
          meant for visible elements. */}
      <rect
        x={-CARD_W / 2 - 24}
        y={-CARD_H / 2 - 24}
        width={CARD_W + 48}
        height={CARD_H + 60}
        fill="white"
        fillOpacity={0.001}
      />
      {/* Focus halo — slightly larger card outline behind. The pulsing
          outer rect is the "I am focused" heartbeat so users don't
          mistake which card drives the bloodline POV (Terry confused
          his mum's focus state for his own previously). Static halo
          stays underneath so the focus ring is visible even at the
          dim end of the pulse cycle. */}
      {isFocus && (
        <>
          <rect
            className="pdr-tree-focus-pulse"
            x={-CARD_W / 2 - 10}
            y={-CARD_H / 2 - 10}
            width={CARD_W + 20}
            height={CARD_H + 20}
            rx={16}
            ry={16}
            fill="none"
            stroke="#f59e0b"
            strokeWidth={2.5}
            style={{ pointerEvents: 'none' }}
          />
          <rect
            x={-CARD_W / 2 - 6}
            y={-CARD_H / 2 - 6}
            width={CARD_W + 12}
            height={CARD_H + 12}
            rx={14}
            ry={14}
            fill="rgba(245, 158, 11, 0.10)"
            stroke="rgba(245, 158, 11, 0.55)"
            strokeWidth={1.5}
          />
        </>
      )}
      {/* Contrast halo — a soft white-ish glow behind the card so it
          pops against busy canvas backgrounds. Only visible when
          contrast > 0. Drawn first so it sits under the card body and
          everything else. */}
      {contrast > 0 && (
        <>
          <rect
            x={-CARD_W / 2 - 8}
            y={-CARD_H / 2 - 8}
            width={CARD_W + 16}
            height={CARD_H + 16}
            rx={14}
            ry={14}
            fill="#ffffff"
            fillOpacity={0.35 * contrast}
          />
          <rect
            x={-CARD_W / 2 - 4}
            y={-CARD_H / 2 - 4}
            width={CARD_W + 8}
            height={CARD_H + 8}
            rx={12}
            ry={12}
            fill="#ffffff"
            fillOpacity={0.55 * contrast}
          />
        </>
      )}
      {/* Card body — rectangular tile with rounded corners. Inherits
          theme via currentColor where needed; explicit white so dark-
          mode users still see a light card (matches royal-chart style). */}
      <rect
        x={-CARD_W / 2}
        y={-CARD_H / 2}
        width={CARD_W}
        height={CARD_H}
        rx={10}
        ry={10}
        fill="#ffffff"
        stroke={isFocus ? ringColor : (borderOverride ?? `rgba(0,0,0,${0.08 + 0.35 * contrast})`)}
        strokeWidth={isFocus ? 2 : (borderOverride ? 2 : 1 + contrast)}
      />
      {/* Optional per-card background image — faded behind the card
          contents. Clipped to the card's rounded shape via a per-node
          clipPath. Only rendered when the person has one set. */}
      {node.cardBackground && (
        <>
          <defs>
            <clipPath id={`cardclip-${node.personId}`}>
              <rect
                x={-CARD_W / 2}
                y={-CARD_H / 2}
                width={CARD_W}
                height={CARD_H}
                rx={10}
                ry={10}
              />
            </clipPath>
          </defs>
          <image
            href={node.cardBackground}
            x={-CARD_W / 2}
            y={-CARD_H / 2}
            width={CARD_W}
            height={CARD_H}
            preserveAspectRatio="xMidYMid slice"
            opacity={0.28 * (1 - contrast * 0.5)}
            clipPath={`url(#cardclip-${node.personId})`}
          />
        </>
      )}
      {/* Card drop-shadow — simple offset rect behind the card for depth.
          Strength scales with the contrast slider. */}
      <rect
        x={-CARD_W / 2}
        y={-CARD_H / 2}
        width={CARD_W}
        height={CARD_H}
        rx={10}
        ry={10}
        fill="none"
        stroke={`rgba(0,0,0,${0.04 + 0.18 * contrast})`}
        strokeWidth={3 + contrast * 3}
        transform={`translate(${1 + contrast} ${1 + contrast * 2})`}
      />
      {/* Avatar — small circle near the top of the card */}
      <circle cx={0} cy={AVATAR_CY} r={AVATAR_R} fill={avatar ? '#fff' : bgColor} stroke="rgba(0,0,0,0.12)" strokeWidth={1} />
      {avatar ? (
        // clipPath percentages are relative to the IMAGE bounding box,
        // not the SVG canvas. The image itself is already placed with
        // x/y so its box is centred on (0, AVATAR_CY); we just need a
        // circle clip at the image's own centre.
        <image
          href={avatar}
          x={-AVATAR_R}
          y={AVATAR_CY - AVATAR_R}
          width={AVATAR_R * 2}
          height={AVATAR_R * 2}
          preserveAspectRatio="xMidYMid slice"
          style={{ clipPath: `circle(${AVATAR_R}px at 50% 50%)` }}
        />
      ) : (
        <text x={0} y={AVATAR_CY + 7} textAnchor="middle" fontSize={18} fontWeight={600} fill="#fff">
          {initials}
        </text>
      )}
      {/* Deceased bluebell marker — top-right of avatar */}
      {isDeceased && (
        <BluebellMarker cx={AVATAR_R - 4} cy={AVATAR_CY - AVATAR_R + 4} />
      )}
      {/* Name — centred below avatar, always visible, dark text.
          Clicking it (when onEditName is provided) opens the
          NameQuickEditor so the user can fill in middle / surname
          without leaving Trees. Cursor stays default for read-only
          contexts (e.g. placeholder ghosts) so we don't suggest
          interactivity that isn't there. */}
      <text
        x={0}
        y={AVATAR_CY + AVATAR_R + AVATAR_TO_NAME}
        textAnchor="middle"
        fontSize={13}
        fontWeight={600}
        fill="#1f2937"
        style={{ cursor: onEditName && !node.isPlaceholder ? 'pointer' : 'default' }}
        onMouseDown={(e) => {
          if (!onEditName || node.isPlaceholder) return;
          // Stop propagation so the canvas's pan/drag handler doesn't
          // start a drag — this is purely a click-to-edit.
          e.stopPropagation();
        }}
        onClick={(e) => {
          if (!onEditName || node.isPlaceholder) return;
          e.stopPropagation();
          onEditName(e.clientX, e.clientY);
        }}
      >
        {displayName}
      </text>
      {/* Relationship label — small, muted, relative to the focus
          person. Renders only for non-focus cards that have a resolved
          path. Hidden for the focus person (they have no "relation to
          themselves") and for distant / disconnected nodes with no
          derivable path. */}
      {!isFocus && relationshipLabel && (
        <text
          x={0}
          y={AVATAR_CY + AVATAR_R + AVATAR_TO_NAME + NAME_TO_LABEL}
          textAnchor="middle"
          fontSize={10}
          fontWeight={600}
          fill="#111827"
          style={{ letterSpacing: '0.02em' }}
        >
          {relationshipLabel}
        </text>
      )}
      {/* Dates — optional, controlled by the header's Add Info > Dates
          Living. Click to edit. When the dates are blank and the user
          has Dates Living turned on, we show a subtle 'add years' hint
          in the same slot so they know where to click. */}
      {showDates && (
        <g
          style={{ cursor: onEditDates ? 'pointer' : 'default' }}
          onClick={(e) => {
            if (!onEditDates) return;
            e.stopPropagation();
            onEditDates(e.clientX, e.clientY);
          }}
        >
          {/* Invisible hit target so the whole bottom strip is clickable */}
          <rect
            x={-CARD_W / 2 + 12}
            y={AVATAR_CY + AVATAR_R + AVATAR_TO_NAME + 6}
            width={CARD_W - 24}
            height={18}
            fill="white"
            fillOpacity={0.001}
          />
          <text
            x={0}
            y={AVATAR_CY + AVATAR_R + AVATAR_TO_NAME + NAME_TO_DATES}
            textAnchor="middle"
            fontSize={11}
            fill={lifeLine ? '#374151' : 'rgba(148,163,184,0.95)'}
            fontStyle={lifeLine ? 'normal' : 'italic'}
            fontWeight={lifeLine ? 500 : 400}
          >
            {lifeLine || 'add years…'}
          </text>
        </g>
      )}
      {/* Step count — top-left corner. Tells the user how many hops
          this person is from the focus. 0 = the focus itself (skipped);
          placeholder ghosts don't carry a meaningful hop count so we
          skip them too. Colour-coded per hop distance so the user can
          see "rings" around the focus at a glance. Purely informational. */}
      {!node.isPlaceholder && !isFocus && node.hopsFromFocus > 0 && (() => {
        const r = 10;
        const cornerX = -CARD_W / 2 + (r + 2);
        const cornerY = -CARD_H / 2 + (r + 2);
        const fill = STEP_BADGE_FILL[node.hopsFromFocus] ?? '#ffffff';
        const stepsLabel = `${node.hopsFromFocus} step${node.hopsFromFocus === 1 ? '' : 's'} from focus`;
        return (
          <g style={{ pointerEvents: 'all' }}>
            <title>{stepsLabel}</title>
            <circle
              cx={cornerX}
              cy={cornerY}
              r={r}
              fill={fill}
              stroke="rgba(0,0,0,0.25)"
              strokeWidth={1}
            />
            <text
              x={cornerX}
              y={cornerY + 4}
              textAnchor="middle"
              fontSize={11}
              fontWeight={700}
              fill="#111827"
              style={{ userSelect: 'none' }}
            >
              {node.hopsFromFocus}
            </text>
          </g>
        );
      })()}
      {/* Gender marker — top-right corner. Shows a small "G" button
          when no gender is set, or the Mars/Venus/Combined symbol
          when it is. Clicking either opens the gender picker. When
          `hideGenderMarker` is true the filled symbol disappears but
          the "G" button stays so the user can still edit. Placeholder
          ghosts don't get this affordance. */}
      {!node.isPlaceholder && onOpenGenderPicker && (() => {
        const symbol = genderMarkerSymbol(node.gender);
        const showSymbol = !!symbol && !hideGenderMarker;
        // Bigger + bolder corner when a symbol is set — users want to
        // read the gender at a glance from across the canvas, so the
        // set state is visually dominant; the unset "G" stays subtle
        // so empty cards don't feel busy.
        const r = showSymbol ? 13 : 10;
        const cornerX = CARD_W / 2 - (r + 2);
        const cornerY = -CARD_H / 2 + (r + 2);
        const genderLabel = node.gender === 'male' ? 'Male — click to change'
          : node.gender === 'female' ? 'Female — click to change'
          : node.gender === 'combined' ? 'Mixed — click to change'
          : 'Click to set gender';
        return (
          <g
            style={{ cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); onOpenGenderPicker(); }}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <title>{genderLabel}</title>
            <circle
              cx={cornerX}
              cy={cornerY}
              r={r}
              fill="#ffffff"
              stroke={showSymbol ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.18)'}
              strokeWidth={1}
            />
            {showSymbol ? (
              <GenderGlyph gender={node.gender} cx={cornerX} cy={cornerY} />
            ) : (
              <text
                x={cornerX}
                y={cornerY + 4}
                textAnchor="middle"
                fontSize={10}
                fontWeight={800}
                fill="#6b7280"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                G
              </text>
            )}
          </g>
        );
      })()}
      {/* Beyond-capacity ancestor chevron — small stemmed indicator
          above the card. Renders ONLY when the DB knows of more
          parents than the canvas is currently showing (i.e. ancestors
          exist past the active Steps / Generations cap). Click toggles
          hide/reveal: if those ancestors are already pinned in
          (ancestorsExpanded=true) the glyph flips to "v" so a second
          click collapses them back. Stroke swaps lavender (#8e7cf0 —
          bloodline) vs slate (#94a3b8 — extended / in-laws) based on
          whether this person is on the focus's direct line. */}
      {hasOutOfScopeAncestors && onExpandAncestors && (() => {
        // Chevron sized 40% larger than the v1 token — the solid-fill
        // treatment needs more presence to read as a deliberate
        // affordance rather than a stray dot. Stem and glyph stroke
        // are bumped in lockstep so proportions stay tight.
        const r = 17;
        const stemLen = 24;
        const cardTop = -CARD_H / 2;
        const chevronCy = cardTop - stemLen - r;
        // Brand palette per Terry: lavender (#ad9eff = --primary) for
        // bloodline, gold/orange (#f59e0b — the same token used for
        // the focus ring + STEP_BADGE_FILL gold) for extended family.
        const fill = isOnBloodline ? '#ad9eff' : '#f59e0b';
        // Slightly darker rim on the bottom edge of the chevron gives
        // it a button-like rounded shape rather than reading flat. The
        // shadow / highlight palette is derived from the brand fill so
        // it stays on-tone whichever variant is rendered.
        const rim = isOnBloodline ? '#7e6df0' : '#c2740a';
        const label = ancestorsExpanded
          ? (isOnBloodline ? 'Hide ancestors on this line' : 'Hide Extended Family')
          : (isOnBloodline ? 'Show more ancestors on this line' : 'Show Extended Family');
        const glyphPath = ancestorsExpanded
          ? 'M -7 -2 L 0 5 L 7 -2'
          : 'M -7 2 L 0 -5 L 7 2';
        // Hover lifts the button by 1px and grows the drop shadow
        // beneath it; pointer-events sit on the chevronGroup so the
        // stem doesn't catch hover on its own (it's decorative).
        const lift = chevronHovered ? -1 : 0;
        return (
          <g>
            {/* Stem — drawn separately from the lifted button so the
                hover lift doesn't drag the line up too. The line is
                purely visual; pointerEvents none lets clicks fall
                through to whatever's underneath at canvas level. */}
            <line
              x1={0}
              y1={cardTop}
              x2={0}
              y2={chevronCy + r}
              stroke={fill}
              strokeWidth={2}
              strokeLinecap="round"
              style={{ pointerEvents: 'none' }}
            />
            <g
              transform={`translate(0 ${chevronCy + lift})`}
              style={{ cursor: 'pointer', transition: 'transform 120ms ease-out' }}
              onMouseEnter={() => setChevronHovered(true)}
              onMouseLeave={() => setChevronHovered(false)}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onExpandAncestors(); }}
            >
              <IconTooltip label={label} side="top">
                <g>
                  {/* Soft drop shadow — slightly oversized circle
                      offset down + blurred via opacity stack. Two
                      stacked shadows (inner sharp, outer soft) give
                      the chip a real "raised button" feel without
                      needing an SVG <filter>. Hover deepens both. */}
                  <ellipse
                    cx={0}
                    cy={chevronHovered ? 5 : 3}
                    rx={r * 0.92}
                    ry={r * 0.55}
                    fill="rgba(0,0,0,0.22)"
                    style={{ pointerEvents: 'none', transition: 'all 120ms ease-out' }}
                  />
                  {/* Rim — slightly darker disc behind the main fill,
                      offset 1.5px down. Reads as the "underside" of
                      the button so the top fill looks proud of it. */}
                  <circle
                    r={r}
                    cx={0}
                    cy={1.5}
                    fill={rim}
                    style={{ pointerEvents: 'none' }}
                  />
                  {/* Main button face */}
                  <circle r={r} fill={fill} stroke="none" />
                  {/* Top highlight — thin lighter arc along the upper
                      edge to suggest a glossy bevel. White at low
                      opacity reads consistent over both lavender and
                      orange variants. */}
                  <path
                    d={`M ${-r * 0.7} ${-r * 0.35} A ${r * 0.85} ${r * 0.85} 0 0 1 ${r * 0.7} ${-r * 0.35}`}
                    stroke="rgba(255,255,255,0.45)"
                    strokeWidth={1.5}
                    fill="none"
                    strokeLinecap="round"
                    style={{ pointerEvents: 'none' }}
                  />
                  {/* Chevron glyph */}
                  <path
                    d={glyphPath}
                    stroke="#ffffff"
                    strokeWidth={3}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ pointerEvents: 'none' }}
                  />
                </g>
              </IconTooltip>
            </g>
          </g>
        );
      })()}
      {/* Side-branch descendant chevron — paints below the card on
          aunts / uncles / great-aunts (anyone who is bloodline AND a
          sibling of a direct ancestor of focus). Click toggles
          reveal / hide of their cousins-and-beyond. Always lavender
          (cousins are bloodline — the brand purple). Default state:
          collapsed, so the canvas opens tidy with only focus's direct
          line + siblings + niblings shown. Stem-and-stud styling
          mirrors the ^ chevron above for visual consistency. */}
      {hasHideableDescendants && onExpandDescendants && (() => {
        const r = 17;
        const stemLen = 24;
        const cardBottom = CARD_H / 2;
        const chevronCy = cardBottom + stemLen + r;
        // Cousins are bloodline → use the lavender palette regardless
        // of isOnBloodline (the head themselves should always be in
        // bloodline anyway since side-branch heads are derived from
        // the bloodline closure).
        const fill = '#ad9eff';
        const rim = '#7e6df0';
        const label = descendantsExpanded
          ? 'Hide cousins on this branch'
          : 'Show cousins on this branch';
        // When expanded the glyph flips upward (^) — "click to fold
        // the branch back up". Same toggle pattern as the ^ chevron.
        const glyphPath = descendantsExpanded
          ? 'M -7 2 L 0 -5 L 7 2'
          : 'M -7 -2 L 0 5 L 7 -2';
        const lift = chevronHovered ? 1 : 0; // hover deepens DOWNWARD for v chevron
        return (
          <g>
            <line
              x1={0}
              y1={cardBottom}
              x2={0}
              y2={chevronCy - r}
              stroke={fill}
              strokeWidth={2}
              strokeLinecap="round"
              style={{ pointerEvents: 'none' }}
            />
            <g
              transform={`translate(0 ${chevronCy + lift})`}
              style={{ cursor: 'pointer', transition: 'transform 120ms ease-out' }}
              onMouseEnter={() => setChevronHovered(true)}
              onMouseLeave={() => setChevronHovered(false)}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onExpandDescendants(); }}
            >
              <IconTooltip label={label} side="bottom">
                <g>
                  <ellipse
                    cx={0}
                    cy={chevronHovered ? 5 : 3}
                    rx={r * 0.92}
                    ry={r * 0.55}
                    fill="rgba(0,0,0,0.22)"
                    style={{ pointerEvents: 'none', transition: 'all 120ms ease-out' }}
                  />
                  <circle r={r} cx={0} cy={1.5} fill={rim} style={{ pointerEvents: 'none' }} />
                  <circle r={r} fill={fill} stroke="none" />
                  <path
                    d={`M ${-r * 0.7} ${-r * 0.35} A ${r * 0.85} ${r * 0.85} 0 0 1 ${r * 0.7} ${-r * 0.35}`}
                    stroke="rgba(255,255,255,0.45)"
                    strokeWidth={1.5}
                    fill="none"
                    strokeLinecap="round"
                    style={{ pointerEvents: 'none' }}
                  />
                  <path
                    d={glyphPath}
                    stroke="#ffffff"
                    strokeWidth={3}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ pointerEvents: 'none' }}
                  />
                </g>
              </IconTooltip>
            </g>
          </g>
        );
      })()}
      {/* Quick-add chips — four plus buttons that appear on hover.
          Anchored to the four edges of the CARD (not the smaller avatar
          circle). When any chip is clicked, we force `hovered=false` so
          the chips disappear under the modal — otherwise they stay sticky
          if the user cancels the picker and moves the mouse away. */}
      {(hovered || isFocus) && !hideChips && !chevronHovered && (
        <g opacity={hovered ? 1 : 0.6} style={{ pointerEvents: 'all' }}>
          {/* Quick-add + chips overlap the card edge — half on, half
              off. Centring each chip exactly on the boundary keeps the
              hover hit-area tight to the card, looks intentional next
              to the corner badges, and stops the chips reading as
              free-floating dots in negative space. */}
          {canAddParent && (
            <QuickAddChip cx={0}                  cy={-CARD_H / 2} label="parent" tooltipSide="top" onClick={() => { setHovered(false); onQuickAddParent(); }} />
          )}
          <QuickAddChip cx={0}                  cy={ CARD_H / 2} label="child"  tooltipSide="bottom" onClick={() => { setHovered(false); onQuickAddChild(); }} />
          {/* Same-generation +chip on either side of the card. Tap
              opens a modal asking Partner vs Sibling — the previous
              SVG-inside-the-canvas popup felt out-of-place against the
              rest of the app's modal-based decision flow. */}
          {/* Choice order + primary swaps based on whether the person
              already has a current partner: with one on file, Sibling
              is the more likely follow-up so it sits ON TOP and gets
              the lavender primary CTA. Without one, Partner leads. */}
          <QuickAddChip
            cx={-CARD_W / 2} cy={0} label="partner / sibling" tooltipSide="left"
            onClick={async () => {
              setHovered(false);
              const partnerChoice = { id: 'partner' as const, label: 'Partner', description: 'Married, together, or previously together.' };
              const siblingChoice = { id: 'sibling' as const, label: 'Sibling', description: 'Brother or sister.' };
              const choice = await promptChoice<'partner' | 'sibling'>({
                eyebrow: 'Add a relative',
                title: hasCurrentPartner ? 'Sibling or partner?' : 'Partner or sibling?',
                message: `Pick the relationship to add to ${node.fullName?.trim() || node.name?.trim() || 'this person'}.`,
                choices: hasCurrentPartner
                  ? [{ ...siblingChoice, primary: true }, partnerChoice]
                  : [{ ...partnerChoice, primary: true }, siblingChoice],
              });
              if (choice === 'partner') onQuickAddPartner();
              else if (choice === 'sibling') onQuickAddSibling();
            }}
          />
          <QuickAddChip
            cx={ CARD_W / 2} cy={0} label="partner / sibling" tooltipSide="right"
            onClick={async () => {
              setHovered(false);
              const partnerChoice = { id: 'partner' as const, label: 'Partner', description: 'Married, together, or previously together.' };
              const siblingChoice = { id: 'sibling' as const, label: 'Sibling', description: 'Brother or sister.' };
              const choice = await promptChoice<'partner' | 'sibling'>({
                eyebrow: 'Add a relative',
                title: hasCurrentPartner ? 'Sibling or partner?' : 'Partner or sibling?',
                message: `Pick the relationship to add to ${node.fullName?.trim() || node.name?.trim() || 'this person'}.`,
                choices: hasCurrentPartner
                  ? [{ ...siblingChoice, primary: true }, partnerChoice]
                  : [{ ...partnerChoice, primary: true }, siblingChoice],
              });
              if (choice === 'partner') onQuickAddPartner();
              else if (choice === 'sibling') onQuickAddSibling();
            }}
          />
        </g>
      )}
    </g>
  );
}

/** Native-SVG gender glyph rendered inside the top-right badge on each
 *  card. Replaces the Unicode ♂ / ♀ / ⚥ glyphs, which fall back to a
 *  thin-stroked symbol font on Windows that looks shaded and illegible
 *  when the Tree is zoomed out. Shapes are pure strokes so they stay
 *  crisp at any zoom level. */
function GenderGlyph({ gender, cx, cy }: { gender: PersonGender | null | undefined; cx: number; cy: number }) {
  const showArrow = gender === 'male' || gender === 'non_binary';
  const showCross = gender === 'female' || gender === 'non_binary';
  if (!showArrow && !showCross) return null;

  // Non-binary centres the circle on the badge and attaches both the
  // NE arrow AND the south cross. Male/female offset the circle so
  // the outgoing ornament (arrow up, cross down) has room to breathe
  // inside the 13-radius badge without clipping the edge.
  const isNB = gender === 'non_binary';
  const circleCx = cx + (isNB ? 0 : (showArrow ? -2 : 0));
  const circleCy = cy + (isNB ? 0 : (showArrow ? 2 : -2));
  const circleR = 4;

  // Arrow tip positioned just inside the badge perimeter (badge r=13
  // so ~7 from centre keeps the arrowhead clear of the white outline).
  const arrowTipX = cx + 7;
  const arrowTipY = cy - 7;
  // Arrow line starts at the 45°-NE edge of the circle.
  const arrowStartX = circleCx + circleR * 0.707;
  const arrowStartY = circleCy - circleR * 0.707;

  // Cross hangs directly below the circle.
  const crossTop = circleCy + circleR;
  const crossBottom = cy + 8;
  const crossMid = (crossTop + crossBottom) / 2 + 0.5;

  return (
    <g
      stroke="#111827"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      style={{ pointerEvents: 'none' }}
    >
      <circle cx={circleCx} cy={circleCy} r={circleR} />
      {showArrow && (
        <>
          <line x1={arrowStartX} y1={arrowStartY} x2={arrowTipX} y2={arrowTipY} />
          <polyline points={`${arrowTipX - 3.5},${arrowTipY} ${arrowTipX},${arrowTipY} ${arrowTipX},${arrowTipY + 3.5}`} />
        </>
      )}
      {showCross && (
        <>
          <line x1={circleCx} y1={crossTop} x2={circleCx} y2={crossBottom} />
          <line x1={circleCx - 3} y1={crossMid} x2={circleCx + 3} y2={crossMid} />
        </>
      )}
    </g>
  );
}

// Note: QuickAddChipMenu (an SVG-inside-the-canvas popup with
// Partner/Sibling rows) used to live here. It was replaced with a
// regular QuickAddChip that opens a promptChoice modal — same UX as
// every other relationship decision in the app, and it doesn't fight
// the canvas pan/zoom. The previous implementation broke when the
// user zoomed out (popup landed on the wrong side) and felt out of
// place against the rest of the modal-driven flow.

function QuickAddChip({ cx, cy, label, onClick, tooltipSide = 'bottom' }: {
  cx: number; cy: number; label: string;
  onClick: () => void;
  /** Which side of the chip Radix should anchor the tooltip. Each
   *  call site picks an anchor that points AWAY from the nearest
   *  card, so the label never overlaps a sibling tile. */
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
}) {
  const [hovered, setHovered] = useState(false);
  // Brand-lavender (#ad9eff = hsl(249 100% 81%) — same value as
  // --primary in index.css).
  const PRIMARY = '#ad9eff';
  const PRIMARY_DARK = '#8e7cf0';
  // Hover label uses the canonical IconTooltip / Radix
  // TooltipContent — same dark rounded pill the rest of PDR shows
  // for icon-only buttons. Renders via a portal so it always sits
  // above adjacent cards instead of being clipped by SVG draw
  // order. The chip itself stays as an SVG group; Radix wraps it
  // as a TooltipTrigger via Slot.
  return (
    <IconTooltip label={label} side={tooltipSide}>
      <g
        transform={`translate(${cx} ${cy})`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ cursor: 'pointer' }}
      >
        <circle r={12} fill={hovered ? PRIMARY : '#ffffff'} stroke={PRIMARY_DARK} strokeWidth={1.5} />
        <text y={5} textAnchor="middle" fontSize={16} fontWeight={600} fill={hovered ? '#ffffff' : PRIMARY_DARK} style={{ pointerEvents: 'none', fontFamily: 'Inter, system-ui, sans-serif' }}>+</text>
      </g>
    </IconTooltip>
  );
}

/** Stylised English bluebell: a small blue droop of three bell-shaped blooms on a green stem.
 *  Drawn in SVG so it scales crisply at any zoom level. */
function BluebellMarker({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g transform={`translate(${cx} ${cy})`}>
      {/* Stem */}
      <path d="M 0 0 Q 1 5 -1 10" stroke="#22c55e" strokeWidth={1} fill="none" />
      {/* Three bell blooms */}
      <path d="M -4 -2 Q -3 2 -1 1 Q -2 -1 -4 -2 Z" fill="#6366f1" />
      <path d="M  2 -1 Q  3 3  1 2 Q  0 0  2 -1 Z" fill="#4f46e5" />
      <path d="M -1  4 Q  0 8 -3 7 Q -3 5 -1  4 Z" fill="#3730a3" />
    </g>
  );
}

function formatLife(birth: string | null, death: string | null): string | null {
  // Royal-chart style: "1978 — Living" when alive, "1948 — 2022" when
  // deceased. Space-em-dash-space. When only a death year is known,
  // fall back to "d. 2022" since we've no start year to bracket with.
  const b = birth ? birth.slice(0, 4) : null;
  const d = death ? death.slice(0, 4) : null;
  if (!b && !d) return null;
  if (b && d) return `${b} — ${d}`;
  if (b) return `${b} — Living`;
  if (d) return `d. ${d}`;
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Right-click context menu
// ─────────────────────────────────────────────────────────────────

/**
 * Small inline editor anchored to a clicked edge. Lets the user change
 * since/until dates and remove just this one edge without opening the
 * full Set-Relationship modal. This is the "option 1" fast path.
 */
function EdgeQuickEditor({ edge, x, y, personNameLookup, onSaved, onClose }: {
  edge: FamilyGraphEdge;
  x: number; y: number;
  personNameLookup: (id: number) => string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [since, setSince] = useState(edge.since ?? '');
  const [until, setUntil] = useState(edge.until ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.edge-quick-editor')) return;
      onClose();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  const save = async () => {
    if (edge.id == null) return;
    setBusy(true);
    const r = await updateRelationship(edge.id, { since: since || null, until: until || null });
    setBusy(false);
    if (r.success) onSaved();
  };

  const remove = async () => {
    if (edge.id == null) return;
    if (!(await promptConfirm({
      title: 'Remove relationship?',
      message: 'This will remove only this one relationship. The people on either end are kept.',
      confirmLabel: 'Remove',
      danger: true,
    }))) return;
    setBusy(true);
    const r = await removeRelationship(edge.id);
    setBusy(false);
    if (r.success) onSaved();
  };

  // Human-readable summary of the edge.
  const a = personNameLookup(edge.aId);
  const b = personNameLookup(edge.bId);
  const summary =
    edge.type === 'parent_of' ? `${a} is parent of ${b}`
    : edge.type === 'spouse_of' ? `${a} & ${b} — partners`
    : edge.type === 'sibling_of' ? `${a} & ${b} — siblings${(edge.flags as any)?.half ? ' (half)' : (edge.flags as any)?.adopted ? ' (adopted)' : ''}`
    : edge.type === 'associated_with' ? `${a} & ${b} — ${(edge.flags as any)?.kind ?? 'connected'}`
    : '';

  // Only partner/spouse and associated_with meaningfully carry since/until.
  // parent_of and sibling_of show just Remove + the summary.
  const showDates = edge.type === 'spouse_of' || edge.type === 'associated_with';

  return (
    <div
      className="edge-quick-editor absolute z-30 bg-popover border border-border rounded-xl shadow-2xl p-3 min-w-[260px]"
      style={{ left: x, top: y, transform: 'translate(-50%, -50%)' }}
    >
      <div className="flex items-center gap-2 mb-2">
        <Pencil className="w-3.5 h-3.5 text-primary" />
        <span className="text-sm font-medium">{summary}</span>
      </div>
      {showDates && (
        <div className="flex flex-col gap-2 mb-2">
          <DateTripleInput label="Since (optional)" value={since} onChange={setSince} />
          <DateTripleInput label="Until (optional)" value={until} onChange={setUntil}
            hint="Set to mark as ex-partner / deceased." />
        </div>
      )}
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={remove}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-50"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Remove
        </button>
        <div className="flex-1" />
        <button onClick={onClose} className="px-2.5 py-1.5 rounded-lg text-xs hover:bg-accent">
          Cancel
        </button>
        {showDates && (
          <button
            onClick={save}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 hover:bg-primary/90"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </div>
  );
}

function NodeContextMenu({ x, y, isFocus, hasCardBackground, ancestryHidden, canHideAncestry, onSetRelationship, onEditRelationships, onRefocus, onRemovePerson, onSetCardBackground, onClearCardBackground, onToggleAncestry, onClose }: {
  x: number; y: number;
  personId: number;
  isFocus: boolean;
  hasCardBackground: boolean;
  ancestryHidden: boolean;
  canHideAncestry: boolean;
  onSetRelationship: () => void;
  onEditRelationships: () => void;
  onRefocus: () => void;
  onRemovePerson: () => void;
  onSetCardBackground: () => void;
  onClearCardBackground: () => void;
  onToggleAncestry: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [onClose]);

  return (
    <div
      className="absolute z-20 bg-popover border border-border rounded-lg shadow-xl py-1 min-w-[240px]"
      style={{ left: x, top: y }}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => e.preventDefault()}
    >
      {!isFocus && (
        <>
          <MenuItem icon={<Eye className="w-4 h-4" />} label="Focus on this person" onClick={onRefocus} />
          <div className="border-t border-border my-1" />
        </>
      )}
      <MenuItem icon={<Link2 className="w-4 h-4" />} label="Set relationship…" onClick={onSetRelationship} />
      <MenuItem icon={<Pencil className="w-4 h-4" />} label="Edit relationships…" onClick={onEditRelationships} />
      {canHideAncestry && (
        <>
          <div className="border-t border-border my-1" />
          <MenuItem
            icon={<EyeOff className="w-4 h-4" />}
            label={ancestryHidden ? "Show this person's ancestry" : "Hide this person's ancestry"}
            onClick={onToggleAncestry}
          />
        </>
      )}
      <div className="border-t border-border my-1" />
      <MenuItem icon={<ImageIcon className="w-4 h-4" />} label={hasCardBackground ? 'Change card background…' : 'Set card background…'} onClick={onSetCardBackground} />
      {hasCardBackground && (
        <MenuItem icon={<X className="w-4 h-4" />} label="Clear card background" onClick={onClearCardBackground} />
      )}
      <div className="border-t border-border my-1" />
      <MenuItem icon={<Trash2 className="w-4 h-4" />} label="Unlink from the tree" onClick={onRemovePerson} danger />
      {/* Deliberately NOT offering "Delete person" here — deleting a
          person in People Manager happens there, not as a Trees side-
          effect. Trees only manages relationships. */}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left ${danger ? 'text-red-500 hover:bg-red-500/10' : 'hover:bg-accent'}`}
    >
      {icon}
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────
// Placeholder (ghost) node + resolver
// ─────────────────────────────────────────────────────────────────

/** Faded dashed circle with a "?" icon — stands in for an unnamed
 *  intermediate person. Clicking opens the resolver to name or link. */
function PlaceholderNode({ node, opacity, onClick, onMouseDown, isOnBloodline = true }: {
  node: LaidOutNode & { renderedX: number; renderedY: number };
  opacity: number;
  onClick: (e: React.MouseEvent) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  /** Inherited bloodline status of the CHILD this ghost is parent of.
   *  Bloodline child → render in brand purple (the ghost is a
   *  bloodline ancestor). Non-bloodline child → render in brand
   *  orange (the ghost is in-law / extended family territory).
   *  Visual is the REVERSE of the expand-chevron buttons: white
   *  fill, coloured stroke, coloured chevron — so the two surfaces
   *  read as "click to populate" (placeholder) vs "click to
   *  reveal/hide" (chevron button). */
  isOnBloodline?: boolean;
}) {
  const r = 14;
  // Brand palette: lavender for bloodline (ghost above a blood
  // relative), orange for non-bloodline (ghost above an in-law).
  // Slightly darker variants of the brand fills so the stroke reads
  // crisp against white.
  const stroke = isOnBloodline ? '#8e7cf0' : '#f59e0b';
  return (
    <g
      transform={`translate(${node.renderedX} ${node.renderedY})`}
      opacity={opacity}
      style={{ cursor: 'pointer' }}
      onClick={onClick}
      onMouseDown={onMouseDown}
    >
      <IconTooltip label="Click to name or link this person" side="top">
        <g>
          {/* Solid white fill so every pixel inside is clickable —
              avoids the SVG hollow-stroke dead-zone. */}
          <circle r={r} fill="#ffffff" stroke={stroke} strokeWidth={1.5} />
          <path
            d="M -6 2 L 0 -4 L 6 2"
            stroke={stroke}
            strokeWidth={2.2}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ pointerEvents: 'none' }}
          />
        </g>
      </IconTooltip>
    </g>
  );
}

/** Convert a relationship-edge label ("parent of") into the noun
 *  form used in the natural-sentence placeholder prompt ("Select X's
 *  parent"). Mirrors the verb→noun mapping for spouse / sibling /
 *  connected-to slots; falls back to "relation" for unknown labels. */
function roleSuffix(label: string): string {
  const lower = label.trim().toLowerCase();
  if (lower === 'parent of') return 'parent';
  if (lower === 'child of') return 'child';
  if (lower === 'partner of') return 'partner';
  if (lower === 'ex-partner of') return 'former partner';
  if (lower === 'sibling of') return 'sibling';
  if (lower === 'connected to') return 'connection';
  return 'relation';
}

/** Inline popup: "Who is this?" — lets user name, link, or remove a
 *  placeholder. Runs in TWO modes:
 *    personId (persisted placeholder): edits a real DB row. Name →
 *      namePlaceholder; Link → mergePlaceholderIntoPerson; Remove →
 *      removePlaceholder.
 *    virtualChildId (virtual ghost, not yet materialised): no DB row
 *      exists yet. Name → createNamedPerson + addRelationship to the
 *      virtual child; Link → addRelationship between the chosen person
 *      and the virtual child directly; Cancel/close → NOTHING persists.
 *      This stops accidental 'Unknown' rows from piling up every time
 *      the user opens + dismisses the popup without committing. */
function PlaceholderResolver({ personId, virtualChildIds, x, y, onResolved, onClose, peopleAlreadyInTree, excludedSuggestionIds, hiddenSuggestions, onHideSuggestion, onUnhideSuggestion, nameConflictLookup, onParentResolved }: {
  personId: number | null;
  /** When this placeholder is a virtual ghost, the IDs of ALL children
   *  the ghost parents. A shared ghost across a sibling group must fill
   *  every sibling on save — otherwise naming the "missing mother"
   *  silently demotes full siblings to half siblings. */
  virtualChildIds: number[] | null;
  x: number; y: number;
  onResolved: () => void;
  onClose: () => void;
  /** Person IDs already placed somewhere in the current tree. These
   *  are excluded from the "Link to existing" suggestion list — if
   *  they're already named and visible, offering them again would
   *  just let the user create a duplicate link or a self-reference. */
  peopleAlreadyInTree?: Set<number>;
  /** Per-tree user-flagged "not part of this family" list. Applied here
   *  so hides performed in the quick-add picker (+ modal) also take
   *  effect in this popover — and vice-versa. */
  excludedSuggestionIds?: Set<number>;
  /** Hidden persons for the review panel, surfaced under the
   *  suggestion list so mistakes can be reversed. */
  hiddenSuggestions?: { id: number; name: string }[];
  onHideSuggestion?: (personId: number) => void | Promise<void>;
  onUnhideSuggestion?: (personId: number) => void | Promise<void>;
  /** Returns matching-name person if one already exists on this tree,
   *  so the "Name them" flow can warn before silently creating a
   *  duplicate (the root cause of the double-Dorothy bug). */
  nameConflictLookup?: (name: string) => { id: number; name: string } | null;
  /** Fired after the placeholder is resolved (named or linked) for
   *  each parent_of relationship the placeholder was filling. The
   *  parent component uses this to fire the marriage / partner-status
   *  prompt — the resolver itself doesn't own that flow. */
  onParentResolved?: (parentId: number, childId: number) => Promise<void>;
}) {
  const isVirtual = personId == null && virtualChildIds != null && virtualChildIds.length > 0;
  // Single-flow picker — no more tab switcher. The input below does
  // double duty: filters existing people as the user types AND feeds
  // the "+ Add X to PDR" create row when the query doesn't match.
  const [linkQuery, setLinkQuery] = useState('');
  const [allPersons, setAllPersons] = useState<{ id: number; name: string; photoCount: number }[]>([]);
  const [selectedLinkId, setSelectedLinkId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shared drag hook — clamps so the header stays on-screen.
  const { modalRef, dragHandleProps } = useDraggableModal();
  /** Relationships this placeholder already holds — shown up-top so the
   *  user knows WHAT this "?" represents before naming/linking. Answers
   *  the common confusion "why is there an extra placeholder?" — at a
   *  glance you see e.g. "Currently: parent of Nee". `otherId` is
   *  carried so post-resolve handlers (the marriage prompt) can fire
   *  per-relationship without a second SQL query. */
  const [relationships, setRelationships] = useState<{ label: string; otherName: string; otherId: number; type: 'parent_of' | 'child_of' | 'spouse_of' | 'sibling_of' | 'associated_with' }[]>([]);

  useEffect(() => {
    (async () => {
      const res = await listPersons();
      if (res.success && res.data) setAllPersons(res.data.map(p => ({
        id: p.id, name: p.name, photoCount: p.photo_count ?? 0,
      })));
    })();
  }, []);

  // Also load this placeholder's own relationships so the modal can
  // tell the user what role this '?' currently plays. For VIRTUAL ghosts
  // the "role" is implied from the virtual edge — they're going to be
  // the parent of whoever virtualChildId is.
  useEffect(() => {
    (async () => {
      const personsRes = await listPersons();
      // Prefer FULL name in this label so it reads unambiguously
      // ("parent of Sally Anne Clapson" vs "parent of Mum"). Falls
      // back to short name when no full name is on file.
      const nameBy = new Map<number, string>();
      if (personsRes.success && personsRes.data) {
        for (const p of personsRes.data) {
          const full = p.full_name?.trim();
          nameBy.set(p.id, full || p.name || '(unnamed)');
        }
      }
      if (isVirtual) {
        if (virtualChildIds != null && virtualChildIds.length > 0) {
          // One "parent of X" line per child the ghost represents, so
          // the user sees every sibling this fill-in will parent.
          setRelationships(virtualChildIds.map(id => ({
            label: 'parent of',
            otherName: nameBy.get(id) ?? '(unknown)',
            otherId: id,
            type: 'parent_of' as const,
          })));
        }
        return;
      }
      if (personId == null) return;
      const relRes = await listRelationshipsForPerson(personId);
      if (!relRes.success || !relRes.data) return;
      const out: { label: string; otherName: string; otherId: number; type: 'parent_of' | 'child_of' | 'spouse_of' | 'sibling_of' | 'associated_with' }[] = [];
      for (const r of relRes.data) {
        const aIsMe = r.person_a_id === personId;
        const otherId = aIsMe ? r.person_b_id : r.person_a_id;
        const otherName = nameBy.get(otherId) ?? '(unknown)';
        if (r.type === 'parent_of') out.push({ label: aIsMe ? 'parent of' : 'child of', otherName, otherId, type: aIsMe ? 'parent_of' : 'child_of' });
        else if (r.type === 'spouse_of') out.push({ label: r.until ? 'ex-partner of' : 'partner of', otherName, otherId, type: 'spouse_of' });
        else if (r.type === 'sibling_of') out.push({ label: 'sibling of', otherName, otherId, type: 'sibling_of' });
        else if (r.type === 'associated_with') out.push({ label: 'connected to', otherName, otherId, type: 'associated_with' });
      }
      setRelationships(out);
    })();
  }, [personId, virtualChildIds, isVirtual]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.placeholder-resolver')) return;
      onClose();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  const filtered = allPersons
    .filter(p => !p.name.startsWith('__'))
    // Exclude anyone already placed elsewhere in the current tree —
    // suggesting them would only create a duplicate link or the user
    // would mistakenly map one person to two slots. The placeholder
    // being resolved is ALSO in this set when it's persisted; that's
    // fine because it's an Unknown (empty name) and already excluded
    // by the name filter above.
    .filter(p => !peopleAlreadyInTree?.has(p.id))
    // Per-tree "not in this family" exclusions. Shared with the
    // quick-add picker (+ modal) so hides in either surface propagate
    // across every picker in the tree.
    .filter(p => !excludedSuggestionIds?.has(p.id))
    .filter(p => p.name.toLowerCase().includes(linkQuery.trim().toLowerCase()))
    // Sort by photo count DESC — the more likely match surfaces first.
    // Tiebreak alphabetical.
    .sort((a, b) => (b.photoCount - a.photoCount) || a.name.localeCompare(b.name));

  // "+ Add X to PDR" create-row gating. Appears when the user has typed
  // a query that doesn't exactly match anyone in the filtered list.
  const trimmedLinkQuery = linkQuery.trim();
  const hasExactMatch = trimmedLinkQuery.length > 0 && filtered.some(
    p => p.name.trim().toLowerCase() === trimmedLinkQuery.toLowerCase()
  );
  const showCreateRow = trimmedLinkQuery.length > 0 && !hasExactMatch && !busy;

  const handleName = async (rawName: string) => {
    setError(null);
    const trimmed = rawName.trim();
    if (!trimmed) { setError('Type a name.'); return; }
    // Namesake guard — same as the + picker. Without this, typing an
    // existing tree member's name here silently creates a second
    // person with the same name (the root cause of the double-Dorothy
    // bug from earlier). Only guard the virtual-ghost path (which
    // creates a NEW person); the persisted path just renames an
    // existing placeholder, so duplication isn't possible there.
    if (isVirtual && nameConflictLookup) {
      const conflict = nameConflictLookup(trimmed);
      if (conflict) {
        const proceed = await promptConfirm({
          title: `"${conflict.name}" is already on this tree`,
          message: `Someone named "${conflict.name}" already exists on your tree. Creating a new person here will add a second person with the same name — only do this if they're genuinely different people who happen to share a name.`,
          confirmLabel: `Yes, create another "${trimmed}"`,
          cancelLabel: 'Cancel',
        });
        if (!proceed) return;
      }
    }
    setBusy(true);
    try {
      if (isVirtual && virtualChildIds != null && virtualChildIds.length > 0) {
        // Virtual mode: create a named person and wire a parent_of edge
        // for EVERY child the ghost represented. Shared ghosts across
        // sibling groups must complete every sibling — otherwise a full
        // sibling group silently degrades to half siblings on save.
        const np = await createNamedPerson(trimmed);
        if (!np.success || np.data == null) { setError(np.error ?? 'Could not create person.'); return; }
        for (const childId of virtualChildIds) {
          const r = await addRelationship({ personAId: np.data, personBId: childId, type: 'parent_of' });
          if (!r.success) { setError(r.error ?? 'Could not save.'); return; }
        }
        // Fire the post-resolve callback for each parent_of edge we
        // just wrote — the parent component uses this to ask the
        // marriage / partner-status question once a child reaches
        // its second parent.
        if (onParentResolved) {
          for (const childId of virtualChildIds) await onParentResolved(np.data, childId);
        }
        onResolved();
        return;
      }
      if (personId == null) return;
      const r = await namePlaceholder(personId, trimmed);
      if (r.success) {
        // Persisted-placeholder rename keeps the placeholder's
        // person_id, so its existing parent_of edges already point
        // at the right children. Fire the callback for each.
        if (onParentResolved) {
          for (const rel of relationships) {
            if (rel.type === 'parent_of') await onParentResolved(personId, rel.otherId);
          }
        }
        onResolved();
      } else setError(r.error ?? 'Could not save.');
    } catch (err) {
      setError((err as Error)?.message ?? 'Unexpected error while saving.');
    } finally {
      setBusy(false);
    }
  };

  const handleLink = async (targetId: number) => {
    setError(null);
    setBusy(true);
    try {
      if (isVirtual && virtualChildIds != null && virtualChildIds.length > 0) {
        // Virtual mode: add a parent_of edge from the chosen person to
        // EVERY child the ghost represented — same rule as naming,
        // preserves full-sibling status across the group.
        for (const childId of virtualChildIds) {
          const r = await addRelationship({ personAId: targetId, personBId: childId, type: 'parent_of' });
          if (!r.success) { setError(r.error ?? 'Could not link.'); return; }
        }
        if (onParentResolved) {
          for (const childId of virtualChildIds) await onParentResolved(targetId, childId);
        }
        onResolved();
        return;
      }
      if (personId == null) return;
      const r = await mergePlaceholderIntoPerson(personId, targetId);
      if (r.success) {
        // Merge: the placeholder's parent_of edges have been
        // re-pointed at `targetId`. Fire the callback per edge so
        // the parent component can ask the marriage prompt.
        if (onParentResolved) {
          for (const rel of relationships) {
            if (rel.type === 'parent_of') await onParentResolved(targetId, rel.otherId);
          }
        }
        onResolved();
      } else setError(r.error ?? 'Could not link.');
    } catch (err) {
      setError((err as Error)?.message ?? 'Unexpected error while linking.');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (isVirtual || personId == null) {
      // Virtual ghost has no persisted state; just dismiss.
      onClose();
      return;
    }
    if (!(await promptConfirm({
      title: 'Remove placeholder?',
      message: 'Relationships that flowed through this unnamed person (e.g. grandparent links) will be broken.',
      confirmLabel: 'Remove',
      danger: true,
    }))) return;
    setBusy(true);
    const r = await removePlaceholder(personId);
    setBusy(false);
    if (r.success) onResolved();
    else setError(r.error ?? 'Could not remove.');
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        className="placeholder-resolver bg-popover border border-border rounded-xl shadow-2xl p-4 w-[28rem] max-w-[90vw]"
        onClick={e => e.stopPropagation()}
      >
      <div
        {...dragHandleProps}
        className={`flex items-center gap-2 mb-3 ${dragHandleProps.className}`}
      >
        <Move className="w-3 h-3 text-muted-foreground/60 shrink-0" aria-hidden />
        <HelpCircle className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Who is this?</span>
        <div className="flex-1" />
        <button onClick={onClose} className="p-0.5 rounded hover:bg-accent">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tell the user what this placeholder currently represents
          using a natural sentence: "Select Sally Anne Clapson's
          parent." Falls back to a list when the placeholder fills
          multiple roles (rare). */}
      {relationships.length > 0 && (
        <div className="mb-3 px-2.5 py-2 rounded-lg bg-muted/40 border border-border/60">
          {relationships.length === 1 ? (
            <p className="text-sm text-foreground">
              Select <strong>{relationships[0].otherName}</strong>'s {roleSuffix(relationships[0].label)}
            </p>
          ) : (
            <>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">Filling slot for</p>
              <ul className="text-xs text-foreground space-y-0.5">
                {relationships.map((r, i) => (
                  <li key={i}>{r.label} <strong>{r.otherName}</strong></li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* Single-flow picker — type to search existing people; if the
          query doesn't match anyone, a "+ Add X to PDR" create row
          appears at the bottom of the list. Replaces the older
          Link-to-existing / Name-them tab split which forced the user
          to pick a mode before typing. */}
      <div>
        <input
          type="text"
          autoFocus
          value={linkQuery}
          onChange={e => { setLinkQuery(e.target.value); setSelectedLinkId(null); }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const typed = linkQuery.trim();
              const exact = filtered.find(p => p.name.trim().toLowerCase() === typed.toLowerCase());
              if (exact) setSelectedLinkId(exact.id);
              else if (filtered.length === 1) setSelectedLinkId(filtered[0].id);
              else if (typed.length > 0) handleName(typed);
            }
          }}
          placeholder="Search or type a new name…"
          className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-sm"
        />
        <div className="mt-2 max-h-40 overflow-auto flex flex-col gap-0.5 border border-border rounded p-0.5">
          {filtered.length === 0 && !showCreateRow && (
            <p className="text-xs text-muted-foreground text-center py-2">No matches.</p>
          )}
          {filtered.map(p => {
            const isSelected = selectedLinkId === p.id;
            return (
              <div
                key={p.id}
                className={`group flex items-center gap-1 px-2 py-1.5 rounded text-sm ${
                  isSelected ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-accent'
                } ${busy ? 'opacity-70' : ''}`}
              >
                <button
                  onClick={() => !busy && setSelectedLinkId(p.id)}
                  disabled={busy}
                  className="flex-1 min-w-0 flex items-center gap-2 text-left"
                >
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className={`text-[10px] shrink-0 ${isSelected ? 'text-primary/80' : 'text-muted-foreground'}`}>
                    {p.photoCount} {p.photoCount === 1 ? 'photo' : 'photos'}
                  </span>
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
              onClick={() => handleName(linkQuery.trim())}
              disabled={busy}
              className="flex items-start gap-2 px-2 py-1.5 rounded text-sm text-left text-foreground hover:bg-primary/10 border-t border-dashed border-border/60 mt-0.5 pt-2 disabled:opacity-50"
            >
              {/* Body in text-foreground (defined tier) so the row
                  reads at full contrast on white. Lavender stays on
                  the icon + hover bg only. */}
              <UserPlus className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary" />
              <span className="leading-snug whitespace-normal break-words">
                Add <strong>{linkQuery.trim()}</strong> as a new person — they aren't on PDR yet.
              </span>
            </button>
          )}
        </div>
        {hiddenSuggestions && onUnhideSuggestion && (
          <HiddenSuggestionsReview hidden={hiddenSuggestions} onUnhide={onUnhideSuggestion} />
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {selectedLinkId != null
            ? 'Click Done to turn this placeholder into the selected person. All relationships on the placeholder transfer to them.'
            : showCreateRow
            ? 'Click Done (or press Enter) to add this person to PDR.'
            : 'Click a name to link this placeholder to them, or type a new name to create a new person.'}
        </p>
      </div>

      {error && (
        <div className="mt-2 text-xs text-red-600">{error}</div>
      )}

      <div className="flex items-center gap-2 mt-3 pt-2 border-t border-border">
        {!isVirtual && (
          <button
            onClick={handleRemove}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" />
            Remove placeholder
          </button>
        )}
        <div className="flex-1" />
        {/* Done commits whichever path the user has set up:
            - selectedLinkId set → merge placeholder into that person
            - typed query with no match → create new person (same as
              clicking the "+ Add X to PDR" row inline)
            - neither → disabled */}
        <button
          onClick={() => {
            if (selectedLinkId != null) handleLink(selectedLinkId);
            else if (showCreateRow) handleName(linkQuery.trim());
          }}
          disabled={busy || (selectedLinkId == null && !showCreateRow)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 hover:bg-primary/90"
        >
          {busy ? (selectedLinkId != null ? 'Linking…' : 'Adding…') : 'Done'}
        </button>
      </div>
      </div>
    </div>
  );
}
