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
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import log from 'electron-log/main.js';
import { toLongPath } from './long-path.js';
import { getLibraryStatus } from './library-sidecar.js';
import { getSettings, setSetting } from './settings-store.js';
import { indexCapturedFile } from './search-database.js';
import { trialCapReached, bumpTrialUsage } from './trial-gate.js';
import { FREE_COLLAGE_LIMIT, FREE_CAROUSEL_LIMIT, FREE_SCREENSHOT_LIMIT, FREE_RECORDING_LIMIT } from './usage-tracker.js';
// v3.0 round 411 (Terry) — global mouse hook for click-ripple. N-API (ABI-stable
// across Electron, no rebuild); the .node binary needs asarUnpack when packaging.
import { uIOhook } from 'uiohook-napi';

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
async function stampCaptureMetadata(filePath: string, capturedAt: Date, kindLabel: string = 'screenshot', caption?: string, title?: string): Promise<void> {
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
      // v2.1 round 363 (Terry) — write the collage's project NAME into the standard caption tags so
      // it TRAVELS with the exported file (EXIF ImageDescription + IPTC + XMP dc:description), the same
      // fields PDR uses for user captions.
      if (caption && caption.trim()) {
        const _cap = caption.trim();
        tags['EXIF:ImageDescription'] = _cap;
        tags['IPTC:Caption-Abstract'] = _cap;
        tags['XMP-dc:Description'] = _cap;
      }
      // v2.1 round 364 (Terry) — the collage's NAME is a PSEUDONYM (separate from the caption note); write
      // it to the TITLE tags so it travels with the file + can be shown next to the filename in the Albums
      // caption dialog.
      if (title && title.trim()) {
        const _tit = title.trim();
        tags['XMP-dc:Title'] = _tit;
        tags['IPTC:ObjectName'] = _tit;
        tags['XPTitle'] = _tit;
      }
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
  // Round 130 (Terry) — the picker must mirror the PHYSICAL desk:
  // his left monitor was showing on the right because
  // getAllDisplays() enumerates in arbitrary order. Windows already
  // knows the arrangement (every display's virtual-desktop origin),
  // so sort by position — left → right, ties top → bottom — and
  // label by POSITION rather than enumeration number. If this still
  // reads backwards for a user, their Windows display arrangement
  // itself is swapped (Settings → System → Display) and fixing it
  // there fixes every app at once.
  const displays = [...screen.getAllDisplays()].sort((a, b) =>
    a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y,
  );
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 320 },
  });
  // Positional fallback for blank display_ids must use Electron's
  // ORIGINAL enumeration order (that's what sources align to).
  const enumOrder = screen.getAllDisplays();
  return displays.map((d, i) => {
    const source =
      sources.find((s) => s.display_id === String(d.id)) ??
      sources[enumOrder.findIndex((e) => e.id === d.id)];
    const positionName =
      displays.length === 2
        ? (i === 0 ? 'Left display' : 'Right display')
        : displays.length === 1
          ? 'Display'
          : `Display ${i + 1} (left to right)`;
    return {
      id: String(d.id),
      label: `${positionName}${d.id === screen.getPrimaryDisplay().id ? ' (primary)' : ''} — ${Math.round(d.bounds.width * d.scaleFactor)}×${Math.round(d.bounds.height * d.scaleFactor)}`,
      width: Math.round(d.bounds.width * d.scaleFactor),
      height: Math.round(d.bounds.height * d.scaleFactor),
      isPrimary: d.id === screen.getPrimaryDisplay().id,
      thumbnailDataUrl: source ? source.thumbnail.toDataURL() : '',
    };
  });
}

/**
 * Round 131 — the desktopCapturer source for one display (its id is
 * what the widget's getUserMedia needs). Thumbnails irrelevant here,
 * so request 1×1. Falls back to the sole source when display_ids are
 * blank (some Windows configs).
 */
async function getDisplaySource(display: Electron.Display): Promise<Electron.DesktopCapturerSource | null> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  return (
    sources.find((s) => s.display_id === String(display.id)) ??
    (sources.length === 1 ? sources[0] : null)
  );
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

// ─── v2.1 round 303→306 (Terry) — collage "Take screenshot" = PREPARE → REGION ──
// Evolution: 303 grabbed a whole window (wrong — wanted just a picture in it); 304
// switched to a region grab but froze the CURRENT screen, so you couldn't first get
// to the right window/tab; 306 (Terry's pick) splits it in two — PREPARE then CAPTURE:
//   1) PREPARE — minimise the collage window + float a small "Capture region" bar so
//      the user can freely switch to the exact window and tab they want.
//   2) CAPTURE — on the bar's button, freeze that screen + run the SAME region overlay
//      as the title-bar Capture region (drag a box, click-a-window snap), crop, and add
//      the crop to the collage. The crop is a collage ingredient (NOT added to Library).
let prepBarWindow: BrowserWindow | null = null;
let prepResolve: ((go: boolean) => void) | null = null;
let prepMinimized: BrowserWindow | null = null;   // the collage window we minimised, to restore after

function closePrepBar(): void {
  if (prepBarWindow && !prepBarWindow.isDestroyed()) { try { prepBarWindow.close(); } catch { /* non-fatal */ } }
  prepBarWindow = null;
}
function restorePrepWindow(): void {
  // v2.1 round 312 (Terry) — Capture OR Cancel must both bring the collage straight back to the
  // FRONT. show()+focus() alone can leave it un-hidden but occluded (Windows blocks a background
  // app from taking the foreground), so use the always-on-top flip — set topmost, show/focus,
  // then drop topmost — which forces it above other windows without needing foreground rights.
  if (prepMinimized && !prepMinimized.isDestroyed()) {
    const w = prepMinimized;
    try {
      if (w.isMinimized()) w.restore();
      w.show();
      w.setAlwaysOnTop(true);
      w.focus();
      w.setAlwaysOnTop(false);
    } catch { /* non-fatal */ }
  }
  prepMinimized = null;
}

// v2.1 round 313 (Terry) — SHARED region-capture flow, used by BOTH the collage chevron and the
// title-bar "Capture region" (Terry: the title-bar one should match the collage one — no separate
// "which screen?" step). Hide the calling window so the user can navigate, float the prep bar,
// then the LIVE per-monitor overlay → drag/adjust → grab the chosen display → crop. Returns the
// cropped PNG + dims (or cancelled/error); callers persist it differently (collage tile vs Library).
async function regionCaptureWithPrep(
  callingWin: BrowserWindow | null,
): Promise<{ buffer: Buffer; width: number; height: number } | { cancelled: true } | { error: string }> {
  if (captureInFlight || prepBarWindow) return { error: 'A screenshot is already being set up.' };
  // ── PHASE 1: PREPARE ── hide the calling window so the user can navigate, then wait for
  // Capture/Cancel on the floating bar. HIDE (not minimise) — minimize/restore left it stuck on
  // Cancel; hide/show + the always-on-top flip reliably brings it back (round 312).
  prepMinimized = callingWin && !callingWin.isDestroyed() ? callingWin : null;
  if (prepMinimized) { try { prepMinimized.hide(); } catch { /* non-fatal */ } }
  const go = await new Promise<boolean>((resolve) => {
    prepResolve = resolve;
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const W = 470, H = 70;
    const bx = Math.round(disp.bounds.x + (disp.bounds.width - W) / 2);
    const by = Math.round(disp.bounds.y + disp.bounds.height - H - 56);
    const bar = new BrowserWindow({
      x: bx, y: by, width: W, height: H, frame: false, transparent: true, resizable: false,
      movable: true, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'capture-mini-preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    prepBarWindow = bar;
    try { bar.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
    bar.once('closed', () => { const r = prepResolve; prepResolve = null; prepBarWindow = null; if (r) r(false); });
    bar.webContents.once('did-finish-load', () => { if (!bar.isDestroyed()) bar.showInactive(); });
    void bar.loadFile(path.join(__dirname, '../dist/public/capture-prep-bar.html'));
  });
  closePrepBar();
  if (!go) { restorePrepWindow(); return { cancelled: true }; }
  // ── PHASE 2: CAPTURE ── live per-monitor overlay (round 311 — one window PER screen, so the
  // 2nd monitor works and there's no "which screen?" step) → drag/adjust → grab + crop.
  captureInFlight = true;
  try {
    await sleep(160);   // let the prep bar fully disappear first
    const picked = await openMultiDisplayOverlay({ adjustable: true });
    if (!picked) { restorePrepWindow(); return { cancelled: true }; }
    const { rect, display } = picked;
    const grab = await grabDisplayPng(display, { hideWindows: false });
    if (!grab) { restorePrepWindow(); return { error: 'Could not capture the screen.' }; }
    grab.restore();
    const scaleX = grab.width / display.bounds.width, scaleY = grab.height / display.bounds.height;
    const x = Math.max(0, Math.min(grab.width - 1, Math.round(rect.x * scaleX)));
    const y = Math.max(0, Math.min(grab.height - 1, Math.round(rect.y * scaleY)));
    const width = Math.max(1, Math.min(grab.width - x, Math.round(rect.width * scaleX)));
    const height = Math.max(1, Math.min(grab.height - y, Math.round(rect.height * scaleY)));
    const cropped = nativeImage.createFromBuffer(grab.buffer).crop({ x, y, width, height });
    if (cropped.isEmpty()) { restorePrepWindow(); return { error: 'The selected area was empty.' }; }
    restorePrepWindow();   // bring the calling window back to the front
    return { buffer: cropped.toPNG(), width, height };
  } catch (err) {
    restorePrepWindow();
    log.warn(`[capture] region capture failed: ${(err as Error).message}`);
    return { error: (err as Error).message };
  } finally {
    captureInFlight = false;
  }
}

// v3.0 round 559 (Terry) — save an arbitrary image (a webcam still) into the library exactly like a
// screenshot: PDR Captures, indexed, _SS suffix, broadcast. Returns the new library fileId so Trees
// can attach it as a person's face. (The screen-region path uses the existing captureRegion, which
// already persists + returns a fileId — everything lands in the library, per Terry.)
export async function saveCapturedImageToLibrary(
  dataUrl: string,
): Promise<CaptureScreenshotResult> {
  try {
    const m = /^data:image\/\w+;base64,(.+)$/.exec(dataUrl || '');
    if (!m) return { success: false, error: 'Invalid image data.' };
    const buffer = Buffer.from(m[1], 'base64');
    const img = nativeImage.createFromBuffer(buffer);
    const size = img.isEmpty() ? { width: null as number | null, height: null as number | null } : img.getSize();
    // Normalise to PNG bytes so persistCapture's format branch behaves like a screenshot.
    const png = img.isEmpty() ? buffer : img.toPNG();
    return await persistCapture(png, new Date(), size.width, size.height, 'screenshot');
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function captureCollageRegion(
  callingWin: BrowserWindow | null,
): Promise<{ success: boolean; filePath?: string; cancelled?: boolean; error?: string }> {
  const r = await regionCaptureWithPrep(callingWin);
  if ('cancelled' in r) return { success: false, cancelled: true };
  if ('error' in r) return { success: false, error: r.error };
  // Persist as a collage ingredient (not the Library).
  const dir = path.join(app.getPath('userData'), 'collage-captures');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* non-fatal */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `Screenshot_${stamp}.png`);
  fs.writeFileSync(toLongPath(filePath), r.buffer);
  return { success: true, filePath };
}

ipcMain.handle('collage:captureRegion', async (event) => {
  return await captureCollageRegion(BrowserWindow.fromWebContents(event.sender) || null);
});
// Floating prep-bar buttons resolve PHASE 1.
ipcMain.on('collage:prepCapture', () => { const r = prepResolve; prepResolve = null; if (r) r(true); });
ipcMain.on('collage:prepCancel', () => { const r = prepResolve; prepResolve = null; if (r) r(false); });

// ─── Region selection overlay ────────────────────────────────────────────────

let overlayWindow: BrowserWindow | null = null;
let overlayResolve: ((rect: SelectionRect | null) => void) | null = null;

// v2.1 round 311 (Terry) — MULTI-DISPLAY region capture: one overlay window PER monitor.
// Round 310's single window spanning all monitors didn't work — Terry couldn't select on his
// 2nd screen and the capture hung (a transparent window spanning displays is unreliable on
// Windows, esp. mixed VGA/DVI). Each window is single-screen; whichever one the user draws on
// wins, and the rect comes back in that display's own CSS pixels.
let multiOverlayWins: Array<{ win: BrowserWindow; display: Electron.Display }> = [];
let multiOverlayResolve: ((r: { rect: SelectionRect; display: Electron.Display } | null) => void) | null = null;

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

/** Resolve the multi-display overlay once and close EVERY per-monitor window. */
function finishMultiOverlay(result: { rect: SelectionRect; display: Electron.Display } | null): void {
  const resolve = multiOverlayResolve;
  multiOverlayResolve = null;
  const wins = multiOverlayWins;
  multiOverlayWins = [];
  for (const w of wins) { if (!w.win.isDestroyed()) { try { w.win.close(); } catch { /* non-fatal */ } } }
  if (resolve) resolve(result);
}

// Selection events from the overlay page. Registered once at module
// load; the sender check pins them to the live overlay so a stale or
// spoofed renderer can't complete someone else's selection.
ipcMain.on('capture:overlay-select', (event, rect: SelectionRect) => {
  if (overlayWindow && !overlayWindow.isDestroyed() && event.sender === overlayWindow.webContents) {
    finishOverlay(rect && rect.width >= 1 && rect.height >= 1 ? rect : null);
    return;
  }
  const m = multiOverlayWins.find((w) => !w.win.isDestroyed() && w.win.webContents === event.sender);
  if (m && rect && rect.width >= 1 && rect.height >= 1) finishMultiOverlay({ rect, display: m.display });
});
ipcMain.on('capture:overlay-cancel', (event) => {
  if (overlayWindow && !overlayWindow.isDestroyed() && event.sender === overlayWindow.webContents) {
    finishOverlay(null);
    return;
  }
  if (multiOverlayWins.some((w) => !w.win.isDestroyed() && w.win.webContents === event.sender)) finishMultiOverlay(null);
});

/**
 * Open a LIVE region overlay on EVERY display (one window each) and resolve with the rect +
 * the display it was drawn on. No blur-cancel (the windows cover every screen, so moving the
 * cursor between them would otherwise self-cancel); Esc on any window cancels them all.
 */
function openMultiDisplayOverlay(opts: { adjustable?: boolean }): Promise<{ rect: SelectionRect; display: Electron.Display } | null> {
  return new Promise((resolve) => {
    multiOverlayResolve = resolve;
    multiOverlayWins = [];
    const displays = screen.getAllDisplays();
    const cursorDisp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    displays.forEach((d) => {
      const win = new BrowserWindow({
        x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
        frame: false, show: false, transparent: true, backgroundColor: '#00000000',
        resizable: false, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
        webPreferences: { preload: path.join(__dirname, 'capture-mini-preload.js'), contextIsolation: true, nodeIntegration: false },
      });
      try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
      try { win.setContentProtection(true); } catch { /* non-fatal */ }
      win.setMenu(null);
      const localWindows = enumerateWindowRectsForDisplay(d);
      multiOverlayWins.push({ win, display: d });
      win.webContents.once('did-finish-load', () => {
        if (win.isDestroyed()) return;
        win.webContents.send('capture:overlay-init', { live: true, adjustable: opts.adjustable === true, windows: localWindows });
        if (d.id === cursorDisp.id) { win.show(); win.focus(); } else { win.showInactive(); }
      });
      // If a window is closed externally and they're ALL gone with nothing selected, cancel.
      win.on('closed', () => {
        if (multiOverlayResolve && multiOverlayWins.every((w) => w.win.isDestroyed())) finishMultiOverlay(null);
      });
      void win.loadFile(path.join(__dirname, '../dist/public/capture-overlay.html'));
    });
  });
}

/**
 * Frameless always-on-top window covering the target display, showing
 * the frozen frame with the drag-to-select veil. Resolves with the
 * selection rect in the display's CSS pixels, or null on cancel.
 */
function openRegionOverlay(
  display: Electron.Display,
  frozenDataUrl: string | null,
  windows: SelectionRect[],
  onShown?: () => void,
  opts?: { live?: boolean; adjustable?: boolean },
): Promise<SelectionRect | null> {
  // Round 131 (Terry) — LIVE mode: a transparent dimming veil over
  // the real desktop instead of a pasted frozen screenshot. The
  // frozen-image overlay showed the captured taskbar on TOP of the
  // real Windows taskbar — "two taskbars", disorienting. Recording
  // area-selection doesn't need a frozen frame (the recording grabs
  // live later), so it uses live mode; screenshot region capture
  // still freezes (it must capture that exact instant).
  const live = opts?.live === true;
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
      transparent: live,
      backgroundColor: live ? '#00000000' : '#000000',
      webPreferences: {
        preload: path.join(__dirname, 'capture-mini-preload.js'),   // round 312 — tiny preload, loads instantly
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    overlayWindow = win;
    // screen-saver level floats above fullscreen apps and the taskbar.
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
    // Round 127 — excluded from capture. Matters for the mid-recording
    // Blur selector (the overlay must never leak into the footage if
    // the recorder is still draining); harmless for the screenshot
    // flow, whose grab happens before this window exists.
    try { win.setContentProtection(true); } catch { /* non-fatal */ }
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
      win.webContents.send('capture:overlay-init', { imageDataUrl: frozenDataUrl, windows, live, adjustable: opts?.adjustable === true });
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
 * Region screenshot to the Library. v2.1 round 313 (Terry) — now uses the SAME flow as the
 * collage chevron: hide PDR so you can navigate, a floating "Capture region" bar, then a LIVE
 * per-monitor overlay (every screen at once — no "which screen?" picker) with Lightshot-style
 * adjustable handles. Only the destination differs from the collage (the Library, via
 * persistCapture). The old frozen-frame + display-picker path is gone.
 */
export async function captureRegion(_opts: {
  displayId?: string;
  trigger: 'button' | 'hotkey';
}): Promise<CaptureScreenshotResult> {
  void flushPendingCaptures().catch((err) =>
    log.warn(`[capture] inline pending flush failed (non-fatal): ${(err as Error).message}`),
  );
  // Hide the focused PDR window during the prep step (the title-bar button → the main window;
  // a hotkey fired over a non-PDR window → null, so nothing of ours to hide).
  const r = await regionCaptureWithPrep(BrowserWindow.getFocusedWindow());
  if ('cancelled' in r) { log.info('[capture] region selection cancelled'); return { success: false, cancelled: true }; }
  if ('error' in r) return { success: false, error: r.error };
  return await persistCapture(r.buffer, new Date(), r.width, r.height, 'region');
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

// ─── Collage (v2.1 round 138, Terry 2026-06-12) ──────────────────────────────
//
// v2.1 round 139 (Terry 2026-06-12) - the old grid-collage composer
// window (collage.html + createCollage + collage:open/create/close) was
// retired here. "Create collage" now opens the chosen photos straight
// into PDRV's freeform editor (search:openViewer with the collage flag);
// the editor sends a layout to collage:saveLayout below, which composites
// the full-resolution originals with sharp.

// v2.1 round 139 (Terry) — save a FREEFORM collage the PDRV editor
// laid out. The renderer sends a resolution-independent layout (each
// photo's fractional position/size/rotation on the canvas); we
// composite the FULL-RESOLUTION originals here with sharp (not the
// on-screen thumbnails — premium quality, and it sidesteps the
// canvas-taint the pdr-file:// protocol would cause if we rendered
// the export in the renderer). Lands as a born-in-PDR _CO file and
// indexes it like a capture, so the user can then enhance it with
// the normal Looks / Frames / sliders.
// v2.1 round 140 (Terry) — per-tile enhancement. Each collage photo can
// carry its own Enhance state (the same set PDRV's side panel exposes),
// so one tile can be high-contrast + red-framed while another is B&W.
interface CollageEnhance {
  brightness?: number; contrast?: number; saturation?: number; temperature?: number;
  colour?: number; // v2.1 round 152 — 0..100, 100 = full colour, 0 = B&W
  flipH?: boolean; flipV?: boolean; // v2.1 round 155 — mirror / flip
  tone?: 'none' | 'sepia' | 'vintage'; borderColor?: string; borderWeight?: 'thin' | 'mat'; borderPct?: number;
  opacity?: number; // v2.1 round 143 — per-tile transparency (0.1–1)
  blend?: number; // v2.1 round 150 — edge feather %, 0–100 (0 = crisp)
  corners?: number[]; // v2.1 round 164 — curved corners [tl,tr,br,bl], 0–1 of half the short side
  vignette?: number; // v2.1 round 294 — PER-PHOTO vignette 0..100
  vignetteShape?: string; // v2.1 round 294 — vignette shape (ellipse/heart/star/…)
  grain?: number; // v2.1 round 294 — PER-PHOTO film grain 0..150
  blur?: number; // v2.1 round 327 — PER-PHOTO blur 0..100
  pixelate?: number; // v2.1 round 327 — PER-PHOTO pixelate 0..100
  // v2.1 round 341 — PER-PHOTO Glow & shadow edge/depth effects (0..100) + their colours (hex).
  glow?: number; dropShadow?: number; lift?: number; neon?: number; outline?: number;
  glowColor?: string; dropShadowColor?: string; liftColor?: string; neonColor?: string; outlineColor?: string;
}
// v2.1 round 164 (Terry) — CURVED CORNERS + Blend, in one rounded-rect
// signed-distance mask. corners = [tl,tr,br,bl] (0–1 of half the short side);
// blend 0–100 widens the feather band inward from the rounded boundary so the
// (rounded) edge melts away with no straight rectangle edge left. The formula
// is IDENTICAL to the live preview (viewer.html applyShapeMask) so the saved
// file matches the editor. dest-in keeps any existing alpha (frame / fade).
async function roundedFeatherMask(sharp: any, buf: Buffer, w: number, h: number, corners?: number[], blend?: number): Promise<Buffer> {
  const b = Math.max(0, Math.min(100, blend || 0));
  const c = Array.isArray(corners) ? corners : [0, 0, 0, 0];
  const hasCorner = c.some((v) => (v || 0) > 0.001);
  if ((b <= 0 && !hasCorner) || w < 2 || h < 2) return buf;
  const minD = Math.min(w, h);
  const radii = [c[0], c[1], c[2], c[3]].map((v) => Math.max(0, Math.min(1, v || 0)) * minD / 2);
  const featherPx = Math.max(0.75, (b / 100) * 0.45 * minD);
  const cx = w / 2, cy = h / 2;
  const mask = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const r = (px < cx) ? (py < cy ? radii[0] : radii[3]) : (py < cy ? radii[1] : radii[2]);
      const qx = Math.abs(px - cx) - (cx - r);
      const qy = Math.abs(py - cy) - (cy - r);
      const sdf = Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
      mask[(y * w + x) * 4 + 3] = Math.round(Math.max(0, Math.min(1, -sdf / featherPx)) * 255);
    }
  }
  const maskPng = await sharp(mask, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return await sharp(buf).ensureAlpha().composite([{ input: maskPng, blend: 'dest-in' }]).png().toBuffer();
}
interface CollageLayout {
  // v2.1 round 142 (Terry) — bgImage: an optional library photo used as
  // the canvas backdrop, faded over the solid bg colour at `opacity`
  // (same idea as the Trees canvas background).
  // v2.1 round 235 (Terry) — gradient: an optional GRADIENT backdrop (phase 1 of
  // "Background textures"). Mutually exclusive with transparent + bgImage (the
  // editor clears those when a gradient is chosen). Rasterized to an SVG at W×H and
  // composited as the BOTTOM layer, matching the editor's CSS gradient preview.
  //   kind  — 'linear' | 'radial' | 'mesh'
  //   angle — CSS linear-gradient angle in degrees (0 = to top, 90 = to right); linear only
  //   stops — [{ color:'#rrggbb', pos:0..100 }, ...]  (linear/radial)
  // v2.1 round 239 (Terry) — MESH: a base colour + several soft colour "blobs"
  //   (radial-gradient circles fading to transparent), the standard CSS mesh look.
  //   base  — '#rrggbb' painted first; blobs — [{ color, x, y, r }] with x/y the blob
  //   centre and r the falloff radius, all in % of the canvas. Baked by
  //   buildCollageMeshSvg (base rect + one radial per blob, same stacking as the CSS).
  // v2.1 round 238 (Terry) — vignette/grain: WHOLE-COLLAGE finishing treatments
  // (0..100; absent/0 = off), composited as the TOP layer over the finished collage
  // (tiles + bg + text), independent of the bg kind. See buildCollageVignetteSvg /
  // buildCollageGrainSvg + the composite block in collage:saveLayout.
  // v2.1 round 244 (Terry) — `texture`: an optional close-up MATERIAL SURFACE backdrop
  // (brick face / wood grain / concrete / leather / marble / …). Mutually exclusive with
  // gradient + transparent + bgImage (the editor clears those when a texture is chosen).
  // Baked from the SAME full-canvas feTurbulence surface SVG the editor previews
  // (buildCollageTextureSvg, mirroring the renderer's COLLAGE_TEXTURES) at W×H and
  // composited as the BOTTOM layer.
  canvas: { w: number; h: number; bg: string; transparent?: boolean; bgImage?: { path: string; opacity: number; enh?: CollageEnhance }; gradient?: { kind: 'linear' | 'radial' | 'mesh'; angle?: number; stops?: Array<{ color: string; pos: number }>; base?: string; blobs?: Array<{ color: string; x: number; y: number; r: number }> }; texture?: { id: string }; vignette?: number; vignetteShape?: string; grain?: number };
  // v2.1 round 263 (Terry) — bg-tile: `coverFill` marks a tile that reads as a
  // BACKGROUND — the photo is cover-fit into its box (the box = whole canvas at
  // the locked full-canvas default, or the user's resized rectangle once unlocked)
  // rather than the box being shaped to the photo. `aspect` for a coverFill item is
  // the BOX aspect (the renderer sends effectiveAspect = box aspect), so the bake
  // sizes the tile to wFrac×(wFrac/aspect) and resizes the source with fit:'cover'
  // (no crop/zoom). Mutually exclusive per saved layout with canvas.bgImage (legacy).
  items: Array<{ path: string; bgRemoved?: boolean; coverFill?: boolean; xFrac: number; yFrac: number; wFrac: number; aspect: number; rot: number; zoom?: number; panX?: number; panY?: number; enh?: CollageEnhance; crop?: { l: number; t: number; r: number; b: number } }>;
  // v2.1 round 185 (Text #1) — text layers rendered to transparent PNGs in the
  // renderer (the SAME canvas render that drives the on-screen preview), so the
  // text lands at the same relative position + size here and sharp never renders
  // text (no font dependency). pngBase64 is a data URL (or bare base64); xFrac/
  // yFrac are the layer CENTRE in canvas fractions; rot in degrees.
  texts?: Array<{ pngBase64: string; xFrac: number; yFrac: number; rot: number }>;
}
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return { r: 255, g: 255, b: 255 };
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
// v2.1 round 266 (Terry) — oversized tiles: a collage/carousel tile may be LARGER
// than the page (Canva-style), so the bake's wFrac ceiling rises from 1 to 4× the
// (wide) canvas width. Content is still clipped to each page by the final extract;
// the PAD below is bounded by each tile's real OFF-PAGE OVERHANG (not its full 4×
// extent) so the composite base never balloons. Must match viewer.html's client
// resize ceiling (Phase 3).
const TILE_WFRAC_MAX = 4;
// v2.1 round 266 (Terry) — oversized tiles travel off-page, so the box TOP-LEFT
// fraction is clamped to a WIDE window (not [0,1]) — far enough that a tile up to
// TILE_WFRAC_MAX× can sit fully above/left/below/right of the page yet still
// composite at its true position. The final per-tile safety clamp (~L1527) keeps the
// placed bbox inside the PAD-expanded base. Used by BOTH the PAD pre-scan and the
// composite loop so cx/cy agree exactly. (clamp01 is still used for crop rects etc.)
const clampTileX = (n: number) => (Number.isFinite(n) ? Math.max(-TILE_WFRAC_MAX, Math.min(1 + TILE_WFRAC_MAX, n)) : 0);
const clampTileY = (n: number) => (Number.isFinite(n) ? Math.max(-TILE_WFRAC_MAX, Math.min(1 + TILE_WFRAC_MAX, n)) : 0);
// v2.1 round 266 (Terry) — OOM BACKSTOP. wFrac is a fraction of the WHOLE wide
// carousel canvas, so TILE_WFRAC_MAX× on a 10-page strip (W≈10800) could be a
// ~43000px raster (multi-GB) and crash the bake at toBuffer(). This is a pure
// crash-guard, NOT a feature: it is a guaranteed no-op for every realistic
// "bigger than the pages" size (a 2× tile on the 6-page panorama = 12960px, well
// under the cap) and only clamps genuinely pathological rasters (>16000px in a
// dimension, i.e. wFrac beyond ~1.5× the entire multi-page strip). At those
// extreme sizes the tile is shrunk to the cap (a small position shift), which is
// always preferable to losing the user's save to an out-of-memory crash.
const MAX_TILE_PX = 16000;
const capTilePx = (n: number) => Math.min(n, MAX_TILE_PX);

// v2.1 round 237 (Terry) — CSS colour-HINT (midpoint) sampling. A bare percentage
// token between two colour stops in a CSS gradient — `c0 0%, H%, c1 100%` — is NOT
// the linear midpoint: it's the point where the two colours mix 50/50, with a
// NON-LINEAR power ease either side of it. A 2-stop SVG <linearGradient> can't
// reproduce that curve, so the bake must SAMPLE the eased colour at many positions
// and emit them as explicit stops. This returns an array of { off:0..1, color } for
// ONE hinted segment between (a, posA) and (b, posB) with the hint at absolute
// position `hintPos` (all positions on the SAME 0..1 scale as the segment ends).
//
// CSS midpoint formula (per the spec / every browser): within the segment, let the
// hint's fractional position be H = (hintPos − posA)/(posB − posA), clamped to
// (0,1). For a sample at segment-fraction x∈[0,1], the colour-mix weight is
//   t = x ^ (ln 0.5 / ln H)
// so that at x = H, t = 0.5 (the colours are exactly half-mixed at the hint), and
// the ease is faster on one side than the other. We mix in sRGB (what CSS does for
// these legacy hex gradients), matching the on-screen preview.
function sampleCssHintSegment(
  a: { r: number; g: number; b: number }, posA: number,
  b: { r: number; g: number; b: number }, posB: number,
  hintPos: number,
  samples: number,
): Array<{ off: number; color: string }> {
  const span = posB - posA;
  // Degenerate segment → just the two endpoints.
  if (!(Math.abs(span) > 1e-6)) {
    return [{ off: posA, color: rgbToHex(a) }, { off: posB, color: rgbToHex(b) }];
  }
  let H = (hintPos - posA) / span;
  H = Math.max(0.001, Math.min(0.999, H));
  // Exponent so that x^exp == 0.5 at x == H.
  const exp = Math.log(0.5) / Math.log(H);
  const out: Array<{ off: number; color: string }> = [];
  const N = Math.max(2, samples);
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);                 // 0..1 across the segment
    const t = Math.pow(x, exp);            // eased mix weight
    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const bl = Math.round(a.b + (b.b - a.b) * t);
    out.push({ off: posA + span * x, color: rgbToHex({ r, g, b: bl }) });
  }
  return out;
}
function rgbToHex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}

// v2.1 round 235 (Terry) — build an SVG that reproduces the editor's CSS gradient
// at the OUTPUT resolution, so the baked background matches the preview exactly.
//
// CSS-angle ↔ SVG-vector mapping (the tricky bit — they differ):
//   • CSS `linear-gradient(Adeg, …)`: 0deg points to the TOP, increasing CLOCKWISE
//     (90deg = right, 180deg = bottom). The gradient line passes through the box
//     centre; CSS sizes it so the 0% / 100% stops sit on the lines through the two
//     corners the gradient line is perpendicular to (the "magic" gradient-line
//     length L = |W·sinθ| + |H·cosθ|). To match this on a NON-SQUARE canvas we must
//     work in pixel space (gradientUnits="userSpaceOnUse"), NOT objectBoundingBox
//     (which would skew the visual angle by the aspect ratio).
//     Direction unit vector for CSS angle θ: dir = (sinθ, −cosθ) — note the −cos,
//     because SVG/CSS y grows DOWNWARD while CSS angle 0deg points up. Endpoints:
//       start(0%) = centre − dir·(L/2),  end(100%) = centre + dir·(L/2).
//   • CSS `radial-gradient(circle at center, …)` defaults to farthest-corner: a
//     circle centred on the box with radius = distance centre→farthest corner =
//     hypot(W/2, H/2). SVG radialGradient with userSpaceOnUse cx/cy/r does the same.
function buildCollageGradientSvg(
  W: number,
  H: number,
  gradient: { kind: 'linear' | 'radial'; angle?: number; stops: Array<{ color: string; pos: number }> },
): string {
  // Sanitize stops (valid hex + clamped pos), sorted by position.
  const stops = (gradient.stops || [])
    .map((s) => ({
      color: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(s.color || '')) ? String(s.color) : '#ffffff',
      pos: Math.max(0, Math.min(100, Number(s.pos) || 0)),
    }))
    .sort((a, b) => a.pos - b.pos);
  if (stops.length < 2) {
    const only = stops[0] ? stops[0].color : '#ffffff';
    stops.length = 0;
    stops.push({ color: only, pos: 0 }, { color: only, pos: 100 });
  }
  const stopTags = stops
    .map((s) => `<stop offset="${s.pos}%" stop-color="${s.color}"/>`)
    .join('');

  let defs: string;
  if (gradient.kind === 'radial') {
    const cx = W / 2, cy = H / 2;
    const r = Math.hypot(W / 2, H / 2);   // farthest-corner radius
    defs = `<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">${stopTags}</radialGradient>`;
  } else {
    const theta = ((Number.isFinite(gradient.angle) ? (gradient.angle as number) : 135) * Math.PI) / 180;
    const dx = Math.sin(theta);
    const dy = -Math.cos(theta);   // CSS 0deg = up; SVG y grows down → negate cos
    const L = Math.abs(W * Math.sin(theta)) + Math.abs(H * Math.cos(theta));
    const cx = W / 2, cy = H / 2;
    const x1 = cx - (dx * L) / 2, y1 = cy - (dy * L) / 2;
    const x2 = cx + (dx * L) / 2, y2 = cy + (dy * L) / 2;
    defs = `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopTags}</linearGradient>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs}</defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`;
}

// v2.1 round 239 (Terry) — MESH gradient bake. Reproduces the editor's CSS mesh
// (collageMeshCss): a base-colour rect, then one radial per "blob" stacked over it.
// Two things must match the browser exactly:
//  • STACKING ORDER. The CSS stacks blobs as background-image layers with the FIRST
//    blob ON TOP (CSS paints the first layer topmost), base underneath. SVG paint
//    order is the reverse (later elements draw on top), so we paint the base rect
//    first, then the blobs in REVERSE array order — last blob first … first blob last
//    → the first blob lands on top, matching the CSS.
//  • RADIUS SEMANTICS. Each blob is `radial-gradient(circle at x% y%, color 0%,
//    transparent r%)`. There, `r%` is a COLOUR-STOP position, not the gradient size:
//    the gradient defaults to `circle farthest-corner` (radius = distance from the
//    centre to the FARTHEST canvas corner), the colour sits at 0%, and it fades to
//    transparent at r% of that radius, staying transparent beyond (last-stop hold).
//    So the SVG radialGradient uses r = farthest-corner distance (userSpaceOnUse px),
//    with the opaque stop at 0% and the transparent stop at r% — SVG's default pad
//    spread holds it transparent past r%, exactly like the CSS. The centre (x%,y%) is
//    taken against W×H. Blobs use normal source-over alpha, like the browser layers.
function buildCollageMeshSvg(
  W: number,
  H: number,
  mesh: { base?: string; blobs?: Array<{ color: string; x: number; y: number; r: number }> },
): string {
  const okHex = (c: string) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(c || ''));
  const base = okHex(mesh.base || '') ? String(mesh.base) : '#1a1a2e';
  const blobs = (Array.isArray(mesh.blobs) ? mesh.blobs : [])
    .map((bl) => ({
      color: okHex(bl.color) ? String(bl.color) : '#ffffff',
      x: Math.max(-50, Math.min(150, Number(bl.x) || 0)),
      y: Math.max(-50, Math.min(150, Number(bl.y) || 0)),
      r: Math.max(5, Math.min(150, Number(bl.r) || 60)),
    }));
  // REVERSE so the first blob (CSS-topmost) is painted last (SVG-topmost).
  const ordered = blobs.slice().reverse();
  let defs = '';
  let rects = '';
  ordered.forEach((bl, i) => {
    const cx = (bl.x / 100) * W;
    const cy = (bl.y / 100) * H;
    // farthest-corner extent: max distance from the centre to any of the 4 corners.
    const far = Math.max(
      Math.hypot(cx - 0, cy - 0),
      Math.hypot(cx - W, cy - 0),
      Math.hypot(cx - 0, cy - H),
      Math.hypot(cx - W, cy - H),
    );
    // Transparent colour-stop offset within that radius (CSS `transparent r%`),
    // clamped just under 100% so the gradient is well-defined.
    const stopPct = Math.max(1, Math.min(100, bl.r));
    const id = `m${i}`;
    defs +=
      `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${far}">` +
      `<stop offset="0%" stop-color="${bl.color}" stop-opacity="1"/>` +
      `<stop offset="${stopPct}%" stop-color="${bl.color}" stop-opacity="0"/>` +
      `</radialGradient>`;
    rects += `<rect width="${W}" height="${H}" fill="url(#${id})"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs}</defs>` +
    `<rect width="${W}" height="${H}" fill="${base}"/>${rects}</svg>`;
}

// v2.1 round 244 (Terry) — CLOSE-UP MATERIAL SURFACE bake (REDO of round 242's zoomed-
// out geometric patterns). This table + helpers are a VERBATIM mirror of the renderer's
// COLLAGE_TEXTURES (viewer.html): each entry is a material whose full-canvas SURFACE is
// driven by feTurbulence (fractal/Perlin noise) mapped through feColorMatrix to the
// material colour + light/dark RELIEF (lighter = raised, darker = pits). NO lighting
// filters (feDiffuseLighting/feSpecularLighting DON'T render in librsvg). The surface
// SVG uses a FIXED 1000×1000 viewBox with preserveAspectRatio="none", so feTurbulence's
// per-user-unit baseFrequency yields the SAME noise scale + appearance whether rendered
// at on-screen px (editor preview) or output px (this bake) — only the outer width/height
// differ, the noise coordinate space does not, so saved == preview. The INNER markup
// (collageTextureSurfaceInner) is byte-identical to viewer.html's; any change here MUST
// be mirrored there and vice-versa.
type CollageTextureGrain = { freq: string; oct: number; seed: number; op: number; amp: number };
type CollageTextureEntry = { id: string; base: string; freq: string; oct: number; seed: number; type: string; amp: number | number[]; grain?: CollageTextureGrain };
const COLLAGE_TEXTURES: CollageTextureEntry[] = [
  { id: 'brick',    base: '#a8553a', freq: '0.022', oct: 4, seed: 11, type: 'fractalNoise', amp: [0.62, 0.42, 0.34], grain: { freq: '0.09', oct: 2, seed: 12, op: 0.18, amp: 0.5 } },
  { id: 'wood',     base: '#a9763f', freq: '0.006 0.05', oct: 5, seed: 7,  type: 'fractalNoise', amp: [0.5, 0.36, 0.22], grain: { freq: '0.012 0.16', oct: 2, seed: 8, op: 0.22, amp: 0.45 } },
  { id: 'woodchip', base: '#d8c9a6', freq: '0.045', oct: 3, seed: 21, type: 'turbulence',   amp: [0.45, 0.42, 0.34], grain: { freq: '0.16', oct: 2, seed: 22, op: 0.22, amp: 0.5 } },
  { id: 'concrete', base: '#9a9a98', freq: '0.05', oct: 5, seed: 31, type: 'fractalNoise', amp: [0.34, 0.34, 0.34], grain: { freq: '0.28', oct: 2, seed: 32, op: 0.16, amp: 0.45 } },
  { id: 'linen',    base: '#d9d2c2', freq: '0.10 0.11', oct: 2, seed: 41, type: 'turbulence',   amp: [0.26, 0.26, 0.24], grain: { freq: '0.35', oct: 1, seed: 42, op: 0.14, amp: 0.4 } },
  { id: 'paper',    base: '#efe9dc', freq: '0.16', oct: 3, seed: 51, type: 'fractalNoise', amp: [0.14, 0.14, 0.13], grain: { freq: '0.5', oct: 1, seed: 52, op: 0.12, amp: 0.35 } },
  { id: 'leather',  base: '#7c4f33', freq: '0.06', oct: 3, seed: 61, type: 'turbulence',   amp: [0.5, 0.36, 0.26], grain: { freq: '0.2', oct: 2, seed: 62, op: 0.2, amp: 0.5 } },
  { id: 'marble',   base: '#e6e3dc', freq: '0.006 0.03', oct: 6, seed: 71, type: 'fractalNoise', amp: [0.3, 0.3, 0.32], grain: { freq: '0.3', oct: 1, seed: 72, op: 0.1, amp: 0.3 } },
  { id: 'slate',    base: '#6f767c', freq: '0.04', oct: 5, seed: 81, type: 'fractalNoise', amp: [0.4, 0.42, 0.46], grain: { freq: '0.24', oct: 2, seed: 82, op: 0.18, amp: 0.5 } },
  { id: 'sand',     base: '#d8c08a', freq: '0.14', oct: 3, seed: 91, type: 'turbulence',   amp: [0.3, 0.26, 0.18], grain: { freq: '0.5', oct: 2, seed: 92, op: 0.18, amp: 0.45 } },
];
// v2.1 round 244 (Terry) — "#rrggbb" → [r,g,b] 0..1 (mirror of viewer.html collageHexRgb01).
function collageHexRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
// v2.1 round 244 (Terry) — one turbulence→colour-matrix <filter> (mirror of viewer.html
// collageSurfaceFilter). out_c = base_c + (lum−0.5)·amp_c per channel; alpha forced opaque.
function collageSurfaceFilter(id: string, freq: string, oct: number, seed: number, type: string, baseArr: number[], ampArr: number[]): string {
  function row(b: number, a: number) {
    const k = (0.3333 * a).toFixed(5);
    return k + ' ' + k + ' ' + k + ' 0 ' + (b - 0.5 * a).toFixed(5);
  }
  const matrix = row(baseArr[0], ampArr[0]) + '  ' + row(baseArr[1], ampArr[1]) + '  ' +
    row(baseArr[2], ampArr[2]) + '  0 0 0 0 1';
  return '<filter id="' + id + '" x="0" y="0" width="100%" height="100%" ' +
    'filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">' +
    '<feTurbulence type="' + type + '" baseFrequency="' + freq + '" numOctaves="' + oct +
    '" seed="' + seed + '" stitchTiles="stitch" result="t"/>' +
    '<feColorMatrix in="t" type="matrix" values="' + matrix + '"/>' +
    '</filter>';
}
// v2.1 round 244 (Terry) — INNER markup of a material surface (mirror of viewer.html
// collageTextureSurfaceInner): filter defs + base rect + relief rect + optional grain
// rect, in the FIXED 1000×1000 user-unit space. Byte-identical to the renderer's output.
function collageTextureSurfaceInner(entry: CollageTextureEntry): string {
  const base = collageHexRgb01(entry.base);
  const amp = Array.isArray(entry.amp) ? entry.amp : [entry.amp, entry.amp, entry.amp];
  let defs = collageSurfaceFilter('sr', entry.freq, entry.oct, entry.seed, entry.type || 'fractalNoise', base, amp);
  let out = '<defs>' + defs;
  const grain = entry.grain;
  if (grain) {
    defs += collageSurfaceFilter('sg', grain.freq, grain.oct, grain.seed, 'fractalNoise', [0.5, 0.5, 0.5], [grain.amp, grain.amp, grain.amp]);
    out = '<defs>' + defs;
  }
  out += '</defs>';
  out += '<rect x="0" y="0" width="1000" height="1000" fill="' + entry.base + '"/>';
  out += '<rect x="0" y="0" width="1000" height="1000" filter="url(#sr)"/>';
  if (grain) out += '<rect x="0" y="0" width="1000" height="1000" filter="url(#sg)" opacity="' + grain.op + '"/>';
  return out;
}
// v2.1 round 244 (Terry) — build the full-canvas material-surface SVG at W×H, with the
// FIXED 1000×1000 viewBox + preserveAspectRatio="none" so the feTurbulence noise scale
// matches the editor preview exactly (the editor's collageTextureSurfaceSvg with the same
// inner markup). Returns '' for an unknown id (caller skips the layer).
function buildCollageTextureSvg(W: number, H: number, id: string): string {
  const entry = COLLAGE_TEXTURES.find((t) => t.id === id);
  if (!entry) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 1000 1000" preserveAspectRatio="none">` +
    collageTextureSurfaceInner(entry) + `</svg>`;
}

// v2.1 round 238 (Terry) — VIGNETTE finishing layer. Reproduces the editor's CSS
// `radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,a) 100%)` at the
// output W×H so the baked edge-darkening matches the preview. The CSS ellipse uses
// the default `farthest-corner` extent: an ellipse keeping the box aspect, sized so
// it passes through the corners. In objectBoundingBox units (each axis scaled to the
// box) that ellipse has radius 1/√2 ≈ 0.7071 on both axes from the centre — so
// cx/cy 0.5, r 0.7071 gives exactly the farthest-corner ellipse on any aspect. The
// 55% transparent core + the slider-scaled edge alpha mirror applyCollageTreatments.
// v2.1 round 240 (Terry) — VIGNETTE SHAPE geometry, mirrored from viewer.html
// (collageVignetteShapeMarkup) so the bake reproduces the preview shape-for-shape. Each
// shape is normalized into a 100×100 box, centred, clearing a similar portion of the
// canvas as the classic ellipse. The mask below renders these in box space with
// preserveAspectRatio="none" so the box stretches to the canvas aspect — exactly like the
// preview's CSS mask + the original radial-gradient ellipse.
function collageVignetteShapeMarkup(shape: string, fill: string): string {
  const f = `fill="${fill}"`;
  switch (shape) {
    case 'circle':
      return `<circle cx="50" cy="50" r="39" ${f}/>`;
    case 'heart':
      return `<path ${f} d="M50 88 C18 66 8 48 8 33 C8 20 18 13 28 13 C37 13 45 19 50 28 C55 19 63 13 72 13 C82 13 92 20 92 33 C92 48 82 66 50 88 Z"/>`;
    case 'hearts': {
      const heart = (cx: number, cy: number, s: number): string =>
        `<path ${f} d="` +
        `M${cx} ${cy + 0.78 * s}` +
        ` C${cx - 0.92 * s} ${cy + 0.18 * s} ${cx - 1.0 * s} ${cy - 0.30 * s} ${cx - 1.0 * s} ${cy - 0.52 * s}` +
        ` C${cx - 1.0 * s} ${cy - 0.86 * s} ${cx - 0.55 * s} ${cy - 1.0 * s} ${cx - 0.28 * s} ${cy - 0.78 * s}` +
        ` C${cx - 0.12 * s} ${cy - 0.64 * s} ${cx} ${cy - 0.46 * s} ${cx} ${cy - 0.40 * s}` +
        ` C${cx} ${cy - 0.46 * s} ${cx + 0.12 * s} ${cy - 0.64 * s} ${cx + 0.28 * s} ${cy - 0.78 * s}` +
        ` C${cx + 0.55 * s} ${cy - 1.0 * s} ${cx + 1.0 * s} ${cy - 0.86 * s} ${cx + 1.0 * s} ${cy - 0.52 * s}` +
        ` C${cx + 1.0 * s} ${cy - 0.30 * s} ${cx + 0.92 * s} ${cy + 0.18 * s} ${cx} ${cy + 0.78 * s}` +
        ` Z"/>`;
      return heart(35, 42, 26) + heart(65, 56, 26);
    }
    case 'balloon':
      return `<path ${f} d="M50 8 C71 8 84 25 84 43 C84 64 64 79 54 88 L57 95 C58 97 56 99 53 99 L47 99 C44 99 42 97 43 95 L46 88 C36 79 16 64 16 43 C16 25 29 8 50 8 Z"/>`;
    case 'star':
      return `<path ${f} d="M50 6 L61.8 36.6 L94.5 38.8 L69 59.4 L77.3 91.5 L50 73.5 L22.7 91.5 L31 59.4 L5.5 38.8 L38.2 36.6 Z"/>`;
    case 'ellipse':
    default:
      return `<ellipse cx="50" cy="50" rx="45" ry="45" ${f}/>`;
  }
}

// v2.1 round 240 (Terry) — the vignette bake. ELLIPSE (default) returns the EXACT original
// radial-gradient SVG so its output is byte-for-byte unchanged. Any other shape paints a
// solid black rect (at the slider-scaled 0..0.85 alpha) masked by a BLURRED shape so the
// dark shows OUTSIDE the shape and feathers softly to clear inside — matching the preview's
// rgba-black layer + CSS shape mask. The mask is rendered in the same 100×100 box space
// with preserveAspectRatio="none" (and stdDev=5 in box units) as the preview, so feather +
// coverage register across the canvas aspect.
function buildCollageVignetteSvg(W: number, H: number, intensity: number, shape?: string): string {
  const v = Math.max(0, Math.min(100, intensity || 0));
  const a = ((v / 100) * 0.85).toFixed(3);   // matches the preview's 0..0.85 edge alpha
  const sh = shape || 'ellipse';
  if (sh === 'ellipse') {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs><radialGradient id="v" cx="0.5" cy="0.5" r="0.7071">` +
      `<stop offset="55%" stop-color="#000000" stop-opacity="0"/>` +
      `<stop offset="100%" stop-color="#000000" stop-opacity="${a}"/>` +
      `</radialGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="url(#v)"/></svg>`
    );
  }
  // White field with a blurred dark hole in the shape → as a luminance mask, this keeps
  // the black rect OUTSIDE the shape and softly clears it inside.
  const hole = collageVignetteShapeMarkup(sh, '#000000');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 100 100" preserveAspectRatio="none">` +
    `<defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter>` +
    `<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">` +
    `<rect width="100" height="100" fill="#ffffff"/>` +
    `<g filter="url(#b)">${hole}</g>` +
    `</mask></defs>` +
    `<rect width="100" height="100" fill="#000000" fill-opacity="${a}" mask="url(#m)"/></svg>`
  );
}

// v2.1 round 238 (Terry) — GRAIN finishing layer. A monochrome film-grain texture via
// SVG feTurbulence (fractalNoise), rasterized by sharp at the output W×H and composited
// with blend 'overlay' (matching the preview's mix-blend-mode:overlay) so it darkens
// shadows + lightens highlights subtly, leaving mid-greys neutral — only the texture
// shows. baseFrequency is kept close to the preview's grain feel (the preview tiles a
// 160px noise tile at 0.9; here we render full-frame at a fine frequency for an
// equivalent subtle grain at print sizes — grain is texture, not registration-critical).
// The whole layer's opacity scales 0..0.5 with the slider, exactly like the preview.
function buildCollageGrainSvg(W: number, H: number, intensity: number): string {
  // v2.1 round 325 (Terry) — grain scale back to 0-100 but the effect DOUBLED (op coefficient
  // 0.5 -> 1.0) so 100 → 1.0; matches the doubled preview (applyCollageTreatments).
  const g = Math.max(0, Math.min(100, intensity || 0));
  const op = ((g / 100) * 1.0).toFixed(3);
  // fractalNoise → collapse to GREY centred on ~0.5 (average the noise channels into
  // R=G=B) with FULL alpha. Mid-grey 0.5 under 'overlay' is a no-op, so lighter noise
  // LIGHTENS and darker noise DARKENS — proper filmic grain that pushes both ways
  // (not just a brighten). The rect's opacity carries the slider-scaled strength.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<filter id="n" x="0" y="0" width="100%" height="100%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" stitchTiles="stitch" result="t"/>` +
    `<feColorMatrix in="t" type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 1" result="g"/>` +
    // v2.1 round 327 (Terry) — double again (3rd) via CONTRAST (opacity maxed); matches collageGrainDataUri.
    `<feComponentTransfer in="g"><feFuncR type="linear" slope="4" intercept="-1.5"/><feFuncG type="linear" slope="4" intercept="-1.5"/><feFuncB type="linear" slope="4" intercept="-1.5"/></feComponentTransfer>` +
    `</filter>` +
    `<rect width="${W}" height="${H}" filter="url(#n)" opacity="${op}"/></svg>`
  );
}

// Build a sharp pipeline for ONE collage tile: source → EXIF-rotate →
// resize to the tile box → the photo's own Enhance bake (mirrors
// viewer:saveEnhanced exactly) → optional frame. Returned un-toBuffer'd
// so the caller can read the result dims. The placement rotation is
// applied by the caller afterwards.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildCollageTilePipeline(sharp: any, srcLong: string, iw: number, ih: number, enh?: CollageEnhance, cropRect?: { left: number; top: number; width: number; height: number }, coverPos: string = 'attention', keepAlpha: boolean = false) {
  // v2.1 round 173 (Terry) — keepAlpha = the source is a background-removed
  // cut-out (transparent PNG). sharp's .linear() applies to EVERY channel,
  // which would scale the alpha and bring the removed background back; so for
  // cut-outs the contrast + temperature ops use per-channel arrays that leave
  // the alpha (4th channel) untouched. modulate / greyscale / flip / recomb
  // already preserve alpha.
  let p = sharp(srcLong, { failOnError: false }).rotate();
  // v2.1 round 145 (Terry) — crop: extract the user's rect (in oriented
  // px) BEFORE resizing to the tile box.
  if (cropRect && cropRect.width > 1 && cropRect.height > 1) {
    p = p.extract({ left: Math.max(0, cropRect.left), top: Math.max(0, cropRect.top), width: cropRect.width, height: cropRect.height });
  }
  // v2.1 round 160 (Terry) — coverPos: tiles use 'attention' (a smart crop,
  // moot in practice since the box aspect matches the photo). The BACKGROUND
  // passes 'centre' so the bake matches the editor's CSS background-position:
  // center — sharp's default 'attention' was cropping the bg to a different
  // region, so the saved background looked shifted vs the editor.
  // v2.1 round 161 (Terry) — FRAME = MATTE. Resize the photo to the INNER box
  // (tile minus the frame) and extend the frame back out to iw×ih below, so a
  // framed tile keeps its footprint and the photo sits fully INSIDE the frame.
  // Previously we resized to iw×ih then extended the frame OUTSIDE, which grew
  // the tile and made the on-screen preview clip the photo's outer edge —
  // Terry: "the frame is eating up the photo image". Frame % matches the
  // editor preview (applyFilterToEl): mat 8%, thin 3.5% of the short side.
  const _bc = enh ? (enh.borderColor || '').trim() : '';
  const _hasFrame = !!_bc && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(_bc);
  const _framePx = _hasFrame ? Math.max(3, Math.round(Math.min(iw, ih) * (typeof enh!.borderPct === 'number' ? enh!.borderPct : (enh!.borderWeight === 'mat' ? 0.08 : 0.035)))) : 0;
  p = p.resize(Math.max(2, iw - _framePx * 2), Math.max(2, ih - _framePx * 2), { fit: 'cover', position: coverPos });
  if (enh) {
    const b = (enh.brightness ?? 100) / 100;
    const c = (enh.contrast ?? 100) / 100;
    // v2.1 round 152 (Terry) — Colour slider (100 = colour, 0 = B&W) is a
    // master desaturation that multiplies the Saturation slider.
    const s = ((enh.saturation ?? 100) / 100) * ((enh.colour ?? 50) / 50);
    const t = enh.temperature ?? 0;
    const bw = s <= 0.001;
    const tone = enh.tone ?? 'none';
    if (b !== 1 || (s !== 1 && !bw)) p = p.modulate({ brightness: b, ...(bw ? {} : { saturation: s }) });
    if (c !== 1) {
      const slope = c, off = 128 * (1 - slope);
      p = keepAlpha ? p.linear([slope, slope, slope, 1], [off, off, off, 0]) : p.linear(slope, off);
    }
    if (t !== 0 && tone === 'none') {
      const tt = t / 50;
      // Temperature is a diagonal recomb (R up, B down) = a per-channel multiply,
      // so for cut-outs we use the alpha-safe per-channel linear instead.
      p = keepAlpha
        ? p.linear([1 + 0.30 * tt, 1, 1 - 0.30 * tt, 1], [0, 0, 0, 0])
        : p.recomb([[1 + 0.30 * tt, 0, 0], [0, 1, 0], [0, 0, 1 - 0.30 * tt]]);
    }
    if (tone === 'sepia') p = p.recomb([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]]);
    else if (tone === 'vintage') p = p.recomb([[0.696, 0.385, 0.095], [0.175, 0.843, 0.084], [0.136, 0.267, 0.566]]);
    if (bw) p = p.greyscale();
    // v2.1 round 155 (Terry) — Mirror = .flop() (left↔right), Flip = .flip()
    // (top↕bottom). After the crop/resize/enhance, before the frame, so the
    // frame stays square around the transformed image.
    if (enh.flipH) p = p.flop();
    if (enh.flipV) p = p.flip();
    // v2.1 round 161 (Terry) — extend the matte frame back out to iw×ih
    // (width computed above as _framePx). Footprint preserved; photo inside.
    if (_hasFrame) {
      p = p.extend({ top: _framePx, bottom: _framePx, left: _framePx, right: _framePx, background: _bc });
    }
  }
  return p;
}

// v2.1 round 341 (Terry) — Glow & shadow edge-effect EXTENT (padding) for a tile of short side `s`.
// Single source of truth used by BOTH the PAD pre-scan (so a glowing tile near the page edge still
// fits the base) and buildTileEdgeFx (the canvas it builds on). Mirrors applyTileEdgeFx's sizing:
// 3σ Gaussian reach + offset (+ dilate for outline), per active effect; the max wins.
function edgeFxExtent(enh: CollageEnhance | undefined, s: number): number {
  if (!enh) return 0;
  const cl = (v: unknown) => Math.max(0, Math.min(100, Number(v) || 0));
  const glow = cl(enh.glow), neon = cl(enh.neon), lift = cl(enh.lift), ds = cl(enh.dropShadow), ol = cl(enh.outline);
  let ext = 0;
  if (glow > 0) { const gb = (glow / 100) * 0.14 * s; ext = Math.max(ext, gb * 0.35 + (gb / 2) * 3); }   // spread + 3σ
  if (neon > 0) { const nb = (neon / 100) * 0.10 * s; ext = Math.max(ext, nb * 0.3 + (nb / 2) * 3, nb * 3); }
  if (lift > 0) { const lb = (lift / 100) * 0.16 * s; ext = Math.max(ext, (lb / 2) * 3 + (lift / 100) * 0.06 * s); }
  if (ds > 0) { const d = (ds / 100) * 0.07 * s; ext = Math.max(ext, (d / 2) * 3 + d); }
  if (ol > 0) ext = Math.max(ext, Math.max(1, (ol / 100) * 0.05 * s));
  return ext > 0 ? Math.ceil(ext) + 8 : 0;
}

// v2.1 round 341 (Terry) — EXPORT BAKE for the Glow & shadow edge effects. Mirrors the editor's
// box-shadow preview (applyTileEdgeFx): for each active effect, a coloured silhouette of the
// (un-rotated, already-shaped) tile is blurred (glow/neon/lift/drop-shadow) or dilated (outline),
// offset, and composited BEHIND the tile on a padded canvas. The caller then rotates the whole thing
// as one, so the effects turn WITH the tile (the preview's box-shadow rotates with the element). Sizes
// scale by the tile's short side `s` (same fractions as the preview) → matches at any export size.
// Returns the combined buffer + dims (tile centred), or null when no effect is active.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildTileEdgeFx(sharp: any, tile: Buffer, w: number, h: number, enh: CollageEnhance, op: number = 1, glowOnly: boolean = false): Promise<{ buf: Buffer; w: number; h: number } | null> {
  const s = Math.min(w, h);
  const P = edgeFxExtent(enh, s);
  if (P <= 0) return null;
  const cl = (v: unknown) => Math.max(0, Math.min(100, Number(v) || 0));
  const glow = cl(enh.glow), neon = cl(enh.neon), lift = cl(enh.lift), ds = cl(enh.dropShadow), ol = cl(enh.outline);
  // Layers in CSS paint order BACK→FRONT (outline furthest back; glow nearest the tile); the tile is
  // composited last, on top. { color, alpha, sigma (blur), dilate (outline only), dx, dy (offset) }.
  // { color, alpha, spread (HARD grow = CSS box-shadow spread), sigma (blur σ ≈ CSS blur/2), dx, dy }.
  const layers: Array<{ color: string; alpha: number; spread: number; sigma: number; dx: number; dy: number }> = [];
  if (ol > 0) layers.push({ color: enh.outlineColor || '#ffffff', alpha: 1, spread: Math.max(1, (ol / 100) * 0.05 * s), sigma: 0, dx: 0, dy: 0 });
  if (ds > 0) { const d = (ds / 100) * 0.07 * s; layers.push({ color: enh.dropShadowColor || '#000000', alpha: 0.55, spread: 0, sigma: d / 2, dx: d, dy: d }); }
  if (lift > 0) { const lb = (lift / 100) * 0.16 * s; layers.push({ color: enh.liftColor || '#000000', alpha: 0.5, spread: 0, sigma: lb / 2, dx: 0, dy: (lift / 100) * 0.06 * s }); }
  if (neon > 0) { const nb = (neon / 100) * 0.10 * s; const nc = enh.neonColor || '#ff2bd6'; layers.push({ color: nc, alpha: 1, spread: nb * 0.3, sigma: nb / 2, dx: 0, dy: 0 }); layers.push({ color: nc, alpha: 1, spread: 0, sigma: nb, dx: 0, dy: 0 }); }
  if (glow > 0) { const gb = (glow / 100) * 0.14 * s; layers.push({ color: enh.glowColor || '#ffffff', alpha: 0.9, spread: gb * 0.35, sigma: gb / 2, dx: 0, dy: 0 }); }
  const W2 = w + P * 2, H2 = h + P * 2;
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (const l of layers) {
    const c = hexToRgb(l.color);
    // The tile's alpha placed on a W2×H2 canvas at this layer's offset → the silhouette shape.
    const tileOnBase = await sharp({ create: { width: W2, height: H2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: tile, left: Math.round(P + l.dx), top: Math.round(P + l.dy) }]).png().toBuffer();
    // CSS spread = a HARD grow of the shape (blur + threshold ≈ morphological dilate) BEFORE the blur,
    // so a glow / neon keeps a BOLD solid core near the edge instead of fading straight off (which made
    // the bake far paler than the box-shadow preview — esp. on a faded tile). Outline = spread, no blur.
    let shapeAlpha = sharp(tileOnBase).extractChannel('alpha');
    if (l.spread > 0) shapeAlpha = shapeAlpha.blur(Math.max(0.3, l.spread)).threshold(38);
    const alphaRaw = await shapeAlpha.raw().toBuffer();
    let sil = await sharp({ create: { width: W2, height: H2, channels: 3, background: { r: c.r, g: c.g, b: c.b } } })
      .joinChannel(alphaRaw, { raw: { width: W2, height: H2, channels: 1 } }).png().toBuffer();
    if (l.alpha < 0.999) {   // multiply the silhouette's alpha by the effect opacity
      const am = await sharp({ create: { width: W2, height: H2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: l.alpha } } }).png().toBuffer();
      sil = await sharp(sil).composite([{ input: am, blend: 'dest-in' }]).png().toBuffer();
    }
    if (l.sigma > 0.3) sil = await sharp(sil).blur(l.sigma).png().toBuffer();
    composites.push({ input: sil, left: 0, top: 0 });
  }
  // Accumulate the effects, then CUT the tile's (un-faded, centred) shape out of them so they sit only
  // OUTSIDE the tile — CSS box-shadow is clipped to outside the border box. Without this a FADED photo
  // would show its own glow THROUGH it (tinting the photo), which the editor never does.
  let shadows = await sharp({ create: { width: W2, height: H2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites).png().toBuffer();
  const tileCentre = await sharp({ create: { width: W2, height: H2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: tile, left: P, top: P }]).png().toBuffer();
  shadows = await sharp(shadows).composite([{ input: tileCentre, blend: 'dest-out' }]).png().toBuffer();
  // v3.0 (Terry 2026-07-05) — glowOnly: return JUST the crisp glow (tile shape cut out, transparent
  // centre) so the EDITOR can lay it behind the live photo. The live <img> then covers the centre,
  // leaving the crisp silhouette outline showing — pixel-matching this same engine's thumbnail bake.
  if (glowOnly) return { buf: shadows, w: W2, h: H2 };
  // The photo on top — "Fade" (opacity) fades the PHOTO only (in the editor it's on the <img>, so the
  // glow / shadow stay at full strength), so apply it to the tile here, not to the whole buffer.
  let topTile = tile;
  if (op < 0.999) {
    const am = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: op } } }).png().toBuffer();
    topTile = await sharp(tile).ensureAlpha().composite([{ input: am, blend: 'dest-in' }]).png().toBuffer();
  }
  const buf = await sharp(shadows).composite([{ input: topTile, left: P, top: P }]).png().toBuffer();
  return { buf, w: W2, h: H2 };
}

// v2.1 round 258 (Terry) — carousel P4: extracted the layout→final-image-Buffer
// bake out of collage:saveLayout so a carousel can bake N pages with the SAME
// compositing pipeline. Pure function of `layout`; the single-collage handler and
// the per-slide carousel loop both call it, then do their own write/index/album.
// Throws (not returns) on empty / unreadable so callers' try/catch turns the SAME
// message strings into { success:false, error } — single-save stays byte-identical.
async function bakeCollageLayout(layout: CollageLayout): Promise<Buffer> {
  if (!layout || !layout.canvas || !Array.isArray(layout.items) || layout.items.length === 0) {
    throw new Error('Nothing to save — the collage is empty.');
  }
  {
    const sharp = (await import('sharp')).default;
    // v2.1 round 260 (Terry) — carousel wide: a carousel bakes ONE wide canvas
    // (width = pageCount*1080, up to 10*1080 = 10800) that the saveCarousel handler
    // then slices into N pages of exactly 1080×1350. So the W ceiling rises from
    // 2400 to 11000 to admit the wide strip; H stays ≤ 2400. CRITICAL: the wide W
    // must end up EXACTLY layout.canvas.w (= N*1080) so the slice boundaries fall on
    // clean 1080 multiples — the 11000 ceiling is comfortably above 10800 and never
    // clamps a valid carousel below N*1080. Single-collage saves pass normal sizes
    // (≤ 2400), so the raised ceiling is a no-op for them.
    const W = Math.max(600, Math.min(11000, Math.round(layout.canvas.w || 2000)));
    const H = Math.max(450, Math.min(2400, Math.round(layout.canvas.h || 1500)));
    const bg = hexToRgb(layout.canvas.bg || '#ffffff');
    // v2.1 round 177 (Terry) — transparent background: the removed areas (and
    // any canvas not covered by a tile) stay see-through, and the collage is
    // saved as a PNG instead of a flattened JPEG. Mutually exclusive with a
    // background photo (the UI clears one when you pick the other).
    const transparent = !!layout.canvas.transparent;
    // Generous padding so a rotated / dragged-to-the-edge tile never
    // overflows the composite base (sharp errors if an input extends
    // past the base bounds).
    // v2.1 round 260 (Terry) — carousel wide: PAD must be TILE-bounded, not
    // canvas-bounded. The old `0.8·W` was fine when W ≤ 2400 (PAD ≤ 1920), but on a
    // 10800-wide carousel it became ~8640px → a 28080-wide ×4-channel base ≈ 350 MB,
    // which OOMs sharp. The padding only needs to cover the LARGEST single tile when
    // rotated 45° about an on-canvas centre — independent of how wide the canvas is.
    //
    // v2.1 round 266 (Terry) — oversized tiles (≤ TILE_WFRAC_MAX× the canvas) can now
    // exceed the page, so round-260's "bound PAD by the LARGEST tile extent" would
    // re-introduce the OOM it cured: a 4× tile's full extent on a wide canvas is huge.
    // PAD only needs to cover how far a tile sticks OUT past the visible page rect
    // [0,W]×[0,H] — its OFF-PAGE OVERHANG. Any tile pixels beyond [0,W]×[0,H] are cut
    // by the final extract anyway; the base just has to physically contain each placed
    // tile's bbox (sharp throws if an input overruns the base, and the final safety
    // clamp ~L1527 would otherwise SHIFT an off-page tile back in, corrupting its
    // position — so PAD must equal the real overhang for legitimately off-page tiles).
    // For each tile: rotated half-extents hw,hh about centre (cx,cy); overhang on each
    // side = how far [cx-hw,cx+hw]×[cy-hh,cy+hh] exceeds [0,W]×[0,H]. A tile fully
    // on-page contributes 0 → a centred-but-oversized tile still only pads by its real
    // spill, never by the wide W. Half-extents are inflated 8% (FRAME_SLOP) so a frame
    // grown tile — whose true rotW/rotH the pre-scan can't see — still fits.
    const FRAME_SLOP = 1.08;
    let maxOverhangPx = 0;
    for (const it of layout.items) {
      if (!it) continue;
      const _aspect = Number.isFinite(it.aspect) && it.aspect > 0.01 ? it.aspect : 1;
      const _wFrac = Math.max(0.02, Math.min(TILE_WFRAC_MAX, it.wFrac || 0.3));
      const _iw = capTilePx(Math.max(2, Math.round(_wFrac * W)));
      const _ih = capTilePx(Math.max(2, Math.round(_iw / _aspect)));
      // Rotated bbox dims: rW = iw·|cos|+ih·|sin|, rH = iw·|sin|+ih·|cos|.
      const _rad = (((it.rot || 0) % 360) * Math.PI) / 180;
      const _c = Math.abs(Math.cos(_rad)), _s = Math.abs(Math.sin(_rad));
      // v2.1 round 341 (Terry) — add the Glow & shadow edge-effect spread so a glowing / outlined tile
      // near the page edge still fits the padded base (else its bbox overruns the base → sharp throws).
      const _efx = edgeFxExtent(it.enh, Math.min(_iw, _ih));
      const _hw = ((_iw * _c + _ih * _s) / 2) * FRAME_SLOP + _efx;
      const _hh = ((_iw * _s + _ih * _c) / 2) * FRAME_SLOP + _efx;
      // Box centre in page px (matches cx/cy used at composite time below).
      const _cx = clampTileX(it.xFrac) * W + _iw / 2;
      const _cy = clampTileY(it.yFrac) * H + _ih / 2;
      const _over = Math.max(
        _hw - _cx,            // spill past the LEFT edge (x=0)
        (_cx + _hw) - W,      // spill past the RIGHT edge (x=W)
        _hh - _cy,            // spill past the TOP edge (y=0)
        (_cy + _hh) - H,      // spill past the BOTTOM edge (y=H)
        0,
      );
      if (_over > maxOverhangPx) maxOverhangPx = _over;
    }
    // Floor preserves round-260's small rotation/rounding margin for the no-overhang
    // (on-page) case; +64 absolute slop covers feather/round-corner growth + rounding.
    const PAD = Math.ceil(maxOverhangPx) + 64 + Math.min(256, Math.round(H * 0.1));
    const baseW = W + PAD * 2;
    const baseH = H + PAD * 2;

    // v2.1 round 238 (Terry) — `blend` is optional (default 'over'); the grain
    // finishing layer uses 'overlay' to match the preview's mix-blend-mode. The
    // literals are all members of sharp's Blend union, so this stays assignable to
    // .composite()'s OverlayOptions[].
    const composites: Array<{ input: Buffer; left: number; top: number; blend?: 'over' | 'overlay' | 'soft-light' }> = [];
    for (const item of layout.items) {
      if (!item || !item.path || !fs.existsSync(toLongPath(item.path))) continue;
      try {
        const aspect = Number.isFinite(item.aspect) && item.aspect > 0.01 ? item.aspect : 1;
        // v2.1 round 266 (Terry) — oversized tiles: ceiling 1 → TILE_WFRAC_MAX, and the
        // box top-left clamps from [0,1] to the wide clampTileX/Y window so an off-page
        // tile composites at its TRUE position (was forced on-page). MUST mirror the PAD
        // pre-scan above exactly or the overhang estimate undersizes the base.
        const wFrac = Math.max(0.02, Math.min(TILE_WFRAC_MAX, item.wFrac || 0.3));
        const xFrac = clampTileX(item.xFrac);
        const yFrac = clampTileY(item.yFrac);
        const iw = capTilePx(Math.max(2, Math.round(wFrac * W)));
        const ih = capTilePx(Math.max(2, Math.round(iw / aspect)));
        // v2.1 round 263 (Terry) — bg-tile: a coverFill tile is a BACKGROUND fill —
        // the box (iw×ih above, computed from wFrac + the BOX aspect the renderer sent)
        // is covered by the photo via fit:'cover', with NO crop and NO zoom/pan (a
        // backdrop has none). For the locked full-canvas default wFrac=1 + box aspect =
        // canvas aspect, so iw=W, ih=H. Skipping crop/zoom below keeps the bake matching
        // the editor's genuine objectFit:'cover'. Centre position (not 'attention') so the
        // saved fill matches the editor's object-position:center.
        const isCover = !!item.coverFill;
        // v2.1 round 145 (Terry) — crop: convert the fractional rect to
        // oriented pixels (swap dims for EXIF 90/270) for sharp .extract.
        let cropRect: { left: number; top: number; width: number; height: number } | undefined;
        const cr = item.crop;
        if (!isCover && cr && (cr.l > 0.001 || cr.t > 0.001 || cr.r < 0.999 || cr.b < 0.999)) {
          try {
            const meta = await sharp(toLongPath(item.path), { failOnError: false }).metadata();
            let ow = meta.width || 0, oh = meta.height || 0;
            if (meta.orientation && meta.orientation >= 5) { const tmp = ow; ow = oh; oh = tmp; }
            const cl = clamp01(cr.l), ct = clamp01(cr.t), crr = clamp01(cr.r), cbb = clamp01(cr.b);
            if (ow > 0 && oh > 0 && crr > cl && cbb > ct) {
              cropRect = {
                left: Math.round(cl * ow), top: Math.round(ct * oh),
                width: Math.max(1, Math.min(ow - Math.round(cl * ow), Math.round((crr - cl) * ow))),
                height: Math.max(1, Math.min(oh - Math.round(ct * oh), Math.round((cbb - ct) * oh))),
              };
            }
          } catch { /* crop best-effort; fall back to full image */ }
        }
        // v2.1 round 168 (Terry) — Ctrl+scroll photo zoom (1–2×): magnify the
        // centre of the visible region by insetting the extract rect to its
        // centre 1/zoom (defaulting to the full photo when there's no crop).
        // One extract → resize, so the saved file matches the editor preview.
        const _zoom = Math.max(1, Math.min(2.8, item.zoom || 1));   // v2.1 round 347 (Terry) — tile zoom max 2 → 2.8 (+40%); fallback-bake only (WYSIWYG export uses the live DOM)
        if (!isCover && _zoom > 1) {
          let region = cropRect;
          if (!region) {
            try {
              const meta = await sharp(toLongPath(item.path), { failOnError: false }).metadata();
              let ow = meta.width || 0, oh = meta.height || 0;
              if (meta.orientation && meta.orientation >= 5) { const tmp = ow; ow = oh; oh = tmp; }
              if (ow > 0 && oh > 0) region = { left: 0, top: 0, width: ow, height: oh };
            } catch { /* zoom best-effort */ }
          }
          if (region) {
            const insetX = region.width * (1 - 1 / _zoom) / 2;
            const insetY = region.height * (1 - 1 / _zoom) / 2;
            // v2.1 round 169 (Terry) — pan shift: panX/panY (−1..1) move the
            // extract within the slack (±inset), matching the editor's pan.
            const panShiftX = Math.max(-1, Math.min(1, item.panX || 0)) * insetX;
            const panShiftY = Math.max(-1, Math.min(1, item.panY || 0)) * insetY;
            cropRect = {
              left: Math.round(region.left + insetX + panShiftX),
              top: Math.round(region.top + insetY + panShiftY),
              width: Math.max(1, Math.round(region.width / _zoom)),
              height: Math.max(1, Math.round(region.height / _zoom)),
            };
          }
        }
        // v2.1 round 327 (Terry) — ZOOM-IN-FRAME for coverFill (frame-fill) tiles: the box
        // stays fixed; zoom shows a smaller centred (pan-shifted) sub-rect of the COVER region,
        // mirroring the editor's scale()+translate() on the cover-fit <img> (renderCollageItem).
        if (isCover && _zoom > 1) {
          try {
            const cmeta = await sharp(toLongPath(item.path), { failOnError: false }).metadata();
            let cow = cmeta.width || 0, coh = cmeta.height || 0;
            if (cmeta.orientation && cmeta.orientation >= 5) { const tmp = cow; cow = coh; coh = tmp; }
            if (cow > 0 && coh > 0) {
              const boxAspect = iw / ih;
              let cReg: { left: number; top: number; width: number; height: number };
              if (cow / coh > boxAspect) { const ccw = Math.round(coh * boxAspect); cReg = { left: Math.round((cow - ccw) / 2), top: 0, width: ccw, height: coh }; }
              else { const cch = Math.round(cow / boxAspect); cReg = { left: 0, top: Math.round((coh - cch) / 2), width: cow, height: cch }; }
              const cInsetX = cReg.width * (1 - 1 / _zoom) / 2;
              const cInsetY = cReg.height * (1 - 1 / _zoom) / 2;
              const cpsx = Math.max(-1, Math.min(1, item.panX || 0)) * cInsetX;
              const cpsy = Math.max(-1, Math.min(1, item.panY || 0)) * cInsetY;
              cropRect = {
                left: Math.round(cReg.left + cInsetX + cpsx),
                top: Math.round(cReg.top + cInsetY + cpsy),
                width: Math.max(1, Math.round(cReg.width / _zoom)),
                height: Math.max(1, Math.round(cReg.height / _zoom)),
              };
            }
          } catch { /* zoom-in-frame best-effort; fall back to plain cover */ }
        }
        // v2.1 round 344 (Terry) — keepAlpha (the cut-out path that uses 4-element per-channel .linear()
        // to protect the alpha) is only valid when the source ACTUALLY decodes to an alpha channel.
        // Some "cut-outs" are <4-band (e.g. a 3-band PNG/JPEG), and the 4-element linear then throws
        // "Band expansion using linear is unsupported" → the whole tile was silently skipped from the
        // bake. Gate keepAlpha on the real alpha so a non-alpha cut-out falls back to the normal path
        // (it has no transparency to protect anyway) instead of vanishing.
        let keepAlphaTile = false;
        if (item.bgRemoved) {
          try { const _m = await sharp(toLongPath(item.path), { failOnError: false }).metadata(); keepAlphaTile = !!_m.hasAlpha; }
          catch { keepAlphaTile = false; }
        }
        // Bake the tile (crop + resize + its own Enhance state + frame).
        // The result may be larger than iw×ih if a frame was added, so
        // read its real dims back.
        const baked = await buildCollageTilePipeline(sharp, toLongPath(item.path), iw, ih, item.enh, cropRect, isCover ? 'centre' : 'attention', keepAlphaTile)
          .png()
          .toBuffer({ resolveWithObject: true });
        let tile = baked.data;
        let rotW = baked.info.width, rotH = baked.info.height;
        // v2.1 round 327 (Terry) — per-photo BLUR + PIXELATE (mirror the editor's clip filter).
        // Applied BEFORE the corner/blend mask, matching the preview order (CSS filter, then
        // mask). Both scale with the tile's short side (same fraction applyTileFx uses) so the
        // saved image matches the preview at any export size. Blur then pixelate (preview order).
        if (item.enh) {
          const tShort = Math.min(rotW, rotH);
          const tblur = Math.max(0, Math.min(100, Number(item.enh.blur) || 0));
          if (tblur > 0) {
            try { tile = await sharp(tile).blur(Math.max(0.3, tblur / 100 * 0.0225 * tShort)).png().toBuffer(); }   // v2.1 round 329 (Terry) — range halved
            catch (e) { log.warn(`[collage] tile blur skipped: ${(e as Error).message}`); }
          }
          const tpix = Math.max(0, Math.min(100, Number(item.enh.pixelate) || 0));
          if (tpix > 0) {
            try {
              const cell = Math.max(2, Math.round(tpix / 100 * 0.044 * tShort));   // v2.1 round 330 (Terry) — a further 20% less (0.055 -> 0.044)
              const dw = Math.max(1, Math.round(rotW / cell)), dh = Math.max(1, Math.round(rotH / cell));
              tile = await sharp(tile).resize(dw, dh, { kernel: 'nearest' }).resize(rotW, rotH, { kernel: 'nearest' }).png().toBuffer();
            } catch (e) { log.warn(`[collage] tile pixelate skipped: ${(e as Error).message}`); }
          }
        }
        // v2.1 round 150 (Terry) — Blend: feather the (framed) tile's edges
        // BEFORE rotation, so the soft band aligns with the tile rectangle.
        // v2.1 round 164 (Terry) — round corners + feather the (framed) tile's
        // edges BEFORE rotation, so the shape aligns with the tile rectangle.
        // No-op when neither corners nor blend are set.
        if (item.enh) {
          tile = await roundedFeatherMask(sharp, tile, rotW, rotH, item.enh.corners, item.enh.blend);
        }
        // v2.1 round 294 (Terry) — PER-PHOTO vignette + grain: composite the same SVGs the
        // whole-collage finish uses, but sized to THIS tile, then re-clip to the tile's own
        // alpha so a rounded / cut-out tile keeps its shape (no black corners). Mirrors the
        // editor's per-tile .ct-vig / .ct-grain overlays. Before rotation so it turns with the photo.
        if (item.enh) {
          const tvig = Math.max(0, Math.min(100, Number(item.enh.vignette) || 0));
          const tgrain = Math.max(0, Math.min(150, Number(item.enh.grain) || 0));
          if (tvig > 0 || tgrain > 0) {
            try {
              const tLayers: Array<{ input: Buffer; blend: 'over' | 'overlay' }> = [];
              if (tvig > 0) tLayers.push({ input: await sharp(Buffer.from(buildCollageVignetteSvg(rotW, rotH, tvig, String(item.enh.vignetteShape || 'ellipse')))).png().toBuffer(), blend: 'over' });
              if (tgrain > 0) tLayers.push({ input: await sharp(Buffer.from(buildCollageGrainSvg(rotW, rotH, tgrain))).png().toBuffer(), blend: 'overlay' });
              if (tLayers.length) {
                const tileAlpha = tile;   // the shaped tile carries the correct alpha
                const shaded = await sharp(tile).ensureAlpha().composite(tLayers).png().toBuffer();
                tile = await sharp(shaded).composite([{ input: tileAlpha, blend: 'dest-in' }]).png().toBuffer();
              }
            } catch (vgErr) {
              log.warn(`[collage] per-tile vignette/grain skipped (non-fatal): ${(vgErr as Error).message}`);
            }
          }
        }
        // v2.1 round 341 (Terry) — EXPORT BAKE the Glow & shadow edge effects onto the un-rotated tile
        // (so the rotation below turns them WITH the tile, matching the preview's box-shadow). Built from
        // the already-shaped tile, so a rounded / feathered tile gets a rounded glow / outline.
        // v2.1 round 342 (Terry) — pass the Fade opacity so it fades the PHOTO only (not the glow); when
        // it does, skip the generic opacity step below so the glow isn't double-faded into nothing.
        let edgeFxFadedPhoto = false;
        if (item.enh) {
          try {
            const _op = item.enh.opacity != null ? Math.max(0.1, Math.min(1, item.enh.opacity)) : 1;
            const _ef = await buildTileEdgeFx(sharp, tile, rotW, rotH, item.enh, _op);
            if (_ef) { tile = _ef.buf; rotW = _ef.w; rotH = _ef.h; edgeFxFadedPhoto = _op < 1; }
          } catch (efErr) {
            log.warn(`[collage] tile edge effects skipped (non-fatal): ${(efErr as Error).message}`);
          }
        }
        const rot = ((item.rot || 0) % 360 + 360) % 360;
        if (rot > 0.1 && rot < 359.9) {
          const rotated = await sharp(tile)
            .rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer({ resolveWithObject: true });
          tile = rotated.data;
          rotW = rotated.info.width;
          rotH = rotated.info.height;
        }
        // v2.1 round 143 (Terry) — per-tile transparency. Multiply the
        // tile's alpha by `opacity` via a dest-in composite with a
        // uniform-alpha layer (Porter-Duff dest-in = dest × src.alpha),
        // so it works whether or not the tile already has alpha (frame /
        // rotation). Skipped when opaque.
        const op = (item.enh && item.enh.opacity != null && !edgeFxFadedPhoto) ? Math.max(0.1, Math.min(1, item.enh.opacity)) : 1;   // v2.1 round 342 — edge fx already faded the photo
        if (op < 1) {
          const mask = await sharp({ create: { width: rotW, height: rotH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: op } } }).png().toBuffer();
          tile = await sharp(tile).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
        }
        // Centre on the unframed box centre — a frame grows the tile
        // symmetrically, so the centre is unchanged.
        const cx = xFrac * W + iw / 2;
        const cy = yFrac * H + ih / 2;
        let left = Math.round(cx - rotW / 2) + PAD;
        let top = Math.round(cy - rotH / 2) + PAD;
        // Final safety clamp so the tile always sits within the base.
        left = Math.max(0, Math.min(baseW - rotW, left));
        top = Math.max(0, Math.min(baseH - rotH, top));
        composites.push({ input: tile, left, top });
      } catch (cellErr) {
        log.warn(`[collage] skipped a photo (${item.path}): ${(cellErr as Error).message}`);
      }
    }
    if (composites.length === 0) throw new Error('None of the photos could be read.');

    // v2.1 round 235 (Terry) — optional GRADIENT background (phase 1 of "Background
    // textures"). Rasterize the gradient SVG at the OUTPUT W×H via sharp and prepend
    // it as the BOTTOM layer (under the tiles), matching the editor's CSS gradient
    // preview (see buildCollageGradientSvg for the CSS-angle↔SVG-vector mapping).
    // Mutually exclusive with transparent + a bg photo (the editor clears those when
    // a gradient is chosen), so it can't double-composite with the bg-photo below.
    const gradient = transparent ? undefined : layout.canvas.gradient;
    // v2.1 round 239 (Terry) — MESH is base+blobs (no stops); route it to the mesh
    // bake. Linear/radial still use buildCollageGradientSvg (stops-based). Either way
    // the rasterized SVG is prepended as the BOTTOM layer (under the tiles).
    if (gradient && gradient.kind === 'mesh' && Array.isArray(gradient.blobs) && gradient.blobs.length >= 1) {
      try {
        const svg = buildCollageMeshSvg(W, H, gradient);
        const gradBuf = await sharp(Buffer.from(svg)).png().toBuffer();
        composites.unshift({ input: gradBuf, left: PAD, top: PAD });
      } catch (gradErr) {
        log.warn(`[collage] mesh background skipped (non-fatal): ${(gradErr as Error).message}`);
      }
    } else if (gradient && Array.isArray(gradient.stops) && gradient.stops.length >= 1) {
      try {
        // buildCollageGradientSvg takes the stops-based shape; the wider union's
        // optional stops are guaranteed present in this branch.
        const svg = buildCollageGradientSvg(W, H, { kind: gradient.kind === 'radial' ? 'radial' : 'linear', angle: gradient.angle, stops: gradient.stops });
        const gradBuf = await sharp(Buffer.from(svg)).png().toBuffer();
        composites.unshift({ input: gradBuf, left: PAD, top: PAD });
      } catch (gradErr) {
        log.warn(`[collage] gradient background skipped (non-fatal): ${(gradErr as Error).message}`);
      }
    }

    // v2.1 round 244 (Terry) — optional close-up MATERIAL SURFACE background. Rasterize
    // the full-canvas feTurbulence surface SVG at the OUTPUT W×H via sharp and prepend it
    // as the BOTTOM layer (under the tiles), matching the editor's full-canvas preview
    // (fixed 1000×1000 viewBox → identical noise scale). Mutually exclusive with gradient
    // + transparent + a bg photo (the editor clears those when a texture is chosen), so it
    // can't double-composite. The surface rect is opaque,
    // so it fully covers the base bg colour underneath.
    const texture = transparent ? undefined : layout.canvas.texture;
    if (texture && texture.id) {
      try {
        const svg = buildCollageTextureSvg(W, H, texture.id);
        if (svg) {
          const texBuf = await sharp(Buffer.from(svg)).png().toBuffer();
          composites.unshift({ input: texBuf, left: PAD, top: PAD });
        }
      } catch (texErr) {
        log.warn(`[collage] texture background skipped (non-fatal): ${(texErr as Error).message}`);
      }
    }

    // v2.1 round 142 (Terry) — optional background PHOTO, faded over the
    // solid colour at `opacity`. Prepended (bottom layer) so the tiles
    // sit on top. Resized cover to the canvas, alpha set to opacity so
    // the solid bg colour shows through underneath (the "Fade" slider).
    const bgImage = transparent ? undefined : layout.canvas.bgImage;
    if (bgImage && bgImage.path && fs.existsSync(toLongPath(bgImage.path))) {
      try {
        const op = Math.max(0, Math.min(1, Number.isFinite(bgImage.opacity) ? bgImage.opacity : 0.4));
        // v2.1 round 149 (Terry) — the background is enhanceable now: bake
        // its own Look/levels through the SAME tile pipeline (no crop, no
        // frame — borderColor is always '' for a background), then apply the
        // Fade via the alpha exactly as before.
        // v2.1 round 160 (Terry) — 'centre' so the saved background matches
        // the editor's centered cover (was 'attention' → shifted on save).
        const bgPipe = bgImage.enh
          ? buildCollageTilePipeline(sharp, toLongPath(bgImage.path), W, H, bgImage.enh, undefined, 'centre')
          : sharp(toLongPath(bgImage.path), { failOnError: false }).rotate().resize(W, H, { fit: 'cover', position: 'centre' });
        let bgBuf = await bgPipe
          .removeAlpha()      // drop any source alpha so the fade is uniform
          .ensureAlpha(op)    // whole image at `opacity` → bg colour shows through
          .png()
          .toBuffer();
        // v2.1 round 150 — Blend on the background = vignette its edges to
        // the base colour at the canvas border.
        const bgEnh2 = (bgImage.enh || {}) as CollageEnhance;
        bgBuf = await roundedFeatherMask(sharp, bgBuf, W, H, bgEnh2.corners, bgEnh2.blend);
        composites.unshift({ input: bgBuf, left: PAD, top: PAD });
      } catch (bgErr) {
        log.warn(`[collage] background image skipped (non-fatal): ${(bgErr as Error).message}`);
      }
    }

    // v2.1 round 185 (Text #1) — composite the text layers ON TOP of the tiles
    // (and background). Each pngBase64 is a transparent PNG already rendered at
    // the OUTPUT short side by the renderer's renderTextToCanvas, so it lands at
    // the same relative position + size as the on-screen preview. We only decode
    // + place it (optionally rotating about its centre). Anchored CENTRE at
    // xFrac/yFrac, in the SAME +PAD coordinate system as the tiles, then clamped
    // to the padded base. The generous PAD means the clamp effectively never
    // fires (a centre-on-canvas layer can't reach a negative origin); if a future
    // huge layer did, it clamps to the base edge rather than erroring.
    if (Array.isArray(layout.texts)) {
      for (const t of layout.texts) {
        if (!t || !t.pngBase64) continue;
        try {
          const b64 = t.pngBase64.replace(/^data:image\/png;base64,/, '');
          let textBuf = Buffer.from(b64, 'base64');
          let textW = 0, textH = 0;
          const rot = ((t.rot || 0) % 360 + 360) % 360;
          if (rot > 0.1 && rot < 359.9) {
            const rotated = await sharp(textBuf)
              .rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
              .png()
              .toBuffer({ resolveWithObject: true });
            textBuf = rotated.data;
            textW = rotated.info.width;
            textH = rotated.info.height;
          } else {
            const meta = await sharp(textBuf).metadata();
            textW = meta.width || 0;
            textH = meta.height || 0;
          }
          if (textW < 1 || textH < 1) continue;
          const cx = clamp01(t.xFrac) * W;
          const cy = clamp01(t.yFrac) * H;
          let left = Math.round(cx - textW / 2) + PAD;
          let top = Math.round(cy - textH / 2) + PAD;
          left = Math.max(0, Math.min(baseW - textW, left));
          top = Math.max(0, Math.min(baseH - textH, top));
          composites.push({ input: textBuf, left, top });
        } catch (txtErr) {
          log.warn(`[collage] text layer skipped (non-fatal): ${(txtErr as Error).message}`);
        }
      }
    }

    // v2.1 round 238 (Terry) — WHOLE-COLLAGE finishing treatments (Vignette + Grain),
    // composited as the TOP layer over the finished collage (tiles + bg + text), AFTER
    // everything else, so they're whole-image finishes independent of the bg kind —
    // matching the editor's canvas overlays (z above the tiles + text). Both span the
    // visible W×H at +PAD so they register exactly with the extracted output. 0 = skip.
    const vignette = Math.max(0, Math.min(100, Number(layout.canvas.vignette) || 0));
    if (vignette > 0) {
      try {
        const vigBuf = await sharp(Buffer.from(buildCollageVignetteSvg(W, H, vignette, String(layout.canvas.vignetteShape || 'ellipse')))).png().toBuffer();
        composites.push({ input: vigBuf, left: PAD, top: PAD });
      } catch (vigErr) {
        log.warn(`[collage] vignette skipped (non-fatal): ${(vigErr as Error).message}`);
      }
    }
    // v2.1 round 325 (Terry) — grain 0-100 (doubled effect); bake matches the preview.
    const grain = Math.max(0, Math.min(100, Number(layout.canvas.grain) || 0));
    if (grain > 0) {
      try {
        const grainBuf = await sharp(Buffer.from(buildCollageGrainSvg(W, H, grain))).png().toBuffer();
        // 'overlay' blend matches the preview's mix-blend-mode:overlay (the SVG already
        // carries the slider-scaled opacity on its rect).
        composites.push({ input: grainBuf, left: PAD, top: PAD, blend: 'overlay' });
      } catch (grainErr) {
        log.warn(`[collage] grain skipped (non-fatal): ${(grainErr as Error).message}`);
      }
    }

    // Two pipelines, deliberately: sharp applies .composite() at the
    // END of a pipeline, AFTER .extract(). Chaining composite→extract in
    // one call would crop the still-empty padded base first, then drop
    // the +PAD-offset tiles off the small canvas (a blank background was
    // the symptom). So composite onto the padded base → buffer, then
    // extract the centre region in a fresh pipeline.
    const paddedBuf = await sharp({
      create: { width: baseW, height: baseH, channels: 4, background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : { ...bg, alpha: 1 } },
    })
      .composite(composites)
      .png()
      .toBuffer();
    // Transparent → keep the alpha + save PNG; otherwise flatten onto the bg
    // colour + save JPEG (smaller, no needless alpha).
    const collageBuf = transparent
      ? await sharp(paddedBuf).extract({ left: PAD, top: PAD, width: W, height: H }).png().toBuffer()
      : await sharp(paddedBuf).extract({ left: PAD, top: PAD, width: W, height: H }).flatten({ background: bg }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    log.info(`[collage] baked composite (${composites.length} photos, ${W}×${H})`);
    return collageBuf;
  }
}

// v2.1 round 333 (Terry) — render a small PNG THUMBNAIL of a collage layout for the Collages
// Welcome Screen recent/template cards, WITHOUT saving to the library. Returns a data-URL (or
// null on failure). The renderer scales the layout down first so this bake stays cheap.
// v2.1 round 346 (Terry) — WYSIWYG EXPORT. Render the REAL collage DOM (viewer.html — the SAME code as
// the editor) at full export px in an off-screen window, then capturePage it. The saved image is the
// exact editor render, ending the sharp re-draw drift (bg / faded glow / coverFill mismatches). Takes a
// snapshotCollage() JSON string; the off-screen window restores it via window.__collageExportRender and
// returns the canvas rect to clip. The window is shown with opacity 0 (off-screen-invisible) only so
// Chromium paints a frame for capturePage — the user never sees it.
// v3.0 (Terry, Tier-3 #11) — `transparent` renders the off-screen window WITH an alpha channel, so a
// transparent-background collage exports as a true WYSIWYG see-through PNG (offscreen rendering supports
// transparent windows; the paint frames carry the page's alpha). The renderer side cooperates by not
// painting the checkerboard cue and hiding the editor chrome behind the canvas during a transparent
// export render (the checkerboard is an EDITOR cue, not content). Opaque exports keep the exact same
// non-transparent window as before — zero change to that path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function captureCollageExport(snapshot: string, w: number, h: number, transparent = false): Promise<Buffer> {
  // v3.0 round 541 (Terry) — width ceiling 8000 → 11000 so a full 10-page carousel
  // (10×1080 = 10800 wide) can render WYSIWYG; offscreen windows aren't screen-clamped.
  const W = Math.max(16, Math.min(11000, Math.round(w || 1080)));
  const H = Math.max(16, Math.min(8000, Math.round(h || 1350)));
  // OFFSCREEN rendering: the page renders to a bitmap with no visible window (no flash), and the
  // 'paint' event delivers full-window frames. (capturePage on a hidden / opacity-0 window came back
  // blank — Chromium doesn't paint an invisible window; offscreen always produces frames.) The window
  // content is W×H and the export-mode CSS makes the canvas fill it, so each frame IS the collage.
  const win = new BrowserWindow({
    show: false, width: W, height: H, useContentSize: true, frame: false, enableLargerThanScreen: true,
    ...(transparent ? { transparent: true, backgroundColor: '#00000000' } : {}),
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  });
  try { win.setContentSize(W, H); } catch { /* noop */ }   // enforce the FULL export size (a window is otherwise clamped to the screen work-area, which cropped tall exports)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastPaint: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  win.webContents.on('paint', (_e: any, _dirty: any, image: any) => { lastPaint = image; });
  try {
    win.webContents.setFrameRate(30);
    const viewerHtml = path.join(__dirname, '../dist/public/viewer.html');
    await win.loadFile(viewerHtml, { query: { collageExport: '1' } });
    try { win.setContentSize(W, H); } catch { /* noop */ }   // re-assert after load (before the render)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rect: any = await win.webContents.executeJavaScript(`window.__collageExportRender(${JSON.stringify({ snapshot, w: W, h: H })})`);
    if (!rect || rect.error) throw new Error('export render failed: ' + (rect && rect.error ? rect.error : 'no rect'));
    if (rect.dbg) log.info(`[collage] wysiwyg render dbg: ${JSON.stringify(rect.dbg)}`);
    // OFFSCREEN renders to a bitmap at the FULL W×H — no screen-size clamp (a VISIBLE window taller than
    // the monitor gets cropped to the screen, which clipped the export). The 'paint' event delivers
    // full-window frames; grab the latest after the render + image loads settle (invalidate nudges a
    // frame for an otherwise-static page).
    await new Promise((r) => setTimeout(r, 250));
    try { win.webContents.invalidate(); } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 300));
    if (!lastPaint) throw new Error('no paint frame from the offscreen export window');
    return (lastPaint as { toPNG: () => Buffer }).toPNG();
  } finally {
    try { win.destroy(); } catch { /* noop */ }
  }
}

// v2.1 round 346 (Terry) — TEMP test handler for the WYSIWYG capture: writes a temp PNG, returns its
// path so the result can be inspected + compared to the editor before wiring Save over to it.
ipcMain.handle('collage:captureExportTest', async (_e, snapshot: string, w: number, h: number, transparent?: boolean) => {
  try {
    const buf = await captureCollageExport(snapshot, w, h, !!transparent);
    const p = path.join(app.getPath('temp'), 'pdr-wysiwyg-test.png');
    fs.writeFileSync(p, buf);
    return { ok: true, path: p, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});
ipcMain.handle('collage:renderThumb', async (_event, layout: CollageLayout, pageCount?: number) => {
  try {
    if (!layout || !layout.canvas || !Array.isArray(layout.items) || layout.items.length === 0) return null;
    const sharp = (await import('sharp')).default;
    let buf = await bakeCollageLayout(layout);
    // v3.0 (Terry 2026-07-05) — a CAROUSEL bakes as a wide N-page strip; squished into the 4:3 gallery
    // card it looked broken (sparse pages + background). Crop to the FIRST PAGE so the card shows a
    // clean representative slide (like IG shows a carousel's first frame); the card gets a "pages" badge.
    const N = Math.max(0, Math.round(pageCount || 0));
    if (N > 1) {
      const meta = await sharp(buf).metadata();
      const W = meta.width || 0, H = meta.height || 0;
      if (W > 0 && H > 0) {
        const pw = Math.max(1, Math.min(W, Math.round(W / N)));
        const page1 = await sharp(buf).extract({ left: 0, top: 0, width: pw, height: H }).png().toBuffer();
        // v3.0 round 584 (Terry) — only ADOPT the page-1 crop if it actually has content. A carousel
        // whose page 1 is still empty (photo sits on a later page) would otherwise thumbnail to a blank
        // slide; in that case keep the FULL strip so the visible content still shows in the card.
        try {
          const st = await sharp(page1).stats();
          const maxStd = Math.max(...st.channels.map((c) => c.stdev));
          if (maxStd >= 12) buf = page1;
        } catch { buf = page1; }
      }
    }
    const png = await sharp(buf).resize(360, 540, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    return 'data:image/png;base64,' + png.toString('base64');
  } catch (err) {
    log.warn(`[collage] renderThumb failed (non-fatal): ${(err as Error).message}`);
    return null;
  }
});
// v3.0 (Terry 2026-07-05) — bake JUST the crisp glow for a single cut-out tile (silhouette outline,
// transparent centre) through the SAME sharp engine as the thumbnail. The editor lays this behind the
// live photo so the live preview + the saved (WYSIWYG) photo match the thumbnail's crisp outline
// instead of a CSS box-shadow rectangle / smudge. Returns a data URL + pad (extra px each side for the
// glow spill) so the client can position it. Returns ok:false when there's no edge fx (nothing to show).
ipcMain.handle('collage:bakeCutoutGlow', async (_e, args: { path: string; enh: CollageEnhance; w: number; h: number; op?: number; crop?: { l: number; t: number; r: number; b: number } }) => {
  try {
    const a = args || ({} as { path?: string; enh?: CollageEnhance; w?: number; h?: number; op?: number; crop?: { l: number; t: number; r: number; b: number } });
    if (!a.path || !a.w || !a.h) return { ok: false };
    const w = Math.max(4, Math.round(a.w)), h = Math.max(4, Math.round(a.h));
    const sharp = (await import('sharp')).default;
    const src = await fs.promises.readFile(toLongPath(a.path));
    let img = sharp(src).ensureAlpha();
    // v3.0 (Terry 2026-07-05) — honour the tile's CROP so the glow follows the VISIBLE (cropped)
    // silhouette, not the full photo. Without this, a cropped cut-out's glow was offset/scaled wrong.
    const cr = a.crop;
    if (cr && (cr.l > 0.001 || cr.t > 0.001 || cr.r < 0.999 || cr.b < 0.999)) {
      const meta = await img.metadata();
      const W = meta.width || 0, H = meta.height || 0;
      if (W > 0 && H > 0) {
        const left = Math.max(0, Math.round(cr.l * W)), top = Math.max(0, Math.round(cr.t * H));
        const cw = Math.max(1, Math.min(W - left, Math.round((cr.r - cr.l) * W)));
        const ch = Math.max(1, Math.min(H - top, Math.round((cr.b - cr.t) * H)));
        img = sharp(await img.extract({ left, top, width: cw, height: ch }).png().toBuffer()).ensureAlpha();
      }
    }
    const tile = await img.resize(w, h, { fit: 'fill' }).ensureAlpha().png().toBuffer();
    const r = await buildTileEdgeFx(sharp, tile, w, h, a.enh || {}, typeof a.op === 'number' ? a.op : 1, true);
    if (!r) return { ok: false };
    return { ok: true, dataUrl: 'data:image/png;base64,' + r.buf.toString('base64'), w: r.w, h: r.h, pad: Math.round((r.w - w) / 2) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
});
ipcMain.handle('collage:saveLayout', async (_event, layout: CollageLayout, opts?: { snapshot?: string; w?: number; h?: number; album?: string; name?: string; caption?: string; replaceFileId?: number }) => {
  try {
    // v3.0 (Terry) — Free-account cap of 5 saved collages (lifetime usage; a NEW save only —
    // Updating an existing collage doesn't count again).
    const isNewCollage = !(opts && typeof opts.replaceFileId === 'number');
    if (isNewCollage && await trialCapReached('collages', FREE_COLLAGE_LIMIT)) {
      return { success: false, error: `Your free account can save up to ${FREE_COLLAGE_LIMIT} collages. Upgrade for unlimited.`, limit: 'collages' as const };
    }
    // v2.1 round 346 (Terry) — WYSIWYG export: when the renderer sends the editor snapshot, save the
    // REAL collage render (captureCollageExport → off-screen viewer.html at full px → capturePage), so
    // the file is EXACTLY what's on screen. Falls back to the sharp re-draw (bakeCollageLayout) when
    // there's no snapshot or on capture failure.
    // v3.0 (Terry, Tier-3 #11) — transparent collages now go through the SAME WYSIWYG path (the capture
    // window renders with alpha), so a see-through PNG carries everything the editor shows — glow/blur
    // background elements, effects, text — instead of the old feature-lagging sharp re-draw.
    const transparent = !!layout.canvas.transparent;
    let collageBuf: Buffer | null = null;
    let W = Math.max(600, Math.min(2400, Math.round(layout.canvas.w || 2000)));
    let H = Math.max(450, Math.min(2400, Math.round(layout.canvas.h || 1500)));
    if (opts && opts.snapshot) {
      try {
        const png = await captureCollageExport(opts.snapshot, opts.w || W, opts.h || H, transparent);
        const sharpLib = (await import('sharp')).default;
        const meta = await sharpLib(png).metadata();
        if (meta.width && meta.height) { W = meta.width; H = meta.height; }
        // Transparent → keep the alpha (PNG); opaque → JPEG as before.
        collageBuf = transparent
          ? await sharpLib(png).png().toBuffer()
          : await sharpLib(png).jpeg({ quality: 92 }).toBuffer();
      } catch (capErr) {
        log.warn(`[collage] WYSIWYG capture failed, falling back to re-draw: ${(capErr as Error).message}`);
      }
    }
    if (!collageBuf) collageBuf = await bakeCollageLayout(layout);

    const capturedAt = new Date();
    const { date, time, month } = timestampParts(capturedAt);
    const libRoot = onlineLibraryRoot();
    const destDir = libRoot ? path.join(libRoot, 'PDR Captures', month) : pendingDir();
    fs.mkdirSync(toLongPath(destDir), { recursive: true });
    const outPath = uniqueCapturePath(destDir, `${date}_${time}_CO`, transparent ? '.png' : '.jpg');
    fs.writeFileSync(toLongPath(outPath), collageBuf);
    const filename = path.basename(outPath);
    await stampCaptureMetadata(outPath, capturedAt, 'collage', opts && opts.caption ? opts.caption : undefined, opts && opts.name ? opts.name : undefined);

    let fileId: number | null = null;
    let savedAlbumId: number | null = null;   // v3.0 (Terry) — the PDR Collages ‹category› album this filed into (for the "View in Albums" jump)
    if (libRoot) {
      try {
        fileId = await indexCapturedFile(outPath, libRoot, capturedAt, W, H, 'photo');
        // v2.1 round 364 (Terry) — the user's caption NOTE (from the Collages caption button), if any,
        // becomes the exported file's caption so it carries to Albums. The collage NAME is a SEPARATE
        // pseudonym written to the title tags (above), NOT the caption. Non-fatal.
        if (fileId != null && opts && opts.caption && opts.caption.trim()) {
          try { const { setFileCaption } = await import('./search-database.js'); setFileCaption(fileId, opts.caption.trim()); } catch (capErr) { log.warn(`[collage] set caption failed (non-fatal): ${(capErr as Error).message}`); }
        }
        // v3.0 (Terry) — store the collage's category·type name so Albums can show it under the tile + filter by type.
        if (fileId != null && opts && opts.name && opts.name.trim()) {
          try { const { setCollageName } = await import('./search-database.js'); setCollageName(fileId, opts.name.trim()); } catch (nameErr) { log.warn(`[collage] set collage name failed (non-fatal): ${(nameErr as Error).message}`); }
        }
        // v2.1 round 161 (Terry) — every saved collage joins a "PDR Collages"
        // album (created on first save), so they're all gathered in one place
        // in the Albums view. Non-fatal: a failure here never blocks the save.
        // v2.1 round 162 (Terry) — gated on Settings → Capture toggle (default on).
        const wantCollagesAlbum = (() => { try { return getSettings().saveCollagesToAlbum !== false; } catch { return true; } })();
        if (fileId != null && wantCollagesAlbum) {
          try {
            // v2.1 round 353 / v3.0 (Terry) — single collages file into PDR Collages › Collages › ‹category›
            // (the category picked in the export wizard, default "General"). The kind-folder keeps single
            // collages separate from carousels under the one PDR Collages source.
            const { ensureCollageKindFolders, findOrCreateCollageAlbumInFolder, addPhotosToAlbum } = await import('./search-database.js');
            const albumTitle = (opts && typeof opts.album === 'string' && opts.album.trim()) ? opts.album.trim() : 'General';
            const folders = ensureCollageKindFolders();
            const albumId = findOrCreateCollageAlbumInFolder(albumTitle, folders.collages);
            if (albumId != null) { addPhotosToAlbum(albumId, [fileId]); savedAlbumId = albumId; }
          } catch (albErr) {
            log.warn(`[collage] add to PDR Collages source failed (non-fatal): ${(albErr as Error).message}`);
          }
        }
        // v3.0 (Terry) — "Update" a collage: the renderer passes the PREVIOUS export's fileId. We've just
        // written the new export; now delete the old file + its row so the album keeps ONE current photo
        // per collage (not a pile of near-identical copies). The new file has a fresh path, so its
        // thumbnail regenerates on its own (no cache busting needed). Non-fatal + self-delete guarded.
        if (fileId != null && opts && typeof opts.replaceFileId === 'number' && opts.replaceFileId !== fileId) {
          try {
            const { getFileById, deleteIndexedFiles } = await import('./search-database.js');
            const old = getFileById(opts.replaceFileId);
            if (old && old.file_path && path.resolve(old.file_path) !== path.resolve(outPath)) {
              try { fs.unlinkSync(toLongPath(old.file_path)); } catch (_) {}
              deleteIndexedFiles([opts.replaceFileId]);
            }
          } catch (repErr) {
            log.warn(`[collage] replace previous export failed (non-fatal): ${(repErr as Error).message}`);
          }
        }
        // v2.1 round 366 (Terry) — broadcast AFTER the album filing so the open Albums view (which now
        // auto-reloads on this event) sees the new file's album membership. Broadcasting before the filing
        // raced the membership write, so the export didn't appear until you switched albums + back.
        if (fileId != null) broadcast('library:filesAdded', { reason: 'collage', newFilePath: outPath, fileId });
      } catch (idxErr) {
        log.warn(`[collage] composite index pass failed (file saved): ${(idxErr as Error).message}`);
      }
    }
    log.info(`[collage] saved freeform composite ${filename} (${W}×${H})${fileId != null ? ` → id ${fileId}` : libRoot ? '' : ' → pending'}`);
    if (isNewCollage) await bumpTrialUsage('collages');
    return { success: true, filePath: outPath, filename, fileId, albumId: savedAlbumId, pending: !libRoot };
  } catch (err) {
    log.warn(`[collage] saveLayout failed: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
});

// v2.1 round 260 (Terry) — carousel wide: SLICED EXPORT. The carousel is now ONE
// WIDE canvas (layout.canvas.w = pageCount*1080, h = 1350). We bake it ONCE through
// the shared pipeline (bakeCollageLayout) — so a spanning gradient / background / tile
// is rendered continuously across the whole strip — then crop N slices of EXACTLY
// 1080×1350 from the single baked buffer. Bake-once+extract (vs N separate bakes) is
// chosen so the seams between slides are pixel-continuous: any cross-page element is
// composited in one coordinate system and only cut afterwards, leaving no resize /
// rounding mismatch at the 1080 boundaries.
//
// Each slice is written into ONE dedicated subfolder `PDR Captures/<month>/
// Carousel_<YYYYMMDD_HHmmss>/` as slide_01.jpg … slide_NN.jpg (slide_NN.png when the
// canvas is transparent), then stamped + indexed (each at 1080×1350) + added to the
// "PDR Carousels" album (same Settings gate as the single save, separate album) — the
// index/album tail is the SAME as the per-slide loop it replaces. v2.1 round 273 (Terry):
// carousels get their OWN "PDR Carousels" album (single collages stay in "PDR Collages").
// Returns the file list + folder so the
// renderer reveals the folder (a single Viewer open is wrong for N files). Shape
// unchanged: { success, files, folderPath, count, pending }.
const CAROUSEL_SLICE_W = 1080;
const CAROUSEL_SLICE_H = 1350;
ipcMain.handle('collage:saveCarousel', async (_event, layout: CollageLayout, pageCount: number, opts?: { name?: string; caption?: string; album?: string; snapshot?: string; w?: number; h?: number; replaceAlbumId?: number }) => {
  try {
    // v3.0 (Terry) — Free-account cap of 5 saved carousels (lifetime usage; a NEW save only).
    const isNewCarousel = !(opts && typeof opts.replaceAlbumId === 'number');
    if (isNewCarousel && await trialCapReached('carousels', FREE_CAROUSEL_LIMIT)) {
      return { success: false, error: `Your free account can save up to ${FREE_CAROUSEL_LIMIT} carousels. Upgrade for unlimited.`, limit: 'carousels' as const };
    }
    const n = Math.max(1, Math.round(Number(pageCount) || 0));
    if (!layout || !layout.canvas || !Array.isArray(layout.items) || layout.items.length === 0) {
      return { success: false, error: 'Nothing to save — the carousel is empty.' };
    }
    // v3.0 round 541 (Terry) — the carousel now saves WYSIWYG like a single collage: render the
    // REAL wide canvas (captureCollageExport → off-screen viewer.html at full wide px) so the
    // layered background — Blended gradients, Glow/Blur circles, grain/pixelate, the new
    // background-photo effects — lands in the slices exactly as on screen. Terry hit the gap:
    // the sharp re-draw (bakeCollageLayout) pre-dates all of that, so his background changes
    // silently vanished from the saved carousel. The re-draw stays as the on-failure fallback.
    let wideBuf: Buffer | null = null;
    if (opts && opts.snapshot) {
      try {
        wideBuf = await captureCollageExport(opts.snapshot, opts.w || layout.canvas.w, opts.h || layout.canvas.h, !!layout.canvas.transparent);
      } catch (capErr) {
        log.warn(`[collage] carousel WYSIWYG capture failed, falling back to re-draw: ${(capErr as Error).message}`);
      }
    }
    // Bake fallback: bakeCollageLayout throws on empty/unreadable, turning the same
    // message strings into { success:false, error } via the catch.
    if (!wideBuf) wideBuf = await bakeCollageLayout(layout);
    const sharp = (await import('sharp')).default;
    // The wide bake width MUST equal pageCount*1080 so the crops land on clean 1080
    // boundaries (bakeCollageLayout's W ceiling is 11000, above 10*1080, so it never
    // clamps a valid carousel below N*1080). Read the real baked dims back and assert
    // every slice fits — never extract past the buffer (sharp would throw).
    const wideMeta = await sharp(wideBuf).metadata();
    const wideWidth = wideMeta.width || 0;
    const wideHeight = wideMeta.height || 0;
    const transparent = !!(layout.canvas && layout.canvas.transparent);

    const capturedAt = new Date();
    const { date, time, month } = timestampParts(capturedAt);
    const stamp = `${capturedAt.getFullYear()}${pad(capturedAt.getMonth() + 1)}${pad(capturedAt.getDate())}_${pad(capturedAt.getHours())}${pad(capturedAt.getMinutes())}${pad(capturedAt.getSeconds())}`;
    const libRoot = onlineLibraryRoot();
    const baseDir = libRoot ? path.join(libRoot, 'PDR Captures', month) : pendingDir();
    const folderPath = path.join(baseDir, `Carousel_${stamp}`);
    fs.mkdirSync(toLongPath(folderPath), { recursive: true });

    // v3.0 round 542 (Terry) — UPDATE parity with collages: a re-save REPLACES the previous
    // carousel save (its slides + wide file + its album) instead of stacking a new copy per
    // save. Runs only after the new wide render succeeded above, so a failed save can never
    // destroy the previous good one. Same delete pattern as the single-collage replaceFileId.
    if (opts && typeof opts.replaceAlbumId === 'number') {
      try {
        const sdb = await import('./search-database.js');
        const oldPhotos = sdb.listAlbumPhotos(opts.replaceAlbumId);
        const oldIds: number[] = [];
        let oldDir: string | null = null;
        for (const oldP of oldPhotos) {
          oldIds.push(oldP.id);
          if (oldP.file_path) {
            if (!oldDir) oldDir = path.dirname(oldP.file_path);
            try { fs.unlinkSync(toLongPath(oldP.file_path)); } catch { /* already gone */ }
          }
        }
        if (oldIds.length) sdb.deleteIndexedFiles(oldIds);
        sdb.deleteAlbum(opts.replaceAlbumId);
        // The old per-carousel export folder is empty now — tidy it (best-effort; guarded to
        // OUR Carousel_<stamp> naming so a mis-set path can never remove a user folder).
        if (oldDir && /Carousel_\d{8}_\d{6}$/.test(oldDir)) { try { fs.rmdirSync(toLongPath(oldDir)); } catch { /* not empty / gone */ } }
        log.info(`[collage] carousel update: replaced previous save (album ${opts.replaceAlbumId}, ${oldIds.length} file(s))`);
      } catch (updErr) {
        log.warn(`[collage] carousel update: removing the previous save failed (non-fatal): ${(updErr as Error).message}`);
      }
    }

    // Album helpers imported once (not per slide). Same Settings gate + lookup/create
    // pattern as the single save, but carousel slides land in PDR Collages › Carousels › ‹category›
    // (kept separate from single collages' "Collages" folder, under the one PDR Collages source).
    // v3.0 (Terry) — was a flat user_created "PDR Carousels" album; now a kind-folder + category.
    const wantCollagesAlbum = (() => { try { return getSettings().saveCollagesToAlbum !== false; } catch { return true; } })();
    // v3.0 (Terry) — each carousel is its OWN album (cover = the wide overview, name = the collage name) under
    // PDR Collages › Carousels › ‹category›, so a carousel reads as one clickable unit, not loose pages.
    let albumId: number | null = null;
    let addPhotosToAlbum: ((id: number, ids: number[]) => unknown) | null = null;
    let setAlbumCover: ((albumId: number, fileId: number | null) => void) | null = null;
    if (libRoot && wantCollagesAlbum) {
      try {
        const sdb = await import('./search-database.js');
        const category = (opts && typeof opts.album === 'string' && opts.album.trim()) ? opts.album.trim() : 'General';
        const carouselName = sdb.collageTypeFromName(opts && opts.name ? opts.name : null) || `Carousel ${date} ${time}`;
        const categoryFolderId = sdb.ensureCarouselCategoryFolder(category);
        albumId = sdb.createCarouselAlbum(carouselName, categoryFolderId);
        addPhotosToAlbum = sdb.addPhotosToAlbum;
        setAlbumCover = sdb.setAlbumCover;
      } catch (albErr) {
        log.warn(`[collage] carousel album prep failed (non-fatal): ${(albErr as Error).message}`); // v3.0 (Terry)
      }
    }

    // v3.0 (Terry) — save the WIDE design (the cohesive overview the pages were sliced from) as its own
    // long-dated library file, index it, and make it the carousel album's COVER + first photo. This is the
    // previously-missing carousel file; it also names + covers the carousel folder.
    let wideFileId: number | null = null;
    let wideOutPath: string | null = null;   // v3.0 round 542 (Terry) — returned so the post-save Viewer can open the wide design FIRST
    if (libRoot) {
      try {
        const wideOut = uniqueCapturePath(folderPath, `${date}_${time}_CW`, transparent ? '.png' : '.jpg');
        wideOutPath = wideOut;
        const wideOutBuf = transparent ? await sharp(wideBuf).png().toBuffer() : await sharp(wideBuf).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
        fs.writeFileSync(toLongPath(wideOut), wideOutBuf);
        await stampCaptureMetadata(wideOut, capturedAt, 'collage', opts && opts.caption ? opts.caption : undefined, opts && opts.name ? opts.name : undefined);
        wideFileId = await indexCapturedFile(wideOut, libRoot, capturedAt, wideWidth, wideHeight, 'photo');
        if (wideFileId != null) {
          broadcast('library:filesAdded', { reason: 'collage', newFilePath: wideOut, fileId: wideFileId });
          try {
            const sdb = await import('./search-database.js');
            if (opts && opts.caption && opts.caption.trim()) sdb.setFileCaption(wideFileId, opts.caption.trim());
            if (opts && opts.name && opts.name.trim()) sdb.setCollageName(wideFileId, opts.name.trim());
            if (albumId != null) {
              // The wide overview joins the album (ordered first as the full-design reference) but is NOT the
              // cover — see the first-page cover set after the slides are saved (Terry: the wide file distorts
              // as a square tile).
              if (addPhotosToAlbum) addPhotosToAlbum(albumId, [wideFileId]);
            }
          } catch (wMetaErr) { log.warn(`[collage] carousel wide-file album/cover failed (non-fatal): ${(wMetaErr as Error).message}`); }
        }
      } catch (wideErr) {
        log.warn(`[collage] carousel wide-file save failed (non-fatal): ${(wideErr as Error).message}`);
      }
    }

    const files: Array<{ filePath: string; filename: string; fileId: number | null }> = [];
    for (let i = 0; i < n; i++) {
      const left = i * CAROUSEL_SLICE_W;
      // Slice-accuracy guard: the crop must sit wholly inside the baked buffer.
      // If the bake came back narrower than expected (clamp / unexpected dims),
      // stop rather than ask sharp to extract past the edge (which throws).
      if (left + CAROUSEL_SLICE_W > wideWidth || CAROUSEL_SLICE_H > wideHeight) {
        log.warn(`[collage] carousel slice ${i + 1} out of bounds (left ${left}+${CAROUSEL_SLICE_W} > wide ${wideWidth}×${wideHeight}) — stopping`);
        break;
      }
      let buf: Buffer;
      try {
        // Each slice is EXACTLY 1080×1350. PNG when transparent (keep alpha),
        // else mozjpeg q92 — matching the single-collage encoder choice.
        const slice = sharp(wideBuf).extract({ left, top: 0, width: CAROUSEL_SLICE_W, height: CAROUSEL_SLICE_H });
        buf = transparent
          ? await slice.png().toBuffer()
          : await slice.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
      } catch (sliceErr) {
        log.warn(`[collage] carousel slice ${i + 1} extract failed (${(sliceErr as Error).message})`);
        continue;
      }
      const filename = `slide_${String(i + 1).padStart(2, '0')}${transparent ? '.png' : '.jpg'}`;
      const outPath = path.join(folderPath, filename);
      fs.writeFileSync(toLongPath(outPath), buf);
      await stampCaptureMetadata(outPath, capturedAt, 'collage', opts && opts.caption ? opts.caption : undefined, opts && opts.name ? opts.name : undefined);

      let fileId: number | null = null;
      if (libRoot) {
        try {
          // Each slide is indexed at its true 1080×1350 (not the wide canvas dims).
          fileId = await indexCapturedFile(outPath, libRoot, capturedAt, CAROUSEL_SLICE_W, CAROUSEL_SLICE_H, 'photo');
          if (fileId != null) broadcast('library:filesAdded', { reason: 'collage', newFilePath: outPath, fileId });
          // v2.1 round 373 (Terry) — carousel slides carry the collage's caption NOTE (+ the NAME travels
          // via the title tags written by stampCaptureMetadata above), like a single-collage export.
          if (fileId != null && opts && opts.caption && opts.caption.trim()) {
            try { const { setFileCaption } = await import('./search-database.js'); setFileCaption(fileId, opts.caption.trim()); } catch (capErr) { log.warn(`[collage] carousel slide ${i + 1} set caption failed (non-fatal): ${(capErr as Error).message}`); }
          }
          // v3.0 (Terry) — each slide carries the carousel's category·type name (for the Albums Type label + filter).
          if (fileId != null && opts && opts.name && opts.name.trim()) {
            try { const { setCollageName } = await import('./search-database.js'); setCollageName(fileId, opts.name.trim()); } catch (nameErr) { log.warn(`[collage] carousel slide ${i + 1} set collage name failed (non-fatal): ${(nameErr as Error).message}`); }
          }
          if (fileId != null && albumId != null && addPhotosToAlbum) {
            try { addPhotosToAlbum(albumId, [fileId]); }
            catch (albErr) { log.warn(`[collage] carousel slide ${i + 1} album-add failed (non-fatal): ${(albErr as Error).message}`); }
          }
        } catch (idxErr) {
          log.warn(`[collage] carousel slide ${i + 1} index pass failed (file saved): ${(idxErr as Error).message}`);
        }
      }
      files.push({ filePath: outPath, filename, fileId });
    }

    if (files.length === 0) {
      return { success: false, error: 'None of the slides could be saved.' };
    }

    // v3.0 (Terry) — the carousel COVER is its FIRST PAGE (slide_01), not the wide overview: the 4320×1350
    // overview distorts badly cropped into a square tile, whereas a page reads cleanly.
    if (albumId != null && setAlbumCover) {
      const firstPageId = files.find((f) => f.fileId != null)?.fileId ?? null;
      if (firstPageId != null) { try { setAlbumCover(albumId, firstPageId); } catch { /* non-fatal */ } }
    }
    log.info(`[collage] saved carousel — ${files.length}/${n} slide(s) sliced from ${wideWidth}×${wideHeight} → ${folderPath}${libRoot ? '' : ' (pending)'}`);
    // v3.0 round 542 (Terry) — wideFile lets the renderer open the joined wide design FIRST in
    // the Viewer (it sits at the front in Albums; the post-save Viewer should match).
    // v3.0 round 546 (Terry) — + its library file id, so the editor's "View" goto can open the
    // wide design directly (mirrors a single collage's exportedFileId).
    if (isNewCarousel) await bumpTrialUsage('carousels');
    return { success: true, files, folderPath, count: files.length, albumId, wideFile: wideOutPath ? { filePath: wideOutPath, filename: path.basename(wideOutPath), fileId: wideFileId } : null, pending: !libRoot };
  } catch (err) {
    log.warn(`[collage] saveCarousel failed: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
});

// v2.1 round 182 (Terry) — save the single-photo Viewer's background cut-out as a
// new transparent PNG in the library. The temp file is ALREADY a transparent PNG
// (the bg-remover worker's output) — copy its bytes verbatim (no re-encode/flatten)
// into PDR Captures and index it, mirroring the tail of collage:saveLayout. Unlike
// collages it does NOT join the "PDR Collages" album.
ipcMain.handle(
  'viewer:saveCutout',
  async (
    _event,
    req: {
      tempPath: string;
      originalPath?: string;
      // v2.1 round 184 (Terry) — the backdrop the cut-out is placed on.
      bg?: { type: 'transparent' | 'color' | 'photo'; value: string };
    },
  ) => {
    try {
      if (!req || !req.tempPath || !fs.existsSync(toLongPath(req.tempPath))) {
        return { success: false, error: 'Cut-out not found.' };
      }
      const sharp = (await import('sharp')).default;
      const capturedAt = new Date();
      const { date, time, month } = timestampParts(capturedAt);
      const libRoot = onlineLibraryRoot();
      const destDir = libRoot ? path.join(libRoot, 'PDR Captures', month) : pendingDir();
      fs.mkdirSync(toLongPath(destDir), { recursive: true });
      const base = req.originalPath
        ? `${path.basename(req.originalPath, path.extname(req.originalPath))}_BG`
        : `${date}_${time}_BG`;

      // v2.1 round 184 (Terry) — compose the cut-out onto the chosen backdrop:
      //  • transparent / missing → keep today's behaviour: the temp PNG verbatim.
      //  • colour → flatten the transparent areas to the colour → JPEG.
      //  • photo  → cover-fit the backdrop photo to the cut-out's pixel size,
      //    composite the cut-out over it → JPEG.
      const bgType = req.bg?.type;
      let outBuf: Buffer;
      let ext: '.png' | '.jpg';
      if (bgType === 'color') {
        outBuf = await sharp(toLongPath(req.tempPath))
          .flatten({ background: hexToRgb(req.bg?.value || '#ffffff') })
          .jpeg({ quality: 92 })
          .toBuffer();
        ext = '.jpg';
      } else if (bgType === 'photo' && req.bg?.value && fs.existsSync(toLongPath(req.bg.value))) {
        const cutMeta = await sharp(toLongPath(req.tempPath)).metadata();
        const cutW = cutMeta.width ?? 0;
        const cutH = cutMeta.height ?? 0;
        if (cutW > 0 && cutH > 0) {
          const bgBuf = await sharp(toLongPath(req.bg.value))
            .resize(cutW, cutH, { fit: 'cover', position: 'attention' })
            .toBuffer();
          outBuf = await sharp(bgBuf)
            .composite([{ input: toLongPath(req.tempPath) }])
            .jpeg({ quality: 92 })
            .toBuffer();
          ext = '.jpg';
        } else {
          // Degenerate cut-out size — fall back to the verbatim transparent PNG.
          outBuf = fs.readFileSync(toLongPath(req.tempPath));
          ext = '.png';
        }
      } else {
        // transparent / missing → verbatim transparent PNG (unchanged behaviour).
        outBuf = fs.readFileSync(toLongPath(req.tempPath));
        ext = '.png';
      }

      const outPath = uniqueCapturePath(destDir, base, ext);
      fs.writeFileSync(toLongPath(outPath), outBuf);
      const filename = path.basename(outPath);
      await stampCaptureMetadata(outPath, capturedAt, 'cutout');

      let fileId: number | null = null;
      if (libRoot) {
        try {
          const meta = await sharp(outBuf).metadata();
          fileId = await indexCapturedFile(outPath, libRoot, capturedAt, meta.width ?? null, meta.height ?? null, 'photo');
          if (fileId != null) broadcast('library:filesAdded', { reason: 'cutout', newFilePath: outPath, fileId });
        } catch (idxErr) {
          log.warn(`[cutout] index pass failed (file saved): ${(idxErr as Error).message}`);
        }
      }
      log.info(`[cutout] saved ${ext === '.jpg' ? 'composite JPEG' : 'transparent PNG'} ${filename}${fileId != null ? ` → id ${fileId}` : libRoot ? '' : ' → pending'}`);
      return { success: true, filePath: outPath, filename, fileId, pending: !libRoot };
    } catch (err) {
      log.warn(`[cutout] saveCutout failed: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message };
    }
  },
);

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

// Round 129 (Terry) — recording is TWO-STAGE. Clicking record first
// ESTABLISHES what's being recorded (screen via the picker, then the
// area via the freeze-frame selector: click a window, drag a region,
// or Enter for the whole screen). That arms the bar in a pre-record
// state — the user can set up the cam, change quality, make a cup of
// tea — and NOTHING is captured until they press Record on the bar.
// 'armed' is that waiting state; the temp file, the stream, and the
// filename timestamp are all created at the actual Record press.
let recordingState: 'idle' | 'armed' | 'recording' | 'processing' = 'idle';
let recordWidget: BrowserWindow | null = null;
let recordTempPath: string | null = null;
let recordStream: fs.WriteStream | null = null;
let recordStartedAt: Date | null = null;
let recordDisplay: Electron.Display | null = null;
type RecordQualityKey = 'high' | 'standard' | 'compact' | 'tiny';   // v3.1 (Terry) — + tiny
let recordQuality: RecordQualityKey = 'standard';
let recordMeta: { width: number | null; height: number | null; hasAudio: boolean } = { width: null, height: null, hasAudio: false };
// Round 129 — region recording: the chosen area in VIDEO pixels
// (null = whole screen). The capture itself is always full-screen;
// FFmpeg crops at save time (same zero-live-cost pattern as blur).
let recordRegionCrop: SelectionRect | null = null;
// The same region in display CSS pixels — what the on-screen marker
// draws, and what the armed-stage Area re-pick replaces.
let recordRegionCssRect: SelectionRect | null = null;
// Click-through, content-protected outline marking the recorded
// region on screen — the USER sees the boundary, the footage doesn't.
let regionMarkerWindow: BrowserWindow | null = null;

/** Map an overlay selection (display CSS px) to a video-pixel crop;
 *  a selection covering (effectively) the whole display means no
 *  crop at all. */
function computeRegionCrop(areaRect: SelectionRect, display: Electron.Display, grabW: number, grabH: number): SelectionRect | null {
  const coversAll =
    areaRect.x <= 2 && areaRect.y <= 2 &&
    areaRect.width >= display.bounds.width - 4 &&
    areaRect.height >= display.bounds.height - 4;
  if (coversAll) return null;
  const scaleX = grabW / display.bounds.width;
  const scaleY = grabH / display.bounds.height;
  const even = (n: number) => Math.max(0, 2 * Math.floor(n / 2));
  const x = even(areaRect.x * scaleX);
  const y = even(areaRect.y * scaleY);
  let width = even(areaRect.width * scaleX);
  let height = even(areaRect.height * scaleY);
  width = Math.max(64, Math.min(width, even(grabW) - x));
  height = Math.max(64, Math.min(height, even(grabH) - y));
  return { x, y, width, height };
}

// Quality presets (round 126): live capture bitrate + save-time crf.
// v3.1 (Terry — "recordings are really quite large even in compact") — added TINY: explicitly trades
// sharpness for a much smaller file. Its levers are CRF 30 + a save-time DOWNSCALE to ≤1280px wide
// (see transcodeWebmToMp4) — the downscale is the big win (~60-70% smaller) and makes the encode
// FASTER, not slower. The x264 preset stays ultrafast for every preset: veryfast was measured on
// this machine at ~2 min for a 6-second 1080p clip (see the note in transcodeWebmToMp4) — a slower
// preset would make long saves feel broken.
const RECORD_QUALITY = {
  high: { bitsPerSecond: 12_000_000, crf: '19' },
  standard: { bitsPerSecond: 8_000_000, crf: '21' },
  compact: { bitsPerSecond: 4_000_000, crf: '26' },
  tiny: { bitsPerSecond: 2_000_000, crf: '30' },
} as const;
// v3.1 (Terry) — Tiny's output width cap (longest dimension the saved video keeps).
const TINY_MAX_W = 1280;

// Round 127 — blur segments for the active recording. Rects are in
// VIDEO pixels; start/end are recording-clock milliseconds stamped by
// the widget (its clock excludes paused time, so stamps taken while
// paused line up exactly with the output timeline). endMs null =
// still blurring (closed automatically at stop). Mirrored to a
// sidecar JSON next to the temp WebM after every change so a crash
// mid-recording can NEVER save sensitive content unblurred — the
// startup orphan recovery reads it back.
interface BlurSegment { x: number; y: number; width: number; height: number; startMs: number; endMs: number | null }
let recordBlurSegments: BlurSegment[] = [];
// v3.0 round 412 (Terry) — ZOOM moments. focalX/focalY normalised 0..1 in the FINAL
// (post-region-crop) frame; level = zoom factor (e.g. 2 = 2×). Applied at save by an
// FFmpeg zoompan stage (same zero-live-cost pattern as crop/blur). endMs null = still
// zoomed (closed at stop). Manual (Zoom button) + auto (clicks) both produce these.
interface ZoomSegment { focalX: number; focalY: number; level: number; startMs: number; endMs: number | null }
let recordZoomSegments: ZoomSegment[] = [];

// v3.0 round 485 (Terry) — AUTO-ZOOM toward clicks. When enabled, each click during a
// recording opens an automatic ZoomSegment toward where the cursor was, eased in by the
// same save-time zoompan stage as manual zoom (zero live cost). A hold timer eases it
// back out once the user stops clicking; a click while a zoom is already open just
// extends the hold (we don't re-target mid-zoom — keeps the motion calm). The click
// positions come from the SAME global mouse hook the click-ripple feature uses.
let autoZoomEnabled = false;
let autoZoomTimer: NodeJS.Timeout | null = null;
let autoZoomOpenFocal: { x: number; y: number } | null = null;
const AUTOZOOM_LEVEL = 2;        // zoom factor each click eases in to
const AUTOZOOM_HOLD_MS = 2500;   // how long the zoom holds after the last click before easing out

/** Elapsed recording-clock ms (0 before record-start). Matches the timeline the save uses. */
function nowMs(): number {
  return recordStartedAt ? Date.now() - recordStartedAt.getTime() : 0;
}

/**
 * Map a cursor point (DIP, same space as display.bounds) to a normalised 0..1 focal in
 * the FINAL (post-region-crop) frame the zoompan stage operates on. Returns null if there
 * is no recorded display, or the click landed outside the recorded frame/region.
 */
function autoZoomFocalFromCursor(p: { x: number; y: number }): { x: number; y: number } | null {
  if (!recordDisplay) return null;
  const b = recordDisplay.bounds;
  const relX = p.x - b.x;
  const relY = p.y - b.y;
  let fx: number, fy: number;
  if (recordRegionCssRect) {
    const r = recordRegionCssRect;
    fx = (relX - r.x) / r.width;
    fy = (relY - r.y) / r.height;
  } else {
    fx = relX / b.width;
    fy = relY / b.height;
  }
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null; // clicked outside the recorded frame
  return { x: fx, y: fy };
}

/** Close the still-open auto-zoom segment (ease-out runs to its endMs). */
function closeOpenAutoZoom(): void {
  const open = [...recordZoomSegments].reverse().find((s) => s.endMs === null);
  if (open) open.endMs = Math.max(open.startMs, nowMs());
  autoZoomOpenFocal = null;
}

/**
 * Drive auto-zoom from one click. Opens a new zoom toward the click when none is open;
 * a click while one IS open just (re)arms the hold timer so the zoom stays in longer.
 */
function driveAutoZoom(p: { x: number; y: number }): void {
  if (recordingState !== 'recording') return;
  const focal = autoZoomFocalFromCursor(p);
  if (!focal) return;
  if (!autoZoomOpenFocal) {
    recordZoomSegments.push({ focalX: focal.x, focalY: focal.y, level: AUTOZOOM_LEVEL, startMs: nowMs(), endMs: null });
    autoZoomOpenFocal = focal;
    log.info(`[capture] auto-zoom ON at ${(nowMs() / 1000).toFixed(1)}s → ${focal.x.toFixed(2)},${focal.y.toFixed(2)}`);
  }
  // Always (re)arm the hold: the zoom eases out AUTOZOOM_HOLD_MS after the LAST click.
  if (autoZoomTimer) clearTimeout(autoZoomTimer);
  autoZoomTimer = setTimeout(() => { autoZoomTimer = null; closeOpenAutoZoom(); }, AUTOZOOM_HOLD_MS);
}

// Round 128 — camera bubble (tutorial picture-in-picture). A real
// transparent always-on-top window on the recorded display that is
// deliberately NOT content-protected: it's on screen, so the
// recording captures it — no compositing. camVisible tracks the
// faded state; the window survives hidden so toggling back is
// instant (the camera stream stays warm).
// v3.1 (Terry) — TWO camera bubbles ("the option to add a 2nd camera… both at the same time, or one
// or the other"). State is per-which (1 = main cam, 2 = second cam); the bar's Cam / Cam 2 buttons
// toggle each independently. The cam hotkey keeps driving cam 1.
const camWindows: Record<number, BrowserWindow | null> = { 1: null, 2: null };
const camVisibles: Record<number, boolean> = { 1: false, 2: false };
let camHotkeyAccelerator: string | null = null;
// v3.1 (Terry 2026-07-11) — LIVE "cam only" mode: an opaque full-screen CURTAIN window that covers
// the recorded display BELOW the cam bubbles, hiding the desktop so the footage shows just the
// camera(s). Toggled mid-recording from the bar. NOT content-protected (it must be filmed); sits at
// a lower always-on-top level than the cams ('screen-saver'), captures clicks so the hidden live
// desktop can't be mis-clicked. This reuses the existing desktop-capture pipeline untouched (no
// canvas compositor) — see [[project_capture_record_modes]].
let recordCamOnly = false;
let recordCurtainWindow: BrowserWindow | null = null;
// Cam bubble bounds saved on entering cam-only (so they enlarge/centre while cam-only, then restore).
const camSavedBounds: Record<number, Electron.Rectangle | null> = { 1: null, 2: null };
// Bubble size presets per shape (v3.1 Terry — "increase/decrease the bubble"): cycled S→M→L from the
// bubble's hover size button; persisted per camera (captureCamSize / captureCam2Size).
// v3.1 (Terry SS1) — three shapes now (circle, rounded square, rectangle). Circle + square share 1:1
// dims (only the border-radius differs, set in capture-cam.html); rectangle is 4:3.
const CAM_SIZES = {
  circle: { s: { w: 176, h: 176 }, m: { w: 232, h: 232 }, l: { w: 292, h: 292 } },
  square: { s: { w: 176, h: 176 }, m: { w: 232, h: 232 }, l: { w: 292, h: 292 } },
  rectangle: { s: { w: 232, h: 150 }, m: { w: 302, h: 192 }, l: { w: 376, h: 238 } },
} as const;
type CamSizeKey = 's' | 'm' | 'l';
type CamShapeKey = 'circle' | 'square' | 'rectangle';
const CAM_SHAPE_ORDER: CamShapeKey[] = ['circle', 'square', 'rectangle'];
function camSizeSettingKey(which: number): 'captureCamSize' | 'captureCam2Size' { return which === 2 ? 'captureCam2Size' : 'captureCamSize'; }
function getCamSize(which: number): CamSizeKey {
  try { const v = getSettings()[camSizeSettingKey(which)] as CamSizeKey; return (v === 's' || v === 'l') ? v : 'm'; } catch { return 'm'; }
}
// v3.1 (Terry SS1) — PER-CAMERA shape. Cam 1 keeps the legacy captureCamShape (circle|rectangle from
// Settings, now also 'square'); Cam 2 has its own captureCam2Shape (defaults to circle).
function camShapeSettingKey(which: number): 'captureCamShape' | 'captureCam2Shape' { return which === 2 ? 'captureCam2Shape' : 'captureCamShape'; }
function getCamShape(which: number): CamShapeKey {
  try { const v = getSettings()[camShapeSettingKey(which)] as CamShapeKey; return (v === 'square' || v === 'rectangle') ? v : 'circle'; } catch { return 'circle'; }
}
// v3.1 (Terry 2026-07-11) — the bubble is now CONTINUOUSLY sizeable (drag the ⤢ handle) instead of a
// 3-step S/M/L cycle, and can grow to 4× the old Large. The size is persisted as a numeric HEIGHT in
// px (captureCamSizePx / captureCam2SizePx); width follows the shape's aspect. Falls back to the old
// s/m/l preset height so existing setups keep their size.
const CAM_MIN_H = 150;
function camAspect(shape: CamShapeKey): number { const m = CAM_SIZES[shape].m; return m.w / m.h; }   // circle/square = 1, rectangle ≈ 1.57
function camMaxH(shape: CamShapeKey): number { return CAM_SIZES[shape].l.h * 4; }                      // Terry: 4× the current largest
function camSizePxKey(which: number): 'captureCamSizePx' | 'captureCam2SizePx' { return which === 2 ? 'captureCam2SizePx' : 'captureCamSizePx'; }
function getCamSizeH(which: number): number {
  const shape = getCamShape(which);
  try {
    const px = getSettings()[camSizePxKey(which)] as number | undefined;
    if (typeof px === 'number' && isFinite(px) && px > 0) return Math.max(CAM_MIN_H, Math.min(camMaxH(shape), Math.round(px)));
  } catch { /* fall through */ }
  return CAM_SIZES[shape][getCamSize(which)].h;   // legacy s/m/l → its height
}
function camDimsFor(which: number, shape: CamShapeKey, hOverride?: number): { w: number; h: number } {
  const h = Math.max(CAM_MIN_H, Math.min(camMaxH(shape), Math.round(hOverride != null ? hOverride : getCamSizeH(which))));
  return { w: Math.round(h * camAspect(shape)), h };
}
// v3.1 (Terry SS1) — PER-CAMERA backdrop. Cam 1 keeps captureCamBg; Cam 2 has captureCam2Bg (so the
// second camera no longer inherits the first's backdrop).
function camBgSettingKey(which: number): 'captureCamBg' | 'captureCam2Bg' { return which === 2 ? 'captureCam2Bg' : 'captureCamBg'; }
function getCamBg(which: number): { type: string; value?: string; amount?: number } {
  try { return (getSettings()[camBgSettingKey(which)] as { type: string; value?: string; amount?: number }) || { type: 'none' }; } catch { return { type: 'none' }; }
}
// v3.1 (Terry) — normalise a backdrop payload: type + optional value (scene/colour/image) + optional amount
// (the blur/pixelate slider, 0–100). Extra/garbage keys are dropped before persisting.
function cleanCamBg(bg?: { type?: string; value?: string; amount?: number }): { type: string; value?: string; amount?: number } {
  return {
    type: String((bg && bg.type) || 'none'),
    value: (bg && typeof bg.value === 'string') ? bg.value : undefined,
    amount: (bg && typeof bg.amount === 'number' && isFinite(bg.amount)) ? bg.amount : undefined,
  };
}

function blurSidecarPath(webmPath: string): string {
  return webmPath.replace(/\.webm$/i, '.blur.json');
}

function persistBlurSidecar(): void {
  if (!recordTempPath) return;
  try {
    // Round 129 — the sidecar now carries the region crop too, so a
    // crash mid-region-recording can't recover the FULL screen
    // (which would leak everything around the chosen area).
    fs.writeFileSync(
      toLongPath(blurSidecarPath(recordTempPath)),
      JSON.stringify({ crop: recordRegionCrop, segments: recordBlurSegments }),
    );
  } catch (err) {
    log.warn(`[capture] blur sidecar write failed (non-fatal): ${(err as Error).message}`);
  }
}

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
    let p = esmRequire('ffmpeg-static') as string;
    // v3.0.0 (Terry 2026-07-06) — remap the asar path to app.asar.unpacked so the exe is runnable
    // in packaged builds (same fix as main.ts; the bare asar path can't be spawned).
    if (p) p = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    ffmpegPathCached = p && fs.existsSync(p) ? p : null;
  } catch {
    ffmpegPathCached = null;
  }
  return ffmpegPathCached;
}

function teardownRecording(opts: { discardTemp: boolean }): void {
  closeCamBubble();
  closeRecordCurtain(); recordCamOnly = false;   // v3.1 (Terry) — drop the cam-only curtain
  closeRippleOverlay();
  closeTooltipWindow();
  closeBlurOverlay();
  closeRegionMarker();
  unregisterCamHotkey();
  recordRegionCrop = null;
  recordRegionCssRect = null;
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
    setTimeout(() => {
      try { fs.unlinkSync(toLongPath(p)); } catch { /* non-fatal */ }
      try { fs.unlinkSync(toLongPath(blurSidecarPath(p))); } catch { /* non-fatal */ }
    }, 500);
  }
  recordBlurSegments = [];
  recordZoomSegments = [];
  // v3.0 round 485 (Terry) — auto-zoom teardown: clear the hold timer + open-focal, and
  // force-stop the click hook (recording is over, so neither feature needs it now —
  // closeRippleOverlay above skips stopRippleHook while autoZoomEnabled is true).
  if (autoZoomTimer) { clearTimeout(autoZoomTimer); autoZoomTimer = null; }
  autoZoomOpenFocal = null;
  stopRippleHook();
  recordTempPath = null;
  recordStartedAt = null;
  recordDisplay = null;
  recordingState = 'idle';
  broadcastRecordingState();
}

// v3.1 (Terry) — DISCARD the current take but RE-ARM: keep the recorder bar, the camera bubble(s), the
// chosen screen and any region crop, and go back to 'armed' so the user can record again without
// relaunching from the titlebar. Recording-time overlays/hooks (they belong to a live take) are torn down.
function discardAndRearm(): void {
  closeRippleOverlay();
  closeRecordCurtain(); recordCamOnly = false;   // v3.1 (Terry) — cam-only is a recording-time mode; drop it on re-arm
  closeBlurOverlay();
  closeRegionMarker();
  if (recordStream) {
    try { recordStream.end(); } catch { /* non-fatal */ }
    recordStream = null;
  }
  if (recordTempPath) {
    const p = recordTempPath;
    // Give the stream a beat to flush before unlinking (same as teardown's discard).
    setTimeout(() => {
      try { fs.unlinkSync(toLongPath(p)); } catch { /* non-fatal */ }
      try { fs.unlinkSync(toLongPath(blurSidecarPath(p))); } catch { /* non-fatal */ }
    }, 500);
  }
  recordBlurSegments = [];
  recordZoomSegments = [];
  if (autoZoomTimer) { clearTimeout(autoZoomTimer); autoZoomTimer = null; }
  autoZoomOpenFocal = null;
  stopRippleHook();   // closeRippleOverlay skips this while autoZoomEnabled — force it (the take is over)
  recordTempPath = null;
  recordStartedAt = null;
  recordMeta = { width: null, height: null, hasAudio: false };
  // Back to ARMED — recordDisplay + recordRegionCrop are kept so the next take reuses the same setup.
  recordingState = 'armed';
  broadcastRecordingState();
}

export interface StartRecordingResult {
  success: boolean;
  alreadyRecording?: boolean;
  /** Round 129 — the user pressed Esc at the area-selection stage;
   *  nothing was set up. Callers stay silent. */
  cancelled?: boolean;
  needsDisplayPick?: boolean;
  displays?: CaptureDisplayInfo[];
  error?: string;
}

export async function startRecording(opts: { displayId?: string; trigger: 'button' }): Promise<StartRecordingResult> {
  // v3.0 (Terry) — Free-account cap of 5 screen recordings (lifetime usage). Blocked at the START
  // so the user can't set up a recording they can't save; the completed-save bump lives in the
  // recording persist tail.
  if (await trialCapReached('recordings', FREE_RECORDING_LIMIT)) {
    return { success: false, error: `Your free account can save up to ${FREE_RECORDING_LIMIT} screen recordings. Upgrade for unlimited.`, limit: 'recordings' } as StartRecordingResult;
  }
  if (recordingState !== 'idle') {
    return {
      success: false,
      alreadyRecording: true,
      error: recordingState === 'processing'
        ? 'Still saving your previous recording — one moment.'
        : recordingState === 'armed'
          ? 'A recording is already set up — press Record on the bar, or close it first.'
          : 'A recording is already in progress.',
    };
  }
  try {
    // Round 131 (Terry) — MENU FIRST. Clicking record no longer gates
    // on a screen picker or an immediate area-freeze (both were
    // disorienting: you couldn't arrange windows first, and the
    // frozen frame showed a second taskbar). Instead the bar opens
    // straight away, ARMED, targeting a sensible default; WHICH
    // screen and WHICH area are now choices ON the bar (Screen
    // dropdown + Area button), changeable freely before you press
    // Record. Default display = explicit pick, else PRIMARY (fresh
    // each time — never silently the last session's screen).
    const allDisplays = screen.getAllDisplays();
    const display = opts.displayId
      ? (allDisplays.find((d) => String(d.id) === String(opts.displayId)) ?? screen.getPrimaryDisplay())
      : screen.getPrimaryDisplay();

    const source = await getDisplaySource(display);
    if (!source) return { success: false, error: 'Could not access the screen for recording.' };

    // ARMED — nothing recorded yet, full screen by default (Area
    // button sets a region). Temp file + timestamps are created when
    // the user presses Record (capture:record-started).
    recordStartedAt = null;
    recordTempPath = null;
    recordDisplay = display;
    recordRegionCrop = null;
    recordRegionCssRect = null;
    recordMeta = { width: null, height: null, hasAudio: false };
    const screenList = await listCaptureDisplays();

    const recordAudio = (() => {
      try { return getSettings().captureRecordAudio !== false; } catch { return true; }
    })();
    recordQuality = (() => {
      try { return (getSettings().captureRecordQuality as RecordQualityKey) || 'standard'; } catch { return 'standard'; }
    })();

    const widget = new BrowserWindow({
      // Round 130 — generous initial width so nothing clips on the
      // first paint; the widget then measures its real content and
      // asks main to size the window exactly (capture:record-resize),
      // so the bar can never clip however many controls are shown.
      width: 780,
      height: 64,
      x: display.bounds.x + display.bounds.width - 804,
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
      // External close (Alt+F4 on the widget) while armed or
      // recording — treat as cancel; the engine died with the
      // renderer.
      if (recordWidget === widget && (recordingState === 'recording' || recordingState === 'armed')) {
        log.info('[capture] recording widget closed externally — discarding');
        recordWidget = null;
        teardownRecording({ discardTemp: true });
      }
    });

    widget.webContents.once('did-finish-load', () => {
      if (widget.isDestroyed()) return;
      widget.webContents.send('capture:record-init', {
        sourceId: source.id,
        audio: recordAudio,
        // v3.0 round 410 (Terry) — microphone/voiceover preference for the bar.
        mic: (() => { try { return getSettings().captureMicEnabled === true; } catch { return false; } })(),
        micDevice: (() => { try { return getSettings().captureMicDevice || ''; } catch { return ''; } })(),
        // v3.0 round 411 (Terry) — click-ripple preference for the bar.
        ripple: (() => { try { return getSettings().captureRippleEnabled === true; } catch { return false; } })(),
        // v3.0 round 485 (Terry) — auto-zoom-toward-clicks preference for the bar.
        autoZoom: (() => { try { return getSettings().captureAutoZoomEnabled === true; } catch { return false; } })(),
        // v3.1 (Terry) — remembered camera VIRTUAL BACKGROUND (none/blur/gradient/image) for the bar's picker;
        // v3.1 (Terry SS1) — cam 2 carries its OWN backdrop now (per-camera picker on the bar).
        camBg: (() => { try { return getSettings().captureCamBg || { type: 'none' }; } catch { return { type: 'none' }; } })(),
        cam2Bg: (() => { try { return getSettings().captureCam2Bg || { type: 'none' }; } catch { return { type: 'none' }; } })(),
        maxWidth: Math.round(display.bounds.width * display.scaleFactor),
        maxHeight: Math.round(display.bounds.height * display.scaleFactor),
        videoBitsPerSecond: RECORD_QUALITY[recordQuality].bitsPerSecond,
        quality: recordQuality,
        // Round 129 — the bar opens ARMED: engine idle until the
        // user presses its Record button.
        armed: true,
        region: recordRegionCrop,
        // Round 131 — screen picker lives on the bar now.
        screens: screenList.map((s) => ({ id: s.id, label: s.label })),
        currentScreenId: String(display.id),
      });
      // showInactive — setting up a recording must not steal focus
      // from whatever the user is about to record.
      widget.showInactive();
    });
    void widget.loadFile(path.join(__dirname, '../dist/public/capture-record-widget.html'));

    recordingState = 'armed';
    broadcastRecordingState();
    // Round 128 — camera bubble: auto-start when enabled in Settings;
    // the per-recording cam hotkey toggles it either way. Both work
    // during the armed stage too, so the user can frame themselves
    // before pressing Record.
    const camEnabled = (() => {
      try { return getSettings().captureCamEnabled === true; } catch { return false; }
    })();
    if (camEnabled) createCamBubble(display);
    // v3.0 round 413 (Terry) — the click-ripple overlay + its global mouse
    // hook are DEFERRED to capture:record-started (NOT armed). A global
    // low-level input hook plus a fullscreen transparent always-on-top
    // overlay running during the armed/setup phase needlessly loaded the
    // system ("lag when the bar appears, before recording"). Ripples only
    // matter inside the footage, so they now spin up the instant Record is
    // pressed and tear down on stop/cancel.
    registerCamHotkey();
    log.info(`[capture] recording ARMED on display ${display.id} (audio: ${recordAudio ? 'system' : 'off'}, cam: ${camEnabled ? 'on' : 'off'}, full screen) — waiting for Record`);
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
  if ((recordingState === 'recording' || recordingState === 'armed') && recordWidget && !recordWidget.isDestroyed()) {
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
/**
 * Round 127 — turn the recorded blur segments into an FFmpeg
 * filter_complex chain. Per segment: split the frame, crop the
 * region, box-blur it hard, overlay it back at the same spot — but
 * only between the segment's start and end on the output timeline
 * (`enable='between(t,a,b)'`). Chained so any number of sequential
 * segments compose. Pure save-time work: recording itself never
 * touches a pixel.
 */
/**
 * Compose the save-time video filter chain: an optional region crop
 * first (round 129 — region recording captures full-screen and crops
 * here), then the blur segments (coords shifted into the cropped
 * space; segments falling outside the region are dropped).
 */
// v3.0 round 412 (Terry) — build the zoompan z/x/y expressions for the zoom moments.
// Per moment: smoothstep ease-in (0.4s) → hold at `level` → ease-out, panned so the
// focal point stays put; z=1 (no zoom) everywhere else. x/y use the live `zoom` so the
// pan tracks the ease. fps is forced upstream so frame index `in` maps cleanly to time.
function buildZoomExpr(segments: ZoomSegment[], fps: number): { z: string; x: string; y: string } | null {
  const valid = segments.filter((s) => s.endMs !== null && (s.endMs as number) > s.startMs && s.level > 1.01);
  if (valid.length === 0) return null;
  const ef = Math.max(1, Math.round(0.4 * fps));
  const sm = (e: string) => `(${e})*(${e})*(3-2*(${e}))`; // smoothstep
  let z = '1', x = '0', y = '0';
  for (let i = valid.length - 1; i >= 0; i--) {
    const s = valid[i];
    const f0 = Math.round((s.startMs / 1000) * fps);
    const f1 = Math.round(((s.endMs as number) / 1000) * fps);
    const Lm1 = (s.level - 1).toFixed(4), L = s.level.toFixed(4);
    const segZ = `if(lt(in,${f0 + ef}),1+${Lm1}*${sm(`(in-${f0})/${ef}`)},if(gt(in,${f1 - ef}),1+${Lm1}*${sm(`(${f1}-in)/${ef}`)},${L}))`;
    z = `if(between(in,${f0},${f1}),${segZ},${z})`;
    x = `if(between(in,${f0},${f1}),(iw-iw/zoom)*${s.focalX.toFixed(4)},${x})`;
    y = `if(between(in,${f0},${f1}),(ih-ih/zoom)*${s.focalY.toFixed(4)},${y})`;
  }
  return { z, x, y };
}
function buildVideoFilter(segments: BlurSegment[], regionCrop: SelectionRect | null, zoomSegments: ZoomSegment[] = [], frameW = 0, frameH = 0): { filter: string; outLabel: string } | null {
  const parts: string[] = [];
  let cur = '0:v';
  if (regionCrop) {
    parts.push(`[${cur}]crop=${regionCrop.width}:${regionCrop.height}:${regionCrop.x}:${regionCrop.y}[vc]`);
    cur = 'vc';
  }
  const adjusted = segments
    .map((s) => {
      if (!regionCrop) return s;
      const x1 = Math.max(s.x, regionCrop.x);
      const y1 = Math.max(s.y, regionCrop.y);
      const x2 = Math.min(s.x + s.width, regionCrop.x + regionCrop.width);
      const y2 = Math.min(s.y + s.height, regionCrop.y + regionCrop.height);
      if (x2 - x1 < 4 || y2 - y1 < 4) return null; // outside the region
      const even = (n: number) => Math.max(0, 2 * Math.floor(n / 2));
      return { ...s, x: even(x1 - regionCrop.x), y: even(y1 - regionCrop.y), width: even(x2 - x1), height: even(y2 - y1) };
    })
    .filter((s): s is BlurSegment => s !== null);
  adjusted.forEach((s, i) => {
    const start = (s.startMs / 1000).toFixed(3);
    // Open segment (never unblurred) runs to end-of-clip.
    const end = s.endMs === null ? '999999' : (s.endMs / 1000).toFixed(3);
    // v3.0 round 417 (Terry) — STRONG, smooth obscuring (was boxblur=10, which
    // left text faintly legible — read as "not covered"). Downscale the region
    // to ~1/20, upscale it back smoothly, then a light boxblur: content is fully
    // hidden at any region size. Position is unchanged (verified: the blur lands
    // exactly on the drawn box).
    const dw = Math.max(1, Math.ceil(s.width / 20));
    const dh = Math.max(1, Math.ceil(s.height / 20));
    parts.push(`[${cur}]split=2[a${i}][b${i}]`);
    parts.push(`[b${i}]crop=${s.width}:${s.height}:${s.x}:${s.y},scale=${dw}:${dh},scale=${s.width}:${s.height},boxblur=10[bb${i}]`);
    parts.push(`[a${i}][bb${i}]overlay=${s.x}:${s.y}:enable='between(t,${start},${end})'[v${i}]`);
    cur = `v${i}`;
  });
  // v3.0 round 412 — zoom moments: zoompan on the FINAL frame (after crop/blur). fps is
  // forced so frame index maps to time; s = the post-crop frame size.
  const zexpr = buildZoomExpr(zoomSegments, 30);
  if (zexpr && frameW > 1 && frameH > 1) {
    parts.push(`[${cur}]fps=30,zoompan=z='${zexpr.z}':x='${zexpr.x}':y='${zexpr.y}':d=1:s=${frameW}x${frameH}:fps=30[vz]`);
    cur = 'vz';
  }
  if (parts.length === 0) return null;
  return { filter: parts.join(';'), outLabel: cur };
}

async function transcodeWebmToMp4(webmPath: string, crf: string = '21', blurSegments: BlurSegment[] = [], regionCrop: SelectionRect | null = null, zoomSegments: ZoomSegment[] = [], frameW = 0, frameH = 0, downscaleMaxW = 0): Promise<string | null> {
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
  const segments = blurSegments.filter((s) => s.width >= 2 && s.height >= 2);
  const built = buildVideoFilter(segments, regionCrop, zoomSegments, frameW, frameH);
  // v3.1 (Terry) — TINY preset: downscale the OUTPUT to ≤downscaleMaxW wide (aspect kept, even height).
  // 'min(...,iw)' never upscales a small region recording. Fewer pixels = a much smaller file AND a
  // faster encode — the right trade lever on this machine (a slower x264 preset is not; see above).
  const scaleExpr = downscaleMaxW > 0 ? `scale='min(${downscaleMaxW},iw)':-2` : '';
  let videoArgs: string[] = [];
  if (built) {
    videoArgs = scaleExpr
      ? ['-filter_complex', `${built.filter};[${built.outLabel}]${scaleExpr}[vtiny]`, '-map', '[vtiny]', '-map', '0:a?']
      : ['-filter_complex', built.filter, '-map', `[${built.outLabel}]`, '-map', '0:a?'];
  } else if (scaleExpr) {
    videoArgs = ['-vf', scaleExpr];
  }
  if (built || scaleExpr) {
    log.info(`[capture] save-time filters: ${regionCrop ? `region crop ${regionCrop.width}×${regionCrop.height}` : 'no crop'}${segments.length > 0 ? ` + ${segments.length} blur segment(s)` : ''}${scaleExpr ? ` + tiny downscale ≤${downscaleMaxW}w` : ''}`);
  }
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', src,
    ...videoArgs,
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
  // v3.0 (Terry) — count a completed screen recording toward the Free-account cap of 5 (lifetime).
  await bumpTrialUsage('recordings');
  return { success: true, filePath: outPath, filename, fileId, pending: !libRoot };
}

async function finalizeRecording(): Promise<void> {
  const webmPath = recordTempPath;
  const startedAt = recordStartedAt ?? new Date();
  const meta = recordMeta;
  const blurSegments = recordBlurSegments;
  recordBlurSegments = [];
  // v3.0 round 485 (Terry) — STOP pressed: close any still-open auto-zoom segment so its
  // ease-out runs to the end of the clip (manual zoom relies on the widget sending 'close'
  // at stop; auto-zoom has no widget event, so we close it here in main while the clock is
  // still live). Must run BEFORE we snapshot recordZoomSegments for the save below.
  if (autoZoomTimer) { clearTimeout(autoZoomTimer); autoZoomTimer = null; }
  closeOpenAutoZoom();
  const zoomSegments = recordZoomSegments;
  recordZoomSegments = [];
  const regionCrop = recordRegionCrop;
  recordRegionCrop = null;
  recordRegionCssRect = null;
  closeCamBubble();
  closeRippleOverlay();
  closeTooltipWindow();
  closeBlurOverlay();
  closeRegionMarker();
  unregisterCamHotkey();
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
    const fw = regionCrop?.width ?? meta.width ?? 0;
    const fh = regionCrop?.height ?? meta.height ?? 0;
    const mp4Path = await transcodeWebmToMp4(webmPath, RECORD_QUALITY[recordQuality].crf, blurSegments, regionCrop, zoomSegments, fw, fh, recordQuality === 'tiny' ? TINY_MAX_W : 0);
    if (mp4Path) {
      try { fs.unlinkSync(toLongPath(webmPath)); } catch { /* non-fatal */ }
      try { fs.unlinkSync(toLongPath(blurSidecarPath(webmPath))); } catch { /* non-fatal */ }
      await persistRecording(mp4Path, startedAt, regionCrop?.width ?? meta.width, regionCrop?.height ?? meta.height);
    } else {
      // FFmpeg unavailable/failed — persist the WebM itself rather
      // than lose the recording. NOTE: blur segments can only be
      // applied by the transcode; if any exist, warn loudly rather
      // than ship sensitive content silently unblurred.
      if (blurSegments.length > 0) {
        log.warn(`[capture] transcode failed with ${blurSegments.length} blur segment(s) pending — the saved WebM is NOT blurred`);
        broadcast('capture:recordError', { message: 'The recording was saved, but the blur could not be applied to it.' });
      }
      try { fs.unlinkSync(toLongPath(blurSidecarPath(webmPath))); } catch { /* non-fatal */ }
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
    // Round 129 — THIS is the moment recording truly begins (the
    // user pressed Record on the armed bar). The temp file, the
    // stream, and the filename timestamp are all born here, so a
    // recording armed at 9:00 but started at 9:07 is dated 9:07.
    // IPC ordering guarantees this handler runs before the first
    // chunk arrives (the widget reports started before recorder.start).
    if (recordingState === 'armed') {
      recordStartedAt = new Date();
      const { date, time } = timestampParts(recordStartedAt);
      fs.mkdirSync(toLongPath(recordTempDir()), { recursive: true });
      recordTempPath = path.join(recordTempDir(), `rec-${date}_${time}.webm`);
      recordStream = fs.createWriteStream(toLongPath(recordTempPath));
      // Region recordings get their sidecar immediately so crash
      // recovery knows the crop even with zero blur segments.
      if (recordRegionCrop) persistBlurSidecar();
      recordingState = 'recording';
      broadcastRecordingState();
      // v3.0 round 413 (Terry) — NOW start the click-ripple overlay + global
      // hook (deferred from arm, so the armed/setup phase stays lag-free).
      const rippleOn = (() => { try { return getSettings().captureRippleEnabled === true; } catch { return false; } })();
      if (rippleOn && recordDisplay) createRippleOverlay(recordDisplay);
      // v3.0 round 485 (Terry) — read the persisted auto-zoom choice now that
      // recordDisplay + recordStartedAt are set; if on, make sure the click hook
      // is running (createRippleOverlay above may already have started it).
      autoZoomEnabled = (() => { try { return getSettings().captureAutoZoomEnabled === true; } catch { return false; } })();
      if (autoZoomEnabled) ensureClickHook();
    }
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
// v3.1 (Terry) — the confirm bar's Discard: bin this take but keep the bar up, re-armed for another go.
ipcMain.on('capture:record-discard-rearm', (event) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents) {
    log.info('[capture] recording discarded — re-armed for another take');
    discardAndRearm();
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
      // Round 129 — region recordings snap the REGION, not the whole
      // screen: the still should match what's being recorded.
      let buffer = grab.buffer;
      let w: number | null = grab.width;
      let h: number | null = grab.height;
      if (recordRegionCrop) {
        const cropped = nativeImage.createFromBuffer(grab.buffer).crop(recordRegionCrop);
        if (!cropped.isEmpty()) {
          buffer = cropped.toPNG();
          w = recordRegionCrop.width;
          h = recordRegionCrop.height;
        }
      }
      await persistCapture(buffer, capturedAt, w, h, 'screenshot');
    } catch (err) {
      log.warn(`[capture] mid-recording snap failed: ${(err as Error).message}`);
    }
  })();
});

// Round 127 — quality changed from the recording bar. Applies to the
// SAVE step of the in-flight recording (the capture bitrate was fixed
// at start) and persists as the setting for future ones; the
// settings:changed broadcast keeps the Settings → Capture radio live.
ipcMain.on('capture:record-quality', (event, info: { quality?: RecordQualityKey }) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const q = info?.quality;
  if (q !== 'high' && q !== 'standard' && q !== 'compact' && q !== 'tiny') return;   // v3.1 (Terry) — + tiny
  recordQuality = q;
  try { setSetting('captureRecordQuality', q); } catch { /* non-fatal */ }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send('settings:changed', { key: 'captureRecordQuality', value: q }); } catch { /* non-fatal */ }
  }
  log.info(`[capture] recording quality → ${q} (save-time; persisted for future recordings)`);
});

// ─── v3.1 (Terry) — camera VIRTUAL BACKGROUND ───────────────────────────────
// The bar's Background picker → persist the choice + relay it live to the cam
// bubble (which does the person-segmentation compositing itself, offline).
// bg = { type: 'none' | 'blur' | 'gradient' | 'image', value?: string }
//   gradient → value = preset id (the bubble draws it); image → value = file path.
ipcMain.on('capture:cam-set-bg', (event, info: { bg?: { type?: string; value?: string }; which?: number }) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const bg = (info && info.bg) || undefined;
  const which = info && info.which === 2 ? 2 : 1;   // v3.1 (Terry SS1) — PER-CAMERA now
  const clean = { type: String((bg && bg.type) || 'none'), value: (bg && typeof bg.value === 'string') ? bg.value : undefined };
  try { setSetting(camBgSettingKey(which), clean); } catch { /* non-fatal */ }
  const win = camWindows[which];   // apply to THIS camera only — cam 2 no longer inherits cam 1's backdrop
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('capture:cam-do', { action: 'set-bg', bg: clean }); } catch { /* non-fatal */ }
  }
  log.info(`[capture] cam ${which} background → ${clean.type}${clean.value ? ' (' + clean.value + ')' : ''}`);
});
// v3.1 (Terry SS1) — cycle a bubble's SHAPE circle → square → rectangle. Reshapes the window around
// its centre (border-radius handled in the page), persists per camera, echoes the shape to the bubble.
ipcMain.on('capture:cam-shape', (event, info?: { which?: number }) => {
  const which = info && info.which === 2 ? 2 : 1;
  const win = camWindows[which];
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const next = CAM_SHAPE_ORDER[(CAM_SHAPE_ORDER.indexOf(getCamShape(which)) + 1) % CAM_SHAPE_ORDER.length];
  try { setSetting(camShapeSettingKey(which), next); } catch { /* non-fatal */ }
  const dims = camDimsFor(which, next);   // v3.1 — keep the current (numeric) height, apply the new shape's aspect
  try {
    const b = win.getBounds();
    win.setBounds({ x: Math.round(b.x + (b.width - dims.w) / 2), y: Math.round(b.y + (b.height - dims.h) / 2), width: dims.w, height: dims.h });
  } catch { /* non-fatal */ }
  try { win.webContents.send('capture:cam-do', { action: 'shape', shape: next }); } catch { /* non-fatal */ }
  log.info(`[capture] cam ${which} shape → ${next}`);
});
// v3.1 (Terry) — the BACKDROP now comes from a button ON the bubble. The bubble applies it locally and
// sends this so main PERSISTS it for the right camera (resolved from the sender window).
ipcMain.on('capture:cam-bubble-set-bg', (event, bg: { type?: string; value?: string }) => {
  let which = 0;
  for (const w of [1, 2]) { const win = camWindows[w]; if (win && !win.isDestroyed() && event.sender === win.webContents) { which = w; break; } }
  if (!which) return;
  const clean = { type: String((bg && bg.type) || 'none'), value: (bg && typeof bg.value === 'string') ? bg.value : undefined };
  try { setSetting(camBgSettingKey(which), clean); } catch { /* non-fatal */ }
  log.info(`[capture] cam ${which} backdrop (from bubble) → ${clean.type}${clean.value ? ' (' + clean.value + ')' : ''}`);
});
// "My picture…" — a native image picker, parented to the bar. Returns the path or null.
ipcMain.handle('capture:cam-bg-pick', async (event) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return null;
  try {
    const res = await dialog.showOpenDialog(recordWidget, {
      title: 'Choose a background picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
    return res.filePaths[0];
  } catch { return null; }
});

// Round 127 — Blur. The widget auto-pauses, then asks for the area
// selector. We freeze the recorded display exactly as it stands (no
// window hiding — the footage must match) and reuse the region
// overlay, snap-to-window included. The chosen rect goes back to the
// widget in VIDEO pixels; the widget stamps the recording-clock
// start/end on its open/close reports below.
ipcMain.on('capture:record-blur-request', (event) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const display = recordDisplay;
  const widget = recordWidget;
  const replyRect = (rect: { x: number; y: number; width: number; height: number } | null) => {
    if (widget && !widget.isDestroyed()) {
      try { widget.webContents.send('capture:record-do', { action: 'blur-opened', rect }); } catch { /* non-fatal */ }
    }
  };
  if (!display || recordingState !== 'recording' || captureInFlight) {
    replyRect(null);
    return;
  }
  captureInFlight = true; // blocks hotkey screenshots while selecting
  void (async () => {
    try {
      // v3.0 round 418 (Terry) — LIVE veil over the real (paused) desktop, NOT a
      // pasted frozen screenshot. The frozen grab rendered the captured taskbar
      // above the real Windows taskbar, so the box you drew landed OFFSET from
      // the content. The recording is paused during blur selection, so the
      // desktop already shows the exact frame being blurred — select straight
      // over it, which is 1:1 with the footage (same fix recording area-select
      // already uses).
      const windows = enumerateWindowRectsForDisplay(display);
      const rect = await openRegionOverlay(display, null, windows, undefined, { live: true });
      if (!rect) { replyRect(null); return; }
      // Display CSS px → video px, rounded to even values (chroma-
      // subsampled H.264 prefers even crop geometry) and clamped.
      const vw = recordMeta.width ?? Math.round(display.bounds.width * display.scaleFactor);
      const vh = recordMeta.height ?? Math.round(display.bounds.height * display.scaleFactor);
      const scaleX = vw / display.bounds.width;
      const scaleY = vh / display.bounds.height;
      const even = (n: number) => Math.max(0, 2 * Math.floor(n / 2));
      let x = even(rect.x * scaleX);
      let y = even(rect.y * scaleY);
      let width = even(rect.width * scaleX);
      let height = even(rect.height * scaleY);
      width = Math.max(2, Math.min(width, even(vw) - x));
      height = Math.max(2, Math.min(height, even(vh) - y));
      replyRect({ x, y, width, height });
    } catch (err) {
      log.warn(`[capture] blur selection failed: ${(err as Error).message}`);
      replyRect(null);
    } finally {
      captureInFlight = false;
    }
  })();
});

// ─── Round 129: region marker ────────────────────────────────────────────────

/**
 * A click-through, content-protected, transparent window covering the
 * recorded display that draws a border around the recorded region —
 * the user always sees what's in frame; the footage never does.
 * rect is in display CSS pixels (the overlay selection, pre-scale).
 */
function createRegionMarker(display: Electron.Display, rect: SelectionRect): void {
  closeRegionMarker();
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    show: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  regionMarkerWindow = win;
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
  try { win.setContentProtection(true); } catch { /* non-fatal */ }
  try { win.setIgnoreMouseEvents(true); } catch { /* non-fatal */ }
  win.setMenu(null);
  win.on('closed', () => {
    if (regionMarkerWindow === win) regionMarkerWindow = null;
  });
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('capture:region-marker-init', { rect });
    win.showInactive();
  });
  void win.loadFile(path.join(__dirname, '../dist/public/capture-region-marker.html'));
}

function closeRegionMarker(): void {
  if (regionMarkerWindow && !regionMarkerWindow.isDestroyed()) {
    try { regionMarkerWindow.close(); } catch { /* non-fatal */ }
  }
  regionMarkerWindow = null;
}

// ─── Round 128: camera bubble ────────────────────────────────────────────────

function notifyWidgetCamState(): void {
  if (recordWidget && !recordWidget.isDestroyed()) {
    try { recordWidget.webContents.send('capture:record-do', { action: 'cam-state', visible: camVisibles[1], visible2: camVisibles[2], camOnly: recordCamOnly }); } catch { /* non-fatal */ }
  }
}

// v3.1 (Terry) — HOVER over the bubble is detected in MAIN, not the renderer. The bubble is an
// -webkit-app-region:drag window, and drag regions swallow mouse events (the OS uses them for window
// dragging), so a renderer :hover only fired on the thin no-drag edge, never the draggable middle
// ("controls appear on the circumference, disappear in the middle"). We poll the screen cursor against
// each visible bubble's bounds and send cam-do {action:'hover'} only when the over/out state flips.
// Cheap (a getCursorScreenPoint + rect test at ~9Hz) and only runs while a bubble is on screen.
let camHoverPoll: NodeJS.Timeout | null = null;
const camHoverLast: Record<number, boolean> = { 1: false, 2: false };
function startCamHoverPoll(): void {
  if (camHoverPoll) return;
  camHoverPoll = setInterval(() => {
    let any = false;
    let pt: Electron.Point;
    try { pt = screen.getCursorScreenPoint(); } catch { return; }
    for (const which of [1, 2]) {
      const win = camWindows[which];
      if (!win || win.isDestroyed() || !camVisibles[which]) { camHoverLast[which] = false; continue; }
      any = true;
      let over = false;
      try { const b = win.getBounds(); over = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height; } catch { /* non-fatal */ }
      if (over !== camHoverLast[which]) {
        camHoverLast[which] = over;
        try { win.webContents.send('capture:cam-do', { action: 'hover', over }); } catch { /* non-fatal */ }
      }
    }
    if (!any) stopCamHoverPoll();
  }, 110);
}
function stopCamHoverPoll(): void { if (camHoverPoll) { clearInterval(camHoverPoll); camHoverPoll = null; } camHoverLast[1] = false; camHoverLast[2] = false; }

function createCamBubble(display: Electron.Display, which: number = 1): void {
  const existing = camWindows[which];
  if (existing && !existing.isDestroyed()) return;
  const shape = getCamShape(which);   // v3.1 (Terry SS1) — per-camera shape (cam 2 no longer forced to cam 1's)
  // v3.1 (Terry) — cam 2 has its own device setting; '' = auto (the page picks the next camera
  // that isn't cam 1's, so plugging in a second webcam just works with zero setup).
  const deviceId = (() => {
    try { return (which === 2 ? getSettings().captureCam2Device : getSettings().captureCamDevice) || ''; } catch { return ''; }
  })();
  const avoidDeviceId = (() => {
    try { return which === 2 ? (getSettings().captureCamDevice || '') : ''; } catch { return ''; }
  })();
  // v3.1 (Terry) — per-camera persisted size — now a continuous height (px), drag-resized from the ⤢
  // handle, up to 4× the old Large.
  const dims = camDimsFor(which, shape);
  const width = dims.w;
  const height = dims.h;
  const win = new BrowserWindow({
    width,
    height,
    // Bottom-LEFT corner — the recording bar owns bottom-right. Cam 2 sits just right of cam 1.
    x: display.bounds.x + 24 + (which === 2 ? width + 14 : 0),
    y: display.bounds.y + display.bounds.height - height - 56,
    frame: false,
    show: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  camWindows[which] = win;
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
  // NO setContentProtection here — the bubble must appear in the
  // footage; that's its entire purpose.
  win.setMenu(null);
  // v3.0 round 487 (Terry) — Clicks + cam-drag glitch. The global click hook (uiohook) and
  // the full-screen ripple overlay both fight the cam bubble's OS app-region drag — hijacking
  // focus and OS windows (the earlier z-order tweak didn't cure it). So while the cam is being
  // DRAGGED, fully SUSPEND Clicks: stop the hook AND hide the ripple overlay; restore both
  // ~400ms after the drag stops (debounced off the window-move events). Clicks behaves
  // normally everywhere else and the instant a cam drag ends.
  let camDragTimer: NodeJS.Timeout | null = null;
  const suspendClicksForCamDrag = () => {
    const wasOn = rippleHookOn;
    if (rippleHookOn) stopRippleHook();
    if (rippleWindow && !rippleWindow.isDestroyed() && rippleWindow.isVisible()) { try { rippleWindow.hide(); } catch { /* non-fatal */ } }
    if (wasOn) log.info('[capture] cam drag — Clicks suspended');
    if (camDragTimer) clearTimeout(camDragTimer);
    camDragTimer = setTimeout(() => {
      camDragTimer = null;
      if (recordingState !== 'recording') return;
      if (rippleWindow && !rippleWindow.isDestroyed() && !rippleWindow.isVisible()) { try { rippleWindow.showInactive(); } catch { /* non-fatal */ } }
      if (rippleWindow || autoZoomEnabled) { ensureClickHook(); log.info('[capture] cam drag ended — Clicks resumed'); }
    }, 400);
  };
  win.on('will-move', suspendClicksForCamDrag);
  win.on('move', suspendClicksForCamDrag);
  win.on('closed', () => {
    if (camWindows[which] === win) {
      camWindows[which] = null;
      camVisibles[which] = false;
      notifyWidgetCamState();
    }
  });
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    // v3.1 (Terry SS1) — pass THIS camera's own backdrop (per-camera now) + shape + which; and tell
    // the bubble whether we're already recording, so it hides its controls (armed = controls shown).
    const bg = getCamBg(which);
    win.webContents.send('capture:cam-init', { deviceId, shape, bg, which, avoidDeviceId });
    win.showInactive();
    camVisibles[which] = true;
    startCamHoverPoll();   // v3.1 (Terry) — main-driven hover for the controls (works over the drag region)
    notifyWidgetCamState();
    // v3.1 Stage 2 (Terry) — if we're in cam-only, a freshly-created bubble must join the fill layout.
    if (recordCamOnly && recordDisplay) { setTimeout(() => { relayoutCamOnlyIfActive(); }, 120); }
  });
  void win.loadFile(path.join(__dirname, '../dist/public/capture-cam.html'));
}

// ─── v3.0 round 411 (Terry): click-ripple overlay ───────────────────────────
// A fullscreen, transparent, CLICK-THROUGH, always-on-top window on the recorded
// display (NOT content-protected, so the rings appear in the footage). A global
// mouse hook reports each click; we map it to the overlay's CSS px and draw a ring.
let rippleWindow: BrowserWindow | null = null;
let rippleDisplay: Electron.Display | null = null;
let rippleHookOn = false;

// v3.0 round 485 (Terry) — the global mouse hook now feeds BOTH features: it draws the
// click ripple (if the overlay is up) AND drives auto-zoom (if enabled). Gated on an
// active recording so stray clicks while idle/processing do nothing. We read the cursor
// point once and fan it out.
function onGlobalMouseDown(): void {
  if (recordingState !== 'recording') return;
  try {
    const p = screen.getCursorScreenPoint();   // DIP — same space as display.bounds + the overlay
    // Click ripple — only when its overlay exists and the click is on the recorded display.
    if (rippleWindow && !rippleWindow.isDestroyed() && rippleDisplay) {
      const b = rippleDisplay.bounds;
      const x = p.x - b.x, y = p.y - b.y;
      if (x >= 0 && y >= 0 && x <= b.width && y <= b.height) {
        rippleWindow.webContents.send('capture:ripple-click', { x, y });
      }
    }
    // Auto-zoom — toward the click (its own on-frame bounds check lives in driveAutoZoom).
    if (autoZoomEnabled) driveAutoZoom(p);
  } catch { /* non-fatal */ }
}
function startRippleHook(): void {
  if (rippleHookOn) return;
  try {
    uIOhook.on('mousedown', onGlobalMouseDown);
    uIOhook.start();
    rippleHookOn = true;
  } catch (e) { log.warn(`[capture] click hook failed: ${(e as Error).message}`); }
}
// v3.0 round 485 (Terry) — start the global click hook if EITHER feature needs it
// (ripples OR auto-zoom). startRippleHook already no-ops when it's already running.
function ensureClickHook(): void {
  startRippleHook();
}
function stopRippleHook(): void {
  if (!rippleHookOn) return;
  try { uIOhook.removeListener('mousedown', onGlobalMouseDown); } catch { /* non-fatal */ }
  try { uIOhook.stop(); } catch { /* non-fatal */ }
  rippleHookOn = false;
}
function createRippleOverlay(display: Electron.Display): void {
  if (rippleWindow && !rippleWindow.isDestroyed()) return;
  rippleDisplay = display;
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, show: false, transparent: true, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  rippleWindow = win;
  // v3.0 round 486 (Terry) — sit the ripple JUST BELOW the cam bubble (which is
  // 'screen-saver'). At the SAME level the two tie on z-order by raise-order, so
  // toggling Clicks AFTER Cam put the click-through ripple ABOVE the cam — and the
  // cam's OS app-region drag then passed THROUGH the ripple to the windows behind,
  // so "dragging the cam" actually dragged/clicked OS windows (focus changes, windows
  // closing). 'pop-up-menu' stays above the recorded content (rings still film) but
  // under the cam, so the cam is always grabbable regardless of toggle order.
  try { win.setAlwaysOnTop(true, 'pop-up-menu'); } catch { /* non-fatal */ }
  // Click-through — the overlay must never intercept the user's clicks; the global
  // hook still sees them.
  try { win.setIgnoreMouseEvents(true, { forward: true }); } catch { /* non-fatal */ }
  // NO setContentProtection — the rings MUST appear in the footage.
  win.setMenu(null);
  // v3.0 round 485 (Terry) — don't kill the hook on overlay-close if auto-zoom still needs it.
  win.on('closed', () => { if (rippleWindow === win) { rippleWindow = null; if (!autoZoomEnabled) stopRippleHook(); } });
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.showInactive();
    ensureClickHook();
  });
  void win.loadFile(path.join(__dirname, '../dist/public/capture-ripple.html'));
}
function closeRippleOverlay(): void {
  // v3.0 round 485 (Terry) — closing the ripple overlay must NOT stop the click hook when
  // auto-zoom is still using it; only stop it if no feature needs the hook anymore.
  if (!autoZoomEnabled) stopRippleHook();
  if (rippleWindow && !rippleWindow.isDestroyed()) { try { rippleWindow.close(); } catch { /* non-fatal */ } }
  rippleWindow = null;
}

// ─── v3.0 round 413 (Terry): PDR-style tooltips for the recorder bar ─────────
// The bar is its own 64px chromeless window, so a tooltip bubble can't overflow
// above its buttons. This separate transparent, click-through, content-protected
// window (so it's never in the footage) is positioned just above whichever bar
// control the cursor is on. Created lazily on first hover; closed on teardown.
let tooltipWindow: BrowserWindow | null = null;
let tooltipReady = false;
let tooltipPending: { text: string; x: number; y: number } | null = null;
const TIP_W = 300, TIP_H = 104;

function ensureTooltipWindow(): void {
  if (tooltipWindow && !tooltipWindow.isDestroyed()) return;
  tooltipReady = false;
  const win = new BrowserWindow({
    width: TIP_W, height: TIP_H, show: false, frame: false, transparent: true, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  tooltipWindow = win;
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
  try { win.setIgnoreMouseEvents(true); } catch { /* non-fatal */ }   // never intercept the user's clicks
  try { win.setContentProtection(true); } catch { /* non-fatal */ }   // never appears in the recording
  win.setMenu(null);
  win.on('closed', () => {
    if (tooltipWindow === win) { tooltipWindow = null; tooltipReady = false; tooltipPending = null; }
  });
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    tooltipReady = true;
    if (tooltipPending) { const p = tooltipPending; tooltipPending = null; showRecorderTip(p.text, p.x, p.y); }
  });
  void win.loadFile(path.join(__dirname, '../dist/public/capture-tip.html'));
}
function showRecorderTip(text: string, localX: number, localY: number): void {
  if (!tooltipWindow || tooltipWindow.isDestroyed()) return;
  if (!recordWidget || recordWidget.isDestroyed()) return;
  const wb = recordWidget.getBounds();
  const disp = recordDisplay ? recordDisplay.bounds : screen.getPrimaryDisplay().bounds;
  // localX = the control's centre, localY = its top, both in widget-window coords.
  // v3.1 (Terry) — TIP_GAP lifts the whole tooltip a few px CLEAR of the button so its caret/edge
  // never overlaps the control ("a little bit of the screen between the floating buttons and the tooltip").
  const TIP_GAP = 9;
  let x = Math.round(wb.x + localX - TIP_W / 2);
  let y = Math.round(wb.y + localY - TIP_H - TIP_GAP);
  x = Math.max(disp.x, Math.min(x, disp.x + disp.width - TIP_W));
  y = Math.max(disp.y, y);
  try { tooltipWindow.setBounds({ x, y, width: TIP_W, height: TIP_H }); } catch { /* non-fatal */ }
  try { tooltipWindow.webContents.send('capture:tip-text', { text }); } catch { /* non-fatal */ }
  try { tooltipWindow.showInactive(); } catch { /* non-fatal */ }
}
function hideRecorderTip(): void {
  tooltipPending = null;
  if (tooltipWindow && !tooltipWindow.isDestroyed()) { try { tooltipWindow.hide(); } catch { /* non-fatal */ } }
}
function closeTooltipWindow(): void {
  tooltipPending = null;
  if (tooltipWindow && !tooltipWindow.isDestroyed()) { try { tooltipWindow.close(); } catch { /* non-fatal */ } }
  tooltipWindow = null;
}
ipcMain.on('capture:record-tip', (event, info: { text?: string | null; x?: number; y?: number }) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const text = info?.text;
  if (!text) { hideRecorderTip(); return; }
  ensureTooltipWindow();
  if (tooltipReady) showRecorderTip(text, info?.x ?? 0, info?.y ?? 0);
  else tooltipPending = { text, x: info?.x ?? 0, y: info?.y ?? 0 };
});

// ─── v3.0 round 414 (Terry): live blur confirmation overlay ──────────────────
// FFmpeg applies the blur at SAVE, so during recording the user sees the real
// content with no sign it's being blurred. This fullscreen, transparent,
// CLICK-THROUGH, content-protected window draws a frosted box over each active
// blur region so the user can SEE what's blurred; being content-protected it
// never appears in the footage (which gets the real FFmpeg blur).
let blurOverlayWindow: BrowserWindow | null = null;

function ensureBlurOverlay(display: Electron.Display): void {
  if (blurOverlayWindow && !blurOverlayWindow.isDestroyed()) return;
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, show: false, transparent: true, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  blurOverlayWindow = win;
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
  try { win.setIgnoreMouseEvents(true); } catch { /* non-fatal */ }   // click-through — confirmation only
  try { win.setContentProtection(true); } catch { /* non-fatal */ }   // never appears in the footage
  win.setMenu(null);
  win.on('closed', () => { if (blurOverlayWindow === win) blurOverlayWindow = null; });
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.showInactive();
    updateBlurOverlay();
  });
  void win.loadFile(path.join(__dirname, '../dist/public/capture-blur-overlay.html'));
}
function updateBlurOverlay(): void {
  if (!blurOverlayWindow || blurOverlayWindow.isDestroyed()) return;
  const disp = recordDisplay ? recordDisplay.bounds : screen.getPrimaryDisplay().bounds;
  const sf = recordDisplay ? recordDisplay.scaleFactor : 1;
  const vw = recordMeta.width ?? Math.round(disp.width * sf);
  const vh = recordMeta.height ?? Math.round(disp.height * sf);
  const sx = vw > 0 ? disp.width / vw : 1;
  const sy = vh > 0 ? disp.height / vh : 1;
  // recordBlurSegments are in full-frame VIDEO px; map to display CSS px so the
  // frosted box lands exactly where the blur will be in the footage.
  const areas = recordBlurSegments
    .filter((s) => s.endMs === null)
    .map((s) => ({ x: Math.round(s.x * sx), y: Math.round(s.y * sy), w: Math.round(s.width * sx), h: Math.round(s.height * sy) }));
  try { blurOverlayWindow.webContents.send('capture:blur-areas', { areas }); } catch { /* non-fatal */ }
}
function closeBlurOverlay(): void {
  if (blurOverlayWindow && !blurOverlayWindow.isDestroyed()) { try { blurOverlayWindow.close(); } catch { /* non-fatal */ } }
  blurOverlayWindow = null;
}

/** Show/hide the bubble with the page-side fade. Creates it on first
 *  toggle if the recording started without one. */
function toggleCamBubble(which: number = 1): void {
  // Armed counts too (round 129) — the user frames their camera
  // BEFORE pressing Record.
  if ((recordingState !== 'recording' && recordingState !== 'armed') || !recordDisplay) return;
  // v3.1 (Terry 2026-07-11) — in CAM-ONLY the Cam buttons are a SOLO source SWITCH, not a toggle:
  // clicking a camera shows ONLY that one (the other turns off), so you flip cam 1 ↔ cam 2 in a
  // single click and can NEVER end up on a black screen with no camera (Terry: "why is there a black
  // curtain"). Clicking the camera that's already showing does nothing (leave via "Show screen").
  if (recordCamOnly) {
    const other = which === 1 ? 2 : 1;
    if (camVisibles[which] && !camVisibles[other]) return;   // already the sole shown cam → no-op
    if (camVisibles[other]) {                                // hide the other camera
      const ow = camWindows[other];
      if (ow && !ow.isDestroyed()) { try { ow.webContents.send('capture:cam-do', { action: 'hide' }); } catch { /* non-fatal */ } }
      camVisibles[other] = false;
    }
    const w = camWindows[which];                             // show / create the chosen camera
    if (!w || w.isDestroyed()) { createCamBubble(recordDisplay, which); }
    else if (!camVisibles[which]) {
      try { w.showInactive(); } catch { /* non-fatal */ }
      try { w.webContents.send('capture:cam-do', { action: 'show' }); } catch { /* non-fatal */ }
      camVisibles[which] = true;
      startCamHoverPoll();
    }
    notifyWidgetCamState();
    setTimeout(() => relayoutCamOnlyIfActive(), 90);   // fill the screen with the chosen camera
    return;
  }
  const win = camWindows[which];
  if (!win || win.isDestroyed()) {
    createCamBubble(recordDisplay, which);
    return;
  }
  if (camVisibles[which]) {
    try { win.webContents.send('capture:cam-do', { action: 'hide' }); } catch { /* non-fatal */ }
    camVisibles[which] = false;
    notifyWidgetCamState();
    // The window itself hides when the page reports the fade done
    // (capture:cam-fadedout) so the footage records the fade.
  } else {
    try { win.showInactive(); } catch { /* non-fatal */ }
    try { win.webContents.send('capture:cam-do', { action: 'show' }); } catch { /* non-fatal */ }
    camVisibles[which] = true;
    startCamHoverPoll();   // v3.1 (Terry) — resume the hover poll when a bubble is re-shown
    notifyWidgetCamState();
    if (recordCamOnly && recordDisplay) setTimeout(() => { relayoutCamOnlyIfActive(); }, 60);   // v3.1 (Terry) — re-showing a cam during cam-only → re-split full↔split
  }
}

function closeCamBubble(): void {
  for (const which of [1, 2]) {   // v3.1 (Terry) — tear down BOTH bubbles
    const win = camWindows[which];
    if (win && !win.isDestroyed()) {
      try { win.close(); } catch { /* non-fatal */ }
    }
    camWindows[which] = null;
    camVisibles[which] = false;
  }
  stopCamHoverPoll();   // v3.1 (Terry) — no bubbles left → stop the cursor poll
  closeBackdropPicker();
}

// ─── v3.1 (Terry 2026-07-11): LIVE "cam only" — the desktop-hiding curtain ───
// v3.1 (Terry) — a filmed FADE for the screen↔cam switch: step a window's opacity from→to over ms.
function fadeWindowOpacity(win: BrowserWindow | null, from: number, to: number, ms: number, done?: () => void): void {
  if (!win || win.isDestroyed()) { if (done) done(); return; }
  const steps = 14;
  const dt = Math.max(12, Math.round(ms / steps));
  try { win.setOpacity(from); } catch { /* non-fatal */ }
  let i = 0;
  const tick = (): void => {
    if (!win || win.isDestroyed()) { if (done) done(); return; }
    i++;
    const v = from + (to - from) * (i / steps);
    try { win.setOpacity(Math.max(0, Math.min(1, v))); } catch { /* non-fatal */ }
    if (i >= steps) { if (done) done(); return; }
    setTimeout(tick, dt);
  };
  setTimeout(tick, dt);
}
function closeRecordCurtain(): void {
  const w = recordCurtainWindow;
  recordCurtainWindow = null;
  if (w && !w.isDestroyed()) { try { w.close(); } catch { /* non-fatal */ } }
}
function createRecordCurtain(display: Electron.Display): void {
  if (recordCurtainWindow && !recordCurtainWindow.isDestroyed()) return;
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, show: false, transparent: false, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false,
    backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  recordCurtainWindow = win;
  // NO setContentProtection — the curtain MUST appear in the footage (it's the cam-only backdrop).
  win.setMenu(null);
  // Sit ABOVE the desktop but BELOW the cam bubbles ('screen-saver' level) so the cams show on top.
  try { win.setAlwaysOnTop(true, 'pop-up-menu'); } catch { /* non-fatal */ }
  try { win.setIgnoreMouseEvents(false); } catch { /* non-fatal */ }   // block clicks → the hidden live desktop can't be mis-clicked
  try { win.setOpacity(0); } catch { /* non-fatal */ }   // start invisible → setRecordCamOnly fades it in (filmed transition)
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { try { win.showInactive(); } catch { /* non-fatal */ } raiseOverlaysAboveCurtain(); } });
  void win.loadURL('about:blank');   // opaque black via backgroundColor
  try { win.showInactive(); } catch { /* non-fatal */ }
}
// Keep the cam bubbles AND the recorder bar above the curtain (Terry SS: the curtain was covering
// the bar, so you couldn't turn cam-only back off). The bar is content-protected → still not filmed.
function raiseOverlaysAboveCurtain(): void {
  for (const which of [1, 2]) {
    const w = camWindows[which];
    if (w && !w.isDestroyed()) { try { w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop(); } catch { /* non-fatal */ } }
  }
  if (recordWidget && !recordWidget.isDestroyed()) { try { recordWidget.setAlwaysOnTop(true, 'screen-saver'); recordWidget.moveTop(); } catch { /* non-fatal */ } }
}
// v3.1 Stage 2 (Terry) — while cam-only the visible cam(s) FILL THE SCREEN: 1 cam = the whole display;
// 2 cams = split-screen, each half. The bubble goes full-bleed (cam-do 'fill'). Bounds saved so the cam
// restores to its corner spotlight on exit. opts.anim → the cam plays the swirl-in (macOS-style vortex).
const CAMONLY_SWIRL_OUT_MS = 460;
function layoutCamsForCamOnly(display: Electron.Display, opts?: { anim?: boolean }): void {
  const b = display.bounds;
  const on = [1, 2].filter((w) => camVisibles[w] && camWindows[w] && !camWindows[w]!.isDestroyed());
  const n = on.length;
  if (!n) return;
  const anim = !!(opts && opts.anim);
  on.forEach((which, idx) => {
    const win = camWindows[which]!;
    let x: number, y: number, w: number, h: number;
    if (n === 1) { x = b.x; y = b.y; w = b.width; h = b.height; }               // one cam → full screen
    else { w = Math.round(b.width / 2); h = b.height; y = b.y; x = b.x + idx * w; }   // two cams → left | right halves
    if (!camSavedBounds[which]) { try { camSavedBounds[which] = win.getBounds(); } catch { /* non-fatal */ } }
    // A non-resizable frameless window can silently CLAMP a setBounds bigger than its creation size on
    // Windows — so lift the size ceiling first, then set the bounds (Terry: "one cam only occupies half").
    try { win.setResizable(true); } catch { /* non-fatal */ }
    try { win.setMaximumSize(0, 0); } catch { /* non-fatal */ }   // 0,0 = no maximum
    try { win.setBounds({ x, y, width: w, height: h }); } catch { /* non-fatal */ }
    try { win.webContents.send('capture:cam-do', { action: 'fill', on: true, anim }); } catch { /* non-fatal */ }
    try { const got = win.getBounds(); log.info(`[capture] cam-only fill n=${n} cam${which} want ${w}x${h} got ${got.width}x${got.height} (display ${b.width}x${b.height})`); } catch { /* non-fatal */ }
  });
}
// v3.1 (Terry) — re-fill on ANY cam change during cam-only: 2→1 goes split→FULL (no black half left),
// 1→2 goes full→split. A cam that's no longer visible drops out of the fill (back to its spotlight
// bounds) so the remaining one can take the whole screen.
function relayoutCamOnlyIfActive(): void {
  if (!recordCamOnly || !recordDisplay) return;
  for (const which of [1, 2]) {
    if (!camVisibles[which] && camSavedBounds[which]) {
      const win = camWindows[which];
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('capture:cam-do', { action: 'fill', on: false }); } catch { /* non-fatal */ }
        try { win.setBounds(camSavedBounds[which]!); } catch { /* non-fatal */ }
        try { win.setResizable(false); } catch { /* non-fatal */ }
      }
      camSavedBounds[which] = null;
    }
  }
  layoutCamsForCamOnly(recordDisplay);
  raiseOverlaysAboveCurtain();
}
function restoreOneCamToSpotlight(which: number): void {
  const win = camWindows[which];
  const saved = camSavedBounds[which];
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('capture:cam-do', { action: 'fill', on: false }); } catch { /* non-fatal */ }
    if (saved) { try { win.setBounds(saved); } catch { /* non-fatal */ } try { win.setResizable(false); } catch { /* non-fatal */ } }
  }
  camSavedBounds[which] = null;
}
function restoreCamBoundsFromCamOnly(animOut: boolean): void {
  if (animOut) {
    for (const which of [1, 2]) {
      const win = camWindows[which];
      if (win && !win.isDestroyed() && camSavedBounds[which]) { try { win.webContents.send('capture:cam-do', { action: 'fill', on: false, anim: true }); } catch { /* non-fatal */ } }   // swirl OUT (keeps fullscreen)
    }
    setTimeout(() => { restoreOneCamToSpotlight(1); restoreOneCamToSpotlight(2); }, CAMONLY_SWIRL_OUT_MS);
  } else {
    restoreOneCamToSpotlight(1); restoreOneCamToSpotlight(2);
  }
}
// Flip live "cam only": show/hide the curtain + fill/restore the cam(s), with a macOS-style swirl.
function setRecordCamOnly(on: boolean): void {
  if ((recordingState !== 'recording' && recordingState !== 'armed') || !recordDisplay) return;
  if (on) {
    // Cam-only shows ONE camera at a time. Start solo: none on → turn cam 1 on; BOTH on → drop to cam 1
    // (the Cam buttons then SWITCH between them). recordCamOnly is still false here, so toggleCamBubble
    // takes its normal path for the auto-add.
    if (!camVisibles[1] && !camVisibles[2]) toggleCamBubble(1);
    else if (camVisibles[1] && camVisibles[2]) {
      const w2 = camWindows[2];
      if (w2 && !w2.isDestroyed()) { try { w2.webContents.send('capture:cam-do', { action: 'hide' }); } catch { /* non-fatal */ } }
      camVisibles[2] = false;
      notifyWidgetCamState();
    }
    createRecordCurtain(recordDisplay);
    recordCamOnly = true;
    fadeWindowOpacity(recordCurtainWindow, 0, 1, 200);   // desktop fades to black fast, THEN the cam swirls in
    setTimeout(() => { if (recordCamOnly && recordDisplay) { layoutCamsForCamOnly(recordDisplay, { anim: true }); raiseOverlaysAboveCurtain(); } }, 200);
    setTimeout(() => { if (recordCamOnly && recordDisplay) { layoutCamsForCamOnly(recordDisplay); raiseOverlaysAboveCurtain(); } }, 520);   // safety re-assert (async cam) — no swirl
  } else {
    recordCamOnly = false;
    restoreCamBoundsFromCamOnly(true);   // swirl the cam(s) out, restore spotlight after the anim
    const curtain = recordCurtainWindow;
    recordCurtainWindow = null;
    setTimeout(() => { fadeWindowOpacity(curtain, 1, 0, 240, () => { if (curtain && !curtain.isDestroyed()) { try { curtain.close(); } catch { /* non-fatal */ } } }); }, CAMONLY_SWIRL_OUT_MS);   // black → desktop AFTER the cam swirls away
  }
  notifyWidgetCamState();
}

// v3.1 (Terry) — the BACKDROP PICKER is its own roomy window (the bubble is too small for the scene
// thumbnails). Opened from the bubble's Backdrop button; content-protected so it never appears in the
// footage; centred on the recorded display. Choices route back through main to persist + apply per camera.
let backdropPickerWindow: BrowserWindow | null = null;
// v3.1 (Terry) — the picker stays ALIVE through a "Memories" library pick (only Done closes it): it's
// HIDDEN while the main window is in pick mode, then reshown when the pick ends (picked OR cancelled),
// which main.ts signals via reshowBackdropPickerAfterPick().
let backdropPickerHiddenForPick = false;
function closeBackdropPicker(): void {
  backdropPickerHiddenForPick = false;
  if (backdropPickerWindow && !backdropPickerWindow.isDestroyed()) {
    try { backdropPickerWindow.close(); } catch { /* non-fatal */ }
  }
  backdropPickerWindow = null;
}
export function reshowBackdropPickerAfterPick(): void {
  if (!backdropPickerHiddenForPick) return;   // self-guards: no-op unless a cam-bg Memories pick hid it
  backdropPickerHiddenForPick = false;
  if (backdropPickerWindow && !backdropPickerWindow.isDestroyed()) {
    try { backdropPickerWindow.show(); backdropPickerWindow.focus(); } catch { /* non-fatal */ }
  }
}
function createBackdropPicker(which: number): void {
  if (backdropPickerWindow && !backdropPickerWindow.isDestroyed()) {
    try {
      backdropPickerWindow.webContents.send('capture:cam-picker-init', { which, current: getCamBg(which) });
      backdropPickerWindow.show(); backdropPickerWindow.focus();
    } catch { /* non-fatal */ }
    return;
  }
  const display = recordDisplay || screen.getPrimaryDisplay();
  const W = 620, H = 560;
  const x = Math.round(display.bounds.x + (display.bounds.width - W) / 2);
  const y = Math.round(display.bounds.y + (display.bounds.height - H) / 2);
  const win = new BrowserWindow({
    width: W, height: H, x, y, frame: false, show: false, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: '#14131c',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  backdropPickerWindow = win;
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* non-fatal */ }
  try { win.setContentProtection(true); } catch { /* non-fatal */ }   // never in the footage
  win.setMenu(null);
  win.on('closed', () => { if (backdropPickerWindow === win) backdropPickerWindow = null; });
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('capture:cam-picker-init', { which, current: getCamBg(which) });
    win.show(); win.focus();
  });
  void win.loadFile(path.join(__dirname, '../dist/public/capture-backdrop-picker.html'));
}
ipcMain.on('capture:cam-open-picker', (event, info?: { which?: number }) => {
  const which = info && info.which === 2 ? 2 : 1;
  const win = camWindows[which];
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;   // opener must be that camera's bubble
  createBackdropPicker(which);
});
ipcMain.on('capture:cam-picker-choose', (event, info?: { which?: number; bg?: { type?: string; value?: string; amount?: number } }) => {
  if (!(backdropPickerWindow && !backdropPickerWindow.isDestroyed() && event.sender === backdropPickerWindow.webContents)) return;
  const which = info && info.which === 2 ? 2 : 1;
  const clean = cleanCamBg(info && info.bg);
  try { setSetting(camBgSettingKey(which), clean); } catch { /* non-fatal */ }
  const win = camWindows[which];
  if (win && !win.isDestroyed()) { try { win.webContents.send('capture:cam-do', { action: 'set-bg', bg: clean }); } catch { /* non-fatal */ } }
  log.info(`[capture] cam ${which} backdrop (picker) → ${clean.type}${clean.value ? ' (' + clean.value + ')' : ''}${typeof clean.amount === 'number' ? ' @' + clean.amount : ''}`);
});
// v3.1 (Terry) — LIVE PREVIEW while dragging the blur/pixelate slider: apply to the cam but do NOT persist
// (rapid settings writes would hammer the disk on the main thread). The slider's release persists via choose.
ipcMain.on('capture:cam-picker-preview', (event, info?: { which?: number; bg?: { type?: string; value?: string; amount?: number } }) => {
  if (!(backdropPickerWindow && !backdropPickerWindow.isDestroyed() && event.sender === backdropPickerWindow.webContents)) return;
  const which = info && info.which === 2 ? 2 : 1;
  const clean = cleanCamBg(info && info.bg);
  const win = camWindows[which];
  if (win && !win.isDestroyed()) { try { win.webContents.send('capture:cam-do', { action: 'set-bg', bg: clean }); } catch { /* non-fatal */ } }
});
ipcMain.on('capture:cam-picker-pick', async (event, info?: { which?: number; source?: string }) => {
  if (!(backdropPickerWindow && !backdropPickerWindow.isDestroyed() && event.sender === backdropPickerWindow.webContents)) return;
  const which = info && info.which === 2 ? 2 : 1;
  const source = info && info.source === 'thispc' ? 'thispc' : 'memories';
  if (source === 'thispc') {
    // "This PC" — an OS file picker, main-driven (the bubble can't call the recorder-gated cam-bg-pick).
    // Keep the picker ALIVE (Terry: only Done closes it). Drop its screen-saver-level topmost while the
    // dialog is up so it isn't trapped behind the picker, parent the dialog to it, then restore.
    const picker = backdropPickerWindow;
    try { if (picker && !picker.isDestroyed()) picker.setAlwaysOnTop(false); } catch { /* non-fatal */ }
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose a background picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
    };
    let filePath: string | null = null;
    try {
      const res = picker && !picker.isDestroyed() ? await dialog.showOpenDialog(picker, opts) : await dialog.showOpenDialog(opts);
      if (!res.canceled && res.filePaths && res.filePaths[0]) filePath = res.filePaths[0];
    } catch { /* non-fatal */ }
    try { if (picker && !picker.isDestroyed()) { picker.setAlwaysOnTop(true, 'screen-saver'); picker.show(); picker.focus(); } } catch { /* non-fatal */ }
    if (!filePath) return;   // cancelled → the picker stays open
    const bg = { type: 'image', value: filePath };
    try { setSetting(camBgSettingKey(which), bg); } catch { /* non-fatal */ }
    const win = camWindows[which];
    if (win && !win.isDestroyed()) { try { win.webContents.send('capture:cam-do', { action: 'set-bg', bg }); } catch { /* non-fatal */ } }
    log.info(`[capture] cam ${which} backdrop (This PC) → image (${filePath})`);
    return;
  }
  // "Memories" — pick from the PDR library (brings the MAIN window forward for pick mode). HIDE the picker
  // (don't close it — only Done does that); reshowBackdropPickerAfterPick() brings it back when the pick ends.
  if (backdropPickerWindow && !backdropPickerWindow.isDestroyed()) {
    try { backdropPickerWindow.hide(); backdropPickerHiddenForPick = true; } catch { /* non-fatal */ }
  }
  const win = camWindows[which];
  if (win && !win.isDestroyed()) { try { win.webContents.send('capture:cam-do', { action: 'pick-image' }); } catch { /* non-fatal */ } }
});
ipcMain.on('capture:cam-picker-close', (event) => {
  if (backdropPickerWindow && !backdropPickerWindow.isDestroyed() && event.sender === backdropPickerWindow.webContents) closeBackdropPicker();
});

function registerCamHotkey(): void {
  const accelerator = (() => {
    try { return getSettings().captureCamHotkey || 'Ctrl+Shift+C'; } catch { return 'Ctrl+Shift+C'; }
  })();
  try {
    const ok = globalShortcut.register(accelerator, () => toggleCamBubble());
    camHotkeyAccelerator = ok ? accelerator : null;
    log.info(`[capture] cam hotkey ${accelerator} ${ok ? 'registered for this recording' : 'NOT registered (in use elsewhere)'}`);
  } catch (err) {
    camHotkeyAccelerator = null;
    log.warn(`[capture] cam hotkey registration threw: ${(err as Error).message}`);
  }
}

function unregisterCamHotkey(): void {
  if (camHotkeyAccelerator) {
    try { globalShortcut.unregister(camHotkeyAccelerator); } catch { /* non-fatal */ }
    camHotkeyAccelerator = null;
  }
}

// Round 130 (Terry) — re-pick the recorded area from the ARMED bar.
// His exact scenario: pick the screen while PDR is fullscreen, arm
// with Enter, alt-tab to arrange the windows he actually wants to
// record (nothing cancels — only the selector overlay is modal),
// then press Area on the bar for a FRESH freeze of the screen as it
// now stands. Esc in the re-pick keeps the previous area rather than
// abandoning the setup.
ipcMain.on('capture:record-area-request', (event) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const display = recordDisplay;
  const widget = recordWidget;
  const reply = () => {
    if (widget && !widget.isDestroyed()) {
      try { widget.webContents.send('capture:record-do', { action: 'area-set', region: recordRegionCrop }); } catch { /* non-fatal */ }
    }
  };
  if (!display || recordingState !== 'armed' || captureInFlight) {
    reply();
    return;
  }
  captureInFlight = true;
  // Hide the stale outline while re-picking so it can't confuse the
  // new selection.
  closeRegionMarker();
  void (async () => {
    try {
      // Round 131 — LIVE veil (no frozen grab): the user already
      // arranged their windows before clicking Area, so we just need
      // the rectangle over the live desktop. Native pixel size for
      // the crop scale = the display's CSS bounds × scaleFactor (the
      // recording captures at that native resolution).
      const windows = enumerateWindowRectsForDisplay(display);
      const nativeW = Math.round(display.bounds.width * display.scaleFactor);
      const nativeH = Math.round(display.bounds.height * display.scaleFactor);
      const rect = await openRegionOverlay(display, null, windows, undefined, { live: true });
      if (rect) {
        recordRegionCrop = computeRegionCrop(rect, display, nativeW, nativeH);
        recordRegionCssRect = recordRegionCrop ? rect : null;
        if (recordRegionCrop && recordRegionCssRect) createRegionMarker(display, recordRegionCssRect);
        log.info(`[capture] recording area set: ${recordRegionCrop ? `${recordRegionCrop.width}×${recordRegionCrop.height}` : 'full screen'}`);
      } else if (recordRegionCssRect) {
        // Esc kept the previous area — restore its outline.
        createRegionMarker(display, recordRegionCssRect);
      }
      reply();
    } catch (err) {
      log.warn(`[capture] area pick failed: ${(err as Error).message}`);
      reply();
    } finally {
      captureInFlight = false;
    }
  })();
});

// Round 131 — change the recorded screen from the bar's Screen
// dropdown (Terry: pick the screen AFTER seeing the menu, and never
// silently assume last time's). Resets the region to full (a region
// on the old screen doesn't map to the new one), moves the bar + cam
// to the new display, and hands the widget the new source id so the
// engine records the right screen when Record is pressed.
ipcMain.on('capture:record-set-screen', (event, displayId: string) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  if (recordingState !== 'armed') return;
  const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
  if (!display) return;
  recordDisplay = display;
  recordRegionCrop = null;
  recordRegionCssRect = null;
  closeRegionMarker();
  // Move the bar to the newly-targeted display (bottom-right); the
  // self-sizer will re-anchor width on its next tick.
  try {
    const b = recordWidget.getBounds();
    recordWidget.setBounds({
      x: display.bounds.x + display.bounds.width - b.width - 24,
      y: display.bounds.y + display.bounds.height - b.height - 56,
      width: b.width,
      height: b.height,
    });
  } catch { /* non-fatal */ }
  // Re-home the camera bubble(s) if up. v3.1 (Terry) — remember WHICH bubbles existed, close both,
  // recreate the same set on the new display.
  {
    const hadCam = [1, 2].filter((w) => { const win = camWindows[w]; return win && !win.isDestroyed(); });
    if (hadCam.length) {
      closeCamBubble();
      for (const w of hadCam) createCamBubble(display, w);
    }
  }
  void (async () => {
    const source = await getDisplaySource(display);
    if (recordWidget && !recordWidget.isDestroyed()) {
      try {
        recordWidget.webContents.send('capture:record-do', {
          action: 'screen-set',
          sourceId: source?.id ?? null,
          maxWidth: Math.round(display.bounds.width * display.scaleFactor),
          maxHeight: Math.round(display.bounds.height * display.scaleFactor),
          screenId: String(display.id),
        });
      } catch { /* non-fatal */ }
    }
    log.info(`[capture] recorded screen changed to display ${display.id}`);
  })();
});

// Round 130 — the widget measures its own content and asks for a
// window width that fits every visible control, anchored to the
// recorded display's bottom-right. Future-proofs the bar against
// clipping no matter how many buttons appear (the bug where Record
// fell off the right edge after Area was added).
ipcMain.on('capture:record-resize', (event, width: number) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const display = recordDisplay ?? screen.getPrimaryDisplay();
  const target = Math.round(Math.max(280, Math.min(width || 0, display.bounds.width - 48)));
  try {
    const cur = recordWidget.getBounds();
    if (Math.abs(cur.width - target) < 2) return; // already there
    // Keep the right edge anchored to the display's right margin.
    const right = display.bounds.x + display.bounds.width - 24;
    recordWidget.setBounds({ x: right - target, y: cur.y, width: target, height: cur.height });
  } catch { /* non-fatal */ }
});

ipcMain.on('capture:record-cam-toggle', (event, info?: { which?: number }) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents) {
    toggleCamBubble(info && info.which === 2 ? 2 : 1);   // v3.1 (Terry) — Cam / Cam 2 toggle their own bubbles
  }
});
// v3.1 (Terry 2026-07-11) — LIVE "cam only": flip the desktop-hiding curtain on/off mid-recording.
ipcMain.on('capture:record-camonly-toggle', (event) => {
  if (recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents) {
    setRecordCamOnly(!recordCamOnly);
  }
});
// v3.1 (Terry) — cycle a bubble's size S→M→L→S (the bubble's hover ⤢ button). Resizes the window
// around its centre (the page's fluid inset layout reflows itself) and persists per camera.
// Resize the bubble around its centre to a target HEIGHT (px), clamped + aspect-kept, and persist it.
function applyCamHeight(which: number, h: number, persist: boolean): void {
  const win = camWindows[which];
  if (!win || win.isDestroyed() || recordCamOnly) return;   // never resize the spotlight while cam-only is filling the screen
  const shape = getCamShape(which);
  const dims = camDimsFor(which, shape, h);
  try {
    const b = win.getBounds();
    win.setBounds({ x: Math.round(b.x + (b.width - dims.w) / 2), y: Math.round(b.y + (b.height - dims.h) / 2), width: dims.w, height: dims.h });
  } catch { /* non-fatal */ }
  if (persist) { try { setSetting(camSizePxKey(which), dims.h); } catch { /* non-fatal */ } }
}
// Click the ⤢ handle → step through 5 sizes (Terry: "5 different sizes"), smallest→4× the old Large.
ipcMain.on('capture:cam-size', (event, info?: { which?: number }) => {
  const which = info && info.which === 2 ? 2 : 1;
  const win = camWindows[which];
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const shape = getCamShape(which);
  const steps = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(CAM_MIN_H + f * (camMaxH(shape) - CAM_MIN_H)));
  const cur = getCamSizeH(which);
  const next = steps.find((s) => s > cur + 4) ?? steps[0];   // next larger, wrapping to smallest
  applyCamHeight(which, next, true);
  log.info(`[capture] cam ${which} size step → ${next}px`);
});
// Drag the ⤢ handle → continuous resize (Terry: "a slider on a sliding scale"). commit persists.
ipcMain.on('capture:cam-resize', (event, info?: { which?: number; h?: number; commit?: boolean }) => {
  const which = info && info.which === 2 ? 2 : 1;
  const win = camWindows[which];
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  if (typeof info?.h === 'number' && isFinite(info.h)) applyCamHeight(which, info.h, !!info.commit);
});
// v3.0 round 410 (Terry) — microphone/voiceover on/off + device, reported from
// the recording bar so they persist for future recordings (same persist+sync
// pattern as quality). The widget owns the live mic capture + audio mixing.
ipcMain.on('capture:record-mic-toggle', (event, info: { enabled?: boolean }) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const on = info?.enabled === true;
  try { setSetting('captureMicEnabled', on); } catch { /* non-fatal */ }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send('settings:changed', { key: 'captureMicEnabled', value: on }); } catch { /* non-fatal */ }
  }
  log.info(`[capture] microphone → ${on ? 'on' : 'off'} (persisted for future recordings)`);
});
ipcMain.on('capture:record-set-mic', (event, deviceId: string) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const id = typeof deviceId === 'string' ? deviceId : '';
  try { setSetting('captureMicDevice', id); } catch { /* non-fatal */ }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send('settings:changed', { key: 'captureMicDevice', value: id }); } catch { /* non-fatal */ }
  }
  log.info('[capture] microphone device set (persisted for future recordings)');
});
// v3.0 round 411 (Terry) — click-ripple on/off from the recording bar: persist +
// create/close the overlay (which starts/stops the global mouse hook).
ipcMain.on('capture:record-ripple-toggle', (event, info: { enabled?: boolean }) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  const on = info?.enabled === true;
  try { setSetting('captureRippleEnabled', on); } catch { /* non-fatal */ }
  // v3.0 round 413 (Terry) — only spin up the overlay/hook if recording is
  // actually underway; while armed we just persist the choice (record-started
  // honours it) so the setup phase never carries the hook's overhead.
  if (on && recordDisplay && recordingState === 'recording') createRippleOverlay(recordDisplay);
  else if (!on) closeRippleOverlay();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send('settings:changed', { key: 'captureRippleEnabled', value: on }); } catch { /* non-fatal */ }
  }
  log.info(`[capture] click-ripple → ${on ? 'on' : 'off'}`);
});
ipcMain.on('capture:cam-fadedout', (event) => {
  // v3.1 (Terry) — two bubbles: hide exactly the SENDER's window once its fade is done.
  for (const which of [1, 2]) {
    const win = camWindows[which];
    if (win && !win.isDestroyed() && event.sender === win.webContents && !camVisibles[which]) {
      try { win.hide(); } catch { /* non-fatal */ }
    }
  }
  // v3.1 (Terry) — a cam hidden DURING cam-only → the remaining one takes the whole screen (no black half).
  relayoutCamOnlyIfActive();
});
ipcMain.on('capture:cam-error', (event, info: { message?: string }) => {
  const camWindow = [1, 2].map((w) => camWindows[w]).find((w) => w && !w.isDestroyed() && event.sender === w.webContents) || null;   // v3.1 (Terry) — resolve which bubble errored
  if (camWindow && !camWindow.isDestroyed() && event.sender === camWindow.webContents) {
    log.warn(`[capture] camera bubble failed: ${info?.message ?? 'unknown'}`);
    broadcast('capture:recordError', { message: 'The camera couldn\'t start — check Windows camera privacy settings. The recording itself is unaffected.' });
    closeCamBubble();
    if (recordCamOnly) setRecordCamOnly(false);   // v3.1 (Terry) — cam-only with no working camera → show the desktop, never a blank black screen
    notifyWidgetCamState();
  }
});

ipcMain.on('capture:record-blur', (event, info: { type?: 'open' | 'close'; rect?: { x: number; y: number; width: number; height: number }; startMs?: number; endMs?: number }) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  if (info?.type === 'open' && info.rect && typeof info.startMs === 'number') {
    recordBlurSegments.push({
      x: info.rect.x, y: info.rect.y, width: info.rect.width, height: info.rect.height,
      startMs: Math.max(0, info.startMs), endMs: null,
    });
    persistBlurSidecar();
    log.info(`[capture] blur ON at ${(info.startMs / 1000).toFixed(1)}s (${info.rect.width}×${info.rect.height} @ ${info.rect.x},${info.rect.y})`);
    // v3.0 round 414 — show the live confirmation box for this region.
    if (recordDisplay) ensureBlurOverlay(recordDisplay);
    updateBlurOverlay();
  } else if (info?.type === 'close' && typeof info.endMs === 'number') {
    const open = [...recordBlurSegments].reverse().find((s) => s.endMs === null);
    if (open) {
      open.endMs = Math.max(open.startMs, info.endMs);
      persistBlurSidecar();
      log.info(`[capture] blur OFF at ${(info.endMs / 1000).toFixed(1)}s`);
      updateBlurOverlay();
    }
  }
});
// v3.0 round 412 (Terry) — zoom moments from the recording bar (manual Zoom button),
// mirroring blur open/close. Focal defaults to centre when not given (manual); auto-zoom
// passes a click focal. Applied by the FFmpeg zoompan stage at save.
ipcMain.on('capture:record-zoom', (event, info: { type?: 'open' | 'close'; startMs?: number; endMs?: number; focalX?: number; focalY?: number; level?: number }) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  if (info?.type === 'open' && typeof info.startMs === 'number') {
    recordZoomSegments.push({
      focalX: typeof info.focalX === 'number' ? Math.min(1, Math.max(0, info.focalX)) : 0.5,
      focalY: typeof info.focalY === 'number' ? Math.min(1, Math.max(0, info.focalY)) : 0.5,
      level: typeof info.level === 'number' ? Math.min(4, Math.max(1.1, info.level)) : 2,
      startMs: Math.max(0, info.startMs), endMs: null,
    });
    log.info(`[capture] zoom ON at ${(info.startMs / 1000).toFixed(1)}s`);
  } else if (info?.type === 'close' && typeof info.endMs === 'number') {
    const open = [...recordZoomSegments].reverse().find((s) => s.endMs === null);
    if (open) {
      open.endMs = Math.max(open.startMs, info.endMs);
      log.info(`[capture] zoom OFF at ${(info.endMs / 1000).toFixed(1)}s`);
    }
  }
});
// v3.0 round 485 (Terry) — AUTO-ZOOM toward clicks on/off from the recording bar.
// Persist the choice + (de)activate the click hook. When turned on mid-recording we
// ensure the hook is running so the very next click drives a zoom; turning it off leaves
// any open segment to ease out on its timer. Mirrors the click-ripple toggle's pattern.
ipcMain.on('capture:set-auto-zoom', (event, on: unknown) => {
  if (!(recordWidget && !recordWidget.isDestroyed() && event.sender === recordWidget.webContents)) return;
  autoZoomEnabled = !!on;
  try { setSetting('captureAutoZoomEnabled', autoZoomEnabled); } catch { /* non-fatal */ }
  // Only carry the hook's overhead while actually recording (the click-ripple toggle uses
  // the same rule); record-started honours the persisted choice when recording begins.
  if (autoZoomEnabled && recordingState === 'recording') ensureClickHook();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send('settings:changed', { key: 'captureAutoZoomEnabled', value: autoZoomEnabled }); } catch { /* non-fatal */ }
  }
  log.info(`[capture] auto-zoom → ${autoZoomEnabled ? 'on' : 'off'}`);
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
      // Round 127 — re-apply any blur the user had set before the
      // crash/quit; the sidecar JSON travels with the temp WebM
      // precisely so sensitive content never resurfaces unblurred.
      let blurSegments: BlurSegment[] = [];
      let crop: SelectionRect | null = null;
      try {
        const sidecar = blurSidecarPath(full);
        if (fs.existsSync(toLongPath(sidecar))) {
          const parsed = JSON.parse(fs.readFileSync(toLongPath(sidecar), 'utf8'));
          if (Array.isArray(parsed)) {
            blurSegments = parsed; // pre-round-129 shape
          } else if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.segments)) blurSegments = parsed.segments;
            if (parsed.crop && typeof parsed.crop.width === 'number') crop = parsed.crop;
          }
        }
      } catch { /* recover without blur/crop metadata */ }
      const mp4Path = await transcodeWebmToMp4(full, '21', blurSegments, crop);
      if (mp4Path) {
        try { fs.unlinkSync(toLongPath(full)); } catch { /* non-fatal */ }
        try { fs.unlinkSync(toLongPath(blurSidecarPath(full))); } catch { /* non-fatal */ }
        await persistRecording(mp4Path, startedAt, crop?.width ?? null, crop?.height ?? null);
      } else {
        if (blurSegments.length > 0) {
          log.warn(`[capture] orphan recovery: transcode failed with ${blurSegments.length} blur segment(s) — recovered WebM is NOT blurred`);
        }
        try { fs.unlinkSync(toLongPath(blurSidecarPath(full))); } catch { /* non-fatal */ }
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
