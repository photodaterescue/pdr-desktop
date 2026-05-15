import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';

// AiOfferCard — Apple-style post-Fix discovery surface that offers
// AI Analysis as a natural next step rather than burying it in
// Settings. Sits on the Dashboard above Source Analysis, and reads
// the same dismiss flag as the existing S&D banner so the user
// never sees a duplicate prompt across surfaces.
//
// Trigger logic (premium pattern):
//   1. AI is OFF (settings.aiEnabled === false)
//   2. The user has at least some indexed photos in the library
//      (otherwise the offer has nothing to act on)
//   3. EITHER the user has never dismissed it, OR the library has
//      grown by ≥ 5,000 photos since they last dismissed
//
// "Not now" stores the dismissed flag PLUS the current indexed-photo
// count as a baseline. Once the library exceeds baseline + 5,000,
// the offer re-shows because the value of AI scales with library
// size — at small counts AI feels like overkill, at thousands of
// photos face/tag search becomes essential. The trigger catches the
// user at the moment the need becomes real, not at an arbitrary
// "remind me later" date they chose months ago.

const DISMISS_KEY = 'pdr-ai-prompt-dismissed';
const BASELINE_KEY = 'pdr-ai-prompt-baseline';
const RE_OFFER_THRESHOLD = 5000;

interface AiOfferCardProps {
  /** Optional surface label for instrumentation / future split paths.
   *  'dashboard' = the primary post-Fix surface;
   *  'sd' = the older S&D banner (kept for users who never see
   *  Dashboard between Fix and S&D). */
  surface?: 'dashboard' | 'sd';
}

export function AiOfferCard({ surface = 'dashboard' }: AiOfferCardProps) {
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const [indexedTotal, setIndexedTotal] = useState<number>(0);
  const [dismissed, setDismissed] = useState<boolean>(() => localStorage.getItem(DISMISS_KEY) === 'true');
  const [baseline, setBaseline] = useState<number>(() => {
    const raw = localStorage.getItem(BASELINE_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  });
  const [busy, setBusy] = useState(false);

  // Fetch settings.aiEnabled + current indexed total on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await (window as any).pdr?.settings?.get?.();
        if (!cancelled && settings) setAiEnabled(!!settings.aiEnabled);
      } catch {
        if (!cancelled) setAiEnabled(false);
      }
      try {
        const res = await (window as any).pdr?.search?.stats?.();
        if (!cancelled && res?.success && typeof res.data?.totalFiles === 'number') {
          setIndexedTotal(res.data.totalFiles);
        }
      } catch {
        // Best-effort — if stats fail, treat as 0 (offer still
        // shows on first run with no baseline; never hides a
        // legitimate re-offer).
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Decision: show the offer?
  // - AI must be loaded AND off
  // - There must be at least some indexed files to act on
  // - Either never dismissed, OR library has grown ≥ 5,000 since dismiss
  const shouldShow = aiEnabled === false
    && indexedTotal > 0
    && (!dismissed || indexedTotal >= baseline + RE_OFFER_THRESHOLD);

  if (!shouldShow) return null;

  const handleEnable = async () => {
    setBusy(true);
    try {
      await (window as any).pdr?.settings?.set?.('aiEnabled', true);
      // Also clear the dismiss flag so the user sees a clean state
      // next time AI is somehow disabled (it shouldn't auto-re-offer
      // immediately after enabling).
      localStorage.removeItem(DISMISS_KEY);
      localStorage.removeItem(BASELINE_KEY);
      setDismissed(false);
      setBaseline(0);
      setAiEnabled(true);
      // Kick off model download / processing via the existing IPC the
      // S&D banner uses. Workspace listens on this event globally.
      window.dispatchEvent(new CustomEvent('pdr:aiOfferAccepted', { detail: { surface } }));
    } catch (e) {
      console.warn('[AiOfferCard] enable failed:', e);
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, 'true');
    localStorage.setItem(BASELINE_KEY, String(indexedTotal));
    setDismissed(true);
    setBaseline(indexedTotal);
  };

  // Visual: emerald-tinted card matching the existing "you just did
  // something good, here's the next step" pattern. Sparkles icon
  // signals AI/value-add. Two CTAs: primary Enable, link Not-now.
  return (
    <section className="mb-6 rounded-xl border border-violet-200/70 dark:border-violet-900/40 bg-gradient-to-r from-violet-50 to-purple-50 dark:from-violet-950/30 dark:to-purple-950/20 p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="w-10 h-10 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center shrink-0">
        <Sparkles className="w-5 h-5 text-violet-600 dark:text-violet-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-h2 text-foreground">
          {dismissed ? 'Your library has grown — recognise people and content?' : 'Your photos are organised. Take it further?'}
        </p>
        <p className="text-body-muted mt-1">
          Let PDR recognise people and what's in your photos — searchable by face and by content (sunset, beach, pet…). One-time ~300 MB download, then runs in the background, about a minute per 100 photos. Everything stays on your device.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button onClick={handleEnable} disabled={busy} variant="primary" size="sm">
          <Sparkles />
          Enable
        </Button>
        <Button onClick={handleDismiss} disabled={busy} variant="secondary" size="sm">
          Not now
        </Button>
        <IconTooltip label="Dismiss" side="left">
          <button
            onClick={handleDismiss}
            disabled={busy}
            className="p-1.5 rounded-md hover:bg-violet-200/40 dark:hover:bg-violet-800/30 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </IconTooltip>
      </div>
    </section>
  );
}
