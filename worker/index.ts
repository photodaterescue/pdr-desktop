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
