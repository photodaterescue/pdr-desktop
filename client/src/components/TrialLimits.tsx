import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, Sparkles, X, ArrowUpRight, Camera, Video, Film, Images, LayoutGrid, Users, ImageDown } from 'lucide-react';
import { useLicense } from '@/contexts/LicenseContext';
import { getTrialUsage, type TrialUsage, type TrialUsageFeature } from '@/lib/electron-bridge';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';

/**
 * v3.0 (Terry) — the Free-trial usage centre. One place a trial user can see how much of each
 * capped feature they've used, with an alert when a limit is hit + an Upgrade path. Paid plans
 * are fully uncapped, so none of this renders for them — except in PREVIEW mode (fired via the
 * `pdr:preview-trial-limits` event) so a paid licence can still see the whole thing.
 *
 * Wiring: <TrialLimitsButton/> lives in the title bar; <TrialLimitsHost/> is mounted once and
 * owns the modals. They talk over window events, so the button doesn't need to share React state
 * across the title-bar / workspace trees.
 */

const ICONS: Record<string, typeof Camera> = {
  files: ImageDown, people: Users, faceScreenshot: Camera, faceWebcam: Video,
  clips: Film, collages: LayoutGrid, carousels: Images, screenshots: Camera, recordings: Video,
};

function openUpgrade() {
  window.dispatchEvent(new CustomEvent('pdr:openLicenseModal'));
}

/**
 * Static mirror of the backend TRIAL_FEATURES so the modal can render INSTANTLY (with zeros/unknown)
 * without waiting on trial:getUsage — whose cloud files-count can be slow. Live numbers replace these
 * the moment the fetch resolves. Keep labels/limits in sync with electron/usage-tracker.ts.
 */
const FALLBACK_FEATURES: TrialUsageFeature[] = [
  { key: 'files', label: 'Photos & videos fixed', used: 0, limit: 1000, reached: false, unknown: true },
  { key: 'people', label: 'People named in your tree', used: 0, limit: 12, reached: false, unknown: false },
  { key: 'faceScreenshot', label: 'Faces set from a screenshot', used: 0, limit: 3, reached: false, unknown: false },
  { key: 'faceWebcam', label: 'Faces set from a webcam', used: 0, limit: 3, reached: false, unknown: false },
  { key: 'clips', label: 'Video clips', used: 0, limit: 10, reached: false, unknown: false },
  { key: 'collages', label: 'Collages saved', used: 0, limit: 5, reached: false, unknown: false },
  { key: 'carousels', label: 'Carousels saved', used: 0, limit: 5, reached: false, unknown: false },
  { key: 'screenshots', label: 'Screenshots', used: 0, limit: 20, reached: false, unknown: false },
  { key: 'recordings', label: 'Screen recordings', used: 0, limit: 5, reached: false, unknown: false },
];
const FALLBACK_USAGE: TrialUsage = { isTrial: true, plan: 'free', features: FALLBACK_FEATURES, anyReached: false };

/** Illustrative usage so a paid licence (preview) can see every state — some empty, some near, one hit. */
function sampleUsage(real: TrialUsage): TrialUsage {
  const demo: Record<string, number> = {
    files: 742, people: 12, faceScreenshot: 2, faceWebcam: 0,
    clips: 8, collages: 5, carousels: 1, screenshots: 14, recordings: 3,
  };
  const features = real.features.map((f) => {
    const used = demo[f.key] ?? f.used;
    return { ...f, used, reached: used >= f.limit, unknown: false };
  });
  return { isTrial: true, plan: 'free', features, anyReached: features.some((x) => x.reached) };
}

/** Shared fetch of the trial usage snapshot; refreshes on the `pdr:trial-usage-changed` event. */
function useTrialUsage() {
  const { license, storedLicenseKey } = useLicense();
  const isTrial = license.plan === 'free' && !!storedLicenseKey;
  const [usage, setUsage] = useState<TrialUsage | null>(null);
  const refresh = useCallback(async () => {
    const u = await getTrialUsage(storedLicenseKey || undefined);
    if (u) setUsage(u);
  }, [storedLicenseKey]);
  useEffect(() => { if (isTrial) void refresh(); }, [isTrial, refresh]);
  useEffect(() => {
    const h = () => { void refresh(); };
    // Refresh on an explicit change ping AND whenever a cap blocks something (so the
    // title-bar alert dot lights up the instant a limit is hit).
    window.addEventListener('pdr:trial-usage-changed', h);
    window.addEventListener('pdr:trial-limit', h);
    return () => {
      window.removeEventListener('pdr:trial-usage-changed', h);
      window.removeEventListener('pdr:trial-limit', h);
    };
  }, [refresh]);
  return { isTrial, usage, refresh };
}

// ─── Limit acknowledgement ───────────────────────────────────────────────────
// Caps are LIFETIME (a reached limit never un-reaches), so an alert keyed purely on "anyReached"
// would nag forever. Instead we remember which reached limits the user has SEEN (opened the usage
// modal since they hit) in localStorage; the button alerts only for reached-but-unacknowledged
// limits, then falls back to its neutral fuchsia (free-trial) look. A brand-new limit re-alerts.
const ACK_KEY = 'pdr-trial-ack-reached';
function getAckReached(): string[] { try { return JSON.parse(localStorage.getItem(ACK_KEY) || '[]'); } catch { return []; } }
function setAckReached(keys: string[]): void { try { localStorage.setItem(ACK_KEY, JSON.stringify(keys)); } catch { /* ignore */ } }

// ─── Title-bar button ────────────────────────────────────────────────────────
export function TrialLimitsButton() {
  const { isTrial, usage } = useTrialUsage();
  const [preview, setPreview] = useState(false);
  const [ack, setAck] = useState<string[]>(() => getAckReached());
  useEffect(() => {
    const onPreview = () => setPreview(true);
    const onAck = () => setAck(getAckReached());
    window.addEventListener('pdr:preview-trial-limits', onPreview);
    window.addEventListener('pdr:trial-ack-changed', onAck);
    return () => {
      window.removeEventListener('pdr:preview-trial-limits', onPreview);
      window.removeEventListener('pdr:trial-ack-changed', onAck);
    };
  }, []);
  if (!isTrial && !preview) return null;
  // Neutral = the Viewer "Share" button's violet→fuchsia AI gradient + WHITE text (Terry's reference)
  // so it's release-branded and crisp, not a pale tint. Alert = a warm amber→orange gradient (white
  // text) that clearly contrasts, shown while a reached limit is still unacknowledged. Preview = neutral.
  const alerting = !preview && !!usage?.features?.some((f) => f.reached && !ack.includes(f.key));
  return (
    <IconTooltip label={alerting ? 'Trial Limits — you’ve hit a limit' : 'Trial Limits — you’re on the free trial'} side="bottom">
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('pdr:openTrialUsage'))}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold tracking-wide text-white border transition-all duration-150 hover:brightness-110 ${
          alerting
            ? 'bg-gradient-to-r from-amber-500 to-orange-500 border-orange-400/70 shadow-[0_0_10px_rgba(245,158,11,0.5)]'
            : 'bg-gradient-to-r from-violet-500 to-fuchsia-500 border-fuchsia-500/60 shadow-[0_0_10px_rgba(139,92,246,0.45)]'
        }`}
        data-testid="trial-limits-button"
      >
        <Gauge className="w-3 h-3" />
        Trial Limits
        {alerting && <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
      </button>
    </IconTooltip>
  );
}

// ─── A single feature row ────────────────────────────────────────────────────
function FeatureRow({ f }: { f: TrialUsageFeature }) {
  const Icon = ICONS[f.key] ?? Sparkles;
  const pct = f.limit > 0 ? Math.min(100, Math.round((f.used / f.limit) * 100)) : 0;
  const near = !f.reached && pct >= 80;
  const barColor = f.reached ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-primary';
  const countText = f.unknown ? '—' : `${f.used} of ${f.limit}`;
  return (
    <div className="flex items-center gap-3 py-2">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${f.reached ? 'bg-red-500/10 text-red-500' : 'bg-primary/10 text-primary'}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground truncate">{f.label}</span>
          {/* Always show the count — even at the limit (Terry). "Limit reached" is a tag beside it, not a replacement. */}
          <span className="flex items-center gap-1.5 shrink-0">
            {f.reached && <span className="text-[10px] font-semibold uppercase tracking-wide text-red-500">Limit reached</span>}
            <span className={`text-xs font-semibold tabular-nums ${f.reached ? 'text-red-600 dark:text-red-400' : near ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
              {countText}
            </span>
          </span>
        </div>
        <div className="mt-1 h-1.5 rounded-full bg-secondary overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${f.unknown ? 0 : pct}%` }} />
        </div>
      </div>
    </div>
  );
}

// ─── Modals + event host (mounted once) ──────────────────────────────────────
export function TrialLimitsHost() {
  const { license, storedLicenseKey } = useLicense();
  const { isTrial, usage, refresh } = useTrialUsage();
  const [usageOpen, setUsageOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [upsell, setUpsell] = useState<{ message: string } | null>(null);

  // Open the usage modal (button or preview); fire the upsell on any capped block.
  useEffect(() => {
    // Open IMMEDIATELY (fallback data renders at once); the fetch fills in live numbers when it
    // resolves. Never gate the open on refresh() — its cloud files-count can take seconds.
    const openUsage = () => { setUsageOpen(true); void refresh(); };
    const openPreview = () => { setPreview(true); setUsageOpen(true); void refresh(); };
    const onLimit = (e: Event) => {
      const d = (e as CustomEvent).detail as { message?: string } | undefined;
      setUpsell({ message: d?.message || 'You’ve reached a free-trial limit. Upgrade for unlimited.' });
      void refresh();
    };
    window.addEventListener('pdr:openTrialUsage', openUsage);
    window.addEventListener('pdr:preview-trial-limits', openPreview);
    window.addEventListener('pdr:trial-limit', onLimit);
    return () => {
      window.removeEventListener('pdr:openTrialUsage', openUsage);
      window.removeEventListener('pdr:preview-trial-limits', openPreview);
      window.removeEventListener('pdr:trial-limit', onLimit);
    };
  }, [refresh]);

  // Post-activation nudge: the first time a trial licence becomes active, point them at the button.
  const nudgedRef = useRef(false);
  useEffect(() => {
    if (license.plan !== 'free' || !storedLicenseKey || nudgedRef.current) return;
    try { if (localStorage.getItem('pdr-trial-nudge-shown') === 'true') { nudgedRef.current = true; return; } } catch { /* ignore */ }
    nudgedRef.current = true;
    try { localStorage.setItem('pdr-trial-nudge-shown', 'true'); } catch { /* ignore */ }
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('pdr-toast', { detail: {
        type: 'info', title: 'You’re on the free trial',
        message: 'Track how much of each feature you’ve used anytime from the Trial Limits button, top-left.',
        duration: 9000,
      } }));
    }, 1400);
  }, [license.plan, storedLicenseKey]);

  // Opening the REAL usage modal acknowledges whatever limits are currently reached, so the
  // title-bar button drops its amber alert back to neutral fuchsia (and won't nag until a NEW
  // limit hits). Preview never acknowledges (it isn't the user's real state).
  useEffect(() => {
    if (!usageOpen || preview || !usage) return;
    const reached = usage.features.filter((f) => f.reached).map((f) => f.key);
    if (!reached.length) return;
    const cur = getAckReached();
    const merged = Array.from(new Set([...cur, ...reached]));
    if (merged.length !== cur.length) {
      setAckReached(merged);
      window.dispatchEvent(new CustomEvent('pdr:trial-ack-changed'));
    }
  }, [usageOpen, preview, usage]);

  // Always render SOMETHING the instant the modal opens: real usage if fetched, else the static
  // fallback. Preview overlays illustrative numbers on whichever base we have.
  const base = usage ?? FALLBACK_USAGE;
  const shown = preview ? sampleUsage(base) : base;
  const closeUsage = () => { setUsageOpen(false); setPreview(false); };

  if ((!isTrial && !preview) && !upsell) return null;

  return createPortal(
    <>
      {usageOpen && shown && (
        <div className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) closeUsage(); }}>
          <div className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-foreground flex items-center gap-2"><Gauge className="w-4 h-4 text-primary" /> Your free-trial usage</h3>
                <p className="text-xs text-muted-foreground mt-1">What you’ve used of each feature. Upgrade any time for unlimited{preview ? ' (preview — sample numbers)' : ''}.</p>
              </div>
              <button onClick={closeUsage} className="shrink-0 -mr-1 p-1 rounded hover:bg-secondary transition-colors" aria-label="Close"><X className="w-4 h-4 text-muted-foreground" /></button>
            </div>
            <div className="px-5 max-h-[52vh] overflow-y-auto divide-y divide-border/60">
              {shown.features.map((f) => <FeatureRow key={f.key} f={f} />)}
            </div>
            <div className="px-5 py-4 border-t border-border bg-secondary/30">
              <Button className="w-full" onClick={() => { closeUsage(); openUpgrade(); }}>
                <Sparkles className="w-4 h-4 mr-2" /> Upgrade for unlimited
              </Button>
              <p className="text-[11px] text-muted-foreground text-center mt-2">Monthly, yearly, or a one-time lifetime licence — your call.</p>
            </div>
          </div>
        </div>
      )}

      {upsell && (
        <div className="fixed inset-0 z-[200001] flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setUpsell(null); }}>
          <div className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="px-6 pt-6 pb-2 text-center">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-3"><Sparkles className="w-6 h-6" /></div>
              <h3 className="text-lg font-semibold text-foreground">You’ve hit a free-trial limit</h3>
              <p className="text-sm text-muted-foreground mt-1.5">{upsell.message}</p>
            </div>
            <div className="px-6 pt-3 pb-6 space-y-2">
              <Button className="w-full" onClick={() => { setUpsell(null); openUpgrade(); }}>
                <ArrowUpRight className="w-4 h-4 mr-2" /> Upgrade for unlimited
              </Button>
              <button onClick={() => { setUpsell(null); window.dispatchEvent(new CustomEvent('pdr:openTrialUsage')); }} className="w-full text-xs text-muted-foreground hover:text-foreground py-1.5 transition-colors">See all my trial limits</button>
              <button onClick={() => setUpsell(null)} className="w-full text-xs text-muted-foreground hover:text-foreground py-1 transition-colors">Maybe later</button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
