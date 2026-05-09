import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Gift,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLicense } from '@/contexts/LicenseContext';

// ─────────────────────────────────────────────────────────────────────
// RetentionModal — multi-option cancel flow + cancelled-state handling.
//
// Opens from LicenseModal's "Cancel subscription" link. On mount fetches
// the customer's plan tier, retention history, AND cancellation state
// from the Worker so the modal shows the right thing in three exclusive
// cases:
//
//   1. Already cancelled (cancel-at-period-end) — show the "you've
//      cancelled, expires X, want to resume?" view instead of the
//      retention ladder. Their card on file carries over if they resume.
//
//   2. Active subscription — show the offer ladder appropriate to
//      their plan tier. Primary card lavender-bordered as the
//      recommended path; secondary alternates underneath.
//
//   3. No actionable plan (lifetime / trial / unknown) — show a
//      generic info state. LicenseModal usually gates these out so
//      this is defensive only.
//
// Visual palette: the menu state uses an AMBER accent (header gradient,
// primary card border, "Best for you" eyebrow, Sparkles icon) instead
// of the lavender that wraps the rest of the app. This makes the
// retention experience visually announce itself as a special-offer
// moment rather than just-another-modal. Verify-key keeps its rose
// "danger" palette, success keeps emerald, and the cancelled-state
// view uses a calm slate palette so it reads as informational rather
// than alarming.
//
// Offer ladder by current plan (active subscriptions only):
//   monthly-full + first cancel  → 50% × 3 months (primary), Yearly $54, Lifetime $139
//   monthly-full + already used  → keep Monthly $19 (primary), Yearly $54, Lifetime $139
//   monthly-retention            → Yearly $54 (primary), Lifetime $139
//   yearly-full                  → $25 off forever (primary), Lifetime $139
//   yearly-retention             → Lifetime $139 only
//
// All state-changing actions (monthly-discount, switch-to-yearly,
// cancel, resume) gate behind a license-key re-entry to defend
// against accidental clicks by anyone with access to the device.
// Lifetime upsell skips the gate because card-entry on the LS
// checkout is the real barrier.
// ─────────────────────────────────────────────────────────────────────

type Step =
  | 'loading'
  | 'menu'
  | 'cancelled'
  | 'verify-key'
  | 'processing'
  | 'success'
  | 'error';

type PendingAction =
  | 'monthly-discount'
  | 'switch-to-yearly'
  | 'cancel'
  | 'resume'
  | null;

type OfferId =
  | 'monthly-discount'
  | 'switch-to-yearly'
  | 'lifetime-upsell'
  | 'stay-as-is'
  | 'cancel';

interface RetentionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface OfferOption {
  id: OfferId;
  label: string;
  description: string;
  primary?: boolean;
}

const WORKER_BASE = 'https://updates.photodaterescue.com';

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

// Single source of truth for each offer's copy. Label format is
// "[X% off] — [Plan] at [price] [duration]" so every card in the
// ladder reads in the same voice; the discount percentage leads
// because that's the number most people scan for. Bodies are
// short and parallel (duration/cadence + one practical fact).
const OFFER_MONTHLY_DISCOUNT: Omit<OfferOption, 'primary'> = {
  id: 'monthly-discount',
  label: '50% off — Monthly at $9/mo for 3 months',
  description: 'Reverts to $19/mo automatically after 3 months. Card on file stays as-is.',
};
const OFFER_SWITCH_TO_YEARLY: Omit<OfferOption, 'primary'> = {
  id: 'switch-to-yearly',
  label: '32% off — Yearly at $54/yr forever',
  description: 'Applies to every renewal, forever. Card on file stays as-is.',
};
const OFFER_LIFETIME_UPSELL: Omit<OfferOption, 'primary'> = {
  id: 'lifetime-upsell',
  label: '30% off — Lifetime at $139 one-time',
  description: 'Single payment, never another bill.',
};
const OFFER_STAY_AS_IS: Omit<OfferOption, 'primary'> = {
  id: 'stay-as-is',
  label: 'Keep Monthly at $19/mo',
  description: 'No changes — your current plan continues.',
};

function getOffersForPlan(currentPlan: string, hasUsedRetention: boolean): OfferOption[] {
  if (currentPlan === 'monthly-full' && !hasUsedRetention) {
    return [
      { ...OFFER_MONTHLY_DISCOUNT, primary: true },
      OFFER_SWITCH_TO_YEARLY,
      OFFER_LIFETIME_UPSELL,
    ];
  }
  if (currentPlan === 'monthly-full' && hasUsedRetention) {
    return [
      { ...OFFER_STAY_AS_IS, primary: true },
      OFFER_SWITCH_TO_YEARLY,
      OFFER_LIFETIME_UPSELL,
    ];
  }
  if (currentPlan === 'monthly-retention') {
    return [{ ...OFFER_SWITCH_TO_YEARLY, primary: true }, OFFER_LIFETIME_UPSELL];
  }
  if (currentPlan === 'yearly-full') {
    return [{ ...OFFER_SWITCH_TO_YEARLY, primary: true }, OFFER_LIFETIME_UPSELL];
  }
  if (currentPlan === 'yearly-retention') {
    return [{ ...OFFER_LIFETIME_UPSELL, primary: true }];
  }
  // lifetime / trial / unknown — no offers; modal shouldn't have been opened.
  return [];
}

export function RetentionModal({ isOpen, onClose }: RetentionModalProps) {
  const { storedLicenseKey, setStoredLicenseKey, activate } = useLicense();
  const [step, setStep] = useState<Step>('loading');
  const [currentPlan, setCurrentPlan] = useState<string>('unknown');
  const [hasUsedRetention, setHasUsedRetention] = useState<boolean>(false);
  const [isCancelled, setIsCancelled] = useState<boolean>(false);
  const [cancelExpiresAt, setCancelExpiresAt] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [successHeading, setSuccessHeading] = useState<string>('');

  const handleClose = () => {
    setStep('loading');
    setKeyInput('');
    setKeyError(null);
    setErrorMsg(null);
    setSuccessMsg(null);
    setSuccessHeading('');
    setPendingAction(null);
    onClose();
  };

  const callWorker = async (
    path: string,
    body: unknown,
  ): Promise<{ ok: boolean; data?: any; error?: string }> => {
    try {
      const res = await fetch(WORKER_BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        return { ok: false, error: errBody?.error || 'Worker returned ' + res.status };
      }
      const data = await res.json();
      return { ok: true, data };
    } catch {
      return { ok: false, error: 'Network error — please check your connection and try again.' };
    }
  };

  // Fetch retention status whenever the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    if (!storedLicenseKey) {
      setErrorMsg('No license key stored on this device. Please activate your license first.');
      setStep('error');
      return;
    }
    let cancelled = false;
    (async () => {
      setStep('loading');
      const result = await callWorker('/api/license/retention-status', {
        key: storedLicenseKey,
      });
      if (cancelled) return;
      if (!result.ok) {
        setErrorMsg(result.error ?? 'Could not fetch your subscription details.');
        setStep('error');
        return;
      }
      const plan = result.data?.currentPlan ?? 'unknown';
      const used = !!result.data?.hasUsedRetention;
      const cancelledFlag = !!result.data?.isCancelled;
      const expiresAt = result.data?.cancelExpiresAt ?? null;
      setCurrentPlan(plan);
      setHasUsedRetention(used);
      setIsCancelled(cancelledFlag);
      setCancelExpiresAt(expiresAt);
      // Cancelled-but-not-expired sub → the resume view, never the
      // offer ladder. The customer has already chosen to leave; offering
      // them the ladder again would feel pushy.
      setStep(cancelledFlag ? 'cancelled' : 'menu');
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, storedLicenseKey]);

  if (!isOpen) return null;

  const handlePickOption = (id: OfferId) => {
    if (id === 'stay-as-is') {
      handleClose();
      return;
    }
    if (id === 'lifetime-upsell') {
      handleLifetimeUpsell();
      return;
    }
    setPendingAction(id as PendingAction);
    setKeyError(null);
    setKeyInput('');
    setStep('verify-key');
  };

  const handlePickCancel = () => {
    setPendingAction('cancel');
    setKeyError(null);
    setKeyInput('');
    setStep('verify-key');
  };

  const handlePickResume = () => {
    setPendingAction('resume');
    setKeyError(null);
    setKeyInput('');
    setStep('verify-key');
  };

  const handleLifetimeUpsell = async () => {
    if (!storedLicenseKey) return;
    setPendingAction(null);
    setStep('processing');
    setErrorMsg(null);
    const result = await callWorker('/api/license/lifetime-upsell-checkout', {
      key: storedLicenseKey,
    });
    if (!result.ok || !result.data?.checkoutUrl) {
      setErrorMsg(result.error ?? 'Could not create your upgrade checkout — please try again.');
      setStep('error');
      return;
    }
    const { openExternalUrl } = await import('@/lib/electron-bridge');
    await openExternalUrl(result.data.checkoutUrl);
    setSuccessHeading('Heading to checkout…');
    setSuccessMsg(
      'We\'ve opened the Lemon Squeezy checkout in your browser. Once you complete payment, your Lifetime license activates automatically.',
    );
    setStep('success');
  };

  const handleVerifyAndProceed = async () => {
    if (!storedLicenseKey || !pendingAction) return;
    if (keyInput.trim().toUpperCase() !== storedLicenseKey.trim().toUpperCase()) {
      setKeyError(
        'That key does not match the licence on this device. Check the email Lemon Squeezy sent you when you purchased.',
      );
      return;
    }
    setKeyError(null);
    setStep('processing');
    setErrorMsg(null);

    if (pendingAction === 'cancel') {
      const result = await callWorker('/api/license/cancel-subscription', {
        key: storedLicenseKey,
      });
      if (!result.ok) {
        setErrorMsg(result.error ?? 'Could not cancel — please try again.');
        setStep('error');
        return;
      }
      setSuccessHeading('Subscription cancelled');
      setSuccessMsg(
        'Your subscription has been cancelled and will not renew. You can keep using Photo Date Rescue until the end of your current billing period.',
      );
      setStep('success');
      return;
    }

    if (pendingAction === 'resume') {
      const result = await callWorker('/api/license/resume-subscription', {
        key: storedLicenseKey,
      });
      if (!result.ok) {
        setErrorMsg(result.error ?? 'Could not resume — please try again.');
        setStep('error');
        return;
      }
      setSuccessHeading('Subscription resumed');
      setSuccessMsg(
        'Your subscription is active again. Billing will continue on your normal renewal date — your card on file stays as-is.',
      );
      setStep('success');
      return;
    }

    // monthly-discount or switch-to-yearly
    const result = await callWorker('/api/license/apply-retention', {
      key: storedLicenseKey,
      action: pendingAction,
    });
    if (!result.ok) {
      setErrorMsg(result.error ?? 'Could not apply — please try again.');
      setStep('error');
      return;
    }
    if (result.data?.alreadyUsed) {
      handleLifetimeUpsell();
      return;
    }
    // LS issues a fresh license key on variant change. Swap the stored
    // key + re-activate the device so the local cache stays in sync —
    // otherwise the next validate against the now-expired old key marks
    // PDR as expired even though the subscription is genuinely active.
    if (result.data?.newLicenseKey) {
      const newKey: string = result.data.newLicenseKey;
      setStoredLicenseKey(newKey);
      const actResult = await activate(newKey);
      if (!actResult.success) {
        setErrorMsg(
          actResult.error
            ? `The plan switch worked but activating the new license failed: ${actResult.error}. Open the License modal and re-enter your key to recover.`
            : 'The plan switch worked but activating the new license failed. Open the License modal and re-enter your key to recover.',
        );
        setStep('error');
        return;
      }
    }
    if (pendingAction === 'monthly-discount') {
      setSuccessHeading('Discount applied!');
      setSuccessMsg(
        'Your next bill will be $9/mo for the next 3 months, then automatically returns to $19/mo. Your card on file stays as-is — nothing else for you to do.',
      );
    } else {
      setSuccessHeading('Switched to Yearly');
      setSuccessMsg(
        'You\'re now on Yearly at $54/yr. Your card on file will be charged on your next renewal date — no more monthly bills.',
      );
    }
    setStep('success');
  };

  const offers = getOffersForPlan(currentPlan, hasUsedRetention);
  const showCancelLink = offers.length > 0;

  const verifyHeading =
    pendingAction === 'cancel'
      ? 'Confirm cancellation'
      : pendingAction === 'resume'
        ? 'Confirm resume'
        : pendingAction === 'monthly-discount'
          ? 'Confirm discount'
          : 'Confirm switch';
  const verifySubcopy =
    pendingAction === 'cancel'
      ? 'Enter your license key to confirm. This protects against accidental cancels by anyone with access to this device.'
      : pendingAction === 'resume'
        ? 'Enter your license key to confirm reactivating your subscription.'
        : pendingAction === 'monthly-discount'
          ? 'Enter your license key to confirm switching to the discounted Monthly Retention plan ($9/mo × 3 months).'
          : 'Enter your license key to confirm switching to Yearly Retention ($54/yr forever).';
  const verifyButtonLabel =
    pendingAction === 'cancel'
      ? 'Cancel my subscription'
      : pendingAction === 'resume'
        ? 'Resume my subscription'
        : 'Confirm';

  // ── Render functions ─────────────────────────────────────────────────

  const renderLoading = () => (
    <div className="px-6 py-12 flex flex-col items-center text-center gap-4">
      <Loader2 className="w-10 h-10 text-primary animate-spin" />
      <p className="text-base font-medium text-foreground">Loading your subscription details…</p>
    </div>
  );

  // Menu state — AMBER palette so the retention offer reads as a
  // special-offer moment rather than just-another-lavender-modal.
  const renderMenu = () => (
    <>
      <div className="relative bg-gradient-to-br from-amber-100 via-amber-50 to-transparent px-6 pt-8 pb-6 dark:from-amber-950/40 dark:via-amber-950/20">
        <button
          onClick={handleClose}
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
            className="w-16 h-16 bg-gradient-to-br from-amber-200 to-amber-50 rounded-2xl flex items-center justify-center mb-4 border border-amber-300/60 shadow-lg shadow-amber-500/10 dark:from-amber-700 dark:to-amber-900"
          >
            <Gift className="w-8 h-8 text-amber-600 dark:text-amber-400" />
          </motion.div>
          <p className="text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-700 dark:text-amber-400 mb-2">
            A thank-you for staying
          </p>
          <h2 className="text-xl font-semibold text-foreground mb-2">Before you go…</h2>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">
            Pick whichever option works best for you — your card on file carries over, no
            re-entry needed.
          </p>
        </div>
      </div>
      <div className="px-6 pb-6 pt-2 space-y-3">
        {offers.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No offers available for your current plan.
          </p>
        ) : (
          offers.map((offer) => (
            <button
              key={offer.id}
              onClick={() => handlePickOption(offer.id)}
              data-testid={`button-retention-${offer.id}`}
              className={
                'w-full rounded-xl border p-5 text-left transition-all hover:shadow-md ' +
                (offer.primary
                  ? 'border-amber-300/60 bg-gradient-to-br from-amber-50/60 via-amber-50/30 to-transparent hover:border-amber-400/70 shadow-sm shadow-amber-500/10 dark:from-amber-950/30 dark:via-amber-950/10 dark:border-amber-700/50'
                  : 'border-border bg-secondary/20 hover:border-amber-300/40 hover:bg-amber-50/20 dark:hover:bg-amber-950/10')
              }
            >
              <p
                className={
                  'text-xs font-semibold uppercase tracking-wider mb-2 ' +
                  (offer.primary
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-muted-foreground')
                }
              >
                {offer.primary ? 'Best for you' : 'Or'}
              </p>
              <h3 className="text-base font-semibold text-foreground mb-1.5 leading-snug flex items-center gap-2">
                {offer.label}
                {offer.primary && (
                  <Sparkles className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                )}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{offer.description}</p>
            </button>
          ))
        )}
        {showCancelLink && (
          <div className="pt-2 text-center">
            <button
              onClick={handlePickCancel}
              data-testid="button-retention-cancel-anyway"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
            >
              No thanks, cancel my subscription
            </button>
          </div>
        )}
        <p className="text-xs text-muted-foreground/70 text-center leading-relaxed pt-2">
          Reports History and Memories stay accessible regardless of subscription status.
        </p>
      </div>
    </>
  );

  // Cancelled state — same amber palette as the active offer ladder so
  // the comeback pitch feels like a celebration rather than an
  // afterthought. We show the same offer cards (with 'stay-as-is'
  // filtered out — they have to resume to stay) and demote the plain
  // "resume current plan" path to a quiet text-link at the bottom.
  // Accepting any offer-card path triggers a single PATCH that switches
  // variant AND un-cancels in one round-trip; the "just resume" link
  // is the no-change resume path.
  const renderCancelled = () => {
    let cancelledOffers = offers.filter((o) => o.id !== 'stay-as-is');
    if (cancelledOffers.length > 0 && !cancelledOffers.some((o) => o.primary)) {
      cancelledOffers = cancelledOffers.map((o, i) =>
        i === 0 ? { ...o, primary: true } : o,
      );
    }
    return (
      <>
        <div className="relative bg-gradient-to-br from-amber-100 via-amber-50 to-transparent px-6 pt-8 pb-6 dark:from-amber-950/40 dark:via-amber-950/20">
          <button
            onClick={handleClose}
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
              className="w-16 h-16 bg-gradient-to-br from-amber-200 to-amber-50 rounded-2xl flex items-center justify-center mb-4 border border-amber-300/60 shadow-lg shadow-amber-500/10 dark:from-amber-700 dark:to-amber-900"
            >
              <Gift className="w-8 h-8 text-amber-600 dark:text-amber-400" />
            </motion.div>
            <p className="text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-700 dark:text-amber-400 mb-2">
              Access ends {formatDate(cancelExpiresAt)}
            </p>
            <h2 className="text-xl font-semibold text-foreground mb-2">Reconsidering?</h2>
            <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">
              You'll keep full access until then. Here's how to come back — your card on file
              carries over, no re-checkout needed.
            </p>
          </div>
        </div>
        <div className="px-6 pb-6 pt-2 space-y-3">
          {cancelledOffers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No offers available for your plan.
            </p>
          ) : (
            cancelledOffers.map((offer) => (
              <button
                key={offer.id}
                onClick={() => handlePickOption(offer.id)}
                data-testid={`button-retention-cancelled-${offer.id}`}
                className={
                  'w-full rounded-xl border p-5 text-left transition-all hover:shadow-md ' +
                  (offer.primary
                    ? 'border-amber-300/60 bg-gradient-to-br from-amber-50/60 via-amber-50/30 to-transparent hover:border-amber-400/70 shadow-sm shadow-amber-500/10 dark:from-amber-950/30 dark:via-amber-950/10 dark:border-amber-700/50'
                    : 'border-border bg-secondary/20 hover:border-amber-300/40 hover:bg-amber-50/20 dark:hover:bg-amber-950/10')
                }
              >
                <p
                  className={
                    'text-xs font-semibold uppercase tracking-wider mb-2 ' +
                    (offer.primary
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-muted-foreground')
                  }
                >
                  {offer.primary ? 'Best for you' : 'Or'}
                </p>
                <h3 className="text-base font-semibold text-foreground mb-1.5 leading-snug flex items-center gap-2">
                  {offer.label}
                  {offer.primary && (
                    <Sparkles className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                  )}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{offer.description}</p>
              </button>
            ))
          )}
          <div className="pt-2 text-center">
            <button
              onClick={handlePickResume}
              data-testid="button-retention-resume-as-is"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
            >
              {currentPlan === 'monthly-full'
                ? 'Just resume Monthly at $19/mo — no discount'
                : currentPlan === 'monthly-retention'
                  ? 'Just resume at $9/mo — current discount continues'
                  : currentPlan === 'yearly-full'
                    ? 'Just resume Yearly at $79/yr — no discount'
                    : currentPlan === 'yearly-retention'
                      ? 'Just resume Yearly at $54/yr — current discount continues'
                      : 'Just resume my current plan — no changes'}
            </button>
          </div>
          <p className="text-xs text-muted-foreground/70 text-center leading-relaxed pt-2">
            Reports History and Memories stay accessible regardless of subscription status.
          </p>
        </div>
      </>
    );
  };

  const renderVerifyKey = () => (
    <>
      <div className="relative bg-gradient-to-br from-rose-100 via-rose-50 to-transparent px-6 pt-8 pb-6 dark:from-rose-950/40 dark:via-rose-950/20">
        <button
          onClick={handleClose}
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
            className="w-16 h-16 bg-gradient-to-br from-rose-200 to-rose-50 rounded-2xl flex items-center justify-center mb-4 border border-rose-300/60 shadow-lg shadow-rose-500/10 dark:from-rose-700 dark:to-rose-900"
          >
            <AlertTriangle className="w-8 h-8 text-rose-600 dark:text-rose-400" />
          </motion.div>
          <h2 className="text-xl font-semibold text-foreground mb-2">{verifyHeading}</h2>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">{verifySubcopy}</p>
        </div>
      </div>
      <div className="px-6 pb-6 pt-2 space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">License key</label>
          <input
            type="text"
            value={keyInput}
            onChange={(e) => {
              setKeyInput(e.target.value);
              setKeyError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleVerifyAndProceed();
            }}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            className="w-full px-4 py-3 rounded-lg border border-border bg-background text-foreground font-mono text-center tracking-wider focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            data-testid="input-cancel-confirm-key"
            autoFocus
          />
          {keyError && (
            <div className="flex items-start gap-2 mt-3 p-3 bg-rose-50 dark:bg-rose-950/30 rounded-lg border border-rose-200 dark:border-rose-800">
              <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-rose-800 dark:text-rose-300">{keyError}</p>
            </div>
          )}
        </div>
        <Button
          onClick={handleVerifyAndProceed}
          disabled={!keyInput.trim()}
          variant={pendingAction === 'cancel' ? 'destructive' : 'default'}
          className="w-full h-12 text-base font-medium"
          data-testid="button-confirm-action"
        >
          {verifyButtonLabel}
        </Button>
        <Button
          onClick={() => setStep(isCancelled ? 'cancelled' : 'menu')}
          variant="secondary"
          className="w-full"
        >
          Go back
        </Button>
      </div>
    </>
  );

  const renderProcessing = () => (
    <div className="px-6 py-12 flex flex-col items-center text-center gap-4">
      <Loader2 className="w-10 h-10 text-primary animate-spin" />
      <p className="text-base font-medium text-foreground">Working on it…</p>
      <p className="text-sm text-muted-foreground max-w-sm">
        This usually takes a couple of seconds. Please don't close the window.
      </p>
    </div>
  );

  const renderSuccess = () => {
    const isUpsell = successHeading === 'Heading to checkout…';
    const isPositive = pendingAction !== 'cancel';
    return (
      <>
        <div
          className={
            'relative px-6 pt-8 pb-6 ' +
            (isPositive
              ? 'bg-gradient-to-br from-emerald-100 via-emerald-50 to-transparent dark:from-emerald-950/40 dark:via-emerald-950/20'
              : 'bg-gradient-to-br from-secondary/50 via-secondary/20 to-transparent')
          }
        >
          <button
            onClick={handleClose}
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
                'w-16 h-16 rounded-2xl flex items-center justify-center mb-4 border shadow-lg ' +
                (isPositive
                  ? 'bg-gradient-to-br from-emerald-200 to-emerald-50 border-emerald-300/60 shadow-emerald-500/10 dark:from-emerald-700 dark:to-emerald-900'
                  : 'bg-gradient-to-br from-secondary to-secondary/50 border-border')
              }
            >
              <CheckCircle2
                className={
                  'w-8 h-8 ' +
                  (isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')
                }
              />
            </motion.div>
            <h2 className="text-xl font-semibold text-foreground mb-2">{successHeading}</h2>
            <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">{successMsg}</p>
          </div>
        </div>
        <div className="px-6 pb-6 pt-2">
          <Button onClick={handleClose} className="w-full h-12 text-base font-medium">
            {isUpsell ? 'Done — back to Photo Date Rescue' : 'Done'}
          </Button>
        </div>
      </>
    );
  };

  const renderError = () => (
    <>
      <div className="relative bg-gradient-to-br from-rose-100 via-rose-50 to-transparent px-6 pt-8 pb-6 dark:from-rose-950/40 dark:via-rose-950/20">
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
        <div className="flex flex-col items-center text-center">
          <div className="w-16 h-16 bg-gradient-to-br from-rose-200 to-rose-50 rounded-2xl flex items-center justify-center mb-4 border border-rose-300/60 shadow-lg shadow-rose-500/10 dark:from-rose-700 dark:to-rose-900">
            <AlertTriangle className="w-8 h-8 text-rose-600 dark:text-rose-400" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">Something went wrong</h2>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">
            {errorMsg ?? 'An unexpected error occurred. Please try again.'}
          </p>
        </div>
      </div>
      <div className="px-6 pb-6 pt-2 space-y-3">
        <Button
          onClick={() => {
            setErrorMsg(null);
            setStep(isCancelled ? 'cancelled' : 'menu');
          }}
          className="w-full h-12 text-base font-medium"
        >
          Try again
        </Button>
        <Button onClick={handleClose} variant="secondary" className="w-full">
          Close — contact support if this persists
        </Button>
      </div>
    </>
  );

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={handleClose}
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
          {step === 'loading' && renderLoading()}
          {step === 'menu' && renderMenu()}
          {step === 'cancelled' && renderCancelled()}
          {step === 'verify-key' && renderVerifyKey()}
          {step === 'processing' && renderProcessing()}
          {step === 'success' && renderSuccess()}
          {step === 'error' && renderError()}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
