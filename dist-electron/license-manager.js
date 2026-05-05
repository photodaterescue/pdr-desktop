import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
// Install: npm install node-machine-id
import pkg from 'node-machine-id';
const { machineIdSync } = pkg;
// ============ CONSTANTS ============
const GRACE_PERIOD_DAYS = 7;
const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
const LEMON_SQUEEZY_API = 'https://api.lemonsqueezy.com/v1/licenses';
// ============ HELPERS ============
function getCacheFilePath() {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'license.json');
}
function hashLicenseKey(key) {
    return crypto.createHash('sha256').update(key.trim().toUpperCase()).digest('hex');
}
export function getMachineFingerprint() {
    try {
        const machineId = machineIdSync();
        return crypto.createHash('sha256').update(machineId).digest('hex').substring(0, 32);
    }
    catch (error) {
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
function detectPlanFromVariant(variantName) {
    if (!variantName)
        return null;
    const lower = variantName.toLowerCase();
    if (lower.includes('lifetime'))
        return 'lifetime';
    if (lower.includes('yearly') || lower.includes('annual'))
        return 'yearly';
    if (lower.includes('monthly'))
        return 'monthly';
    return null;
}
// ============ CACHE OPERATIONS ============
export function loadCache() {
    try {
        const cachePath = getCacheFilePath();
        if (!fs.existsSync(cachePath))
            return null;
        const data = fs.readFileSync(cachePath, 'utf-8');
        return JSON.parse(data);
    }
    catch {
        return null;
    }
}
function saveCache(cache) {
    try {
        const cachePath = getCacheFilePath();
        const dir = path.dirname(cachePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    }
    catch (error) {
        console.error('Failed to save license cache:', error);
    }
}
export function clearCache() {
    try {
        const cachePath = getCacheFilePath();
        if (fs.existsSync(cachePath)) {
            fs.unlinkSync(cachePath);
        }
    }
    catch (error) {
        console.error('Failed to clear license cache:', error);
    }
}
// ============ API CALLS ============
async function validateWithLemonSqueezy(licenseKey, instanceId) {
    // 5 s timeout via AbortController — without this, an offline launch
    // sits on the OS-level TCP timeout (~21 s) before falling back to
    // cached licence state. That makes PDR feel frozen on first paint
    // for any user without internet. 5 s is short enough to feel
    // responsive, long enough to tolerate a sluggish but reachable
    // Lemon Squeezy.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${LEMON_SQUEEZY_API}/validate`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                license_key: licenseKey,
                instance_id: instanceId,
            }),
            signal: controller.signal,
        });
        const data = await response.json();
        return { success: true, data };
    }
    catch (error) {
        // AbortError = our 5 s timeout fired (treat as offline).
        // Other network errors (DNS fail, connection refused, etc.) =
        // also offline. Either way we fall through to cached licence.
        const isTimeout = error instanceof Error && error.name === 'AbortError';
        return {
            success: false,
            offline: true,
            error: isTimeout ? 'Network timeout (5 s)' : 'Network unavailable',
        };
    }
    finally {
        clearTimeout(timeoutId);
    }
}
async function activateWithLemonSqueezy(licenseKey, instanceId, instanceName) {
    try {
        const response = await fetch(`${LEMON_SQUEEZY_API}/activate`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                license_key: licenseKey,
                instance_name: instanceName,
            }),
        });
        const data = await response.json();
        // Activation endpoint returns 'activated', not 'valid'
        const isActivated = data.activated === true;
        if (!isActivated) {
            const errorMsg = data.error || `Activation failed: ${JSON.stringify(data).substring(0, 200)}`;
            return { success: false, error: errorMsg };
        }
        // Map 'activated' to 'valid' for consistency with validate endpoint
        data.valid = true;
        return { success: true, data };
    }
    catch (error) {
        return { success: false, error: 'Network error. Please check your connection.' };
    }
}
async function deactivateWithLemonSqueezy(licenseKey, instanceId) {
    try {
        const response = await fetch(`${LEMON_SQUEEZY_API}/deactivate`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                license_key: licenseKey,
                instance_id: instanceId,
            }),
        });
        const data = await response.json();
        return { success: data.deactivated === true };
    }
    catch (error) {
        return { success: false, error: 'Network error' };
    }
}
// ============ MAIN LICENSE FUNCTIONS ============
export async function getLicenseStatus() {
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
    // If cached status is active and within grace period, allow use
    if (cache.status === 'active' && isWithinGrace) {
        return {
            isValid: true,
            status: 'active',
            plan: cache.plan,
            canUsePremiumFeatures: true,
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
export async function activateLicense(licenseKey) {
    const instanceId = getMachineFingerprint();
    const instanceName = `PDR-${process.platform}-${instanceId.substring(0, 8)}`;
    const result = await activateWithLemonSqueezy(licenseKey, instanceId, instanceName);
    if (!result.success || !result.data) {
        return { success: false, error: result.error || 'Activation failed' };
    }
    const data = result.data;
    const lsStatus = data.license_key?.status || 'inactive';
    // Map LS status to our status
    let status = 'invalid';
    let errorMessage;
    if (lsStatus === 'active') {
        status = 'active';
    }
    else if (lsStatus === 'inactive') {
        status = 'expired';
        errorMessage = 'License is inactive. Please check your subscription status.';
    }
    else if (lsStatus === 'expired') {
        status = 'expired';
        errorMessage = 'License has expired. Please renew your subscription.';
    }
    else if (lsStatus === 'disabled') {
        status = 'invalid';
        errorMessage = 'License has been disabled. Please contact support.';
    }
    else {
        errorMessage = `Unexpected license status: ${lsStatus}`;
    }
    const plan = detectPlanFromVariant(data.meta?.variant_name);
    const cache = {
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
export async function refreshLicense(licenseKey) {
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
    let status = 'invalid';
    if (data.valid && lsStatus === 'active')
        status = 'active';
    else if (lsStatus === 'inactive' || lsStatus === 'expired')
        status = 'expired';
    else if (lsStatus === 'disabled')
        status = 'invalid';
    const plan = detectPlanFromVariant(data.meta?.variant_name) || cache.plan;
    const updatedCache = {
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
export async function deactivateLicense(licenseKey) {
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
