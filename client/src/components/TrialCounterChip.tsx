import React, { useEffect, useState } from 'react';
import { Sparkles, AlertCircle, AlertTriangle } from 'lucide-react';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { useLicense } from '@/contexts/LicenseContext';
import { getUsage, type UsageResult } from '@/lib/electron-bridge';

/**
 * Free Trial file-counter chip — lives in the TitleBar's right
 * cluster next to LicenseStatusBadge. Renders nothing for paid /
 * unlicensed plans.
 *
 * Visual language matches LicenseStatusBadge:
 *   • flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium
 *   • palette tokens (`bg-X-50 text-X-700 border-X-200/60`) so the
 *     light/dark themes pick up automatically
 *   • TooltipProvider / Tooltip wrapper so hovering surfaces a
 *     full-sentence explanation of where the count comes from
 *   • Click → opens the License modal (the same target as the
 *     standard licensed / offline / activate badges) so users land
 *     somewhere familiar — Phase 2D will add the upgrade path
 *
 * State colour shifts on three thresholds so the user gets a visual
 * nudge well before they hit the cap:
 *   <70%   emerald   "lots of trial left"
 *   70-89% amber     "getting close"
 *   ≥90%   red       "almost out"
 *
 * Refresh model:
 *   - On mount + whenever the license key changes, fetch current
 *     usage from the Cloudflare-Worker counter.
 *   - Listen for `pdr:trialUsageUpdate` CustomEvents — the workspace
 *     fix-flow dispatches one after each successful Run with the
 *     new used/limit values, so the chip updates without a second
 *     network round-trip.
 *
 * No periodic polling — the only ways the count changes are:
 *   (a) the user runs a Fix in this app instance (covered by the
 *       CustomEvent above), or
 *   (b) the user reinstalls / runs PDR on another machine with the
 *       same license key (covered by the on-mount fetch).
 */
export function TrialCounterChip() {
  const { license, storedLicenseKey } = useLicense();
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null);

  const isFreeTrial = license.plan === 'free' && !!storedLicenseKey;

  useEffect(() => {
    if (!isFreeTrial || !storedLicenseKey) {
      setUsage(null);
      return;
    }

    let cancelled = false;
    void getUsage(storedLicenseKey).then((r: UsageResult) => {
      if (cancelled) return;
      if (r.success && typeof r.used === 'number' && typeof r.limit === 'number') {
        setUsage({ used: r.used, limit: r.limit });
      }
    });

    // Cross-component refresh — workspace dispatches this after
    // each successful Fix run, with the new totals from the Worker
    // increment response. Saves a duplicate network round-trip and
    // keeps the chip in lockstep with reality.
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ used: number; limit: number }>).detail;
      if (detail && typeof detail.used === 'number' && typeof detail.limit === 'number') {
        setUsage({ used: detail.used, limit: detail.limit });
      }
    };
    window.addEventListener('pdr:trialUsageUpdate', handler as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener('pdr:trialUsageUpdate', handler as EventListener);
    };
  }, [isFreeTrial, storedLicenseKey]);

  if (!isFreeTrial || !usage) return null;

  const { used, limit } = usage;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const remaining = Math.max(0, limit - used);

  // Three states drive the palette + leading icon. Identical
  // structure across them keeps width / height stable so the
  // surrounding TitleBar cluster doesn't reflow as the user fixes
  // their first / hundredth / hundred-and-ninetieth file.
  let palette = 'bg-emerald-50 text-emerald-700 border-emerald-200/60 hover:bg-emerald-100 hover:text-emerald-800';
  let icon = <Sparkles className="w-3 h-3" />;
  let tooltipText = `Free Trial — ${remaining} of ${limit} files remaining. Click to upgrade for unlimited use.`;

  if (pct >= 90) {
    palette = 'bg-red-50 text-red-700 border-red-200/60 hover:bg-red-100 hover:text-red-800';
    icon = <AlertTriangle className="w-3 h-3" />;
    tooltipText = `Free Trial — only ${remaining} files left. Upgrade now to keep going.`;
  } else if (pct >= 70) {
    palette = 'bg-amber-50 text-amber-700 border-amber-200/60 hover:bg-amber-100 hover:text-amber-800';
    icon = <AlertCircle className="w-3 h-3" />;
    tooltipText = `Free Trial — ${remaining} files left of your ${limit}-file allowance. Click to upgrade.`;
  }

  return (
    <IconTooltip label={tooltipText} side="bottom">
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('pdr:openLicenseModal'))}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium cursor-pointer transition-all duration-200 hover:scale-[1.02] ${palette}`}
        data-testid="badge-trial-counter"
      >
        {icon}
        <span className="tabular-nums">Free Trial · {used}/{limit}</span>
      </button>
    </IconTooltip>
  );
}
