/**
 * v2.1 (Terry 2026-06-11) — Screen capture manager.
 *
 * Owns the "screenshot straight into the library" surface: the
 * desktopCapturer grab, PDR-window hide/restore choreography, the
 * region-selection overlay, file placement under
 * <LibraryRoot>\PDR Captures\YYYY-MM\, the pending fallback when the
 * Library Drive is disconnected, the global hotkey, and the
 * post-capture broadcasts that drive live view refresh + the renderer
 * toast.
 *
 * Deliberately NOT a Fix scenario (Terry's architectural call): a
 * capture is created inside PDR with an authoritative timestamp and a
 * known format, so it skips the Fix worker / source-add / analysis
 * entirely and lands via indexCapturedFile — the third sibling of the
 * Enhance-save / Clip-trim single-file upserts in search-database.
 *
 * Region flow (step 2) freezes the screen FIRST — the grab happens the
 * moment the user triggers, then a frameless always-on-top overlay
 * shows that frozen frame with a drag-to-select veil (Snipping-Tool
 * style). The crop is taken from the frozen buffer, so what the user
 * framed is exactly what lands in the library, and the overlay itself
 * can never appear in the shot.
 *
 * Windows-only first cut. Screen RECORDING (MediaRecorder → FFmpeg →
 * MP4) joins this module in a later step; stills don't need a renderer
 * media stream at all — desktopCapturer hands the main process a
 * full-resolution NativeImage directly.
 */
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, nativeImage, screen } from 'electron';
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
  /** Region flow only — the user dismissed the overlay (Esc / blur).
   *  Not an error; callers stay silent. */
  cancelled?: boolean;
  /** Button-triggered capture on a multi-monitor setup with no
   *  remembered choice — renderer should show the display picker and
   *  re-invoke with displayId. */
  needsDisplayPick?: boolean;
  displays?: CaptureDisplayInfo[];
  error?: string;
}

interface SelectionRect { x: number; y: number; width: number; height: number }

// Which display the user picked in this session's picker. Hotkey
// captures don't read or write this — they always take the display
// under the cursor (the thing the user is looking at).
let sessionDisplayId: string | null = null;

// Re-entrancy guard — a mashed hotkey must not stack hide/capture/
// restore cycles (or a second overlay) on top of an in-flight one.
// Held for the whole overlay lifetime during region capture, which
// also correctly blocks full-screen hotkey fires mid-selection.
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
 * Shared display resolution for both capture verbs.
 * - explicit displayId → that display (remembered for the session)
 * - hotkey → display under the cursor, never any UI
 * - button, one display → it; button, several + remembered → that;
 *   otherwise null = caller should return needsDisplayPick.
 */
function resolveTargetDisplay(opts: { displayId?: string; trigger: 'button' | 'hotkey' }):
  | { display: Electron.Display }
  | { error: string }
  | { pick: true } {
  const displays = screen.getAllDisplays();
  if (opts.displayId) {
    const display = displays.find((d) => String(d.id) === String(opts.displayId));
    if (!display) return { error: 'That display is no longer connected.' };
    sessionDisplayId = String(display.id);
    return { display };
  }
  if (opts.trigger === 'hotkey') {
    return { display: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) };
  }
  if (displays.length === 1) return { display: displays[0] };
  if (sessionDisplayId) {
    const remembered = displays.find((d) => String(d.id) === sessionDisplayId);
    if (remembered) return { display: remembered };
  }
  return { pick: true };
}

/**
 * Hide PDR's windows, grab the target display at native resolution,
 * restore the windows. The restore happens in finally — windows come
 * back IMMEDIATELY after the grab, before any disk/exiftool/index
 * work, and before the region overlay opens (the overlay is a
 * topmost fullscreen window, so PDR restoring underneath it is
 * invisible and Esc lands the user straight back where they were).
 */
async function grabDisplayPng(target: Electron.Display): Promise<{ buffer: Buffer; width: number; height: number } | null> {
  const toRestore: Array<{ win: BrowserWindow; focused: boolean }> = [];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
      toRestore.push({ win, focused: win.isFocused() });
    }
  }
  try {
    for (const { win } of toRestore) {
      try { win.hide(); } catch { /* non-fatal */ }
    }
    if (toRestore.length > 0) {
      // Give the compositor a beat to actually drop the windows
      // from screen before we shoot.
      await sleep(280);
    }

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
      sources.find((s) => s.display_id === String(target.id)) ??
      (sources.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) return null;
    const size = source.thumbnail.getSize();
    return { buffer: source.thumbnail.toPNG(), width: size.width, height: size.height };
  } finally {
    for (const { win, focused } of toRestore) {
      if (win.isDestroyed()) continue;
      // showInactive for windows that weren't focused — restoring
      // a background PDR must not steal focus from the user's app.
      try { focused ? win.show() : win.showInactive(); } catch { /* non-fatal */ }
    }
  }
}

/**
 * Shared tail of every screenshot verb: place the PNG (library or
 * pending), stamp XMP, index, broadcast, log. The capture timestamp
 * is the FROZEN moment (when the grab happened), not when the user
 * finished dragging a region.
 */
async function persistCapture(
  pngBuffer: Buffer,
  capturedAt: Date,
  imgWidth: number | null,
  imgHeight: number | null,
  kind: 'screenshot' | 'region',
): Promise<CaptureScreenshotResult> {
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
    log.info(`[capture] ${kind} ${filename} (${imgWidth}×${imgHeight}) → library${fileId != null ? ` (file id ${fileId})` : ' (NOT indexed)'}`);
  } else {
    log.info(`[capture] ${kind} ${filename} → pending (Library Drive offline); will flush on reconnect`);
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
}

/**
 * Take a full-screen screenshot and land it in the library.
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

    const resolved = resolveTargetDisplay(opts);
    if ('error' in resolved) return { success: false, error: resolved.error };
    if ('pick' in resolved) {
      return { success: false, needsDisplayPick: true, displays: await listCaptureDisplays() };
    }

    const capturedAt = new Date();
    const grab = await grabDisplayPng(resolved.display);
    if (!grab) return { success: false, error: 'Could not capture the screen.' };

    return await persistCapture(grab.buffer, capturedAt, grab.width, grab.height, 'screenshot');
  } catch (err) {
    log.warn(`[capture] screenshot failed: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  } finally {
    captureInFlight = false;
  }
}

// ─── Region selection overlay ────────────────────────────────────────────────

let overlayWindow: BrowserWindow | null = null;
let overlayResolve: ((rect: SelectionRect | null) => void) | null = null;

/** Resolve the pending overlay promise exactly once and tear the
 *  overlay window down. null = cancelled (Esc / blur / closed). */
function finishOverlay(rect: SelectionRect | null): void {
  const resolve = overlayResolve;
  overlayResolve = null;
  const win = overlayWindow;
  overlayWindow = null;
  if (win && !win.isDestroyed()) {
    try { win.close(); } catch { /* non-fatal */ }
  }
  if (resolve) resolve(rect);
}

// Selection events from the overlay page. Registered once at module
// load; the sender check pins them to the live overlay so a stale or
// spoofed renderer can't complete someone else's selection.
ipcMain.on('capture:overlay-select', (event, rect: SelectionRect) => {
  if (overlayWindow && !overlayWindow.isDestroyed() && event.sender === overlayWindow.webContents) {
    finishOverlay(rect && rect.width >= 1 && rect.height >= 1 ? rect : null);
  }
});
ipcMain.on('capture:overlay-cancel', (event) => {
  if (overlayWindow && !overlayWindow.isDestroyed() && event.sender === overlayWindow.webContents) {
    finishOverlay(null);
  }
});

/**
 * Frameless always-on-top window covering the target display, showing
 * the frozen frame with the drag-to-select veil. Resolves with the
 * selection rect in the display's CSS pixels, or null on cancel.
 */
function openRegionOverlay(display: Electron.Display, frozenDataUrl: string): Promise<SelectionRect | null> {
  return new Promise<SelectionRect | null>((resolve) => {
    overlayResolve = resolve;
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    overlayWindow = win;
    // screen-saver level floats above fullscreen apps and the taskbar.
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
    win.setMenu(null);

    win.on('closed', () => {
      // Covers external closes (e.g. Alt+F4) — finishOverlay no-ops
      // when the selection already resolved.
      if (overlayResolve) {
        const r = overlayResolve;
        overlayResolve = null;
        overlayWindow = null;
        r(null);
      }
    });

    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.webContents.send('capture:overlay-init', { imageDataUrl: frozenDataUrl });
      win.show();
      win.focus();
      // Blur = the user clicked away / alt-tabbed — treat as cancel so
      // a topmost overlay can never get stranded behind their work.
      // Attached AFTER show+focus settles so the show itself can't
      // trip it.
      setTimeout(() => {
        if (!win.isDestroyed()) win.on('blur', () => finishOverlay(null));
      }, 300);
    });

    void win.loadFile(path.join(__dirname, '../dist/public/capture-overlay.html'));
  });
}

/**
 * Region screenshot: freeze the target display, let the user drag a
 * rectangle over the frozen frame, crop, and land it in the library
 * through the same pipeline as the full-screen verb.
 */
export async function captureRegion(opts: {
  displayId?: string;
  trigger: 'button' | 'hotkey';
}): Promise<CaptureScreenshotResult> {
  if (captureInFlight) {
    return { success: false, error: 'A capture is already in progress.' };
  }
  captureInFlight = true;
  try {
    void flushPendingCaptures().catch((err) =>
      log.warn(`[capture] inline pending flush failed (non-fatal): ${(err as Error).message}`),
    );

    const resolved = resolveTargetDisplay(opts);
    if ('error' in resolved) return { success: false, error: resolved.error };
    if ('pick' in resolved) {
      return { success: false, needsDisplayPick: true, displays: await listCaptureDisplays() };
    }
    const display = resolved.display;

    // Freeze the screen NOW — the screenshot is this moment, however
    // long the user then spends framing the rectangle.
    const capturedAt = new Date();
    const grab = await grabDisplayPng(display);
    if (!grab) return { success: false, error: 'Could not capture the screen.' };

    const dataUrl = `data:image/png;base64,${grab.buffer.toString('base64')}`;
    const rect = await openRegionOverlay(display, dataUrl);
    if (!rect) {
      log.info('[capture] region selection cancelled');
      return { success: false, cancelled: true };
    }

    // Overlay coords are the display's CSS pixels; the frozen frame is
    // native pixels — scale, round, clamp.
    const scaleX = grab.width / display.bounds.width;
    const scaleY = grab.height / display.bounds.height;
    const x = Math.max(0, Math.min(grab.width - 1, Math.round(rect.x * scaleX)));
    const y = Math.max(0, Math.min(grab.height - 1, Math.round(rect.y * scaleY)));
    const width = Math.max(1, Math.min(grab.width - x, Math.round(rect.width * scaleX)));
    const height = Math.max(1, Math.min(grab.height - y, Math.round(rect.height * scaleY)));

    const cropped = nativeImage.createFromBuffer(grab.buffer).crop({ x, y, width, height });
    if (cropped.isEmpty()) return { success: false, error: 'Selected area was empty.' };

    return await persistCapture(cropped.toPNG(), capturedAt, width, height, 'region');
  } catch (err) {
    log.warn(`[capture] region capture failed: ${(err as Error).message}`);
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
 * "user remapped it in Settings → Capture" handler. What the hotkey
 * DOES (full screen vs region overlay) is read from settings at fire
 * time, so flipping the Settings → Capture action radio needs no
 * re-registration. Registration can legitimately fail when another
 * app owns the combo — the title-bar button is unaffected, so we log
 * + report rather than throw.
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
      const action = (() => {
        try { return getSettings().captureHotkeyAction || 'fullscreen'; } catch { return 'fullscreen'; }
      })();
      const fire = action === 'region' ? captureRegion : captureScreenshot;
      void fire({ trigger: 'hotkey' }).catch((err) =>
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
