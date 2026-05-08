/**
 * Free Trial file-counter client.
 *
 * Talks to the Cloudflare Worker at https://updates.photodaterescue.com
 * (the same Worker that serves auto-update artefacts from R2). Two
 * endpoints, both POST + JSON:
 *
 *   /api/usage/get        body: { key }            → { used: number }
 *   /api/usage/increment  body: { key, count }     → { used: number }
 *
 * Storage is keyed server-side by SHA-256 of the trimmed/upper-cased
 * license key, so the raw key never lands in KV. A KV record per
 * customer holds `{ used: number }`. The hard cap (200 for the Free
 * Trial variant) is enforced in this module / the calling code, not
 * in the Worker — the Worker just stores whatever count it's told.
 *
 * Why client-side enforcement: the Worker is intentionally simple
 * (single namespace, no LS validation per call) so that adding a new
 * paid tier with a different limit doesn't require a Worker rebuild.
 * The price of that simplicity is that a sufficiently-motivated user
 * could MITM the increment to under-report. For the v2.1.0 first cut
 * we accept that — the population of "people who reverse-engineer a
 * desktop app to cheat a 200-file trial" is essentially zero.
 *
 * Network failures: all functions reject with a thrown Error rather
 * than returning a tagged result, so the caller can decide whether
 * to (a) block the user (strict) or (b) trust the local optimistic
 * count and silently retry (lenient). For the pre-fix gate we want
 * strict — if we can't read usage we shouldn't let an unlimited Fix
 * run on a Free Trial license. For increment-after-fix we want
 * lenient — the user already paid the work cost; we shouldn't
 * penalise them for a flaky network.
 */

const WORKER_BASE = 'https://updates.photodaterescue.com';

/** Hard cap for the Free Trial. Mirrors what gets enforced in
 * `analysis-engine.ts` / wherever the pre-fix gate calls into. */
export const FREE_TRIAL_FILE_LIMIT = 200;

/** Network timeout for the Worker fetch (ms). Short on purpose —
 * the user shouldn't wait more than a couple of seconds at the
 * pre-fix gate just to know how many files they've used. The
 * fallback in the gate is to fail-CLOSED (block the run) so the
 * counter can't be silently bypassed by killing the network. */
const FETCH_TIMEOUT_MS = 4_000;

interface UsageResponse {
  used: number;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  // AbortController gives us a hard wall on slow networks. Without
  // it, fetch() would honour the OS-level TCP timeout (~30 s on
  // Windows) and the user would think the app had hung.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${WORKER_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Pull the JSON error body for a useful log message — the
      // Worker returns `{ error: '...' }` on the failure path. Fall
      // back to the status text if the body isn't JSON.
      let message = res.statusText;
      try {
        const errorBody = (await res.json()) as { error?: string };
        if (errorBody?.error) message = errorBody.error;
      } catch { /* keep statusText */ }
      throw new Error(`usage worker ${path} → ${res.status} ${message}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the current files-used count for a license key. Returns 0
 * when the KV record doesn't exist yet (first launch / freshly
 * activated trial).
 */
export async function getUsage(licenseKey: string): Promise<number> {
  if (typeof licenseKey !== 'string' || licenseKey.trim().length < 8) {
    throw new Error('getUsage: license key missing / too short');
  }
  const result = await postJson<UsageResponse>('/api/usage/get', {
    key: licenseKey.trim(),
  });
  if (typeof result?.used !== 'number' || !Number.isFinite(result.used)) {
    throw new Error(`getUsage: malformed response ${JSON.stringify(result)}`);
  }
  return Math.max(0, Math.floor(result.used));
}

/**
 * Add `count` to the stored files-used. Returns the new total. The
 * Worker side is last-write-wins on KV, so two concurrent
 * increments for the same key can race and lose one — for the Free
 * Trial use case (one user, a handful of in-flight file fixes) the
 * worst case is the user fixing one extra file beyond the cap,
 * strictly user-favourable.
 */
export async function incrementUsage(licenseKey: string, count: number): Promise<number> {
  if (typeof licenseKey !== 'string' || licenseKey.trim().length < 8) {
    throw new Error('incrementUsage: license key missing / too short');
  }
  if (!Number.isFinite(count) || count < 1 || count > 10_000) {
    throw new Error(`incrementUsage: count out of range (${count})`);
  }
  const result = await postJson<UsageResponse>('/api/usage/increment', {
    key: licenseKey.trim(),
    count: Math.floor(count),
  });
  if (typeof result?.used !== 'number' || !Number.isFinite(result.used)) {
    throw new Error(`incrementUsage: malformed response ${JSON.stringify(result)}`);
  }
  return Math.max(0, Math.floor(result.used));
}
