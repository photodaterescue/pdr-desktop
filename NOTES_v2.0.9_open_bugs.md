# v2.0.9 — open bugs to resume

Snapshot written 2026-05-20 in the middle of the workspace-pre-mount perf pass. Three threads were live when Terry paused; this file is the handover so the next session can pick up without re-walking the diagnostic.

## 1. Memories sidebar collapse flicker on first WS → Memories click

**Symptom.** From the Welcome Screen, clicking the Memories card lands the user in Memories with the **sidebar painted wide for a frame**, then it snaps to collapsed. S&D never shows this — its sidebar is collapsed on the first paint. Subsequent visits to Memories from inside the workspace (via the sidebar icon, or after coming back from `Go to Welcome`) also behave correctly. The bug is **only the very first Welcome → Memories navigation per renderer session**.

**Underlying architecture.** The workspace is now pre-mounted from app launch (see `client/src/App.tsx` `AppShell` — `Workspace` is always rendered inside an `absolute inset-0` div with `display: isWorkspace ? 'block' : 'none'`). When the user clicks a Welcome card the URL changes to `#/workspace?view=memories`, `AppShell` re-renders, the workspace div flips to `display: block`, and the workspace's internal `?view=` handler eventually calls `setActiveView('memories')`.

The sidebar's `collapsed` state inside workspace is computed from `pinState`, `tempExpanded`, `activeView`, and (recently) `urlViewForCollapse`. The default `tempExpanded=true` is intentional — see Terry's 2026-05-19 feedback: "the workspace sidebar is collapsing immediately when I go to workspace... this should always be expanded whenever launching for the first time." A useLayoutEffect resets `tempExpanded` to `false` on activeView change so collapsing views auto-collapse.

The reason S&D works but Memories doesn't is **timing**: when activeView state changes via the URL useEffect, it cascades to the `tempExpanded` reset useLayoutEffect, and the sidebar collapses. But the browser already painted the in-between frame with `tempExpanded=true` (the FIRST render of workspace becoming visible). S&D somehow avoids this — needs further investigation (suspect: SearchPanel mounts inside its own display:none/flex container so workspace's outer sidebar doesn't visibly paint until activeView is correct).

### Attempts that didn't fix it

1. **Converted the activeView-watching `useEffect` → `useLayoutEffect`.** Theory: fire `setTempExpanded(false)` before the browser paints. Outcome: the URL handler at `client/src/pages/workspace.tsx:1308` is still a plain `useEffect`, so `setActiveView('memories')` lands a frame after the workspace becomes visible. The useLayoutEffect runs at the correct phase but its trigger (activeView changing) is too late.

2. **Added a second `useLayoutEffect` watching `searchString` (hash-derived query string).** Theory: catch the URL change synchronously before the URL handler had a chance. Outcome: Vite's minifier tree-shook the outer `searchString` constant — its only references were dep-array identifiers, which the analyser doesn't count as real uses. Renderer crashed with `ReferenceError: searchString is not defined`, gave a blank window.

3. **Switched that useLayoutEffect dep to `location` from `wouter.useLocation`.** Theory: hook return values can't be tree-shaken. Outcome: `wouter` and `react-router-dom` (the actual router driving App.tsx) don't share state. The `location` returned by wouter NEVER updates here even though the URL did change, so the effect never re-fires.

4. **Removed the dep array entirely; effect runs every render with a `tempExpanded` guard.** Theory: workspace re-renders when its parent App.tsx re-renders on URL change, so a no-deps layout effect catches every navigation. Outcome: the effect fires, but it still runs AFTER the first render's commit phase — paint 1 has the wide sidebar; paint 2 has the collapsed one. Subsequent visits work because `tempExpanded` stays `false` from the first reset.

5. **Computed `urlViewForCollapse` synchronously in the render body** from `window.location.hash`, used it in the collapse formula as `effectiveViewForCollapse`. Outcome: works for the formula but didn't fix the visible flicker because `tempExpanded=true` short-circuited the formula to "expanded".

6. **Made `urlForcesCollapse` take PRIORITY over `tempExpanded` in the collapse formula.** If the URL has `?view=memories/search/familytree`, `collapsed=true` regardless of `tempExpanded`. **This is the latest in-tree state.** Terry confirmed it still isn't right — implies my `urlViewForCollapse` is somehow reading `null` on the first render, OR there's a different render where the sidebar is computed and painted before `urlViewForCollapse` settles.

### Things to try next

These are listed in order of "most likely to actually fix":

- **Lift `activeView` state from Workspace UP into App.tsx.** Currently `activeView` lives inside Workspace; App.tsx's URL change triggers a Workspace re-render but Workspace's `activeView` state lags by one render (the URL useEffect). If App.tsx owns `activeView` and sets it synchronously from `useLocation()`'s pathname/search, the value is correct the moment Workspace becomes visible — no useEffect lag.
- **Replace `wouter.useLocation` in workspace with `react-router-dom.useLocation`.** Both routers exist in the codebase; wouter doesn't see the URL changes that drive the actual rendering. Workspace's URL-reading code currently relies on `window.location.hash` snapshots — making it use the real router would let dep arrays actually fire.
- **Pre-mount MemoriesPanel itself (not just Workspace),** so when the panel becomes visible its own sidebar has already mounted in its target state. This is the heaviest change but matches PM's prewarm shape best.
- **Disable the sidebar CSS transition for the first paint after a workspace-visible flip.** Even with state computed correctly, if there's any CSS animation on width or opacity the user sees the transition. The `.sidebar-animated` class in `client/src/index.css` has a 0.35s width transition — gating it off until after the first stable render would mask any residual flicker.

### Files touched

- `client/src/pages/workspace.tsx` — `tempExpanded` initial value, two useLayoutEffects, `urlViewForCollapse` + `urlForcesCollapse` derived values, modified `collapsed` formula.
- `client/src/App.tsx` — `AppShell` with always-mounted Workspace.

## 2. S&D shows "555 of 18,744 results" but the grid is empty

**Symptom.** Search results count appears in the header (e.g. "555 results · Showing 60 of 555") but no photo tiles render below it. Worked fine before the v2.0.9 react-window virtualisation.

**Likely cause.** The virtualised List bails out when `gridSize.width === 0 || gridSize.height === 0` (a safety check in `client/src/components/SearchPanel.tsx` ~line 4327). The `gridContainerRef` element is only rendered into the DOM when `displayFiles.length > 0` (i.e. after the first search has returned results). The mount-only ResizeObserver useEffect attached to a `null` ref originally — my latest fix re-runs it when `results` changes so it picks up the now-existing element. But on first attachment `el.clientWidth` may still be `0` if the parent flex chain hasn't laid out yet.

### Things to try next

- Remove the `gridSize === 0` early-return entirely. Pass `defaultHeight={window.innerHeight - 200}` and let react-window's auto-resize update once the container settles.
- Use a `requestAnimationFrame` after observing to read clientWidth a frame later, giving layout time to settle.
- As a fallback, render the previous CSS-grid version when gridSize is zero so the user always sees something.

### Files touched

- `client/src/components/SearchPanel.tsx` — virtualised grid block + the gridSize observer.

## 3. Refresh buttons on S&D, Memories — By Date, Albums

**Asked.** Terry 2026-05-20: "Why is there not a refresh in S&D? I thought you were going to add one. There should be a refresh in By Date and Albums also..."

**Status.** Not yet added. The auto-refresh on `pdr:libraryRebuildComplete` events fires automatically after the catch-up indexer completes, but there's no user-initiated manual reload. A small `RotateCcw`-icon button alongside the existing zoom / density / library controls on each surface would be enough.

### Files to touch

- `client/src/components/SearchPanel.tsx` — alongside the results bar
- `client/src/components/MemoriesView.tsx` — alongside the consolidated header row (already has density + library selector)
- `client/src/components/AlbumsView.tsx` — alongside the per-folder / per-album density toggle

## Quick state recap

- Build script's release-gate baking is now FOOLPROOF — passes `import.meta.env.VITE_PDR_RELEASE_GATE` via Vite's inline `define` as well as `process.env` so Trees + Date Editor cannot accidentally ungate again.
- Workspace pre-mount is live; SearchPanel takes a `paused` prop that's true unless `activeView === 'search'`, suppressing its initial search + per-tile ffmpeg spawn while hidden.
- Settings → General has a "Go to Welcome" button at the bottom for jumping out of the workspace without a full restart.
- Memories prefetch (buckets + 160px thumbnails into an in-memory cache) runs on Welcome page mount; MemoriesView consumes it synchronously so the visible Memories click stays near-instant.
- Lazy-load IntersectionObservers on month tiles + album covers — only visible tiles fetch.
- Infinite scroll in S&D is gated on `hasUserScrolledRef` so it can't chain-fire on first paint.

Everything above is committed to `feat(v2.0.9): viewer rebuild, S&D perf pass, Memories polish` (`6b7ad1c`) plus the perf+prewarm follow-ups that are NOT yet committed (the workspace pre-mount, paused S&D, sidebar useLayoutEffects, Memories prefetch module, Welcome `?view=dashboard` routing, Settings Go-to-Welcome button, and the open sidebar/S&D fixes above).
