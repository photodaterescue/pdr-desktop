import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';

// Install: npm install node-machine-id
import pkg from 'node-machine-id';
const { machineIdSync } = pkg;

// ============ TYPES ============

export interface LicenseCache {
  licenseKeyHash: string;
  instanceId: string;
  lsInstanceId?: string;  // Lemon Squeezy instance ID for API calls
  status: 'active' | 'inactive' | 'expired' | 'invalid';
  // 'free' = the v2.1.0 Free Trial variant — issued by LS at $0,
  // gates premium features OFF and is subject to the 1,000-file
  // counter enforced by the Cloudflare Worker.
  plan: 'monthly' | 'yearly' | 'lifetime' | 'free' | null;
  validatedAt: number;
  expiresAt: number | null;
  customerEmail: string | null;
}

export interface LicenseStatus {
  isValid: boolean;
  status: 'active' | 'inactive' | 'expired' | 'invalid' | 'none';
  plan: 'monthly' | 'yearly' | 'lifetime' | 'free' | null;
  canUsePremiumFeatures: boolean;
  isOfflineGrace: boolean;
  daysUntilGraceExpires: number | null;
  customerEmail: string | null;
}

interface LemonSqueezyValidateResponse {
  valid: boolean;
  error?: string;
  license_key?: {
    id: number;
    status: 'active' | 'inactive' | 'expired' | 'disabled';
    key: string;
    activation_limit: number;
    activation_usage: number;
    created_at: string;
    expires_at: string | null;
  };
  instance?: {
    id: string;
    name: string;
    created_at: string;
  };
  meta?: {
    store_id: number;
    order_id: number;
    order_item_id: number;
    variant_id: number;
    variant_name: string;
    product_id: number;
    product_name: string;
    customer_id: number;
    customer_name: string;
    customer_email: string;
  };
}

// ============ CONSTANTS ============

const GRACE_PERIOD_DAYS = 7;
const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
const LEMON_SQUEEZY_API = 'https://api.lemonsqueezy.com/v1/licenses';

// ============ HELPERS ============

function getCacheFilePath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'license.json');
}

function hashLicenseKey(key: string): string {
  return crypto.createHash('sha256').update(key.trim().toUpperCase()).digest('hex');
}

export function getMachineFingerprint(): string {
  try {
    const machineId = machineIdSync();
    return crypto.createHash('sha256').update(machineId).digest('hex').substring(0, 32);
  } catch (error) {
    // Fallback: generate a random ID and persist it
    const fallbackPath = path.join(app.getPath('userData'), '.machine-id');
    if (fs.existsSync(fallbackPath)) {
      return fs.readFileSync(fallbackPath, 'utf-8').trim();
    }
    const randomId = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(fallbackPath, randomId, 'utf-8');
    return randomId;
  }
}

function detectPlanFromVariant(variantName: string | undefined): 'monthly' | 'yearly' | 'lifetime' | 'free' | null {
  if (!variantName) return null;
  const lower = variantName.toLowerCase();
  if (lower.includes('lifetime')) return 'lifetime';
  if (lower.includes('yearly') || lower.includes('annual')) return 'yearly';
  if (lower.includes('monthly')) return 'monthly';
  // Free Trial variant on LS — name "Photo Date Rescue – Free Trial".
  // We match on "free" or "trial" so a future rename (e.g. "Free
  // tier" / "Free starter") still resolves to the same plan id and
  // doesn't silently fall through to `null` and lock the user out.
  if (lower.includes('free') || lower.includes('trial')) return 'free';
  return null;
}

// ============ CACHE OPERATIONS ============

export function loadCache(): LicenseCache | null {
  try {
    const cachePath = getCacheFilePath();
    if (!fs.existsSync(cachePath)) return null;
    const data = fs.readFileSync(cachePath, 'utf-8');
    return JSON.parse(data) as LicenseCache;
  } catch {
    return null;
  }
}

function saveCache(cache: LicenseCache): void {
  try {
    const cachePath = getCacheFilePath();
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save license cache:', error);
  }
}

export function clearCache(): void {
  try {
    const cachePath = getCacheFilePath();
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  } catch (error) {
    console.error('Failed to clear license cache:', error);
  }
}

// ============ API CALLS ============

/**
 * Run a fetch with a hard timeout — aborts the request AND the body
 * read if the server is sluggish. Returns the same Response object
 * fetch would have, but throws AbortError if the timeout fires.
 *
 * Why a helper: validate / activate / deactivate all need the same
 * behaviour. Without it a cooperative LS slowdown hangs the whole
 * IPC handler — Terry hit a 5+ minute "Checking..." stall when the
 * deactivate path (no timeout originally) sat on a stalled body
 * read. With this helper, every external LS call is bounded.
 *
 * The wrapper races fetch + body parse against a single timer so a
 * server that sends headers fast then drips the body still aborts
 * cleanly.
 */
async function lsFetchJson<T = any>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await response.json() as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function validateWithLemonSqueezy(licenseKey: string, instanceId: string): Promise<{
  success: boolean;
  data?: LemonSqueezyValidateResponse;
  error?: string;
  offline?: boolean;
}> {
  // 5 s timeout — without it, an offline launch sits on the OS-level
  // TCP timeout (~21 s) before falling back to cached licence state.
  // That makes PDR feel frozen on first paint for any user without
  // internet. 5 s is short enough to feel responsive, long enough
  // to tolerate a sluggish but reachable Lemon Squeezy.
  try {
    const data = await lsFetchJson<LemonSqueezyValidateResponse>(
      `${LEMON_SQUEEZY_API}/validate`,
      { license_key: licenseKey, instance_id: instanceId },
      5000,
    );
    return { success: true, data };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return {
      success: false,
      offline: true,
      error: isTimeout ? 'Network timeout (5 s)' : 'Network unavailable',
    };
  }
}

async function activateWithLemonSqueezy(licenseKey: string, instanceId: string, instanceName: string): Promise<{
  success: boolean;
  data?: LemonSqueezyValidateResponse;
  error?: string;
}> {
  // 8 s timeout — slightly longer than validate's 5 s because activation
  // is a one-time interactive action where the user is staring at a
  // spinner; a couple of extra seconds of patience is fine. Without
  // any timeout this would hang on a slow LS exactly like deactivate
  // did before.
  try {
    const data = await lsFetchJson<LemonSqueezyValidateResponse>(
      `${LEMON_SQUEEZY_API}/activate`,
      { license_key: licenseKey, instance_name: instanceName },
      8000,
    );
    const isActivated = (data as any).activated === true;
    if (!isActivated) {
      const errorMsg = data.error || `Activation failed: ${JSON.stringify(data).substring(0, 200)}`;
      return { success: false, error: errorMsg };
    }
    data.valid = true;
    return { success: true, data };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return {
      success: false,
      error: isTimeout
        ? 'Network timeout (8 s) — please check your connection and try again.'
        : 'Network error. Please check your connection.',
    };
  }
}

async function deactivateWithLemonSqueezy(licenseKey: string, instanceId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  // 8 s timeout — same rationale as activate. Critically: BEFORE the
  // 2.0.2 fix, deactivate had no timeout at all, so a stalled LS
  // request would leave the modal showing "Deactivating..." forever
  // (Terry hit a 5+ min hang). Always bound external calls.
  try {
    const data = await lsFetchJson<{ deactivated?: boolean }>(
      `${LEMON_SQUEEZY_API}/deactivate`,
      { license_key: licenseKey, instance_id: instanceId },
      8000,
    );
    return { success: data.deactivated === true };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return {
      success: false,
      error: isTimeout
        ? 'Network timeout (8 s) — please check your connection and try again.'
        : 'Network error',
    };
  }
}

// ============ MAIN LICENSE FUNCTIONS ============

export async function getLicenseStatus(): Promise<LicenseStatus> {
  const cache = loadCache();
  const instanceId = getMachineFingerprint();

  // No cache = no license
  if (!cache) {
    return {
      isValid: false,
      status: 'none',
      plan: null,
      canUsePremiumFeatures: false,
      isOfflineGrace: false,
      daysUntilGraceExpires: null,
      customerEmail: null,
    };
  }

  // Check if instance matches
  if (cache.instanceId !== instanceId) {
    return {
      isValid: false,
      status: 'invalid',
      plan: null,
      canUsePremiumFeatures: false,
      isOfflineGrace: false,
      daysUntilGraceExpires: null,
      customerEmail: null,
    };
  }

  // Try online validation
  // We need the original key for API calls - but we only store the hash
  // For refresh, we'll rely on the cached status and grace period
  // Real validation requires the user to re-enter key or we store encrypted key

  const now = Date.now();
  const timeSinceValidation = now - cache.validatedAt;
  const isWithinGrace = timeSinceValidation < GRACE_PERIOD_MS;
  const daysUntilGraceExpires = isWithinGrace 
    ? Math.ceil((GRACE_PERIOD_MS - timeSinceValidation) / (24 * 60 * 60 * 1000))
    : 0;

  // Lifetime licenses never expire - bypass grace period check
  if (cache.status === 'active' && cache.plan === 'lifetime') {
    return {
      isValid: true,
      status: 'active',
      plan: cache.plan,
      canUsePremiumFeatures: true,
      isOfflineGrace: false,
      daysUntilGraceExpires: null,
      customerEmail: cache.customerEmail,
    };
  }

  // If cached status is active and within grace period, allow use.
  // Free Trial licenses are valid (the user signed up, has a real LS
  // license key) but DON'T unlock premium features — Trees, Date
  // Editor, Photo Format conversion stay gated. The 1,000-file cap
  // they're subject to is enforced separately by the Worker counter.
  if (cache.status === 'active' && isWithinGrace) {
    return {
      isValid: true,
      status: 'active',
      plan: cache.plan,
      canUsePremiumFeatures: cache.plan !== 'free',
      isOfflineGrace: timeSinceValidation > 60000, // More than 1 minute since validation = likely offline
      daysUntilGraceExpires: daysUntilGraceExpires,
      customerEmail: cache.customerEmail,
    };
  }

  // Grace period expired or status not active
  if (cache.status === 'active' && !isWithinGrace) {
    return {
      isValid: false,
      status: 'expired',
      plan: cache.plan,
      canUsePremiumFeatures: false,
      isOfflineGrace: false,
      daysUntilGraceExpires: null,
      customerEmail: cache.customerEmail,
    };
  }

  // Inactive/expired/invalid status
  return {
    isValid: false,
    status: cache.status,
    plan: cache.plan,
    canUsePremiumFeatures: false,
    isOfflineGrace: false,
    daysUntilGraceExpires: null,
    customerEmail: cache.customerEmail,
  };
}

export async function activateLicense(licenseKey: string): Promise<{
  success: boolean;
  error?: string;
  status?: LicenseStatus;
}> {
  const instanceId = getMachineFingerprint();
  const instanceName = `PDR-${process.platform}-${instanceId.substring(0, 8)}`;

  const result = await activateWithLemonSqueezy(licenseKey, instanceId, instanceName);

  if (!result.success || !result.data) {
    return { success: false, error: result.error || 'Activation failed' };
  }

  const data = result.data;
  const lsStatus = data.license_key?.status || 'inactive';
  
  // Map LS status to our status
  let status: LicenseCache['status'] = 'invalid';
  let errorMessage: string | undefined;
  
  if (lsStatus === 'active') {
    status = 'active';
  } else if (lsStatus === 'inactive') {
    status = 'expired';
    errorMessage = 'License is inactive. Please check your subscription status.';
  } else if (lsStatus === 'expired') {
    status = 'expired';
    errorMessage = 'License has expired. Please renew your subscription.';
  } else if (lsStatus === 'disabled') {
    status = 'invalid';
    errorMessage = 'License has been disabled. Please contact support.';
  } else {
    errorMessage = `Unexpected license status: ${lsStatus}`;
  }

  const plan = detectPlanFromVariant(data.meta?.variant_name);

  const cache: LicenseCache = {
    licenseKeyHash: hashLicenseKey(licenseKey),
    instanceId: instanceId,
    lsInstanceId: data.instance?.id,
    status,
    plan,
    validatedAt: Date.now(),
    expiresAt: data.license_key?.expires_at ? new Date(data.license_key.expires_at).getTime() : null,
    customerEmail: data.meta?.customer_email || null,
  };

  saveCache(cache);

  const licenseStatus = await getLicenseStatus();
  if (status !== 'active') {
    return { success: false, error: errorMessage, status: licenseStatus };
  }
  return { success: true, status: licenseStatus };
}

export async function refreshLicense(licenseKey: string): Promise<{
  success: boolean;
  error?: string;
  status?: LicenseStatus;
}> {
  const cache = loadCache();
  if (!cache) {
    return { success: false, error: 'No license to refresh' };
  }

  const instanceId = cache.lsInstanceId || cache.instanceId;
  const result = await validateWithLemonSqueezy(licenseKey, instanceId);

  if (result.offline) {
    // Offline - return current cached status
    const status = await getLicenseStatus();
    return { success: status.canUsePremiumFeatures, status };
  }

  if (!result.success || !result.data) {
    return { success: false, error: result.error || 'Validation failed' };
  }

  const data = result.data;
  const lsStatus = data.license_key?.status || 'inactive';

  let status: LicenseCache['status'] = 'invalid';
  if (data.valid && lsStatus === 'active') status = 'active';
  else if (lsStatus === 'inactive' || lsStatus === 'expired') status = 'expired';
  else if (lsStatus === 'disabled') status = 'invalid';

  const plan = detectPlanFromVariant(data.meta?.variant_name) || cache.plan;

  const updatedCache: LicenseCache = {
    ...cache,
    status,
    plan,
    validatedAt: Date.now(),
    expiresAt: data.license_key?.expires_at ? new Date(data.license_key.expires_at).getTime() : null,
    customerEmail: data.meta?.customer_email || cache.customerEmail,
  };

  saveCache(updatedCache);

  const licenseStatus = await getLicenseStatus();
  return { success: status === 'active', status: licenseStatus };
}

export async function deactivateLicense(licenseKey: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const cache = loadCache();
  if (!cache) {
    return { success: true }; // Nothing to deactivate
  }

  // Use lsInstanceId for the API call (the Lemon Squeezy instance UUID)
  const instanceId = cache.lsInstanceId || cache.instanceId;
  const result = await deactivateWithLemonSqueezy(licenseKey, instanceId);
  
  // Clear local cache regardless of API result
  clearCache();

  return result;
}