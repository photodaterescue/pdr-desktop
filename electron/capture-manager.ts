/**
 * v2.1 (Terry 2026-06-11) — Screen capture manager.
 *
 * Owns the "screenshot straight into the library" surface: the
 * desktopCapturer grab, PDR-window hide/restore choreography, file
 * placement under <LibraryRoot>\PDR Captures\YYYY-MM\, the pending
 * fallback when the Library Drive is disconnected, the global hotkey,
 * and the post-capture broadcasts that drive live view refresh + the
 * renderer toast.
 *
 * Deliberately NOT a Fix scenario (Terry's architectural call): a
 * capture is created inside PDR with an authoritative timestamp and a
 * known format, so it skips the Fix worker / source-add / analysis
 * entirely and lands via indexCapturedFile — the third sibling of the
 * Enhance-save / Clip-trim single-file upserts in search-database.
 *
 * Windows-only first cut. Screen RECORDING (MediaRecorder → FFmpeg →
 * MP4) will join this module in a later step; stills don't need a
 * renderer media stream at all — desktopCapturer hands the main
 * process a full-resolution NativeImage directly.
 */
import { app, BrowserWindow, desktopCapturer, globalShortcut, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import log from 'electron-log/main.js';
import { toLongPath } from './long-path.js';
import { getLibraryStatus } from './library-sidecar.js';
import { getSettings } from './settings-store.js';
import { indexCapturedFile } from './search-database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CaptureDisplayInfo {
  id: string;
  label: string;
  width: number;
  height: number;
  isPrimary: boolean;
  thumbnailDataUrl: string;
}

export interface CaptureScreenshotResult {
  success: boolean;
  filePath?: string;
  filename?: string;
  fileId?: number | null;
  /** true when the Library Drive was offline and the PNG went to the
   *  AppData pending folder instead (flushed on reconnect). */
  pending?: boolean;
  /** Button-triggered capture on a multi-monitor setup with no
   *  remembered choice — renderer should show the display picker and
   *  re-invoke with displayId. */
  needsDisplayPick?: boolean;
  displays?: CaptureDisplayInfo[];
  error?: string;
}

// Which display the user picked in this session's picker. Hotkey
// captures don't read or write this — they always take the display
// under the cursor (the thing the user is looking at).
let sessionDisplayId: string | null = null;

// Re-entrancy guard — a mashed hotkey must not stack hide/capture/
// restore cycles on top of each other.
let captureInFlight = false;

const PENDING_DIR_NAME = 'Captures-pending';

function pendingDir(): string {
  return path.join(app.getPath('userData'), PENDING_DIR_NAME);
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch { /* non-fatal */ }
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pad = (n: number) => String(n).padStart(2, '0');

function timestampParts(d: Date) {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
    month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    isoLocal: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
}

/** Collision-safe target path: base name, then -2, -3, … */
function uniqueCapturePath(dir: string, baseName: string, ext: string): string {
  let candidate = path.join(dir, `${baseName}${ext}`);
  let n = 2;
  while (fs.existsSync(toLongPath(candidate))) {
    candidate = path.join(dir, `${baseName}-${n}${ext}`);
    n++;
    if (n > 999) throw new Error('Too many capture files with this timestamp.');
  }
  return candidate;
}

/** The attached Library Drive root, but only when it's actually
 *  reachable on disk right now (covers the disconnected-USB case). */
function onlineLibraryRoot(): string | null {
  try {
    const status = getLibraryStatus();
    const root = status?.libraryRoot ?? null;
    if (root && fs.existsSync(root)) return root;
  } catch { /* fall through */ }
  return null;
}

/**
 * Best-effort XMP stamp so the PNG is self-describing even outside
 * PDR (and a from-scratch index rebuild re-derives the right story).
 * Mirrors the viewer:saveEnhanced exiftool pattern — failure only
 * costs the embedded metadata, never the capture itself.
 */
async function stampCaptureMetadata(filePath: string, capturedAt: Date): Promise<void> {
  try {
    const { ExifTool } = await import('exiftool-vendored');
    const exiftoolPath = path.join(__dirname, 'bin', 'exiftool.exe');
    const exiftool = new ExifTool({
      exiftoolPath: fs.existsSync(exiftoolPath) ? exiftoolPath : undefined,
    });
    const { isoLocal } = timestampParts(capturedAt);
    try {
      const tags = {
        'XMP-xmp:CreateDate': isoLocal,
        'XMP-photoshop:DateCreated': isoLocal,
        'XMP-xmp:Label': 'PDR-Capture',
        'XMP-xmpMM:HistoryAction': 'created',
        'XMP-xmpMM:HistorySoftwareAgent': `Photo Date Rescue ${app.getVersion()} (screenshot)`,
        'XMP-xmpMM:HistoryWhen': isoLocal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      await exiftool.write(filePath, tags, ['-overwrite_original']);
    } finally {
      try { await exiftool.end(); } catch { /* non-fatal */ }
    }
  } catch (err) {
    log.warn(`[capture] XMP stamp failed (non-fatal): ${(err as Error).message}`);
  }
}

/**
 * All connected displays with small live thumbnails for the picker.
 * Thumbnails at 320px wide are plenty for "which screen is which".
 */
export async function listCaptureDisplays(): Promise<CaptureDisplayInfo[]> {
  const displays = screen.getAllDisplays();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 320 },
  });
  return displays.map((d, i) => {
    const source =
      sources.find((s) => s.display_id === String(d.id)) ??
      // Some Windows configs report blank display_ids — fall back to
      // positional pairing, which matches Electron's enumeration order.
      sources[i];
    return {
      id: String(d.id),
      label: `Display ${i + 1}${d.id === screen.getPrimaryDisplay().id ? ' (primary)' : ''} — ${Math.round(d.bounds.width * d.scaleFactor)}×${Math.round(d.bounds.height * d.scaleFactor)}`,
      width: Math.round(d.bounds.width * d.scaleFactor),
      height: Math.round(d.bounds.height * d.scaleFactor),
      isPrimary: d.id === screen.getPrimaryDisplay().id,
      thumbnailDataUrl: source ? source.thumbnail.toDataURL() : '',
    };
  });
}

/**
 * Take a full-screen screenshot and land it in the library.
 *
 * trigger 'button': multi-monitor with no session choice → returns
 * needsDisplayPick + the display list instead of capturing (the
 * renderer shows the picker and re-invokes with displayId).
 * trigger 'hotkey': captures the display under the CURSOR — no UI,
 * because the user is mid-flow in some other app.
 */
export async function captureScreenshot(opts: {
  displayId?: string;
  trigger: 'button' | 'hotkey';
}): Promise<CaptureScreenshotResult> {
  if (captureInFlight) {
    return { success: false, error: 'A capture is already in progress.' };
  }
  captureInFlight = true;
  try {
    // Older pending captures ride along on the next capture attempt —
    // cheap eventual-consistency retry without a watcher. Fire and
    // forget; a slow flush must not delay THIS capture.
    void flushPendingCaptures().catch((err) =>
      log.warn(`[capture] inline pending flush failed (non-fatal): ${(err as Error).message}`),
    );

    // ── Resolve which display to shoot ──────────────────────────────
    const displays = screen.getAllDisplays();
    let target = null as Electron.Display | null;
    if (opts.displayId) {
      target = displays.find((d) => String(d.id) === String(opts.displayId)) ?? null;
      if (!target) return { success: false, error: 'That display is no longer connected.' };
      sessionDisplayId = String(target.id);
    } else if (opts.trigger === 'hotkey') {
      target = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } else if (displays.length === 1) {
      target = displays[0];
    } else if (sessionDisplayId) {
      target = displays.find((d) => String(d.id) === sessionDisplayId) ?? null;
    }
    if (!target) {
      return { success: false, needsDisplayPick: true, displays: await listCaptureDisplays() };
    }

    const capturedAt = new Date();

    // ── Get PDR out of the shot ─────────────────────────────────────
    // The user almost always wants what's BEHIND PDR. Hide every
    // visible PDR window (main + viewer + PM), shoot, restore. Hotkey
    // with PDR minimised: nothing visible, nothing to hide — instant.
    const toRestore: Array<{ win: BrowserWindow; focused: boolean }> = [];
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
        toRestore.push({ win, focused: win.isFocused() });
      }
    }
    const restoreWindows = () => {
      for (const { win, focused } of toRestore) {
        if (win.isDestroyed()) continue;
        // showInactive for windows that weren't focused — restoring
        // a background PDR must not steal focus from the user's app.
        try { focused ? win.show() : win.showInactive(); } catch { /* non-fatal */ }
      }
    };

    let pngBuffer: Buffer;
    let imgWidth: number | null = null;
    let imgHeight: number | null = null;
    try {
      for (const { win } of toRestore) {
        try { win.hide(); } catch { /* non-fatal */ }
      }
      if (toRestore.length > 0) {
        // Give the compositor a beat to actually drop the windows
        // from screen before we shoot.
        await sleep(280);
      }

      // ── Shoot ─────────────────────────────────────────────────────
      // Ask for the display's native pixel size — desktopCapturer
      // scales the "thumbnail" to fit the requested box, so requesting
      // bounds × scaleFactor returns a pixel-perfect full-res frame.
      const nativeW = Math.round(target.bounds.width * target.scaleFactor);
      const nativeH = Math.round(target.bounds.height * target.scaleFactor);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: nativeW, height: nativeH },
      });
      const source =
        sources.find((s) => s.display_id === String(target!.id)) ??
        (sources.length === 1 ? sources[0] : undefined);
      if (!source || source.thumbnail.isEmpty()) {
        return { success: false, error: 'Could not capture the screen.' };
      }
      pngBuffer = source.thumbnail.toPNG();
      const size = source.thumbnail.getSize();
      imgWidth = size.width || null;
      imgHeight = size.height || null;
    } finally {
      // Windows come back IMMEDIATELY after the grab — the slower
      // disk/exiftool/index work below happens behind a visible app.
      restoreWindows();
    }

    // ── Place the file ──────────────────────────────────────────────
    const { date, time, month } = timestampParts(capturedAt);
    const libRoot = onlineLibraryRoot();
    const destDir = libRoot
      ? path.join(libRoot, 'PDR Captures', month)
      : pendingDir();
    fs.mkdirSync(toLongPath(destDir), { recursive: true });
    const outPath = uniqueCapturePath(destDir, `${date}_${time}_Screenshot`, '.png');
    fs.writeFileSync(toLongPath(outPath), pngBuffer);
    const filename = path.basename(outPath);

    // Self-describing metadata inside the PNG (best-effort).
    await stampCaptureMetadata(outPath, capturedAt);

    // ── Index + announce ────────────────────────────────────────────
    let fileId: number | null = null;
    if (libRoot) {
      try {
        fileId = await indexCapturedFile(outPath, libRoot, capturedAt, imgWidth, imgHeight, 'photo');
        if (fileId != null) {
          broadcast('library:filesAdded', { reason: 'capture', newFilePath: outPath, fileId });
        }
      } catch (idxErr) {
        log.warn(`[capture] index pass failed (file still saved): ${(idxErr as Error).message}`);
      }
      log.info(`[capture] screenshot ${filename} (${imgWidth}×${imgHeight}) → library${fileId != null ? ` (file id ${fileId})` : ' (NOT indexed)'}`);
    } else {
      log.info(`[capture] screenshot ${filename} → pending (Library Drive offline); will flush on reconnect`);
    }

    broadcast('capture:completed', {
      filePath: outPath,
      filename,
      fileId,
      pending: !libRoot,
      width: imgWidth,
      height: imgHeight,
    });

    return { success: true, filePath: outPath, filename, fileId, pending: !libRoot };
  } catch (err) {
    log.warn(`[capture] screenshot failed: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  } finally {
    captureInFlight = false;
  }
}

/**
 * Move any captures stranded in the AppData pending folder into the
 * (now reconnected) library, index them, and announce. Capture time
 * comes back out of the filename — the same YYYY-MM-DD_HH-MM-SS
 * pattern the indexer itself parses. Called at startup (deferred) and
 * opportunistically before every new capture.
 */
export async function flushPendingCaptures(): Promise<number> {
  const dir = pendingDir();
  if (!fs.existsSync(dir)) return 0;
  const libRoot = onlineLibraryRoot();
  if (!libRoot) return 0;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => /\.(png|mp4)$/i.test(f));
  } catch {
    return 0;
  }
  if (entries.length === 0) return 0;

  let flushed = 0;
  for (const name of entries) {
    try {
      const srcPath = path.join(dir, name);
      // Recover the capture moment from the filename; fall back to
      // the file's mtime for anything hand-renamed in the meantime.
      const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
      const capturedAt = m
        ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
        : fs.statSync(srcPath).mtime;

      const { month } = timestampParts(capturedAt);
      const destDir = path.join(libRoot, 'PDR Captures', month);
      fs.mkdirSync(toLongPath(destDir), { recursive: true });
      const ext = path.extname(name).toLowerCase();
      const destPath = uniqueCapturePath(destDir, path.basename(name, ext), ext);
      try {
        fs.renameSync(toLongPath(srcPath), toLongPath(destPath));
      } catch {
        // Cross-volume move (AppData on C:, library on D:) — copy + delete.
        fs.copyFileSync(toLongPath(srcPath), toLongPath(destPath));
        fs.unlinkSync(toLongPath(srcPath));
      }

      // Dimensions best-effort from the file itself.
      let width: number | null = null;
      let height: number | null = null;
      try {
        const sharp = (await import('sharp')).default;
        const meta = await sharp(destPath, { failOnError: false }).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
      } catch { /* keep nulls */ }

      const fileType = ext === '.mp4' ? 'video' : 'photo';
      const fileId = await indexCapturedFile(destPath, libRoot, capturedAt, width, height, fileType);
      if (fileId != null) {
        broadcast('library:filesAdded', { reason: 'capture', newFilePath: destPath, fileId });
      }
      flushed++;
      log.info(`[capture] flushed pending ${name} → ${destPath}${fileId != null ? ` (file id ${fileId})` : ''}`);
    } catch (err) {
      log.warn(`[capture] pending flush of ${name} failed (left in place): ${(err as Error).message}`);
    }
  }

  if (flushed > 0) {
    broadcast('capture:pendingFlushed', { count: flushed });
  }
  return flushed;
}

// ─── Global hotkey ───────────────────────────────────────────────────────────

let currentAccelerator: string | null = null;

/**
 * (Re-)register the screenshot hotkey from settings. Always
 * unregisters the previous accelerator first, so this doubles as the
 * "user remapped it in Settings → Capture" handler. Registration can
 * legitimately fail when another app owns the combo — the title-bar
 * button is unaffected, so we log + report rather than throw.
 */
export function registerCaptureHotkey(): { registered: boolean; accelerator: string } {
  const accelerator = (() => {
    try { return getSettings().captureHotkey || 'Ctrl+Shift+S'; } catch { return 'Ctrl+Shift+S'; }
  })();
  if (currentAccelerator) {
    try { globalShortcut.unregister(currentAccelerator); } catch { /* non-fatal */ }
    currentAccelerator = null;
  }
  let registered = false;
  try {
    registered = globalShortcut.register(accelerator, () => {
      void captureScreenshot({ trigger: 'hotkey' }).catch((err) =>
        log.warn(`[capture] hotkey capture failed: ${(err as Error).message}`),
      );
    });
  } catch (err) {
    log.warn(`[capture] hotkey registration threw: ${(err as Error).message}`);
  }
  if (registered) currentAccelerator = accelerator;
  log.info(`[capture] global hotkey ${accelerator} ${registered ? 'registered' : 'NOT registered (likely in use by another app)'}`);
  return { registered, accelerator };
}

export function unregisterCaptureHotkey(): void {
  if (currentAccelerator) {
    try { globalShortcut.unregister(currentAccelerator); } catch { /* non-fatal */ }
    currentAccelerator = null;
  }
}
