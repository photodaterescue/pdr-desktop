import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import {
  getLicenseStatus,
  activateLicense as activateLicenseIPC,
  refreshLicense,
  deactivateLicense as deactivateLicenseIPC,
  LicenseStatus,
  isElectron,
} from '@/lib/electron-bridge';

interface LicenseContextType {
  license: LicenseStatus;
  isLoading: boolean;
  isLicensed: boolean;
  activate: (licenseKey: string) => Promise<{ success: boolean; error?: string }>;
  deactivate: (licenseKey: string) => Promise<{ success: boolean; error?: string }>;
  refresh: (licenseKey?: string) => Promise<void>;
  clearError: () => void;
  storedLicenseKey: string | null;
  setStoredLicenseKey: (key: string | null) => void;
}

const LicenseContext = createContext<LicenseContextType | null>(null);

const LICENSE_KEY_STORAGE = 'pdr-license-key';

function getStoredLicenseKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(LICENSE_KEY_STORAGE);
}

function setStoredLicenseKeyLocal(key: string | null): void {
  if (typeof window === 'undefined') return;
  if (key) {
    localStorage.setItem(LICENSE_KEY_STORAGE, key);
  } else {
    localStorage.removeItem(LICENSE_KEY_STORAGE);
  }
}

const defaultLicenseStatus: LicenseStatus = {
  isValid: false,
  status: 'none',
  plan: null,
  canUsePremiumFeatures: false,
  isOfflineGrace: false,
  daysUntilGraceExpires: null,
  customerEmail: null,
};

export function LicenseProvider({ children }: { children: ReactNode }) {
  const [license, setLicense] = useState<LicenseStatus>(defaultLicenseStatus);
  const [isLoading, setIsLoading] = useState(true);
  const [storedLicenseKey, setStoredLicenseKeyState] = useState<string | null>(null);

  const isLicensed = license.canUsePremiumFeatures;

  const setStoredLicenseKey = useCallback((key: string | null) => {
    setStoredLicenseKeyLocal(key);
    setStoredLicenseKeyState(key);
  }, []);

  const refresh = useCallback(async (licenseKey?: string) => {
    setIsLoading(true);
    try {
      if (!isElectron()) {
        setLicense(defaultLicenseStatus);
        return;
      }

      const keyToUse = licenseKey || storedLicenseKey;
      
      if (keyToUse) {
        const result = await refreshLicense(keyToUse);
        if (result.status) {
          setLicense(result.status);
        } else {
          const status = await getLicenseStatus();
          setLicense(status);
        }
      } else {
        const status = await getLicenseStatus();
        setLicense(status);
      }
    } catch (error) {
      console.error('Failed to refresh license:', error);
      setLicense(defaultLicenseStatus);
    } finally {
      setIsLoading(false);
    }
  }, [storedLicenseKey]);

  // Track if we've shown the grace period toast this session
  const [hasShownGraceToast, setHasShownGraceToast] = useState(false);

  // Two-stage bootstrap. Critical UX rule: NEVER show "Checking..." in
  // the title-bar badge on app launch. Even with a 5 s LS validate
  // timeout, harness/network conditions can stretch the validate to
  // multi-minute hangs (Terry hit 5+ min). The badge gating on a
  // single isLoading flag would freeze on "Checking..." for the
  // entire stretch, blocking visibility into actual licence state
  // the user already has cached.
  //
  // Stage 1 — fast cache read (getLicenseStatus): reads license.json
  // from disk via IPC, no network. Returns within milliseconds.
  // Releases isLoading immediately so the badge can render the cached
  // "Active / Offline (Xd) / Activate" state without a spinner.
  //
  // Stage 2 — background LS validate (refreshLicense): hits Lemon
  // Squeezy with the AbortController-bounded fetch. May take 5 s, may
  // take longer if the network is sluggish. Whenever it resolves, the
  // license state updates — but the badge is NOT in a loading state
  // during this time. The user sees a stable cached state that
  // *might* update silently in the background.
  //
  // The explicit `refresh()` call (used by "Retry now" in the License
  // modal) keeps its isLoading gate because that IS a user-driven
  // action where the spinner is wanted.
  useEffect(() => {
    const bootstrap = async () => {
      const savedKey = getStoredLicenseKey();
      setStoredLicenseKeyState(savedKey);

      // Stage 1: fast cache read so the badge renders without spinner.
      if (isElectron()) {
        try {
          const cached = await getLicenseStatus();
          setLicense(cached);
        } catch (e) {
          // Cache read failed; leave defaultLicenseStatus in state.
          // The badge will show "Activate License" until stage 2
          // completes (if there's any chance of a successful refresh).
          console.error('License cache read failed:', e);
        }
      }
      setIsLoading(false);

      // Stage 2: background LS validate, no isLoading gate. If this
      // takes 5 minutes (slow network), the badge has been showing the
      // cached state the whole time — fine. When it finishes, the
      // result silently updates the license state.
      if (isElectron() && savedKey) {
        try {
          const result = await refreshLicense(savedKey);
          if (result.status) {
            setLicense(result.status);
          }
        } catch (e) {
          // Validation failed — the cached state from stage 1 stays.
          console.error('Background license validation failed:', e);
        }
      }
    };
    bootstrap();
  }, []);

  // Show toast notification when in grace period
  useEffect(() => {
    if (!isLoading && license.isOfflineGrace && license.daysUntilGraceExpires !== null && !hasShownGraceToast) {
      setHasShownGraceToast(true);
      
      // Dispatch a custom event that can be caught by a toast component
      const toastEvent = new CustomEvent('pdr-toast', {
        detail: {
          type: 'warning',
          title: 'Offline Mode',
          message: `${license.daysUntilGraceExpires} days remaining to validate your license. Connect to the internet to continue using Photo Date Rescue.`,
          duration: 8000,
        }
      });
      window.dispatchEvent(toastEvent);
    }
  }, [isLoading, license.isOfflineGrace, license.daysUntilGraceExpires, hasShownGraceToast]);

  const activate = useCallback(async (licenseKey: string): Promise<{ success: boolean; error?: string }> => {
    if (!licenseKey.trim()) {
      return { success: false, error: 'Please enter a license key' };
    }

    setIsLoading(true);

    try {
      const result = await activateLicenseIPC(licenseKey);
      
      if (result.success && result.status) {
        setLicense(result.status);
        setStoredLicenseKey(licenseKey);
        return { success: true };
      } else {
        return { success: false, error: result.error || 'Activation failed' };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Network error';
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, [setStoredLicenseKey]);

  const deactivate = useCallback(async (licenseKey: string): Promise<{ success: boolean; error?: string }> => {
    if (!licenseKey) {
      return { success: false, error: 'No license key provided' };
    }

    setIsLoading(true);

    try {
      const result = await deactivateLicenseIPC(licenseKey);
      
      if (result.success) {
        setLicense(defaultLicenseStatus);
        setStoredLicenseKey(null);
        return { success: true };
      } else {
        return { success: false, error: result.error || 'Deactivation failed' };
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    } finally {
      setIsLoading(false);
    }
  }, [setStoredLicenseKey]);

  const clearError = useCallback(() => {
    // No error state to clear in this implementation
  }, []);

  return (
    <LicenseContext.Provider value={{
      license,
      isLoading,
      isLicensed,
      activate,
      deactivate,
      refresh,
      clearError,
      storedLicenseKey,
      setStoredLicenseKey,
    }}>
      {children}
    </LicenseContext.Provider>
  );
}

export function useLicense() {
  const context = useContext(LicenseContext);
  if (!context) {
    throw new Error('useLicense must be used within a LicenseProvider');
  }
  return context;
}