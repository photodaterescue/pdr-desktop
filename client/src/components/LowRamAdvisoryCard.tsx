import { useEffect, useState } from 'react';
import { Cpu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';

// LowRamAdvisoryCard — one-shot Dashboard guidance for users on
// budget hardware where very large Takeouts (>20 GB) may struggle.
//
// Customer Kathr (2026-05-16) ran a Pentium N4200 / 4 GB DDR3
// laptop on a 50 GB Takeout source served over SMB to a UNC library
// drive — every single combination of factors that makes PDR slow
// or memory-tight, all at once. Without a heads-up upfront, users
// in this bracket spend hours grinding before working out their
// hardware just isn't going to handle a single 50 GB chunk. A calm
// one-time advisory at first launch flags it before they start.
//
// Trigger condition: totalmem < LOW_RAM_GB_THRESHOLD AND the user
// has not previously dismissed the advisory (settings flag
// lowRamAdvisoryDismissedAt). Once dismissed, never re-shown — this
// is not a recurring nag, it's a one-off heads-up.
//
// The fix is genuinely user-side: Google's Takeout settings let you
// split your library into smaller pieces (e.g. 10 GB instead of
// 50 GB). PDR can't make a 4 GB-RAM laptop into an 8 GB one; we can
// only tell the user upfront that the smaller-pieces option exists.

const LOW_RAM_GB_THRESHOLD = 6; // anything under this gets the advisory

export function LowRamAdvisoryCard() {
  const [totalGB, setTotalGB] = useState<number | null>(null);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mem = await (window as any).pdr?.system?.memoryInfo?.();
        if (!cancelled && mem?.success && typeof mem.data?.totalGB === 'number') {
          setTotalGB(mem.data.totalGB);
        }
      } catch { /* ignore — leaves the card hidden */ }
      try {
        const settings = await (window as any).pdr?.settings?.get?.();
        if (!cancelled && settings) {
          setDismissedAt(settings.lowRamAdvisoryDismissedAt ?? null);
        }
      } catch { /* ignore — defaults to not dismissed */ }
      if (!cancelled) setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!loaded) return null;
  if (dismissedAt) return null;
  if (totalGB === null || totalGB >= LOW_RAM_GB_THRESHOLD) return null;

  const handleDismiss = async () => {
    try {
      const ts = new Date().toISOString();
      await (window as any).pdr?.settings?.set?.('lowRamAdvisoryDismissedAt', ts);
      setDismissedAt(ts);
    } catch (e) {
      console.warn('[LowRamAdvisoryCard] dismiss failed:', e);
    }
  };

  return (
    <section className="mb-6 rounded-xl border border-amber-200/70 dark:border-amber-900/40 bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/20 p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center shrink-0">
        <Cpu className="w-5 h-5 text-amber-600 dark:text-amber-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-h2 text-foreground">PDR works best with 8 GB+ RAM</p>
        <p className="text-body-muted mt-1">
          This PC has {totalGB} GB. Smaller Takeouts (up to ~20 GB) should run fine — single 50 GB Takeouts may be slow or run out of memory. Google's Takeout settings let you split your library into smaller pieces (e.g. 10 GB instead of 50 GB) which helps a lot.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button onClick={handleDismiss} variant="secondary" size="sm">
          Got it
        </Button>
        <IconTooltip label="Dismiss" side="left">
          <button
            onClick={handleDismiss}
            className="p-1.5 rounded-md hover:bg-amber-200/40 dark:hover:bg-amber-800/30 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Dismiss advisory"
          >
            <X className="w-4 h-4" />
          </button>
        </IconTooltip>
      </div>
    </section>
  );
}
