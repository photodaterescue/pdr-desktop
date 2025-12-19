import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import {
  LicenseState,
  validateLicense,
  activateLicense,
  deactivateLicense,
  checkStoredLicense,
  isValidLicenseKeyFormat,
} from '@/lib/lemonsqueezy';

interface LicenseContextType {
  license: LicenseState;
  isLoading: boolean;
  isLicensed: boolean;
  activate: (licenseKey: string) => Promise<{ success: boolean; error?: string }>;
  deactivate: () => Promise<{ success: boolean; error?: string }>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

const LicenseContext = createContext<LicenseContextType | null>(null);

export function LicenseProvider({ children }: { children: ReactNode }) {
  const [license, setLicense] = useState<LicenseState>({
    status: 'unchecked',
    licenseKey: null,
    instanceId: null,
    customerEmail: null,
    productName: null,
    expiresAt: null,
    errorMessage: null,
  });
  const [isLoading, setIsLoading] = useState(true);

  const isLicensed = license.status === 'valid';

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const state = await checkStoredLicense();
      setLicense(state);
    } catch (error) {
      setLicense(prev => ({
        ...prev,
        status: 'error',
        errorMessage: 'Failed to check license status',
      }));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activate = useCallback(async (licenseKey: string): Promise<{ success: boolean; error?: string }> => {
    if (!isValidLicenseKeyFormat(licenseKey)) {
      return { success: false, error: 'Invalid license key format' };
    }

    setLicense(prev => ({ ...prev, status: 'checking', errorMessage: null }));
    setIsLoading(true);

    try {
      const result = await activateLicense(licenseKey);
      
      if (result.activated) {
        setLicense({
          status: 'valid',
          licenseKey: licenseKey,
          instanceId: result.instance?.id || null,
          customerEmail: result.meta?.customerEmail || null,
          productName: result.meta?.productName || null,
          expiresAt: result.licenseKey?.expiresAt || null,
          errorMessage: null,
        });
        return { success: true };
      } else {
        const errorMsg = result.error || 'Activation failed';
        setLicense(prev => ({
          ...prev,
          status: 'invalid',
          errorMessage: errorMsg,
        }));
        return { success: false, error: errorMsg };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Network error';
      setLicense(prev => ({
        ...prev,
        status: 'error',
        errorMessage: errorMsg,
      }));
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, []);

  const deactivate = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!license.licenseKey || !license.instanceId) {
      return { success: false, error: 'No active license' };
    }

    setIsLoading(true);

    try {
      const result = await deactivateLicense(license.licenseKey, license.instanceId);
      
      if (result.deactivated) {
        setLicense({
          status: 'unchecked',
          licenseKey: null,
          instanceId: null,
          customerEmail: null,
          productName: null,
          expiresAt: null,
          errorMessage: null,
        });
        return { success: true };
      } else {
        return { success: false, error: result.error || 'Deactivation failed' };
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    } finally {
      setIsLoading(false);
    }
  }, [license.licenseKey, license.instanceId]);

  const clearError = useCallback(() => {
    setLicense(prev => ({ ...prev, errorMessage: null }));
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
