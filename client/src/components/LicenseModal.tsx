import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Key, CheckCircle2, AlertCircle, Loader2, ShieldCheck, Mail, Clock } from 'lucide-react';
import { Button } from '@/components/ui/custom-button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useLicense } from '@/contexts/LicenseContext';
import { isTrial, getTrialDaysRemaining } from '@/lib/lemonsqueezy';

interface LicenseModalProps {
  onClose: () => void;
}

export function LicenseModal({ onClose }: LicenseModalProps) {
  const { license, isLoading, isLicensed, activate, deactivate } = useLicense();
  const [licenseKey, setLicenseKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleActivate = async () => {
    if (!licenseKey.trim()) {
      setError('Please enter a license key');
      return;
    }

    setError(null);
    const result = await activate(licenseKey.trim());
    
    if (!result.success) {
      setError(result.error || 'Activation failed');
    }
  };

  const handleDeactivate = async () => {
    const result = await deactivate();
    if (!result.success) {
      setError(result.error || 'Deactivation failed');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading) {
      handleActivate();
    }
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
        className="bg-background rounded-2xl shadow-2xl max-w-md w-full p-6"
      >
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Key className="w-5 h-5 text-primary" />
            </div>
            <h2 className="text-xl font-semibold text-foreground">License</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-secondary rounded-full transition-colors"
            data-testid="button-close-license"
          >
            <X className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>

        {isLicensed ? (
          <div className="space-y-6">
            <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-200">
              <div className="flex items-center gap-3 mb-3">
                <CheckCircle2 className="w-6 h-6 text-emerald-600" />
                <span className="font-semibold text-emerald-900">License Active</span>
              </div>
              
              <div className="space-y-2 text-sm">
                {license.productName && (
                  <div className="flex items-center gap-2 text-emerald-800">
                    <ShieldCheck className="w-4 h-4" />
                    <span>{license.productName}</span>
                  </div>
                )}
                {license.customerEmail && (
                  <div className="flex items-center gap-2 text-emerald-800">
                    <Mail className="w-4 h-4" />
                    <span>{license.customerEmail}</span>
                  </div>
                )}
                {license.expiresAt && (
                  <div className="text-emerald-700 text-xs mt-2">
                    Expires: {new Date(license.expiresAt).toLocaleDateString()}
                  </div>
                )}
              </div>
            </div>

            <div className="text-center">
              <Button
                variant="outline"
                onClick={handleDeactivate}
                disabled={isLoading}
                className="text-muted-foreground"
                data-testid="button-deactivate-license"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Deactivating...
                  </>
                ) : (
                  'Deactivate License'
                )}
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Deactivate to use on a different device
              </p>
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

            {(error || license.errorMessage) && (
              <div className="flex items-start gap-2 p-3 bg-rose-50 rounded-lg border border-rose-200">
                <AlertCircle className="w-5 h-5 text-rose-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-rose-800">{error || license.errorMessage}</p>
              </div>
            )}

            <Button
              onClick={handleActivate}
              disabled={isLoading || !licenseKey.trim()}
              className="w-full"
              size="lg"
              data-testid="button-activate-license"
            >
              {isLoading ? (
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
              <a
                href="https://photodaterescue.com/#pricing"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline font-medium"
                data-testid="link-purchase-license"
              >
                Purchase Photo Date Rescue
              </a>
            </div>
          </div>
        )}
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
    const isTrialLicense = isTrial(license);
    const daysRemaining = getTrialDaysRemaining(license);
    
    if (isTrialLicense) {
      const tooltipText = daysRemaining !== null 
        ? `Trial active — ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''} remaining`
        : 'Trial active — click to manage';
      
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onClick}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200/60 text-xs font-medium hover:bg-amber-100 hover:text-amber-800 cursor-pointer transition-all duration-200 hover:scale-[1.02]"
                data-testid="badge-license-trial"
              >
                <Clock className="w-3 h-3" />
                <span>Trial</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{tooltipText}</p>
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
            <p>Licensed — manage license</p>
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

  if (license.status === 'error') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onClick}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-100 text-amber-700 text-xs font-medium hover:bg-amber-200 hover:text-amber-800 cursor-pointer transition-all duration-200 hover:scale-[1.02]"
              data-testid="badge-license-error"
            >
              <AlertCircle className="w-3 h-3" />
              <span>Offline</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Offline — click to check status</p>
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
