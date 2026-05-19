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

import { useState, useRef, useLayoutEffect } from 'react';
import { CalendarRange, FolderPlus } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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

  // Sliding-thumb refs + state. The white pill that marks the active
  // tab is a single absolute-positioned div inside the TabsList;
  // when the tab changes we re-measure the target trigger's offset
  // and animate left+width. This gives the premium iOS-segmented
  // feel rather than the snap-of-two-backgrounds default. Terry
  // 2026-05-18: "Can you make the transition... seem premium? It
  // feels robotic at the moment."
  const byDateRef = useRef<HTMLButtonElement>(null);
  const albumsRef = useRef<HTMLButtonElement>(null);
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

  // Header content (h1 + sliding tab switcher) — extracted so both
  // TabsContents can render it. In By Date mode it sits at the top
  // spanning full width; in Albums mode it's passed via `headerSlot`
  // into AlbumsView's left pane so the vertical divider between the
  // tree and the right content runs up to the title bar. Only the
  // active TabsContent's instance is mounted at runtime — the refs
  // bind to whichever is current, and useLayoutEffect re-measures
  // when `tab` changes.
  const headerInner = (
    <>
      <h1 className="text-2xl font-semibold text-foreground mb-3">Memories</h1>
      <TabsList className="relative inline-flex h-11 p-1 bg-primary rounded-full">
        {thumbStyle && (
          <div
            aria-hidden
            className="absolute top-1 h-9 bg-background rounded-full shadow-sm pointer-events-none transition-[left,width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
            style={{ left: `${thumbStyle.left}px`, width: `${thumbStyle.width}px` }}
          />
        )}
        <TabsTrigger
          ref={byDateRef}
          value="byDate"
          data-testid="tab-memories-by-date"
          className="relative z-10 gap-2 px-5 h-9 rounded-full text-sm font-medium transition-colors duration-300 data-[state=active]:text-primary data-[state=inactive]:text-primary-foreground"
        >
          <CalendarRange className="w-4 h-4" />
          By Date
        </TabsTrigger>
        <TabsTrigger
          ref={albumsRef}
          value="albums"
          data-testid="tab-memories-albums"
          className="relative z-10 gap-2 px-5 h-9 rounded-full text-sm font-medium transition-colors duration-300 data-[state=active]:text-primary data-[state=inactive]:text-primary-foreground"
        >
          <FolderPlus className="w-4 h-4" />
          Albums
        </TabsTrigger>
      </TabsList>
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
          on first mount (which both are cheap). Terry 2026-05-19:
          "the user should be able to go to Albums, and then go back
          to By Date, and still be in the same place them left." */}
      <TabsContent value="byDate" forceMount className="flex-1 min-h-0 mt-0 flex-col data-[state=active]:flex data-[state=inactive]:hidden">
        <div className="px-6 pt-5 pb-3 border-b border-border">{headerInner}</div>
        <div className="flex-1 min-h-0">
          <MemoriesView />
        </div>
      </TabsContent>
      <TabsContent value="albums" forceMount className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden">
        <AlbumsView
          headerSlot={
            <div className="px-4 pt-5 pb-3 border-b border-border">
              {headerInner}
            </div>
          }
        />
      </TabsContent>
    </Tabs>
  );
}
