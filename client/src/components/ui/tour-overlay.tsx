import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronLeft, ChevronRight, SkipForward } from 'lucide-react';
import { Button } from './custom-button';

export interface TourStep {
  id: string;
  targetSelector?: string;
  title: string;
  description: string;
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  preferredPositions?: ('top' | 'bottom' | 'left' | 'right')[];
  highlightPadding?: number;
}

/**
 * Brand metadata for a tour. Each tour gets a display name (shown
 * in the step badge — "Memories Step 1 of 5") and an accent colour
 * (drives the highlight ring, tooltip border, step badge tint, and
 * progress dots). Kept in sync with home.tsx ShowcaseCard accents +
 * SIDEBAR_ACCENT in workspace.tsx so the same colour follows an app
 * across Welcome / sidebar / tour.
 */
export interface TourMeta {
  /** Short display name, e.g. "Workspace", "Memories", "Reports History" */
  name: string;
  /** Hex accent colour — drives all branded surfaces in the overlay */
  accent: string;
}

interface TourOverlayProps {
  steps: TourStep[];
  isOpen: boolean;
  onClose: () => void;
  onComplete: () => void;
  /**
   * Optional per-tour branding. When supplied, the highlight ring,
   * tooltip border, step badge and progress dots all tint with
   * `accent`, and the step badge label becomes "{name} Step X of Y"
   * instead of the generic "Step X of Y".
   */
  meta?: TourMeta;
}

const TOUR_COMPLETED_KEY = 'pdr-tour-completed';

export function hasTourBeenCompleted(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(TOUR_COMPLETED_KEY) === 'true';
}

export function markTourCompleted(): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(TOUR_COMPLETED_KEY, 'true');
  }
}

export function resetTourCompletion(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(TOUR_COMPLETED_KEY);
  }
}

export function TourOverlay({ steps, isOpen, onClose, onComplete, meta }: TourOverlayProps) {
  // Brand accent for this tour (or fall back to lavender so the
  // overlay never renders without a tint). Used as inline styles
  // because Tailwind can't generate arbitrary hex classes at
  // runtime — accent is a value, not a class name.
  const accent = meta?.accent ?? '#a99cff';
  const tourName = meta?.name ?? null;
  const [currentStep, setCurrentStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);

  const step = steps[currentStep];
  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === steps.length - 1;

  const calculatePosition = useCallback(() => {
    if (!step) return;

    if (!step.targetSelector || step.position === 'center') {
      setTargetRect(null);
      setTooltipPosition({
        top: window.innerHeight / 2,
        left: window.innerWidth / 2
      });
      return;
    }

    const target = document.querySelector(step.targetSelector);
    if (!target) {
      setTargetRect(null);
      setTooltipPosition({
        top: window.innerHeight / 2,
        left: window.innerWidth / 2
      });
      return;
    }

    const rect = target.getBoundingClientRect();
    setTargetRect(rect);

    const padding = step.highlightPadding || 8;
    const tooltipEl = tooltipRef.current;
    const tooltipWidth = tooltipEl?.offsetWidth || 360;
    const tooltipHeight = tooltipEl?.offsetHeight || 220;
    const gap = 20;
    const margin = 16;

    const targetPadded = {
      top: rect.top - padding,
      left: rect.left - padding,
      right: rect.right + padding,
      bottom: rect.bottom + padding
    };

    const getPositionCoords = (pos: 'top' | 'bottom' | 'left' | 'right') => {
      let t = 0, l = 0;
      switch (pos) {
        case 'top':
          t = targetPadded.top - tooltipHeight - gap;
          l = rect.left + rect.width / 2 - tooltipWidth / 2;
          break;
        case 'bottom':
          t = targetPadded.bottom + gap;
          l = rect.left + rect.width / 2 - tooltipWidth / 2;
          break;
        case 'left':
          t = rect.top + rect.height / 2 - tooltipHeight / 2;
          l = targetPadded.left - tooltipWidth - gap;
          break;
        case 'right':
          t = rect.top + rect.height / 2 - tooltipHeight / 2;
          l = targetPadded.right + gap;
          break;
      }
      return { top: t, left: l };
    };

    const hasOverlap = (coords: { top: number, left: number }) => {
      const tr = {
        top: coords.top,
        left: coords.left,
        right: coords.left + tooltipWidth,
        bottom: coords.top + tooltipHeight
      };
      const horizontalOverlap = tr.left < targetPadded.right && tr.right > targetPadded.left;
      const verticalOverlap = tr.top < targetPadded.bottom && tr.bottom > targetPadded.top;
      return horizontalOverlap && verticalOverlap;
    };

    const fitsInViewport = (coords: { top: number, left: number }) => {
      return coords.top >= margin &&
        coords.left >= margin &&
        coords.left + tooltipWidth <= window.innerWidth - margin &&
        coords.top + tooltipHeight <= window.innerHeight - margin;
    };

    const clampToViewport = (coords: { top: number, left: number }) => {
      return {
        left: Math.max(margin, Math.min(coords.left, window.innerWidth - tooltipWidth - margin)),
        top: Math.max(margin, Math.min(coords.top, window.innerHeight - tooltipHeight - margin))
      };
    };

    const defaultPositions: ('top' | 'bottom' | 'left' | 'right')[] = ['top', 'bottom', 'left', 'right'];
    let positions = defaultPositions;
    if (step.preferredPositions) {
      positions = step.preferredPositions;
    } else if (step.position && (step.position as string) !== 'center') {
      const preferred = step.position as 'top' | 'bottom' | 'left' | 'right';
      positions = [preferred, ...defaultPositions.filter(p => p !== preferred)];
    }

    let finalCoords: { top: number, left: number } | null = null;

    for (const pos of positions) {
      const coords = getPositionCoords(pos);
      if (fitsInViewport(coords) && !hasOverlap(coords)) {
        finalCoords = coords;
        break;
      }
      const clamped = clampToViewport(coords);
      if (!hasOverlap(clamped)) {
        finalCoords = clamped;
        break;
      }
    }

    if (!finalCoords) {
      const topCoords = getPositionCoords('top');
      finalCoords = clampToViewport(topCoords);
    }

    setTooltipPosition(finalCoords);
  }, [step]);

  useEffect(() => {
    if (!isOpen) {
      setCurrentStep(0);
      return;
    }

    calculatePosition();
    
    const handleResize = () => calculatePosition();
    window.addEventListener('resize', handleResize);
    
    return () => window.removeEventListener('resize', handleResize);
  }, [isOpen, currentStep, calculatePosition]);

  useEffect(() => {
    if (isOpen && step?.targetSelector) {
      const target = document.querySelector(step.targetSelector);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(calculatePosition, 300);
      }
    }
  }, [isOpen, currentStep, step, calculatePosition]);

  const handleNext = () => {
    if (isLastStep) {
      markTourCompleted();
      onComplete();
    } else {
      setCurrentStep(prev => prev + 1);
    }
  };

  const handleBack = () => {
    if (!isFirstStep) {
      setCurrentStep(prev => prev - 1);
    }
  };

  const handleSkip = () => {
    markTourCompleted();
    onClose();
  };

  if (!isOpen || !step) return null;

  const padding = step.highlightPadding || 8;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999]"
        data-testid="tour-overlay"
      >
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ mixBlendMode: 'normal' }}
        >
          <defs>
            <mask id="spotlight-mask">
              <rect x="0" y="0" width="100%" height="100%" fill="white" />
              {targetRect && (
                <rect
                  x={targetRect.left - padding}
                  y={targetRect.top - padding}
                  width={targetRect.width + padding * 2}
                  height={targetRect.height + padding * 2}
                  rx="8"
                  fill="black"
                />
              )}
            </mask>
          </defs>
          <rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            fill="rgba(0, 0, 0, 0.75)"
            mask="url(#spotlight-mask)"
            className="pointer-events-auto"
            onClick={handleSkip}
          />
        </svg>

        {targetRect && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="absolute pointer-events-none"
            style={{
              top: targetRect.top - padding,
              left: targetRect.left - padding,
              width: targetRect.width + padding * 2,
              height: targetRect.height + padding * 2,
            }}
          >
            <div
              className="absolute inset-0 rounded-lg ring-2 ring-offset-2 ring-offset-transparent"
              style={{ ['--tw-ring-color' as any]: accent, boxShadow: `0 0 0 2px ${accent}` }}
            />
            <div
              className="absolute inset-0 rounded-lg animate-pulse"
              // 5% alpha (was 10%). Pink/magenta accents at 10% read
              // as a visible warm tinge over neutral UI; halving the
              // alpha keeps the pulse breath visible without colouring
              // the highlighted content. Same value works across every
              // tour accent (lavender, blue, gold, emerald, pink, teal).
              style={{ backgroundColor: accent + '0D' /* ~5% alpha */ }}
            />
          </motion.div>
        )}

        <motion.div
          ref={tooltipRef}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ delay: 0.1 }}
          className="absolute bg-background rounded-xl shadow-2xl p-5 w-[360px] pointer-events-auto border-2"
          style={{
            top: step.position === 'center' ? '50%' : tooltipPosition.top,
            left: step.position === 'center' ? '50%' : tooltipPosition.left,
            transform: step.position === 'center' ? 'translate(-50%, -50%)' : 'none',
            borderColor: accent,
          }}
          data-testid="tour-tooltip"
        >
          <button
            onClick={handleSkip}
            className="absolute top-3 right-3 p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
            data-testid="tour-close"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="pr-8">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full text-white"
                style={{ backgroundColor: accent }}
              >
                {tourName ? `${tourName} — ` : ''}Step {currentStep + 1} of {steps.length}
              </span>
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">{step.title}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-5 whitespace-pre-line">{step.description}</p>
          </div>

          <div className="flex items-center justify-between">
            <button
              onClick={handleSkip}
              className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
              data-testid="tour-skip"
            >
              <SkipForward className="w-3.5 h-3.5" />
              Skip tour
            </button>

            <div className="flex items-center gap-2">
              {!isFirstStep && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBack}
                  className="gap-1"
                  data-testid="tour-back"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleNext}
                className="gap-1"
                data-testid="tour-next"
              >
                {isLastStep ? 'Finish' : 'Next'}
                {!isLastStep && <ChevronRight className="w-4 h-4" />}
              </Button>
            </div>
          </div>

          <div className="flex justify-center gap-1.5 mt-4 pt-3 border-t border-border">
            {steps.map((_, index) => (
              <button
                key={index}
                onClick={() => setCurrentStep(index)}
                className={`h-2 rounded-full transition-all duration-200 ${
                  index === currentStep ? 'w-4' : 'w-2'
                } ${index > currentStep ? 'bg-border hover:bg-muted-foreground/30' : ''}`}
                style={
                  index === currentStep
                    ? { backgroundColor: accent }
                    : index < currentStep
                      ? { backgroundColor: accent + '80' /* ~50% alpha */ }
                      : undefined
                }
                data-testid={`tour-dot-${index}`}
              />
            ))}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Photo Date Rescue',
    description: 'This quick tour walks you through the workspace — the Library Drive, your Sources, the analysis flow, and the fix itself. It takes about a minute. You can replay it any time from Help & Support, and PDR keeps itself up to date in the background so you\'ll always have the latest version.',
    position: 'center'
  },
  {
    id: 'sources-panel',
    targetSelector: '[data-tour="sources-panel"]',
    title: 'Your Sources',
    description: 'Sources appear here once added — folders, ZIP archives, RAR archives or whole drives. Tick a Source\'s checkbox to include it in the analysis, untick to leave it out. Multiple Sources are analysed together as a single Combined Analysis.',
    position: 'right',
    highlightPadding: 12
  },
  {
    id: 'add-source',
    targetSelector: '[data-tour="add-source"]',
    title: 'Add a Source',
    description: 'Click Add Source to open the Folder Browser — a custom picker that shows every drive on your machine with speed and capacity ratings, plus your Quick Access folders. Pick a folder, drive, or ZIP/RAR archive containing the photos you want to fix. You can add as many Sources as you like.',
    position: 'bottom',
    highlightPadding: 8
  },
  {
    id: 'confidence-cards',
    targetSelector: '[data-tour="confidence-cards"]',
    title: 'Date Confidence Breakdown',
    description: 'These four cards summarise how dates were determined per Source: Confirmed (embedded EXIF / Takeout metadata), Recovered (structured filename patterns), Marked (no reliable date — fallback rules used), and Duplicates (hash-matched identical copies skipped from output). They\'re initial estimates — the authoritative figures land in your Fix Report.',
    position: 'bottom',
    highlightPadding: 12
  },
  {
    id: 'combined-analysis',
    targetSelector: '[data-tour="combined-analysis"]',
    title: 'Combined Analysis',
    description: 'Totals across every ticked Source — photos, videos, total size. The Photos / Videos toggles filter what the fix processes. You can keep adding more Sources from this card too; PDR re-analyses them and folds the new numbers in.',
    position: 'left',
    highlightPadding: 12
  },
  {
    id: 'destination',
    targetSelector: '[data-tour="destination"]',
    title: 'Your Library Drive',
    description: 'This is where your fixed photos will live. PDR encourages you to pick a Library Drive before adding Sources — the Library Planner sizes your collection across seven buckets and the Drive Advisor rates each available drive on speed, capacity and connection type so you don\'t accidentally pick a slow or full drive. The colour-coded indicator confirms there\'s room for the run.',
    position: 'left',
    highlightPadding: 8
  },
  {
    id: 'apply-fixes',
    targetSelector: '[data-tour="apply-fixes"]',
    title: 'Run Fix',
    description: 'When the analysis looks right, click Run Fix. PDR copies your files to the Library Drive with corrected dates and a tidy folder structure, skips identical duplicates automatically, and saves a permanent report. Originals are never modified — output is always written to a fresh location.',
    preferredPositions: ['top', 'left', 'right', 'bottom'],
    highlightPadding: 8
  },
  {
    id: 'guides-panel',
    targetSelector: '[data-tour="guides-panel"]',
    title: 'Guides & Help',
    description: 'Step-by-step walkthroughs, best practices, and answers to common questions live here. If something goes wrong, Help & Support has a one-click "Report a problem" button that bundles your log, system info and licence state into a single ZIP for our team — no hunting in %APPDATA% required.',
    preferredPositions: ['right', 'left', 'top', 'bottom'],
    highlightPadding: 12
  },
  {
    id: 'reports-history',
    targetSelector: '[data-tour="reports-history"]',
    title: 'Reports History',
    description: 'Every fix run saves a permanent report — what was processed, how each date was determined, what duplicates were skipped, where the output landed. Reopen any past report from here, export to CSV or TXT, or compare runs over time. Treat reports as part of your archive.',
    preferredPositions: ['top', 'left', 'right', 'bottom'],
    highlightPadding: 8
  },
  {
    id: 'complete',
    title: 'You\'re Ready!',
    description: 'That\'s the essentials. After your first fix, explore Search & Discovery (find any photo by date, person, location, tag), Memories (a Year/Month timeline + On This Day), and People Manager (AI-detected face clusters you can name). Trees, Edit Dates and Photo Format conversion are released shortly. Your originals are always safe — happy organising.',
    position: 'center'
  }
];

/* ─── Search & Discovery Tour ─────────────────────────────────────────────
 * Shown when user clicks Quick Tour while S&D search results are active.
 * Covers the ribbon filters, search bar, people filter, and results pane.
 */
export const SD_TOUR_STEPS: TourStep[] = [
  {
    id: 'sd-welcome',
    title: 'Search & Discovery',
    description: 'This tour walks you through finding photos across your library once they\'ve been fixed and indexed. It takes about a minute, and you can restart it anytime from the sidebar.',
    position: 'center'
  },
  {
    id: 'sd-ribbon-tabs',
    targetSelector: '[data-tour="sd-ribbon-tabs"]',
    title: 'Filter Tabs',
    description: 'Switch between Favourites, Filters, Camera, Exposure, and AI. Each tab groups related filters so you can narrow down your library by any combination.',
    position: 'bottom',
    highlightPadding: 6
  },
  {
    id: 'sd-search-box',
    targetSelector: '[data-tour="sd-search-box"]',
    title: 'Smart Search',
    description: 'Type a name, camera, place or tag. Combine people with:\n  •  +  or  &  →  photos where they appear together\n  •  ,  →  photos of any of them\nExample:  Sarah + James  finds only photos with both Sarah AND James. Sarah, James finds all photos with either.',
    position: 'bottom',
    highlightPadding: 8
  },
  {
    id: 'sd-ai-tab',
    targetSelector: '[data-tour="sd-tags-filter"]',
    title: 'AI Filters',
    description: 'Click the AI tab to filter by faces and AI-detected tags. Single-column face counts = photos of just that person; multi-column = photos shared with multiple selected people. Tag chips narrow your library to scenes, objects or activities the analyser found.',
    position: 'bottom',
    highlightPadding: 8
  },
  {
    id: 'sd-sort',
    targetSelector: '[data-tour="sd-sort"]',
    title: 'Sort Order',
    description: 'Sort results by date, name, size, confidence and more. Click to toggle ascending/descending.',
    position: 'bottom',
    highlightPadding: 6
  },
  {
    id: 'sd-results-grid',
    targetSelector: '[data-tour="sd-results-grid"]',
    title: 'Results',
    description: 'Your matching photos appear here. Click a thumbnail to preview, or select multiple to perform batch actions like copying to a new folder.',
    position: 'top',
    highlightPadding: 8
  },
  {
    id: 'sd-sidebar-collapse',
    targetSelector: '[data-tour="sd-sidebar-collapse"]',
    title: 'More Viewing Space',
    description: 'The sidebar collapses automatically when search results appear, giving you more room for thumbnails. Pin it open or closed using the buttons at the top — your preference is saved.',
    preferredPositions: ['right', 'bottom', 'top'],
    highlightPadding: 8
  },
  {
    id: 'sd-favourites',
    targetSelector: '[data-tour="sd-favourites-tab"]',
    title: 'Save Your Favourite Searches',
    description: 'Star a filter combination to save it. Up to 10 favourites can be pinned for quick access on the Favourites tab.',
    position: 'bottom',
    highlightPadding: 6
  },
  {
    id: 'sd-complete',
    title: 'Enjoy Your Library',
    description: 'That\'s Search & Discovery! Everything happens on your device — no uploads, no cloud. Your photos, your library, fully searchable.',
    position: 'center'
  }
];

/* ─── Date Editor Tour ────────────────────────────────────────────────────
 * Shown from the Date Editor window's "?" button. Date Editor lets you
 * fix dates PDR couldn't auto-correct — typically Marked or Recovered
 * photos that need a human eye. Six steps, mostly centered narration
 * with two element-anchored highlights (search + save).
 */
export const DATE_EDITOR_TOUR_STEPS: TourStep[] = [
  {
    id: 'de-welcome',
    title: 'Welcome to Date Editor',
    description: 'Date Editor is where you fix the dates PDR couldn\'t auto-correct — usually photos marked as Recovered or Marked that need a human eye. Originals are never touched; PDR writes corrected dates back to the indexed copy.',
    position: 'center'
  },
  {
    id: 'de-seed',
    targetSelector: '[data-tour="de-seed"]',
    title: 'What You\'re Editing',
    description: 'These pills show the search filter you came in with — confidence level, camera, year range, people, etc. The list of photos below matches that filter. Use Search & Discovery to come back with a different selection any time.',
    preferredPositions: ['bottom', 'top'],
    highlightPadding: 8
  },
  {
    id: 'de-suggestions',
    targetSelector: '[data-tour="de-suggestions"]',
    title: 'Suggested Dates',
    description: 'PDR offers candidate dates inferred from neighbours, GPS, faces, sequence numbers, or the filename itself. Each one shows where it came from so you can judge it. Click a suggestion to apply, or type your own.',
    preferredPositions: ['top', 'bottom', 'left'],
    highlightPadding: 8
  },
  {
    id: 'de-input',
    targetSelector: '[data-tour="de-input"]',
    title: 'Type or Paste a Date',
    description: 'Need something custom? Type a date directly. PDR accepts most common formats (2003-04-15, 15 Apr 2003, etc.). The original date stays in EXIF unless you press Save.',
    preferredPositions: ['top', 'bottom'],
    highlightPadding: 8
  },
  {
    id: 'de-save',
    targetSelector: '[data-tour="de-save"]',
    title: 'Save the Correction',
    description: 'Save writes the new date to PDR\'s index and bumps the photo to Corrected. Originals stay untouched on disk. Undo is one click away if you change your mind.',
    preferredPositions: ['top', 'left', 'bottom'],
    highlightPadding: 8
  },
  {
    id: 'de-complete',
    title: 'You\'re Set',
    description: 'Work through your list at your own pace. Any time you spot a pattern (e.g. "everything in this folder is off by a year"), Date Editor lets you bulk-apply the same correction to multiple photos. Close the window when you\'re done — your corrections sync straight back to the main library.',
    position: 'center'
  }
];

/* ─── People Manager Tour ─────────────────────────────────────────────────
 * Shown from the People Manager window's "?" button. Walks the user
 * through naming face clusters, merging, splitting, and the AI
 * suggestion flow.
 */
export const PEOPLE_MANAGER_TOUR_STEPS: TourStep[] = [
  {
    id: 'pm-welcome',
    title: 'Welcome to People Manager',
    description: 'People Manager turns the faces detected across your library into named, searchable people. Everything runs on your device — no faces leave your machine.',
    position: 'center'
  },
  {
    id: 'pm-clusters',
    targetSelector: '[data-tour="pm-clusters"]',
    title: 'Face Clusters',
    description: 'Each row is a cluster — a group of faces PDR thinks belong to the same person. The thumbnail strip shows up to a dozen sample faces; the count tells you how many photos that person appears in across your library.',
    preferredPositions: ['right', 'bottom', 'top'],
    highlightPadding: 8
  },
  {
    id: 'pm-match-slider',
    targetSelector: '[data-tour="pm-match-slider"]',
    title: 'Match Slider',
    description: 'Loose includes more auto-matches in each row (closer to "anyone who looks vaguely like them"). Strict counts only the most-similar matches. Drag to taste — releasing the slider re-runs Improve at the new threshold so the rows update instantly.',
    preferredPositions: ['bottom', 'left'],
    highlightPadding: 8
  },
  {
    id: 'pm-verify',
    targetSelector: '[data-tour="pm-verify"]',
    title: 'Verify & Reassign',
    description: 'Click any face thumbnail to open the action panel on the right. From there: Verify (confirms this face is who PDR thinks it is — earns the purple ring), or type a different name to reassign. Selecting multiple faces (Shift-click or drag) lets you verify/reassign a whole batch in one go.',
    preferredPositions: ['right', 'bottom', 'top'],
    highlightPadding: 8
  },
  {
    id: 'pm-suggest',
    targetSelector: '[data-tour="pm-suggest"]',
    title: 'Improve Facial Recognition',
    description: 'The sparkles button re-runs the auto-matcher across every named person, using your verified faces as the reference. Each new match appears as an unverified face in that person\'s row — review and verify the good ones to make the next pass even sharper.',
    preferredPositions: ['bottom', 'top', 'right'],
    highlightPadding: 8
  },
  {
    id: 'pm-snapshot',
    targetSelector: '[data-tour="pm-snapshot"]',
    title: 'Snapshots',
    description: 'A snapshot captures your current naming state. Take one before any big merge or split — restoring a snapshot rolls back every cluster change since it was taken. Good practice: snapshot before each session.',
    preferredPositions: ['bottom', 'top', 'left'],
    highlightPadding: 8
  },
  {
    id: 'pm-complete',
    title: 'That\'s People Manager',
    description: 'Names + photos are saved instantly to your library. Close the window when you\'re done — your work is already persisted. The more clusters you name, the better Search & Discovery, Memories, and Trees become.',
    position: 'center'
  }
];

/* ─── Memories Tour ───────────────────────────────────────────────────────
 * Shown from the workspace "?" button when the Memories view is active.
 */
export const MEMORIES_TOUR_STEPS: TourStep[] = [
  {
    id: 'mem-welcome',
    title: 'Welcome to Memories',
    description: 'Memories is your library viewed through time — Year/Month rows, On This Day, and people-themed groupings. It\'s the closest thing to "scrolling through a photo album" inside PDR.',
    position: 'center'
  },
  {
    id: 'mem-rows',
    targetSelector: '[data-tour="mem-rows"]',
    title: 'Time Rows',
    description: 'Each row is a slice of time — typically a month or a notable event. PDR groups bursts of photos automatically and shows the strongest representative thumbnail at the front.',
    preferredPositions: ['top', 'bottom'],
    highlightPadding: 8
  },
  {
    id: 'mem-controls',
    targetSelector: '[data-tour="mem-controls"]',
    title: 'Density & Library',
    description: 'Two static controls in the header. Density toggles between Spacious (rounded tiles with gaps) and Tight (a wall of photos with no gaps). Library Selector picks which Parallel-Structure library you\'re browsing — the same chooser shown in S&D, so a switch in either view updates both. Below, an "On This Day" row appears whenever you have photos from this calendar date in past years.',
    preferredPositions: ['bottom', 'left'],
    highlightPadding: 8
  },
  {
    id: 'mem-open',
    targetSelector: '[data-tour="mem-open"]',
    title: 'Open a Memory',
    description: 'Click any thumbnail to open the full-screen viewer. From there you can navigate within the memory, see the date / location / people, and jump to Search & Discovery for that day or that person.',
    preferredPositions: ['top', 'left', 'right'],
    highlightPadding: 8
  },
  {
    id: 'mem-complete',
    title: 'Enjoy the Trip',
    description: 'Memories updates automatically as you fix more photos and name more people. The more your library matures, the richer Memories gets.',
    position: 'center'
  }
];

/* ─── Family Trees Tour ───────────────────────────────────────────────────
 * Shown from the workspace "?" button when the Trees view is active.
 */
export const TREES_TOUR_STEPS: TourStep[] = [
  {
    id: 'tr-welcome',
    title: 'Welcome to Family Trees',
    description: 'Trees lets you turn the people you\'ve named into a proper family tree — parents, spouses, siblings, generations. PDR uses the tree to enrich Search & Discovery and Memories ("photos with Grandad and his grandchildren").',
    position: 'center'
  },
  {
    id: 'tr-add-person',
    targetSelector: '[data-tour="tr-add-person"]',
    title: 'Add or Pick People',
    description: 'Add a person to the tree by name. PDR matches the name back to your People Manager clusters where it can — so a tree node knows which photos belong to that person.',
    preferredPositions: ['bottom', 'right', 'top'],
    highlightPadding: 8
  },
  {
    id: 'tr-relationships',
    targetSelector: '[data-tour="tr-relationships"]',
    title: 'Add Relationships',
    description: 'Connect two people as parent/child, spouses, or siblings. PDR validates the connections (no one ends up as their own grandparent) and lays the tree out automatically.',
    preferredPositions: ['top', 'right', 'left'],
    highlightPadding: 8
  },
  {
    id: 'tr-canvas',
    targetSelector: '[data-tour="tr-canvas"]',
    title: 'The Canvas',
    description: 'Drag, zoom and re-arrange. Generations stack vertically by default; couples sit side-by-side. The layout follows standard genealogy conventions but you can tweak position freely.',
    preferredPositions: ['top', 'right', 'bottom'],
    highlightPadding: 8
  },
  {
    id: 'tr-export',
    targetSelector: '[data-tour="tr-export"]',
    title: 'Save & Export',
    description: 'Trees are saved automatically. Export to PNG for printing, or to a sharable image for family group chats. PDR doesn\'t upload trees anywhere — they live with your library.',
    preferredPositions: ['bottom', 'top', 'left'],
    highlightPadding: 8
  },
  {
    id: 'tr-complete',
    title: 'Trees, Done',
    description: 'A tree is the backbone of a great family library. Once people are connected, every search and every memory becomes richer. Build it up over time — there\'s no rush.',
    position: 'center'
  }
];

/* ─── Reports History Tour ────────────────────────────────────────────────
 * Shown from the workspace "?" button when the Reports History modal
 * is open (or as the default tour after a Fix completes).
 */
export const REPORTS_TOUR_STEPS: TourStep[] = [
  {
    id: 'rh-welcome',
    title: 'Reports History',
    description: 'Every time you Run Fix, PDR saves a permanent report — a snapshot of what was processed, how each date was decided, what duplicates were skipped, and where the output landed.',
    position: 'center'
  },
  {
    id: 'rh-list',
    targetSelector: '[data-tour="rh-list"]',
    title: 'Past Runs',
    description: 'The list shows every Fix you\'ve ever run, newest first. Each row tells you when, how many files, the total size, and which Library Drive received the output. Click any row to open its full report.',
    preferredPositions: ['right', 'bottom', 'top'],
    highlightPadding: 8
  },
  {
    id: 'rh-detail',
    targetSelector: '[data-tour="rh-detail"]',
    title: 'Row at a Glance',
    description: 'Each row summarises one Fix run — confirmed (green), recovered (blue), marked (grey), and duplicates (amber). The numbers tell you at a glance how the run went without opening anything.',
    preferredPositions: ['top', 'left', 'right'],
    highlightPadding: 8
  },
  {
    id: 'rh-restore',
    targetSelector: '[data-tour="rh-restore"]',
    title: 'Drill In & Restore',
    description: 'Click Report Summary to open the full file-by-file breakdown — source paths, chosen dates, confidence bands, and the rules that produced each one. You can also Restore From Backup if you ever need to roll a run back. Non-destructive, no surprises.',
    preferredPositions: ['top', 'bottom', 'left'],
    highlightPadding: 8
  },
  {
    id: 'rh-complete',
    title: 'Treat Reports as Archive',
    description: 'Reports are part of your library, not throwaway logs. Years from now they\'ll tell you exactly why a photo ended up where it did. PDR keeps every report indefinitely.',
    position: 'center'
  }
];

/* ─── Per-tour brand metadata ─────────────────────────────────────────────
 * Brand name + accent for each tour. Kept in sync with home.tsx
 * ShowcaseCard accents and SIDEBAR_ACCENT in workspace.tsx so the
 * same colour identifies an app across Welcome, sidebar, tour
 * launcher and tour overlay.
 *
 *   Workspace        — lavender    (#a99cff)  shared with the brand primary
 *   S&D              — blue        (#3b82f6)
 *   Memories         — amber       (#f59e0b)
 *   Trees            — emerald     (#10b981)
 *   People Manager   — pink        (#ec4899)
 *   Date Editor      — brand gold  (#f8c15c)  matches --color-gold from index.css (the
 *                                              gold tone in the PDR logo + STEP_BADGE_FILL)
 *   Reports History  — teal        (#14b8a6)  archival / immutable record
 */
export const WORKSPACE_TOUR_META: TourMeta = { name: 'Workspace', accent: '#a99cff' };
export const SD_TOUR_META: TourMeta = { name: 'Search & Discovery', accent: '#3b82f6' };
export const MEMORIES_TOUR_META: TourMeta = { name: 'Memories', accent: '#f8c15c' };
export const TREES_TOUR_META: TourMeta = { name: 'Family Trees', accent: '#10b981' };
export const PEOPLE_MANAGER_TOUR_META: TourMeta = { name: 'People Manager', accent: '#ec4899' };
export const DATE_EDITOR_TOUR_META: TourMeta = { name: 'Date Editor', accent: '#f8c15c' };
export const REPORTS_TOUR_META: TourMeta = { name: 'Reports History', accent: '#14b8a6' };
