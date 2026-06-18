// electron/phone-share.ts
// v2.1 round 279 (Terry) — Sharing Phase 2: "Send to Phone" over local Wi-Fi.
//
// A tiny, short-lived LAN HTTP server. The renderer shows a QR code encoding
// this server's URL; the phone (on the SAME Wi-Fi) scans it, opens a little
// mobile page, and pulls the selected photos straight off the PC. No cloud, no
// account, no upload — the files never leave the local network. This is the
// on-ethos "your photos stay on your hardware" answer to the phone last-mile.
//
// Security model (defence in depth, all local):
//   • The URL carries an unguessable 128-bit token; without it every route
//     404s. Another device on the LAN can't reach the files by guessing.
//   • Strict allowlist: only the files in THIS session are served, addressed by
//     an opaque random id → an absolute path is NEVER taken from the request,
//     so path traversal is impossible.
//   • Auto-expiry (15 min) + explicit stopShare() when the modal closes, so the
//     port isn't left open. One session at a time.
//   • nosniff + attachment Content-Disposition on downloads.

import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';

export interface PhoneShareFile { id: string; path: string; name: string; size: number; }

export interface PhoneShareStatus {
  active: boolean;
  url?: string;
  ip?: string;
  port?: number;
  fileCount?: number;
  downloads?: number;
  expiresAt?: number;
}

interface Session {
  server: http.Server;
  token: string;
  ip: string;
  port: number;
  files: PhoneShareFile[];
  downloads: number;          // count of file/zip fetches (for the live indicator)
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
}

let session: Session | null = null;

const TTL_MS = 15 * 60 * 1000;   // auto-stop after 15 minutes
const MAX_FILES = 200;           // sanity cap for one share

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.m4v': 'video/x-m4v', '.zip': 'application/zip',
};
function mimeFor(p: string): string {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}
function isImage(p: string): boolean {
  return mimeFor(p).startsWith('image/');
}

/** Best LAN IPv4 — prefer common private ranges over odd virtual adapters. */
function pickLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      // Node <18 used 'IPv4', >=18 uses 4 — accept both.
      const fam = (ni as any).family;
      if ((fam === 'IPv4' || fam === 4) && !ni.internal && ni.address) {
        candidates.push(ni.address);
      }
    }
  }
  const rank = (ip: string) =>
    ip.startsWith('192.168.') ? 0 :
    ip.startsWith('10.') ? 1 :
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates[0] || null;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function fmtSize(bytes: number): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

/** The mobile download page — dark, PDR-branded, thumb grid + per-photo save
 *  and a "Download all" zip. Inline CSS so it's a single self-contained doc. */
function renderPage(s: Session): string {
  const base = `/s/${s.token}`;
  const totalBytes = s.files.reduce((n, f) => n + (f.size || 0), 0);
  const cards = s.files.map((f) => {
    const preview = isImage(f.path)
      ? `<img class="thumb" loading="lazy" src="${base}/v/${f.id}" alt="${esc(f.name)}">`
      : `<div class="thumb vid">▶</div>`;
    return `<div class="card">
      <a class="thumbwrap" href="${base}/f/${f.id}" download>${preview}</a>
      <div class="meta"><span class="nm" title="${esc(f.name)}">${esc(f.name)}</span><span class="sz">${esc(fmtSize(f.size))}</span></div>
      <a class="dl" href="${base}/f/${f.id}" download>Save</a>
    </div>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Photos from Photo Date Rescue</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; background: #0f0f1e; color: #eaeaff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { position: sticky; top: 0; z-index: 5; padding: 16px 16px 12px;
    background: rgba(15,15,30,0.92); backdrop-filter: blur(8px);
    border-bottom: 1px solid rgba(169,156,255,0.18); }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; }
  .dot { width: 10px; height: 10px; border-radius: 50%;
    background: linear-gradient(135deg,#A99CFF,#d946ef); box-shadow: 0 0 8px rgba(169,156,255,0.6); }
  .sub { margin-top: 3px; font-size: 12.5px; color: #b9b4d6; }
  .all { display: block; margin: 12px 16px 4px; text-align: center; text-decoration: none;
    padding: 13px; border-radius: 12px; font-weight: 700; font-size: 15px; color: #1a1a2e;
    background: linear-gradient(90deg,#A99CFF,#c9b6ff); }
  .all:active { filter: brightness(0.94); }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; padding: 12px 16px 28px; }
  @media (min-width: 560px) { .grid { grid-template-columns: repeat(3, 1fr); } }
  .card { background: #1a1a2e; border: 1px solid rgba(169,156,255,0.14);
    border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
  .thumbwrap { display: block; aspect-ratio: 1/1; background: #12122a; }
  .thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb.vid { display: flex; align-items: center; justify-content: center;
    font-size: 30px; color: rgba(255,255,255,0.7); }
  .meta { padding: 7px 9px 2px; min-width: 0; }
  .nm { display: block; font-size: 11.5px; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; color: #d6d2ee; }
  .sz { font-size: 10.5px; color: #8d88aa; }
  .dl { margin: 7px 9px 10px; text-align: center; text-decoration: none; font-size: 13px;
    font-weight: 600; color: #cdbcff; border: 1px solid rgba(169,156,255,0.4);
    border-radius: 9px; padding: 8px; }
  .dl:active { background: rgba(169,156,255,0.16); }
  footer { text-align: center; font-size: 11px; color: #6f6a8c; padding: 0 16px 30px; }
</style></head>
<body>
  <header>
    <div class="brand"><span class="dot"></span> Photo Date Rescue</div>
    <div class="sub">${s.files.length} item${s.files.length === 1 ? '' : 's'}${totalBytes ? ' · ' + esc(fmtSize(totalBytes)) : ''} · shared over your Wi-Fi</div>
  </header>
  ${s.files.length > 1 ? `<a class="all" href="${base}/all.zip" download>Download all (zip)</a>` : ''}
  <div class="grid">${cards}</div>
  <footer>Tip: tap a photo or “Save”. On iPhone, saved files land in the Files app — open one to add it to Photos.</footer>
</body></html>`;
}

function bump(s: Session) { s.downloads += 1; }

function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const s = session;
    if (!s) { res.writeHead(503); res.end('No active share'); return; }
    const url = new URL(req.url || '/', 'http://local');
    const parts = url.pathname.split('/').filter(Boolean);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Every route is gated on /s/<token>.
    if (parts[0] !== 's' || parts[1] !== s.token) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
    }
    const rest = parts.slice(2);

    // Page
    if (rest.length === 0) {
      const html = renderPage(s);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html); return;
    }

    // Download-all zip
    if (rest[0] === 'all.zip') {
      try {
        const zip = new AdmZip();
        const used = new Set<string>();
        for (const f of s.files) {
          if (!fs.existsSync(f.path)) continue;
          let nm = f.name || path.basename(f.path);
          // de-dupe names inside the zip
          let n = nm, i = 1;
          while (used.has(n.toLowerCase())) {
            const ext = path.extname(nm); const stem = nm.slice(0, nm.length - ext.length);
            n = `${stem} (${i++})${ext}`;
          }
          used.add(n.toLowerCase());
          zip.addLocalFile(f.path, '', n);
        }
        const buf = zip.toBuffer();
        bump(s);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="PDR-photos.zip"',
          'Content-Length': String(buf.length),
        });
        res.end(buf); return;
      } catch (e) {
        res.writeHead(500); res.end('Zip failed'); return;
      }
    }

    // Single file: /f/<id> (attachment) or /v/<id> (inline preview)
    if ((rest[0] === 'f' || rest[0] === 'v') && rest[1]) {
      const file = s.files.find((x) => x.id === rest[1]);
      if (!file || !fs.existsSync(file.path)) { res.writeHead(404); res.end('Not found'); return; }
      const stat = fs.statSync(file.path);
      const headers: Record<string, string> = {
        'Content-Type': mimeFor(file.path),
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-store',
      };
      if (rest[0] === 'f') {
        headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(file.name)}"`;
        bump(s);
      }
      res.writeHead(200, headers);
      const stream = fs.createReadStream(file.path);
      stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
      stream.pipe(res);
      return;
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    try { res.writeHead(500); res.end('Error'); } catch { /* ignore */ }
  }
}

export function getStatus(): PhoneShareStatus {
  if (!session) return { active: false };
  return {
    active: true,
    url: `http://${session.ip}:${session.port}/s/${session.token}`,
    ip: session.ip,
    port: session.port,
    fileCount: session.files.length,
    downloads: session.downloads,
    expiresAt: session.expiresAt,
  };
}

export function stopShare(): Promise<void> {
  return new Promise((resolve) => {
    const s = session;
    session = null;
    if (!s) { resolve(); return; }
    try { clearTimeout(s.expiryTimer); } catch { /* ignore */ }
    try { s.server.close(() => resolve()); } catch { resolve(); }
    // Don't hang forever if close stalls on a keep-alive socket.
    setTimeout(() => resolve(), 1500);
  });
}

/**
 * Start (or restart) a share for `inputs` (absolute file paths). Resolves with
 * the live status (URL to QR-encode). Throws if no LAN IP or nothing to share.
 */
export async function startShare(inputs: { path: string; name?: string }[]): Promise<PhoneShareStatus> {
  await stopShare();

  const ip = pickLanIp();
  if (!ip) {
    throw new Error('No Wi-Fi / local network connection found. Connect this PC to the same Wi-Fi as your phone and try again.');
  }

  // Build the allowlist: existing files only, de-duped by path, capped.
  const seen = new Set<string>();
  const files: PhoneShareFile[] = [];
  for (const inp of inputs || []) {
    const p = inp && inp.path;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    let size = 0;
    try { if (!fs.existsSync(p)) continue; size = fs.statSync(p).size; } catch { continue; }
    files.push({ id: crypto.randomBytes(6).toString('hex'), path: p, name: inp.name || path.basename(p), size });
    if (files.length >= MAX_FILES) break;
  }
  if (files.length === 0) {
    throw new Error('None of the selected files could be found on disk.');
  }

  const token = crypto.randomBytes(16).toString('hex');
  const server = http.createServer(handle);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Ephemeral port, bound to all interfaces so the phone on the LAN can reach it.
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const addr = server.address();
  const port = (addr && typeof addr === 'object') ? addr.port : 0;

  const expiresAt = Date.now() + TTL_MS;
  const expiryTimer = setTimeout(() => { void stopShare(); }, TTL_MS);
  // Don't let the timer keep the app alive.
  try { (expiryTimer as any).unref?.(); } catch { /* ignore */ }

  session = { server, token, ip, port, files, downloads: 0, expiresAt, expiryTimer };
  return getStatus();
}
