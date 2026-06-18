// electron/print-manager.ts
// v2.1 round 280 (Terry) — Sharing Phase 3: Print + Print to PDF.
//
// Lays the selected photos into a print-ready HTML document (chosen layout /
// fit / paper / orientation), renders it in a hidden BrowserWindow, then either
// opens the native OS print dialog (covers EVERY installed printer, local or
// network, AND "Microsoft Print to PDF") or writes a PDF straight to disk via
// Chromium's printToPDF. All local — nothing leaves the machine.

import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type PrintLayout = '1' | '2' | '4' | 'contact';
export type PrintFit = 'fit' | 'fill';
export type PrintPaper = 'Letter' | 'A4';
export type PrintOrientation = 'portrait' | 'landscape';

export interface PrintOpts {
  layout: PrintLayout;
  fit: PrintFit;
  paper: PrintPaper;
  orientation: PrintOrientation;
}

export interface PrintInput { path: string; name?: string; }

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/** Windows path → file:// URL, encoding each segment but keeping the drive + slashes. */
function fileUrl(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/').map((seg, i) =>
    (i === 0 && /^[a-zA-Z]:$/.test(seg)) ? seg : encodeURIComponent(seg));
  return 'file:///' + parts.join('/');
}

function perPageFor(layout: PrintLayout): number {
  return layout === '1' ? 1 : layout === '2' ? 2 : layout === '4' ? 4 : 0;
}

function gridFor(layout: PrintLayout, orientation: PrintOrientation): string {
  if (layout === '1') return 'grid-template-columns:1fr;grid-template-rows:1fr;';
  if (layout === '2') {
    return orientation === 'landscape'
      ? 'grid-template-columns:1fr 1fr;grid-template-rows:1fr;'
      : 'grid-template-columns:1fr;grid-template-rows:1fr 1fr;';
  }
  if (layout === '4') return 'grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;';
  return '';
}

/** Build the full print HTML document for the given photos + options. */
export function buildPrintHtml(files: PrintInput[], opts: PrintOpts): string {
  const fitClass = opts.fit === 'fill' ? 'fill' : 'fit';

  let body = '';
  if (opts.layout === 'contact') {
    const cells = files.map((f) => `
      <figure class="citem">
        <img src="${fileUrl(f.path)}" alt="">
        <figcaption class="cap">${esc(f.name || path.basename(f.path))}</figcaption>
      </figure>`).join('');
    body = `<div class="contact">${cells}</div>`;
  } else {
    const per = perPageFor(opts.layout);
    const pages: string[] = [];
    for (let i = 0; i < files.length; i += per) {
      const group = files.slice(i, i + per);
      const cells = group.map((f) =>
        `<div class="cell"><img src="${fileUrl(f.path)}" alt=""></div>`).join('');
      pages.push(`<section class="page" style="${gridFor(opts.layout, opts.orientation)}">${cells}</section>`);
    }
    body = pages.join('');
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: ${opts.paper} ${opts.orientation}; margin: 0.4in; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .page {
    page-break-after: always; break-after: page;
    height: 100vh; width: 100%;
    display: grid; gap: 0.18in;
  }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .cell { display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .cell img { display: block; }
  .fit .cell img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; }
  .fill .cell img { width: 100%; height: 100%; object-fit: cover; }
  /* Contact sheet */
  .contact { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.12in; }
  .contact .citem { break-inside: avoid; margin: 0; text-align: center; }
  .contact .citem img { width: 100%; height: 1.55in; object-fit: cover; border: 1px solid #ddd; display: block; }
  .contact .cap { font-size: 7pt; color: #444; word-break: break-all; margin-top: 2px; line-height: 1.1; }
</style></head>
<body class="${fitClass}">${body}</body></html>`;
}

/** Wait until every <img> in the window has loaded (or errored), with a cap. */
async function waitForImages(win: BrowserWindow): Promise<void> {
  try {
    await win.webContents.executeJavaScript(`new Promise((res) => {
      const imgs = Array.from(document.images);
      let pending = imgs.filter(i => !i.complete).length;
      if (pending === 0) return res(true);
      let done = false;
      const finish = () => { if (!done) { done = true; res(true); } };
      imgs.forEach(i => {
        if (i.complete) return;
        const tick = () => { if (--pending <= 0) finish(); };
        i.addEventListener('load', tick); i.addEventListener('error', tick);
      });
      setTimeout(finish, 8000);
    })`);
  } catch { /* best-effort */ }
}

/** Create a hidden window, render the layout HTML, run `job`, then clean up. */
async function withPrintWindow<T>(
  files: PrintInput[],
  opts: PrintOpts,
  job: (win: BrowserWindow) => Promise<T>,
): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    width: 920,
    height: 1200,
    webPreferences: {
      // Local-only, hidden print surface — file:// <img> from a file:// page.
      webSecurity: false,
      offscreen: false,
      backgroundThrottling: false,
    },
  });
  // Stamp uniqueness without Date.now (unavailable in some contexts here it's
  // fine in main, but keep it cheap): pid + a random suffix.
  const tmp = path.join(os.tmpdir(), `pdr-print-${process.pid}-${Math.floor(Math.random() * 1e9).toString(36)}.html`);
  try {
    await fs.promises.writeFile(tmp, buildPrintHtml(files, opts), 'utf8');
    await win.loadFile(tmp);
    await waitForImages(win);
    return await job(win);
  } finally {
    try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  }
}

/** Open the native OS print dialog for the photos. Returns cancelled=true if
 *  the user dismissed the dialog (not an error). */
export async function printPhotos(
  files: PrintInput[],
  opts: PrintOpts,
): Promise<{ success: boolean; cancelled?: boolean; error?: string }> {
  if (!files || files.length === 0) return { success: false, error: 'Nothing to print.' };
  try {
    return await withPrintWindow(files, opts, (win) => new Promise((resolve) => {
      win.webContents.print({
        silent: false,
        printBackground: true,
        pageSize: opts.paper,
        landscape: opts.orientation === 'landscape',
        margins: { marginType: 'none' },
      }, (ok, failureReason) => {
        if (ok) resolve({ success: true });
        else if (/cancel/i.test(failureReason || '')) resolve({ success: false, cancelled: true });
        else resolve({ success: false, error: failureReason || 'Printing failed.' });
      });
    }));
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/** Render the photos to a PDF written at `savePath`. */
export async function savePhotosPdf(
  files: PrintInput[],
  opts: PrintOpts,
  savePath: string,
): Promise<{ success: boolean; error?: string }> {
  if (!files || files.length === 0) return { success: false, error: 'Nothing to save.' };
  try {
    return await withPrintWindow(files, opts, async (win) => {
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: opts.paper,
        landscape: opts.orientation === 'landscape',
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      await fs.promises.writeFile(savePath, pdf);
      return { success: true };
    });
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
