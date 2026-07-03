import { motion, AnimatePresence } from 'framer-motion';
import { X, LayoutGrid, Network, Video, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface WhatsNew30Props {
  isOpen: boolean;
  /** Dismiss (marks the splash as seen). */
  onClose: () => void;
  /** "See everything that's new" — closes + opens About PDR's version history. */
  onSeeFullList: () => void;
}

/**
 * v3.0 round 548 (Terry) — the "What's new in 3.0" SECOND SPLASH / feature showcase.
 *
 * Terry: "this is our chance to showcase/amaze customers (and free-testers), with all
 * that PDR brings to the table." Slogan pairing agreed 2026-07-03: headline "The Power
 * of 3", subline "They say good things come in threes." — the 3 carries triple weight:
 * version 3.0, the three marquee features, and PDR's three principles (Security /
 * Privacy / Ownership). The three feature cards are labelled Create / Connect / Capture.
 *
 * Shown ONCE (localStorage 'pdr-whatsnew-30-shown', set by the workspace on dismiss),
 * replayable from About PDR. Visual + interaction language matches TrialLimitModal /
 * LicenseRequiredModal exactly (same backdrop, spring scale-in, gradient header, the
 * `Button` primitive from @/components/ui/button — modals consistently use that one).
 */

const PILLARS = [
  {
    key: 'create',
    word: 'Create',
    title: 'Collages & Carousels',
    body: 'A full design studio: layouts, frames, text and fonts, layered backgrounds and effects. Every design saves as a project you can reopen — and as a real photo in your library.',
    Icon: LayoutGrid,
  },
  {
    key: 'connect',
    word: 'Connect',
    title: 'Family Trees',
    body: 'Turn the people you’ve named into a living family tree — built from the actual photos of the people in it. Focus anyone, explore generation by generation.',
    Icon: Network,
  },
  {
    key: 'capture',
    word: 'Capture',
    title: 'Screen Capture',
    body: 'Record your screen straight into your library — with voiceover, zoom moments, a webcam bubble and live privacy blur. Screenshots too.',
    Icon: Video,
  },
];

const ALSO_CHIPS = [
  'Send to Phone',
  'Print & PDF',
  'Drag out in bulk',
  'Photo captions',
  'Video transcription',
  'Enhance & AI repair',
  'Recycle Bin',
  'Needs Dates',
];

export function WhatsNew30({ isOpen, onClose, onSeeFullList }: WhatsNew30Props) {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-black/[0.35] backdrop-blur-[3px] flex items-center justify-center z-50 p-4"
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: 'spring', duration: 0.5, bounce: 0.3 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-background rounded-2xl shadow-2xl max-w-2xl w-full border border-border overflow-hidden"
        >
          {/* Header — the standard primary gradient, with an oversized translucent "3"
              as the brand motif behind the headline. */}
          <div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-transparent px-8 pt-8 pb-6 overflow-hidden">
            <span
              aria-hidden="true"
              className="absolute -top-6 right-6 text-[150px] leading-none font-bold text-primary/10 select-none pointer-events-none"
            >
              3
            </span>
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>

            <div className="relative">
              <p className="text-[11px] font-semibold tracking-[0.18em] uppercase text-muted-foreground mb-2">
                Photo Date Rescue 3.0
              </p>
              <h2 className="text-3xl font-semibold text-foreground mb-1.5">The Power of 3</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                They say good things come in threes. PDR is now a full home for your photos &mdash;
                and everything still happens on your own hardware, nothing uploaded, ever.
              </p>
            </div>
          </div>

          {/* The three pillars — Create / Connect / Capture. */}
          <div className="px-8 pt-5 pb-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {PILLARS.map((p, i) => (
              <motion.div
                key={p.key}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12 + i * 0.09, type: 'spring', duration: 0.45, bounce: 0.25 }}
                className="rounded-xl border border-border bg-secondary/30 p-4 flex flex-col"
              >
                <div className="w-10 h-10 bg-gradient-to-br from-primary/20 to-primary/5 rounded-xl flex items-center justify-center mb-3 border border-primary/20 shadow-sm shadow-primary/10">
                  <p.Icon className="w-5 h-5 text-primary" />
                </div>
                <p className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground mb-0.5">{p.word}</p>
                <h3 className="text-sm font-semibold text-foreground mb-1.5">{p.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{p.body}</p>
              </motion.div>
            ))}
          </div>

          {/* And that's not all… */}
          <div className="px-8 pt-3 pb-1">
            <p className="text-[11px] font-semibold tracking-[0.16em] uppercase text-muted-foreground mb-2">
              And that&apos;s not all
            </p>
            <div className="flex flex-wrap gap-1.5">
              {ALSO_CHIPS.map((c) => (
                <span
                  key={c}
                  className="inline-flex items-center h-6 px-2.5 rounded-full border border-border bg-secondary/40 text-[11px] text-foreground/80"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>

          {/* CTAs */}
          <div className="px-8 pb-6 pt-4 space-y-2.5">
            <Button
              onClick={onClose}
              className="w-full h-12 text-base font-medium shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all duration-300"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Start exploring
            </Button>
            <Button onClick={onSeeFullList} variant="secondary" className="w-full">
              See everything that&apos;s new
            </Button>
            <p className="text-xs text-muted-foreground/70 text-center leading-relaxed">
              Replay this any time from Menu &rarr; About PDR.
            </p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
