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

  useEffect(() => {
    const savedKey = getStoredLicenseKey();
    setStoredLicenseKeyState(savedKey);
    refresh(savedKey || undefined);
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