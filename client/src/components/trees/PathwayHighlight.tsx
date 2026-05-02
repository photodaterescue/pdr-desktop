import { useMemo, useEffect, useRef, useState } from 'react';
import type { TreeLayout, LaidOutNode } from '@/lib/trees-layout';

/**
 * PathwayHighlight — animated effects showing the relationship path
 * from the focus person to a target person. Supports multiple effect
 * modes that can be combined; each mode is a self-contained layer
 * driven by requestAnimationFrame + React state (NOT SVG SMIL —
 * Terry's first version using <animateMotion> wasn't firing reliably
 * in the Electron build, RAF is the dependable alternative).
 *
 * Modes:
 *   'comet' — bright lavender ball travels along the path with a
 *             trailing glow halo, then traces a lap around the target
 *             card's perimeter and fades out.
 *   'sonar' — an expanding ring pulses outward from focus, then from
 *             each subsequent waypoint as the wavefront passes
 *             through, then a final ring at the target. Reads as
 *             "ping → ping → ping → arrival ring".
 *
 * Both share the same BFS path-finding + per-segment timing.
 */

const COMET_COLOUR = '#ad9eff';
const COMET_GLOW = 'rgba(173, 158, 255, 0.55)';

/** Travel time per segment in the path. ~0.85 s × hop count gives a
 *  6-hop path (great-uncle's grandchild → focus) about 5 s — long
 *  enough to read as a journey, short enough not to feel sluggish. */
const SECONDS_PER_SEGMENT = 0.85;

const CARD_LAP_DURATION_MS = 1100;
const CARD_FADE_DURATION_MS = 700;

interface Props {
  layout: TreeLayout;
  /** PersonId of the target the effect runs TO. Required. */
  targetId: number | null;
  /** Card width / height in SCREEN pixels — used to draw the arrival
   *  lap. Caller is responsible for scaling by viewport.scale before
   *  passing in, since this component now renders in screen coords
   *  rather than the canvas's world-coords transform group. */
  cardW: number;
  cardH: number;
  /** Per-person SCREEN-space position map. The parent computes this
   *  by combining canvas-level world coords (translated through
   *  viewport.scale + tx/ty) AND any panel-level mini-placements
   *  (panelLeft + cx * scale, panelTop + cy * scale), so a single
   *  lookup gives the actual on-screen position whether the person
   *  is a canvas card or a panel card. PathwayHighlight uses these
   *  to build its path geometry, which lets the comet sail across
   *  canvas → panel boundaries seamlessly. */
  positionByPersonId?: Map<number, { x: number; y: number }>;
  /** For each person rendered INSIDE an open panel, the world-coords
   *  of (a) the chevron stud beneath their panel's head card and
   *  (b) the panel's anchor point on the panel border. PathwayHighlight
   *  injects these as virtual waypoints when the path crosses from a
   *  canvas card INTO a panel descendant, so the comet rides the
   *  chevron tether geometry rather than cutting a diagonal across
   *  the panel chrome. */
  panelTransitionByDescendantId?: Map<number, {
    chevronX: number; chevronY: number;
    anchorX: number; anchorY: number;
  }>;
  /** Which effect modes are active. Multiple modes can run together;
   *  each draws its own layer. Defaulted to comet-only. */
  mode?: {
    comet?: boolean;
    sonar?: boolean;
    /** Bright gradient slice that travels along the path — like the
     *  comet but rendered as a wider, softer stripe of light. */
    sweep?: boolean;
    /** Lightning-style jagged bursts around the moving head; reads as
     *  electricity arcing through the connection. */
    electric?: boolean;
    /** Animated dashes flowing along the path — like data pulsing
     *  through fibre-optic cable. */
    fiber?: boolean;
    /** Thick steady glow on the entire path while the comet travels —
     *  reads as the wires being lit-up neon-style. */
    led?: boolean;
  };
  /** Total animation lifetime before parent should clear targetId. */
  onComplete?: () => void;
}

function findShortestPath(
  layout: TreeLayout,
  fromId: number,
  toId: number,
): number[] | null {
  if (fromId === toId) return [fromId];
  const adj = new Map<number, number[]>();
  for (const e of layout.edges) {
    if (!e.visible) continue;
    if (!adj.has(e.aId)) adj.set(e.aId, []);
    if (!adj.has(e.bId)) adj.set(e.bId, []);
    adj.get(e.aId)!.push(e.bId);
    adj.get(e.bId)!.push(e.aId);
  }
  const prev = new Map<number, number>();
  const seen = new Set<number>([fromId]);
  const queue: number[] = [fromId];
  let found = false;
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === toId) { found = true; break; }
    for (const n of adj.get(cur) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, cur);
      queue.push(n);
    }
  }
  if (!found) return null;
  const path: number[] = [toId];
  let cur = toId;
  while (cur !== fromId) {
    cur = prev.get(cur)!;
    path.unshift(cur);
  }
  return path;
}

/** Build an array of (x,y) waypoints for the comet to traverse. We
 *  insert intermediate Manhattan corners so the comet's diagonal hops
 *  between named cards still trace orthogonal Z-shapes that follow the
 *  canvas's connection-line geometry. When a node id is in
 *  `transitions`, we also inject the chevron + panel-anchor waypoints
 *  before / after that node so the comet rides the chevron tether
 *  geometry on its way INTO or OUT OF an open panel — rather than
 *  cutting a diagonal across the panel chrome. */
/** Card height in world units — must match CARD_H in TreesCanvas.
 *  Used so the comet path can land on/depart from a card's TOP or
 *  BOTTOM edge (matching where canvas connection lines actually
 *  attach) instead of cutting through the card centre. */
const CARD_H_WORLD = 154;
/** Row height between generations — same constant trees-layout.ts uses
 *  in DEFAULT_OPTIONS.rowHeight. The sibling bracket lives midway
 *  between siblings' row and their parents' row, i.e. at the bottom of
 *  the parent gap — exactly y = sibling.y - bracketOffset where
 *  bracketOffset = (rowHeight + cardH) * 0.5 sort of. We use a simple
 *  approximation: bracket sits cardH * 0.55 above the sibling row
 *  (matches the canvas FamilyGroup's bracketY computation closely
 *  enough that the comet visually rides the same line). */
const SIBLING_BRACKET_LIFT = 90;
/** Vertical centre of the avatar within a card — partnership lines
 *  draw at this y offset from card centre. */
const AVATAR_CY_OFFSET = -22;

function buildWaypoints(
  nodes: LaidOutNode[],
  edges: { aId: number; bId: number; type: string; visible?: boolean }[],
  transitions?: Map<number, { chevronX: number; chevronY: number; anchorX: number; anchorY: number }>,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  if (nodes.length === 0) return out;
  out.push({ x: nodes[0].x, y: nodes[0].y });
  const inPanel = (id: number) => transitions?.has(id) ?? false;
  /** Detect the relationship between two adjacent BFS nodes so we can
   *  retrace the canvas's actual connection geometry. */
  const findRelation = (aId: number, bId: number): 'parent_a' | 'parent_b' | 'spouse' | 'sibling' | 'unknown' => {
    for (const e of edges) {
      if (e.type === 'parent_of') {
        if (e.aId === aId && e.bId === bId) return 'parent_a'; // a is parent of b
        if (e.aId === bId && e.bId === aId) return 'parent_b'; // b is parent of a
      } else if (e.type === 'spouse_of') {
        if ((e.aId === aId && e.bId === bId) || (e.aId === bId && e.bId === aId)) return 'spouse';
      } else if (e.type === 'sibling_of') {
        if ((e.aId === aId && e.bId === bId) || (e.aId === bId && e.bId === aId)) return 'sibling';
      }
    }
    return 'unknown';
  };
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1];
    const b = nodes[i];
    const aInPanel = inPanel(a.personId);
    const bInPanel = inPanel(b.personId);
    // Crossing INTO a panel — chevron + anchor as virtual waypoints.
    if (!aInPanel && bInPanel) {
      const t = transitions!.get(b.personId)!;
      // Canvas card a's bottom edge → chevron stud. Drop from a.bottom
      // straight DOWN to the chevron's level, then across at the
      // chevron's y to its column.
      const aBottom = a.y + CARD_H_WORLD / 2;
      if (a.x !== t.chevronX) {
        out.push({ x: a.x, y: aBottom });
        out.push({ x: a.x, y: t.chevronY });
        out.push({ x: t.chevronX, y: t.chevronY });
      } else {
        out.push({ x: t.chevronX, y: t.chevronY });
      }
      // Chevron → panel anchor. Tether is a bezier on canvas; here
      // we approximate with a straight segment (same start/end pts).
      out.push({ x: t.anchorX, y: t.anchorY });
      // Anchor → in-panel card (top edge).
      const bTop = b.y - CARD_H_WORLD / 2;
      if (t.anchorX !== b.x) {
        out.push({ x: t.anchorX, y: bTop });
        out.push({ x: b.x, y: bTop });
      } else {
        out.push({ x: b.x, y: bTop });
      }
      out.push({ x: b.x, y: b.y });
      continue;
    }
    // Crossing OUT OF a panel — symmetric.
    if (aInPanel && !bInPanel) {
      const t = transitions!.get(a.personId)!;
      const aTop = a.y - CARD_H_WORLD / 2;
      if (a.x !== t.anchorX) {
        out.push({ x: a.x, y: aTop });
        out.push({ x: t.anchorX, y: aTop });
      } else {
        out.push({ x: t.anchorX, y: aTop });
      }
      out.push({ x: t.anchorX, y: t.anchorY });
      out.push({ x: t.chevronX, y: t.chevronY });
      const bBottom = b.y + CARD_H_WORLD / 2;
      if (t.chevronX !== b.x) {
        out.push({ x: t.chevronX, y: bBottom });
        out.push({ x: b.x, y: bBottom });
      } else {
        out.push({ x: b.x, y: bBottom });
      }
      out.push({ x: b.x, y: b.y });
      continue;
    }
    // Same-context (both canvas, both same panel) — retrace the actual
    // rendered line geometry based on edge type. parent_of takes a Z
    // through the row gap; sibling_of goes UP to the bracket above
    // both siblings then DOWN; spouse_of runs horizontal at avatar
    // level between the cards' inside edges.
    const rel = findRelation(a.personId, b.personId);
    if (rel === 'parent_a') {
      // a is parent of b — drop from a's bottom, across at midY, down
      // to b's top, then settle at b's centre.
      const aBottom = a.y + CARD_H_WORLD / 2;
      const bTop = b.y - CARD_H_WORLD / 2;
      const midY = (aBottom + bTop) / 2;
      out.push({ x: a.x, y: aBottom });
      out.push({ x: a.x, y: midY });
      out.push({ x: b.x, y: midY });
      out.push({ x: b.x, y: bTop });
      out.push({ x: b.x, y: b.y });
    } else if (rel === 'parent_b') {
      // b is parent of a — go UP from a, across at midY, up to b.
      const aTop = a.y - CARD_H_WORLD / 2;
      const bBottom = b.y + CARD_H_WORLD / 2;
      const midY = (aTop + bBottom) / 2;
      out.push({ x: a.x, y: aTop });
      out.push({ x: a.x, y: midY });
      out.push({ x: b.x, y: midY });
      out.push({ x: b.x, y: bBottom });
      out.push({ x: b.x, y: b.y });
    } else if (rel === 'sibling') {
      // Sibling bracket — climb UP from a's top to the bracket Y
      // (above both siblings, below their parents), traverse across,
      // and DOWN to b's top.
      const aTop = a.y - CARD_H_WORLD / 2;
      const bTop = b.y - CARD_H_WORLD / 2;
      const bracketY = Math.min(a.y, b.y) - CARD_H_WORLD / 2 - SIBLING_BRACKET_LIFT;
      out.push({ x: a.x, y: aTop });
      out.push({ x: a.x, y: bracketY });
      out.push({ x: b.x, y: bracketY });
      out.push({ x: b.x, y: bTop });
      out.push({ x: b.x, y: b.y });
    } else if (rel === 'spouse') {
      // Partnership bar at avatar level — runs along the inside edges
      // of the two partner cards.
      const avatarY = (a.y + b.y) / 2 + AVATAR_CY_OFFSET;
      out.push({ x: a.x, y: avatarY });
      out.push({ x: b.x, y: avatarY });
      out.push({ x: b.x, y: b.y });
    } else {
      // Fallback — treat as a generic Z.
      if (a.y === b.y) {
        out.push({ x: b.x, y: b.y });
      } else {
        const midY = (a.y + b.y) / 2;
        out.push({ x: a.x, y: midY });
        out.push({ x: b.x, y: midY });
        out.push({ x: b.x, y: b.y });
      }
    }
  }
  return out;
}

/** Build the same path as a single SVG `d` string so we can render
 *  the static "rail" the comet rides on. */
function buildPathD(waypoints: { x: number; y: number }[]): string {
  if (waypoints.length === 0) return '';
  const first = waypoints[0];
  let d = `M ${first.x} ${first.y}`;
  for (let i = 1; i < waypoints.length; i++) {
    d += ` L ${waypoints[i].x} ${waypoints[i].y}`;
  }
  return d;
}

/** Compute (x, y) on a piecewise-linear path at progress t in [0, 1].
 *  Path length is the sum of segment lengths; we walk the path until
 *  we accumulate t × totalLength. */
function positionAlong(
  waypoints: { x: number; y: number }[],
  t: number,
): { x: number; y: number } {
  if (waypoints.length === 0) return { x: 0, y: 0 };
  if (waypoints.length === 1) return waypoints[0];
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const dx = waypoints[i].x - waypoints[i - 1].x;
    const dy = waypoints[i].y - waypoints[i - 1].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    lengths.push(len);
    total += len;
  }
  if (total === 0) return waypoints[0];
  let dist = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (dist <= lengths[i]) {
      const f = lengths[i] === 0 ? 0 : dist / lengths[i];
      return {
        x: waypoints[i].x + f * (waypoints[i + 1].x - waypoints[i].x),
        y: waypoints[i].y + f * (waypoints[i + 1].y - waypoints[i].y),
      };
    }
    dist -= lengths[i];
  }
  return waypoints[waypoints.length - 1];
}

export function PathwayHighlight({
  layout,
  targetId,
  cardW,
  cardH,
  positionByPersonId,
  panelTransitionByDescendantId,
  mode = { comet: true },
  onComplete,
}: Props) {
  const focusId = layout.focusPersonId;

  const pathInfo = useMemo(() => {
    if (targetId == null) return null;
    if (targetId === focusId) return null;
    const ids = findShortestPath(layout, focusId, targetId);
    if (!ids || ids.length < 2) return null;
    const placedById = new Map<number, LaidOutNode>(
      layout.nodes.map(n => [n.personId, n]),
    );
    // For each person on the path, prefer the screen position from
    // positionByPersonId (which accounts for panel routing) over the
    // raw layout coords. Without the map we fall back to layout coords
    // — useful for tests / standalone usage but not how TreesCanvas
    // wires us up.
    const nodes = ids
      .map(id => {
        const placed = placedById.get(id);
        if (!placed) return null;
        const screen = positionByPersonId?.get(id);
        if (screen) {
          // Override the layout x/y with the screen-space position so
          // path geometry traces through where the card is actually
          // rendered (panel or canvas).
          return { ...placed, x: screen.x, y: screen.y };
        }
        return placed;
      })
      .filter((n): n is LaidOutNode => n != null);
    if (nodes.length < 2) return null;
    const waypoints = buildWaypoints(nodes, layout.edges, panelTransitionByDescendantId);
    return {
      ids,
      nodes,
      waypoints,
      pathD: buildPathD(waypoints),
      target: nodes[nodes.length - 1],
      travelDurationMs: (nodes.length - 1) * SECONDS_PER_SEGMENT * 1000,
    };
  }, [layout, focusId, targetId, positionByPersonId, panelTransitionByDescendantId]);

  // RAF-driven progress. Updated 60 times a second so the React tree
  // re-renders the comet's position. Cheap because PathwayHighlight is
  // a small leaf component — most of the parent canvas isn't touched.
  const [progress, setProgress] = useState(0);
  const startRef = useRef(0);

  useEffect(() => {
    if (!pathInfo) return;
    startRef.current = performance.now();
    setProgress(0);
    const totalMs = pathInfo.travelDurationMs + CARD_LAP_DURATION_MS + CARD_FADE_DURATION_MS;
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = now - startRef.current;
      const t = Math.min(1, elapsed / totalMs);
      setProgress(t);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else if (onComplete) {
        // Tiny cushion so the final frame paints before we ask the
        // parent to unmount us.
        setTimeout(() => onComplete(), 80);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pathInfo, onComplete]);

  if (!pathInfo) return null;
  const { pathD, waypoints, target, travelDurationMs } = pathInfo;
  const totalMs = travelDurationMs + CARD_LAP_DURATION_MS + CARD_FADE_DURATION_MS;
  const elapsedMs = progress * totalMs;
  // Sub-progress within each phase for compositing the lap + fade.
  const travelT = Math.min(1, elapsedMs / travelDurationMs);
  const lapT = Math.max(0, Math.min(1, (elapsedMs - travelDurationMs) / CARD_LAP_DURATION_MS));
  const fadeT = Math.max(0, Math.min(1, (elapsedMs - travelDurationMs - CARD_LAP_DURATION_MS) / CARD_FADE_DURATION_MS));
  // Path-trail opacity: fades in fast, holds during travel + lap,
  // fades out together with the lap halo at the end.
  const trailOpacity = (() => {
    if (elapsedMs < 80) return (elapsedMs / 80) * 0.45;
    if (fadeT > 0) return 0.45 * (1 - fadeT);
    return 0.45;
  })();
  // Comet head: travels along the path during the travel phase, hides
  // afterwards.
  const cometPos = positionAlong(waypoints, travelT);
  const cometOpacity = travelT >= 1 ? 0 : (travelT < 0.05 ? travelT / 0.05 : (travelT > 0.95 ? (1 - travelT) / 0.05 : 1));
  // Sonar ring radii — emitted at each waypoint as the comet passes.
  // Each ring expands from 18 to 80 over 600 ms then fades.
  const sonarRings = (() => {
    if (!mode.sonar) return [];
    const rings: { x: number; y: number; r: number; opacity: number }[] = [];
    if (waypoints.length < 2) return rings;
    // Total path length and per-waypoint distance markers.
    let total = 0;
    const cum = [0];
    for (let i = 1; i < waypoints.length; i++) {
      const dx = waypoints[i].x - waypoints[i - 1].x;
      const dy = waypoints[i].y - waypoints[i - 1].y;
      total += Math.sqrt(dx * dx + dy * dy);
      cum.push(total);
    }
    const RING_LIFE_MS = 700;
    for (let i = 0; i < waypoints.length; i++) {
      const arrivalT = total === 0 ? 0 : cum[i] / total;
      const arrivalMs = arrivalT * travelDurationMs;
      const age = elapsedMs - arrivalMs;
      if (age < 0 || age > RING_LIFE_MS) continue;
      const f = age / RING_LIFE_MS;
      rings.push({
        x: waypoints[i].x,
        y: waypoints[i].y,
        r: 18 + f * 62,
        opacity: 1 - f,
      });
    }
    return rings;
  })();
  // Card-perimeter lap geometry.
  const lapInset = 4;
  const lapX = target.x - cardW / 2 - lapInset;
  const lapY = target.y - cardH / 2 - lapInset;
  const lapW = cardW + lapInset * 2;
  const lapH = cardH + lapInset * 2;
  const lapPerimeter = 2 * (lapW + lapH) + 16;
  // Lap is drawn via stroke-dashoffset shrinking from full perimeter
  // to 0 over the lap phase, then fades out with the halo.
  const lapDashOffset = lapPerimeter * (1 - lapT);
  const lapOpacity = lapT > 0 ? (1 - fadeT) : 0;
  // Halo around the target card during and after the lap.
  const haloOpacity = lapT > 0 ? 0.85 * (1 - fadeT) : 0;

  return (
    <g style={{ pointerEvents: 'none' }}>
      {/* Static path trail — the rail the comet rides along. */}
      <path
        d={pathD}
        fill="none"
        stroke={COMET_COLOUR}
        strokeWidth={4}
        strokeOpacity={trailOpacity}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* LED neon tube — thick steady glow on the whole path while the
          travel + lap is in progress. Underlay drawn first so anything
          else paints on top. Fades in/out together with the trail. */}
      {mode.led && (
        <path
          d={pathD}
          fill="none"
          stroke={COMET_GLOW}
          strokeWidth={14}
          strokeOpacity={trailOpacity * 1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {/* Fibre-optic flow — animated dashes flowing along the path.
          Driven by progress so the dashes appear to "travel"
          continuously while the effect is on screen. Dash pattern
          (8 12) gives discrete pulses spaced ~20 px apart. */}
      {mode.fiber && (
        <path
          d={pathD}
          fill="none"
          stroke={COMET_COLOUR}
          strokeWidth={3}
          strokeOpacity={trailOpacity * 1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="8 12"
          strokeDashoffset={-progress * 600}
        />
      )}
      {/* Sonar rings — only rendered when the sonar mode is on. */}
      {mode.sonar && sonarRings.map((r, i) => (
        <circle
          key={`sonar-${i}`}
          cx={r.x}
          cy={r.y}
          r={r.r}
          fill="none"
          stroke={COMET_COLOUR}
          strokeWidth={3}
          opacity={r.opacity}
        />
      ))}
      {/* Gradient sweep — wide soft stripe trailing the travelling
          head. Three concentric circles with decreasing opacity and
          increasing radius give a gradient-blur read distinct from
          the comet's tighter halo. */}
      {mode.sweep && travelT < 1 && (
        <>
          <circle cx={cometPos.x} cy={cometPos.y} r={28} fill={COMET_COLOUR} opacity={cometOpacity * 0.18} />
          <circle cx={cometPos.x} cy={cometPos.y} r={20} fill={COMET_COLOUR} opacity={cometOpacity * 0.32} />
          <circle cx={cometPos.x} cy={cometPos.y} r={13} fill={COMET_COLOUR} opacity={cometOpacity * 0.55} />
        </>
      )}
      {/* Electric arc — three jagged lightning-style bolts emanating
          from the moving head. Per-frame jitter from progress gives
          each render a slightly different shape (the visual hallmark
          of arcing electricity). Same brand lavender as the rest. */}
      {mode.electric && travelT < 1 && (
        <g opacity={cometOpacity}>
          {[0, 1, 2].map(i => {
            const seed = (progress * 1000 + i * 37) % 1;
            const angle = (i * 2.094) + seed * 0.7;
            const len = 18 + seed * 12;
            const sx = cometPos.x;
            const sy = cometPos.y;
            const ex = sx + Math.cos(angle) * len;
            const ey = sy + Math.sin(angle) * len;
            const midX = (sx + ex) / 2 + (seed - 0.5) * 8;
            const midY = (sy + ey) / 2 + (seed - 0.5) * 8;
            return (
              <path
                key={`bolt-${i}`}
                d={`M ${sx} ${sy} L ${midX} ${midY} L ${ex} ${ey}`}
                stroke={COMET_COLOUR}
                strokeWidth={2}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.85}
              />
            );
          })}
        </g>
      )}
      {/* Comet halo + head — only rendered when the comet mode is on. */}
      {mode.comet && (
        <>
          <circle cx={cometPos.x} cy={cometPos.y} r={17} fill={COMET_GLOW} opacity={cometOpacity * 0.95} />
          <circle cx={cometPos.x} cy={cometPos.y} r={11} fill={COMET_COLOUR} opacity={cometOpacity} />
        </>
      )}
      {/* Card-perimeter lap — fires when travel completes. */}
      {lapT > 0 && (
        <>
          {/* Halo glow around the target card. */}
          <rect
            x={lapX - 3}
            y={lapY - 3}
            width={lapW + 6}
            height={lapH + 6}
            rx={16}
            ry={16}
            fill="none"
            stroke={COMET_GLOW}
            strokeWidth={11}
            opacity={haloOpacity}
          />
          {/* Lap stroke tracing the card border. */}
          <rect
            x={lapX}
            y={lapY}
            width={lapW}
            height={lapH}
            rx={14}
            ry={14}
            fill="none"
            stroke={COMET_COLOUR}
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={lapPerimeter}
            strokeDashoffset={lapDashOffset}
            opacity={lapOpacity}
          />
        </>
      )}
    </g>
  );
}
