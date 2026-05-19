/**
 * Cross-cutting state for "user navigated FROM an empty album INTO
 * Search & Discovery / Memories By Date" (v2.0.8 step 6 polish —
 * Terry 2026-05-19).
 *
 * Lives outside React's component tree because the producer (the
 * empty-album CTA inside AlbumsView, several levels deep) and the
 * consumers (SearchPanel + MemoriesView, both top-level surfaces
 * mounted by workspace.tsx) don't share a sensible context
 * boundary. A small subscribe/setter module is leaner than a new
 * React context and avoids prop-drilling the value through the
 * full nav surface.
 *
 * The state is cleared by workspace.tsx whenever `activeView`
 * leaves both 'search' and 'memories' — opening Trees, PM,
 * Dashboard, etc. dismisses the back-pill (Terry's spec: "BUT
 * ONLY until the user opens a different app"). Clicking the back
 * pill itself also clears it after dispatching the return-nav
 * event.
 */

export interface AlbumReturnSource {
  albumId: number;
  /** Album title — shown on the back pill so the user sees which
   *  album they'll return to ("Back to 'Mum and Lilly'"). */
  title: string;
}

let current: AlbumReturnSource | null = null;
const listeners = new Set<(next: AlbumReturnSource | null) => void>();

// Pending "open this album when AlbumsView next mounts" target —
// covers the race where SearchPanel / MemoriesView dispatches the
// back-nav event BEFORE the MemoriesPanel + AlbumsView have
// re-mounted (workspace.tsx only mounts MemoriesPanel when
// activeView === 'memories'). The event listener inside AlbumsView
// can't catch an event that fired before the listener registered;
// this latched value bridges that gap. Consumers MUST consume the
// value (it's a one-shot — read clears it).
let pendingOpen: number | null = null;
export function setPendingAlbumOpen(id: number | null): void { pendingOpen = id; }
export function consumePendingAlbumOpen(): number | null {
  const v = pendingOpen;
  pendingOpen = null;
  return v;
}

export function getAlbumReturnSource(): AlbumReturnSource | null {
  return current;
}

export function setAlbumReturnSource(next: AlbumReturnSource | null): void {
  current = next;
  for (const l of listeners) {
    try { l(next); } catch { /* listener errors must not break siblings */ }
  }
}

export function subscribeAlbumReturnSource(
  listener: (next: AlbumReturnSource | null) => void
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// React hook wrapper — consumers (SearchPanel, MemoriesView) just
// call `const src = useAlbumReturnSource()` and re-render when the
// value changes. Doing the subscribe boilerplate in one place
// avoids each consumer wiring its own useEffect.
import { useEffect, useState } from 'react';

export function useAlbumReturnSource(): AlbumReturnSource | null {
  const [value, setValue] = useState<AlbumReturnSource | null>(current);
  useEffect(() => subscribeAlbumReturnSource(setValue), []);
  return value;
}
