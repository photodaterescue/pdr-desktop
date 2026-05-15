import { useEffect, useState } from 'react';
import { ShieldCheck, Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';

// DbBackupReminderCard — the Dashboard-surface complement to the
// persistent "Back up DB" pill on the Library Drive row in the LDM.
//
// The pill is the ALWAYS-VISIBLE affordance: open the LDM, see your
// backup state any time. The banner is the ACTIVITY-/TIME-TRIGGERED
// nudge — it surfaces on the Dashboard when the user has photos in
// their library AND either (a) has never backed up, or (b) the last
// backup is older than 30 days AND they haven't snoozed within the
// last 30 days. Whichever fires first gets the user's attention;
// "Back up now" opens the LDM (where the explainer + Back-up-now
// flow lives), "Snooze 30 days" suppresses the banner for a month.
//
// State sources:
//   settings.lastDbBackupAt          ISO timestamp of last export, or null
//   settings.dbBackupReminderSnoozedAt  ISO timestamp of last snooze, or null
//   pdr.search.stats().totalFiles    photo count — gate so we don't nag
//                                    fresh users who have nothing to lose
//
// Why a separate component (not just the pill): the user might never
// open the LDM on their own — they're driving from the Dashboard.
// The banner brings the reminder to where the user actually is,
// without being a modal they have to dismiss.

const SNOOZE_DAYS = 30;
const STALE_DAYS = 30;
const MIN_PHOTOS_TO_REMIND = 50; // below this the library isn't yet meaningful

export function DbBackupReminderCard() {
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [snoozedAt, setSnoozedAt] = useState<string | null>(null);
  const [photoCount, setPhotoCount] = useState<number>(0);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await (window as any).pdr?.settings?.get?.();
        if (!cancelled && settings) {
          setLastBackupAt(settings.lastDbBackupAt ?? null);
          setSnoozedAt(settings.dbBackupReminderSnoozedAt ?? null);
        }
      } catch {}
      try {
        const res = await (window as any).pdr?.search?.stats?.();
        if (!cancelled && res?.success && typeof res.data?.totalFiles === 'number') {
          setPhotoCount(res.data.totalFiles);
        }
      } catch {}
      if (!cancelled) setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!loaded) return null;
  // Gate on a real library — no point nagging a user with 12 photos.
  if (photoCount < MIN_PHOTOS_TO_REMIND) return null;

  const now = Date.now();
  const daysSinceBackup = lastBackupAt ? Math.floor((now - new Date(lastBackupAt).getTime()) / 86400000) : null;
  const daysSinceSnooze = snoozedAt ? Math.floor((now - new Date(snoozedAt).getTime()) / 86400000) : null;
  const snoozeActive = daysSinceSnooze !== null && daysSinceSnooze < SNOOZE_DAYS;

  const neverBackedUp = lastBackupAt === null;
  const stale = daysSinceBackup !== null && daysSinceBackup > STALE_DAYS;
  const shouldShow = (neverBackedUp || stale) && !snoozeActive;

  if (!shouldShow) return null;

  const headline = neverBackedUp
    ? 'Back up your library DB'
    : `Your library DB backup is ${daysSinceBackup} days old`;
  const body = neverBackedUp
    ? `You have ${photoCount.toLocaleString()} photos and counting in PDR. The library DB holds every face, name, tag, and date — back it up off this PC so a broken or stolen PC doesn't take it with it.`
    : 'Save a fresh copy of the library DB off this PC. Cloud, email, or another drive — anywhere not on this machine.';

  const handleBackupNow = async () => {
    // Direct OS save dialog — no LDM detour. Terry's call (2026-05-15):
    // "If the user has already chosen back up now, then shouldn't the
    // db file just download?" Routing through the LDM just to have the
    // user click another button felt redundant. Now the banner button
    // is the action: click → save dialog → save → done. Banner
    // disappears on next render because lastBackupAt becomes "today".
    if (busy) return;
    setBusy(true);
    try {
      const res = await (window as any).pdr?.library?.exportDb?.();
      if (res?.success && res.data?.path) {
        const now = new Date().toISOString();
        try {
          await (window as any).pdr?.settings?.set?.('lastDbBackupAt', now);
          await (window as any).pdr?.settings?.set?.('dbBackupReminderSnoozedAt', null);
        } catch {}
        setLastBackupAt(now);
        setSnoozedAt(null);
      }
      // res.error === 'cancelled' from the user closing the OS dialog
      // is a no-op — leave the banner visible and let them try again.
    } catch (e) {
      console.warn('[DbBackupReminderCard] backup failed:', e);
    } finally {
      setBusy(false);
    }
  };

  const handleSnooze = async () => {
    try {
      const ts = new Date().toISOString();
      await (window as any).pdr?.settings?.set?.('dbBackupReminderSnoozedAt', ts);
      setSnoozedAt(ts);
    } catch (e) {
      console.warn('[DbBackupReminderCard] snooze failed:', e);
    }
  };

  return (
    <section className="mb-6 rounded-xl border border-amber-200/70 dark:border-amber-900/40 bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/20 p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center shrink-0">
        <ShieldCheck className="w-5 h-5 text-amber-600 dark:text-amber-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-h2 text-foreground">{headline}</p>
        <p className="text-body-muted mt-1">{body}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button onClick={handleBackupNow} disabled={busy} variant="primary" size="sm">
          <Download />
          {busy ? 'Saving…' : 'Back up now'}
        </Button>
        <Button onClick={handleSnooze} disabled={busy} variant="secondary" size="sm">
          Snooze 30 days
        </Button>
        <IconTooltip label="Snooze 30 days" side="left">
          <button
            onClick={handleSnooze}
            className="p-1.5 rounded-md hover:bg-amber-200/40 dark:hover:bg-amber-800/30 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Snooze reminder"
          >
            <X className="w-4 h-4" />
          </button>
        </IconTooltip>
      </div>
    </section>
  );
}
