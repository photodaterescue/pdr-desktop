import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { listBackups } from '@/lib/electron-bridge';
import { IconTooltip } from '@/components/ui/icon-tooltip';

/**
 * Tiny relative-time formatter for the snapshot status badge.
 * "Just now" / "2m ago" / "1h ago" / "Yesterday" / "3 days ago".
 * Local helper instead of pulling in a date library for one badge.
 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return 'unknown';
  const diffMs = Date.now() - then;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return 'Just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

interface SnapshotStatusBadgeProps {
  /** Optional Tailwind class string for surrounding margins. PM uses
   *  `ml-2`; the workspace toolbar may want different spacing. */
  className?: string;
  /** Small / default. Default fits PM's toolbar; small fits compact
   *  toolbars like Trees. */
  size?: 'sm' | 'default';
  /** 'default': light surface (PM body, Trees toolbar). 'dark-toolbar':
   *  white-text styling for dark ribbons (S&D's purple bar). */
  variant?: 'default' | 'dark-toolbar';
}

/**
 * Snapshot freshness badge — same component used in PM, S&D, and
 * Trees so the safety-net status is consistent everywhere users
 * make decisions about their data. Click → opens Settings on the
 * Backup tab via the existing `pdr.openSettings('backup')` channel.
 *
 * Loads on mount, refreshes the relative-time label every 60s
 * (without re-querying the backend), and re-fetches the actual
 * snapshot list every 5 minutes (catches auto-event snapshots
 * landing mid-session). Renders nothing if there's no snapshot
 * yet (fresh installs that haven't had a launch snapshot).
 */
export function SnapshotStatusBadge({ className = 'ml-2', size = 'default', variant = 'default' }: SnapshotStatusBadgeProps) {
  const [lastMtime, setLastMtime] = useState<string | null>(null);
  // Re-render every 60s so the relative-time label stays current
  // without re-querying the backend.
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      const r = await listBackups();
      if (cancelled) return;
      if (r.success && r.data && r.data.length > 0) setLastMtime(r.data[0].mtime);
      else setLastMtime(null);
    };
    fetchOnce();
    const tick = setInterval(() => setTick(t => t + 1), 60_000);
    const refetch = setInterval(fetchOnce, 5 * 60_000);
    return () => { cancelled = true; clearInterval(tick); clearInterval(refetch); };
  }, []);

  if (!lastMtime) return null;

  const sizeClasses = size === 'sm'
    ? 'px-2 py-1 text-[11px]'
    : 'px-2.5 py-1.5 text-xs';
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';

  const variantClasses = variant === 'dark-toolbar'
    // Pill-styled for the S&D dark ribbon — matches the
    // surrounding "X photos analyzed" stat pills' visual language.
    ? 'rounded-full bg-emerald-500/20 text-white/85 hover:bg-emerald-500/30 hover:text-white'
    // Default light/dark surfaces (PM body, Trees toolbar).
    : 'rounded-lg font-medium border bg-background text-muted-foreground border-border/70 hover:border-emerald-400/50 hover:text-foreground hover:bg-emerald-50/30 dark:hover:bg-emerald-900/10';

  return (
    <IconTooltip label="Click to open Settings → Backup" side="bottom">
      <button
        type="button"
        onClick={() => {
          if ((window as any).pdr?.openSettings) {
            (window as any).pdr.openSettings('backup');
          } else {
            window.opener?.postMessage({ type: 'pdr:openSettings', tab: 'backup' }, '*');
          }
        }}
        className={`${className} flex items-center gap-1.5 ${sizeClasses} transition-colors ${variantClasses}`}
      >
        <ShieldCheck className={`${iconSize} ${variant === 'dark-toolbar' ? 'text-emerald-300' : 'text-emerald-500'}`} />
        <span>Last snapshot: {formatRelativeTime(lastMtime)}</span>
      </button>
    </IconTooltip>
  );
}
