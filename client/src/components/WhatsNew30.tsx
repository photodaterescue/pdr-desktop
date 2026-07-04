import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, LayoutGrid, Network, Video, Sparkles, ChevronDown, Zap, CalendarDays, Search, Users, CalendarClock, HardDrive } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface WhatsNew30Props {
  isOpen: boolean;
  /** Dismiss (marks the splash as seen). Used by the X + backdrop — stays where you are. */
  onClose: () => void;
  /** "See everything that's new" — closes + opens About PDR's version history. */
  onSeeFullList: () => void;
  /** "Get started" — closes, plants the user in the Workspace, and teaches the sidebar. */
  onGetStarted?: () => void;
}

/**
 * v3.0 round 551 (Terry) — the "What's new in 3.0" showcase, THIRD pass on art + copy:
 *  - Subline is now the tagline callback "Bring your photos home." (was the wishy-washy
 *    "Everything you'll ever do…") — memorable, and it echoes the Welcome/About tagline.
 *  - The "full picture" expander is a PULSING FUCHSIA PILL so it's noticed (it was easily
 *    missed as a plain grey link).
 *  - Primary CTA reads "Get started" (it dismisses into the workspace — "Start exploring"
 *    over-promised); the secondary genuinely opens the full changelog.
 *  - The FOUNDATION cards carry each section's real SIDEBAR ACCENT colour (Memories amber,
 *    S&D blue, People fuchsia, etc. — SIDEBAR_ACCENT in workspace.tsx) so the identity users
 *    see in the side menu is reinforced here. The three NEW-in-3.0 pillars keep the
 *    violet→fuchsia "new" gradient, so new-vs-foundation reads at a glance.
 *
 * Shown ONCE (localStorage 'pdr-whatsnew-30-shown', set by the workspace on dismiss);
 * replayable from About PDR, the titlebar "3.0" pill, and the Settings footer version.
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

// v3.0 round 550 (Terry) — "the full picture": reviewers (and their viewers) skipped
// straight past the FOUNDATION — Memories, S&D, the engine itself — so the splash now
// carries the whole story behind one expander. r551: each card wears its section's real
// sidebar accent (SIDEBAR_ACCENT hexes) so the identity is consistent app-wide.
const FOUNDATION = [
  {
    key: 'engine',
    title: 'One engine, any source',
    body: 'Phone dumps, SD cards, old drives — even a 50 GB Google Takeout. PDR fixes the dates and files everything into one clean, structured library. Nothing else on the market will do this.',
    Icon: Zap,
    accent: '#a99cff', // Dashboard / primary lavender
  },
  {
    key: 'memories',
    title: 'Memories — Dates & Albums',
    body: 'Every photo lands on a timeline of the day it was taken, with albums that organise your library without ever duplicating a file.',
    Icon: CalendarDays,
    accent: '#FEC242', // Memories amber
  },
  {
    key: 'search',
    title: 'Search & Discovery',
    body: 'Find any photo in seconds — by person, place, camera, caption or date. All of it offline, on your machine.',
    Icon: Search,
    accent: '#3b82f6', // S&D blue
  },
  {
    key: 'people',
    title: 'People Manager & faces',
    body: 'Name a face once and PDR finds that person across your whole library — the same names that power Family Trees.',
    Icon: Users,
    accent: '#d946ef', // People Manager fuchsia
  },
  {
    key: 'pace',
    title: 'Your pace, no pressure',
    body: 'Photos that couldn’t be dated wait patiently in Needs Dates. Fix a handful today, a hundred next month — nothing rushes you.',
    Icon: CalendarClock,
    accent: '#fda4af', // calm pastel rose — "here when you need it"
  },
  {
    key: 'yours',
    title: 'A library that survives anything',
    body: 'Your library lives on your own drive and reconnects instantly after a reinstall or a new PC. It is yours, forever.',
    Icon: HardDrive,
    accent: '#10b981', // evergreen emerald — permanent, safe
  },
];

export function WhatsNew30({ isOpen, onClose, onSeeFullList, onGetStarted }: WhatsNew30Props) {
  // r550 — "the full picture" expander (collapsed by default). Hook sits above the
  // early return per the rules of hooks.
  const [showFull, setShowFull] = useState(false);
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
              /* r550 (Terry queried the crop) — the bleed is deliberate, but at 190px it clipped
                 timidly and read as an accident. Bigger + pushed harder off the corner = an
                 unmistakably intentional poster crop. */
              className="absolute -top-20 -right-3 text-[240px] leading-none font-bold bg-gradient-to-br from-violet-400/30 to-fuchsia-400/20 bg-clip-text text-transparent select-none pointer-events-none"
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
                className="text-[15px] text-muted-foreground leading-relaxed max-w-xl mx-auto"
              >
                <span className="text-lg font-semibold text-foreground">Bring your photos home.</span>
                <br />
                All in one place, all on your own hardware, all yours.
              </motion.p>
            </div>
          </div>

          {/* The three NEW-in-3.0 pillars — Create / Connect / Capture, centred. */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.26 }}
            className="pt-6 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-muted-foreground"
          >
            New in 3.0
          </motion.p>
          <div className="px-10 pt-3 pb-2 grid grid-cols-1 sm:grid-cols-3 gap-4">
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

          {/* r550 (Terry) — "the full picture": the FOUNDATION features behind one expander,
              collapsed by default. r551: a PULSING FUCHSIA PILL so it isn't missed; each
              revealed card wears its real sidebar-section accent. */}
          <div className="px-10 pt-5 text-center">
            <button
              type="button"
              onClick={() => setShowFull((v) => !v)}
              /* r552 (Terry) — gentle 5px-ring breathe, same rate as the Add Source CTA
                 (outline-pulse); the pulse stops once the section is open. */
              style={showFull ? undefined : { animation: 'outline-pulse-fuchsia 2s ease-in-out infinite' }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-fuchsia-400/60 bg-fuchsia-500/[0.07] text-sm font-medium text-fuchsia-600 dark:text-fuchsia-300 hover:bg-fuchsia-500/[0.12] transition-colors"
            >
              <ChevronDown className={`w-4 h-4 transition-transform duration-300 ${showFull ? 'rotate-180' : ''}`} />
              {showFull ? 'Show less' : 'New to PDR? See everything it already does'}
            </button>
            <AnimatePresence initial={false}>
              {showFull && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.35, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-4 text-left">
                    {FOUNDATION.map((f) => (
                      <div key={f.key} className="flex items-start gap-3 rounded-xl border border-border bg-secondary/25 p-3.5">
                        <div
                          className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center border"
                          style={{ backgroundColor: `${f.accent}22`, borderColor: `${f.accent}55` }}
                        >
                          <f.Icon className="w-4 h-4" style={{ color: f.accent }} />
                        </div>
                        <div>
                          <h4 className="text-[13px] font-semibold text-foreground mb-0.5">{f.title}</h4>
                          <p className="text-xs text-muted-foreground leading-relaxed">{f.body}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* CTAs + the ethos closer (mirrors the Welcome screen's trio line). */}
          <div className="px-10 pb-8 pt-5 space-y-3 text-center">
            <Button
              onClick={onGetStarted ?? onClose}
              className="w-full h-12 text-base font-medium text-white bg-gradient-to-r from-violet-600 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 shadow-lg shadow-fuchsia-500/25 hover:shadow-fuchsia-500/40 transition-all duration-300"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Get started
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
              Replay this any time from the <span className="font-medium text-foreground/80">3.0</span> badge up top, or Menu &rarr; About PDR.
            </p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
