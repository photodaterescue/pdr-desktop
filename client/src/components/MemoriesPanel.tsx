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

import { useState } from 'react';
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

  const handleTabChange = (next: string) => {
    const nextTyped: MemoriesTab = next === 'albums' ? 'albums' : 'byDate';
    setTab(nextTyped);
    try { localStorage.setItem(TAB_STORAGE_KEY, nextTyped); } catch { /* localStorage may be unavailable */ }
  };

  return (
    <Tabs value={tab} onValueChange={handleTabChange} className="flex flex-col h-full">
      {/* Section header + tab strip. "Memories" is a top-level Workspace
          surface; previous version's "By Date" / "Albums" pills read as
          minor sub-controls. Now: page title set in lg, tabs sit
          beneath it as a proper view-switcher with bigger pills, taller
          h-11, and prominent active state. Terry 2026-05-18: "By Date
          and Albums are somewhat unnoticeable. They are both really
          big features, but they just look so bland... maybe it just
          needs to be written above where By Date and Albums appears." */}
      <div className="px-6 pt-5 pb-3 border-b border-border">
        <h1 className="text-2xl font-semibold text-foreground mb-3">Memories</h1>
        <TabsList className="h-11 p-1">
          <TabsTrigger
            value="byDate"
            data-testid="tab-memories-by-date"
            className="gap-2 px-4 h-9 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <CalendarRange className="w-4 h-4" />
            By Date
          </TabsTrigger>
          <TabsTrigger
            value="albums"
            data-testid="tab-memories-albums"
            className="gap-2 px-4 h-9 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <FolderPlus className="w-4 h-4" />
            Albums
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="byDate" className="flex-1 min-h-0 mt-0">
        <MemoriesView />
      </TabsContent>
      <TabsContent value="albums" className="flex-1 min-h-0 mt-0">
        <AlbumsView />
      </TabsContent>
    </Tabs>
  );
}
