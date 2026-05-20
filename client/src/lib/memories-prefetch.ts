/**
 * Memories prefetch — module-level cache populated by the Welcome
 * Screen so that when the user clicks the Memories sidebar link
 * the panel can hydrate from RAM instead of firing fresh IPC calls.
 *
 * Pattern parallels PM's prewarmPeopleWindow in main.ts but for an
 * in-renderer panel rather than a separate Electron window. Terry
 * 2026-05-20: "if that's successful, we can then roll out this
 * method to all the internal apps/tools". This file is the
 * prototype; success here pulls the same shape across to AlbumsView,
 * SearchPanel, etc.
 *
 * Why a module singleton rather than React context: the prefetcher
 * runs from the Welcome page (one component tree), the consumer is
 * MemoriesView mounted inside Workspace (a sibling tree, mounted
 * later after route change). They never share a render context, so
 * a top-level Provider would have to wrap App.tsx — heavier than
 * just a typed module-scoped Map.
 *
 * The cache holds:
 *   - `buckets` — MemoriesYearBucket[] from getMemoriesYearMonthBuckets
 *     (no runIds filter, so it's the full timeline).
 *   - `thumbs` — Map<filePath, dataUrl>. Pre-decoded base64 data URLs
 *     keyed on the sample-file path that MonthTile renders. The
 *     equivalent disk-cache hit would still cost a file read +
 *     base64 encode + IPC roundtrip per tile (≈5–15ms × 36 visible
 *     tiles + AI-worker contention = the 5-second flash Terry saw);
 *     having the data URLs in RAM means MonthTile's first render
 *     already has the image.
 *
 * Lifetime: lives for the renderer process's lifetime. Re-mounting
 * Welcome (e.g. user navigates back from Workspace) does NOT re-fetch
 * because `ready` is already true. The data is small (~132 buckets,
 * ~132 × 10KB ≈ 1.3 MB of base64 thumbnails for Terry's library)
 * so the memory cost is negligible compared to the UX win.
 */

import {
  getMemoriesYearMonthBuckets,
  getThumbnail,
  type MemoriesYearBucket,
} from './electron-bridge';

// MUST match MemoriesView's MonthTile getThumbnail size. If those
// ever diverge, the disk cache (md5(filePath:size)) misses and the
// pre-warm thumbnail is wasted bytes. Single source of truth.
export const MEMORIES_TILE_SIZE = 160;

interface PrefetchState {
  buckets: MemoriesYearBucket[] | null;
  thumbs: Map<string, string>;
  ready: boolean;
  // While the prefetch is in flight a second caller (e.g. a fast
  // re-mount of Welcome) joins the same promise rather than firing
  // a second pass.
  inFlight: Promise<void> | null;
}

const state: PrefetchState = {
  buckets: null,
  thumbs: new Map(),
  ready: false,
  inFlight: null,
};

export async function prefetchMemories(): Promise<void> {
  if (state.ready) return;
  if (state.inFlight) return state.inFlight;

  state.inFlight = (async () => {
    try {
      const t0 = performance.now();
      // eslint-disable-next-line no-console
      console.log('[Welcome] Memories pre-warm: starting');
      const res = await getMemoriesYearMonthBuckets();
      if (!res.success || !res.data) {
        // eslint-disable-next-line no-console
        console.log('[Welcome] Memories pre-warm: bucket fetch failed');
        return;
      }
      state.buckets = res.data;
      // eslint-disable-next-line no-console
      console.log(`[Welcome] Memories pre-warm: ${res.data.length} buckets fetched in ${Math.round(performance.now() - t0)}ms`);

      // Pool of 4 — matches the workspace-side prewarm pool. Higher
      // would saturate the IPC channel and starve foreground work
      // (e.g. a sidebar click landing in the middle of the prewarm).
      const queue: string[] = [];
      const seen = new Set<string>();
      for (const b of res.data) {
        if (b.sampleFilePath && !seen.has(b.sampleFilePath)) {
          seen.add(b.sampleFilePath);
          queue.push(b.sampleFilePath);
        }
      }
      const POOL = 4;
      const worker = async () => {
        while (queue.length > 0) {
          const path = queue.shift();
          if (!path) continue;
          try {
            const r = await getThumbnail(path, MEMORIES_TILE_SIZE);
            if (r.success && r.dataUrl) state.thumbs.set(path, r.dataUrl);
          } catch { /* per-tile failure is non-fatal */ }
        }
      };
      const tThumbs = performance.now();
      await Promise.all(Array.from({ length: POOL }, worker));
      // eslint-disable-next-line no-console
      console.log(`[Welcome] Memories pre-warm: ${state.thumbs.size}/${seen.size} thumbnails warmed in ${Math.round(performance.now() - tThumbs)}ms`);
      state.ready = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log('[Welcome] Memories pre-warm: error', err);
    }
  })();

  return state.inFlight;
}

/**
 * Synchronous read for the consumer (MemoriesView) on mount. Returns
 * null when the prefetch hasn't completed yet — in which case the
 * caller falls back to its own fetch path (no regression vs. the
 * pre-prefetch behaviour).
 */
export function getPrefetchedMemories(): {
  buckets: MemoriesYearBucket[];
  thumbs: Map<string, string>;
} | null {
  if (!state.ready || !state.buckets) return null;
  return { buckets: state.buckets, thumbs: state.thumbs };
}

/**
 * Look up a single pre-warmed thumbnail by sample-file path.
 * MonthTile uses this in its useState initialiser so the very
 * first render has the image instead of an icon placeholder.
 */
export function getPrefetchedThumb(filePath: string): string | undefined {
  return state.thumbs.get(filePath);
}
