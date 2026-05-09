/**
 * Photo Date Rescue — auto-update edge proxy + Free Trial counter.
 *
 * Cloudflare Worker at https://updates.photodaterescue.com that does
 * two things:
 *
 *   1. Static-file proxy in front of the private `pdr-updates` R2
 *      bucket. Serves the auto-update manifest + NSIS installers +
 *      blockmaps to electron-updater clients running inside the
 *      packaged PDR app.
 *
 *   2. JSON API for the v2.1.0 Free Trial file-cap counter. Persists a
 *      per-license-key counter in KV so reinstalls / machine-
 *      fingerprint changes can't reset the trial. Endpoints:
 *        POST /api/usage/get        -> read current files-used
 *        POST /api/usage/increment  -> atomically add to files-used
 *
 * The R2 bucket itself is private (no public R2.dev domain). All
 * reads must come through this Worker so we control:
 *   - which file types are exposed
 *   - cache-control headers per asset class
 *   - request method whitelisting
 *   - logging/observability via Cloudflare Workers analytics
 *
 * What gets served (static files)
 *   /                              -> health check (200, plain text)
 *   /latest.yml                    -> electron-updater manifest
 *   /Photo Date Rescue Setup X.exe -> NSIS installer
 *   /Photo Date Rescue Setup X.exe.blockmap
 *                                  -> differential update metadata
 *
 * Anything else returns 404.
 */

export interface Env {
  // R2 bucket binding — declared in wrangler.toml. The Worker reads
  // objects from this bucket; the bucket itself stays private.
  BUCKET: R2Bucket;
  // KV namespace for the Free Trial file counter. Each license key
  // gets one record at `usage:<sha256(key)>` storing JSON of the form
  // `{ used: number }`. Created via `wrangler kv namespace create
  // USAGE_KV`; ids pasted into wrangler.toml.
  USAGE_KV: KVNamespace;
  // Lemon Squeezy admin API key — set via `wrangler secret put LS_API_KEY`.
  // Used by the retention/cancel endpoints to apply discounts and cancel
  // subscriptions on a customer's behalf. Never sent to the renderer.
  LS_API_KEY?: string;
}

type GetOrHead = 'GET' | 'HEAD';

// File-type whitelist. Limits the surface area so the bucket can't be
// accidentally used as a generic CDN if other artifacts land in it.
// .yml = electron-updater's latest.yml manifest
// .exe = NSIS installer
// .blockmap = differential update metadata (electron-updater)
// .sha512 = checksum file (some publish flows write these)
const ALLOWED_PATH = /\.(yml|exe|exe\.blockmap|blockmap|sha512)$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ─────────────────────────────────────────────────────────────
    // JSON API routes — Free Trial file counter
    //
    // Lives under /api/* and accepts POST only. Routed BEFORE the
    // GET/HEAD method check below so the static-file path doesn't
    // 405 a legitimate POST. Each handler reads + writes a single KV
    // record so callers don't need to care about storage shape.
    // ─────────────────────────────────────────────────────────────
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    const method = request.method.toUpperCase() as GetOrHead;
    if (method !== 'GET' && method !== 'HEAD') {
      return text(`Method ${request.method} not allowed`, 405, {
        Allow: 'GET, HEAD',
      });
    }

    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));

    // Root health-check. Useful for "is the Worker deployed?" pings
    // and for the wrangler tail output during smoke testing.
    if (!key) {
      return text('Photo Date Rescue update server', 200);
    }

    // Reject anything outside the whitelist before we touch R2.
    // Saves a Class B operation on garbage paths.
    if (!ALLOWED_PATH.test(key)) {
      return text('Not found', 404);
    }

    // Range-request support. electron-updater uses this for download
    // resume on flaky connections — without it, a dropped connection
    // restarts the whole installer download from byte zero.
    const rangeHeader = request.headers.get('range');
    const r2Options: R2GetOptions = {};
    if (rangeHeader) {
      const parsed = parseRange(rangeHeader);
      if (parsed) {
        r2Options.range = parsed;
      }
    }

    if (method === 'HEAD') {
      const head = await env.BUCKET.head(key);
      if (!head) return text('Not found', 404);
      return new Response(null, {
        status: 200,
        headers: buildHeaders(head, key),
      });
    }

    const object = await env.BUCKET.get(key, r2Options);
    if (!object) return text('Not found', 404);

    const headers = buildHeaders(object, key);

    // Range responses get 206 Partial Content + a Content-Range
    // header. R2 has already sliced the body to the requested range.
    if (r2Options.range) {
      const range = r2Options.range as { offset?: number; length?: number; suffix?: number };
      const offset = range.offset ?? 0;
      const length = range.length ?? object.size - offset;
      const end = offset + length - 1;
      headers.set('content-range', `bytes ${offset}-${end}/${object.size}`);
      headers.set('content-length', String(length));
      return new Response(object.body, { status: 206, headers });
    }

    return new Response(object.body, { status: 200, headers });
  },

  // Daily cron handler — runs at the schedule defined in wrangler.toml.
  // Used by the retention flow to revert monthly-discount customers back
  // to the regular Monthly variant after their 90-day discount expires.
  // Runs entirely server-side; the renderer never has to reason about
  // expiry timing.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runRetentionRevertCron(env));
  },
};

function buildHeaders(object: R2Object, key: string): Headers {
  const headers = new Headers();
  // Pull in the object's stored Content-Type, Content-Disposition,
  // etc. that electron-builder set on upload.
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);

  // Cache policy:
  //   latest.yml — short cache so newly published releases reach
  //                clients within a minute. The 4-h client-side
  //                check cadence is the bigger throttle anyway.
  //   *.exe / *.blockmap — immutable for a year. Each release has a
  //                a unique version-stamped filename, so once
  //                published it never changes.
  if (key.toLowerCase().endsWith('.yml')) {
    headers.set('cache-control', 'public, max-age=60, s-maxage=60, must-revalidate');
  } else {
    headers.set('cache-control', 'public, max-age=31536000, immutable');
  }

  // Belt-and-braces content type for the NSIS installer if R2 didn't
  // record one (some upload paths skip it). electron-updater doesn't
  // strictly require this but Edge browsers occasionally do.
  if (!headers.get('content-type')) {
    if (key.toLowerCase().endsWith('.exe')) {
      headers.set('content-type', 'application/vnd.microsoft.portable-executable');
    } else if (key.toLowerCase().endsWith('.yml')) {
      headers.set('content-type', 'text/yaml; charset=utf-8');
    } else {
      headers.set('content-type', 'application/octet-stream');
    }
  }

  return headers;
}

/**
 * Parse a Range request header into the R2 options shape. Returns
 * undefined if the header is malformed or specifies multi-part
 * ranges (which we don't bother supporting — electron-updater only
 * issues simple single-range requests).
 */
function parseRange(
  header: string,
): { offset?: number; length?: number; suffix?: number } | undefined {
  // Format: "bytes=START-END" or "bytes=START-" or "bytes=-SUFFIX"
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const startStr = match[1];
  const endStr = match[2];
  if (startStr === '' && endStr !== '') {
    // Suffix range: last N bytes
    return { suffix: parseInt(endStr, 10) };
  }
  if (startStr !== '' && endStr === '') {
    // Open-ended: from offset to end of file
    return { offset: parseInt(startStr, 10) };
  }
  if (startStr !== '' && endStr !== '') {
    const offset = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    return { offset, length: end - offset + 1 };
  }
  return undefined;
}

function text(body: string, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(body + '\n', {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...(extraHeaders ?? {}),
    },
  });
}

// ──────────────────────────────────────────────────────────────────
// Free Trial file counter API
//
// All routes are POST-only with a JSON body. The counter is keyed by
// the SHA-256 of the license key so we never persist the raw key.
// Storage shape is intentionally minimal: `{ used: number }`. Adding
// fields later is non-breaking because reads default missing fields
// to zero / null.
// ──────────────────────────────────────────────────────────────────

interface UsageRecord {
  used: number;
}

const CORS_HEADERS: Record<string, string> = {
  // The PDR app is an Electron renderer that ships no Origin header
  // for IPC-initiated fetches, but explicit CORS headers cost
  // nothing and make wrangler dev / curl debugging painless.
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') {
    // Pre-flight — return the CORS headers and call it done. No body.
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return jsonError('Method not allowed — use POST', 405, { Allow: 'POST' });
  }

  // Parse JSON body once. Empty / malformed bodies short-circuit so
  // the route handlers below can assume a valid object.
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  switch (url.pathname) {
    case '/api/usage/get':
      return apiUsageGet(body, env);
    case '/api/usage/increment':
      return apiUsageIncrement(body, env);
    case '/api/license/list-instances':
      return apiLicenseListInstances(body, env);
    case '/api/license/deactivate-instance':
      return apiLicenseDeactivateInstance(body, env);
    case '/api/license/retention-status':
      return apiLicenseRetentionStatus(body, env);
    case '/api/license/apply-retention':
      return apiLicenseApplyRetention(body, env);
    case '/api/license/lifetime-upsell-checkout':
      return apiLicenseLifetimeUpsellCheckout(body, env);
    case '/api/license/cancel-subscription':
      return apiLicenseCancelSubscription(body, env);
    case '/api/license/resume-subscription':
      return apiLicenseResumeSubscription(body, env);
    default:
      return jsonError('Not found', 404);
  }
}

/**
 * GET — read the current files-used count for a license key. Returns
 * `{ used: 0 }` if the KV record doesn't exist yet (first-launch
 * before a single Fix has run).
 */
async function apiUsageGet(body: any, env: Env): Promise<Response> {
  const key: string | undefined = body?.key;
  if (typeof key !== 'string' || key.trim().length < 8) {
    return jsonError('Missing or invalid `key`', 400);
  }
  const kvKey = await usageKvKey(key);
  const raw = await env.USAGE_KV.get(kvKey);
  const used = parseUsedFrom(raw);
  return json({ used });
}

/**
 * INCREMENT — atomically add `count` to the stored files-used. If no
 * record exists yet, writes `{ used: count }`. Returns the new total.
 *
 * KV is last-write-wins, not transactional, so two concurrent
 * increments on the same license key can race and lose one increment
 * (read 50, read 50, write 51, write 51 -> 51 instead of 52). For
 * the Free Trial use case (one user, a few concurrent file fixes,
 * ceiling at 1,000) the worst-case impact is a user occasionally
 * fixing one extra file beyond their cap — strictly user-favourable,
 * so KISS over the complexity of moving to D1 / Durable Objects.
 */
async function apiUsageIncrement(body: any, env: Env): Promise<Response> {
  const key: string | undefined = body?.key;
  const count: number | undefined = body?.count;
  if (typeof key !== 'string' || key.trim().length < 8) {
    return jsonError('Missing or invalid `key`', 400);
  }
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 1 || count > 10000) {
    // Upper bound is a sanity cap — a single Fix run will never add
    // more than a few thousand files. Rejecting silly counts keeps a
    // bug or tampered client from spiking the counter past the
    // limit in one call.
    return jsonError('`count` must be a positive integer up to 10000', 400);
  }

  const kvKey = await usageKvKey(key);
  const existing = parseUsedFrom(await env.USAGE_KV.get(kvKey));
  const next: UsageRecord = { used: existing + count };
  await env.USAGE_KV.put(kvKey, JSON.stringify(next));
  return json({ used: next.used });
}

/**
 * Map a raw license key to its KV record key. We hash so the raw
 * key never appears in storage or in error logs — if a KV dump
 * leaked, an attacker would still need to brute-force the hash to
 * recover the license keys. SHA-256 is overkill for the threat
 * model but it's free in WorkerCrypto.
 */
async function usageKvKey(licenseKey: string): Promise<string> {
  const data = new TextEncoder().encode(licenseKey.trim().toUpperCase());
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `usage:${hex}`;
}

/**
 * Parse a stored `{ used }` JSON blob. Treats every failure mode
 * (null, malformed, missing field, non-number) as "0 used" so a
 * corrupted record doesn't permanently lock the user out of the
 * trial — they get a clean restart from zero.
 */
function parseUsedFrom(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    const used = parsed?.used;
    return typeof used === 'number' && Number.isFinite(used) && used >= 0 ? used : 0;
  } catch {
    return 0;
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function jsonError(message: string, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
      ...(extra ?? {}),
    },
  });
}

// ───────────────────────────────────────────────────────────────────────
// Retention / cancellation API — proxies LS admin operations on behalf
// of the desktop client. The LS_API_KEY secret never reaches the
// renderer; all admin calls live here.
//
// Until LS_API_KEY is set via `wrangler secret put LS_API_KEY`, these
// endpoints stub the actual LS calls and return realistic mocked
// responses. The renderer behaves identically — only the server-side
// effect changes when real keys are wired.
// ───────────────────────────────────────────────────────────────────────

const RETENTION_KV_PREFIX = 'retention:';

// LS variant + discount constants. The variant IDs are numeric LS IDs
// (NOT the checkout-buy UUID slug) — copy them from each variant's ⋯
// menu in the LS dashboard. The two retention variants are hidden in
// the Share Product panel so the public store can't buy direct at the
// retention price; they're only reachable via subscription PATCH.
//
// Discount codes are store-scoped, generated in the LS dashboard with
// explicit "PDR retention (M/Y/L)" naming so they can't be conflated.
// LIFETIME's discount code is the only one used at fresh-checkout time
// (the upsell flow); the M/Y codes exist for any future direct-checkout
// scenarios but aren't used by the in-app retention path, which uses
// variant-switching instead.
const LS_VARIANT_LIFETIME = '1112466';
const LS_VARIANT_MONTHLY_RETENTION = '1625831'; // $9/mo (50% off Monthly $19)
const LS_VARIANT_YEARLY_RETENTION = '1632365';  // $54/yr ($25 off Yearly $79)
const LS_DISCOUNT_CODE_MONTHLY = 'E5MTU1OQ';
const LS_DISCOUNT_CODE_YEARLY = 'KZNJC4OQ';
const LS_DISCOUNT_CODE_LIFETIME = 'A1OTA1MA';

async function retentionKvKey(licenseKey: string): Promise<string> {
  const data = new TextEncoder().encode(licenseKey.trim().toUpperCase());
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return RETENTION_KV_PREFIX + hex;
}

/**
 * Apply a retention action to the user's current LS subscription by
 * PATCHing the subscription to a different variant. Two supported actions:
 *
 *   monthly-discount  — Switch from regular Monthly ($19) to Monthly
 *                       Retention ($9) for 3 months, then auto-revert
 *                       via the scheduled cron handler. Customer's
 *                       card on file carries over; no re-checkout.
 *
 *   switch-to-yearly  — Switch from Monthly OR Yearly-full to Yearly
 *                       Retention ($54/yr forever). Card carries over;
 *                       no auto-revert (the discount is permanent).
 *
 * Body: { key: string; action: 'monthly-discount' | 'switch-to-yearly' }
 * Returns: { ok: true; alreadyUsed: boolean }
 *
 * `alreadyUsed: true` means the customer already used their monthly
 * retention discount; the renderer should redirect to the lifetime
 * upsell flow rather than offering the same monthly discount twice.
 */
async function apiLicenseApplyRetention(body: any, env: Env): Promise<Response> {
  const key: string | undefined = body?.key;
  const action: string | undefined = body?.action;
  if (typeof key !== 'string' || key.trim().length < 8) {
    return jsonError('Missing or invalid `key`', 400);
  }
  if (action !== 'monthly-discount' && action !== 'switch-to-yearly') {
    return jsonError('`action` must be `monthly-discount` or `switch-to-yearly`', 400);
  }

  if (!env.LS_API_KEY) {
    return jsonError('LS_API_KEY not configured', 500);
  }

  // Block double-dipping on the monthly retention discount. Checking
  // here AND filtering server-side keeps the renderer from accidentally
  // re-offering the same 50%×3-month deal if its state gets out of sync.
  if (action === 'monthly-discount') {
    const kvKey = await retentionKvKey(key);
    if (await env.USAGE_KV.get(kvKey)) {
      return json({ ok: true, alreadyUsed: true });
    }
  }

  const validate = await lsValidateLicense(key);
  if (!validate.ok || !validate.orderId) {
    return jsonError(validate.error ?? 'License validation failed', 502);
  }
  const subId = await lsFindSubscription(validate.orderId, env);
  if (!subId) {
    return jsonError('No active subscription found for this license', 404);
  }

  const targetVariantId =
    action === 'monthly-discount'
      ? LS_VARIANT_MONTHLY_RETENTION
      : LS_VARIANT_YEARLY_RETENTION;

  // `cancelled: false` is included so the same flow works when the
  // customer is currently cancelled — accepting an offer reactivates
  // the subscription AND switches the variant in a single PATCH.
  const patch = await lsPatchSubscription(
    subId,
    {
      variant_id: Number(targetVariantId),
      disable_prorations: true,
      invoice_immediately: false,
      cancelled: false,
    },
    env,
  );
  if (!patch.ok) {
    return jsonError(patch.error ?? 'Could not switch subscription variant', 502);
  }

  // Write retention KV record. For monthly-discount, include the
  // expiry timestamp + original variant ID so the daily cron can
  // PATCH them back to their original variant after 90 days. For
  // switch-to-yearly there's no expiry — the discount is permanent.
  const kvKey = await retentionKvKey(key);
  const record: Record<string, unknown> = {
    usedAt: Date.now(),
    action,
    subscriptionId: subId,
    customerEmail: validate.customerEmail,
  };
  if (action === 'monthly-discount') {
    record.originalVariantId = String(validate.variantId ?? '');
    record.expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000; // +90 days
  }
  await env.USAGE_KV.put(kvKey, JSON.stringify(record));

  return json({ ok: true, alreadyUsed: false });
}

/**
 * Returns the customer's current plan tier, retention history, and
 * subscription cancellation state so the RetentionModal can show the
 * right UI without baking those rules into the renderer. Plan tiers
 * and the cancelled-detection live server-side so the mapping is in
 * one place.
 *
 * Body: { key: string }
 * Returns: {
 *   currentPlan: 'monthly-full' | 'monthly-retention' | 'yearly-full' |
 *                'yearly-retention' | 'lifetime' | 'trial' | 'unknown',
 *   hasUsedRetention: boolean,
 *   isCancelled: boolean,            // true if sub is cancelled-but-not-expired
 *   cancelExpiresAt: string | null,  // ISO timestamp; only meaningful if isCancelled
 * }
 */
async function apiLicenseRetentionStatus(body: any, env: Env): Promise<Response> {
  const key: string | undefined = body?.key;
  if (typeof key !== 'string' || key.trim().length < 8) {
    return jsonError('Missing or invalid `key`', 400);
  }

  if (!env.LS_API_KEY) {
    return json({
      currentPlan: 'unknown',
      hasUsedRetention: false,
      isCancelled: false,
      cancelExpiresAt: null,
    });
  }

  try {
    const validate = await lsValidateLicense(key);
    if (!validate.ok) {
      return jsonError(validate.error ?? 'License validation failed', 502);
    }

    const variantId = String(validate.variantId ?? '');
    let currentPlan: string;
    let subscription: any = null;

    // Direct variant-ID matches first — fastest path. We still fetch
    // the subscription afterwards if we need cancelled-state, since
    // that lives only on the subscription resource, not on the
    // license validate response.
    if (variantId === LS_VARIANT_MONTHLY_RETENTION) {
      currentPlan = 'monthly-retention';
    } else if (variantId === LS_VARIANT_YEARLY_RETENTION) {
      currentPlan = 'yearly-retention';
    } else if (variantId === LS_VARIANT_LIFETIME) {
      currentPlan = 'lifetime';
    } else {
      // Otherwise inspect the subscription's variant_name to figure out
      // whether they're on the regular Monthly or Yearly variant.
      const subId = validate.orderId
        ? await lsFindSubscription(validate.orderId, env)
        : null;
      if (!subId) {
        currentPlan = 'unknown';
      } else {
        const subRes = await lsGetSubscription(subId, env);
        subscription = subRes.data;
        const variantName = String(subscription?.attributes?.variant_name ?? '').toLowerCase();
        if (variantName.includes('yearly')) {
          currentPlan = 'yearly-full';
        } else if (variantName.includes('monthly')) {
          currentPlan = 'monthly-full';
        } else if (variantName.includes('trial')) {
          currentPlan = 'trial';
        } else {
          currentPlan = 'unknown';
        }
      }
    }

    // For the variant-ID-matched cases we haven't fetched the sub yet;
    // do it now so we can read cancelled state. Lifetime customers
    // have no subscription so skip that case.
    if (!subscription && currentPlan !== 'lifetime' && currentPlan !== 'unknown' && validate.orderId) {
      const subId = await lsFindSubscription(validate.orderId, env);
      if (subId) {
        const subRes = await lsGetSubscription(subId, env);
        subscription = subRes.data;
      }
    }

    const isCancelled = !!subscription?.attributes?.cancelled;
    const cancelExpiresAt = isCancelled
      ? (subscription?.attributes?.ends_at ?? null)
      : null;

    const kvKey = await retentionKvKey(key);
    const hasUsedRetention = !!(await env.USAGE_KV.get(kvKey));

    return json({ currentPlan, hasUsedRetention, isCancelled, cancelExpiresAt });
  } catch (e: any) {
    return jsonError(`retention-status failed: ${e?.message ?? 'unknown'}`, 502);
  }
}

/**
 * Resume a cancelled-but-not-yet-expired subscription. LS supports this
 * via PATCH /v1/subscriptions/{id} with `cancelled: false` — billing
 * picks up at the next renewal date, no re-checkout, card on file
 * carries over. Only works while the subscription is still active
 * (i.e. before `ends_at`); after expiry the customer needs a fresh
 * checkout.
 *
 * Body: { key: string }
 * Returns: { ok: true }
 */
async function apiLicenseResumeSubscription(body: any, env: Env): Promise<Response> {
  const key: string | undefined = body?.key;
  if (typeof key !== 'string' || key.trim().length < 8) {
    return jsonError('Missing or invalid `key`', 400);
  }

  if (!env.LS_API_KEY) {
    return json({ ok: true });
  }

  try {
    const validate = await lsValidateLicense(key);
    if (!validate.ok || !validate.orderId) {
      return jsonError(validate.error ?? 'License validation failed', 502);
    }

    const subId = await lsFindSubscription(validate.orderId, env);
    if (!subId) {
      return jsonError('No subscription found for this license', 404);
    }

    const patchBody = {
      data: {
        type: 'subscriptions',
        id: subId,
        attributes: { cancelled: false },
      },
    };

    const res = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${subId}`, {
      method: 'PATCH',
      headers: {
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${env.LS_API_KEY}`,
      },
      body: JSON.stringify(patchBody),
    });
    if (!res.ok) {
      const errText = await res.text();
      return jsonError(`LS resume error: ${errText.slice(0, 200)}`, 502);
    }
    return json({ ok: true });
  } catch (e: any) {
    return jsonError(`LS resume failed: ${e?.message ?? 'unknown error'}`, 502);
  }
}

/**
 * Generate a one-time LS checkout URL for the lifetime variant with a
 * 30% discount applied. Used after a monthly customer cancels twice —
 * convert them into a lifetime customer at $139.
 *
 * Body: { key: string }
 * Returns: { ok: true; checkoutUrl: string }
 */
async function apiLicenseLifetimeUpsellCheckout(body: any, env: Env): Promise<Response> {
  const key: string | undefined = body?.key;
  if (typeof key !== 'string' || key.trim().length < 8) {
    return jsonError('Missing or invalid `key`', 400);
  }

  if (!env.LS_API_KEY) {
    // Fallback if the secret isn't provisioned — send to the public
    // pricing page so the user at least sees how to upgrade.
    return json({ ok: true, checkoutUrl: 'https://photodaterescue.com/#pricing' });
  }

  try {
    const validate = await lsValidateLicense(key);
    if (!validate.ok || !validate.storeId) {
      return jsonError(validate.error ?? 'License validation failed', 502);
    }

    // POST /v1/checkouts creates a hosted checkout link with the
    // lifetime variant + discount + customer email pre-applied. The
    // returned URL is single-use scoped to that variant; the user
    // lands on a page that already knows the price ($199 - $60 = $139)
    // and only asks for card details.
    const checkoutBody = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            email: validate.customerEmail ?? '',
            discount_code: LS_DISCOUNT_CODE_LIFETIME,
          },
        },
        relationships: {
          store: { data: { type: 'stores', id: String(validate.storeId) } },
          variant: { data: { type: 'variants', id: LS_VARIANT_LIFETIME } },
        },
      },
    };

    const res = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${env.LS_API_KEY}`,
      },
      body: JSON.stringify(checkoutBody),
    });
    if (!res.ok) {
      const errText = await res.text();
      return jsonError(`LS checkout error: ${errText.slice(0, 200)}`, 502);
    }
    const data: any = await res.json();
    const url = data?.data?.attributes?.url;
    if (typeof url !== 'string') {
      return jsonError('LS checkout did not return URL', 502);
    }
    return json({ ok: true, checkoutUrl: url });
  } catch (e: any) {
    return jsonError(`LS checkout failed: ${e?.message ?? 'unknown error'}`, 502);
  }
}

/**
 * Cancel the user's subscription on LS. The user retains access until
 * the end of their current billing period; LS handles the timing.
 *
 * Body: { key: string }
 * Returns: { ok: true }
 */
async function apiLicenseCancelSubscription(body: any, env: Env): Promise<Response> {
  const key: string | undefined = body?.key;
  if (typeof key !== 'string' || key.trim().length < 8) {
    return jsonError('Missing or invalid `key`', 400);
  }

  if (!env.LS_API_KEY) {
    return json({ ok: true });
  }

  try {
    const validate = await lsValidateLicense(key);
    if (!validate.ok || !validate.orderId) {
      return jsonError(validate.error ?? 'License validation failed', 502);
    }

    const subId = await lsFindSubscription(validate.orderId, env);
    if (!subId) {
      // Lifetime customers have no subscription to cancel; treat as a
      // no-op success so the renderer's "Cancel" path doesn't error
      // out for licenses that aren't subscriptions in the first place.
      return json({ ok: true });
    }

    // DELETE /v1/subscriptions/{id} flags the sub as cancelled but
    // keeps it active until the end of the current billing period.
    // Customer retains access; we don't have to do anything else.
    const res = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${subId}`, {
      method: 'DELETE',
      headers: {
        'Accept': 'application/vnd.api+json',
        'Authorization': `Bearer ${env.LS_API_KEY}`,
      },
    });
    if (!res.ok && res.status !== 204) {
      const errText = await res.text();
      return jsonError(`LS cancel error: ${errText.slice(0, 200)}`, 502);
    }
    return json({ ok: true });
  } catch (e: any) {
    return jsonError(`LS cancel failed: ${e?.message ?? 'unknown error'}`, 502);
  }
}

async function apiLicenseListInstances(body: any, env: Env): Promise<Response> {
  const key: string | undefined = body?.key;
  const currentInstanceId: string | undefined = body?.currentInstanceId;
  if (typeof key !== 'string' || key.trim().length < 8) {
    return jsonError('Missing or invalid `key`', 400);
  }
  if (!env.LS_API_KEY) {
    return json({
      ok: true,
      instances: [
        { id: 'mock-instance-1', name: 'PDR-win32-bc6510f2', createdAt: '2026-04-26T09:14:00Z', isCurrent: true },
        { id: 'mock-instance-2', name: 'PDR-win32-aabbccdd', createdAt: '2026-03-12T14:22:00Z', isCurrent: false },
      ],
    });
  }
  try {
    const validateRes = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key.trim() }),
    });
    const validateData: any = await validateRes.json();
    if (!validateData.valid || !validateData.license_key?.id) {
      return jsonError('License key not recognised by Lemon Squeezy', 401);
    }
    const licenseKeyId = validateData.license_key.id;
    const instancesRes = await fetch(
      `https://api.lemonsqueezy.com/v1/license-key-instances?filter[license_key_id]=${licenseKeyId}`,
      { headers: { 'Accept': 'application/vnd.api+json', 'Authorization': `Bearer ${env.LS_API_KEY}` } },
    );
    if (!instancesRes.ok) {
      const errText = await instancesRes.text();
      return jsonError(`LS list-instances error: ${errText.slice(0, 200)}`, 502);
    }
    const instancesData: any = await instancesRes.json();
    const instances = (instancesData.data ?? []).map((inst: any) => ({
      id: inst.attributes?.identifier ?? inst.id,
      name: inst.attributes?.name ?? 'Unknown device',
      createdAt: inst.attributes?.created_at ?? null,
      isCurrent: currentInstanceId ? ((inst.attributes?.identifier ?? inst.id) === currentInstanceId) : false,
    }));
    return json({ ok: true, instances });
  } catch (e: any) {
    return jsonError(`LS list-instances failed: ${e?.message ?? 'unknown error'}`, 502);
  }
}
async function apiLicenseDeactivateInstance(body: any, env: Env): Promise<Response> {
  const key: string | undefined = body?.key;
  const confirmKey: string | undefined = body?.confirmKey;
  const instanceId: string | undefined = body?.instanceId;
  if (typeof key !== 'string' || key.trim().length < 8) {
    return jsonError('Missing or invalid `key`', 400);
  }
  if (typeof confirmKey !== 'string' || confirmKey.trim().toUpperCase() !== key.trim().toUpperCase()) {
    return jsonError('License key confirmation does not match', 403);
  }
  if (typeof instanceId !== 'string' || instanceId.trim().length < 4) {
    return jsonError('Missing or invalid `instanceId`', 400);
  }
  if (!env.LS_API_KEY) {
    return json({ ok: true });
  }
  try {
    const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/deactivate', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key.trim(), instance_id: instanceId.trim() }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return jsonError(`LS deactivate error: ${errText.slice(0, 200)}`, 502);
    }
    const data: any = await res.json();
    if (!data.deactivated) {
      return jsonError('Lemon Squeezy reported instance not deactivated', 502);
    }
    return json({ ok: true });
  } catch (e: any) {
    return jsonError(`LS deactivate failed: ${e?.message ?? 'unknown error'}`, 502);
  }
}

// ───────────────────────────────────────────────────────────────────────
// LS API helpers — shared by retention/cancel/upsell handlers. Centralised
// here so the JSON:API content-types and bearer-auth boilerplate aren't
// repeated in every handler.
// ───────────────────────────────────────────────────────────────────────

interface LsValidateResult {
  ok: boolean;
  licenseKeyId?: number;
  orderId?: number;
  storeId?: number;
  customerId?: number;
  customerEmail?: string;
  variantId?: number;
  error?: string;
}

/**
 * Validate a license key via LS's public endpoint and return the
 * useful identifiers from the response. Doesn't require LS_API_KEY —
 * /v1/licenses/validate is the unauthenticated endpoint also used by
 * activate/deactivate. We pull `meta.store_id` etc. so callers can
 * skip a separate /v1/stores lookup when building checkouts.
 */
async function lsValidateLicense(licenseKey: string): Promise<LsValidateResult> {
  try {
    const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey.trim() }),
    });
    const data: any = await res.json();
    if (!data?.valid) {
      return { ok: false, error: 'License key not recognised by Lemon Squeezy' };
    }
    return {
      ok: true,
      licenseKeyId: data.license_key?.id,
      orderId: data.meta?.order_id,
      storeId: data.meta?.store_id,
      customerId: data.meta?.customer_id,
      customerEmail: data.meta?.customer_email,
      variantId: data.meta?.variant_id,
    };
  } catch (e: any) {
    return { ok: false, error: `LS validate failed: ${e?.message ?? 'unknown'}` };
  }
}

/**
 * Look up the subscription ID for a given order. LS's /v1/subscriptions
 * endpoint accepts a filter[order_id] query so we can skip walking
 * orders/license-keys ourselves. Prefers an active sub if multiple
 * results come back (cancelled subs stay listed until period end).
 * Returns null on any failure so callers can decide whether to error
 * out or no-op (e.g. lifetime licenses have no sub at all).
 */
async function lsFindSubscription(orderId: number, env: Env): Promise<string | null> {
  if (!env.LS_API_KEY) return null;
  try {
    const res = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions?filter[order_id]=${orderId}`,
      {
        headers: {
          'Accept': 'application/vnd.api+json',
          'Authorization': `Bearer ${env.LS_API_KEY}`,
        },
      },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const subs: any[] = data?.data ?? [];
    const active = subs.find((s) => s?.attributes?.status === 'active');
    if (active?.id) return active.id;
    if (subs[0]?.id) return subs[0].id;
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the full subscription resource for a given subscription ID.
 * Used by retention-status to read variant_name and decide whether
 * the customer is on the regular Monthly or Yearly variant when the
 * variant ID doesn't match one of our known constants.
 */
async function lsGetSubscription(
  subId: string,
  env: Env,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  if (!env.LS_API_KEY) return { ok: false, error: 'LS_API_KEY not configured' };
  try {
    const res = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${subId}`, {
      headers: {
        'Accept': 'application/vnd.api+json',
        'Authorization': `Bearer ${env.LS_API_KEY}`,
      },
    });
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `LS GET subscription error: ${errText.slice(0, 200)}` };
    }
    const data: any = await res.json();
    return { ok: true, data: data.data };
  } catch (e: any) {
    return { ok: false, error: `LS GET subscription failed: ${e?.message ?? 'unknown'}` };
  }
}

/**
 * Switch an LS subscription to a different variant via PATCH. Used by
 * the retention flow to move a customer to/from the hidden retention
 * variants without forcing them through a fresh checkout. The card on
 * file carries over and the customer never re-enters payment details.
 *
 * `disable_prorations: true` skips the partial-month credit/charge
 * calculation — we don't want to refund the customer for the unused
 * portion of their current billing cycle when applying a discount.
 *
 * `invoice_immediately: false` means the new pricing takes effect at
 * the next regular billing date rather than triggering an immediate
 * invoice. The customer's billing anchor stays the same.
 */
async function lsPatchSubscription(
  subId: string,
  attributes: Record<string, unknown>,
  env: Env,
): Promise<{ ok: boolean; error?: string }> {
  if (!env.LS_API_KEY) return { ok: false, error: 'LS_API_KEY not configured' };
  try {
    const body = {
      data: {
        type: 'subscriptions',
        id: subId,
        attributes,
      },
    };
    const res = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${subId}`, {
      method: 'PATCH',
      headers: {
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${env.LS_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `LS PATCH error: ${errText.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `LS PATCH failed: ${e?.message ?? 'unknown'}` };
  }
}

// ───────────────────────────────────────────────────────────────────────
// Scheduled handler — runs daily via the cron trigger declared in
// wrangler.toml. Walks the retention KV store, finds any monthly-discount
// records whose 90-day window has expired, and PATCHes those subscriptions
// back to their original variant so the customer goes back to paying $19.
// The KV record stays (with `revertedAt` stamped on it) so `hasUsedRetention`
// remains true and the same customer can't claim the discount again.
// ───────────────────────────────────────────────────────────────────────

async function runRetentionRevertCron(env: Env): Promise<void> {
  if (!env.LS_API_KEY) return;

  let cursor: string | undefined;
  const now = Date.now();

  do {
    const list = await env.USAGE_KV.list({
      prefix: RETENTION_KV_PREFIX,
      cursor,
    });

    for (const item of list.keys) {
      try {
        const raw = await env.USAGE_KV.get(item.name);
        if (!raw) continue;
        const record = JSON.parse(raw);

        // Only monthly-discount records have an expiresAt; switch-to-yearly
        // is permanent and never reverts.
        if (record.action !== 'monthly-discount') continue;
        if (record.revertedAt) continue; // already reverted, leave alone
        if (typeof record.expiresAt !== 'number' || record.expiresAt > now) continue;

        const subId = record.subscriptionId;
        const originalVariantId = record.originalVariantId;
        if (!subId || !originalVariantId) continue;

        const patch = await lsPatchSubscription(
          subId,
          {
            variant_id: Number(originalVariantId),
            disable_prorations: true,
            invoice_immediately: false,
          },
          env,
        );
        if (patch.ok) {
          record.revertedAt = now;
          // Keep expiresAt for audit but it's no longer the trigger.
          await env.USAGE_KV.put(item.name, JSON.stringify(record));
        }
        // On PATCH failure, leave the record alone so the next cron
        // run picks it up again. Persistent failures will stay in KV
        // and can be investigated via the Cloudflare dashboard.
      } catch {
        // Skip this record and continue with the next.
      }
    }

    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}
