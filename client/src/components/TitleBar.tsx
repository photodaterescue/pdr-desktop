import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Sun, Moon, Brain, Pause, Play, X as XIcon, ChevronLeft, ChevronRight, ArrowLeft, Trash2, RotateCcw } from 'lucide-react';
import { LicenseStatusBadge } from '@/components/LicenseModal';
import { TrialCounterChip } from '@/components/TrialCounterChip';
import { LibraryStatusButton } from '@/components/LibraryStatusButton';
import { onAiProgress, pauseAi, resumeAi, cancelAi, getRecycleBinCount, onRecycleBinChanged, getSettings, type AiProgress } from '@/lib/electron-bridge';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { TourLauncher, type TourMenuItem } from '@/components/TourLauncher';
import { useAlbumReturnSource, setAlbumReturnSource, setPendingAlbumOpen } from '@/lib/album-return-source';
import { useMemoriesReturnSource, setMemoriesReturnSource } from '@/lib/memories-return-source';
import type { TourStep, TourMeta } from '@/components/ui/tour-overlay';

/**
 * Custom title bar — PDR branding left, lavender right.
 * Rendered once at the app root so it appears on all views.
 *
 * Hosts two app-global controls on the right side of the lavender area so
 * they stay visible regardless of which view is active (Dashboard, S&D,
 * Memories, Trees):
 *   - Light/dark theme toggle
 *   - Licensed / Unlicensed status badge
 *
 * Behaviour:
 *  - When sidebar is expanded (> ~100px): title "Photo Date Rescue" sits next to the logo on the left
 *    over the white sidebar-matching background
 *  - When sidebar is collapsed (narrow strip): logo stays at its natural size (not squished),
 *    and the title "Photo Date Rescue" moves to the horizontal center of the lavender bar
 */
export function TitleBar() {
  // Library pill is workspace-context. Hide it on the Welcome ("/")
  // route — the post-LDM modals (Library Planner → DDA → folder
  // picker) live inside DashboardPanel and aren't mounted on
  // Welcome, so clicking through would silently dead-end. The
  // Welcome screen is for entering the app, not configuring it.
  // (Terry's call, 2026-05-16: "I think I want the library tab
  // disabled in the welcome screen. This isn't the location to be
  // using it anyhow.")
  const location = useLocation();
  const showLibraryPill = location.pathname !== '/';

  // Back-to-album affordance — non-null when the user navigated INTO
  // S&D or Memories from an empty album's CTA. Cleared by workspace
  // when the user opens any other top-level surface (Dashboard,
  // Trees, PM). Visible regardless of route because TitleBar is
  // mounted at the app root. v2.0.8 step 6 polish (Terry 2026-05-19).
  const albumReturnSource = useAlbumReturnSource();
  const memoriesReturnSource = useMemoriesReturnSource();

  const [sidebarWidth, setSidebarWidth] = useState<number>(280);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    if (typeof document === 'undefined') return false;
    return document.documentElement.classList.contains('dark');
  });
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null);
  // The flashing pill can be distracting across long re-tagging runs.
  // When collapsed, the pill shrinks from the left toward the right,
  // leaving a small static icon (no pulse) anchored on the right that
  // can be clicked to expand again.
  const [pillCollapsed, setPillCollapsed] = useState(false);
  // Per-view tour menu — each route (Home / Source Selection /
  // Workspace) and each Workspace view (Memories / S&D / Trees /
  // Reports) dispatches a 'pdr:tourMenu' CustomEvent on mount or
  // whenever its active view changes. The TitleBar stores the
  // latest payload and renders the global "?" launcher with the
  // right items for whatever the user is currently looking at.
  // Events with `null` items hide the launcher (e.g. Home before
  // the first source is added — no tours apply yet).
  const [tourMenuItems, setTourMenuItems] = useState<TourMenuItem[] | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ items: TourMenuItem[] | null }>).detail;
      setTourMenuItems(detail?.items ?? null);
    };
    window.addEventListener('pdr:tourMenu', handler as EventListener);
    return () => window.removeEventListener('pdr:tourMenu', handler as EventListener);
  }, []);
  // Starting a tour bounces back through another CustomEvent so the
  // hosting window owns the TourOverlay state — the TitleBar never
  // mounts the overlay itself (would clip behind the chrome). Meta
  // (brand name + accent) rides along so the host's TourOverlay
  // tints itself the same colour as the launcher item the user
  // clicked.
  const handleStartTour = (steps: TourStep[], meta?: TourMeta) => {
    window.dispatchEvent(new CustomEvent('pdr:startTour', { detail: { steps, meta } }));
  };
  // Use the *primary* registered item's accent as the trigger pill
  // colour. The primary entry is "Quick Tour for the current view",
  // so the launcher button takes that view's brand colour and the
  // pill follows the user across views (lavender on Workspace,
  // blue on S&D, amber on Memories, etc.). Falls back to undefined
  // if no primary item is registered, in which case TourLauncher
  // uses its default styling.
  const primaryAccent = tourMenuItems?.find(i => i.primary)?.meta?.accent;

  // Subscribe to AI progress once at mount. onAiProgress returns a
  // per-handler unsubscribe so other renderer components (SearchPanel)
  // can subscribe independently without clobbering this one.
  useEffect(() => {
    const unsub = onAiProgress((p) => setAiProgress(p));
    return () => { unsub(); };
  }, []);

  // v2.0.15 (Terry 2026-05-29) — live Recycle Bin count for the
  // titlebar badge. Refreshes on every recycle:changed broadcast so
  // the number stays in sync without polling.
  const [recycleCount, setRecycleCount] = useState<number>(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const r = await getRecycleBinCount();
      if (!cancelled && r.success) setRecycleCount(r.count ?? 0);
    };
    refresh();
    const off = onRecycleBinChanged(() => { void refresh(); });
    return () => { cancelled = true; off(); };
  }, []);

  // v2.0.15 (Terry 2026-05-29) — Settings → General toggle that
  // controls whether the count badge appears on the titlebar's
  // Recycle Bin icon. Loaded once at mount; refreshed live via the
  // `pdr:settingsChanged` window event the Settings modal dispatches
  // so toggling doesn't require a relaunch. Default OFF — the count
  // is always available in the hover tooltip regardless.
  const [showCountBadge, setShowCountBadge] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    getSettings().then((s) => {
      if (!cancelled) setShowCountBadge(!!(s as any)?.recycleBinShowCountBadge);
    }).catch(() => { /* best-effort */ });
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; value: unknown }>).detail;
      if (detail?.key === 'recycleBinShowCountBadge') setShowCountBadge(!!detail.value);
    };
    window.addEventListener('pdr:settingsChanged', handler as EventListener);
    return () => { cancelled = true; window.removeEventListener('pdr:settingsChanged', handler as EventListener); };
  }, []);

  const aiProcessing = aiProgress != null
    && aiProgress.phase !== 'complete'
    && aiProgress.phase !== 'error';

  useEffect(() => {
    // Observe the --sidebar-width CSS variable changes
    const update = () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim();
      const px = parseFloat(raw) || 280;
      setSidebarWidth(px);
    };
    update();
    // Poll occasionally — CSS var changes don't trigger observers directly
    const interval = setInterval(update, 200);
    return () => clearInterval(interval);
  }, []);

  // Sync local dark-mode state when another surface (Settings, keyboard
  // shortcut) flips the documentElement class.
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.classList.contains('dark'));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const toggleDarkMode = () => {
    const next = !isDarkMode;
    if (next) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    setIsDarkMode(next);
    try { localStorage.setItem('pdr-dark-mode', next ? 'true' : 'false'); } catch {}
    (window as any).pdr?.setTitleBarColor?.(next);
  };

  const isSidebarCollapsed = sidebarWidth < 100;
  // When collapsed, the white section holds just the logo at a fixed minimum width
  const whiteSectionWidth = isSidebarCollapsed ? 48 : sidebarWidth;

  // Pointer-down handler that broadcasts a custom event whenever the
  // user interacts with the titlebar. -webkit-app-region: drag
  // normally swallows mouse events so renderer-level click-outside
  // listeners don't fire — this gives every popover/dropdown a
  // reliable signal to close. Terry 2026-05-19: "clicking on the
  // titlebar should also make the drop down disappear". Fires for
  // every interaction (drag or click); listeners can de-bounce if
  // needed.
  const broadcastTitlebarPointer = () => {
    try { window.dispatchEvent(new CustomEvent('pdr:titlebar-pointer')); } catch {}
  };
  return (
    <div
      className="custom-title-bar flex items-center shrink-0 select-none z-50 relative"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      onPointerDown={broadcastTitlebarPointer}
      onMouseDown={broadcastTitlebarPointer}
    >
      {/* Left: white section with logo (+ text when expanded) */}
      <div
        className="flex items-center gap-2 h-full bg-white dark:bg-sidebar shrink-0 border-r sidebar-container"
        style={{
          WebkitAppRegion: 'drag',
          width: `${whiteSectionWidth}px`,
          transition: 'width 0.35s cubic-bezier(0.22, 1, 0.36, 1), padding 0.35s cubic-bezier(0.22, 1, 0.36, 1)',
          willChange: 'width',
          justifyContent: isSidebarCollapsed ? 'center' : 'flex-start',
          paddingLeft: isSidebarCollapsed ? 0 : '16px',
          paddingRight: isSidebarCollapsed ? 0 : '16px',
        } as React.CSSProperties}
      >
        <img
          src="./assets/pdr-logo_transparent.png"
          className="w-5 h-5 object-contain shrink-0"
          alt="PDR"
        />
        {!isSidebarCollapsed && (
          <span className="text-[12px] text-foreground font-semibold tracking-wide whitespace-nowrap font-heading">
            Photo Date Rescue
          </span>
        )}
      </div>

      {/* When collapsed: "Photo Date Rescue" title left-aligned, starting right after the white section */}
      {isSidebarCollapsed && (
        <span
          className="text-[12px] text-foreground/80 font-semibold tracking-wide whitespace-nowrap font-heading pl-3"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          Photo Date Rescue
        </span>
      )}

      {/* Back-to-album affordance (v2.0.8 step 6, Terry 2026-05-19).
          When the user reached S&D or Memories via an empty-album
          CTA, this pill sits right of "Photo Date Rescue" — gold + white
          so it stands out from the lavender title bar as a
          "purposeful visit" reminder. Click returns to that specific
          album; auto-dismisses when the user opens any other top-level
          surface. Wrapped in a no-drag region so the click registers
          without being swallowed by the title-bar drag chrome. */}
      {albumReturnSource && (
        <div
          className="flex items-center gap-2 pl-3"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          data-testid="titlebar-album-return"
        >
          <span className="h-5 w-px bg-foreground/20" aria-hidden="true" />
          {/* Single chip with TWO inline actions — gold pill body
              (click to go back) + small white X cap (click to
              dismiss without going back). Same iOS/macOS dismissable-
              chip pattern used elsewhere in PDR. */}
          <div
            className="inline-flex items-center rounded-full shadow-sm overflow-hidden"
            style={{ backgroundColor: 'var(--color-gold)' }}
          >
            <IconTooltip label="Return to the album you came from" side="bottom">
              <button
                type="button"
                onClick={() => {
                  const id = albumReturnSource.albumId;
                  setAlbumReturnSource(null);
                  setPendingAlbumOpen(id);
                  try { localStorage.setItem('pdr-albums-pending-open', String(id)); } catch { /* localStorage may be unavailable */ }
                  window.dispatchEvent(new CustomEvent('pdr:openAlbumsAlbum', { detail: { id } }));
                }}
                className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1 text-xs font-semibold text-white transition-colors hover:brightness-105"
                data-testid="titlebar-album-return-button"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to "{albumReturnSource.title}"
              </button>
            </IconTooltip>
            <IconTooltip label="Dismiss — don't take me back" side="bottom">
              <button
                type="button"
                onClick={() => setAlbumReturnSource(null)}
                className="inline-flex items-center justify-center pr-2.5 pl-1 py-1 text-white/90 hover:text-white hover:bg-black/10 transition-colors"
                data-testid="titlebar-album-return-dismiss"
                aria-label="Dismiss back-to-album pill"
              >
                <XIcon className="w-3.5 h-3.5" />
              </button>
            </IconTooltip>
          </div>
        </div>
      )}

      {/* v2.0.15 (Terry 2026-06-02) — back-to-Memories pill. Mirror
          of the album-return chip above, fired when the user lands
          in S&D via Memories' Send-to-S&D. Same chip chrome AND
          same gold (--color-gold) as the album pill — that's Memories'
          actual sidebar accent colour (SIDEBAR_ACCENT.amber in
          workspace.tsx), and Albums live under Memories so they
          rightly share the brand colour. The two pills can both
          appear at once if the user is in an album AND used
          Send-to-S&D — labels distinguish them. */}
      {memoriesReturnSource && (
        <div
          className="flex items-center gap-2 pl-3"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          data-testid="titlebar-memories-return"
        >
          <span className="h-5 w-px bg-foreground/20" aria-hidden="true" />
          <div
            className="inline-flex items-center rounded-full shadow-sm overflow-hidden"
            style={{ backgroundColor: 'var(--color-gold)' }}
          >
            <IconTooltip label="Return to where you came from in Memories" side="bottom">
              <button
                type="button"
                onClick={() => {
                  const tab = memoriesReturnSource.tab;
                  const drilldown = memoriesReturnSource.drilldown;
                  const albumId = memoriesReturnSource.albumId;
                  const scrollToFileId = memoriesReturnSource.scrollToFileId;
                  setMemoriesReturnSource(null);
                  // v2.0.15 (Terry 2026-06-02) — write the latches
                  // SYNCHRONOUSLY before flipping the view. The
                  // target components (MemoriesView / AlbumsView)
                  // read these keys at useState init time (NOT in
                  // a useEffect) so the very first render lands
                  // correctly — bypassing the listener race that
                  // made the earlier event-listener approach
                  // unreliable. Each component clears its own key
                  // after reading so a stale value can't hijack a
                  // future mount.
                  if (drilldown) {
                    try { localStorage.setItem('pdr-memories-pending-drilldown', JSON.stringify(drilldown)); } catch { /* localStorage may be unavailable */ }
                  }
                  if (typeof albumId === 'number') {
                    try { localStorage.setItem('pdr-albums-pending-open', String(albumId)); } catch { /* localStorage may be unavailable */ }
                    // Also ensure MemoriesPanel mounts on the Albums
                    // tab so AlbumsView's init actually runs.
                    try { localStorage.setItem('pdr-memories-tab', 'albums'); } catch { /* localStorage may be unavailable */ }
                  }
                  // v2.0.15 (Terry 2026-06-02) — scroll-to-file latch.
                  // After the drilldown or album loads its file list,
                  // the target view reads this id and scrolls the
                  // matching tile into view so the user lands at the
                  // exact spot they right-clicked from.
                  if (typeof scrollToFileId === 'number') {
                    try { localStorage.setItem('pdr-memories-pending-scroll-to', String(scrollToFileId)); } catch { /* localStorage may be unavailable */ }
                  }
                  window.dispatchEvent(new CustomEvent('pdr:memoriesSwitchTab', { detail: { tab, drilldown } }));
                }}
                className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1 text-xs font-semibold text-white transition-colors hover:brightness-110"
                data-testid="titlebar-memories-return-button"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to {memoriesReturnSource.label ?? (memoriesReturnSource.tab === 'albums' ? 'Memories — Albums' : 'Memories — Dates')}
              </button>
            </IconTooltip>
            <IconTooltip label="Dismiss — don't take me back" side="bottom">
              <button
                type="button"
                onClick={() => setMemoriesReturnSource(null)}
                className="inline-flex items-center justify-center pr-2.5 pl-1 py-1 text-white/90 hover:text-white hover:bg-black/10 transition-colors"
                data-testid="titlebar-memories-return-dismiss"
                aria-label="Dismiss back-to-Memories pill"
              >
                <XIcon className="w-3.5 h-3.5" />
              </button>
            </IconTooltip>
          </div>
        </div>
      )}

      {/* Rest: lavender draggable area */}
      <div className="flex-1" />

      {/* App-global controls — visible on every view. The no-drag wrapper is
          required so clicks aren't swallowed by the title-bar's drag region. */}
      <div
        className="flex items-center gap-1.5 pr-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* AI progress pill — shown on every view while re-tagging or
            first-time analysis is running. "Tagging X/Y" for tags-only
            re-runs, "Analyzing X/Y" for the combined faces+tags flow.
            Collapsible: click the chevron on the left to shrink the
            pill down to just an icon (no pulse). */}
        {aiProcessing && (
          pillCollapsed ? (
            <IconTooltip label={aiProgress ? `Expand — ${aiProgress.tagsOnly ? 'Tagging' : 'Analyzing'} ${aiProgress.current}/${aiProgress.total}` : 'Expand'} side="bottom">
              <button
                onClick={() => setPillCollapsed(false)}
                className="flex items-center gap-1 text-xs text-white font-medium bg-purple-500/30 hover:bg-purple-500/45 px-2 py-1 rounded-full transition-colors"
              >
                <ChevronLeft className="w-3 h-3 opacity-80" />
                <Brain className="w-3.5 h-3.5" />
              </button>
            </IconTooltip>
          ) : (
            <span className={`flex items-center gap-1.5 text-xs text-white font-medium ${aiProgress?.phase === 'paused' ? 'bg-amber-500/30' : 'bg-purple-500/30'} px-2.5 py-1 rounded-full ${aiProgress?.phase === 'paused' ? '' : 'animate-pulse'}`}>
              <IconTooltip label="Collapse — keeps the pill out of your peripheral vision while the run continues in the background." side="bottom">
                <button
                  onClick={() => setPillCollapsed(true)}
                  className="-ml-0.5 mr-0.5 hover:text-white/90"
                >
                  <ChevronRight className="w-3 h-3" />
                </button>
              </IconTooltip>
              {aiProgress?.phase === 'paused' ? (
                <Pause className="w-3.5 h-3.5" />
              ) : (
                <Brain className="w-3.5 h-3.5 animate-spin" />
              )}
              {!aiProgress ? 'Starting AI analysis...' :
               aiProgress.phase === 'downloading-models' ? `Downloading AI models${aiProgress.modelDownloadProgress ? ` (${aiProgress.modelDownloadProgress.percent}%)` : ''}...` :
               aiProgress.phase === 'clustering' ? 'Clustering faces...' :
               aiProgress.phase === 'paused' ? `Paused ${aiProgress.current}/${aiProgress.total}` :
               `${aiProgress.tagsOnly ? 'Tagging' : 'Analyzing'} ${aiProgress.current}/${aiProgress.total}`}
              {aiProgress?.phase === 'paused' ? (
                <IconTooltip label="Resume" side="bottom">
                  <button onClick={() => resumeAi()} className="ml-1 hover:text-white/90"><Play className="w-3 h-3" /></button>
                </IconTooltip>
              ) : (
                <IconTooltip label="Pause" side="bottom">
                  <button onClick={() => pauseAi()} className="ml-1 hover:text-white/90"><Pause className="w-3 h-3" /></button>
                </IconTooltip>
              )}
              <IconTooltip label="Cancel" side="bottom">
                <button onClick={() => cancelAi()} className="ml-0.5 hover:text-white/90"><XIcon className="w-3 h-3" /></button>
              </IconTooltip>
            </span>
          )
        )}
        {/* v2.0.15 (Terry 2026-05-29) — Recycle Bin shortcut. Sits
            JUST LEFT of the TourLauncher "?" so it's reachable from
            any view (Dashboard, S&D, Memories, Trees) without
            hunting through the sidebar. Live count badge appears
            when the bin is non-empty. Dispatches a window event
            that workspace.tsx listens for (mirrors the
            pdr:openLicenseModal / pdr:memoriesSwitchTab pattern) so
            TitleBar doesn't need to know about activeView state.
            Styling copies the dark-mode toggle below — same w-7 h-7
            rounded-full hover-on-white pattern that defines the
            titlebar's button family. */}
        {/* v2.0.15 (Terry 2026-05-29) — count badge is opt-in via
            Settings → General → "Show Recycle Bin count on titlebar"
            (default OFF, so the icon stays clean for everyone by
            default; power users who want at-a-glance "anything to
            empty?" visibility can flip it on). The count is always
            in the hover tooltip regardless of the badge setting.
            Switching to `relative` on the button only when the badge
            is showing keeps the icon perfectly centred when the
            badge is hidden. */}
        <IconTooltip label={recycleCount > 0 ? `Recycle Bin · ${recycleCount} item${recycleCount === 1 ? '' : 's'}` : 'Recycle Bin'} side="bottom">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('pdr:openRecycleBin'))}
            className={`${showCountBadge && recycleCount > 0 ? 'relative ' : ''}flex items-center justify-center w-7 h-7 rounded-full hover:bg-white/20 text-white/80 hover:text-white transition-all`}
            data-testid="titlebar-recycle-bin"
            aria-label={recycleCount > 0 ? `Recycle Bin, ${recycleCount} items` : 'Recycle Bin'}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {showCountBadge && recycleCount > 0 && (
              <span
                className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full bg-[var(--color-gold)] text-[#1f1a08] text-[9px] font-bold leading-none border border-primary"
                aria-hidden
              >
                {recycleCount > 99 ? '99+' : recycleCount}
              </span>
            )}
          </button>
        </IconTooltip>
        {/* v2.0.15 (Terry 2026-05-29) — universal Refresh button.
            Dispatches pdr:refreshActiveView which each view
            subscribes to and handles its own re-fetch (MemoriesView
            re-pulls buckets, drilldown re-pulls files, AlbumsView
            re-runs refreshAll, SearchPanel re-runs the current
            search). Frees per-view header real estate AND fixes the
            position inconsistency across Albums / By Date / S&D —
            same place on every page now. Styling matches the
            Recycle Bin button next to it. */}
        <IconTooltip label="Refresh — reload this view" side="bottom">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('pdr:refreshActiveView'))}
            className="flex items-center justify-center w-7 h-7 rounded-full hover:bg-white/20 text-white/80 hover:text-white transition-all"
            data-testid="titlebar-refresh"
            aria-label="Refresh"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </IconTooltip>
        {tourMenuItems && tourMenuItems.length > 0 && (
          <TourLauncher
            items={tourMenuItems}
            onStartTour={handleStartTour}
            triggerStyle="titlebar"
            triggerAccent={primaryAccent}
          />
        )}
        <IconTooltip label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'} side="bottom">
          <button
            onClick={toggleDarkMode}
            className="flex items-center justify-center w-7 h-7 rounded-full hover:bg-white/20 text-white/80 hover:text-white transition-all"
          >
            {isDarkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
        </IconTooltip>
        {/* Free Trial file counter — only renders when the
            current license is on the `'free'` plan, otherwise null.
            Sits left of LicenseStatusBadge so the user reads "trial
            usage → license state" left-to-right. Self-contained:
            uses useLicense() internally + listens for
            `pdr:trialUsageUpdate` to live-refresh after each Fix. */}
        <TrialCounterChip />
        {showLibraryPill && <LibraryStatusButton />}
        <LicenseStatusBadge
          onClick={() => window.dispatchEvent(new CustomEvent('pdr:openLicenseModal'))}
        />
      </div>

      {/* Spacer for native window controls overlay area */}
      <div className="w-[140px] shrink-0" />
    </div>
  );
}
