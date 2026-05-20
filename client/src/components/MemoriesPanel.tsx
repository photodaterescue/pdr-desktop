/**
 * MemoriesPanel (v2.0.8 step 3).
 *
 * Tab switcher at the top of the Memories surface — `[By Date | Albums]`.
 * "By Date" renders the existing MemoriesView (the chronological
 * year/month timeline that's been there since v1.0). "Albums" renders
 * the new AlbumsView (list of albums + per-album detail).
 *
 * The tab choice persists in localStorage so the user lands on whichever
 * tab they had open last. Default for first-time openers is "By Date" —
 * matches existing muscle memory; new users only switch to Albums after
 * they've Fixed a Takeout (which auto-populates albums) or hand-created
 * one.
 *
 * Uses PDR's Tabs primitive from `@/components/ui/tabs` (Radix-based,
 * pill-segmented styling) per the style-guide rule "Existing primitives
 * live in client/src/components/ui/ — reuse one if it fits." The
 * segmented-pill look reads as "equal alternates" in a way that suits a
 * top-level view switcher; underline-tabs are reserved for sub-section
 * navigation inside denser surfaces (e.g. Settings).
 */

import { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { CalendarRange, FolderPlus } from 'lucide-react';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import MemoriesView from './MemoriesView';
import AlbumsView from './AlbumsView';

type MemoriesTab = 'byDate' | 'albums';

const TAB_STORAGE_KEY = 'pdr-memories-tab';

function loadInitialTab(): MemoriesTab {
  if (typeof localStorage === 'undefined') return 'byDate';
  return localStorage.getItem(TAB_STORAGE_KEY) === 'albums' ? 'albums' : 'byDate';
}

export default function MemoriesPanel() {
  const [tab, setTab] = useState<MemoriesTab>(loadInitialTab);

  // Slot DOM node next to the [By Date | Albums] toggle. MemoriesView
  // portals its summary / Jump-to-latest / density toggle / library
  // selector into this slot so they live on the toggle's row instead
  // of consuming a second header strip below. Terry 2026-05-20: the
  // empty horizontal space next to the toggle was wasted real estate;
  // packing the controls onto the same row frees a row's worth of
  // vertical space for the actual photo grid. Stored as state (not a
  // ref) so MemoriesView re-portals when the node mounts on first
  // render — ref alone would land MemoriesView's effect a tick too
  // early and skip the portal.
  const [byDateControlsSlot, setByDateControlsSlot] = useState<HTMLDivElement | null>(null);

  // Cross-component nav: empty-album state CTAs in AlbumsView dispatch
  // `pdr:memoriesSwitchTab` with detail = string | { tab, from }.
  // Keeps the AlbumsView decoupled from MemoriesPanel state — no
  // prop drilling, no callback threading — while still letting the
  // empty-album CTA route the user to the chronological timeline
  // where they can pick photos to add to the album. The `from`
  // payload (when present) is consumed by workspace.tsx separately
  // to set the AlbumReturnSource singleton.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // Two payload shapes supported:
      //   1. Bare string ('byDate' | 'albums') — legacy callers.
      //   2. Object { tab, from } — v2.0.8 empty-album CTAs.
      let wantedTab: MemoriesTab = 'byDate';
      if (typeof detail === 'string') {
        wantedTab = detail === 'albums' ? 'albums' : 'byDate';
      } else if (detail && typeof detail === 'object' && 'tab' in detail) {
        wantedTab = (detail as { tab: string }).tab === 'albums' ? 'albums' : 'byDate';
      }
      setTab(wantedTab);
      try { localStorage.setItem(TAB_STORAGE_KEY, wantedTab); } catch { /* localStorage may be unavailable */ }
    };
    window.addEventListener('pdr:memoriesSwitchTab', handler as EventListener);
    return () => window.removeEventListener('pdr:memoriesSwitchTab', handler as EventListener);
  }, []);

  // Back-pill nav from SearchPanel / MemoriesView "Back to album"
  // dispatches `pdr:openAlbumsAlbum` with detail = { id }. Switch
  // this panel to the Albums tab so AlbumsView's own listener can
  // do the album-selection step.
  useEffect(() => {
    const handler = () => {
      setTab('albums');
      try { localStorage.setItem(TAB_STORAGE_KEY, 'albums'); } catch { /* localStorage may be unavailable */ }
    };
    window.addEventListener('pdr:openAlbumsAlbum', handler as EventListener);
    return () => window.removeEventListener('pdr:openAlbumsAlbum', handler as EventListener);
  }, []);

  // Sliding-thumb refs + state. The white pill that marks the active
  // tab is a single absolute-positioned div inside the TabsList;
  // when the tab changes we re-measure the target trigger's offset
  // and animate left+width. This gives the premium iOS-segmented
  // feel rather than the snap-of-two-backgrounds default. Terry
  // 2026-05-18: "Can you make the transition... seem premium? It
  // feels robotic at the moment."
  const byDateRef = useRef<HTMLSpanElement>(null);
  const albumsRef = useRef<HTMLSpanElement>(null);
  const [thumbStyle, setThumbStyle] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const target = tab === 'byDate' ? byDateRef.current : albumsRef.current;
    if (target) {
      setThumbStyle({ left: target.offsetLeft, width: target.offsetWidth });
    }
  }, [tab]);

  const handleTabChange = (next: string) => {
    const nextTyped: MemoriesTab = next === 'albums' ? 'albums' : 'byDate';
    setTab(nextTyped);
    try { localStorage.setItem(TAB_STORAGE_KEY, nextTyped); } catch { /* localStorage may be unavailable */ }
  };

  // Header content (h1 + sliding tab switcher) — rendered inside
  // EACH TabsContent at the same padding so the toggle's x-position
  // stays consistent when flipping tabs. The header lives inside
  // each pane (not hoisted above the tabs) so Albums can pass it
  // into the LEFT pane's headerSlot — that's what keeps the vertical
  // divider between the tree and the right content running all the
  // way up to the title bar (Terry 2026-05-18: "The pencil bar should
  // go all the way to the title bar").
  //
  // The toggle itself is a single click-anywhere button (Terry
  // 2026-05-19: "they just click it anywhere and it toggles the
  // other way"). Inner spans are visual labels; the sliding white
  // thumb sits behind whichever is active.
  const headerInner = (
    <>
      <h1 className="text-2xl font-semibold text-foreground mb-3">Memories</h1>
      <div className="flex items-center gap-4 flex-wrap">
        <button
          type="button"
          onClick={() => handleTabChange(tab === 'byDate' ? 'albums' : 'byDate')}
          title={tab === 'byDate' ? 'Switch to Albums' : 'Switch to By Date'}
          className="relative inline-flex items-center h-11 p-1 bg-primary rounded-full cursor-pointer shrink-0"
          data-testid="memories-tab-toggle"
        >
          {thumbStyle && (
            <span
              aria-hidden
              className="absolute top-1 h-9 bg-background rounded-full shadow-sm pointer-events-none transition-[left,width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
              style={{ left: `${thumbStyle.left}px`, width: `${thumbStyle.width}px` }}
            />
          )}
          <span
            ref={byDateRef}
            className={`relative z-10 inline-flex items-center gap-2 px-5 h-9 rounded-full text-sm font-medium transition-colors duration-300 ${tab === 'byDate' ? 'text-primary' : 'text-primary-foreground'}`}
            data-testid="tab-memories-by-date"
          >
            <CalendarRange className="w-4 h-4" />
            By Date
          </span>
          <span
            ref={albumsRef}
            className={`relative z-10 inline-flex items-center gap-2 px-5 h-9 rounded-full text-sm font-medium transition-colors duration-300 ${tab === 'albums' ? 'text-primary' : 'text-primary-foreground'}`}
            data-testid="tab-memories-albums"
          >
            <FolderPlus className="w-4 h-4" />
            Albums
          </span>
        </button>
        {/* Slot inline with the toggle pill. Only rendered on the By
            Date tab — Albums has no equivalent controls today. The
            vertical bar divider sits between the toggle and the slot
            content; aria-hidden because it's purely decorative. The
            slot is filled at runtime by MemoriesView via createPortal
            (see `byDateControlsSlot` state + the
            `headerControlsTarget` prop on MemoriesView below). When
            byDate's summary text wraps to a second line on narrow
            windows the flex-wrap on this row lets it drop cleanly
            below the toggle. */}
        {tab === 'byDate' && (
          <>
            <span aria-hidden className="text-border select-none">|</span>
            <div
              ref={(el) => setByDateControlsSlot(el)}
              className="flex items-center justify-between gap-4 flex-wrap flex-1 min-w-0"
            />
          </>
        )}
      </div>
    </>
  );

  return (
    <Tabs value={tab} onValueChange={handleTabChange} className="flex flex-col h-full">
      {/* forceMount on BOTH TabsContents keeps each tab's React state
          alive across switches. By default Radix unmounts inactive
          content, which wiped MemoriesView's drilldown position and
          AlbumsView's selection state every time the user toggled
          tabs. With forceMount the inactive content is hidden via
          [hidden]:display:none from the browser's default UA rule
          but stays in the DOM — state persists, scroll positions
          survive, and the only cost is rendering both surfaces once
          on first mount (which both are cheap). */}
      {/* headerInner is rendered ONLY inside the ACTIVE TabsContent
          — not both. Rendering it twice (once in each forceMounted
          pane) leaves the inactive pane with `display:none`, where
          the tab-trigger refs all report `offsetLeft=0, offsetWidth=0`.
          The single shared ref pair ends up measuring whichever
          instance committed last, so the thumb collapses to
          `{left:0,width:0}` (invisible) and the active label —
          which uses `text-primary` (lavender) on the lavender pill —
          becomes invisible without the white thumb behind it. The
          "By Date" segment vanishing in screenshot 1 was this bug.
          Solution: gate header rendering on `tab` so refs are
          attached to exactly one instance at a time. */}
      <TabsContent value="byDate" forceMount className="flex-1 min-h-0 mt-0 flex-col data-[state=active]:flex data-[state=inactive]:hidden">
        {/* px-4 here MUST match the px-4 wrapper passed to AlbumsView's
            headerSlot below — keeps the toggle in the same x-position
            so the eye doesn't have to retarget on tab switch. */}
        {tab === 'byDate' && (
          <div className="px-4 pt-5 pb-3 border-b border-border">
            {headerInner}
          </div>
        )}
        <div className="flex-1 min-h-0">
          <MemoriesView headerControlsTarget={byDateControlsSlot} />
        </div>
      </TabsContent>
      <TabsContent value="albums" forceMount className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden">
        <AlbumsView
          headerSlot={tab === 'albums' ? (
            <div className="px-4 pt-5 pb-3 border-b border-border">
              {headerInner}
            </div>
          ) : null}
        />
      </TabsContent>
    </Tabs>
  );
}
