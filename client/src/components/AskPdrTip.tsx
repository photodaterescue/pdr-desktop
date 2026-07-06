import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { AiSparkle } from '@/components/AiSparkle';

/**
 * Ask PDR learning tip (v3.1, Terry) — a small, dismissible nudge shown on empty
 * screens (empty workspace, etc.) that points first-time users at the offline AI
 * helper. Helpful while learning PDR, but annoying once you know it — so it can be
 * dismissed ("Don't show this again") and re-enabled from Settings.
 *
 * The dismissed flag lives in localStorage (PDR's pattern for dismissed advisories;
 * also cleared by Settings → Reset to Optimized Defaults). Clicking "Ask PDR" fires
 * the shared `pdr:open-ask-pdr` event that the Workspace turns into "open Help &
 * Support + focus the box" — the same action as the titlebar sparkle and Ctrl+/.
 */
export const ASK_PDR_TIP_HIDDEN_KEY = 'pdr:askPdrTipHidden';

export function isAskPdrTipHidden(): boolean {
  try { return localStorage.getItem(ASK_PDR_TIP_HIDDEN_KEY) === '1'; } catch { return false; }
}

export function setAskPdrTipHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(ASK_PDR_TIP_HIDDEN_KEY, '1');
    else localStorage.removeItem(ASK_PDR_TIP_HIDDEN_KEY);
  } catch { /* noop */ }
  // Let any mounted tip react immediately (e.g. re-enabled from Settings while the
  // empty-state tip is already on screen but hidden).
  try { window.dispatchEvent(new CustomEvent('pdr:askpdr-tip-changed')); } catch { /* noop */ }
}

export function AskPdrTip() {
  const [hidden, setHidden] = useState(isAskPdrTipHidden);
  useEffect(() => {
    const onChanged = () => setHidden(isAskPdrTipHidden());
    window.addEventListener('pdr:askpdr-tip-changed', onChanged);
    return () => window.removeEventListener('pdr:askpdr-tip-changed', onChanged);
  }, []);
  if (hidden) return null;

  const openAskPdr = () => window.dispatchEvent(new CustomEvent('pdr:open-ask-pdr'));
  const dismiss = () => { setAskPdrTipHidden(true); setHidden(true); };

  return (
    <div className="mt-8 w-full max-w-md mx-auto flex items-start gap-3 rounded-xl border border-[#8b5cf6]/40 bg-primary/[0.04] px-4 py-3 text-left">
      <AiSparkle className="w-5 h-5 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground leading-relaxed">
          New to PDR? {' '}
          <button
            type="button"
            onClick={openAskPdr}
            className="font-semibold bg-gradient-to-r from-[#c026d3] to-[#f062f5] bg-clip-text text-transparent hover:underline"
          >
            Ask PDR
          </button>
          {' '}anything in your own words — no manual to read.
        </p>
        <button
          type="button"
          onClick={dismiss}
          className="mt-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Don&apos;t show this again
        </button>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 p-1 -mt-0.5 -mr-1 text-muted-foreground/60 hover:text-foreground transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
