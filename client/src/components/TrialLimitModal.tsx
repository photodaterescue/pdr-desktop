import { motion, AnimatePresence } from 'framer-motion';
import { X, Sparkles, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TrialLimitModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Files-used count returned by the Worker counter. */
  used: number;
  /** Hard cap for the Free Trial — typically 200. */
  limit: number;
  /** How many files THIS run would add. When `used + wouldUse > limit`,
   *  the modal renders "would-exceed" copy; when `used >= limit` (regardless
   *  of wouldUse) it renders "already at limit" copy. */
  wouldUse: number;
}

/**
 * Free Trial 200-file gate.
 *
 * Two variants of the same modal, picked by the relationship between
 * `used`, `wouldUse`, and `limit`:
 *
 *   used >= limit                 → "Trial limit reached" — already capped
 *   used + wouldUse > limit       → "This run would exceed your trial" —
 *                                   user is about to blow past the cap
 *
 * Visual + interaction language matches LicenseRequiredModal exactly
 * (same backdrop, same scale-in spring, same gradient header, same
 * `Button` primitive from `@/components/ui/button` not custom-button —
 * modals consistently use that one per the two-Button-files note in
 * memory).
 *
 * The "Upgrade" CTA opens the public pricing page in the system
 * browser via `openExternalUrl` — same URL LicenseRequiredModal uses
 * for the "Don't have one? Purchase" link, so users land somewhere
 * familiar regardless of which gate they hit first.
 */
export function TrialLimitModal({ isOpen, onClose, used, limit, wouldUse }: TrialLimitModalProps) {
  if (!isOpen) return null;

  const atLimit = used >= limit;
  const remaining = Math.max(0, limit - used);

  // Heading + body copy. Kept short — modals that read like a wall
  // of text get dismissed without being read.
  const heading = atLimit ? 'Trial limit reached' : 'This run would exceed your trial';
  const subheading = atLimit
    ? `You've used all ${limit} files in your Free Trial.`
    : `You have ${remaining} of ${limit} free files left, but this run would add ${wouldUse}.`;
  const body = atLimit
    ? 'Upgrade to a paid tier to keep fixing photos. Your existing reports and Memories stay accessible.'
    : 'Upgrade to a paid tier to run this Fix in full, or pick a smaller selection that fits within the remaining files.';

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: 'spring', duration: 0.5, bounce: 0.3 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-background rounded-2xl shadow-2xl max-w-md w-full border border-border overflow-hidden"
        >
          {/* Header — uses an amber gradient when we're at the limit
              (more urgent feel) and the standard primary gradient
              when we're just warning a too-big run. */}
          <div className={
            atLimit
              ? 'relative bg-gradient-to-br from-amber-100 via-amber-50 to-transparent px-6 pt-8 pb-6'
              : 'relative bg-gradient-to-br from-primary/10 via-primary/5 to-transparent px-6 pt-8 pb-6'
          }>
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>

            <div className="flex flex-col items-center text-center">
              <motion.div
                initial={{ scale: 0, rotate: -20 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ delay: 0.1, type: 'spring', stiffness: 200 }}
                className={
                  atLimit
                    ? 'w-16 h-16 bg-gradient-to-br from-amber-200 to-amber-50 rounded-2xl flex items-center justify-center mb-4 border border-amber-300/60 shadow-lg shadow-amber-500/10'
                    : 'w-16 h-16 bg-gradient-to-br from-primary/20 to-primary/5 rounded-2xl flex items-center justify-center mb-4 border border-primary/20 shadow-lg shadow-primary/10'
                }
              >
                {atLimit
                  ? <AlertTriangle className="w-8 h-8 text-amber-600" />
                  : <Sparkles className="w-8 h-8 text-primary" />}
              </motion.div>

              <h2 className="text-xl font-semibold text-foreground mb-2">{heading}</h2>
              <p className="text-muted-foreground text-sm leading-relaxed">{subheading}</p>
            </div>
          </div>

          {/* Content */}
          <div className="px-6 pb-6 pt-2">
            <div className="space-y-4">
              <p className="text-sm text-foreground/80 leading-relaxed text-center">
                {body}
              </p>

              {/* Primary CTA — opens the pricing page in the system
                  browser. Same target as LicenseRequiredModal's
                  "Purchase" link so the user lands on a familiar
                  page regardless of which gate brought them here. */}
              <Button
                onClick={async () => {
                  const { openExternalUrl } = await import('@/lib/electron-bridge');
                  await openExternalUrl('https://photodaterescue.com/#pricing');
                  onClose();
                }}
                className="w-full h-12 text-base font-medium shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all duration-300"
              >
                <Sparkles className="w-4 h-4 mr-2" />
                Upgrade to keep going
              </Button>

              {/* Secondary action — secondary variant per the
                  STYLE_GUIDE.md "Cancel buttons" rule. Closes the
                  modal so the user can either pick a smaller batch
                  (would-exceed mode) or just keep browsing reports
                  (at-limit mode). */}
              <Button
                onClick={onClose}
                variant="secondary"
                className="w-full"
              >
                {atLimit ? 'Continue browsing' : 'Pick a smaller selection'}
              </Button>

              {/* Reassurance — match LicenseRequiredModal's tone of
                  small print at the bottom. */}
              <p className="text-xs text-muted-foreground/70 text-center leading-relaxed">
                Reports History and Memories stay available regardless of trial status.
              </p>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
