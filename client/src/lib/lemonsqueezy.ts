/**
 * LemonSqueezy License Validation Module
 * 
 * Handles license key validation, activation, and deactivation
 * for Photo Date Rescue desktop application.
 * 
 * API docs: https://docs.lemonsqueezy.com/api/license-api
 */

const VALIDATE_ENDPOINT = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const ACTIVATE_ENDPOINT = 'https://api.lemonsqueezy.com/v1/licenses/activate';
const DEACTIVATE_ENDPOINT = 'https://api.lemonsqueezy.com/v1/licenses/deactivate';

export interface LicenseValidationResult {
  valid: boolean;
  error: string | null;
  licenseKey: {
    id: number;
    status: 'active' | 'inactive' | 'expired' | 'disabled';
    key: string;
    activationLimit: number;
    activationUsage: number;
    createdAt: string;
    expiresAt: string | null;
  } | null;
  instance: {
    id: string;
    name: string;
    createdAt: string;
  } | null;
  meta: {
    storeId: number;
    orderId: number;
    productId: number;
    productName: string;
    variantId: number;
    variantName: string;
    customerId: number;
    customerName: string;
    customerEmail: string;
  } | null;
}

export interface LicenseActivationResult {
  activated: boolean;
  error: string | null;
  instance: {
    id: string;
    name: string;
    createdAt: string;
  } | null;
  licenseKey: LicenseValidationResult['licenseKey'];
  meta: LicenseValidationResult['meta'];
}

export interface LicenseState {
  status: 'unchecked' | 'checking' | 'valid' | 'invalid' | 'expired' | 'error';
  licenseKey: string | null;
  instanceId: string | null;
  customerEmail: string | null;
  productName: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
}

const STORAGE_KEY = 'pdr_license';
const INSTANCE_KEY = 'pdr_instance_id';

function getStoredLicense(): { licenseKey: string; instanceId: string } | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to read stored license:', e);
  }
  return null;
}

function storeLicense(licenseKey: string, instanceId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ licenseKey, instanceId }));
  } catch (e) {
    console.error('Failed to store license:', e);
  }
}

function clearStoredLicense(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error('Failed to clear stored license:', e);
  }
}

function generateInstanceName(): string {
  const userAgent = navigator.userAgent;
  const platform = navigator.platform || 'Unknown';
  const timestamp = Date.now();
  return `PDR-${platform}-${timestamp}`.substring(0, 50);
}

export async function validateLicense(licenseKey: string, instanceId?: string): Promise<LicenseValidationResult> {
  try {
    const payload: Record<string, string> = {
      license_key: licenseKey,
    };
    
    if (instanceId) {
      payload.instance_id = instanceId;
    }

    const response = await fetch(VALIDATE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    
    return {
      valid: data.valid === true,
      error: data.error || null,
      licenseKey: data.license_key ? {
        id: data.license_key.id,
        status: data.license_key.status,
        key: data.license_key.key,
        activationLimit: data.license_key.activation_limit,
        activationUsage: data.license_key.activation_usage,
        createdAt: data.license_key.created_at,
        expiresAt: data.license_key.expires_at,
      } : null,
      instance: data.instance ? {
        id: data.instance.id,
        name: data.instance.name,
        createdAt: data.instance.created_at,
      } : null,
      meta: data.meta ? {
        storeId: data.meta.store_id,
        orderId: data.meta.order_id,
        productId: data.meta.product_id,
        productName: data.meta.product_name,
        variantId: data.meta.variant_id,
        variantName: data.meta.variant_name,
        customerId: data.meta.customer_id,
        customerName: data.meta.customer_name,
        customerEmail: data.meta.customer_email,
      } : null,
    };
  } catch (error) {
    console.error('License validation failed:', error);
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Network error during validation',
      licenseKey: null,
      instance: null,
      meta: null,
    };
  }
}

export async function activateLicense(licenseKey: string): Promise<LicenseActivationResult> {
  try {
    const instanceName = generateInstanceName();
    
    const payload = {
      license_key: licenseKey,
      instance_name: instanceName,
    };

    const response = await fetch(ACTIVATE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    
    if (data.activated && data.instance) {
      storeLicense(licenseKey, data.instance.id);
    }
    
    return {
      activated: data.activated === true,
      error: data.error || null,
      instance: data.instance ? {
        id: data.instance.id,
        name: data.instance.name,
        createdAt: data.instance.created_at,
      } : null,
      licenseKey: data.license_key ? {
        id: data.license_key.id,
        status: data.license_key.status,
        key: data.license_key.key,
        activationLimit: data.license_key.activation_limit,
        activationUsage: data.license_key.activation_usage,
        createdAt: data.license_key.created_at,
        expiresAt: data.license_key.expires_at,
      } : null,
      meta: data.meta ? {
        storeId: data.meta.store_id,
        orderId: data.meta.order_id,
        productId: data.meta.product_id,
        productName: data.meta.product_name,
        variantId: data.meta.variant_id,
        variantName: data.meta.variant_name,
        customerId: data.meta.customer_id,
        customerName: data.meta.customer_name,
        customerEmail: data.meta.customer_email,
      } : null,
    };
  } catch (error) {
    console.error('License activation failed:', error);
    return {
      activated: false,
      error: error instanceof Error ? error.message : 'Network error during activation',
      instance: null,
      licenseKey: null,
      meta: null,
    };
  }
}

export async function deactivateLicense(licenseKey: string, instanceId: string): Promise<{ deactivated: boolean; error: string | null }> {
  try {
    const payload = {
      license_key: licenseKey,
      instance_id: instanceId,
    };

    const response = await fetch(DEACTIVATE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    
    if (data.deactivated) {
      clearStoredLicense();
    }
    
    return {
      deactivated: data.deactivated === true,
      error: data.error || null,
    };
  } catch (error) {
    console.error('License deactivation failed:', error);
    return {
      deactivated: false,
      error: error instanceof Error ? error.message : 'Network error during deactivation',
    };
  }
}

export async function checkStoredLicense(): Promise<LicenseState> {
  const stored = getStoredLicense();
  
  if (!stored) {
    return {
      status: 'unchecked',
      licenseKey: null,
      instanceId: null,
      customerEmail: null,
      productName: null,
      expiresAt: null,
      errorMessage: null,
    };
  }
  
  const result = await validateLicense(stored.licenseKey, stored.instanceId);
  
  if (result.valid) {
    return {
      status: result.licenseKey?.status === 'expired' ? 'expired' : 'valid',
      licenseKey: stored.licenseKey,
      instanceId: stored.instanceId,
      customerEmail: result.meta?.customerEmail || null,
      productName: result.meta?.productName || null,
      expiresAt: result.licenseKey?.expiresAt || null,
      errorMessage: null,
    };
  }
  
  // Distinguish network errors from actual invalid license responses
  const isNetworkError = result.error?.toLowerCase().includes('network') || 
                         result.error?.toLowerCase().includes('fetch') ||
                         result.error?.toLowerCase().includes('failed to');
  
  if (isNetworkError) {
    // Network error - assume license is still valid until we can verify
    return {
      status: 'error',
      licenseKey: stored.licenseKey,
      instanceId: stored.instanceId,
      customerEmail: null,
      productName: null,
      expiresAt: null,
      errorMessage: 'Unable to verify license. Check your internet connection.',
    };
  }
  
  return {
    status: 'invalid',
    licenseKey: stored.licenseKey,
    instanceId: stored.instanceId,
    customerEmail: null,
    productName: null,
    expiresAt: null,
    errorMessage: result.error,
  };
}

export function formatLicenseKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9-]/g, '').toUpperCase();
}

export function isValidLicenseKeyFormat(key: string): boolean {
  const cleaned = key.replace(/[^a-zA-Z0-9-]/g, '');
  return cleaned.length >= 8;
}
