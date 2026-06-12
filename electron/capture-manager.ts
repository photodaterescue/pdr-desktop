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
import { createRequire } from 'module';
import { execSync } from 'child_process';
import log from 'electron-log/main.js';
import { toLongPath } from './long-path.js';
import { getLibraryStatus } from './library-sidecar.js';
import { getSettings } from './settings-store.js';
import { indexCapturedFile } from './search-database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const esmRequire = createRequire(import.meta.url);

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
async function stampCaptureMetadata(filePath: string, capturedAt: Date, kindLabel: string = 'screenshot'): Promise<void> {
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
        'XMP-xmpMM:HistorySoftwareAgent': `Photo Date Rescue ${app.getVersion()} (${kindLabel})`,
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
 * Hide PDR's windows and grab the target display at native
 * resolution. The caller gets back a `restore()` it MUST invoke
 * (idempotent) — the full-screen verb restores immediately after the
 * grab; the region verb defers restore until the overlay window is
 * actually SHOWING, so PDR pops back exactly once behind the overlay
 * instead of flashing in and out before it (Terry's "few quick
 * flashes of windows changing" report, round 124).
 *
 * When `includeWindows` is set, the on-screen window rectangles are
 * enumerated IN THE SAME FROZEN MOMENT (PDR still hidden) so the
 * overlay's click-a-window snapping matches the frozen pixels
 * exactly. On a failed grab the windows are restored here before
 * returning null.
 */
async function grabDisplayPng(
  target: Electron.Display,
  opts?: { includeWindows?: boolean; hideWindows?: boolean },
): Promise<{ buffer: Buffer; width: number; height: number; windows: SelectionRect[]; restore: () => void } | null> {
  const toRestore: Array<{ win: BrowserWindow; focused: boolean }> = [];
  // hideWindows false = "grab the screen exactly as it stands" — used
  // by the mid-recording Snap button, where hiding PDR would put a
  // visible blip INTO the recording (round 126).
  if (opts?.hideWindows !== false) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
        toRestore.push({ win, focused: win.isFocused() });
      }
    }
  }
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const { win, focused } of toRestore) {
      if (win.isDestroyed()) continue;
      // showInactive for windows that weren't focused — restoring
      // a background PDR must not steal focus from the user's app.
      try { focused ? win.show() : win.showInactive(); } catch { /* non-fatal */ }
    }
  };
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
    if (!source || source.thumbnail.isEmpty()) {
      restore();
      return null;
    }
    const size = source.thumbnail.getSize();
    const windows = opts?.includeWindows ? enumerateWindowRectsForDisplay(target) : [];
    return { buffer: source.thumbnail.toPNG(), width: size.width, height: size.height, windows, restore };
  } catch (err) {
    restore();
    throw err;
  }
}

// ─── Snap-to-window enumeration (Win32 via koffi) ────────────────────────────

// Lazily-initialised Win32 bindings. koffi struct/proto names are
// process-global, so these MUST be defined exactly once. Any failure
// (koffi prebuilt missing, exotic Windows build) just disables
// snap-to-window — free-drag selection is unaffected.
interface WinApi {
  koffi: any;
  enumProto: any;
  EnumWindows: any;
  IsWindowVisible: any;
  IsIconic: any;
  GetWindowRect: any;
  DwmRect: any;
  DwmU32: any;
}
let winApi: WinApi | null = null;
let winApiFailed = false;

function initWinApi(): WinApi | null {
  if (winApi || winApiFailed) return winApi;
  try {
    const koffi = esmRequire('koffi');
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    koffi.struct('PdrRect', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const enumProto = koffi.proto('bool PdrEnumWindowsProc(void *hwnd, intptr_t lParam)');
    winApi = {
      koffi,
      enumProto,
      EnumWindows: user32.func('bool __stdcall EnumWindows(PdrEnumWindowsProc *cb, intptr_t lParam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ PdrRect *rect)'),
      // Same symbol declared twice with different out-param shapes —
      // DwmGetWindowAttribute is attribute-polymorphic (RECT for
      // EXTENDED_FRAME_BOUNDS(9), uint32 for CLOAKED(14)).
      DwmRect: dwmapi.func('long __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attr, _Out_ PdrRect *pv, uint32_t cb)'),
      DwmU32: dwmapi.func('long __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attr, _Out_ uint32_t *pv, uint32_t cb)'),
    };
  } catch (err) {
    winApiFailed = true;
    log.warn(`[capture] Win32 bindings unavailable — snap-to-window disabled (non-fatal): ${(err as Error).message}`);
  }
  return winApi;
}

/**
 * Top-down z-ordered rectangles of every real on-screen window
 * intersecting the target display, in the display's CSS pixels.
 * Called while PDR's own windows are hidden, so they self-exclude
 * via IsWindowVisible. Cloaked UWP ghosts are skipped; rects use
 * DWM extended frame bounds (no drop-shadow padding) with a
 * GetWindowRect fallback.
 */
function enumerateWindowRectsForDisplay(display: Electron.Display): SelectionRect[] {
  const api = initWinApi();
  if (!api) return [];
  const out: SelectionRect[] = [];
  const sf = display.scaleFactor || 1;
  const disp = {
    x: Math.round(display.bounds.x * sf),
    y: Math.round(display.bounds.y * sf),
    w: Math.round(display.bounds.width * sf),
    h: Math.round(display.bounds.height * sf),
  };
  try {
    const cb = api.koffi.register((hwnd: unknown) => {
      try {
        if (out.length >= 64) return false; // plenty — stop walking
        if (!api.IsWindowVisible(hwnd) || api.IsIconic(hwnd)) return true;
        const cloaked = [0];
        try {
          if (api.DwmU32(hwnd, 14, cloaked, 4) === 0 && cloaked[0] !== 0) return true;
        } catch { /* treat as not cloaked */ }
        const rect = { left: 0, top: 0, right: 0, bottom: 0 };
        let got = false;
        try { got = api.DwmRect(hwnd, 9, rect, 16) === 0; } catch { got = false; }
        if (!got || rect.right <= rect.left) {
          try { got = !!api.GetWindowRect(hwnd, rect); } catch { got = false; }
        }
        if (!got) return true;
        if (rect.right - rect.left < 48 || rect.bottom - rect.top < 48) return true;
        // Visible intersection with the target display only.
        const ix = Math.max(rect.left, disp.x);
        const iy = Math.max(rect.top, disp.y);
        const ix2 = Math.min(rect.right, disp.x + disp.w);
        const iy2 = Math.min(rect.bottom, disp.y + disp.h);
        if (ix2 - ix < 24 || iy2 - iy < 24) return true;
        out.push({
          x: Math.max(0, Math.round((ix - disp.x) / sf)),
          y: Math.max(0, Math.round((iy - disp.y) / sf)),
          width: Math.round((ix2 - ix) / sf),
          height: Math.round((iy2 - iy) / sf),
        });
      } catch { /* skip this window */ }
      return true;
    }, api.koffi.pointer(api.enumProto));
    try {
      api.EnumWindows(cb, 0);
    } finally {
      try { api.koffi.unregister(cb); } catch { /* non-fatal */ }
    }
  } catch (err) {
    log.warn(`[capture] window enumeration failed — snap-to-window disabled this capture: ${(err as Error).message}`);
    return [];
  }
  return out;
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

  // v2.1 round 124 (Terry 2026-06-11) — Settings → Capture format
  // choice. PNG (default) writes the grab verbatim; JPG re-encodes at
  // quality 92 for ~5-10× smaller files. A failed conversion falls
  // back to PNG rather than losing the capture.
  const format = (() => {
    try { return getSettings().captureFormat || 'png'; } catch { return 'png'; }
  })();
  let outBuffer = pngBuffer;
  let outExt = '.png';
  if (format === 'jpg') {
    try {
      const sharp = (await import('sharp')).default;
      outBuffer = await sharp(pngBuffer).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
      outExt = '.jpg';
    } catch (convErr) {
      log.warn(`[capture] JPG conversion failed — saving PNG instead (non-fatal): ${(convErr as Error).message}`);
      outBuffer = pngBuffer;
      outExt = '.png';
    }
  }

  // _SS suffix per Terry round 124 — two letters, matching the
  // _CF/_RC/_MK/_E family (recordings will be _SR). The rebuild
  // indexer's suffix reader knows _SS → confirmed + PDR-Capture.
  const outPath = uniqueCapturePath(destDir, `${date}_${time}_SS`, outExt);
  fs.writeFileSync(toLongPath(outPath), outBuffer);
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
    kind: 'screenshot',
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
    // Full-screen verb: windows come back immediately — the slower
    // disk/exiftool/index work happens behind a visible app.
    grab.restore();

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
function openRegionOverlay(
  display: Electron.Display,
  frozenDataUrl: string,
  windows: SelectionRect[],
  onShown?: () => void,
): Promise<SelectionRect | null> {
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
      win.webContents.send('capture:overlay-init', { imageDataUrl: frozenDataUrl, windows });
      win.show();
      win.focus();
      // PDR's hidden windows restore NOW, underneath the overlay —
      // one clean transition instead of the flash-in-flash-out Terry
      // reported (round 124).
      try { onShown?.(); } catch { /* non-fatal */ }
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
    // long the user then spends framing the rectangle. Window rects
    // are enumerated in the same frozen moment for snap-to-window.
    const capturedAt = new Date();
    const grab = await grabDisplayPng(display, { includeWindows: true });
    if (!grab) return { success: false, error: 'Could not capture the screen.' };

    const dataUrl = `data:image/png;base64,${grab.buffer.toString('base64')}`;
    let rect: SelectionRect | null = null;
    try {
      // PDR's windows restore once the overlay is SHOWING (onShown) —
      // invisible behind it, ready when the overlay closes.
      rect = await openRegionOverlay(display, dataUrl, grab.windows, grab.restore);
    } finally {
      // Belt-and-braces: if the overlay never reached 'shown' (load
      // failure, instant cancel), the windows still come back.
      grab.restore();
    }
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

// ─── Conflicting capture-tool detection ──────────────────────────────────────

// v2.1 round 124 (Terry 2026-06-11) — Terry's Ctrl+Shift+S presses
// never reached PDR despite successful RegisterHotKey: Lightshot was
// running and its keyboard HOOK consumed the combo before Windows
// generated WM_HOTKEY (hooks always outrank hotkey registrations).
// Windows can't tell us who ate a keystroke, but we CAN name the
// known capture tools currently running so Settings → Capture turns
// "the hotkey does nothing" from a mystery into a guided fix.
const KNOWN_CAPTURE_TOOLS: Array<{ match: RegExp; label: string }> = [
  { match: /lightshot/i, label: 'Lightshot' },
  { match: /sharex/i, label: 'ShareX' },
  { match: /greenshot/i, label: 'Greenshot' },
  { match: /snagit|snagpriv/i, label: 'Snagit' },
  { match: /picpick/i, label: 'PicPick' },
  { match: /screenpresso/i, label: 'Screenpresso' },
  { match: /flameshot/i, label: 'Flameshot' },
  // Round 125 — not a capture tool, but it's the tool that actually
  // ate Terry's hotkey (its own capture feature showed the red
  // corner UI). Any shortcut-hooking utility belongs on this list.
  { match: /mousewithoutborders/i, label: 'Mouse Without Borders' },
];

export function checkConflictingCaptureTools(): string[] {
  try {
    const out = execSync('tasklist /fo csv /nh', { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const found: string[] = [];
    for (const tool of KNOWN_CAPTURE_TOOLS) {
      if (tool.match.test(out)) found.push(tool.label);
    }
    return found;
  } catch {
    return [];
  }
}

// ─── Screen recording (step 3) ───────────────────────────────────────────────
//
// The recording ENGINE lives in the floating widget's renderer — a
// small frameless always-on-top window (content-protected, so it
// never appears in the recording itself) that owns getUserMedia +
// MediaRecorder and streams WebM chunks to main over IPC. Main
// appends them to a temp .webm as they arrive (no renderer memory
// growth on long recordings), then on stop pipes the WebM through
// the bundled FFmpeg → H.264/AAC MP4 with +faststart (PDRV scrubbing
// needs the moov atom up front) and lands it via the same
// persist/index/broadcast pipeline as screenshots — filename suffix
// _SR, fileType 'video'.
//
// PDR's own windows are deliberately NOT hidden or minimised when a
// recording starts — recording is a session the user orchestrates
// (they may well be recording PDR itself), unlike the instantaneous
// screenshot where "get PDR out of the shot" is almost always right.

let recordingState: 'idle' | 'recording' | 'processing' = 'idle';
let recordWidget: BrowserWindow | null = null;
let recordTempPath: string | null = null;
let recordStream: fs.WriteStream | null = null;
let recordStartedAt: Date | null = null;
let recordDisplay: Electron.Display | null = null;
let recordQuality: 'high' | 'standard' | 'compact' = 'standard';
let recordMeta: { width: number | null; height: number | null; hasAudio: boolean } = { width: null, height: null, hasAudio: false };

// Quality presets (round 126): live capture bitrate + save-time crf.
const RECORD_QUALITY = {
  high: { bitsPerSecond: 12_000_000, crf: '19' },
  standard: { bitsPerSecond: 8_000_000, crf: '21' },
  compact: { bitsPerSecond: 4_000_000, crf: '26' },
} as const;

function recordTempDir(): string {
  return path.join(app.getPath('userData'), 'Captures-temp');
}

function broadcastRecordingState(): void {
  broadcast('capture:recordingState', { state: recordingState });
}

// Lazy ffmpeg path — same ffmpeg-static resolution main.ts uses for
// thumbnails + HEVC transcodes (asarUnpack'd in packaged builds).
let ffmpegPathCached: string | null | undefined;
function ffmpegPath(): string | null {
  if (ffmpegPathCached !== undefined) return ffmpegPathCached;
  try {
    const p = esmRequire('ffmpeg-static') as string;
    ffmpegPathCached = p && fs.existsSync(p) ? p : null;
  } catch {
    ffmpegPathCached = null;
  }
  return ffmpegPathCached;
}

function teardownRecording(opts: { discardTemp: boolean }): void {
  if (recordWidget && !recordWidget.isDestroyed()) {
    try { recordWidget.close(); } catch { /* non-fatal */ }
  }
  recordWidget = null;
  if (recordStream) {
    try { recordStream.end(); } catch { /* non-fatal */ }
    recordStream = null;
  }
  if (opts.discardTemp && recordTempPath) {
    const p = recordTempPath;
    // Give the stream a beat to flush before unlinking.
    setTimeout(() => { try { fs.unlinkSync(toLongPath(p)); } catch { /* non-fatal */ } }, 500);
  }
  recordTempPath = null;
  recordStartedAt = null;
  recordDisplay = null;
  recordingState = 'idle';
  broadcastRecordingState();
}

export interface StartRecordingResult {
  success: boolean;
  alreadyRecording?: boolean;
  needsDisplayPick?: boolean;
  displays?: CaptureDisplayInfo[];
  error?: string;
}

export async function startRecording(opts: { displayId?: string; trigger: 'button' }): Promise<StartRecordingResult> {
  if (recordingState !== 'idle') {
    return {
      success: false,
      alreadyRecording: true,
      error: recordingState === 'processing'
        ? 'Still saving your previous recording — one moment.'
        : 'A recording is already in progress.',
    };
  }
  try {
    const resolved = resolveTargetDisplay(opts);
    if ('error' in resolved) return { success: false, error: resolved.error };
    if ('pick' in resolved) {
      return { success: false, needsDisplayPick: true, displays: await listCaptureDisplays() };
    }
    const display = resolved.display;

    // The widget's getUserMedia needs the desktopCapturer SOURCE id
    // for this display (thumbnails irrelevant — request 1×1).
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    const source =
      sources.find((s) => s.display_id === String(display.id)) ??
      (sources.length === 1 ? sources[0] : undefined);
    if (!source) return { success: false, error: 'Could not access the screen for recording.' };

    recordStartedAt = new Date();
    recordDisplay = display;
    const { date, time } = timestampParts(recordStartedAt);
    fs.mkdirSync(toLongPath(recordTempDir()), { recursive: true });
    // Temp name carries the start timestamp so the startup orphan
    // recovery can rebuild the right capture date after a crash.
    recordTempPath = path.join(recordTempDir(), `rec-${date}_${time}.webm`);
    recordStream = fs.createWriteStream(toLongPath(recordTempPath));
    recordMeta = { width: null, height: null, hasAudio: false };

    const recordAudio = (() => {
      try { return getSettings().captureRecordAudio !== false; } catch { return true; }
    })();
    recordQuality = (() => {
      try { return (getSettings().captureRecordQuality as 'high' | 'standard' | 'compact') || 'standard'; } catch { return 'standard'; }
    })();

    const widget = new BrowserWindow({
      width: 430,
      height: 64,
      x: display.bounds.x + display.bounds.width - 450,
      y: display.bounds.y + display.bounds.height - 120,
      frame: false,
      show: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#16161a',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    recordWidget = widget;
    try { widget.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
    // WDA_EXCLUDEFROMCAPTURE — the widget stays visible to the user
    // but never appears in the recording (Win10 2004+).
    try { widget.setContentProtection(true); } catch { /* non-fatal */ }
    widget.setMenu(null);

    widget.on('closed', () => {
      // External close (Alt+F4 on the widget) while recording —
      // treat as cancel; the engine died with the renderer.
      if (recordWidget === widget && recordingState === 'recording') {
        log.info('[capture] recording widget closed externally — discarding recording');
        recordWidget = null;
        teardownRecording({ discardTemp: true });
      }
    });

    widget.webContents.once('did-finish-load', () => {
      if (widget.isDestroyed()) return;
      widget.webContents.send('capture:record-init', {
        sourceId: source.id,
        audio: recordAudio,
        maxWidth: Math.round(display.bounds.width * display.scaleFactor),
        maxHeight: Math.round(display.bounds.height * display.scaleFactor),
        videoBitsPerSecond: RECORD_QUALITY[recordQuality].bitsPerSecond,
      });
      // showInactive — starting a recording must not steal focus from
      // whatever the user is about to record.
      widget.showInactive();
    });
    void widget.loadFile(path.join(__dirname, '../dist/public/capture-record-widget.html'));

    recordingState = 'recording';
    broadcastRecordingState();
    log.info(`[capture] recording started on display ${display.id} (audio: ${recordAudio ? 'system' : 'off'})`);
    return { success: true };
  } catch (err) {
    log.warn(`[capture] startRecording failed: ${(err as Error).message}`);
    teardownRecording({ discardTemp: true });
    return { success: false, error: (err as Error).message };
  }
}

/** Ask the widget's recorder to stop (it flushes and reports back on
 *  capture:record-stopped, which runs the finalize pipeline). */
export function stopRecording(): { success: boolean; error?: string } {
  if (recordingState !== 'recording' || !recordWidget || recordWidget.isDestroyed()) {
    return { success: false, error: 'No recording in progress.' };
  }
  try { recordWidget.webContents.send('capture:record-do', { action: 'stop' }); } catch { /* non-fatal */ }
  return { success: true };
}

export function cancelRecording(): { success: boolean } {
  if (recordingState === 'recording' && recordWidget && !recordWidget.isDestroyed()) {
    try { recordWidget.webContents.send('capture:record-do', { action: 'cancel' }); } catch { /* non-fatal */ }
    // The widget replies on capture:record-cancelled; belt-and-braces
    // teardown happens there. If the widget is wedged, the closed
    // handler covers it.
    return { success: true };
  }
  return { success: false };
}

/**
 * WebM → H.264/AAC MP4 with +faststart. Returns the mp4 path, or
 * null when FFmpeg is unavailable / fails (caller falls back to
 * keeping the WebM — Chromium plays VP9 natively, so the recording
 * is still viewable in PDRV; losing the user's recording is the only
 * unacceptable outcome).
 */
async function transcodeWebmToMp4(webmPath: string, crf: string = '21'): Promise<string | null> {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) {
    log.warn('[capture] ffmpeg unavailable — keeping WebM recording as-is');
    return null;
  }
  const outPath = webmPath.replace(/\.webm$/i, '.mp4');
  // ffmpeg can't open \\?\-prefixed paths (see extractVideoFrame).
  const src = webmPath.replace(/^\\\\\?\\/, '');
  const dst = outPath.replace(/^\\\\\?\\/, '');
  // ultrafast preset: verification on Terry's machine showed
  // veryfast took ~2 min for a 6-second 1080p clip on an older CPU —
  // the encode time scales with recording length, so a long recording
  // would feel broken. ultrafast roughly halves it; for screen
  // content (flat regions, text) the quality difference is
  // negligible. crf comes from the quality preset (round 126).
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', src,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', crf, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    '-y', dst,
  ];
  const { spawn } = await import('child_process');
  return new Promise<string | null>((resolve) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBuf.length < 4096) stderrBuf += chunk.toString('utf8');
    });
    proc.on('error', (err) => {
      log.warn(`[capture] ffmpeg spawn failed: ${err.message}`);
      resolve(null);
    });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) {
        resolve(outPath);
      } else {
        log.warn(`[capture] ffmpeg transcode failed (code ${code}): ${stderrBuf.trim().slice(0, 500)}`);
        resolve(null);
      }
    });
  });
}

/**
 * Shared tail for recordings — mirrors persistCapture but for an
 * already-encoded video file: place under PDR Captures (or pending),
 * stamp XMP, index as fileType 'video', broadcast. The capture
 * timestamp is the recording START.
 */
async function persistRecording(
  videoPath: string,
  startedAt: Date,
  width: number | null,
  height: number | null,
): Promise<CaptureScreenshotResult> {
  const { date, time, month } = timestampParts(startedAt);
  const libRoot = onlineLibraryRoot();
  const destDir = libRoot ? path.join(libRoot, 'PDR Captures', month) : pendingDir();
  fs.mkdirSync(toLongPath(destDir), { recursive: true });
  const ext = path.extname(videoPath).toLowerCase() || '.mp4';
  const outPath = uniqueCapturePath(destDir, `${date}_${time}_SR`, ext);
  try {
    fs.renameSync(toLongPath(videoPath), toLongPath(outPath));
  } catch {
    fs.copyFileSync(toLongPath(videoPath), toLongPath(outPath));
    try { fs.unlinkSync(toLongPath(videoPath)); } catch { /* non-fatal */ }
  }
  const filename = path.basename(outPath);

  await stampCaptureMetadata(outPath, startedAt, 'screen recording');

  let fileId: number | null = null;
  if (libRoot) {
    try {
      fileId = await indexCapturedFile(outPath, libRoot, startedAt, width, height, 'video');
      if (fileId != null) {
        broadcast('library:filesAdded', { reason: 'capture', newFilePath: outPath, fileId });
      }
    } catch (idxErr) {
      log.warn(`[capture] recording index pass failed (file still saved): ${(idxErr as Error).message}`);
    }
    log.info(`[capture] recording ${filename} (${width}×${height}) → library${fileId != null ? ` (file id ${fileId})` : ' (NOT indexed)'}`);
  } else {
    log.info(`[capture] recording ${filename} → pending (Library Drive offline); will flush on reconnect`);
  }

  broadcast('capture:completed', {
    kind: 'recording',
    filePath: outPath,
    filename,
    fileId,
    pending: !libRoot,
    width,
    height,
  });
  return { success: true, filePath: outPath, filename, fileId, pending: !libRoot };
}

async function finalizeRecording(): Promise<void> {
  const webmPath = recordTempPath;
  const startedAt = recordStartedAt ?? new Date();
  const meta = recordMeta;
  // Close the widget + stream, keep the temp file.
  if (recordWidget && !recordWidget.isDestroyed()) {
    try { recordWidget.close(); } catch { /* non-fatal */ }
  }
  recordWidget = null;
  recordingState = 'processing';
  broadcastRecordingState();
  if (recordStream) {
    const stream = recordStream;
    recordStream = null;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }
  recordTempPath = null;
  recordStartedAt = null;
  recordDisplay = null;

  try {
    if (!webmPath || !fs.existsSync(toLongPath(webmPath)) || fs.statSync(toLongPath(webmPath)).size === 0) {
      log.warn('[capture] recording produced no data — nothing to save');
      return;
    }
    const mp4Path = await transcodeWebmToMp4(webmPath, RECORD_QUALITY[recordQuality].crf);
    if (mp4Path) {
      try { fs.unlinkSync(toLongPath(webmPath)); } catch { /* non-fatal */ }
      await persistRecording(mp4Path, startedAt, meta.width, meta.height);
    } else {
      // FFmpeg unavailable/failed — persist the WebM itself rather
      // than lose the recording.
      await persistRecording(webmPath, startedAt, meta.width, meta.height);
    }
  } catch (err) {
    log.warn(`[capture] recording finalize failed: ${(err as Error).message}`);
    broadcast('capture:recordError', { message: (err as Error).message });
  } finally {
    recordingState = 'idle';
    broadcastRecordingState();
  }
}

// Widget → main channels. Sender-pinned to the live widget.
ipcMain.on('capture:record-chunk', (event, chunk: ArrayBuffer | Uint8Array) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents && recordStream) {
    try { recordStream.write(Buffer.from(chunk as ArrayBuffer)); } catch { /* non-fatal */ }
  }
});
ipcMain.on('capture:record-started', (event, info: { width?: number; height?: number; hasAudio?: boolean }) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents) {
    recordMeta = { width: info?.width ?? null, height: info?.height ?? null, hasAudio: !!info?.hasAudio };
    log.info(`[capture] recorder running ${recordMeta.width}×${recordMeta.height}, audio: ${recordMeta.hasAudio ? 'yes' : 'no'}`);
  }
});
ipcMain.on('capture:record-stopped', (event) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents) {
    void finalizeRecording();
  }
});
ipcMain.on('capture:record-cancelled', (event) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents) {
    log.info('[capture] recording cancelled by user — discarded');
    teardownRecording({ discardTemp: true });
  }
});
ipcMain.on('capture:record-error', (event, info: { message?: string }) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents) {
    log.warn(`[capture] recorder error: ${info?.message ?? 'unknown'}`);
    broadcast('capture:recordError', { message: info?.message ?? 'Recording failed.' });
    teardownRecording({ discardTemp: true });
  }
});
// Round 126 — Snap button on the widget: a still of the recorded
// display, taken mid-recording WITHOUT hiding PDR's windows (a
// hide/restore would blip INSIDE the recording; what's on screen is
// by definition what the user is recording). The widget itself is
// content-protected, so it appears in neither the recording nor the
// snap. Lands through the normal screenshot pipeline → toast →
// indexed → S&D Captures.
ipcMain.on('capture:record-snap', (event) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const display = recordDisplay;
  if (!display || recordingState !== 'recording') return;
  void (async () => {
    try {
      const capturedAt = new Date();
      const grab = await grabDisplayPng(display, { hideWindows: false });
      if (!grab) {
        log.warn('[capture] mid-recording snap failed: could not grab display');
        return;
      }
      grab.restore(); // no-op (nothing hidden) — keeps the contract
      await persistCapture(grab.buffer, capturedAt, grab.width, grab.height, 'screenshot');
    } catch (err) {
      log.warn(`[capture] mid-recording snap failed: ${(err as Error).message}`);
    }
  })();
});

/** App-quit safety: flush the temp WebM so the startup orphan
 *  recovery can transcode + index it on next launch. */
export function flushRecordingOnQuit(): void {
  if (recordStream) {
    try { recordStream.end(); } catch { /* non-fatal */ }
    recordStream = null;
  }
}

/**
 * Startup recovery — any rec-*.webm left in Captures-temp means a
 * recording was live when PDR quit or crashed. Transcode + land it
 * rather than silently losing the user's one-shot moment. The start
 * timestamp comes back out of the temp filename.
 */
export async function recoverOrphanRecordings(): Promise<number> {
  const dir = recordTempDir();
  if (!fs.existsSync(dir)) return 0;
  if (recordingState !== 'idle') return 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => /^rec-.*\.webm$/i.test(f));
  } catch {
    return 0;
  }
  let recovered = 0;
  for (const name of entries) {
    try {
      const full = path.join(dir, name);
      if (fs.statSync(toLongPath(full)).size === 0) {
        try { fs.unlinkSync(toLongPath(full)); } catch { /* non-fatal */ }
        continue;
      }
      const m = name.match(/^rec-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
      const startedAt = m
        ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
        : fs.statSync(toLongPath(full)).mtime;
      const mp4Path = await transcodeWebmToMp4(full);
      if (mp4Path) {
        try { fs.unlinkSync(toLongPath(full)); } catch { /* non-fatal */ }
        await persistRecording(mp4Path, startedAt, null, null);
      } else {
        await persistRecording(full, startedAt, null, null);
      }
      recovered++;
      log.info(`[capture] recovered orphaned recording ${name}`);
    } catch (err) {
      log.warn(`[capture] orphan recording recovery failed for ${name} (left in place): ${(err as Error).message}`);
    }
  }
  return recovered;
}
