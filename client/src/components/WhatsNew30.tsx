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
 * v3.0 round 549 (Terry) — the "What's new in 3.0" showcase, SECOND PASS on Terry's art
 * direction: bigger, everything CENTRED (it's all titles/headings), and the Viewer Share
 * button's violet→fuchsia palette woven through (gradient headline + "3", drifting glow
 * blobs, gradient primary CTA) so it pops instead of reading as one flat lavender wash.
 * Copy locked 2026-07-04: headline "The Power of 3"; subline = the "all in one place /
 * all on your own hardware / all yours" ecosystem line; closer mirrors the Welcome
 * screen's ethos trio — Security · Privacy · Ownership.
 *
 * Shown ONCE (localStorage 'pdr-whatsnew-30-shown', set by the workspace on dismiss),
 * replayable from About PDR. Modal skeleton still matches TrialLimitModal (backdrop,
 * spring scale-in, the `Button` primitive); the gradient accents are the Share button's
 * own violet→fuchsia, per Terry's explicit reference.
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
  'Video transcripts',
  'Trim & send video clips',
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
        className="fixed inset-0 bg-black/[0.45] backdrop-blur-[4px] flex items-center justify-center z-50 p-4"
      >
        <motion.div
          initial={{ scale: 0.92, opacity: 0, y: 16 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: 'spring', duration: 0.6, bounce: 0.32 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-background rounded-2xl shadow-2xl max-w-3xl w-full border border-border overflow-hidden max-h-[94vh] overflow-y-auto"
        >
          {/* Header — violet→fuchsia wash with two slow-drifting glow blobs (the collage
              glow-circle idea turned into chrome) and a gradient "3" behind the headline. */}
          <div className="relative bg-gradient-to-br from-violet-500/15 via-fuchsia-400/10 to-transparent px-10 pt-10 pb-7 overflow-hidden text-center">
            <motion.span
              aria-hidden="true"
              animate={{ x: [0, 26, 0], y: [0, -18, 0] }}
              transition={{ repeat: Infinity, duration: 9, ease: 'easeInOut' }}
              className="absolute -top-16 -left-10 w-64 h-64 rounded-full bg-violet-500/20 blur-3xl pointer-events-none"
            />
            <motion.span
              aria-hidden="true"
              animate={{ x: [0, -30, 0], y: [0, 14, 0] }}
              transition={{ repeat: Infinity, duration: 11, ease: 'easeInOut' }}
              className="absolute -bottom-20 -right-8 w-72 h-72 rounded-full bg-fuchsia-500/15 blur-3xl pointer-events-none"
            />
            <motion.span
              aria-hidden="true"
              initial={{ scale: 0.5, opacity: 0, rotate: -8 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              transition={{ delay: 0.15, type: 'spring', duration: 0.8, bounce: 0.35 }}
              className="absolute -top-8 right-8 text-[190px] leading-none font-bold bg-gradient-to-br from-violet-400/30 to-fuchsia-400/20 bg-clip-text text-transparent select-none pointer-events-none"
            >
              3
            </motion.span>
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>

            <div className="relative">
              <motion.p
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08 }}
                className="text-[11px] font-semibold tracking-[0.2em] uppercase text-muted-foreground mb-3"
              >
                Photo Date Rescue 3.0
              </motion.p>
              <motion.h2
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.14, type: 'spring', duration: 0.6 }}
                className="text-5xl font-bold mb-3 bg-gradient-to-r from-violet-600 via-fuchsia-500 to-violet-600 bg-clip-text text-transparent"
              >
                The Power of 3
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.22 }}
                className="text-[15px] text-foreground/80 leading-relaxed max-w-xl mx-auto"
              >
                Everything you&apos;ll ever do with your photos &mdash; all in one place,
                all on your own hardware, all yours.
              </motion.p>
            </div>
          </div>

          {/* The three pillars — Create / Connect / Capture, centred. */}
          <div className="px-10 pt-6 pb-2 grid grid-cols-1 sm:grid-cols-3 gap-4">
            {PILLARS.map((p, i) => (
              <motion.div
                key={p.key}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.28 + i * 0.1, type: 'spring', duration: 0.5, bounce: 0.28 }}
                className="rounded-xl border border-violet-200/50 dark:border-violet-400/15 bg-gradient-to-b from-violet-500/[0.06] to-fuchsia-500/[0.03] p-5 flex flex-col items-center text-center hover:border-fuchsia-300/60 transition-colors"
              >
                <div className="w-12 h-12 bg-gradient-to-br from-violet-500/25 to-fuchsia-500/15 rounded-xl flex items-center justify-center mb-3 border border-violet-400/25 shadow-sm shadow-fuchsia-500/10">
                  <p.Icon className="w-6 h-6 text-violet-500" />
                </div>
                <p className="text-[10px] font-semibold tracking-[0.18em] uppercase bg-gradient-to-r from-violet-500 to-fuchsia-500 bg-clip-text text-transparent mb-1">{p.word}</p>
                <h3 className="text-[15px] font-semibold text-foreground mb-2">{p.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{p.body}</p>
              </motion.div>
            ))}
          </div>

          {/* And that's not all… */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="px-10 pt-5 pb-1 text-center"
          >
            <p className="text-[11px] font-semibold tracking-[0.18em] uppercase text-muted-foreground mb-2.5">
              And that&apos;s not all
            </p>
            <div className="flex flex-wrap justify-center gap-1.5 max-w-xl mx-auto">
              {ALSO_CHIPS.map((c) => (
                <span
                  key={c}
                  className="inline-flex items-center h-6.5 px-3 py-1 rounded-full border border-violet-300/40 dark:border-violet-400/20 bg-violet-500/[0.05] text-[11.5px] text-foreground/85"
                >
                  {c}
                </span>
              ))}
            </div>
          </motion.div>

          {/* CTAs + the ethos closer (mirrors the Welcome screen's trio line). */}
          <div className="px-10 pb-8 pt-5 space-y-3 text-center">
            <Button
              onClick={onClose}
              className="w-full h-12 text-base font-medium text-white bg-gradient-to-r from-violet-600 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 shadow-lg shadow-fuchsia-500/25 hover:shadow-fuchsia-500/40 transition-all duration-300"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Start exploring
            </Button>
            <Button onClick={onSeeFullList} variant="secondary" className="w-full">
              See everything that&apos;s new
            </Button>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.8 }}
              className="pt-3 text-[11px] font-semibold tracking-[0.2em] uppercase text-foreground/70"
            >
              Built on <span className="bg-gradient-to-r from-violet-500 to-fuchsia-500 bg-clip-text text-transparent">Security &middot; Privacy &middot; Ownership</span>
            </motion.p>
            <p className="text-xs text-muted-foreground/70 leading-relaxed">
              Replay this any time from Menu &rarr; About PDR.
            </p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
