import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Sparkles, AlertTriangle, CheckCircle2, Loader2, Heart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLicense } from '@/contexts/LicenseContext';

// ─────────────────────────────────────────────────────────────────────
// RetentionModal — multi-option cancel-flow.
//
// Opens from LicenseModal's "Cancel subscription" link. Fetches the
// customer's current plan tier + retention history from the Worker on
// mount so the menu of offers reflects exactly what's available given
// where they are in the subscription lifecycle. The renderer never
// reasons about "is this the first cancel?" or "are they on the
// retention discount yet?" — the Worker computes that and returns a
// simple `currentPlan` string the renderer maps to a fixed offer set.
//
// Offer ladder by current plan:
//   monthly-full + first cancel  → 50% × 3 months (primary), Yearly $54, Lifetime $139
//   monthly-full + already used  → keep Monthly $19 (primary), Yearly $54, Lifetime $139
//   monthly-retention            → Yearly $54 (primary), Lifetime $139
//   yearly-full                  → $25 off forever ($54/yr) (primary), Lifetime $139
//   yearly-retention             → Lifetime $139 only
//
// All state-changing actions (monthly-discount, switch-to-yearly, cancel)
// gate behind a license-key re-entry to defend against accidental clicks
// by anyone with access to the device. Lifetime upsell skips the gate
// because card-entry is the real barrier.
// ─────────────────────────────────────────────────────────────────────

type Step = 'loading' | 'menu' | 'verify-key' | 'processing' | 'success' | 'error';
type PendingAction = 'monthly-discount' | 'switch-to-yearly' | 'cancel' | null;
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

function getOffersForPlan(currentPlan: string, hasUsedRetention: boolean): OfferOption[] {
  if (currentPlan === 'monthly-full' && !hasUsedRetention) {
    return [
      {
        id: 'monthly-discount',
        label: 'Stay on Monthly — $9/mo for 3 months',
        description:
          'Save 50% × 3 months ($30 total). Reverts to $19/mo automatically afterwards. Your card on file stays as-is.',
        primary: true,
      },
      {
        id: 'switch-to-yearly',
        label: 'Switch to Yearly — $54/yr forever',
        description:
          'Save $174/yr vs full Monthly. The discount applies to every renewal, forever, for as long as you stay subscribed.',
      },
      {
        id: 'lifetime-upsell',
        label: 'Buy Lifetime — $139 one-time',
        description:
          '30% off Lifetime. One payment, no more bills. About 7 months of Monthly pays this off outright.',
      },
    ];
  }
  if (currentPlan === 'monthly-full' && hasUsedRetention) {
    return [
      {
        id: 'stay-as-is',
        label: 'Keep Monthly at $19/mo',
        description: 'Continue your current plan with no changes — your card on file stays as-is.',
        primary: true,
      },
      {
        id: 'switch-to-yearly',
        label: 'Switch to Yearly — $54/yr forever',
        description:
          'Save $174/yr vs Monthly. The discount applies to every renewal, forever.',
      },
      {
        id: 'lifetime-upsell',
        label: 'Buy Lifetime — $139 one-time',
        description: '30% off Lifetime. One payment, never pay again.',
      },
    ];
  }
  if (currentPlan === 'monthly-retention') {
    return [
      {
        id: 'switch-to-yearly',
        label: 'Switch to Yearly — $54/yr forever',
        description:
          'Save $174/yr vs full Monthly. The discount applies to every renewal, forever.',
        primary: true,
      },
      {
        id: 'lifetime-upsell',
        label: 'Buy Lifetime — $139 one-time',
        description: '30% off Lifetime. One payment, never pay again.',
      },
    ];
  }
  if (currentPlan === 'yearly-full') {
    return [
      {
        id: 'switch-to-yearly',
        label: 'Save $25/yr forever — switch to $54/yr',
        description:
          'The discount applies to every future renewal, forever, for as long as you stay subscribed.',
        primary: true,
      },
      {
        id: 'lifetime-upsell',
        label: 'Buy Lifetime — $139 one-time',
        description: '30% off Lifetime. One payment, never pay again.',
      },
    ];
  }
  if (currentPlan === 'yearly-retention') {
    return [
      {
        id: 'lifetime-upsell',
        label: 'Buy Lifetime — $139 one-time',
        description:
          '30% off Lifetime. About 2.5 years of Yearly pays this off outright. One payment, never pay again.',
        primary: true,
      },
    ];
  }
  // lifetime / trial / unknown — no offers; modal shouldn't have been opened.
  return [];
}

export function RetentionModal({ isOpen, onClose }: RetentionModalProps) {
  const { storedLicenseKey } = useLicense();
  const [step, setStep] = useState<Step>('loading');
  const [currentPlan, setCurrentPlan] = useState<string>('unknown');
  const [hasUsedRetention, setHasUsedRetention] = useState<boolean>(false);
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

  // Fetch retention status whenever the modal opens. Re-fetches if the
  // license key changes mid-session (rare, but defensive).
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
      setCurrentPlan(result.data?.currentPlan ?? 'unknown');
      setHasUsedRetention(!!result.data?.hasUsedRetention);
      setStep('menu');
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, storedLicenseKey]);

  if (!isOpen) return null;

  const handlePickOption = (id: OfferId) => {
    if (id === 'stay-as-is') {
      // No state change — just close the modal.
      handleClose();
      return;
    }
    if (id === 'lifetime-upsell') {
      // Skip the verify-key gate; card-entry on the LS checkout is the
      // real barrier. Just open the checkout in the system browser.
      handleLifetimeUpsell();
      return;
    }
    // monthly-discount / switch-to-yearly / cancel — verify key first.
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

  const handleLifetimeUpsell = async () => {
    if (!storedLicenseKey) return;
    setPendingAction(null); // not a state-changing action; keep success-screen logic clean
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
      // Server says the customer's already used this. Bounce them to
      // the lifetime upsell as a sensible fallback rather than erroring.
      handleLifetimeUpsell();
      return;
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
      : pendingAction === 'monthly-discount'
        ? 'Confirm discount'
        : 'Confirm switch';
  const verifySubcopy =
    pendingAction === 'cancel'
      ? 'Enter your license key to confirm. This protects against accidental cancels by anyone with access to this device.'
      : pendingAction === 'monthly-discount'
        ? 'Enter your license key to confirm switching to the discounted Monthly Retention plan ($9/mo × 3 months).'
        : 'Enter your license key to confirm switching to Yearly Retention ($54/yr forever).';
  const verifyButtonLabel =
    pendingAction === 'cancel' ? 'Cancel my subscription' : 'Confirm';

  // ── Render functions ─────────────────────────────────────────────────

  const renderLoading = () => (
    <div className="px-6 py-12 flex flex-col items-center text-center gap-4">
      <Loader2 className="w-10 h-10 text-primary animate-spin" />
      <p className="text-base font-medium text-foreground">Loading your subscription details…</p>
    </div>
  );

  const renderMenu = () => (
    <>
      <div className="relative bg-gradient-to-br from-primary/15 via-primary/5 to-transparent px-6 pt-8 pb-6">
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
            className="w-16 h-16 bg-gradient-to-br from-primary/20 to-primary/5 rounded-2xl flex items-center justify-center mb-4 border border-primary/20 shadow-lg shadow-primary/10"
          >
            <Heart className="w-8 h-8 text-primary" />
          </motion.div>
          <h2 className="text-xl font-semibold text-foreground mb-2">Before you go…</h2>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">
            We'd hate to see you leave. Pick whichever option works best for you — your card on
            file carries over, no re-entry needed.
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
                  ? 'border-primary/40 bg-primary/5 hover:border-primary/60 shadow-sm shadow-primary/10'
                  : 'border-border bg-secondary/20 hover:border-primary/30 hover:bg-primary/[0.02]')
              }
            >
              <p
                className={
                  'text-xs font-semibold uppercase tracking-wider mb-2 ' +
                  (offer.primary ? 'text-primary' : 'text-muted-foreground')
                }
              >
                {offer.primary ? 'Best for you' : 'Or'}
              </p>
              <h3 className="text-base font-semibold text-foreground mb-1.5 leading-snug flex items-center gap-2">
                {offer.label}
                {offer.primary && <Sparkles className="w-4 h-4 text-primary flex-shrink-0" />}
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
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">
            {verifySubcopy}
          </p>
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
        <Button onClick={() => setStep('menu')} variant="secondary" className="w-full">
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
    const isUpsell = pendingAction === null && successHeading === 'Heading to checkout…';
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
            <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">
              {successMsg}
            </p>
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
            setStep('menu');
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
          {step === 'verify-key' && renderVerifyKey()}
          {step === 'processing' && renderProcessing()}
          {step === 'success' && renderSuccess()}
          {step === 'error' && renderError()}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
