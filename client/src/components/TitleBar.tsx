import React, { useEffect, useState } from 'react';
import { Sun, Moon, Brain, Pause, Play, X as XIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { LicenseStatusBadge } from '@/components/LicenseModal';
import { TrialCounterChip } from '@/components/TrialCounterChip';
import { onAiProgress, pauseAi, resumeAi, cancelAi, type AiProgress } from '@/lib/electron-bridge';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { TourLauncher, type TourMenuItem } from '@/components/TourLauncher';
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

  return (
    <div
      className="custom-title-bar flex items-center shrink-0 select-none z-50 relative"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
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
        {/* Free Trial 200-file counter — only renders when the
            current license is on the `'free'` plan, otherwise null.
            Sits left of LicenseStatusBadge so the user reads "trial
            usage → license state" left-to-right. Self-contained:
            uses useLicense() internally + listens for
            `pdr:trialUsageUpdate` to live-refresh after each Fix. */}
        <TrialCounterChip />
        <LicenseStatusBadge
          onClick={() => window.dispatchEvent(new CustomEvent('pdr:openLicenseModal'))}
        />
      </div>

      {/* Spacer for native window controls overlay area */}
      <div className="w-[140px] shrink-0" />
    </div>
  );
}
