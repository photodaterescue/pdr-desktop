# Trees Floating Panel — Design Doc

**Status:** Approved (awaiting implementation)
**Author:** Claude (with Terry)
**Date:** 2026-05-01

This document captures the design of the **tethered floating-panel** affordance for the Trees view: how revealed branches (cousins, in-laws, side-branches) are presented as elevated, draggable panels above the base canvas instead of being injected into the main layout. It supersedes the previous "lift card" approach (a CSS keyframe + faint drop-shadow), which proved too subtle to communicate elevation.

---

## 1. Concept

When a user clicks a chevron-button to reveal a hidden branch (cousins beneath an aunt, in-laws' family-of-origin, etc.), the revealed sub-tree appears in a **floating panel** that sits *above* the base canvas on a higher visual plane. The base canvas dims to ~35 % opacity to reinforce the layered metaphor — the panel reads as "a sheet of paper placed over the tree".

The panel is:
- **Tethered** to the chevron that opened it via a Bezier curve, so it stays spatially anchored to its origin on the base canvas.
- **Draggable** within constrained bounds — the user can move it out of the way, but never far enough to break the spatial relationship to its origin.
- **Self-laid-out** — inside the panel, the same layout primitives (per-family centring, sibling tightness, partner adjacency) render the branch as a mini-tree, recursively.

This replaces the previous flat-injection-with-CSS-shadow approach.

---

## 2. Visual & interaction rules

### 2.1 Base-canvas dimming
- When at least one panel is open, the base canvas dims to **55 % opacity** (originally spec'd at 35 %, bumped after the first sanity check — 35 % was unreadable, 55 % reads as recessed without losing legibility).
- Tree lines and cards in the dimmed base remain visible (so the user keeps spatial context for the tether), just visibly recessed.
- Header (filter pills, branch counters, etc.) remains full-strength — chrome doesn't dim.

### 2.2 Panel(s) full-strength
- Open panels render at **100 % opacity** — they're the focal layer.
- Multiple panels stay at full strength simultaneously (Terry's rule — opting into multi-panel mode means accepting full-strength for all of them).
- Z-order: most-recently-interacted-with panel sits on top. Clicking any part of a panel raises it.

### 2.3 Tether line
- A **Bezier curve** from the chevron's origin point on the base canvas to the panel's anchor edge (typically top-centre of the panel).
- Control points pulled toward each end so the line bends naturally as the panel moves — never a straight diagonal that breaks the visual relationship.
- Stroke colour matches the chevron that opened the panel: lavender (`#ad9eff`) for bloodline-cousin chevrons, brand orange (`#f59e0b`) for extended-family chevrons.
- Stroke weight: **2 px** — slightly thicker than the standard family lines (1.5 px scaffolding) so it reads as a *leader line* rather than a `parent_of` edge.
- The tether is drawn in a separate SVG layer above the dimmed base but below the panel itself, so the panel's content never gets crossed by the line.

### 2.4 Pulsating active chevron
- When a chevron's panel is **open** (collapsed → expanded transition), the chevron itself begins to **pulsate** — gentle opacity + scale animation, ~1.5–2 s cycle.
- The chevron's glyph **does not rotate** when active. Earlier rotation-on-expansion (^ → v) was visually noisy and lost the directional meaning. Pulsating reuses the same vocabulary as the focus-card pulse.
- When the panel closes, the chevron returns to its static collapsed state.

### 2.5 Mini-tree inside the panel
- The panel's content is a **recursively-laid-out subtree** of the branch it opened.
- Same layout primitives as the main canvas: per-family centring, sibling tightness (`spouseOffset`), partner adjacency, bloodline-aware grouping, ancestor/descendant centring.
- If anyone *inside* the panel has hidden in-laws or cousins of their own, they get the same chevron-button vocabulary — clicking opens *another* panel (recursive consistency).

---

## 3. Drag mechanics & constraints

### 3.1 Constraints
**Vertical:**
- Panel's **top edge** must remain at-or-below the bottom of its origin's generation row, plus a small gap (~`spouseOffset / 2`).
- Small upward tolerance (~10 px) for fine positioning; beyond that the panel hard-clamps.
- Reason: a side-branch from Carol's row should never sit visually above Carol's row, or above her parents D + S. The hierarchy must always read top-down.

**Horizontal:**
- Panel **centre** can drift ±~1.5 × panel width from the origin's X coordinate, then hard-clamps.
- Reason: far enough left/right to get out of the way of overlapping content; not so far that the tether becomes absurdly long and the spatial relationship breaks.

**Snap behaviour:**
- Live-clamp during drag (the panel can't be dragged into illegal regions; the cursor "drags free" while the panel stays at its constrained edge).
- *Not* spring-back-on-release — that feels jerky and confusing.

### 3.2 Position memory
- Per-branch position stored in canvas state, keyed by the chevron's `originPersonId` + chevron-direction (so Carol's "cousins-down" panel and Lindsay's "in-laws-up" panel are remembered separately).
- Closing and re-opening the same chevron restores the panel's last position.
- Position is not persisted across sessions — only within a single Trees view session.

### 3.3 Combined bounds clamp
- When panels are open, the canvas's pan-clamp (rule 6.1 below) treats **the union of (base tree bounds) + (open panels' bounds)** as the world.
- Effect: a panel dragged far from the tree can still be reached by panning; the canvas won't strand the panel off-screen.

---

## 4. Multi-panel rules

- **No hard cap on number of open panels.** Users opt in to crowding by repeatedly clicking chevrons; that's their decision, not ours to gate.
- **All open panels render at full strength** (Terry's explicit rule — multi-panel mode means equal visual weight for all panels).
- **Z-order:** the panel most recently interacted with (clicked anywhere inside, or dragged) sits on top. Other panels sit beneath it in last-touched order.
- **Visual overlap is allowed.** Panels can sit on top of each other; the user manages stacking via drag, like Mac windows.
- **Header pill** gains a counter: "*N* panels open" alongside the existing "*N* branches shown" counter. Click → close all panels.
- **Tethers from multiple panels** are all drawn — each panel has its own Bezier line back to its origin, even if lines cross.

---

## 5. Closing gestures

The panel can be closed by **any** of:
- Clicking the same chevron-button again (now an "active" pulsating affordance — clicking it acts as a collapse).
- Pressing **Esc** — closes the topmost panel only. Pressing Esc again closes the next, etc.
- Clicking the **base canvas** anywhere (the dimmed area outside any panel) — closes all panels at once.
- Clicking the "close all" button on the header pill (rule 4).

There is **no** dedicated X close button on each panel — the chevron-as-toggle, Esc, and click-outside cover every case without adding chrome.

---

## 6. Pan & zoom rules (canvas hygiene)

### 6.1 Never-blank canvas
- The viewport must always intersect the **world bounds** (base tree + any open panels' bounds).
- Panning is live-clamped: dragging beyond the world's edge stops the pan when the bounds exit the viewport.
- On extreme zoom-out, the world auto-fits centred (no panning needed).
- There is no state in which the user can be looking at an entirely empty canvas while content exists somewhere off-screen.

### 6.2 Refocus is universal
- Any person rendered anywhere — base canvas OR inside a panel — can be double-clicked to become the new focus.
- Re-focusing **closes all panels** (existing focus-change auto-collapse already handles this).
- The bloodline-pulse moves to the new focus card; new chevrons are evaluated against the new focus's bloodline.

---

## 7. Chevron palette (unchanged)

- **Lavender (`#ad9eff`)** — chevron leads to bloodline content (cousins, side-branch descendants, bloodline-revealable ancestors).
- **Orange (`#f59e0b`)** — chevron leads to non-bloodline / extended-family content (in-laws' family-of-origin, partners' siblings).
- Chevron buttons retain their solid-fill + white-glyph design (the "raised CTA" look from the earlier redesign).
- The static rim, drop-shadow, top-highlight, and hover-lift are unchanged.

---

## 8. Implementation order (small commits)

Each step lands as its own commit + push. No big-bang rollout.

1. **Doc landed** *(this commit)* — design recorded in repo.
2. **Base-canvas dim layer** — when any panel state is open, dim the existing canvas SVG to 35 % opacity. Header stays full-strength. Sanity-check: can the user still see the dimmed tree well enough?
3. **Panel container shell** — empty floating panel rendered as a separate SVG `<g>` (or HTML overlay; decide during implementation) above the dimmed canvas. No content yet, just a positioned rectangle with the lift-card visual treatment (drop-shadow, white background, rounded corners). Spawned from a chevron click.
4. **Tether Bezier** — connect the panel anchor to its origin on the base canvas with a curved leader line. Test as the panel's position is hard-coded to different points to verify the curve flexes correctly.
5. **Panel content render** — render the revealed subtree inside the panel using existing layout primitives, scoped to the branch's nodes/edges. Re-uses `computePedigreeLayout` or a new sub-layout function fed only the branch's data.
6. **Drag mechanics + constraints** — vertical/horizontal clamps, live-clamp behaviour, position memory keyed by origin.
7. **Pulsating active chevron** — replace glyph rotation with a pulse animation when the chevron's panel is open.
8. **Multi-panel state** — `openPanels: Map<originKey, PanelState>` instead of a single panel. Z-order via last-touched.
9. **Close gestures** — Esc handler (topmost), click-outside-on-dimmed-canvas (all), header pill "close all".
10. **Combined bounds clamp** — pan/zoom respects union of tree + panels.
11. **Recursive chevrons** — chevrons inside a panel can spawn further panels; tether origins from inside-panel positions.

---

## 9. Open questions (resolve during implementation)

- **SVG vs HTML for the panel?** SVG keeps everything in one coordinate system (easier for tether maths). HTML overlay is easier for drag handling and can use native pointer events. Likely answer: **HTML for the panel container, SVG for the tether line drawn into the main canvas.**
- **Does Esc close ALL panels or just topmost?** Currently spec'd as "topmost". Could revise if it feels unintuitive in practice.
- **Should the dim-the-base-canvas opacity (35 %) be configurable?** Probably not — this is a brand-feel decision, not a user setting.
- **Should panels be resizable?** v1 says no (panel sizes itself to its content). Revisit if heavy users start asking for it.
- **Animation duration for panel open/close?** Suggest ~220 ms ease-out, matching the existing card-lift keyframe. Confirm during implementation.

---

## 10. Out of scope for this doc (future work)

- Persisting panel positions across Trees-view sessions (stored on the saved tree record).
- Zoom-into-panel (treat the panel as its own viewport).
- Print/export with panels open vs closed.
- Keyboard navigation between panels (Tab to switch).

## 11. Phase 12 — maiden names (deferred)

The branch-surname header for in-law ancestor panels (rule 2.x) currently uses whatever surname is stored against the topmost ancestor. For Lindsay Clapson's family-of-origin panel that means we'd want her *maiden* surname (McCall) on the abbreviated header, not her married surname (Clapson). PDR doesn't yet model maiden names — every person has a single name field — so we use whatever's stored.

Phase 12 work:

1. Add an optional `maiden_name` column on the persons table (nullable, free-text).
2. People Manager: surface a "Maiden name" field on the person editor (visible for any person regardless of gender — same field).
3. Trees Panel header: prefer `maiden_name` over the surname extracted from `name`/`full_name` when computing `branchSurname` for ancestor chevrons.
4. Decide whether the canvas card name display ever shows the maiden name (probably not — primary identity is current name).

Marked as **phase 12** so we revisit after the panel UX is fully landed.

---

End of design doc. Implementation begins after Terry signs off on this document.
