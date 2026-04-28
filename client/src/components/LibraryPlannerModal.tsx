import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  HardDrive, Camera, Smartphone, Cloud, Monitor,
  ChevronRight, Layers, FolderHeart, AlertTriangle,
  CheckCircle2, ExternalLink, ShoppingCart,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { listDrives, type DriveInfo } from '@/lib/electron-bridge';

interface LibraryPlannerModalProps {
  isOpen: boolean;
  onComplete: (answers: LibraryPlannerAnswers) => void;
  onSkip: () => void;
  previousAnswers?: LibraryPlannerAnswers | null;
}

export interface LibraryPlannerAnswers {
  collectionSizeGB: number;
  multipleSourcesPlanned: 'yes' | 'no' | 'not-sure';
}

const SIZE_PRESETS = [
  { label: 'Under 50 GB', sublabel: 'A few thousand photos', value: 50, icon: Camera },
  { label: '50–200 GB', sublabel: 'A solid collection', value: 125, icon: Smartphone },
  { label: '200–500 GB', sublabel: 'Years of photos & some video', value: 350, icon: HardDrive },
  { label: '500 GB – 1 TB', sublabel: 'A large, multi-device library', value: 750, icon: Layers },
  { label: '1–5 TB', sublabel: 'Extensive — photos, videos, RAW files', value: 2048, icon: Monitor },
  { label: '5 TB+', sublabel: 'Professional-scale archive', value: 5120, icon: Cloud },
] as const;

function fmtGB(gb: number): string {
  return gb >= 1000 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(0)} GB`;
}

export default function LibraryPlannerModal({ isOpen, onComplete, onSkip, previousAnswers }: LibraryPlannerModalProps) {
  const [selectedSize, setSelectedSize] = useState<number | null>(null);
  const [multipleSources, setMultipleSources] = useState<'yes' | 'no' | 'not-sure' | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [finalSizeGB, setFinalSizeGB] = useState(0);

  // True when the modal was opened via the "Review library plan" link
  // (the user already has saved answers). Drives both the dismiss-button
  // styling and what onSkip means semantically.
  const isReview = !!previousAnswers;

  // Track where a pointer interaction started so a click-and-drag that
  // releases on the backdrop doesn't dismiss the modal — see
  // feedback_modal_backdrop_close.
  const downOnBackdrop = useRef(false);

  // Load drives when modal opens — pre-populate with previous answers if reviewing
  useEffect(() => {
    if (!isOpen) return;
    listDrives().then(setDrives).catch(() => {});
    if (previousAnswers) {
      // Find closest preset match (handles value changes between versions)
      const closest = SIZE_PRESETS.reduce((prev, curr) =>
        Math.abs(curr.value - previousAnswers.collectionSizeGB) < Math.abs(prev.value - previousAnswers.collectionSizeGB) ? curr : prev
      );
      setSelectedSize(closest.value);
      setMultipleSources(previousAnswers.multipleSourcesPlanned);
    } else {
      setSelectedSize(null);
      setMultipleSources(null);
    }
    setStep(1);
  }, [isOpen]);

  // Esc to dismiss — same semantics as the Skip/Close button
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!isReview) localStorage.setItem('pdr-library-planner-complete', 'true');
        onSkip();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, isReview, onSkip]);

  if (!isOpen) return null;

  const handleDismiss = () => {
    if (!isReview) localStorage.setItem('pdr-library-planner-complete', 'true');
    onSkip();
  };

  // Compute the estimated collection size with modest headroom
  const computeFinalSize = () => {
    if (!selectedSize) return 0;
    // Add 10% for headroom — keeps 10% of drive free (good practice to avoid corruption risk)
    const buffered = Math.round(selectedSize * 1.1);
    // Multiple sources = 10% more headroom (some overlap is likely)
    return multipleSources === 'yes' ? Math.round(buffered * 1.1) : buffered;
  };

  // Analyse drives against the collection size for Step 3
  const analyseForStep3 = () => {
    const needed = computeFinalSize();
    const usable = drives.filter(d =>
      d.type !== 'CD/DVD' &&
      (d.totalBytes / (1024 * 1024 * 1024)) >= 16
    );

    // Local drives (not system, not network)
    const localDrives = usable.filter(d =>
      !d.letter.toUpperCase().startsWith('C') && d.type !== 'Network'
    );
    const localWithSpace = localDrives.filter(d =>
      (d.freeBytes / (1024 * 1024 * 1024)) >= needed
    );

    // Network drives with space
    const networkWithSpace = usable.filter(d =>
      d.type === 'Network' && (d.freeBytes / (1024 * 1024 * 1024)) >= needed
    );

    // Best local candidate (even if not enough space)
    const bestLocal = [...localDrives].sort((a, b) => b.freeBytes - a.freeBytes)[0] || null;
    const bestLocalFreeGB = bestLocal ? bestLocal.freeBytes / (1024 * 1024 * 1024) : 0;

    return {
      needed,
      localWithSpace,
      networkWithSpace,
      bestLocal,
      bestLocalFreeGB,
      hasGoodOption: localWithSpace.length > 0,
      hasOnlyNetwork: localWithSpace.length === 0 && networkWithSpace.length > 0,
      hasNothing: localWithSpace.length === 0 && networkWithSpace.length === 0,
    };
  };

  const handleContinue = () => {
    if (step === 1 && selectedSize !== null) {
      setStep(2);
    } else if (step === 2 && multipleSources !== null) {
      const size = computeFinalSize();
      setFinalSizeGB(size);
      setStep(3);
    } else if (step === 3) {
      const answers: LibraryPlannerAnswers = {
        collectionSizeGB: finalSizeGB,
        multipleSourcesPlanned: multipleSources!,
      };
      localStorage.setItem('pdr-library-planner-complete', 'true');
      localStorage.setItem('pdr-library-planner-size', String(finalSizeGB));
      localStorage.setItem('pdr-library-planner-multi', multipleSources!);
      onComplete(answers);
    }
  };

  const analysis = step === 3 ? analyseForStep3() : null;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
        onClick={(e) => {
          if (downOnBackdrop.current && e.target === e.currentTarget) {
            handleDismiss();
          }
          downOnBackdrop.current = false;
        }}
      >
        <motion.div
          className="bg-background rounded-2xl shadow-2xl border border-border w-[520px] max-h-[85vh] overflow-hidden flex flex-col"
          initial={{ scale: 0.95, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: 'spring', duration: 0.5, bounce: 0.3 }}
        >
          {/* Header */}
          <div className="px-6 py-5 border-b border-border">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <FolderHeart className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">Plan Your Library</h2>
                <p className="text-xs text-muted-foreground">A couple of quick questions to help you get the best start</p>
              </div>
            </div>
            <p className="text-[13px] text-foreground/70 leading-relaxed mt-3">
              Where you store your library matters more than you'd think. Answering these will help us
              guide you to the right destination — so you don't end up running out of space or having
              to move everything later.
            </p>
          </div>

          {/* Step indicator */}
          <div className="px-6 pt-4 pb-2 flex items-center justify-center gap-2 max-w-[200px] mx-auto w-full">
            <div className={`h-1 flex-1 rounded-full transition-colors ${step >= 1 ? 'bg-primary' : 'bg-secondary'}`} />
            <div className={`h-1 flex-1 rounded-full transition-colors ${step >= 2 ? 'bg-primary' : 'bg-secondary'}`} />
            <div className={`h-1 flex-1 rounded-full transition-colors ${step >= 3 ? 'bg-primary' : 'bg-secondary'}`} />
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {step === 1 && (
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3 }}
              >
                <h3 className="text-sm font-semibold text-foreground mb-1">
                  Roughly how much photo & video data do you have in total?
                </h3>
                <p className="text-xs text-foreground/60 mb-4 leading-relaxed">
                  Think about everything — external hard drives, personal cloud, cloud services like Google
                  Photos or iCloud, memory sticks, NAS, old phones, cameras, old laptops... all of it. An
                  estimate is perfectly fine — we'll add a buffer automatically.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {SIZE_PRESETS.map(preset => {
                    const Icon = preset.icon;
                    const isSelected = selectedSize === preset.value;
                    return (
                      <button
                        key={preset.value}
                        onClick={() => setSelectedSize(preset.value)}
                        className={`flex items-center gap-3 p-3.5 rounded-xl border-2 text-left transition-all ${
                          isSelected
                            ? 'border-primary bg-primary/5 shadow-sm'
                            : 'border-border hover:border-primary/30 hover:bg-secondary/30'
                        }`}
                      >
                        <Icon className={`w-5 h-5 shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                        <div className="min-w-0">
                          <div className={`text-sm font-medium ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                            {preset.label}
                          </div>
                          <div className="text-[11px] text-foreground/50">{preset.sublabel}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3 }}
              >
                <h3 className="text-sm font-semibold text-foreground mb-1">
                  Are you planning to bring photos together from multiple places?
                </h3>
                <p className="text-xs text-foreground/60 mb-4 leading-relaxed">
                  For example, consolidating photos from your phone, an old laptop, a camera SD card, and
                  a cloud backup — all into one organised library on one drive.
                </p>
                <div className="space-y-2">
                  {([
                    {
                      value: 'yes' as const,
                      label: 'Yes — I want everything in one place',
                      sublabel: 'Best experience. We\'ll make sure your destination has enough room for all of it.',
                    },
                    {
                      value: 'no' as const,
                      label: 'No — just processing one source for now',
                      sublabel: 'That\'s fine. You can always add more later.',
                    },
                    {
                      value: 'not-sure' as const,
                      label: 'Not sure yet',
                      sublabel: 'No problem. We\'ll recommend a drive with room to grow just in case.',
                    },
                  ]).map(option => {
                    const isSelected = multipleSources === option.value;
                    return (
                      <button
                        key={option.value}
                        onClick={() => setMultipleSources(option.value)}
                        className={`w-full flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all ${
                          isSelected
                            ? 'border-primary bg-primary/5 shadow-sm'
                            : 'border-border hover:border-primary/30 hover:bg-secondary/30'
                        }`}
                      >
                        <div className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                          isSelected ? 'border-primary' : 'border-muted-foreground/40'
                        }`}>
                          {isSelected && <div className="w-2 h-2 rounded-full bg-primary" />}
                        </div>
                        <div>
                          <div className={`text-sm font-medium ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                            {option.label}
                          </div>
                          <div className="text-[11px] text-foreground/50 mt-0.5">{option.sublabel}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {step === 3 && analysis && (
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3 }}
                className="space-y-4"
              >
                <h3 className="text-sm font-semibold text-foreground">
                  Here's what we found
                </h3>
                <p className="text-xs text-foreground/60 leading-relaxed">
                  Based on your answers, you need approximately <strong className="text-foreground">{fmtGB(analysis.needed)}</strong> of
                  free space for your library (including buffer for underestimation).
                </p>

                {/* Good scenario — local drives with enough space */}
                {analysis.hasGoodOption && (
                  <div className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/20">
                    <div className="flex items-start gap-3">
                      <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 mb-1">You have drives that can handle this</p>
                        <div className="space-y-1">
                          {analysis.localWithSpace.map(d => {
                            const freeGB = d.freeBytes / (1024 * 1024 * 1024);
                            return (
                              <p key={d.letter} className="text-xs text-foreground/70">
                                <strong className="text-foreground">{d.letter}</strong> — {d.label} — {fmtGB(freeGB)} free
                              </p>
                            );
                          })}
                        </div>
                        <p className="text-xs text-foreground/50 mt-2">
                          On the next screen, these will be highlighted in green. Choose one as your permanent library destination.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Only network drives have space */}
                {analysis.hasOnlyNetwork && (
                  <div className="p-4 rounded-xl bg-amber-500/5 border border-amber-500/20">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-amber-700 dark:text-amber-400 mb-1">
                          Your network drive is the only one with the space
                        </p>
                        <p className="text-xs text-foreground/60 leading-relaxed mb-2">
                          Network drive{analysis.networkWithSpace.length > 1 ? 's' : ` ${analysis.networkWithSpace[0]?.letter}`} has
                          room for your library, and PDR's Fast (Robocopy) network mode is roughly 3.5× quicker
                          than the legacy method in our testing — so saving over the network is a reasonable
                          option. They're still a little more sensitive to connection drops, sleep, or power
                          cuts during very long jobs, so a local drive is the most resilient choice if you have
                          the space.
                        </p>
                        {analysis.bestLocal && (
                          <p className="text-xs text-foreground/60 leading-relaxed mb-2">
                            Your largest local drive is <strong className="text-foreground">{analysis.bestLocal.letter}</strong> with
                            only <strong className="text-foreground">{fmtGB(analysis.bestLocalFreeGB)}</strong> free
                            — not enough for your estimated {fmtGB(analysis.needed)} library.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Nothing has enough space */}
                {analysis.hasNothing && (
                  <div className="p-4 rounded-xl bg-red-500/5 border border-red-500/20">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-red-600 dark:text-red-400 mb-1">
                          None of your drives have enough space
                        </p>
                        <p className="text-xs text-foreground/60 leading-relaxed">
                          You need approximately {fmtGB(analysis.needed)} free, but
                          {analysis.bestLocal
                            ? ` your largest local drive (${analysis.bestLocal.letter}) only has ${fmtGB(analysis.bestLocalFreeGB)} free.`
                            : ' no suitable local drives were found.'
                          }
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Recommendations when space is insufficient */}
                {!analysis.hasGoodOption && (
                  <div className="p-4 rounded-xl bg-secondary/40 border border-border">
                    <p className="text-xs font-semibold text-foreground mb-2.5">What you can do</p>
                    <div className="space-y-2.5">
                      <div className="flex items-start gap-2.5 text-xs text-foreground/70">
                        <span className="text-primary font-bold mt-px shrink-0">1.</span>
                        <span>
                          <strong className="text-foreground">Free up space</strong> on an existing drive by moving files
                          you don't need immediate access to (old backups, downloads, etc.) to your network storage or cloud.
                        </span>
                      </div>
                      <div className="flex items-start gap-2.5 text-xs text-foreground/70">
                        <span className="text-primary font-bold mt-px shrink-0">2.</span>
                        <span>
                          <strong className="text-foreground">Add a USB external drive</strong> — a USB 3.0 external HDD
                          ({fmtGB(analysis.needed >= 2000 ? 4096 : analysis.needed >= 500 ? 2048 : 1024)} or larger) is affordable
                          and works with any computer. This is the easiest option.
                        </span>
                      </div>
                      <div className="flex items-start gap-2.5 text-xs text-foreground/70">
                        <span className="text-primary font-bold mt-px shrink-0">3.</span>
                        <span>
                          <strong className="text-foreground">Add a second internal drive</strong> — if your PC has a spare
                          drive bay or M.2 slot, an internal SSD gives the best speed. Many desktops and some laptops support this.
                        </span>
                      </div>
                      <div className="flex items-start gap-2.5 text-xs text-foreground/70">
                        <span className="text-primary font-bold mt-px shrink-0">4.</span>
                        <span>
                          <strong className="text-foreground">Process in batches</strong> — if you'd rather not buy a new drive
                          right now, you can split your collection into smaller batches and process them to different destinations.
                          This works, but you lose the benefit of a single, unified library.
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* You can still continue */}
                <p className="text-[11px] text-foreground/40 leading-relaxed">
                  {analysis.hasGoodOption
                    ? 'You\'re in a great position. Press Continue to choose your destination.'
                    : 'You can still continue and select a destination — this is guidance, not a blocker. But being aware now saves frustration later.'
                  }
                </p>
              </motion.div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-border flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {step > 1 && (
                <button
                  onClick={() => setStep((step - 1) as 1 | 2)}
                  className="text-xs text-foreground/50 hover:text-foreground transition-colors"
                >
                  ← Back
                </button>
              )}
              {/* Dismiss control — present on every step so the user is
                  never trapped in the flow. Outlined "Close" button when
                  reviewing an existing plan; faint "Skip for now" link
                  on the first-time setup. */}
              {isReview ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDismiss}
                >
                  Close
                </Button>
              ) : (
                <button
                  onClick={handleDismiss}
                  className="text-xs text-foreground/50 hover:text-foreground transition-colors"
                >
                  Skip for now
                </button>
              )}
            </div>
            <Button
              onClick={handleContinue}
              disabled={(step === 1 && selectedSize === null) || (step === 2 && multipleSources === null)}
            >
              {step === 3 ? 'Choose Destination' : 'Next'}
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
