import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { Link2, Trash2, Eye, EyeOff, Pencil, HelpCircle, UserPlus, X, Image as ImageIcon } from 'lucide-react';
import { getFaceCrop, updateRelationship, removeRelationship, namePlaceholder, mergePlaceholderIntoPerson, removePlaceholder, listPersons, listRelationshipsForPerson, createPlaceholderPerson, createNamedPerson, addRelationship, setPersonCardBackground, type FamilyGraphEdge } from '@/lib/electron-bridge';
import type { TreeLayout, LaidOutNode, LaidOutEdge } from '@/lib/trees-layout';
import { DateTripleInput } from './DateTripleInput';
import { promptConfirm } from './promptConfirm';
import { computeRelationshipLabels } from '@/lib/relationship-label';
import { GenderPickerModal, genderMarkerSymbol } from './GenderPickerModal';
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

export function TreesCanvas({ layout, onRefocus, onSetRelationship, onEditRelationships, onRemovePerson, onQuickAddParent, onQuickAddPartner, onQuickAddChild, onQuickAddSibling, hideQuickAddChips, showDates, onEditDates, onGraphMutated, canvasBackground, canvasBackgroundOpacity = 0.15, treeContrast = 0.3, useGenderedLabels = false, hideGenderMarker = false, hiddenAncestorPersonIds, onToggleHiddenAncestor, onRequestCardBackgroundPick, allReachablePersonIds }: TreesCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ tx: 0, ty: 0, scale: 1 });
  const [avatars, setAvatars] = useState<Map<number, string>>(new Map());
  const [contextMenu, setContextMenu] = useState<{ personId: number; x: number; y: number } | null>(null);
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
    };
    const onUp = () => {
      panState.current.active = false;
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
    const name = layout.nodes.find(n => n.personId === personId)?.name ?? 'this person';
    onRequestCardBackgroundPick(personId, name);
  }, [onRequestCardBackgroundPick, layout.nodes]);

  const clearCardBackgroundFor = useCallback(async (personId: number) => {
    await setPersonCardBackground(personId, null);
    onGraphMutated();
  }, [onGraphMutated]);

  // Rendered positions come straight from the deterministic layout;
  // there are no per-node offsets since individual dragging is disabled.
  const placedNodes = useMemo(() => layout.nodes.map(n => ({
    ...n, renderedX: n.x, renderedY: n.y,
  })), [layout.nodes]);

  const nodeById = useMemo(() => {
    const m = new Map<number, typeof placedNodes[0]>();
    for (const n of placedNodes) m.set(n.personId, n);
    return m;
  }, [placedNodes]);

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
    );
  }, [layout.focusPersonId, layout.edges, layout.nodes, useGenderedLabels]);

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
      <svg
        ref={svgRef}
        data-tree-canvas="true"
        className={`w-full h-full cursor-grab active:cursor-grabbing ${canvasBackground ? '' : 'bg-[radial-gradient(circle,_rgba(167,139,250,0.06)_1px,_transparent_1px)] [background-size:24px_24px]'}`}
        onWheel={handleWheel}
        onMouseDown={handlePanStart}
        onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
      >
        <g transform={`translate(${viewport.tx} ${viewport.ty}) scale(${viewport.scale})`}>
          {/* Pedigree family groups — one marriage bar + sibling bracket
              per parent-set. Drawn BEFORE individual edges so they sit
              underneath the nodes. */}
          {familyGroups.map((group, i) => {
            // Are the parents married (stored spouse_of between any of
            // them)? If yes, EdgeLine draws the partnership connector —
            // we skip our own marriage bar to avoid duplicate overlap.
            const hasStoredSpouse = layout.edges.some(e =>
              e.type === 'spouse_of' && !e.derived
              && group.parentIds.includes(e.aId) && group.parentIds.includes(e.bId)
            );
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
            const avatar = avatars.get(node.personId);
            const isFocus = node.personId === layout.focusPersonId;
            const dimOpacity = Math.max(0.5, 1 - node.hopsFromFocus * 0.1);
            if (node.isPlaceholder) {
              return (
                <PlaceholderNode
                  key={node.personId}
                  node={node}
                  opacity={dimOpacity}
                  onClick={(e) => handleNodeClick(e, node)}
                  onMouseDown={(e) => handleNodeMouseDown(e, node)}
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
                canAddParent={(node.totalParentCount ?? 0) < 2}
              />
            );
          })}
        </g>

        {/* Fixed overlay: zoom indicator */}
        <g>
          <rect x={12} y={12} rx={6} ry={6} width={56} height={22} fill="rgba(0,0,0,0.45)" />
          <text x={40} y={27} textAnchor="middle" fontSize={12} fill="#fff">
            {Math.round(viewport.scale * 100)}%
          </text>
        </g>
      </svg>

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
          peopleAlreadyInTree={allReachablePersonIds ?? new Set(
            // Fallback to laid-out nodes only if the parent didn't
            // supply the full reachable set. Prefer the parent's set
            // because it includes people who are currently hidden by
            // Steps or hide-ancestry — they're still "in the tree"
            // and shouldn't be re-offered as link targets.
            layout.nodes
              .filter(n => !n.isPlaceholder && n.personId > 0)
              .map(n => n.personId),
          )}
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
function FamilyGroup({ parents, children, parentsAreSpouses, bracketOffset, onParentClick, contrast = 0.3 }: {
  parents: (LaidOutNode & { renderedX: number; renderedY: number; isPlaceholder: boolean })[];
  children: (LaidOutNode & { renderedX: number; renderedY: number })[];
  /** True when a stored spouse_of edge exists between parents. In that
   *  case the partnership line is drawn by EdgeLine, so we skip our
   *  own marriage bar to avoid duplicate overlap. */
  parentsAreSpouses: boolean;
  bracketOffset: number;
  onParentClick: (parentId: number) => void;
  contrast?: number;
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

  // Bracket geometry. Two cases:
  //   • SINGLE child — extend the bracket horizontally to include the
  //     marriage midpoint, so the drop comes straight down from
  //     between the two parents and bends via a mini-bracket to the
  //     child's column. This produces the classic pedigree "T with
  //     shoulder" look: midpoint centered, child offset to one side.
  //   • MULTI child — clamp the drop to the children's range so the
  //     bracket never extends past unrelated cards (otherwise a
  //     spouse's parents laid out with a wide midpoint could paint
  //     the bracket horizontal across a non-child's column). A short
  //     connector at parentY bridges the midpoint to the drop column
  //     in that edge case.
  const childXs = children.map(c => c.renderedX).sort((a, b) => a - b);
  const childMinX = childXs[0];
  const childMaxX = childXs[childXs.length - 1];
  const isSingleChild = childMinX === childMaxX;
  const bracketStart = isSingleChild ? Math.min(childMinX, marriageBarMidX) : childMinX;
  const bracketEnd   = isSingleChild ? Math.max(childMaxX, marriageBarMidX) : childMaxX;
  const dropAnchorX = isSingleChild
    ? marriageBarMidX
    : Math.max(childMinX, Math.min(childMaxX, marriageBarMidX));
  const needsConnector = !isSingleChild && Math.abs(dropAnchorX - marriageBarMidX) > 0.5;

  // Stroke darkens + thickens with contrast so the family scaffolding
  // (marriage bar, bracket, child drops) reads clearly against busy
  // backgrounds. Halo is a wider white underlay drawn first.
  const strokeBase = '#64748b';
  const strokeDark = '#1f2937';
  const stroke = contrast > 0.5 ? strokeDark : strokeBase;
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

function PersonNode({ node, avatar, isFocus, opacity, hideChips, showDates, onEditDates, onMouseDown, onDoubleClick, onContextMenu, onQuickAddParent, onQuickAddPartner, onQuickAddChild, onQuickAddSibling, contrast = 0.3, relationshipLabel, hideGenderMarker, onOpenGenderPicker, canAddParent = true }: {
  node: LaidOutNode & { renderedX: number; renderedY: number };
  avatar: string | undefined;
  isFocus: boolean;
  opacity: number;
  hideChips?: boolean;
  showDates?: boolean;
  onEditDates?: (screenX: number, screenY: number) => void;
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
}) {
  const [hovered, setHovered] = useState(false);
  const ringColor = isFocus ? '#f59e0b' : '#6366f1';
  const initials = initialsOf(node.name);
  const bgColor = colorFromId(node.personId);
  const lifeLine = formatLife(node.birthDate, node.deathDate);
  const isDeceased = !!node.deathDate;
  const displayName = node.name.length > 22 ? node.name.slice(0, 20) + '…' : node.name;

  return (
    <g
      transform={`translate(${node.renderedX} ${node.renderedY})`}
      opacity={opacity}
      style={{ cursor: 'default' }}
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
      {/* Focus halo — slightly larger card outline behind */}
      {isFocus && (
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
        stroke={isFocus ? ringColor : `rgba(0,0,0,${0.08 + 0.35 * contrast})`}
        strokeWidth={isFocus ? 2 : 1 + contrast}
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
      {/* Name — centred below avatar, always visible, dark text */}
      <text x={0} y={AVATAR_CY + AVATAR_R + AVATAR_TO_NAME} textAnchor="middle" fontSize={13} fontWeight={600} fill="#1f2937">
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
        return (
          <g style={{ pointerEvents: 'none' }}>
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
        return (
          <g
            style={{ cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); onOpenGenderPicker(); }}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
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
      {/* Quick-add chips — four plus buttons that appear on hover.
          Anchored to the four edges of the CARD (not the smaller avatar
          circle). When any chip is clicked, we force `hovered=false` so
          the chips disappear under the modal — otherwise they stay sticky
          if the user cancels the picker and moves the mouse away. */}
      {(hovered || isFocus) && !hideChips && (
        <g opacity={hovered ? 1 : 0.6} style={{ pointerEvents: 'all' }}>
          {canAddParent && (
            <QuickAddChip cx={0}                  cy={-CARD_H / 2 - 16} label="parent" onClick={() => { setHovered(false); onQuickAddParent(); }} />
          )}
          <QuickAddChip cx={0}                  cy={ CARD_H / 2 + 16} label="child"  onClick={() => { setHovered(false); onQuickAddChild(); }} />
          <QuickAddChipMenu
            cx={-CARD_W / 2 - 20} cy={0} label="partner / sibling"
            onPartner={() => { setHovered(false); onQuickAddPartner(); }}
            onSibling={() => { setHovered(false); onQuickAddSibling(); }}
          />
          <QuickAddChipMenu
            cx={ CARD_W / 2 + 20} cy={0} label="partner / sibling"
            onPartner={() => { setHovered(false); onQuickAddPartner(); }}
            onSibling={() => { setHovered(false); onQuickAddSibling(); }}
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

/** Sideways chip that opens a small menu instead of firing a single
 *  action — used for same-generation adds so the user can pick Partner
 *  or Sibling without caring which side the chip is on. */
function QuickAddChipMenu({ cx, cy, label, onPartner, onSibling }: {
  cx: number; cy: number; label: string;
  onPartner: () => void;
  onSibling: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Close menu if user clicks outside this chip.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      const target = e.target as SVGElement;
      if (target.closest(`[data-chip-id="${cx}-${cy}"]`)) return;
      setMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuOpen, cx, cy]);

  return (
    <g
      transform={`translate(${cx} ${cy})`}
      data-chip-id={`${cx}-${cy}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ cursor: 'pointer' }}
    >
      <circle
        r={12}
        fill={hovered || menuOpen ? '#6366f1' : '#ffffff'}
        stroke="#6366f1"
        strokeWidth={1.5}
        onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}
      />
      <text y={4} textAnchor="middle" fontSize={16} fontWeight={600}
        fill={hovered || menuOpen ? '#ffffff' : '#6366f1'}
        style={{ pointerEvents: 'none' }}>+</text>
      {hovered && !menuOpen && (
        <g>
          <rect x={-48} y={14} width={96} height={16} rx={3} fill="rgba(0,0,0,0.8)" />
          <text y={26} textAnchor="middle" fontSize={10} fill="#ffffff"
            style={{ pointerEvents: 'none' }}>{label}</text>
        </g>
      )}
      {menuOpen && (
        <g transform="translate(0 18)">
          <rect x={-52} y={0} width={104} height={52} rx={6}
            fill="#ffffff" stroke="#6366f1" strokeWidth={1} />
          <g onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onPartner(); }}
             style={{ cursor: 'pointer' }}>
            <rect x={-50} y={2} width={100} height={22} fill="transparent" />
            <text x={0} y={17} textAnchor="middle" fontSize={12} fill="#1f2937">Partner / spouse</text>
          </g>
          <line x1={-50} y1={26} x2={50} y2={26} stroke="#e5e7eb" strokeWidth={1} />
          <g onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onSibling(); }}
             style={{ cursor: 'pointer' }}>
            <rect x={-50} y={28} width={100} height={22} fill="transparent" />
            <text x={0} y={43} textAnchor="middle" fontSize={12} fill="#1f2937">Sibling</text>
          </g>
        </g>
      )}
    </g>
  );
}

function QuickAddChip({ cx, cy, label, onClick }: { cx: number; cy: number; label: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <g
      transform={`translate(${cx} ${cy})`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ cursor: 'pointer' }}
    >
      <circle r={12} fill={hovered ? '#6366f1' : '#ffffff'} stroke="#6366f1" strokeWidth={1.5} />
      <text y={4} textAnchor="middle" fontSize={16} fontWeight={600} fill={hovered ? '#ffffff' : '#6366f1'} style={{ pointerEvents: 'none' }}>+</text>
      {hovered && (
        <g>
          <rect x={-28} y={14} width={56} height={16} rx={3} fill="rgba(0,0,0,0.8)" />
          <text y={26} textAnchor="middle" fontSize={10} fill="#ffffff" style={{ pointerEvents: 'none' }}>{label}</text>
        </g>
      )}
    </g>
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
function PlaceholderNode({ node, opacity, onClick, onMouseDown }: {
  node: LaidOutNode & { renderedX: number; renderedY: number };
  opacity: number;
  onClick: (e: React.MouseEvent) => void;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const ghostRadius = 28; // smaller than regular nodes so they read as "not-quite-there"
  return (
    <g
      transform={`translate(${node.renderedX} ${node.renderedY})`}
      opacity={opacity * 0.55}
      style={{ cursor: 'pointer' }}
      onClick={onClick}
      onMouseDown={onMouseDown}
    >
      {/* Invisible fill for reliable click hit-testing — dashed circles
          with fill="none" swallow clicks in the interior. */}
      <circle r={ghostRadius} fill="#ffffff" fillOpacity={0.001} />
      <circle
        r={ghostRadius}
        fill="none"
        stroke="#94a3b8"
        strokeWidth={1.5}
        strokeDasharray="4 4"
        style={{ pointerEvents: 'none' }}
      />
      <text
        y={7}
        textAnchor="middle"
        fontSize={28}
        fontWeight={400}
        fill="#94a3b8"
        style={{ pointerEvents: 'none' }}
      >
        ?
      </text>
      <text
        y={ghostRadius + 16}
        textAnchor="middle"
        fontSize={11}
        fontStyle="italic"
        fontWeight={500}
        fill="#64748b"
        style={{ pointerEvents: 'none' }}
      >
        click to name
      </text>
    </g>
  );
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
function PlaceholderResolver({ personId, virtualChildIds, x, y, onResolved, onClose, peopleAlreadyInTree }: {
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
}) {
  const isVirtual = personId == null && virtualChildIds != null && virtualChildIds.length > 0;
  // Default to 'link' — most placeholder resolutions are "this is
  // already a named person I have elsewhere", not "create a new named
  // person from scratch". Tab order in the UI puts Link FIRST for
  // the same reason.
  const [mode, setMode] = useState<'name' | 'link'>('link');
  const [nameInput, setNameInput] = useState('');
  const [linkQuery, setLinkQuery] = useState('');
  const [allPersons, setAllPersons] = useState<{ id: number; name: string; photoCount: number }[]>([]);
  const [selectedLinkId, setSelectedLinkId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Relationships this placeholder already holds — shown up-top so the
   *  user knows WHAT this "?" represents before naming/linking. Answers
   *  the common confusion "why is there an extra placeholder?" — at a
   *  glance you see e.g. "Currently: parent of Nee". */
  const [relationships, setRelationships] = useState<{ label: string; otherName: string }[]>([]);

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
      const nameBy = new Map<number, string>();
      if (personsRes.success && personsRes.data) {
        for (const p of personsRes.data) nameBy.set(p.id, p.name || '(unnamed)');
      }
      if (isVirtual) {
        if (virtualChildIds != null && virtualChildIds.length > 0) {
          // One "Parent of X" line per child the ghost represents, so
          // the user sees every sibling this fill-in will parent. Hides
          // the old confusion where a shared ghost claimed to be
          // "Parent of Alan" only, silently omitting Peter and Trisha.
          setRelationships(virtualChildIds.map(id => ({
            label: 'Parent of',
            otherName: nameBy.get(id) ?? '(unknown)',
          })));
        }
        return;
      }
      if (personId == null) return;
      const relRes = await listRelationshipsForPerson(personId);
      if (!relRes.success || !relRes.data) return;
      const out: { label: string; otherName: string }[] = [];
      for (const r of relRes.data) {
        const aIsMe = r.person_a_id === personId;
        const otherId = aIsMe ? r.person_b_id : r.person_a_id;
        const otherName = nameBy.get(otherId) ?? '(unknown)';
        if (r.type === 'parent_of') out.push({ label: aIsMe ? 'Parent of' : 'Child of', otherName });
        else if (r.type === 'spouse_of') out.push({ label: r.until ? 'Ex-partner of' : 'Partner of', otherName });
        else if (r.type === 'sibling_of') out.push({ label: 'Sibling of', otherName });
        else if (r.type === 'associated_with') out.push({ label: 'Connected to', otherName });
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
    .filter(p => p.name.toLowerCase().includes(linkQuery.trim().toLowerCase()))
    // Sort by photo count DESC — the more likely match surfaces first.
    // Tiebreak alphabetical.
    .sort((a, b) => (b.photoCount - a.photoCount) || a.name.localeCompare(b.name));

  const handleName = async () => {
    setError(null);
    const trimmed = nameInput.trim();
    if (!trimmed) { setError('Type a name.'); return; }
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
        onResolved();
        return;
      }
      if (personId == null) return;
      const r = await namePlaceholder(personId, trimmed);
      if (r.success) onResolved();
      else setError(r.error ?? 'Could not save.');
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
        onResolved();
        return;
      }
      if (personId == null) return;
      const r = await mergePlaceholderIntoPerson(personId, targetId);
      if (r.success) onResolved();
      else setError(r.error ?? 'Could not link.');
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
      className="placeholder-resolver absolute z-30 bg-popover border border-border rounded-xl shadow-2xl p-3 min-w-[300px] max-w-[340px]"
      style={{ left: x, top: y, transform: 'translate(-50%, -50%)' }}
    >
      <div className="flex items-center gap-2 mb-3">
        <HelpCircle className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Who is this?</span>
        <div className="flex-1" />
        <button onClick={onClose} className="p-0.5 rounded hover:bg-accent">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tell the user what this placeholder currently represents so
          they can decide whether to name it, link it, or remove it. */}
      {relationships.length > 0 && (
        <div className="mb-3 px-2.5 py-2 rounded-lg bg-muted/40 border border-border/60">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">Currently linked as</p>
          <ul className="text-xs text-foreground space-y-0.5">
            {relationships.map((r, i) => (
              <li key={i}>{r.label} <strong>{r.otherName}</strong></li>
            ))}
          </ul>
        </div>
      )}

      {/* Mode switcher — Link to existing on the LEFT and default
          because that's the most common resolution for a placeholder.
          Name them is the "I have nobody for this yet, create a new
          named person" secondary action on the RIGHT. */}
      <div className="flex gap-1 mb-3 p-0.5 bg-muted rounded-lg text-xs">
        <button
          onClick={() => setMode('link')}
          className={`flex-1 px-2 py-1 rounded ${mode === 'link' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
        >
          Link to existing
        </button>
        <button
          onClick={() => setMode('name')}
          className={`flex-1 px-2 py-1 rounded ${mode === 'name' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
        >
          Name them
        </button>
      </div>

      {mode === 'name' ? (
        <div>
          <input
            type="text"
            autoFocus
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleName(); }}
            placeholder="e.g. Grandma Eileen"
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-sm"
          />
          <p className="text-[10px] text-muted-foreground mt-1">Creates a new named person. They'll appear in People Manager so you can link photos later.</p>
        </div>
      ) : (
        <div>
          <input
            type="text"
            autoFocus
            value={linkQuery}
            onChange={e => setLinkQuery(e.target.value)}
            placeholder="Search named people…"
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-sm"
          />
          <div className="mt-2 max-h-40 overflow-auto flex flex-col gap-0.5 border border-border rounded p-0.5">
            {filtered.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-2">No matches.</p>
            )}
            {filtered.map(p => {
              const isSelected = selectedLinkId === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => setSelectedLinkId(p.id)}
                  disabled={busy}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm disabled:opacity-50 ${
                    isSelected ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-accent'
                  }`}
                >
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className={`text-[10px] shrink-0 ${isSelected ? 'text-primary/80' : 'text-muted-foreground'}`}>
                    {p.photoCount} {p.photoCount === 1 ? 'photo' : 'photos'}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-1">Pick the person this placeholder should become, then click Done. All relationships on the placeholder transfer to them.</p>
        </div>
      )}

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
        {mode === 'name' && (
          <button
            onClick={handleName}
            disabled={busy || !nameInput.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 hover:bg-primary/90"
          >
            <UserPlus className="w-3 h-3" />
            {busy ? 'Saving…' : 'Save name'}
          </button>
        )}
        {mode === 'link' && (
          <button
            onClick={() => selectedLinkId != null && handleLink(selectedLinkId)}
            disabled={busy || selectedLinkId == null}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 hover:bg-primary/90"
          >
            {busy ? 'Linking…' : 'Done'}
          </button>
        )}
      </div>
    </div>
  );
}
