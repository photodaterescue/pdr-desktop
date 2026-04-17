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

interface TourOverlayProps {
  steps: TourStep[];
  isOpen: boolean;
  onClose: () => void;
  onComplete: () => void;
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

export function TourOverlay({ steps, isOpen, onClose, onComplete }: TourOverlayProps) {
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
            <div className="absolute inset-0 rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-transparent" />
            <div className="absolute inset-0 rounded-lg animate-pulse bg-primary/10" />
          </motion.div>
        )}

        <motion.div
          ref={tooltipRef}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ delay: 0.1 }}
          className="absolute bg-background border border-border rounded-xl shadow-2xl p-5 w-[360px] pointer-events-auto"
          style={{
            top: step.position === 'center' ? '50%' : tooltipPosition.top,
            left: step.position === 'center' ? '50%' : tooltipPosition.left,
            transform: step.position === 'center' ? 'translate(-50%, -50%)' : 'none'
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
              <span className="text-xs font-medium text-foreground bg-secondary border border-border px-2 py-0.5 rounded-full">
                Step {currentStep + 1} of {steps.length}
              </span>
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">{step.title}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-5">{step.description}</p>
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
                className={`w-2 h-2 rounded-full transition-all duration-200 ${
                  index === currentStep 
                    ? 'bg-primary w-4' 
                    : index < currentStep 
                      ? 'bg-primary/50' 
                      : 'bg-border hover:bg-muted-foreground/30'
                }`}
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
    description: 'This quick tour will show you how to safely restore dates on your photos and videos. It only takes a minute, and you can replay it anytime from Help & Support.',
    position: 'center'
  },
  {
    id: 'sources-panel',
    targetSelector: '[data-tour="sources-panel"]',
    title: 'Your Sources',
    description: 'This is where your photo sources appear. Add folders, ZIP archives, or external drives. Each source can be toggled on/off with the checkbox to include or exclude it from analysis.',
    position: 'right',
    highlightPadding: 12
  },
  {
    id: 'add-source',
    targetSelector: '[data-tour="add-source"]',
    title: 'Add a Source',
    description: 'Click here to add folders, drives, or ZIP files containing your photos. You can add multiple sources and analyze them together or separately.',
    position: 'bottom',
    highlightPadding: 8
  },
  {
    id: 'confidence-cards',
    targetSelector: '[data-tour="confidence-cards"]',
    title: 'Date Confidence Breakdown',
    description: 'These cards show a preliminary indication of how dates were determined. Confirmed = embedded metadata, Recovered = filename patterns, Marked = fallback rules. Note: These are initial estimates. The final, authoritative results appear in your Fix Report after running the fix.',
    position: 'bottom',
    highlightPadding: 12
  },
  {
    id: 'combined-analysis',
    targetSelector: '[data-tour="combined-analysis"]',
    title: 'Combined Analysis',
    description: 'This panel shows totals across all selected sources. Use the Photo/Video toggles to filter by media type. You can also add more folders or ZIP archives directly from here.',
    position: 'left',
    highlightPadding: 12
  },
  {
    id: 'destination',
    targetSelector: '[data-tour="destination"]',
    title: 'Choose Destination',
    description: 'Select where your fixed files will be saved. Make sure the storage indicator shows green — this means there\'s enough space for your files. If it shows red or orange, choose a location with more available storage.',
    position: 'left',
    highlightPadding: 8
  },
  {
    id: 'apply-fixes',
    targetSelector: '[data-tour="apply-fixes"]',
    title: 'Apply Fixes',
    description: 'When you\'re ready, click here to start the fix process. PDR will copy your files to the destination with corrected dates. A detailed report is saved automatically.',
    preferredPositions: ['top', 'left', 'right', 'bottom'],
    highlightPadding: 8
  },
  {
    id: 'guides-panel',
    targetSelector: '[data-tour="guides-panel"]',
    title: 'Guides & Help',
    description: 'Need guidance? The side panel has step-by-step guides, best practices, and answers to common questions. It\'s your go-to resource while working.',
    preferredPositions: ['right', 'left', 'top', 'bottom'],
    highlightPadding: 12
  },
  {
    id: 'reports-history',
    targetSelector: '[data-tour="reports-history"]',
    title: 'Reports History',
    description: 'Every fix run creates a report. Access your complete history here to review past jobs, export data, or verify what was changed.',
    preferredPositions: ['top', 'left', 'right', 'bottom'],
    highlightPadding: 8
  },
  {
    id: 'complete',
    title: 'You\'re Ready!',
    description: 'That\'s the essentials! Start by adding a source, review the analysis, choose a destination, and apply fixes. Remember: your originals are always safe. Happy organizing!',
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
    description: 'Type a person\'s name, a camera, a place, or a tag. For people you can use operators: "Mel + Terry" (together), "Mel, Terry" (any), "Mel and Terry" (together). Suggestions appear as you type.',
    position: 'bottom',
    highlightPadding: 8
  },
  {
    id: 'sd-people-filter',
    targetSelector: '[data-tour="sd-people-filter"]',
    title: 'People Filter',
    description: 'Click the PEOPLE button to pick people from your library. Single-column numbers = photos of just that person. Multi-column numbers = photos shared with the people you\'ve already selected.',
    position: 'bottom',
    highlightPadding: 8
  },
  {
    id: 'sd-tags-filter',
    targetSelector: '[data-tour="sd-tags-filter"]',
    title: 'AI Tags',
    description: 'Browse AI-detected tags — objects, scenes, activities. Click any tag to filter your library to only photos that contain it.',
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
    targetSelector: '[data-tour="sd-favourites"]',
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
