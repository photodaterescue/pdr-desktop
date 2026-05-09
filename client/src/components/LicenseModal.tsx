import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Key, CheckCircle2, AlertCircle, Loader2, ShieldCheck, Mail, Calendar, RefreshCw, Monitor } from "lucide-react";
import { Button } from '@/components/ui/custom-button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useLicense } from '@/contexts/LicenseContext';
import { RetentionModal } from './RetentionModal';
import { ManageDevicesModal } from './ManageDevicesModal';

interface LicenseModalProps {
  onClose: () => void;
}

export function LicenseModal({ onClose }: LicenseModalProps) {
  const { license, isLoading, isLicensed, activate, deactivate, refresh, storedLicenseKey } = useLicense();
  const [isRetrying, setIsRetrying] = useState(false);
  // Per-action local flags so the button text accurately reflects
  // what's actually in flight. Before this split, `isLoading` from
  // the context was shared across refresh / activate / deactivate, so
  // hitting "Retry now" made the Deactivate button read "Deactivating..."
  // even though no deactivation was happening — confusing on its own,
  // and indistinguishable from a real stuck deactivate. Tracked
  // locally because the modal is the only surface that needs the
  // distinction; the context can keep its single isLoading for cases
  // that just want a generic "something is happening" signal.
  const [isActivating, setIsActivating] = useState(false);
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [showRetention, setShowRetention] = useState(false);
  const [showManageDevices, setShowManageDevices] = useState(false);
  const [licenseKey, setLicenseKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleActivate = async () => {
    if (!licenseKey.trim()) {
      setError('Please enter a license key');
      return;
    }

    setError(null);
    setIsActivating(true);
    try {
      const result = await activate(licenseKey.trim());
      if (!result.success) {
        setError(result.error || 'Activation failed');
      }
    } finally {
      setIsActivating(false);
    }
  };

  const handleDeactivate = async () => {
    if (!storedLicenseKey) {
      setError('No license key found');
      return;
    }
    setIsDeactivating(true);
    try {
      const result = await deactivate(storedLicenseKey);
      if (!result.success) {
        setError(result.error || 'Deactivation failed');
      }
    } finally {
      setIsDeactivating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading) {
      handleActivate();
    }
  };

  const getPlanLabel = (plan: string | null): string => {
    if (!plan) return 'Photo Date Rescue';
    if (plan === 'lifetime') return 'Photo Date Rescue — Lifetime';
    if (plan === 'yearly') return 'Photo Date Rescue — Yearly';
    if (plan === 'monthly') return 'Photo Date Rescue — Monthly';
    return 'Photo Date Rescue';
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="relative bg-background rounded-2xl shadow-2xl max-w-md w-full p-6"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 hover:bg-secondary rounded-full transition-colors"
          data-testid="button-close-license"
        >
          <X className="w-5 h-5 text-muted-foreground" />
        </button>
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center mb-4 border border-primary/20 shadow-lg shadow-primary/10">
            <Key className="w-8 h-8 text-primary" />
          </div>
          <h2 className="text-xl font-semibold text-foreground">License</h2>
        </div>

        {isLicensed ? (
          <div className="space-y-6">
            {/* Grace period warning banner */}
            {license.isOfflineGrace && license.daysUntilGraceExpires !== null && (
              <div className="p-3 bg-amber-50 dark:bg-amber-950/30 rounded-xl border border-amber-200 dark:border-amber-800">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                      Offline Mode — {license.daysUntilGraceExpires} days remaining
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                      Connect to the internet to validate your license and continue using Photo Date Rescue.
                    </p>
                    <button
                      onClick={async () => {
                        setIsRetrying(true);
                        await refresh(storedLicenseKey || undefined);
                        setIsRetrying(false);
                      }}
                      disabled={isRetrying}
                      className="mt-2 flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-200 transition-colors disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
                      {isRetrying ? 'Checking...' : 'Retry now'}
                    </button>
                  </div>
                </div>
              </div>
            )}
            
            <div className="p-4 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl border border-emerald-200 dark:border-emerald-800">
              <div className="flex items-center justify-center gap-3 mb-3">
                <CheckCircle2 className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
                <span className="font-semibold text-emerald-900 dark:text-emerald-300">License Active</span>
              </div>
              
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-center gap-2 text-emerald-800 dark:text-emerald-300">
                  <ShieldCheck className="w-4 h-4" />
                  <span>{getPlanLabel(license.plan)}</span>
                </div>
                {license.customerEmail && (
                  <div className="flex items-center justify-center gap-2 text-emerald-800 dark:text-emerald-300">
                    <Mail className="w-4 h-4" />
                    <span>{license.customerEmail}</span>
                  </div>
                )}
                {license.isOfflineGrace && license.daysUntilGraceExpires !== null && (
                  <div className="flex items-center justify-center gap-2 text-amber-700 dark:text-amber-400 text-xs mt-2">
                    <Calendar className="w-3 h-3" />
                    <span>Offline mode — {license.daysUntilGraceExpires} days until verification needed</span>
                  </div>
                )}
              </div>
            </div>
            <Button
              onClick={() => setShowManageDevices(true)}
              className="w-full h-12 text-base font-medium shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all duration-300"
              data-testid="button-manage-devices"
            >
              <Monitor className="w-4 h-4 mr-2" />
              Manage Devices
            </Button>

            <div className="flex flex-col items-center gap-1 pt-1">
              {(license.plan === 'monthly' || license.plan === 'yearly') && (
                <button
                  onClick={() => setShowRetention(true)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  data-testid="button-cancel-subscription"
                >
                  Cancel subscription
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                License Key
              </label>
              <input
                type="text"
                value={licenseKey}
                onChange={(e) => {
                  setLicenseKey(e.target.value);
                  setError(null);
                }}
                onKeyDown={handleKeyDown}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                className="w-full px-4 py-3 rounded-lg border border-border bg-background text-foreground font-mono text-center tracking-wider focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                disabled={isLoading}
                data-testid="input-license-key"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 bg-rose-50 dark:bg-rose-950/30 rounded-lg border border-rose-200 dark:border-rose-800">
                <AlertCircle className="w-5 h-5 text-rose-600 dark:text-rose-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-rose-800 dark:text-rose-300">{error}</p>
              </div>
            )}

            <Button
              onClick={handleActivate}
              disabled={isActivating || !licenseKey.trim()}
              className="w-full"
              size="lg"
              data-testid="button-activate-license"
            >
              {isActivating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Activating...
                </>
              ) : (
                'Activate License'
              )}
            </Button>

            <div className="text-center space-y-2">
              <p className="text-sm text-muted-foreground">
                Don't have a license?
              </p>
              <button
                onClick={async () => {
                  const { openExternalUrl } = await import('@/lib/electron-bridge');
                  await openExternalUrl('https://photodaterescue.com/#pricing');
                }}
                className="text-sm text-primary hover:underline font-medium cursor-pointer bg-transparent border-none"
                data-testid="link-purchase-license"
              >
                Purchase Photo Date Rescue
              </button>
            </div>
          </div>
        )}
        <RetentionModal isOpen={showRetention} onClose={() => setShowRetention(false)} />
        <ManageDevicesModal isOpen={showManageDevices} onClose={() => setShowManageDevices(false)} />
      </motion.div>
    </motion.div>
  );
}

export function LicenseStatusBadge({ onClick }: { onClick?: () => void }) {
  const { license, isLoading, isLicensed } = useLicense();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary text-muted-foreground text-xs">
        <Loader2 className="w-3 h-3 animate-spin" />
        <span>Checking...</span>
      </div>
    );
  }

  if (isLicensed) {
    // Check if in offline grace period
    if (license.isOfflineGrace && license.daysUntilGraceExpires !== null) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onClick}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200/60 text-xs font-medium hover:bg-amber-100 hover:text-amber-800 cursor-pointer transition-all duration-200 hover:scale-[1.02]"
                data-testid="badge-license-grace"
              >
                <AlertCircle className="w-3 h-3" />
                <span>Offline ({license.daysUntilGraceExpires}d)</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Offline mode — {license.daysUntilGraceExpires} days to validate</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onClick}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/60 text-xs font-medium hover:bg-emerald-100 hover:text-emerald-800 cursor-pointer transition-all duration-200 hover:scale-[1.02]"
              data-testid="badge-license-active"
            >
              <CheckCircle2 className="w-3 h-3" />
              <span>Licensed</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Licensed — click to manage</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (license.status === 'expired') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onClick}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-100 text-amber-700 text-xs font-medium hover:bg-amber-200 hover:text-amber-800 cursor-pointer transition-all duration-200 hover:scale-[1.02]"
              data-testid="badge-license-expired"
            >
              <AlertCircle className="w-3 h-3" />
              <span>Expired</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>License expired — click to renew</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (license.status === 'invalid') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onClick}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-rose-100 text-rose-700 text-xs font-medium hover:bg-rose-200 hover:text-rose-800 cursor-pointer transition-all duration-200 hover:scale-[1.02]"
              data-testid="badge-license-invalid"
            >
              <AlertCircle className="w-3 h-3" />
              <span>Invalid</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>License invalid — click to re-activate</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onClick}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-rose-50 text-rose-600/80 border border-rose-200/50 text-xs font-medium hover:bg-rose-100 hover:text-rose-700 cursor-pointer transition-all duration-200 hover:scale-[1.02]"
            data-testid="badge-license-inactive"
          >
            <Key className="w-3 h-3" />
            <span>Activate</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>Not activated — click to enter license key</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
