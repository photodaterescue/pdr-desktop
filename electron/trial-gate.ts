/**
 * v3.0 (Terry) — shared Free-trial cap gate, usable from BOTH main.ts and capture-manager.ts
 * (collage / carousel / capture handlers live there). Paid plans (monthly / yearly / lifetime)
 * are UNCAPPED: trialCapReached always returns false and bumpTrialUsage never accrues for them.
 * Usage is LIFETIME (increment-only) so a cap reads as "X of N used" and can't be gamed by
 * make-then-delete. Fails OPEN (treat as premium) on any license read error so a paying user is
 * never wrongly blocked.
 */
import { getLicenseStatus } from './license-manager.js';
import { getTrialUsageCount, incrementTrialUsage } from './search-database.js';

export async function isFreeAccount(): Promise<boolean> {
  try {
    const s = await getLicenseStatus();
    return !s?.canUsePremiumFeatures;
  } catch {
    return false;
  }
}

/** True only when this is a Free account AND the feature is at/over its cap. */
export async function trialCapReached(key: string, limit: number): Promise<boolean> {
  if (!(await isFreeAccount())) return false;   // paid = uncapped
  return getTrialUsageCount(key) >= limit;
}

/** Add one to a feature's lifetime usage — but only for Free accounts. */
export async function bumpTrialUsage(key: string): Promise<void> {
  try {
    if (await isFreeAccount()) incrementTrialUsage(key);
  } catch {
    /* non-fatal */
  }
}
