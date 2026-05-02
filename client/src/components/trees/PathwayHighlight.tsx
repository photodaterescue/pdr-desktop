import { useMemo, useEffect, useRef } from 'react';
import type { TreeLayout, LaidOutNode } from '@/lib/trees-layout';

/**
 * PathwayHighlight — animated comet trail showing the relationship path
 * from the focus person to a target person, with a card-perimeter "lap"
 * animation when the comet arrives.
 *
 * Design (negotiated with Terry, /chat 2026-05-02):
 *   - Comet rides ALONG the connection lines, not diagonally across them,
 *     so it reads as "live data flowing through the tree's wiring".
 *   - Orthogonal Manhattan path between each pair of consecutive nodes,
 *     concatenated into one continuous path so the comet doesn't tele-
 *     port between segments.
 *   - Lavender (#ad9eff = --primary) by default — same brand colour
 *     used for bloodline lines so the highlight reads as part of the
 *     tree's existing colour vocabulary, just brighter and moving.
 *   - On arrival: a single animated stroke-dashoffset traces around the
 *     target card's perimeter once, then leaves a soft glow that fades
 *     over ~1.2s. (Spec also mentions a "star" sparkle at the starting
 *     corner; deferred to a follow-up commit.)
 */

const COMET_RADIUS = 7;
const TRAIL_RADIUS = 11;
const COMET_COLOUR = '#ad9eff';
const COMET_GLOW = 'rgba(173, 158, 255, 0.45)';

/** Travel time per segment in the path. Tuned so a 6-hop path (great-
 *  uncle's grandchild → focus, the kind of distance Terry's tree
 *  routinely shows) arrives in around 2.5s — long enough to read as a
 *  journey, short enough not to feel sluggish. */
const SECONDS_PER_SEGMENT = 0.45;

/** Card-lap arrival animation. The lap traces a rounded rectangle
 *  matching the card's border once, then the whole highlight fades. */
const CARD_LAP_DURATION_MS = 900;
const CARD_FADE_DURATION_MS = 600;

interface Props {
  layout: TreeLayout;
  /** PersonId of the target the comet flies TO. Setting this kicks off
   *  a fresh animation; setting back to null clears the highlight. */
  targetId: number | null;
  /** Card width / height in world coordinates — used to draw the
   *  arrival lap around the target's border. Same constants the canvas
   *  PersonNode uses. */
  cardW: number;
  cardH: number;
  /** Total animation lifetime before parent should clear targetId.
   *  Computed = travel time + lap time + fade margin. Exposed as a
   *  callback so the parent can `setTimeout` once and not duplicate
   *  the timing math here. */
  onComplete?: () => void;
}

/** BFS the visible edges in `layout` to find the shortest path of
 *  personIds from `fromId` to `toId`. Returns null when no path
 *  exists in the visible graph. */
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

/** Build an SVG path-d string that walks orthogonally from each node to
 *  the next, ALONG where the canvas would draw connection lines:
 *    - same-y pair (siblings, spouses): horizontal segment
 *    - different-y pair (parent/child): vertical → horizontal → vertical
 *      Z-shape using midY between the two rows
 *  Concatenated as a single continuous M ... L ... L ... path so the
 *  comet rides smoothly without teleporting between segments. */
function buildOrthogonalPath(nodes: LaidOutNode[]): string {
  if (nodes.length === 0) return '';
  const first = nodes[0];
  let d = `M ${first.x} ${first.y}`;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1];
    const b = nodes[i];
    if (a.y === b.y) {
      // Horizontal hop — sibling / spouse / same-row in-law.
      d += ` L ${b.x} ${b.y}`;
    } else {
      // Vertical hop — parent ↔ child. Trace the canvas's Z shape:
      // straight down from A, across at midY, straight down to B.
      const midY = (a.y + b.y) / 2;
      d += ` L ${a.x} ${midY} L ${b.x} ${midY} L ${b.x} ${b.y}`;
    }
  }
  return d;
}

export function PathwayHighlight({
  layout,
  targetId,
  cardW,
  cardH,
  onComplete,
}: Props) {
  const focusId = layout.focusPersonId;
  // Re-compute the path whenever target changes. Memo'd against layout
  // identity so rapid re-renders during the animation don't re-walk
  // the BFS for every viewport pan / zoom tick.
  const pathInfo = useMemo(() => {
    if (targetId == null) return null;
    if (targetId === focusId) return null;
    const ids = findShortestPath(layout, focusId, targetId);
    if (!ids || ids.length < 2) return null;
    const placedById = new Map<number, LaidOutNode>(
      layout.nodes.map(n => [n.personId, n]),
    );
    const nodes = ids
      .map(id => placedById.get(id))
      .filter((n): n is LaidOutNode => n != null);
    if (nodes.length < 2) return null;
    return {
      ids,
      nodes,
      pathD: buildOrthogonalPath(nodes),
      target: nodes[nodes.length - 1],
      travelDurationMs: (nodes.length - 1) * SECONDS_PER_SEGMENT * 1000,
    };
  }, [layout, focusId, targetId]);

  // Fire onComplete once travel + lap + fade have all finished. Stored
  // in a ref so React-strict-mode double-invokes don't double-fire.
  const completeFiredRef = useRef<number | null>(null);
  useEffect(() => {
    if (!pathInfo || !onComplete) return;
    if (completeFiredRef.current === targetId) return;
    completeFiredRef.current = targetId;
    const total =
      pathInfo.travelDurationMs + CARD_LAP_DURATION_MS + CARD_FADE_DURATION_MS;
    const t = setTimeout(() => onComplete(), total + 80); // 80 ms cushion
    return () => clearTimeout(t);
  }, [pathInfo, targetId, onComplete]);

  if (!pathInfo) return null;
  const { pathD, target, travelDurationMs } = pathInfo;
  const travelDurationS = travelDurationMs / 1000;
  // Card-perimeter rect — drawn from the target's centre out to the
  // card edges. Same +/-half-W/H math the canvas uses for PersonNode
  // hit zones, plus a small outward offset so the lap sits proud of
  // the card border instead of overlapping it.
  const lapInset = 4;
  const lapX = target.x - cardW / 2 - lapInset;
  const lapY = target.y - cardH / 2 - lapInset;
  const lapW = cardW + lapInset * 2;
  const lapH = cardH + lapInset * 2;
  // Stroke-dashoffset trick: dashArray equal to perimeter, dashOffset
  // animated from perimeter→0 traces the rectangle once. SVG <animate>
  // handles begin time so we can chain it directly after the comet
  // arrives without a useEffect / setTimeout.
  const lapPerimeter = 2 * (lapW + lapH) + 16; // generous overshoot for rounded corners
  return (
    <g style={{ pointerEvents: 'none' }}>
      {/* Faint backing-trail along the entire path — gives the comet a
          visible "rail" to ride along even before it reaches each
          segment. Fades out together with the comet at the end. */}
      <path
        d={pathD}
        fill="none"
        stroke={COMET_COLOUR}
        strokeWidth={2.5}
        strokeOpacity={0}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <animate
          attributeName="stroke-opacity"
          values="0;0.32;0.32;0"
          keyTimes={`0;0.1;${(travelDurationMs - 100) / (travelDurationMs + CARD_LAP_DURATION_MS + CARD_FADE_DURATION_MS)};1`}
          dur={`${(travelDurationMs + CARD_LAP_DURATION_MS + CARD_FADE_DURATION_MS) / 1000}s`}
          repeatCount="1"
          fill="freeze"
        />
      </path>
      {/* Comet trail — a larger blurred-feel circle rides one step
          behind the head, giving the LED-tube glow Terry asked for
          without needing an SVG <filter>. */}
      <circle r={TRAIL_RADIUS} fill={COMET_GLOW} opacity={0}>
        <animate
          attributeName="opacity"
          values="0;0.85;0.85;0"
          keyTimes="0;0.05;0.95;1"
          dur={`${travelDurationS}s`}
          repeatCount="1"
          fill="freeze"
        />
        <animateMotion
          dur={`${travelDurationS}s`}
          repeatCount="1"
          path={pathD}
          fill="freeze"
          rotate="auto"
        />
      </circle>
      {/* Comet head — the bright moving point. */}
      <circle r={COMET_RADIUS} fill={COMET_COLOUR} opacity={0}>
        <animate
          attributeName="opacity"
          values="0;1;1;0"
          keyTimes="0;0.05;0.95;1"
          dur={`${travelDurationS}s`}
          repeatCount="1"
          fill="freeze"
        />
        <animateMotion
          dur={`${travelDurationS}s`}
          repeatCount="1"
          path={pathD}
          fill="freeze"
          rotate="auto"
        />
      </circle>
      {/* Card-perimeter lap — fires when the comet finishes. Uses an
          SVG <animate> with begin = travel time so timing is owned by
          SVG itself, no setTimeout race conditions. */}
      <rect
        x={lapX}
        y={lapY}
        width={lapW}
        height={lapH}
        rx={14}
        ry={14}
        fill="none"
        stroke={COMET_COLOUR}
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={lapPerimeter}
        strokeDashoffset={lapPerimeter}
        opacity={0}
      >
        <animate
          attributeName="opacity"
          values="0;1;1;0"
          keyTimes="0;0.01;0.7;1"
          begin={`${travelDurationS}s`}
          dur={`${(CARD_LAP_DURATION_MS + CARD_FADE_DURATION_MS) / 1000}s`}
          repeatCount="1"
          fill="freeze"
        />
        <animate
          attributeName="stroke-dashoffset"
          values={`${lapPerimeter};0`}
          begin={`${travelDurationS}s`}
          dur={`${CARD_LAP_DURATION_MS / 1000}s`}
          repeatCount="1"
          fill="freeze"
        />
      </rect>
      {/* Soft halo glow around the target card during and after the
          lap — fades out together with the lap stroke. Same lavender
          glow tone the comet trail uses, just at lower opacity. */}
      <rect
        x={lapX - 3}
        y={lapY - 3}
        width={lapW + 6}
        height={lapH + 6}
        rx={16}
        ry={16}
        fill="none"
        stroke={COMET_GLOW}
        strokeWidth={9}
        opacity={0}
      >
        <animate
          attributeName="opacity"
          values="0;0.7;0"
          keyTimes="0;0.4;1"
          begin={`${travelDurationS}s`}
          dur={`${(CARD_LAP_DURATION_MS + CARD_FADE_DURATION_MS) / 1000}s`}
          repeatCount="1"
          fill="freeze"
        />
      </rect>
    </g>
  );
}
