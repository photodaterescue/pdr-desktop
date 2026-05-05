/**
 * Photo Date Rescue — auto-update edge proxy.
 *
 * Cloudflare Worker that fronts the `pdr-updates` R2 bucket and serves
 * release artifacts to electron-updater clients running inside the
 * packaged PDR app. Lives at https://updates.photodaterescue.com.
 *
 * The bucket itself is private (no public R2.dev domain). All reads
 * must come through this Worker so we control:
 *   - which file types are exposed
 *   - cache-control headers per asset class
 *   - request method whitelisting
 *   - logging/observability via Cloudflare Workers analytics
 *
 * What gets served
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
    const method = request.method.toUpperCase() as GetOrHead;
    if (method !== 'GET' && method !== 'HEAD') {
      return text(`Method ${request.method} not allowed`, 405, {
        Allow: 'GET, HEAD',
      });
    }

    const url = new URL(request.url);
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
