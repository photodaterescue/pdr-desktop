import React, { useEffect, useState } from 'react';
import { Sun, Moon, Brain, Pause, Play, X as XIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { LicenseStatusBadge } from '@/components/LicenseModal';
import { onAiProgress, pauseAi, resumeAi, cancelAi, type AiProgress } from '@/lib/electron-bridge';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { TourLauncher, type TourMenuItem } from '@/components/TourLauncher';
import { FixStatusChip } from '@/components/FixStatusChip';
import type { TourStep, TourMeta } from '@/components/ui/tour-overlay';

interface WindowChromeProps {
  /**
   * Tour menu items shown in the launcher popover. Each window
   * supplies its own (Date Editor tour for the Date Editor window,
   * People Manager tour for the PM window).
   */
  tourItems: TourMenuItem[];
  /**
   * Brand accent for the launcher trigger pill — usually the same
   * as the primary tour item's meta.accent.
   */
  triggerAccent?: string;
  /**
   * Called when the user picks a tour item that has steps. The host
   * sets its own TourOverlay state from these steps + meta.
   */
  onStartTour: (steps: TourStep[], meta?: TourMeta) => void;
}

/**
 * Embedded chrome bar for pop-out PDR windows (Date Editor, People
 * Manager, future). Mirrors the main window's TitleBar right-cluster
 * so users get the same affordances regardless of which window they
 * are looking at:
 *
 *   • AI processing pill (Tagging X/Y / Analyzing X/Y) with collapse
 *     and pause / resume / cancel controls
 *   • FixStatusChip — passive indicator for any in-flight Fix
 *   • TourLauncher — branded "?" launcher with the window's tour
 *   • Light / dark indicator — read-only Sun / Moon glyph that
 *     mirrors the current document theme. Pop-out windows sync
 *     their theme from the main window via IPC, so toggling here
 *     would only fall out of sync; v2.1.0 will lift this to a true
 *     cross-window toggle.
 *   • LicenseStatusBadge — display-only pill showing the activation
 *     state. Click handler intentionally omitted in pop-out windows
 *     for v2.0.0 — managing licenses lives in the main window.
 *
 * Drag region is the whole 32px bar; the right-side cluster sets
 * WebkitAppRegion: 'no-drag' so its buttons are clickable. Matches
 * Electron's titleBarOverlay convention.
 */
export function WindowChrome({ tourItems, triggerAccent, onStartTour }: WindowChromeProps) {
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null);
  const [pillCollapsed, setPillCollapsed] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    if (typeof document === 'undefined') return false;
    return document.documentElement.classList.contains('dark');
  });

  useEffect(() => {
    const unsub = onAiProgress((p) => setAiProgress(p));
    return () => { unsub(); };
  }, []);

  // Sync the local dark-mode state with whatever the document's
  // root class says — pop-out windows update it from the main
  // window via IPC, so we just watch for the class to flip.
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.classList.contains('dark'));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const aiProcessing = aiProgress != null
    && aiProgress.phase !== 'complete'
    && aiProgress.phase !== 'error';

  return (
    <div
      className="shrink-0 bg-primary flex items-center"
      style={{ height: 32, WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Drag spacer fills the left side */}
      <div className="flex-1" />

      {/* Right-side controls cluster — interactive, so opt out of drag */}
      <div
        className="flex items-center gap-1.5 pr-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
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
        {tourItems.length > 0 && (
          <TourLauncher
            items={tourItems}
            onStartTour={onStartTour}
            triggerStyle="titlebar"
            triggerAccent={triggerAccent}
          />
        )}
        <IconTooltip label={isDarkMode ? 'Dark mode active (toggle in main window)' : 'Light mode active (toggle in main window)'} side="bottom">
          <span
            className="flex items-center justify-center w-7 h-7 rounded-full text-white/80"
            aria-label={isDarkMode ? 'Dark mode' : 'Light mode'}
          >
            {isDarkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </span>
        </IconTooltip>
        <LicenseStatusBadge />
      </div>

      {/* FixStatusChip is a fixed-position banner, mounted here so
          it lives inside the chrome's React tree without affecting
          the bar's flex layout. */}
      <FixStatusChip />
    </div>
  );
}
